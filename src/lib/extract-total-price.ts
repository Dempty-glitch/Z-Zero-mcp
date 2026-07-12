// extract-total-price.ts
// Phase 2: Smart Routing - DOM Price Extractor
// Scans a checkout page via Playwright and returns the cart total in USD.
// Returns null if no price can be confidently found.

import type { Page } from "playwright";

/**
 * Multi-strategy total price extractor.
 * Strategy order (most reliable → least reliable):
 *   1. Known CSS selectors for major platforms (Shopify, Stripe, Woo)
 *   2. Aria / data-testid patterns
 *   3. Text heuristic: find largest $ amount near keywords "total", "amount due"
 */
export async function extractTotalPrice(page: Page): Promise<number | null> {
    // ─── Strategy 1: Well-known selector list ────────────────────────────────
    const knownSelectors = [
        // Shopify
        '[data-checkout-payment-amount]',
        '.payment-due__price',
        // Stripe Checkout
        '[data-testid="total-amount"]',
        '.OrderAmountRow--total .OrderAmountRow-amount',
        // Woocommerce
        '.order-total .amount',
        '.woocommerce-Price-amount.amount',
        // Generic
        '[data-testid*="total" i]',
        '[class*="order-total" i]',
        '[class*="total-price" i]',
        '[class*="grand-total" i]',
        '[id*="order-total" i]',
        '[id*="grand-total" i]',
        'span[class*="total"]',
        'td[class*="total"]',
    ];

    for (const selector of knownSelectors) {
        try {
            const el = await page.$(selector);
            if (!el) continue;
            const text = await el.innerText();
            const parsed = parseMoneyString(text);
            if (parsed !== null && parsed > 0) {
                console.error(`[PRICE] ✅ Strategy 1 found via selector "${selector}": $${parsed}`);
                return parsed;
            }
        } catch {
            // element may have been removed from DOM — continue
        }
    }

    // ─── Strategy 2: Scan all visible text near "total" keyword ──────────────
    try {
        const amount = await page.evaluate(() => {
            const allText = Array.from(document.querySelectorAll('*'))
                .filter((el): el is HTMLElement => {
                    if (!(el instanceof HTMLElement)) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden';
                })
                .filter(el => {
                    const text = el.innerText?.toLowerCase() ?? '';
                    return (
                        (text.includes('total') || text.includes('amount due') || text.includes('you pay')) &&
                        el.children.length < 5 // narrow to leaf-ish nodes
                    );
                })
                .map(el => el.innerText ?? '');

            // Find first valid $ pattern in those elements
            const priceRegex = /\$\s*([\d,]+(?:\.\d{1,2})?)/;
            for (const text of allText) {
                const match = text.match(priceRegex);
                if (match) {
                    const value = parseFloat(match[1].replace(/,/g, ''));
                    if (value > 0 && value < 10000) return value; // sanity bound
                }
            }
            return null;
        });

        if (amount !== null && amount > 0) {
            console.error(`[PRICE] ✅ Strategy 2 (text heuristic) found: $${amount}`);
            return amount;
        }
    } catch (e) {
        console.error(`[PRICE] Strategy 2 failed: ${e}`);
    }

    // ─── Strategy 3: Last resort — biggest dollar amount visible on page ─────
    try {
        const amount = await page.evaluate(() => {
            const regex = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
            const bodyText = (document.body as HTMLElement).innerText ?? '';
            const values: number[] = [];
            let m: RegExpExecArray | null;
            while ((m = regex.exec(bodyText)) !== null) {
                const v = parseFloat(m[1].replace(/,/g, ''));
                if (v >= 0.5 && v < 10000) values.push(v);
            }
            if (values.length === 0) return null;
            // ✅ FIX 10: Use median instead of max — prevents merchant injecting hidden large price
            values.sort((a, b) => a - b);
            return values[Math.floor(values.length / 2)];
        });

        if (amount !== null && amount > 0) {
            console.error(`[PRICE] ⚠️  Strategy 3 (largest $ on page): $${amount}. Low confidence.`);
            return amount;
        }
    } catch (e) {
        console.error(`[PRICE] Strategy 3 failed: ${e}`);
    }

    console.error('[PRICE] ❌ Could not detect total price on this page.');
    return null;
}

/**
 * Detect whether the checkout charges in USD or a non-USD currency.
 * Purpose: size the FX buffer on the JIT card. A USD checkout total is final —
 * our USD card pays it 1:1, no conversion. A non-USD total gets FX-converted +
 * a conversion fee on our USD card and can drift OVER the authorized limit →
 * issuer decline. So non-USD orders need a slightly larger card limit.
 *
 * Conservative by design: defaults to 'USD' unless a CLEAR non-USD signal is
 * present. Both error directions are non-catastrophic (over-buffer → refunded
 * at settlement; under-buffer → a decline the agent can retry), so we avoid
 * false positives from random uppercase text via a currency-code whitelist.
 */
export async function detectCheckoutCurrency(page: Page): Promise<'USD' | 'NON_USD'> {
    try {
        return await page.evaluate(() => {
            const body = (document.body as HTMLElement).innerText || '';
            // 1. Non-USD currency symbols
            if (/[€£¥₹₩₺₽฿₴]/.test(body)) return 'NON_USD';
            // 2. Ambiguous "$" with a non-US region prefix (CA$, A$, NZ$, HK$, R$, S$)
            if (/\b(?:CA|A|NZ|HK|R|S)\$/.test(body)) return 'NON_USD';
            // 3. Explicit 3-letter ISO codes — whitelist of common non-USD only
            const NON_USD = ['EUR','GBP','JPY','CNY','INR','AUD','CAD','CHF','SGD','HKD','NZD','SEK','NOK','DKK','KRW','MXN','BRL','ZAR','AED','THB','MYR','PHP','VND','IDR','PLN','TRY'];
            for (const code of NON_USD) {
                if (new RegExp(`\\b${code}\\b`).test(body)) return 'NON_USD';
            }
            return 'USD';
        });
    } catch {
        return 'USD'; // fail safe → smallest buffer, never blocks a payment
    }
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function parseMoneyString(text: string): number | null {
    // Handles: "$49.99", "USD 49.99", "49,99 $", "49.99 USD"
    const match = text.match(/[\d,]+(?:\.\d{1,2})?/);
    if (!match) return null;
    const value = parseFloat(match[0].replace(/,/g, ''));
    if (isNaN(value) || value <= 0) return null;
    return value;
}
