// M.5 (audit T14 F2): a project folder's MCP config that points Z_ZERO_API_BASE_URL
// somewhere else must not receive the key stored on this machine.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot } from "./harness/boot.mjs";

// The fake API plays the stranger's server here.
const z = await boot({ envKey: () => undefined, allowCustomApi: false });
test.after(() => z.close());

const storedKey = "zk_test_" + "5".repeat(24);
function storeCanonicalKey() {
    const dir = path.join(z.home, ".z-zero");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "credentials"), JSON.stringify({ passport_key: storedKey }) + "\n", { mode: 0o600 });
}
const keySentToStranger = () => z.api.state.calls.some((c) => c.bearer === storedKey);

test("without Z_ZERO_ALLOW_CUSTOM_API=1 the custom address is ignored", async () => {
    storeCanonicalKey();
    z.api.reset();
    await z.restart({ Z_ZERO_API_KEY: undefined, Z_ZERO_ALLOW_CUSTOM_API: undefined });
    await z.call("list_cards", {});
    assert.equal(keySentToStranger(), false, "stored key sent to the custom address");
    assert.equal(z.api.state.calls.length, 0, "custom address was called at all");
});

test("with the flag, the custom address works but never gets the z-zero.xyz key", async () => {
    storeCanonicalKey();
    z.api.reset();
    await z.restart({ Z_ZERO_API_KEY: undefined, Z_ZERO_ALLOW_CUSTOM_API: "1" });
    await z.call("list_cards", {});
    assert.equal(keySentToStranger(), false, "stored z-zero.xyz key sent to the custom address");
});

test("api base resolution (unit)", async () => {
    const save = { base: process.env.Z_ZERO_API_BASE_URL, allow: process.env.Z_ZERO_ALLOW_CUSTOM_API };
    try {
        const { resolveApiBaseUrl } = z.lib("api-base");
        process.env.Z_ZERO_API_BASE_URL = "https://evil.example/v1///";
        delete process.env.Z_ZERO_ALLOW_CUSTOM_API;
        assert.equal(resolveApiBaseUrl(), "https://z-zero.xyz");
        process.env.Z_ZERO_ALLOW_CUSTOM_API = "1";
        assert.equal(resolveApiBaseUrl(), "https://evil.example");
        process.env.Z_ZERO_API_BASE_URL = "http://evil.example";
        assert.equal(resolveApiBaseUrl(), "https://z-zero.xyz");
    } finally {
        process.env.Z_ZERO_API_BASE_URL = save.base;
        if (save.allow === undefined) delete process.env.Z_ZERO_ALLOW_CUSTOM_API;
        else process.env.Z_ZERO_ALLOW_CUSTOM_API = save.allow;
    }
});
