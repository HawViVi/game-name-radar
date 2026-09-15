import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildValidatedRobloxBatch,
  fetchRobloxGameMetadata,
  scanRobloxCharts,
} from '../lib/roblox-discovery.mjs';

const REQUEST_LIMIT = 6;
const CHART_LIMIT = 5;
const UNIVERSE_LIMIT = 10;
const TOP_TRENDING_ID = 'roblox-top-trending';
const UP_AND_COMING_ID = 'roblox-up-and-coming';

function endpointType(input) {
  const url = String(input);
  if (url.includes('explore-api')) return 'charts';
  if (url.includes('games.roblox.com')) return 'games-api';
  return 'unknown';
}

function selectedHeader(headers, names) {
  for (const name of names) {
    const value = headers?.get?.(name);
    if (value) return value;
  }
  return null;
}

export function createBudgetedFetch(fetchImpl = globalThis.fetch, limit = REQUEST_LIMIT) {
  let totalRequests = 0;
  const network = [];

  const budgetedFetch = async (input, init) => {
    if (totalRequests >= limit) {
      const error = new Error(`Roblox Canary HTTP request budget exhausted at ${limit} requests`);
      error.code = 'ROBLOX_CANARY_REQUEST_BUDGET_EXCEEDED';
      throw error;
    }
    totalRequests += 1;
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(input, init);
      network.push({
        endpointType: endpointType(input),
        status: response.status,
        durationMs: Date.now() - startedAt,
        retryAfter: response.headers?.get?.('retry-after') || null,
        rateLimit: {
          limit: selectedHeader(response.headers, ['ratelimit-limit', 'x-ratelimit-limit']),
          remaining: selectedHeader(response.headers, ['ratelimit-remaining', 'x-ratelimit-remaining']),
          reset: selectedHeader(response.headers, ['ratelimit-reset', 'x-ratelimit-reset']),
        },
      });
      return response;
    } catch (error) {
      network.push({
        endpointType: endpointType(input),
        status: null,
        durationMs: Date.now() - startedAt,
        retryAfter: null,
        rateLimit: { limit: null, remaining: null, reset: null },
      });
      throw error;
    }
  };

  return {
    fetch: budgetedFetch,
    get totalRequests() { return totalRequests; },
    network,
  };
}

function cleanIssue(issue = {}) {
  return {
    scope: issue.scope || null,
    code: issue.code || null,
    field: issue.field || null,
    status: issue.status || null,
    message: issue.message || String(issue),
  };
}

function expandIssues(issues = []) {
  return issues.flatMap((issue) => {
    const nested = (issue.validationErrors || []).map(cleanIssue);
    return [cleanIssue(issue), ...nested];
  });
}

function chartSample(result) {
  return (result?.entries || []).slice(0, CHART_LIMIT).map((entry) => ({
    universeId: entry.universeId,
    rootPlaceId: entry.rootPlaceId,
    name: entry.originalName,
    rank: entry.rank,
    sponsored: entry.sponsored,
  }));
}

function gameSample(universeIds, games) {
  return universeIds.map((universeId) => {
    const game = games.get(universeId);
    return game ? {
      universeId: game.universeId,
      rootPlaceId: game.rootPlaceId,
      name: game.originalName,
      creatorName: game.creator.name,
      created: game.createdAt,
      updated: game.updatedAt,
      playing: game.playing,
      visits: game.visits,
      favorites: game.favorites,
      genreL1: game.genreL1,
      genreL2: game.genreL2,
    } : { universeId, missing: true };
  });
}

export async function runRobloxCanary(options = {}) {
  const startedAt = new Date(options.nowMs || Date.now()).toISOString();
  const sourcesPath = new URL('../config/sources.json', import.meta.url);
  const configuredSources = options.sources || JSON.parse(await fs.readFile(sourcesPath, 'utf8'));
  const canarySources = configuredSources
    .filter((source) => [TOP_TRENDING_ID, UP_AND_COMING_ID].includes(source.id))
    .map((source) => ({ ...source, enabled: true }));
  const requestBudget = createBudgetedFetch(options.fetchImpl || globalThis.fetch, REQUEST_LIMIT);
  const errors = [];
  const warnings = [];

  let chartRun = null;
  let topTrending = null;
  let upAndComing = null;
  let universeIds = [];
  let metadataResult = { games: new Map(), errors: [], complete: false };
  let batch = { valid: false, validationErrors: [], errors: [] };

  if (canarySources.length !== 2) {
    errors.push(cleanIssue({ code: 'CANARY_SOURCE_CONFIG_MISMATCH', message: 'Both Roblox Canary source definitions are required' }));
  } else {
    chartRun = await scanRobloxCharts(canarySources, {
      fetchImpl: requestBudget.fetch,
      maxEntriesPerSource: CHART_LIMIT,
      timeoutMs: options.timeoutMs,
      sleepFn: options.sleepFn,
      nowMs: options.nowMs,
    });
    if (!chartRun.success) errors.push(...expandIssues(chartRun.errors));
    topTrending = chartRun.sourceResults.find((result) => result.source.id === TOP_TRENDING_ID) || null;
    upAndComing = chartRun.sourceResults.find((result) => result.source.id === UP_AND_COMING_ID) || null;
    warnings.push(...chartRun.sourceResults.flatMap((result) => (result.validationErrors || []).map(cleanIssue)));

    if (!topTrending) errors.push(cleanIssue({ code: 'TOP_TRENDING_NOT_FOUND', message: 'Top Trending was not identified' }));
    if (!upAndComing) errors.push(cleanIssue({ code: 'UP_AND_COMING_NOT_FOUND', message: 'Up-and-Coming was not identified' }));
    if (topTrending && !topTrending.sortId) errors.push(cleanIssue({ code: 'TOP_TRENDING_SORT_ID_MISSING', message: 'Top Trending sort ID was not present' }));
    if (upAndComing && !upAndComing.sortId) errors.push(cleanIssue({ code: 'UP_AND_COMING_SORT_ID_MISSING', message: 'Up-and-Coming sort ID was not present' }));

    universeIds = [...new Set(chartRun.sourceResults.flatMap((result) => result.entries.map((entry) => entry.universeId)))].slice(0, UNIVERSE_LIMIT);
    if (chartRun.success && topTrending?.sortId && upAndComing?.sortId && universeIds.length > 0) {
      metadataResult = await fetchRobloxGameMetadata(universeIds, {
        fetchImpl: requestBudget.fetch,
        timeoutMs: options.timeoutMs,
      });
      batch = buildValidatedRobloxBatch(chartRun.sourceResults, metadataResult);
      errors.push(...expandIssues(batch.errors));
      for (const issue of batch.validationErrors || []) {
        const cleaned = cleanIssue(issue);
        if (!warnings.some((warning) => warning.scope === cleaned.scope && warning.code === cleaned.code && warning.message === cleaned.message)) warnings.push(cleaned);
      }
    }
  }

  const chartsNetwork = requestBudget.network.filter((item) => item.endpointType === 'charts');
  const gamesNetwork = requestBudget.network.filter((item) => item.endpointType === 'games-api');
  const compatible = Boolean(
    chartRun?.success
    && topTrending
    && upAndComing
    && topTrending.sortId
    && upAndComing.sortId
    && metadataResult.complete
    && batch.valid
    && universeIds.length > 0
    && requestBudget.totalRequests <= REQUEST_LIMIT
  );
  if (!compatible && errors.length === 0) errors.push(cleanIssue({ code: 'CANARY_INCOMPATIBLE', message: 'Canary compatibility criteria were not satisfied' }));

  return {
    environment: {
      githubActions: process.env.GITHUB_ACTIONS === 'true',
      nodeVersion: process.version,
      startedAt,
      finishedAt: new Date(options.finishedNowMs || Date.now()).toISOString(),
      totalRequests: requestBudget.totalRequests,
    },
    charts: {
      getSortsStatus: chartsNetwork.at(-1)?.status ?? null,
      topTrendingFound: Boolean(topTrending),
      topTrendingSortId: topTrending?.sortId || null,
      topTrendingReturned: topTrending?.entries.length || 0,
      upAndComingFound: Boolean(upAndComing),
      upAndComingSortId: upAndComing?.sortId || null,
      upAndComingReturned: upAndComing?.entries.length || 0,
    },
    sample: {
      topTrending: chartSample(topTrending),
      upAndComing: chartSample(upAndComing),
    },
    gamesApi: {
      status: gamesNetwork.at(-1)?.status ?? null,
      requestedUniverses: universeIds.length,
      returnedUniverses: metadataResult.games.size,
      completeBatch: Boolean(metadataResult.complete && batch.valid),
      universes: gameSample(universeIds, metadataResult.games),
    },
    network: requestBudget.network,
    schema: { compatible, warnings, errors },
    result: compatible ? 'PASS' : 'FAIL',
  };
}

async function main() {
  let summary;
  try {
    summary = await runRobloxCanary();
  } catch (error) {
    const now = new Date().toISOString();
    summary = {
      environment: { githubActions: process.env.GITHUB_ACTIONS === 'true', nodeVersion: process.version, startedAt: now, finishedAt: now, totalRequests: 0 },
      charts: { getSortsStatus: null, topTrendingFound: false, topTrendingSortId: null, topTrendingReturned: 0, upAndComingFound: false, upAndComingSortId: null, upAndComingReturned: 0 },
      sample: { topTrending: [], upAndComing: [] },
      gamesApi: { status: null, requestedUniverses: 0, returnedUniverses: 0, completeBatch: false, universes: [] },
      network: [],
      schema: { compatible: false, warnings: [], errors: [cleanIssue(error)] },
      result: 'FAIL',
    };
  }
  process.stdout.write(`${JSON.stringify({ 'CANARY SUMMARY': summary }, null, 2)}\n`);
  if (summary.result !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
