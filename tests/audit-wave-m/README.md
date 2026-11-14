# Audit wave M tests (MCP 1.11.0)

Each test reproduces a finding from the November 2026 audit (T11–T14, T19, T00) and
checks it is gone. Same tests run against any build, so the old behaviour can be
shown failing and the new one passing:

```bash
npm run build && bash tests/audit-wave-m/run.sh                 # this tree
ZZ_TARGET=/path/to/other/z-zero-mcp bash tests/audit-wave-m/run.sh   # another build (needs its own dist/ + node_modules)
bash tests/audit-wave-m/run.sh m2_domain_lock                   # one file
```

What runs:
- the real MCP server build (`dist/`), driven by an MCP client over an in-memory pipe;
- real Chromium (the Playwright cache), whose traffic goes through a local proxy so a page
  at `https://meanblvd.com/` is served from this machine on what the browser sees as the
  default port (`harness/sites.mjs`);
- a fake Z-ZERO API on 127.0.0.1 that hands out the public test card 4242 4242 4242 4242
  (`harness/fake-api.mjs`);
- a fresh fake `HOME` per process — never the real `~/.z-zero`.

Nothing leaves the machine: `run.sh` wraps everything in `sandbox-exec` with outbound
network denied except loopback, and `harness/net-guard.mjs` refuses (and records) any
socket or `fetch` to a non-local host.

| File | Item |
|---|---|
| `m0_smoke` | a normal checkout still pays |
| `m1_pan_never_leaves` | M.1 card number never in a tool result, `receipt_id` or receipt |
| `m2_domain_lock` | M.2 page moved after the lock, frames, hidden fields, http/port/`*.localhost`, `*.myshopify.com`, parent domain |
| `m3_autopay_ceiling` | M.3 `max_amount` required; visible-text price only; commas; other currencies |
| `m4_key_rotation` | M.4 config key rotated on connect; `set_api_key` rotate-first, same-account only; newer config key wins |
| `m5_api_base` | M.5 custom API address needs `Z_ZERO_ALLOW_CUSTOM_API=1` and never gets the stored key |
| `m6_m7_m8_m9` | M.6 no on-chain send · M.7 visible-text confirmation, untrusted page text fenced, `iframe_selector` · M.8 cancel when the card cannot be fetched · M.9 SDK version |
