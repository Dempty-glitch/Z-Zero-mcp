// Domain lock (lib/domain-lock.ts): where a card may be typed.
// Run: npm run test:domain-lock
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCheckoutUrl, checkPaymentPage } from "../dist/lib/domain-lock.js";

const L = "meanblvd.com";

test("checkout_url must be on the locked store", () => {
    assert.equal(checkCheckoutUrl("https://meanblvd.com/checkouts/cn/abc", L).ok, true);
    assert.equal(checkCheckoutUrl("https://www.meanblvd.com/x", L).ok, true);
    assert.equal(checkCheckoutUrl("https://shop.meanblvd.com/x", L).ok, true);
    assert.equal(checkCheckoutUrl("https://meanblvd.com.evil.io/x", L).ok, false);
    assert.equal(checkCheckoutUrl("https://evilmeanblvd.com/x", L).ok, false);
    // A reseller's wrapped payment link is not the store.
    assert.equal(checkCheckoutUrl("https://checkout.stripe.com/c/pay/x", L).ok, false);
});

test("no lock = refuse", () => {
    assert.equal(checkCheckoutUrl("https://meanblvd.com/x", null).ok, false);
    assert.equal(checkPaymentPage("https://meanblvd.com/x", undefined).ok, false);
});

test("live page: the store or a hosted payment page it handed off to", () => {
    assert.equal(checkPaymentPage("https://meanblvd.com/thanks", L).ok, true);
    assert.equal(checkPaymentPage("https://checkout.stripe.com/c/pay/x", L).ok, true);
    assert.equal(checkPaymentPage("https://www.paypal.com/checkoutnow", L).ok, true);
    // A stranger's Shopify store is not a payment page for this store (audit T11 F1).
    assert.equal(checkPaymentPage("https://x.myshopify.com/checkouts/1", L).ok, false);
    assert.equal(checkPaymentPage("https://meanblvd.myshopify.com/c/1", "meanblvd.myshopify.com").ok, true);
    // https, default port, no *.localhost (audit T11 F3/F6, T19).
    assert.equal(checkPaymentPage("http://meanblvd.com/x", L).ok, false);
    assert.equal(checkPaymentPage("https://meanblvd.com:8443/x", L).ok, false);
    assert.equal(checkPaymentPage("https://meanblvd.localhost/x", "meanblvd.localhost").ok, false);
    // A parent domain is not covered by a subdomain lock (audit T11 F5).
    assert.equal(checkCheckoutUrl("https://gumroad.com/l/x", "alice.gumroad.com").ok, false);
    assert.equal(checkPaymentPage("https://pay-meanblvd.com/x", L).ok, false);
});

test("card iframes are trusted by origin, never by name", async () => {
    const { isTrustedCardFrame } = await import("../dist/lib/domain-lock.js");
    assert.equal(isTrustedCardFrame("https://js.stripe.com/v3/elements-inner-card", L), true);
    assert.equal(isTrustedCardFrame("https://checkout.pci.shopifyinc.com/build/x", L), true);
    assert.equal(isTrustedCardFrame("https://meanblvd.com/pay-frame", L), true);
    assert.equal(isTrustedCardFrame("https://evil.io/?js.stripe.com", L), false);
    assert.equal(isTrustedCardFrame("about:blank", L), false);
});
