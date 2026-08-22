// W3a backtest — idempotency thật, không phải idempotency giả.
//
// Bẫy cần chặn (review 22/08): sinh randomUUID() BÊN TRONG mỗi lần gọi tool
// không giải quyết retry — lần retry là một tool call MỚI, sinh key MỚI,
// backend lại phát thẻ nữa. Key phải sống QUA các lần gọi, nhưng chỉ được
// tái dùng khi lần trước CHƯA RÕ kết quả.
//
// T1: backend đã phát thẻ nhưng response bị mất (socket chết) → retry cùng
//     yêu cầu PHẢI gửi lại CÙNG key → backend replay thẻ cũ → tổng 1 thẻ.
// T2: hai lần mua thành công cùng một món → PHẢI là hai key khác nhau → 2 thẻ.
// T3: backend từ chối dứt khoát (402) → lần gọi sau là ý định MỚI → key mới.
//
// Mock server mô phỏng đúng ngữ nghĩa idempotency_reservations của
// /api/tokens/issue thật: key trùng + đã COMPLETED → replay token cũ.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Issued = { token: string; key: string | undefined };

const cards: Issued[] = [];                       // mỗi phần tử = một thẻ THẬT đã phát (tiền đã đi)
const seenKeys: (string | undefined)[] = [];      // idempotency_key của TỪNG request đến
const replays: string[] = [];                     // các lần backend replay thay vì phát mới
const completed = new Map<string, string>();      // reservation: key -> token (COMPLETED)
let mode: "drop_after_issue" | "normal" | "reject_402" = "normal";
let dropped = false;

const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const key: string | undefined = body.idempotency_key;
        seenKeys.push(key);

        // Replay: đúng ngữ nghĩa backend thật (COMPLETED + token còn đó).
        if (key && completed.has(key)) {
            replays.push(key);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ token: completed.get(key), idempotent: true, mode: "cached" }));
            return;
        }

        if (mode === "reject_402") {
            res.writeHead(402, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "INSUFFICIENT_BALANCE", message: "Top up first." }));
            return;
        }

        // Phát thẻ thật — TIỀN ĐÃ ĐI từ thời điểm này.
        const token = `tok_${cards.length + 1}`;
        cards.push({ token, key });
        if (key) completed.set(key, token);

        if (mode === "drop_after_issue" && !dropped) {
            dropped = true;          // thẻ đã phát nhưng client không bao giờ thấy response
            res.socket?.destroy();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    });
});

await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as AddressInfo).port;

process.env.Z_ZERO_API_BASE_URL = `http://127.0.0.1:${port}`;
process.env.Z_ZERO_API_KEY = process.env.Z_ZERO_API_KEY || "zk_test_backtest";
const { issueTokenRemote } = await import("../dist/base_backend.js");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: string) {
    if (cond) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name} — ${detail}`); }
}

// ── T1: response bị mất → retry phải tái dùng key, không phát thẻ thứ hai ──
mode = "drop_after_issue";
const t1a = await issueTokenRemote("alias_t1", 20, "etsy.com");
const t1b = await issueTokenRemote("alias_t1", 20, "etsy.com");   // agent retry cùng yêu cầu
check("T1.lost-response surfaces as error", t1a?.error === "NETWORK_ERROR",
    `expected NETWORK_ERROR, got ${JSON.stringify(t1a)?.slice(0, 120)}`);
check("T1.retry reuses the SAME idempotency key",
    !!seenKeys[0] && seenKeys[0] === seenKeys[1],
    `keys: ${seenKeys[0]} vs ${seenKeys[1]} (undefined = không gửi key — bug hiện tại)`);
check("T1.exactly ONE card issued", cards.length === 1, `cards issued: ${cards.length}`);
check("T1.retry got the ORIGINAL token back", t1b?.token === "tok_1",
    `got ${JSON.stringify(t1b)?.slice(0, 120)}`);

// ── T2: hai lần mua thật cùng món → hai key khác nhau, hai thẻ ──
mode = "normal";
const before = cards.length;
const t2a = await issueTokenRemote("alias_t2", 15, "shop.com");
const t2b = await issueTokenRemote("alias_t2", 15, "shop.com");   // món thứ hai, chủ đích
const k2a = seenKeys[seenKeys.length - 2], k2b = seenKeys[seenKeys.length - 1];
check("T2.both purchases succeeded", !!t2a?.token && !!t2b?.token && t2a.token !== t2b.token,
    `tokens: ${t2a?.token} / ${t2b?.token}`);
check("T2.two DIFFERENT keys", !!k2a && !!k2b && k2a !== k2b, `keys: ${k2a} vs ${k2b}`);
check("T2.two cards issued", cards.length === before + 2, `delta: ${cards.length - before}`);

// ── T3: từ chối dứt khoát → lần sau là ý định mới, key mới ──
mode = "reject_402";
await issueTokenRemote("alias_t3", 99, "big.com");
mode = "normal";
await issueTokenRemote("alias_t3", 99, "big.com");                // user đã nạp tiền, mua lại
const k3a = seenKeys[seenKeys.length - 2], k3b = seenKeys[seenKeys.length - 1];
check("T3.definitive rejection mints a NEW key next time", !!k3a && !!k3b && k3a !== k3b,
    `keys: ${k3a} vs ${k3b}`);

server.close();
console.log(`\nSUMMARY ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ""}`);
process.exit(fail ? 1 : 0);
