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
  // Standard workflow generator output: same mechanism as the pinned reference plus the protected SEC_UA variable layer.
  const standard = expected
    .replace("description: 'JSON overrides for any canonical env control; individual nonblank inputs win'",
      "description: 'JSON object of supported control overrides not exposed above (keys are UPPER_CASE control names, values are scalars); nonblank individual inputs win'")
    .replace('          DISPATCH_INPUTS: ${{ toJSON(inputs) }}\n', '          DISPATCH_INPUTS: ${{ toJSON(inputs) }}\n          PROTECTED_SEC_UA: ${{ vars.SEC_UA }}\n')
    .replace('            import { appendFile } from "node:fs/promises";\n', '            import { appendFile } from "node:fs/promises";\n            // schedule runs have no dispatch inputs: file defaults apply as-is\n')
    .replace('            const controls = resolveControls(file, advanced, individual);',
      '            // Protected repository Actions variable: highest precedence, applied only when nonblank (never printed).\n            const protectedVars = {};\n            if ((process.env.PROTECTED_SEC_UA ?? "").trim()) protectedVars.SEC_UA = process.env.PROTECTED_SEC_UA.trim();\n            const controls = resolveControls(file, advanced, individual, protectedVars);')
    .replace('map(([key,value]) => `${key}=${value}\\n`)', 'map(([key, value]) => `${key}=${value}\\n`)');
  expect(actual).toBe(standard);
  const names = [...actual.slice(actual.indexOf('    inputs:'), actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBe(25); expect(names).toContain('advanced'); expect(names).toContain('category'); expect(names).not.toContain('history_range');
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase());
  expect(actual).toContain("cron: '0 0 * * 0'"); expect(actual).not.toMatch(/^  push:/m);
  expect(actual).not.toContain('bunx tsc'); expect(actual).toContain('toJSON(inputs)');
  expect(actual).not.toMatch(/inputs\.\w+ \|\| '/); // no per-input shell/env interpolation of defaults
  expect(actual).toContain('git add api/ark\n          if git diff --cached --quiet -- api/ark');
  expect(actual).toContain('if: ${{ !cancelled() }}');
});

test('scheduled path (empty inputs and advanced) equals config defaults; no personal contact in defaults', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(resolveControls(file, {}, {}, {})).toEqual(Object.fromEntries(Object.entries(file).map(([k, v]) => [k, String(v)])));
  expect(file.SEC_UA).not.toMatch(/@/);
  expect(file.SEC_UA).toContain('https://github.com/daggerok/ARK');
  expect(readConfig(resolveControls(file)).secUa).toBe(file.SEC_UA);
  expect(read('scripts/update-data.ts')).not.toMatch(/updater admin@/);
});

test('protected SEC_UA variable wins only when nonblank and invalid layers are rejected', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
  expect(resolveControls(file, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, {}).SEC_UA).toBe('in');
  expect(() => resolveControls(file, {}, {}, { SEC_UA: 'a\nb' })).toThrow();
  expect(() => resolveControls(file, 'x')).toThrow();
  expect(() => resolveControls(file, { UNKNOWN: 'x' })).toThrow();
  expect(() => resolveControls(file, {}, { TICKERS: { a: 1 } })).toThrow();
});

test('workflow keeps SEC_UA protected, output fixed to api/ark and has no output-dir input', () => {
  const actual = read('.github/workflows/update-data.yml');
  expect(actual).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
  expect(actual).toContain('resolveControls(file, advanced, individual, protectedVars)');
  expect(actual).not.toMatch(/OUTPUT_DIR|output_dir/i);
  expect(actual).not.toMatch(/\$\{\{\s*inputs\./);
  expect(actual).toContain("default: '{}'");
  expect(actual.match(/git add (\S+)/g)).toEqual(['git add api/ark']);
  expect(actual.match(/api\/[\w-]+/g)!.every((p) => p === 'api/ark')).toBe(true);
});
