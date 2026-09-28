#!/usr/bin/env bun
// Bun provides Node-compatible fs/promises and process globals for this script.
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}


// ---------------------------------------------------------------------------
// ARK catalog and stable public endpoints
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;
type Range = { min: number; max: number; source?: string };
type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

export type ArkFund = {
  ticker: string;
  name: string;
  category: string;
  fundPage: string;
  holdingsCsv: string;
  trustCik: string;
};

const ASSETS = 'https://assets.ark-funds.com/fund-documents/funds-etf-csv';
const ARK_SITE = 'https://www.ark-funds.com';
export const ARK_CATALOG_URL = `${ARK_SITE}/our-etfs/`;
const SEC_DATA_HOST = 'https://data.sec.gov';
const SEC_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
const SEC_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const API_ROOT = path.join(path.dirname(outputFileURLToPath(import.meta.url)), '..', 'api', 'ark');
const INDEX_FILE = path.join(API_ROOT, 'index.json');
const STATE_FILE = path.join(API_ROOT, 'update-state.json');
const DEFAULT_HOLDINGS_PAGE_SIZE = 250;
const DEFAULT_HISTORY_PAGE_SIZE = 1000;
const DEFAULT_REQUEST_SLEEP = 1.5;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_RETRIES = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
const AUM_PRESETS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: Number.POSITIVE_INFINITY },
} as const;
type AumPreset = keyof typeof AUM_PRESETS;
const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export const ARK_FUNDS: readonly ArkFund[] = [
  { ticker: 'ARKB', name: 'ARK 21Shares Bitcoin ETF', category: 'Digital Assets', fundPage: `${ARK_SITE}/funds/arkb`, holdingsCsv: `${ASSETS}/ARK_21SHARES_BITCOIN_ETF_ARKB_HOLDINGS.csv`, trustCik: '0001869699' },
  { ticker: 'ARKD', name: 'ARK DIET Q1 Buffer ETF', category: 'Defined Outcome', fundPage: `${ARK_SITE}/funds/arkd`, holdingsCsv: `${ASSETS}/ARK_DIET_Q1_BUFFER_ETF_ARKD_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKE', name: 'ARK DIET Q3 Buffer ETF', category: 'Defined Outcome', fundPage: `${ARK_SITE}/funds/arke`, holdingsCsv: `${ASSETS}/ARK_DIET_Q3_BUFFER_ETF_ARKE_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKF', name: 'ARK Blockchain & Fintech Innovation ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/arkf`, holdingsCsv: `${ASSETS}/ARK_FINTECH_INNOVATION_ETF_ARKF_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKG', name: 'ARK Genomic Revolution ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/arkg`, holdingsCsv: `${ASSETS}/ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKI', name: 'ARK DIET Q2 Buffer ETF', category: 'Defined Outcome', fundPage: `${ARK_SITE}/funds/arki`, holdingsCsv: `${ASSETS}/ARK_DIET_Q2_BUFFER_ETF_ARKI_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKK', name: 'ARK Innovation ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/arkk`, holdingsCsv: `${ASSETS}/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKQ', name: 'ARK Autonomous Technology & Robotics ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/arkq`, holdingsCsv: `${ASSETS}/ARK_AUTONOMOUS_TECH._%26_ROBOTICS_ETF_ARKQ_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKT', name: 'ARK DIET Q4 Buffer ETF', category: 'Defined Outcome', fundPage: `${ARK_SITE}/funds/arkt`, holdingsCsv: `${ASSETS}/ARK_DIET_Q4_BUFFER_ETF_ARKT_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKW', name: 'ARK Next Generation Technology ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/arkw`, holdingsCsv: `${ASSETS}/ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKX', name: 'ARK Space & Defense Innovation ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/arkx`, holdingsCsv: `${ASSETS}/ARK_SPACE_%26_DEFENSE_INNOVATION_ETF_ARKX_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'ARKY', name: 'ARK Active Autocallable Income ETF', category: 'Structured Income', fundPage: `${ARK_SITE}/funds/arky`, holdingsCsv: `${ASSETS}/ARK_ACTIVE_AUTOCALLABLE_INCOME_ETF_ARKY_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'IZRL', name: 'ARK Israel Innovative Technology ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/izrl`, holdingsCsv: `${ASSETS}/ARK_ISRAEL_INNOVATIVE_TECHNOLOGY_ETF_IZRL_HOLDINGS.csv`, trustCik: '0001579982' },
  { ticker: 'PRNT', name: 'The 3D Printing ETF', category: 'Thematic Equity', fundPage: `${ARK_SITE}/funds/prnt`, holdingsCsv: `${ASSETS}/THE_3D_PRINTING_ETF_PRNT_HOLDINGS.csv`, trustCik: '0001579982' },
];

const ARK_FUND_BY_TICKER = new Map(ARK_FUNDS.map((fund) => [fund.ticker, fund]));

export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] as const;
export const ARKY_HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category', 'Notional per Note'] as const;
export const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount'] as const;
export const YAHOO_HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'] as const;

export type HoldingRow = Record<string, string>;
export type ParsedHoldings = {
  ticker: string;
  headers: string[];
  rows: HoldingRow[];
  asOfDate: string;
  totalRows: number;
  sourceKind: 'official ARK daily holdings CSV' | 'official ARKY structured-note holdings CSV';
};
export type ArkDailyPoint = { date: string; nav: number | null; marketPrice: number | null; premiumDiscount: number | null };
export type YahooPricePoint = { date: string; close: number | null; adjClose: number | null; volume: number | null };
export type YahooDividend = { date: string; amount: number };
export type YahooChart = {
  points: YahooPricePoint[];
  dividends: YahooDividend[];
  exchangeName: string | null;
  currency: string | null;
  regularMarketPrice: number | null;
  firstTradeDate: string | null;
};
export type ArkPerformance = {
  ticker: string | null;
  asOfDate: string;
  navAnnualized: Record<string, number | null>;
  navCumulative: Record<string, number | null>;
  navCalendar: Record<string, number | null>;
  marketAnnualized: Record<string, number | null>;
  marketCumulative: Record<string, number | null>;
};
export type ArkOverview = {
  ticker: string | null;
  netAssets: number | null;
  netAssetsText: string;
  fundType: string;
  cusip: string | null;
  isin: string | null;
  exchange: string | null;
  inceptionDate: string | null;
  expenseRatio: number | null;
  expenseRatioText: string | null;
  asOfDate: string | null;
  secYield: number | null;
};

// ---------------------------------------------------------------------------
// Pure text, number, date, and category helpers
// ---------------------------------------------------------------------------

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

export function htmlText(fragment: string): string {
  return cleanText(decodeHtmlEntities(String(fragment ?? '').replace(/<br\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ' ')));
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let text = cleanText(value);
  if (!text || /^[-—–]+$/.test(text) || /^(n\/a|na|none|null)$/i.test(text)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[$,%\s,]/g, '');
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = cleanText(value).replace(/,/g, '');
  const match = /\(?\s*(-?\d+(?:\.\d+)?)\s*(trillion|billion|million|thousand|[KMBT])?\s*\)?/i.exec(text);
  if (!match) return numberOrNull(text);
  const suffix = (match[2] || '').toUpperCase();
  const multiplier = suffix.startsWith('TR') || suffix === 'T' ? 1e12
    : suffix.startsWith('B') ? 1e9
      : suffix.startsWith('M') ? 1e6
        : suffix.startsWith('K') || suffix.startsWith('TH') ? 1e3 : 1;
  const amount = Number(match[1]) * multiplier;
  return Number.isFinite(amount) ? amount : null;
}

export function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function toIsoDate(value: unknown): string {
  const text = cleanText(value);
  if (!text) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
}

export function displayDate(value: unknown): string {
  const iso = toIsoDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return cleanText(value);
  const month = Number(match[2]);
  return `${MONTHS[month - 1] || match[2]} ${String(Number(match[3])).padStart(2, '0')} ${match[1]}`;
}

export function formatUsDate(value: unknown): string {
  const iso = toIsoDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : cleanText(value);
}

export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;
}

export function categoryForType(rawType: string, fallback: string): string {
  const type = cleanText(rawType).toLowerCase();
  if (/digital asset|bitcoin|crypto/.test(type)) return 'Digital Assets';
  if (/autocall|structured income|income etf/.test(type)) return 'Structured Income';
  if (/buffer|defined outcome|di[e]?t/.test(type)) return 'Defined Outcome';
  return fallback;
}

function tickerOrBlank(value: unknown): string {
  const ticker = cleanText(value).toUpperCase();
  return ['-', '--', '—', 'N/A', 'NA', 'NONE'].includes(ticker) ? '' : ticker;
}

export function classifyArkAsset(nameValue: unknown, tickerValue: unknown): string {
  const name = cleanText(nameValue).toUpperCase();
  const ticker = tickerOrBlank(tickerValue);
  if (/GOLDMAN.*TRSY|MONEY MARKET|CASH AND CASH EQUIVALENTS|CASH & CASH EQUIVALENTS|CASH SWEEP/.test(name)) return 'Cash & Equivalents';
  if (/TREASURY|T-BILL|T BILL/.test(name)) return 'Treasury';
  if (/AUTOCALL|ELN|TRS|STRUCTURED NOTE|EQUITY LINKED NOTE/.test(name)) return 'Structured Note';
  if (/BITCOIN|ETHEREUM|DIGITAL ASSET|CRYPTO/.test(name) || ['BTC', 'ETH', 'BITCOIN'].includes(ticker)) return 'Digital Asset';
  if (/ETF|FUND|TRUST|MUTUAL/.test(name)) return 'Fund';
  if (!ticker) return 'Other';
  return 'Equity';
}

// ---------------------------------------------------------------------------
// RFC-4180 CSV parser and official holdings mapping
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const body = String(text).replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export function headerKey(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function parseArkHoldingsCsv(text: string, tickerValue: string, modifiedAt = ''): ParsedHoldings {
  const ticker = tickerOrBlank(tickerValue);
  const fund = ARK_FUND_BY_TICKER.get(ticker);
  if (!fund) throw new Error(`holdings: unsupported ARK ETF ticker ${ticker || '(empty)'}`);
  const table = parseCsv(text);
  const headerIndex = table.findIndex((row) => row.some((cell) => ['company', 'position'].includes(headerKey(cell))));
  if (headerIndex < 0) throw new Error(`${ticker} holdings CSV: header row not found`);
  const header = table[headerIndex].map(headerKey);
  const indexOf = (key: string): number => header.indexOf(key);
  const at = (row: string[], key: string): string => {
    const index = indexOf(key);
    return index < 0 ? '' : cleanText(row[index] ?? '');
  };
  const arky = indexOf('position') >= 0 && indexOf('notionalpernote') >= 0 && indexOf('marketweight') >= 0;
  const asOfFromModified = toIsoDate(modifiedAt);
  const rows: HoldingRow[] = [];
  let asOfDate = '';
  if (arky) {
    if (ticker !== 'ARKY') throw new Error(`${ticker} holdings CSV: unexpected structured-note layout`);
    for (const row of table.slice(headerIndex + 1)) {
      const name = at(row, 'position');
      if (!name) continue;
      const cusip = at(row, 'cusip');
      const notional = at(row, 'notionalpernote');
      rows.push({
        Name: name,
        Ticker: '',
        Identifier: cusip,
        Weight: at(row, 'marketweight'),
        'Market Value': at(row, 'marketvalue'),
        'Shares Held': '',
        'Asset Category': classifyArkAsset(name, ''),
        'Notional per Note': notional,
      });
    }
    asOfDate = asOfFromModified;
  } else {
    const required = ['date', 'fund', 'company', 'ticker', 'cusip', 'shares', 'marketvalue', 'weight'];
    const missing = required.filter((key) => indexOf(key) < 0);
    if (missing.length) throw new Error(`${ticker} holdings CSV: missing standard columns ${missing.join(', ')}`);
    for (const row of table.slice(headerIndex + 1)) {
      const name = at(row, 'company');
      if (!name) continue;
      const rowTicker = at(row, 'fund').toUpperCase();
      if (rowTicker && rowTicker !== ticker) throw new Error(`${ticker} holdings CSV contains fund ${rowTicker}`);
      const sourceDate = toIsoDate(at(row, 'date'));
      if (sourceDate && !asOfDate) asOfDate = sourceDate;
      const holdingTicker = tickerOrBlank(at(row, 'ticker'));
      rows.push({
        Name: name,
        Ticker: holdingTicker,
        Identifier: at(row, 'cusip'),
        Weight: at(row, 'weight'),
        'Market Value': at(row, 'marketvalue'),
        'Shares Held': at(row, 'shares'),
        'Asset Category': classifyArkAsset(name, holdingTicker),
      });
    }
    if (!asOfDate) asOfDate = asOfFromModified;
  }
  if (!rows.length) throw new Error(`${ticker} holdings CSV contains no positions`);
  return {
    ticker,
    headers: [...(arky ? ARKY_HOLDINGS_HEADERS : HOLDINGS_HEADERS)],
    rows,
    asOfDate,
    totalRows: rows.length,
    sourceKind: arky ? 'official ARKY structured-note holdings CSV' : 'official ARK daily holdings CSV',
  };
}

// ---------------------------------------------------------------------------
// Official ARK HTML/JSON response parsers
// ---------------------------------------------------------------------------

export function parseArkCatalogHtml(html: string): ArkFund[] {
  const discovered = new Set<string>();
  for (const match of String(html).matchAll(/\/funds\/([a-z0-9]+)/gi)) {
    const ticker = String(match[1]).toUpperCase();
    if (ARK_FUND_BY_TICKER.has(ticker)) discovered.add(ticker);
  }
  return ARK_FUNDS.filter((fund) => discovered.has(fund.ticker));
}

export function extractFundPageId(html: string): string | null {
  const match = /\/api\/fund\/overview\/(\d+)/i.exec(String(html));
  return match ? match[1] : null;
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function detailsItems(html: string): Map<string, string> {
  const items = new Map<string, string>();
  for (const match of String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const body = match[1];
    const span = /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(body);
    if (!span || span.index === undefined) continue;
    const label = htmlText(body.slice(0, span.index)).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const value = htmlText(span[1]);
    if (label) items.set(label, value);
  }
  return items;
}

function totalFeeText(html: string): string | null {
  const match = /<b\b[^>]*>\s*TOTAL FEES\s*<\/b>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(String(html));
  return match ? htmlText(match[1]) || null : null;
}

export function parseArkOverview(payload: unknown): ArkOverview {
  const root = record(payload);
  const details = detailsItems(String(root.detailsView ?? ''));
  const fees = totalFeeText(String(root.feesView ?? ''));
  const netAssetsText = details.get('NET ASSETS') || '';
  const expenseText = details.get('EXPENSE RATIO') || fees || '';
  const dateMatch = /(?:as\s+of\s+)?(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i.exec(cleanText(root.formattedDate));
  return {
    ticker: details.get('TICKER')?.toUpperCase() || null,
    netAssets: parseAmount(netAssetsText),
    netAssetsText,
    fundType: details.get('TYPE') || '',
    cusip: details.get('CUSIP') || null,
    isin: details.get('ISIN') || null,
    exchange: details.get('PRIMARY EXCHANGE') || null,
    inceptionDate: toIsoDate(details.get('INCEPTION DATE')) || null,
    expenseRatio: numberOrNull(expenseText),
    expenseRatioText: expenseText || null,
    asOfDate: dateMatch ? toIsoDate(dateMatch[1]) || null : null,
    secYield: numberOrNull(details.get('30 DAY SEC YIELD') || details.get('SEC YIELD') || ''),
  };
}

export function parseArkNavHistory(payload: unknown): ArkDailyPoint[] {
  const chart = record(payload).chartData;
  if (!Array.isArray(chart)) return [];
  const byDate = new Map<string, ArkDailyPoint>();
  for (const raw of chart) {
    const item = record(raw);
    const epoch = numberOrNull(item.epochDateMilliSeconds);
    if (epoch === null) continue;
    const milliseconds = epoch < 100_000_000_000 ? epoch * 1000 : epoch;
    const date = new Date(milliseconds).toISOString().slice(0, 10);
    const nav = numberOrNull(item.nav);
    const marketPrice = numberOrNull(item.marketPrice);
    if (nav === null && marketPrice === null) continue;
    const premiumDiscount = nav !== null && nav !== 0 && marketPrice !== null
      ? round(((marketPrice - nav) / nav) * 100, 4)
      : null;
    byDate.set(date, { date, nav, marketPrice, premiumDiscount });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function htmlTableRows(fragment: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of String(fragment).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(htmlText(cellMatch[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function sectionTableRows(view: string, sectionId: string): string[][] {
  const match = new RegExp(`id=["']${sectionId}["']`, 'i').exec(view);
  if (!match || match.index === undefined) return [];
  const remaining = view.slice(match.index);
  const nextSection = /id=["']tab-(?:annualized|cumulative|calendar-year)["']/gi;
  nextSection.lastIndex = 4;
  const next = nextSection.exec(remaining);
  const section = next ? remaining.slice(0, next.index) : remaining;
  const table = /<table\b[^>]*>[\s\S]*?<\/table>/i.exec(section);
  return table ? htmlTableRows(table[0]) : [];
}

function periodKey(value: string): string {
  const key = cleanText(value).toLowerCase().replace(/\s+/g, ' ');
  if (/^1\s*year$/.test(key)) return '1Y';
  if (/^3\s*years?$/.test(key)) return '3Y';
  if (/^5\s*years?$/.test(key)) return '5Y';
  if (/^10\s*years?$/.test(key)) return '10Y';
  if (key === 'ytd') return 'YTD';
  if (/^1\s*months?$/.test(key)) return '1M';
  if (/^3\s*months?$/.test(key)) return '3M';
  if (key === 'since inception') return 'SI';
  const year = /^(\d{4})\s*year$/.exec(key);
  return year ? year[1] : key.toUpperCase();
}

function performanceRows(rows: string[][], desired: 'NAV' | 'MARKET PRICE'): Record<string, number | null> {
  if (!rows.length) return {};
  const header = rows[0].slice(1).map(periodKey);
  const target = rows.find((row) => cleanText(row[0]).toUpperCase() === desired);
  if (!target) return {};
  const values: Record<string, number | null> = {};
  for (let index = 0; index < header.length; index += 1) values[header[index]] = numberOrNull(target[index + 1] ?? null);
  return values;
}

export function parseArkPerformance(payload: unknown): ArkPerformance {
  const root = record(payload);
  const view = String(root.view ?? '');
  const dateMatch = /As\s+of\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i.exec(view);
  const annual = sectionTableRows(view, 'tab-annualized');
  const cumulative = sectionTableRows(view, 'tab-cumulative');
  const calendar = sectionTableRows(view, 'tab-calendar-year');
  return {
    ticker: cleanText(root.ticker).toUpperCase() || null,
    asOfDate: dateMatch ? toIsoDate(dateMatch[1]) : '',
    navAnnualized: performanceRows(annual, 'NAV'),
    navCumulative: performanceRows(cumulative, 'NAV'),
    navCalendar: performanceRows(calendar, 'NAV'),
    marketAnnualized: performanceRows(annual, 'MARKET PRICE'),
    marketCumulative: performanceRows(cumulative, 'MARKET PRICE'),
  };
}

export function buildOfficialReturns(monthEnd: ArkPerformance | null, quarterEnd: ArkPerformance | null): {
  monthEnd: JsonRecord;
  quarterEnd: JsonRecord;
  metrics: JsonRecord;
} {
  const monthAnn = monthEnd?.navAnnualized ?? {};
  const monthCum = monthEnd?.navCumulative ?? {};
  const quarterAnn = quarterEnd?.navAnnualized ?? {};
  const quarterCum = quarterEnd?.navCumulative ?? {};
  const month: JsonRecord = {
    asOfDate: monthEnd?.asOfDate ? displayDate(monthEnd.asOfDate) : '',
    ytd: monthCum.YTD ?? null,
    yr1: monthAnn['1Y'] ?? null,
    yr3: monthAnn['3Y'] ?? null,
    yr5: monthAnn['5Y'] ?? null,
    yr10: monthAnn['10Y'] ?? null,
    sinceInception: monthAnn.SI ?? null,
    sinceInceptionCumulative: monthCum.SI ?? null,
    mo1: monthCum['1M'] ?? null,
    mo3: monthCum['3M'] ?? null,
  };
  const quarter: JsonRecord = {
    asOfDate: quarterEnd?.asOfDate ? displayDate(quarterEnd.asOfDate) : '',
    ytd: quarterCum.YTD ?? null,
    yr1: quarterAnn['1Y'] ?? null,
    yr3: quarterAnn['3Y'] ?? null,
    yr5: quarterAnn['5Y'] ?? null,
    yr10: quarterAnn['10Y'] ?? null,
    sinceInception: quarterAnn.SI ?? null,
    sinceInceptionCumulative: quarterCum.SI ?? null,
    mo1: quarterCum['1M'] ?? null,
    mo3: quarterCum['3M'] ?? null,
  };
  const cagr3y = typeof month.yr3 === 'number' ? month.yr3 : null;
  const cagr5y = typeof month.yr5 === 'number' ? month.yr5 : null;
  const cagr10y = typeof month.yr10 === 'number' ? month.yr10 : null;
  const metrics: JsonRecord = {
    ytd: month.ytd,
    tr1y: month.yr1,
    tr3y: cumulativeFromAnnualized(cagr3y, 3),
    tr5y: cumulativeFromAnnualized(cagr5y, 5),
    tr10y: cumulativeFromAnnualized(cagr10y, 10),
    cagr3y,
    cagr5y,
    cagr10y,
    siAnn: month.sinceInception,
    returnsBasis: 'official ARK Invest NAV total returns (fund performance API, month-end series)',
  };
  return { monthEnd: month, quarterEnd: quarter, metrics };
}

// ---------------------------------------------------------------------------
// Yahoo Finance fallback and return calculations
// ---------------------------------------------------------------------------

export function yahooChartUrl(tickerValue: string, nowEpochSeconds = Math.floor(Date.now() / 1000)): string {
  const ticker = tickerOrBlank(tickerValue);
  const query = new URLSearchParams({
    period1: '0',
    period2: String(Math.floor(nowEpochSeconds)),
    interval: '1d',
    events: 'div|split',
    includeAdjustedClose: 'true',
  });
  return `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?${query.toString()}`;
}

export function yahooChartProvenanceUrl(tickerValue: string): string {
  return `${YAHOO_CHART_URL}/${encodeURIComponent(tickerOrBlank(tickerValue))}`;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseYahooChart(payload: unknown): YahooChart {
  const chart = record(record(payload).chart);
  const result = record(arrayValue(chart.result)[0]);
  if (!Object.keys(result).length) return { points: [], dividends: [], exchangeName: null, currency: null, regularMarketPrice: null, firstTradeDate: null };
  const timestamps = arrayValue(result.timestamp);
  const indicators = record(result.indicators);
  const quote = record(arrayValue(indicators.quote)[0]);
  const quoteClose = arrayValue(quote.close);
  const quoteVolume = arrayValue(quote.volume);
  const adjusted = record(arrayValue(indicators.adjclose)[0]);
  const adjustedClose = arrayValue(adjusted.adjclose);
  const points: YahooPricePoint[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const epoch = numberOrNull(timestamps[index]);
    if (epoch === null) continue;
    const date = new Date(epoch * 1000).toISOString().slice(0, 10);
    const closeRaw = numberOrNull(quoteClose[index]);
    const adjRaw = numberOrNull(adjustedClose[index]);
    if (closeRaw === null && adjRaw === null) continue;
    points.push({
      date,
      close: closeRaw === null ? null : round(closeRaw, 2),
      // Yahoo recomputes adjusted-close values, so persist the stable two-decimal value.
      adjClose: adjRaw === null ? null : round(adjRaw, 2),
      volume: numberOrNull(quoteVolume[index]),
    });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  const dividends: YahooDividend[] = [];
  const events = record(record(result.events).dividends);
  for (const [key, raw] of Object.entries(events)) {
    const event = record(raw);
    const epoch = numberOrNull(event.date) ?? numberOrNull(key);
    const amount = numberOrNull(event.amount);
    if (epoch === null || amount === null) continue;
    const date = new Date(epoch * 1000).toISOString().slice(0, 10);
    dividends.push({ date, amount });
  }
  dividends.sort((a, b) => a.date.localeCompare(b.date));
  const meta = record(result.meta);
  const regularMarketPrice = numberOrNull(meta.regularMarketPrice);
  const firstTradeEpoch = numberOrNull(meta.firstTradeDate);
  return {
    points,
    dividends,
    exchangeName: cleanText(meta.fullExchangeName ?? meta.exchangeName) || null,
    currency: cleanText(meta.currency) || null,
    regularMarketPrice,
    firstTradeDate: firstTradeEpoch === null ? null : new Date(firstTradeEpoch * 1000).toISOString().slice(0, 10),
  };
}

export function cumulativeFromAnnualized(annualized: number | null, years: number): number | null {
  if (annualized === null || !Number.isFinite(annualized) || years <= 0) return null;
  return round(((1 + annualized / 100) ** years - 1) * 100, 2);
}

export function annualizedFromCumulative(cumulative: number | null, years: number): number | null {
  if (cumulative === null || !Number.isFinite(cumulative) || years <= 0) return null;
  const base = 1 + cumulative / 100;
  return base <= 0 ? null : round((base ** (1 / years) - 1) * 100, 2);
}

export function paymentsPerYear(frequency: string | null | undefined): number | null {
  const text = cleanText(frequency).toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (['monthly', 'mdec', 'month'].includes(text)) return 12;
  if (['quarterly', 'qdec', 'quarter'].includes(text)) return 4;
  if (['semi-annually', 'semiannually', 'semi-annual', 'semiannual', 'sdec'].includes(text)) return 6;
  if (['annually', 'annual', 'ydec', 'yearly'].includes(text)) return 1;
  if (text === 'weekly') return 52;
  return null;
}

export function formatDistributionFrequency(value: unknown): string {
  const raw = cleanText(value);
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!normalized || normalized === '-') return '00 - None';
  if (normalized === 'monthly' || normalized === 'mdec') return '01 - Monthly';
  if (normalized === 'quarterly' || normalized === 'qdec') return '04 - Quarterly';
  if (['semi-annually', 'semiannual', 'semi-annual', 'sdec'].includes(normalized)) return '06 - Semi-annually';
  if (['annually', 'annual', 'ydec', 'yearly'].includes(normalized)) return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular' || normalized === 'other') return '99 - Irregular';
  return raw;
}

export function inferDistributionFrequency(exDates: string[], referenceDate = new Date()): string | null {
  const cutoff = new Date(referenceDate.getTime() - 400 * 86_400_000).toISOString().slice(0, 10);
  const through = referenceDate.toISOString().slice(0, 10);
  const recent = [...new Set(exDates.map(toIsoDate).filter((date) => date && date >= cutoff && date <= through))].sort();
  if (!recent.length) return null;
  if (recent.length < 3) return 'Unknown';
  const gaps = recent.slice(1).map((date, index) => (Date.parse(date) - Date.parse(recent[index])) / 86_400_000).filter((gap) => gap > 0);
  if (!gaps.length) return 'Unknown';
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (mean >= 20 && mean <= 40) return 'Monthly';
  if (mean >= 70 && mean <= 110) return 'Quarterly';
  if (mean >= 150 && mean <= 215) return 'Semi-annually';
  if (mean >= 330 && mean <= 400) return 'Annually';
  return 'Irregular';
}

export function trailingDividendYield(dividends: YahooDividend[], price: number | null, asOfDate: string): number | null {
  if (price === null || price <= 0) return null;
  const end = toIsoDate(asOfDate);
  if (!end) return null;
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 365);
  const from = start.toISOString().slice(0, 10);
  const paid = dividends.filter((event) => event.date >= from && event.date <= end).reduce((sum, event) => sum + event.amount, 0);
  return paid > 0 ? round((paid / price) * 100, 2) : null;
}

function monthEndBefore(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

function quarterEndBefore(now: Date): string {
  const quarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(now.getUTCFullYear(), quarterStartMonth, 0)).toISOString().slice(0, 10);
}

function addYears(iso: string, amount: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + amount);
  return date.toISOString().slice(0, 10);
}

function addMonths(iso: string, amount: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 10);
}

function priceAtOrBefore(points: YahooPricePoint[], date: string): YahooPricePoint | null {
  let result: YahooPricePoint | null = null;
  for (const point of points) {
    if (point.date > date) break;
    if ((point.adjClose ?? point.close) !== null) result = point;
  }
  return result;
}

function totalReturn(points: YahooPricePoint[], endDate: string, startDate: string): number | null {
  const end = priceAtOrBefore(points, endDate);
  const start = priceAtOrBefore(points, startDate);
  const endValue = end?.adjClose ?? end?.close ?? null;
  const startValue = start?.adjClose ?? start?.close ?? null;
  if (!end || !start || endValue === null || startValue === null || startValue <= 0 || end.date <= start.date) return null;
  return round((endValue / startValue - 1) * 100, 2);
}

function annualizedReturn(points: YahooPricePoint[], endDate: string, years: number): number | null {
  const end = priceAtOrBefore(points, endDate);
  const startDate = addYears(endDate, -years);
  const start = priceAtOrBefore(points, startDate);
  const endValue = end?.adjClose ?? end?.close ?? null;
  const startValue = start?.adjClose ?? start?.close ?? null;
  if (!end || !start || endValue === null || startValue === null || startValue <= 0 || end.date <= start.date) return null;
  const days = (Date.parse(end.date) - Date.parse(start.date)) / 86_400_000;
  if (days < 300 * years) return null;
  return round(((endValue / startValue) ** (365.2425 / days) - 1) * 100, 2);
}

function sinceInceptionReturns(points: YahooPricePoint[], endDate: string): { annualized: number | null; cumulative: number | null } {
  const end = priceAtOrBefore(points, endDate);
  const start = points.find((point) => point.date <= endDate && (point.adjClose ?? point.close) !== null) ?? null;
  const endValue = end?.adjClose ?? end?.close ?? null;
  const startValue = start?.adjClose ?? start?.close ?? null;
  if (!end || !start || endValue === null || startValue === null || startValue <= 0 || end.date <= start.date) return { annualized: null, cumulative: null };
  const years = (Date.parse(end.date) - Date.parse(start.date)) / (365.2425 * 86_400_000);
  const cumulative = round((endValue / startValue - 1) * 100, 2);
  return { annualized: years >= 1 ? annualizedFromCumulative(cumulative, years) : null, cumulative };
}

function derivedPeriod(points: YahooPricePoint[], endDate: string): JsonRecord {
  const inception = sinceInceptionReturns(points, endDate);
  const yr1 = totalReturn(points, endDate, addYears(endDate, -1));
  const yr3 = annualizedReturn(points, endDate, 3);
  const yr5 = annualizedReturn(points, endDate, 5);
  const yr10 = annualizedReturn(points, endDate, 10);
  return {
    asOfDate: endDate ? displayDate(endDate) : '',
    mo1: totalReturn(points, endDate, addMonths(endDate, -1)),
    mo3: totalReturn(points, endDate, addMonths(endDate, -3)),
    ytd: totalReturn(points, endDate, `${endDate.slice(0, 4)}-01-01`),
    yr1,
    yr3,
    yr5,
    yr10,
    sinceInception: inception.annualized,
    sinceInceptionCumulative: inception.cumulative,
  };
}

export function buildYahooReturns(points: YahooPricePoint[], referenceDate = new Date()): { monthEnd: JsonRecord; quarterEnd: JsonRecord; metrics: JsonRecord } {
  const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const monthEnd = derivedPeriod(ordered, monthEndBefore(referenceDate));
  const quarterEnd = derivedPeriod(ordered, quarterEndBefore(referenceDate));
  const cagr3y = typeof monthEnd.yr3 === 'number' ? monthEnd.yr3 : null;
  const cagr5y = typeof monthEnd.yr5 === 'number' ? monthEnd.yr5 : null;
  const cagr10y = typeof monthEnd.yr10 === 'number' ? monthEnd.yr10 : null;
  return {
    monthEnd,
    quarterEnd,
    metrics: {
      ytd: monthEnd.ytd,
      tr1y: monthEnd.yr1,
      tr3y: cumulativeFromAnnualized(cagr3y, 3),
      tr5y: cumulativeFromAnnualized(cagr5y, 5),
      tr10y: cumulativeFromAnnualized(cagr10y, 10),
      cagr3y,
      cagr5y,
      cagr10y,
      siAnn: monthEnd.sinceInception,
      returnsBasis: 'Yahoo Finance adjusted close total-return proxy (official ARK performance unavailable)',
    },
  };
}

// ---------------------------------------------------------------------------
// Environment configuration and filters
// ---------------------------------------------------------------------------

export type UpdaterConfig = {
  concurrency: number;
  requestSleepSeconds: number;
  maxFetches: number;
  maxRetries: number;
  holdingsPageSize: number;
  historyPageSize: number;
  tickers: string[];
  category: string;
  secUa: string;
  skipArk: boolean;
  skipYahoo: boolean;
  edgarFallback: boolean;
  aumRange?: Range;
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

export function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

export function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseNonNegativeDecimal(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseBoolean(raw: string, fallback = false): boolean {
  if (!raw) return fallback;
  return /^(1|true|yes|y|on)$/i.test(raw);
}

export function parseRange(raw: string, label = 'range'): Range | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`${label}: expected min:max with exactly one colon`);
  const parseBound = (value: string, lower: boolean): number => {
    const cleaned = value.replace(/[$,%\s]/g, '');
    if (!cleaned) return lower ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) throw new Error(`${label}: invalid numeric bound ${value}`);
    return parsed;
  };
  const range = { min: parseBound(parts[0], true), max: parseBound(parts[1], false), source: raw };
  if (range.min > range.max) throw new Error(`${label}: minimum exceeds maximum`);
  return range;
}

function parseAumBound(raw: string): number | undefined {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return undefined;
  const preset = AUM_PRESETS[cleaned.toLowerCase() as AumPreset];
  if (preset) return preset.min;
  const match = /^(-?\d+(?:\.\d+)?)([KMBT])?$/i.exec(cleaned);
  if (!match) throw new Error(`AUM: invalid bound ${raw}`);
  return Number(match[1]) * (match[2] ? AMOUNT_SUFFIXES[match[2].toUpperCase()] : 1);
}

export function parseAumRange(raw: string): Range | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  const wholePreset = AUM_PRESETS[text.toLowerCase() as AumPreset];
  if (wholePreset) return { ...wholePreset, source: raw };
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error('AUM: expected min:max with exactly one colon');
  const leftPreset = AUM_PRESETS[parts[0].replace(/[$,\s]/g, '').toLowerCase() as AumPreset];
  const rightPreset = AUM_PRESETS[parts[1].replace(/[$,\s]/g, '').toLowerCase() as AumPreset];
  const min = leftPreset ? leftPreset.min : (parseAumBound(parts[0]) ?? Number.NEGATIVE_INFINITY);
  const max = rightPreset ? rightPreset.max : (parseAumBound(parts[1]) ?? Number.POSITIVE_INFINITY);
  if (min > max) throw new Error('AUM: minimum exceeds maximum');
  return { min, max, source: raw };
}

function parseReturnRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const result: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const value = envValue(env, `${prefix}_${period}`);
    const range = value ? parseRange(value, `${prefix}_${period}`) : undefined;
    if (range) result[period] = range;
  }
  return result;
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  const tickers = envValue(env, 'TICKERS').split(/[\s,;]+/).map((value) => tickerOrBlank(value)).filter(Boolean);
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), DEFAULT_CONCURRENCY),
    requestSleepSeconds: parseNonNegativeDecimal(envValue(env, 'REQUEST_SLEEP'), DEFAULT_REQUEST_SLEEP),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES'), 0),
    maxRetries: parseNonNegativeInt(envValue(env, 'MAX_RETRIES'), DEFAULT_MAX_RETRIES),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), DEFAULT_HOLDINGS_PAGE_SIZE),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), DEFAULT_HISTORY_PAGE_SIZE),
    tickers,
    category: cleanText(envValue(env, 'CATEGORY')),
    secUa: envValue(env, 'SEC_UA') || 'DaggerOk ARK static feed updater admin@daggerok.example.com',
    skipArk: parseBoolean(envValue(env, 'SKIP_ARK')),
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO')),
    edgarFallback: parseBoolean(envValue(env, 'EDGAR_FALLBACK'), true),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseReturnRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseReturnRanges(env, 'TOTAL_RETURN'),
  };
}

export function hasDeferredFilters(config: UpdaterConfig): boolean {
  return Boolean(config.aumRange || config.terRange || config.dividendYieldRange || config.secYieldRange ||
    Object.keys(config.performanceRanges).length || Object.keys(config.totalReturnRanges).length);
}

export function passesStaticFilters(fund: ArkFund, config: UpdaterConfig): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
  if (config.category && !fund.category.toLowerCase().includes(config.category.toLowerCase())) return false;
  return true;
}

function withinRange(value: number | null, range: Range | undefined, missingPasses = false): boolean {
  if (!range) return true;
  if (value === null || !Number.isFinite(value)) return missingPasses;
  return value >= range.min && value <= range.max;
}

export function passesMetricFilters(entry: JsonRecord, config: UpdaterConfig): boolean {
  const metrics = record(entry.metrics);
  const returns = record(entry.returns);
  const monthEnd = record(returns.monthEnd);
  if (!withinRange(numberOrNull(entry.aumValue), config.aumRange)) return false;
  if (!withinRange(numberOrNull(entry.terValue), config.terRange)) return false;
  if (!withinRange(numberOrNull(metrics.dividendYield), config.dividendYieldRange)) return false;
  if (!withinRange(numberOrNull(metrics.secYield), config.secYieldRange)) return false;
  const published: Record<ReturnPeriod, number | null> = {
    YTD: numberOrNull(monthEnd.ytd),
    '1Y': numberOrNull(metrics.tr1y) ?? numberOrNull(monthEnd.yr1),
    '3Y': numberOrNull(metrics.cagr3y) ?? numberOrNull(monthEnd.yr3),
    '5Y': numberOrNull(metrics.cagr5y) ?? numberOrNull(monthEnd.yr5),
    '10Y': numberOrNull(metrics.cagr10y) ?? numberOrNull(monthEnd.yr10),
  };
  const total: Record<ReturnPeriod, number | null> = {
    YTD: numberOrNull(monthEnd.ytd),
    '1Y': numberOrNull(metrics.tr1y),
    '3Y': numberOrNull(metrics.tr3y),
    '5Y': numberOrNull(metrics.tr5y),
    '10Y': numberOrNull(metrics.tr10y),
  };
  for (const period of RETURN_PERIODS) {
    if (!withinRange(published[period], config.performanceRanges[period], true)) return false;
    if (!withinRange(total[period], config.totalReturnRanges[period], true)) return false;
  }
  return true;
}

export const USAGE = `ARK Invest ETF static-feed updater (zero runtime dependencies; Bun only).

Usage: bun ./scripts/update-data.ts [--help]

Environment controls:
  TICKERS              Space/comma separated ETF tickers. ANDed with other filters.
  MAX_FETCHES          0 means all selected funds; positive values resume at the saved cursor.
  REQUEST_SLEEP        Seconds between request starts (default 1.5; issuer site uses one conservative gate).
  CONCURRENCY          Independent paced lanes for Azure, Yahoo, and SEC requests (default 2).
  MAX_RETRIES          Retry count for network/temporary HTTP errors (default 2).
  HOLDINGS_PAGE_SIZE   Holdings rows per static JSON page (default 250).
  HISTORY_PAGE_SIZE    History rows per static JSON page (default 1000).
  CATEGORY             Keep a category name (case-insensitive substring).
  AUM                  Dollar min:max; K/M/B/T suffixes or nano/micro/small/mid/large presets.
  TER                  Expense-ratio percent min:max.
  DIVIDEND_YIELD       Trailing 12-month indicated dividend yield percent min:max.
  SEC_YIELD            Published 30-day SEC yield percent min:max.
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y   Official annualized NAV performance range.
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y  Cumulative NAV total-return range.
  SEC_UA               Contact-bearing User-Agent for SEC EDGAR (default is a repository placeholder).
  EDGAR_FALLBACK       Enable Form N-PORT-P holdings fallback (default true).
  SKIP_ARK             Do not request ark-funds.com (requires prior static data for source fallbacks).
  SKIP_YAHOO           Disable Yahoo history/distribution fallback.
  VERBOSE              Show per-request retries and fallback notices.

Range syntax is strict min:max with one colon; an empty side is unbounded.

Examples:
  TICKERS="ARKK ARKY ARKB" bun ./scripts/update-data.ts
  MAX_FETCHES=3 bun ./scripts/update-data.ts
  AUM="1B:" TER=":0.75" bun ./scripts/update-data.ts
`;

// ---------------------------------------------------------------------------
// SEC EDGAR N-PORT parsing helpers (fallback only)
// ---------------------------------------------------------------------------

export type NportPosition = {
  name: string;
  ticker: string;
  identifier: string;
  balance: number | null;
  valueUsd: number | null;
  percent: number | null;
  assetCategory: string;
};
export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string;
  netAssets: number | null;
  positions: NportPosition[];
};
export type SecSeriesRef = { cik: string; seriesId: string; classId: string };
export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

function xmlTagText(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<(?:(?:[A-Za-z0-9_.-]+):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_.-]+):)?${escaped}\\s*>`, 'i').exec(xml);
  return match ? htmlText(match[1]) : '';
}

function xmlIdentifier(xml: string): string {
  const cusip = xmlTagText(xml, 'cusip');
  if (cusip && !/^n\/a$/i.test(cusip)) return cusip;
  const match = /<(?:isin|sedol|other|cusip)\b[^>]*\bvalue=["']([^"']+)["']/i.exec(xml);
  return match ? htmlText(match[1]) : '';
}

export function parseNportXml(xml: string): ParsedNport {
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo\s*>/i.exec(xml)?.[1] ?? '';
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo\s*>/i.exec(xml)?.[1] ?? '';
  const positions: NportPosition[] = [];
  const blockPattern = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec\s*>/gi;
  for (const match of String(xml).matchAll(blockPattern)) {
    const body = match[1];
    const valueText = xmlTagText(body, 'valUSD') || xmlTagText(body, 'curVal');
    positions.push({
      name: xmlTagText(body, 'name') || xmlTagText(body, 'title'),
      ticker: tickerOrBlank(xmlTagText(body, 'ticker')),
      identifier: xmlIdentifier(body),
      balance: numberOrNull(xmlTagText(body, 'balance')),
      valueUsd: numberOrNull(valueText),
      percent: numberOrNull(xmlTagText(body, 'pctVal')),
      assetCategory: xmlTagText(body, 'assetCat'),
    });
  }
  return {
    regName: xmlTagText(genInfo, 'regName'),
    regCik: xmlTagText(genInfo, 'regCik').replace(/\D/g, '').padStart(10, '0'),
    seriesName: xmlTagText(genInfo, 'seriesName'),
    seriesId: xmlTagText(genInfo, 'seriesId').toUpperCase(),
    repPdDate: toIsoDate(xmlTagText(genInfo, 'repPdDate')),
    netAssets: numberOrNull(xmlTagText(fundInfo, 'netAssets')),
    positions,
  };
}

export function parseFundTickerMap(payload: unknown): Map<string, SecSeriesRef> {
  const root = record(payload);
  const fields = arrayValue(root.fields).map((value) => String(value));
  const rows = arrayValue(root.data);
  const map = new Map<string, SecSeriesRef>();
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const row = raw as unknown[];
    const value = (field: string): string => {
      const index = fields.indexOf(field);
      return index < 0 ? '' : cleanText(row[index]);
    };
    const ticker = tickerOrBlank(value('symbol'));
    const cik = value('cik').replace(/\D/g, '');
    if (!ticker || !cik || map.has(ticker)) continue;
    map.set(ticker, { cik: cik.padStart(10, '0'), seriesId: value('seriesId').toUpperCase(), classId: value('classId').toUpperCase() });
  }
  return map;
}

export function nportUrlFor(cik: string, accession: string): string {
  return `${SEC_ARCHIVES}/${Number(cik)}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(submissions: unknown): NportAccession[] {
  const recent = record(record(submissions).filings).recent;
  const forms = arrayValue(record(recent).form);
  const accessions = arrayValue(record(recent).accessionNumber);
  const filed = arrayValue(record(recent).filingDate);
  const reportDate = arrayValue(record(recent).reportDate);
  const cik = cleanText(record(submissions).cik).replace(/\D/g, '').padStart(10, '0');
  const result: NportAccession[] = [];
  for (let index = 0; index < forms.length; index += 1) {
    if (cleanText(forms[index]).toUpperCase() !== 'NPORT-P') continue;
    const accession = cleanText(accessions[index]);
    if (!accession) continue;
    result.push({
      accession,
      filed: cleanText(filed[index]),
      reportDate: cleanText(reportDate[index]),
      url: nportUrlFor(cik, accession),
    });
  }
  return result;
}

export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  const query = new URLSearchParams({
    action: 'getcompany', CIK: seriesId.toUpperCase(), type: 'NPORT-P', dateb: '', owner: 'include', count: String(count), output: 'atom',
  });
  return `${SEC_BROWSE_URL}?${query.toString()}`;
}

export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const entry of String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1];
    const form = xmlTagText(body, 'filing-type') || xmlTagText(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = xmlTagText(body, 'accession-number') || xmlTagText(body, 'accession-nunber');
    const filingHref = xmlTagText(body, 'filing-href');
    const cik = /\/edgar\/data\/(\d+)\//i.exec(filingHref)?.[1] || accession.slice(0, 10);
    if (!accession) continue;
    result.push({ accession, filed: xmlTagText(body, 'filing-date'), reportDate: xmlTagText(body, 'period'), url: nportUrlFor(cik, accession) });
  }
  return result;
}

export function normalizeHoldingName(value: string): string {
  return cleanText(value).toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function parseCompanyTickerMap(payload: unknown): Map<string, string> {
  const root = record(payload);
  const map = new Map<string, string>();
  for (const raw of Object.values(root)) {
    const row = record(raw);
    const ticker = tickerOrBlank(row.ticker);
    const title = cleanText(row.title);
    if (!ticker || !title) continue;
    const normalized = normalizeHoldingName(title);
    if (normalized && !map.has(normalized)) map.set(normalized, ticker);
  }
  return map;
}

export function nportToHoldings(parsed: ParsedNport, companyTickers = new Map<string, string>()): HoldingRow[] {
  return parsed.positions.map((position) => {
    const ticker = position.ticker || companyTickers.get(normalizeHoldingName(position.name)) || '';
    const weight = position.percent !== null
      ? position.percent
      : (parsed.netAssets !== null && parsed.netAssets > 0 && position.valueUsd !== null ? (position.valueUsd / parsed.netAssets) * 100 : null);
    return {
      Name: position.name,
      Ticker: ticker,
      Identifier: position.identifier,
      Weight: weight === null ? '' : `${round(weight, 2)}%`,
      'Market Value': position.valueUsd === null ? '' : String(position.valueUsd),
      'Shares Held': position.balance === null ? '' : String(position.balance),
      'Asset Category': position.assetCategory || classifyArkAsset(position.name, ticker),
    };
  });
}

// ---------------------------------------------------------------------------
// Pagination and deterministic filesystem writes
// ---------------------------------------------------------------------------

export function splitPages<T>(rows: T[], pageSize: number): T[][] {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('page size must be a positive integer');
  const pages: T[][] = [];
  for (let index = 0; index < rows.length; index += pageSize) pages.push(rows.slice(index, index + pageSize));
  return pages;
}

export function pageFileName(index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error('page index must be a positive integer');
  return `${String(index).padStart(3, '0')}.json`;
}

export function buildPageEnvelope<T>(ticker: string, page: number, pageSize: number, totalRows: number, headers: readonly string[], rows: T[]): JsonRecord {
  return { ticker, page, pageSize, totalRows, headers: [...headers], rows };
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as JsonRecord;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortJsonKeys(source[key])]));
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortJsonKeys(value), null, 2)}\n`;
}

export function semanticContentKey(value: unknown): string {
  return outputContentKey(value);
}

export async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  if (existsSync(file) && await readFile(file, 'utf8') === content) return 'unchanged';
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return 'written';
}

export async function writeJsonIfChanged(file: string, value: unknown): Promise<'written' | 'unchanged'> {
  const serialized = stableStringify(value);
  if (existsSync(file)) {
    const currentText = await readFile(file, 'utf8');
    try {
      if (semanticContentKey(JSON.parse(currentText)) === semanticContentKey(value)) return 'unchanged';
    } catch { /* Replace a malformed prior JSON file with the valid candidate. */ }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serialized, 'utf8');
  return 'written';
}

export async function prunePages(directory: string, count: number): Promise<void> {
  if (!existsSync(directory)) return;
  const files = await readdir(directory);
  for (const file of files) {
    const match = /^(\d+)\.json$/.exec(file);
    if (match && Number(match[1]) > count) await rm(path.join(directory, file));
  }
}
