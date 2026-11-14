// domain-lock.ts
// Where a card may be typed (founder decision 23/10/2026). Each card is locked
// at issue time to the store's domain; the server returns it with the card
// (/api/tokens/resolve → merchant_domain). Two checks use it:
//   1. the checkout_url the agent hands us must be on that domain — before any
//      browser opens;
//   2. the page in front of us when each field is typed must be on that domain,
//      or on a hosted payment page a store hands off to (Stripe Checkout,
//      PayPal…). playwright_bridge.ts asks again for every field (CardGate).
// A reseller wrapping someone else's payment link, or a look-alike page, fails
// check 1; a redirect away from the store to anywhere else fails check 2.
//
// Both checks want the plain public web: https on the default port, not a
// `*.localhost` name (audit T11 F3/F6, T19). A store's own domain covers its
// subdomains (shop.x.com for x.com) — never the other way round: a card locked
// to alice.gumroad.com is not a card for gumroad.com (audit T11 F5).
//
// Known residue: a hosted payment page is trusted by host only, so a store that
// redirects to SOMEONE ELSE's Stripe/PayPal page passes. The issuer-side caps
// ($50, single use, no cash/funding) bound that case.

/** Hosted payment pages a store may legitimately hand the buyer off to. */
const PAYMENT_PAGE_HOSTS: string[] = [
    "checkout.shopify.com",
    "shop.app",
    "checkout.stripe.com",
    "buy.stripe.com",
    "paypal.com",
    "checkoutshopper-live.adyen.com",
    "checkout.square.site",
    "square.link",
    "pay.checkout.com",
];
/**
 * Suffixes for the same. `.myshopify.com` is NOT here (audit T11 F1): every
 * Shopify store, a stranger's included, lives under it. A store whose own
 * domain is x.myshopify.com is still covered by its lock.
 */
const PAYMENT_PAGE_SUFFIXES: string[] = [".paypal.com"];

/** The machine owner's explicit opt-in for a checkout served from this machine (tests). */
function localCheckoutAllowed(url: URL): boolean {
    return process.env.Z_ZERO_ALLOW_LOCAL_CHECKOUT === "1" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * The host of a URL a card may go to, or null: https only, default port only,
 * no `*.localhost`. (The local opt-in above is the one exception.)
 */
function publicHostOf(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (localCheckoutAllowed(url)) return host;
    if (url.protocol !== "https:" || url.port !== "") return null;
    if (host === "localhost" || host.endsWith(".localhost")) return null;
    return host.replace(/^www\./, "");
}

/** Same store: equal, or a subdomain of the locked domain (shop.x.com for x.com). */
function sameSite(host: string, locked: string): boolean {
    const l = locked.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return host === l || host.endsWith("." + l);
}

function isPaymentPage(host: string): boolean {
    return PAYMENT_PAGE_HOSTS.includes(host) || PAYMENT_PAGE_SUFFIXES.some((s) => host.endsWith(s));
}

function describe(raw: string): string {
    try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}`;
    } catch {
        return "an unreadable address";
    }
}

export type LockCheck = { ok: true } | { ok: false; reason: string };

function noLock(): LockCheck {
    return {
        ok: false,
        reason:
            "This card has no merchant domain lock (issued before the lock existed, or for a merchant name instead of a domain). " +
            "Cancel it with cancel_payment_token and request a new card with merchant = the store's domain.",
    };
}

/** Check 1 — the URL the agent wants us to pay on, before opening anything. */
export function checkCheckoutUrl(checkoutUrl: string, lockedDomain: string | null | undefined): LockCheck {
    if (!lockedDomain) return noLock();
    const host = publicHostOf(checkoutUrl);
    if (host && sameSite(host, lockedDomain)) return { ok: true };
    return {
        ok: false,
        reason: host
            ? `checkout_url is on ${host}, but this card is locked to ${lockedDomain}. The card is only typed on the store it was issued for.`
            : `checkout_url ${describe(checkoutUrl)} is not a plain https page on the default port. The card is only typed on https://${lockedDomain}.`,
    };
}

/** Check 2 — the page actually in front of us, right before the card is typed. */
export function checkPaymentPage(pageUrl: string, lockedDomain: string | null | undefined): LockCheck {
    if (!lockedDomain) return noLock();
    const host = publicHostOf(pageUrl);
    if (host && (sameSite(host, lockedDomain) || isPaymentPage(host))) return { ok: true };
    return {
        ok: false,
        reason:
            `The page moved to ${describe(pageUrl)}, which is neither https://${lockedDomain} nor a known payment page. ` +
            `The card was NOT typed in.`,
    };
}

/**
 * Card-field iframe providers. Exact provider domains only: `.shopify.com` was
 * here and covers cdn.shopify.com, where any store uploads files — an uploaded
 * SVG served from there passed as a "card frame" (audit T11 F4 / T19).
 */
const CARD_FRAME_SUFFIXES: string[] = [
    ".stripe.com", ".shopifyinc.com", ".shopifycs.com", ".braintreegateway.com",
    ".adyen.com", ".squarecdn.com", ".checkout.com", ".paypal.com",
];

/**
 * May a card field inside this frame receive card data? Only when the frame
 * really comes from the locked store or a payment provider — judged by its
 * origin, never by the frame's self-chosen name (audit MCP-03 / N3).
 */
export function isTrustedCardFrame(frameUrl: string, lockedDomain: string | null | undefined): boolean {
    const host = publicHostOf(frameUrl);
    if (!host) return false;
    if (lockedDomain && sameSite(host, lockedDomain)) return true;
    return CARD_FRAME_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}
