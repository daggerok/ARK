/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('configuration precedence: file < advanced < nonblank input < environment/ARK_ alias', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'ARKK' }, { CONCURRENCY: 3, TICKERS: 'ARKQ' }, { CONCURRENCY: '4', TICKERS: '' }, { ARK_CONCURRENCY: '5', CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('5'); expect(c.TICKERS).toBe('ARKQ');
  expect(resolveControls({ TICKERS: 'ARKK' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  expect(readConfig(resolveControls({ MAX_RETRIES: 0 })).maxRetries).toBe(0);
  expect(readConfig(resolveControls({ CATEGORY: 'Thematic' })).category).toBe('Thematic');
});

test('safe resolver rejects unknown, invalid and environment-file injection values', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TICKERS: ['ARKK'] }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { ARK_SEC_UA: 'x\0bad' })).toThrow();
});

test('all canonical controls defaulted in tracked JSON; controls, README and USAGE in sync', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  const config = readConfig(resolveControls(file));
  expect(config.tickers).toEqual([]); expect(config.maxFetches).toBe(0); expect(config.requestSleepSeconds).toBe(1.5); expect(config.concurrency).toBe(2);
  const doc = read('README.md');
  // README lists the five tenors of PERFORMANCE_* / TOTAL_RETURN_* on one row: `PREFIX_YTD` / `_1Y` / ... (the parity guard in update-data.test.ts expands them).
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(doc).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(doc).toContain('`' + tenor[1] + '_YTD`');
  }
  expect(doc).toContain('scripts/update-data.config.json');
});

test('CI is the pinned aberdeen/Capital-Group mechanism with exactly the permitted ARK adaptations', () => {
  const ref = read('evidence/config-reference/update-data.yml');
  const expected = ref
    .replaceAll('abrdn', 'ARK Invest')
    .replaceAll('api/aberdeen', 'api/ark')
    .replaceAll('Rows per market-price history JSON page', 'Rows per official NAV / fallback market-price history JSON page')
    .replaceAll('bun test scripts/update-data.test.ts', 'bun test')
    // Same per-worker concurrency amendment as Capital-Group: descriptions only.
    .replaceAll('Seconds between request starts including retries; conservative shared gate', 'Seconds between request starts per worker, including retries and the r.jina.ai issuer fallback')
    .replaceAll('Parallel fund workers; request starts remain conservatively paced', 'Independent parallel fund workers, each with its own request pacing')
    // ARK keeps full official history (no HISTORY_RANGE); CATEGORY takes that input slot.
    .replace('      history_range:\n        description: "Yahoo daily history range: max or Ny (e.g. 5y); preserves prior history; blank inherits scripts/update-data.config.json"',
      '      category:\n        description: "Keep funds whose category contains this text (case-insensitive); blank inherits scripts/update-data.config.json"');
  const actual = read('.github/workflows/update-data.yml');
  expect(actual).toBe(expected);
  const names = [...actual.slice(actual.indexOf('    inputs:'), actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBe(25); expect(names).toContain('advanced'); expect(names).toContain('category'); expect(names).not.toContain('history_range');
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase());
  expect(actual).toContain("cron: '0 0 * * 0'"); expect(actual).not.toMatch(/^  push:/m);
  expect(actual).not.toContain('bunx tsc'); expect(actual).toContain('toJSON(inputs)');
  expect(actual).not.toMatch(/inputs\.\w+ \|\| '/); // no per-input shell/env interpolation of defaults
  expect(actual).toContain('git add api/ark\n          if git diff --cached --quiet -- api/ark');
  expect(actual).toContain('if: ${{ !cancelled() }}');
});
