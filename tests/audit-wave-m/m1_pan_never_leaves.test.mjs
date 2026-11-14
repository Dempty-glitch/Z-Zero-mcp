// M.1 (audit T12 F3, F9; T19): the card number never leaves the card-typing code —
// not in an error the model reads, not in receipt_id, not in what is sent to /api/receipts.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, hasPan } from "./harness/boot.mjs";
import { seedToken, FAKE_CVV } from "./harness/fake-api.mjs";

const z = await boot();
test.after(() => z.close());

test("a failed fill inside a Stripe frame does not hand the card number to the model", async () => {
    // Stripe frame whose card field is a checkbox: Playwright's fill error quotes fill("<number>").
    const token = seedToken(z.api, { amount: 19, merchant: "meanblvd.com" });
    const r = await z.call("execute_payment", {
        token, actual_amount: 19,
        checkout_url: "https://meanblvd.com/frame-host?name=__privateStripeFrame1&src=" + encodeURIComponent("https://js.stripe.com/subframe?type=checkbox&tag=stripe_checkbox"),
        recheck: { page_shows: "Checkout $19", decision: "go" },
    });
    assert.equal(hasPan(r.text), false, `card number in tool result: ${r.text.slice(0, 400)}`);
    assert.ok(!r.text.includes(FAKE_CVV), "CVV in tool result");
});

test("a page that echoes the card as its 'order number' gets no card into receipt_id or the receipt", async () => {
    const token = seedToken(z.api, { amount: 14, merchant: "meanblvd.com" });
    const r = await z.call("execute_payment", {
        token, actual_amount: 14, checkout_url: "https://meanblvd.com/receipt-echo",
        recheck: { page_shows: "Digital item $14", decision: "go" },
    });
    assert.equal(hasPan(r.text), false, `card number in tool result: ${r.text.slice(0, 400)}`);
    for (const c of z.api.callsTo("/api/receipts")) {
        assert.equal(hasPan(JSON.stringify(c.body)), false, "card number sent to /api/receipts");
        assert.ok(!String(c.body.merchant_order_id ?? "").includes(FAKE_CVV), "CVV sent to /api/receipts");
    }
    for (const c of z.api.callsTo("/api/tokens/burn")) {
        assert.equal(hasPan(JSON.stringify(c.body)), false, "card number sent with burn");
    }
});

// The 6 spellings T19 found, plus the ones the dashboard filter covers (same function).
const PAN = "4242424242424242";
const VARIANTS = {
    "plain": `card ${PAN} declined`,
    "single spaces": "card 4242 4242 4242 4242",
    "hyphens": "4242-4242-4242-4242",
    "underscore prefix": `id_${PAN}`,
    "dots": "4242.4242.4242.4242",
    "double spaces": "4242  4242  4242  4242",
    "%20": "4242%204242%204242%204242",
    "en dash": "4242–4242–4242–4242",
    "letters around": `pan${PAN}x`,
    "full-width": "４２４２４２４２４２４２４２４２",
    "inside a URL": `https://x.test/pay?card=${PAN}&x=1`,
};
for (const [name, input] of Object.entries(VARIANTS)) {
    test(`redactCardData masks: ${name}`, () => {
        const out = z.taxonomy().redactCardData(input);
        assert.equal(hasPan(out), false, `still readable: ${out}`);
    });
}
test("redactCardData masks cvv=NNN / security_code: NNN", () => {
    const { redactCardData } = z.taxonomy();
    for (const s of ["cvv=888", "security_code: 888", '{"cvc":"888"}', "dom_cvv_888"]) {
        assert.ok(!redactCardData(s).includes("888"), s);
    }
});
test("redactCardData leaves tx hashes, UUIDs and short numbers alone", () => {
    const { redactCardData } = z.taxonomy();
    for (const s of ["0xab1234567890123456cdef1234567890123456ab1234567890123456cdef1234", "550e8400-e29b-41d4-a716-446655440000", "ORDER-12345678901", "Total $49.99"]) {
        assert.equal(redactCardData(s), s);
    }
});
