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
//
// Any other host is OFF unless the machine's owner also sets
// Z_ZERO_ALLOW_CUSTOM_API=1 (audit T14 F2, M.5). A project folder can carry its
// own MCP config; one environment variable in it must not be enough to send
// this machine's Passport Key somewhere else. And even when allowed, a custom
// host gets its own credentials file (lib/key-store.ts) — a key stored for
// z-zero.xyz is never sent to it.

export const CANONICAL_API = "https://z-zero.xyz";

// Hosts that 30x to CANONICAL. Same origin in spirit, different origin to fetch.
// clawcard.store is the pre-rebrand domain and is still in real configs.
const LEGACY_HOSTS = new Set([
    "zzero.xyz",
    "www.zzero.xyz",
    "www.z-zero.xyz",
    "clawcard.store",
    "www.clawcard.store",
]);

const warnedFor = new Set<string>();
function warnOnce(key: string, msg: string): void {
    if (warnedFor.has(key)) return;
    warnedFor.add(key);
    console.error(msg);
}

/** The base URL every request should use: an origin, no path, no trailing slash. */
export function resolveApiBaseUrl(): string {
    const raw = (process.env.Z_ZERO_API_BASE_URL || process.env.Z_ZERO_API_BASE || "").trim();
    if (!raw) return CANONICAL_API;

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        warnOnce("invalid", `[Z-ZERO MCP] ⚠️ Z_ZERO_API_BASE_URL is not a valid URL — using ${CANONICAL_API}.`);
        return CANONICAL_API;
    }
    const host = url.hostname.toLowerCase();

    if (host === new URL(CANONICAL_API).hostname && url.protocol === "https:" && url.port === "") return CANONICAL_API;

    if (LEGACY_HOSTS.has(host)) {
        warnOnce("legacy",
            `[Z-ZERO MCP] ⚠️ Z_ZERO_API_BASE_URL points at ${host}, which redirects to z-zero.xyz. ` +
            `A cross-origin redirect strips the Authorization header, so every call would fail as 401. ` +
            `Using ${CANONICAL_API} instead — please update your MCP config.`
        );
        return CANONICAL_API;
    }

    if (process.env.Z_ZERO_ALLOW_CUSTOM_API !== "1") {
        warnOnce("custom-off",
            `[Z-ZERO MCP] ⚠️ Z_ZERO_API_BASE_URL (${url.host}) is IGNORED — using ${CANONICAL_API}. ` +
            `To run against your own Z-ZERO server, also set Z_ZERO_ALLOW_CUSTOM_API=1.`
        );
        return CANONICAL_API;
    }

    // The Passport Key rides on every request to this host, so it must be HTTPS.
    // Plain http only for a server on this machine.
    const isLocal = host === "localhost" || host === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
        warnOnce("custom-http", `[Z-ZERO MCP] ⚠️ Z_ZERO_API_BASE_URL must be https — using ${CANONICAL_API} instead.`);
        return CANONICAL_API;
    }
    warnOnce("custom-on",
        `[Z-ZERO MCP] ⚠️ Custom API ${url.origin} is ON (Z_ZERO_ALLOW_CUSTOM_API=1). ` +
        `It gets its own key file; your z-zero.xyz key is not sent there.`
    );
    return url.origin;
}

/** True when requests go somewhere other than z-zero.xyz. */
export function isCustomApi(): boolean {
    return resolveApiBaseUrl() !== CANONICAL_API;
}
