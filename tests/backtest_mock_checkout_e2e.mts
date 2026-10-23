import { createServer } from "node:http";
import { fillCheckoutForm } from "../dist/playwright_bridge.js";

type Expected = "confirmed" | "declined" | "not_submitted" | "no_fields" | "blocked";

const form = `
  <input autocomplete="cc-number">
  <input autocomplete="cc-exp">
  <input autocomplete="cc-csc">
  <input autocomplete="cc-name">
`;

// Pages are served from 127.0.0.1 (not data: URLs) because every card is locked to
// a host (lib/domain-lock.ts) and a data: URL has none.
const bodies: string[] = [];
const server = createServer((req, res) => {
  const i = Number((req.url ?? "").split("/").pop());
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${bodies[i] ?? ""}</body></html>`);
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as { port: number }).port;

function page(body: string): string {
  bodies.push(body);
  return `http://127.0.0.1:${port}/case/${bodies.length - 1}`;
}

const cases: Array<{ name: string; url: string; expected: Expected; receipt?: string; lockedTo?: string }> = [
  {
    name: "real confirmation text after submit",
    url: page(`${form}<button type="button" onclick="document.body.innerText='Thank you for your order. Order number: ORDER-7788'">Pay</button>`),
    expected: "confirmed",
    receipt: "ORDER-7788",
  },
  {
    name: "decline text after submit",
    url: page(`${form}<button type="button" onclick="document.body.innerText='Payment was declined. Try another card.'">Pay</button>`),
    expected: "declined",
  },
  {
    name: "filled form without submit control",
    url: page(form),
    expected: "not_submitted",
  },
  {
    name: "page without card fields",
    url: page("<main>Order summary only</main>"),
    expected: "no_fields",
  },
  {
    name: "card locked to another store — nothing typed",
    url: page(`${form}<button type="button">Pay</button>`),
    expected: "blocked",
    lockedTo: "meanblvd.com",
  },
];

let passed = 0;
for (const testCase of cases) {
  const card = {
    number: "4242424242424242",
    exp_month: "03",
    exp_year: "2029",
    cvv: "123",
    name: "Sandbox Test",
    merchant_domain: testCase.lockedTo ?? "127.0.0.1",
  };
  const result = await fillCheckoutForm(testCase.url, card);
  const secretsWiped = card.number === "0000000000000000" && card.cvv === "000";
  const statusMatches = result.status === testCase.expected;
  const receiptMatches = testCase.receipt === undefined || result.receipt_id === testCase.receipt;
  const ok = statusMatches && receiptMatches && secretsWiped;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.name}: ${JSON.stringify({ status: result.status, receipt_id: result.receipt_id, secretsWiped })}`);
}

server.close();
console.log(`SUMMARY ${passed}/${cases.length} PASS`);
process.exitCode = passed === cases.length ? 0 : 1;
