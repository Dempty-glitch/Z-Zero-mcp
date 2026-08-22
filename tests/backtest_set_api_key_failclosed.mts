// W2a backtest — set_api_key phải FAIL-CLOSED.
//
// Lỗi (review 22/08): key vừa dán được activate trong RAM TRƯỚC khi gọi
// /api/keys/rotate; rotate lỗi/timeout thì catch{} nuốt và vẫn trả SUCCESS.
// Hậu quả: chạy bằng key đã đi qua chat mà tưởng đã rotate.
//
// Kỳ vọng sau fix:
//   S1 rotate 5xx      → isError, key CŨ vẫn active (Bearer của call sau = OLD)
//   S2 rotate mất kết nối → isError, key CŨ vẫn active, message nói rõ đường lui
//   S3 rotate OK       → SUCCESS rotated_on_connect=true, Bearer sau = NEW (server cấp),
//                        credentials file chứa NEW và KHÔNG BAO GIỜ chứa key đã dán
//
// Chạy MCP THẬT qua stdio; HOME trỏ vào thư mục tạm để persist không chạm ~/.z-zero thật.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const OLD = "zk_test_" + "o".repeat(64);
const PASTED = "zk_test_" + "p".repeat(64);
const NEW = "zk_test_" + "n".repeat(64);

type Mode = "rotate_ok" | "rotate_500" | "rotate_drop" | "rotate_commit_then_drop";
let pastedDeadOnServer = false;   // S4: server đã rotate (PASTED chết) nhưng reply không tới client
let mode: Mode = "rotate_ok";
const seen: { path: string; bearer: string | undefined }[] = [];

const server = createServer((req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    seen.push({ path: req.url || "", bearer });
    if (pastedDeadOnServer && bearer === PASTED) {        // key dán đã bị rotate → server từ chối ở MỌI route
        res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "AUTH_REQUIRED" })); return;
    }
    if (req.url?.startsWith("/api/keys/rotate")) {
        if (mode === "rotate_commit_then_drop") { pastedDeadOnServer = true; req.socket.destroy(); return; }
        if (mode === "rotate_drop") { req.socket.destroy(); return; }
        if (mode === "rotate_500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "ROTATE_FAILED" })); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ new_key: NEW })); return;
    }
    // mọi route khác (balance, cards…) → 200 rỗng, chỉ cần Bearer được ghi lại
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ address: "0xabc", balance_usdt: 0 }));
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as AddressInfo).port;

async function runScenario(m: Mode, calls = 1) {
    mode = m; seen.length = 0; pastedDeadOnServer = false;
    const home = mkdtempSync(join(tmpdir(), "zz-w2a-"));
    const child = spawn("node", ["dist/index.js"], {
        env: { ...process.env, HOME: home, Z_ZERO_API_BASE_URL: `http://127.0.0.1:${port}`, Z_ZERO_API_KEY: OLD },
        stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => {});
    const pending = new Map<number, (v: any) => void>();
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } } catch {}
        }
    });
    let nextId = 1;
    const rpc = (method: string, params: any) => new Promise<any>((ok, bad) => {
        const id = nextId++; pending.set(id, ok);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); bad(new Error(`timeout ${method}`)); } }, 20000);
    });
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "w2a", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    let setRes: any, firstText = "";
    for (let i = 0; i < calls; i++) {                      // calls=2 → agent retry cùng key dán
        setRes = await rpc("tools/call", { name: "set_api_key", arguments: { api_key: PASTED } });
        if (i === 0) firstText = setRes.result?.content?.[0]?.text ?? "";
    }
    const setText: string = setRes.result?.content?.[0]?.text ?? "";
    const isError = !!setRes.result?.isError;
    await rpc("tools/call", { name: "check_balance", arguments: { card_alias: "x" } });   // call sau → Bearer nào?
    const after = [...seen].reverse().find((s) => s.path.startsWith("/api/wallet/balance") && s.bearer !== PASTED) ?? seen[seen.length - 1];
    const bearerAfter = seen[seen.length - 1]?.bearer;
    const credFile = join(home, ".z-zero", "credentials");
    const cred = existsSync(credFile) ? readFileSync(credFile, "utf8") : "";
    child.kill();
    return { isError, setText, firstText, bearerAfter, cred, seen: [...seen] };
}

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d: string) => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} — ${d}`); } };
const short = (k?: string) => k ? k.slice(0, 10) + "…" + k.slice(-4) : String(k);

// ── S1: rotate 500 ──
const s1 = await runScenario("rotate_500");
check("S1.rotate 5xx → tool returns isError", s1.isError, `isError=${s1.isError} text=${s1.setText.slice(0, 90)}`);
check("S1.previous key still active after failure", s1.bearerAfter === OLD, `Bearer sau = ${short(s1.bearerAfter)} (OLD=${short(OLD)} PASTED=${short(PASTED)})`);
check("S1.remote_status = ERROR", /"remote_status":\s*"ERROR"/.test(s1.setText), s1.setText.slice(0, 120));
check("S1.pasted key never persisted", !s1.cred.includes(PASTED), `cred=${short(s1.cred.trim())}`);

// ── S2: rotate mất kết nối ──
const s2 = await runScenario("rotate_drop");
check("S2.lost rotate → isError", s2.isError, `isError=${s2.isError} text=${s2.setText.slice(0, 90)}`);
check("S2.previous key still active", s2.bearerAfter === OLD, `Bearer sau = ${short(s2.bearerAfter)}`);
check("S2.remote_status = UNKNOWN (rotation may have happened)", /"remote_status":\s*"UNKNOWN"/.test(s2.setText), s2.setText.slice(0, 120));
check("S2.message tells the agent the way back (retry / fresh key)", /retry|fresh key|previous key/i.test(s2.setText), `text=${s2.setText.slice(0, 120)}`);

// ── S3: rotate OK ──
const s3 = await runScenario("rotate_ok");
check("S3.rotate ok → SUCCESS rotated_on_connect=true", !s3.isError && /"rotated_on_connect":\s*true/.test(s3.setText), `isError=${s3.isError} text=${s3.setText.slice(0, 90)}`);
check("S3.server-minted key is the active one", s3.bearerAfter === NEW, `Bearer sau = ${short(s3.bearerAfter)}`);
check("S3.NEW persisted, PASTED never persisted", s3.cred.includes(NEW) && !s3.cred.includes(PASTED), `cred=${short(s3.cred.trim())}`);
check("S3.rotate was called with the PASTED key as bearer", s3.seen.some((x) => x.path.startsWith("/api/keys/rotate") && x.bearer === PASTED), JSON.stringify(s3.seen.map((x) => [x.path, short(x.bearer)])));

// ── S4: rotate ĐÃ xảy ra ở server, reply mất → agent retry cùng key dán ──
const s4 = await runScenario("rotate_commit_then_drop", 2);
check("S4.first attempt → isError with remote_status UNKNOWN", /"remote_status":\s*"UNKNOWN"/.test(s4.firstText), s4.firstText.slice(0, 120));
check("S4.retry with the now-dead pasted key → isError", s4.isError, `isError=${s4.isError} text=${s4.setText.slice(0, 100)}`);
check("S4.retry points the agent to a fresh key from the dashboard", /dashboard\/agents/i.test(s4.setText), s4.setText.slice(0, 140));
check("S4.OLD key still active through the whole sequence", s4.bearerAfter === OLD, `Bearer sau = ${short(s4.bearerAfter)}`);
check("S4.nothing persisted", !s4.cred.includes(PASTED) && !s4.cred.includes(NEW), `cred=${short(s4.cred.trim())}`);

server.close();
console.log(`\nSUMMARY ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ""}`);
process.exit(fail ? 1 : 0);
