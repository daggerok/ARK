#!/usr/bin/env bun
/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARK_FUNDS,
  ARKY_HOLDINGS_HEADERS,
  ProviderHttpError,
  arkApiUrls,
  createPacedGate,
  createRequestClients,
  createSecFallbackResolver,
  jinaReaderUrl,
  parseProviderJson,
  updateArkFund,
  unwrapJinaReaderText,
  HOLDINGS_HEADERS,
  buildOfficialReturns,
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
import { readFile as readFixture } from 'node:fs/promises';

const fixture = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);
const arkkCsv = await readFixture(fixture('arkk-holdings-2026-09-28.csv'), 'utf8');
const arkyCsv = await readFixture(fixture('arky-holdings-2026-09-28.csv'), 'utf8');
const overviewFixture = JSON.parse(await readFixture(fixture('arkk-overview-2026-09-28.json'), 'utf8')) as unknown;
const monthPerformanceFixture = JSON.parse(await readFixture(fixture('arkk-performance-month-end-2026-09-28.json'), 'utf8')) as unknown;
const quarterPerformanceFixture = JSON.parse(await readFixture(fixture('arkk-performance-quarter-end-2026-09-28.json'), 'utf8')) as unknown;
const navHistoryFixture = JSON.parse(await readFixture(fixture('arkk-nav-history-sample-2026-09-28.json'), 'utf8')) as unknown;

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
    const parsed = parseArkOverview(overviewFixture);
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
    const rows = parseArkNavHistory(navHistoryFixture);
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
    const month = parseArkPerformance(monthPerformanceFixture);
    const quarter = parseArkPerformance(quarterPerformanceFixture);
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
    expect(parsed.totalRows).toBe(46); // source also has one trailing legal disclaimer row
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
    expect(parsed.totalRows).toBe(47);
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
    const synthetic = arkyCsv + 'OVERWEIGHT NOTE,CUSIP-X,1,1,101.25%\r\n';
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

  test('static and post-fetch filters are ANDed; missing return periods pass for young funds', () => {
    const config = readConfig({ TICKERS: 'ARKK ARKY', CATEGORY: 'equity', AUM: '1B:', TER: ':1', PERFORMANCE_3Y: '10:30' });
    const arkk = ARK_FUNDS.find((fund) => fund.ticker === 'ARKK')!;
    const arky = ARK_FUNDS.find((fund) => fund.ticker === 'ARKY')!;
    expect(passesStaticFilters(arkk, config)).toBe(true);
    expect(passesStaticFilters(arky, config)).toBe(false);
    const entry = { aumValue: 2_000_000_000, terValue: 0.75, metrics: { dividendYield: null, secYield: null, tr1y: 12, cagr3y: null }, returns: { monthEnd: { ytd: 5, yr1: 12, yr3: null } } };
    expect(passesMetricFilters(entry, config)).toBe(true);
    expect(passesMetricFilters({ ...entry, aumValue: 500_000_000 }, config)).toBe(false);
    expect(passesMetricFilters({ ...entry, metrics: { ...entry.metrics, cagr3y: 35 } }, config)).toBe(false);
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
    const directory = await mkdtemp(join(tmpdir(), 'ark-fixture-'));
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

  test('two consecutive ARK denials activate the proxy for the rest of the run', async () => {
    const calls: string[] = [];
    const notices: string[] = [];
    const client = createRequestClients(readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '0' }), {
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('https://r.jina.ai/')) {
          return new Response('Title: ARK\nURL Source: https://www.ark-funds.com/funds/arkb\nMarkdown Content:\n{"ok":true}', { status: 200 });
        }
        return new Response('blocked', { status: 403 });
      },
      onIssuerProxy: (message) => notices.push(message),
    });
    await expect(client.ark('https://www.ark-funds.com/funds/arkk')).rejects.toMatchObject({ status: 403 } satisfies Partial<ProviderHttpError>);
    const secondUrl = 'https://www.ark-funds.com/funds/arkb';
    await expect(client.ark(secondUrl)).resolves.toMatchObject({ text: '{"ok":true}' });
    const thirdUrl = 'https://www.ark-funds.com/api/fund/overview/1010';
    await expect(client.ark(thirdUrl)).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(client.isArkProxyActive()).toBe(true);
    expect(calls).toEqual([
      'https://www.ark-funds.com/funds/arkk',
      secondUrl,
      jinaReaderUrl(secondUrl),
      jinaReaderUrl(thirdUrl),
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('[ issuer   ]');
  });

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
  test('official fixture responses produce UI-compatible paginated files and byte-stable reruns', async () => {
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
    const clients = {
      ark: async (url: string) => {
        if (url === fund.fundPage) return respond('<script>url: "/api/fund/overview/1004"</script>', url);
        if (url.includes('/api/fund/overview/1004')) return respond(JSON.stringify(overviewFixture), url);
        if (url.includes('/api/fund/nav-historical-change/1004')) return respond(JSON.stringify(navHistoryFixture), url);
        if (url.includes('/api/fund/performance/1004')) {
          const range = new URL(url).searchParams.get('Range');
          return respond(JSON.stringify(range === 'quarter-end' ? quarterPerformanceFixture : monthPerformanceFixture), url);
        }
        throw new Error(`unexpected ARK URL: ${url}`);
      },
      azure: async (url: string) => respond(arkkCsv, url, { 'last-modified': 'Mon, 28 Sep 2026 06:05:47 GMT' }),
      yahoo: async (url: string) => respond(JSON.stringify(yahooPayload), url),
      sec: async (url: string) => { throw new Error(`unexpected SEC URL: ${url}`); },
      isArkProxyActive: () => false,
    };
    const config = readConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '0', HOLDINGS_PAGE_SIZE: '20', HISTORY_PAGE_SIZE: '2' });
    try {
      const first = await updateArkFund(fund, config, clients, { apiRoot: directory, referenceDate });
      expect(first.entry).toMatchObject({ ticker: 'ARKK', holdings: 46, history: 4, terValue: 0.75, metrics: { tr1y: 14.07, cagr3y: 25.02 } });
      expect(first.entry).toMatchObject({ returns: { monthEnd: { ytd: 11.13, asOfDate: 'Aug 31 2026' }, quarterEnd: { asOfDate: 'Jun 30 2026' } } });
      const fundRoot = join(directory, 'funds', ticker);
      const metaText = await readFile(join(fundRoot, 'meta.json'), 'utf8');
      const meta = JSON.parse(metaText) as Record<string, unknown>;
      expect(meta).toMatchObject({ source: { pageId: '1004', holdingsSource: 'official ARK daily holdings CSV', historySource: 'official ARK Invest daily NAV and market-price history API' } });
      const holdingsPage = JSON.parse(await readFile(join(fundRoot, 'holdings', '001.json'), 'utf8')) as Record<string, unknown>;
      expect(holdingsPage).toMatchObject({ ticker: 'ARKK', page: 1, totalRows: 46, headers: ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] });
      expect(holdingsPage.rows).toBeArrayOfSize(20);
      expect((holdingsPage.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ Ticker: 'TSLA', Weight: '9.12%' });
      const historyPage = JSON.parse(await readFile(join(fundRoot, 'history', '001.json'), 'utf8')) as Record<string, unknown>;
      expect(historyPage).toMatchObject({ totalRows: 4, headers: ['Date', 'NAV', 'Market Price', 'Premium/Discount'] });
      expect(historyPage.rows).toBeArrayOfSize(2);

      const paths = [
        join(fundRoot, 'meta.json'),
        join(fundRoot, 'holdings', '001.json'), join(fundRoot, 'holdings', '002.json'), join(fundRoot, 'holdings', '003.json'),
        join(fundRoot, 'history', '001.json'), join(fundRoot, 'history', '002.json'),
      ];
      const before = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      await updateArkFund(fund, config, clients, { apiRoot: directory, referenceDate });
      const after = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      expect(after).toEqual(before);
      const retainedConfig = readConfig({ SKIP_ARK: '1', SKIP_YAHOO: '1', EDGAR_FALLBACK: '0', REQUEST_SLEEP: '0', MAX_RETRIES: '0', HOLDINGS_PAGE_SIZE: '20', HISTORY_PAGE_SIZE: '2' });
      const retained = await updateArkFund(fund, retainedConfig, clients, { apiRoot: directory, referenceDate });
      expect(retained).toMatchObject({ holdingsCount: 46, historyCount: 4 });
      const afterRetention = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
      expect(afterRetention).toEqual(before);
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
    const config = readConfig({
      TICKERS: 'ARKK ARKY', MAX_FETCHES: '1', REQUEST_SLEEP: '0', MAX_RETRIES: '0',
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
      expect(firstState).toMatchObject({ cursor: 1, tickers: ['ARKK', 'ARKY'] });

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
});
