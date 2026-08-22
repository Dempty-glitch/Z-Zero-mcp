// UCP Bridge — the "Official Rail"
// Pays Shopify (and any UCP-compliant) checkouts through the Universal Commerce
// Protocol instead of browser automation. Shopify's platform-wide robots policy
// ("Checkouts are for humans... no scripted form fills, browser automation")
// makes this the ONLY sanctioned lane on Shopify stores — the card is submitted
// as a structured UCP payment instrument to the merchant's declared
// dev.shopify.card handler, never typed into a DOM form.
//
// Same security contract as playwright_bridge: CardData lives only in RAM inside
// this module, is wiped after submission, and NEVER enters LLM context.

import type { CardData, PaymentResult } from "./types.js";
import { withTimeout, TimeoutError } from "./lib/with-timeout.js";
import { assertSafeCheckoutUrl } from "./lib/url-guard.js";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import * as https from "node:https";

const UCP_HARD_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// ============================================================
// SSRF guard for every URL this module touches: the agent-supplied
// shop URL, every redirect hop during discovery, AND the MCP endpoint
// the merchant's document points at (a hostile .well-known/ucp could
// otherwise steer us to localhost / LAN / cloud metadata).
// ============================================================
function assertSafeUcpUrl(rawUrl: string, what: string): void {
    try {
        assertSafeCheckoutUrl(rawUrl);
        // The UCP lane never talks to loopback — no local opt-in here, unlike the Playwright lane.
        const host = new URL(rawUrl).hostname;
        const bare = host.replace(/^\[|\]$/g, "");
        // Hostnames are vetted at resolve time (resolvePublic); only IP LITERALS are judged here.
        if (/^localhost$/i.test(host) || (isIP(bare) && isPrivateIp(bare))) throw new Error(`SSRF blocked host: ${host}`);
    } catch (err: any) {
        throw new Error(`UCP ${what} rejected: ${err?.message ?? err}`);
    }
}

/** Expand any IPv6 literal (::, zone id, embedded dotted IPv4) to 8 numeric groups; null if malformed. */
function expandIpv6(ip: string): number[] | null {
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
function isPrivateIp(ip: string): boolean {
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

type ResolvedAddr = { address: string; family: number };

/**
 * Resolve the host, reject if ANY address is private, and RETURN the vetted
 * addresses so the socket can be pinned to them. Resolving here and letting the
 * HTTP client resolve again would be a DNS-rebinding hole (review 14/08).
 */
async function resolvePublic(rawUrl: string, what: string): Promise<ResolvedAddr[]> {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
    const lit = isIP(host);
    if (lit) {
        if (isPrivateIp(host)) throw new Error(`UCP ${what} rejected: SSRF blocked IP ${host}`);
        return [{ address: host, family: lit }];
    }
    let addrs: ResolvedAddr[];
    try {
        addrs = await dns.lookup(host, { all: true });
    } catch (err: any) {
        throw new Error(`UCP ${what} rejected: DNS lookup failed for ${host} (${err?.code ?? err?.message})`);
    }
    if (!addrs.length) throw new Error(`UCP ${what} rejected: ${host} did not resolve`);
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad) throw new Error(`UCP ${what} rejected: ${host} resolves to private address ${bad.address}`);
    return addrs;
}

/** Lookup override that ignores the hostname and returns ONLY the pre-vetted addresses. */
export function makePinnedLookup(addrs: ResolvedAddr[]): (...args: any[]) => void {
    return (_hostname: string, options: any, callback?: any) => {
        const cb = typeof options === "function" ? options : callback;
        const opts = typeof options === "function" ? {} : (options ?? {});
        if (opts.all) return cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        return cb(null, addrs[0].address, addrs[0].family);
    };
}

/**
 * Redirect policy (pure, unit-tested):
 *  - non-GET requests NEVER follow redirects (an MCP POST must land where discovery said);
 *  - cross-origin GET redirects are followed but credential-bearing headers are stripped.
 */
export function planRedirect(
    current: string,
    location: string,
    init: { method?: string; headers?: Record<string, string> }
): { next: string; headers: Record<string, string> } {
    const next = new URL(location, current).toString();
    const method = (init.method ?? "GET").toUpperCase();
    const from = new URL(current).origin;
    const to = new URL(next).origin;
    if (method !== "GET") throw new Error(`redirect refused for ${method} (${from} → ${to})`);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (from !== to) {
        for (const k of Object.keys(headers)) {
            if (/^(authorization|mcp-session-id|cookie|proxy-authorization)$/i.test(k)) delete headers[k];
        }
    }
    return { next, headers };
}

interface SafeResponse {
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json(): Promise<any>;
}

interface SafeInit { method?: string; headers?: Record<string, string>; body?: string }

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB — a UCP document/checkout is a few KB

export interface PinnedRequestOpts {
    deadlineMs?: number;       // ABSOLUTE wall-clock budget (Node's `timeout` is only idle time)
    maxBodyBytes?: number;
    /** Transport override for tests (e.g. http.request against a local server). Production: https.request. */
    requestFn?: typeof https.request;
}

/**
 * One request whose TCP connection is pinned to the vetted addresses (SNI/Host stay the hostname).
 * Guards against slow-loris (absolute deadline → destroy) and response bombs (body cap → destroy).
 */
export function pinnedRequest(url: string, init: SafeInit, addrs: ResolvedAddr[], opts: PinnedRequestOpts = {}): Promise<SafeResponse> {
    const u = new URL(url);
    const deadlineMs = opts.deadlineMs ?? FETCH_TIMEOUT_MS;
    const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    const requestFn = opts.requestFn ?? https.request;
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => { if (!settled) { settled = true; clearTimeout(deadline); reject(err); } };
        const done = (r: SafeResponse) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(r); } };

        const req = requestFn(
            {
                protocol: u.protocol,
                host: u.hostname,
                servername: u.protocol === "https:" ? u.hostname : undefined,
                port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
                path: u.pathname + u.search,
                method: init.method ?? "GET",
                headers: init.headers ?? {},
                lookup: makePinnedLookup(addrs) as any,
                timeout: deadlineMs, // idle guard; the absolute deadline below is the real cap
            },
            (res) => {
                const chunks: Buffer[] = [];
                let received = 0;
                res.on("data", (c: Buffer) => {
                    received += c.length;
                    if (received > maxBody) {
                        res.destroy();
                        req.destroy();
                        fail(new Error(`response exceeded ${maxBody} bytes`));
                        return;
                    }
                    chunks.push(c);
                });
                res.on("error", fail);
                res.on("end", () => {
                    if (settled) return;
                    const body = Buffer.concat(chunks).toString("utf8");
                    const status = res.statusCode ?? 0;
                    done({
                        status,
                        ok: status >= 200 && status < 300,
                        headers: {
                            get: (name: string) => {
                                const v = res.headers[name.toLowerCase()];
                                return Array.isArray(v) ? v.join(", ") : (v ?? null);
                            },
                        },
                        text: async () => body,
                        json: async () => JSON.parse(body),
                    });
                });
            }
        );
        const deadline = setTimeout(() => {
            req.destroy();
            fail(new Error(`deadline exceeded after ${deadlineMs}ms`));
        }, deadlineMs);
        req.on("timeout", () => { req.destroy(); fail(new Error(`idle timeout after ${deadlineMs}ms`)); });
        req.on("error", fail);
        if (init.body) req.write(init.body);
        req.end();
    });
}

const DEFAULT_USER_AGENT = "z-zero-mcp-ucp-bridge";

async function safeFetch(url: string, init: SafeInit = {}, what = "url"): Promise<SafeResponse> {
    let current = url;
    let headers: Record<string, string> = { ...(init.headers ?? {}) };
    // Always identify as a declared agent. Shopify answers 403 to UA-less requests,
    // and never spoofing a human browser is a hard-coded discipline of this bridge.
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) headers["User-Agent"] = DEFAULT_USER_AGENT;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        assertSafeUcpUrl(current, what);
        const addrs = await resolvePublic(current, what);
        const res = await pinnedRequest(current, { ...init, headers }, addrs);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) return res;
            const plan = planRedirect(current, loc, { method: init.method, headers });
            current = plan.next;
            headers = plan.headers;
            continue;
        }
        return res;
    }
    throw new Error(`UCP ${what}: too many redirects (>${MAX_REDIRECTS})`);
}

// ISO 4217 minor-unit exponent from the runtime's currency data (CLF/UYW=4,
// KWD=3, VND/JPY=0, USD=2 …). Unknown/invalid codes fall back to 2.
export function minorUnitExponent(currency: string | null | undefined): number {
    const c = (currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) return 2;
    try {
        const d = new Intl.NumberFormat("en", { style: "currency", currency: c }).resolvedOptions().maximumFractionDigits;
        return typeof d === "number" ? d : 2;
    } catch {
        return 2;
    }
}
export function minorToMajor(minor: number | null, currency: string | null | undefined): number | null {
    if (minor == null) return null;
    return minor / Math.pow(10, minorUnitExponent(currency));
}

// ============================================================
// Discovery — GET https://{shop}/.well-known/ucp
// ============================================================

export interface UcpPaymentHandler {
    handler_name: string;          // e.g. "dev.shopify.card"
    id: string;                    // instance id, e.g. "shopify.card" — goes into instrument.handler_id
    version: string;
    config: Record<string, unknown>;
}

export interface UcpDiscovery {
    version: string;
    mcpEndpoint: string;           // e.g. https://shop.myshopify.com/api/ucp/mcp
    handlers: UcpPaymentHandler[];
    cardHandler: UcpPaymentHandler | null;  // dev.shopify.card if declared
    raw: Record<string, unknown>;
}

/**
 * Fetches and parses a merchant's UCP discovery document.
 * Returns null when the merchant does not speak UCP (→ caller falls back to Playwright).
 * Throws only on SSRF rejection (never silently "fall back" past a blocked host).
 */
export async function ucpDiscover(merchantUrl: string): Promise<UcpDiscovery | null> {
    let origin: string;
    try {
        origin = new URL(merchantUrl).origin;
    } catch {
        return null;
    }
    assertSafeUcpUrl(origin, "shop_url");

    let doc: any;
    try {
        const res = await safeFetch(`${origin}/.well-known/ucp`, { headers: { Accept: "application/json" } }, "discovery");
        if (!res.ok) {
            if (res.status !== 404) console.error(`[UCP] discovery ${origin} → HTTP ${res.status}`);
            return null;
        }
        doc = await res.json();
    } catch (err: any) {
        if (/rejected|redirects/.test(String(err?.message))) throw err;
        console.error(`[UCP] discovery failed for ${origin}: ${err?.message ?? err}`);
        return null;
    }

    const ucp = doc?.ucp;
    if (!ucp || typeof ucp !== "object") return null;

    // MCP endpoint from services (dev.ucp.shopping, transport "mcp")
    let mcpEndpoint: string | null = null;
    const services = ucp.services ?? {};
    for (const entries of Object.values(services) as any[]) {
        if (!Array.isArray(entries)) continue;
        const mcp = entries.find((e: any) => e?.transport === "mcp" && typeof e?.endpoint === "string");
        if (mcp) { mcpEndpoint = mcp.endpoint; break; }
    }
    if (!mcpEndpoint) return null;
    // The merchant document is untrusted input — its endpoint must pass the same guard.
    assertSafeUcpUrl(mcpEndpoint, "mcp endpoint (from merchant discovery)");

    const handlers: UcpPaymentHandler[] = [];
    const handlerMap = ucp.payment_handlers ?? {};
    for (const [handler_name, entries] of Object.entries(handlerMap) as [string, any][]) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
            handlers.push({
                handler_name,
                id: String(e?.id ?? handler_name),
                version: String(e?.version ?? ""),
                config: e?.config ?? {},
            });
        }
    }

    return {
        version: String(ucp.version ?? ""),
        mcpEndpoint,
        handlers,
        cardHandler: handlers.find((h) => h.handler_name === "dev.shopify.card") ?? null,
        raw: ucp,
    };
}

// ============================================================
// Minimal MCP client — JSON-RPC 2.0 over Streamable HTTP
// Stateless-first (spec 2026-07-28); falls back to initialize
// handshake if the server demands it. Accepts JSON and SSE replies.
// ============================================================

// Agent profile sent in meta["ucp-agent"] for capability negotiation.
// TODO(z-zero): host our own profile at https://z-zero.xyz/.well-known/ucp-agent.json
// and switch the default — Shopify's published example profile is used until then.
const DEFAULT_AGENT_PROFILE =
    process.env.UCP_AGENT_PROFILE ??
    "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json";

export class UcpMcpClient {
    private nextId = 1;
    private sessionId: string | null = null;
    private initialized = false;

    constructor(
        private endpoint: string,
        private opts: { bearerToken?: string; userAgent?: string; agentProfile?: string } = {}
    ) {
        assertSafeUcpUrl(endpoint, "mcp endpoint");
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            // Declared agent — never spoof a human browser (hard-coded discipline).
            "User-Agent": this.opts.userAgent ?? "z-zero-mcp-ucp-bridge",
        };
        if (this.opts.bearerToken) h.Authorization = `Bearer ${this.opts.bearerToken}`;
        if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
        return h;
    }

    private async rpc(method: string, params: unknown): Promise<any> {
        const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
        const res = await safeFetch(this.endpoint, { method: "POST", headers: this.headers(), body }, "mcp call");

        const sid = res.headers.get("mcp-session-id");
        if (sid) this.sessionId = sid;

        const ctype = res.headers.get("content-type") ?? "";
        let payload: any = null;
        if (ctype.includes("text/event-stream")) {
            // Collect the last JSON-RPC response object in the SSE stream.
            const text = await res.text();
            for (const line of text.split("\n")) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data:")) {
                    try {
                        const parsed = JSON.parse(trimmed.slice(5).trim());
                        if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) payload = parsed;
                    } catch { /* keep scanning */ }
                }
            }
        } else {
            try { payload = await res.json(); } catch { payload = null; }
        }

        if (!res.ok && !payload) {
            throw new Error(`UCP MCP HTTP ${res.status} on ${method}`);
        }
        if (payload?.error) {
            const err: any = new Error(`UCP MCP error ${payload.error.code}: ${payload.error.message}`);
            err.rpcCode = payload.error.code;
            err.rpcData = payload.error.data;
            throw err;
        }
        return payload?.result;
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        try {
            await this.rpc("initialize", {
                protocolVersion: "2026-07-28",
                capabilities: {},
                clientInfo: { name: "z-zero-ucp-bridge", version: "1.0.0" },
            });
            // Best-effort — notification has no id and some stateless servers reject it.
            await safeFetch(this.endpoint, {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            }).catch(() => {});
        } catch {
            // Stateless servers may not implement initialize at all — that's fine.
        }
        this.initialized = true;
    }

    /** Calls a UCP tool. Retries once through the initialize handshake on "not initialized" errors. */
    async callTool(name: string, args: Record<string, unknown>): Promise<any> {
        // Inject the agent profile into meta unless the caller already set one.
        const m = (args.meta ?? {}) as Record<string, unknown>;
        if (!m["ucp-agent"]) {
            m["ucp-agent"] = { profile: this.opts.agentProfile ?? DEFAULT_AGENT_PROFILE };
        }
        args = { ...args, meta: m };
        const doCall = () => this.rpc("tools/call", { name, arguments: args });
        try {
            return this.unwrap(await doCall());
        } catch (err: any) {
            const msg = String(err?.message ?? "");
            if (err?.rpcCode === -32002 || /initializ/i.test(msg)) {
                await this.ensureInitialized();
                return this.unwrap(await doCall());
            }
            // Anonymous tier has tight rate limits — back off once before giving up.
            if (err?.rpcCode === -32000 || /rate limit/i.test(msg)) {
                await new Promise((r) => setTimeout(r, 2_500));
                return this.unwrap(await doCall());
            }
            throw err;
        }
    }

    /**
     * MCP tool results wrap payloads in content blocks; UCP puts JSON in structuredContent
     * or a text block. Shopify marks results isError even when the payload is a perfectly
     * valid checkout resource in a recoverable state (e.g. delivery_address_required) —
     * so a parseable UCP resource is RETURNED, never thrown; only opaque errors throw.
     */
    private unwrap(result: any): any {
        if (result == null) return result;
        let payload: any;
        if (result.structuredContent !== undefined) payload = result.structuredContent;
        else if (Array.isArray(result.content)) {
            const textBlock = result.content.find((c: any) => c?.type === "text" && typeof c.text === "string");
            if (textBlock) {
                try { payload = JSON.parse(textBlock.text); } catch { payload = textBlock.text; }
            }
        }
        if (result.isError) {
            const isUcpResource = payload && typeof payload === "object" && (payload.id || payload.status || payload.ucp);
            if (isUcpResource) return payload;
            const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? result);
            throw new Error(`UCP tool error: ${text}`);
        }
        return payload ?? result;
    }
}

// ============================================================
// Checkout flow
// ============================================================

export interface UcpBuyer {
    email: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
}

// UCP postal_address (schema.org-style field names — verified against
// ucp.dev/2026-04-08/schemas/shopping/types/postal_address.json)
export interface UcpAddress {
    first_name?: string;
    last_name?: string;
    street_address: string;
    extended_address?: string;
    address_locality: string;   // city
    address_region?: string;    // state/province code (required for US/CA)
    address_country: string;    // ISO 3166-1 alpha-2, e.g. "US"
    postal_code: string;
    phone_number?: string;
}

export interface UcpLineItem {
    /** Merchant product/variant identifier, e.g. a Shopify variant GID or product URL */
    item_id: string;
    quantity: number;
}

export interface UcpQuote {
    checkout_id: string;
    status: string;                 // incomplete | requires_escalation | ready_for_complete | ...
    total_minor: number | null;     // grand total as the wire value — MINOR units (8900 USD = $89.00)
    total_major: number | null;     // human/major units per ISO 4217 exponent (89 for 8900 USD; 12160000 VND stays 12160000)
    currency: string | null;
    continue_url: string | null;    // escalation URL when the merchant demands buyer action
    messages: string[];
    raw: any;
}

const uuid = () => globalThis.crypto.randomUUID();

/** Standard UCP meta block sent with every call. */
function meta(extra?: Record<string, unknown>): Record<string, unknown> {
    return { ...extra };
}

function pickMoney(obj: any, keys: string[]): { amount: number | null; currency: string | null } {
    for (const k of keys) {
        const v = obj?.[k];
        if (v == null) continue;
        if (typeof v === "number") return { amount: v, currency: obj?.currency ?? null };
        if (typeof v === "object") {
            const amount = Number(v.amount ?? v.value ?? NaN);
            if (!Number.isNaN(amount)) return { amount, currency: v.currency ?? v.currency_code ?? null };
        }
        const parsed = Number(v);
        if (!Number.isNaN(parsed)) return { amount: parsed, currency: obj?.currency ?? null };
    }
    return { amount: null, currency: null };
}

function summarizeCheckout(checkout: any): Omit<UcpQuote, "raw"> {
    const c = checkout?.checkout ?? checkout ?? {};

    // Shopify shape: totals = [{type:"total", amount, display_text}, ...]; amounts in the
    // currency's MINOR units for decimal currencies, whole units for zero-decimal (VND, JPY).
    let amount: number | null = null;
    let currency: string | null = c.currency ?? null;
    if (Array.isArray(c.totals)) {
        const totalRow = c.totals.find((t: any) => t?.type === "total") ?? c.totals[c.totals.length - 1];
        if (totalRow && totalRow.amount != null) amount = Number(totalRow.amount);
    } else {
        const money = pickMoney(c.totals ?? c.total ?? c.cost ?? c, ["total", "grand_total", "total_amount", "amount"]);
        amount = money.amount;
        currency = currency ?? money.currency;
    }

    const messages: string[] = [];
    for (const m of c.messages ?? []) {
        if (typeof m === "string") messages.push(m);
        else if (m?.content) messages.push(`[${m.code ?? m.severity ?? "msg"}] ${m.content}`);
        else if (m?.message) messages.push(String(m.message));
        else if (m?.content_html) messages.push(String(m.content_html));
    }
    return {
        checkout_id: String(c.id ?? ""),
        status: String(c.status ?? "unknown"),
        total_minor: amount,
        total_major: minorToMajor(amount, currency),
        currency,
        continue_url: c.continue_url ?? c.escalation?.continue_url ?? null,
        messages,
    };
}

/**
 * Creates a checkout for the given line items and returns the merchant's quote
 * (total, status, escalation info). NO money moves here — this is the read step
 * the agent uses before requesting a JIT card for the exact total.
 */
export async function ucpCreateCheckout(
    client: UcpMcpClient,
    items: UcpLineItem[],
    buyer: UcpBuyer,
    shippingAddress?: UcpAddress
): Promise<UcpQuote> {
    const checkout: Record<string, unknown> = {
        line_items: items.map((i) => ({ item: { id: i.item_id }, quantity: i.quantity })),
        buyer,
    };
    const result = await client.callTool("create_checkout", { meta: meta(), checkout });
    let created: UcpQuote = { ...summarizeCheckout(result), raw: result };

    // Address goes in a SECOND call: Shopify validation demands line_items re-sent and
    // destinations as FLAT postal_address objects with line_item_ids (learned live 14/08).
    if (shippingAddress && created.checkout_id) {
        const c = (result as any)?.checkout ?? result ?? {};
        const lineItems = (c.line_items ?? []).map((li: any) => ({
            id: li.id,
            item: { id: li.item?.id },
            quantity: li.quantity,
        }));
        const upd = await client.callTool("update_checkout", {
            meta: meta(),
            id: created.checkout_id,
            checkout: {
                line_items: lineItems,
                buyer,
                fulfillment: {
                    methods: [{
                        type: "shipping",
                        line_item_ids: lineItems.map((li: any) => li.id),
                        destinations: [shippingAddress],
                    }],
                },
            },
        });
        created = { ...summarizeCheckout(upd), raw: upd };
    }
    return created;
}

export async function ucpGetCheckout(client: UcpMcpClient, checkoutId: string): Promise<UcpQuote> {
    const result = await client.callTool("get_checkout", { meta: meta(), id: checkoutId });
    return { ...summarizeCheckout(result), raw: result };
}

// ============================================================
// Payment — submit the Z-Zero JIT card via dev.shopify.card
// ============================================================

const BRAND_BY_PREFIX: Array<[RegExp, string]> = [
    [/^4/, "visa"],
    [/^5[1-5]/, "master"],
    [/^2[2-7]/, "master"],
    [/^3[47]/, "american_express"],
    [/^6(?:011|5)/, "discover"],
    [/^3(?:0[0-5]|[68])/, "diners_club"],
];

function detectBrand(pan: string): string {
    for (const [re, brand] of BRAND_BY_PREFIX) if (re.test(pan)) return brand;
    return "visa";
}

export interface UcpPayParams {
    merchantUrl: string;
    checkoutId: string;
    cardData: CardData;             // resolved server-side; wiped after submission
    buyer: UcpBuyer;
    billingAddress: UcpAddress;
    bearerToken?: string;           // Shopify Token-tier credential (required for complete_checkout)
    /** Existing client (keeps session); a new one is built when omitted. */
    client?: UcpMcpClient;
    expectedTotalMajor?: number;    // pre-flight guard in MAJOR units: abort if merchant total drifted above this
}

// ⛔ PAYMENT LANE IS NOT YET ENABLED.
// Two things are unverified against a live Token-tier shop: (1) the exact credential
// shape dev.shopify.card accepts, (2) whether extension_interaction_required clears at
// Token-tier. Until a real e2e passes, ucpPayCheckout refuses to run unless the machine
// owner opts in explicitly. No MCP tool calls this function today.
const UCP_PAY_ENABLED = process.env.Z_ZERO_UCP_PAY_ENABLED === "1";

/**
 * Attaches the card instrument and completes the checkout.
 * Mirrors playwright_bridge semantics: returns PaymentResult where success=true
 * ONLY on a merchant-confirmed order (that is the caller's sole burn gate).
 */
export async function ucpPayCheckout(params: UcpPayParams): Promise<PaymentResult> {
    const { cardData } = params;
    if (!UCP_PAY_ENABLED) {
        // Wipe immediately — we are not going to use the card.
        cardData.number = "0000000000000000"; cardData.cvv = "000"; cardData.exp_month = "00"; cardData.exp_year = "0000"; cardData.name = "";
        return {
            success: false,
            status: "not_submitted",
            message:
                "UCP payment lane is not enabled (Z_ZERO_UCP_PAY_ENABLED is unset). The lane currently supports discovery + " +
                "quote/draft + continue_url only; completion requires Shopify Token-tier auth and an unverified card-credential shape. " +
                "Nothing was charged, token NOT burned.",
        };
    }
    try {
        return await withTimeout(
            _ucpPayInner(params),
            UCP_HARD_TIMEOUT_MS,
            "ucpPayCheckout"
        );
    } catch (err: unknown) {
        if (err instanceof TimeoutError) {
            return {
                success: false,
                status: "unconfirmed",
                message:
                    `UCP checkout timed out after ${UCP_HARD_TIMEOUT_MS / 1000}s AFTER submission started. ` +
                    `Token NOT burned — verify with get_order/merchant before any retry (double-charge risk).`,
            };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, status: "error", message: `UCP payment failed: ${msg}` };
    } finally {
        // RAM WIPE — same contract as playwright_bridge
        cardData.number = "0000000000000000";
        cardData.cvv = "000";
        cardData.exp_month = "00";
        cardData.exp_year = "0000";
        cardData.name = "";
    }
}

async function _ucpPayInner(params: UcpPayParams): Promise<PaymentResult> {
    const { merchantUrl, checkoutId, cardData, buyer, billingAddress, bearerToken, expectedTotalMajor } = params;

    const discovery = await ucpDiscover(merchantUrl);
    if (!discovery) {
        return { success: false, status: "no_fields", message: "Merchant does not expose /.well-known/ucp — UCP lane unavailable. Fall back to the standard flow." };
    }
    if (!discovery.cardHandler) {
        return {
            success: false,
            status: "no_fields",
            message:
                `Merchant speaks UCP but declares no dev.shopify.card handler ` +
                `(handlers: ${discovery.handlers.map((h) => h.handler_name).join(", ") || "none"}). ` +
                `Card payment is not possible on the UCP lane here.`,
        };
    }

    const client = params.client ?? new UcpMcpClient(discovery.mcpEndpoint, { bearerToken });

    // Pre-flight: re-read the checkout, verify state & total BEFORE attaching the card.
    const quote = await ucpGetCheckout(client, checkoutId);
    if (quote.status === "completed") {
        return { success: false, status: "error", message: "Checkout is already completed — refusing to pay twice." };
    }
    if (quote.status === "canceled") {
        return { success: false, status: "error", message: "Checkout was canceled by the merchant." };
    }
    if (expectedTotalMajor != null && quote.total_major != null && quote.total_major > expectedTotalMajor + 0.005) {
        return {
            success: false,
            status: "not_submitted",
            message:
                `🚨 BLOCKED before submission: merchant total ${quote.total_major} ${quote.currency ?? ""} exceeds the authorized ${expectedTotalMajor}. ` +
                `Token NOT burned. Re-quote and request a new token for the correct amount.`,
        };
    }

    // Card instrument for dev.shopify.card. Credential shape follows the UCP
    // payment-handler pattern. ⚠️ UNVERIFIED against a live Token-tier shop: the
    // raw-card-fields guess may need to become the encrypted-credential variant.
    // That is exactly why this whole function sits behind Z_ZERO_UCP_PAY_ENABLED —
    // server validation errors are surfaced verbatim below to drive the fix.
    const pan = cardData.number.replace(/\D/g, "");
    const instrument = {
        id: `zz_${uuid().slice(0, 8)}`,
        handler_id: discovery.cardHandler.id,
        type: "card",
        billing_address: billingAddress,
        credential: {
            type: "card",
            number: pan,
            exp_month: Number(cardData.exp_month),
            exp_year: Number(cardData.exp_year.length === 2 ? `20${cardData.exp_year}` : cardData.exp_year),
            verification_value: cardData.cvv,
            name: cardData.name,
        },
        display: {
            brand: detectBrand(pan),
            last_digits: pan.slice(-4),
        },
        selected: true,
    };

    // Attach instrument (update), then complete with an idempotency key.
    // update_checkout has PUT semantics: anything omitted can be dropped. Re-send
    // line_items AND the fulfillment state (address + selected method) from the
    // pre-flight read, or the address we just collected gets wiped (review 14/08).
    const quoteCheckout = (quote.raw as any)?.checkout ?? quote.raw ?? {};
    const lineItemsPatch = (quoteCheckout.line_items ?? []).map((li: any) => ({
        id: li.id,
        item: { id: li.item?.id },
        quantity: li.quantity,
    }));
    const fulfillmentPatch = quoteCheckout.fulfillment && Array.isArray(quoteCheckout.fulfillment.methods) && quoteCheckout.fulfillment.methods.length
        ? quoteCheckout.fulfillment
        : undefined;
    let updated: UcpQuote;
    try {
        const upd = await client.callTool("update_checkout", {
            meta: meta(),
            id: checkoutId,
            checkout: {
                line_items: lineItemsPatch,
                buyer,
                ...(fulfillmentPatch ? { fulfillment: fulfillmentPatch } : {}),
                payment: { instruments: [instrument] },
            },
        });
        updated = { ...summarizeCheckout(upd), raw: upd };
    } catch (err: any) {
        return {
            success: false,
            status: "not_submitted",
            message: `Merchant rejected the payment instrument BEFORE completion (nothing charged): ${err?.message ?? err}`,
        };
    }

    if (updated.status === "requires_escalation") {
        return {
            success: false,
            status: "not_submitted",
            message:
                `Merchant requires buyer escalation before completing — nothing was charged. ` +
                (updated.continue_url ? `Hand the buyer this URL to finish: ${updated.continue_url}. ` : "") +
                updated.messages.join(" "),
        };
    }

    const idempotencyKey = uuid();
    let completed: any;
    try {
        completed = await client.callTool("complete_checkout", {
            meta: meta({ "idempotency-key": idempotencyKey }),
            id: checkoutId,
            checkout: { payment: { instruments: [instrument] } },
        });
    } catch (err: any) {
        const msg = String(err?.message ?? err);
        // Auth-gate: Shopify only allows Token-tier agents to complete.
        if (/401|403|unauthorized|forbidden|permission/i.test(msg)) {
            return {
                success: false,
                status: "not_submitted",
                message:
                    `complete_checkout requires Token-tier agent auth on this shop (Shopify Dev Dashboard JWT or a shop access token) — nothing was charged. ` +
                    (updated.continue_url ? `Buyer can finish manually at: ${updated.continue_url}. ` : "") +
                    `Server said: ${msg}`,
            };
        }
        if (/declin|insufficient|invalid card|card.*not accepted/i.test(msg)) {
            return { success: false, status: "declined", message: `Merchant declined the card at completion: ${msg}` };
        }
        // Submission started but the outcome is unknown — the dangerous case.
        return {
            success: false,
            status: "unconfirmed",
            message:
                `complete_checkout errored AFTER submission (idempotency-key ${idempotencyKey}) — outcome unknown, token NOT burned. ` +
                `Retry with the SAME key or verify via get_order before anything else. Server said: ${msg}`,
        };
    }

    const final = summarizeCheckout(completed);
    const order = completed?.order ?? completed?.checkout?.order ?? null;
    const orderId: string | undefined = order?.id ?? order?.order_number ?? completed?.order_id ?? undefined;

    if (final.status === "completed" || orderId) {
        return {
            success: true,
            status: "confirmed",
            message:
                `✅ Order confirmed via the official UCP rail (dev.shopify.card — no browser, no form-fill).` +
                (final.total_major != null ? ` Total ${final.total_major} ${final.currency ?? ""}.` : ""),
            receipt_id: orderId ? String(orderId) : undefined,
            amount: final.total_major ?? undefined,
        };
    }
    if (final.status === "requires_escalation") {
        return {
            success: false,
            status: "not_submitted",
            message:
                `Completion halted — merchant demands buyer action. ` +
                (final.continue_url ? `Continue at: ${final.continue_url}. ` : "") + final.messages.join(" "),
        };
    }
    return {
        success: false,
        status: "unconfirmed",
        message:
            `complete_checkout returned status "${final.status}" with no order id — token NOT burned. ` +
            `Poll get_checkout/get_order before retrying (idempotency-key ${idempotencyKey}). ${final.messages.join(" ")}`,
    };
}

// Exposed for offline unit tests only — not part of the public bridge API.
export const __ucpInternals = { isPrivateIp, expandIpv6, assertSafeUcpUrl, summarizeCheckout, pinnedRequest };
