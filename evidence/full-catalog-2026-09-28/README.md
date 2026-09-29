# Full-catalog live acceptance — 2026-09-28 (America/New_York)

Unfiltered 14-fund runs of `scripts/update-data.ts` executed in fresh, isolated
copies (`git archive <rev> scripts package.json bun.lock`) with no API seed.
Command for every run:

```
env -i HOME=/home/user PATH=/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  VERBOSE=1 /home/user/.bun/bin/bun scripts/update-data.ts
```

Effective config (printed in each log): `TICKERS=all`, `MAX_FETCHES=0`,
`REQUEST_SLEEP=1.5`, `CONCURRENCY=2`, `MAX_RETRIES=2`, `SKIP_ARK=false`,
`SKIP_YAHOO=false`, `EDGAR_FALLBACK=true`, no metric filters. Bun 1.4.2.

| File | Revision | Result |
| --- | --- | --- |
| `run-diagnostic-1-d9563e7.log` | `d9563e7` | exit 0, 14 updated / 0 failures, **but** r.jina.ai HTTP 429 (keyless ~20 RPM limit) degraded ARKT (no page ID/overview, Yahoo history), ARKY + PRNT (month-end performance) and IZRL (history → Yahoo). Diagnostic only; output not published. |
| `run-accepted-1-4d3e8c8.log` | `4d3e8c8` | exit 0, 14 updated / 0 failures, 0 × HTTP 429, all 14 funds with official page ID, overview, NAV/market-price history and performance provenance. 03:22:48–03:26:20 UTC. |
| `run-accepted-2-4d3e8c8.log` | `4d3e8c8` | exit 0, all 14 `unchanged`, 0 × HTTP 429. 03:26:35–03:30:07 UTC. |
| `hashes-after-run1.txt` / `hashes-after-run2.txt` | `4d3e8c8` | SHA-256 of all 59 output files after each accepted run; `diff` is empty (byte-identical repeat, no timestamp churn). |
| `hashes-published-api.txt` | `4d3e8c8` | SHA-256 of the committed `api/ark` tree; identical to `hashes-after-run2.txt`. |

Accepted output: 59 files, 3,011,864 bytes; index counts `14 funds · 416
holdings rows · 21,413 history rows`; `api/ark/index.json` SHA-256
`4970b84362a8b8b8e915bd8bcf646b7655af4f2a0918daceda252f49fe5b7181`.

Per-fund history / holdings / distributions (accepted runs): ARKB 679/1/0,
ARKD 184/4/0, ARKE 61/5/0, ARKF 1922/44/3, ARKG 2992/33/5, ARKI 123/5/0,
ARKK 2992/46/7, ARKQ 3015/38/6, ARKT 248/5/1, ARKW 3015/43/6, ARKX 1380/35/0,
ARKY 27/47/0, IZRL 2213/66/5, PRNT 2562/44/7. Official page IDs discovered at
runtime: ARKQ 1001, ARKW 1002, ARKG 1003, ARKK 1004, PRNT 1005, IZRL 1006,
ARKF 1007, ARKX 1008, ARKB 1010, ARKT 1011, ARKD 1012, ARKI 1013, ARKE 1014,
ARKY 1015.

Provider notes recorded honestly:

- Direct `ark-funds.com` requests returned two consecutive HTTP 403 responses
  in every run; the updater printed one `[ issuer   ]` notice and routed the
  remaining issuer page/API requests through the read-only `r.jina.ai` proxy
  (raw HTML for pages, plain text for `/api/` JSON). Holdings CSVs (Azure Blob)
  and Yahoo Finance were fetched directly.
- ARKF's official holdings CSV is dated 2026-01-02 (270 days old at run time);
  the updater keeps the source date and warns instead of treating HTTP 200 as
  freshness.
- Distributions come from Yahoo Finance chart dividend events only (ARK
  publishes no dividend-history API). EDGAR N-PORT fallback was enabled but not
  needed because every official CSV succeeded.
- History as-of date is 2026-09-25 (last trading day before the run) for all
  funds; holdings as-of date is 2026-09-28 except ARKF (above).
