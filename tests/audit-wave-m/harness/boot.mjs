// Start the MCP server under test (ZZ_TARGET/dist) inside this process, wired to
// the fake API and the local sites, and give the test an MCP client.
//
// Run every test file with:
//   node --import ./tests/audit-wave-m/harness/net-guard.mjs \
//        --import ./tests/audit-wave-m/harness/hooks.mjs <file>
// (run.sh does this, inside sandbox-exec with outbound network denied).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startFakeApi } from "./fake-api.mjs";
import { startSites } from "./sites.mjs";

const TARGET = process.env.ZZ_TARGET;
if (!TARGET) throw new Error("ZZ_TARGET (path of the z-zero-mcp tree to test) is not set");
if (!globalThis.__zzBlockedFetches) throw new Error("load harness/net-guard.mjs first (--import)");
const require = createRequire(path.join(TARGET, "package.json"));

/** A fresh, empty fake HOME for this process (never the real ~/.z-zero). */
export function fakeHome() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-wave-m-home-"));
    process.env.HOME = dir;
    return dir;
}

/**
 * @param {object} o
 * @param {(api) => string|undefined} [o.envKey]  key to put in Z_ZERO_API_KEY (from the fake API)
 * @param {boolean} [o.allowCustomApi=true]       set Z_ZERO_ALLOW_CUSTOM_API=1
 * @param {(home, api) => void} [o.beforeImport]  last chance to write files / env before the MCP loads
 */
export async function boot(o = {}) {
    const home = process.env.HOME?.includes("zz-wave-m-home-") ? process.env.HOME : fakeHome();
    // Real browser binaries live in the real user cache; HOME is fake.
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(os.userInfo().homedir, "Library", "Caches", "ms-playwright");
    for (const k of ["Z_ZERO_API_KEY", "Z_ZERO_API_BASE", "Z_ZERO_ENABLE_WEB3_PAY", "Z_ZERO_ALLOW_LOCAL_CHECKOUT", "Z_ZERO_INTERNAL_SECRET", "Z_ZERO_UCP_PAY_ENABLED"]) delete process.env[k];

    const api = await startFakeApi();
    const sites = await startSites();
    api.addAccount("acct_main", "0x1111111111111111111111111111111111111111");
    const key = o.envKey === undefined ? api.addKey("acct_main") : o.envKey(api);
    if (key) process.env.Z_ZERO_API_KEY = key;
    process.env.Z_ZERO_API_BASE_URL = api.baseUrl;
    if (o.allowCustomApi !== false) process.env.Z_ZERO_ALLOW_CUSTOM_API = "1";
    else delete process.env.Z_ZERO_ALLOW_CUSTOM_API;
    o.beforeImport?.(home, api);

    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    let client;
    async function start() {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        globalThis.__zzServerTransport = serverT;
        require(path.join(TARGET, "dist", "index.js"));
        client = new Client({ name: "wave-m-tests", version: "1.0.0" });
        await client.connect(clientT);
    }
    await start();

    /** Stop the MCP server and load it again from scratch, like a client restart. */
    async function restart(env = {}) {
        await client.close().catch(() => {});
        const dist = path.join(TARGET, "dist") + path.sep;
        for (const k of Object.keys(require.cache)) if (k.startsWith(dist)) delete require.cache[k];
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined || v === null) delete process.env[k];
            else process.env[k] = v;
        }
        await start();
    }

    async function call(name, args) {
        try {
            const r = await client.callTool({ name, arguments: args });
            const text = r?.content?.map((c) => c.text ?? "").join("\n") ?? "";
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* plain text */ }
            return { isError: !!r?.isError, text, parsed };
        } catch (err) {
            return { isError: true, threw: true, text: String(err?.message || err), parsed: null };
        }
    }

    return {
        api, sites, home, call, key, restart,
        bridge: () => require(path.join(TARGET, "dist", "playwright_bridge.js")),
        lib: (name) => require(path.join(TARGET, "dist", "lib", `${name}.js`)),
        taxonomy: () => require(path.join(TARGET, "dist", "failure_taxonomy.js")),
        async close() {
            await client.close().catch(() => {});
            await sites.close();
            await api.close();
        },
    };
}

/** True if this text contains the test card number, however it is spelled. */
export function hasPan(text) {
    return String(text ?? "").normalize("NFKC").replace(/%20/g, "").replace(/[^0-9]/g, "").includes("4242424242424242");
}
