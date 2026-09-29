# ARK Invest isolated live acceptance — 2026-09-28

This records a successful real-network updater run for three representative ARK ETFs. The data is isolated evidence, **not** production `api/ark` data. No production API dataset or published seed existed in this branch, so the run began with a fresh API root in a temporary copy of the repository.

## Code and command

- Revision archived for the run: `38b371cbee6cf7349a47044c798329676641b528` (`docs(worklog): record Jina proxy correction`; updater fix is in `a700d2285d4c270d6c7c06d3b0d245d1a4f34863`).
- Temporary working copy: `/tmp/ark-live-acceptance-38b` (removed after copying the generated data into this evidence folder).
- Same CLI command was run three times against the same isolated API root. Runs 1 and 2 satisfy the required first/repeat run; run 3 was an additional before/after SHA-256 check.

```sh
env -i HOME=/home/user PATH=/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  TICKERS='ARKK ARKY ARKB' VERBOSE=1 MAX_FETCHES=0 REQUEST_SLEEP=1.5 \
  CONCURRENCY=2 MAX_RETRIES=2 \
  /home/user/.bun/bin/bun scripts/update-data.ts
```

Effective settings from every log: `TICKERS=ARKK,ARKY,ARKB`, `MAX_FETCHES=0`, `REQUEST_SLEEP=1.5`, `CONCURRENCY=2`, `MAX_RETRIES=2`, `SKIP_ARK=false`, `SKIP_YAHOO=false`, `EDGAR_FALLBACK=true`, `VERBOSE=true`; no static or metric filters were set. No provider-skip flags were enabled.

Log-file completion times (America/New_York): run 1 `21:07:02`, run 2 `21:07:51`, run 3 `21:09:00`. Each command exited `0`. Run 1 reported all three funds updated; run 2 and run 3 reported all three unchanged. Logs are `run-accepted-1.log`, `run-accepted-2.log`, and `run-accepted-3.log`.

## Results and source provenance

The official catalog page exposed all 14 supported ETF paths; the index retained the full 14-fund catalog and contains no unrequested fund directories. Dynamic fund IDs came from each official fund page at runtime (no permanent ID map). The issuer's direct requests returned HTTP 403; after two consecutive denials the updater switched once to the read-only Jina proxy. Jina raw HTML exposed the page IDs and Jina plain-text API responses were parseable. Holdings came from ARK's official Azure CSVs; NAV/market-price histories and performance came from ARK's official fund APIs. Yahoo was used only for distribution history; EDGAR fallback remained enabled but was not needed for these three holdings feeds.

| Ticker | Dynamic page ID | Official holdings rows | Official NAV/history rows | Distributions | Holdings as-of | History as-of |
|---|---:|---:|---:|---:|---|---|
| ARKK | 1004 | 46 | 2,992 | 7 (Yahoo events) | 2026-09-28 (CSV date column) | 2026-09-25 |
| ARKY | 1015 | 47 | 27 | 0 (Yahoo returned none) | 2026-09-28 (Azure `Last-Modified`; CSV has no date column) | 2026-09-25 |
| ARKB | 1010 | 1 | 679 | 0 (Yahoo returned none) | 2026-09-28 (CSV date column) | 2026-09-25 |

All three manifests reference official overview, daily-history, and performance endpoints; each explicitly labels Yahoo as the dividend/distribution source. The generated `index.json` reports 14 catalog entries, 94 holdings rows, and 3,698 history rows. The isolated API tree contains 12 valid JSON files totaling 545,676 bytes; its generated directory set is exactly `ARKK`, `ARKY`, and `ARKB`.

## Byte-stability check

The third run was bracketed by full-tree SHA-256 manifests, `hashes-before-run3.txt` and `hashes-after-run3.txt`. `diff -u` returned no differences: all 12 files (545,676 bytes) matched byte-for-byte, including the index and metadata. `hashes-accepted-api.txt` records the persistent evidence copy; it was verified byte-identical to the temporary run output.

The successful generated API is preserved at `accepted-api/ark/`. The earlier unsuccessful diagnostic attempt remains clearly separate at `run-1.log` and `diagnostic-output/api/ark/`; it used the prior Markdown-only proxy behavior and is not part of this accepted dataset.
