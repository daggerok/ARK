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
import { AsyncLocalStorage } from 'node:async_hooks';

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
    } else if (name === 'JINA_API_KEY') {
      values.set(name, value ? '(set)' : ''); // never echo secrets
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
  jinaApiKey: string;
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
    jinaApiKey: envValue(env, 'JINA_API_KEY'),
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
  REQUEST_SLEEP        Seconds between request starts within each worker, including retries (default 1.5).
  CONCURRENCY          Independent parallel fund workers, each with its own request pacing (default 2).
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
  JINA_API_KEY         Optional r.jina.ai key (environment/secret only, never a file control). ark-funds.com
                       rejects Bun's TLS fingerprint, so issuer data flows through the read-only r.jina.ai
                       proxy; keyless it is limited to about 20 requests/minute for the whole run, with a
                       key every worker paces itself by REQUEST_SLEEP only.

Defaults: scripts/update-data.config.json; explicit environment overrides the file (ARK_<KEY> wins over <KEY>).
Actions: file < advanced JSON < individual nonblank inputs. Range syntax is strict min:max with one colon;
an empty side is unbounded.

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
    const categoryForm = /<category\b[^>]*\bterm=["']([^"']+)["']/i.exec(body)?.[1] ?? '';
    const form = xmlTagText(body, 'filing-type') || xmlTagText(body, 'type') || categoryForm;
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const filingHref = xmlTagText(body, 'filing-href') || /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(body)?.[1] || '';
    const rawAccession = xmlTagText(body, 'accession-number') || xmlTagText(body, 'accession-nunber') || /\/(\d{18})(?:\/|$)/.exec(filingHref)?.[1] || '';
    const accessionDigits = rawAccession.replace(/\D/g, '');
    const accession = /^\d{18}$/.test(accessionDigits)
      ? `${accessionDigits.slice(0, 10)}-${accessionDigits.slice(10, 12)}-${accessionDigits.slice(12)}`
      : rawAccession;
    const cik = /\/Archives\/edgar\/data\/(\d+)\//i.exec(filingHref)?.[1] || /\/edgar\/data\/(\d+)\//i.exec(filingHref)?.[1] || accession.slice(0, 10);
    if (!accession) continue;
    result.push({ accession, filed: xmlTagText(body, 'filing-date') || xmlTagText(body, 'updated'), reportDate: xmlTagText(body, 'period') || xmlTagText(body, 'reportDate'), url: nportUrlFor(cik, accession) });
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

// ---------------------------------------------------------------------------
// Paced network clients (kept injectable so all request behavior is testable offline)
// ---------------------------------------------------------------------------

export type PaceClock = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type RequestRuntime = PaceClock & {
  fetchImpl?: typeof fetch;
  onRetry?: (message: string) => void;
  onIssuerProxy?: (message: string) => void;
  /** Per-request wall-clock limit (headers + body); tests override it. */
  requestTimeoutMs?: number;
};

type RequestGate = <T>(task: () => T | Promise<T>) => Promise<T>;
type Sleep = (milliseconds: number) => Promise<void>;

/**
 * Honest, contact-bearing User-Agent. Verified live 2026-09-28: ark-funds.com
 * sits behind a Cloudflare managed challenge that keys on the TLS fingerprint,
 * so Bun's fetch receives HTTP 403 with ANY User-Agent (curl passes, Bun does
 * not); spoofing a browser UA does not help there and makes r.jina.ai (also on
 * Cloudflare) challenge the request instead. Keep the tool UA everywhere.
 */
export const ISSUER_USER_AGENT = 'DaggerOk ARK Invest ETF data updater (+https://github.com/daggerok/ARK; admin@daggerok.example.com)';
const ISSUER_DIRECT_DENIAL_LIMIT = 2;
/**
 * r.jina.ai throttles keyless read requests to about 20 per minute per IP
 * (observed live as HTTP 429 "Per IP rate limit exceeded" at 1.5-second pacing).
 * Proxied issuer requests therefore never start closer than 3 seconds apart,
 * regardless of a shorter REQUEST_SLEEP.
 */
export const ISSUER_PROXY_MIN_INTERVAL_MS = 3000;
/**
 * Every provider request (including the r.jina.ai proxy, which renders pages
 * in a headless browser) is aborted after this long so one stalled connection
 * cannot block a paced lane for the rest of the run; the abort is retried as
 * a network error.
 */
export const REQUEST_TIMEOUT_MS = 90_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Independent paced lanes. Requests are assigned to the least-recently-used
 * lane at enqueue time and continue on that exact lane after the prior task
 * settles, even when the prior task rejects.
 */
export function createPacedGate(concurrency: number, intervalMs: number, clock: PaceClock = {}): RequestGate {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('request gate concurrency must be a positive integer');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('request gate interval must be a non-negative finite number');
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? defaultSleep;
  const lanes: Array<{ lastUsed: number; nextAllowedAt: number; tail: Promise<void> }> = Array.from(
    { length: concurrency },
    () => ({ lastUsed: 0, nextAllowedAt: Number.NEGATIVE_INFINITY, tail: Promise.resolve() }),
  );
  let order = 0;
  return <T>(task: () => T | Promise<T>): Promise<T> => {
    let selected = lanes[0];
    for (const lane of lanes.slice(1)) if (lane.lastUsed < selected.lastUsed) selected = lane;
    selected.lastUsed = ++order;
    const work = selected.tail.then(async () => {
      const wait = selected.nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      const startedAt = now();
      selected.nextAllowedAt = startedAt + intervalMs;
      return task();
    });
    selected.tail = work.then(() => undefined, () => undefined);
    return work;
  };
}

/**
 * Sibling-parity pacing (Capital-Group model): CONCURRENCY independent fund
 * workers, each with its OWN request lane. Only a lane's timer reservations are
 * queued, never network operations; a worker keeps its lane across funds,
 * retries, proxy fallbacks and providers. Requests issued outside any worker
 * (catalog discovery, SEC ticker tables) use the shared discovery gate.
 */
export function createRequestGate(delayMs: number, clock: PaceClock = {}): RequestGate {
  return createPacedGate(1, Math.max(0, delayMs), clock);
}
const requestLane = new AsyncLocalStorage<RequestGate>();
export function withRequestLane<T>(delayMs: number, work: () => Promise<T>, clock: PaceClock = {}): Promise<T> {
  return requestLane.run(createRequestGate(delayMs, clock), work);
}
export function currentRequestLane(): RequestGate | undefined {
  return requestLane.getStore();
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly provider: string;
  readonly responseText: string;

  constructor(provider: string, url: string, status: number, statusText: string, responseText: string) {
    const detail = cleanText(responseText).slice(0, 180);
    super(`${provider} HTTP ${status}${statusText ? ` ${cleanText(statusText)}` : ''} for ${url}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.url = url;
    this.provider = provider;
    this.responseText = responseText;
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(response: Response | null, retryIndex: number, now: () => number): number {
  const backoff = Math.min(30_000, 500 * (2 ** retryIndex));
  const raw = response?.headers.get('retry-after')?.trim() ?? '';
  if (!raw) return backoff;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(backoff, Math.min(120_000, seconds * 1000));
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(backoff, Math.min(120_000, timestamp - now())) : backoff;
}

export type ProviderResponse = { text: string; headers: Headers; url: string };

async function requestTextWithRetry(
  url: string,
  provider: string,
  gate: RequestGate,
  headers: HeadersInit,
  config: UpdaterConfig,
  runtime: RequestRuntime,
): Promise<ProviderResponse> {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const sleep = runtime.sleep ?? defaultSleep;
  const now = runtime.now ?? Date.now;
  const timeoutMs = runtime.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    let response: Response;
    let responseText: string;
    try {
      // The timeout clock starts when the request actually starts, i.e. inside
      // the gate: queued requests must not expire while waiting for their slot.
      response = await gate(() => fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) }));
      responseText = await response.text();
    } catch (error) {
      const detail = cleanText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      if (attempt >= config.maxRetries) {
        throw new Error(`${provider} request failed for ${url} after ${attempt + 1} attempt(s): ${detail}`);
      }
      const wait = Math.min(30_000, 500 * (2 ** attempt));
      const message = `[ ${'retry'.padEnd(9)}] ${provider} network error (${detail.slice(0, 120)}) for ${url}; retry ${attempt + 1}/${config.maxRetries} in ${wait}ms`;
      (runtime.onRetry ?? outputNote)(message);
      await sleep(wait);
      continue;
    }
    if (response.ok) return { text: responseText, headers: response.headers, url };
    const failure = new ProviderHttpError(provider, url, response.status, response.statusText, responseText);
    if (!retryableStatus(response.status) || attempt >= config.maxRetries) throw failure;
    const wait = retryDelay(response, attempt, now);
    const message = `[ ${'retry'.padEnd(9)}] ${provider} HTTP ${response.status} for ${url}; retry ${attempt + 1}/${config.maxRetries} in ${wait}ms`;
    (runtime.onRetry ?? outputNote)(message);
    await sleep(wait);
  }
  throw new Error(`${provider} request loop ended unexpectedly for ${url}`);
}

export function jinaReaderUrl(urlValue: string): string {
  const url = new URL(urlValue);
  return `https://r.jina.ai/${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

export function unwrapJinaReaderText(value: string): string {
  let text = String(value ?? '');
  const marker = /(?:^|\n)Markdown Content:\s*/i.exec(text);
  if (marker && marker.index !== undefined) text = text.slice(marker.index + marker[0].length);
  text = text.trim();
  const fenced = /^```(?:json|html|xml|text)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

export function parseProviderJson(text: string): unknown {
  const body = unwrapJinaReaderText(text);
  try { return JSON.parse(body) as unknown; }
  catch (firstError) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
    if (fenced) {
      try { return JSON.parse(fenced[1]) as unknown; }
      catch { /* Report the original response body below. */ }
    }
    const detail = firstError instanceof Error ? firstError.message : String(firstError);
    throw new Error(`provider response was not valid JSON: ${detail}`);
  }
}

export type RequestClients = {
  ark: (url: string) => Promise<ProviderResponse>;
  azure: (url: string) => Promise<ProviderResponse>;
  yahoo: (url: string) => Promise<ProviderResponse>;
  sec: (url: string) => Promise<ProviderResponse>;
  isArkProxyActive: () => boolean;
};

/**
 * Provider clients. Every request is paced on the calling worker's own lane
 * (see withRequestLane); with no lane it falls back to one discovery gate.
 * Issuer traffic goes direct with a browser User-Agent; after repeated 403s it
 * switches to the read-only r.jina.ai proxy, whose keyless per-IP limit is
 * enforced by one extra process-wide gate on top of the worker lane.
 */
export function createRequestClients(config: UpdaterConfig, runtime: RequestRuntime = {}): RequestClients {
  const intervalMs = config.requestSleepSeconds * 1000;
  const paceClock: PaceClock = { now: runtime.now, sleep: runtime.sleep };
  const discoveryGate = createRequestGate(intervalMs, paceClock);
  const jinaApiKey = cleanText(config.jinaApiKey);
  // Keyless r.jina.ai is limited per IP (~20/min): one process-wide gate on top
  // of the worker lanes. With an API key the documented limit is 500/min, so
  // only the per-worker REQUEST_SLEEP pacing applies.
  const proxyLimitGate = jinaApiKey ? null : createRequestGate(ISSUER_PROXY_MIN_INTERVAL_MS, paceClock);
  const laneGate: RequestGate = (task) => (currentRequestLane() ?? discoveryGate)(task);
  const proxyGate: RequestGate = (task) => laneGate(() => (proxyLimitGate ? proxyLimitGate(task) : task()));
  const arkHeaders = {
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    'User-Agent': ISSUER_USER_AGENT,
    Referer: `${ARK_SITE}/our-etfs/`,
  };
  let consecutiveArkDenials = 0;
  let arkProxyActive = false;

  const request = (
    url: string,
    provider: string,
    gate: RequestGate,
    headers: HeadersInit,
  ): Promise<ProviderResponse> => requestTextWithRetry(url, provider, gate, headers, config, runtime);

  const arkProxy = async (url: string): Promise<ProviderResponse> => {
    const responseFormat = new URL(url).pathname.startsWith('/api/') ? 'text' : 'html';
    const response = await request(jinaReaderUrl(url), 'ARK proxy', proxyGate, {
      ...arkHeaders,
      'X-Respond-With': responseFormat,
      ...(jinaApiKey ? { Authorization: `Bearer ${jinaApiKey}` } : {}),
    });
    return { ...response, text: unwrapJinaReaderText(response.text) };
  };

  const ark = async (url: string): Promise<ProviderResponse> => {
    if (arkProxyActive) return arkProxy(url);
    try {
      const response = await request(url, 'ARK issuer', laneGate, arkHeaders);
      consecutiveArkDenials = 0;
      return response;
    } catch (error) {
      if (!(error instanceof ProviderHttpError) || error.status !== 403) throw error;
      consecutiveArkDenials += 1;
      if (consecutiveArkDenials < ISSUER_DIRECT_DENIAL_LIMIT && !arkProxyActive) throw error;
      const firstSwitch = !arkProxyActive;
      arkProxyActive = true;
      if (firstSwitch) {
        const pacing = jinaApiKey
          ? 'authenticated (JINA_API_KEY set), paced per worker by REQUEST_SLEEP'
          : `keyless (about 20 requests per minute; set JINA_API_KEY for parallel issuer fetches)`;
        const notice = `[ ${'issuer'.padEnd(9)}] ARK direct requests returned ${consecutiveArkDenials} consecutive HTTP 403 responses; using the read-only r.jina.ai proxy for remaining issuer requests — ${pacing}.`;
        (runtime.onIssuerProxy ?? ((message: string) => console.warn(message)))(notice);
      }
      return arkProxy(url);
    }
  };

  const azure = (url: string): Promise<ProviderResponse> => request(url, 'ARK holdings', laneGate, {
    Accept: 'text/csv,application/octet-stream;q=0.9,*/*;q=0.8',
    'User-Agent': ISSUER_USER_AGENT,
  });
  const yahoo = (url: string): Promise<ProviderResponse> => request(url, 'Yahoo Finance', laneGate, {
    Accept: 'application/json,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (compatible; DaggerOk-ARK-ETF-Updater/1.0)',
  });
  const sec = (url: string): Promise<ProviderResponse> => request(url, 'SEC EDGAR', laneGate, {
    Accept: 'application/json,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    'User-Agent': config.secUa,
  });

  return { ark, azure, yahoo, sec, isArkProxyActive: () => arkProxyActive };
}

export function arkApiUrls(pageId: string): { overview: string; history: string; monthEnd: string; quarterEnd: string } {
  const id = encodeURIComponent(cleanText(pageId));
  const history = new URL(`/api/fund/nav-historical-change/${id}`, ARK_SITE);
  history.searchParams.set('headingText', 'NAV Historical Change');
  history.searchParams.set('overviewText', 'NAV and Market Price');
  const performanceUrl = (range: 'month-end' | 'quarter-end'): string => {
    const url = new URL(`/api/fund/performance/${id}`, ARK_SITE);
    url.searchParams.set('Range', range);
    url.searchParams.set('Tab', 'tab-annualized');
    url.searchParams.set('ExcludeMarketPrice', 'False');
    url.searchParams.set('DisplayReturnCharge', 'False');
    return url.toString();
  };
  return {
    overview: new URL(`/api/fund/overview/${id}`, ARK_SITE).toString(),
    history: history.toString(),
    monthEnd: performanceUrl('month-end'),
    quarterEnd: performanceUrl('quarter-end'),
  };
}

// ---------------------------------------------------------------------------
// Previous-data retention and SEC N-PORT fallback
// ---------------------------------------------------------------------------

export type SecHoldingResult = { parsed: ParsedNport; accessions: NportAccession[]; selected: NportAccession; holdings: HoldingRow[] };
export type SecFallbackResolver = (fund: ArkFund) => Promise<SecHoldingResult | null>;

export function createSecFallbackResolver(clients: RequestClients): SecFallbackResolver {
  let fundTickersPromise: Promise<Map<string, SecSeriesRef>> | null = null;
  let companyTickersPromise: Promise<Map<string, string>> | null = null;
  const submissionsPromises = new Map<string, Promise<unknown>>();

  const fundTickers = (): Promise<Map<string, SecSeriesRef>> => {
    if (!fundTickersPromise) {
      fundTickersPromise = clients.sec(SEC_FUND_TICKERS_URL)
        .then((response) => parseFundTickerMap(parseProviderJson(response.text)));
    }
    return fundTickersPromise;
  };
  const companyTickers = (): Promise<Map<string, string>> => {
    if (!companyTickersPromise) {
      companyTickersPromise = clients.sec(SEC_COMPANY_TICKERS_URL)
        .then((response) => parseCompanyTickerMap(parseProviderJson(response.text)));
    }
    return companyTickersPromise;
  };
  const submissions = (cik: string): Promise<unknown> => {
    const paddedCik = cik.replace(/\D/g, '').padStart(10, '0');
    const cached = submissionsPromises.get(paddedCik);
    if (cached) return cached;
    const work = clients.sec(`${SEC_DATA_HOST}/submissions/CIK${paddedCik}.json`)
      .then((response) => parseProviderJson(response.text));
    submissionsPromises.set(paddedCik, work);
    return work;
  };

  return async (fund: ArkFund): Promise<SecHoldingResult | null> => {
    const mapping = await fundTickers();
    const series = mapping.get(fund.ticker);
    if (series && series.cik !== fund.trustCik) {
      outputNote(`[ ${'edgar'.padEnd(9)}] ${fund.ticker} SEC ticker map CIK ${series.cik} did not match expected trust ${fund.trustCik}; ignoring the mapping.`);
    }
    const seriesId = series?.cik === fund.trustCik ? series.seriesId : '';
    let accessions: NportAccession[] = [];
    if (seriesId) {
      try {
        const response = await clients.sec(edgarSeriesFilingsUrl(seriesId, 10));
        accessions = parseEdgarAtomFilings(response.text);
      } catch (error) {
        outputNote(`[ ${'edgar'.padEnd(9)}] ${fund.ticker} series filing lookup failed: ${error instanceof Error ? error.message : cleanText(error)}`);
      }
    }
    if (!accessions.length) {
      const recent = await submissions(fund.trustCik);
      accessions = parseNportAccessions(recent);
    }
    const names = [normalizeHoldingName(fund.name), normalizeHoldingName(fund.ticker)];
    for (const accession of accessions.slice(0, 10)) {
      const response = await clients.sec(accession.url);
      const parsed = parseNportXml(response.text);
      if (parsed.regCik && parsed.regCik !== fund.trustCik) continue;
      if (seriesId && parsed.seriesId && parsed.seriesId !== seriesId) continue;
      const seriesName = normalizeHoldingName(parsed.seriesName);
      if (!seriesId && seriesName && !names.some((name) => name && (seriesName === name || seriesName.includes(name)))) continue;
      if (!parsed.positions.length) continue;
      let tickers = new Map<string, string>();
      if (parsed.positions.some((position) => !position.ticker)) {
        try { tickers = await companyTickers(); }
        catch (error) { outputNote(`[ ${'edgar'.padEnd(9)}] SEC company ticker map unavailable: ${error instanceof Error ? error.message : cleanText(error)}`); }
      }
      return { parsed, accessions, selected: accession, holdings: nportToHoldings(parsed, tickers) };
    }
    return null;
  };
}

type StoredSheet = { headers: string[]; rows: JsonRecord[]; asOfDate: string; source: string };
type SheetKind = 'holdings' | 'history';

function stringArray(value: unknown): string[] {
  return arrayValue(value).map((item) => cleanText(item)).filter(Boolean);
}

async function readJsonRecord(file: string): Promise<JsonRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Object.keys(record(parsed)).length ? record(parsed) : null;
  } catch { return null; }
}

async function readStoredSheet(root: string, ticker: string, kind: SheetKind, manifestValue: unknown): Promise<StoredSheet> {
  const manifest = record(manifestValue);
  let headers = stringArray(manifest.headers);
  const rows: JsonRecord[] = [];
  const fundDirectory = path.join(root, 'funds', ticker);
  for (const rawPage of arrayValue(manifest.pages)) {
    const pageName = cleanText(rawPage).replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = pageName.split('/').filter(Boolean);
    if (!parts.length || parts.includes('..')) continue;
    const relativeParts = parts[0] === kind ? parts : [kind, ...parts];
    const file = path.join(fundDirectory, ...relativeParts);
    const page = await readJsonRecord(file);
    if (!page) continue;
    const pageHeaders = stringArray(page.headers);
    if (!headers.length && pageHeaders.length) headers = pageHeaders;
    const pageRows = arrayValue(page.rows);
    for (const rawRow of pageRows) {
      if (Array.isArray(rawRow)) {
        const values = rawRow as unknown[];
        rows.push(Object.fromEntries(headers.map((header, index) => [header, cleanText(values[index])] )));
      } else {
        const row = record(rawRow);
        rows.push(Object.fromEntries(headers.map((header) => [header, cleanText(row[header])] )));
      }
    }
  }
  return {
    headers,
    rows,
    asOfDate: cleanText(manifest.asOfDate),
    source: cleanText(manifest.source),
  };
}

function readDistributionWorksheet(meta: JsonRecord): JsonRecord {
  const distribution = record(meta.distributions);
  return {
    frequency: cleanText(distribution.frequency) || '—',
    exDate: cleanText(distribution.exDate) || '—',
    dividend: cleanText(distribution.dividend) || '—',
    headers: stringArray(distribution.headers).length ? stringArray(distribution.headers) : ['Ex-Date', 'Amount'],
    rows: arrayValue(distribution.rows).filter(Array.isArray).map((row) => (row as unknown[]).map((cell) => cleanText(cell))),
    source: cleanText(distribution.source),
  };
}

function numberField(source: JsonRecord, key: string): number | null {
  return numberOrNull(source[key]);
}

function stringField(source: JsonRecord, key: string, fallback = ''): string {
  const value = cleanText(source[key]);
  return value || fallback;
}

function formatPrice(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : `$${value.toFixed(digits)}`;
}

function dateAgeDays(value: string, referenceDate: Date): number | null {
  const iso = toIsoDate(value);
  if (!iso) return null;
  const sourceDay = Date.parse(`${iso}T00:00:00Z`);
  const referenceDay = Date.parse(`${referenceDate.toISOString().slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(sourceDay) && Number.isFinite(referenceDay) ? Math.floor((referenceDay - sourceDay) / 86_400_000) : null;
}

function hasNumericReturn(value: unknown): boolean {
  return Object.values(record(value)).some((item) => typeof item === 'number' && Number.isFinite(item));
}

function officialReturnsPresent(month: ArkPerformance | null, quarter: ArkPerformance | null): boolean {
  if (!month && !quarter) return false;
  return Boolean(month && (hasNumericReturn(month.navAnnualized) || hasNumericReturn(month.navCumulative))) ||
    Boolean(quarter && (hasNumericReturn(quarter.navAnnualized) || hasNumericReturn(quarter.navCumulative)));
}

function buildHistoryRows(points: ArkDailyPoint[]): JsonRecord[] {
  return points.map((point) => ({
    Date: displayDate(point.date),
    NAV: point.nav === null ? '' : point.nav.toFixed(2),
    'Market Price': point.marketPrice === null ? '' : point.marketPrice.toFixed(2),
    'Premium/Discount': point.premiumDiscount === null ? '' : `${point.premiumDiscount.toFixed(4)}%`,
  }));
}

function buildYahooHistoryRows(chart: YahooChart): JsonRecord[] {
  return chart.points.map((point) => ({
    Date: displayDate(point.date),
    Close: point.close === null ? '' : point.close.toFixed(2),
    'Adj Close': point.adjClose === null ? '' : point.adjClose.toFixed(2),
    Volume: point.volume === null ? '' : String(point.volume),
  }));
}

function distributionData(
  chart: YahooChart | null,
  previous: JsonRecord,
  referenceDate: Date,
  price: number | null,
): { worksheet: JsonRecord; indicatedYield: number | null; yieldKind: string } {
  const previousWorksheet = readDistributionWorksheet(previous);
  if (!chart) {
    return {
      worksheet: previousWorksheet,
      indicatedYield: numberField(record(previous.metrics), 'dividendYield'),
      yieldKind: stringField(record(previous.yields), 'dividendYieldKind', 'previously published distribution data'),
    };
  }
  if (!chart.dividends.length) {
    const worksheet = previousWorksheet.rows.length ? previousWorksheet : {
      frequency: '—', exDate: '—', dividend: '—', headers: ['Ex-Date', 'Amount'], rows: [],
      source: 'Yahoo Finance chart response contained no distribution events',
    };
    return {
      worksheet,
      indicatedYield: numberField(record(previous.metrics), 'dividendYield'),
      yieldKind: stringField(record(previous.yields), 'dividendYieldKind', 'not available from Yahoo Finance'),
    };
  }
  const eligible = chart.dividends.filter((event) => event.date <= referenceDate.toISOString().slice(0, 10));
  const sorted = [...eligible].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return { worksheet: previousWorksheet, indicatedYield: numberField(record(previous.metrics), 'dividendYield'), yieldKind: 'previously published distribution data' };
  const latest = sorted[sorted.length - 1];
  const frequency = inferDistributionFrequency(sorted.map((event) => event.date), referenceDate) ?? 'Unknown';
  const payments = paymentsPerYear(frequency);
  const annualized = payments !== null && price !== null && price > 0 ? round((latest.amount * payments / price) * 100, 2) : null;
  const trailing = annualized === null ? trailingDividendYield(sorted, price, referenceDate.toISOString().slice(0, 10)) : null;
  const indicatedYield = annualized ?? trailing;
  const yieldKind = annualized !== null
    ? `indicated: Yahoo Finance latest distribution x inferred ${frequency.toLowerCase()} frequency / market price`
    : trailing !== null ? 'Yahoo Finance trailing 12-month distributions / market price' : 'not available from Yahoo Finance';
  const worksheet: JsonRecord = {
    frequency,
    exDate: displayDate(latest.date),
    dividend: formatPrice(latest.amount, 4),
    headers: ['Ex-Date', 'Amount'],
    rows: sorted.slice(-12).reverse().map((event) => [displayDate(event.date), formatPrice(event.amount, 4)]),
    source: 'Yahoo Finance chart dividend events (ARK does not publish a dividend-history API endpoint)',
  };
  return { worksheet, indicatedYield, yieldKind };
}

async function persistSheet(
  root: string,
  ticker: string,
  kind: SheetKind,
  headers: readonly string[],
  rows: JsonRecord[],
  pageSize: number,
  asOfDate: string,
  source: string,
): Promise<JsonRecord> {
  const directory = path.join(root, 'funds', ticker, kind);
  const pageGroups = splitPages(rows, pageSize);
  const pages: string[] = [];
  for (let index = 0; index < pageGroups.length; index += 1) {
    const pageNumber = index + 1;
    const name = pageFileName(pageNumber);
    const envelope = buildPageEnvelope(ticker, pageNumber, pageSize, rows.length, headers, pageGroups[index]);
    await writeJsonIfChanged(path.join(directory, name), envelope);
    pages.push(`${kind}/${name}`);
  }
  await prunePages(directory, pageGroups.length);
  return { pages, pageSize, totalRows: rows.length, headers: [...headers], asOfDate: asOfDate ? displayDate(asOfDate) : '—', source };
}

// ---------------------------------------------------------------------------
// Source fetch and per-fund build
// ---------------------------------------------------------------------------

export type ArkFundUpdateResult = {
  entry: JsonRecord;
  status?: string;
  reason?: string;
  holdingsCount: number;
  historyCount: number;
  distributionCount: number;
  netAssets: number | null;
  dividendYield: number | null;
  secYield: number | null;
};

export type ArkFundUpdateOptions = {
  apiRoot?: string;
  referenceDate?: Date;
  secFallback?: SecFallbackResolver;
  onNote?: (message: string) => void;
};

type OfficialFundData = {
  pageId: string | null;
  overview: ArkOverview | null;
  history: ArkDailyPoint[];
  monthEnd: ArkPerformance | null;
  quarterEnd: ArkPerformance | null;
  urls: ReturnType<typeof arkApiUrls> | null;
};

function noteSourceFailure(onNote: (message: string) => void, source: string, ticker: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : cleanText(error);
  onNote(`[ ${source.padEnd(9)}] ${ticker} ${detail}`);
}

async function fetchOfficialFundData(
  fund: ArkFund,
  config: UpdaterConfig,
  clients: RequestClients,
  onNote: (message: string) => void,
  knownPageId: string | null = null,
): Promise<OfficialFundData> {
  const empty: OfficialFundData = { pageId: null, overview: null, history: [], monthEnd: null, quarterEnd: null, urls: null };
  if (config.skipArk) return empty;
  const requestJson = async (url: string, label: string): Promise<unknown | null> => {
    try { return parseProviderJson((await clients.ark(url)).text); }
    catch (error) { noteSourceFailure(onNote, label, fund.ticker, error); return null; }
  };
  const parseOverview = (payload: unknown | null): ArkOverview | null => {
    if (payload === null) return null;
    try {
      const parsed = parseArkOverview(payload);
      if (parsed.ticker && parsed.ticker !== fund.ticker) throw new Error(`overview ticker ${parsed.ticker} did not match request`);
      return parsed;
    } catch (error) { noteSourceFailure(onNote, 'overview', fund.ticker, error); return null; }
  };
  // Page IDs are derived from the fund page at runtime, never from a static
  // map. A previously published ID is reused only when the overview endpoint
  // confirms it still answers for this ticker; otherwise the page is re-read.
  let pageId: string | null = null;
  let overview: ArkOverview | null = null;
  const reusableId = cleanText(knownPageId);
  if (reusableId) {
    const candidate = parseOverview(await requestJson(arkApiUrls(reusableId).overview, 'overview'));
    if (candidate?.ticker === fund.ticker) { pageId = reusableId; overview = candidate; }
  }
  if (!pageId) {
    try {
      const page = await clients.ark(fund.fundPage);
      pageId = extractFundPageId(page.text);
      if (!pageId) throw new Error('official fund page did not expose /api/fund/overview/<id>');
    } catch (error) {
      noteSourceFailure(onNote, 'issuer', fund.ticker, error);
      return empty;
    }
  }
  const urls = arkApiUrls(pageId);
  const [overviewPayload, historyPayload, monthPayload, quarterPayload] = await Promise.all([
    overview ? Promise.resolve(null) : requestJson(urls.overview, 'overview'),
    requestJson(urls.history, 'history'),
    requestJson(urls.monthEnd, 'performance'),
    requestJson(urls.quarterEnd, 'performance'),
  ]);
  if (!overview) overview = parseOverview(overviewPayload);
  let history: ArkDailyPoint[] = [];
  if (historyPayload !== null) {
    try { history = parseArkNavHistory(historyPayload); }
    catch (error) { noteSourceFailure(onNote, 'history', fund.ticker, error); }
  }
  const parsePerformance = (payload: unknown | null, label: string): ArkPerformance | null => {
    if (payload === null) return null;
    try {
      const parsed = parseArkPerformance(payload);
      if (parsed.ticker && parsed.ticker !== fund.ticker) throw new Error(`performance ticker ${parsed.ticker} did not match request`);
      return parsed;
    } catch (error) { noteSourceFailure(onNote, label, fund.ticker, error); return null; }
  };
  return {
    pageId,
    overview,
    history,
    monthEnd: parsePerformance(monthPayload, 'performance'),
    quarterEnd: parsePerformance(quarterPayload, 'performance'),
    urls,
  };
}

async function fetchYahooFundData(
  fund: ArkFund,
  config: UpdaterConfig,
  clients: RequestClients,
  referenceDate: Date,
  onNote: (message: string) => void,
): Promise<YahooChart | null> {
  if (config.skipYahoo) return null;
  try {
    const url = yahooChartUrl(fund.ticker, Math.floor(referenceDate.getTime() / 1000));
    const response = await clients.yahoo(url);
    const chart = parseYahooChart(parseProviderJson(response.text));
    if (!chart.points.length) throw new Error('chart returned no daily price points');
    return chart;
  } catch (error) {
    noteSourceFailure(onNote, 'chart', fund.ticker, error);
    return null;
  }
}

function holdingRowsFromStored(rows: JsonRecord[], headers: readonly string[]): HoldingRow[] {
  return rows.map((row) => {
    const next: HoldingRow = {};
    for (const header of headers) next[header] = cleanText(row[header]);
    return next;
  });
}

function mergeNonNull(primary: JsonRecord, secondary: JsonRecord): JsonRecord {
  const result: JsonRecord = { ...secondary };
  for (const [key, value] of Object.entries(primary)) {
    if (value !== null && value !== undefined && value !== '') result[key] = value;
  }
  return result;
}

function hasFundData(
  freshHoldings: boolean,
  official: OfficialFundData,
  yahoo: YahooChart | null,
  previousMeta: JsonRecord | null,
  previousEntry: JsonRecord,
): boolean {
  const priorMetrics = mergeNonNull(record(previousMeta?.metrics), record(previousEntry.metrics));
  const priorReturns = record(previousEntry.returns).monthEnd ? record(previousEntry.returns) : record(previousMeta?.returns);
  const priorHoldings = Math.max(numberField(record(previousMeta?.holdings), 'totalRows') ?? 0, numberField(previousEntry, 'holdings') ?? 0);
  const priorHistory = Math.max(numberField(record(previousMeta?.history), 'totalRows') ?? 0, numberField(previousEntry, 'history') ?? 0);
  const priorFinancialFacts = [
    numberField(previousMeta ?? {}, 'aumValue'), numberField(previousEntry, 'aumValue'),
    numberField(previousMeta ?? {}, 'terValue'), numberField(previousEntry, 'terValue'),
    numberField(previousMeta ?? {}, 'navValue'), numberField(previousEntry, 'navValue'),
    numberField(priorMetrics, 'tr1y'), numberField(priorMetrics, 'cagr3y'), numberField(priorMetrics, 'dividendYield'),
    numberField(record(priorReturns.monthEnd), 'ytd'), numberField(record(priorReturns.monthEnd), 'yr1'),
  ].some((value) => value !== null);
  return freshHoldings || Boolean(official.overview || official.history.length || officialReturnsPresent(official.monthEnd, official.quarterEnd)) ||
    Boolean(yahoo?.points.length) || priorHoldings > 0 || priorHistory > 0 || priorFinancialFacts;
}

export async function updateArkFund(
  fund: ArkFund,
  config: UpdaterConfig,
  clients: RequestClients,
  options: ArkFundUpdateOptions = {},
): Promise<ArkFundUpdateResult> {
  const apiRoot = options.apiRoot ?? API_ROOT;
  const referenceDate = options.referenceDate ?? new Date();
  const onNote = options.onNote ?? outputNote;
  const fundDirectory = path.join(apiRoot, 'funds', fund.ticker);
  const previousIndex = await readJsonRecord(path.join(apiRoot, 'index.json'));
  const previousEntry = arrayValue(previousIndex?.funds).map(record).find((entry) => entry.ticker === fund.ticker) ?? {};
  const previousMeta = await readJsonRecord(path.join(fundDirectory, 'meta.json'));
  const previousSource = record(previousMeta?.source);
  const previousHoldings = await readStoredSheet(apiRoot, fund.ticker, 'holdings', previousMeta?.holdings);
  const previousHistory = await readStoredSheet(apiRoot, fund.ticker, 'history', previousMeta?.history);
  const previousCombined: JsonRecord = { ...previousEntry, ...(previousMeta ?? {}) };
  const secFallback = options.secFallback ?? createSecFallbackResolver(clients);

  const [official, yahoo, csvResult] = await Promise.all([
    fetchOfficialFundData(fund, config, clients, onNote, stringField(previousSource, 'pageId') || null),
    fetchYahooFundData(fund, config, clients, referenceDate, onNote),
    (async (): Promise<ParsedHoldings | null> => {
      if (config.skipArk) return null;
      try {
        const response = await clients.azure(fund.holdingsCsv);
        return parseArkHoldingsCsv(response.text, fund.ticker, response.headers.get('last-modified') ?? '');
      } catch (error) { noteSourceFailure(onNote, 'holdings', fund.ticker, error); return null; }
    })(),
  ]);

  let holdingsRows: HoldingRow[] = [];
  let holdingsHeaders: readonly string[] = [];
  let holdingsAsOfDate = '';
  let holdingsSource = '';
  let edgarFiling: NportAccession | null = null;
  let nportDoc: string | null = null;
  if (csvResult) {
    holdingsRows = csvResult.rows;
    holdingsHeaders = csvResult.headers;
    holdingsAsOfDate = csvResult.asOfDate;
    holdingsSource = csvResult.sourceKind;
  } else if (config.edgarFallback) {
    try {
      const fallback = await secFallback(fund);
      if (fallback) {
        holdingsRows = fallback.holdings;
        holdingsHeaders = HOLDINGS_HEADERS;
        holdingsAsOfDate = fallback.parsed.repPdDate || fallback.selected.reportDate;
        holdingsSource = 'SEC EDGAR Form N-PORT-P fallback';
        edgarFiling = fallback.selected;
        nportDoc = fallback.selected.url;
        onNote(`[ ${'edgar'.padEnd(9)}] ${fund.ticker} using N-PORT-P ${fallback.selected.accession} (${holdingsRows.length} positions)`);
      }
    } catch (error) { noteSourceFailure(onNote, 'edgar', fund.ticker, error); }
  }
  if (!holdingsRows.length && previousHoldings.rows.length) {
    holdingsHeaders = previousHoldings.headers.length ? previousHoldings.headers : (fund.ticker === 'ARKY' ? ARKY_HOLDINGS_HEADERS : HOLDINGS_HEADERS);
    holdingsRows = holdingRowsFromStored(previousHoldings.rows, holdingsHeaders);
    holdingsAsOfDate = toIsoDate(previousHoldings.asOfDate) || stringField(record(previousMeta?.holdings), 'asOfDate');
    holdingsSource = stringField(record(previousMeta?.holdings), 'source', stringField(previousSource, 'holdingsSource', 'previously published holdings (retained)'));
    nportDoc = stringField(previousSource, 'nportDoc') || null;
    onNote(`[ ${'holdings'.padEnd(9)}] ${fund.ticker} retaining ${holdingsRows.length} previously published holdings rows`);
  }
  if (!holdingsHeaders.length) holdingsHeaders = fund.ticker === 'ARKY' ? ARKY_HOLDINGS_HEADERS : HOLDINGS_HEADERS;
  if (!holdingsAsOfDate) holdingsAsOfDate = toIsoDate(record(previousMeta?.holdings).asOfDate);

  const yahooPoints = yahoo?.points ?? [];
  let historyRows: JsonRecord[] = [];
  let historyHeaders: readonly string[] = [];
  let historyAsOfDate = '';
  let historySource = '';
  if (official.history.length) {
    historyRows = buildHistoryRows(official.history);
    historyHeaders = HISTORY_HEADERS;
    historyAsOfDate = official.history[official.history.length - 1].date;
    historySource = 'official ARK Invest daily NAV and market-price history API';
  } else if (yahoo && yahooPoints.length) {
    historyRows = buildYahooHistoryRows(yahoo);
    historyHeaders = YAHOO_HISTORY_HEADERS;
    historyAsOfDate = yahooPoints[yahooPoints.length - 1].date;
    historySource = 'Yahoo Finance daily adjusted-close fallback';
  } else if (previousHistory.rows.length) {
    historyHeaders = previousHistory.headers;
    historyRows = previousHistory.rows;
    historyAsOfDate = toIsoDate(previousHistory.asOfDate) || stringField(record(previousMeta?.history), 'asOfDate');
    historySource = stringField(record(previousMeta?.history), 'source', stringField(previousSource, 'historySource', 'previously published history (retained)'));
    onNote(`[ ${'history'.padEnd(9)}] ${fund.ticker} retaining ${historyRows.length} previously published history rows`);
  }
  if (!historyHeaders.length) historyHeaders = config.skipYahoo ? HISTORY_HEADERS : YAHOO_HISTORY_HEADERS;

  if (!hasFundData(Boolean(csvResult) || Boolean(edgarFiling) || holdingsRows.length > 0, official, yahoo, previousMeta, previousEntry)) {
    return {
      entry: previousEntry,
      status: 'failed',
      reason: 'no provider returned usable data and no previously published fund data exists',
      holdingsCount: 0,
      historyCount: 0,
      distributionCount: 0,
      netAssets: null,
      dividendYield: null,
      secYield: null,
    };
  }

  const previousMetrics = mergeNonNull(record(previousMeta?.metrics), record(previousEntry.metrics));
  const previousReturns = record(previousEntry.returns).monthEnd || previousMeta?.returns
    ? record(previousEntry.returns).monthEnd ? record(previousEntry.returns) : record(previousMeta?.returns)
    : {};
  const yahooReturns = yahooPoints.length ? buildYahooReturns(yahooPoints, referenceDate) : { monthEnd: {}, quarterEnd: {}, metrics: {} };
  const publishedReturns = officialReturnsPresent(official.monthEnd, official.quarterEnd)
    ? buildOfficialReturns(official.monthEnd, official.quarterEnd)
    : { monthEnd: {}, quarterEnd: {}, metrics: {} };
  const returns: JsonRecord = {
    monthEnd: mergeNonNull(record(publishedReturns.monthEnd), mergeNonNull(record(yahooReturns.monthEnd), record(previousReturns.monthEnd))),
    quarterEnd: mergeNonNull(record(publishedReturns.quarterEnd), mergeNonNull(record(yahooReturns.quarterEnd), record(previousReturns.quarterEnd))),
  };
  const pricePoint = official.history.length ? official.history[official.history.length - 1] : null;
  const yahooPoint = yahooPoints.length ? yahooPoints[yahooPoints.length - 1] : null;
  const navValue = pricePoint?.nav ?? numberField(previousEntry, 'navValue') ?? numberField(record(previousMeta), 'navValue');
  const closePriceValue = pricePoint?.marketPrice ?? yahoo?.regularMarketPrice ?? yahooPoint?.close ?? numberField(previousEntry, 'closePriceValue') ?? numberField(record(previousMeta), 'closePriceValue');
  const premiumDiscountValue = pricePoint?.premiumDiscount ?? numberField(previousEntry, 'premiumDiscountValue') ?? numberField(record(previousMeta), 'premiumDiscountValue');
  const distributions = distributionData(yahoo, previousCombined, referenceDate, closePriceValue);
  const overview = official.overview;
  const aumValue = overview?.netAssets ?? numberField(previousEntry, 'aumValue') ?? numberField(record(previousMeta), 'aumValue');
  const terValue = overview?.expenseRatio ?? numberField(previousEntry, 'terValue') ?? numberField(record(previousMeta), 'terValue');
  const secYield = overview?.secYield ?? numberField(previousMetrics, 'secYield');
  const returnMetrics = mergeNonNull(
    record(publishedReturns.metrics),
    mergeNonNull(record(yahooReturns.metrics), previousMetrics),
  );
  const metrics: JsonRecord = {
    ...returnMetrics,
    dividendYield: distributions.indicatedYield,
    dividendYieldText: distributions.indicatedYield === null ? null : formatPercent(distributions.indicatedYield),
    secYield,
    secYieldText: secYield === null ? null : formatPercent(secYield),
  };
  const asOfIso = historyAsOfDate || official.history[official.history.length - 1]?.date || overview?.asOfDate || toIsoDate(previousEntry.asOfDate);
  const asOfDate = asOfIso ? displayDate(asOfIso) : stringField(previousEntry, 'asOfDate', '—');
  const ter = terValue === null ? stringField(previousEntry, 'ter', stringField(record(previousMeta), 'ter', '—')) : formatPercent(terValue);
  const aum = overview?.netAssetsText || stringField(previousEntry, 'aum', stringField(record(previousMeta), 'aum', formatMoney(aumValue)));
  const nav = navValue === null ? stringField(previousEntry, 'nav', '—') : formatPrice(navValue);
  const closePrice = closePriceValue === null ? stringField(previousEntry, 'closePrice', stringField(record(previousMeta), 'closePrice', '—')) : formatPrice(closePriceValue);
  const premiumDiscount = premiumDiscountValue === null ? stringField(previousEntry, 'premiumDiscount', stringField(record(previousMeta), 'premiumDiscount', '—')) : formatPercent(premiumDiscountValue, 4);
  const inceptionIso = overview?.inceptionDate || toIsoDate(previousEntry.inceptionDate) || toIsoDate(record(previousMeta).inceptionDate);
  const inceptionDate = inceptionIso ? displayDate(inceptionIso) : stringField(previousEntry, 'inceptionDate', stringField(record(previousMeta), 'inceptionDate', '—'));
  const exchange = overview?.exchange || stringField(previousEntry, 'exchange', stringField(record(previousMeta), 'exchange'));
  const cusip = overview?.cusip || stringField(record(previousMeta?.identifiers), 'cusip') || stringField(previousEntry, 'cusip') || null;
  const isin = overview?.isin || stringField(record(previousMeta?.identifiers), 'isin') || stringField(previousEntry, 'isin') || null;
  const category = categoryForType(overview?.fundType ?? '', fund.category);
  const distributionWorksheet = record(distributions.worksheet);
  const distributionRows = arrayValue(distributionWorksheet.rows).filter(Array.isArray);
  const manifestAsOfHoldings = holdingsAsOfDate || toIsoDate(stringField(record(previousMeta?.holdings), 'asOfDate'));
  const manifestAsOfHistory = historyAsOfDate || toIsoDate(stringField(record(previousMeta?.history), 'asOfDate'));
  const holdingsAgeDays = dateAgeDays(holdingsAsOfDate, referenceDate);
  if (csvResult && holdingsAgeDays !== null && holdingsAgeDays > 7) {
    onNote(`[ ${'holdings'.padEnd(9)}] ${fund.ticker} CSV snapshot is ${holdingsAgeDays} days old (as of ${holdingsAsOfDate}); the source date is preserved and HTTP 200 is not treated as evidence of freshness.`);
  }
  const sourceProvider = [
    overview ? 'ARK Invest official fund API' : '',
    csvResult ? 'ARK Invest Azure holdings CSV' : '',
    official.history.length ? 'ARK Invest official NAV history' : '',
    yahoo ? 'Yahoo Finance chart' : '',
    edgarFiling ? 'SEC EDGAR N-PORT-P fallback' : '',
  ].filter(Boolean).join(' + ') || stringField(previousSource, 'provider', 'previously published ARK data');
  const source: JsonRecord = {
    ...previousSource,
    provider: sourceProvider,
    trustCik: fund.trustCik,
    fundPage: fund.fundPage,
    pageId: official.pageId || stringField(previousSource, 'pageId') || null,
    catalogUrl: ARK_CATALOG_URL,
    holdingsCsv: fund.holdingsCsv,
    holdingsAsOfDate: holdingsAsOfDate || null,
    holdingsDateBasis: csvResult
      ? (fund.ticker === 'ARKY' ? 'Azure Last-Modified HTTP header (ARKY CSV omits a date column)' : 'official holdings CSV date column')
      : edgarFiling ? 'SEC N-PORT-P report period' : stringField(previousSource, 'holdingsDateBasis', 'previously published metadata'),
    holdingsSource: csvResult ? csvResult.sourceKind : holdingsSource || stringField(previousSource, 'holdingsSource', 'unavailable'),
    historySource: historySource || stringField(previousSource, 'historySource', 'unavailable'),
    distributionsSource: cleanText(distributionWorksheet.source) || stringField(previousSource, 'distributionsSource', 'not available'),
    overviewApi: official.urls?.overview || stringField(previousSource, 'overviewApi') || null,
    historyApi: official.urls?.history || stringField(previousSource, 'historyApi') || null,
    performanceApi: official.urls?.monthEnd || stringField(previousSource, 'performanceApi') || null,
    yahooChart: yahooChartProvenanceUrl(fund.ticker),
    edgarFiling: edgarFiling ?? record(previousSource.edgarFiling),
    nportDoc: nportDoc || stringField(previousSource, 'nportDoc') || null,
  };
  const distributionOutput: JsonRecord = {
    ...distributionWorksheet,
    source: cleanText(distributionWorksheet.source) || stringField(previousSource, 'distributionsSource', 'not available'),
  };
  const meta: JsonRecord = {
    ...(previousMeta ?? {}),
    ticker: fund.ticker,
    name: fund.name,
    category,
    fundPage: fund.fundPage,
    dataFile: `funds/${fund.ticker}/meta.json`,
    generatedAt: new Date().toISOString(),
    asOfDate,
    inceptionDate,
    exchange,
    nav,
    navValue,
    closePrice,
    closePriceValue,
    premiumDiscount,
    premiumDiscountValue,
    ter,
    terValue,
    aum,
    aumValue,
    identifiers: { ...record(previousMeta?.identifiers), cusip, isin, indexTicker: record(previousMeta?.identifiers).indexTicker ?? null },
    distributions: distributionOutput,
    returns,
    metrics,
    yields: {
      dividendYield: distributions.indicatedYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldKind: distributions.yieldKind,
      secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind: overview?.secYield === null || overview?.secYield === undefined
        ? stringField(record(previousMeta?.yields), 'secYieldKind', 'not published by ARK for this fund')
        : 'ARK Invest official fund-page 30-day SEC yield',
    },
    source,
    holdings: {
      pages: [], pageSize: config.holdingsPageSize, totalRows: holdingsRows.length,
      headers: [...holdingsHeaders], asOfDate: manifestAsOfHoldings ? displayDate(manifestAsOfHoldings) : '—',
      source: source.holdingsSource,
    },
    history: {
      pages: [], pageSize: config.historyPageSize, totalRows: historyRows.length,
      headers: [...historyHeaders], asOfDate: manifestAsOfHistory ? displayDate(manifestAsOfHistory) : '—',
      source: source.historySource,
    },
  };
  const publishedHoldingsCount = holdingsRows.length || previousHoldings.rows.length;
  const publishedHistoryCount = historyRows.length || previousHistory.rows.length;
  const candidateEntry: JsonRecord = {
    ...previousEntry,
    ticker: fund.ticker,
    name: fund.name,
    category,
    fundPage: fund.fundPage,
    dataFile: `funds/${fund.ticker}/meta.json`,
    ter,
    terValue,
    nav,
    navValue,
    aum,
    aumValue,
    asOfDate,
    inceptionDate,
    exchange,
    closePrice,
    closePriceValue,
    premiumDiscount,
    premiumDiscountValue,
    cusip,
    isin,
    distributions: {
      frequency: stringField(distributionWorksheet, 'frequency', '—'),
      exDate: stringField(distributionWorksheet, 'exDate', '—'),
      dividend: stringField(distributionWorksheet, 'dividend', '—'),
    },
    returns,
    metrics,
    holdings: publishedHoldingsCount,
    history: publishedHistoryCount,
  };
  if (!passesMetricFilters(candidateEntry, config)) {
    return {
      entry: previousEntry,
      status: 'filtered',
      reason: 'fresh fund metrics did not satisfy the configured ranges; previous publication retained',
      holdingsCount: publishedHoldingsCount,
      historyCount: publishedHistoryCount,
      distributionCount: distributionRows.length,
      netAssets: aumValue,
      dividendYield: distributions.indicatedYield,
      secYield,
    };
  }

  const holdingsManifest = await persistSheet(apiRoot, fund.ticker, 'holdings', holdingsHeaders, holdingsRows, config.holdingsPageSize, manifestAsOfHoldings, String(source.holdingsSource));
  const historyManifest = await persistSheet(apiRoot, fund.ticker, 'history', historyHeaders, historyRows, config.historyPageSize, manifestAsOfHistory, String(source.historySource));
  meta.holdings = holdingsManifest;
  meta.history = historyManifest;
  await writeJsonIfChanged(path.join(fundDirectory, 'meta.json'), meta);

  return {
    entry: candidateEntry,
    holdingsCount: publishedHoldingsCount,
    historyCount: publishedHistoryCount,
    distributionCount: distributionRows.length,
    netAssets: aumValue,
    dividendYield: distributions.indicatedYield,
    secYield,
  };
}

// ---------------------------------------------------------------------------
// Catalog, cursor, bounded worker pool, and CLI
// ---------------------------------------------------------------------------

export type RunUpdaterOptions = {
  config?: UpdaterConfig;
  env?: Record<string, string | undefined>;
  clients?: RequestClients;
  runtime?: RequestRuntime;
  apiRoot?: string;
  referenceDate?: Date;
  onNote?: (message: string) => void;
};

export type RunUpdaterReport = {
  selectedTickers: string[];
  processedTickers: string[];
  filteredTickers: string[];
  failedTickers: string[];
  nextCursor: number | null;
  indexPath: string;
};

function seedIndexEntry(fund: ArkFund): JsonRecord {
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: `funds/${fund.ticker}/meta.json`,
    ter: '—', terValue: null,
    nav: '—', navValue: null,
    aum: '—', aumValue: null,
    asOfDate: '—', inceptionDate: '—', exchange: '',
    closePrice: '—', closePriceValue: null,
    premiumDiscount: '—', premiumDiscountValue: null,
    cusip: null, isin: null,
    distributions: { frequency: '—', exDate: '—', dividend: '—' },
    returns: { monthEnd: {}, quarterEnd: {} },
    metrics: {
      ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null,
      cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null,
      dividendYield: null, dividendYieldText: null, secYield: null, secYieldText: null,
    },
    holdings: 0,
    history: 0,
  };
}

function mergeCatalogEntries(previous: JsonRecord | null): Map<string, JsonRecord> {
  const entries = new Map<string, JsonRecord>();
  for (const raw of arrayValue(previous?.funds)) {
    const entry = record(raw);
    const ticker = tickerOrBlank(entry.ticker);
    if (ticker) entries.set(ticker, entry);
  }
  for (const fund of ARK_FUNDS) if (!entries.has(fund.ticker)) entries.set(fund.ticker, seedIndexEntry(fund));
  return entries;
}

function sumIndexCounts(entries: Iterable<JsonRecord>, key: 'holdings' | 'history'): number {
  let total = 0;
  for (const entry of entries) total += Math.max(0, numberOrNull(entry[key]) ?? 0);
  return total;
}

function resultCountsFromEntry(entry: JsonRecord): { holdingsCount: number; historyCount: number; distributionCount: number; netAssets: number | null; dividendYield: number | null; secYield: number | null } {
  return {
    holdingsCount: Math.max(0, numberOrNull(entry.holdings) ?? 0),
    historyCount: Math.max(0, numberOrNull(entry.history) ?? 0),
    distributionCount: arrayValue(record(entry.distributions).rows).length,
    netAssets: numberField(entry, 'aumValue'),
    dividendYield: numberField(record(entry.metrics), 'dividendYield'),
    secYield: numberField(record(entry.metrics), 'secYield'),
  };
}

export async function runUpdater(options: RunUpdaterOptions = {}): Promise<RunUpdaterReport> {
  const config = options.config ?? readConfig(options.env ?? process.env);
  const apiRoot = options.apiRoot ?? API_ROOT;
  const referenceDate = options.referenceDate ?? new Date();
  const onNote = options.onNote ?? outputNote;
  const clients = options.clients ?? createRequestClients(config, options.runtime);
  const invalidTickers = config.tickers.filter((ticker) => !ARK_FUND_BY_TICKER.has(ticker));
  if (invalidTickers.length) throw new Error(`TICKERS contains unsupported ARK ETF(s): ${[...new Set(invalidTickers)].join(', ')}`);
  outputPrintConfig('ARK Invest', { ...config });

  let catalogSource = 'fixed 14-fund ARK ETF catalog';
  if (config.skipArk) {
    catalogSource = 'fixed 14-fund ARK ETF catalog (SKIP_ARK enabled)';
    console.log(`[ ${'catalog'.padEnd(9)}] ${ARK_FUNDS.length} ARK Invest ETFs (${catalogSource})`);
  } else {
    try {
      let catalogPage: ProviderResponse;
      try {
        catalogPage = await clients.ark(ARK_CATALOG_URL);
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 403 || clients.isArkProxyActive()) throw error;
        // A single repeated catalog request reaches the configured denial threshold,
        // letting the request client retry this page through Jina's raw-HTML mode.
        catalogPage = await clients.ark(ARK_CATALOG_URL);
      }
      const discovered = parseArkCatalogHtml(catalogPage.text);
      if (!discovered.length) throw new Error('official ETF page contained no supported ETF fund links');
      catalogSource = `official ETF page; ${discovered.length} supported fund paths observed; fixed 14-fund catalog retained`;
      if (discovered.length !== ARK_FUNDS.length) {
        console.warn(`[ ${'catalog'.padEnd(9)}] official page exposed ${discovered.length}/${ARK_FUNDS.length} supported ETFs; retaining the full fixed catalog`);
      }
      console.log(`[ ${'catalog'.padEnd(9)}] ${ARK_FUNDS.length} ARK Invest ETFs (${catalogSource})`);
    } catch (error) {
      catalogSource = 'fixed 14-fund ARK ETF catalog (official discovery unavailable)';
      console.warn(`[ ${'catalog'.padEnd(9)}] official catalog unavailable; retaining all ${ARK_FUNDS.length} supported ETFs: ${error instanceof Error ? error.message : cleanText(error)}`);
    }
  }

  const previousIndex = await readJsonRecord(path.join(apiRoot, 'index.json'));
  const indexEntries = mergeCatalogEntries(previousIndex);
  const staticSelection = ARK_FUNDS.filter((fund) => passesStaticFilters(fund, config));
  outputPrintFilter(staticSelection.length, ARK_FUNDS.length, hasDeferredFilters(config));

  let selectedFunds = staticSelection;
  let nextCursor: number | null = null;
  let startCursor = 0;
  const stateFile = path.join(apiRoot, 'update-state.json');
  if (config.maxFetches > 0) {
    const state = await readJsonRecord(stateFile);
    const configuredTickers = staticSelection.map((fund) => fund.ticker);
    const priorTickers = stringArray(state?.tickers);
    const savedCursor = numberOrNull(state?.cursor) ?? 0;
    const matchingScope = configuredTickers.length === priorTickers.length && configuredTickers.every((ticker, index) => ticker === priorTickers[index]);
    startCursor = matchingScope && configuredTickers.length ? Math.min(Math.max(0, Math.floor(savedCursor)), configuredTickers.length - 1) : 0;
    selectedFunds = staticSelection.slice(startCursor, startCursor + config.maxFetches);
    nextCursor = configuredTickers.length && startCursor + selectedFunds.length < configuredTickers.length
      ? startCursor + selectedFunds.length
      : 0;
    console.log(`[ ${'cursor'.padEnd(9)}] starting at ${configuredTickers.length ? startCursor + 1 : 0} of ${configuredTickers.length}; processing ${selectedFunds.length}; next ${configuredTickers.length ? nextCursor + 1 : 0}`);
  } else if (existsSync(stateFile)) {
    await rm(stateFile, { force: true });
  }

  const reporter = outputCreateReporter(apiRoot, selectedFunds.length);
  const secFallback = config.edgarFallback ? createSecFallbackResolver(clients) : undefined;
  const processedTickers: string[] = [];
  const filteredTickers: string[] = [];
  const failedTickers: string[] = [];
  let successes = 0;
  let nextFundIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextFundIndex;
      nextFundIndex += 1;
      const fund = selectedFunds[index];
      if (!fund) return;
      const before = await reporter.before(fund.ticker);
      let result: ArkFundUpdateResult;
      try {
        result = await updateArkFund(fund, config, clients, {
          apiRoot,
          referenceDate,
          secFallback,
          onNote,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : cleanText(error);
        onNote(`[ ${'product'.padEnd(9)}] ${fund.ticker} failed: ${message}`);
        result = {
          entry: indexEntries.get(fund.ticker) ?? seedIndexEntry(fund),
          status: 'failed',
          reason: message,
          ...resultCountsFromEntry(indexEntries.get(fund.ticker) ?? seedIndexEntry(fund)),
        };
      }
      processedTickers.push(fund.ticker);
      if (result.status === 'filtered') filteredTickers.push(fund.ticker);
      else if (result.status === 'failed') failedTickers.push(fund.ticker);
      else {
        indexEntries.set(fund.ticker, result.entry);
        successes += 1;
      }
      await reporter.result(fund.ticker, before, result.status, result.reason, {
        ...result.entry,
        holdings: { totalRows: result.holdingsCount },
        history: { totalRows: result.historyCount },
        distributions: { rows: { length: result.distributionCount } },
        netAssets: result.netAssets,
        metrics: { dividendYield: result.dividendYield, secYield: result.secYield },
      });
    }
  };
  const laneClock: PaceClock = { now: options.runtime?.now, sleep: options.runtime?.sleep };
  const workerCount = Math.min(config.concurrency, selectedFunds.length);
  await Promise.all(Array.from({ length: workerCount }, () => withRequestLane(config.requestSleepSeconds * 1000, worker, laneClock)));

  const sortedEntries = [...indexEntries.values()].sort((a, b) => cleanText(a.ticker).localeCompare(cleanText(b.ticker)));
  const indexDocument: JsonRecord = {
    ...(previousIndex ?? {}),
    brand: 'ARK Invest',
    generatedAt: new Date().toISOString(),
    catalog: { url: ARK_CATALOG_URL, source: catalogSource, tickers: ARK_FUNDS.map((fund) => fund.ticker) },
    counts: {
      funds: sortedEntries.length,
      holdings: sumIndexCounts(sortedEntries, 'holdings'),
      history: sumIndexCounts(sortedEntries, 'history'),
    },
    funds: sortedEntries,
  };
  const indexPath = path.join(apiRoot, 'index.json');
  await writeJsonIfChanged(indexPath, indexDocument);
  if (config.maxFetches > 0) {
    await writeJsonIfChanged(stateFile, {
      cursor: nextCursor ?? 0,
      tickers: staticSelection.map((fund) => fund.ticker),
      generatedAt: new Date().toISOString(),
    });
  }
  const holdingsTotal = sumIndexCounts(sortedEntries, 'holdings');
  const historyTotal = sumIndexCounts(sortedEntries, 'history');
  console.log(`[ ${'done'.padEnd(9)}] ${successes} funds updated, ${failedTickers.length} failures`);
  console.log(`[ ${'done'.padEnd(9)}] counts: ${sortedEntries.length} catalog funds · ${holdingsTotal} holdings rows · ${historyTotal} history rows${filteredTickers.length ? ` · ${filteredTickers.length} filtered` : ''}`);

  return {
    selectedTickers: selectedFunds.map((fund) => fund.ticker),
    processedTickers,
    filteredTickers,
    failedTickers,
    nextCursor,
    indexPath,
  };
}

// File defaults and explicit overrides, same mechanism as the sibling
// daggerok/aberdeen and daggerok/Capital-Group updaters: allowlisted scalar
// controls only, so GitHub Actions can resolve them without interpolating user
// input into bash. Precedence: config file < advanced JSON < nonblank inputs <
// environment (`ARK_<KEY>` alias wins over `<KEY>`). JINA_API_KEY is a secret
// and is deliberately NOT a control: it is read from the environment only.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'TICKERS',
  'CATEGORY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'SEC_UA',
  'SKIP_YAHOO', 'SKIP_ARK', 'EDGAR_FALLBACK', 'VERBOSE',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = env[`ARK_${key}`] ?? env[key];
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key];
    if (v === undefined || v === '') continue;
    const min = ['MAX_FETCHES', 'MAX_RETRIES'].includes(key) ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['SKIP_YAHOO', 'SKIP_ARK', 'EDGAR_FALLBACK', 'VERBOSE']) {
    if (result[key] && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key])) throw new Error(`${key}: expected boolean`);
  }
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const controls = resolveControls(file, {}, {}, env);
  // Secrets and non-control passthroughs stay environment-only.
  if (env.JINA_API_KEY !== undefined) controls.JINA_API_KEY = env.JINA_API_KEY;
  return controls;
}

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<void> {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    return;
  }
  if (argv.length) throw new Error(`unsupported argument(s): ${argv.join(' ')}. Use --help for usage.`);
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  await runUpdater({ config: readConfig(controls) });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : cleanText(error);
    console.error(`[ ${'error'.padEnd(9)}] ${cleanText(detail)}`);
    process.exitCode = 1;
  });
}
