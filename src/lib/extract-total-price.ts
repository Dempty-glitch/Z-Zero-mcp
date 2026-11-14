// extract-total-price.ts
// Reads the checkout total off a page for auto_pay_checkout — as a CROSS-CHECK
// against the ceiling the agent passes (max_amount), never as the authority.
//
// Rules (audit T12 F4, T13 F3; M.3):
//   - only text a person can see counts: not display:none, not transparent,
//     not a 0px font, not parked off-screen. A page used to get a $5 item
//     charged as $49 by hiding "$49.00" somewhere;
//   - a number is a price only with a currency mark next to it ("48 items" is
//     not $48);
//   - "0,49 $" is forty-nine cents, "1.234,56 €" is one thousand two hundred…;
//   - the currency is read with the number. Anything not clearly US dollars is
//     reported as such; the caller does not convert it.

import type { Page } from "playwright";

export type PriceCurrency = "USD" | "NON_USD";
export interface DetectedPrice {
    amount: number;
    currency: PriceCurrency;
    /** The visible text the number came from (page data — untrusted). */
    source: string;
}

const NON_USD_SYMBOL = /[€£¥₹₩₺₽฿₴₫₱₦₪]|\b(?:CA|C|A|AU|NZ|HK|R|S|SG|MX|NT)\$/;
const NON_USD_CODE = /\b(?:EUR|GBP|JPY|CNY|RMB|INR|AUD|CAD|CHF|SGD|HKD|NZD|SEK|NOK|DKK|KRW|MXN|BRL|ZAR|AED|THB|MYR|PHP|VND|IDR|PLN|TRY|TWD|ILS|CZK|HUF)\b/;
const USD_MARK = /US\$|\bUSD\b|\$/;

/** "1,234.56" · "0,49" · "1.234,56" · "1,234" · "49" → number, or null. */
export function parseAmount(raw: string): number | null {
    const s = raw.replace(/[\s  ']/g, "");
    if (!/^\d[\d.,]*$/.test(s)) return null;
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    let normalized: string;
    if (lastDot >= 0 && lastComma >= 0) {
        // The later separator is the decimal one.
        normalized = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
    } else if (lastComma >= 0) {
        const decimals = s.length - lastComma - 1;
        // "1,234" / "12,345,678" = thousands; "0,49" / "12,5" = decimals
        normalized = decimals === 3 && /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,(?=\d+$)/, ".").replace(/,/g, "");
    } else if (lastDot >= 0) {
        const decimals = s.length - lastDot - 1;
        normalized = decimals === 3 && /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s;
    } else {
        normalized = s;
    }
    const v = Number(normalized);
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

/**
 * A price in a string: a number with a currency mark right before or after it.
 * Returns null when there is no such pair.
 */
export function parsePriceText(text: string): DetectedPrice | null {
    const t = text.normalize("NFKC");
    const MONEY = /((?:[A-Z]{2,3})?\$|US\$|[€£¥₹₩₺₽฿₴₫₱₦₪]|\b[A-Z]{3}\b)?\s*(\d[\d.,\s ]*\d|\d)\s*((?:[A-Z]{2,3})?\$|[€£¥₹₩₺₽฿₴₫₱₦₪]|\b[A-Z]{3}\b)?/g;
    for (const m of t.matchAll(MONEY)) {
        const before = m[1] || "";
        const after = m[3] || "";
        const mark = (before + " " + after).trim();
        if (!mark) continue;
        const isNonUsd = NON_USD_SYMBOL.test(mark) || NON_USD_CODE.test(mark);
        const isUsd = !isNonUsd && USD_MARK.test(mark);
        if (!isNonUsd && !isUsd) continue; // e.g. "48 ITEMS"
        const amount = parseAmount(m[2]);
        if (amount === null) continue;
        return { amount, currency: isUsd ? "USD" : "NON_USD", source: m[0].trim().slice(0, 40) };
    }
    return null;
}

/**
 * Multi-strategy total price extractor, visible text only.
 *   1. Known total selectors for major platforms (Shopify, Stripe, Woo, generic)
 *   2. Short visible texts that mention "total" / "amount due" / "you pay"
 *   3. Median of all visible prices on the page (low confidence)
 */
export async function extractTotalPrice(page: Page): Promise<DetectedPrice | null> {
    const candidates: { strategy: number; text: string }[] = await page.evaluate(() => {
        const visible = (el: Element): boolean => {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
            const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
            const left = r.left + window.scrollX;
            const top = r.top + window.scrollY;
            if (left + r.width <= 0 || top + r.height <= 0 || left >= docW || top >= docH) return false;
            let opacity = 1;
            for (let n: Element | null = el; n; n = n.parentElement) {
                const s = getComputedStyle(n);
                if (s.display === "none" || s.visibility === "hidden") return false;
                opacity *= parseFloat(s.opacity || "1");
            }
            if (opacity < 0.1) return false;
            return parseFloat(getComputedStyle(el).fontSize || "16") >= 6;
        };
        const textOf = (el: Element) => ((el as HTMLElement).innerText || "").trim();
        const out: { strategy: number; text: string }[] = [];

        const known = [
            '[data-checkout-payment-amount]', '.payment-due__price',
            '[data-testid="total-amount"]', '.OrderAmountRow--total .OrderAmountRow-amount',
            '.order-total .amount', '.woocommerce-Price-amount.amount',
            '[data-testid*="total" i]', '[class*="order-total" i]', '[class*="total-price" i]',
            '[class*="grand-total" i]', '[id*="order-total" i]', '[id*="grand-total" i]',
            'span[class*="total"]', 'td[class*="total"]',
        ];
        for (const sel of known) {
            for (const el of Array.from(document.querySelectorAll(sel))) {
                if (visible(el)) out.push({ strategy: 1, text: textOf(el) });
            }
        }
        for (const el of Array.from(document.querySelectorAll("body *"))) {
            if (el.children.length >= 5) continue;
            const t = textOf(el).toLowerCase();
            if ((t.includes("total") || t.includes("amount due") || t.includes("you pay")) && t.length < 200 && visible(el)) {
                out.push({ strategy: 2, text: textOf(el) });
            }
        }
        for (const el of Array.from(document.querySelectorAll("body *"))) {
            if (el.children.length === 0 && visible(el)) {
                const t = textOf(el);
                if (t && t.length < 200) out.push({ strategy: 3, text: t });
            }
        }
        return out.slice(0, 3000);
    }).catch(() => []);

    for (const strategy of [1, 2]) {
        for (const c of candidates.filter((x) => x.strategy === strategy)) {
            const p = parsePriceText(c.text);
            if (p) {
                console.error(`[PRICE] Strategy ${strategy}: ${p.currency} ${p.amount}`);
                return p;
            }
        }
    }

    // Strategy 3: median of every visible price — low confidence, same currency only.
    const all = candidates.filter((x) => x.strategy === 3)
        .map((c) => parsePriceText(c.text))
        .filter((p): p is DetectedPrice => p !== null && p.amount < 10_000);
    if (all.length > 0) {
        const currency: PriceCurrency = all.some((p) => p.currency === "NON_USD") ? "NON_USD" : "USD";
        const sorted = all.filter((p) => p.currency === currency).sort((a, b) => a.amount - b.amount);
        const pick = sorted[Math.floor(sorted.length / 2)];
        console.error(`[PRICE] ⚠️ Strategy 3 (median of visible prices): ${pick.currency} ${pick.amount}. Low confidence.`);
        return pick;
    }

    console.error('[PRICE] ❌ Could not detect total price on this page.');
    return null;
}

/**
 * Does the page as a whole show a currency other than US dollars? A "$" alone
 * is also how CAD/AUD/… stores print prices, so a "$" total on a page that
 * mentions another currency is not taken as USD. Visible text only.
 */
export async function pageMentionsOtherCurrency(page: Page): Promise<boolean> {
    try {
        const body = await page.evaluate(() => (document.body as HTMLElement).innerText || "");
        return NON_USD_SYMBOL.test(body) || NON_USD_CODE.test(body);
    } catch {
        return false;
    }
}
