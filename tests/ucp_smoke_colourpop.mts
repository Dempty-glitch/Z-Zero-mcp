// ⚠️ LIVE test (real store, unpaid drafts; not CI). Run: npm run test:ucp-smoke:live
// Quick smoke of the exact code path ucp_probe_checkout uses (quote only, no payment).
import { ucpDiscover, UcpMcpClient, ucpCreateCheckout } from "../dist/ucp_bridge.js";

const SHOP = process.argv[2] ?? "https://colourpop.com";
const QUERY = process.argv[3] ?? "lippie stix";

const disc = await ucpDiscover(SHOP);
if (!disc) throw new Error("no ucp");
console.log("handlers:", disc.handlers.map((h) => h.handler_name).join(", "));

const client = new UcpMcpClient(disc.mcpEndpoint);
const search = await client.callTool("search_catalog", { meta: {}, catalog: { query: QUERY, limit: 3 } });
const blob = JSON.stringify(search);
const ids = [...new Set(
    (blob.match(/gid:\\?\/\\?\/shopify\/ProductVariant\/\d+/g) ?? []).map((s) => s.replace(/\\\//g, "/"))
)];
console.log("variants:", ids.slice(0, 3));
if (!ids.length) { console.log(blob.slice(0, 1500)); process.exit(1); }

const q = await ucpCreateCheckout(client, [{ item_id: ids[0], quantity: 1 }], { email: "agent@z-zero.xyz" }, {
    first_name: "ZZero", last_name: "Dryrun", street_address: "100 Main St", address_locality: "New York",
    address_region: "NY", address_country: "US", postal_code: "10001", phone_number: "+12125550100",
});
console.log(JSON.stringify({ checkout_id: q.checkout_id, status: q.status, total_minor: q.total_minor, total_major: q.total_major, currency: q.currency, messages: q.messages }, null, 2));
const raw: any = (q.raw as any)?.checkout ?? q.raw ?? {};
console.log("fulfillment:", JSON.stringify(raw.fulfillment ?? null)?.slice(0, 1800));
console.log("\n✅ SMOKE COMPLETE — no payment step executed.");
