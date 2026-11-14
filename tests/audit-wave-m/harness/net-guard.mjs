// Loaded FIRST in every test process. Nothing may leave this machine: sockets
// only to loopback, and fetch() to any other host is recorded and refused (so a
// test can assert "the MCP tried to call z-zero.xyz" without it ever happening).
// Tests are also run inside `sandbox-exec` with outbound network denied.
import net from "node:net";

const LOCAL = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const first = args[0];
    if (typeof first === "object" && first && !first.path) {
        const host = String(first.host || first.hostname || "127.0.0.1").toLowerCase();
        if (!LOCAL.has(host)) throw new Error(`BLOCKED_EXTERNAL_CONNECT ${host}`);
    } else if (typeof first === "number") {
        const host = typeof args[1] === "string" ? args[1].toLowerCase() : "127.0.0.1";
        if (!LOCAL.has(host)) throw new Error(`BLOCKED_EXTERNAL_CONNECT ${host}`);
    }
    return origConnect.apply(this, args);
};

globalThis.__zzBlockedFetches = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!LOCAL.has(url.hostname)) {
        const h = new Headers(init.headers || {});
        globalThis.__zzBlockedFetches.push({ url: url.href, authorization: h.get("authorization") });
        throw new TypeError(`fetch blocked by test harness: ${url.host}`);
    }
    return realFetch(input, init);
};
