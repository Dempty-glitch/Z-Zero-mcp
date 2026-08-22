// UCP dry-run against MEAN BLVD (pilot merchant #1).
// Exercises: discovery → search_catalog → create_checkout → address → purchasability.
// ⛔ NEVER attaches a payment instrument or calls complete_checkout — no money moves here.
// Checkout drafts expire server-side on their own (expires_at ~30 days).
//
// ⚠️ LIVE test: hits real Shopify stores and creates real (unpaid) checkout drafts. Not part of CI.
// Run: npm run test:ucp-dryrun:live   (or: node --experimental-strip-types tests/ucp_dryrun_meanblvd.mts [shopUrl])

import { ucpDiscover, UcpMcpClient, ucpCreateCheckout } from "../dist/ucp_bridge.js";

const SHOP = process.argv[2] ?? "https://meanblvd.com";

const log = (label: string, data: unknown) =>
    console.log(`\n=== ${label} ===\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);

const TEST_ADDRESS = {
    first_name: "ZZero",
    last_name: "Dryrun",
    street_address: "100 Main St",
    address_locality: "New York",
    address_region: "NY",
    address_country: "US",
    postal_code: "10001",
    phone_number: "+12125550100",
};

const main = async () => {
    // 1) Discovery
    const disc = await ucpDiscover(SHOP);
    if (!disc) throw new Error(`No UCP discovery at ${SHOP}`);
    log("DISCOVERY", {
        version: disc.version,
        mcpEndpoint: disc.mcpEndpoint,
        handlers: disc.handlers.map((h) => `${h.handler_name} (id=${h.id}, v=${h.version})`),
        cardHandler: disc.cardHandler?.id ?? null,
    });

    const client = new UcpMcpClient(disc.mcpEndpoint);

    // 2) Catalog search
    const search = await client.callTool("search_catalog", {
        meta: {},
        catalog: { query: "dress", limit: 5 },
    });
    const blob = JSON.stringify(search);
    const variantIds = [...new Set(
        (blob.match(/gid:\\?\/\\?\/shopify\/ProductVariant\/\d+/g) ?? []).map((s) => s.replace(/\\\//g, "/"))
    )];
    log("CANDIDATE VARIANTS", variantIds.slice(0, 6));
    if (variantIds.length === 0) {
        log("SEARCH RESULT (truncated)", blob.slice(0, 3000));
        throw new Error("No variant ids found in search result");
    }

    // 3+4) For each candidate: create checkout → add TEST address → check purchasability.
    for (const itemId of variantIds.slice(0, 4)) {
        console.log(`\n──────── trying variant ${itemId} ────────`);
        let quote;
        try {
            quote = await ucpCreateCheckout(client, [{ item_id: itemId, quantity: 1 }], { email: "hung@z-zero.xyz" });
        } catch (e: any) {
            log("create_checkout FAILED", e?.message ?? String(e));
            continue;
        }
        const created = (quote.raw as any)?.checkout ?? quote.raw ?? {};
        const title = created?.line_items?.[0]?.item?.title ?? "?";
        log("QUOTE", { title, status: quote.status, total_minor: quote.total_minor, total_major: quote.total_major, currency: quote.currency, messages: quote.messages });
        if (!quote.checkout_id || quote.messages.some((m) => /out_of_stock|sold out/i.test(m))) {
            console.log("→ sold out / no checkout created, trying next variant…");
            continue;
        }

        const lineItems = (created.line_items ?? []).map((li: any) => ({ id: li.id, item: { id: li.item?.id }, quantity: li.quantity }));
        let updated: any = null;
        try {
            updated = await client.callTool("update_checkout", {
                meta: {},
                id: quote.checkout_id,
                checkout: {
                    line_items: lineItems,
                    buyer: { email: "hung@z-zero.xyz", first_name: "ZZero", last_name: "Dryrun" },
                    fulfillment: {
                        methods: [{
                            type: "shipping",
                            line_item_ids: lineItems.map((li: any) => li.id),
                            destinations: [TEST_ADDRESS],
                        }],
                    },
                },
            });
        } catch (e: any) {
            log("update_checkout(address) FAILED", e?.message ?? String(e));
            continue;
        }
        const u = updated?.checkout ?? updated ?? {};
        const codes = (u.messages ?? []).map((m: any) => m?.code ?? String(m));
        log("AFTER ADDRESS", {
            status: u.status,
            totals: u.totals ?? null,
            message_codes: codes,
            fulfillment: JSON.stringify(u.fulfillment ?? null)?.slice(0, 2500) ?? "n/a",
            payment: JSON.stringify(u.payment ?? null)?.slice(0, 1000) ?? "n/a",
        });
        const blocked = codes.some((c: string) => /item_unavailable|out_of_stock|invalid/.test(c));
        if (!blocked && u.status) {
            log("PURCHASABLE PATH FOUND", { itemId, title, status: u.status, checkout_id: quote.checkout_id, messages: u.messages ?? [] });
            break;
        }
        console.log("→ item unavailable for this market, trying next variant…");
    }

    console.log("\n✅ DRY-RUN COMPLETE — stopped before any payment step, as designed.");
};

main().catch((e) => {
    console.error("\n❌ DRY-RUN FAILED:", e?.message ?? e);
    process.exit(1);
});
