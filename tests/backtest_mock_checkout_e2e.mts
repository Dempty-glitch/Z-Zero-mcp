import { fillCheckoutForm } from "../dist/playwright_bridge.js";

type Expected = "confirmed" | "declined" | "not_submitted" | "no_fields";

const form = `
  <input autocomplete="cc-number">
  <input autocomplete="cc-exp">
  <input autocomplete="cc-csc">
  <input autocomplete="cc-name">
`;

function page(body: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`)}`;
}

const cases: Array<{ name: string; url: string; expected: Expected; receipt?: string }> = [
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
];

let passed = 0;
for (const testCase of cases) {
  const card = {
    number: "4242424242424242",
    exp_month: "03",
    exp_year: "2029",
    cvv: "123",
    name: "Sandbox Test",
  };
  const result = await fillCheckoutForm(testCase.url, card);
  const secretsWiped = card.number === "0000000000000000" && card.cvv === "000";
  const statusMatches = result.status === testCase.expected;
  const receiptMatches = testCase.receipt === undefined || result.receipt_id === testCase.receipt;
  const ok = statusMatches && receiptMatches && secretsWiped;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.name}: ${JSON.stringify({ status: result.status, receipt_id: result.receipt_id, secretsWiped })}`);
}

console.log(`SUMMARY ${passed}/${cases.length} PASS`);
process.exitCode = passed === cases.length ? 0 : 1;
