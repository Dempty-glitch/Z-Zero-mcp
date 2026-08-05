// Z-ZERO Base Backend (formerly wdk_backend.ts — renamed in the 05/08/2026 WDK purge;
// the Tether-WDK/Tron era it was named for is gone, this has been Base + USDC throughout).
//
//   - getBalanceRemote() → on-chain USDC balance on Base via /api/wallet/balance
//   - getDepositAddressesRemote() → the agent's Base smart-account address
//   - issueTokenRemote() → sends USDC on Base first, THEN issues the JIT card
//   - cancelTokenRemote() → on-chain USDC refund back to the user's Base wallet

import type { CardData, PaymentToken } from "./types.js";
import { getPassportKey, hasPassportKey } from "./lib/key-store.js";
import { resolveApiBaseUrl } from "./lib/api-base.js";

const API_BASE_URL = resolveApiBaseUrl();
const INTERNAL_SECRET = process.env.Z_ZERO_INTERNAL_SECRET || "";

// Injected at build time — always reflects the actual running version
import { CURRENT_MCP_VERSION } from "./version.js";

if (!hasPassportKey()) {
    console.error("❌ ERROR: Z_ZERO_API_KEY (Passport Key) is missing!");
    console.error("🔐 Get your key: https://z-zero.xyz/dashboard/agents");
    console.error("🛠️  Or call the set_api_key MCP tool to set it without restarting.");
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP helpers (same as api_backend.ts to call Dashboard API)
// ──────────────────────────────────────────────────────────────────────────────

async function apiRequest(endpoint: string, method: string = 'GET', body: any = null) {
    const PASSPORT_KEY = getPassportKey();  // ✅ Hot-swap: read key dynamically each request
    if (!PASSPORT_KEY) {
        return { error: "AUTH_REQUIRED", message: "Z_ZERO_API_KEY is missing." };
    }
    const url = `${API_BASE_URL.replace(/\/$/, '')}${endpoint}`;
    try {
        const res = await fetch(url, {
            method,
            headers: {
                "Authorization": `Bearer ${PASSPORT_KEY}`,
                "Content-Type": "application/json",
                "X-MCP-Version": CURRENT_MCP_VERSION,
            },
            body: body ? JSON.stringify(body) : null,
            // Never let fetch follow a redirect while carrying the Passport Key:
            // it would either drop the header (silent 401) or hand the key to
            // whatever host the redirect names. Surface it instead.
            redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
            return redirectError(url, res);
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            return httpError(res, err);
        }
        return await res.json();
    } catch (err: any) {
        return { error: "NETWORK_ERROR", message: err.message };
    }
}

// Normalise a failed HTTP response into an error object callers can branch on.
// A 401 becomes AUTH_REQUIRED here — at the source — so no caller can mistake a
// rejected key for a missing resource. `status` rides along so callers can tell
// 404 (resource genuinely absent) from 500 (server broke).
// A redirect on an authenticated call is a configuration bug, not an auth bug.
// Say so, because the 401 it would otherwise become reads as "your key is dead".
function redirectError(url: string, res: Response) {
    const target = res.headers.get("location") || "another host";
    return {
        error: "BASE_URL_REDIRECT",
        status: res.status,
        message:
            `${url} redirected (${res.status}) to ${target}. The Passport Key was NOT forwarded — ` +
            `a redirected request loses its Authorization header, which shows up as a false 401. ` +
            `Set Z_ZERO_API_BASE_URL to https://z-zero.xyz in your MCP config.`,
    };
}

function httpError(res: Response, err: any) {
    if (res.status === 401) {
        return {
            error: "AUTH_REQUIRED",
            status: 401,
            message: err?.message || err?.error || "Passport Key is missing, invalid, or revoked.",
        };
    }
    return {
        error: err?.error || "API_ERROR",
        status: res.status,
        message: err?.message || err?.error || res.statusText,
    };
}

async function internalApiRequest(endpoint: string, method: string, body: any) {
    // Auth is the Bearer Passport Key — the server dropped the x-internal-secret
    // gate on /resolve and /burn (redundant to per-user token ownership, Jul 2026).
    // The old client-side CONFIG_ERROR check here broke execute_payment for every
    // install configured per the current docs (key only). Secret is now attached
    // only if present, as back-compat for self-hosted deployments that still gate on it.
    const url = `${API_BASE_URL.replace(/\/$/, '')}${endpoint}`;
    try {
        const res = await fetch(url, {
            method,
            headers: {
                ...(INTERNAL_SECRET ? { "x-internal-secret": INTERNAL_SECRET } : {}),
                "Authorization": `Bearer ${getPassportKey()}`,
                "Content-Type": "application/json",
                "X-MCP-Version": CURRENT_MCP_VERSION,
            },
            body: body ? JSON.stringify(body) : null,
            // Never let fetch follow a redirect while carrying the Passport Key:
            // it would either drop the header (silent 401) or hand the key to
            // whatever host the redirect names. Surface it instead.
            redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
            return redirectError(url, res);
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            return httpError(res, err);
        }
        return await res.json();
    } catch (err: any) {
        return { error: "NETWORK_ERROR", message: err.message };
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core API: Same as custodial (cards, tokens still managed by Dashboard)
// ──────────────────────────────────────────────────────────────────────────────

export async function listCardsRemote(): Promise<any> {
    // /api/tokens/cards returns card aliases + the on-chain Base USDC balance.
    return await apiRequest('/api/tokens/cards', 'GET');
}

// ──────────────────────────────────────────────────────────────────────────────
// Balance: On-chain USDC (stablecoin) on Base via Dashboard API
// ──────────────────────────────────────────────────────────────────────────────

// Turn a failed /api/wallet/balance call into an honest, actionable failure.
// Returns null when the call succeeded.
//
// Why this exists: this used to collapse EVERY error into "Base wallet not
// connected", so a user whose Passport Key had been revoked was sent to the
// wallet page to fix a problem that was about the key. Only a genuine 404 means
// "no wallet" — everything else must keep its own identity.
function walletLookupFailure(data: any) {
    if (!data?.error) return null;

    if (data.error === "AUTH_REQUIRED") {
        return { error: "AUTH_REQUIRED", message: data.message };
    }
    if (data.error === "NETWORK_ERROR") {
        return {
            error: "NETWORK_ERROR",
            message: `Could not reach ${API_BASE_URL}: ${data.message}`,
        };
    }
    if (data.status === 404) {
        return {
            error: "NO_WALLET",
            message: 'Base wallet not connected. Create one at https://z-zero.xyz/dashboard/agent-wallet',
        };
    }
    return {
        error: data.error,
        status: data.status,
        message: data.message || 'Could not read your Base wallet balance.',
    };
}

export async function getBalanceRemote(cardAlias: string): Promise<any> {
    // Call Dashboard to get the agent's Base wallet balance (Dashboard resolves user from
    // passport key, finds the connected Base wallet, queries on-chain USDC balance)
    const data = await apiRequest('/api/wallet/balance', 'GET');
    const failure = walletLookupFailure(data);
    if (failure) return failure;

    return {
        wallet_balance: data.base_usdc_balance ?? data.balance_usdt,
        currency: 'USDC',
        chain: data.chain || 'base',
        address: data.address,
        mode: 'base_onchain',
        note: `Base smart-account wallet. On-chain stablecoin (USDC) balance. Address: ${data.address}`
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Deposit Address: the agent's Base smart-account address (single chain)
// ──────────────────────────────────────────────────────────────────────────────

export async function getDepositAddressesRemote(): Promise<any> {
    const data = await apiRequest('/api/wallet/balance', 'GET');

    const failure = walletLookupFailure(data);
    if (failure) return failure;

    const balance = data.base_usdc_balance ?? data.balance_usdt;

    return {
        cards: [{ alias: 'base-wallet', balance, currency: 'USDC' }],
        deposit_addresses: {
            base: data.address,
            note: 'Send USDC (or any supported stablecoin) on Base to your wallet. Gasless spending via the Coinbase Paymaster.'
        },
        base_wallet: {
            address: data.address,
            chain: data.chain || 'base',
            balance_usdt: balance
        }
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Issue Token: On-chain USDC (Base) payment → JIT card
// ──────────────────────────────────────────────────────────────────────────────

export async function issueTokenRemote(
    cardAlias: string,
    amount: number,
    merchant: string,
    intent?: {
        cart?: Array<{ title: string; qty: number; unit_price?: number; url?: string }>;
        subtotal?: number;
        currency?: string;
        ship_to?: string;
    }
): Promise<any | null> {
    // Base AA Flow (reversed from custodial):
    // 1. Create Partner card first (reservation)
    // 2. Send USDC on Base from the agent's wallet → system wallet (gasless via Coinbase Paymaster)
    // 3. Dashboard verifies on-chain tx, activates token
    // This is safe: if on-chain tx fails, Dashboard auto-cancels the card reservation.

    const data = await apiRequest('/api/tokens/issue', 'POST', {
        card_alias: cardAlias,
        amount,
        merchant,
        device_fingerprint: `mcp-base-${process.platform}-${process.arch}`,
        network_id: process.env.NETWORK_ID || "base-usdc",
        session_id: `base-${Math.random().toString(36).substring(7)}`,
        // Primitive 1: the intent this card is derived from. Server signs it and
        // returns the signed object; older servers simply ignore this field.
        ...(intent ? { intent } : {}),
    });

    if (!data) return null;
    if (data.error) return data;

    return {
        token: data.token,
        card_alias: cardAlias,
        amount,
        merchant,
        created_at: Date.now(),
        ttl_seconds: 3600,
        used: false,
        tx_hash: data.tx_hash,
        mode: 'base_usdc',
        intent: data.intent || null,     // signed intent (intent_id, hash, signature) if server supports it
        mcp_warning: data._mcp_warning || null,  // Relay backend version warning to agent
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Receipt (Primitive 3): ask the Dashboard to build+sign a receipt for a
// CONFIRMED payment. Never blocks the payment result — caller treats null as
// "receipt unavailable" and the purchase is still fine.
// ──────────────────────────────────────────────────────────────────────────────

export async function postReceiptRemote(payload: {
    token: string;
    checkout_url: string;
    merchant_order_id?: string | null;
    amount_captured?: number;
    card_last4?: string;
    /** The purpose record — signed into the receipt alongside the outcome. */
    recheck?: { page_shows: string; decision: "go" | "pause"; why?: string };
}): Promise<any | null> {
    const data = await apiRequest('/api/receipts', 'POST', payload);
    if (!data || data.error) return null;
    return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolve Token: Same as custodial (returns PAN/CVV for Playwright injection)
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Purpose: the criteria this card was issued against, straight from the server.
// Deliberately NOT part of resolve — resolve pulls a real PAN from the issuer,
// and asking "what was this for?" must never cost a card fetch.
// ──────────────────────────────────────────────────────────────────────────────

export async function getTokenPurposeRemote(token: string): Promise<any> {
    return await apiRequest('/api/tokens/purpose', 'POST', { token });
}

export async function resolveTokenRemote(token: string): Promise<CardData | null> {
    const data = await internalApiRequest('/api/tokens/resolve', 'POST', { token });
    if (!data || data.error) return data;

    // ✅ FIX 7: Reject incomplete card data — don't silently fallback to fake values
    if (!data.number || !data.cvv || !data.exp) {
        return { error: "INCOMPLETE_CARD", message: "Card data missing required fields (number/cvv/exp). Token may be invalid or expired." } as CardData;
    }
    return {
        number: data.number,
        exp_month: data.exp.split('/')[0],
        exp_year: "20" + data.exp.split('/')[1],
        cvv: data.cvv,
        name: data.name || "Z-ZERO AI AGENT",
        authorized_amount: data.authorized_amount ? Number(data.authorized_amount) : undefined,
        intent_id: data.intent_id || undefined,      // Primitive 1 linkage (if server supports it)
        intent_hash: data.intent_hash || undefined,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Burn Token: Mark used + on-chain refund of underspend (if any)
// ──────────────────────────────────────────────────────────────────────────────

export async function burnTokenRemote(token: string, receipt_id?: string): Promise<boolean> {
    const data = await internalApiRequest('/api/tokens/burn', 'POST', {
        token,
        receipt_id,
        success: true,
    });
    return !!data && !data.error;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cancel Token: Refund USDC back to user's Base wallet on-chain
// ──────────────────────────────────────────────────────────────────────────────

export async function cancelTokenRemote(token: string): Promise<any> {
    const data = await apiRequest('/api/tokens/cancel', 'POST', {
        token,
    });
    if (data?.error) return data;
    return {
        success: !!data,
        refunded_amount: data?.refunded_amount || 0,
        tx_hash: data?.tx_hash || null,   // On-chain refund tx hash
        note: 'Stablecoin (USDC) refunded on-chain to your Base wallet.'
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Refund Underspend: Logged only (full refund logic handled in burnTokenRemote)
// ──────────────────────────────────────────────────────────────────────────────

export async function refundUnderspendRemote(token: string, actualSpent: number): Promise<void> {
    // console.error (NOT console.log) — stdout is the MCP stdio transport; logging there corrupts the protocol.
    console.error(`[Z-ZERO MCP] Token ${token} burned. Actual spent: $${actualSpent}. On-chain refund handled by Dashboard.`);
}
