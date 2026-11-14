// Stands in for `playwright` inside the MCP under test. Real Chromium, but every
// request goes through the local proxy (harness/sites.mjs), so a page at
// https://meanblvd.com/ is served from this machine on what Chromium sees as the
// default port, and nothing reaches the internet.
const path = require("node:path");
const target = process.env.ZZ_TARGET;
const pw = require(path.join(target, "node_modules", "playwright"));

const chromium = new Proxy(pw.chromium, {
    get(t, prop) {
        if (prop === "launch") {
            return async (opts = {}) => {
                const proxyPort = globalThis.__zzProxyPort;
                if (!proxyPort) throw new Error("test proxy not started");
                const browser = await t.launch({
                    ...opts,
                    proxy: { server: `http://127.0.0.1:${proxyPort}` },
                    args: [
                        ...(opts.args || []),
                        "--disable-background-networking", "--disable-component-update",
                        "--disable-default-apps", "--disable-sync", "--no-first-run",
                        "--disable-domain-reliability", "--disable-client-side-phishing-detection",
                        "--ignore-certificate-errors",
                    ],
                });
                return new Proxy(browser, {
                    get(b, p) {
                        if (p === "newContext") {
                            return async (c = {}) => {
                                const ctx = await b.newContext({ ignoreHTTPSErrors: true, ...c });
                                ctx.setDefaultTimeout(Number(process.env.ZZ_ACTION_TIMEOUT_MS || 4000));
                                return ctx;
                            };
                        }
                        const v = Reflect.get(b, p);
                        return typeof v === "function" ? v.bind(b) : v;
                    },
                });
            };
        }
        const v = Reflect.get(t, prop);
        return typeof v === "function" ? v.bind(t) : v;
    },
});
module.exports = { ...pw, chromium };
