// Harness sanity: a plain store checkout still pays (both before and after the fix).
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness/boot.mjs";
import { seedToken, FAKE_PAN } from "./harness/fake-api.mjs";

const z = await boot();
test.after(() => z.close());

test("happy path: card typed on the locked store, order confirmed, token burned", async () => {
    const token = seedToken(z.api, { amount: 20, merchant: "meanblvd.com" });
    const r = await z.call("execute_payment", {
        token, checkout_url: "https://meanblvd.com/form?tag=happy", actual_amount: 20,
        recheck: { page_shows: "Mug $20", decision: "go" },
    });
    assert.equal(r.parsed?.status, "confirmed", r.text);
    const rec = z.sites.find((x) => x.tag === "happy");
    assert.equal(rec?.cardnumber, FAKE_PAN);
    assert.equal(rec?.host, "meanblvd.com");
    assert.equal(z.api.callsTo("/api/tokens/burn").length, 1);
});
