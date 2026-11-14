// M.3 (audit T12 F4, T13 F3; founder 14/11: max_amount required, the agent converts
// currency): the card in auto_pay_checkout is never bigger than the owner's ceiling,
// and only VISIBLE text is read as the price.
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness/boot.mjs";

const z = await boot();
test.after(() => z.close());
const autopay = (v, max_amount) => {
    z.api.reset();
    return z.call("auto_pay_checkout", { checkout_url: `https://meanblvd.com/price?v=${v}`, card_alias: "Card_01", ...(max_amount !== undefined ? { max_amount } : {}) });
};
const issued = () => z.api.callsTo("/api/tokens/issue").map((c) => c.body.amount);

test("max_amount is required", async () => {
    const r = await autopay("usd12");
    assert.equal(r.isError, true, r.text.slice(0, 200));
    assert.deepEqual(issued(), [], "a card was issued without a ceiling");
});

test("plain USD page under the ceiling: card ≈ visible total, payment goes through", async () => {
    const r = await autopay("usd12", 20);
    assert.equal(r.parsed?.status, "SUCCESS", r.text);
    assert.equal(issued().length, 1);
    assert.ok(issued()[0] >= 12 && issued()[0] <= 12.5, `issued ${issued()[0]}`);
});

test("visible total above the ceiling: no card at all", async () => {
    const r = await autopay("usd30", 20);
    assert.equal(r.parsed?.status, "PRICE_ABOVE_MAX", r.text);
    assert.deepEqual(issued(), []);
});

for (const [v, label] of [["hidden49", "display:none $49"], ["opacity49", "transparent off-screen $49s"]]) {
    test(`hidden price (${label}) does not size the card`, async () => {
        const r = await autopay(v, 10);
        assert.ok(issued().every((a) => a <= 5.2), `card sized from hidden text: issued ${issued()} — ${r.text.slice(0, 200)}`);
    });
}

test("'48 items' is not a $48 price", async () => {
    const r = await autopay("counter48", 10);
    assert.ok(issued().every((a) => a <= 5.2), `issued ${issued()}: ${r.text.slice(0, 200)}`);
});

test("'0,49 $' is 49 cents, not $49", async () => {
    const r = await autopay("comma", 10);
    assert.ok(issued().every((a) => a <= 1.01), `issued ${issued()}: ${r.text.slice(0, 200)}`);
});

test("a yen price is not read as dollars: the card is the agent's USD ceiling", async () => {
    const r = await autopay("jpy", 32);
    assert.deepEqual(issued(), [32], r.text.slice(0, 300));
    assert.equal(r.parsed?.detected_currency, "NON_USD");
});

test("price parsing (unit)", () => {
    const { parsePriceText, parseAmount } = z.lib("extract-total-price");
    assert.equal(typeof parsePriceText, "function", "no visible-text price parser");
    assert.equal(parseAmount("1,234.56"), 1234.56);
    assert.equal(parseAmount("1.234,56"), 1234.56);
    assert.equal(parseAmount("0,49"), 0.49);
    assert.equal(parseAmount("1,234"), 1234);
    assert.equal(parsePriceText("48 items"), null);
    assert.equal(parsePriceText("Total: $12.00")?.amount, 12);
    assert.equal(parsePriceText("¥4,500")?.currency, "NON_USD");
    assert.equal(parsePriceText("CA$20.00")?.currency, "NON_USD");
    assert.equal(parsePriceText("USD 9.99")?.currency, "USD");
});
