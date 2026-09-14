import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetedFetch, runRobloxCanary } from '../scripts/roblox-canary.mjs';

const SOURCES = [
  { id: 'roblox-top-trending', name: 'Top', kind: 'roblox-chart', fetchKind: 'roblox-charts', chartName: 'Top Trending', enabled: false },
  { id: 'roblox-up-and-coming', name: 'Up', kind: 'roblox-chart', fetchKind: 'roblox-charts', chartName: 'Up-and-Coming', enabled: false },
];

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => payload,
  };
}

function chartGames(start) {
  return Array.from({ length: 7 }, (_, index) => ({
    universeId: String(start + index),
    rootPlaceId: String(start + 100 + index),
    name: `Canary ${start + index}`,
    rank: index + 1,
    isSponsored: false,
  }));
}

function gameRow(id) {
  return {
    id: Number(id),
    rootPlaceId: Number(id) + 100,
    name: `Canary ${id}`,
    creator: { id: 7, name: 'Canary Studio', type: 'Group' },
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-10T00:00:00Z',
    playing: 100,
    visits: 1000,
    favoritedCount: 50,
    genre_l1: 'Adventure',
    genre_l2: 'Exploration',
  };
}

test('Canary stays read-only, bounded, and returns a structured PASS summary', async () => {
  let calls = 0;
  const candidates = [{ id: 'sentinel' }];
  const state = { sentinel: true };
  const before = structuredClone({ candidates, state });
  const summary = await runRobloxCanary({
    sources: SOURCES,
    nowMs: Date.parse('2026-09-10T00:00:00Z'),
    finishedNowMs: Date.parse('2026-09-10T00:00:01Z'),
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('explore-api')) {
        return response(200, { sorts: [
          { sortId: 'top-live', sortDisplayName: 'Top Trending', games: chartGames(100) },
          { sortId: 'up-live', sortDisplayName: 'Up & Coming', games: chartGames(200) },
        ] });
      }
      const ids = new URL(url).searchParams.get('universeIds').split(',');
      return response(200, { data: ids.map(gameRow) });
    },
  });
  assert.equal(summary.result, 'PASS');
  assert.equal(summary.environment.totalRequests, 2);
  assert.equal(summary.charts.topTrendingReturned, 5);
  assert.equal(summary.charts.upAndComingReturned, 5);
  assert.equal(summary.gamesApi.requestedUniverses, 10);
  assert.equal(summary.gamesApi.returnedUniverses, 10);
  assert.equal(calls, 2);
  assert.deepEqual({ candidates, state }, before);
});

test('Canary request budget refuses a seventh HTTP request', async () => {
  let actualCalls = 0;
  const budget = createBudgetedFetch(async () => {
    actualCalls += 1;
    return response(200, {});
  });
  for (let index = 0; index < 6; index += 1) await budget.fetch('https://games.roblox.com/v1/games');
  await assert.rejects(
    budget.fetch('https://games.roblox.com/v1/games'),
    (error) => error.code === 'ROBLOX_CANARY_REQUEST_BUDGET_EXCEEDED',
  );
  assert.equal(actualCalls, 6);
  assert.equal(budget.totalRequests, 6);
});

test('Canary fails closed when Games metadata is incomplete', async () => {
  const summary = await runRobloxCanary({
    sources: SOURCES,
    fetchImpl: async (url) => {
      if (String(url).includes('explore-api')) {
        return response(200, { sorts: [
          { sortId: 'top-live', sortDisplayName: 'Top Trending', games: chartGames(100) },
          { sortId: 'up-live', sortDisplayName: 'Up & Coming', games: chartGames(200) },
        ] });
      }
      const ids = new URL(url).searchParams.get('universeIds').split(',');
      return response(200, { data: ids.slice(0, -1).map(gameRow) });
    },
  });
  assert.equal(summary.result, 'FAIL');
  assert.equal(summary.gamesApi.completeBatch, false);
  assert.equal(summary.schema.compatible, false);
  assert.ok(summary.schema.errors.some((error) => error.code === 'MISSING_UNIVERSES'));
});
