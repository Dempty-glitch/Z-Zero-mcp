// api-base.ts
// One place that decides which host this MCP server talks to.
//
// Why this exists: the move to z-zero.xyz left older installs pointing at
// zzero.xyz, which now answers 308 → https://z-zero.xyz. Node's fetch follows
// that redirect but DROPS the Authorization header on a cross-origin hop, so
// the API sees no key and answers 401 "Unauthorized". The result is the worst
// kind of failure — a perfectly valid Passport Key that looks revoked, on every
// single tool, with the docs telling the user to go make another one.
//
// Rewriting the known legacy hosts here fixes it for every call site at once.
// We never re-send the key to a redirect target ourselves: that is how a key
// leaks to whatever host a redirect happens to name.

const CANONICAL = "https://z-zero.xyz";

// Hosts that 30x to CANONICAL. Same origin in spirit, different origin to fetch.
// clawcard.store is the pre-rebrand domain and is still in real configs.
const LEGACY_HOSTS = new Set([
    "zzero.xyz",
    "www.zzero.xyz",
    "www.z-zero.xyz",
    "clawcard.store",
    "www.clawcard.store",
]);

let warned = false;

/** The base URL every request should use, with legacy hosts corrected. */
export function resolveApiBaseUrl(): string {
    const raw = (
        process.env.Z_ZERO_API_BASE_URL ||
        process.env.Z_ZERO_API_BASE ||
        CANONICAL
    ).trim();

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        console.error(`[Z-ZERO MCP] ⚠️ Z_ZERO_API_BASE_URL is not a valid URL ("${raw}") — using ${CANONICAL}.`);
        return CANONICAL;
    }

    if (LEGACY_HOSTS.has(url.hostname)) {
        if (!warned) {
            warned = true;
            console.error(
                `[Z-ZERO MCP] ⚠️ Z_ZERO_API_BASE_URL points at ${url.hostname}, which redirects to z-zero.xyz. ` +
                `A cross-origin redirect strips the Authorization header, so every call would fail as 401. ` +
                `Using ${CANONICAL} instead — please update your MCP config.`
            );
        }
        return CANONICAL;
    }

    return raw.replace(/\/$/, "");
}
