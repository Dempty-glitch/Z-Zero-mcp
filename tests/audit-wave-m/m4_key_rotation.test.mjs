// M.4 (audit T14 F1, F3, F4; founder 14/11: make the promise true in code).
// "The key you paste is dead the moment your agent connects" must hold for the key
// written into the MCP config too, and set_api_key must not quietly move this machine
// to somebody else's account.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot } from "./harness/boot.mjs";

const z = await boot({ envKey: () => undefined }); // no key at first; each test sets one
test.after(() => z.close());
const credDir = () => path.join(z.home, ".z-zero");
const credFiles = () => (fs.existsSync(credDir()) ? fs.readdirSync(credDir()).filter((f) => f.startsWith("credentials")) : []);
const wipeCreds = () => { for (const f of credFiles()) fs.unlinkSync(path.join(credDir(), f)); };
const depositAddress = async () => (await z.call("get_deposit_addresses", {})).text.match(/0x[0-9a-fA-F]{40}/)?.[0];

test("a key from the MCP config is swapped for a fresh one on connect (T14 F1)", async () => {
    wipeCreds();
    const configKey = z.api.addKey("acct_main");
    await z.restart({ Z_ZERO_API_KEY: configKey });
    const r = await z.call("list_cards", {});
    assert.equal(r.isError, false, r.text.slice(0, 200));
    assert.equal(z.api.isLive(configKey), false, "the key in the config (and in the chat it came from) still works");
    assert.ok(credFiles().length > 0, "fresh key not stored locally");
    assert.ok(!fs.readFileSync(path.join(credDir(), credFiles()[0]), "utf8").includes(configKey), "config key stored as-is");
});

test("set_api_key rotates even when the account has no wallet yet (T14 F4)", async () => {
    wipeCreds();
    z.api.addAccount("acct_nowallet", null);
    await z.restart({ Z_ZERO_API_KEY: undefined });
    const pasted = z.api.addKey("acct_nowallet");
    const r = await z.call("set_api_key", { api_key: pasted });
    assert.equal(r.parsed?.status, "SUCCESS", r.text.slice(0, 300));
    assert.equal(z.api.isLive(pasted), false, "the pasted key is still alive");
});

test("set_api_key does not move a working install to another account (T14 F3)", async () => {
    wipeCreds();
    z.api.addAccount("acct_other", "0x2222222222222222222222222222222222222222");
    await z.restart({ Z_ZERO_API_KEY: z.api.addKey("acct_main") });
    assert.equal((await depositAddress())?.toLowerCase(), "0x1111111111111111111111111111111111111111");
    const strangerKey = z.api.addKey("acct_other");
    const r = await z.call("set_api_key", { api_key: strangerKey });
    assert.equal(r.parsed?.status, "NOT_SWITCHED", r.text.slice(0, 300));
    assert.equal((await depositAddress())?.toLowerCase(), "0x1111111111111111111111111111111111111111", "deposit address switched to another account");
    // and after a restart too
    await z.restart({});
    assert.equal((await depositAddress())?.toLowerCase(), "0x1111111111111111111111111111111111111111", "switched after restart");
});

test("set_api_key with a fresh key of the SAME account is accepted", async () => {
    const r = await z.call("set_api_key", { api_key: z.api.addKey("acct_main") });
    assert.equal(r.parsed?.status, "SUCCESS", r.text.slice(0, 300));
});

test("a NEW key put in the config later is used, not hidden by the stored one (T14 F3)", async () => {
    wipeCreds();
    await z.restart({ Z_ZERO_API_KEY: z.api.addKey("acct_main") });
    await z.call("list_cards", {});
    const newConfigKey = z.api.addKey("acct_main");
    await z.restart({ Z_ZERO_API_KEY: newConfigKey });
    const r = await z.call("list_cards", {});
    assert.equal(r.isError, false, r.text.slice(0, 200));
    assert.equal(z.api.isLive(newConfigKey), false, "new config key was ignored (still alive, never rotated)");
});

test("a dead stored key falls back to a working config key (old credentials files)", async () => {
    wipeCreds();
    fs.mkdirSync(credDir(), { recursive: true });
    // Written the way 1.5–1.10 wrote it: no record of which config key it replaced.
    const deadKey = "zk_test_" + "d".repeat(24);
    const port = new URL(z.api.baseUrl).port;
    for (const f of ["credentials", `credentials-127.0.0.1_${port}`]) {
        fs.writeFileSync(path.join(credDir(), f), JSON.stringify({ passport_key: deadKey }) + "\n", { mode: 0o600 });
    }
    const configKey = z.api.addKey("acct_main");
    await z.restart({ Z_ZERO_API_KEY: configKey });
    const r = await z.call("list_cards", {});
    assert.equal(r.isError, false, `stuck on the dead stored key: ${r.text.slice(0, 200)}`);
});
