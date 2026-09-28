# Public-source parser fixtures

Snapshots were collected on 2026-09-28 and are used only by offline unit tests; tests never make network requests.

- `arkk-holdings-2026-09-28.csv` — official daily holdings CSV: <https://assets.ark-funds.com/fund-documents/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv>
- `arky-holdings-2026-09-28.csv` — official structured-note holdings CSV: <https://assets.ark-funds.com/fund-documents/funds-etf-csv/ARK_ACTIVE_AUTOCALLABLE_INCOME_ETF_ARKY_HOLDINGS.csv>. This source intentionally has no date column; the updater uses the Azure `Last-Modified` header for the manifest date.
- `arkk-overview-2026-09-28.json` — official overview API response for page ID 1004, discovered from the ARKK fund page: <https://www.ark-funds.com/api/fund/overview/1004>
- `arkk-performance-month-end-2026-09-28.json` and `arkk-performance-quarter-end-2026-09-28.json` — official performance API responses for page ID 1004. The requests use `Range=month-end` and `Range=quarter-end`, respectively, plus `Tab=tab-annualized`, `ExcludeMarketPrice=False`, and `DisplayReturnCharge=False`.
- `arkk-nav-history-sample-2026-09-28.json` — first two and last two rows sampled from the official daily NAV/market-price API response for page ID 1004: <https://www.ark-funds.com/api/fund/nav-historical-change/1004?headingText=NAV%20Historical%20Change&overviewText=NAV%20and%20Market%20Price>. The live response had 2,992 rows; the smaller fixture keeps the repository compact.

The ARKY parser test adds an artificial `101.25%` source weight to ensure the provider's value is never clamped; the value is synthetic test input, not part of the dated CSV snapshot.
