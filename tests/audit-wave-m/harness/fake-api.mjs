// A stand-in Z-ZERO API on 127.0.0.1. Hands out the public test card number
// 4242 4242 4242 4242 — never a real card, never a real key.
import http from "node:http";
import crypto from "node:crypto";

export const FAKE_PAN = "4242424242424242";
export const FAKE_CVV = "987";
export const FAKE_EXP = "12/30";

const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
});

function domainOf(merchant) {
    const s = String(merchant || "").trim().toLowerCase();
    try { return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, ""); } catch { return null; }
}

export async function startFakeApi() {
    const state = {
        // key → account. Accounts: { id, address|null }
        keys: new Map(),
        accounts: new Map(),
        tokens: new Map(),
        calls: [],               // every request: { method, path, bearer, body }
        modes: { failResolve: false },
    };
    const api = {
        state,
        addAccount(id, address) {
            state.accounts.set(id, { id, address });
            return id;
        },
        addKey(accountId, key = `zk_test_${crypto.randomBytes(12).toString("hex")}`) {
            state.keys.set(key, accountId);
            return key;
        },
        isLive(key) { return state.keys.has(key); },
        callsTo(path) { return state.calls.filter((c) => c.path === path); },
        reset() { state.calls.length = 0; state.modes.failResolve = false; },
    };

    const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        const raw = await readBody(req);
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
        const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || null;
        state.calls.push({ method: req.method, path: u.pathname, bearer, body });
        const account = bearer ? state.accounts.get(state.keys.get(bearer)) : null;

        if (u.pathname === "/api/receipts" && req.method === "POST") {
            const id = crypto.randomUUID();
            return json(res, 200, { receipt: { receipt_id: id, merchant_order_id: body.merchant_order_id ?? null, match: { total: "ok" }, diff: [] }, receipt_hash: "0x" + "cd".repeat(32), verify_url: `http://127.0.0.1/receipt/${id}` });
        }
        if (!account) return json(res, 401, { error: "AUTH_REQUIRED", message: "Unknown or revoked key." });

        switch (`${req.method} ${u.pathname}`) {
            case "POST /api/keys/rotate": {
                const fresh = `zk_test_${crypto.randomBytes(12).toString("hex")}`;
                state.keys.delete(bearer);
                state.keys.set(fresh, account.id);
                return json(res, 200, { rotated: true, new_key: fresh });
            }
            case "GET /api/wallet/balance":
                if (!account.address) return json(res, 404, { error: "NO_WALLET", message: "No connected Base wallet found." });
                return json(res, 200, { address: account.address, chain: "base", base_usdc_balance: 100, balance_usdt: 100 });
            case "GET /api/tokens/cards":
                return json(res, 200, { cards: [{ alias: "Card_01", balance: 100, currency: "USDC", mode: "base" }], active_tokens: [] });
            case "POST /api/tokens/issue": {
                const token = `tok_${crypto.randomBytes(8).toString("hex")}`;
                state.tokens.set(token, { amount: body.amount, merchant_domain: domainOf(body.merchant), status: "ACTIVE" });
                return json(res, 200, { token, tx_hash: "0xfeed" });
            }
            case "POST /api/tokens/purpose": {
                const t = state.tokens.get(body.token);
                if (!t) return json(res, 404, { error: "INVALID_TOKEN", message: "Token not found." });
                return json(res, 200, { criteria: null, authorized_amount: t.amount });
            }
            case "POST /api/tokens/resolve": {
                if (state.modes.failResolve) return json(res, 503, { error: "TEMPORARILY_UNAVAILABLE", message: "Card provider busy." });
                const t = state.tokens.get(body.token);
                if (!t || t.status !== "ACTIVE") return json(res, 404, { error: "INVALID_TOKEN", message: "Token not active." });
                return json(res, 200, { number: FAKE_PAN, exp: FAKE_EXP, cvv: FAKE_CVV, name: "TEST HOLDER", authorized_amount: t.amount, merchant_domain: t.merchant_domain });
            }
            case "POST /api/tokens/burn": {
                const t = state.tokens.get(body.token);
                if (t) t.status = "USED";
                return json(res, 200, { success: true });
            }
            case "POST /api/tokens/cancel": {
                const t = state.tokens.get(body.token);
                if (!t || t.status !== "ACTIVE") return json(res, 400, { error: "Token not active" });
                t.status = "CANCELLED";
                return json(res, 200, { success: true, refunded_amount: t.amount, tx_hash: "0xrefund" });
            }
            case "GET /api/checkout-hints":
                return json(res, 200, { found: false, hints: null });
            case "POST /api/checkout-hints":
                return json(res, 200, { ok: true });
            case "POST /api/wallet/transfer":
                return json(res, 200, { success: true, txHash: "0xfaketransfer" });
            default:
                return json(res, 404, { error: "Not found", path: u.pathname });
        }
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    api.baseUrl = `http://127.0.0.1:${server.address().port}`;
    api.close = () => new Promise((ok) => server.close(() => ok()));
    return api;
}

/** Seed a token directly (as if request_payment_token had run). */
export function seedToken(api, { amount, merchant }) {
    const token = `tok_${crypto.randomBytes(8).toString("hex")}`;
    api.state.tokens.set(token, { amount, merchant_domain: domainOf(merchant), status: "ACTIVE" });
    return token;
}
