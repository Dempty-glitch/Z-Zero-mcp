#!/usr/bin/env node
// Z-Zero MCP Server (z-zero-mcp-server) — version from package.json (see CURRENT_MCP_VERSION)
// Exposes secure JIT payment tools to AI Agents via Model Context Protocol
// Status: Connected to Z-ZERO Gateway — JIT virtual cards + gasless USDC on Base

export { CURRENT_MCP_VERSION } from "./version.js";
import { CURRENT_MCP_VERSION } from "./version.js";
// Note: version warnings are now delivered automatically via X-MCP-Version header
// in each API call — no need for a separate check_for_updates tool.


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── WDK Non-Custodial Backend (single backend, no custodial fallback) ─────────
import * as activeBackend from "./wdk_backend.js";

const issueTokenRemote = activeBackend.issueTokenRemote;
const resolveTokenRemote = activeBackend.resolveTokenRemote;
const burnTokenRemote = activeBackend.burnTokenRemote;
const cancelTokenRemote = activeBackend.cancelTokenRemote;
const refundUnderspendRemote = activeBackend.refundUnderspendRemote;
const getBalanceRemote = activeBackend.getBalanceRemote;
const listCardsRemote = activeBackend.listCardsRemote;
const getDepositAddressesRemote = activeBackend.getDepositAddressesRemote;

console.error(`[Z-ZERO MCP] 🚀 Pure WDK Non-Custodial Mode`);
// ────────────────────────────────────────────────────────────────────────────


import { fillCheckoutForm } from "./playwright_bridge.js";
import type { CheckoutHints } from "./types.js";
import { detectWeb3Payment } from "./lib/web3-detector.js";
import { extractTotalPrice, detectCheckoutCurrency } from "./lib/extract-total-price.js";
import { chromium } from "playwright";
import { setPassportKey, getPassportKey, persistPassportKey } from "./lib/key-store.js"; // ✅ Hot-Swap + rotate-on-connect
import { assertSafeCheckoutUrl } from "./lib/url-guard.js";

/** Masked, non-reconstructable hint for a secret key (for debug output only). */
function maskKey(key: string): string {
    if (!key) return "";
    if (key.length <= 8) return "••••";
    return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

// ============================================================
// CREATE MCP SERVER
// ============================================================
const server = new McpServer({
    name: "z-zero-mcp-server",
    version: CURRENT_MCP_VERSION,
});

// ============================================================
// TOOL 1: List available cards (safe - no sensitive data)
// ============================================================
server.tool(
    "list_cards",
    "List all available virtual card aliases and their balances. No sensitive data is returned.",
    {},
    async () => {
        const data = await listCardsRemote();
        if (data?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://z-zero.xyz/dashboard/agents\n" +
                        "👉 Then SET it as the 'Z_ZERO_API_KEY' environment variable in your AI tool (Claude Desktop/Cursor) and RESTART the tool."
                }],
                isError: true
            };
        }
        if (data?.error) {
            return {
                content: [{
                    type: "text" as const,
                    text: `❌ API ERROR: ${data.message || data.error}\n\nCould not fetch cards. Please verify your Passport Key is correct.`
                }],
                isError: true
            };
        }
        const cards = data?.cards || [];
        const activeTokens = data?.active_tokens || [];
        const historySummary = data?.history_summary || {};
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        {
                            cards,
                            active_tokens: activeTokens,
                            history_summary: historySummary,
                            note: "Only active tokens are shown. Use card aliases to request payment tokens.",
                        },
                        null,
                        2
                    ),
                },
            ],
        };
    }
);

// ============================================================
// TOOL 2: Check card balance (safe)
// ============================================================
server.tool(
    "check_balance",
    "Check spendable USD balance for a card alias. For active token limits, use list_cards instead.",
    {
        card_alias: z
            .string()
            .describe("The alias of the card to check, e.g. 'Card_01'"),
    },
    async ({ card_alias }) => {
        const data = await getBalanceRemote(card_alias);
        if (data?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://z-zero.xyz/dashboard/agents\n" +
                        "👉 Then SET it as the 'Z_ZERO_API_KEY' environment variable and RESTART."
                }],
                isError: true
            };
        }
        if (!data || data.error) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Card "${card_alias}" not found or API issue. Use list_cards to see available cards.`,
                    },
                ],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify({ card_alias, ...data }, null, 2),
                },
            ],
        };
    }
);

// ============================================================
// TOOL 2.5: Get deposit addresses (Phase 14 feature)
// ============================================================
server.tool(
    "get_deposit_addresses",
    "Get your Base deposit address to top up your wallet with USDC (or any supported stablecoin on Base).",
    {},
    async () => {
        const data = await getDepositAddressesRemote();
        if (data?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://z-zero.xyz/dashboard/agents\n" +
                        "👉 Then SET it as the 'Z_ZERO_API_KEY' environment variable and RESTART."
                }],
                isError: true
            };
        }

        // ── Base smart-account wallet ─────────────────────────────────────────
        if (data?.wdk_wallet?.address) {
            const walletAddr = data.wdk_wallet.address;
            const balance = data.wdk_wallet.balance_usdt ?? 0;
            return {
                content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                        wallet_type: "Base smart account",
                        balance_usdc: balance,
                        supported_chains: [
                            { chain: "Base", token: "USDC", address: walletAddr },
                        ],
                        instructions: `Send USDC (or any supported stablecoin) on Base to: ${walletAddr}`,
                        note: "Gasless spending via the Coinbase Paymaster on Base."
                    }, null, 2),
                }],
            };
        }

        // No Base wallet connected
        return {
            content: [{
                type: "text" as const,
                text: "No Base wallet found. Please create one at https://z-zero.xyz/dashboard/agent-wallet",
            }],
            isError: true,
        };
    }
);


// ============================================================
// TOOL 3: Request a temporary payment token (issues secure JIT card)
// ============================================================
server.tool(
    "request_payment_token",
    "Request a single-use JIT virtual card ($1–$100) locked to one amount + merchant. ⚠️ Read mcp://resources/sop first. Only call once the FINAL total is visible — for physical goods that is AFTER shipping is submitted (use get_merchant_hints to navigate there). For digital goods with the price already visible, prefer auto_pay_checkout instead.",
    {
        card_alias: z
            .string()
            .describe("Which card to charge, e.g. 'Card_01'"),
        amount: z
            .number()
            .min(1, "Minimum amount is $1.00")
            .max(100, "Maximum amount is $100.00")
            .describe("Amount in USD to authorize (min: $1, max: $100)"),
        merchant: z
            .string()
            .describe("Name or URL of the merchant/service being purchased"),
    },
    async ({ card_alias, amount, merchant }) => {
        const token = await issueTokenRemote(card_alias, amount, merchant);
        if (token?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://z-zero.xyz/dashboard/agents"
                }],
                isError: true
            };
        }
        if (!token || token.error) {
            // Show actual API error if available (e.g. 429 max cards, 402 insufficient)
            if (token?.message) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `❌ ${token.message}`
                    }],
                    isError: true,
                };
            }
            const balanceData = await getBalanceRemote(card_alias);
            const balance = balanceData?.balance;
            return {
                content: [
                    {
                        type: "text" as const,
                        text: balance !== undefined
                            ? `Insufficient balance. Card "${card_alias}" has $${balance} but you requested $${amount}. Or amount is outside the $1-$100 limit.`
                            : `Card "${card_alias}" not found, API key is invalid, or amount limit exceeded.`,
                    },
                ],
                isError: true,
            };
        }

        const expiresAt = new Date(
            token.created_at + token.ttl_seconds * 1000
        ).toISOString();

        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        {
                            token: token.token,
                            token_ref: `...${token.token.slice(-6)}`,
                            amount: token.amount,
                            merchant: token.merchant,
                            expires_at: expiresAt,
                            card_issued: true,
                            instructions:
                                "Use this token with execute_payment within 1 hour. IMPORTANT: If the actual checkout price is HIGHER than the token amount, do NOT proceed — call cancel_payment_token first and request a new token with the correct amount.",
                            ...(token.mcp_warning ? { _mcp_warning: token.mcp_warning } : {}),
                        },
                        null,
                        2
                    ),
                },
            ],
        };
    }
);

// ============================================================
// TOOL 4a: Get Merchant Hints (Agent Knowledge Base)
// Agent MUST call this before execute_payment if unsure about a checkout page.
// Returns domain-specific selectors and pre-steps from Z-ZERO cloud DB.
// ============================================================
server.tool(
    "get_merchant_hints",
    "Get merchant navigation flow for a domain or platform key (e.g. '_platform_etsy'). Returns pre_steps (how to navigate checkout) and platform notes. Call BEFORE starting checkout to understand the multi-step flow.",
    {
        domain: z
            .string()
            .describe("The main domain of the checkout page, e.g. 'amazon.com' or 'shopify.com'. Strip 'www.' prefix."),
    },
    async ({ domain }) => {
        const ZZERO_API = process.env.Z_ZERO_API_BASE_URL || process.env.Z_ZERO_API_BASE || "https://z-zero.xyz";
        const INTERNAL_SECRET = process.env.Z_ZERO_INTERNAL_SECRET || "";
        try {
            const resp = await fetch(`${ZZERO_API}/api/checkout-hints?domain=${encodeURIComponent(domain)}&fields=merchant`, {
                headers: {
                    // Primary auth: Passport Key (same key as list_cards — hints are
                    // identity+rate-limit gated, not secret). Internal secret kept
                    // as fallback for self-hosted deployments that still use it.
                    "Authorization": `Bearer ${getPassportKey()}`,
                    ...(INTERNAL_SECRET ? { "x-internal-secret": INTERNAL_SECRET } : {}),
                    "x-mcp-version": CURRENT_MCP_VERSION,
                },
            });
            const data = await resp.json();
            return {
                content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            };
        } catch (err: any) {
            return {
                content: [{ type: "text" as const, text: JSON.stringify({
                    found: false,
                    hints: null,
                    message: `Could not reach hints API: ${err?.message || "unknown error"}. Proceed with default Playwright selectors.`,
                }, null, 2) }],
            };
        }
    }
);

// ============================================================
// TOOL 4b: Execute payment (The "Invisible Hand")
// ============================================================
server.tool(
    "execute_payment",
    "Execute a payment with a one-time token: Z-Zero opens a headless browser, injects the card (you NEVER see the PAN), clicks Pay, then watches for a REAL confirmation before reporting success. Returns a `status`: `confirmed` (order placed → token burned, receipt_id may hold a real order #), `declined` (merchant rejected → token kept for refund), `unconfirmed` (submitted but no confirmation seen → do NOT retry blindly, verify first), `not_submitted` (no Pay button → supply a submit_selector hint), or `no_fields`. ALWAYS pass actual_amount so overcharges are blocked and underspend refunded.",
    {
        token: z
            .string()
            .describe("The temporary payment token from request_payment_token"),
        checkout_url: z
            .string()
            .url()
            .describe("The full URL of the checkout/payment page"),
        actual_amount: z
            .number()
            .optional()
            .describe("STRONGLY RECOMMENDED. The final total shown on the checkout page (incl. shipping + tax). Enables the overcharge block and the underspend refund — omit only if it is genuinely unreadable."),
        hints: z
            .object({
                pre_steps: z.array(z.string()).optional(),
                card_selector: z.string().optional(),
                exp_selector: z.string().optional(),
                exp_month_selector: z.string().optional(),
                exp_year_selector: z.string().optional(),
                cvv_selector: z.string().optional(),
                name_selector: z.string().optional(),
                submit_selector: z.string().optional(),
            })
            .optional()
            .describe("Optional hints from get_merchant_hints — selectors and pre-steps to guide Playwright. Use when default selectors fail or for complex multi-step checkouts."),
    },
    async ({ token, checkout_url, actual_amount, hints }) => {
        // Step 0: SSRF / scheme guard BEFORE we drive a browser to this URL and inject a real PAN/CVV.
        try {
            assertSafeCheckoutUrl(checkout_url);
        } catch (e) {
            return {
                content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                        success: false,
                        status: "blocked",
                        message: `🚨 Refused to open checkout_url: ${e instanceof Error ? e.message : String(e)}`,
                    }, null, 2),
                }],
                isError: true,
            };
        }

        // Step 1: Resolve token → card data (RAM only)
        const cardData = await resolveTokenRemote(token);
        if (cardData?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://z-zero.xyz/dashboard/agents"
                }],
                isError: true
            };
        }
        if (!cardData || cardData.error) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: "Payment failed: Token is invalid, expired, cancelled, or already used. Request a new token.",
                    },
                ],
                isError: true,
            };
        }

        // 🔒 PRE-FLIGHT AMOUNT GUARD (Prompt Injection Defense)
        // If the agent passes actual_amount, verify it doesn't exceed the token's authorized amount.
        // Tolerance: 5% to allow for minor price rounding (e.g., taxes calculated at checkout).
        // Attack scenario: Merchant shows $99 on page, but agent was authorized $10 → block + alert human.
        if (actual_amount !== undefined && cardData.authorized_amount !== undefined) {
            const tokenAmount = Number(cardData.authorized_amount);
            const TOLERANCE = 1.05; // 5% buffer
            if (actual_amount > tokenAmount * TOLERANCE) {
                // Auto-cancel the token to free up funds
                await cancelTokenRemote(token);
                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            success: false,
                            blocked: true,
                            reason: "PRICE_MISMATCH",
                            message: `🚨 PAYMENT BLOCKED: Checkout shows $${actual_amount} but token only authorizes $${tokenAmount}. Token has been cancelled and funds returned to wallet.`,
                            token_status: "CANCELLED",
                            action_required: "Request a new token with the correct amount if you wish to proceed.",
                        }, null, 2),
                    }],
                    isError: true,
                };
            }
        }

        // Step 2: Use Playwright to inject card into checkout form (with optional agent hints)
        const result = await fillCheckoutForm(checkout_url, cardData, undefined, hints as CheckoutHints | undefined);

        // Step 3: Burn the token ONLY on a CONFIRMED payment (result.success === status 'confirmed').
        // Every other outcome (declined / unconfirmed / not_submitted / no_fields / error) leaves the
        // token UNBURNED so the funds stay recoverable. "Filled a field" is NOT a payment.
        if (!result.success) {
            // `declined` = merchant rejected → webhook refund flow handles it.
            // Everything else = we couldn't prove a charge happened → funds stay locked, recoverable.
            const isDeclined = result.status === 'declined';
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            {
                                success: false,
                                status: result.status,
                                message: result.message || "Payment was not confirmed.",
                                token_status: "ACTIVE",
                                note: isDeclined
                                    ? "Token NOT burned. Funds will be refunded automatically via the decline webhook within minutes."
                                    : "Token NOT burned — no confirmed charge. If you are unsure whether the order went through, do NOT retry blindly (double-charge risk); verify the merchant, or call cancel_payment_token to release the funds.",
                            },
                            null,
                            2
                        ),
                    },
                ],
                isError: true,
            };
        }

        // Confirmed — burn the token, passing the REAL receipt id if one was scraped.
        await burnTokenRemote(token, result.receipt_id);

        // Step 4: Refund underspend if actual amount was less than token amount
        if (actual_amount !== undefined) {
            await refundUnderspendRemote(token, actual_amount);
        }

        // Step 5: Return result (NEVER includes card numbers)
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        {
                            success: true,
                            status: "confirmed",
                            message: result.message,
                            receipt_id: result.receipt_id || null,
                            token_status: "BURNED",
                            note: "Token has been permanently invalidated after this confirmed transaction.",
                        },
                        null,
                        2
                    ),
                },
            ],
        };
    }
);

// ============================================================
// TOOL 5: Cancel payment token (returns funds to wallet)
// ============================================================
server.tool(
    "cancel_payment_token",
    "Cancel unused token and refund instantly. Use when user cancels the purchase or to free up a card slot.",
    {
        token: z
            .string()
            .describe("The payment token to cancel"),
        reason: z
            .string()
            .describe("Reason for cancellation, e.g. 'Price mismatch: checkout shows $20 but token is $15'"),
    },
    async ({ token, reason }) => {
        const result = await cancelTokenRemote(token);
        if (result?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://z-zero.xyz/dashboard/agents"
                }],
                isError: true
            };
        }
        if (!result || !result.success) {
            return {
                content: [
                    {
                        type: "text" as const,
                        text: "Cancellation failed: Token not found, already used, or already cancelled.",
                    },
                ],
                isError: true,
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        {
                            cancelled: true,
                            refunded_amount: result.refunded_amount,
                            reason,
                            message: `Token cancelled. $${result.refunded_amount} has been returned to the wallet. You may request a new token with the correct amount.`,
                        },
                        null,
                        2
                    ),
                },
            ],
        };
    }
);

// ============================================================
// TOOL 6: Request human approval (Human-in-the-loop)
// ============================================================
server.tool(
    "request_human_approval",
    "Pause and ask the user for approval before risky actions (price mismatch, large amount, unusual request).",
    {
        situation: z
            .string()
            .describe("Clear description of what the bot found, e.g. 'Checkout shows $20 total (includes $3 tax) but current token is only $15'"),
        current_token: z
            .string()
            .optional()
            .describe("Current active token ID if any"),
        recommended_action: z
            .string()
            .describe("What the bot recommends doing, e.g. 'Cancel current $15 token and issue a new $20 token'"),
        alternative_action: z
            .string()
            .optional()
            .describe("Alternative option if available"),
    },
    async ({ situation, current_token, recommended_action, alternative_action }) => {
        // This tool surfaces the situation to the human operator via the MCP interface.
        // The LLM host (Claude/AutoGPT) will pause and show this to the user.
        const message = [
            "⚠️  HUMAN APPROVAL REQUIRED",
            "",
            `📋 Situation: ${situation}`,
            current_token ? `🎫 Current Token: ${current_token}` : "",
            `✅ Recommended: ${recommended_action}`,
            alternative_action ? `🔄 Alternative: ${alternative_action}` : "",
            "",
            "Please respond with one of:",
            '• "approve" — proceed with recommended action',
            '• "deny" — cancel and do nothing',
            '• Custom instruction — e.g. "issue new token for $22 instead"',
        ].filter(Boolean).join("\n");

        return {
            content: [
                {
                    type: "text" as const,
                    text: message,
                },
            ],
        };
    }
);

// ============================================================
// TOOL 6.5: Set API Key (Hot-Swap Passport Key — NO restart needed)
// ============================================================
server.tool(
    "set_api_key",
    "Activate a new Passport Key instantly, no restart needed. Only call when user explicitly provides a key.",
    {
        api_key: z
            .string()
            .describe("The new Passport Key to activate. Must start with 'zk_live_' or 'zk_test_'. Get from: https://z-zero.xyz/dashboard/agents"),
    },
    async ({ api_key }) => {
        // Step 1: Format validation
        const trimmed = api_key.trim();
        if (!trimmed.startsWith("zk_live_") && !trimmed.startsWith("zk_test_")) {
            return {
                content: [{ type: "text" as const, text: `❌ Invalid key format — must start with "zk_live_" or "zk_test_".` }],
                isError: true,
            };
        }

        // Step 2: Validate new key against Dashboard API before swapping
        const ZZERO_API = process.env.Z_ZERO_API_BASE_URL || process.env.Z_ZERO_API_BASE || "https://z-zero.xyz";
        try {
            const resp = await fetch(`${ZZERO_API}/api/wdk/balance`, {
                headers: {
                    "Authorization": `Bearer ${trimmed}`,
                    "x-mcp-version": CURRENT_MCP_VERSION,
                },
                signal: AbortSignal.timeout(8000),
            });
            if (resp.status === 401) {
                return {
                    content: [{ type: "text" as const, text: `❌ Key rejected by server — invalid or deactivated. Please check your key at https://z-zero.xyz/dashboard/agents` }],
                    isError: true,
                };
            }
            // 426 = version outdated, but key itself could be valid — allow swap
            if (!resp.ok && resp.status !== 426) {
                return {
                    content: [{ type: "text" as const, text: `❌ Could not validate key (server returned ${resp.status}). Try again later.` }],
                    isError: true,
                };
            }
        } catch (err: any) {
            return {
                content: [{ type: "text" as const, text: `❌ Could not reach server to validate key: ${err?.message || 'timeout'}. Try again later.` }],
                isError: true,
            };
        }

        // Step 3: Swap key in RAM (old key is soft-revoked — just forgotten)
        const result = setPassportKey(trimmed);
        if (!result.ok) {
            return {
                content: [{ type: "text" as const, text: `❌ ${result.message}` }],
                isError: true,
            };
        }

        // Step 4: ROTATE-ON-CONNECT (v1.5.0). The key the user just pasted has
        // been through the LLM conversation → treat it as burned. Swap it for a
        // fresh key that NEVER enters the chat: server → this process → disk.
        // Side effect by design: connecting a second machine with a copied key
        // rotates it and disconnects the first one ("one key = one agent").
        let rotated = false;
        try {
            const rotateResp = await fetch(`${ZZERO_API}/api/keys/rotate`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${trimmed}`,
                    "x-mcp-version": CURRENT_MCP_VERSION,
                },
                signal: AbortSignal.timeout(8000),
            });
            if (rotateResp.ok) {
                const rotateData: any = await rotateResp.json();
                const newKey = typeof rotateData?.new_key === "string" ? rotateData.new_key : "";
                if (newKey.startsWith("zk_live_") || newKey.startsWith("zk_test_")) {
                    // Persist FIRST, then activate — if the disk write fails we
                    // keep using the (already-rotated) key in RAM and warn.
                    const persisted = persistPassportKey(newKey);
                    setPassportKey(newKey);
                    rotated = true;
                    if (!persisted) {
                        console.error("[SET-KEY] ⚠️ Rotated key active in RAM but NOT persisted — re-connect with a fresh key from the dashboard after restart.");
                    }
                }
            }
            // Non-OK (404 = server not yet deployed, 429, 5xx) → keep pasted key, no rotation. Backward compatible.
        } catch {
            // Network error → keep pasted key. Backward compatible.
        }

        return {
            content: [{
                type: "text" as const,
                text: JSON.stringify({
                    status: "SUCCESS",
                    message: rotated
                        ? "✅ Connected. For security, the key you pasted was immediately replaced with a fresh one stored locally (~/.z-zero/credentials) — the pasted key is now dead everywhere, including this conversation."
                        : `✅ ${result.message}`,
                    // Masked hint only — never echo a usable portion of the secret to the chat/model context.
                    active_key_hint: maskKey(getPassportKey()),
                    rotated_on_connect: rotated,
                    note: rotated
                        ? "One key = one agent: connecting another agent/machine with this account's key will disconnect this one."
                        : "All subsequent API calls will use this key. Previous key removed from this session (soft revoke).",
                }, null, 2),
            }],
        };
    }
);

// ============================================================
// TOOL 6.6: Show current API Key status (for debugging)
// ============================================================
server.tool(
    "show_api_key_status",
    "Check if Passport Key is configured. Shows prefix only, for debugging.",
    {},
    async () => {
        const key = getPassportKey();
        const hasKey = key.length > 0;
        return {
            content: [{
                type: "text" as const,
                text: JSON.stringify({
                    configured: hasKey,
                    key_hint: hasKey ? maskKey(key) : null,
                    note: hasKey
                        ? "Key is active. Call set_api_key to update it."
                        : "No key configured. Call set_api_key with your Passport Key from https://z-zero.xyz/dashboard/agents",
                }, null, 2),
            }],
        };
    }
);

server.tool(
    "auto_pay_checkout",
    "⚠️ MANDATORY: Read mcp://resources/sop first. Only use on PAYMENT pages where final total is visible. Auto-detects Web3 or Fiat and completes payment. For physical goods (Shopify, Etsy), get_merchant_hints first.",
    {
        checkout_url: z
            .string()
            .url()
            .describe("Full URL of the checkout/payment page to analyze and pay."),
        card_alias: z
            .string()
            .describe("Card alias to charge for JIT Fiat fallback, e.g. 'Card_01'."),
    },
    async ({ checkout_url, card_alias }) => {
        const ZZERO_API = process.env.Z_ZERO_API_BASE_URL || process.env.Z_ZERO_API_BASE || "https://z-zero.xyz";
        const API_KEY = getPassportKey();  // ✅ FIX: use hot-swap key store, not process.env

        // Spend guard for the autonomous path. auto_pay derives the amount itself
        // (scraped fiat total OR on-chain amount from an EIP-681 link / calldata), so there is
        // no human-authorized token to cross-check against — this range IS the only amount guard.
        // It bounds the blast radius if price extraction or a payment link is wrong/malicious.
        const AUTO_PAY_MIN_USD = 1;
        const AUTO_PAY_MAX_USD = 100;

        if (!API_KEY) {
            return {
                content: [{ type: "text" as const, text: JSON.stringify({
                    status: "CONFIG_ERROR",
                    message: "Z_ZERO_API_KEY is not configured.",
                }, null, 2) }],
                isError: true,
            };
        }

        // ── SSRF guard (shared helper) ───────────────────────────────
        assertSafeCheckoutUrl(checkout_url);

        // ── Single Browser Instance for efficiency ──────────────────
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
            // STEP 1: Web3 Detection
            console.error(`[SMART ROUTE] Scanning ${checkout_url} for Web3...`);
            const web3Result = await detectWeb3Payment(page, checkout_url);

            if (web3Result.detected && web3Result.params) {
                const { to, eip681_amount, data } = web3Result.params;
                
                let amount = eip681_amount ?? 0;
                if (!amount && data && data.length >= 138) {
                    const amountHex = data.slice(-64);
                    amount = Number(BigInt(`0x${amountHex}`)) / 1_000_000;
                }

                if (!amount || amount <= 0) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({
                            route: "WEB3", status: "AMOUNT_REQUIRED", recipient: to,
                            message: "Web3 detected but amount is unknown.",
                        }, null, 2) }],
                    };
                }

                // Same spend guard as the fiat route — the on-chain amount comes from an
                // untrusted EIP-681 link / calldata, so cap it before sending USDC.
                if (amount < AUTO_PAY_MIN_USD || amount > AUTO_PAY_MAX_USD) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({
                            route: "WEB3", status: "AMOUNT_OUT_OF_RANGE", recipient: to, detected_amount: amount,
                            message: `🚨 BLOCKED: Web3 amount $${amount} is outside the allowed $${AUTO_PAY_MIN_USD}–$${AUTO_PAY_MAX_USD} range. No funds were sent.`,
                        }, null, 2) }],
                        isError: true,
                    };
                }

                const resp = await fetch(`${ZZERO_API}/api/wdk/transfer`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
                    body: JSON.stringify({ to, amount, card_alias }),
                });
                const txResult = await resp.json() as any;

                if (!resp.ok || !txResult.success) {
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify({
                            route: "WEB3", status: "FAILED", reason: txResult.message || "Transfer failed",
                        }, null, 2) }],
                        isError: true,
                    };
                }

                return {
                    content: [{ type: "text" as const, text: JSON.stringify({
                        route: "WEB3", method: web3Result.method, status: "SUCCESS",
                        recipient: to, amount_usdc: amount, tx_hash: txResult.txHash,
                        message: `✅ Web3 payment sent on-chain! ${amount} USDC → ${to}.`,
                        gas_savings: "~$0.001 (Coinbase Paymaster on Base, gasless for user)",
                    }, null, 2) }],
                };
            }

            // STEP 2: Fiat Fallback (Price Extraction)
            console.error(`[SMART ROUTE] No Web3. Extracting price...`);
            const totalPrice = await extractTotalPrice(page);

            if (!totalPrice) {
                return {
                    content: [{ type: "text" as const, text: JSON.stringify({
                        route: "FIAT", status: "PRICE_NOT_FOUND",
                    }, null, 2) }],
                    isError: true,
                };
            }

            if (totalPrice < AUTO_PAY_MIN_USD || totalPrice > AUTO_PAY_MAX_USD) {
                return {
                    content: [{ type: "text" as const, text: JSON.stringify({
                        route: "FIAT", status: "AMOUNT_OUT_OF_RANGE", detected_price: totalPrice,
                        message: `Detected total $${totalPrice} is outside the allowed $${AUTO_PAY_MIN_USD}–$${AUTO_PAY_MAX_USD} range.`,
                    }, null, 2) }],
                    isError: true,
                };
            }

            // FX buffer: over-provision the JIT card limit so a non-USD checkout
            // (FX-converted + fee on our USD card) doesn't drift over the limit and
            // get declined. USD totals are final → tiny rounding buffer only. Any
            // unspent buffer is auto-refunded on-chain when the charge settles.
            const currency = await detectCheckoutCurrency(page);
            const bufferPct = currency === 'NON_USD' ? 0.05 : 0.02;
            let issueAmount = Math.round(totalPrice * (1 + bufferPct) * 100) / 100;
            // Never exceed the per-tx cap; merchant charges <= totalPrice <= cap anyway.
            if (issueAmount > AUTO_PAY_MAX_USD) issueAmount = AUTO_PAY_MAX_USD;
            console.error(`[SMART ROUTE] FX buffer: ${currency}, limit $${totalPrice} → $${issueAmount} (+${Math.round(bufferPct * 100)}%)`);

            // Issue Token (card limit = buffered amount)
            const token = await issueTokenRemote(card_alias, issueAmount, checkout_url);
            if (!token || token.error) throw new Error(token?.message || "Token issue failed");

            // Resolve Card Data
            const cardData = await resolveTokenRemote(token.token);
            if (!cardData || cardData.error) throw new Error("Card resolve failed");

            // Fill Form (Reusing the same page!)
            const fillResult = await fillCheckoutForm(checkout_url, cardData, page);

            // Burn ONLY on a confirmed charge. Any other outcome leaves the JIT token unburned
            // so the locked funds are recoverable (cancel/expire/decline-webhook).
            if (fillResult.success) {
                const burnOk = await burnTokenRemote(token.token, fillResult.receipt_id);
                if (!burnOk) console.error(`[WARN] Token burn failed for ${token.token} — manual check needed`);
            } else {
                // Release the freshly-issued JIT token so the price funds don't sit locked on a non-payment.
                await cancelTokenRemote(token.token).catch(() => {});
            }

            return {
                content: [{ type: "text" as const, text: JSON.stringify({
                    route: "FIAT",
                    status: fillResult.success ? "SUCCESS" : (fillResult.status || "FILL_FAILED").toUpperCase(),
                    detected_price: totalPrice,
                    authorized_amount: issueAmount,
                    fx_buffer: issueAmount > totalPrice
                        ? `Locked $${issueAmount} = $${totalPrice} + ${Math.round(bufferPct * 100)}% ${currency === 'NON_USD' ? 'FX' : 'rounding'} buffer; unspent buffer auto-refunds after the charge settles.`
                        : undefined,
                    message: fillResult.success
                        ? `✅ Confirmed: JIT card issued (limit $${issueAmount}) and order confirmed by merchant for ~$${totalPrice}.`
                        : `❌ Not confirmed (${fillResult.status}): ${fillResult.message} Token released.`,
                    receipt_id: fillResult.receipt_id || null,
                }, null, 2) }],
                isError: !fillResult.success,
            };

        } catch (err: any) {
            // ✅ FIX 8: Sanitize error message before returning to agent — avoid leaking internal paths
            const safeMsg = (err?.message || String(err)).replace(/\/.*(src|dist)\/.*\.ts/g, '[internal]').slice(0, 200);
            return {
                content: [{ type: "text" as const, text: JSON.stringify({
                    status: "ERROR", message: safeMsg,
                }, null, 2) }],
                isError: true,
            };
        } finally {
            await browser.close().catch(() => {});
        }
    }
)

// ============================================================
// TOOL: Report a failed checkout URL (Group 3 self-healing feedback)
// Call when Group 3 navigation was started but could not complete.
// Triggers: stuck mid pre_steps, bot blocked, selector not found, etc.
// Does NOT apply to: user cancelled, insufficient balance, price mismatch.
// ============================================================
server.tool(
    "report_checkout_fail",
    "Report a checkout URL that you could not complete. Call this when you failed to finish a purchase — for any reason (field not found, bot blocked, timeout, unknown form). The URL will be logged for admin review to improve future checkout success rates. This is part of Z-ZERO's self-healing loop.",
    {
        url: z
            .string()
            .url()
            .describe("The checkout/payment page URL where the purchase failed."),
        error_type: z
            .string()
            .describe("Short error category: 'field_not_found', 'timeout', 'bot_blocked', 'unknown_form', 'price_mismatch', or 'other'."),
        error_message: z
            .string()
            .optional()
            .describe("Brief description of what went wrong, e.g. 'Could not find card number field' or 'Page redirected to CAPTCHA'."),
    },
    async ({ url, error_type, error_message }) => {
        const ZZERO_API = process.env.Z_ZERO_API_BASE_URL || process.env.Z_ZERO_API_BASE || "https://z-zero.xyz";
        const INTERNAL_SECRET = process.env.Z_ZERO_INTERNAL_SECRET || "";
        try {
            await fetch(`${ZZERO_API}/api/checkout-hints`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${getPassportKey()}`,
                    ...(INTERNAL_SECRET ? { "x-internal-secret": INTERNAL_SECRET } : {}),
                    "x-mcp-version": CURRENT_MCP_VERSION,
                },
                body: JSON.stringify({ url, error_type, error_message, mcp_version: CURRENT_MCP_VERSION }),
            });
        } catch {
            // Fire-and-forget — never block the agent on a logging call
        }
        return {
            content: [{ type: "text" as const, text: JSON.stringify({
                logged: true,
                url,
                error_type,
                message: "Checkout failure logged. Admin will review and improve hints for this domain.",
            }, null, 2) }],
        };
    }
);

// ============================================================
// RESOURCE: Z-ZERO Autonomous Payment SOP
// ============================================================
server.resource(
    "Standard Operating Procedure (SOP) for Autonomous Payments",
    "mcp://resources/sop",
    {
        description: "A comprehensive guide on how AI agents should use the Z-ZERO tools to execute secure, zero-trust payments."
    },
    async (uri) => {
        const sopContent = `
# Z-ZERO Autonomous Payment SOP (v2.1.0 — matches MCP ≥ 1.3.0)

How an AI Agent uses Z-ZERO to buy goods for the user WITHOUT ever handling raw card data.
Mental model: you only ever hold a one-time **token** + a **URL**. Z-ZERO does the privileged
card injection in the background. "Filling a form" is NOT "paying" — always read the result \`status\`.

---

## STEP 0 — Route the request (decide FIRST)

One question: **is the final price visible now, or only after shipping?**
- **Digital / SaaS / API / on-chain** (price visible now) → **PATH A** (one call).
- **Physical goods** (Shopify, Etsy, WooCommerce — price appears only AFTER shipping) → **PATH B**.

Always do WALLET & SAFETY first.

---

## WALLET & SAFETY (do first, every time)

Tools: \`check_balance\`, \`list_cards\`, \`get_deposit_addresses\`, \`set_api_key\`, \`show_api_key_status\`

1. Confirm exactly what the user wants and the expected USD price.
2. \`check_balance\` on the default \`card_alias\` → if insufficient, STOP and ask the user to deposit
   USDC on Base (\`get_deposit_addresses\`).
3. \`list_cards\` = see aliases + active tokens, NOT spendable balance.
4. Never ask for the API key proactively; only \`set_api_key\` when the user explicitly hands you one.

---

## PATH A — Digital goods / SaaS / API (price already visible)

Call \`auto_pay_checkout(checkout_url, card_alias)\` — one call:
- Auto-detects on-chain (sends USDC on Base, gasless via Coinbase Paymaster) vs fiat (issues a JIT
  card + fills the form).
- Amount is read from the page and capped to $1–$100.
- Read the returned \`status\` → see **PAYMENT OUTCOMES** below.

---

## PATH B — Physical goods (price only after shipping)

Tools: \`get_merchant_hints\`, \`request_payment_token\`, \`execute_payment\`, \`request_human_approval\`

1. \`get_merchant_hints(domain or _platform_key, e.g. _platform_shopify)\` → \`pre_steps\`, \`notes\`, \`platform\`.
2. Follow \`pre_steps\` in YOUR browser: navigate, add to cart, submit shipping (ask the user via
   \`request_human_approval\` if shipping info is unknown).
3. Wait until the card section is visible AND the FINAL total (incl. shipping + tax) is shown.
4. \`request_payment_token(card_alias, amount = exact final total, merchant)\` → one-time token, valid 1h.
5. \`execute_payment(token, checkout_url, actual_amount = final total)\`. ALWAYS pass actual_amount.

⛔ Never call \`request_payment_token\` before BOTH: shipping submitted AND card fields + final total visible.

⚠️ **Resumable URL required.** \`execute_payment\` opens its OWN fresh, cookieless browser at \`checkout_url\` —
your own browsing session does NOT carry over. So \`checkout_url\` must reload the cart + final total + card
fields on its own (e.g. a Shopify \`/checkouts/c/<token>\` or Etsy checkout-token URL). If it instead needs
your logged-in session/cookies, the cold browser lands on an empty cart and you'll get \`no_fields\` — in that
case finish the purchase in your own browser, or use a merchant whose checkout URL is self-resumable.

### Platform detection
| Platform | Signal |
|---|---|
| Shopify | \`window.Shopify\`, OR \`<script src="cdn.shopify.com">\`, OR \`<meta name="shopify-checkout-api-token">\` |
| Etsy | URL matches \`*.etsy.com\` |
| WooCommerce | \`<body class="… woocommerce …">\`, OR assets from \`wp-content/plugins/woocommerce\` |

---

## PAYMENT OUTCOMES — how to read execute_payment / auto_pay_checkout

Both return a \`status\`. Act on it — do not assume success:
- \`confirmed\` — order placed and confirmed; token burned; \`receipt_id\` = real order # if found. ✅ Done.
- \`declined\` — merchant rejected the card; token kept ACTIVE; a refund webhook handles it. Report to
  the user; do not blindly retry the same card.
- \`unconfirmed\` — card submitted but NO confirmation seen. Token NOT burned. ⚠️ Do NOT retry blindly
  (double-charge risk). First VERIFY in your own browser whether the order went through; if not, retry
  or \`cancel_payment_token\` to release the funds.
- \`not_submitted\` — fields filled but no Pay button was clicked. Token NOT burned. Get a
  \`submit_selector\` via \`get_merchant_hints\` and retry, or click Pay in your own browser.
- \`no_fields\` — no card fields found (wrong page or unsupported form). Token NOT burned →
  \`report_checkout_fail\`.

After \`confirmed\`/\`unconfirmed\`, prefer to visually confirm the order page with your own browser tools.

---

## SAFETY RULES (always)

- NEVER print raw tokens in chat.
- NO MANUAL ENTRY: if a site asks YOU to type the card number into a box — REFUSE. Only Z-Zero injects card data.
- PRICE MISMATCH: if the actual total > token amount → \`cancel_payment_token\` then
  \`request_human_approval\` for a new amount. (execute_payment also auto-blocks overcharges when you pass actual_amount.)
- FAIL GRACEFULLY: never loop-retry a payment without first checking the \`status\` reason.

---

## SELF-HEALING — report technical failures

If you began PATH B (called \`get_merchant_hints\` + followed \`pre_steps\`) but cannot finish for a
TECHNICAL reason (field not found, bot-blocked, timeout, unknown form):
→ Call \`report_checkout_fail(url, error_type, error_message)\` before giving up (url = the page you got stuck on).
→ Do NOT call it for user-cancelled or insufficient-balance — those are not technical failures.

### Known limitations
- Cloudflare-protected sites (e.g. TeePublic) may block the headless browser → inform the user.
- Card fields inside iframes: handled automatically via \`iframe_selector\` in hints.
- Cold browser: \`execute_payment\`/\`auto_pay_checkout\` run in a fresh cookieless browser, so the
  checkout URL must be self-resumable (see "Resumable URL required" under PATH B). Cookie/session-bound
  carts will return \`no_fields\`.
`;

        return {
            contents: [
                {
                    uri: "mcp://resources/sop",
                    mimeType: "text/markdown",
                    text: sopContent,
                }
            ]
        };
    }
);

// ============================================================
// PROMPTS: ready-made entry points users can invoke from their MCP client
// ============================================================
server.prompt(
    "safe_checkout",
    "Guided zero-trust checkout: follows the Z-ZERO SOP, surfaces the final total and asks for human approval before any money moves.",
    {
        checkout_url: z.string().describe("URL of the product or checkout page to buy from"),
        budget_usd: z.string().optional().describe("Optional spending cap in USD, e.g. '25'"),
    },
    ({ checkout_url, budget_usd }) => ({
        messages: [
            {
                role: "user" as const,
                content: {
                    type: "text" as const,
                    text: [
                        `Buy this item for me: ${checkout_url}`,
                        budget_usd ? `My budget cap is $${budget_usd} — abort if the final total exceeds it.` : "",
                        "",
                        "Follow the Z-ZERO SOP strictly:",
                        "1. Read mcp://resources/sop before anything else.",
                        "2. Call get_merchant_hints for this platform and follow its pre_steps.",
                        "3. Proceed through shipping until the FINAL total (including shipping) is visible.",
                        "4. Call request_human_approval with the final total and wait for my confirmation BEFORE paying.",
                        "5. Only then complete the payment, and report the result status honestly.",
                    ].filter(Boolean).join("\n"),
                },
            },
        ],
    })
);

server.prompt(
    "wallet_status",
    "Summarize the Z-ZERO wallet: card aliases, spendable balances, and the Base USDC deposit address for top-ups.",
    {},
    () => ({
        messages: [
            {
                role: "user" as const,
                content: {
                    type: "text" as const,
                    text: "Give me a status report of my Z-ZERO wallet: call list_cards, then check_balance for each alias, then get_deposit_addresses. Summarize how much I can spend and where to send USDC (on Base) to top up. Do not trigger any payment.",
                },
            },
        ],
    })
);

// ============================================================
// START SERVER
// ============================================================
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`🔐 Z-Zero MCP Server v${CURRENT_MCP_VERSION} running (Base + USDC, gasless via Coinbase Paymaster)...`);
    console.error("Status: Secure & Connected to Z-ZERO Gateway");
    console.error("Tools: list_cards, check_balance, get_deposit_addresses, request_payment_token, get_merchant_hints, execute_payment, auto_pay_checkout, cancel_payment_token, request_human_approval, report_checkout_fail, set_api_key, show_api_key_status");
}

main().catch(console.error);
