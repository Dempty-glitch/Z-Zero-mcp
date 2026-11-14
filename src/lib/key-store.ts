// key-store.ts
// Shared, mutable in-memory store for the Passport Key.
// All API backends import getPassportKey() from here
// so a single set_api_key MCP tool updates the key for ALL backends at once.
//
// Rotate-on-connect, for EVERY way a key arrives (audit T14 F1, M.4):
// the key a person copies from the dashboard is a one-time ticket. Pasted into
// a chat (set_api_key) or written into the MCP config as Z_ZERO_API_KEY by the
// agent, it has been through an LLM conversation. So the first time this server
// uses it, it trades it for a fresh key (POST /api/keys/rotate) and keeps the
// fresh one in a local file, chmod 600. The copy in the chat or the config is
// dead from then on. Before 1.11 only set_api_key did this; a key that came in
// through the config file — the path most install tabs use — never rotated.
//
// The credentials file remembers WHICH config key it replaced (a SHA-256 of it,
// never the key). A different Z_ZERO_API_KEY in the config later means the user
// put a new key there on purpose: that one wins and is rotated in turn. Before,
// an old file silently beat any new key in the config (audit T14 F3).
//
// One file per API host (lib/api-base.ts): the z-zero.xyz key is never read
// when requests go to a custom server (audit T14 F2, M.5).
//
// Thread-safety: Node.js is single-threaded. Module-level `let` is safe.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { resolveApiBaseUrl, CANONICAL_API } from "./api-base.js";
import { CURRENT_MCP_VERSION } from "../version.js";

const CRED_DIR = join(homedir(), ".z-zero");

/** ~/.z-zero/credentials for z-zero.xyz; credentials-<host_port> for anything else. */
function credFile(): string {
    const base = resolveApiBaseUrl();
    if (base === CANONICAL_API) return join(CRED_DIR, "credentials");
    const u = new URL(base);
    return join(CRED_DIR, `credentials-${(u.host).replace(/[^a-zA-Z0-9.-]/g, "_")}`);
}

const looksLikeKey = (k: string) => k.startsWith("zk_live_") || k.startsWith("zk_test_");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// from_env_sha256: the config key in place when this file was written; null = there was
// none; absent = a file from before 1.11 (no record either way).
interface StoredCred { passport_key: string; from_env_sha256?: string | null }

function readCred(): StoredCred | null {
    try {
        const parsed = JSON.parse(readFileSync(credFile(), "utf8"));
        const key = typeof parsed?.passport_key === "string" ? parsed.passport_key.trim() : "";
        if (!looksLikeKey(key)) return null;
        const from = typeof parsed?.from_env_sha256 === "string" ? parsed.from_env_sha256
            : ("from_env_sha256" in (parsed ?? {}) ? null : undefined);
        return { passport_key: key, from_env_sha256: from };
    } catch {
        return null; // no file yet, or unreadable
    }
}

function envKey(): string {
    const k = (process.env.Z_ZERO_API_KEY || "").trim();
    return looksLikeKey(k) ? k : "";
}

/**
 * Persist the key with owner-only permissions, noting which config key (if any)
 * was in place when it was written. Returns true on success. Failure is
 * non-fatal (key still lives in memory).
 */
export function persistPassportKey(key: string): boolean {
    try {
        mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
        const env = envKey();
        const body: StoredCred = { passport_key: key, from_env_sha256: env ? sha256(env) : null };
        writeFileSync(credFile(), JSON.stringify(body) + "\n", { mode: 0o600 });
        chmodSync(credFile(), 0o600); // enforce even if file pre-existed with looser mode
        return true;
    } catch (err: any) {
        console.error(`[KEY-STORE] ⚠️ Could not persist key to ${credFile()}: ${err?.message || err}`);
        return false;
    }
}

type KeySource = "file" | "env" | "set_api_key" | "none";

let _passportKey = "";
let _source: KeySource = "none";
/** The active key came from the config and has not been traded for a fresh one yet. */
let _envRotationPending = false;
/** A dead file key may fall back to the config key once. */
let _envFallbackTried = false;

(function loadInitialKey() {
    const cred = readCred();
    const env = envKey();
    const envIsNew = !!env && env !== cred?.passport_key &&
        (!cred || (cred.from_env_sha256 !== undefined && cred.from_env_sha256 !== sha256(env)));
    if (envIsNew) {
        _passportKey = env;
        _source = "env";
        _envRotationPending = true;
    } else if (cred) {
        _passportKey = cred.passport_key;
        _source = "file";
    }
})();

/** Read the current active Passport Key. */
export function getPassportKey(): string {
    return _passportKey;
}

/** Where the active key came from, and whether it still has to be rotated. */
export function keyStatus(): { source: KeySource; rotation_pending: boolean } {
    return { source: _source, rotation_pending: _envRotationPending };
}

/**
 * Replace the active Passport Key in memory (no restart needed).
 * @param newKey - must start with "zk_live_" or "zk_test_"
 * @returns true if the key looks valid, false if rejected
 */
export function setPassportKey(newKey: string): { ok: boolean; message: string } {
    const trimmed = newKey.trim();
    if (!trimmed) {
        return { ok: false, message: "Key cannot be empty." };
    }
    if (!looksLikeKey(trimmed)) {
        return { ok: false, message: `Invalid key format — must start with "zk_live_" or "zk_test_".` };
    }
    _passportKey = trimmed;
    _source = "set_api_key";
    _envRotationPending = false;
    // ✅ FIX 11: Don't log partial key — even 10 chars helps brute-force
    console.error(`[KEY-STORE] ✅ Passport Key updated successfully.`);
    return { ok: true, message: "Passport Key updated successfully." };
}

/** Check if a key is currently configured. */
export function hasPassportKey(): boolean {
    return _passportKey.length > 0;
}

let _rotating: Promise<void> | null = null;

/**
 * Make sure a key that came in through the config has been traded for a fresh
 * one. Called at server start and before every authenticated request; does
 * nothing once done. A network failure leaves it pending and the next request
 * tries again (the config key keeps working meanwhile — it is only dead once
 * the server has swapped it).
 */
export async function ensureKeyReady(): Promise<void> {
    if (!_envRotationPending) return;
    if (!_rotating) _rotating = rotateConfigKey().finally(() => { _rotating = null; });
    await _rotating;
}

async function rotateConfigKey(): Promise<void> {
    const configKey = _passportKey;
    let resp: Response;
    try {
        resp = await fetch(`${resolveApiBaseUrl()}/api/keys/rotate`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${configKey}`, "x-mcp-version": CURRENT_MCP_VERSION },
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
        });
    } catch (err: any) {
        console.error(`[KEY-STORE] ⚠️ Could not rotate the config key yet (${err?.message || "network"}); will retry on the next call.`);
        return;
    }

    if (resp.ok) {
        const data: any = await resp.json().catch(() => null);
        const fresh = typeof data?.new_key === "string" ? data.new_key : "";
        if (!looksLikeKey(fresh)) return; // malformed answer: stay pending, retry later
        const persisted = persistPassportKey(fresh);
        _passportKey = fresh;
        _source = "file";
        _envRotationPending = false;
        console.error(
            `[KEY-STORE] ✅ The key from your MCP config was swapped for a fresh one ` +
            (persisted ? `(stored in ${credFile()}). ` : `(NOT stored — could not write ${credFile()}; after a restart, get a new key from the dashboard). `) +
            `The copy in the config and in any chat is now dead.`
        );
        return;
    }

    if (resp.status === 401 || resp.status === 409) {
        // The config key is already dead: another process on this machine rotated
        // it a moment ago (two MCP clients starting together), or it was revoked.
        // Take what is in the credentials file, if anything.
        _envRotationPending = false;
        let cred = readCred();
        if (!cred || cred.passport_key === configKey) {
            await new Promise((r) => setTimeout(r, 1500));
            cred = readCred();
        }
        if (cred && cred.passport_key !== configKey) {
            _passportKey = cred.passport_key;
            _source = "file";
            console.error("[KEY-STORE] The config key was already rotated — using the stored key.");
        } else {
            console.error("[KEY-STORE] ⚠️ The key in your MCP config was rejected (revoked, or already used on another machine). Get a fresh key from https://z-zero.xyz/dashboard/agents.");
        }
        return;
    }
    if (resp.status === 404) {
        // A self-hosted server without the rotate endpoint: keep the config key as before.
        _envRotationPending = false;
        console.error("[KEY-STORE] This server has no key-rotation endpoint; the key from your MCP config stays as it is.");
        return;
    }
    // 429 / 5xx: stay pending, retry on the next call.
    console.error(`[KEY-STORE] ⚠️ Key rotation answered ${resp.status}; will retry on the next call.`);
}

/**
 * The stored key was just rejected (401). If the config holds a different key
 * that has not been tried, switch to it (and rotate it). Returns true when the
 * caller should retry once. Handles credentials files written before 1.11,
 * which do not record which config key they replaced (audit T14 F3).
 */
export async function recoverFromRejectedKey(): Promise<boolean> {
    if (_source !== "file" || _envFallbackTried) return false;
    const env = envKey();
    if (!env || env === _passportKey) return false;
    _envFallbackTried = true;
    _passportKey = env;
    _source = "env";
    _envRotationPending = true;
    await ensureKeyReady();
    return true;
}
