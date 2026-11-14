// M.2 (audit T11 F1–F3, F5, F6; T12 F1, F2; T00 F1; T19): where a card may be typed.
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness/boot.mjs";
import { seedToken, FAKE_PAN } from "./harness/fake-api.mjs";

const z = await boot();
test.after(() => z.close());
const go = (page_shows) => ({ page_shows, decision: "go" });
const pay = (token, checkout_url, amount, hints) =>
    z.call("execute_payment", { token, checkout_url, actual_amount: amount, ...(hints ? { hints } : {}), recheck: go(`Item $${amount}`) });
const gotCard = (pred) => z.sites.records.some((r) => pred(r) && JSON.stringify(r).includes(FAKE_PAN));
const settle = () => new Promise((ok) => setTimeout(ok, 300));

test("a stranger's *.myshopify.com page is not a payment page for another store (T11 F1)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 45, merchant: "etsy.com" });
    await pay(token, "https://etsy.com/listing?to=" + encodeURIComponent("https://evil-attacker.myshopify.com/form?tag=myshopify"), 45, { pre_steps: ["#pay-link"] });
    await settle();
    assert.equal(gotCard((r) => r.tag === "myshopify"), false, "card typed on evil-attacker.myshopify.com");
});

test("a hosted payment page the store hands off to still works (checkout.stripe.com)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 45, merchant: "etsy.com" });
    const r = await pay(token, "https://etsy.com/listing?to=" + encodeURIComponent("https://checkout.stripe.com/form?tag=stripe_hosted"), 45, { pre_steps: ["#pay-link"] });
    assert.equal(r.parsed?.status, "confirmed", r.text);
    assert.ok(gotCard((x) => x.tag === "stripe_hosted"));
});

for (const ms of [0, 150, 400, 680]) {
    test(`page moves to another site ${ms}ms after the lock check: card not typed there (T11 F2 / T12 F2)`, async () => {
        z.sites.reset();
        const token = seedToken(z.api, { amount: 35, merchant: "meanblvd.com" });
        const r = await pay(token, `https://meanblvd.com/delayed-js?ms=${ms}`, 35, { pre_steps: ["#next-btn"], card_selector: "#locked-field" });
        await settle();
        assert.equal(gotCard((x) => x.tag === "toctou_js"), false, `card reached evil.io: ${r.text.slice(0, 300)}`);
    });
}

test("slow link to another site after the lock check: card not typed there", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 35, merchant: "meanblvd.com" });
    await pay(token, "https://meanblvd.com/slow-link", 35, { pre_steps: ["#slow-anchor"], card_selector: "#locked-field" });
    await settle();
    assert.equal(gotCard((x) => x.tag === "toctou_slow"), false);
});

test("a selector cannot walk into another site's frame (T12 F1)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 19, merchant: "meanblvd.com" });
    await pay(token, "https://meanblvd.com/frame-host?src=" + encodeURIComponent("https://evil-widget.io/subframe?tag=cross_frame"), 19, {
        card_selector: "iframe#ext-frame >> internal:control=enter-frame >> #number",
        exp_selector: "iframe#ext-frame >> internal:control=enter-frame >> #expiry",
        cvv_selector: "iframe#ext-frame >> internal:control=enter-frame >> #verification_value",
        submit_selector: "#submit-btn",
    });
    await settle();
    assert.equal(gotCard((x) => x.tag === "cross_frame"), false, "card typed into evil-widget.io frame");
});

test("invisible 2px fields on the page do not get the card ahead of the real Stripe frame", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 15, merchant: "meanblvd.com" });
    const r = await pay(token, "https://meanblvd.com/opacity-priority", 15);
    await settle();
    assert.equal(gotCard((x) => x.tag === "opacity_main"), false, "card typed into invisible main-page fields");
    assert.ok(gotCard((x) => x.tag === "real_stripe"), `Stripe frame did not get the card: ${r.text.slice(0, 300)}`);
});

test("redirect to plain http on the same store: card not typed (T11 F3)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 20, merchant: "meanblvd.com" });
    await pay(token, "https://meanblvd.com/downgrade", 20);
    await settle();
    assert.equal(gotCard((x) => x.tag === "http_downgrade"), false);
});

test("another port on the store's host is not the store (T11 F6)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 30, merchant: "meanblvd.com" });
    const r = await pay(token, "https://meanblvd.com:8443/form?tag=alt_port", 30);
    await settle();
    assert.equal(gotCard((x) => x.tag === "alt_port"), false);
    assert.equal(r.parsed?.status, "blocked", r.text);
});

test("*.localhost and localhost. are refused before any browser opens (T19)", async () => {
    for (const url of ["https://shop.localhost/form", "https://localhost./form"]) {
        const token = seedToken(z.api, { amount: 20, merchant: "meanblvd.com" });
        const r = await pay(token, url, 20);
        assert.equal(r.parsed?.status, "blocked", `${url}: ${r.text.slice(0, 200)}`);
        assert.match(r.parsed?.message ?? "", /Refused to open checkout_url/, url);
    }
});

test("a card for alice.gumroad.com is not a card for gumroad.com (T11 F5)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 25, merchant: "alice.gumroad.com" });
    await pay(token, "https://gumroad.com/form?tag=parent", 25);
    await settle();
    assert.equal(gotCard((x) => x.tag === "parent"), false);
});

test("domain-lock rules (unit)", () => {
    const { checkCheckoutUrl, checkPaymentPage, isTrustedCardFrame } = z.lib("domain-lock");
    const L = "meanblvd.com";
    assert.equal(checkCheckoutUrl("https://meanblvd.com/x", L).ok, true);
    assert.equal(checkCheckoutUrl("https://shop.meanblvd.com/x", L).ok, true);
    assert.equal(checkCheckoutUrl("http://meanblvd.com/x", L).ok, false);
    assert.equal(checkCheckoutUrl("https://meanblvd.com:8443/x", L).ok, false);
    assert.equal(checkCheckoutUrl("https://gumroad.com/x", "alice.gumroad.com").ok, false);
    assert.equal(checkPaymentPage("https://x.myshopify.com/checkouts/1", L).ok, false);
    assert.equal(checkPaymentPage("https://meanblvd.myshopify.com/checkouts/1", "meanblvd.myshopify.com").ok, true);
    assert.equal(checkPaymentPage("https://checkout.stripe.com/c/pay/x", L).ok, true);
    assert.equal(checkPaymentPage("https://shop.localhost/x", "localhost").ok, false);
    assert.equal(isTrustedCardFrame("https://cdn.shopify.com/s/files/evil.svg", L), false);
    assert.equal(isTrustedCardFrame("https://checkout.pci.shopifyinc.com/build/x", L), true);
    assert.equal(isTrustedCardFrame("https://js.stripe.com:8443/v3", L), false);
});
