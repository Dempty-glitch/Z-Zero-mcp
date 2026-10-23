// url-guard.ts
// Shared SSRF / scheme guard for any URL we are about to drive Playwright to.
// Used by BOTH execute_payment and auto_pay_checkout — these tools navigate a
// headless browser to an agent-supplied URL and (for execute_payment) inject a
// real PAN/CVV, so the destination must be a public HTTPS host, never an
// internal/metadata address.

import { isIP } from "node:net";

/** Expand any IPv6 literal (::, zone id, embedded dotted IPv4) to 8 numeric groups; null if malformed. */
export function expandIpv6(ip: string): number[] | null {
    let str = ip.toLowerCase().split("%")[0];
    const dotted = str.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) {
        const v4 = dotted[2].split(".").map(Number);
        if (v4.some((n) => n > 255)) return null;
        str = dotted[1] + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
    }
    const halves = str.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
    const groups = [...head, ...new Array(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    if (groups.length !== 8 || groups.some((n) => Number.isNaN(n))) return null;
    return groups;
}

/**
 * RFC1918 / loopback / link-local / CGNAT / multicast / unspecified for IPv4;
 * for IPv6: ::/96 (unspecified, loopback, deprecated IPv4-compatible), IPv4-mapped
 * ::ffff:0:0/96 in ANY spelling (dotted or hex — "::ffff:7f00:1" IS 127.0.0.1),
 * NAT64 64:ff9b::/96, ULA fc00::/7, link-local fe80::/10, site-local fec0::/10,
 * multicast ff00::/8. Unparseable literals are treated as unsafe.
 */
export function isPrivateIp(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (v === 6) {
        const g = expandIpv6(ip);
        if (!g) return true;
        const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
        const zero5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
        if (zero5 && g[5] === 0xffff) return isPrivateIp(v4(g[6], g[7]));      // IPv4-mapped, any spelling
        if (zero5 && g[5] === 0) return true;                                   // ::, ::1, ::a.b.c.d
        if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
            return isPrivateIp(v4(g[6], g[7]));                                 // NAT64
        }
        if ((g[0] & 0xfe00) === 0xfc00) return true;                            // ULA fc00::/7
        if ((g[0] & 0xffc0) === 0xfe80) return true;                            // link-local
        if ((g[0] & 0xffc0) === 0xfec0) return true;                            // site-local (deprecated)
        if ((g[0] & 0xff00) === 0xff00) return true;                            // multicast
        return false;
    }
    return true; // not an IP literal at all → caller must not treat as safe
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,        // link-local incl. cloud metadata 169.254.169.254
    /^\[::1\]$/,
    /^0\.0\.0\.0$/,
];

/**
 * Throws if `rawUrl` is not a safe public checkout URL.
 * - must parse as a URL
 * - must be HTTPS (except a loopback host when local checkout is explicitly enabled)
 * - must not resolve to a private / loopback / link-local host (SSRF)
 */
export function assertSafeCheckoutUrl(rawUrl: string): void {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid checkout_url: ${rawUrl}`);
    }

    const hostname = url.hostname;

    // Loopback checkout targets are an EXPLICIT opt-in, never a side effect of
    // NODE_ENV. This server runs on the end user's machine, where NODE_ENV is
    // essentially never "production" — so keying the bypass off that flag left it
    // permanently open in the one place it has to stay shut: this is the call that
    // decides where a real PAN/CVV gets typed. Opting in also waives the HTTPS
    // requirement, which is why it must be a deliberate act by the machine's owner.
    if (hostname === "localhost" || hostname === "127.0.0.1") {
        if (process.env.Z_ZERO_ALLOW_LOCAL_CHECKOUT === "1") {
            console.error(
                `[URL-GUARD] ⚠️ Local checkout allowed for ${hostname} — ` +
                `Z_ZERO_ALLOW_LOCAL_CHECKOUT=1 is set. Real card data will be typed into a local page. ` +
                `Unset it outside of testing.`
            );
            return;
        }
        throw new Error(
            `SSRF blocked host: ${hostname}. Checkout must be a public HTTPS page — ` +
            `a local address would receive real card data. ` +
            `For local testing only, set Z_ZERO_ALLOW_LOCAL_CHECKOUT=1.`
        );
    }

    if (url.protocol !== "https:") {
        throw new Error("checkout_url must use HTTPS.");
    }
    if (PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname))) {
        throw new Error(`SSRF blocked host: ${hostname}`);
    }
    // IP literals in any spelling: IPv6 private ranges, IPv4-mapped "::ffff:7f00:1",
    // CGNAT, 0.0.0.0/8 … (same judge the UCP lane uses; audit MCP-04).
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (isIP(bare) && isPrivateIp(bare)) {
        throw new Error(`SSRF blocked host: ${hostname}`);
    }
}
