// Playwright Bridge - The "Invisible Hand"
// Securely injects card data into checkout forms without exposing it to AI

import type { CardData, PaymentResult, CheckoutHints } from "./types.js";
import { withTimeout, TimeoutError } from "./lib/with-timeout.js";
import { launchBrowser } from "./lib/browser.js";
import { checkPaymentPage, isTrustedCardFrame, type LockCheck } from "./lib/domain-lock.js";
import { scrubCardValues } from "./failure_taxonomy.js";

const CHECKOUT_HARD_TIMEOUT_MS = 60_000; // 60s absolute cap — prevents slow-loris attacks
const PAGE_DETAIL_MAX = 300;

type Page = import("playwright").Page;
type Frame = import("playwright").Frame;
type ElementHandle = import("playwright").ElementHandle;

/**
 * Detects and fills credit card form fields on a checkout page.
 * Card data exists ONLY in RAM and is wiped after injection.
 * Hard timeout of 60s prevents merchant page from hanging indefinitely.
 *
 * Nothing this function returns may carry the card (audit T12 F3, M.1): a
 * Playwright error quotes the value it was filling (`fill("4242…")`), and a page
 * can echo the number back as its "order number". Every string leaving here goes
 * through finish(), which strips this card's own number and CVV, then every
 * other card-shaped number.
 */
export async function fillCheckoutForm(
    checkoutUrl: string,
    cardData: CardData,
    existingPage?: Page,
    hints?: CheckoutHints
): Promise<PaymentResult> {
    // Kept only to scrub output; the bridge wipes cardData itself.
    const secrets = { number: cardData.number, cvv: cardData.cvv };
    let browser: import("playwright").Browser | null = null;
    let page: Page;

    try {
        if (existingPage) {
            page = existingPage;
        } else {
            browser = await launchBrowser();
            const context = await browser.newContext();
            page = await context.newPage();
        }
        const result = await withTimeout(
            _fillCheckoutFormInner(page, checkoutUrl, cardData, hints),
            CHECKOUT_HARD_TIMEOUT_MS,
            'fillCheckoutForm',
            async () => {
                console.error('[PLAYWRIGHT] ⚠️ Hard timeout hit — force-closing browser');
                if (browser) await browser.close().catch(() => {});
            }
        );
        return finish(result, secrets);
    } catch (err: unknown) {
        if (err instanceof TimeoutError) {
            return finish({
                success: false,
                status: 'error',
                message: `Checkout timed out after ${CHECKOUT_HARD_TIMEOUT_MS / 1000}s. The merchant page may be too slow or blocking automation.`,
            }, secrets);
        }
        return finish({
            success: false,
            status: 'error',
            message: 'The browser failed during the checkout attempt.',
            page_detail: err instanceof Error ? err.message : String(err),
        }, secrets);
    } finally {
        if (browser) await browser.close().catch(() => {});
        // Wipe the copy too: fill is over, nothing needs the values any more.
        secrets.number = "";
        secrets.cvv = "";
    }
}

/** Last stop before a result leaves the bridge: no card value in any string. */
function finish(r: PaymentResult, secrets: { number?: string; cvv?: string }): PaymentResult {
    const out: PaymentResult = { ...r, message: scrubCardValues(r.message, secrets) };
    if (r.page_detail) {
        out.page_detail = scrubCardValues(r.page_detail, secrets).slice(0, PAGE_DETAIL_MAX);
    }
    if (r.receipt_id !== undefined) {
        out.receipt_id = cleanReceiptId(r.receipt_id, secrets);
    }
    return out;
}

/**
 * An order number is page text. It goes into the agent's result, the signed
 * receipt and the public receipt page, so: short, plain characters only, and
 * dropped outright if it holds this card's number or CVV, or anything that can
 * be a card number. A dropped id costs a convenience; a kept one could cost the
 * card (audit T12 F3: a page echoed "Order number: <PAN>-<CVV>").
 */
function cleanReceiptId(id: string | undefined, secrets: { number?: string; cvv?: string }): string | undefined {
    if (!id) return undefined;
    const plain = id.normalize("NFKC").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/.test(plain)) return undefined;
    return scrubCardValues(plain, secrets, { cards: "valid" }) === plain ? plain : undefined;
}

// ============================================================
// CARD GATE — where a card value may go (audit T11 F2, T12 F1/F2, T00 F1; M.2)
//
// checkPaymentPage() looked at the page once, before the first field. A page
// that moved a few hundred ms later still received the card, and an agent's
// selector could reach into any frame on the page. Now every single field is
// judged on its own, at the moment it is typed into:
//   - the page has not moved to another origin since the lock check;
//   - the field lives in the main page of the locked store, or in a frame whose
//     REAL origin is the store or a known card-field provider;
//   - on the main page, the field looks like a card field and a person can see
//     it (not an order note, not an invisible 2px box over the real iframe).
// ============================================================
type FieldKind = 'number' | 'exp' | 'cvv' | 'name';

const FIELD_SHAPE: Record<FieldKind, RegExp> = {
    number: /cc-?number|card.?num|cardnumber|credit.?card|card.?no\b|\bccnum|\bpan\b|card[_\s-]?number/i,
    exp: /cc-exp|exp(iry|iration|ires)?\b|exp[-_\s]?(date|month|year|mm|yy)|\bmm\s*\/\s*yy|valid.?thru/i,
    cvv: /cc-csc|\bcvv|\bcvc|\bcsc\b|security.?code|card.?code|verification|cvn/i,
    name: /cc-name|card.?holder|name.?on.?card|ccname|card.?name/i,
};

class CardGate {
    private lockedOrigin: string | null = null;
    private movedTo: string | null = null;
    private readonly onNav: (f: Frame) => void;

    constructor(private readonly page: Page, private readonly lockedDomain: string | null | undefined) {
        this.onNav = (f: Frame) => {
            if (f !== this.page.mainFrame() || !this.lockedOrigin || this.movedTo) return;
            if (originOf(f.url()) !== this.lockedOrigin) this.movedTo = f.url();
        };
    }

    /** Lock to the page in front of us now. Any later move to another origin stops the fill. */
    arm(): LockCheck {
        const lock = checkPaymentPage(this.page.url(), this.lockedDomain);
        if (!lock.ok) return lock;
        this.lockedOrigin = originOf(this.page.url());
        this.page.on('framenavigated', this.onNav);
        return lock;
    }

    dispose(): void {
        this.page.off('framenavigated', this.onNav);
    }

    /** Stop everything: the page itself has gone somewhere else. */
    moved(): LockCheck | null {
        if (this.movedTo) return blockedMove(this.movedTo);
        if (originOf(this.page.url()) !== this.lockedOrigin) return blockedMove(this.page.url());
        const live = checkPaymentPage(this.page.url(), this.lockedDomain);
        return live.ok ? null : live;
    }

    /** May this one field receive this one value? false = skip the field, never type. */
    async allows(el: ElementHandle, kind: FieldKind): Promise<boolean> {
        if (this.moved()) return false;
        const frame = await el.ownerFrame().catch(() => null);
        if (!frame) return false;
        if (frame === this.page.mainFrame()) {
            if (originOf(frame.url()) !== this.lockedOrigin) return false;
            return (await looksLikeCardField(el, kind)) && (await isHumanVisible(el));
        }
        return isTrustedCardFrame(frame.url(), this.lockedDomain);
    }
}

function originOf(url: string): string | null {
    try {
        const o = new URL(url).origin;
        return o === "null" ? null : o;
    } catch { return null; }
}

function blockedMove(to: string): LockCheck {
    return {
        ok: false,
        reason: `The page moved to ${hostOf(to)} while the card was being filled in. Filling stopped; nothing more was typed and the order was not submitted.`,
    };
}

function hostOf(url: string): string {
    try { return new URL(url).host || "an unreadable address"; } catch { return "an unreadable address"; }
}

async function looksLikeCardField(el: ElementHandle, kind: FieldKind): Promise<boolean> {
    const attrs = await el.evaluate((e) => {
        const a = (n: string) => (e as HTMLElement).getAttribute(n) || "";
        return [a("autocomplete"), a("name"), a("id"), a("placeholder"), a("aria-label"), a("data-elements-stable-field-name")].join(" ");
    }).catch(() => "");
    return FIELD_SHAPE[kind].test(attrs);
}

async function isHumanVisible(el: ElementHandle): Promise<boolean> {
    if (!(await el.isVisible().catch(() => false))) return false;
    return el.evaluate((e) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        let opacity = 1;
        for (let n: Element | null = e as Element; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.visibility === "hidden" || s.display === "none") return false;
            opacity *= parseFloat(s.opacity || "1");
        }
        return opacity >= 0.1;
    }).catch(() => false);
}

// ============================================================
// HELPER: Smart fill — handles both <input> and <select>
// Prevents crash when dropdown uses <select> instead of <input>
// ============================================================
async function smartFill(gate: CardGate, el: ElementHandle, value: string, kind: FieldKind): Promise<boolean> {
    try {
        if (!(await gate.allows(el, kind))) return false;
        const tag = await el.evaluate(e => (e as HTMLElement).tagName.toLowerCase());
        // Card data only ever goes into a form field built to hold it: an <input> of a
        // text-like type, or a <select> (expiry). Never a textarea, a hidden or email
        // input, or anything else a hint selector might point at (audit MCP-03) —
        // those are where a card number would end up in an order note or a page owner's log.
        if (tag !== 'input' && tag !== 'select') return false;
        if (tag === 'input') {
            const type = await el.evaluate(e => ((e as HTMLInputElement).type || 'text').toLowerCase());
            if (!['text', 'tel', 'number', 'password'].includes(type)) return false;
        }
        if (tag === 'select') {
            // Try by value first (most common: "01", "12", "2030")
            try { await el.selectOption({ value }); return true; } catch { /* next */ }
            // Try matching option label containing the value
            try { await el.selectOption({ label: value }); return true; } catch { /* next */ }
            // Last resort: numeric index (month "01" → index 1 if 0="Select...")
            const idx = parseInt(value, 10);
            if (!isNaN(idx)) {
                try { await el.selectOption({ index: idx }); return true; } catch { /* give up */ }
            }
            return false;
        } else {
            await el.fill(value);
            return true;
        }
    } catch {
        // Never rethrow: a Playwright fill error quotes the value it was typing.
        return false;
    }
}

/** Try each selector in order, smartFill the first match */
async function tryFillField(
    gate: CardGate,
    ctx: Page | Frame,
    selectors: string[],
    value: string,
    kind: FieldKind
): Promise<boolean> {
    for (const selector of selectors) {
        const el = await ctx.$(selector).catch(() => null);
        if (el) {
            const ok = await smartFill(gate, el, value, kind);
            if (ok) return true;
        }
    }
    return false;
}

/**
 * A hint selector is plain CSS. Playwright also reads `>>` chains and its own
 * engines (`internal:control=enter-frame`, `xpath=`…), which let one string walk
 * into another site's frame (audit T12 F1). Those are refused outright.
 */
function isPlainCss(selector: string | undefined): selector is string {
    if (!selector) return false;
    return !/>>|^\s*[a-z_-]+=|internal:/i.test(selector);
}

// ============================================================
// CONFIRMATION DETECTION — the core of "filled ≠ paid"
// After Pay is clicked we must observe a REAL outcome before
// telling the caller it succeeded. A blind waitForTimeout()
// followed by success:true is what made receipts fake.
// ============================================================
const CONFIRM_WAIT_MS = 12_000;   // total budget to watch for an outcome (well within the 60s hard cap)
const CONFIRM_POLL_MS = 750;

// URL of a post-payment page (we additionally require the URL to have moved off the checkout page)
const SUCCESS_URL_RE = /thank[_-]?you|order[-_]?(?:received|confirmation|confirmed|complete|placed)|\/orders?\/|\/receipts?\/|payment[_-]?success|checkout\/success|confirmation/i;
// Strong success phrases — deliberately specific so a checkout "Order summary" panel does NOT trigger it
const SUCCESS_TEXT_RE = /thank you for your (?:order|purchase|payment)|your order (?:has been|is) (?:confirmed|placed|received)|order (?:confirmed|placed successfully)|payment (?:successful|received|approved|complete)|purchase complete|order number[:\s#]/i;
// Decline / failure signals
const DECLINE_TEXT_RE = /(?:card|payment|transaction) (?:was )?declined|payment (?:failed|unsuccessful|was not|could not be processed)|(?:invalid|incorrect) (?:card|cvv|cvc|security code|card number|expiry)|insufficient funds|try (?:a |another )?(?:different )?card|card (?:was )?not accepted|we (?:couldn'?t|could not) process/i;
// Real order/confirmation number to use as receipt_id (only when confirmed)
const RECEIPT_RE = /(?:order|confirmation|receipt)\s*(?:number|no\.?|#)?[:\s#]*([A-Z0-9][A-Z0-9-]{3,})/i;

type OutcomeKind = 'confirmed' | 'declined' | 'unconfirmed';

/**
 * The text a person looking at the page can actually read (audit T12 F6, M.7).
 * innerText still counts text that is transparent, 0px, or parked off-screen —
 * a page could hide "Order number: …" there and have a non-payment read as paid
 * (the token then burns and the money sits in USED with no way back).
 */
async function readableText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const out: string[] = [];
        const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
        const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
        const seen = new Map<Element, boolean>();
        const readable = (el: Element): boolean => {
            const cached = seen.get(el);
            if (cached !== undefined) return cached;
            let ok = true;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) ok = false;
            const left = r.left + window.scrollX;
            const top = r.top + window.scrollY;
            if (ok && (left + r.width <= 0 || top + r.height <= 0 || left >= docW || top >= docH)) ok = false;
            if (ok) {
                let opacity = 1;
                for (let n: Element | null = el; n; n = n.parentElement) {
                    const s = getComputedStyle(n);
                    if (s.display === "none" || s.visibility === "hidden") { ok = false; break; }
                    opacity *= parseFloat(s.opacity || "1");
                    if (n === el && parseFloat(s.fontSize || "16") < 6) { ok = false; break; }
                }
                if (ok && opacity < 0.1) ok = false;
            }
            seen.set(el, ok);
            return ok;
        };
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = (n.textContent || "").trim();
            const parent = n.parentElement;
            if (!t || !parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) continue;
            if (readable(parent)) out.push(t);
            if (out.length > 4000) break;
        }
        return out.join("\n");
    });
}

/**
 * Watches the page after Pay is clicked and classifies the real outcome.
 * Polls URL + readable text for a confirmation or decline signal until a
 * signal is seen or CONFIRM_WAIT_MS elapses. Default (no signal) is the
 * SAFE 'unconfirmed' — caller must NOT burn the token on that.
 */
async function detectPaymentOutcome(
    page: Page,
    checkoutUrl: string
): Promise<{ kind: OutcomeKind; receipt_id?: string }> {
    const checkoutPath = (() => {
        try { const u = new URL(checkoutUrl); return u.origin + u.pathname; } catch { return checkoutUrl.split('?')[0]; }
    })();

    const deadline = Date.now() + CONFIRM_WAIT_MS;
    while (Date.now() < deadline) {
        let currentUrl = '';
        let bodyText = '';
        try {
            currentUrl = page.url();
            bodyText = await readableText(page);
        } catch {
            // page is mid-navigation — wait and retry
            await page.waitForTimeout(CONFIRM_POLL_MS).catch(() => {});
            continue;
        }

        // Decline is a definitive negative — check first.
        if (DECLINE_TEXT_RE.test(bodyText)) {
            return { kind: 'declined' };
        }

        const movedOff = (() => {
            try { const u = new URL(currentUrl); return (u.origin + u.pathname) !== checkoutPath; } catch { return false; }
        })();
        const urlSignal = movedOff && SUCCESS_URL_RE.test(currentUrl);
        const textSignal = SUCCESS_TEXT_RE.test(bodyText);

        if (urlSignal || textSignal) {
            const m = bodyText.match(RECEIPT_RE);
            return { kind: 'confirmed', receipt_id: m?.[1] };
        }

        await page.waitForTimeout(CONFIRM_POLL_MS).catch(() => {});
    }

    // No clear signal within the window — safe default, caller will NOT burn.
    return { kind: 'unconfirmed' };
}

/** Map a detected outcome to the PaymentResult shape (receipt only ever real). */
function outcomeToResult(
    outcome: { kind: OutcomeKind; receipt_id?: string },
    fieldNote: string
): PaymentResult {
    switch (outcome.kind) {
        case 'confirmed':
            return {
                success: true,
                status: 'confirmed',
                message: `Payment confirmed by the merchant. ${fieldNote}`,
                receipt_id: outcome.receipt_id,
            };
        case 'declined':
            return {
                success: false,
                status: 'declined',
                message: `Payment was declined by the merchant. ${fieldNote}`,
            };
        case 'unconfirmed':
        default:
            return {
                success: false,
                status: 'unconfirmed',
                message:
                    `Card details were submitted but no order confirmation was detected. ${fieldNote} ` +
                    `The token was NOT burned — verify whether the order went through before retrying (avoid double-charge).`,
            };
    }
}

/** Click the pay button only while the page is still the one we locked to. */
async function clickIfStillLocked(gate: CardGate, btn: ElementHandle): Promise<LockCheck | 'clicked' | 'not_clicked'> {
    const moved = gate.moved();
    if (moved) return moved;
    try {
        if (await btn.isVisible()) { await btn.click(); return 'clicked'; }
    } catch { /* covered, detached, … — treat as not clicked */ }
    return 'not_clicked';
}

/** Internal implementation — called by fillCheckoutForm inside a timeout wrapper */
async function _fillCheckoutFormInner(
    page: Page,
    checkoutUrl: string,
    cardData: CardData,
    hints?: CheckoutHints
): Promise<PaymentResult> {
    const gate = new CardGate(page, cardData.merchant_domain);
    try {
        // ✅ FIX: Skip navigation if page already loaded (Single Browser reuse from auto_pay_checkout)
        // Prevents double-navigate which would reload page and lose cart/session state.
        const currentUrl = page.url();
        const baseCheckoutUrl = checkoutUrl.split("?")[0];
        let landedUrl = currentUrl;
        if (!currentUrl || currentUrl === "about:blank" || !currentUrl.startsWith(baseCheckoutUrl)) {
            // ⚠️ COLD BROWSER: execute_payment lands here with a fresh, COOKIELESS context — none of the
            // agent's own browsing session carries over. This only works when checkout_url is RESUMABLE
            // cold: the cart, final total and card fields must be reconstructable server-side from the URL
            // alone (Shopify /checkouts/c/<token>, Etsy token URLs). For cookie/session-bound carts the
            // page loads empty or redirects to /cart|/login and no card fields will be found.
            await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
            landedUrl = page.url();
        }
        // Heuristic: did the cold load bounce off the intended checkout (cart/session not carried)?
        const landedElsewhere = (() => {
            try {
                const want = new URL(checkoutUrl);
                const got = new URL(landedUrl);
                return got.host !== want.host || got.pathname.split("/")[1] !== want.pathname.split("/")[1];
            } catch { return false; }
        })();

        // ============================================================
        // STRATEGY 0: Pre-steps — click to open/reveal the payment form
        // Agent provides selectors to click BEFORE filling (e.g. accordion, tab, modal)
        // ============================================================
        if (hints?.pre_steps && hints.pre_steps.length > 0) {
            for (const selector of hints.pre_steps) {
                if (!isPlainCss(selector)) continue;
                try {
                    const el = await page.$(selector);
                    if (el && await el.isVisible()) {
                        await el.click();
                        await page.waitForTimeout(500); // brief pause for animation
                    }
                } catch { /* non-fatal — continue */ }
            }
        }

        // 🔒 DOMAIN LOCK — armed on the page in front of us now, then held for every
        // field (CardGate). The card goes only on its own store or a hosted payment
        // page that store handed off to (lib/domain-lock.ts).
        const lock = gate.arm();
        if (!lock.ok) {
            return { success: false, status: "blocked", message: lock.reason };
        }

        let filledFields = 0;
        let cardNumberFilled = false;
        const stopIfMoved = (): PaymentResult | null => {
            const moved = gate.moved();
            return moved && !moved.ok ? { success: false, status: "blocked", message: moved.reason } : null;
        };

        // ============================================================
        // STRATEGY 0.5: Agent-provided selectors (from get_merchant_hints)
        // Tried first — agent already read the DOM and knows exact locations.
        // iframe_selector: card fields are searched INSIDE frames whose name holds
        // that fragment AND whose real origin is the store or a card-field provider.
        // No such frame → the card fields are not searched anywhere else (the main
        // page is where an order note lives; audit T11 F4 / T00 F1).
        // Name on card is always searched on the main page (outside iframe).
        // Falls through to Strategy 1 if the card number could not be placed.
        // ============================================================
        if (hints && (hints.card_selector || hints.exp_selector || hints.cvv_selector)) {
            let cardContexts: (Frame | Page)[] = [page];
            if (hints.iframe_selector) {
                // Card frames load after the page; until then they sit at about:blank
                // and fail the origin check.
                await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
                cardContexts = page.frames().filter((f) =>
                    f !== page.mainFrame() &&
                    f.name().includes(hints.iframe_selector as string) &&
                    isTrustedCardFrame(f.url(), cardData.merchant_domain)
                );
            }

            const fillHint = async (selector: string | undefined, value: string, kind: FieldKind, contexts: (Frame | Page)[]): Promise<boolean> => {
                if (!isPlainCss(selector)) return false;
                for (const ctx of contexts) {
                    const el = await ctx.$(selector).catch(() => null);
                    if (el) return smartFill(gate, el, value, kind);
                }
                return false;
            };

            let hintFilled = 0;
            if (await fillHint(hints.card_selector, cardData.number, 'number', cardContexts)) { hintFilled++; cardNumberFilled = true; }
            if (hints.exp_selector) {
                // Expiry combined (with space-padded slash for Shopify: "MM / YY")
                if (await fillHint(hints.exp_selector, `${cardData.exp_month} / ${cardData.exp_year.slice(-2)}`, 'exp', cardContexts)) hintFilled++;
            } else if (hints.exp_month_selector) {
                if (await fillHint(hints.exp_month_selector, cardData.exp_month, 'exp', cardContexts)) hintFilled++;
                if (await fillHint(hints.exp_year_selector, cardData.exp_year, 'exp', cardContexts)) hintFilled++;
            }
            if (await fillHint(hints.cvv_selector, cardData.cvv, 'cvv', cardContexts)) hintFilled++;
            // Name on card — ALWAYS on main page (outside iframe for Shopify/most platforms)
            if (cardNumberFilled && await fillHint(hints.name_selector, cardData.name, 'name', [page])) hintFilled++;

            const stopped = stopIfMoved();
            if (stopped) return stopped;

            if (cardNumberFilled) {
                filledFields += hintFilled;
                const modeNote = `${filledFields} fields injected via agent hints${hints.iframe_selector ? ' (iframe mode)' : ''}.`;

                // Must actually submit to have any chance of a real payment.
                let clicked = false;
                if (isPlainCss(hints.submit_selector)) {
                    const btn = await page.$(hints.submit_selector).catch(() => null);
                    if (btn) {
                        const c = await clickIfStillLocked(gate, btn);
                        if (typeof c === 'object') return { success: false, status: 'blocked', message: c.ok ? '' : c.reason };
                        clicked = c === 'clicked';
                    }
                }

                if (!clicked) {
                    // Fields filled but no submit happened → NOT a payment. Do not fabricate success.
                    return {
                        success: false,
                        status: 'not_submitted',
                        message:
                            `${modeNote} No submit/pay button was clicked (provide a submit_selector via get_merchant_hints). ` +
                            `The order was NOT placed and the token was NOT burned.`,
                    };
                }

                // Submitted — observe the real outcome before declaring success.
                const outcome = await detectPaymentOutcome(page, checkoutUrl);
                return outcomeToResult(outcome, modeNote);
            }
            // hints provided but the card number could not be placed → fall through to Strategy 1
        }

        // ============================================================
        // STRATEGY 1: Standard HTML form fields
        // Covers: plain forms, Shopify, WooCommerce, custom checkouts
        // Priority: autocomplete (W3C) → name → platform-specific → placeholder → aria-label
        // ============================================================
        const S = {
            number: [
                '[autocomplete="cc-number"]',
                'input[name="cardnumber"]',
                'input[name="card-number"]',
                'input[name="cc-number"]',
                'input[name="card_number"]',
                'input[name="checkout[payment][card_number]"]',       // Shopify
                'input[id="wc-stripe-cc-number"]',                    // WooCommerce
                'input[data-elements-stable-field-name="cardNumber"]',
                'input[placeholder*="card number" i]',
                'input[aria-label*="card number" i]',
            ],
            expiry: [
                '[autocomplete="cc-exp"]',
                'input[name="exp-date"]',
                'input[name="cc-exp"]',
                'input[name="expiry"]',
                'input[name="checkout[payment][card_expiry]"]',       // Shopify
                'input[placeholder*="MM / YY" i]',
                'input[placeholder*="MM/YY" i]',
                'input[aria-label*="expir" i]',
            ],
            exp_month: [
                '[autocomplete="cc-exp-month"]',
                'select[name="exp-month"]',
                'select[name="exp_month"]',
                'select[name="card_exp_month"]',
                'select[id*="exp-month" i]',
                'select[id*="exp_month" i]',
                'input[name="exp-month"]',
                'input[name="exp_month"]',
            ],
            exp_year: [
                '[autocomplete="cc-exp-year"]',
                'select[name="exp-year"]',
                'select[name="exp_year"]',
                'select[name="card_exp_year"]',
                'select[id*="exp-year" i]',
                'select[id*="exp_year" i]',
                'input[name="exp-year"]',
                'input[name="exp_year"]',
            ],
            cvv: [
                '[autocomplete="cc-csc"]',
                'input[name="cvc"]',
                'input[name="cvv"]',
                'input[name="cc-csc"]',
                'input[name="security_code"]',
                'input[name="checkout[payment][card_cvc]"]',          // Shopify
                'input[id="wc-stripe-cc-cvc"]',                       // WooCommerce
                'input[placeholder*="CVC" i]',
                'input[placeholder*="CVV" i]',
                'input[placeholder*="security" i]',
                'input[aria-label*="security code" i]',
                'input[aria-label*="CVC" i]',
            ],
            name: [
                '[autocomplete="cc-name"]',
                'input[name="ccname"]',
                'input[name="cc-name"]',
                'input[name="card-name"]',
                'input[name="card_name"]',
                'input[placeholder*="name on card" i]',
                'input[placeholder*="cardholder" i]',
                'input[aria-label*="name on card" i]',
            ],
        };

        // Card Number
        if (await tryFillField(gate, page, S.number, cardData.number, 'number')) { filledFields++; cardNumberFilled = true; }

        // Expiry: try combined MM/YY first
        const expiryValue = `${cardData.exp_month}/${cardData.exp_year.slice(-2)}`;
        let expiryFilled = await tryFillField(gate, page, S.expiry, expiryValue, 'exp');
        if (expiryFilled) filledFields++;

        // Expiry: fallback to separate month + year (works with both <input> AND <select>)
        if (!expiryFilled) {
            if (await tryFillField(gate, page, S.exp_month, cardData.exp_month, 'exp')) filledFields++;
            if (await tryFillField(gate, page, S.exp_year, cardData.exp_year, 'exp')) filledFields++;
        }

        // CVV
        if (await tryFillField(gate, page, S.cvv, cardData.cvv, 'cvv')) filledFields++;

        // Name on Card
        if (await tryFillField(gate, page, S.name, cardData.name, 'name')) filledFields++;

        const stopped1 = stopIfMoved();
        if (stopped1) return stopped1;

        // ============================================================
        // STRATEGY 2: Stripe Elements (iframe-based)
        // Stripe renders payment inputs inside iframes from js.stripe.com.
        // Stripe has 2 modes:
        //   - Unified: 1 iframe with all fields (card, exp, cvc in one)
        //   - Split: separate iframes per field (cardNumber, cardExpiry, cardCvc)
        // We handle both by scanning ALL matching Stripe frames.
        // ============================================================
        if (!cardNumberFilled) {
            await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
            // Recognised by the frame's real origin, never by its name or a substring of
            // its URL: any frame can call itself __privateStripeFrame or carry
            // "js.stripe.com" in a query string (audit MCP-03 / N3).
            const stripeFrames = page.frames().filter((f) => {
                try {
                    const u = new URL(f.url());
                    return u.protocol === 'https:' && (u.hostname === 'stripe.com' || u.hostname.endsWith('.stripe.com'));
                } catch { return false; }
            });

            for (const frame of stripeFrames) {
                if (await tryFillField(gate, frame, [
                    'input[name="cardnumber"]',
                    'input[autocomplete="cc-number"]',
                    'input[data-elements-stable-field-name="cardNumber"]',
                ], cardData.number, 'number')) { filledFields++; cardNumberFilled = true; }

                // Expiry (Stripe uses MM/YY without slash)
                if (await tryFillField(gate, frame, [
                    'input[name="exp-date"]',
                    'input[autocomplete="cc-exp"]',
                    'input[data-elements-stable-field-name="cardExpiry"]',
                ], `${cardData.exp_month}${cardData.exp_year.slice(-2)}`, 'exp')) filledFields++;

                if (await tryFillField(gate, frame, [
                    'input[name="cvc"]',
                    'input[autocomplete="cc-csc"]',
                    'input[data-elements-stable-field-name="cardCvc"]',
                ], cardData.cvv, 'cvv')) filledFields++;
            }
            const stopped2 = stopIfMoved();
            if (stopped2) return stopped2;
        }

        if (filledFields === 0) {
            return {
                success: false,
                status: 'no_fields',
                message:
                    "Could not detect any credit card fields on this page. " +
                    (landedElsewhere
                        ? "The checkout URL redirected elsewhere (see page_detail) — the cart/session likely did not carry over. " +
                          "Z-Zero opens its OWN fresh browser, so checkout_url must be resumable on its own " +
                          "(e.g. a Shopify/Etsy checkout-token URL), not a page that needs the agent's logged-in session. "
                        : "") +
                    "The checkout form may use an unsupported format, or the page requires a logged-in session.",
                ...(landedElsewhere ? { page_detail: `landed on: ${landedUrl}` } : {}),
            };
        }

        // ============================================================
        // LOOK FOR "PAY" / "SUBMIT" BUTTON
        // ============================================================
        const payButtonSelectors = [
            'button[type="submit"]',
            'button:has-text("Pay")',
            'button:has-text("Submit")',
            'button:has-text("Place order")',
            'button:has-text("Complete")',
            'input[type="submit"]',
        ];

        let clicked = false;
        for (const selector of payButtonSelectors) {
            const btn = await page.$(selector).catch(() => null);
            if (!btn) continue;
            const c = await clickIfStillLocked(gate, btn);
            if (typeof c === 'object') return { success: false, status: 'blocked', message: c.ok ? '' : c.reason };
            if (c === 'clicked') { clicked = true; break; }
        }

        const fieldNote = `${filledFields} fields injected.`;

        if (!clicked) {
            // Form filled but no Pay button found → the order was never submitted.
            return {
                success: false,
                status: 'not_submitted',
                message:
                    `${fieldNote} No Pay/Submit button could be found or clicked, so the order was NOT placed ` +
                    `and the token was NOT burned. Use get_merchant_hints to supply a submit_selector.`,
            };
        }

        // Submitted — observe the real outcome (confirmed / declined / unconfirmed)
        // instead of blindly assuming success. receipt_id is set ONLY if a real one is scraped.
        const outcome = await detectPaymentOutcome(page, checkoutUrl);
        return outcomeToResult(outcome, fieldNote);
    } catch (error: unknown) {
        return {
            success: false,
            status: 'error',
            message: 'The browser failed during the checkout attempt.',
            page_detail: error instanceof Error ? error.message : String(error),
        };
    } finally {
        gate.dispose();
        // ============================================================
        // RAM WIPE - Critical security step
        // ============================================================
        // Overwrite card data with zeros before dereferencing
        cardData.number = "0000000000000000";
        cardData.cvv = "000";
        cardData.exp_month = "00";
        cardData.exp_year = "0000";
        cardData.name = "";
        // Note: browser.close() is handled by fillCheckoutForm's outer finally block
    }
}
