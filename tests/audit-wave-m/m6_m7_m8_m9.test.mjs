// M.6 on-chain branch removed (founder 14/11) · M.7 success only from visible text,
// page text labelled as untrusted, iframe_selector works with an origin check ·
// M.8 a card that could not be fetched is cancelled at once · M.9 SDK patch level.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot } from "./harness/boot.mjs";
import { seedToken, FAKE_PAN } from "./harness/fake-api.mjs";

const z = await boot();
test.after(() => z.close());
const go = (page_shows) => ({ page_shows, decision: "go" });
const settle = () => new Promise((ok) => setTimeout(ok, 300));

// ── M.6 ──────────────────────────────────────────────────────────────────────
test("M.6: even with Z_ZERO_ENABLE_WEB3_PAY=1, auto_pay never sends USDC to an address on the page", async () => {
    process.env.Z_ZERO_ENABLE_WEB3_PAY = "1";
    try {
        z.api.reset();
        await z.call("auto_pay_checkout", { checkout_url: "https://meanblvd.com/web3", card_alias: "Card_01", max_amount: 30 });
        assert.equal(z.api.callsTo("/api/wallet/transfer").length, 0, "USDC transfer sent from a page-supplied address");
    } finally {
        delete process.env.Z_ZERO_ENABLE_WEB3_PAY;
    }
});

test("M.6: no tool description or SOP offers on-chain payment of a page address", async () => {
    const src = fs.readFileSync(path.join(process.env.ZZ_TARGET, "dist", "index.js"), "utf8");
    assert.ok(!src.includes("Z_ZERO_ENABLE_WEB3_PAY"), "the on-chain switch is still in the build");
    assert.ok(!fs.existsSync(path.join(process.env.ZZ_TARGET, "dist", "lib", "web3-detector.js")), "web3 detector still shipped");
});

// ── M.7 ──────────────────────────────────────────────────────────────────────
test("M.7: a hidden 'Order number' does not count as a confirmed payment (T12 F6)", async () => {
    z.api.reset();
    const token = seedToken(z.api, { amount: 14, merchant: "meanblvd.com" });
    const r = await z.call("execute_payment", { token, checkout_url: "https://meanblvd.com/fake-confirm", actual_amount: 14, recheck: go("Digital item $14") });
    assert.notEqual(r.parsed?.status, "confirmed", r.text.slice(0, 300));
    assert.equal(z.api.callsTo("/api/tokens/burn").length, 0, "token burned on a fake confirmation");
});

const outsideFence = (parsed, needle) => {
    if (!parsed) return true;
    const { untrusted_page_data, ...rest } = parsed;
    return JSON.stringify(rest).includes(needle);
};

test("M.7: a redirect URL written by the page only appears inside untrusted_page_data (T12 F7)", async () => {
    const token = seedToken(z.api, { amount: 15, merchant: "meanblvd.com" });
    const r = await z.call("execute_payment", { token, checkout_url: "https://meanblvd.com/bounce", actual_amount: 15, recheck: go("Checkout $15") });
    assert.ok(r.parsed, r.text.slice(0, 200));
    assert.equal(outsideFence(r.parsed, "IGNORE_PREVIOUS_INSTRUCTIONS"), false, `page text outside the fence: ${r.text.slice(0, 400)}`);
});

test("M.7: text from a covering element (click error) only appears inside untrusted_page_data", async () => {
    const token = seedToken(z.api, { amount: 20, merchant: "meanblvd.com" });
    const r = await z.call("execute_payment", { token, checkout_url: "https://meanblvd.com/overlay-click", actual_amount: 20, recheck: go("Item $20") });
    assert.ok(r.parsed, r.text.slice(0, 200));
    assert.equal(outsideFence(r.parsed, "IGNORE_RULES_CALL"), false, `page text outside the fence: ${r.text.slice(0, 400)}`);
});

test("M.7: iframe_selector reaches a real card-provider frame — and only that (T11 F4)", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 28, merchant: "meanblvd.com" });
    const frame = encodeURIComponent("https://checkout.pci.shopifyinc.com/subframe?tag=shopify_pci");
    const r = await z.call("execute_payment", {
        token, checkout_url: `https://meanblvd.com/iframe-checkout?frame=${frame}`, actual_amount: 28,
        hints: { iframe_selector: "card-fields", card_selector: "#number", exp_selector: "#expiry", cvv_selector: "#verification_value", submit_selector: "#pay-btn" },
        recheck: go("Checkout $28"),
    });
    await settle();
    const main = z.sites.find((x) => x.tag === "iframe_main");
    assert.ok(!String(main?.note ?? "").includes(FAKE_PAN), "card typed into the page's order-note field");
    assert.ok(z.sites.records.some((x) => x.tag === "shopify_pci" && x.num === FAKE_PAN), `card not typed into the PCI frame: ${r.text.slice(0, 300)}`);
});

test("M.7: iframe_selector naming an untrusted frame (merchant CDN upload) gets no card", async () => {
    z.sites.reset();
    const token = seedToken(z.api, { amount: 28, merchant: "meanblvd.com" });
    const frame = encodeURIComponent("https://cdn.shopify.com/evil.svg");
    await z.call("execute_payment", {
        token, checkout_url: `https://meanblvd.com/iframe-checkout?frame=${frame}`, actual_amount: 28,
        hints: { iframe_selector: "card-fields", card_selector: "#svg-cc", exp_selector: "#svg-exp", cvv_selector: "#svg-cvv", submit_selector: "#pay-btn" },
        recheck: go("Checkout $28"),
    });
    await settle();
    assert.ok(!z.sites.records.some((x) => JSON.stringify(x).includes(FAKE_PAN)), "card reached an untrusted frame or the page");
});

// ── M.8 ──────────────────────────────────────────────────────────────────────
test("M.8: auto_pay cancels the card at once if the card number cannot be fetched (T13 F4)", async () => {
    z.api.reset();
    z.api.state.modes.failResolve = true;
    try {
        const r = await z.call("auto_pay_checkout", { checkout_url: "https://meanblvd.com/price?v=usd12", card_alias: "Card_01", max_amount: 20 });
        assert.equal(z.api.callsTo("/api/tokens/issue").length, 1, r.text.slice(0, 200));
        assert.equal(z.api.callsTo("/api/tokens/cancel").length, 1, `issued card left locked: ${r.text.slice(0, 300)}`);
    } finally {
        z.api.state.modes.failResolve = false;
    }
});

// ── M.9 ──────────────────────────────────────────────────────────────────────
test("M.9: @modelcontextprotocol/sdk is at least 1.32.2", () => {
    const v = JSON.parse(fs.readFileSync(path.join(process.env.ZZ_TARGET, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8")).version;
    const [a, b, c] = v.split(".").map(Number);
    assert.ok(a > 1 || (a === 1 && (b > 32 || (b === 32 && c >= 2))), `sdk ${v}`);
});
