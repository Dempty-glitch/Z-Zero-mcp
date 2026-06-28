// Playwright Bridge - The "Invisible Hand"
// Securely injects card data into checkout forms without exposing it to AI

import { chromium } from "playwright";
import type { CardData, PaymentResult, CheckoutHints } from "./types.js";
import { withTimeout, TimeoutError } from "./lib/with-timeout.js";

const CHECKOUT_HARD_TIMEOUT_MS = 60_000; // 60s absolute cap — prevents slow-loris attacks

/**
 * Detects and fills credit card form fields on a checkout page.
 * Card data exists ONLY in RAM and is wiped after injection.
 * Hard timeout of 60s prevents merchant page from hanging indefinitely.
 */
export async function fillCheckoutForm(
    checkoutUrl: string,
    cardData: CardData,
    existingPage?: import("playwright").Page,
    hints?: CheckoutHints
): Promise<PaymentResult> {
    let browser: import("playwright").Browser | null = null;
    let page: import("playwright").Page;

    if (existingPage) {
        page = existingPage;
    } else {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        page = await context.newPage();
    }

    try {
        return await withTimeout(
            _fillCheckoutFormInner(page, checkoutUrl, cardData, hints),
            CHECKOUT_HARD_TIMEOUT_MS,
            'fillCheckoutForm',
            async () => {
                console.error('[PLAYWRIGHT] ⚠️ Hard timeout hit — force-closing browser');
                if (browser) await browser.close().catch(() => {});
            }
        );
    } catch (err: unknown) {
        if (err instanceof TimeoutError) {
            return {
                success: false,
                status: 'error',
                message: `Checkout timed out after ${CHECKOUT_HARD_TIMEOUT_MS / 1000}s. The merchant page may be too slow or blocking automation.`,
            };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, status: 'error', message: `Payment failed: ${errMsg}` };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ============================================================
// HELPER: Smart fill — handles both <input> and <select>
// Prevents crash when dropdown uses <select> instead of <input>
// ============================================================
async function smartFill(el: import("playwright").ElementHandle, value: string): Promise<boolean> {
    try {
        const tag = await el.evaluate(e => (e as HTMLElement).tagName.toLowerCase());
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
        return false;
    }
}

/** Try each selector in order, smartFill the first match */
async function tryFillField(
    page: import("playwright").Page,
    selectors: string[],
    value: string
): Promise<boolean> {
    for (const selector of selectors) {
        const el = await page.$(selector);
        if (el) {
            const ok = await smartFill(el, value);
            if (ok) return true;
        }
    }
    return false;
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
 * Watches the page after Pay is clicked and classifies the real outcome.
 * Polls URL + visible text for a confirmation or decline signal until a
 * signal is seen or CONFIRM_WAIT_MS elapses. Default (no signal) is the
 * SAFE 'unconfirmed' — caller must NOT burn the token on that.
 */
async function detectPaymentOutcome(
    page: import("playwright").Page,
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
            bodyText = await page.evaluate(() => document.body?.innerText ?? '');
        } catch {
            // page is mid-navigation — wait and retry
            await page.waitForTimeout(CONFIRM_POLL_MS);
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

        await page.waitForTimeout(CONFIRM_POLL_MS);
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

/** Internal implementation — called by fillCheckoutForm inside a timeout wrapper */
async function _fillCheckoutFormInner(
    page: import("playwright").Page,
    checkoutUrl: string,
    cardData: CardData,
    hints?: CheckoutHints
): Promise<PaymentResult> {
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
                try {
                    const el = await page.$(selector);
                    if (el && await el.isVisible()) {
                        await el.click();
                        await page.waitForTimeout(500); // brief pause for animation
                    }
                } catch { /* non-fatal — continue */ }
            }
        }

        let filledFields = 0;

        // ============================================================
        // STRATEGY 0.5: Agent-provided selectors (from get_merchant_hints)
        // Tried first — agent already read the DOM and knows exact locations.
        // Supports iframe_selector: if provided, card fields are searched INSIDE
        // matching iframes (e.g. Shopify "card-fields-iframe") rather than main page.
        // Name on card is always searched on the main page (outside iframe).
        // Falls through to Strategy 1 if nothing matched.
        // ============================================================
        if (hints && (hints.card_selector || hints.exp_selector || hints.cvv_selector)) {
            const hintFillResults: boolean[] = [];

            // Determine search context: matching iframe frames or main page.
            // When iframe_selector is set, Playwright finds frames whose name includes
            // that fragment. Shopify uses separate iframes per field so we collect ALL.
            type SearchCtx = import('playwright').Frame | import('playwright').Page;
            let cardContexts: SearchCtx[] = [page];
            if (hints.iframe_selector) {
                const matchingFrames = page.frames().filter((f) =>
                    f.name().includes(hints.iframe_selector as string)
                );
                if (matchingFrames.length > 0) cardContexts = matchingFrames;
            }

            // Card number
            if (hints.card_selector) {
                for (const ctx of cardContexts) {
                    const el = await ctx.$(hints.card_selector);
                    if (el) { hintFillResults.push(await smartFill(el, cardData.number)); break; }
                }
            }

            // Expiry combined (with space-padded slash for Shopify: "MM / YY")
            if (hints.exp_selector) {
                const expiryVal = `${cardData.exp_month} / ${cardData.exp_year.slice(-2)}`;
                for (const ctx of cardContexts) {
                    const el = await ctx.$(hints.exp_selector);
                    if (el) { hintFillResults.push(await smartFill(el, expiryVal)); break; }
                }
            }

            // Expiry split month/year
            if (!hints.exp_selector && hints.exp_month_selector) {
                for (const ctx of cardContexts) {
                    const elM = await ctx.$(hints.exp_month_selector);
                    if (elM) { hintFillResults.push(await smartFill(elM, cardData.exp_month)); break; }
                }
                if (hints.exp_year_selector) {
                    for (const ctx of cardContexts) {
                        const elY = await ctx.$(hints.exp_year_selector);
                        if (elY) { hintFillResults.push(await smartFill(elY, cardData.exp_year)); break; }
                    }
                }
            }

            // CVV
            if (hints.cvv_selector) {
                for (const ctx of cardContexts) {
                    const el = await ctx.$(hints.cvv_selector);
                    if (el) { hintFillResults.push(await smartFill(el, cardData.cvv)); break; }
                }
            }

            // Name on card — ALWAYS on main page (outside iframe for Shopify/most platforms)
            if (hints.name_selector) {
                const el = await page.$(hints.name_selector);
                if (el) { hintFillResults.push(await smartFill(el, cardData.name)); }
            }

            const hintSuccesses = hintFillResults.filter(Boolean).length;
            if (hintSuccesses > 0) {
                filledFields += hintSuccesses;
                const modeNote = `${filledFields} fields injected via agent hints${hints.iframe_selector ? ' (iframe mode)' : ''}.`;

                // Must actually submit to have any chance of a real payment.
                let clicked = false;
                if (hints.submit_selector) {
                    try {
                        const btn = await page.$(hints.submit_selector);
                        if (btn && await btn.isVisible()) { await btn.click(); clicked = true; }
                    } catch { /* non-fatal */ }
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
            // hints provided but nothing matched → fall through to Strategy 1
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
        if (await tryFillField(page, S.number, cardData.number)) filledFields++;

        // Expiry: try combined MM/YY first
        const expiryValue = `${cardData.exp_month}/${cardData.exp_year.slice(-2)}`;
        let expiryFilled = await tryFillField(page, S.expiry, expiryValue);
        if (expiryFilled) filledFields++;

        // Expiry: fallback to separate month + year (works with both <input> AND <select>)
        if (!expiryFilled) {
            if (await tryFillField(page, S.exp_month, cardData.exp_month)) filledFields++;
            if (await tryFillField(page, S.exp_year, cardData.exp_year)) filledFields++;
        }

        // CVV
        if (await tryFillField(page, S.cvv, cardData.cvv)) filledFields++;

        // Name on Card
        if (await tryFillField(page, S.name, cardData.name)) filledFields++;

        // ============================================================
        // STRATEGY 2: Stripe Elements (iframe-based)
        // Stripe renders payment inputs inside iframes from js.stripe.com.
        // Some merchants use __privateStripeFrame* named frames.
        // Stripe has 2 modes:
        //   - Unified: 1 iframe with all fields (card, exp, cvc in one)
        //   - Split: separate iframes per field (cardNumber, cardExpiry, cardCvc)
        // We handle both by scanning ALL matching Stripe frames.
        // ============================================================
        if (filledFields === 0) {
            const stripeFrames = page.frames().filter((f) => {
                const url = f.url();
                const name = f.name();
                return url.includes('js.stripe.com')
                    || url.includes('stripe.com/elements')
                    || name.startsWith('__privateStripeFrame');
            });

            for (const frame of stripeFrames) {
                // Card Number
                for (const sel of [
                    'input[name="cardnumber"]',
                    'input[autocomplete="cc-number"]',
                    'input[data-elements-stable-field-name="cardNumber"]',
                ]) {
                    const el = await frame.$(sel);
                    if (el) { await el.fill(cardData.number); filledFields++; break; }
                }

                // Expiry (Stripe uses MM/YY without slash)
                for (const sel of [
                    'input[name="exp-date"]',
                    'input[autocomplete="cc-exp"]',
                    'input[data-elements-stable-field-name="cardExpiry"]',
                ]) {
                    const el = await frame.$(sel);
                    if (el) {
                        await el.fill(`${cardData.exp_month}${cardData.exp_year.slice(-2)}`);
                        filledFields++;
                        break;
                    }
                }

                // CVC
                for (const sel of [
                    'input[name="cvc"]',
                    'input[autocomplete="cc-csc"]',
                    'input[data-elements-stable-field-name="cardCvc"]',
                ]) {
                    const el = await frame.$(sel);
                    if (el) { await el.fill(cardData.cvv); filledFields++; break; }
                }
            }
        }

        if (filledFields === 0) {
            return {
                success: false,
                status: 'no_fields',
                message:
                    "Could not detect any credit card fields on this page. " +
                    (landedElsewhere
                        ? `The checkout URL redirected to ${landedUrl} — the cart/session likely did not carry over. ` +
                          "Z-Zero opens its OWN fresh browser, so checkout_url must be resumable on its own " +
                          "(e.g. a Shopify/Etsy checkout-token URL), not a page that needs the agent's logged-in session. "
                        : "") +
                    "The checkout form may use an unsupported format, or the page requires a logged-in session.",
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
            const btn = await page.$(selector);
            if (btn && (await btn.isVisible())) {
                await btn.click();
                clicked = true;
                break;
            }
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
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            status: 'error',
            message: `Payment failed: ${errMsg}`,
        };
    } finally {
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
