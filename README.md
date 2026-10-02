# ARK Invest

One of the app's features lets you select ARK Invest ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/ark` static feed (ark-funds.com ETF pages and per-fund overview, NAV-history and performance JSON — official NAV returns, expenses, net assets and whole-life NAV/market-price history — plus the official daily holdings CSV files, with SEC EDGAR N-PORT-P and Yahoo Finance as fallbacks) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/ARK#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/ARK/>.

## Updating the static ARK Invest data

Run the updater with Bun:

```bash
bun test
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples.

Defaults live in `scripts/update-data.config.json` (every control as a string). Explicit environment variables override the file; an `ARK_<KEY>` alias (for example `ARK_CONCURRENCY`) wins over the plain `<KEY>` when both are set. The **Update ARK Invest ETF data** GitHub Actions workflow uses the same `resolveControls` resolver: individual `workflow_dispatch` inputs are blank by default and inherit the file, the `advanced` input accepts a JSON object with any control, and the precedence is file defaults < advanced JSON < nonblank individual inputs < protected Actions variable/env. GitHub allows at most 25 inputs, so controls without an individual input (see the workflow) are set through `advanced` (for example `{"VERBOSE":"true"}`). Scheduled runs have no inputs and use the file defaults. The real SEC contact belongs in the protected repository Actions variable `SEC_UA`, which wins when nonblank; the config default is `daggerok ETF feed daggerok@gmail.com`. An explicitly set environment variable wins even when empty (it clears the control), and invalid values fail with an error instead of falling back silently. All supplied filters use **AND** logic.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (the 14 ARK ETFs) | `https://www.ark-funds.com/our-etfs/` (the official [ETF overview page](https://www.ark-funds.com/our-etfs/); ARKVX, an interval fund, is excluded) |
| Fund facts per fund | `https://www.ark-funds.com/api/fund/overview/{ID}` (the JSON behind each fund page, e.g. [ARKK](https://www.ark-funds.com/funds/arkk); the page ID is discovered from the page at run time) |
| Holdings per fund | `https://assets.ark-funds.com/fund-documents/funds-etf-csv/{FUND}_HOLDINGS.csv` (the official daily holdings CSV linked from each fund page; ARKY uses a structured-note layout) |
| Daily history | `https://www.ark-funds.com/api/fund/nav-historical-change/{ID}` (official NAV and market-price history) |
| Returns | `https://www.ark-funds.com/api/fund/performance/{ID}` (official month-end and quarter-end NAV returns) |
| Distributions | Yahoo Finance chart API dividend events (ARK publishes no dividend-history endpoint) |
| Fallback | SEC EDGAR N-PORT-P (ARK ETF Trust, CIK 0001579982; Ark 21Shares Bitcoin ETF, CIK 0001869699) + Yahoo Finance chart API as fallbacks |

All issuer requests go directly to ark-funds.com with a short contact-bearing User-Agent (`daggerok ETF feed daggerok@gmail.com`). The site's Cloudflare WAF answers HTTP 403 to any User-Agent that contains a URL (the crawler-style `(+https://github.com/…)`) and challenges browser User-Agents sent from a non-browser TLS stack, so the updater deliberately uses neither. Only if two consecutive direct requests are still denied does it fall back to the read-only `r.jina.ai` reader for the remaining issuer requests (one `[ issuer   ]` notice; that reader is limited to roughly 20 requests per minute, so proxied requests are spaced 3 seconds apart across the whole run). A previously published fund page ID is reused when the overview endpoint confirms it still answers for the same ticker, which skips the heaviest page download on repeat runs; IDs are never hard-coded. Holdings CSVs, SEC EDGAR and Yahoo Finance are always fetched directly. A fund whose sources fail keeps its previously published data.

### Metrics and caveats

Each fund carries a derived `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` — official YTD and 1-year NAV returns → *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` — published annualized 3Y/5Y/10Y figures → *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` — cumulative 3Y/5Y/10Y figures `(1 + CAGR)^n - 1` → *TR 3Y/5Y/10Y*
- `siAnn` — since-inception annualized → *SI Ann.*
- `dividendYield` — indicated yield (latest Yahoo Finance distribution × inferred frequency ÷ market price) or trailing 12-month yield; `—` when no distributions are reported
- `secYield` — 30-day SEC yield when published on the fund page; `—` otherwise

- Official NAV returns come from ark-funds.com; market-price history and distribution-based yields come from Yahoo Finance and are estimates, not official figures
- Unavailable values are shown as `—` and are never written as `0`
- ARKVX (an interval fund) is excluded from the catalog; ARKY uses a structured-note holdings layout
- Each fund records its holdings source (official CSV or SEC EDGAR N-PORT-P fallback) and as-of date; a fund whose sources fail keeps its previously published data

### Update controls

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | all | Batch size: with a positive value the updater continues after the committed cursor in `api/ark/update-state.json`; empty or `0` is a full pass — every fund is refreshed in one run. |
| `REQUEST_SLEEP` | `1.5` | Minimum delay in seconds between request starts **within one worker**, including retries, for every provider (ark-funds.com, Azure holdings, Yahoo Finance, SEC EDGAR). Only the last-resort `r.jina.ai` fallback is additionally limited to one request every 3 seconds across all workers. |
| `CONCURRENCY` | `2` | Number of independent fund workers. Each worker owns its request lane, so `CONCURRENCY=15` starts 15 funds at once and total run time shrinks roughly in proportion. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `K`/`M`/`B`/`T`, or one of `nano`, `micro`, `small`, `mid`, `large`. |
| `TER` | `:` | Expense ratio range in % (strict `min:max`). |
| `DIVIDEND_YIELD` | `:` | Dividend-yield percentage range. |
| `SEC_YIELD` | `:` | 30-day SEC yield percentage range. |
| `CATEGORY` | all | Case-insensitive substring of the fund category, e.g. `Thematic`. |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `ARKK ARKW ARKG ARKB`. |
| `PERFORMANCE_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Official annualized NAV return ranges in %. |
| `TOTAL_RETURN_YTD` / `_1Y` / `_3Y` / `_5Y` / `_10Y` | `:` | Cumulative NAV total-return ranges in %. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page. |
| `MAX_RETRIES` | `2` | Retries after the initial request (integer >= 1). Only network errors (including the 90-second per-request timeout) and HTTP 408/425/429/5xx are retried with exponential backoff and `Retry-After`. |
| `HISTORY_RANGE` | `max` | `max` or `Ny` (for example `5y`): limits the Yahoo request window and the published daily-history rows to the last N years. |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC User-Agent; SEC policy requires automated tools to declare a contact. The protected `SEC_UA` Actions variable overrides it when nonblank. |
| `EDGAR_FALLBACK` | on | Set to `0`/`false` to disable the SEC EDGAR N-PORT-P holdings fallback. |
| `SKIP_ARK` | off | Do not request ark-funds.com; keep the fixed catalog and previously published official data and only run the fallbacks. |
| `SKIP_YAHOO` | off | Skip Yahoo Finance history and distribution updates. |
| `VERBOSE` | off | Print per-request retry and fallback notices. |

`TICKERS` combines with AUM, TER, yield and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Examples

```bash
MAX_FETCHES=3 bun scripts/update-data.ts
CONCURRENCY=15 bun scripts/update-data.ts
TICKERS="ARKK ARKW ARKG ARKB" bun scripts/update-data.ts
AUM="1B:" TER=":0.75" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" bun scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone — no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

Config, README and `--help` parity, workflow shape and parser checks all run as part of `bun test`.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs (Firestore data feed) | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com CSV downloads + Yahoo Finance | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT](./LICENSE) - same as all sibling ETF repositories

ARK®, ARK Invest® and the fund names/tickers referenced here are trademarks of ARK Investment Management LLC. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by ARK Investment Management LLC or ARK ETF Trust. All data is reproduced from ARK Invest's own public fund pages and downloads, public SEC EDGAR filings and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
