#!/usr/bin/env bun
/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARK_FUNDS,
  ARKY_HOLDINGS_HEADERS,
  CONTROL_NAMES,
  DEFAULT_SEC_UA,
  HOLDINGS_HEADERS,
  ISSUER_PROXY_MIN_INTERVAL_MS,
  ISSUER_USER_AGENT,
  OFFICIAL_RETURNS_BASIS,
  REQUEST_TIMEOUT_MS,
  RUN_SOFT_DEADLINE_MS,
  UNAVAILABLE_RETURNS_BASIS,
  USAGE,
  YAHOO_RETURNS_BASIS,
  annualizedFromCumulative,
  arkApiUrls,
  buildFundMetrics,
  resolveYieldBasis,
  yieldBasisFromKind,
  buildOfficialReturns,
  buildPageEnvelope,
  buildYahooReturns,
  createPacedGate,
  createRequestClients,
  createSecFallbackResolver,
  cumulativeFromAnnualized,
  detectUnlistedArkFunds,
  displayDate,
  edgarSeriesFilingsUrl,
  extractFundPageId,
  formatDistributionFrequency,
  historyWindowStartEpoch,
  inferDistributionFrequency,
  installSystemCa,
  isCertError,
  isoStamp,
  jinaReaderUrl,
  main,
  mergeHistoryRows,
  nportToHoldings,
  nportUrlFor,
  numberOrNull,
  pageFileName,
  parseAumRange,
  parseArkCatalogHtml,
  parseArkCatalogSlugs,
  parseArkHoldingsCsv,
  parseArkNavHistory,
  parseArkOverview,
  parseArkPerformance,
  parseCompanyTickerMap,
  parseCsv,
  parseEdgarAtomFilings,
  parseFundTickerMap,
  parseNportAccessions,
  parseNportXml,
  parseProviderJson,
  parseRange,
  parseYahooChart,
  passesMetricFilters,
  passesStaticFilters,
  paymentsPerYear,
  readConfig,
  resolveControls,
  resolveReturnMetrics,
  runUpdater,
  semanticContentKey,
  splitPages,
  stableStringify,
  toIsoDate,
  trailingDividendYield,
  unwrapJinaReaderText,
  updateArkFund,
  withRequestLane,
  writeFileAtomic,
  writeIfChanged,
  writeJsonIfChanged,
  yahooChartProvenanceUrl,
  yahooChartUrl,
} from './update-data';

// ---------------------------------------------------------------------------
// Inline samples of the official ARK payloads (no fixtures, no network)
// ---------------------------------------------------------------------------
const overviewSample: unknown = {
  feesView: '<div><div class="b-fees__item"><div class="b-fees__item-top"><b>TOTAL FEES</b><span>0.75%</span></div></div></div>',
  detailsView: '<ul><li>TICKER <span>ARKK</span></li><li>NET ASSETS <span>$5,562 Million</span></li><li>TYPE <span>Active Equity ETF</span></li>' +
    '<li>CUSIP <span>00214Q104</span></li><li>ISIN <span>US00214Q1040</span></li><li>PRIMARY EXCHANGE <span>Cboe BZX</span></li>' +
    '<li>INCEPTION DATE <span>10/31/2014</span></li><li>EXPENSE RATIO <span>0.75%</span></li></ul>',
  formattedDate: 'As of 08/31/2026',
};
const navHistorySample: unknown = {
  chartData: [
    { nav: 20.12, marketPrice: 20.38, epochDateMilliSeconds: 1414713600000 },
    { nav: 20.11, marketPrice: 20.38, epochDateMilliSeconds: 1414972800000 },
    { nav: 91.71, marketPrice: 91.7, epochDateMilliSeconds: 1790226000000 },
    { nav: 90.78, marketPrice: 90.77, epochDateMilliSeconds: 1790312400000 },
  ],
};
const performanceSample = (asOf: string, annualized: string[], cumulative: string[]): unknown => {
  const table = (id: string, heads: string[], values: string[]): string =>
    `<div class="tab-pane" id="${id}"><table><thead><tr><td>ARKK</td>${heads.map((h) => `<td>${h}</td>`).join('')}</tr></thead>` +
    `<tbody><tr><td>NAV</td>${values.map((v) => `<td>${v}</td>`).join('')}</tr></tbody></table></div>`;
  return {
    ticker: 'ARKK',
    view: `<div class="b-date__text">As of ${asOf}</div>` +
      table('tab-annualized', ['1 Year', '3 Years', '5 Years', '10 Years', 'Since Inception'], annualized) +
      table('tab-cumulative', ['1 Months', '3 Months', 'YTD', 'Since Inception'], cumulative) +
      table('tab-calendar-year', ['2025 Year'], ['35.58%']),
  };
};
const monthPerformanceSample = performanceSample('08/31/2026', ['14.07%', '25.02%', '-6.70%', '16.15%', '13.98%'], ['20.20%', '4.37%', '11.13%', '370.38%']);
const quarterPerformanceSample = performanceSample('06/30/2026', ['14.82%', '22.29%', '-9.05%', '16.16%', '13.63%'], ['-1.53%', '19.45%', '4.85%', '343.82%']);
const DISCLAIMER = '"Investors should carefully consider the investment objectives and risks of an ARK ETF before investing. ""NAV"" may differ from market price."';
const arkkCsv = [
  'date,fund,company,ticker,cusip,shares,market value ($),weight (%)',
  '09/28/2026,ARKK,TESLA INC,TSLA,88160R101,"2,141,056","$796,708,348.16",9.12%',
  '09/28/2026,ARKK,SPACE EXPLORATION TECHN-CL A,SPCX,84615Q103,"3,514,048","$522,468,656.64",5.98%',
  '09/28/2026,ARKK,BRERA HOLDINGS PLC WTS,,BREADUMMY,"431,626","$936,627.77",0.01%',
  DISCLAIMER,
].join('\r\n');
const arkyCsv = [
  'position,cusip,$ notional per note,market value ($),market weight (%)',
  'GOLDMAN FS TRSY OBLIG INST 468,X9USDGSFT,"35,922,746","$35,922,745.78",86.13%',
  'TREASURY BILL 0 8/5/2027,912797VR5,"4,900,000","$4,718,634.73",11.31%',
  'BMNR Autocall ELN LONG TRS 31.22 PA 10/18/2027,1740056,"800,000","$136,407.00",0.33%',
].join('\r\n') + '\r\n';

// ---------------------------------------------------------------------------
// Pipeline helpers: a mocked provider and a per-test temp root
// ---------------------------------------------------------------------------
type Scenario = {
  csv?: string | Error;
  month?: unknown;
  quarter?: unknown;
  history?: unknown;
  yahooPoints?: number | Error;
  firstTrade?: string;
  dividends?: Record<string, { date: number; amount: number }>;
};
const DAY_MS = 86_400_000;
const REF = new Date('2026-09-28T12:00:00Z');
const navPoints = (count: number, end = '2026-09-25'): unknown => ({
  chartData: Array.from({ length: count }, (_, index) => ({ nav: 50 + index * 0.01, marketPrice: 50 + index * 0.01, epochDateMilliSeconds: Date.parse(`${end}T00:00:00Z`) - (count - 1 - index) * DAY_MS })),
});
const yahooPayload = (count: number, firstTrade = '2014-10-31', dividends: Scenario['dividends'] = {}): unknown => ({
  chart: {
    result: [{
      timestamp: Array.from({ length: count }, (_, index) => Math.floor((Date.parse('2026-09-25T00:00:00Z') - (count - 1 - index) * DAY_MS) / 1000)),
      indicators: { quote: [{ close: Array.from({ length: count }, (_, index) => 50 + index * 0.01), volume: Array.from({ length: count }, () => 1) }], adjclose: [{ adjclose: Array.from({ length: count }, (_, index) => 50 + index * 0.01) }] },
      events: { dividends },
      meta: { regularMarketPrice: 60, firstTradeDate: Math.floor(Date.parse(`${firstTrade}T00:00:00Z`) / 1000) },
    }],
    error: null,
  },
});
const csvAt = (date: string): string => ['date,fund,company,ticker,cusip,shares,market value ($),weight (%)', `${date},ARKK,TESLA INC,TSLA,88160R101,"2","$3",9%`].join('\r\n');
const respondWith = (text: string, url: string, headers: Record<string, string> = {}) => ({ text, url, headers: new Headers(headers) });
const clientsFor = (scenario: Scenario = {}) => ({
  ark: async (url: string) => {
    if (url.endsWith('/funds/arkk')) return respondWith('url: "/api/fund/overview/1004"', url);
    if (url.includes('/api/fund/overview/')) return respondWith(JSON.stringify(overviewSample), url);
    if (url.includes('/api/fund/nav-historical-change/')) return respondWith(JSON.stringify(scenario.history ?? navHistorySample), url);
    if (url.includes('/api/fund/performance/')) {
      const quarter = new URL(url).searchParams.get('Range') === 'quarter-end';
      return respondWith(JSON.stringify(quarter ? scenario.quarter ?? quarterPerformanceSample : scenario.month ?? monthPerformanceSample), url);
    }
    throw new Error(`unexpected ARK URL: ${url}`);
  },
  azure: async (url: string) => {
    if (scenario.csv instanceof Error) throw scenario.csv;
    return respondWith(scenario.csv ?? arkkCsv, url, { 'last-modified': 'Mon, 28 Sep 2026 06:05:47 GMT' });
  },
  yahoo: async (url: string) => {
    if (scenario.yahooPoints instanceof Error) throw scenario.yahooPoints;
    return respondWith(JSON.stringify(yahooPayload(scenario.yahooPoints ?? 4, scenario.firstTrade, scenario.dividends)), url);
  },
  sec: async (url: string) => { throw new Error(`unexpected SEC URL: ${url}`); },
  isArkProxyActive: () => false,
});
const arkkFund = ARK_FUNDS.find((fund) => fund.ticker === 'ARKK')!;
// readConfig rejects MAX_RETRIES < 1; tests that must not retry zero it on the parsed config
const quietConfig = (env: Record<string, string> = {}) => ({ ...readConfig({ REQUEST_SLEEP: '0', ...env }), maxRetries: 0 });
const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));
const withTempRoot = async (work: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'ark-test-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const quiet = { onNote: () => undefined, onWarn: () => undefined };
const update = (root: string, scenario: Scenario, env: Record<string, string> = {}, extra: Record<string, unknown> = {}, warns: string[] = []) =>
  updateArkFund(arkkFund, quietConfig(env), clientsFor(scenario), { apiRoot: root, referenceDate: REF, onNote: () => undefined, onWarn: (message) => warns.push(message), ...extra });
const run = (root: string, env: Record<string, string>, clients = clientsFor({})) =>
  runUpdater({ config: quietConfig(env), apiRoot: root, clients, referenceDate: REF, ...quiet });
const oldNport = (repPdDate: string) => async () => ({
  parsed: { repPdDate, positions: [], regCik: '', seriesName: '', seriesId: '', netAssets: null },
  accessions: [],
  selected: { accession: 'acc', filed: repPdDate, reportDate: repPdDate, url: 'https://example.test/primary_doc.xml' },
  holdings: [{ Name: 'N-PORT CO', Ticker: 'NPT', Identifier: '1', Weight: '1%', 'Market Value': '1', 'Shares Held': '1', 'Asset Category': 'Equity' }],
});
const metaOf = (root: string) => readJson(join(root, 'funds', 'ARKK', 'meta.json'));
// a hung promise would stall the whole run: fail instead (the guard is far above any provider timeout used here)
const guarded = <T>(promise: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('test guard: request never settled')), ms))]);
const SKIP_ALL = { SKIP_ARK: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0' };

// ---------------------------------------------------------------------------
// Clean, portable environment for every test: no exported control variables,
// pinned time zone, restored fetch and exit code
// ---------------------------------------------------------------------------
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const isControlVariable = (key: string): boolean =>
  (CONTROL_NAMES as readonly string[]).includes(key) || key.startsWith('ARK_') || ['HISTORICAL_PAGE_SIZE', 'GITHUB_STEP_SUMMARY', 'PROTECTED_SEC_UA', 'TZ'].includes(key);

beforeEach(() => {
  savedEnv.clear();
  for (const key of Object.keys(process.env)) if (isControlVariable(key)) { savedEnv.set(key, process.env[key]); delete process.env[key]; }
  savedEnv.set('TZ', process.env.TZ);
  process.env.TZ = 'UTC';
});
afterEach(() => {
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  globalThis.fetch = originalFetch;
  process.exitCode = 0;
});

describe('controls', () => {
  const file = JSON.parse(readFileSync(new URL('./update-data.config.json', import.meta.url), 'utf8'));

  test('precedence: file < advanced < nonblank input < env < protected SEC_UA; an explicit empty env clears', () => {
    const merged = resolveControls({ CONCURRENCY: 2, TICKERS: 'ARKK' }, { CONCURRENCY: 3, TICKERS: 'ARKQ' }, { CONCURRENCY: '4', TICKERS: '' }, { ARK_CONCURRENCY: '5', CONCURRENCY: '6' });
    expect(merged.CONCURRENCY).toBe('5');
    expect(merged.TICKERS).toBe('ARKQ'); // blank input does not clear the advanced value
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'ARKK' }, {}, { TICKERS: 'ARKW' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
    expect(readConfig(resolveControls({ CATEGORY: 'Thematic' })).category).toBe('Thematic');
  });

  test('strict validation: bad values, layers, CR/LF/NUL, unknown tickers and ranges are errors, never fallbacks', () => {
    const bad: unknown[] = [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\rfoo' }, { SEC_UA: 'x\0bad' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 },
      { MAX_RETRIES: 'x' }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { AUM: '1:2:3' }, { TER: '5:1' },
      { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' }, { TICKERS: ['ARKK'] }, null, []];
    for (const value of bad) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls(file, 'x')).toThrow();
    expect(() => resolveControls(file, {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => resolveControls({}, {}, {}, { ARK_SEC_UA: 'x\0bad' })).toThrow();
    expect(() => readConfig({ MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    expect(readConfig(resolveControls({ MAX_RETRIES: 1 })).maxRetries).toBe(1);
    expect(() => readConfig({ TICKERS: 'ARKK NOPE' })).toThrow('NOPE');
    expect(() => resolveControls({}, {}, {}, { TICKERS: 'ARKK ZZZZ' })).toThrow('ZZZZ');
  });

  test('brand env aliases: ARK_ prefix and the legacy HISTORICAL_PAGE_SIZE', () => {
    expect(resolveControls({ HISTORY_PAGE_SIZE: '1000' }, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500', ARK_HISTORY_PAGE_SIZE: '300' }).HISTORY_PAGE_SIZE).toBe('300');
    expect(() => resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '0' })).toThrow('HISTORY_PAGE_SIZE');
  });

  test('defaults: the scheduled path equals the config file, keys match CONTROL_NAMES and --help', () => {
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    expect(resolveControls(file, {}, {}, {})).toEqual(Object.fromEntries(Object.entries(file).map(([k, v]) => [k, String(v)])));
    const config = readConfig(resolveControls(file));
    expect(config).toMatchObject({ tickers: [], maxFetches: 0, requestSleepSeconds: 1.5, concurrency: 2, maxRetries: 2, historyRange: 'max', edgarFallback: true, secUa: DEFAULT_SEC_UA });
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(DEFAULT_SEC_UA).toBe(file.SEC_UA);
    for (const v of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(resolveControls({ USE_SYSTEM_CA: v }).USE_SYSTEM_CA).toBe(v.toLowerCase());
    expect(file.USE_SYSTEM_CA).toBe('auto');
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
      expect(USAGE).toContain(tenor ? `${tenor[1]}_YTD|1Y|3Y|5Y|10Y` : name);
    }
  });

  test('ranges and filters: exact parsing, AND semantics, a bounded return excludes funds without that figure', () => {
    const config = readConfig({
      TICKERS: 'arkk, ARKY ARKB', CATEGORY: 'Equity', REQUEST_SLEEP: '2.25', CONCURRENCY: '3', MAX_FETCHES: '4',
      AUM: '1B:', TER: ':0.75', PERFORMANCE_3Y: '10:30', TOTAL_RETURN_5Y: '-50:100', EDGAR_FALLBACK: '0',
    });
    expect(config).toMatchObject({ tickers: ['ARKK', 'ARKY', 'ARKB'], category: 'Equity', requestSleepSeconds: 2.25, concurrency: 3, maxFetches: 4, edgarFallback: false });
    expect(config.aumRange).toMatchObject({ min: 1_000_000_000, max: Number.POSITIVE_INFINITY });
    expect(config.terRange?.max).toBe(0.75);
    expect(config.performanceRanges['3Y']?.min).toBe(10);
    expect(config.totalReturnRanges['5Y']?.min).toBe(-50);
    expect(parseRange('', 'TER')).toBeUndefined();
    expect(parseRange(':', 'TER')).toBeUndefined();
    expect(parseRange('1%:4%', 'TER')).toMatchObject({ min: 1, max: 4 });
    expect(() => parseRange('5:1', 'TER')).toThrow('minimum exceeds maximum');
    expect(() => parseRange('1:2:3', 'TER')).toThrow('exactly one colon');
    expect(parseAumRange('micro')).toMatchObject({ min: 10_000_000, max: 300_000_000 });
    expect(parseAumRange('small:large')).toMatchObject({ min: 300_000_000, max: Number.POSITIVE_INFINITY });

    const filters = readConfig({ TICKERS: 'ARKK ARKY', CATEGORY: 'equity', AUM: '1B:', TER: ':1', PERFORMANCE_3Y: '10:30' });
    expect(passesStaticFilters(ARK_FUNDS.find((fund) => fund.ticker === 'ARKK')!, filters)).toBe(true);
    expect(passesStaticFilters(ARK_FUNDS.find((fund) => fund.ticker === 'ARKY')!, filters)).toBe(false);
    const entry = { aumValue: 2_000_000_000, terValue: 0.75, metrics: { dividendYield: null, secYield: null, tr1y: 12, cagr3y: null }, returns: { monthEnd: { ytd: 5, yr1: 12, yr3: null } } };
    expect(passesMetricFilters(entry, filters)).toBe(false); // young fund: no 3Y figure is excluded, not waved through
    const withThreeYear = { ...entry, metrics: { ...entry.metrics, cagr3y: 20 }, returns: { monthEnd: { ytd: 5, yr1: 12, yr3: 20 } } };
    expect(passesMetricFilters(withThreeYear, filters)).toBe(true);
    expect(passesMetricFilters({ ...withThreeYear, aumValue: 500_000_000 }, filters)).toBe(false);
    expect(passesMetricFilters({ ...entry, metrics: { ...entry.metrics, cagr3y: 35 } }, filters)).toBe(false);
    expect(passesMetricFilters({ ...entry, metrics: { ...entry.metrics, tr3y: null } }, readConfig({ TOTAL_RETURN_3Y: '0:' }))).toBe(false);
    expect(passesMetricFilters(entry, readConfig({}))).toBe(true); // an unbounded range keeps funds without the figure
  });
});

describe('parsing', () => {
  test('catalog: 14 official ETFs without ARKVX, supported paths only, page id parsed, unlisted funds detected', () => {
    expect(ARK_FUNDS.map((fund) => fund.ticker)).toEqual(['ARKB', 'ARKD', 'ARKE', 'ARKF', 'ARKG', 'ARKI', 'ARKK', 'ARKQ', 'ARKT', 'ARKW', 'ARKX', 'ARKY', 'IZRL', 'PRNT']);
    const html = '<a href="/funds/arkk">ARKK</a><a href="/funds/arkvx">Venture</a><a href="/funds/arky/">ARKY</a><a href="/funds/arkz">ARKZ</a><a href="/funds/arkk">dup</a>';
    expect(parseArkCatalogHtml(html).map((fund) => fund.ticker)).toEqual(['ARKK', 'ARKY']);
    expect(parseArkCatalogHtml('<html>no ETF links</html>')).toEqual([]);
    expect(parseArkCatalogSlugs(html)).toEqual(['ARKK', 'ARKVX', 'ARKY', 'ARKZ']);
    expect(detectUnlistedArkFunds(html)).toEqual(['ARKZ']);
    expect(extractFundPageId('<script>url: "/api/fund/overview/1004"</script>')).toBe('1004');
    expect(extractFundPageId('<html>no endpoint</html>')).toBeNull();
  });

  test('overview and NAV history: issuer facts, scaled net assets, fee fallback, sorted points with premium/discount', () => {
    expect(parseArkOverview(overviewSample)).toMatchObject({
      ticker: 'ARKK', netAssets: 5_562_000_000, netAssetsText: '$5,562 Million', fundType: 'Active Equity ETF', cusip: '00214Q104',
      isin: 'US00214Q1040', exchange: 'Cboe BZX', inceptionDate: '2014-10-31', expenseRatio: 0.75, asOfDate: '2026-08-31',
    });
    const fallback = parseArkOverview({
      detailsView: '<ul><li>TICKER <span>TEST</span></li><li>NET ASSETS <span>$10 Million</span></li></ul>',
      feesView: '<div><b>TOTAL FEES</b><span>0.40%</span></div>',
      formattedDate: 'As of 9/30/2026',
    });
    expect(fallback).toMatchObject({ expenseRatio: 0.4, asOfDate: '2026-09-30', netAssets: 10_000_000 });
    const rows = parseArkNavHistory(navHistorySample);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ date: '2014-10-31', nav: 20.12, marketPrice: 20.38, premiumDiscount: 1.2922 });
    expect(rows.at(-1)).toMatchObject({ date: '2026-09-25', nav: 90.78, marketPrice: 90.77 });
  });

  test('performance: month-end and quarter-end tables, reordered headings, zero stays 0 and a dash becomes null', () => {
    const month = parseArkPerformance(monthPerformanceSample);
    const quarter = parseArkPerformance(quarterPerformanceSample);
    expect(month).toMatchObject({ ticker: 'ARKK', asOfDate: '2026-08-31' });
    expect(month.navAnnualized).toMatchObject({ '1Y': 14.07, '3Y': 25.02, '5Y': -6.7, '10Y': 16.15, SI: 13.98 });
    expect(month.navCumulative).toMatchObject({ YTD: 11.13, SI: 370.38 });
    expect(quarter.asOfDate).toBe('2026-06-30');
    const returns = buildOfficialReturns(month, quarter);
    expect(returns.monthEnd).toMatchObject({ asOfDate: 'Aug 31 2026', ytd: 11.13 });
    expect(returns.quarterEnd.asOfDate).toBe('Jun 30 2026');
    expect(returns.metrics).toMatchObject({ cagr3y: 25.02, tr3y: cumulativeFromAnnualized(25.02, 3), performanceAsOf: '2026-08-31' });
    expect(returns.metrics.returnsBasis).toContain('official ARK Invest');

    const odd = parseArkPerformance({
      ticker: 'TEST',
      view: '<div class="b-date__text">As of 06/30/2026</div>' +
        '<div id="tab-annualized"><table><tr><td>TEST</td><td>5 Years</td><td>1 Year</td><td>3 Years</td></tr>' +
        '<tr><td>NAV</td><td>0.00%</td><td>-2.5%</td><td>—</td></tr></table></div>' +
        '<div id="tab-cumulative"><table><tr><td>TEST</td><td>YTD</td><td>Since Inception</td></tr>' +
        '<tr><td>NAV</td><td>0.00%</td><td>10.00%</td></tr></table></div>' +
        '<div id="tab-calendar-year"><table><tr><td>TEST</td><td>2025 Year</td></tr><tr><td>NAV</td><td>0.00%</td></tr></table></div>',
    });
    expect(odd.navAnnualized['5Y']).toBe(0);
    expect(odd.navAnnualized['1Y']).toBe(-2.5);
    expect(odd.navAnnualized['3Y']).toBeNull();
    expect(odd.navCumulative.YTD).toBe(0);
    expect(odd.navCalendar['2025']).toBe(0);
  });

  test('holdings CSV: RFC-4180 quirks, standard and ARKY layouts, >100% weights kept, malformed files rejected', () => {
    expect(parseCsv('﻿name,shares\r\n"A, B Inc.","1,234"\r\n"The ""Quoted"" Co",2\r\n')).toEqual([['name', 'shares'], ['A, B Inc.', '1,234'], ['The "Quoted" Co', '2']]);
    expect(() => parseCsv('name,value\n"unterminated,1')).toThrow('unterminated');
    const standard = parseArkHoldingsCsv(arkkCsv, 'ARKK');
    expect(standard.headers).toEqual([...HOLDINGS_HEADERS]);
    expect(standard).toMatchObject({ totalRows: 3, asOfDate: '2026-09-28' }); // the trailing legal disclaimer is not a row
    expect(standard.rows[0]).toMatchObject({ Name: 'TESLA INC', Ticker: 'TSLA', Identifier: '88160R101', Weight: '9.12%', 'Market Value': '$796,708,348.16', 'Shares Held': '2,141,056', 'Asset Category': 'Equity' });
    const arky = parseArkHoldingsCsv(arkyCsv, 'ARKY', 'Mon, 28 Sep 2026 06:05:49 GMT');
    expect(arky.headers).toEqual([...ARKY_HOLDINGS_HEADERS]);
    expect(arky).toMatchObject({ totalRows: 3, asOfDate: '2026-09-28' });
    expect(arky.rows[0]).toMatchObject({ Name: 'GOLDMAN FS TRSY OBLIG INST 468', Identifier: 'X9USDGSFT', 'Shares Held': '', 'Asset Category': 'Cash & Equivalents', 'Notional per Note': '35,922,746' });
    expect(arky.rows.map((row) => row['Asset Category'])).toEqual(['Cash & Equivalents', 'Treasury', 'Structured Note']);
    const heavy = parseArkHoldingsCsv(arkyCsv + 'OVERWEIGHT NOTE,CUSIP-X,1,1,101.25%\r\n', 'ARKY', '2026-09-28');
    expect(numberOrNull(heavy.rows.at(-1)?.Weight)).toBe(101.25);
    expect(() => parseArkHoldingsCsv('html error', 'ARKK')).toThrow('header row not found');
    expect(() => parseArkHoldingsCsv(arkkCsv.replace('ARKK,', 'ARKQ,'), 'ARKK')).toThrow('contains fund ARKQ');
    expect(() => parseArkHoldingsCsv(arkyCsv, 'ARKK')).toThrow('unexpected structured-note layout');
  });

  test('numbers and dates: unavailable values are null never 0, dates are time-zone independent', () => {
    for (const value of ['$', '%', ',', '$,%', ' $ ', '—']) expect(numberOrNull(value)).toBeNull();
    expect(numberOrNull('$0')).toBe(0);
    expect(numberOrNull('0.00%')).toBe(0);
    expect(numberOrNull('($1,234.50)')).toBe(-1234.5);
    for (const zone of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = zone;
      expect(toIsoDate('09/28/2026')).toBe('2026-09-28');
      expect(toIsoDate('Sep 28 2026')).toBe('2026-09-28');
      expect(toIsoDate('September 5, 2026')).toBe('2026-09-05');
      expect(toIsoDate('Mon, 28 Sep 2026 06:05:47 GMT')).toBe('2026-09-28');
      expect(displayDate('2026-09-28')).toBe('Sep 28 2026');
    }
    expect(isoStamp(new Date('2026-10-03T04:05:06.789Z'))).toBe('2026-10-03T04:05:06Z');
  });

  test('Yahoo chart: adjusted close rounded to cents, dividends and meta parsed', () => {
    const parsed = parseYahooChart({
      chart: { result: [{
        timestamp: [1_757_030_400, 1_757_116_800],
        indicators: { quote: [{ close: [100.123, 101.987], volume: [1000, 1200] }], adjclose: [{ adjclose: [99.999, 101.876] }] },
        events: { dividends: { '1757030400': { amount: 0.25, date: 1_757_030_400 } } },
        meta: { exchangeName: 'Cboe BZX', currency: 'USD', regularMarketPrice: 101.99, firstTradeDate: 1_757_030_400 },
      }], error: null },
    });
    expect(parsed.points).toHaveLength(2);
    expect(parsed.points[0]).toMatchObject({ close: 100.12, adjClose: 100 });
    expect(parsed.points[1].adjClose).toBe(101.88);
    expect(parsed.dividends).toEqual([{ date: parsed.points[0].date, amount: 0.25 }]);
    expect(parsed).toMatchObject({ exchangeName: 'Cboe BZX', regularMarketPrice: 101.99 });
  });

  test('SEC N-PORT: XML, ticker tables, accession URLs, Atom feeds and the fallback resolver', async () => {
    const xml = '<edgarSubmission><genInfo><regName>ARK ETF Trust</regName><regCik>0001579982</regCik><seriesName>ARK Innovation ETF</seriesName><seriesId>S000012345</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo><invstOrSec><name>EXAMPLE CORP</name><ticker>EXM</ticker><cusip>123456789</cusip><balance>25</balance><valUSD>1000</valUSD><pctVal>0.1</pctVal><assetCat>EC</assetCat></invstOrSec></edgarSubmission>';
    const parsed = parseNportXml(xml);
    expect(parsed).toMatchObject({ regName: 'ARK ETF Trust', regCik: '0001579982', seriesName: 'ARK Innovation ETF', seriesId: 'S000012345', repPdDate: '2026-06-30', netAssets: 1_000_000 });
    expect(nportToHoldings(parsed)[0]).toMatchObject({ Name: 'EXAMPLE CORP', Identifier: '123456789', Weight: '0.1%', 'Market Value': '1000', 'Shares Held': '25', 'Asset Category': 'EC' });
    const companies = parseCompanyTickerMap({ '0': { cik_str: 1, ticker: 'EXM', title: 'Example Corporation' } });
    const unticked = parseNportXml('<edgarSubmission><invstOrSec><name>Example Corporation</name><balance>1</balance><valUSD>50</valUSD><pctVal>0.1</pctVal><assetCat>EC</assetCat></invstOrSec></edgarSubmission>');
    expect(nportToHoldings(unticked, companies)[0].Ticker).toBe('EXM');

    const map = parseFundTickerMap({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1579982, 'S000012345', 'C000012345', 'ARKK'], [1869699, 'S000067890', 'C000067890', 'ARKB']] });
    expect(map.get('ARKK')).toEqual({ cik: '0001579982', seriesId: 'S000012345', classId: 'C000012345' });
    expect(map.get('ARKB')?.cik).toBe('0001869699');
    const accessions = parseNportAccessions({ cik: '1579982', filings: { recent: {
      form: ['NPORT-P', '497K'], accessionNumber: ['0001579982-26-000001', '0001579982-26-000002'], filingDate: ['2026-08-15', '2026-08-16'], reportDate: ['2026-06-30', ''],
    } } });
    expect(accessions).toHaveLength(1);
    expect(accessions[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml');
    expect(nportUrlFor('0001579982', '0001579982-26-000001')).toContain('/1579982/000157998226000001/');
    expect(edgarSeriesFilingsUrl('S000012345')).toContain('CIK=S000012345');
    const atomLink = '<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001579982-26-000001</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/</filing-href><period>2026-06-30</period></entry></feed>';
    expect(parseEdgarAtomFilings(atomLink)[0].url).toContain('/1579982/000157998226000001/primary_doc.xml');
    expect(parseEdgarAtomFilings('<feed><entry><category term="NPORT-P"/><updated>2026-09-01T00:00:00Z</updated><link href="https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/" rel="alternate"/></entry></feed>')).toEqual([{
      accession: '0001579982-26-000001', filed: '2026-09-01T00:00:00Z', reportDate: '',
      url: 'https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml',
    }]);

    const calls: string[] = [];
    const sec = async (url: string) => {
      calls.push(url);
      if (url.endsWith('company_tickers_mf.json')) return respondWith(JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1579982, 'S000012345', 'C000012345', 'ARKK']] }), url);
      if (url.includes('browse-edgar')) return respondWith('<feed><entry><category term="NPORT-P"/><link href="https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/"/></entry></feed>', url);
      return respondWith(xml, url);
    };
    const result = await createSecFallbackResolver({ ...clientsFor(), sec })(arkkFund);
    expect(result?.selected.accession).toBe('0001579982-26-000001');
    expect(result?.parsed.seriesId).toBe('S000012345');
    expect(result?.holdings[0]).toMatchObject({ Ticker: 'EXM', Weight: '0.1%', 'Shares Held': '25' });
    expect(calls.some((url) => url.includes('/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml'))).toBe(true);
  });

  test('issuer API paths mirror the page parameters and proxy JSON is unwrapped', () => {
    const urls = arkApiUrls('1004');
    expect(urls.overview).toBe('https://www.ark-funds.com/api/fund/overview/1004');
    const history = new URL(urls.history);
    expect(history.pathname).toBe('/api/fund/nav-historical-change/1004');
    expect(history.searchParams.get('headingText')).toBe('NAV Historical Change');
    expect(new URL(urls.monthEnd).searchParams.get('Range')).toBe('month-end');
    expect(new URL(urls.monthEnd).searchParams.get('Tab')).toBe('tab-annualized');
    expect(new URL(urls.quarterEnd).searchParams.get('Range')).toBe('quarter-end');
    expect(unwrapJinaReaderText('Title: Example\nURL Source: https://example.test\nMarkdown Content:\n```json\n{"fund":1}\n```')).toBe('{"fund":1}');
    expect(parseProviderJson('Title: Example\nMarkdown Content:\n{"fund":1}')).toEqual({ fund: 1 });
  });
});

describe('metrics', () => {
  test('one metrics shape: same key set, returnsBasis and performanceAsOf travel together, one source per fund', () => {
    const official = { ytd: 5, tr1y: 10, cagr3y: 8, returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-08-31' };
    const yahoo = { ytd: 6, tr1y: 11, cagr3y: 9, cagr5y: 7, returnsBasis: YAHOO_RETURNS_BASIS, performanceAsOf: '2026-08-31' };
    const keys = ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'dividendYieldBasis', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf'];
    const officialOnly = buildFundMetrics(resolveReturnMetrics(official, {}, {}), null, null);
    expect(Object.keys(officialOnly)).toEqual(keys);
    expect(officialOnly).toMatchObject({ ytd: 5, tr3y: null, returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-08-31' });
    const nothing = buildFundMetrics(resolveReturnMetrics({}, {}, {}), 1.5, null);
    expect(Object.keys(nothing)).toEqual(keys);
    expect(nothing).toMatchObject({ ytd: null, returnsBasis: UNAVAILABLE_RETURNS_BASIS, performanceAsOf: null, dividendYield: 1.5 });
    expect(buildFundMetrics({ returnsBasis: '-' }, null, null).returnsBasis).toBe(UNAVAILABLE_RETURNS_BASIS);
    expect(buildFundMetrics({ performanceAsOf: '' }, null, null).performanceAsOf).toBeNull();
    // the official unit wins whole: a Yahoo-only figure never fills its nulls
    const unit = resolveReturnMetrics(official, yahoo, {});
    expect(unit).toMatchObject({ cagr5y: null, ytd: 5, returnsBasis: OFFICIAL_RETURNS_BASIS });
    expect(resolveReturnMetrics({}, { ...yahoo, performanceAsOf: '2026-09-25' }, {})).toMatchObject({ returnsBasis: YAHOO_RETURNS_BASIS, performanceAsOf: '2026-09-25' });
    expect(resolveReturnMetrics({}, {}, { ytd: 3, returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-07-31' })).toMatchObject({ returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-07-31' });
    const serialized = JSON.parse(stableStringify({ b: 1, metrics: { ytd: 1, returnsBasis: 'x', performanceAsOf: null, a: 2 } }));
    expect(Object.keys(serialized.metrics)).toEqual(['ytd', 'returnsBasis', 'performanceAsOf', 'a']);
  });

  test('dividendYieldBasis: a code per yield source, null exactly when the yield is null, same key set on every row', async () => {
    // lookup of the kind texts this updater writes; ARK publishes no yield, so nothing is official
    expect(yieldBasisFromKind('indicated: Yahoo Finance latest distribution x inferred monthly frequency / market price')).toBe('indicated');
    expect(yieldBasisFromKind('Yahoo Finance trailing 12-month distributions / market price')).toBe('computed-trailing-12m');
    expect(yieldBasisFromKind('not available from Yahoo Finance')).toBeNull();
    expect(yieldBasisFromKind('previously published distribution data')).toBe('indicated');
    expect(resolveYieldBasis(null, 'indicated')).toBeNull();
    expect(resolveYieldBasis(0, 'computed-trailing-12m')).toBe('computed-trailing-12m');
    expect(resolveYieldBasis(2, 'bogus', 'Yahoo Finance trailing 12-month distributions / market price')).toBe('computed-trailing-12m');
    expect(buildFundMetrics({}, 1.5, null, 'computed-trailing-12m').dividendYieldBasis).toBe('computed-trailing-12m');
    expect(buildFundMetrics({}, null, null, 'indicated').dividendYieldBasis).toBeNull();
    const epoch = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const monthly = Object.fromEntries(['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map((d, i) => [String(i), { date: epoch(d), amount: 0.1 }]));
    await withTempRoot(async (root) => {
      await update(root, { dividends: monthly });
      expect((await metaOf(root)).metrics).toMatchObject({ dividendYield: expect.any(Number), dividendYieldBasis: 'indicated' });
      expect((await metaOf(root)).yields.dividendYieldBasis).toBe('indicated');
    });
    await withTempRoot(async (root) => {
      await update(root, { dividends: { a: { date: epoch('2026-08-28'), amount: 0.5 } } });
      expect((await metaOf(root)).metrics).toMatchObject({ dividendYieldBasis: 'computed-trailing-12m' });
      // Yahoo down on the next run: the old yield keeps its old code
      await update(root, {}, { SKIP_YAHOO: '1' });
      const kept = (await metaOf(root)).metrics;
      expect(kept.dividendYield).not.toBeNull();
      expect(kept.dividendYieldBasis).toBe('computed-trailing-12m');
    });
    await withTempRoot(async (root) => {
      await update(root, {});
      const meta = await metaOf(root);
      expect(meta.metrics.dividendYield).toBeNull();
      expect(meta.metrics.dividendYieldBasis).toBeNull();
    });
    // fresh, kept (legacy, no key) and placeholder rows share one key set; a legacy row gets its code from the meta kind text
    await withTempRoot(async (root) => {
      await run(root, { TICKERS: 'ARKK' });
      const metaPath = join(root, 'funds', 'ARKK', 'meta.json');
      const indexPath = join(root, 'index.json');
      const meta = await readJson(metaPath);
      meta.yields.dividendYieldKind = 'Yahoo Finance trailing 12-month distributions / market price';
      await Bun.write(metaPath, JSON.stringify(meta));
      const index = await readJson(indexPath);
      const legacy = index.funds.find((row: any) => row.ticker === 'ARKK');
      legacy.metrics.dividendYield = 2.5;
      legacy.metrics.dividendYieldText = '2.50%';
      delete legacy.metrics.dividendYieldBasis;
      await Bun.write(indexPath, JSON.stringify(index));
      await run(root, { TICKERS: 'ARKY' });
      const after = await readJson(indexPath);
      const arkk = after.funds.find((row: any) => row.ticker === 'ARKK');
      const arkq = after.funds.find((row: any) => row.ticker === 'ARKQ');
      expect(arkk.metrics.dividendYieldBasis).toBe('computed-trailing-12m');
      expect(arkq.metrics.dividendYieldBasis).toBeNull();
      for (const row of after.funds) expect(Object.keys(row.metrics)).toEqual(Object.keys(arkq.metrics));
    });
  });

  test('young funds: horizons longer than the fund age and a since-inception figure under one year are null', () => {
    const month = parseArkPerformance(performanceSample('08/31/2026', ['1.10%', '5.00%', '6.00%', '7.00%', '1.38%'], ['1%', '2%', '3%', '1.38%']));
    const young = buildOfficialReturns(month, null, '2026-08-19');
    expect(young.metrics).toMatchObject({ tr1y: null, cagr3y: null, cagr5y: null, siAnn: null });
    expect(young.monthEnd.sinceInception).toBeNull();
    expect(young.monthEnd.sinceInceptionCumulative).toBe(1.38);
    expect(buildOfficialReturns(month, null, '2023-09-26').metrics).toMatchObject({ tr1y: 1.1, cagr3y: null, tr3y: null, siAnn: 1.38 }); // 2.93 years old
    expect(buildOfficialReturns(month, null, '2020-01-01').metrics).toMatchObject({ cagr3y: 5, cagr5y: 6 });
  });

  test('Yahoo-derived returns: completed month/quarter ends only, inception figures only from a window that reaches the first trade', () => {
    const points = [
      { date: '2025-06-30', close: 100, adjClose: 100, volume: 1 },
      { date: '2025-12-31', close: 110, adjClose: 110, volume: 1 },
      { date: '2026-03-31', close: 120, adjClose: 120, volume: 1 },
      { date: '2026-06-30', close: 125, adjClose: 125, volume: 1 },
      { date: '2026-08-31', close: 130, adjClose: 130, volume: 1 },
      { date: '2026-09-25', close: 140, adjClose: 140, volume: 1 },
    ];
    const derived = buildYahooReturns(points, REF);
    expect(derived.monthEnd).toMatchObject({ asOfDate: 'Aug 31 2026', ytd: 18.18 });
    expect(derived.quarterEnd).toMatchObject({ asOfDate: 'Jun 30 2026', ytd: 13.64 });
    expect(derived.metrics.returnsBasis).toContain('Yahoo Finance');
    expect(derived.metrics.performanceAsOf).toBe('2026-08-31');
    const long = Array.from({ length: 800 }, (_, index) => ({ date: new Date(Date.parse('2024-07-20T00:00:00Z') + index * DAY_MS).toISOString().slice(0, 10), close: 50 + index * 0.01, adjClose: 50 + index * 0.01, volume: 1 }));
    expect(buildYahooReturns(long, REF, true).metrics.siAnn).not.toBeNull();
    const clipped = buildYahooReturns(long, REF, false);
    expect(clipped.metrics.siAnn).toBeNull();
    expect(clipped.monthEnd.sinceInceptionCumulative).toBeNull();
    expect(cumulativeFromAnnualized(10, 3)).toBe(33.1);
    expect(annualizedFromCumulative(33.1, 3)).toBe(10);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
    expect(annualizedFromCumulative(-100, 3)).toBeNull();
  });

  test('distributions: None is not Unknown, semi-annual means 2 payments a year (yield not overstated)', async () => {
    for (const value of [null, '', '—', 'None']) expect(formatDistributionFrequency(value)).toBe('00 - None');
    expect(formatDistributionFrequency('Unknown')).toBe('00 - Unknown');
    expect(formatDistributionFrequency('MDEC')).toBe('01 - Monthly');
    expect(formatDistributionFrequency('QDEC')).toBe('04 - Quarterly');
    expect(paymentsPerYear('Monthly')).toBe(12);
    expect(paymentsPerYear('Unknown')).toBeNull();
    for (const value of ['semi-annually', 'SDEC', 'Semi-Annual']) expect(paymentsPerYear(value)).toBe(2);
    const now = new Date('2026-09-28T00:00:00Z');
    expect(inferDistributionFrequency([], now)).toBeNull();
    expect(inferDistributionFrequency(['2026-07-01', '2026-08-01'], now)).toBe('Unknown');
    expect(inferDistributionFrequency(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], now)).toBe('Monthly');
    expect(inferDistributionFrequency(['2025-09-01', '2026-03-01', '2026-08-28'], now)).toBe('Semi-annually');
    expect(trailingDividendYield([{ date: '2026-06-01', amount: 0.5 }, { date: '2026-08-01', amount: 0.5 }], 100, '2026-09-28')).toBe(1);
    expect(trailingDividendYield([], 100, '2026-09-28')).toBeNull();
    const epoch = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const dividends = { a: { date: epoch('2025-09-01'), amount: 0.5 }, b: { date: epoch('2026-03-01'), amount: 0.5 }, c: { date: epoch('2026-08-28'), amount: 0.5 } };
    await withTempRoot(async (root) => {
      await update(root, { dividends });
      const meta = await metaOf(root);
      expect(meta.distributions.frequency).toBe('Semi-annually');
      expect(meta.metrics.dividendYield).toBe(1.1); // 0.50 x 2 / 90.77, not x 6
    });
  });

  test('returns are one unit: a figure ARK later nulls stays null and never travels under a new date; TER maps from the overview', async () => {
    await withTempRoot(async (root) => {
      const first = await update(root, {});
      expect(first.entry).toMatchObject({ terValue: 0.75, metrics: { tr1y: 14.07, cagr3y: 25.02 } });
      expect((await metaOf(root)).metrics).toMatchObject({ cagr3y: 25.02, tr1y: 14.07 });
      await update(root, { month: performanceSample('09/30/2026', ['14.07%', '', '', '', '13.98%'], ['20.20%', '4.37%', '11.13%', '370.38%']) });
      const meta = await metaOf(root);
      expect(meta.metrics).toMatchObject({ tr1y: 14.07, cagr3y: null, tr3y: null, cagr5y: null, returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-09-30' });
      expect(meta.returns.monthEnd).toMatchObject({ yr3: null, yr5: null });
    });
  });
});

describe('pipeline', () => {
  test('one fund: paginated UI files, official sources, a byte-identical rerun that reuses the page id, retained data on SKIP', async () => {
    await withTempRoot(async (root) => {
      const arkUrls: string[] = [];
      const base = clientsFor({});
      const clients = { ...base, ark: async (url: string) => { arkUrls.push(url); return base.ark(url); } };
      const env = { HOLDINGS_PAGE_SIZE: '2', HISTORY_PAGE_SIZE: '2' };
      const first = await updateArkFund(arkkFund, quietConfig(env), clients, { apiRoot: root, referenceDate: REF, ...quiet });
      expect(first.entry).toMatchObject({ ticker: 'ARKK', holdings: 3, history: 4, returns: { monthEnd: { ytd: 11.13, asOfDate: 'Aug 31 2026' }, quarterEnd: { asOfDate: 'Jun 30 2026' } } });
      const fundRoot = join(root, 'funds', 'ARKK');
      expect(await metaOf(root)).toMatchObject({ source: { pageId: '1004', holdingsSource: 'official ARK daily holdings CSV', historySource: 'official ARK Invest daily NAV and market-price history API' } });
      const holdingsPage = await readJson(join(fundRoot, 'holdings', '001.json'));
      expect(holdingsPage).toMatchObject({ ticker: 'ARKK', page: 1, totalRows: 3, headers: ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] });
      expect(holdingsPage.rows).toHaveLength(2);
      expect(holdingsPage.rows[0]).toMatchObject({ Ticker: 'TSLA', Weight: '9.12%' });
      expect(await readJson(join(fundRoot, 'history', '001.json'))).toMatchObject({ totalRows: 4, headers: ['Date', 'NAV', 'Market Price', 'Premium/Discount'] });

      const paths = ['meta.json', 'holdings/001.json', 'holdings/002.json', 'history/001.json', 'history/002.json'].map((name) => join(fundRoot, name));
      const snapshot = () => Promise.all(paths.map((file) => readFile(file, 'utf8')));
      const before = await snapshot();
      expect(arkUrls).toContain(arkkFund.fundPage);
      arkUrls.length = 0;
      await updateArkFund(arkkFund, quietConfig(env), clients, { apiRoot: root, referenceDate: REF, ...quiet });
      expect(await snapshot()).toEqual(before);
      expect(arkUrls).not.toContain(arkkFund.fundPage); // the heavy fund page is skipped once the published id is confirmed
      const retained = await updateArkFund(arkkFund, quietConfig({ ...env, ...SKIP_ALL }), clients, { apiRoot: root, referenceDate: REF, ...quiet });
      expect(retained).toMatchObject({ holdingsCount: 3, historyCount: 4 });
      expect(await snapshot()).toEqual(before);
    });
  });

  test('a one-ticker run keeps every catalog row; rows without meta have dataFile null and the same metrics keys', async () => {
    await withTempRoot(async (root) => {
      await run(root, { TICKERS: 'ARKK' });
      const index = await readJson(join(root, 'index.json'));
      expect(index.funds).toHaveLength(14);
      const arkk = index.funds.find((row: any) => row.ticker === 'ARKK');
      const arkq = index.funds.find((row: any) => row.ticker === 'ARKQ');
      expect(arkk.dataFile).toBe('funds/ARKK/meta.json');
      expect(arkq.dataFile).toBeNull();
      expect(Object.keys(arkq.metrics)).toEqual(Object.keys(arkk.metrics));
      expect(arkq.metrics).toMatchObject({ returnsBasis: UNAVAILABLE_RETURNS_BASIS, performanceAsOf: null, ytd: null });
      await run(root, { TICKERS: 'ARKY' }); // another filtered run does not drop ARKK either
      const again = await readJson(join(root, 'index.json'));
      expect(again.funds).toHaveLength(14);
      expect(again.funds.find((row: any) => row.ticker === 'ARKK').dataFile).toBe('funds/ARKK/meta.json');
    });
  });

  test('a second identical run writes nothing, stamps included', async () => {
    await withTempRoot(async (root) => {
      const snapshot = async (): Promise<Array<[string, string, number]>> => {
        const out: Array<[string, string, number]> = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else out.push([full, await readFile(full, 'utf8'), (await stat(full)).mtimeMs]);
          }
        };
        await walk(root);
        return out.sort((a, b) => a[0].localeCompare(b[0]));
      };
      await run(root, { TICKERS: 'ARKK', EDGAR_FALLBACK: '0' });
      const first = await snapshot();
      await Bun.sleep(20); // any rewrite would move the mtime
      await run(root, { TICKERS: 'ARKK', EDGAR_FALLBACK: '0' });
      expect(await snapshot()).toEqual(first);
      expect(first.some(([file]) => file.endsWith('.tmp'))).toBe(false);
    });
  });

  test('a failed source keeps the whole fund as published: CSV (never an older N-PORT) and performance', async () => {
    await withTempRoot(async (root) => {
      await update(root, {});
      const files = () => Promise.all(['meta.json', 'holdings/001.json', 'history/001.json'].map((name) => readFile(join(root, 'funds', 'ARKK', name), 'utf8')));
      const before = await files();
      const csvFailed = await update(root, { csv: new Error('HTTP 403') }, { EDGAR_FALLBACK: '1' }, { secFallback: oldNport('2026-06-30') });
      expect(csvFailed.status).toBe('failed');
      expect(csvFailed.reason).toContain('holdings CSV');
      expect(await files()).toEqual(before);
      expect((await metaOf(root)).holdings.asOfDate).toBe('Sep 28 2026');

      const base = clientsFor({});
      const clients = { ...base, ark: async (url: string) => { if (url.includes('/api/fund/performance/')) throw new Error('HTTP 503'); return base.ark(url); } };
      const perfFailed = await updateArkFund(arkkFund, quietConfig(), clients, { apiRoot: root, referenceDate: REF, ...quiet });
      expect(perfFailed.status).toBe('failed');
      expect(perfFailed.reason).toContain('performance');
      expect(await files()).toEqual(before);
    });
  });

  test('N-PORT freshness: a newer report replaces older published holdings, a stale snapshot is surfaced as a warning', async () => {
    await withTempRoot(async (root) => {
      const warnings: string[] = [];
      await update(root, { csv: csvAt('01/02/2026') }, {}, {}, warnings);
      expect(warnings.some((message) => message.includes('days old') && message.includes('ARKK'))).toBe(true);
      expect(parseArkHoldingsCsv(['date,fund,company,ticker,cusip,shares,market value ($),weight (%)', '01/02/2026,ARKF,OLD CO,OLD,1,"1","$1",1%', '09/28/2026,ARKF,TESLA INC,TSLA,88160R101,"2","$3",9%'].join('\n'), 'ARKF').asOfDate).toBe('2026-09-28');
    });
    await withTempRoot(async (root) => {
      await update(root, { csv: csvAt('06/01/2026') });
      const result = await update(root, { csv: new Error('HTTP 403') }, { EDGAR_FALLBACK: '1' }, { secFallback: oldNport('2026-08-31') });
      expect(result.status).toBeUndefined();
      expect((await metaOf(root)).holdings).toMatchObject({ source: 'SEC EDGAR Form N-PORT-P fallback', asOfDate: 'Aug 31 2026' });
    });
  });

  test('HISTORY_RANGE never shrinks published history: older rows are merged back and every page is kept', async () => {
    await withTempRoot(async (root) => {
      const full = navPoints(1500);
      await update(root, { history: full, yahooPoints: 1500 }, { HISTORY_PAGE_SIZE: '1000' });
      expect((await metaOf(root)).history.totalRows).toBe(1500);
      await update(root, { history: full, yahooPoints: 800 }, { HISTORY_RANGE: '2y', HISTORY_PAGE_SIZE: '1000' });
      const after = await metaOf(root);
      expect(after.history).toMatchObject({ totalRows: 1500, asOfDate: 'Sep 25 2026' });
      expect((await readdir(join(root, 'funds', 'ARKK', 'history'))).sort()).toEqual(['001.json', '002.json']);
    });
    const previous = { headers: ['Date', 'NAV'], rows: [{ Date: 'Jan 02 2026', NAV: '1' }, { Date: 'Jun 01 2026', NAV: '2' }] };
    expect(mergeHistoryRows(previous, ['Date', 'NAV'], [{ Date: 'Jun 01 2026', NAV: '3' }]).map((row) => row.NAV)).toEqual(['1', '3']);
    expect(mergeHistoryRows(previous, ['Date', 'Close'], [{ Date: 'Jun 01 2026', Close: '3' }])).toHaveLength(1);
  });

  test('HISTORY_RANGE=1y keeps only the NAV points of the last year; a Yahoo-only 2y window is not labeled inception', async () => {
    await withTempRoot(async (root) => {
      const windowed = await update(root, {}, { HISTORY_RANGE: '1y' });
      expect(windowed).toMatchObject({ historyCount: 2 }); // 2 of the 4 sample points are inside the last year
    });
    await withTempRoot(async (root) => {
      await update(root, { yahooPoints: 800, firstTrade: '2014-10-31' }, { SKIP_ARK: '1', HISTORY_RANGE: '2y' });
      expect((await metaOf(root)).metrics.siAnn).toBeNull();
    });
  });

  test('writes are atomic and deterministic; stale pages go only after meta.json is written', async () => {
    expect(splitPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => splitPages([1], 0)).toThrow('positive integer');
    expect(pageFileName(1)).toBe('001.json');
    expect(pageFileName(1002)).toBe('1002.json');
    expect(buildPageEnvelope('ARKK', 1, 2, 3, ['Ticker'], [{ Ticker: 'TSLA' }])).toMatchObject({ ticker: 'ARKK', page: 1, pageSize: 2, totalRows: 3 });
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(stableStringify({ a: { x: 3, y: 2 }, z: 1 }));
    expect(semanticContentKey({ generatedAt: 'A', nested: { catalogReadAt: 'B', value: 1 } })).toBe(semanticContentKey({ generatedAt: 'C', nested: { catalogReadAt: 'D', value: 1 } }));
    await withTempRoot(async (root) => {
      const file = join(root, 'x', 'a.json');
      expect(await writeIfChanged(file, '{"rows":[]}\n')).toBe('written');
      expect(await writeIfChanged(file, '{"rows":[]}\n')).toBe('unchanged');
      await writeFileAtomic(file, '{"a":1}\n');
      await writeJsonIfChanged(file, { a: 2 });
      expect(await readdir(join(root, 'x'))).toEqual(['a.json']);
      await expect(writeFileAtomic(join(root, 'x', 'a.json', 'nested.json'), 'z')).rejects.toBeDefined();
      expect(await readJson(file)).toEqual({ a: 2 });

      await update(root, { history: navPoints(5) }, { HISTORY_PAGE_SIZE: '2' });
      const historyDir = join(root, 'funds', 'ARKK', 'history');
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      await rm(join(root, 'funds', 'ARKK', 'meta.json'));
      await mkdir(join(root, 'funds', 'ARKK', 'meta.json', 'blocker'), { recursive: true }); // makes the meta.json write fail
      await expect(update(root, { history: navPoints(5) }, { HISTORY_PAGE_SIZE: '5' })).rejects.toBeDefined();
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      await rm(join(root, 'funds', 'ARKK', 'meta.json'), { recursive: true, force: true });
      await update(root, { history: navPoints(5) }, { HISTORY_PAGE_SIZE: '5' });
      expect((await readdir(historyDir)).sort()).toEqual(['001.json']);
    });
  });

  test('MAX_FETCHES: scoped cursor resumes, wraps around, a TICKERS run leaves it alone and a failure never trims the catalog', async () => {
    await withTempRoot(async (root) => {
      const requests: string[] = [];
      const refuse = async (url: string) => { requests.push(url); throw new Error('skipped sources must not be requested'); };
      const clients = { ark: refuse, azure: refuse, yahoo: refuse, sec: refuse, isArkProxyActive: () => false };
      await writeJsonIfChanged(join(root, 'index.json'), { brand: 'ARK Invest', funds: [{ ticker: 'ARKQ', name: 'Existing ARKQ record', category: 'Preserved', holdings: 4, history: 8, customTag: 'keep-me' }] });
      const first = await run(root, { ...SKIP_ALL, TICKERS: 'ARKK ARKY', MAX_FETCHES: '1' }, clients);
      expect(first).toMatchObject({ selectedTickers: ['ARKK'], failedTickers: ['ARKK'], nextCursor: 1 });
      expect((await readJson(join(root, 'update-state.json'))).scopes).toMatchObject({ 'ARKK,ARKY': { cursor: 1, tickers: ['ARKK', 'ARKY'] } });
      const second = await run(root, { ...SKIP_ALL, TICKERS: 'ARKK ARKY', MAX_FETCHES: '1' }, clients);
      expect(second).toMatchObject({ selectedTickers: ['ARKY'], failedTickers: ['ARKY'], nextCursor: 0 });
      expect(requests).toEqual([]);
      const index = await readJson(join(root, 'index.json'));
      expect(index.funds).toHaveLength(14);
      expect(index.funds.find((row: any) => row.ticker === 'ARKQ')).toMatchObject({ name: 'Existing ARKQ record', category: 'Preserved', holdings: 4, history: 8, customTag: 'keep-me' });
      expect(index.funds.find((row: any) => row.ticker === 'ARKB')).toMatchObject({ holdings: 0, history: 0 });
      expect(await Bun.file(join(root, 'funds', 'ARKK', 'meta.json')).exists()).toBe(false);
    });
    await withTempRoot(async (root) => {
      const batch = (extra: Record<string, string>) => run(root, { ...SKIP_ALL, ...extra });
      const a = await batch({ MAX_FETCHES: '5' });
      const b = await batch({ MAX_FETCHES: '5' });
      const c = await batch({ MAX_FETCHES: '5' });
      expect(c.selectedTickers).toHaveLength(5); // 14 funds: 5 + 5 + 5 wraps instead of a short last batch
      expect(new Set([...a.selectedTickers, ...b.selectedTickers]).size).toBe(10);
      expect(c.selectedTickers.slice(4)).toEqual(a.selectedTickers.slice(0, 1));
      const state = await readJson(join(root, 'update-state.json'));
      const fullScope = Object.keys(state.scopes)[0];
      await batch({ TICKERS: 'ARKK ARKY', MAX_FETCHES: '1' });
      await batch({ TICKERS: 'ARKK ARKY', MAX_FETCHES: '0' });
      const after = await readJson(join(root, 'update-state.json'));
      expect(after.scopes[fullScope].cursor).toBe(state.scopes[fullScope].cursor);
      expect(Object.keys(after.scopes)).toContain('ARKK,ARKY');
    });
  });

  test('a soft deadline stops taking new funds, still writes the index and moves the cursor only by started funds', async () => {
    expect(RUN_SOFT_DEADLINE_MS).toBe(25 * 60_000);
    await withTempRoot(async (root) => {
      let clock = 0;
      const base = clientsFor({});
      const clients = { ...base, ark: async (url: string) => { if (url.includes('/api/fund/overview/')) clock += 10_000; return base.ark(url); } };
      const config = quietConfig({ MAX_FETCHES: '3', CONCURRENCY: '1', EDGAR_FALLBACK: '0', TICKERS: 'ARKK ARKB ARKQ' });
      const report = await runUpdater({ config, apiRoot: root, clients, referenceDate: REF, runtime: { now: () => clock, sleep: async () => undefined }, deadlineMs: 5_000, ...quiet });
      expect(report.deadlineReached).toBe(true);
      expect(report.processedTickers).toEqual(['ARKB', 'ARKK']); // ARKB fails fast, ARKK burns the budget, ARKQ is never started
      expect(report.nextCursor).toBe(2);
      expect((await readJson(join(root, 'index.json'))).funds).toHaveLength(14);
    });
  });

  test('main exits non-zero only when every selected fund failed', async () => {
    await withTempRoot(async (root) => {
      const options = { apiRoot: root, clients: clientsFor({}), referenceDate: REF, ...quiet };
      const report = await main([], { TICKERS: 'ARKK', ...SKIP_ALL, REQUEST_SLEEP: '0' }, options);
      expect(report?.failedTickers).toEqual(['ARKK']);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await main([], { TICKERS: 'ARKK', EDGAR_FALLBACK: '0', REQUEST_SLEEP: '0' }, options);
      expect(process.exitCode).toBe(0);
    });
  });

  test('catalog: a direct 403 goes through the raw-HTML proxy and the fixed catalog is retained; unlisted funds are reported as NEW FUNDS', async () => {
    await withTempRoot(async (root) => {
      const calls: Array<{ url: string; respondWith: string | null }> = [];
      const notices: string[] = [];
      const config = quietConfig({ CATEGORY: 'not-a-supported-category' });
      const clients = createRequestClients(config, {
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({ url, respondWith: new Headers(init?.headers).get('x-respond-with') });
          return url.startsWith('https://r.jina.ai/') ? new Response('<html><body><a href="/funds/arkk">ARKK</a></body></html>', { status: 200 }) : new Response('blocked', { status: 403 });
        },
        onIssuerProxy: (message) => notices.push(message),
      });
      const report = await runUpdater({ config, apiRoot: root, clients, ...quiet });
      expect(report.selectedTickers).toEqual([]);
      expect(calls.filter((call) => call.url.startsWith('https://r.jina.ai/'))).toEqual([{ url: jinaReaderUrl('https://www.ark-funds.com/our-etfs/'), respondWith: 'html' }]);
      expect(notices).toHaveLength(1);
      const index = await readJson(join(root, 'index.json'));
      expect(index.catalog.source).toContain('official ETF page; 1 supported fund paths observed');
      expect(index.catalog.tickers).toHaveLength(14);
    });
    await withTempRoot(async (root) => {
      const summary = join(root, 'summary.md');
      process.env.GITHUB_STEP_SUMMARY = summary;
      const html = '<a href="/funds/arkk">ARKK</a><a href="/funds/arkz">ARKZ</a>';
      const base = clientsFor({});
      const clients = { ...base, ark: async (url: string) => url.endsWith('/our-etfs/') ? respondWith(html, url) : base.ark(url) };
      const report = await runUpdater({ config: quietConfig({ CATEGORY: 'nothing-matches' }), apiRoot: root, clients, ...quiet });
      expect(report.newFunds).toEqual(['ARKZ']);
      expect(await readFile(summary, 'utf8')).toContain('NEW FUNDS: ARKZ');
    });
  });
});

describe('network', () => {
  test('pacing: lanes start apart on a fake clock and stay usable after a rejected request', async () => {
    let clock = 0;
    const waits: number[] = [];
    const starts: number[] = [];
    const gate = createPacedGate(2, 100, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    const work = [
      gate(() => { starts.push(clock); return 'first'; }),
      gate(() => { starts.push(clock); return 'second'; }),
      gate(() => { starts.push(clock); return 'third'; }),
      gate(() => { starts.push(clock); throw new Error('expected rejection'); }),
    ];
    await expect(Promise.all(work)).rejects.toThrow('expected rejection');
    expect(starts.slice(0, 2)).toEqual([0, 0]);
    expect(starts[2]).toBeGreaterThanOrEqual(100);
    expect(starts[3]).toBeGreaterThanOrEqual(100);
    expect(waits.every((ms) => ms === 100)).toBe(true);
    await expect(gate(() => 'recovered')).resolves.toBe('recovered');
  });

  test('retries are bounded: a temporary error is retried through the paced client, the r.jina.ai proxy retries once and paces >= 3.2 s', async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const retries: string[] = [];
    const client = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1' }), {
      fetchImpl: async (input) => { calls.push(String(input)); return calls.length === 1 ? new Response('temporarily unavailable', { status: 503 }) : new Response('ready', { status: 200 }); },
      sleep: async (ms) => { waits.push(ms); },
      onRetry: (message) => retries.push(message),
    });
    await expect(client.azure('https://assets.example.test/fund.csv')).resolves.toMatchObject({ text: 'ready' });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([500]);
    expect(retries).toHaveLength(1);

    let clock = 0;
    const proxyStarts: number[] = [];
    const proxied = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '5' }), {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      onRetry: () => undefined,
      onIssuerProxy: () => undefined,
      fetchImpl: async (input) => {
        if (String(input).startsWith('https://r.jina.ai/')) { proxyStarts.push(clock); return new Response('busy', { status: 503 }); }
        return new Response('blocked', { status: 403 });
      },
    });
    await expect(proxied.ark('https://www.ark-funds.com/api/fund/overview/1004')).rejects.toThrow('503');
    expect(proxyStarts).toHaveLength(2); // whatever MAX_RETRIES says
    expect(proxyStarts[1] - proxyStarts[0]).toBeGreaterThanOrEqual(ISSUER_PROXY_MIN_INTERVAL_MS);
    expect(ISSUER_PROXY_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(3200);
  });

  test('issuer 403 handling: a transient denial is retried directly, a repeated one switches to the proxy for later requests; honest User-Agent', async () => {
    let direct = 0;
    const transient = createRequestClients(quietConfig(), {
      sleep: async () => undefined,
      fetchImpl: async () => { direct += 1; return direct === 1 ? new Response('challenge', { status: 403 }) : new Response('{"ok":true}', { status: 200 }); },
      onIssuerProxy: () => undefined,
    });
    await expect(transient.ark('https://www.ark-funds.com/api/fund/overview/1004')).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(direct).toBe(2);
    expect(transient.isArkProxyActive()).toBe(false);

    let clock = 0;
    const calls: Array<{ url: string; respondWith: string | null }> = [];
    const proxyStarts: number[] = [];
    const client = createRequestClients(quietConfig(), {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      onIssuerProxy: () => undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, respondWith: new Headers(init?.headers).get('x-respond-with') });
        if (!url.startsWith('https://r.jina.ai/')) return new Response('blocked', { status: 403 });
        proxyStarts.push(clock);
        return new Response(url.includes('/api/') ? '{"ok":true}' : `<script>url: "/api/fund/overview/${url.includes('/funds/arkk') ? '1004' : '1010'}"</script>`, { status: 200 });
      },
    });
    await expect(client.ark('https://www.ark-funds.com/our-etfs/')).resolves.toBeDefined(); // the denied request itself is not lost
    expect(client.isArkProxyActive()).toBe(true);
    const pages = await Promise.all(['https://www.ark-funds.com/funds/arkk', 'https://www.ark-funds.com/funds/arkb'].map((url) => client.ark(url)));
    expect(pages.map((page) => extractFundPageId(page.text))).toEqual(['1004', '1010']);
    await expect(client.ark('https://www.ark-funds.com/api/fund/overview/1004')).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(calls.filter((call) => !call.url.startsWith('https://r.jina.ai/'))).toHaveLength(2);
    expect(calls.filter((call) => call.url.includes('/funds/arkk') || call.url.includes('/funds/arkb')).every((call) => call.respondWith === 'html')).toBe(true);
    expect(calls.find((call) => call.url.includes('/api/fund/overview/1004'))?.respondWith).toBe('text');
    for (let index = 1; index < proxyStarts.length; index += 1) expect(proxyStarts[index] - proxyStarts[index - 1]).toBeGreaterThanOrEqual(ISSUER_PROXY_MIN_INTERVAL_MS);

    const seen: string[] = [];
    const plain = createRequestClients(quietConfig(), { fetchImpl: async (_input, init) => { seen.push(new Headers(init?.headers).get('user-agent') ?? ''); return new Response('ok', { status: 200 }); } });
    await plain.ark('https://www.ark-funds.com/funds/arkk');
    expect(seen).toEqual([ISSUER_USER_AGENT]);
    expect(ISSUER_USER_AGENT).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(ISSUER_USER_AGENT).not.toMatch(/https?:\/\//); // a URL in the UA is answered with HTTP 403 by ark-funds.com
  });

  test('timeout: a stalled connection and a stalled body are aborted and retried', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(45_000);
    let connectCalls = 0;
    const stalledConnection = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1' }), {
      requestTimeoutMs: 50,
      sleep: async () => undefined,
      onRetry: () => undefined,
      fetchImpl: (_input, init) => {
        connectCalls += 1;
        if (connectCalls > 1) return Promise.resolve(new Response('recovered', { status: 200 }));
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted'))));
      },
    });
    await expect(guarded(stalledConnection.azure('https://assets.example.test/fund.csv'))).resolves.toMatchObject({ text: 'recovered' });
    expect(connectCalls).toBe(2);

    let bodyCalls = 0;
    const stalledBody = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1' }), {
      requestTimeoutMs: 50,
      sleep: async () => undefined,
      onRetry: () => undefined,
      fetchImpl: (_input, init) => {
        bodyCalls += 1;
        if (bodyCalls > 1) return Promise.resolve(new Response('recovered', { status: 200 }));
        const body = new ReadableStream({ start: (controller) => init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason ?? new Error('aborted'))) });
        return Promise.resolve(new Response(body, { status: 200 })); // headers arrive, the body never does
      },
    });
    await expect(guarded(stalledBody.azure('https://assets.example.test/fund.csv'))).resolves.toMatchObject({ text: 'recovered' });
    expect(bodyCalls).toBe(2);
  }, 10_000);

  test('timeout starts when the request starts, not while it waits in a pacing queue', async () => {
    const retries: string[] = [];
    // 4 requests behind a 300 ms lane with a 1 s timeout: queue wait of the last one (900 ms) must not count
    const client = createRequestClients(quietConfig({ REQUEST_SLEEP: '0.3' }), {
      requestTimeoutMs: 1000,
      onRetry: (message) => retries.push(message),
      fetchImpl: (input, init) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
        setTimeout(() => resolve(new Response(String(input), { status: 200 })), 5);
      }),
    });
    const urls = ['a', 'b', 'c', 'd'].map((name) => `https://assets.example.test/${name}.csv`);
    const results = await withRequestLane(300, () => Promise.all(urls.map((url) => client.azure(url))));
    expect(results.map((result) => result.text)).toEqual(urls);
    expect(retries).toEqual([]);
  }, 10_000);

  test('concurrency is real: peak in-flight requests is 1 at CONCURRENCY=1 and N at CONCURRENCY=N', async () => {
    const peaks: number[] = [];
    for (const concurrency of [1, 3, 6]) {
      await withTempRoot(async (root) => {
        let active = 0;
        let peak = 0;
        const config = quietConfig({ TICKERS: 'ARKB ARKD ARKE ARKF ARKG ARKI', CONCURRENCY: String(concurrency), EDGAR_FALLBACK: '0' });
        const clients = createRequestClients(config, {
          fetchImpl: async () => {
            peak = Math.max(peak, ++active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            return new Response('not found', { status: 404 });
          },
        });
        const report = await runUpdater({ config, apiRoot: root, clients, referenceDate: REF, ...quiet });
        expect(report.failedTickers).toHaveLength(6);
        peaks.push(peak);
      });
    }
    expect(peaks).toEqual([1, 3, 6]);
  }, 15_000);

  test('HISTORY_RANGE puts explicit period bounds into the Yahoo request and max starts at 0', () => {
    const now = 1_800_000_000;
    const url = new URL(yahooChartUrl('ARKK', now));
    expect(url.searchParams.get('period1')).toBe('0');
    expect(url.searchParams.get('period2')).toBe(String(now));
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('events')).toBe('div|split');
    expect(url.searchParams.get('includeAdjustedClose')).toBe('true');
    expect(new URL(yahooChartUrl('ARKK', now, 'max')).searchParams.get('period1')).toBe('0');
    const fiveYear = new URL(yahooChartUrl('ARKK', now, '5y'));
    expect(fiveYear.searchParams.get('period1')).toBe(String(Math.floor(now - 5 * 365.25 * 86_400)));
    expect(fiveYear.searchParams.get('period2')).toBe(String(now));
    expect(historyWindowStartEpoch('1y', now)).toBeGreaterThan(historyWindowStartEpoch('10y', now));
    expect(historyWindowStartEpoch('max', now)).toBe(0);
    expect(yahooChartProvenanceUrl('ARKK')).toBe('https://query1.finance.yahoo.com/v8/finance/chart/ARKK');
  });

  test('system CA: certificate errors are recognized (also through .cause), fetch is wrapped only in auto mode and restarts once', async () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
    let restarts = 0;
    const reexec = () => { restarts += 1; return undefined as never; };
    const original = globalThis.fetch;
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(original);
    installSystemCa('true', reexec, true);
    expect(restarts).toBe(0);
    installSystemCa('true', reexec, false);
    expect(restarts).toBe(1);

    restarts = 0;
    let next: () => Promise<Response> = async () => new Response('ok');
    globalThis.fetch = (async () => next()) as unknown as typeof fetch;
    const base = globalThis.fetch;
    installSystemCa('auto', reexec, false);
    expect(globalThis.fetch).not.toBe(base);
    expect(await (await fetch('https://example.test/')).text()).toBe('ok');
    next = async () => { throw new Error('ECONNRESET'); };
    await expect(fetch('https://example.test/')).rejects.toThrow('ECONNRESET');
    expect(restarts).toBe(0);
    next = async () => { throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }); };
    await fetch('https://example.test/');
    expect(restarts).toBe(1);
  });
});
