import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  calculateRobloxGrowth,
  buildValidatedRobloxBatch,
  buildRobloxTransientCandidate,
  compactRobloxSnapshots,
  fetchWithTimeout,
  fetchRobloxGameMetadata,
  isSignificantRobloxRename,
  mergeRobloxDiscovery,
  normalizeRobloxTitle,
  parseRobloxChartsPayload,
  pruneRobloxObservationPool,
  RobloxSchemaValidationError,
  runRobloxDiscoveryTransaction,
  scanRobloxCharts,
} from '../lib/roblox-discovery.mjs';
import { calculateFastSignals } from '../lib/fast-signals.mjs';
import { allowsPaidRobloxVerification } from '../lib/roblox-fast-signals.mjs';
import { buildTodayReview } from '../lib/today-review.mjs';

const TOP = { id: 'roblox-top-trending', name: 'Roblox Top Trending', kind: 'roblox-chart', fetchKind: 'roblox-charts', chartName: 'Top Trending', enabled: true };
const UPCOMING = { id: 'roblox-up-and-coming', name: 'Roblox Up-and-Coming', kind: 'roblox-chart', fetchKind: 'roblox-charts', chartName: 'Up-and-Coming', enabled: true };
const fastResult = (classification, overrides = {}) => () => ({
  modelVersion: 3,
  profile: 'roblox',
  classification,
  score: classification === 'pass' ? 60 : classification === 'watch' ? 40 : 20,
  strongGrowth: false,
  ...overrides,
});
const realFast = (candidate, nowMs) => calculateFastSignals(candidate, {}, nowMs);

function response(status, payload, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name.toLowerCase()] || null }, json: async () => payload };
}

function chartPayload(name = 'Anime Fighters', universeId = '101') {
  return {
    sorts: [
      { sortId: 'dynamic-991', sortDisplayName: 'Top Trending', games: [{ universeId, rootPlaceId: '201', name, playing: 500, rank: 4, isSponsored: false }] },
      { sortId: 'dynamic-817', sortDisplayName: 'Up & Coming', games: [{ universeId, rootPlaceId: '201', name, playing: 500, rank: 12, isSponsored: false }] },
    ],
  };
}

function gameRow(universeId, overrides = {}) {
  return {
    id: universeId,
    rootPlaceId: String(Number(universeId) + 1000),
    name: `Game ${universeId}`,
    creator: { id: '301', name: 'Fixture Studio', type: 'Group' },
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-10T00:00:00Z',
    playing: 500,
    visits: 12000,
    favoritedCount: 900,
    genre_l1: 'RPG',
    genre_l2: 'Action RPG',
    ...overrides,
  };
}

function chartResultsFor(ids, overrides = {}) {
  return parseRobloxChartsPayload({
    sorts: [{
      sortDisplayName: 'Top Trending',
      games: ids.map((id, index) => ({ universeId: id, name: `Game ${id}`, rank: index + 1, isSponsored: false, ...overrides })),
    }],
  }, [TOP], '2026-09-10T00:00:00Z');
}

test('normalizes only known Roblox decorations conservatively', () => {
  assert.equal(normalizeRobloxTitle('[UPDATE 4] 🔥 Anime Fighters').normalizedKeyword, 'Anime Fighters');
  assert.equal(normalizeRobloxTitle('SCP: Site Roleplay (CONSOLE UPDATE!)').normalizedKeyword, 'SCP: Site Roleplay');
  assert.equal(normalizeRobloxTitle('Volleyball 4.2').normalizedKeyword, 'Volleyball 4.2');
  assert.equal(normalizeRobloxTitle('[King Crimson] Sakura Stand').normalizedKeyword, '[King Crimson] Sakura Stand');
  assert.equal(normalizeRobloxTitle('UPDATE 6 | Dungeon Quest').normalizedKeyword, 'Dungeon Quest');
  assert.deepEqual(normalizeRobloxTitle('[NEW] ⭐ Game Name').removedDecorations, ['[NEW]', '⭐']);
});

test('discovers target charts by display name instead of permanent sort IDs', () => {
  const results = parseRobloxChartsPayload(chartPayload(), [TOP, UPCOMING], '2026-09-10T00:00:00Z');
  assert.deepEqual(results.map((item) => item.source.id), ['roblox-top-trending', 'roblox-up-and-coming']);
  assert.deepEqual(results.map((item) => item.sortId), ['dynamic-991', 'dynamic-817']);
  assert.deepEqual(results.map((item) => item.sortName), ['Top Trending', 'Up & Coming']);
  assert.equal(results[0].entries[0].universeId, '101');
  assert.equal(results[1].entries[0].rank, 12);
});

test('Canary chart parsing limits each sort before validation and enrichment', () => {
  const games = Array.from({ length: 8 }, (_, index) => ({
    universeId: String(100 + index),
    name: `Game ${index}`,
    rank: index + 1,
    isSponsored: false,
  }));
  games[6].universeId = 'invalid-outside-canary-limit';
  const results = parseRobloxChartsPayload(
    { sorts: [{ sortId: 'limited', sortDisplayName: 'Top Trending', games }] },
    [TOP],
    '2026-09-10T00:00:00Z',
    { maxEntriesPerSource: 5 },
  );
  assert.equal(results[0].entries.length, 5);
});

test('Charts request uses country all and computer device without a fixed sort ID', async () => {
  let requestedUrl = '';
  const result = await scanRobloxCharts([TOP], {
    sessionId: 'fixture-session',
    fetchImpl: async (url) => { requestedUrl = url; return response(200, chartPayload()); },
  });
  const url = new URL(requestedUrl);
  assert.equal(result.success, true);
  assert.equal(url.searchParams.get('country'), 'all');
  assert.equal(url.searchParams.get('device'), 'computer');
  assert.equal(url.searchParams.has('sortId'), false);
});

test('disabled Roblox sources execute no request', async () => {
  let calls = 0;
  const result = await scanRobloxCharts([{ ...TOP, enabled: false }], { fetchImpl: async () => { calls += 1; } });
  assert.equal(result.ran, false);
  assert.equal(result.success, null);
  assert.equal(calls, 0);
});

test('Phase A Roblox source configuration remains disabled', async () => {
  const sources = JSON.parse(await fs.readFile(new URL('../config/sources.json', import.meta.url), 'utf8'));
  const robloxSources = sources.filter((source) => source.fetchKind === 'roblox-charts');
  assert.deepEqual(robloxSources.map((source) => source.id), ['roblox-top-trending', 'roblox-up-and-coming']);
  assert.equal(robloxSources.every((source) => source.enabled === false), true);
});

test('Charts 403 and 429 are graceful and Retry-After is honored', async () => {
  const forbidden = await scanRobloxCharts([TOP], { fetchImpl: async () => response(403, {}) });
  assert.equal(forbidden.success, false);
  assert.equal(forbidden.errors[0].status, 403);

  let calls = 0;
  const waits = [];
  const limited = await scanRobloxCharts([TOP], {
    fetchImpl: async () => { calls += 1; return response(429, {}, { 'retry-after': '2' }); },
    sleepFn: async (ms) => waits.push(ms),
  });
  assert.equal(limited.success, false);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test('a never-returning fetch is aborted by the hard timeout and clears its timer', async () => {
  let aborted = false;
  let cleared = 0;
  await assert.rejects(
    fetchWithTimeout(
      async (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      'https://example.invalid',
      {},
      { timeoutMs: 10, clearTimeoutImpl: (timer) => { cleared += 1; clearTimeout(timer); } },
    ),
    (error) => error.code === 'ROBLOX_HTTP_TIMEOUT' && /timed out/.test(error.message),
  );
  assert.equal(aborted, true);
  assert.equal(cleared, 1);
});

test('a successful request also clears its timeout timer', async () => {
  let cleared = 0;
  const result = await fetchWithTimeout(
    async () => response(200, { ok: true }),
    'https://example.invalid',
    {},
    { timeoutMs: 100, clearTimeoutImpl: (timer) => { cleared += 1; clearTimeout(timer); } },
  );
  assert.deepEqual(result.payload, { ok: true });
  assert.equal(cleared, 1);
});

test('the second Charts attempt is independently timeout-protected', async () => {
  let calls = 0;
  let secondAborted = false;
  const result = await scanRobloxCharts([TOP], {
    timeoutMs: 10,
    sleepFn: async () => {},
    fetchImpl: async (url, { signal }) => {
      calls += 1;
      if (calls === 1) return response(429, {}, { 'retry-after': '0.001' });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          secondAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(secondAborted, true);
  assert.equal(result.success, false);
  assert.equal(result.errors[0].code, 'ROBLOX_HTTP_TIMEOUT');
});

test('empty chart response is rejected so previous candidates and snapshots remain untouched', async () => {
  const candidates = [{ id: 'roblox:old', roblox: { universeId: 'old' } }];
  const state = { roblox: { universes: { old: { snapshots: [{ at: '2026-09-09T00:00:00Z' }] } } } };
  const before = structuredClone({ candidates, state });
  const result = await scanRobloxCharts([TOP], {
    fetchImpl: async () => response(200, { sorts: [{ sortDisplayName: 'Top Trending', games: [] }] }),
  });
  assert.equal(result.success, false);
  assert.match(result.errors[0].message, /empty/);
  assert.deepEqual({ candidates, state }, before);
});

test('Games API metadata keeps IDs as strings and maps the requested fields', async () => {
  const result = await fetchRobloxGameMetadata(['101'], {
    fetchImpl: async () => response(200, { data: [{ id: 101, rootPlaceId: 201, name: 'Anime Fighters', creator: { id: 301, name: 'Studio', type: 'Group' }, created: '2026-09-01T00:00:00Z', updated: '2026-09-10T00:00:00Z', playing: 800, visits: 12000, favoritedCount: 900, genre_l1: 'RPG', genre_l2: 'Action RPG' }] }),
  });
  const game = result.games.get('101');
  assert.equal(game.universeId, '101');
  assert.equal(game.rootPlaceId, '201');
  assert.equal(game.creator.id, '301');
  assert.equal(game.favorites, 900);
  assert.deepEqual(result.errors, []);
  assert.equal(result.complete, true);
});

test('Charts rejects invalid IDs and empty names with structured validation errors', () => {
  for (const item of [
    { universeId: '0', name: 'Zero', rank: 1, isSponsored: false },
    { universeId: '-1', name: 'Negative', rank: 1, isSponsored: false },
    { universeId: 'abc', name: 'Letters', rank: 1, isSponsored: false },
    { universeId: '12.3', name: 'Decimal', rank: 1, isSponsored: false },
    { universeId: '', name: 'Empty ID', rank: 1, isSponsored: false },
    { name: 'Missing ID', rank: 1, isSponsored: false },
    { universeId: '101', rootPlaceId: 'bad', name: 'Bad Place', rank: 1, isSponsored: false },
    { universeId: '101', rootPlaceId: '201', name: '   ', rank: 1, isSponsored: false },
  ]) {
    assert.throws(
      () => parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [item] }] }, [TOP]),
      (error) => error instanceof RobloxSchemaValidationError && error.validationErrors.length > 0,
    );
  }
});

test('invalid rank cannot become natural chart growth evidence', () => {
  const result = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: 'Rankless Game', rank: -1, isSponsored: false }] }] }, [TOP]);
  const entry = result[0].entries[0];
  assert.equal(entry.rank, null);
  assert.equal(entry.sponsored, false);
  assert.deepEqual(result[0].validationErrors.map((error) => error.code), ['INVALID_RANK']);
  const candidates = [];
  const state = {};
  mergeRobloxDiscovery({ candidates, state, sourceResults: result, metadataByUniverse: new Map([['101', { ...gameRow('101'), universeId: '101', originalName: 'Rankless Game', favorites: 900, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' }]]), now: '2026-09-10T00:00:00Z', evaluateFast: fastResult('pass') });
  assert.equal(candidates[0].roblox.latestGrowth.chartSourceCount, 0);
  assert.equal(candidates[0].roblox.rankings['roblox-top-trending'].currentRank, null);
  assert.equal(candidates[0].sources[0].currentRank, null);
});

test('missing sponsored field becomes unknown and cannot count as natural chart evidence', () => {
  const result = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: 'Unknown Promotion', rank: 2 }] }] }, [TOP]);
  assert.equal(result[0].entries[0].sponsored, 'unknown');
  assert.equal(result[0].validationErrors[0].code, 'UNKNOWN_SPONSORED_STATUS');
  const candidates = [];
  const state = {};
  mergeRobloxDiscovery({ candidates, state, sourceResults: result, metadataByUniverse: new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Unknown Promotion', creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 100, visits: 1000, favorites: 20 }]]), now: '2026-09-10T00:00:00Z', evaluateFast: fastResult('pass') });
  assert.equal(candidates[0].roblox.latestGrowth.chartSourceCount, 0);
  assert.equal(candidates[0].roblox.rankings['roblox-top-trending'].currentRank, null);
  assert.equal(candidates[0].sources[0].currentRank, null);
});

test('Universe ID is the identity across renames while same names in different Universes remain separate', () => {
  const candidates = [];
  const state = {};
  const metadata = new Map([
    ['101', { universeId: '101', rootPlaceId: '201', originalName: '[UPDATE] First Quest', creator: { id: '1', name: 'A', type: 'Group' }, playing: 100, visits: 1000, favorites: 50 }],
    ['102', { universeId: '102', rootPlaceId: '202', originalName: 'First Quest', creator: { id: '2', name: 'B', type: 'Group' }, playing: 80, visits: 800, favorites: 40 }],
  ]);
  const first = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: '[UPDATE] First Quest', rank: 20, isSponsored: false }, { universeId: '102', name: 'First Quest', rank: 30, isSponsored: false }] }] }, [TOP]);
  mergeRobloxDiscovery({ candidates, state, sourceResults: first, metadataByUniverse: metadata, now: '2026-09-09T00:00:00Z', evaluateFast: fastResult('pass') });
  assert.deepEqual(candidates.map((item) => item.id).sort(), ['roblox:101', 'roblox:102']);
  candidates.find((item) => item.id === 'roblox:101').seo = { queryName: 'First Quest' };
  candidates.find((item) => item.id === 'roblox:101').fast = { classification: 'pass' };

  metadata.set('101', { ...metadata.get('101'), originalName: 'Galaxy Defenders', playing: 350, visits: 7000, favorites: 300 });
  const renamed = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: 'Galaxy Defenders', rank: 5, isSponsored: false }] }] }, [TOP]);
  mergeRobloxDiscovery({ candidates, state, sourceResults: renamed, metadataByUniverse: metadata, now: '2026-09-10T00:00:00Z', evaluateFast: fastResult('weak') });
  const candidate = candidates.find((item) => item.id === 'roblox:101');
  assert.equal(candidates.length, 2);
  assert.equal(candidate.firstSeen, '2026-09-09T00:00:00Z');
  assert.equal(candidate.gameName, 'Galaxy Defenders');
  assert.equal(candidate.roblox.nameHistory.length, 2);
  assert.equal(candidate.roblox.renameEvents.length, 1);
  assert.equal(candidate.roblox.rankings['roblox-top-trending'].previousRank, 20);
  assert.equal(candidate.roblox.rankings['roblox-top-trending'].currentRank, 5);
  assert.equal(candidate.roblox.rankings['roblox-top-trending'].bestRank, 5);
  assert.equal(candidate.seo, undefined);
  assert.equal(candidate.fast.classification, 'weak');
  assert.equal(isSignificantRobloxRename('First Quest', 'Galaxy Defenders'), true);
});

test('first snapshot has no fabricated growth and later snapshots calculate 24h/48h deltas', () => {
  const first = { at: '2026-09-08T00:00:00Z', playing: 100, visits: 1000, favorites: 50, rankings: { top: 40 }, sourceIds: ['top'] };
  const second = { at: '2026-09-09T00:00:00Z', playing: 250, visits: 6000, favorites: 100, rankings: { top: 22 }, sourceIds: ['top'] };
  const third = { at: '2026-09-10T00:00:00Z', playing: 500, visits: 20000, favorites: 350, rankings: { top: 8, upcoming: 12 }, sourceIds: ['top', 'upcoming'] };
  assert.deepEqual(calculateRobloxGrowth(first, []), {
    ccuDelta24h: null, ccuGrowth24h: null, ccuDelta48h: null, ccuGrowth48h: null,
    visitsDelta24h: null, favoritesDelta24h: null, maxRankGain24h: null,
    firstChartEntry24h: false, chartSourceCount: 1,
  });
  const growth = calculateRobloxGrowth(third, [first, second]);
  assert.equal(growth.ccuDelta24h, 250);
  assert.equal(growth.ccuGrowth24h, 100);
  assert.equal(growth.ccuDelta48h, 400);
  assert.equal(growth.ccuGrowth48h, 400);
  assert.equal(growth.visitsDelta24h, 14000);
  assert.equal(growth.favoritesDelta24h, 250);
  assert.equal(growth.maxRankGain24h, 14);
  assert.equal(growth.firstChartEntry24h, true);
});

test('24h snapshot matching accepts plus or minus six hours', () => {
  const current = { at: '2026-09-10T00:00:00Z', playing: 300, visits: 0, favorites: 0, rankings: {}, sourceIds: [] };
  const plusSix = { at: '2026-09-09T06:00:00Z', playing: 100, visits: 0, favorites: 0, rankings: {}, sourceIds: [] };
  const outside = { at: '2026-09-09T06:01:00Z', playing: 50, visits: 0, favorites: 0, rankings: {}, sourceIds: [] };
  assert.equal(calculateRobloxGrowth(current, [plusSix]).ccuDelta24h, 200);
  assert.equal(calculateRobloxGrowth(current, [outside]).ccuDelta24h, null);
});

test('snapshot retention keeps 72h detail and one daily point up to 30 days', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const snapshots = [
    { at: '2026-09-09T01:00:00Z' }, { at: '2026-09-09T13:00:00Z' },
    { at: '2026-09-01T01:00:00Z' }, { at: '2026-09-01T22:00:00Z' },
    { at: '2026-07-01T00:00:00Z' },
  ];
  const compacted = compactRobloxSnapshots(snapshots, now);
  assert.deepEqual(compacted.map((item) => item.at), ['2026-09-01T22:00:00Z', '2026-09-09T01:00:00Z', '2026-09-09T13:00:00Z']);
});

test('sponsored chart items are not merged as natural discovery evidence', () => {
  const sourceResults = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '999', name: 'Paid Game', rank: 1, isSponsored: true }] }] }, [TOP]);
  const candidates = [];
  const state = {};
  const result = mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse: new Map([['999', { universeId: '999', rootPlaceId: '1999', originalName: 'Paid Game', creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 100, visits: 1000, favorites: 20 }]]), now: '2026-09-10T00:00:00Z', evaluateFast: fastResult('pass') });
  assert.equal(result.universesFound, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].roblox.latestGrowth.chartSourceCount, 0);
  assert.equal(candidates[0].roblox.rankings['roblox-top-trending'].currentRank, null);
  assert.equal(candidates[0].sources[0].currentRank, null);
});

function historicalData() {
  return {
    candidates: [{ id: 'roblox:77', gameName: 'Historical', normalizedName: 'historical', firstSeen: '2026-09-01T00:00:00Z', sources: [], roblox: { universeId: '77', rankings: {}, nameHistory: [], renameEvents: [] } }],
    state: { roblox: { universes: { 77: { snapshots: [{ at: '2026-09-09T00:00:00Z', playing: 20, visits: 100, favorites: 4, rankings: {}, sourceIds: [] }] } } } },
  };
}

test('Charts success plus Games 403 leaves candidates and state byte-for-byte unchanged', async () => {
  const history = historicalData();
  const before = structuredClone(history);
  const result = await runRobloxDiscoveryTransaction({
    ...history,
    sourceResults: chartResultsFor(['101']),
    fetchOptions: { fetchImpl: async () => response(403, {}) },
    now: '2026-09-10T00:00:00Z',
  });
  assert.equal(result.success, false);
  assert.equal(result.newUniverses, 0);
  assert.equal(result.updatedUniverses, 0);
  assert.deepEqual(history, before);
});

test('Games timeout leaves historical candidates, state, and snapshots unchanged', async () => {
  const history = historicalData();
  const before = structuredClone(history);
  const result = await runRobloxDiscoveryTransaction({
    ...history,
    sourceResults: chartResultsFor(['101']),
    fetchOptions: {
      timeoutMs: 10,
      fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    },
    now: '2026-09-10T00:00:00Z',
  });
  assert.equal(result.success, false);
  assert.equal(result.errors.some((error) => error.code === 'ROBLOX_HTTP_TIMEOUT'), true);
  assert.deepEqual(history, before);
});

test('ten requested Universes with only nine Games records causes a zero-mutation batch failure', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => String(101 + index));
  const history = historicalData();
  const before = structuredClone(history);
  const result = await runRobloxDiscoveryTransaction({
    ...history,
    sourceResults: chartResultsFor(ids),
    fetchOptions: { fetchImpl: async () => response(200, { data: ids.slice(0, 9).map((id) => gameRow(id)) }) },
    now: '2026-09-10T00:00:00Z',
  });
  assert.equal(result.success, false);
  assert.equal(result.errors.some((error) => error.code === 'MISSING_UNIVERSES' || error.code === 'INCOMPLETE_ENRICHMENT'), true);
  assert.deepEqual(history, before);
});

test('a Games response for the wrong Universe ID fails the whole transaction', async () => {
  const history = historicalData();
  const before = structuredClone(history);
  const result = await runRobloxDiscoveryTransaction({
    ...history,
    sourceResults: chartResultsFor(['101']),
    fetchOptions: { fetchImpl: async () => response(200, { data: [gameRow('102')] }) },
    now: '2026-09-10T00:00:00Z',
  });
  assert.equal(result.success, false);
  assert.equal(result.newUniverses, 0);
  assert.deepEqual(history, before);
});

test('Games schema mismatch and missing enriched rootPlaceId both fail without mutation', async () => {
  for (const row of [gameRow('101', { playing: -1 }), gameRow('101', { rootPlaceId: null })]) {
    const history = historicalData();
    const before = structuredClone(history);
    const result = await runRobloxDiscoveryTransaction({
      ...history,
      sourceResults: chartResultsFor(['101']),
      fetchOptions: { fetchImpl: async () => response(200, { data: [row] }) },
      now: '2026-09-10T00:00:00Z',
    });
    assert.equal(result.success, false);
    assert.equal(result.newUniverses, 0);
    assert.deepEqual(history, before);
  }
});

test('a complete validated enrichment batch merges only after validation succeeds', async () => {
  const history = historicalData();
  const sourceResults = chartResultsFor(['101']);
  const metadata = await fetchRobloxGameMetadata(['101'], { fetchImpl: async () => response(200, { data: [gameRow('101')] }) });
  const batch = buildValidatedRobloxBatch(sourceResults, metadata);
  assert.equal(batch.valid, true);
  const result = await runRobloxDiscoveryTransaction({
    ...history,
    sourceResults,
    fetchOptions: { fetchImpl: async () => response(200, { data: [gameRow('101')] }) },
    now: '2026-09-10T00:00:00Z',
    evaluateFast: fastResult('pass'),
  });
  assert.equal(result.success, true);
  assert.equal(result.newUniverses, 1);
  assert.equal(history.candidates.some((candidate) => candidate.id === 'roblox:101'), true);
  assert.equal(history.state.roblox.universes['101'].snapshots.length, 1);
});

test('fatal Charts schema drift cannot produce a candidate', () => {
  const history = historicalData();
  const before = structuredClone(history);
  assert.throws(
    () => parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: { changed: true }, name: 'Dirty Candidate', rank: 1, isSponsored: false }] }] }, [TOP]),
    (error) => error.code === 'ROBLOX_SCHEMA_MISMATCH',
  );
  assert.deepEqual(history, before);
});

test('merge defensively rejects an invalid Universe ID without mutation', () => {
  const history = historicalData();
  const before = structuredClone(history);
  assert.throws(
    () => mergeRobloxDiscovery({
      ...history,
      sourceResults: [{ source: TOP, entries: [{ universeId: 'abc', originalName: 'Dirty Candidate', rank: 1, sponsored: false }] }],
      metadataByUniverse: new Map(),
      now: '2026-09-10T00:00:00Z',
    }),
    (error) => error.code === 'ROBLOX_SCHEMA_MISMATCH',
  );
  assert.deepEqual(history, before);
});

test('baseline weak Roblox is persisted in observation state without becoming a candidate', () => {
  const candidates = [];
  const state = {};
  const result = mergeRobloxDiscovery({
    candidates,
    state,
    sourceResults: chartResultsFor(['101']),
    metadataByUniverse: new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Observed Only', creator: { id: '1', name: 'Studio', type: 'Group' }, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', playing: 30, visits: 100, favorites: 3 }]]),
    now: '2026-09-10T00:00:00Z',
    evaluateFast: fastResult('weak'),
  });
  assert.equal(candidates.length, 0);
  assert.equal(state.roblox.universes['101'].snapshots.length, 1);
  assert.equal(state.roblox.universes['101'].originalName, 'Observed Only');
  assert.deepEqual(result.fast, { pass: 0, watch: 0, weak: 1 });
  assert.equal(result.stateOnlyUniverses, 1);
  assert.equal(result.promotedThisRun, 0);
});

test('state-only Roblox uses prior snapshots and promotes automatically after real growth', () => {
  const candidates = [];
  const state = {};
  const dayOneMetadata = new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Growth Quest', creator: { id: '1', name: 'Studio', type: 'Group' }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z', playing: 300, visits: 1000, favorites: 30 }]]);
  mergeRobloxDiscovery({ candidates, state, sourceResults: parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: 'Growth Quest', rank: 43, isSponsored: false }] }] }, [TOP]), metadataByUniverse: dayOneMetadata, now: '2026-09-09T00:00:00Z', evaluateFast: realFast });
  assert.equal(candidates.length, 0);

  const dayTwoCharts = parseRobloxChartsPayload({ sorts: [
    { sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: 'Growth Quest', rank: 18, isSponsored: false }] },
    { sortDisplayName: 'Up-and-Coming', games: [{ universeId: '101', name: 'Growth Quest', rank: 18, isSponsored: false }] },
  ] }, [TOP, UPCOMING]);
  const dayTwoMetadata = new Map([['101', { ...dayOneMetadata.get('101'), updatedAt: '2026-09-10T00:00:00Z', playing: 1400, visits: 26000, favorites: 450 }]]);
  const result = mergeRobloxDiscovery({ candidates, state, sourceResults: dayTwoCharts, metadataByUniverse: dayTwoMetadata, now: '2026-09-10T00:00:00Z', evaluateFast: realFast });
  assert.equal(result.promotedThisRun, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fast.classification, 'pass');
  assert.equal(candidates[0].firstSeen, '2026-09-09T00:00:00Z');
  assert.equal(candidates[0].roblox.promotedAt, '2026-09-10T00:00:00Z');
  assert.equal(candidates[0].roblox.latestGrowth.ccuDelta24h, 1100);
  assert.equal(state.roblox.universes['101'].snapshots.length, 2);
});

test('state-only weak Roblox is absent from every candidate-backed paid queue', () => {
  const candidates = [];
  const state = {};
  mergeRobloxDiscovery({
    candidates,
    state,
    sourceResults: chartResultsFor(['101']),
    metadataByUniverse: new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'No Quota Game', creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 30, visits: 100, favorites: 3 }]]),
    now: '2026-09-10T00:00:00Z',
    evaluateFast: fastResult('weak'),
  });
  const transient = buildRobloxTransientCandidate(state.roblox.universes['101'], fastResult('weak')());
  assert.equal(allowsPaidRobloxVerification(transient), false);
  for (const queue of ['serper', 'google-cse', 'seo-expansion', 'serpapi', 'searchapi', 'apify', 'social', 'youtube']) {
    assert.deepEqual(candidates.filter((candidate) => candidate.id === 'roblox:101'), [], `${queue} must only receive persisted candidates`);
  }
});

test('watch does not promote by default while pass and strong growth do', () => {
  for (const [classification, overrides, expected] of [
    ['watch', {}, 0],
    ['pass', {}, 1],
    ['watch', { strongGrowth: true }, 1],
  ]) {
    const candidates = [];
    const state = {};
    mergeRobloxDiscovery({ candidates, state, sourceResults: chartResultsFor(['101']), metadataByUniverse: new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Promotion Gate', creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 100, visits: 1000, favorites: 20 }]]), now: '2026-09-10T00:00:00Z', evaluateFast: fastResult(classification, overrides) });
    assert.equal(candidates.length, expected);
  }
});

test('a newly promoted Fast pass can enter Roblox Today Review in the same run', () => {
  const candidates = [];
  const state = {};
  mergeRobloxDiscovery({
    candidates,
    state,
    sourceResults: chartResultsFor(['101']),
    metadataByUniverse: new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Immediate Review', creator: { id: '1', name: 'Studio', type: 'Group' }, createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', playing: 500, visits: 12000, favorites: 900 }]]),
    now: '2026-09-10T00:00:00Z',
    evaluateFast: fastResult('pass'),
  });
  const review = buildTodayReview(candidates, { nowMs: Date.parse('2026-09-10T00:00:00Z') });
  assert.equal(review.selected.length, 1);
  assert.equal(review.selected[0].todayReview.lane, 'roblox-growth');
});

test('an existing promoted candidate remains after Fast falls to weak', () => {
  const candidates = [];
  const state = {};
  const sourceResults = chartResultsFor(['101']);
  const metadata = new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Stable Identity', creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 100, visits: 1000, favorites: 20 }]]);
  mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse: metadata, now: '2026-09-09T00:00:00Z', evaluateFast: fastResult('pass') });
  mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse: metadata, now: '2026-09-10T00:00:00Z', evaluateFast: fastResult('weak') });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fast.classification, 'weak');
  assert.equal(state.roblox.universes['101'].promotedAt, '2026-09-09T00:00:00Z');
});

test('state identity and firstSeen survive a rename before promotion', () => {
  const candidates = [];
  const state = {};
  const firstMetadata = new Map([['101', { universeId: '101', rootPlaceId: '1101', originalName: 'First Quest', creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 30, visits: 100, favorites: 3 }]]);
  mergeRobloxDiscovery({ candidates, state, sourceResults: chartResultsFor(['101']), metadataByUniverse: firstMetadata, now: '2026-09-09T00:00:00Z', evaluateFast: fastResult('weak') });
  const renamedMetadata = new Map([['101', { ...firstMetadata.get('101'), originalName: 'Galaxy Defenders', playing: 500 }]]);
  const renamedCharts = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [{ universeId: '101', name: 'Galaxy Defenders', rank: 3, isSponsored: false }] }] }, [TOP]);
  mergeRobloxDiscovery({ candidates, state, sourceResults: renamedCharts, metadataByUniverse: renamedMetadata, now: '2026-09-10T00:00:00Z', evaluateFast: fastResult('pass') });
  assert.equal(Object.keys(state.roblox.universes).length, 1);
  assert.equal(state.roblox.universes['101'].nameHistory.length, 2);
  assert.equal(candidates[0].id, 'roblox:101');
  assert.equal(candidates[0].gameName, 'Galaxy Defenders');
  assert.equal(candidates[0].firstSeen, '2026-09-09T00:00:00Z');
});

test('same-name Universes are observed and promoted independently', () => {
  const candidates = [];
  const state = {};
  const sourceResults = parseRobloxChartsPayload({ sorts: [{ sortDisplayName: 'Top Trending', games: [
    { universeId: '101', name: 'Shared Name', rank: 1, isSponsored: false },
    { universeId: '102', name: 'Shared Name', rank: 2, isSponsored: false },
  ] }] }, [TOP]);
  const metadata = new Map([
    ['101', { universeId: '101', rootPlaceId: '1101', originalName: 'Shared Name', creator: { id: '1', name: 'A', type: 'Group' }, playing: 100, visits: 1000, favorites: 20 }],
    ['102', { universeId: '102', rootPlaceId: '1102', originalName: 'Shared Name', creator: { id: '2', name: 'B', type: 'Group' }, playing: 50, visits: 500, favorites: 10 }],
  ]);
  mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse: metadata, now: '2026-09-10T00:00:00Z', evaluateFast: (candidate) => fastResult(candidate.id === 'roblox:101' ? 'pass' : 'weak')() });
  assert.deepEqual(Object.keys(state.roblox.universes).sort(), ['101', '102']);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['roblox:101']);
});

test('observation GC removes only stale never-promoted Universes', () => {
  const state = { roblox: { universes: {
    stale: { lastSeen: '2026-07-01T00:00:00Z', snapshots: [] },
    promoted: { lastSeen: '2026-07-01T00:00:00Z', promotedAt: '2026-06-01T00:00:00Z', snapshots: [] },
    retained: { lastSeen: '2026-07-01T00:00:00Z', specialRetention: true, snapshots: [] },
    recent: { lastSeen: '2026-09-01T00:00:00Z', snapshots: [] },
  } } };
  const candidates = [{ id: 'roblox:candidate', roblox: { universeId: 'candidate' } }];
  state.roblox.universes.candidate = { lastSeen: '2026-07-01T00:00:00Z', snapshots: [] };
  const removed = pruneRobloxObservationPool(state, candidates, Date.parse('2026-09-10T00:00:00Z'));
  assert.deepEqual(removed, ['stale']);
  assert.deepEqual(Object.keys(state.roblox.universes).sort(), ['candidate', 'promoted', 'recent', 'retained']);
  assert.equal(candidates.length, 1);
});

test('116-observation baseline promotes one and cannot consume 115 candidate slots', () => {
  const ids = Array.from({ length: 116 }, (_, index) => String(1001 + index));
  const nonRoblox = Array.from({ length: 3000 }, (_, index) => ({ id: `existing-${index}`, gameName: `Existing ${index}`, normalizedName: `existing ${index}`, firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-09-01T00:00:00Z', sources: [], recommendation: 'pending' }));
  const before = structuredClone(nonRoblox);
  const candidates = structuredClone(nonRoblox);
  const state = {};
  const sourceResults = chartResultsFor(ids);
  const metadata = new Map(ids.map((id) => [id, { universeId: id, rootPlaceId: String(Number(id) + 5000), originalName: `Game ${id}`, creator: { id: '1', name: 'Studio', type: 'Group' }, playing: 100, visits: 1000, favorites: 20 }]));
  const result = mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse: metadata, now: '2026-09-10T00:00:00Z', evaluateFast: (candidate) => fastResult(candidate.id === 'roblox:1001' ? 'pass' : 'weak')() });
  assert.equal(result.observedUniverses, 116);
  assert.equal(result.newObservedUniverses, 116);
  assert.equal(result.stateOnlyUniverses, 115);
  assert.equal(result.promotedThisRun, 1);
  assert.deepEqual(result.fast, { pass: 1, watch: 0, weak: 115 });
  assert.equal(Object.keys(state.roblox.universes).length, 116);
  assert.equal(candidates.length, 3001);
  assert.equal(candidates.filter((candidate) => candidate.id.startsWith('roblox:')).length, 1);
  assert.deepEqual(candidates.slice(0, 3000), before);
  assert.equal(Math.max(0, candidates.length - 3000), 1);
});
