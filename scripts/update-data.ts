#!/usr/bin/env bun
// Bun provides Node-compatible fs/promises and process globals for this script.
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';
import { appendFile, mkdir, readFile, readdir, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

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
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
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
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
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
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
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
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
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
export const DEFAULT_SEC_UA = 'daggerok ETF feed daggerok@gmail.com';
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
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];
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
// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type YahooPricePoint = { date: string; close: number | null; adjClose: number | null; volume: number | null; adjCloseRaw?: number | null };
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
  if (!text) return null;
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
  // Calendar dates (ISO, U.S., month names): pure text, the same day in every time zone (shared calendar-dates block)
  const calendar = calendarIso(text);
  if (calendar) return calendar;
  // An HTTP timestamp (the ARKY CSV's Last-Modified header) names its zone: its UTC day; anything else is no date
  if (!/(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})$/i.test(text)) return '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
}

/** ISO timestamp without milliseconds, e.g. 2026-10-03T04:05:06Z. */
export function isoStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
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

/**
 * A holdings CSV ticker as an exchange ticker: ARK writes some U.S. listings Bloomberg-style with the U.S. composite or
 * exchange code (`XRAY UW`, `RKLB UQ`, `GRMN UN`, `ABC US`), which no watchlist reads: that suffix is dropped. A foreign
 * exchange code (`DSY FP`, `HEXAB SS`, `STMN SE`) stays, it tells the market apart.
 */
export function arkHoldingTicker(value: unknown): string {
  return tickerOrBlank(value).replace(/^([A-Z0-9.\/-]+)\s+U[ABCDFJLMNOPQRSTUVWX]$/, '$1');
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
      // the issuer appends its legal disclaimer as one more "position" without a CUSIP or a weight: it is no holding
      if (!cusip && numberOrNull(at(row, 'marketweight')) === null) continue;
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
      // The snapshot date is the newest row date, not the first row's (a stale leading row must not date the file).
      if (sourceDate && sourceDate > asOfDate) asOfDate = sourceDate;
      const holdingTicker = arkHoldingTicker(at(row, 'ticker'));
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

/** Slugs on the official ETF page that are not ETFs of the trust (ARK Venture Fund is an interval fund). */
const NON_ETF_SLUGS: ReadonlySet<string> = new Set(['ARKVX']);

/** Every `/funds/<slug>` on the official ETF page, upper-cased: the only official discovery source for ARK funds. */
export function parseArkCatalogSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const match of String(html).matchAll(/\/funds\/([a-z]{3,6})(?![a-z0-9-])/gi)) slugs.add(String(match[1]).toUpperCase());
  return [...slugs].sort();
}

/** Tickers the official page lists that are neither in the built-in catalog nor a known non-ETF. */
export function detectUnlistedArkFunds(html: string): string[] {
  return parseArkCatalogSlugs(html).filter((ticker) => !ARK_FUND_BY_TICKER.has(ticker) && !NON_ETF_SLUGS.has(ticker));
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

export const OFFICIAL_RETURNS_BASIS = 'official ARK Invest NAV total returns (fund performance API, month-end series)';
export const YAHOO_RETURNS_BASIS = 'Yahoo Finance adjusted close total-return proxy (official ARK performance unavailable)';
export const UNAVAILABLE_RETURNS_BASIS = 'no returns available (official ARK performance and Yahoo Finance history both unavailable)';
export const RETURN_METRIC_KEYS = ['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn'] as const;

function numberOrNullMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validIsoDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Pick the return metrics of ONE source layer (official > Yahoo > previous publication) and emit the
 * full contract key set (null when unavailable), ending with `returnsBasis` and `performanceAsOf` of that
 * same layer. Layers are never mixed key by key: a number a source later nulls stays null, and a value
 * never travels under another source's basis or date.
 */
export function resolveReturnMetrics(official: JsonRecord, yahoo: JsonRecord, previous: JsonRecord): JsonRecord {
  const layers: Array<{ name: 'official' | 'yahoo' | 'previous'; data: JsonRecord }> = [
    { name: 'official', data: official },
    { name: 'yahoo', data: yahoo },
    { name: 'previous', data: previous },
  ];
  const hasValues = (data: JsonRecord): boolean => RETURN_METRIC_KEYS.some((key) => numberOrNullMetric(data[key]) !== null);
  const hasBasis = (data: JsonRecord): boolean => typeof data.returnsBasis === 'string' && data.returnsBasis.trim() !== '';
  const chosen = layers.find((layer) => hasValues(layer.data))
    ?? layers.find((layer) => layer.name !== 'previous' && hasBasis(layer.data))
    ?? layers[2];
  const out: JsonRecord = {};
  for (const key of RETURN_METRIC_KEYS) out[key] = numberOrNullMetric(chosen.data[key]);
  const previousBasis = typeof chosen.data.returnsBasis === 'string' && chosen.data.returnsBasis.trim() && chosen.data.returnsBasis.trim() !== '-' ? chosen.data.returnsBasis.trim() : '';
  out.returnsBasis = chosen.name === 'official' ? OFFICIAL_RETURNS_BASIS : chosen.name === 'yahoo' ? YAHOO_RETURNS_BASIS : previousBasis || UNAVAILABLE_RETURNS_BASIS;
  out.performanceAsOf = validIsoDate(chosen.data.performanceAsOf);
  return out;
}

/** The shared young-fund rule (calendar anniversary of the inception, inclusive) with ARK's key names: annualized tables, return rows, metrics. */
const YOUNG_TABLE_HORIZONS: Record<string, number> = { '1Y': 1, '3Y': 3, '5Y': 5, '10Y': 10, SI: 1 };
const YOUNG_ROW_HORIZONS: Record<string, number> = { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 };
const YOUNG_METRIC_HORIZONS: Record<string, number> = { tr1y: 1, tr3y: 3, tr5y: 5, tr10y: 10, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 };

/** Drop annualized horizons (and since-inception annualized) longer than the fund's age. */
function ageGuarded(table: Record<string, number | null>, inceptionIso: string | null | undefined, asOfIso: string): Record<string, number | null> {
  return withoutYoungReturns(table, inceptionIso || null, asOfIso || null, YOUNG_TABLE_HORIZONS);
}

export function buildOfficialReturns(monthEnd: ArkPerformance | null, quarterEnd: ArkPerformance | null, inceptionIso: string | null = null): {
  monthEnd: JsonRecord;
  quarterEnd: JsonRecord;
  metrics: JsonRecord;
} {
  const monthAnn = ageGuarded(monthEnd?.navAnnualized ?? {}, inceptionIso, monthEnd?.asOfDate ?? '');
  const monthCum = monthEnd?.navCumulative ?? {};
  const quarterAnn = ageGuarded(quarterEnd?.navAnnualized ?? {}, inceptionIso, quarterEnd?.asOfDate ?? '');
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
    returnsBasis: OFFICIAL_RETURNS_BASIS,
    performanceAsOf: monthEnd?.asOfDate ? toIsoDate(monthEnd.asOfDate) || null : null,
  };
  return { monthEnd: month, quarterEnd: quarter, metrics };
}

// ---------------------------------------------------------------------------
// Yahoo Finance fallback and return calculations
// ---------------------------------------------------------------------------

/** First epoch second of the Yahoo request window: `max` -> 0, `Ny` -> N years before now. */
export function historyWindowStartEpoch(historyRange: string, nowEpochSeconds: number): number {
  const years = /^([1-9]\d*)y$/i.exec(historyRange.trim());
  return years ? Math.max(0, Math.floor(nowEpochSeconds - Number(years[1]) * 365.25 * 86_400)) : 0;
}

export function yahooChartUrl(tickerValue: string, nowEpochSeconds = Math.floor(Date.now() / 1000), historyRange = 'max'): string {
  const ticker = tickerOrBlank(tickerValue);
  const query = new URLSearchParams({
    period1: String(historyWindowStartEpoch(historyRange, nowEpochSeconds)),
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
      adjCloseRaw: adjRaw,
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
  if (['semi-annually', 'semiannually', 'semi-annual', 'semiannual', 'sdec'].includes(text)) return 2;
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

function addDays(iso: string, amount: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
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

function derivedPeriod(points: YahooPricePoint[], endDate: string, coversInception: boolean): JsonRecord {
  // The first point of a shrunken window (HISTORY_RANGE=Ny) is not the fund's inception.
  const inception = coversInception ? sinceInceptionReturns(points, endDate) : { annualized: null, cumulative: null };
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

export function buildYahooReturns(points: YahooPricePoint[], referenceDate = new Date(), coversInception = true): { monthEnd: JsonRecord; quarterEnd: JsonRecord; metrics: JsonRecord } {
  const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const monthEnd = derivedPeriod(ordered, monthEndBefore(referenceDate), coversInception);
  const quarterEnd = derivedPeriod(ordered, quarterEndBefore(referenceDate), coversInception);
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
      returnsBasis: YAHOO_RETURNS_BASIS,
      performanceAsOf: priceAtOrBefore(ordered, monthEndBefore(referenceDate))?.date ?? null,
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
  historyRange: string;
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

export function parseRetries(raw: string): number {
  if (!raw) return DEFAULT_MAX_RETRIES;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new Error('MAX_RETRIES: expected integer >= 1');
  return Number(raw);
}

export function parseHistoryRange(raw: string): string {
  if (!raw) return 'max';
  if (!/^(max|[1-9]\d*y)$/i.test(raw)) throw new Error('HISTORY_RANGE: use max or Ny (e.g. 5y)');
  return raw.toLowerCase();
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
  const unknown = tickers.filter((ticker) => !ARK_FUND_BY_TICKER.has(ticker));
  if (unknown.length) throw new Error(`TICKERS contains unsupported ARK ETF(s): ${[...new Set(unknown)].join(', ')}`);
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), DEFAULT_CONCURRENCY),
    requestSleepSeconds: parseNonNegativeDecimal(envValue(env, 'REQUEST_SLEEP'), DEFAULT_REQUEST_SLEEP),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES'), 0),
    maxRetries: parseRetries(envValue(env, 'MAX_RETRIES')),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), DEFAULT_HOLDINGS_PAGE_SIZE),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), DEFAULT_HISTORY_PAGE_SIZE),
    historyRange: parseHistoryRange(envValue(env, 'HISTORY_RANGE')),
    tickers,
    category: cleanText(envValue(env, 'CATEGORY')),
    secUa: envValue(env, 'SEC_UA') || DEFAULT_SEC_UA,
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
    // A bounded range excludes funds without that figure (no number cannot be inside a range).
    if (!withinRange(published[period], config.performanceRanges[period])) return false;
    if (!withinRange(total[period], config.totalReturnRanges[period])) return false;
  }
  return true;
}

export const USAGE = `ARK Invest ETF static-feed updater (zero runtime dependencies; Bun only).

Usage: bun ./scripts/update-data.ts [--help]

Environment controls:
  TICKERS              Space/comma separated ETF tickers. ANDed with other filters.
  MAX_FETCHES          0 means all selected funds; positive values resume at the saved per-scope cursor and wrap around. A TICKERS run never touches the full-feed cursor.
  REQUEST_SLEEP        Seconds between request starts within each worker, including retries (default 1.5).
  CONCURRENCY          Independent parallel fund workers, each with its own request pacing (default 2).
  MAX_RETRIES          Retry count for network/temporary HTTP errors (integer >= 1, default 2).
  HOLDINGS_PAGE_SIZE   Holdings rows per static JSON page (default 250).
  HISTORY_PAGE_SIZE    History rows per static JSON page (default 1000).
  HISTORY_RANGE        Yahoo request window and fresh history rows: max or Ny (default max). Older published rows are merged back, never pruned.
  CATEGORY             Keep a category name (case-insensitive substring).
  AUM                  Dollar min:max; K/M/B/T suffixes or nano/micro/small/mid/large presets.
  TER                  Expense-ratio percent min:max.
  DIVIDEND_YIELD       Trailing 12-month indicated dividend yield percent min:max.
  SEC_YIELD            Published 30-day SEC yield percent min:max.
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y   Official annualized NAV performance range (funds without the figure are excluded).
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y  Cumulative NAV total-return range.
  SEC_UA               Contact-bearing User-Agent for SEC EDGAR (default daggerok ETF feed daggerok@gmail.com).
  EDGAR_FALLBACK       Enable Form N-PORT-P holdings fallback (default true).
  SKIP_ARK             Do not request ark-funds.com (requires prior static data for source fallbacks).
  SKIP_YAHOO           Disable Yahoo history/distribution fallback.
  VERBOSE              Show per-request retries and fallback notices.
  USE_SYSTEM_CA        TLS trust store: auto (restart once with --use-system-ca on an untrusted-certificate error), true or false (default auto).

Defaults: scripts/update-data.config.json; explicit environment overrides the file (ARK_<KEY> wins over <KEY>).
Actions: file < advanced JSON < individual nonblank inputs. Range syntax is strict min:max with one colon;
an empty side is unbounded.

Examples:
  TICKERS="ARKK ARKY ARKB" bun ./scripts/update-data.ts
  MAX_FETCHES=3 bun ./scripts/update-data.ts
  AUM="1B:" TER=":0.75" bun ./scripts/update-data.ts
`;

// ---------------------------------------------------------------------------
// SEC EDGAR N-PORT holdings sheet (fallback only): the shared nport-reader block at the end of this file finds, reads and checks the filing
// ---------------------------------------------------------------------------

/**
 * The ARK holdings sheet of an N-PORT filing (HOLDINGS_HEADERS). Identifiers are the position's own (`nportIdentifier`),
 * tickers come from `nportTickers` (U.S. equities only), a missing number stays empty (never 0). A position without
 * `pctVal` gets its weight from the same filing: valUSD / netAssets x 100 (both reported, nothing invented); without
 * either it stays empty. Weights keep ARK's `%` cell style; a missing asset category falls back to ARK's own classes.
 */
export function nportToHoldings(filing: NportFiling, tickers: ReadonlyArray<string> = []): HoldingRow[] {
  return filing.positions.map((position, index) => {
    const ticker = tickers[index] || '';
    const weight = position.weight !== null
      ? position.weight
      : (filing.netAssets !== null && filing.netAssets > 0 && position.value !== null ? (position.value / filing.netAssets) * 100 : null);
    const weightCell = nportCell(weight);
    return {
      Name: position.name,
      Ticker: ticker,
      Identifier: nportIdentifier(position),
      Weight: weightCell ? `${weightCell}%` : '',
      'Market Value': nportCell(position.value, 2),
      'Shares Held': nportCell(position.balance),
      'Asset Category': position.assetCat || classifyArkAsset(position.name, ticker),
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

// Keys are sorted for stable diffs, except `metrics` objects: they keep contract order
// (returns, yields, then returnsBasis and performanceAsOf last).
function sortJsonKeys(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonKeys(item));
  if (value !== null && typeof value === 'object') {
    const source = value as JsonRecord;
    const keys = parentKey === 'metrics' ? Object.keys(source) : Object.keys(source).sort();
    return Object.fromEntries(keys.map((key) => [key, sortJsonKeys(source[key], key)]));
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortJsonKeys(value), null, 2)}\n`;
}

export function semanticContentKey(value: unknown): string {
  return outputContentKey(value);
}

let atomicWriteCounter = 0;

/** Write via a sibling tmp file and rename, so a crash or timeout never leaves a half-written file. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  atomicWriteCounter += 1;
  const tmp = `${file}.${process.pid}.${atomicWriteCounter}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  if (existsSync(file) && await readFile(file, 'utf8') === content) return 'unchanged';
  await writeFileAtomic(file, content);
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
  await writeFileAtomic(file, serialized);
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
  fetchImpl?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  onRetry?: (message: string) => void;
  onIssuerProxy?: (message: string) => void;
  /** Per-request wall-clock limit (headers + body); tests override it. */
  requestTimeoutMs?: number;
};

type RequestGate = <T>(task: () => T | Promise<T>) => Promise<T>;
type Sleep = (milliseconds: number) => Promise<void>;

/**
 * Honest, contact-bearing User-Agent WITHOUT a URL. Verified live 2026-09-29:
 * ark-funds.com (Cloudflare WAF) answers HTTP 403 to any User-Agent that
 * contains a `https://github.com/...` link (the classic crawler signature
 * `(+https://...)`), and challenges browser UAs sent from a non-browser TLS
 * stack; a plain tool name with a contact e-mail is accepted, also for 16
 * parallel requests. Never put a URL back into this string.
 */
export const ISSUER_USER_AGENT = 'daggerok ETF feed daggerok@gmail.com';
const ISSUER_DIRECT_DENIAL_LIMIT = 2;
/**
 * r.jina.ai throttles keyless read requests to about 20 per minute per IP
 * (observed live as HTTP 429 "Per IP rate limit exceeded" at 1.5-second pacing).
 * Proxied issuer requests therefore never start closer than 3.2 seconds apart,
 * regardless of a shorter REQUEST_SLEEP.
 */
export const ISSUER_PROXY_MIN_INTERVAL_MS = 3200;
/**
 * Every provider request (including the r.jina.ai proxy, which renders pages
 * in a headless browser) is aborted after this long so one stalled connection
 * cannot block a paced lane for the rest of the run; the abort is retried as
 * a network error.
 */
export const REQUEST_TIMEOUT_MS = 45_000;

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
  // Last-resort proxy only: keyless r.jina.ai is limited per IP (~20/min), so
  // proxied requests share one process-wide gate on top of the worker lanes.
  const proxyLimitGate = createRequestGate(ISSUER_PROXY_MIN_INTERVAL_MS, paceClock);
  const laneGate: RequestGate = (task) => (currentRequestLane() ?? discoveryGate)(task);
  const proxyGate: RequestGate = (task) => laneGate(() => proxyLimitGate(task));
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
    retryCap = Number.POSITIVE_INFINITY,
  ): Promise<ProviderResponse> => requestTextWithRetry(url, provider, gate, headers, retryCap < config.maxRetries ? { ...config, maxRetries: retryCap } : config, runtime);

  const arkProxy = async (url: string): Promise<ProviderResponse> => {
    const responseFormat = new URL(url).pathname.startsWith('/api/') ? 'text' : 'html';
    // The keyless proxy is rate limited for everybody: at most one retry, whatever MAX_RETRIES says.
    const response = await request(jinaReaderUrl(url), 'ARK proxy', proxyGate, {
      ...arkHeaders,
      'X-Respond-With': responseFormat,
    }, 1);
    return { ...response, text: unwrapJinaReaderText(response.text) };
  };

  const ark = async (url: string): Promise<ProviderResponse> => {
    // A 403 is not retried by the generic client (retryableStatus), but dropping the request on the
    // first denial loses it on a datacenter IP. Retry the request once directly (a transient WAF
    // challenge may pass), then send this very request through the proxy.
    for (let attempt = 0; ; attempt += 1) {
      if (arkProxyActive) return arkProxy(url);
      try {
        const response = await request(url, 'ARK issuer', laneGate, arkHeaders);
        consecutiveArkDenials = 0;
        return response;
      } catch (error) {
        if (!(error instanceof ProviderHttpError) || error.status !== 403) throw error;
        consecutiveArkDenials += 1;
        if (attempt < 1 && consecutiveArkDenials < ISSUER_DIRECT_DENIAL_LIMIT) continue;
        const firstSwitch = !arkProxyActive;
        arkProxyActive = true;
        if (firstSwitch) {
          const notice = `[ ${'issuer'.padEnd(9)}] ARK direct requests returned ${consecutiveArkDenials} consecutive HTTP 403 responses; using the read-only r.jina.ai proxy for remaining issuer requests (shared limit of about 20 requests per minute).`;
          // Printed through outputNote so it never lands between fund lines; runUpdater reports the switch before the fund loop.
          (runtime.onIssuerProxy ?? outputNote)(notice);
        }
        return arkProxy(url);
      }
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

export type SecHoldingResult = { filing: NportFiling; candidate: NportCandidate; url: string; holdings: HoldingRow[] } | { problem: string };
/** The fund's newest own N-PORT-P filing as an ARK sheet, only when strictly newer than the published holdings (`asOf` ISO, `rows`). */
export type SecFallbackResolver = (fund: ArkFund, published: { asOf: string; rows: number }) => Promise<SecHoldingResult>;

/**
 * One run's SEC state (the resolver is created once per run): the two SEC ticker tables (each loaded once, a failed load is
 * asked again by the next fund) and the N-PORT reader cache (submissions and documents shared by the funds of one trust).
 * Identity is the series id SEC lists for the ticker under the fund's own trust CIK; with no such series the fund name.
 */
export function createSecFallbackResolver(clients: RequestClients): SecFallbackResolver {
  const state: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };
  const fundTickers = (): Promise<Map<string, NportSeriesRef>> => {
    if (!state.funds) {
      const loading = clients.sec(SEC_FUND_TICKERS_URL).then((response) => parseSecFundTickers(parseProviderJson(response.text)));
      state.funds = loading;
      loading.catch(() => { if (state.funds === loading) state.funds = null; });
    }
    return state.funds;
  };
  const companyNames = (): Promise<Map<string, string>> => {
    if (!state.names) {
      const loading = clients.sec(SEC_COMPANY_TICKERS_URL).then((response) => parseSecCompanyNames(parseProviderJson(response.text)));
      state.names = loading;
      loading.catch(() => { if (state.names === loading) state.names = null; });
    }
    return state.names;
  };
  // Nasdaq Trader symbol directories (shared nport-reader readUsListings), once per run: a row with a foreign ISIN keeps a ticker
  // only for the company's own U.S. listing in U.S. dollars (Q33); null when either directory failed
  let usListings: Promise<Map<string, string> | null> | null = null;
  const loadUsListings = (): Promise<Map<string, string> | null> => {
    if (!usListings) usListings = readUsListings((url) => clients.sec(url).then((response) => response.text));
    return usListings;
  };

  return async (fund: ArkFund, published: { asOf: string; rows: number }): Promise<SecHoldingResult> => {
    const series = (await fundTickers()).get(fund.ticker);
    if (series && series.cik !== fund.trustCik) {
      outputNote(`[ ${'edgar'.padEnd(9)}] ${fund.ticker} SEC ticker map CIK ${series.cik} did not match expected trust ${fund.trustCik}; matching the filing by fund name`);
    }
    const seriesId = series && series.cik === fund.trustCik ? series.seriesId : null;
    const read = await readNportHoldings(
      { ticker: fund.ticker, cik: fund.trustCik, seriesId, name: fund.name },
      published,
      (url, label) => clients.sec(url).then((response) => response.text),
      { cache: state.reader },
    );
    if ('problem' in read) return read;
    const names = await companyNames().catch((error: unknown) => {
      outputNote(`[ ${'edgar'.padEnd(9)}] SEC company ticker map unavailable: ${error instanceof Error ? error.message : cleanText(error)}`);
      return null;
    });
    return { ...read, holdings: nportToHoldings(read.filing, nportTickers(read.filing.positions, names, await loadUsListings())) };
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

function readDistributionWorksheet(meta: JsonRecord): JsonRecord & { rows: string[][] } {
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

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing. Close and Volume
// update as usual; a real change beyond the noise is written.
export const ADJ_CLOSE_NOISE = 1e-4;
export function keepPublishedAdjClose(points: YahooPricePoint[], published: { headers: string[]; rows: JsonRecord[] }): YahooPricePoint[] {
  if (published.headers.join('|') !== YAHOO_HISTORY_HEADERS.join('|')) return points;
  const cents = new Map<string, number>();
  for (const row of published.rows) {
    const date = toIsoDate(row.Date);
    const value = numberOrNull(row['Adj Close']);
    if (date && value !== null) cents.set(date, value);
  }
  return points.map((point) => {
    const prior = cents.get(point.date);
    const raw = point.adjCloseRaw ?? point.adjClose;
    return prior !== undefined && raw !== null && prior !== point.adjClose && Math.abs(raw - prior) <= 0.005 + ADJ_CLOSE_NOISE ? { ...point, adjClose: prior } : point;
  });
}

function buildYahooHistoryRows(points: YahooPricePoint[]): JsonRecord[] {
  return points.map((point) => ({
    Date: displayDate(point.date),
    Close: point.close === null ? '' : point.close.toFixed(2),
    'Adj Close': point.adjClose === null ? '' : point.adjClose.toFixed(2),
    Volume: point.volume === null ? '' : String(point.volume),
  }));
}

export type YieldBasis = 'official-trailing-12m' | 'official-distribution-rate' | 'official-other' | 'computed-trailing-12m' | 'indicated';
export const YIELD_BASIS_CODES: readonly YieldBasis[] = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'];

/**
 * Code for a yield-kind text written by this updater. ARK publishes no distribution yield, so every
 * non-null yield is an updater figure: an unrecognized text can only be an estimate ('indicated'), never official.
 */
export function yieldBasisFromKind(kind: string): YieldBasis | null {
  const text = kind.trim().toLowerCase();
  if (text.startsWith('not available')) return null;
  if (text.startsWith('indicated')) return 'indicated';
  if (text.includes('trailing 12-month')) return 'computed-trailing-12m';
  return 'indicated';
}

/** The code travels with the yield it describes: null exactly when the yield is null, a known code is kept. */
export function resolveYieldBasis(dividendYield: number | null, basis: unknown, kind = ''): YieldBasis | null {
  if (dividendYield === null) return null;
  const known = YIELD_BASIS_CODES.find((code) => code === basis);
  return known ?? yieldBasisFromKind(kind) ?? 'indicated';
}

function distributionData(
  chart: YahooChart | null,
  previous: JsonRecord,
  referenceDate: Date,
  price: number | null,
): { worksheet: JsonRecord; indicatedYield: number | null; yieldKind: string; yieldBasis: YieldBasis | null } {
  const previousWorksheet = readDistributionWorksheet(previous);
  if (!chart) {
    const retainedYield = numberField(record(previous.metrics), 'dividendYield');
    const retainedKind = stringField(record(previous.yields), 'dividendYieldKind', 'previously published distribution data');
    return {
      worksheet: previousWorksheet,
      indicatedYield: retainedYield,
      yieldKind: retainedKind,
      // the previous code stays with the previous yield; a legacy row without one is derived from its kind text
      yieldBasis: resolveYieldBasis(retainedYield, record(previous.metrics).dividendYieldBasis, retainedKind),
    };
  }
  if (!chart.dividends.length) {
    const worksheet = previousWorksheet.rows.length ? previousWorksheet : {
      frequency: '—', exDate: '—', dividend: '—', headers: ['Ex-Date', 'Amount'], rows: [],
      source: 'Yahoo Finance chart response contained no distribution events',
    };
    // The chart answered and shows no distributions: an honest null yield, not the previous number.
    return { worksheet, indicatedYield: null, yieldKind: 'not available from Yahoo Finance', yieldBasis: null };
  }
  const eligible = chart.dividends.filter((event) => event.date <= referenceDate.toISOString().slice(0, 10));
  const sorted = [...eligible].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return { worksheet: previousWorksheet, indicatedYield: null, yieldKind: 'not available from Yahoo Finance', yieldBasis: null };
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
  return { worksheet, indicatedYield, yieldKind, yieldBasis: resolveYieldBasis(indicatedYield, annualized !== null ? 'indicated' : trailing !== null ? 'computed-trailing-12m' : null, yieldKind) };
}

/** Write the pages of one sheet and return its manifest. Stale pages are pruned later, after meta.json. */
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
  return { pages, pageSize, totalRows: rows.length, headers: [...headers], asOfDate: asOfDate ? displayDate(asOfDate) : '—', source };
}

/** Merge older published rows back under a (possibly shorter) fresh window; the fresh rows win. */
export function mergeHistoryRows(previous: { headers: string[]; rows: JsonRecord[] }, headers: readonly string[], fresh: JsonRecord[]): JsonRecord[] {
  if (!previous.rows.length || previous.headers.join('|') !== headers.join('|') || !fresh.length) return fresh;
  const firstFresh = fresh.map((row) => toIsoDate(row.Date)).filter(Boolean).sort()[0];
  if (!firstFresh) return fresh;
  const older = previous.rows.filter((row) => {
    const date = toIsoDate(row.Date);
    return Boolean(date) && date < firstFresh;
  });
  return older.length ? [...older, ...fresh] : fresh;
}

/**
 * A windowed Yahoo chart (HISTORY_RANGE=Ny) joined to the published data, so a window never shrinks the history, the
 * distributions worksheet (12 newest events) or the frequency read from the last 400 days. A published Yahoo history
 * (Date, Close, Adj Close, Volume) goes through the shared mergeWindowedChart (older days rescaled by the overlap, null when
 * the window does not join); a joined day keeps its published Volume cell (an empty cell stays empty). An official NAV
 * history has no prices to join, so only the published distributions older than the window are kept. Days stay sorted.
 */
export function joinYahooWindow(chart: YahooChart, published: { headers: string[]; rows: JsonRecord[] }, publishedDistributions: ReadonlyArray<ReadonlyArray<string>>): YahooChart | null {
  if (!chart.points.length) return chart;
  const firstFresh = chart.points[0].date;
  const epochOf = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 1000;
  const isoOf = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);
  let olderPoints: YahooPricePoint[] = [];
  let olderDividends: YahooDividend[] = [];
  if (published.headers.join('|') === YAHOO_HISTORY_HEADERS.join('|')) {
    const days: WindowedChartDay[] = [];
    for (const point of chart.points) {
      if (point.close !== null && point.adjClose !== null) days.push({ date: point.date, close: point.close, adjClose: point.adjClose, volume: point.volume ?? 0, adjCloseRaw: point.adjCloseRaw ?? point.adjClose });
    }
    const merged = mergeWindowedChart({ days, dividends: chart.dividends.map((event) => ({ epoch: epochOf(event.date), amount: event.amount })) }, published.rows, publishedDistributions);
    if (!merged) return null;
    const volumes = new Map<string, string>();
    for (const row of published.rows) volumes.set(toIsoDate(row.Date), cleanText(row.Volume));
    olderPoints = merged.days.filter((day) => day.date < firstFresh).map((day) => ({
      date: day.date, close: day.close, adjClose: day.adjClose, volume: numberOrNull(volumes.get(day.date) ?? ''), adjCloseRaw: day.adjCloseRaw ?? day.adjClose,
    }));
    olderDividends = merged.dividends.filter((event) => isoOf(event.epoch) < firstFresh).map((event) => ({ date: isoOf(event.epoch), amount: event.amount }));
  } else {
    for (const cells of publishedDistributions) {
      const date = toIsoDate(cells[0]);
      const amount = numberOrNull(cells[1] ?? '');
      if (date && date < firstFresh && amount !== null && amount > 0) olderDividends.push({ date, amount });
    }
    olderDividends.sort((a, b) => a.date.localeCompare(b.date));
  }
  return { ...chart, points: olderPoints.concat(chart.points), dividends: olderDividends.concat(chart.dividends) };
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
  /** Always-visible warnings (stale snapshots); defaults to console.warn. */
  onWarn?: (message: string) => void;
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
    const url = yahooChartUrl(fund.ticker, Math.floor(referenceDate.getTime() / 1000), config.historyRange);
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

/** Full metrics object in contract order: returns, yields, then returnsBasis and performanceAsOf last. */
export function buildFundMetrics(returnMetrics: JsonRecord, dividendYield: number | null, secYield: number | null, yieldBasis: YieldBasis | null = null): JsonRecord {
  const metrics: JsonRecord = {};
  for (const key of RETURN_METRIC_KEYS) metrics[key] = numberOrNullMetric(returnMetrics[key]);
  metrics.dividendYield = dividendYield;
  metrics.dividendYieldText = dividendYield === null ? null : formatPercent(dividendYield);
  metrics.dividendYieldBasis = resolveYieldBasis(dividendYield, yieldBasis);
  metrics.secYield = secYield;
  metrics.secYieldText = secYield === null ? null : formatPercent(secYield);
  const basis = typeof returnMetrics.returnsBasis === 'string' ? returnMetrics.returnsBasis.trim() : '';
  metrics.returnsBasis = basis && basis !== '-' ? basis : UNAVAILABLE_RETURNS_BASIS;
  metrics.performanceAsOf = validIsoDate(returnMetrics.performanceAsOf);
  return metrics;
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
  const onWarn = options.onWarn ?? ((message: string) => console.warn(message));
  const fundDirectory = path.join(apiRoot, 'funds', fund.ticker);
  const previousIndex = await readJsonRecord(path.join(apiRoot, 'index.json'));
  const previousEntry = arrayValue(previousIndex?.funds).map(record).find((entry) => entry.ticker === fund.ticker) ?? {};
  const previousMeta = await readJsonRecord(path.join(fundDirectory, 'meta.json'));
  const previousSource = record(previousMeta?.source);
  const previousHoldings = await readStoredSheet(apiRoot, fund.ticker, 'holdings', previousMeta?.holdings);
  const previousHistory = await readStoredSheet(apiRoot, fund.ticker, 'history', previousMeta?.history);
  const previousCombined: JsonRecord = { ...previousEntry, ...(previousMeta ?? {}) };
  const secFallback = options.secFallback ?? createSecFallbackResolver(clients);

  const [official, fetchedYahoo, csvResult] = await Promise.all([
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
  // A HISTORY_RANGE window never shrinks the published Yahoo history or distributions (shared windowed-chart block);
  // a window that does not join the published history counts as a failed chart: the fund is kept as published.
  let yahoo = fetchedYahoo;
  if (yahoo && historyWindowStartEpoch(config.historyRange, Math.floor(referenceDate.getTime() / 1000)) > 0) {
    yahoo = joinYahooWindow(yahoo, previousHistory, readDistributionWorksheet(previousCombined).rows);
    if (!yahoo) onNote(`[ ${'chart'.padEnd(9)}] ${fund.ticker} chart window does not join the published history (${config.historyRange})`);
  }

  const failedSources: string[] = [];
  let holdingsRows: HoldingRow[] = [];
  let holdingsHeaders: readonly string[] = [];
  let holdingsAsOfDate = '';
  let holdingsSource = '';
  let edgarFiling: { accession: string; filed: string; reportDate: string; url: string } | null = null;
  let nportDoc: string | null = null;
  // ISO through calendarIso: the published sheet's display date (whichever source published it, the daily CSV or an N-PORT report)
  const previousHoldingsAsOf = toIsoDate(previousHoldings.asOfDate) || toIsoDate(stringField(record(previousMeta?.holdings), 'asOfDate'));
  if (csvResult) {
    holdingsRows = csvResult.rows;
    holdingsHeaders = csvResult.headers;
    holdingsAsOfDate = csvResult.asOfDate;
    holdingsSource = csvResult.sourceKind;
  } else if (config.edgarFallback) {
    try {
      // the fund's own newest filing, used only when strictly newer than the published holdings (shared nport-reader block):
      // the issuer's daily CSV is newer than any N-PORT report, so a published CSV sheet is kept
      const read = await secFallback(fund, { asOf: previousHoldingsAsOf, rows: previousHoldings.rows.length });
      if ('problem' in read) onNote(`[ ${'edgar'.padEnd(9)}] ${read.problem}; keeping the published rows`);
      else {
        holdingsRows = read.holdings;
        holdingsHeaders = HOLDINGS_HEADERS;
        holdingsAsOfDate = read.filing.repPdDate;
        holdingsSource = `SEC EDGAR Form N-PORT-P fallback (accession ${read.candidate.accession}, report period ${read.filing.repPdDate || 'n/a'})`;
        edgarFiling = { accession: read.candidate.accession, filed: read.candidate.filed, reportDate: read.filing.repPdDate, url: read.url };
        nportDoc = read.url;
        onNote(`[ ${'edgar'.padEnd(9)}] ${fund.ticker} using N-PORT-P ${read.candidate.accession} (${read.filing.repPdDate}, ${holdingsRows.length} positions)`);
      }
    } catch (error) { noteSourceFailure(onNote, 'edgar', fund.ticker, error); }
  }
  if (!config.skipArk && !csvResult && !edgarFiling) failedSources.push('holdings CSV');
  if (!holdingsRows.length && previousHoldings.rows.length) {
    holdingsHeaders = previousHoldings.headers.length ? previousHoldings.headers : (fund.ticker === 'ARKY' ? ARKY_HOLDINGS_HEADERS : HOLDINGS_HEADERS);
    holdingsRows = holdingRowsFromStored(previousHoldings.rows, holdingsHeaders);
    holdingsAsOfDate = previousHoldingsAsOf;
    holdingsSource = stringField(record(previousMeta?.holdings), 'source', stringField(previousSource, 'holdingsSource', 'previously published holdings (retained)'));
    nportDoc = stringField(previousSource, 'nportDoc') || null;
    onNote(`[ ${'holdings'.padEnd(9)}] ${fund.ticker} retaining ${holdingsRows.length} previously published holdings rows`);
  }
  if (!holdingsHeaders.length) holdingsHeaders = fund.ticker === 'ARKY' ? ARKY_HOLDINGS_HEADERS : HOLDINGS_HEADERS;
  if (!holdingsAsOfDate) holdingsAsOfDate = toIsoDate(record(previousMeta?.holdings).asOfDate);

  if (!config.skipArk) {
    if (!official.pageId) failedSources.push('issuer fund page');
    else {
      if (!official.overview) failedSources.push('overview');
      if (!official.history.length) failedSources.push('NAV history');
      if (!official.monthEnd || !official.quarterEnd) failedSources.push('performance');
    }
  }
  if (!config.skipYahoo && !yahoo) failedSources.push('Yahoo chart');

  const yahooPoints = keepPublishedAdjClose(yahoo?.points ?? [], previousHistory);
  const yahooHistoryHeaders: readonly string[] = YAHOO_HISTORY_HEADERS;
  const previousIsOfficialHistory = previousHistory.rows.length > 0 && previousHistory.headers.join('|') !== yahooHistoryHeaders.join('|');
  let historyRows: JsonRecord[] = [];
  let historyHeaders: readonly string[] = [];
  let historyAsOfDate = '';
  let historySource = '';
  if (official.history.length) {
    const windowStart = config.historyRange === 'max' ? '' : new Date(historyWindowStartEpoch(config.historyRange, Math.floor(referenceDate.getTime() / 1000)) * 1000).toISOString().slice(0, 10);
    const windowed = windowStart ? official.history.filter((point) => point.date >= windowStart) : official.history;
    historyHeaders = HISTORY_HEADERS;
    // A shorter HISTORY_RANGE never shrinks the published series: older published rows are merged back.
    historyRows = mergeHistoryRows(previousHistory, historyHeaders, buildHistoryRows(windowed.length ? windowed : official.history));
    historyAsOfDate = official.history[official.history.length - 1].date;
    historySource = 'official ARK Invest daily NAV and market-price history API';
  } else if (previousIsOfficialHistory) {
    // Official NAV/market-price rows are never replaced by Yahoo adjusted closes under other headers.
    historyHeaders = previousHistory.headers;
    historyRows = previousHistory.rows;
    historyAsOfDate = toIsoDate(previousHistory.asOfDate) || stringField(record(previousMeta?.history), 'asOfDate');
    historySource = stringField(record(previousMeta?.history), 'source', stringField(previousSource, 'historySource', 'previously published history (retained)'));
    onNote(`[ ${'history'.padEnd(9)}] ${fund.ticker} retaining ${historyRows.length} previously published history rows`);
  } else if (yahoo && yahooPoints.length) {
    historyHeaders = yahooHistoryHeaders;
    historyRows = mergeHistoryRows(previousHistory, historyHeaders, buildYahooHistoryRows(yahooPoints));
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
  // Fresh holdings (CSV or N-PORT, never the retained sheet) that look broken (no weight column, non-numeric weights,
  // a bad weight sum, half the rows gone) never replace the published ones; a fund with nothing published is not written.
  // No relax lets a sheet without one numeric weight replace a published sheet that had numeric weights (Q24).
  const holdingsProblem = csvResult || edgarFiling
    ? holdingsGuard(holdingsHeaders, holdingsRows, numberField(record(previousMeta?.holdings), 'totalRows'), HOLDINGS_GUARD_RELAX[fund.ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], holdingsWeightCount(previousHoldings.headers, previousHoldings.rows))
    : null;
  if (holdingsProblem) {
    return {
      entry: previousEntry,
      status: 'failed',
      reason: `holdings guard: ${holdingsProblem}; ${previousMeta ? 'previous complete publication kept' : 'no data published for this fund yet'}`,
      ...resultCountsFromEntry(previousEntry),
    };
  }
  // Fund-level consistency: a fund is either fully refreshed or kept exactly as published. A failed
  // required source with a complete previous state never yields a half-new, half-stale publication.
  if (failedSources.length && previousMeta) {
    return {
      entry: previousEntry,
      status: 'failed',
      reason: `required source(s) failed (${failedSources.join(', ')}); previous complete publication kept`,
      ...resultCountsFromEntry(previousEntry),
    };
  }

  const previousMetrics = mergeNonNull(record(previousMeta?.metrics), record(previousEntry.metrics));
  const previousReturns = record(previousEntry.returns).monthEnd || previousMeta?.returns
    ? record(previousEntry.returns).monthEnd ? record(previousEntry.returns) : record(previousMeta?.returns)
    : {};
  const overview = official.overview;
  const inceptionIso = overview?.inceptionDate || toIsoDate(previousEntry.inceptionDate) || toIsoDate(record(previousMeta).inceptionDate);
  // Yahoo's window may start after the fund's first trade (HISTORY_RANGE=Ny): then "since inception" is unknown.
  const yahooFirstPoint = yahooPoints[0]?.date ?? '';
  const yahooCoversInception = Boolean(yahooFirstPoint) && (yahoo?.firstTradeDate
    ? yahooFirstPoint <= addDays(yahoo.firstTradeDate, 10)
    : config.historyRange === 'max');
  const yahooReturns = yahooPoints.length ? buildYahooReturns(yahooPoints, referenceDate, yahooCoversInception) : { monthEnd: {}, quarterEnd: {}, metrics: {} };
  const publishedReturns = officialReturnsPresent(official.monthEnd, official.quarterEnd)
    ? buildOfficialReturns(official.monthEnd, official.quarterEnd, inceptionIso || null)
    : { monthEnd: {}, quarterEnd: {}, metrics: {} };
  const previousReturnMetrics: JsonRecord = { ...previousMetrics };
  if (!validIsoDate(previousReturnMetrics.performanceAsOf) && previousReturnMetrics.returnsBasis === OFFICIAL_RETURNS_BASIS) {
    previousReturnMetrics.performanceAsOf = toIsoDate(record(previousReturns.monthEnd).asOfDate) || null;
  }
  // One source per fund for the whole returns unit (metrics, month-end, quarter-end, basis, as-of date):
  // official ARK first, then Yahoo, then the previous publication only when both sources are unavailable.
  const officialUnit = Object.keys(publishedReturns.monthEnd).length > 0;
  const yahooUnit = !officialUnit && yahooPoints.length > 0;
  const chosenReturns: { monthEnd: JsonRecord; quarterEnd: JsonRecord } = officialUnit
    ? { monthEnd: publishedReturns.monthEnd, quarterEnd: publishedReturns.quarterEnd }
    : yahooUnit
      ? { monthEnd: yahooReturns.monthEnd, quarterEnd: yahooReturns.quarterEnd }
      : { monthEnd: record(previousReturns.monthEnd), quarterEnd: record(previousReturns.quarterEnd) };
  // The shared young-fund rule on the final returns, whichever source they come from: no 1y, 3y, 5y, 10y or since-inception
  // figure before that calendar anniversary of the inception date (official, Yahoo-derived or retained alike)
  const youngRow = (row: JsonRecord): JsonRecord => withoutYoungReturns(row, inceptionIso || null, row.asOfDate ?? null, YOUNG_ROW_HORIZONS);
  const returns: JsonRecord = { monthEnd: youngRow(chosenReturns.monthEnd), quarterEnd: youngRow(chosenReturns.quarterEnd) };
  const pricePoint = official.history.length ? official.history[official.history.length - 1] : null;
  const yahooPoint = yahooPoints.length ? yahooPoints[yahooPoints.length - 1] : null;
  const navValue = pricePoint?.nav ?? numberField(previousEntry, 'navValue') ?? numberField(record(previousMeta), 'navValue');
  const closePriceValue = pricePoint?.marketPrice ?? yahoo?.regularMarketPrice ?? yahooPoint?.close ?? numberField(previousEntry, 'closePriceValue') ?? numberField(record(previousMeta), 'closePriceValue');
  const premiumDiscountValue = pricePoint?.premiumDiscount ?? numberField(previousEntry, 'premiumDiscountValue') ?? numberField(record(previousMeta), 'premiumDiscountValue');
  const distributions = distributionData(yahoo, previousCombined, referenceDate, closePriceValue);
  const aumValue = overview?.netAssets ?? numberField(previousEntry, 'aumValue') ?? numberField(record(previousMeta), 'aumValue');
  const terValue = overview?.expenseRatio ?? numberField(previousEntry, 'terValue') ?? numberField(record(previousMeta), 'terValue');
  // An honest null from a parsed overview stays null; the previous yield survives only an outage.
  const secYield = overview ? overview.secYield : numberField(previousMetrics, 'secYield');
  const resolvedMetrics = resolveReturnMetrics(
    officialUnit ? record(publishedReturns.metrics) : {},
    yahooUnit ? record(yahooReturns.metrics) : {},
    officialUnit || yahooUnit ? {} : previousReturnMetrics,
  );
  const returnMetrics = withoutYoungReturns(resolvedMetrics, inceptionIso || null, resolvedMetrics.performanceAsOf ?? null, YOUNG_METRIC_HORIZONS);
  const metrics: JsonRecord = buildFundMetrics(returnMetrics, distributions.indicatedYield, secYield, distributions.yieldBasis);
  const asOfIso = historyAsOfDate || official.history[official.history.length - 1]?.date || overview?.asOfDate || toIsoDate(previousEntry.asOfDate);
  const asOfDate = asOfIso ? displayDate(asOfIso) : stringField(previousEntry, 'asOfDate', '—');
  const ter = terValue === null ? stringField(previousEntry, 'ter', stringField(record(previousMeta), 'ter', '—')) : formatPercent(terValue);
  const aum = overview?.netAssetsText || stringField(previousEntry, 'aum', stringField(record(previousMeta), 'aum', formatMoney(aumValue)));
  const nav = navValue === null ? stringField(previousEntry, 'nav', '—') : formatPrice(navValue);
  const closePrice = closePriceValue === null ? stringField(previousEntry, 'closePrice', stringField(record(previousMeta), 'closePrice', '—')) : formatPrice(closePriceValue);
  const premiumDiscount = premiumDiscountValue === null ? stringField(previousEntry, 'premiumDiscount', stringField(record(previousMeta), 'premiumDiscount', '—')) : formatPercent(premiumDiscountValue, 4);
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
    // Always printed (not only with VERBOSE): a stale snapshot must not be published silently.
    onWarn(`[ ${'stale'.padEnd(9)}] ${fund.ticker} holdings CSV snapshot is ${holdingsAgeDays} days old (as of ${holdingsAsOfDate}); the source date is preserved and HTTP 200 is not treated as evidence of freshness.`);
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
    generatedAt: isoStamp(),
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
      dividendYieldBasis: metrics.dividendYieldBasis,
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
  // Order: pages, then meta.json, then stale-page removal (a crash never leaves meta pointing at removed pages).
  await prunePages(path.join(fundDirectory, 'holdings'), Math.ceil(holdingsRows.length / config.holdingsPageSize));
  await prunePages(path.join(fundDirectory, 'history'), Math.ceil(historyRows.length / config.historyPageSize));

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
  onWarn?: (message: string) => void;
  /** Soft deadline: no new fund is started after this many milliseconds (default 25 minutes; workflow limit is 30). */
  deadlineMs?: number;
};

export const RUN_SOFT_DEADLINE_MS = 25 * 60_000;

export type RunUpdaterReport = {
  selectedTickers: string[];
  processedTickers: string[];
  filteredTickers: string[];
  failedTickers: string[];
  nextCursor: number | null;
  indexPath: string;
  newFunds: string[];
  deadlineReached: boolean;
};

function seedIndexEntry(fund: ArkFund): JsonRecord {
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: null,
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
      dividendYield: null, dividendYieldText: null, dividendYieldBasis: null, secYield: null, secYieldText: null,
      returnsBasis: UNAVAILABLE_RETURNS_BASIS, performanceAsOf: null,
    },
    holdings: 0,
    history: 0,
  };
}

/** Insert `dividendYieldBasis` after `dividendYieldText`; a legacy row's code comes from its meta kind text. */
function withYieldBasisKey(metrics: JsonRecord, apiRoot: string, ticker: string): JsonRecord {
  const yieldValue = numberOrNull(metrics.dividendYield);
  let kind = '';
  if (yieldValue !== null && !YIELD_BASIS_CODES.some((code) => code === metrics.dividendYieldBasis)) {
    try {
      kind = stringField(record(record(JSON.parse(readFileSync(path.join(apiRoot, 'funds', ticker, 'meta.json'), 'utf8'))).yields), 'dividendYieldKind');
    } catch { /* no meta: the yield can only be an updater estimate */ }
  }
  const code = resolveYieldBasis(yieldValue, metrics.dividendYieldBasis, kind);
  const out: JsonRecord = {};
  let placed = false;
  for (const [key, value] of Object.entries(metrics)) {
    if (key === 'dividendYieldBasis') continue;
    out[key] = value;
    if (key === 'dividendYieldText') { out.dividendYieldBasis = code; placed = true; }
  }
  if (!placed) out.dividendYieldBasis = code;
  return out;
}

/** Index rows: the published rows without stale catalog-only rows (Q27), then a placeholder for every catalog fund still missing. */
function mergeCatalogEntries(previousRows: JsonRecord[], live: string[]): Map<string, JsonRecord> {
  const entries = new Map<string, JsonRecord>();
  for (const entry of withoutStalePlaceholders(previousRows, live)) {
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

type CursorScope = { cursor: number; tickers: string[] };

/** Cursor state holds one scope per candidate set, so a TICKERS/filtered run never overwrites the full-feed cursor. */
function readCursorScopes(state: JsonRecord | null): Record<string, CursorScope> {
  const scopes: Record<string, CursorScope> = {};
  const nested = record(state?.scopes);
  for (const [key, raw] of Object.entries(nested)) {
    const entry = record(raw);
    scopes[key] = { cursor: Math.max(0, Math.floor(numberOrNull(entry.cursor) ?? 0)), tickers: stringArray(entry.tickers) };
  }
  const legacyTickers = stringArray(state?.tickers);
  if (!Object.keys(nested).length && legacyTickers.length) scopes[legacyTickers.join(',')] = { cursor: Math.max(0, Math.floor(numberOrNull(state?.cursor) ?? 0)), tickers: legacyTickers };
  return scopes;
}

export async function runUpdater(options: RunUpdaterOptions = {}): Promise<RunUpdaterReport> {
  const config = options.config ?? readConfig(options.env ?? process.env);
  const apiRoot = options.apiRoot ?? API_ROOT;
  const referenceDate = options.referenceDate ?? new Date();
  const onNote = options.onNote ?? outputNote;
  const onWarn = options.onWarn ?? ((message: string) => console.warn(message));
  const now = options.runtime?.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = options.deadlineMs ?? RUN_SOFT_DEADLINE_MS;
  const clients = options.clients ?? createRequestClients(config, options.runtime);
  const previousIndex = await readJsonRecord(path.join(apiRoot, 'index.json'));
  const previousRows = arrayValue(previousIndex?.funds).map(record);
  // The fixed catalog is the live fund list (the official page only confirms it): a catalog-only row it no longer lists is dropped.
  const live = ARK_FUNDS.map((fund) => fund.ticker);
  // Q27: a TICKERS entry outside the catalog and the published funds stops the run before any request
  assertKnownTickers(config.tickers.length ? config.tickers : null, knownTickers(live, previousRows), 'the ARK catalog or published feed');
  outputPrintConfig('ARK Invest', { ...config });

  // Funds the official ETF page lists that this built-in catalog does not know. The 14-fund catalog stays hard-coded:
  // the official page only lists fund slugs (no names, CSV file names or trust data), so a new fund cannot be
  // fully described automatically - it is detected and reported, and must be added to ARK_FUNDS.
  let unlistedOnPage: string[] = [];
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
      unlistedOnPage = detectUnlistedArkFunds(catalogPage.text);
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

  const indexEntries = mergeCatalogEntries(previousRows, live);
  const staticSelection = ARK_FUNDS.filter((fund) => passesStaticFilters(fund, config));
  outputPrintFilter(staticSelection.length, ARK_FUNDS.length, hasDeferredFilters(config));
  // The cursor counts only funds that can pass the data filters: published rows are pre-checked, never-published funds stay in.
  // A closed fund leaves the queue here, before the cursor and MAX_FETCHES budget: it is never fetched, guarded or reported.
  const candidates = withoutClosedFunds(hasDeferredFilters(config)
    ? staticSelection.filter((fund) => {
      const entry = indexEntries.get(fund.ticker);
      return !entry || !entry.dataFile || passesMetricFilters(entry, config);
    })
    : staticSelection, (fund) => fund.ticker, CLOSED_FUNDS);

  let selectedFunds = candidates;
  let nextCursor: number | null = null;
  let startCursor = 0;
  const stateFile = path.join(apiRoot, 'update-state.json');
  const scopeKey = candidates.map((fund) => fund.ticker).join(',');
  let scopes: Record<string, CursorScope> = {};
  if (config.maxFetches > 0) {
    scopes = readCursorScopes(await readJsonRecord(stateFile));
    const saved = scopes[scopeKey];
    const total = candidates.length;
    startCursor = saved && total ? saved.cursor % total : 0;
    const count = Math.min(config.maxFetches, total);
    // Wrap around the end of the candidate list so every batch is full-sized.
    selectedFunds = Array.from({ length: count }, (_, offset) => candidates[(startCursor + offset) % total]);
    nextCursor = total ? (startCursor + count) % total : 0;
    console.log(`[ ${'cursor'.padEnd(9)}] starting at ${total ? startCursor + 1 : 0} of ${total}; processing ${selectedFunds.length}; next ${total ? nextCursor + 1 : 0}`);
  } else if (!config.tickers.length && existsSync(stateFile)) {
    // A full refresh resets the cursor; a TICKERS run never touches the cursor state.
    await rm(stateFile, { force: true });
  }

  if (clients.isArkProxyActive() && !outputVerbose()) {
    console.warn(`[ ${'issuer'.padEnd(9)}] ARK direct requests are denied from this network; using the read-only r.jina.ai proxy for remaining issuer requests`);
  }
  const reporter = outputCreateReporter(apiRoot, selectedFunds.length);
  const secFallback = config.edgarFallback ? createSecFallbackResolver(clients) : undefined;
  const processedTickers: string[] = [];
  const filteredTickers: string[] = [];
  const failedTickers: string[] = [];
  let nextFundIndex = 0;
  let deadlineReached = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (now() - startedAt >= deadlineMs) {
        if (nextFundIndex < selectedFunds.length && !deadlineReached) {
          deadlineReached = true;
          console.warn(`[ ${'deadline'.padEnd(9)}] soft deadline of ${Math.round(deadlineMs / 1000)}s reached; ${selectedFunds.length - nextFundIndex} fund(s) not started, the index is still written`);
        }
        return;
      }
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
          onWarn,
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
  if (config.maxFetches > 0 && deadlineReached) {
    // Only funds that were actually started count towards the cursor, in queue order.
    const total = candidates.length;
    nextCursor = total ? (startCursor + Math.min(nextFundIndex, selectedFunds.length)) % total : 0;
  }

  // dataFile mirrors the files on disk: a row without funds/<T>/meta.json points nowhere.
  for (const entry of indexEntries.values()) {
    const ticker = cleanText(entry.ticker);
    entry.dataFile = existsSync(path.join(apiRoot, 'funds', ticker, 'meta.json')) ? `funds/${ticker}/meta.json` : null;
  }
  // Every row (fresh, kept, unselected, legacy) carries the same key set, the code next to the yield it describes.
  for (const entry of indexEntries.values()) entry.metrics = withYieldBasisKey(record(entry.metrics), apiRoot, cleanText(entry.ticker));
  const sortedEntries = markClosedFunds([...indexEntries.values()].sort((a, b) => cleanText(a.ticker).localeCompare(cleanText(b.ticker))), CLOSED_FUNDS);
  const indexDocument: JsonRecord = {
    ...(previousIndex ?? {}),
    brand: 'ARK Invest',
    generatedAt: isoStamp(),
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
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as
  // pending; a fund the official page lists that ARK_FUNDS lacks is named too, it has to be added to the catalog by hand
  const report = newFundsReport(previousRows, sortedEntries);
  const newFundLines = newFundsLines(report);
  if (unlistedOnPage.length) newFundLines.push(`NEW FUNDS (not in the ARK catalog): ${unlistedOnPage.join(', ')} listed on ${ARK_CATALOG_URL} but missing from ARK_FUNDS: add them to the catalog`);
  for (const line of newFundLines) console.log(line);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (newFundLines.length && summaryFile) await appendFile(summaryFile, `### NEW FUNDS\n\n${newFundLines.join('\n')}\n`, 'utf8').catch(() => undefined);
  const newFunds = Array.from(new Set(report.published.concat(report.pending, unlistedOnPage))).sort();
  if (config.maxFetches > 0) {
    scopes[scopeKey] = { cursor: nextCursor ?? 0, tickers: candidates.map((fund) => fund.ticker) };
    await writeJsonIfChanged(stateFile, { scopes, generatedAt: isoStamp() });
  }
  console.log(reporter.summary(startedAt));
  const counts = indexDocument.counts as { funds: number; holdings: number; history: number };
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));

  return {
    selectedTickers: selectedFunds.map((fund) => fund.ticker),
    processedTickers,
    filteredTickers,
    failedTickers,
    nextCursor,
    indexPath,
    newFunds,
    deadlineReached,
  };
}

// File defaults and explicit overrides, same mechanism as the sibling
// daggerok/aberdeen and daggerok/Capital-Group updaters: allowlisted scalar
// controls only, so GitHub Actions can resolve them without interpolating user
// input into bash. Precedence: config file < advanced JSON < nonblank inputs <
// environment (`ARK_<KEY>` alias wins over `<KEY>`).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'TICKERS',
  'CATEGORY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES', 'HISTORY_RANGE', 'SEC_UA',
  'SKIP_YAHOO', 'SKIP_ARK', 'EDGAR_FALLBACK', 'VERBOSE', 'USE_SYSTEM_CA',
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
    const aliases = key === 'HISTORY_PAGE_SIZE' ? ['HISTORICAL_PAGE_SIZE'] : [];
    // ARK_<KEY> wins over <KEY>; the legacy HISTORICAL_PAGE_SIZE spelling stays a working alias.
    const value = env[`ARK_${key}`] ?? aliases.map((alias) => env[`ARK_${alias}`]).find((v) => v !== undefined) ?? env[key] ?? aliases.map((alias) => env[alias]).find((v) => v !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key];
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['SKIP_YAHOO', 'SKIP_ARK', 'EDGAR_FALLBACK', 'VERBOSE']) {
    if (result[key] && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key])) throw new Error(`${key}: expected boolean`);
  }
  if (result.USE_SYSTEM_CA) {
    const mode = result.USE_SYSTEM_CA.toLowerCase();
    if (!['auto', 'true', 'false'].includes(mode)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
    result.USE_SYSTEM_CA = mode;
  }
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

export async function main(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env, options: RunUpdaterOptions = {}): Promise<RunUpdaterReport | void> {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    return;
  }
  if (argv.length) throw new Error(`unsupported argument(s): ${argv.join(' ')}. Use --help for usage.`);
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  installSystemCa(controls.USE_SYSTEM_CA ?? 'auto');
  const report = await runUpdater({ ...options, config: readConfig(controls) });
  // Every selected fund failed: the run produced nothing, so the CI step must not look green.
  if (report.processedTickers.length > 0 && report.failedTickers.length === report.processedTickers.length) process.exitCode = 1;
  return report;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : cleanText(error);
    console.error(`[ ${'error'.padEnd(9)}] ${cleanText(detail)}`);
    process.exitCode = 1;
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, or with a foreign ISIN when the Nasdaq Trader directories list that ticker for the same company (a U.S.
 *   listing such as Linde, NXP, IMAX); renamed issuers through `nportRenamedIssuers`; an abbreviated or reordered name the
 *   exact key misses through a looser key that must name one company (`nportLooseKey`, Q35: `Lowe's Cos` = `LOWES COMPANIES`,
 *   `SCHWAB CHARLES CORP`); never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/**
 * Abbreviated words of issuer names (open-items etfs Q35) -> one spelling, each seen in N-PORT-P filings of the brands against
 * the SEC company_tickers.json title of the same CUSIP issuer (2026-10-26): `LOWES COS` / `LOWES COMPANIES`, `AMERIPRISE FINL`,
 * `VICI PPTYS`, `TAIWAN SEMICONDUCTOR MFG`, `ZIONS BANCORP NA` / `ZIONS BANCORPORATION NATIONAL ASSOCIATION`. '' drops the word.
 */
function nportLooseWords(): Record<string, string> {
  return {
    COS: '', COMPANIES: '', AND: '', OF: '', NA: '', NATIONAL_ASSOCIATION: '', INCORPORATION: '', REIT: '',
    BANCORPORATION: 'BANCORP', FINL: 'FINANCIAL', PPTYS: 'PROPERTIES', PPTY: 'PROPERTY', MFG: 'MANUFACTURING', GRP: 'GROUP',
    HLDGS: 'HOLDINGS', HLDG: 'HOLDING', INTL: 'INTERNATIONAL', SVCS: 'SERVICES', TECH: 'TECHNOLOGIES', TECHNOLOGY: 'TECHNOLOGIES',
    SYS: 'SYSTEMS', NATL: 'NATIONAL', RES: 'RESOURCES', RLTY: 'REALTY', INDS: 'INDUSTRIES', INS: 'INSURANCE', BROS: 'BROTHERS', SVGS: 'SAVINGS',
  };
}

/**
 * The second, looser company key (open-items etfs Q35), used only for a row the exact key (`nportNameKey`) left without a
 * ticker: a Bloomberg location or article after a slash dropped (`Charles Schwab Corp/The`, `Energy Fuels Inc/canada`; never a
 * one-word start like `RE/MAX`), abbreviations read as one word (`nportLooseWords`), the share class dropped (the caller picks
 * the class) and the words sorted, so EDGAR's reordered titles meet the usual order: `SCHWAB CHARLES CORP` = `Charles Schwab
 * Corp`, `HORTON D R INC` = `DR Horton Inc`, `PRICE T ROWE GROUP INC` = `T Rowe Price Group Inc`. Several companies can share a
 * loose key: `parseSecCompanyNames` and `parseUsListings` keep such a key empty, so it never gives a ticker.
 */
export function nportLooseKey(value: unknown): string {
  let raw = String(value === null || value === undefined ? '' : value).trim();
  const slash = /^(.*\s\S*[A-Za-z]{2}[.,]?)\s*\/\s*([A-Za-z][A-Za-z .,']*)$/.exec(raw);
  if (slash) raw = slash[1];
  // a trailing EDGAR or Bloomberg qualifier after the legal form: `CHEVRON CORP NEW`, `US BANCORP DEL`, `PROGRESSIVE CORP OHIO`
  raw = raw.replace(/\b(CORP(?:ORATION)?|INC(?:ORPORATED)?|CO(?:MPANY)?|LTD|BANCORP|GROUP|GRP|TRUST|HOLDINGS?)\.?,?\s+(?:NEW|DEL|REINCORPORATION|OHIO|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\.?$/i, '$1');
  const words = nportLooseWords();
  const key = nportNameKey(raw).replace(/ CL [A-Z]$/, '').replace(/\bNATIONAL ASSOCIATION\b/g, 'NATIONAL_ASSOCIATION');
  return key.split(' ').map((word) => (Object.prototype.hasOwnProperty.call(words, word) ? words[word] : word)).filter(Boolean).sort().join(' ');
}

/**
 * SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too).
 * Each loose key (`nportLooseKey`) is added as `\u0001<loose key>` -> the company's tickers, space-separated in the table's
 * order, or '' when two companies (CIKs) share it; `nportTickers` reads them for rows the exact key misses.
 */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const loose = new Map<string, { cik: string; tickers: string[] } | null>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown; cik_str?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
    const looseKey = nportLooseKey(row.title);
    const cik = String(row.cik_str === null || row.cik_str === undefined ? '' : row.cik_str).replace(/\D/g, '');
    if (!looseKey || !Number(cik)) continue;
    const seen = loose.get(looseKey);
    if (seen === undefined) loose.set(looseKey, { cik: String(Number(cik)), tickers: [ticker] });
    else if (seen && seen.cik === String(Number(cik))) { if (seen.tickers.indexOf(ticker) < 0) seen.tickers.push(ticker); }
    else loose.set(looseKey, null);
  }
  loose.forEach((seen, looseKey) => names.set(`\u0001${looseKey}`, seen ? seen.tickers.join(' ') : ''));
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Renamed issuers (open-items etfs Q33): N-PORT filers keep an issuer's old name for months while SEC's company_tickers.json
 * titles only the new one, so the name match misses (JPMorgan JEPI's Exxon). Old name key (`nportNameKey`) -> [ticker, CUSIP
 * issuer number (the first six characters)]. Used only when the SEC table has no such key, the row's CUSIP (or U.S. ISIN) has
 * that issuer number and the SEC table still lists the ticker. Each entry was confirmed on 2026-10-26: an EC row without a
 * ticker in the N-PORT-P filings of large U.S. equity funds (VTI, SCHB, ITOT, JEPI, IWB, VB, SCHA, FNDX, FNDA, ...) whose name
 * is a former EDGAR name of the CIK that has the ticker today (data.sec.gov submissions `formerNames`, the date the old name
 * ended), the ticker the CIK's only common stock in the Nasdaq Trader directories. Add an entry only with the same evidence.
 * A function, not a const: blocks sit at the end of update-data.ts, below the top-level run, so only declarations are hoisted.
 */
export function nportRenamedIssuers(): Array<[string, string, string]> {
  return [
    ['AADI BIOSCIENCE', 'WHWK', '00032Q'], // CIK 1422142 Whitehawk Therapeutics, Inc., former EDGAR name until 2025-03-18
    ['ABACUS LIFE', 'ABX', '00258Y'], // CIK 1814287 Abacus Global Management, Inc., former EDGAR name until 2025-02-04
    ['ACUITY BRANDS', 'AYI', '00508Y'], // CIK 1144215 ACUITY INC. (DE), former EDGAR name until 2025-04-17
    ['AEROVATE THERAPEUTICS', 'JBIO', '008064'], // CIK 1798749 Jade Biosciences, Inc., former EDGAR name until 2025-04-30
    ['AILERON THERAPEUTICS', 'RNTX', '00887A'], // CIK 1420565 Rein Therapeutics, Inc., former EDGAR name until 2024-12-09
    ['ALLOVIR', 'KLRS', '482929'], // CIK 1754068 Kalaris Therapeutics, Inc., former EDGAR name until 2025-03-12
    ['AMC NETWORKS', 'AMCX', '00164V'], // CIK 1514991 AMC Global Media Inc., former EDGAR name until 2026-04-03
    ['AMMO', 'POWW', '00175J'], // CIK 1015383 Outdoor Holding Co, former EDGAR name until 2025-04-24
    ['ARDENT HEALTH PARTNERS', 'ARDT', '03980N'], // CIK 1756655 Ardent Health, Inc., former EDGAR name until 2025-05-23
    ['ARENA GROUP HOLDINGS', 'PAAI', '040044'], // CIK 894871 Paradium.AI, Inc., former EDGAR name until 2026-08-13
    ['ATEGRITY SPECIALTY HOLDINGS LLC', 'ASIC', '04681Y'], // CIK 2040491 Ategrity Specialty Insurance Co Holdings, former EDGAR name until 2025-06-11
    ['BAKKT HOLDINGS', 'BKKT', '05759B'], // CIK 1820302 Bakkt, Inc., former EDGAR name until 2026-01-20
    ['BED BATH AND BEYOND', 'NXH', '690370'], // CIK 1130713 NEIGHBORHOOD INTELLIGENCE, INC., former EDGAR name until 2026-08-14
    ['BLACKROCK FUNDING', 'BLK', '09290D'], // CIK 2012383 BlackRock, Inc., former EDGAR name until 2024-10-01
    ['BRIGHTSPHERE INVESTMENT GROUP', 'AAMI', '10948W'], // CIK 1748824 Acadian Asset Management Inc., former EDGAR name until 2024-11-14
    ['CARA THERAPEUTICS', 'TVRD', '140755'], // CIK 1346830 Tvardi Therapeutics, Inc., former EDGAR name until 2025-04-11
    ['CEA INDUSTRIES', 'BNC', '86887P'], // CIK 1482541 BNB Standard Corp, former EDGAR name until 2026-09-21
    ['CHROMADEX', 'NAGE', '171077'], // CIK 1386570 Niagen Bioscience, Inc., former EDGAR name until 2025-03-10
    ['CLEANCORE SOLUTIONS', 'ZONE', '184492'], // CIK 1956741 Zone Frontier Inc., former EDGAR name until 2026-08-20
    ['CORPORATE OFFICE PROPERTIES TRUST', 'CDP', '22002T'], // CIK 860546 COPT DEFENSE PROPERTIES, former EDGAR name until 2023-09-14
    ['CULLINAN ONCOLOGY', 'CGEM', '230031'], // CIK 1789972 Cullinan Therapeutics, Inc., former EDGAR name until 2024-04-02
    ['DIME COMMUNITY BANCSHARES', 'DCOM', '25432X'], // CIK 846617 Dime Commercial Bancshares, Inc. /NY/, former EDGAR name until 2026-05-27
    ['DOMO', 'HUCK', '257554'], // CIK 1505952 Huckleberry.ai, Inc., former EDGAR name until 2026-09-03
    ['EASTSIDE DISTILLING', 'BLNE', '277802'], // CIK 1534708 Beeline Holdings, Inc., former EDGAR name until 2025-03-11
    ['EQUITY RESIDENTIAL', 'VMRK', '29476L'], // CIK 906107 VIVMARK RESIDENTIAL, former EDGAR name until 2026-08-12
    ['EXP WORLD HOLDINGS', 'AGNT', '30212W'], // CIK 1495932 AGNT, Inc., former EDGAR name until 2026-06-01
    ['EXXON MOBIL', 'XOM', '30231G'], // holding company reorganization: XOM is CIK 2115436 ExxonMobil Holdings Corp since 2026, the old Exxon Mobil Corp is CIK 34088
    ['EYEPOINT PHARMACEUTICALS', 'EYPT', '30233G'], // CIK 1314102 EyePoint, Inc., former EDGAR name until 2025-12-08
    ['EZFILL HOLDINGS', 'NXXT', '652941'], // CIK 1817004 NEXTNRG, INC., former EDGAR name until 2025-02-14
    ['FORTUNE BRANDS HOME AND SECURITY', 'FBIN', '34964C'], // CIK 1519751 Fortune Brands Innovations, Inc., former EDGAR name until 2022-12-14
    ['FRANKLIN RESOURCES', 'BEN', '354613'], // CIK 38777 FRANKLIN TEMPLETON INC, former EDGAR name until 2026-08-14
    ['FREYR BATTERY', 'TE', '35834F'], // CIK 1992243 T1 Energy Inc., former EDGAR name until 2025-02-14
    ['GALLAGHER ARTHUR J AND', 'AJG', '363576'], // CIK 354190 Arthur J. Gallagher & Co., former EDGAR name until 2019-08-14
    ['GRAINGER WW', 'GWW', '384802'], // CIK 277135 W.W. GRAINGER, INC., former EDGAR name until 2019-10-15
    ['GRAY TELEVISION', 'GTN', '389375'], // CIK 43196 GRAY MEDIA, INC, former EDGAR name until 2025-02-24
    ['GREAT AJAX', 'RPT', '38983D'], // CIK 1614806 Rithm Property Trust Inc., former EDGAR name until 2024-11-13
    ['GREENIDGE GENERATION HOLDINGS', 'VIP', '39531G'], // CIK 1844971 Vulcan Infrastructure & Power Inc., former EDGAR name until 2026-07-09
    ['HANNON ARMSTRONG SUSTAINABLE INFRASTRUCTURE CAPITAL', 'HASI', '41068X'], // CIK 1561894 HA Sustainable Infrastructure Capital, Inc., former EDGAR name until 2024-07-02
    ['HARTFORD FINANCIAL SERVICES GROUP', 'HIG', '416515'], // CIK 874766 HARTFORD INSURANCE GROUP, INC., former EDGAR name until 2025-01-30
    ['HELIX ENERGY SOLUTIONS GROUP', 'HOS', '42330P'], // CIK 866829 HORNBECK OFFSHORE SERVICES, INC., former EDGAR name until 2026-08-31
    ['HYSTER YALE MATERIALS HANDLING', 'HY', '449172'], // CIK 1173514 HYSTER-YALE, INC., former EDGAR name until 2024-05-30
    ['IAC', 'PPLI', '44891N'], // CIK 1800227 People Inc, former EDGAR name until 2026-06-02
    ['IDENTIV', 'INVE', '45170X'], // CIK 1036044 INVE Technologies, Inc., former EDGAR name until 2026-08-25
    ['IRHYTHM TECHNOLOGIES', 'IRTC', '450056'], // CIK 1388658 iRhythm Holdings, Inc., former EDGAR name until 2026-01-12
    ['ISSUER DIRECT', 'ACCS', '46520M'], // CIK 843006 ACCESS Newswire Inc., former EDGAR name until 2025-01-16
    ['JANOVER', 'DFDV', '47100L'], // CIK 1805526 DeFi Development Corp., former EDGAR name until 2025-04-15
    ['JOHN BEAN TECHNOLOGIES', 'JBTM', '477839'], // CIK 1433660 JBT MAREL Corp, former EDGAR name until 2024-12-20
    ['LENDINGCLUB', 'HAPN', '52603A'], // CIK 1409970 Happen, Inc., former EDGAR name until 2026-06-18
    ['LIXTE BIOTECHNOLOGY HOLDINGS', 'NMAD', '539319'], // CIK 1335105 NOMAD POWER SOLUTIONS, INC., former EDGAR name until 2026-07-02
    ['MKS INSTRUMENTS', 'MKSI', '55306N'], // CIK 1049502 MKS INC, former EDGAR name until 2025-05-15
    ['MONTANA TECHNOLOGIES', 'AIRJ', '612160'], // CIK 1855474 AirJoule Technologies Corp., former EDGAR name until 2024-10-21
    ['MULTIPLAN', 'CTEV', '62548M'], // CIK 1793229 Claritev Corp, former EDGAR name until 2025-02-07
    ['NEWPARK RESOURCES', 'NPKI', '651718'], // CIK 71829 NPK International Inc., former EDGAR name until 2024-12-03
    ['ONCOLOGY INSTITUTE', 'STLN', '68236X'], // CIK 1799191 Starling Oncology, Inc., former EDGAR name until 2026-08-03
    ['OREILLY AUTOMOTIVE', 'ORLY', '67103H'], // CIK 898173 O REILLY AUTOMOTIVE INC, former EDGAR name until 1998-04-10
    ['ORION OFFICE REIT', 'ONL', '68629Y'], // CIK 1873923 Orion Properties Inc., former EDGAR name until 2025-03-07
    ['PALTALK', 'IPM', '69764K'], // CIK 1355839 INTELLIGENT PROTECTION MANAGEMENT CORP., former EDGAR name until 2025-01-02
    ['PARAMOUNT SKYDANCE', 'SKYD', '69932A'], // CIK 2041610 Skydance Corp, former EDGAR name until 2026-10-06
    ['PIEDMONT OFFICE REALTY TRUST', 'PDM', '720190'], // CIK 1042776 Piedmont Realty Trust, Inc., former EDGAR name until 2025-06-02
    ['PIERIS PHARMACEUTICALS', 'PVLA', '697947'], // CIK 1583648 PALVELLA THERAPEUTICS, INC., former EDGAR name until 2024-12-12
    ['PLUS THERAPEUTICS', 'CNSY', '72941H'], // CIK 1095981 CERENOME, INC., former EDGAR name until 2026-07-01
    ['RUMBLE', 'RUM', '78137L'], // CIK 1830081 RUM Group Inc., former EDGAR name until 2026-06-17
    ['SCHWEITZER MAUDUIT INTERNATIONAL', 'MATV', '808541'], // CIK 1000623 Mativ Holdings, Inc., former EDGAR name until 2022-07-01
    ['SEQLL', 'CIRC', '048592'], // CIK 1605888 CIRCLE8 GROUP INC, former EDGAR name until 2024-06-06
    ['SHOE CARNIVAL', 'SHOE', '824889'], // CIK 895447 SHOE STATION GROUP INC, former EDGAR name until 2026-06-11
    ['TANGER FACTORY OUTLET CENTERS', 'SKT', '875465'], // CIK 899715 TANGER INC., former EDGAR name until 2023-11-15
    ['TECNOGLASS', 'TGLS', '87877F'], // CIK 1534675 Tecnoglass Holdings Inc., former EDGAR name until 2026-07-07
    ['TEMPUR SEALY INTERNATIONAL', 'SGI', '88023U'], // CIK 1206264 SOMNIGROUP INTERNATIONAL INC., former EDGAR name until 2025-02-14
    ['TEVOGEN BIO HOLDINGS', 'TVGN', '88165K'], // CIK 1860871 Tevogen Inc., former EDGAR name until 2026-07-30
    ['TORO COMBINECO', 'TTGT', '87874R'], // CIK 2018064 TechTarget, Inc., former EDGAR name until 2024-11-20
    ['VIAD', 'PRSU', '92552R'], // CIK 884219 Pursuit Attractions & Hospitality, Inc., former EDGAR name until 2024-12-31
    ['WELLGISTICS HEALTH', 'MEDS', '949503'], // CIK 2030763 DataMeds AI, Inc., former EDGAR name until 2026-07-21
    ['ZOOM VIDEO COMMUNICATIONS', 'ZM', '98980L'], // CIK 1585521 Zoom Communications, Inc., former EDGAR name until 2024-11-12
    ['ZYMEWORKS DELAWARE', 'ZYME', '98985Y'], // CIK 1937653 Zymeworks Inc., former EDGAR name until 2022-10-13
  ];
}

/** Nasdaq Trader symbol directories: Nasdaq listings, and NYSE, NYSE American, NYSE Arca, Cboe and IEX listings. */
export function nportUsListingsUrls(): string[] {
  return ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'];
}

/**
 * The Nasdaq Trader symbol directories (the texts of `nportUsListingsUrls()`, in any order) as U.S.-listed symbol -> security
 * name; test issues and ETFs left out, CQS class dots as SEC dashes (`BRK.B` -> `BRK-B`). An issuer listed under several
 * symbols (Liberty Global LBTYA, LBTYB, LBTYK) also gets the entry `\u0000<name key>` -> its symbols, which `nportUsListed` reads
 * to require the share class. null unless every text is a whole directory (a header with Security Name and the File Creation
 * Time footer), so a failed or cut download changes nothing.
 */
export function parseUsListings(texts: ReadonlyArray<string>): Map<string, string> | null {
  const listings = new Map<string, string>();
  if (!texts.length) return null;
  for (let t = 0; t < texts.length; t++) {
    const lines = String(texts[t] === null || texts[t] === undefined ? '' : texts[t]).split(/\r?\n/).filter((line) => line.trim());
    const header = (lines[0] || '').split('|').map((cell) => cell.trim().toUpperCase());
    const nameAt = header.indexOf('SECURITY NAME'), testAt = header.indexOf('TEST ISSUE'), etfAt = header.indexOf('ETF');
    if (nameAt < 0 || !/^FILE CREATION TIME/i.test(lines[lines.length - 1] || '')) return null;
    for (let i = 1; i < lines.length - 1; i++) {
      const cells = lines[i].split('|');
      const symbol = String(cells[0] || '').trim().toUpperCase().replace(/[./ ]/g, '-');
      if (!symbol || String(cells[testAt] || '').trim() === 'Y' || String(cells[etfAt] || '').trim() === 'Y' || listings.has(symbol)) continue;
      listings.set(symbol, String(cells[nameAt] || '').trim());
    }
  }
  const issuers = new Map<string, string[]>();
  const loose = new Map<string, string[]>();
  listings.forEach((name, symbol) => {
    const key = nportNameKey(nportIssuerName(name));
    if (key) issuers.set(key, (issuers.get(key) || []).concat(symbol));
    const looseKey = nportLooseKey(nportIssuerName(name));
    if (looseKey && nportListedCommon(name)) loose.set(looseKey, (loose.get(looseKey) || []).concat(symbol));
  });
  issuers.forEach((symbols, key) => { if (symbols.length > 1) listings.set(`\u0000${key}`, symbols.join(' ')); });
  loose.forEach((symbols, looseKey) => listings.set(`\u0001${looseKey}`, symbols.join(' ')));
  return listings;
}

/** Is a symbol directory security name a company's own common or ordinary shares (not preferred, depositary, notes, warrants, units, rights)? */
function nportListedCommon(name: string): boolean {
  return !/\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b|\bPREFERRED\b|\bPREF\b|\bPFD\b|\bNOTES?\b|\bDEBENTURES?\b|\bWARRANTS?\b|\bUNITS?\b|\bRIGHTS?\b|%|\bDUE\s+\d{4}\b|\bPERPETUAL\b|\bCUMULATIVE\b|\bSUBORDINATED\b|\bTRUST\s+(?:SECURITIES|CERTIFICATES)\b|\bETNS?\b|\bEXCHANGE[- ]TRADED\b/i.test(name);
}

/** The share class a name or title states (`Class C`, `CL C`, `Series A`, `LIBERTY GLOBAL-C`), '' for none. */
function nportShareClass(...texts: unknown[]): string {
  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] === null || texts[i] === undefined ? '' : texts[i]);
    const match = /\b(?:CLASS|CL|SERIES|SER)\.?\s+([A-Z])\b/i.exec(text) || /[A-Z]-\s?([A-Z])(?:\s|$)/i.exec(text);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

/** Both symbol directories through the brand's `getText`, null when one fails (`parseUsListings`); load once per run. */
export async function readUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  try {
    return parseUsListings(await Promise.all(nportUsListingsUrls().map((url) => getText(url, `Nasdaq Trader ${url.replace(/^.*\//, '')}`))));
  } catch {
    return null;
  }
}

/** A security or sheet name without its share description: `Accenture plc Class A Ordinary Shares (Ireland)` -> `Accenture plc`. */
function nportIssuerName(value: unknown): string {
  return String(value === null || value === undefined ? '' : value).split(' - ')[0]
    .replace(/\s+(?:\(|(?:CLASS|SERIES)\s+[A-Z]\b|COMMON\b|ORDINARY\b|SUBORDINATE\b|SUB\.?\s+VOT|(?:LIMITED|RESTRICTED)\s+VOTING\b|VOTING\b|SHARES?\b|STOCK\b|AMERICAN\s+DEPOSITARY\b|TRADING\s+UNDER\b)[\s\S]*$/i, '');
}

/**
 * Is `ticker` the company's own U.S. listing? The Nasdaq Trader directories (`parseUsListings`) list it under the same company
 * (same name key, or one key the start of the other: `BUNGE GLOBAL` and the directory's `BUNGE`, a name cut short after two words
 * or more: `CHECK POINT SOFTWARE TECH`), and not as depositary or New York registry shares, which are another security than
 * the foreign line (Shell's SHEL ADR, ASML's New York shares). When the issuer has several listed classes, the name or title
 * must state the listed class (Liberty Latin America Class C is LILAK, not LILA). False without listings. Callers check that
 * the line trades in U.S. dollars: a Toronto or London line of the same company in its own currency never gets the U.S. ticker.
 */
export function nportUsListed(listings: Map<string, string> | null, ticker: string, name: unknown, title: unknown = ''): boolean {
  if (!listings) return false;
  const listed = listings.get(String(ticker).trim().toUpperCase().replace(/[./ ]/g, '-'));
  if (listed === undefined || /\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b/i.test(listed)) return false;
  const a = nportNameKey(nportIssuerName(listed)), b = nportNameKey(nportIssuerName(name));
  if (!a || !b) return false;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (a !== b && !(short.length >= 4 && long.indexOf(`${short} `) === 0) && !(short.split(' ').length >= 2 && long.indexOf(short) === 0)) return false;
  const listedClass = nportShareClass(listed);
  return !listedClass || !listings.has(`\u0000${a}`) || nportShareClass(name, title) === listedClass;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker):
 * - U.S. ISIN or none, traded in USD (or with no currency): the filer's own `<ticker value>`, else the SEC issuer-name table
 *   (`names`) when the row has a CUSIP or a U.S. ISIN, else a renamed issuer (`nportRenamedIssuers`)
 * - foreign ISIN (Linde IE, NXP NL, IMAX CA): only traded in USD and only when the symbol directories (`listings`,
 *   `parseUsListings`) confirm the filer's or the name-matched ticker for the same company (`nportUsListed`); a local line in
 *   another currency, and every foreign row without listings, gets none
 * A ticker that lands on two different securities (Alphabet A and C, an ordinary share and its ADR) is dropped from the
 * name-matched rows; when the filer itself gave it to two securities it is dropped from all of them. Rows still without a
 * ticker get the second, looser name match (`nportLooseTickers`), which never changes a ticker given here. Bonds, cash, funds
 * and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null, listings: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const secTickers = new Set<string>();
  if (names) names.forEach((ticker, key) => { if (key.charAt(0) !== '\u0001') secTickers.add(ticker); });
  const renames = nportRenamedIssuers();
  const renamed = (position: NportPosition, key: string): string => {
    const issuer = (position.cusip || (/^US[0-9A-Z]{10}$/.test(position.isin) ? position.isin.slice(2, 11) : '')).slice(0, 6);
    const hit = renames.filter((entry) => entry[0] === key && entry[2] === issuer && secTickers.has(entry[1]))[0];
    return hit ? hit[1] : '';
  };
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    const usd = foreign ? position.currency === 'USD' && Boolean(listings) : !position.currency || position.currency === 'USD';
    if (!equity || !usd) return '';
    const filer = /^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker) ? position.ticker : '';
    const key = nportNameKey(position.name);
    const named = names && (/^[0-9A-Z]{9}$/.test(position.cusip) || /^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) ? names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '' : '';
    if (!foreign) {
      fromFiler[index] = Boolean(filer);
      return filer || named || (names ? renamed(position, key) : '');
    }
    if (filer && nportUsListed(listings, filer, position.name, position.title)) {
      fromFiler[index] = true;
      return filer;
    }
    return named && nportUsListed(listings, named, position.name, position.title) ? named : '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  const exact = tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
  return nportLooseTickers(positions, exact, names, listings);
}

/**
 * The second name match (open-items etfs Q35) for the common-stock rows `nportTickers` left without a ticker; the tickers it
 * already gave never change. The row's loose key (`nportLooseKey`) must name one company: in the SEC table (`\u0001` entries of
 * `parseSecCompanyNames`, one CIK) and/or in the symbol directories (`\u0001` entries of `parseUsListings`, common shares only),
 * and when both know the key they must agree on the company. Of that company's tickers only its listed common shares count
 * (with one SEC ticker and no listing, that ticker); several of them (Fox, Lennar, Zillow) need the class the row states in its
 * name or title, matched to the listed security name, else no ticker. A foreign ISIN needs the directory listing of the same
 * key (its own U.S. shares, never depositary ones). A ticker that a row of `exact` holds for another security, or that this pass
 * finds for two securities, is dropped.
 */
function nportLooseTickers(positions: ReadonlyArray<NportPosition>, exact: string[], names: Map<string, string> | null, listings: Map<string, string> | null): string[] {
  if (!names) return exact;
  const companyOf = new Map<string, string>();
  names.forEach((tickers, key) => { if (key.charAt(0) === '\u0001' && tickers) tickers.split(' ').forEach((ticker) => companyOf.set(ticker, key)); });
  const securityOf = (position: NportPosition): string => position.cusip || position.isin || position.other || nportNameKey(position.name);
  const listedClass = (symbol: string): string => nportShareClass(listings ? listings.get(symbol) : '');
  const found = positions.map((position, index) => {
    if (exact[index] || position.assetCat !== 'EC' || position.derivative || nportIsRight(position)) return '';
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    if (foreign ? position.currency !== 'USD' || !listings : position.currency && position.currency !== 'USD') return '';
    if (!/^[0-9A-Z]{9}$/.test(position.cusip) && !/^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) return '';
    const key = nportLooseKey(position.name);
    if (!key) return '';
    const sec = names.get(`\u0001${key}`);
    const listed = listings ? listings.get(`\u0001${key}`) : undefined;
    if (sec === '' || (sec === undefined && listed === undefined) || (foreign && !listed)) return '';
    const listedSymbols = listed ? listed.split(' ') : [];
    // the company: the SEC entry of the key, else the one SEC entry every listed symbol of the key belongs to
    const company = sec !== undefined ? `\u0001${key}` : companyOf.get(listedSymbols[0]) || '';
    if (!company || listedSymbols.some((symbol) => companyOf.get(symbol) !== company)) return '';
    const tickers = String(names.get(company) || '').split(' ').filter(Boolean);
    const common = tickers.filter((ticker) => listings && listings.has(ticker) && nportListedCommon(String(listings.get(ticker))));
    const candidates = common.length ? common : tickers.length === 1 && !foreign ? tickers : [];
    if (foreign && candidates.some((ticker) => listedSymbols.indexOf(ticker) < 0)) return '';
    const wanted = nportShareClass(position.name, position.title);
    if (candidates.length === 1) return !wanted || !listings || !listings.has(candidates[0]) || !listedClass(candidates[0]) || listedClass(candidates[0]) === wanted ? candidates[0] : '';
    const classed = wanted ? candidates.filter((ticker) => listedClass(ticker) === wanted) : [];
    return classed.length === 1 ? classed[0] : '';
  });
  const taken = new Map<string, string[]>();
  exact.forEach((ticker, index) => { if (ticker) taken.set(ticker, (taken.get(ticker) || []).concat(securityOf(positions[index]))); });
  found.forEach((ticker, index) => {
    if (!ticker) return;
    const seen = taken.get(ticker) || [];
    if (seen.indexOf(securityOf(positions[index])) < 0) taken.set(ticker, seen.concat(securityOf(positions[index])));
  });
  return exact.map((ticker, index) => ticker || (found[index] && (taken.get(found[index]) || []).length === 1 ? found[index] : ''));
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
