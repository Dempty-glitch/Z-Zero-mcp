// key-store.ts
// Shared, mutable in-memory store for the Passport Key (Z_ZERO_API_KEY).
// All API backends (custodial + WDK) import getPassportKey() from here
// so a single set_api_key MCP tool updates the key for ALL backends at once.
//
// v1.5.0: keys are also persisted to ~/.z-zero/credentials (chmod 600).
// Load priority: credentials file > Z_ZERO_API_KEY env. The file exists
// because rotate-on-connect swaps the pasted key for a fresh one that must
// survive restarts WITHOUT ever entering the LLM conversation or the
// claude_desktop_config.json.
//
// Thread-safety: Node.js is single-threaded. Module-level `let` is safe.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CRED_DIR = join(homedir(), ".z-zero");
const CRED_FILE = join(CRED_DIR, "credentials");

/** Read the persisted key from ~/.z-zero/credentials (null if absent/invalid). */
function loadPersistedKey(): string | null {
    try {
        const raw = readFileSync(CRED_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const key = typeof parsed?.passport_key === "string" ? parsed.passport_key.trim() : "";
        if (key.startsWith("zk_live_") || key.startsWith("zk_test_")) return key;
        return null;
    } catch {
        return null; // no file yet, or unreadable — fall back to env
    }
}

/**
 * Persist the key to ~/.z-zero/credentials with owner-only permissions.
 * Returns true on success. Failure is non-fatal (key still lives in memory).
 */
export function persistPassportKey(key: string): boolean {
    try {
        mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(CRED_FILE, JSON.stringify({ passport_key: key }) + "\n", { mode: 0o600 });
        chmodSync(CRED_FILE, 0o600); // enforce even if file pre-existed with looser mode
        return true;
    } catch (err: any) {
        console.error(`[KEY-STORE] ⚠️ Could not persist key to ${CRED_FILE}: ${err?.message || err}`);
        return false;
    }
}

// Load priority: persisted (post-rotation) key wins over the bootstrap env key.
let _passportKey: string = loadPersistedKey() || process.env.Z_ZERO_API_KEY || "";

/** Read the current active Passport Key. */
export function getPassportKey(): string {
    return _passportKey;
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
    if (!trimmed.startsWith("zk_live_") && !trimmed.startsWith("zk_test_")) {
        return { ok: false, message: `Invalid key format — must start with "zk_live_" or "zk_test_". Got: "${trimmed.slice(0, 12)}..."` };
    }
    _passportKey = trimmed;
    // ✅ FIX 11: Don't log partial key — even 10 chars helps brute-force
    console.error(`[KEY-STORE] ✅ Passport Key updated successfully.`);
    return { ok: true, message: `Passport Key updated successfully. Active key prefix: ${trimmed.slice(0, 10)}...` };
}

/** Check if a key is currently configured. */
export function hasPassportKey(): boolean {
    return _passportKey.length > 0;
}
