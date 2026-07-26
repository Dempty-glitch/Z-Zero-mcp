// Z-ZERO WDK Backend — Non-Custodial Module
// Drop-in replacement for api_backend.ts when Z_ZERO_WALLET_MODE=wdk
// Exports IDENTICAL function signatures so index.ts can swap backends without any changes.
//
// Key differences from custodial api_backend.ts:
//   - getBalanceRemote() → reads stablecoin (USDC) balance on-chain on Base (not from Supabase wallets table)
//   - getDepositAddressesRemote() → returns the Base wallet address (not HD custodial address)
//   - issueTokenRemote() → sends USDC on Base first, THEN issues JIT card
//   - cancelTokenRemote() → triggers on-chain USDC refund back to user's Base wallet

import type { CardData, PaymentToken } from "./types.js";
import { getPassportKey, hasPassportKey } from "./lib/key-store.js";

const API_BASE_URL = process.env.Z_ZERO_API_BASE_URL || "https://www.clawcard.store";
const INTERNAL_SECRET = process.env.Z_ZERO_INTERNAL_SECRET || "";

// Injected at build time — always reflects the actual running version
import { CURRENT_MCP_VERSION } from "./version.js";

if (!hasPassportKey()) {
    console.error("❌ ERROR: Z_ZERO_API_KEY (Passport Key) is missing!");
    console.error("🔐 Get your key: https://www.clawcard.store/dashboard/agents");
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
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            return { error: err.error || "API_ERROR", message: err.message || err.error || res.statusText };
        }
        return await res.json();
    } catch (err: any) {
        return { error: "NETWORK_ERROR", message: err.message };
    }
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
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            return { error: err.error || "API_ERROR", message: err.message || err.error || res.statusText };
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
    // Calls /api/tokens/cards — but that route returns balance from Supabase.
    // For WDK mode, the Dashboard API must read wallet_mode and return on-chain balance.
    // This is handled server-side in the updated /api/tokens/cards route.
    return await apiRequest('/api/tokens/cards', 'GET');
}

// ──────────────────────────────────────────────────────────────────────────────
// Balance: On-chain USDC (stablecoin) on Base via Dashboard API
// ──────────────────────────────────────────────────────────────────────────────

export async function getBalanceRemote(cardAlias: string): Promise<any> {
    // Call Dashboard to get the agent's Base wallet balance (Dashboard resolves user from
    // passport key, finds the connected Base wallet, queries on-chain USDC balance)
    const data = await apiRequest('/api/wdk/balance', 'GET');
    if (data?.error) {
        return {
            error: true,
            message: 'Base wallet not connected. Create one at https://www.clawcard.store/dashboard/agent-wallet'
        };
    }

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
    const data = await apiRequest('/api/wdk/balance', 'GET');

    if (data?.error) {
        return {
            error: true,
            message: 'Base wallet not connected. Create one at https://www.clawcard.store/dashboard/agent-wallet'
        };
    }

    const balance = data.base_usdc_balance ?? data.balance_usdt;

    return {
        cards: [{ alias: 'base-wallet', balance, currency: 'USDC' }],
        deposit_addresses: {
            base: data.address,
            note: 'Send USDC (or any supported stablecoin) on Base to your wallet. Gasless spending via the Coinbase Paymaster.'
        },
        wdk_wallet: {
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
    merchant: string
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
        session_id: `wdk-${Math.random().toString(36).substring(7)}`,
        wallet_mode: 'wdk',  // Signals Dashboard to use on-chain payment path
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
        mode: 'wdk_noncustodial',
        mcp_warning: data._mcp_warning || null,  // Relay backend version warning to agent
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Resolve Token: Same as custodial (returns PAN/CVV for Playwright injection)
// ──────────────────────────────────────────────────────────────────────────────

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
        wallet_mode: 'wdk',  // Signals Dashboard to refund underspend on-chain
    });
    return !!data && !data.error;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cancel Token: Refund USDC back to user's Base wallet on-chain
// ──────────────────────────────────────────────────────────────────────────────

export async function cancelTokenRemote(token: string): Promise<any> {
    const data = await apiRequest('/api/tokens/cancel', 'POST', {
        token,
        wallet_mode: 'wdk',  // Triggers on-chain USDC refund
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
    console.error(`[WDK MCP] Token ${token} burned. Actual spent: $${actualSpent}. On-chain refund handled by Dashboard.`);
}
