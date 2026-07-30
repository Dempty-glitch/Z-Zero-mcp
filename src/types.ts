// Shared TypeScript types for AI Virtual Card MCP Server

export interface VirtualCard {
    alias: string;
    number: string;       // 16-digit card number
    exp_month: string;
    exp_year: string;
    cvv: string;
    name: string;
    balance: number;      // remaining balance in USD
    currency: string;
    error?: string;
    message?: string;
}

export interface PaymentToken {
    token: string;
    card_alias: string;
    amount: number;
    merchant: string;
    created_at: number;   // Unix timestamp
    ttl_seconds: number;  // Time-to-live
    used: boolean;
    error?: string;
    message?: string;
}

export interface CardData {
    number: string;
    exp_month: string;
    exp_year: string;
    cvv: string;
    name: string;
    authorized_amount?: number;  // Amount authorized when token was issued (for pre-flight guard)
    intent_id?: string;          // Primitive 1: intent this token is bound to (for event/receipt labeling)
    intent_hash?: string;
    error?: string;
    message?: string;
}

// Outcome of a checkout attempt. CRITICAL: `filled` ≠ `paid`.
//   confirmed     — Pay was clicked AND a real confirmation signal was detected (only this burns the token)
//   declined      — Pay was clicked but the page showed a decline/error (keep token ACTIVE for webhook refund)
//   unconfirmed   — fields filled + Pay clicked, but no clear confirmation within the wait window (do NOT burn — funds stay recoverable)
//   not_submitted — fields filled but no Pay button was found/clicked (do NOT burn)
//   no_fields     — no card fields detected on the page
//   error         — exception/timeout during the attempt
export type PaymentOutcome =
    | 'confirmed'
    | 'declined'
    | 'unconfirmed'
    | 'not_submitted'
    | 'no_fields'
    | 'error';

export interface PaymentResult {
    success: boolean;          // true ONLY when status === 'confirmed' — the sole gate for burning a token
    status: PaymentOutcome;
    message: string;
    receipt_id?: string;       // real order/confirmation number scraped from the page; NEVER fabricated
    amount?: number;
}

export interface CheckoutHints {
    pre_steps?: string[];          // CSS selectors to click BEFORE filling (e.g. open payment accordion)
    iframe_selector?: string;      // iframe name fragment if card fields are inside an iframe (e.g. "card-fields-iframe" for Shopify)
    card_selector?: string;        // CSS for card number input (inside iframe if iframe_selector set)
    exp_selector?: string;         // CSS for expiry combined (MM/YY)
    exp_month_selector?: string;   // CSS for expiry month (if split)
    exp_year_selector?: string;    // CSS for expiry year (if split)
    cvv_selector?: string;         // CSS for CVV/CVC field
    name_selector?: string;        // CSS for cardholder name (always main page, outside iframe)
    submit_selector?: string;      // CSS for submit/pay button
    payment_type?: string;         // 'fiat' | 'web3_manual' | 'web3_wallet' | 'auto'
    notes?: string;                // Human-readable notes (logged, not used by PW)
}

