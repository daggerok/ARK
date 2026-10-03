#!/usr/bin/env bun
/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARK_FUNDS,
  CONTROL_NAMES,
  DEFAULT_SEC_UA,
  historyWindowStartEpoch,
  resolveControls,
  isCertError,
  installSystemCa,
  ARKY_HOLDINGS_HEADERS,
  ProviderHttpError,
  arkApiUrls,
  ISSUER_PROXY_MIN_INTERVAL_MS,
  RUN_SOFT_DEADLINE_MS,
  main,
  mergeHistoryRows,
  parseArkCatalogSlugs,
  detectUnlistedArkFunds,
  isoStamp,
  writeFileAtomic,
  ISSUER_USER_AGENT,
  REQUEST_TIMEOUT_MS,
  USAGE,
  withRequestLane,
  createPacedGate,
  createRequestClients,
  createSecFallbackResolver,
  jinaReaderUrl,
  parseProviderJson,
  updateArkFund,
  unwrapJinaReaderText,
  HOLDINGS_HEADERS,
  buildFundMetrics,
  buildOfficialReturns,
  resolveReturnMetrics,
  OFFICIAL_RETURNS_BASIS,
  YAHOO_RETURNS_BASIS,
  UNAVAILABLE_RETURNS_BASIS,
  buildPageEnvelope,
  buildYahooReturns,
  cumulativeFromAnnualized,
  annualizedFromCumulative,
  displayDate,
  edgarSeriesFilingsUrl,
  extractFundPageId,
  formatDistributionFrequency,
  inferDistributionFrequency,
  nportToHoldings,
  nportUrlFor,
  numberOrNull,
  pageFileName,
  parseAumRange,
  parseArkCatalogHtml,
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
  parseRange,
  parseYahooChart,
  passesMetricFilters,
  passesStaticFilters,
  paymentsPerYear,
  readConfig,
  runUpdater,
  semanticContentKey,
  splitPages,
  stableStringify,
  toIsoDate,
  trailingDividendYield,
  yahooChartProvenanceUrl,
  yahooChartUrl,
  writeIfChanged,
  writeJsonIfChanged,
} from './update-data';
// Small inline samples of the official ARK payloads (no captured pages).
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
const arkyRows = [
  'position,cusip,$ notional per note,market value ($),market weight (%)',
  'GOLDMAN FS TRSY OBLIG INST 468,X9USDGSFT,"35,922,746","$35,922,745.78",86.13%',
  'TREASURY BILL 0 8/5/2027,912797VR5,"4,900,000","$4,718,634.73",11.31%',
  'BMNR Autocall ELN LONG TRS 31.22 PA 10/18/2027,1740056,"800,000","$136,407.00",0.33%',
].join('\r\n') + '\r\n';
const arkyCsv = arkyRows;

// readConfig rejects MAX_RETRIES < 1; unit tests that must not retry zero it on the parsed config
const noRetryConfig = (env: Record<string, string>): ReturnType<typeof readConfig> => ({ ...readConfig(env), maxRetries: 0 });

describe('ARK catalog and official page parsers', () => {
  test('the supported universe contains exactly the 14 official ETFs and excludes ARKVX', () => {
    expect(ARK_FUNDS).toHaveLength(14);
    expect(ARK_FUNDS.map((fund) => fund.ticker)).toEqual([
      'ARKB', 'ARKD', 'ARKE', 'ARKF', 'ARKG', 'ARKI', 'ARKK', 'ARKQ', 'ARKT', 'ARKW', 'ARKX', 'ARKY', 'IZRL', 'PRNT',
    ]);
    expect(ARK_FUNDS.some((fund) => fund.ticker === 'ARKVX')).toBe(false);
    expect(ARK_FUNDS.find((fund) => fund.ticker === 'ARKW')?.name).toBe('ARK Next Generation Technology ETF');
    expect(ARK_FUNDS.find((fund) => fund.ticker === 'ARKF')?.name).toBe('ARK Blockchain & Fintech Innovation ETF');
    expect(ARK_FUNDS.find((fund) => fund.ticker === 'ARKX')?.name).toBe('ARK Space & Defense Innovation ETF');
  });

  test('official catalog discovery keeps only supported ETF paths', () => {
    const html = '<a href="/funds/arkk">ARKK</a><a href="/funds/arkvx">Venture Fund</a><a href="/funds/arky/">ARKY</a><a href="/funds/arkk">duplicate</a>';
    expect(parseArkCatalogHtml(html).map((fund) => fund.ticker)).toEqual(['ARKK', 'ARKY']);
    expect(parseArkCatalogHtml('<html>no ETF links</html>')).toEqual([]);
  });

  test('internal fund id is parsed from the official page instead of hard-coded', () => {
    expect(extractFundPageId('<script>url: "/api/fund/overview/1004"</script>')).toBe('1004');
    expect(extractFundPageId('<html>no endpoint</html>')).toBeNull();
  });

  test('overview parser reads issuer facts, scaled net assets, fee and effective dates', () => {
    const parsed = parseArkOverview(overviewSample);
    expect(parsed.ticker).toBe('ARKK');
    expect(parsed.netAssets).toBe(5_562_000_000);
    expect(parsed.netAssetsText).toBe('$5,562 Million');
    expect(parsed.fundType).toBe('Active Equity ETF');
    expect(parsed.cusip).toBe('00214Q104');
    expect(parsed.isin).toBe('US00214Q1040');
    expect(parsed.exchange).toBe('Cboe BZX');
    expect(parsed.inceptionDate).toBe('2014-10-31');
    expect(parsed.expenseRatio).toBe(0.75);
    expect(parsed.asOfDate).toBe('2026-08-31');
  });

  test('overview parser falls back to TOTAL FEES when the details block omits expense ratio', () => {
    const payload = {
      detailsView: '<ul><li>TICKER <span>TEST</span></li><li>NET ASSETS <span>$10 Million</span></li></ul>',
      feesView: '<div><b>TOTAL FEES</b><span>0.40%</span></div>',
      formattedDate: 'As of 9/30/2026',
    };
    const parsed = parseArkOverview(payload);
    expect(parsed.expenseRatio).toBe(0.4);
    expect(parsed.asOfDate).toBe('2026-09-30');
    expect(parsed.netAssets).toBe(10_000_000);
  });

  test('official NAV history parser sorts source points and computes premium/discount', () => {
    const rows = parseArkNavHistory(navHistorySample);
    expect(rows).toHaveLength(4);
    expect(rows[0].date).toBe('2014-10-31');
    expect(rows[0].nav).toBe(20.12);
    expect(rows[0].marketPrice).toBe(20.38);
    expect(rows[0].premiumDiscount).toBe(1.2922);
    expect(rows.at(-1)?.date).toBe('2026-09-25');
    expect(rows.at(-1)?.nav).toBe(90.78);
    expect(rows.at(-1)?.marketPrice).toBe(90.77);
  });

  test('official performance parser reads month-end and quarter-end NAV tables', () => {
    const month = parseArkPerformance(monthPerformanceSample);
    const quarter = parseArkPerformance(quarterPerformanceSample);
    expect(month.ticker).toBe('ARKK');
    expect(month.asOfDate).toBe('2026-08-31');
    expect(month.navAnnualized['1Y']).toBe(14.07);
    expect(month.navAnnualized['3Y']).toBe(25.02);
    expect(month.navAnnualized['5Y']).toBe(-6.7);
    expect(month.navAnnualized['10Y']).toBe(16.15);
    expect(month.navAnnualized.SI).toBe(13.98);
    expect(month.navCumulative.YTD).toBe(11.13);
    expect(month.navCumulative.SI).toBe(370.38);
    expect(quarter.asOfDate).toBe('2026-06-30');
    expect(quarter.navAnnualized['1Y']).toBe(14.82);
    const returns = buildOfficialReturns(month, quarter);
    expect(returns.monthEnd.asOfDate).toBe('Aug 31 2026');
    expect(returns.monthEnd.ytd).toBe(11.13);
    expect(returns.quarterEnd.asOfDate).toBe('Jun 30 2026');
    expect(returns.metrics.cagr3y).toBe(25.02);
    expect(returns.metrics.tr3y).toBe(cumulativeFromAnnualized(25.02, 3));
    expect(returns.metrics.returnsBasis).toContain('official ARK Invest');
    expect(returns.metrics.performanceAsOf).toBe('2026-08-31');
  });

  test('performance parser supports reordered headings, zeroes and unavailable cells', () => {
    const payload = {
      ticker: 'TEST',
      view: '<div class="b-date__text">As of 06/30/2026</div>' +
        '<div id="tab-annualized"><table><tr><td>TEST</td><td>5 Years</td><td>1 Year</td><td>3 Years</td></tr>' +
        '<tr><td>NAV</td><td>0.00%</td><td>-2.5%</td><td>—</td></tr></table></div>' +
        '<div id="tab-cumulative"><table><tr><td>TEST</td><td>YTD</td><td>Since Inception</td></tr>' +
        '<tr><td>NAV</td><td>0.00%</td><td>10.00%</td></tr></table></div>' +
        '<div id="tab-calendar-year"><table><tr><td>TEST</td><td>2025 Year</td></tr><tr><td>NAV</td><td>0.00%</td></tr></table></div>',
    };
    const parsed = parseArkPerformance(payload);
    expect(parsed.asOfDate).toBe('2026-06-30');
    expect(parsed.navAnnualized['5Y']).toBe(0);
    expect(parsed.navAnnualized['1Y']).toBe(-2.5);
    expect(parsed.navAnnualized['3Y']).toBeNull();
    expect(parsed.navCumulative.YTD).toBe(0);
    expect(parsed.navCalendar['2025']).toBe(0);
  });
});

describe('official holdings CSV parsers', () => {
  test('RFC-4180 parser handles BOM, CRLF, quoted commas, and escaped double-quotes', () => {
    expect(parseCsv('\uFEFFname,shares\r\n"A, B Inc.","1,234"\r\n"The ""Quoted"" Co",2\r\n')).toEqual([
      ['name', 'shares'], ['A, B Inc.', '1,234'], ['The "Quoted" Co', '2'],
    ]);
    expect(() => parseCsv('name,value\n"unterminated,1')).toThrow('unterminated');
  });

  test('standard ARK CSV preserves source identifiers, share counts, market values and weights', () => {
    const parsed = parseArkHoldingsCsv(arkkCsv, 'ARKK');
    expect(parsed.headers).toEqual([...HOLDINGS_HEADERS]);
    expect(parsed.totalRows).toBe(3); // source also has one trailing legal disclaimer row
    expect(parsed.asOfDate).toBe('2026-09-28');
    expect(parsed.rows[0]).toMatchObject({
      Name: 'TESLA INC', Ticker: 'TSLA', Identifier: '88160R101', Weight: '9.12%',
      'Market Value': '$796,708,348.16', 'Shares Held': '2,141,056', 'Asset Category': 'Equity',
    });
    expect(parsed.rows.some((row) => row.Name.includes('SPACE EXPLORATION'))).toBe(true);
  });

  test('ARKY uses the separate five-source-column parser and does not mislabel notional as shares', () => {
    const parsed = parseArkHoldingsCsv(arkyCsv, 'ARKY', 'Mon, 28 Sep 2026 06:05:49 GMT');
    expect(parsed.headers).toEqual([...ARKY_HOLDINGS_HEADERS]);
    expect(parsed.totalRows).toBe(3);
    expect(parsed.asOfDate).toBe('2026-09-28');
    expect(parsed.rows[0]).toMatchObject({
      Name: 'GOLDMAN FS TRSY OBLIG INST 468', Ticker: '', Identifier: 'X9USDGSFT',
      Weight: '86.13%', 'Market Value': '$35,922,745.78', 'Shares Held': '',
      'Asset Category': 'Cash & Equivalents', 'Notional per Note': '35,922,746',
    });
    expect(parsed.rows[1]['Asset Category']).toBe('Treasury');
    expect(parsed.rows[2]['Asset Category']).toBe('Structured Note');
  });

  test('ARKY source percentages over 100 percent are preserved unchanged', () => {
    const synthetic = arkyRows + 'OVERWEIGHT NOTE,CUSIP-X,1,1,101.25%\r\n';
    const parsed = parseArkHoldingsCsv(synthetic, 'ARKY', '2026-09-28');
    expect(parsed.rows.at(-1)?.Weight).toBe('101.25%');
    expect(numberOrNull(parsed.rows.at(-1)?.Weight)).toBe(101.25);
  });

  test('mismatched or malformed provider CSV is rejected rather than published as empty', () => {
    expect(() => parseArkHoldingsCsv('html error', 'ARKK')).toThrow('header row not found');
    expect(() => parseArkHoldingsCsv(arkkCsv.replace('ARKK,', 'ARKQ,'), 'ARKK')).toThrow('contains fund ARKQ');
    expect(() => parseArkHoldingsCsv(arkyCsv, 'ARKK')).toThrow('unexpected structured-note layout');
  });
});

describe('Yahoo fallback and return math', () => {
  test('Yahoo chart URL has explicit full daily period bounds and a stable provenance URL', () => {
    const url = new URL(yahooChartUrl('ARKK', 1_800_000_000));
    expect(url.searchParams.get('period1')).toBe('0');
    expect(url.searchParams.get('period2')).toBe('1800000000');
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('events')).toBe('div|split');
    expect(url.searchParams.get('includeAdjustedClose')).toBe('true');
    expect(yahooChartProvenanceUrl('ARKK')).toBe('https://query1.finance.yahoo.com/v8/finance/chart/ARKK');
    expect(yahooChartProvenanceUrl('ARKK')).not.toContain('?');
  });

  test('Yahoo chart parser rounds adjusted close to cents and parses events', () => {
    const payload: unknown = {
      chart: { result: [{
        timestamp: [1_757_030_400, 1_757_116_800],
        indicators: { quote: [{ close: [100.123, 101.987], volume: [1000, 1200] }], adjclose: [{ adjclose: [99.999, 101.876] }] },
        events: { dividends: { '1757030400': { amount: 0.25, date: 1_757_030_400 } } },
        meta: { exchangeName: 'Cboe BZX', currency: 'USD', regularMarketPrice: 101.99, firstTradeDate: 1_757_030_400 },
      }], error: null },
    };
    const parsed = parseYahooChart(payload);
    expect(parsed.points).toHaveLength(2);
    expect(parsed.points[0].close).toBe(100.12);
    expect(parsed.points[0].adjClose).toBe(100);
    expect(parsed.points[1].adjClose).toBe(101.88);
    expect(parsed.dividends).toEqual([{ date: parsed.points[0].date, amount: 0.25 }]);
    expect(parsed.exchangeName).toBe('Cboe BZX');
    expect(parsed.regularMarketPrice).toBe(101.99);
  });

  test('annualized and cumulative return conversions preserve negatives and reject invalid bases', () => {
    expect(cumulativeFromAnnualized(10, 3)).toBe(33.1);
    expect(annualizedFromCumulative(33.1, 3)).toBe(10);
    expect(cumulativeFromAnnualized(null, 3)).toBeNull();
    expect(annualizedFromCumulative(-100, 3)).toBeNull();
  });

  test('Yahoo-derived returns use only completed month/quarter ends and adjusted closes', () => {
    const points = [
      { date: '2025-06-30', close: 100, adjClose: 100, volume: 1 },
      { date: '2025-12-31', close: 110, adjClose: 110, volume: 1 },
      { date: '2026-03-31', close: 120, adjClose: 120, volume: 1 },
      { date: '2026-06-30', close: 125, adjClose: 125, volume: 1 },
      { date: '2026-08-31', close: 130, adjClose: 130, volume: 1 },
      { date: '2026-09-25', close: 140, adjClose: 140, volume: 1 },
    ];
    const derived = buildYahooReturns(points, new Date('2026-09-28T12:00:00Z'));
    expect(derived.monthEnd.asOfDate).toBe('Aug 31 2026');
    expect(derived.monthEnd.ytd).toBe(18.18);
    expect(derived.quarterEnd.asOfDate).toBe('Jun 30 2026');
    expect(derived.quarterEnd.ytd).toBe(13.64);
    expect(derived.metrics.returnsBasis).toContain('Yahoo Finance');
    expect(derived.metrics.performanceAsOf).toBe('2026-08-31');
  });

  test('metrics contract: full key set, basis and as-of last, null never zero', () => {
    const official = { ytd: 5, tr1y: 10, cagr3y: 8, returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-08-31' };
    const yahoo = { ytd: 6, tr1y: 11, cagr3y: 9, cagr5y: 7, returnsBasis: YAHOO_RETURNS_BASIS, performanceAsOf: '2026-08-31' };
    const officialOnly = buildFundMetrics(resolveReturnMetrics(official, {}, {}), null, null);
    expect(Object.keys(officialOnly)).toEqual([
      'ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn',
      'dividendYield', 'dividendYieldText', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf',
    ]);
    expect(officialOnly.tr3y).toBeNull();
    expect(officialOnly.ytd).toBe(5);
    expect(officialOnly.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);
    expect(officialOnly.performanceAsOf).toBe('2026-08-31');

    // One source per fund: the official unit wins whole, a Yahoo-only figure never fills its nulls
    const unit = resolveReturnMetrics(official, yahoo, {});
    expect(unit.cagr5y).toBeNull();
    expect(unit.ytd).toBe(5);
    expect(unit.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);

    const yahooOnly = resolveReturnMetrics({}, { ...yahoo, performanceAsOf: '2026-09-25' }, {});
    expect(yahooOnly.returnsBasis).toBe(YAHOO_RETURNS_BASIS);
    expect(yahooOnly.performanceAsOf).toBe('2026-09-25');

    const retained = resolveReturnMetrics({}, {}, { ytd: 3, returnsBasis: OFFICIAL_RETURNS_BASIS, performanceAsOf: '2026-07-31' });
    expect(retained.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);
    expect(retained.performanceAsOf).toBe('2026-07-31');

    const nothing = buildFundMetrics(resolveReturnMetrics({}, {}, {}), 1.5, null);
    expect(nothing.returnsBasis).toBe(UNAVAILABLE_RETURNS_BASIS);
    expect(nothing.performanceAsOf).toBeNull();
    expect(nothing.dividendYield).toBe(1.5);
    const serialized = JSON.parse(stableStringify({ b: 1, metrics: { ytd: 1, returnsBasis: 'x', performanceAsOf: null, a: 2 } }));
    expect(Object.keys(serialized)).toEqual(['b', 'metrics']);
    expect(Object.keys(serialized.metrics)).toEqual(['ytd', 'returnsBasis', 'performanceAsOf', 'a']);
    expect(buildFundMetrics({ returnsBasis: '-' }, null, null).returnsBasis).toBe(UNAVAILABLE_RETURNS_BASIS);
    expect(buildFundMetrics({ performanceAsOf: '' }, null, null).performanceAsOf).toBeNull();
  });

  test('dividend yield/frequency handling distinguishes None placeholder from Unknown', () => {
    expect(formatDistributionFrequency(null)).toBe('00 - None');
    expect(formatDistributionFrequency('')).toBe('00 - None');
    expect(formatDistributionFrequency('—')).toBe('00 - None');
    expect(formatDistributionFrequency('None')).toBe('00 - None');
    expect(formatDistributionFrequency('Unknown')).toBe('00 - Unknown');
    expect(formatDistributionFrequency('MDEC')).toBe('01 - Monthly');
    expect(formatDistributionFrequency('QDEC')).toBe('04 - Quarterly');
    expect(formatDistributionFrequency('YDEC')).toBe('12 - Annually');
    expect(paymentsPerYear('Monthly')).toBe(12);
    expect(paymentsPerYear('Quarterly')).toBe(4);
    expect(paymentsPerYear('Unknown')).toBeNull();
    expect(inferDistributionFrequency([], new Date('2026-09-28T00:00:00Z'))).toBeNull();
    expect(inferDistributionFrequency(['2026-07-01', '2026-08-01'], new Date('2026-09-28T00:00:00Z'))).toBe('Unknown');
    expect(inferDistributionFrequency(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], new Date('2026-09-28T00:00:00Z'))).toBe('Monthly');
    expect(trailingDividendYield([{ date: '2026-06-01', amount: 0.5 }, { date: '2026-08-01', amount: 0.5 }], 100, '2026-09-28')).toBe(1);
    expect(trailingDividendYield([], 100, '2026-09-28')).toBeNull();
  });
});

describe('configuration and filters', () => {
  test('readConfig normalizes tickers and reads exact ranges and controls', () => {
    const config = readConfig({
      TICKERS: 'arkk, ARKY ARKB', CATEGORY: 'Equity', REQUEST_SLEEP: '2.25', CONCURRENCY: '3', MAX_FETCHES: '4',
      AUM: '1B:', TER: ':0.75', PERFORMANCE_3Y: '10:30', TOTAL_RETURN_5Y: '-50:100', EDGAR_FALLBACK: '0',
    });
    expect(config.tickers).toEqual(['ARKK', 'ARKY', 'ARKB']);
    expect(config.category).toBe('Equity');
    expect(config.requestSleepSeconds).toBe(2.25);
    expect(config.concurrency).toBe(3);
    expect(config.maxFetches).toBe(4);
    expect(config.aumRange?.min).toBe(1_000_000_000);
    expect(config.aumRange?.max).toBe(Number.POSITIVE_INFINITY);
    expect(config.terRange?.max).toBe(0.75);
    expect(config.performanceRanges['3Y']?.min).toBe(10);
    expect(config.totalReturnRanges['5Y']?.min).toBe(-50);
    expect(config.edgarFallback).toBe(false);
  });

  test('range parser validates boundaries and AUM presets', () => {
    expect(parseRange('', 'TER')).toBeUndefined();
    expect(parseRange(':', 'TER')).toBeUndefined();
    expect(parseRange('1%:4%', 'TER')).toMatchObject({ min: 1, max: 4 });
    expect(parseRange(':2', 'TER')?.min).toBe(Number.NEGATIVE_INFINITY);
    expect(() => parseRange('5:1', 'TER')).toThrow('minimum exceeds maximum');
    expect(() => parseRange('1:2:3', 'TER')).toThrow('exactly one colon');
    expect(parseAumRange('micro')).toMatchObject({ min: 10_000_000, max: 300_000_000 });
    expect(parseAumRange('small:large')).toMatchObject({ min: 300_000_000, max: Number.POSITIVE_INFINITY });
    expect(parseAumRange('1.5B:')).toMatchObject({ min: 1_500_000_000, max: Number.POSITIVE_INFINITY });
  });

  test('static and post-fetch filters are ANDed; a bounded return range excludes funds without that figure', () => {
    const config = readConfig({ TICKERS: 'ARKK ARKY', CATEGORY: 'equity', AUM: '1B:', TER: ':1', PERFORMANCE_3Y: '10:30' });
    const arkk = ARK_FUNDS.find((fund) => fund.ticker === 'ARKK')!;
    const arky = ARK_FUNDS.find((fund) => fund.ticker === 'ARKY')!;
    expect(passesStaticFilters(arkk, config)).toBe(true);
    expect(passesStaticFilters(arky, config)).toBe(false);
    const entry = { aumValue: 2_000_000_000, terValue: 0.75, metrics: { dividendYield: null, secYield: null, tr1y: 12, cagr3y: null }, returns: { monthEnd: { ytd: 5, yr1: 12, yr3: null } } };
    expect(passesMetricFilters(entry, config)).toBe(false);
    const withThreeYear = { ...entry, metrics: { ...entry.metrics, cagr3y: 20 }, returns: { monthEnd: { ytd: 5, yr1: 12, yr3: 20 } } };
    expect(passesMetricFilters(withThreeYear, config)).toBe(true);
    expect(passesMetricFilters({ ...withThreeYear, aumValue: 500_000_000 }, config)).toBe(false);
    expect(passesMetricFilters({ ...entry, metrics: { ...entry.metrics, cagr3y: 35 } }, config)).toBe(false);
    // 3Y bounded and the fund has no 3Y figure (young fund): excluded, not waved through
    expect(passesMetricFilters({ ...entry, metrics: { ...entry.metrics, cagr3y: null }, returns: { monthEnd: { ytd: 5, yr1: 12, yr3: null } } }, config)).toBe(false);
    expect(passesMetricFilters({ ...entry, metrics: { ...entry.metrics, tr3y: null } }, readConfig({ TOTAL_RETURN_3Y: '0:' }))).toBe(false);
    // an unbounded return range keeps funds without the figure
    expect(passesMetricFilters(entry, readConfig({}))).toBe(true);
  });
});

describe('SEC fallback parsing and static output helpers', () => {
  test('N-PORT XML parser retains trust/series/period and maps position values', () => {
    const xml = `<edgarSubmission><genInfo><regName>ARK ETF Trust</regName><regCik>0001579982</regCik><seriesName>ARK Innovation ETF</seriesName><seriesId>S000012345</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo><invstOrSec><name>EXAMPLE CORP</name><cusip>123456789</cusip><balance>25</balance><valUSD>1000</valUSD><pctVal>0.1</pctVal><assetCat>EC</assetCat></invstOrSec></edgarSubmission>`;
    const parsed = parseNportXml(xml);
    expect(parsed.regName).toBe('ARK ETF Trust');
    expect(parsed.regCik).toBe('0001579982');
    expect(parsed.seriesName).toBe('ARK Innovation ETF');
    expect(parsed.seriesId).toBe('S000012345');
    expect(parsed.repPdDate).toBe('2026-06-30');
    expect(parsed.netAssets).toBe(1_000_000);
    expect(nportToHoldings(parsed)[0]).toMatchObject({
      Name: 'EXAMPLE CORP', Identifier: '123456789', Weight: '0.1%', 'Market Value': '1000', 'Shares Held': '25', 'Asset Category': 'EC',
    });
  });

  test('SEC mutual-fund ticker table and submissions resolve accession URLs', () => {
    const map = parseFundTickerMap({
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[1579982, 'S000012345', 'C000012345', 'ARKK'], [1869699, 'S000067890', 'C000067890', 'ARKB']],
    });
    expect(map.get('ARKK')).toEqual({ cik: '0001579982', seriesId: 'S000012345', classId: 'C000012345' });
    expect(map.get('ARKB')?.cik).toBe('0001869699');
    const accessions = parseNportAccessions({
      cik: '1579982', filings: { recent: {
        form: ['NPORT-P', '497K'], accessionNumber: ['0001579982-26-000001', '0001579982-26-000002'],
        filingDate: ['2026-08-15', '2026-08-16'], reportDate: ['2026-06-30', ''],
      } },
    });
    expect(accessions).toHaveLength(1);
    expect(accessions[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml');
    expect(nportUrlFor('0001579982', '0001579982-26-000001')).toContain('/1579982/000157998226000001/');
    expect(edgarSeriesFilingsUrl('S000012345')).toContain('CIK=S000012345');
  });

  test('SEC company names map to exchange tickers and Atom results map to primary_doc.xml', () => {
    const companies = parseCompanyTickerMap({ '0': { cik_str: 1, ticker: 'EXM', title: 'Example Corporation' } });
    const parsed = parseNportXml('<edgarSubmission><invstOrSec><name>Example Corporation</name><balance>1</balance><valUSD>50</valUSD><pctVal>0.1</pctVal><assetCat>EC</assetCat></invstOrSec></edgarSubmission>');
    expect(nportToHoldings(parsed, companies)[0].Ticker).toBe('EXM');
    const atom = '<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001579982-26-000001</accession-number><filing-href>https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/</filing-href><period>2026-06-30</period></entry></feed>';
    expect(parseEdgarAtomFilings(atom)[0].url).toContain('/1579982/000157998226000001/primary_doc.xml');
  });

  test('SEC Atom feeds with category/link attributes resolve series accessions', () => {
    const atom = '<feed><entry><category term="NPORT-P"/><updated>2026-09-01T00:00:00Z</updated><link href="https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/" rel="alternate"/></entry></feed>';
    expect(parseEdgarAtomFilings(atom)).toEqual([{
      accession: '0001579982-26-000001', filed: '2026-09-01T00:00:00Z', reportDate: '',
      url: 'https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml',
    }]);
  });

  test('SEC fallback resolver validates trust and maps a series filing without live requests', async () => {
    const calls: string[] = [];
    const secClients = {
      ark: async (url: string) => ({ text: '', url, headers: new Headers() }),
      azure: async (url: string) => ({ text: '', url, headers: new Headers() }),
      yahoo: async (url: string) => ({ text: '', url, headers: new Headers() }),
      sec: async (url: string) => {
        calls.push(url);
        if (url.endsWith('company_tickers_mf.json')) return { text: JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1579982, 'S000012345', 'C000012345', 'ARKK']] }), url, headers: new Headers() };
        if (url.includes('browse-edgar')) return { text: '<feed><entry><category term="NPORT-P"/><link href="https://www.sec.gov/Archives/edgar/data/1579982/000157998226000001/"/></entry></feed>', url, headers: new Headers() };
        return { text: '<edgarSubmission><genInfo><regName>ARK ETF Trust</regName><regCik>0001579982</regCik><seriesName>ARK Innovation ETF</seriesName><seriesId>S000012345</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo><invstOrSec><name>EXAMPLE CORP</name><ticker>EXM</ticker><cusip>123456789</cusip><balance>25</balance><valUSD>1000</valUSD><pctVal>0.1</pctVal><assetCat>EC</assetCat></invstOrSec></edgarSubmission>', url, headers: new Headers() };
      },
      isArkProxyActive: () => false,
    };
    const fund = ARK_FUNDS.find((item) => item.ticker === 'ARKK')!;
    const result = await createSecFallbackResolver(secClients)(fund);
    expect(result?.selected.accession).toBe('0001579982-26-000001');
    expect(result?.parsed.seriesId).toBe('S000012345');
    expect(result?.holdings[0]).toMatchObject({ Ticker: 'EXM', Weight: '0.1%', 'Shares Held': '25' });
    expect(calls.some((url) => url.includes('/Archives/edgar/data/1579982/000157998226000001/primary_doc.xml'))).toBe(true);
  });

  test('pagination names and stable JSON are deterministic; timestamps are ignored only for content comparison', () => {
    expect(splitPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pageFileName(1)).toBe('001.json');
    expect(pageFileName(1002)).toBe('1002.json');
    expect(() => splitPages([1], 0)).toThrow('positive integer');
    expect(buildPageEnvelope('ARKK', 1, 2, 3, ['Ticker'], [{ Ticker: 'TSLA' }])).toMatchObject({ ticker: 'ARKK', page: 1, pageSize: 2, totalRows: 3 });
    expect(stableStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(stableStringify({ a: { x: 3, y: 2 }, z: 1 }));
    expect(semanticContentKey({ generatedAt: 'A', nested: { catalogReadAt: 'B', value: 1 } })).toBe(semanticContentKey({ generatedAt: 'C', nested: { catalogReadAt: 'D', value: 1 } }));
  });

  test('writeIfChanged distinguishes the first write from an identical rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ark-sample-'));
    try {
      const file = join(directory, 'funds', 'ARKK', '001.json');
      expect(await writeIfChanged(file, '{"rows":[]}\n')).toBe('written');
      expect(await writeIfChanged(file, '{"rows":[]}\n')).toBe('unchanged');
      expect(await readFile(file, 'utf8')).toBe('{"rows":[]}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('formatting helpers', () => {
  test('dates, identifiers and amount parsing preserve stable normalized output', () => {
    expect(toIsoDate('09/28/2026')).toBe('2026-09-28');
    expect(toIsoDate('Mon, 28 Sep 2026 06:05:49 GMT')).toBe('2026-09-28');
    expect(displayDate('2026-09-28')).toBe('Sep 28 2026');
    expect(numberOrNull('($1,234.50)')).toBe(-1234.5);
    expect(numberOrNull('—')).toBeNull();
  });
});

describe('paced provider request clients', () => {
  test('independent lanes pace separately and remain usable after a rejected request', async () => {
    let clock = 0;
    const waits: number[] = [];
    const starts: number[] = [];
    const gate = createPacedGate(2, 100, {
      now: () => clock,
      sleep: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    });
    const work = [
      gate(() => { starts.push(clock); return 'first'; }),
      gate(() => { starts.push(clock); return 'second'; }),
      gate(() => { starts.push(clock); return 'third'; }),
      gate(() => { starts.push(clock); throw new Error('expected rejection'); }),
    ];
    await expect(Promise.all(work)).rejects.toThrow('expected rejection');
    expect(starts).toHaveLength(4);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBe(0);
    expect(starts[2]).toBeGreaterThanOrEqual(100);
    expect(starts[3]).toBeGreaterThanOrEqual(100);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.every((milliseconds) => milliseconds === 100)).toBe(true);
    await expect(gate(() => 'recovered')).resolves.toBe('recovered');
  });

  test('temporary HTTP errors retry through the same paced client', async () => {
    const calls: string[] = [];
    const retries: string[] = [];
    const waits: number[] = [];
    const client = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1' }), {
      fetchImpl: async (input) => {
        calls.push(String(input));
        return calls.length === 1
          ? new Response('temporarily unavailable', { status: 503 })
          : new Response('ready', { status: 200 });
      },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      onRetry: (message) => retries.push(message),
    });
    await expect(client.azure('https://assets.example.test/fund.csv')).resolves.toMatchObject({ text: 'ready' });
    expect(calls).toEqual(['https://assets.example.test/fund.csv', 'https://assets.example.test/fund.csv']);
    expect(waits).toEqual([500]);
    expect(retries[0]).toContain('[ retry    ] ARK holdings HTTP 503');
  });

  test('a first ARK denial is retried once, then the request and all later ones use the proxy (raw page HTML and plain API text)', async () => {
    const calls: Array<{ url: string; respondWith: string | null }> = [];
    const notices: string[] = [];
    let clock = 0;
    const client = createRequestClients(noRetryConfig({ REQUEST_SLEEP: '0' }), {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const respondWith = new Headers(init?.headers).get('x-respond-with');
        calls.push({ url, respondWith });
        if (url.startsWith('https://r.jina.ai/')) {
          if (url.includes('/api/')) return new Response('{"ok":true}', { status: 200 });
          const id = url.includes('/funds/arkk') ? '1004' : '1010';
          return new Response(`<html><script>url: "/api/fund/overview/${id}"</script></html>`, { status: 200 });
        }
        return new Response('blocked', { status: 403 });
      },
      onIssuerProxy: (message) => notices.push(message),
    });
    // The first 403 is retried once directly and then THIS request goes through the proxy (it is not lost)
    await expect(client.ark('https://www.ark-funds.com/our-etfs/')).resolves.toBeDefined();
    expect(client.isArkProxyActive()).toBe(true);
    const pageUrls = ['https://www.ark-funds.com/funds/arkk', 'https://www.ark-funds.com/funds/arkb'];
    const pageResponses = await Promise.all(pageUrls.map((url) => client.ark(url)));
    expect(pageResponses.map((response) => extractFundPageId(response.text))).toEqual(['1004', '1010']);
    await expect(client.ark('https://www.ark-funds.com/api/fund/overview/1004')).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(client.isArkProxyActive()).toBe(true);
    expect(calls.filter((call) => !call.url.startsWith('https://r.jina.ai/'))).toHaveLength(2);
    const proxiedPages = calls.filter((call) => call.url.startsWith('https://r.jina.ai/') && call.url.includes('/funds/'));
    expect(proxiedPages).toHaveLength(2);
    expect(proxiedPages.every((call) => call.respondWith === 'html')).toBe(true);
    expect(calls.find((call) => call.url.includes('/api/fund/overview/1004'))?.respondWith).toBe('text');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('[ issuer   ]');
  });

  test('proxied issuer requests never start closer than the r.jina.ai keyless limit allows', async () => {
    let clock = 0;
    const proxyStarts: number[] = [];
    const client = createRequestClients(noRetryConfig({ REQUEST_SLEEP: '0' }), {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/')) {
          proxyStarts.push(clock);
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('blocked', { status: 403 });
      },
      onIssuerProxy: () => undefined,
    });
    await client.ark('https://www.ark-funds.com/api/fund/overview/1004');
    await Promise.all([
      client.ark('https://www.ark-funds.com/api/fund/overview/1004'),
      client.ark('https://www.ark-funds.com/api/fund/overview/1001'),
      client.ark('https://www.ark-funds.com/api/fund/overview/1002'),
    ]);
    expect(client.isArkProxyActive()).toBe(true);
    expect(proxyStarts).toHaveLength(4);
    expect(ISSUER_PROXY_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(3200);
    for (let index = 1; index < proxyStarts.length; index += 1) {
      expect(proxyStarts[index] - proxyStarts[index - 1]).toBeGreaterThanOrEqual(ISSUER_PROXY_MIN_INTERVAL_MS);
    }
  });

  test('a stalled provider connection is aborted by the request timeout and retried', async () => {
    const retries: string[] = [];
    let calls = 0;
    const client = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1' }), {
      requestTimeoutMs: 20,
      sleep: async () => undefined,
      onRetry: (message) => retries.push(message),
      fetchImpl: (input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
          });
        }
        return Promise.resolve(new Response('recovered', { status: 200 }));
      },
    });
    expect(REQUEST_TIMEOUT_MS).toBe(45_000);
    await expect(client.azure('https://assets.example.test/fund.csv')).resolves.toMatchObject({ text: 'recovered' });
    expect(calls).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain('[ retry    ] ARK holdings network error (TimeoutError:');
  });

  test('the request timeout starts when the request starts, not while it waits in a pacing queue', async () => {
    // Real timers: a 40 ms timeout with 3 requests queued behind a 60 ms lane.
    // Before the fix the last requests expired in the queue and were retried.
    const retries: string[] = [];
    const client = createRequestClients(noRetryConfig({ REQUEST_SLEEP: '0.06' }), {
      requestTimeoutMs: 40,
      onRetry: (message) => retries.push(message),
      fetchImpl: (input, init) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
        setTimeout(() => resolve(new Response(String(input), { status: 200 })), 5);
      }),
    });
    const urls = ['a', 'b', 'c', 'd'].map((name) => `https://assets.example.test/${name}.csv`);
    const results = await withRequestLane(60, () => Promise.all(urls.map((url) => client.azure(url))));
    expect(results.map((result) => result.text)).toEqual(urls);
    expect(retries).toEqual([]);
  });

  test('issuer requests carry the honest contact-bearing User-Agent (no browser spoofing)', async () => {
    const seen: string[] = [];
    const client = createRequestClients(noRetryConfig({ REQUEST_SLEEP: '0' }), {
      fetchImpl: async (_input, init) => { seen.push(new Headers(init?.headers).get('user-agent') ?? ''); return new Response('ok', { status: 200 }); },
    });
    await client.ark('https://www.ark-funds.com/funds/arkk');
    expect(seen).toEqual([ISSUER_USER_AGENT]);
    expect(ISSUER_USER_AGENT).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(ISSUER_USER_AGENT).toContain('@'); // contact
    expect(ISSUER_USER_AGENT).not.toMatch(/https?:\/\//); // any URL in the UA is answered with HTTP 403 by ark-funds.com
    expect(ISSUER_USER_AGENT.startsWith('Mozilla/5.0')).toBe(false);
    expect(client.isArkProxyActive()).toBe(false);
  });

  test('real HTTP: 1, 3 and 15 worker lanes overlap requests, keep per-lane spacing and improve throughput', async () => {
    const starts = new Map<string, number[]>();
    let active = 0;
    let peak = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const lane = new URL(request.url).pathname.split('/')[1]!;
      const times = starts.get(lane) ?? [];
      times.push(performance.now());
      starts.set(lane, times);
      peak = Math.max(peak, ++active);
      await Bun.sleep(20);
      active -= 1;
      return new Response('ok');
    } });
    try {
      const durations: number[] = [];
      for (const concurrency of [1, 3, 15]) {
        starts.clear();
        peak = 0;
        const client = createRequestClients(noRetryConfig({ REQUEST_SLEEP: '0.06', CONCURRENCY: String(concurrency) }));
        const funds = Array.from({ length: 15 }, (_, index) => index);
        const before = performance.now();
        await Promise.all(Array.from({ length: concurrency }, (_, lane) => withRequestLane(60, async () => {
          while (funds.length) {
            const fund = funds.shift()!;
            for (let request = 0; request < 3; request += 1) {
              const response = await client.azure(`${server.url}${lane}/${fund}/${request}`);
              expect(response.text).toBe('ok');
            }
          }
        })));
        durations.push(performance.now() - before);
        expect(starts.size).toBe(concurrency);
        expect(peak).toBe(concurrency);
        expect([...starts.values()].reduce((count, times) => count + times.length, 0)).toBe(45);
        // Server arrivals, not client starts: allow connection jitter.
        for (const times of starts.values()) {
          for (let index = 1; index < times.length; index += 1) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(40);
        }
      }
      // Wide ratio tolerance for busy CI; a single global gate cannot pass this.
      expect(durations[1]!).toBeLessThan(durations[0]! * 0.65);
      expect(durations[2]!).toBeLessThan(durations[0]! * 0.3);
      console.log('[ concurrency test ] HTTP durations ms (1/3/15 lanes):', durations.map(Math.round).join('/'));
    } finally { server.stop(true); }
  }, 15000);

  test('issuer API paths mirror the verified page parameters and proxy JSON is unwrapped', () => {
    const urls = arkApiUrls('1004');
    expect(urls.overview).toBe('https://www.ark-funds.com/api/fund/overview/1004');
    const history = new URL(urls.history);
    expect(history.pathname).toBe('/api/fund/nav-historical-change/1004');
    expect(history.searchParams.get('headingText')).toBe('NAV Historical Change');
    expect(history.searchParams.get('overviewText')).toBe('NAV and Market Price');
    const monthEnd = new URL(urls.monthEnd);
    expect(monthEnd.searchParams.get('Range')).toBe('month-end');
    expect(monthEnd.searchParams.get('Tab')).toBe('tab-annualized');
    expect(monthEnd.searchParams.get('ExcludeMarketPrice')).toBe('False');
    expect(new URL(urls.quarterEnd).searchParams.get('Range')).toBe('quarter-end');
    expect(unwrapJinaReaderText('Title: Example\nURL Source: https://example.test\nMarkdown Content:\n```json\n{"fund":1}\n```')).toBe('{"fund":1}');
    expect(parseProviderJson('Title: Example\nMarkdown Content:\n{"fund":1}')).toEqual({ fund: 1 });
  });
});

describe('per-fund filesystem integration', () => {
  test('official sample responses produce UI-compatible paginated files and byte-stable reruns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ark-update-'));
    const ticker = 'ARKK';
    const fund = ARK_FUNDS.find((item) => item.ticker === ticker)!;
    const referenceDate = new Date('2026-09-28T12:00:00.000Z');
    const epochs = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map((date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000));
    const yahooPayload = {
      chart: {
        result: [{
          timestamp: epochs,
          indicators: { quote: [{ close: [91, 92, 90, 93], volume: [10, 11, 12, 13] }], adjclose: [{ adjclose: [90, 91, 89, 92] }] },
          events: { dividends: {} },
          meta: { regularMarketPrice: 93, currency: 'USD', exchangeName: 'NYSE Arca' },
        }],
        error: null,
      },
    };
    const respond = (text: string, url: string, headers: Record<string, string> = {}) => ({ text, url, headers: new Headers(headers) });
    const arkUrls: string[] = [];
    const clients = {
      ark: async (url: string) => {
        arkUrls.push(url);
        if (url === fund.fundPage) return respond('<script>url: "/api/fund/overview/1004"</script>', url);
        if (url.includes('/api/fund/overview/1004')) return respond(JSON.stringify(overviewSample), url);
        if (url.includes('/api/fund/nav-historical-change/1004')) return respond(JSON.stringify(navHistorySample), url);
        if (url.includes('/api/fund/performance/1004')) {
          const range = new URL(url).searchParams.get('Range');
          return respond(JSON.stringify(range === 'quarter-end' ? quarterPerformanceSample : monthPerformanceSample), url);
        }
        throw new Error(`unexpected ARK URL: ${url}`);
      },
      azure: async (url: string) => respond(arkkCsv, url, { 'last-modified': 'Mon, 28 Sep 2026 06:05:47 GMT' }),
      yahoo: async (url: string) => respond(JSON.stringify(yahooPayload), url),
      sec: async (url: string) => { throw new Error(`unexpected SEC URL: ${url}`); },
      isArkProxyActive: () => false,
    };
    const config = noRetryConfig({ REQUEST_SLEEP: '0', HOLDINGS_PAGE_SIZE: '2', HISTORY_PAGE_SIZE: '2' });
    try {
      const first = await updateArkFund(fund, config, clients, { apiRoot: directory, referenceDate });
      expect(first.entry).toMatchObject({ ticker: 'ARKK', holdings: 3, history: 4, terValue: 0.75, metrics: { tr1y: 14.07, cagr3y: 25.02 } });
      expect(first.entry).toMatchObject({ returns: { monthEnd: { ytd: 11.13, asOfDate: 'Aug 31 2026' }, quarterEnd: { asOfDate: 'Jun 30 2026' } } });
      const fundRoot = join(directory, 'funds', ticker);
      const metaText = await readFile(join(fundRoot, 'meta.json'), 'utf8');
      const meta = JSON.parse(metaText) as Record<string, unknown>;
      expect(meta).toMatchObject({ source: { pageId: '1004', holdingsSource: 'official ARK daily holdings CSV', historySource: 'official ARK Invest daily NAV and market-price history API' } });
      const holdingsPage = JSON.parse(await readFile(join(fundRoot, 'holdings', '001.json'), 'utf8')) as Record<string, unknown>;
      expect(holdingsPage).toMatchObject({ ticker: 'ARKK', page: 1, totalRows: 3, headers: ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] });
      expect(holdingsPage.rows).toBeArrayOfSize(2);
      expect((holdingsPage.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ Ticker: 'TSLA', Weight: '9.12%' });
      const historyPage = JSON.parse(await readFile(join(fundRoot, 'history', '001.json'), 'utf8')) as Record<string, unknown>;
      expect(historyPage).toMatchObject({ totalRows: 4, headers: ['Date', 'NAV', 'Market Price', 'Premium/Discount'] });
      expect(historyPage.rows).toBeArrayOfSize(2);

      const paths = [
        join(fundRoot, 'meta.json'),
        join(fundRoot, 'holdings', '001.json'), join(fundRoot, 'holdings', '002.json'),
        join(fundRoot, 'history', '001.json'), join(fundRoot, 'history', '002.json'),
      ];
      const before = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      expect(arkUrls).toContain(fund.fundPage);
      arkUrls.length = 0;
      await updateArkFund(fund, config, clients, { apiRoot: directory, referenceDate });
      const after = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      expect(after).toEqual(before);
      // The published page ID is reused once the overview confirms it, so the
      // heavy fund-page render is skipped on repeat runs (never a static map).
      expect(arkUrls).not.toContain(fund.fundPage);
      expect(arkUrls.filter((url) => url.includes('/api/fund/overview/1004'))).toHaveLength(1);
      const retainedConfig = noRetryConfig({ SKIP_ARK: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0', REQUEST_SLEEP: '0', HOLDINGS_PAGE_SIZE: '2', HISTORY_PAGE_SIZE: '2' });
      const retained = await updateArkFund(fund, retainedConfig, clients, { apiRoot: directory, referenceDate });
      expect(retained).toMatchObject({ holdingsCount: 3, historyCount: 4 });
      const afterRetention = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      expect(afterRetention).toEqual(before);

      // HISTORY_RANGE=1y keeps only the official NAV points of the last year (2 of the 4 sample points)
      const windowDirectory = await mkdtemp(join(tmpdir(), 'ark-window-'));
      try {
        const windowed = await updateArkFund(fund, noRetryConfig({ REQUEST_SLEEP: '0', HISTORY_RANGE: '1y' }), clients, { apiRoot: windowDirectory, referenceDate });
        expect(windowed).toMatchObject({ historyCount: 2 });
      } finally {
        await rm(windowDirectory, { recursive: true, force: true });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('bounded updater orchestration', () => {
  test('MAX_FETCHES resumes from a scoped cursor and never trims catalog entries on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ark-cursor-'));
    const requests: string[] = [];
    const clients = {
      ark: async (url: string) => { requests.push(url); throw new Error('SKIP_ARK should prevent this request'); },
      azure: async (url: string) => { requests.push(url); throw new Error('SKIP_ARK should prevent this request'); },
      yahoo: async (url: string) => { requests.push(url); throw new Error('SKIP_YAHOO should prevent this request'); },
      sec: async (url: string) => { requests.push(url); throw new Error('EDGAR_FALLBACK=0 should prevent this request'); },
      isArkProxyActive: () => false,
    };
    const config = noRetryConfig({
      TICKERS: 'ARKK ARKY', MAX_FETCHES: '1', REQUEST_SLEEP: '0',
      SKIP_ARK: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0',
    });
    await writeJsonIfChanged(join(directory, 'index.json'), {
      brand: 'ARK Invest',
      funds: [{ ticker: 'ARKQ', name: 'Existing ARKQ record', category: 'Preserved', holdings: 4, history: 8, customTag: 'keep-me' }],
    });
    try {
      const first = await runUpdater({ config, apiRoot: directory, clients, referenceDate: new Date('2026-09-28T12:00:00Z'), onNote: () => undefined });
      expect(first.selectedTickers).toEqual(['ARKK']);
      expect(first.failedTickers).toEqual(['ARKK']);
      expect(first.nextCursor).toBe(1);
      const firstState = JSON.parse(await readFile(join(directory, 'update-state.json'), 'utf8')) as Record<string, unknown>;
      expect(firstState).toMatchObject({ scopes: { 'ARKK,ARKY': { cursor: 1, tickers: ['ARKK', 'ARKY'] } } });

      const second = await runUpdater({ config, apiRoot: directory, clients, referenceDate: new Date('2026-09-28T12:00:00Z'), onNote: () => undefined });
      expect(second.selectedTickers).toEqual(['ARKY']);
      expect(second.failedTickers).toEqual(['ARKY']);
      expect(second.nextCursor).toBe(0);
      expect(requests).toEqual([]);
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as { funds: Array<Record<string, unknown>>; counts: Record<string, unknown> };
      expect(index.funds).toHaveLength(14);
      expect(index.counts).toMatchObject({ funds: 14, holdings: 4, history: 8 });
      expect(index.funds.find((fundRow) => fundRow.ticker === 'ARKB')).toMatchObject({ ticker: 'ARKB', holdings: 0, history: 0 });
      expect(index.funds.find((fundRow) => fundRow.ticker === 'ARKQ')).toMatchObject({ name: 'Existing ARKQ record', category: 'Preserved', holdings: 4, history: 8, customTag: 'keep-me' });
      expect(await Bun.file(join(directory, 'funds', 'ARKK', 'meta.json')).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('catalog discovery retries a direct 403 through the raw-HTML proxy before retaining the fixed catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ark-catalog-proxy-'));
    const calls: Array<{ url: string; respondWith: string | null }> = [];
    const notices: string[] = [];
    const config = noRetryConfig({ CATEGORY: 'not-a-supported-category', REQUEST_SLEEP: '0' });
    const clients = createRequestClients(config, {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const respondWith = new Headers(init?.headers).get('x-respond-with');
        calls.push({ url, respondWith });
        if (url.startsWith('https://r.jina.ai/')) {
          return new Response('<html><body><a href="/funds/arkk">ARKK</a></body></html>', { status: 200 });
        }
        return new Response('blocked', { status: 403 });
      },
      onIssuerProxy: (message) => notices.push(message),
    });
    try {
      const report = await runUpdater({ config, apiRoot: directory, clients, onNote: () => undefined });
      expect(report.selectedTickers).toEqual([]);
      expect(report.processedTickers).toEqual([]);
      expect(calls.filter((call) => !call.url.startsWith('https://r.jina.ai/'))).toHaveLength(2);
      expect(calls.filter((call) => call.url.startsWith('https://r.jina.ai/'))).toEqual([
        { url: jinaReaderUrl('https://www.ark-funds.com/our-etfs/'), respondWith: 'html' },
      ]);
      expect(notices).toHaveLength(1);
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as { catalog: { source: string; tickers: string[] } };
      expect(index.catalog.source).toContain('official ETF page; 1 supported fund paths observed');
      expect(index.catalog.tickers).toHaveLength(14);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('README parity guard', () => {
  const readmePath = join(import.meta.dir, '..', 'README.md');
  const readmeText = readFile(readmePath, 'utf8');

  const headingsOutsideCode = (markdown: string): string[] => {
    const headings: string[] = [];
    let inFence = false;
    for (const line of markdown.split('\n')) {
      if (line.startsWith('```')) { inFence = !inFence; continue; }
      if (!inFence && /^#{1,6} /.test(line)) headings.push(line.trimEnd());
    }
    return headings;
  };

  const tableRows = (markdown: string, heading: string): string[] => {
    const start = markdown.indexOf(`\n${heading}\n`);
    expect(start).toBeGreaterThan(-1);
    const section = markdown.slice(start + heading.length + 2);
    const end = section.search(/\n## /);
    return (end === -1 ? section : section.slice(0, end))
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
      .slice(1);
  };

  test('keeps the pinned sibling heading structure with only brand substitutions', async () => {
    expect(headingsOutsideCode(await readmeText)).toEqual([
      '# ARK Invest',
      '## Using Bun',
      '## Updating the static ARK Invest data',
      '### Data sources',
      '### Metrics and caveats',
      '### Update controls',
      '### Examples',
      '## TypeScript and verification',
      '## Brands table',
      '## Sibling applications',
      '## License',
    ]);
  });

  test('documents only controls the updater implements and every implemented control', async () => {
    const markdown = await readmeText;
    const documented = new Set<string>();
    for (const row of tableRows(markdown, '### Update controls')) {
      const cell = row.split('|')[1] ?? '';
      const codes = [...cell.matchAll(/`([A-Z_0-9]+)`/g)].map((match) => match[1]);
      if (codes.length === 0) continue;
      documented.add(codes[0]);
      for (const suffix of codes.slice(1)) documented.add(`${codes[0].replace(/_YTD$/, '')}${suffix}`);
    }
    const implemented = new Set<string>();
    for (const match of USAGE.matchAll(/^  ([A-Z_]+(?:\|[A-Z0-9|]+)?)\s{2,}/gm)) {
      const name = match[1];
      if (!name.includes('|')) { implemented.add(name); continue; }
      const prefix = name.startsWith('TOTAL_RETURN_') ? 'TOTAL_RETURN_' : 'PERFORMANCE_';
      for (const tenor of name.slice(prefix.length).split('|')) implemented.add(`${prefix}${tenor}`);
    }
    expect([...documented].sort()).toEqual([...implemented].sort());
    for (const example of markdown.match(/^[A-Z_]+="?[^\s"]*"? bun scripts\/update-data\.ts$/gm) ?? []) {
      expect(implemented.has(example.split('=')[0])).toBe(true);
    }
  });

  test('brand and sibling tables include ARK and stay alphabetically ordered', async () => {
    const markdown = await readmeText;
    const brandNames = tableRows(markdown, '## Brands table').map((row) => row.split('|')[1].trim().replace(/\*\*/g, ''));
    const siblingNames = tableRows(markdown, '## Sibling applications').map((row) => row.split('|')[1].trim());
    const sorted = (values: string[]): string[] => [...values].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    expect(brandNames).toHaveLength(29);
    expect(siblingNames).toHaveLength(29);
    expect(brandNames).toEqual(sorted(brandNames));
    expect(siblingNames).toEqual(sorted(siblingNames));
    expect(brandNames).toContain('ARK Invest');
    expect(siblingNames).toEqual(brandNames);
    expect(markdown).toContain('https://daggerok.github.io/ARK/');
    expect(markdown).toContain('https://github.com/daggerok/ARK');
  });
});

describe('configuration resolver', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const file = JSON.parse(read('scripts/update-data.config.json'));

  test('precedence: file < advanced < nonblank input < environment (explicit empty env clears)', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'ARKK' }, { CONCURRENCY: 3, TICKERS: 'ARKQ' }, { CONCURRENCY: '4', TICKERS: '' }, { ARK_CONCURRENCY: '5', CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('5');
    expect(c.TICKERS).toBe('ARKQ');
    expect(resolveControls({ TICKERS: 'ARKK' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({ TICKERS: 'ARKK' }, {}, { TICKERS: 'ARKW' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(readConfig(resolveControls({ CATEGORY: 'Thematic' })).category).toBe('Thematic');
  });

  test('invalid layers and values are rejected, never silently replaced', () => {
    const bad: unknown[] = [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_RETRIES: 'x' }, { MAX_FETCHES: 1.5 },
      { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { AUM: '1:2:3' }, { TER: '5:1' }, { HISTORY_RANGE: '0y' }, { HISTORY_RANGE: 'forever' }, { TICKERS: ['ARKK'] }, null, []];
    for (const value of bad) expect(() => resolveControls(value)).toThrow();
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { ARK_SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls(file, 'x')).toThrow();
    expect(() => resolveControls(file, {}, { TICKERS: { a: 1 } })).toThrow();
    expect(() => readConfig({ MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    expect(readConfig(resolveControls({ MAX_RETRIES: 1 })).maxRetries).toBe(1);
  });

  test('scheduled path (empty inputs and advanced) equals config defaults, with provider defaults', () => {
    expect(resolveControls(file, {}, {}, {})).toEqual(Object.fromEntries(Object.entries(file).map(([k, v]) => [k, String(v)])));
    const config = readConfig(resolveControls(file));
    expect(config.tickers).toEqual([]);
    expect(config.maxFetches).toBe(0);
    expect(config.requestSleepSeconds).toBe(1.5);
    expect(config.concurrency).toBe(2);
    expect(config.maxRetries).toBe(2);
    expect(config.historyRange).toBe('max');
    expect(config.edgarFallback).toBe(true);
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(config.secUa).toBe(DEFAULT_SEC_UA);
    expect(DEFAULT_SEC_UA).toBe(file.SEC_UA);
  });

  test('the protected SEC_UA variable wins only when the workflow passes it as the last layer', () => {
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  });

  test('HISTORY_RANGE limits the Yahoo request window', () => {
    const now = 1_800_000_000;
    expect(new URL(yahooChartUrl('ARKK', now)).searchParams.get('period1')).toBe('0');
    expect(new URL(yahooChartUrl('ARKK', now, 'max')).searchParams.get('period1')).toBe('0');
    expect(new URL(yahooChartUrl('ARKK', now, '5y')).searchParams.get('period1')).toBe(String(Math.floor(now - 5 * 365.25 * 86_400)));
    expect(historyWindowStartEpoch('1y', now)).toBeGreaterThan(historyWindowStartEpoch('10y', now));
    expect(historyWindowStartEpoch('max', now)).toBe(0);
  });

  test('config keys, CONTROL_NAMES, README rows and --help are in sync', () => {
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    const doc = read('README.md');
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
      expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
      if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
    }
    expect(doc).toContain('scripts/update-data.config.json');
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
      expect(USAGE).toContain(tenor ? `${tenor[1]}_YTD|1Y|3Y|5Y|10Y` : name);
    }
  });
});

describe('workflow shape', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const workflow = read('.github/workflows/update-data.yml');

  test('at most 25 inputs, advanced JSON, every individual input maps to a control', () => {
    const names = [...workflow.slice(workflow.indexOf('    inputs:'), workflow.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).toContain('advanced');
    for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES as readonly string[]).toContain(name.toUpperCase());
    expect(workflow).toContain("default: '{}'");
    expect(workflow).toContain("cron: '0 0 * * 0'");
    expect(workflow).not.toMatch(/^  push:/m);
  });

  test('uses the shared resolver, keeps SEC_UA protected and writes only api/ark', () => {
    expect(workflow).toContain('resolveControls(file, advanced, individual, protectedVars)');
    expect(workflow).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(workflow).toContain('toJSON(inputs)');
    expect(workflow).not.toMatch(/\$\{\{\s*inputs\./);
    expect(workflow).not.toMatch(/OUTPUT_DIR|output_dir/i);
    expect(workflow).not.toContain('bunx tsc');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow.match(/git add (\S+)/g)).toEqual(['git add api/ark']);
    expect(workflow.match(/api\/[\w-]+/g)!.every((p) => p === 'api/ark')).toBe(true);
  });
});

describe('system CA support', () => {
  test('USE_SYSTEM_CA resolver: auto/true/false case-insensitive, default auto', () => {
    for (const v of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(resolveControls({ USE_SYSTEM_CA: v }).USE_SYSTEM_CA).toBe(v.toLowerCase());
    expect(() => resolveControls({ USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
    expect(resolveControls(JSON.parse(readFileSync(new URL('./update-data.config.json', import.meta.url), 'utf8'))).USE_SYSTEM_CA).toBe('auto');
  });

  test('isCertError recognizes certificate failures, also through .cause', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);
    expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa wraps fetch only in auto mode and restarts once on a cert error', async () => {
    const original = globalThis.fetch;
    const reexec = () => { calls += 1; return undefined as never; };
    let calls = 0;
    try {
      installSystemCa('false', reexec, false);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('auto', reexec, true);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('true', reexec, true);
      expect(calls).toBe(0);
      installSystemCa('true', reexec, false);
      expect(calls).toBe(1);
      globalThis.fetch = original;

      calls = 0;
      let next: () => Promise<Response> = async () => new Response('ok');
      globalThis.fetch = (async () => next()) as unknown as typeof fetch;
      const base = globalThis.fetch;
      installSystemCa('auto', reexec, false);
      expect(globalThis.fetch).not.toBe(base);
      expect(await (await fetch('https://example.test/')).text()).toBe('ok');
      expect(calls).toBe(0);
      next = async () => { throw new Error('ECONNRESET'); };
      await expect(fetch('https://example.test/')).rejects.toThrow('ECONNRESET');
      expect(calls).toBe(0);
      next = async () => { throw new Error('fetch failed', { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }); };
      await fetch('https://example.test/');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Robustness and data-contract fixes (each test fails on the previous implementation)
// ---------------------------------------------------------------------------

type Scenario = {
  csv?: string | Error;
  month?: unknown;
  quarter?: unknown;
  history?: unknown;
  yahooPoints?: number | Error;
  firstTrade?: string;
  dividends?: Record<string, { date: number; amount: number }>;
  overview?: unknown;
};
const DAY_MS = 86_400_000;
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
    if (url.includes('/api/fund/overview/')) return respondWith(JSON.stringify(scenario.overview ?? overviewSample), url);
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
const REF = new Date('2026-09-28T12:00:00Z');
const quietConfig = (env: Record<string, string> = {}) => noRetryConfig({ REQUEST_SLEEP: '0', ...env });
const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));
const withTempRoot = async (work: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'ark-fix-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const update = (root: string, scenario: Scenario, env: Record<string, string> = {}, extra: Record<string, unknown> = {}, warns: string[] = []) =>
  updateArkFund(arkkFund, quietConfig(env), clientsFor(scenario), { apiRoot: root, referenceDate: REF, onNote: () => undefined, onWarn: (message) => warns.push(message), ...extra });
const oldNport = (repPdDate: string) => async () => ({
  parsed: { repPdDate, positions: [], regCik: '', seriesName: '', seriesId: '', netAssets: null },
  accessions: [],
  selected: { accession: 'acc', filed: repPdDate, reportDate: repPdDate, url: 'https://example.test/primary_doc.xml' },
  holdings: [{ Name: 'N-PORT CO', Ticker: 'NPT', Identifier: '1', Weight: '1%', 'Market Value': '1', 'Shares Held': '1', 'Asset Category': 'Equity' }],
});

afterEach(() => { process.exitCode = 0; });

describe('fix: distribution frequency', () => {
  test('semi-annual means 2 payments a year, so the indicated yield is not overstated 3x', async () => {
    expect(paymentsPerYear('semi-annually')).toBe(2);
    expect(paymentsPerYear('SDEC')).toBe(2);
    expect(paymentsPerYear('Semi-Annual')).toBe(2);
    expect(inferDistributionFrequency(['2025-09-01', '2026-03-01', '2026-08-28'], new Date('2026-09-28T00:00:00Z'))).toBe('Semi-annually');
    const epoch = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const dividends = { a: { date: epoch('2025-09-01'), amount: 0.5 }, b: { date: epoch('2026-03-01'), amount: 0.5 }, c: { date: epoch('2026-08-28'), amount: 0.5 } };
    await withTempRoot(async (root) => {
      await update(root, { dividends });
      const meta = await readJson(join(root, 'funds', 'ARKK', 'meta.json'));
      expect(meta.distributions.frequency).toBe('Semi-annually');
      expect(meta.metrics.dividendYield).toBe(1.1); // 0.50 x 2 / 90.77 (last market price), not x 6 = 3.31
    });
  });
});

describe('fix: holdings freshness', () => {
  test('the snapshot date is the newest row date and a stale snapshot is always surfaced', async () => {
    const csv = ['date,fund,company,ticker,cusip,shares,market value ($),weight (%)', '01/02/2026,ARKF,OLD CO,OLD,1,"1","$1",1%', '09/28/2026,ARKF,TESLA INC,TSLA,88160R101,"2","$3",9%'].join('\n');
    expect(parseArkHoldingsCsv(csv, 'ARKF').asOfDate).toBe('2026-09-28');
    const warnings: string[] = [];
    await withTempRoot(async (root) => {
      await update(root, { csv: csvAt('01/02/2026') }, {}, {}, warnings);
    });
    expect(warnings.some((message) => message.includes('days old') && message.includes('ARKK'))).toBe(true);
  });

  test('a failed CSV never replaces published holdings with an older N-PORT and keeps the whole fund as published', async () => {
    await withTempRoot(async (root) => {
      await update(root, {});
      const files = async () => Promise.all(['meta.json', 'holdings/001.json', 'history/001.json'].map((file) => readFile(join(root, 'funds', 'ARKK', file), 'utf8')));
      const before = await files();
      const result = await update(root, { csv: new Error('HTTP 403') }, { EDGAR_FALLBACK: '1' }, { secFallback: oldNport('2026-06-30') });
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('holdings CSV');
      expect(await files()).toEqual(before);
      expect((await readJson(join(root, 'funds', 'ARKK', 'meta.json'))).holdings.asOfDate).toBe('Sep 28 2026');
    });
  });

  test('an N-PORT report that is newer than the published holdings is still used', async () => {
    await withTempRoot(async (root) => {
      await update(root, { csv: csvAt('06/01/2026') });
      const result = await update(root, { csv: new Error('HTTP 403') }, { EDGAR_FALLBACK: '1' }, { secFallback: oldNport('2026-08-31') });
      expect(result.status).toBeUndefined();
      const meta = await readJson(join(root, 'funds', 'ARKK', 'meta.json'));
      expect(meta.holdings.source).toBe('SEC EDGAR Form N-PORT-P fallback');
      expect(meta.holdings.asOfDate).toBe('Aug 31 2026');
    });
  });
});

describe('fix: returns are one unit', () => {
  test('a figure ARK later nulls stays null and never travels under a new date', async () => {
    await withTempRoot(async (root) => {
      await update(root, {});
      expect((await readJson(join(root, 'funds', 'ARKK', 'meta.json'))).metrics).toMatchObject({ cagr3y: 25.02, tr1y: 14.07 });
      const thinMonth = performanceSample('09/30/2026', ['14.07%', '', '', '', '13.98%'], ['20.20%', '4.37%', '11.13%', '370.38%']);
      await update(root, { month: thinMonth });
      const meta = await readJson(join(root, 'funds', 'ARKK', 'meta.json'));
      expect(meta.metrics.tr1y).toBe(14.07);
      expect(meta.metrics.cagr3y).toBeNull();
      expect(meta.metrics.tr3y).toBeNull();
      expect(meta.metrics.cagr5y).toBeNull();
      expect(meta.metrics.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);
      expect(meta.metrics.performanceAsOf).toBe('2026-09-30');
      expect(meta.returns.monthEnd.yr3).toBeNull();
      expect(meta.returns.monthEnd.yr5).toBeNull();
    });
  });

  test('a failed performance endpoint keeps the whole previous fund instead of mixing sources', async () => {
    await withTempRoot(async (root) => {
      await update(root, {});
      const before = await readFile(join(root, 'funds', 'ARKK', 'meta.json'), 'utf8');
      const clients = { ...clientsFor({}), ark: async (url: string) => {
        if (url.includes('/api/fund/performance/')) throw new Error('HTTP 503');
        return clientsFor({}).ark(url);
      } };
      const result = await updateArkFund(arkkFund, quietConfig(), clients, { apiRoot: root, referenceDate: REF, onNote: () => undefined });
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('performance');
      expect(await readFile(join(root, 'funds', 'ARKK', 'meta.json'), 'utf8')).toBe(before);
    });
  });

  test('horizons longer than the fund age and a since-inception figure under one year are null', () => {
    const month = parseArkPerformance(performanceSample('08/31/2026', ['1.10%', '5.00%', '6.00%', '7.00%', '1.38%'], ['1%', '2%', '3%', '1.38%']));
    const young = buildOfficialReturns(month, null, '2026-08-19');
    expect(young.metrics).toMatchObject({ tr1y: null, cagr3y: null, cagr5y: null, siAnn: null });
    expect(young.monthEnd.sinceInception).toBeNull();
    expect(young.monthEnd.sinceInceptionCumulative).toBe(1.38);
    // 2.93 years old: no 3Y yet, a 1Y figure is real
    const almostThree = buildOfficialReturns(month, null, '2023-09-26');
    expect(almostThree.metrics).toMatchObject({ tr1y: 1.1, cagr3y: null, tr3y: null, siAnn: 1.38 });
    expect(buildOfficialReturns(month, null, '2020-01-01').metrics).toMatchObject({ cagr3y: 5, cagr5y: 6 });
  });
});

describe('fix: HISTORY_RANGE never shrinks the published history', () => {
  test('a shorter window merges older published rows back and keeps every page', async () => {
    await withTempRoot(async (root) => {
      const full = navPoints(1500);
      await update(root, { history: full, yahooPoints: 1500 }, { HISTORY_PAGE_SIZE: '1000' });
      const meta = await readJson(join(root, 'funds', 'ARKK', 'meta.json'));
      expect(meta.history.totalRows).toBe(1500);
      await update(root, { history: full, yahooPoints: 800 }, { HISTORY_RANGE: '2y', HISTORY_PAGE_SIZE: '1000' });
      const after = await readJson(join(root, 'funds', 'ARKK', 'meta.json'));
      expect(after.history.totalRows).toBe(1500);
      expect((await readdir(join(root, 'funds', 'ARKK', 'history'))).sort()).toEqual(['001.json', '002.json']);
      expect(after.history.asOfDate).toBe('Sep 25 2026');
    });
    const previous = { headers: ['Date', 'NAV'], rows: [{ Date: 'Jan 02 2026', NAV: '1' }, { Date: 'Jun 01 2026', NAV: '2' }] };
    expect(mergeHistoryRows(previous, ['Date', 'NAV'], [{ Date: 'Jun 01 2026', NAV: '3' }]).map((row) => row.NAV)).toEqual(['1', '3']);
    expect(mergeHistoryRows(previous, ['Date', 'Close'], [{ Date: 'Jun 01 2026', Close: '3' }])).toHaveLength(1);
  });

  test('siAnn and since-inception cumulative come only from a window that reaches the first trade', () => {
    const points = Array.from({ length: 800 }, (_, index) => ({ date: new Date(Date.parse('2024-07-20T00:00:00Z') + index * DAY_MS).toISOString().slice(0, 10), close: 50 + index * 0.01, adjClose: 50 + index * 0.01, volume: 1 }));
    expect(buildYahooReturns(points, REF, true).metrics.siAnn).not.toBeNull();
    const clipped = buildYahooReturns(points, REF, false);
    expect(clipped.metrics.siAnn).toBeNull();
    expect(clipped.monthEnd.sinceInceptionCumulative).toBeNull();
  });

  test('a Yahoo-only run with HISTORY_RANGE=2y does not label the window start as inception', async () => {
    await withTempRoot(async (root) => {
      await update(root, { yahooPoints: 800, firstTrade: '2014-10-31' }, { SKIP_ARK: '1', HISTORY_RANGE: '2y' });
      expect((await readJson(join(root, 'funds', 'ARKK', 'meta.json'))).metrics.siAnn).toBeNull();
    });
  });
});

describe('fix: network behavior', () => {
  test('the r.jina.ai proxy retries at most once and paces at 3.2 s or more, whatever MAX_RETRIES says', async () => {
    let clock = 0;
    const proxyStarts: number[] = [];
    const client = createRequestClients({ ...readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '5' }) }, {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      onRetry: () => undefined,
      onIssuerProxy: () => undefined,
      fetchImpl: async (input) => {
        if (String(input).startsWith('https://r.jina.ai/')) { proxyStarts.push(clock); return new Response('busy', { status: 503 }); }
        return new Response('blocked', { status: 403 });
      },
    });
    await expect(client.ark('https://www.ark-funds.com/api/fund/overview/1004')).rejects.toThrow('503');
    expect(proxyStarts).toHaveLength(2);
    expect(proxyStarts[1] - proxyStarts[0]).toBeGreaterThanOrEqual(3200);
    expect(ISSUER_PROXY_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(3200);
  });

  test('the first 403 of a run is retried directly once and a transient denial costs nothing', async () => {
    let calls = 0;
    const client = createRequestClients(noRetryConfig({ REQUEST_SLEEP: '0' }), {
      sleep: async () => undefined,
      fetchImpl: async () => { calls += 1; return calls === 1 ? new Response('challenge', { status: 403 }) : new Response('{"ok":true}', { status: 200 }); },
      onIssuerProxy: () => undefined,
    });
    await expect(client.ark('https://www.ark-funds.com/api/fund/overview/1004')).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(calls).toBe(2);
    expect(client.isArkProxyActive()).toBe(false);
  });
});

describe('fix: numbers, dates and writes', () => {
  test('numberOrNull maps symbol-only strings to null, not 0', () => {
    for (const value of ['$', '%', ',', '$,%', ' $ ']) expect(numberOrNull(value)).toBeNull();
    expect(numberOrNull('$0')).toBe(0);
    expect(numberOrNull('0.00%')).toBe(0);
  });

  test('month-name dates parse as UTC in any time zone and generatedAt has no milliseconds', () => {
    const original = process.env.TZ;
    try {
      for (const zone of ['Asia/Tokyo', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = zone;
        expect(toIsoDate('Sep 28 2026')).toBe('2026-09-28');
        expect(toIsoDate('September 5, 2026')).toBe('2026-09-05');
        expect(displayDate('Sep 04 2026')).toBe('Sep 04 2026');
        expect(toIsoDate('Mon, 28 Sep 2026 06:05:47 GMT')).toBe('2026-09-28');
      }
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
    expect(isoStamp(new Date('2026-10-03T04:05:06.789Z'))).toBe('2026-10-03T04:05:06Z');
  });

  test('writes are atomic: no tmp files are left and a failed write keeps the old file', async () => {
    await withTempRoot(async (root) => {
      const file = join(root, 'x', 'a.json');
      await writeFileAtomic(file, '{"a":1}\n');
      await writeJsonIfChanged(file, { a: 2 });
      expect(await readdir(join(root, 'x'))).toEqual(['a.json']);
      await expect(writeFileAtomic(join(root, 'x', 'a.json', 'nested.json'), 'z')).rejects.toBeDefined();
      expect(await readJson(file)).toEqual({ a: 2 });
      expect((await readdir(join(root, 'x'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  test('stale pages are removed only after meta.json is written (a failed meta write leaves them in place)', async () => {
    await withTempRoot(async (root) => {
      await update(root, { history: navPoints(5) }, { HISTORY_PAGE_SIZE: '2' });
      const historyDir = join(root, 'funds', 'ARKK', 'history');
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      // make the meta.json write fail: a non-empty directory sits where the file must go
      await rm(join(root, 'funds', 'ARKK', 'meta.json'));
      await mkdir(join(root, 'funds', 'ARKK', 'meta.json', 'blocker'), { recursive: true });
      await expect(update(root, { history: navPoints(5) }, { HISTORY_PAGE_SIZE: '5' })).rejects.toBeDefined();
      expect((await readdir(historyDir)).sort()).toEqual(['001.json', '002.json', '003.json']);
      await rm(join(root, 'funds', 'ARKK', 'meta.json'), { recursive: true, force: true });
      await update(root, { history: navPoints(5) }, { HISTORY_PAGE_SIZE: '5' });
      expect((await readdir(historyDir)).sort()).toEqual(['001.json']);
    });
  });

  test('a rerun with identical upstream data writes nothing, stamps included', async () => {
    await withTempRoot(async (root) => {
      const config = quietConfig({ TICKERS: 'ARKK', SKIP_ARK: '0', EDGAR_FALLBACK: '0' });
      const clients = clientsFor({});
      const run = () => runUpdater({ config, apiRoot: root, clients, referenceDate: REF, onNote: () => undefined, onWarn: () => undefined });
      await run();
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
      const first = await snapshot();
      await Bun.sleep(15);
      await run();
      expect(await snapshot()).toEqual(first);
      expect(first.some(([file]) => file.endsWith('.tmp'))).toBe(false);
    });
  });
});

describe('fix: orchestration', () => {
  test('unknown TICKERS are a configuration error, also through the resolver', () => {
    expect(() => readConfig({ TICKERS: 'ARKK NOPE' })).toThrow('NOPE');
    expect(() => resolveControls({}, {}, {}, { TICKERS: 'ARKK ZZZZ' })).toThrow('ZZZZ');
  });

  test('the legacy HISTORICAL_PAGE_SIZE alias still works through resolveControls (ARK_ spelling wins)', () => {
    expect(resolveControls({ HISTORY_PAGE_SIZE: '1000' }, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500', ARK_HISTORY_PAGE_SIZE: '300' }).HISTORY_PAGE_SIZE).toBe('300');
    expect(() => resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '0' })).toThrow('HISTORY_PAGE_SIZE');
  });

  test('rows without meta.json get dataFile null and a complete metrics object', async () => {
    await withTempRoot(async (root) => {
      const config = quietConfig({ TICKERS: 'ARKK' });
      await runUpdater({ config, apiRoot: root, clients: clientsFor({}), referenceDate: REF, onNote: () => undefined, onWarn: () => undefined });
      const index = await readJson(join(root, 'index.json'));
      const arkk = index.funds.find((row: any) => row.ticker === 'ARKK');
      const arkq = index.funds.find((row: any) => row.ticker === 'ARKQ');
      expect(arkk.dataFile).toBe('funds/ARKK/meta.json');
      expect(arkq.dataFile).toBeNull();
      expect(Object.keys(arkq.metrics)).toEqual(Object.keys(arkk.metrics));
      expect(arkq.metrics.returnsBasis).toBe(UNAVAILABLE_RETURNS_BASIS);
      expect(arkq.metrics.performanceAsOf).toBeNull();
      expect(arkq.metrics.ytd).toBeNull();
    });
  });

  test('main exits non-zero only when every selected fund failed', async () => {
    await withTempRoot(async (root) => {
      const env = { TICKERS: 'ARKK', SKIP_ARK: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0', REQUEST_SLEEP: '0' };
      process.exitCode = 0;
      const report = await main([], env, { apiRoot: root, clients: clientsFor({}), onNote: () => undefined, onWarn: () => undefined });
      expect(report?.failedTickers).toEqual(['ARKK']);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      const okEnv = { TICKERS: 'ARKK', EDGAR_FALLBACK: '0', REQUEST_SLEEP: '0' };
      await main([], okEnv, { apiRoot: root, clients: clientsFor({}), referenceDate: REF, onNote: () => undefined, onWarn: () => undefined });
      expect(process.exitCode).toBe(0);
    });
  });

  test('NEW FUNDS: funds listed on the official page but missing from the catalog are detected and reported', async () => {
    const html = '<a href="/funds/arkk">ARKK</a><a href="/funds/arkvx">Venture</a><a href="/funds/arkz">ARKZ</a><a href="/funds/arkk">dup</a>';
    expect(parseArkCatalogSlugs(html)).toEqual(['ARKK', 'ARKVX', 'ARKZ']);
    expect(detectUnlistedArkFunds(html)).toEqual(['ARKZ']);
    await withTempRoot(async (root) => {
      const summary = join(root, 'summary.md');
      const previousSummary = process.env.GITHUB_STEP_SUMMARY;
      process.env.GITHUB_STEP_SUMMARY = summary;
      try {
        const clients = { ...clientsFor({}), ark: async (url: string) => url.endsWith('/our-etfs/') ? respondWith(html, url) : clientsFor({}).ark(url) };
        const report = await runUpdater({ config: quietConfig({ CATEGORY: 'nothing-matches' }), apiRoot: root, clients, onNote: () => undefined });
        expect(report.newFunds).toEqual(['ARKZ']);
        expect(await readFile(summary, 'utf8')).toContain('NEW FUNDS: ARKZ');
      } finally {
        if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previousSummary;
      }
    });
  });

  test('the cursor wraps around, counts only funds that can pass the filters and a TICKERS run leaves it alone', async () => {
    await withTempRoot(async (root) => {
      const skipAll = { SKIP_ARK: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0' };
      const run = (env: Record<string, string>) => runUpdater({ config: quietConfig({ ...skipAll, ...env }), apiRoot: root, clients: clientsFor({}), referenceDate: REF, onNote: () => undefined, onWarn: () => undefined });
      const first = await run({ MAX_FETCHES: '5' });
      expect(first.selectedTickers).toHaveLength(5);
      const second = await run({ MAX_FETCHES: '5' });
      const third = await run({ MAX_FETCHES: '5' });
      expect(third.selectedTickers).toHaveLength(5); // 14 funds: 5 + 5 + 5 wraps instead of a short last batch
      expect(new Set([...first.selectedTickers, ...second.selectedTickers]).size).toBe(10);
      expect(third.selectedTickers.slice(4)).toEqual(first.selectedTickers.slice(0, 1));
      const state = await readJson(join(root, 'update-state.json'));
      const scopeKeys = Object.keys(state.scopes);
      // a TICKERS run (bounded or full) neither deletes nor overwrites the full-feed cursor
      await run({ TICKERS: 'ARKK ARKY', MAX_FETCHES: '1' });
      await run({ TICKERS: 'ARKK ARKY', MAX_FETCHES: '0' });
      const after = await readJson(join(root, 'update-state.json'));
      expect(Object.keys(after.scopes)).toEqual(expect.arrayContaining(scopeKeys));
      expect(after.scopes[scopeKeys[0]].cursor).toBe(state.scopes[scopeKeys[0]].cursor);
      expect(Object.keys(after.scopes)).toContain('ARKK,ARKY');
    });
  });

  test('a soft deadline stops taking new funds, still writes the index and moves the cursor only by started funds', async () => {
    expect(RUN_SOFT_DEADLINE_MS).toBe(25 * 60_000);
    await withTempRoot(async (root) => {
      let clock = 0;
      const clients = { ...clientsFor({}), ark: async (url: string) => { if (url.includes('/api/fund/overview/')) clock += 10_000; return clientsFor({}).ark(url); } };
      const config = quietConfig({ MAX_FETCHES: '3', CONCURRENCY: '1', EDGAR_FALLBACK: '0', TICKERS: 'ARKK ARKB ARKQ' });
      const report = await runUpdater({ config, apiRoot: root, clients, referenceDate: REF, runtime: { now: () => clock, sleep: async () => undefined }, deadlineMs: 5_000, onNote: () => undefined, onWarn: () => undefined });
      expect(report.deadlineReached).toBe(true);
      // candidate order is ARKB, ARKK, ARKQ: ARKB fails fast, ARKK burns the budget, ARKQ is never started
      expect(report.processedTickers).toEqual(['ARKB', 'ARKK']);
      expect(report.nextCursor).toBe(2);
      expect((await readJson(join(root, 'index.json'))).funds).toHaveLength(14);
    });
  });
});
