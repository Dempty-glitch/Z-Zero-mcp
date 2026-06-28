#!/usr/bin/env node
// OpenClaw MCP Server (z-zero-mcp-server) v1.1.0
// Exposes secure JIT payment tools to AI Agents via Model Context Protocol
// Status: Connected to Z-ZERO Gateway — produces secure JIT virtual cards

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
import { extractTotalPrice } from "./lib/extract-total-price.js";
import { chromium } from "playwright";
import { setPassportKey, getPassportKey } from "./lib/key-store.js"; // ✅ Hot-Swap support

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
                        "👉 Please GET your key here: https://www.clawcard.store/dashboard/agents\n" +
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
                        "👉 Please GET your key here: https://www.clawcard.store/dashboard/agents\n" +
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
                        "👉 Please GET your key here: https://www.clawcard.store/dashboard/agents\n" +
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
                text: "No Base wallet found. Please create one at https://www.clawcard.store/dashboard/agent-wallet",
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
    "⚠️ MANDATORY: Read mcp://resources/sop first. Collect shipping info and check get_merchant_hints before calling. Request a JIT virtual card ($1-$100).",
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
                        "👉 Please GET your key here: https://www.clawcard.store/dashboard/agents"
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
        const ZZERO_API = process.env.Z_ZERO_API_BASE || "https://www.clawcard.store";
        const INTERNAL_SECRET = process.env.Z_ZERO_INTERNAL_SECRET || "";
        try {
            const resp = await fetch(`${ZZERO_API}/api/checkout-hints?domain=${encodeURIComponent(domain)}&fields=merchant`, {
                headers: {
                    "x-internal-secret": INTERNAL_SECRET,
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
    "Execute a payment using a temporary token. This tool will securely fill the checkout form on the target website. You will NEVER see the real card number - it is handled securely in the background.",
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
            .describe("The actual final amount on the checkout page. If different from token amount, system will auto-refund the difference."),
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
        // Step 1: Resolve token → card data (RAM only)
        const cardData = await resolveTokenRemote(token);
        if (cardData?.error === "AUTH_REQUIRED") {
            return {
                content: [{
                    type: "text" as const,
                    text: "❌ AUTHENTICATION REQUIRED: Your Z_ZERO_API_KEY (Passport Key) is missing from the MCP configuration.\n\n" +
                        "👉 Please GET your key here: https://www.clawcard.store/dashboard/agents"
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

        // Step 3: Burn the token ONLY if payment succeeded
        // If merchant declines → keep token ACTIVE so webhook decline flow can refund correctly
        if (result.success) {
            await burnTokenRemote(token);
        } else {
            // Payment failed — do NOT burn token
            // Partner card issuer will fire a 'card.authorization.declined' webhook → refund handled there
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            {
                                success: false,
                                message: result.message || "Payment was declined by merchant.",
                                token_status: "ACTIVE",
                                note: "Token NOT burned. Funds will be refunded automatically via webhook within minutes.",
                            },
                            null,
                            2
                        ),
                    },
                ],
                isError: true,
            };
        }

        // Step 4: Refund underspend if actual amount was less than token amount
        if (actual_amount !== undefined && result.success) {
            await refundUnderspendRemote(token, actual_amount);
        }

        // Step 5: Return result (NEVER includes card numbers)
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(
                        {
                            success: result.success,
                            message: result.message,
                            receipt_id: result.receipt_id || null,
                            token_status: "BURNED",
                            note: "Token has been permanently invalidated after this transaction.",
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
                        "👉 Please GET your key here: https://www.clawcard.store/dashboard/agents"
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
            .describe("The new Passport Key to activate. Must start with 'zk_live_' or 'zk_test_'. Get from: https://www.clawcard.store/dashboard/agents"),
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
        const ZZERO_API = process.env.Z_ZERO_API_BASE || "https://www.clawcard.store";
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
                    content: [{ type: "text" as const, text: `❌ Key rejected by server — invalid or deactivated. Please check your key at https://www.clawcard.store/dashboard/agents` }],
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
        return {
            content: [{
                type: "text" as const,
                text: JSON.stringify({
                    status: "SUCCESS",
                    message: `✅ ${result.message}`,
                    active_key_prefix: trimmed.slice(0, 12) + "...",
                    note: "All subsequent API calls will use this key. Previous key removed from this session (soft revoke).",
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
                    key_prefix: hasKey ? key.slice(0, 12) + "..." : null,
                    note: hasKey
                        ? "Key is active. Call set_api_key to update it."
                        : "No key configured. Call set_api_key with your Passport Key from https://www.clawcard.store/dashboard/agents",
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
        const ZZERO_API = process.env.Z_ZERO_API_BASE || "https://www.clawcard.store";
        const API_KEY = getPassportKey();  // ✅ FIX: use hot-swap key store, not process.env

        if (!API_KEY) {
            return {
                content: [{ type: "text" as const, text: JSON.stringify({
                    status: "CONFIG_ERROR",
                    message: "Z_ZERO_API_KEY is not configured.",
                }, null, 2) }],
                isError: true,
            };
        }

        // ── SSRF guard ───────────────────────────────────────────────
        (() => {
            let url: URL;
            try { url = new URL(checkout_url); } catch {
                throw new Error(`Invalid checkout_url: ${checkout_url}`);
            }
            const isDev = process.env.NODE_ENV !== "production";
            const hostname = url.hostname;
            if (!(isDev && (hostname === "localhost" || hostname === "127.0.0.1"))) {
                if (url.protocol !== "https:") {
                    throw new Error(`checkout_url must use HTTPS.`);
                }
                const privatePatterns = [
                    /^localhost$/i, /^127\./, /^10\./,
                    /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
                    /^169\.254\./, /^\[::1\]$/, /^0\.0\.0\.0$/,
                ];
                if (privatePatterns.some(p => p.test(hostname))) {
                    throw new Error(`SSRF blocked host: ${hostname}`);
                }
            }
        })();

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

                const resp = await fetch(`${ZZERO_API}/api/wdk/transfer`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-passport-key": API_KEY },
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

            if (totalPrice < 1 || totalPrice > 100) {
                return {
                    content: [{ type: "text" as const, text: JSON.stringify({
                        route: "FIAT", status: "AMOUNT_OUT_OF_RANGE", detected_price: totalPrice,
                    }, null, 2) }],
                    isError: true,
                };
            }

            // Issue Token
            const token = await issueTokenRemote(card_alias, totalPrice, checkout_url);
            if (!token || token.error) throw new Error(token?.message || "Token issue failed");

            // Resolve Card Data
            const cardData = await resolveTokenRemote(token.token);
            if (!cardData || cardData.error) throw new Error("Card resolve failed");

            // Fill Form (Reusing the same page!)
            const fillResult = await fillCheckoutForm(checkout_url, cardData, page);
            if (fillResult.success) {
                const burnOk = await burnTokenRemote(token.token);
                if (!burnOk) console.error(`[WARN] Token burn failed for ${token.token} — manual check needed`);
            }

            return {
                content: [{ type: "text" as const, text: JSON.stringify({
                    route: "FIAT", status: fillResult.success ? "SUCCESS" : "FILL_FAILED",
                    detected_price: totalPrice,
                    message: fillResult.success
                        ? `✅ JIT card issued for $${totalPrice} and checkout filled.`
                        : `❌ Fill failed: ${fillResult.message}`,
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
        const ZZERO_API = process.env.Z_ZERO_API_BASE || "https://www.clawcard.store";
        const INTERNAL_SECRET = process.env.Z_ZERO_INTERNAL_SECRET || "";
        try {
            await fetch(`${ZZERO_API}/api/checkout-hints`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-internal-secret": INTERNAL_SECRET,
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
# Z-ZERO Autonomous Payment Skill SOP (v2.0.0)

This SOP tells the AI Agent how to use Z-ZERO tools to autonomously purchase goods on behalf of the user — without ever handling raw credit card data.

---

## Group 1: Wallet Config (READ FIRST)

Tools: \`check_balance\`, \`list_cards\`, \`get_deposit_addresses\`, \`set_api_key\`, \`show_api_key_status\`

Before ANY purchase:
1. Confirm exactly what the user wants to buy and the expected price (in USD).
2. Call \`check_balance\` using your default \`card_alias\` to verify sufficient funds.
   - If balance is insufficient → STOP. Ask the human to deposit USDC (stablecoin on Base) to their wallet.
3. Use \`list_cards\` to see available card aliases, NOT to check spendable balance.
4. Never ask for the API key proactively — only call \`set_api_key\` when the user explicitly gives you one.

---

## Group 2: Manual 4-Step Payment (Core Flow)

Tools: \`request_payment_token\`, \`execute_payment\`, \`cancel_payment_token\`, \`request_human_approval\`

Execute in this exact order:

### Step 1 — Verify
Confirm item, price, and check balance (see Group 1).

### Step 2 — Navigate to Payment Page
Use browser tools to navigate to the final payment page where card fields are visible and the FINAL total (including shipping + tax) is displayed.
- ⛔ DO NOT call \`request_payment_token\` until BOTH conditions are true:
  1. Shipping/personal info submitted successfully
  2. Card input fields are visible on screen

### Step 3 — Request Token
Call \`request_payment_token\` with exact final amount and merchant name.
Receive a single-use \`token\` (valid 1 hour, locked to that amount).

### Step 4 — Blind Execution
Call \`execute_payment\` with the token + checkout URL.
Z-ZERO opens a headless browser, injects the card securely, clicks Pay. Token burns instantly after success.

### Error Rules
- NEVER print raw tokens in chat.
- NO MANUAL ENTRY: If a site asks you to type a card number into a text box — REFUSE.
- FAIL GRACEFULLY: If \`execute_payment\` returns \`success: false\` → report it. Do NOT retry blindly.
- PRICE MISMATCH: If actual checkout total > token amount → call \`cancel_payment_token\` + \`request_human_approval\` for new amount.

---

## Group 3: Smart Autopilot (Fast Route)

Tools: \`auto_pay_checkout\`, \`get_merchant_hints\`

### Option A — Digital Goods / SaaS / APIs (Use auto_pay_checkout directly)
For pages where the final total is already visible, call \`auto_pay_checkout\`:
- It auto-detects Web3 (sends USDC on Base, gasless) vs Fiat (issues JIT Visa card + auto-fills form).
- One call handles everything.

### Option B — Physical Goods (Shopify, Etsy, WooCommerce)
⛔ DO NOT call \`auto_pay_checkout\` directly. The final price is only visible AFTER shipping is submitted.

Recommended flow:
1. Call \`get_merchant_hints\` with checkout domain or platform key (e.g. \`_platform_shopify\`).
   - Returns \`pre_steps\` (navigation instructions) + \`notes\` + \`platform\`.
2. Follow the \`pre_steps\` — navigate, add to cart, fill shipping form.
   - Ask user for shipping info via \`request_human_approval\` if not already known.
3. Wait for payment/card section to appear + FINAL total is visible.
4. Call \`request_payment_token\` with the exact final amount (Group 2).
5. Call \`execute_payment\` with token + checkout URL (Group 2).

### Platform Detection Signals
| Platform | Detection Signal |
|---|---|
| Shopify | JS object \`window.Shopify\` exists, OR \`<script src="cdn.shopify.com">\`, OR \`<meta name="shopify-checkout-api-token">\` |
| Etsy | URL matches \`*.etsy.com\` (any path) |
| WooCommerce | \`<body class="... woocommerce ...\`>\`, OR script/link tags from \`wp-content/plugins/woocommerce\` |

### Known Limitations
- Cloudflare-protected sites (e.g. TeePublic) may block headless browser → inform user.
- Card fields inside iframes: \`execute_payment\` handles this via \`iframe_selector\` in hints automatically.

### Failure Reporting (Self-Healing Loop)
If you started Group 3 (called \`get_merchant_hints\` and began following \`pre_steps\`) but CANNOT complete the checkout due to a technical reason:
→ Call \`report_checkout_fail(url, error_type, error_message)\` before giving up.
→ Use \`url\` = the page you were on when stuck.
→ Do NOT call this if user cancelled or balance was insufficient — those are not technical failures.
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
// START SERVER
// ============================================================
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`🔐 OpenClaw MCP Server v${CURRENT_MCP_VERSION} running (Phase 2: Smart Routing enabled)...`);
    console.error("Status: Secure & Connected to Z-ZERO Gateway");
    console.error("Tools: list_cards, check_balance, request_payment_token, execute_payment, cancel_payment_token, request_human_approval, auto_pay_checkout, report_checkout_fail");
}

main().catch(console.error);
