// url-guard.ts
// Shared SSRF / scheme guard for any URL we are about to drive Playwright to.
// Used by BOTH execute_payment and auto_pay_checkout — these tools navigate a
// headless browser to an agent-supplied URL and (for execute_payment) inject a
// real PAN/CVV, so the destination must be a public HTTPS host, never an
// internal/metadata address.

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
 * - must be HTTPS (except localhost/127.0.0.1 in non-production, for local testing)
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
    const isDev = process.env.NODE_ENV !== "production";
    const isLocalDev = isDev && (hostname === "localhost" || hostname === "127.0.0.1");
    if (isLocalDev) return;

    if (url.protocol !== "https:") {
        throw new Error("checkout_url must use HTTPS.");
    }
    if (PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname))) {
        throw new Error(`SSRF blocked host: ${hostname}`);
    }
}
