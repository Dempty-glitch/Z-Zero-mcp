// OFFLINE unit tests for the UCP bridge — no network, safe for CI.
// Run: npm run test:ucp-offline
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    __ucpInternals,
    planRedirect,
    makePinnedLookup,
    minorUnitExponent,
    minorToMajor,
    ucpPayCheckout,
    UcpMcpClient,
} from "../dist/ucp_bridge.js";

const { isPrivateIp, assertSafeUcpUrl, summarizeCheckout } = __ucpInternals;

test("isPrivateIp: IPv4 ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
        assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "1.1.1.1", "23.227.38.74"]) {
        assert.equal(isPrivateIp(ip), false, ip);
    }
});

test("isPrivateIp: IPv6 incl. v4-mapped", () => {
    for (const ip of ["::1", "::", "fd00::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3"]) {
        assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8"]) {
        assert.equal(isPrivateIp(ip), false, ip);
    }
});

test("assertSafeUcpUrl: rejects non-https, loopback, private; ignores Playwright local opt-in", () => {
    assert.throws(() => assertSafeUcpUrl("http://example.com", "t"), /HTTPS/);
    assert.throws(() => assertSafeUcpUrl("https://127.0.0.1/x", "t"), /SSRF/);
    assert.throws(() => assertSafeUcpUrl("https://10.0.0.5/x", "t"), /SSRF/);
    assert.throws(() => assertSafeUcpUrl("https://192.168.1.1/mcp", "t"), /SSRF/);
    assert.throws(() => assertSafeUcpUrl("https://[::1]/mcp", "t"), /SSRF/);
    const prev = process.env.Z_ZERO_ALLOW_LOCAL_CHECKOUT;
    process.env.Z_ZERO_ALLOW_LOCAL_CHECKOUT = "1";
    try {
        assert.throws(() => assertSafeUcpUrl("https://localhost/mcp", "t"), /SSRF/);
    } finally {
        if (prev === undefined) delete process.env.Z_ZERO_ALLOW_LOCAL_CHECKOUT; else process.env.Z_ZERO_ALLOW_LOCAL_CHECKOUT = prev;
    }
    assert.doesNotThrow(() => assertSafeUcpUrl("https://meanblvd.com", "t"));
});

test("UcpMcpClient constructor rejects unsafe endpoints (merchant discovery is untrusted)", () => {
    assert.throws(() => new UcpMcpClient("http://example.com/mcp"), /HTTPS/);
    assert.throws(() => new UcpMcpClient("https://127.0.0.1/mcp"), /SSRF/);
    assert.throws(() => new UcpMcpClient("https://169.254.169.254/mcp"), /SSRF/);
    assert.doesNotThrow(() => new UcpMcpClient("https://shop.myshopify.com/api/ucp/mcp"));
});

test("planRedirect: same-origin GET keeps auth; cross-origin GET strips auth; non-GET never follows", () => {
    const headers = { Authorization: "Bearer t", "Mcp-Session-Id": "s", Accept: "application/json" };
    const same = planRedirect("https://a.com/x", "/y", { method: "GET", headers });
    assert.equal(same.next, "https://a.com/y");
    assert.equal(same.headers.Authorization, "Bearer t");
    const cross = planRedirect("https://a.com/x", "https://b.com/y", { method: "GET", headers });
    assert.equal(cross.next, "https://b.com/y");
    assert.equal(cross.headers.Authorization, undefined);
    assert.equal(cross.headers["Mcp-Session-Id"], undefined);
    assert.equal(cross.headers.Accept, "application/json");
    assert.throws(() => planRedirect("https://a.com/x", "/y", { method: "POST", headers }), /redirect refused for POST/);
    assert.throws(() => planRedirect("https://a.com/x", "https://b.com/y", { method: "POST", headers }), /redirect refused/);
});

test("makePinnedLookup: ignores hostname, returns only vetted addresses (DNS-rebinding pin)", async () => {
    const lookup = makePinnedLookup([{ address: "23.227.38.74", family: 4 }, { address: "2606:4700::1", family: 6 }]);
    const one = await new Promise<any[]>((r) => lookup("attacker-controlled.example", {}, (...a: any[]) => r(a)));
    assert.deepEqual(one, [null, "23.227.38.74", 4]);
    const all = await new Promise<any[]>((r) => lookup("attacker-controlled.example", { all: true }, (...a: any[]) => r(a)));
    assert.equal(all[0], null);
    assert.deepEqual(all[1].map((x: any) => x.address), ["23.227.38.74", "2606:4700::1"]);
    const cbOnly = await new Promise<any[]>((r) => lookup("x", (...a: any[]) => r(a)));
    assert.deepEqual(cbOnly, [null, "23.227.38.74", 4]);
});

test("minor-unit exponent follows ISO 4217 via Intl (incl. CLF/UYW=4, MGA per runtime data)", () => {
    assert.equal(minorUnitExponent("USD"), 2);
    assert.equal(minorUnitExponent("VND"), 0);
    assert.equal(minorUnitExponent("JPY"), 0);
    assert.equal(minorUnitExponent("KWD"), 3);
    assert.equal(minorUnitExponent("CLF"), 4);
    assert.equal(minorUnitExponent("UYW"), 4);
    const mgaRuntime = new Intl.NumberFormat("en", { style: "currency", currency: "MGA" }).resolvedOptions().maximumFractionDigits;
    assert.equal(minorUnitExponent("MGA"), mgaRuntime);
    assert.equal(minorUnitExponent("usd"), 2);
    assert.equal(minorUnitExponent(null), 2);
    assert.equal(minorUnitExponent("not-a-code"), 2);
    assert.equal(minorToMajor(8900, "USD"), 89);
    assert.equal(minorToMajor(12160000, "VND"), 12160000);
    assert.equal(minorToMajor(12345, "KWD"), 12.345);
    assert.equal(minorToMajor(null, "USD"), null);
});

test("summarizeCheckout: Shopify totals[] → minor/major, messages, status, continue_url", () => {
    const q = summarizeCheckout({
        id: "gid://shopify/Checkout/abc?key=k",
        status: "requires_escalation",
        currency: "USD",
        totals: [{ type: "subtotal", amount: 3500 }, { type: "total", amount: 3702 }],
        continue_url: "https://shop/cart/c/abc",
        messages: [{ code: "delivery_address_required", content: "A destination address is required", severity: "recoverable" }],
    });
    assert.equal(q.checkout_id, "gid://shopify/Checkout/abc?key=k");
    assert.equal(q.status, "requires_escalation");
    assert.equal(q.total_minor, 3702);
    assert.equal(q.total_major, 37.02);
    assert.equal(q.currency, "USD");
    assert.equal(q.continue_url, "https://shop/cart/c/abc");
    assert.deepEqual(q.messages, ["[delivery_address_required] A destination address is required"]);
    const vnd = summarizeCheckout({ id: "x", status: "incomplete", currency: "VND", totals: [{ type: "total", amount: 12160000 }] });
    assert.equal(vnd.total_major, 12160000);
});

test("ucpPayCheckout: gated off by default — no network, not_submitted, card wiped", async () => {
    const prev = process.env.Z_ZERO_UCP_PAY_ENABLED;
    delete process.env.Z_ZERO_UCP_PAY_ENABLED;
    try {
        const card = { number: "4111111111111111", exp_month: "12", exp_year: "2030", cvv: "123", name: "Test" };
        const r = await ucpPayCheckout({
            merchantUrl: "https://example.com",
            checkoutId: "gid://shopify/Checkout/x",
            cardData: card,
            buyer: { email: "a@b.c" },
            billingAddress: { street_address: "1", address_locality: "NY", address_country: "US", postal_code: "10001" },
        });
        assert.equal(r.success, false);
        assert.equal(r.status, "not_submitted");
        assert.match(r.message, /not enabled/);
        assert.equal(card.number, "0000000000000000");
        assert.equal(card.cvv, "000");
        assert.equal(card.name, "");
    } finally {
        if (prev !== undefined) process.env.Z_ZERO_UCP_PAY_ENABLED = prev;
    }
});

// ───────────────────────── review round 3 ─────────────────────────
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const { expandIpv6, pinnedRequest } = __ucpInternals as any;

test("isPrivateIp: IPv4-mapped in HEX and expanded spellings, IPv4-compatible, NAT64", () => {
    for (const ip of [
        "::ffff:7f00:1",                 // 127.0.0.1 in hex
        "::ffff:a00:1",                  // 10.0.0.1 in hex
        "::ffff:c0a8:101",               // 192.168.1.1
        "::ffff:a9fe:a9fe",              // 169.254.169.254 (cloud metadata)
        "0:0:0:0:0:ffff:7f00:1",         // fully expanded
        "0000:0000:0000:0000:0000:ffff:0a00:0001",
        "::7f00:1",                      // IPv4-compatible (::/96, deprecated)
        "::127.0.0.1",
        "64:ff9b::7f00:1",               // NAT64 → 127.0.0.1
        "64:ff9b::10.0.0.1",
        "fec0::1",                       // site-local
        "ff02::1",                       // multicast
        "fe80::1%en0",                   // zone id
        "not-an-ip",                     // unparseable → unsafe
        ":::1",
    ]) {
        assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["::ffff:808:808", "::ffff:8.8.8.8", "64:ff9b::808:808", "2606:4700::1111", "2001:4860:4860::8888"]) {
        assert.equal(isPrivateIp(ip), false, ip);
    }
    assert.deepEqual(expandIpv6("::ffff:7f00:1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(expandIpv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.equal(expandIpv6("1:2:3"), null);
});

/** Local HTTP server on 127.0.0.1 used ONLY to exercise pinnedRequest's transport guards. */
async function withServer(handler: http.RequestListener, fn: (base: string, addrs: any[]) => Promise<void>) {
    const srv = http.createServer(handler);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    try {
        await fn(`http://ucp-test.invalid:${port}`, [{ address: "127.0.0.1", family: 4 }]);
    } finally {
        srv.closeAllConnections?.();
        await new Promise<void>((r) => srv.close(() => r()));
    }
}

test("pinnedRequest: socket goes to the PINNED address, not to DNS of the hostname", async () => {
    await withServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ host: req.headers.host })); },
        async (base, addrs) => {
            const res = await pinnedRequest(`${base}/x`, { headers: { Accept: "application/json" } }, addrs, { requestFn: http.request });
            assert.equal(res.ok, true);
            const body = await res.json();
            assert.match(body.host, /^ucp-test\.invalid:/); // Host header kept the hostname, bytes went to 127.0.0.1
            assert.equal(res.headers.get("content-type"), "application/json");
        });
});

test("pinnedRequest: slow-loris drip is cut by the ABSOLUTE deadline (not idle timeout)", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        const t = setInterval(() => res.write("x"), 50); // keeps the socket 'active' forever
        res.on("close", () => clearInterval(t));
    }, async (base, addrs) => {
        const t0 = Date.now();
        await assert.rejects(
            pinnedRequest(`${base}/slow`, {}, addrs, { requestFn: http.request, deadlineMs: 400 }),
            /deadline exceeded after 400ms/
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 2000, `took ${elapsed}ms`);
    });
});

test("pinnedRequest: oversized body is rejected and the connection destroyed", async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 1);
        let sent = 0;
        const push = () => { while (sent < 10 * 1024 * 1024 && res.write(chunk)) sent += chunk.length; if (sent < 10 * 1024 * 1024) res.once("drain", push); else res.end(); };
        push();
        res.on("error", () => {});
    }, async (base, addrs) => {
        await assert.rejects(
            pinnedRequest(`${base}/bomb`, {}, addrs, { requestFn: http.request, maxBodyBytes: 256 * 1024 }),
            /response exceeded 262144 bytes/
        );
    });
});
