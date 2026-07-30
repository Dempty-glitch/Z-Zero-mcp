// ============================================================
// Z-ZERO Failure Taxonomy — single source of truth (v1)
//
// Every checkout failure MUST map to exactly one failure_class below.
// This enum is the schema for the labeled-event corpus (Primitive 2,
// docs/zzero_agent_primitives_30_07_26.md): labels cannot be assigned
// retroactively, so this file exists BEFORE the self-healing loop does.
//
// ⚠️ KEEP IN SYNC with z-zero-dashboard/src/lib/failure-taxonomy.ts
//    (two repos, no shared package — bump TAXONOMY_VERSION together).
// ============================================================

export const TAXONOMY_VERSION = 1;

/**
 * Fixed failure classes. Each has a detector (how it is recognized) and a
 * remediation (what the loop should try next time). Do NOT free-text new
 * classes — extend the enum and bump TAXONOMY_VERSION instead.
 */
export const FAILURE_CLASSES = [
    "card_declined_issuer",     // issuer/webhook decline → check velocity/MCC/funds
    "card_declined_bin_block",  // merchant rejects prepaid/virtual BIN → try different BIN
    "avs_mismatch",             // address verification failed → use real billing address
    "3ds_required",             // SCA challenge appeared → escalate request_human_approval
    "bot_detected",             // captcha / Cloudflare / "unusual activity" → new session, slow down
    "form_changed",             // selector not found / DOM changed → re-probe, update hints
    "price_changed",            // total differs from what was authorized → request new token/intent
    "out_of_stock",             // item unavailable at checkout → back to agent for new intent
    "shipping_unsupported",     // merchant can't ship to address → fail early, don't issue card
    "login_required",           // checkout requires an account → out of scope, report clearly
    "timeout",                  // page/flow timed out → check hints whether retry is safe
    "outcome_unconfirmed",      // submitted but no confirmation signal → verify before any retry
    "intent_mismatch",          // reserved for Primitive 1 (checkout page ≠ signed intent)
    "unknown",                  // catch-all — target of the weekly human-labeling pass
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Where in the checkout flow the failure happened. */
export const CHECKOUT_STEPS = [
    "preflight",   // before the browser touched the page (amount guard, balance, config)
    "navigate",    // opening the checkout URL
    "pre_steps",   // walking hints.pre_steps (shipping form, accordion, etc.)
    "fill_form",   // injecting card fields
    "submit",      // clicking Pay
    "confirm",     // waiting for / parsing the confirmation signal
] as const;

export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

/** Structured checkout event — one row per failed (or notable) run. */
export interface CheckoutEvent {
    url: string;
    failure_class: FailureClass;
    step?: CheckoutStep;
    raw_error_type?: string;      // original signal before mapping (bridge status, legacy string)
    error_message?: string;       // MUST be passed through redactCardData() first
    remediation_tried?: string;
    outcome?: "failed" | "recovered" | "aborted";
    labeled_by: "auto" | "agent" | "human";
    card_bin?: string;            // first 6 digits only — never more
    intent_id?: string;           // reserved for Primitive 1
    evidence_ref?: string;
}

// ------------------------------------------------------------
// Redaction — 🔴 redact at capture time, never after.
// Screenshots/DOM/HAR/messages must never contain PAN or CVV.
// ------------------------------------------------------------

/** Mask any 12–19 digit sequence (with optional space/dash separators) and CVV-looking patterns. */
export function redactCardData(text: string): string {
    if (!text) return text;
    return text
        // PAN: 12-19 digits, allowing spaces or dashes between groups
        .replace(/\b(?:\d[ -]?){12,19}\b/g, "[PAN_REDACTED]")
        // CVV mentioned next to a 3-4 digit number
        .replace(/\b(cvv|cvc|security code)\b\s*:?\s*\d{3,4}/gi, "$1 [REDACTED]");
}

/** First 6 digits of a PAN — safe to log (BIN is not cardholder data). */
export function extractBin(cardNumber: string | undefined): string | undefined {
    const digits = (cardNumber || "").replace(/\D/g, "");
    return digits.length >= 6 ? digits.slice(0, 6) : undefined;
}

// ------------------------------------------------------------
// Auto-classification of Playwright bridge outcomes.
// This is what turns today's traffic into labeled data without
// waiting for the agent to call report_checkout_fail.
// ------------------------------------------------------------

const BIN_BLOCK_RE = /prepaid|virtual card|this card type|card type (?:is )?not (?:accepted|supported)/i;
const AVS_RE = /billing address|address (?:verification|does not match|mismatch)|avs/i;
const THREEDS_RE = /3d[\s-]?secure|verified by visa|additional (?:verification|authentication)|authentication required/i;
const BOT_RE = /captcha|unusual activity|cloudflare|are you a robot|access denied|blocked/i;

/**
 * Map a bridge PaymentOutcome (+ message) to a failure_class + step.
 * Returns null for 'confirmed' (nothing to record as a failure).
 */
export function classifyBridgeResult(
    status: string,
    message?: string
): { failure_class: FailureClass; step: CheckoutStep } | null {
    const msg = message || "";
    switch (status) {
        case "confirmed":
            return null;
        case "declined":
            if (BIN_BLOCK_RE.test(msg)) return { failure_class: "card_declined_bin_block", step: "confirm" };
            if (AVS_RE.test(msg)) return { failure_class: "avs_mismatch", step: "confirm" };
            if (THREEDS_RE.test(msg)) return { failure_class: "3ds_required", step: "confirm" };
            return { failure_class: "card_declined_issuer", step: "confirm" };
        case "unconfirmed":
            return { failure_class: "outcome_unconfirmed", step: "confirm" };
        case "not_submitted":
            return { failure_class: "form_changed", step: "submit" };
        case "no_fields":
            if (BOT_RE.test(msg)) return { failure_class: "bot_detected", step: "navigate" };
            return { failure_class: "form_changed", step: "fill_form" };
        case "error":
            if (/timeout|timed out/i.test(msg)) return { failure_class: "timeout", step: "navigate" };
            if (BOT_RE.test(msg)) return { failure_class: "bot_detected", step: "navigate" };
            return { failure_class: "unknown", step: "navigate" };
        default:
            return { failure_class: "unknown", step: "navigate" };
    }
}

/**
 * Legacy string → enum map. Old published MCP versions (and old SOP text)
 * send free-text error_type; the backend uses this same map server-side.
 */
export const LEGACY_ERROR_TYPE_MAP: Record<string, FailureClass> = {
    field_not_found: "form_changed",
    timeout: "timeout",
    bot_blocked: "bot_detected",
    unknown_form: "form_changed",
    price_mismatch: "price_changed",
    other: "unknown",
};
