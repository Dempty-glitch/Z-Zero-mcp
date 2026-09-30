/**
 * lib/browser.ts
 * Launches the headless Chromium the "Invisible Hand" fills checkouts with.
 *
 * `playwright` ships no install script (and we keep none — Socket score), so a
 * fresh `npx` install has NO browser: the first purchase used to die with
 * "Executable doesn't exist". Launch order now:
 *   1. Playwright's headless shell, if already downloaded
 *   2. the user's installed Google Chrome (no download needed)
 *   3. one-time download of the headless shell into Playwright's cache, then retry
 * `warmUpBrowser()` starts that download in the background at server start, so
 * it is normally finished long before the first checkout.
 */

import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const INSTALL_TIMEOUT_MS = 5 * 60_000; // ~100MB download on a slow line

let installing: Promise<void> | null = null;

function isMissingBrowser(err: unknown): boolean {
    return err instanceof Error && /Executable doesn't exist|browserType\.launch: .*not found/i.test(err.message);
}

/** Runs `playwright install --only-shell chromium`. Idempotent (~0.3s when already installed). */
export function ensureBrowserInstalled(): Promise<void> {
    if (installing) return installing;
    installing = new Promise<void>((resolve, reject) => {
        const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
        // stdout must stay clean — it carries the MCP JSON-RPC stream.
        const child = spawn(process.execPath, [cli, "install", "--only-shell", "chromium"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let tail = "";
        const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`Browser download failed (exit ${code}): ${tail.trim().split("\n").slice(-3).join(" | ")}`));
        });
    }).catch((err) => {
        installing = null; // let the next call retry
        throw err;
    });
    return installing;
}

/** Background pre-download at server start. Never throws. */
export function warmUpBrowser(): void {
    ensureBrowserInstalled()
        .then(() => console.error("[BROWSER] Checkout browser ready"))
        .catch((err) => console.error(`[BROWSER] ⚠️ Pre-download failed, will retry at checkout: ${err.message}`));
}

export async function launchBrowser(): Promise<Browser> {
    try {
        return await chromium.launch({ headless: true });
    } catch (err) {
        if (!isMissingBrowser(err)) throw err;
    }
    try {
        return await chromium.launch({ headless: true, channel: "chrome" });
    } catch {
        // no system Chrome either — fall through to the download
    }
    console.error("[BROWSER] No browser found — downloading headless Chromium (one-time, ~100MB)...");
    await ensureBrowserInstalled();
    return chromium.launch({ headless: true });
}
