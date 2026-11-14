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

/**
 * Mask card numbers and CVVs in any text. Same function as
 * z-zero-dashboard/src/lib/failure-taxonomy.ts (keep the two in step).
 *
 * NFKC first: full-width digits (４２４２…) read as a card number to a human and
 * to anything downstream, but slip past an ASCII \d regex. Normalising folds
 * them to ASCII so one pattern catches both forms.
 *
 * A card number is 12–19 digits, however they are glued together: plain,
 * spaced, hyphenated, `id_4242…`, `4242.4242…`, double spaces, `%20`,
 * en-dashes (audit T07 F4, T19 T12-F9). Any digit run of that length with up
 * to three separator characters between digits, not touching another digit.
 *
 * What survives untouched: transaction hashes, UUIDs and other long hex
 * strings (they contain digit runs by chance), and any number under 12 digits.
 *
 * `cards: "any"` (default) masks every 12–19 digit run — right for error text
 * and anything handed to the model, where a stray number is worth nothing and
 * a leaked card is. `cards: "valid"` masks only runs that can BE a card number
 * (13–19 digits, first digit 2–6, Luhn passes) — for an order number whose
 * digits are the point.
 */
const PAN_SEPARATOR = String.raw`(?:%20|[\s._\-‐-―−]){0,3}`;
const PAN_OR_HEX = new RegExp(
    // group 1 = keep: a UUID, or 32+ hex characters with at least one letter
    String.raw`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![0-9a-f])(?=[0-9]*[a-f])[0-9a-f]{32,}(?![0-9a-f]))` +
    String.raw`|(?<!\d)\d(?:${PAN_SEPARATOR}\d){11,18}(?!\d)`,
    "gi",
);
// cvv=123 · "cvv":"123" · 'cvc': '123' · security_code: 123 · _cvv_123
const CVV_PAIR = new RegExp(
    String.raw`(?<![a-z0-9])(cvv2?|cvc2?|security[\s_-]?code)(?![a-z])(?:%20|%22|%3a|%3d|[\s"'=:_>-]){0,6}\d{3,4}(?!\d)`,
    "gi",
);

/** Luhn checksum — every real card number passes it; 9 in 10 random digit runs do not. */
function passesLuhn(digits: string): boolean {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (double) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}

export function redactCardData(text: string, opts: { cards?: "any" | "valid" } = {}): string {
    if (!text) return text;
    const validOnly = opts.cards === "valid";
    return text
        .normalize("NFKC")
        .replace(PAN_OR_HEX, (match: string, hex: string | undefined) => {
            if (hex) return match;
            if (validOnly) {
                // "%20" is a separator here, not two digits of the number.
                const digits = match.replace(/%20/gi, "").replace(/\D/g, "");
                if (digits.length < 13 || !/^[2-6]/.test(digits) || !passesLuhn(digits)) return match;
            }
            return "[PAN_REDACTED]";
        })
        .replace(CVV_PAIR, "$1 [REDACTED]");
}

/**
 * Remove THIS card's own values from a text — whatever is glued between the
 * digits — then run the general redaction. Used on every string the checkout
 * bridge hands back: the pattern above cannot know that a lone 3-digit number
 * is the CVV, but the bridge does.
 */
export function scrubCardValues(
    text: string,
    secrets: { number?: string; cvv?: string },
    opts: { cards?: "any" | "valid" } = {}
): string {
    if (!text) return text;
    let out = text.normalize("NFKC");
    const pan = (secrets.number || "").replace(/\D/g, "");
    if (pan.length >= 12) {
        out = out.replace(new RegExp(pan.split("").join("(?:%20|[^0-9]){0,3}"), "g"), "[PAN_REDACTED]");
    }
    const cvv = (secrets.cvv || "").replace(/\D/g, "");
    if (cvv.length >= 3) {
        out = out.replace(new RegExp(`(?<!\\d)${cvv}(?!\\d)`, "g"), "[REDACTED]");
    }
    return redactCardData(out, opts);
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
        case "blocked":
            return { failure_class: "intent_mismatch", step: "navigate" };
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
