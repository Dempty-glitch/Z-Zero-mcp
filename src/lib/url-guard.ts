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
}
