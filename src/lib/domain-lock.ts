// domain-lock.ts
// Where a card may be typed (founder decision 23/10/2026). Each card is locked
// at issue time to the store's domain; the server returns it with the card
// (/api/tokens/resolve → merchant_domain). Two checks use it:
//   1. the checkout_url the agent hands us must be on that domain — before any
//      browser opens;
//   2. the page in front of us right before typing must be on that domain, or
//      on a hosted payment page a store hands off to (Stripe Checkout, PayPal…).
// A reseller wrapping someone else's payment link, or a look-alike page, fails
// check 1; a redirect away from the store to anywhere else fails check 2.
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
/** Suffixes for the same (store subdomains on a payment platform). */
const PAYMENT_PAGE_SUFFIXES: string[] = [".myshopify.com", ".paypal.com"];

function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    } catch {
        return null;
    }
}

/** Same store: equal, or one is a subdomain of the other (shop.x.com ↔ x.com). */
function sameSite(host: string, locked: string): boolean {
    return host === locked || host.endsWith("." + locked) || locked.endsWith("." + host);
}

function isPaymentPage(host: string): boolean {
    return PAYMENT_PAGE_HOSTS.includes(host) || PAYMENT_PAGE_SUFFIXES.some((s) => host.endsWith(s));
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
    const host = hostOf(checkoutUrl);
    if (host && sameSite(host, lockedDomain)) return { ok: true };
    return {
        ok: false,
        reason:
            `checkout_url is on ${host ?? "an unreadable host"}, but this card is locked to ${lockedDomain}. ` +
            `The card is only typed on the store it was issued for.`,
    };
}

/** Check 2 — the page actually in front of us, right before the card is typed. */
export function checkPaymentPage(pageUrl: string, lockedDomain: string | null | undefined): LockCheck {
    if (!lockedDomain) return noLock();
    const host = hostOf(pageUrl);
    if (host && (sameSite(host, lockedDomain) || isPaymentPage(host))) return { ok: true };
    return {
        ok: false,
        reason:
            `The page moved to ${host ?? "an unreadable host"}, which is neither ${lockedDomain} nor a known payment page. ` +
            `The card was NOT typed in.`,
    };
}
