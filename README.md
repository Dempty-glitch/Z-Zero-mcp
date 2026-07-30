# Z-ZERO MCP — Payment Infrastructure for Agentic Commerce (USDC on Base, gasless)

[![MCP Badge](https://lobehub.com/badge/mcp/dempty-glitch-z-zero-mcp)](https://lobehub.com/mcp/dempty-glitch-z-zero-mcp)
[![npm](https://img.shields.io/npm/v/z-zero-mcp-server)](https://www.npmjs.com/package/z-zero-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI Agents today can plan, reason, and code — but they are financially blind.** They cannot hold money, make payments, or prove their trustworthiness. Every purchase still requires a human to copy-paste a credit card number.

Z-ZERO fixes that. One MCP server gives your agent (Claude, Cursor, any MCP-compatible client) two payment rails — **gasless USDC on Base** for crypto-native checkouts, and **JIT single-use virtual cards** for the 99% of the web that only takes cards — while the model **never sees a real card number**.

```bash
npx z-zero-mcp-server
```

**What makes it different:**
- 🔐 **Zero-trust by design** — the AI never sees PAN, CVV, or expiry. Card data exists only in RAM, injected via Playwright at the last step, then wiped.
- ⛽ **Gasless USDC on Base** — auto-detects crypto checkout (EIP-681) and settles as a gasless USDC transfer sponsored by Coinbase Paymaster. The agent holds only USDC — no ETH, no gas UX.
- 💳 **JIT single-use virtual cards** — amount-locked, 1-hour TTL, burned after a single use. Fiat fallback for the rest of the web.
- 🧠 **Smart Routing + checkout intelligence** — `get_merchant_hints` serves platform-specific checkout playbooks (Shopify, Etsy, WooCommerce…).
- ✍️ **Signed intent + signed receipt** — the card is bound to a signed statement of *what it is for*, and every confirmed purchase returns a signed receipt with a diff against that intent. The agent can **prove** a purchase instead of claiming one (`verify_receipt`, public verify page).
- 🔄 **Structured failure labels** — failed checkouts are labeled with a fixed 14-class `failure_class` (automatically, not only when an agent remembers to report) and stored as evidence for the merchant knowledge base. Facts are promoted into shared hints only after a later outcome or review verifies them.

---

## Live on Base Mainnet

- ✅ Proof — real gasless USDC transfer on Base mainnet: [`0xdfd1f2f8…5d7a`](https://basescan.org/tx/0xdfd1f2f824e1232c3e03c52485332570ff01fbb0340c5571f699ed1218735d7a)
- Onboarding is just "deposit USDC" — no seed phrases in the agent, no native gas token, no exchange account.

---

## How It Works

```
 User            AI Agent              MCP Tools              Z-ZERO API
  │                  │                      │                      │
  │ "Buy me this     │                      │                      │
  │  Shopify item"   │                      │                      │
  ├─────────────────▶│                      │                      │
  │                  │ read mcp://resources/sop (MANDATORY)        │
  │                  ├─────────────────────▶│                      │
  │                  │◀── platform rules ───┤                      │
  │                  │    + payment SOP     │                      │
  │                  │                      │                      │
  │                  │ get_merchant_hints("_platform_shopify")     │
  │                  ├─────────────────────▶│  GET /checkout-hints │
  │                  │                      ├─────────────────────▶│
  │                  │◀── pre_steps+notes ──┤◀──── hints data ─────┤
  │                  │                      │                      │
  │                  │ (fills shipping form, reaches payment page) │
  │                  │                      │                      │
  │                  │ request_payment_token(amount, card_alias)   │
  │                  ├─────────────────────▶│                      │
  │                  │◀── temp_auth token ──┤   (1-hour TTL)       │
  │                  │                      │                      │
  │                  │ execute_payment(token, checkout_url)        │
  │                  ├─────────────────────▶│                      │
  │                  │      Playwright auto-fills card form,       │
  │                  │      burns token after single use 🔥        │
  │                  │◀──── ✅ success ─────┤                      │
  │ "Done! Your item │                      │                      │
  │  is ordered."    │                      │                      │
  │◀─────────────────┤                      │                      │
```

*The AI agent never touches card data — it only handles single-use tokens. Real card details are injected by Playwright at the last step and wiped from RAM.*

> **Crypto checkout branch:** when `auto_pay_checkout` detects a crypto-native checkout (EIP-681), it skips the card flow entirely and settles as a **gasless USDC transfer on Base** — see above.

---

## Why Z-ZERO

Z-ZERO is not a checkout bot — it's payment infrastructure for the agentic-commerce era (agentic transactions are projected to reach **$1.5T by 2030** — Juniper Research).

**Today**, the web is built for humans: agents must fill forms and click buttons, and every purchase still needs a human's card. Z-ZERO solves that now — JIT single-use virtual cards + gasless USDC on Base, with card data isolated from the model. **Tomorrow**, agent payments become a standardized protocol — and what we build along the way is the long-term value:

- **Shared checkout intelligence** — every transaction (and every failure) makes the network smarter.
- **An open standard for agent payments** — any agent platform plugs in via MCP; any rail (cards, USDC, x402) can be added.
- **KYA — Know Your Agent** — verifiable agent reputation. The question isn't "can this agent pay?" but "should you trust it to?"

📖 Full vision & architecture: [The Z-Zero Whitebook](https://z-zero.xyz/whitebook)

---

## Quick Install (Recommended)

```bash
npx z-zero-mcp-server
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "z-zero": {
      "command": "npx",
      "args": ["-y", "z-zero-mcp-server@latest"],
      "env": {
        "Z_ZERO_API_KEY": "zk_live_your_passport_key_here"
      }
    }
  }
}
```

Get your Passport Key at: **[z-zero.xyz/dashboard/agents](https://z-zero.xyz/dashboard/agents)**

---

## Security: rotate-on-connect (v1.5.0+)

The key you copy from the dashboard (or paste into a chat) is only a **one-time bootstrap ticket**.
The moment your agent connects with it, the MCP server silently swaps it for a fresh key:

- The fresh key travels **server → MCP process → disk** and is stored in `~/.z-zero/credentials` (mode `0600`). It never appears in any LLM conversation, tool result, or config file.
- The pasted key is **dead within seconds** — a copy living in a chat transcript, clipboard, or screenshot can no longer be used by anyone.
- On startup the MCP loads the key from `~/.z-zero/credentials` first; the `Z_ZERO_API_KEY` env var is only a bootstrap fallback.

**One key = one machine.** All agents on the same machine (Claude Desktop, Claude Code, Cursor, …) share the same MCP install and the same credentials file — install once, every agent can pay. Connecting a *different* machine with a copied key rotates it, which instantly disconnects the original machine. That is deliberate: it blocks key sharing **and** doubles as an intrusion alarm — if your agent suddenly fails auth, someone else used your key; go to the dashboard and revoke.

Older self-hosted backends without the rotate endpoint keep working — the pasted key simply stays active as before.

---

## Requirements

- **Node.js v18+** — [nodejs.org](https://nodejs.org)
- **Passport Key** — starts with `zk_live_`, get it from the dashboard above

---

## Available MCP Tools

### Group 1 — Wallet Config (Passive)

| Tool | Description |
|------|-------------|
| `list_cards` | List all virtual card aliases and balances |
| `check_balance` | Check spendable USD balance for a card alias |
| `get_deposit_addresses` | Get your Base deposit address to top up with USDC (stablecoin on Base) |
| `set_api_key` | Activate a new Passport Key instantly, no restart needed |
| `show_api_key_status` | Check if a Passport Key is currently loaded (prefix only) |

### Group 2 — Manual 4-Step Payment (Active)

| Tool | Description |
|------|-------------|
| `request_payment_token` | Issue a JIT single-use virtual-card token for a specific amount (1hr TTL). Pass `cart` + `ship_to` and the card is bound to a **signed intent** |
| `execute_payment` | Auto-fill checkout form using a payment token via Playwright. Returns a **signed receipt** on confirmed payments |
| `cancel_payment_token` | Cancel an unused token and refund to wallet |
| `request_human_approval` | Pause and request human confirmation before proceeding |

### Group 3 — Smart Autopilot

| Tool | Description |
|------|-------------|
| `auto_pay_checkout` | Fully autonomous checkout — auto-detects Web3 or Fiat and completes payment |
| `get_merchant_hints` | Fetch platform-specific checkout playbook (pre-steps + selectors) from Knowledge Base |
| `report_checkout_fail` | Report a failed checkout with a **structured `failure_class`** (14-class enum) — feeds the self-healing loop |
| `verify_receipt` | Verify a signed receipt by id — prove a purchase happened instead of claiming it |

> 📖 **Note:** Version checking is handled automatically in each API call. No separate tool needed.

---

## Agent primitives (v1.7.0)

Three things an agent can do here that it cannot do with a normal virtual card.

### 1. Signed intent — the card knows what it is for

Pass the cart when you request a token:

```jsonc
request_payment_token({
  card_alias: "Card_01",
  amount: 44.00,
  merchant: "etsy.com",
  cart: [{ title: "Ceramic mug — matte white", qty: 2, unit_price: 18.50 }],
  ship_to: "12 Nguyen Hue, District 1, Ho Chi Minh City, VN"
})
```

Z-ZERO signs that statement (EIP-191) and binds it to the card. The user gets
cryptographic proof of **what this card was authorized to buy** — not just how
much it could spend. The shipping address is stored as a hash, never raw.

**Before you request a token, compare the checkout page with what the user actually
asked for** — same items, same quantity, same variant, same destination. A mismatch
you catch there costs nothing. After the token, it costs a card.

### 2. Signed receipt — prove the purchase, don't claim it

On a confirmed payment you get back:

```jsonc
"signed_receipt": {
  "receipt_id": "8ea36791-…",
  "receipt_hash": "0x…",
  "match": { "total": "over", "domain": "ok" },
  "diff":  [{ "field": "total", "expected": 44.00, "observed": 46.75 }],
  "verify_url": "https://z-zero.xyz/receipt/8ea36791-…"
}
```

`diff` is the part that matters: it is what the merchant actually did versus what
was authorized. Share `verify_url` with the user — the page is public and anyone
can check it. Verification is three checks: the signature is valid, the signer is
Z-ZERO, and the fields shown still hash to what was signed (so editing the record
afterwards is detectable, including by us).

**What a valid receipt does and does not prove.** It proves the record is signed by
Z-ZERO and unaltered. It does not by itself prove the merchant charged what the
receipt says — most fields start life as the agent's reading of a web page. Every
receipt therefore carries `provenance` per field: `zzero_issued` (the limit we set),
`issuer_captured` (confirmed by the card issuer's capture webhook — settlement
evidence), `agent_reported` (unverified), `human_verified`. Until the capture webhook
lands, this is a **signed execution receipt**, not settlement proof, and it says so.

### 3. Structured failure classes — every failure teaches the network

`report_checkout_fail` takes a fixed enum, not free text:

`card_declined_issuer` · `card_declined_bin_block` · `avs_mismatch` · `3ds_required` ·
`bot_detected` · `form_changed` · `price_changed` · `out_of_stock` ·
`shipping_unsupported` · `login_required` · `timeout` · `outcome_unconfirmed` ·
`intent_mismatch` · `unknown`

Failed runs are also labeled automatically from the browser outcome, so the network
learns even when nobody remembers to report. Card numbers are redacted at capture —
they never reach a log, screenshot or DOM dump.

---

## REST API Reference

The Z-ZERO backend is hosted at `https://z-zero.xyz`. All endpoints require a `Bearer` token using your Passport Key.

> ⚠️ **Use the MCP tools above instead of calling REST directly.** If you must call REST, use the exact paths below.

### `GET /api/tokens/cards`
Returns your card list, balance, and deposit addresses.
```bash
curl -X GET "https://z-zero.xyz/api/tokens/cards" \
  -H "Authorization: Bearer zk_live_your_key"
```

**Aliases (also work):**
- `GET /api/v1/cards` ← for agents that guess REST-style paths

### `POST /api/tokens/issue`
Issue a JIT payment token.

### `POST /api/tokens/resolve`
Resolve a token to card data (server-side only).

### `POST /api/tokens/burn`
Burn a used token.

### `POST /api/tokens/cancel`
Cancel an unused token (refunds balance).

---

## Troubleshooting

### "Z_ZERO_API_KEY is missing"
1. Go to [z-zero.xyz/dashboard/agents](https://z-zero.xyz/dashboard/agents)
2. Copy your Passport Key (starts with `zk_live_`)
3. Add it to your config as `Z_ZERO_API_KEY`
4. **Restart** Claude Desktop / Cursor

### "Invalid API Key" (401)
- Double-check you copied the full key (e.g. `zk_live_c0g3l`)
- Make sure there are no extra spaces or line breaks

### "404 Not Found" on `/api/v1/cards`
- This is a legacy path alias — it should now work. If not, use `/api/tokens/cards` directly.

---

*Security: the key you paste is never kept — it rotates the moment your agent first connects, and the fresh key lives only in a local owner-only file (`~/.z-zero/credentials`, mode 0600), never in any LLM conversation. Card data exists only in volatile RAM during execution.*
