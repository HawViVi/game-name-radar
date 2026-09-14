import { randomUUID } from 'node:crypto';
import { normalizeGameName } from './scanner.mjs';

export const ROBLOX_TITLE_NORMALIZATION_VERSION = 1;
export const ROBLOX_HTTP_TIMEOUT_MS = 15000;
export const ROBLOX_DISCOVERY_ENDPOINTS = Object.freeze({
  charts: 'https://apis.roblox.com/explore-api/v1/get-sorts',
  games: 'https://games.roblox.com/v1/games',
});

const HOUR = 3600000;
const DAY = 86400000;
const FINE_GRAINED_RETENTION = 72 * HOUR;
const DAILY_RETENTION = 30 * DAY;
const SNAPSHOT_TOLERANCE = 6 * HOUR;
const ROBLOX_CHART_ALIASES = new Map([
  ['top trending', 'top-trending'],
  ['trending', 'top-trending'],
  ['up and coming', 'up-and-coming'],
  ['up coming', 'up-and-coming'],
]);

export class RobloxRequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Roblox request timed out after ${timeoutMs}ms`);
    this.name = 'RobloxRequestTimeoutError';
    this.code = 'ROBLOX_HTTP_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

export class RobloxSchemaValidationError extends Error {
  constructor(message, validationErrors = []) {
    super(message);
    this.name = 'RobloxSchemaValidationError';
    this.code = 'ROBLOX_SCHEMA_MISMATCH';
    this.validationErrors = validationErrors;
  }
}

function asString(value) {
  return value === null || value === undefined ? '' : String(value);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveIntegerId(value) {
  const normalized = asString(value).trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function nonNegativeApiInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function validNullableDate(value) {
  return value === null || value === undefined || value === '' || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validationError(scope, code, field, message, details = {}) {
  return { scope, code, field, message, ...details };
}

export async function fetchWithTimeout(fetchImpl, input, init = {}, options = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Roblox fetch implementation is unavailable');
  const timeoutMs = Math.max(1, Number(options.timeoutMs || ROBLOX_HTTP_TIMEOUT_MS));
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  const controller = new AbortController();
  let timer = null;
  let timeoutError = null;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimer(() => {
      timeoutError = new RobloxRequestTimeoutError(timeoutMs);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const requestPromise = (async () => {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    let payload = null;
    if (response.ok) {
      try {
        payload = await response.json();
      } catch (error) {
        const parseError = new Error(`Roblox response JSON parsing failed: ${error.message}`);
        parseError.code = 'ROBLOX_INVALID_JSON';
        throw parseError;
      }
    }
    return { response, payload };
  })();
  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    if (timer !== null) clearTimer(timer);
  }
}

function canonicalLabel(value = '') {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function chartKey(value = '') {
  const label = canonicalLabel(value);
  return ROBLOX_CHART_ALIASES.get(label) || label.replace(/\s+/g, '-');
}

function decorationTag(value = '') {
  const text = String(value).trim();
  return /^(?:(?:console|mobile|xbox|playstation|ps4|ps5|pc)\s+)?(?:update|upd|new|patch|version|release|alpha|beta|testing)(?:\s+(?:v?\d+(?:\.\d+)*|\d+|test))?[!\s]*$/i.test(text);
}

function stripEdgeEmoji(value, removedDecorations) {
  let current = value;
  const leading = current.match(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u)?.[0] || '';
  if (leading.trim()) {
    removedDecorations.push(leading.trim());
    current = current.slice(leading.length);
  }
  const trailing = current.match(/[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u)?.[0] || '';
  if (trailing.trim()) {
    removedDecorations.push(trailing.trim());
    current = current.slice(0, -trailing.length);
  }
  return current;
}

export function normalizeRobloxTitle(originalName = '') {
  const removedDecorations = [];
  let normalizedKeyword = String(originalName).normalize('NFKC').replace(/\s+/g, ' ').trim();
  let changed = true;

  while (changed && normalizedKeyword) {
    changed = false;
    const leadingTag = normalizedKeyword.match(/^\[([^\]]{1,40})\]\s*/);
    if (leadingTag && decorationTag(leadingTag[1])) {
      removedDecorations.push(leadingTag[0].trim());
      normalizedKeyword = normalizedKeyword.slice(leadingTag[0].length).trim();
      changed = true;
    }
    const trailingTag = normalizedKeyword.match(/\s*\(([^)]{1,40})\)$/);
    if (trailingTag && decorationTag(trailingTag[1])) {
      removedDecorations.push(trailingTag[0].trim());
      normalizedKeyword = normalizedKeyword.slice(0, trailingTag.index).trim();
      changed = true;
    }
    const leadingDelimitedTag = normalizedKeyword.match(/^([^|:–—-]{1,30})\s*[|:–—-]\s*/);
    if (leadingDelimitedTag && decorationTag(leadingDelimitedTag[1])) {
      removedDecorations.push(leadingDelimitedTag[0].trim());
      normalizedKeyword = normalizedKeyword.slice(leadingDelimitedTag[0].length).trim();
      changed = true;
    }
    const trailingDelimitedTag = normalizedKeyword.match(/\s*[|:–—-]\s*([^|:–—-]{1,30})$/);
    if (trailingDelimitedTag && decorationTag(trailingDelimitedTag[1])) {
      removedDecorations.push(trailingDelimitedTag[0].trim());
      normalizedKeyword = normalizedKeyword.slice(0, trailingDelimitedTag.index).trim();
      changed = true;
    }
    const withoutEmoji = stripEdgeEmoji(normalizedKeyword, removedDecorations).replace(/\s+/g, ' ').trim();
    if (withoutEmoji !== normalizedKeyword) {
      normalizedKeyword = withoutEmoji;
      changed = true;
    }
  }

  return {
    originalName: String(originalName).trim(),
    normalizedKeyword,
    removedDecorations,
    normalizationVersion: ROBLOX_TITLE_NORMALIZATION_VERSION,
  };
}

export function isMeaningfulRobloxTitle(value = '') {
  const normalized = canonicalLabel(value);
  if (normalized.length < 3 || !/[a-z]/.test(normalized)) return false;
  return !/^(?:test|testing|new game|untitled|place|game|roblox game|my game|template)$/.test(normalized);
}

export function isRobloxCandidate(candidate = {}) {
  return Boolean(candidate.roblox?.universeId) || String(candidate.id || '').startsWith('roblox:');
}

function getSorts(payload) {
  const candidates = [payload?.sorts, payload?.data?.sorts, payload?.response?.sorts];
  return candidates.find(Array.isArray) || null;
}

function getSortItems(sort) {
  const candidates = [
    sort?.games,
    sort?.items,
    sort?.content,
    sort?.gameSet?.games,
    sort?.gameSet?.items,
    sort?.gameTiles,
    sort?.contents,
  ];
  return candidates.find(Array.isArray) || null;
}

function sortName(sort = {}) {
  return sort.sortDisplayName || sort.displayName || sort.name || sort.title || sort.topic || sort.topicLayoutData?.title || '';
}

function sponsoredStatus(item = {}) {
  if (item.isSponsored === true || item.sponsored === true || Boolean(item.adId || item.nativeAdData)) return true;
  if (item.isSponsored === false || item.sponsored === false) return false;
  return 'unknown';
}

function parseChartItem(item, position, sourceId) {
  const scope = `charts:${sourceId}`;
  const fatalErrors = [];
  const validationErrors = [];
  const rawUniverseId = item?.universeId ?? item?.universeID ?? item?.universe?.id ?? item?.game?.universeId;
  const universeId = positiveIntegerId(rawUniverseId);
  if (!universeId) fatalErrors.push(validationError(scope, 'INVALID_UNIVERSE_ID', 'universeId', 'Universe ID must be a positive integer string', { itemIndex: position - 1 }));

  const rawRootPlaceId = item?.rootPlaceId ?? item?.placeId ?? item?.rootPlace?.id;
  const rootPlaceId = rawRootPlaceId === null || rawRootPlaceId === undefined || rawRootPlaceId === '' ? null : positiveIntegerId(rawRootPlaceId);
  if (rawRootPlaceId !== null && rawRootPlaceId !== undefined && rawRootPlaceId !== '' && !rootPlaceId) {
    fatalErrors.push(validationError(scope, 'INVALID_ROOT_PLACE_ID', 'rootPlaceId', 'Root Place ID must be a positive integer string when present', { itemIndex: position - 1, universeId }));
  }

  const rawName = item?.name ?? item?.gameName ?? item?.title ?? item?.universe?.name;
  const originalName = typeof rawName === 'string' ? rawName.trim() : '';
  const title = normalizeRobloxTitle(originalName);
  if (!originalName || !title.normalizedKeyword) {
    fatalErrors.push(validationError(scope, 'INVALID_NAME', 'name', 'Game name must be a non-empty string after normalization', { itemIndex: position - 1, universeId }));
  }

  const hasExplicitRank = item?.rank !== null && item?.rank !== undefined && item?.rank !== '';
  const explicitRank = hasExplicitRank ? nonNegativeInteger(item.rank) : null;
  const rank = hasExplicitRank ? (explicitRank > 0 ? explicitRank : null) : position;
  if (hasExplicitRank && rank === null) {
    validationErrors.push(validationError(scope, 'INVALID_RANK', 'rank', 'Explicit rank must be a positive integer; rank evidence was disabled', { itemIndex: position - 1, universeId }));
  }

  const sponsored = sponsoredStatus(item);
  if (sponsored === 'unknown') {
    validationErrors.push(validationError(scope, 'UNKNOWN_SPONSORED_STATUS', 'sponsored', 'Sponsored status is unknown; natural chart evidence was disabled', { itemIndex: position - 1, universeId }));
  }

  if (fatalErrors.length) return { entry: null, fatalErrors, validationErrors };
  return {
    entry: {
      universeId,
      rootPlaceId,
      originalName,
      ...title,
      playing: nonNegativeInteger(item.playing ?? item.playerCount ?? item.concurrentPlayers),
      visits: nonNegativeInteger(item.visits ?? item.visitCount),
      favorites: nonNegativeInteger(item.favorites ?? item.favoritedCount),
      rank,
      rankSource: hasExplicitRank ? 'field' : 'position',
      sponsored,
    },
    fatalErrors,
    validationErrors,
  };
}

export function parseRobloxChartsPayload(payload, sources, scannedAt = new Date().toISOString()) {
  const sorts = getSorts(payload);
  if (!sorts) {
    throw new RobloxSchemaValidationError(
      'Roblox Charts response structure changed: sorts array missing',
      [validationError('charts', 'MISSING_SORTS_ARRAY', 'sorts', 'Charts response must contain a sorts array')],
    );
  }
  const results = [];

  for (const source of sources) {
    const wanted = chartKey(source.chartName || source.chart || source.id);
    const sort = sorts.find((item) => chartKey(sortName(item)) === wanted);
    if (!sort) {
      throw new RobloxSchemaValidationError(
        `Roblox Charts sort not found: ${source.chartName || source.id}`,
        [validationError(`charts:${source.id}`, 'MISSING_TARGET_SORT', 'sortDisplayName', 'Configured target sort was not present')],
      );
    }
    const items = getSortItems(sort);
    if (!items) {
      throw new RobloxSchemaValidationError(
        `Roblox Charts response structure changed for ${source.chartName || source.id}: games array missing`,
        [validationError(`charts:${source.id}`, 'MISSING_GAMES_ARRAY', 'games', 'Target sort must contain a supported games array')],
      );
    }
    const parsed = items.map((item, index) => parseChartItem(item, index + 1, source.id));
    const fatalErrors = parsed.flatMap((item) => item.fatalErrors);
    const validationErrors = parsed.flatMap((item) => item.validationErrors);
    if (fatalErrors.length) {
      throw new RobloxSchemaValidationError(`Roblox Charts schema validation failed for ${source.chartName || source.id}`, fatalErrors);
    }
    const entries = parsed.map((item) => item.entry).filter(Boolean);
    if (!entries.length) {
      throw new RobloxSchemaValidationError(
        `Roblox Charts returned an empty ${source.chartName || source.id} sort; previous state was preserved`,
        [validationError(`charts:${source.id}`, 'EMPTY_CHART', 'games', 'Chart contained no valid game entries')],
      );
    }
    results.push({ source, entries, validationErrors, detectedType: 'roblox-chart', scannedAt });
  }

  return results;
}

function retryAfterMs(response, nowMs) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}

function chartsUrl(endpoint, sessionId) {
  const url = new URL(endpoint);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('device', 'computer');
  url.searchParams.set('country', 'all');
  url.searchParams.set('sortsPageToken', '');
  url.searchParams.set('gameSetTargetId', '');
  url.searchParams.set('includeMetadata', 'true');
  return url.toString();
}

async function fetchChartsPayload(fetchImpl, url, sleepFn, nowMs, requestOptions) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { response, payload } = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, requestOptions);
    if (response.ok) return { payload, attempts: attempt + 1 };
    const waitMs = retryAfterMs(response, nowMs);
    if (response.status === 429 && attempt === 0 && waitMs > 0 && waitMs <= 30000) {
      await sleepFn(waitMs);
      continue;
    }
    const error = new Error(`Roblox Charts returned HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfterMs = waitMs;
    throw error;
  }
  throw new Error('Roblox Charts retry limit reached');
}

export async function scanRobloxCharts(sources = [], options = {}) {
  const configuredSources = sources.filter((source) => source.fetchKind === 'roblox-charts');
  const enabledSources = configuredSources.filter((source) => source.enabled !== false);
  const generatedAt = new Date(options.nowMs || Date.now()).toISOString();
  const base = {
    configured: configuredSources.length > 0,
    ran: enabledSources.length > 0,
    success: enabledSources.length ? false : null,
    chartSources: enabledSources.map((source) => source.id),
    sourceResults: [],
    errors: [],
    generatedAt,
  };
  if (!enabledSources.length) return base;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ...base, errors: ['Roblox Charts fetch implementation is unavailable'] };
  const sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const endpoint = options.endpoints?.charts || ROBLOX_DISCOVERY_ENDPOINTS.charts;
  const url = chartsUrl(endpoint, options.sessionId || randomUUID());
  try {
    const requestOptions = {
      timeoutMs: options.timeoutMs,
      setTimeoutImpl: options.setTimeoutImpl,
      clearTimeoutImpl: options.clearTimeoutImpl,
    };
    const { payload } = await fetchChartsPayload(fetchImpl, url, sleepFn, Number(options.nowMs || Date.now()), requestOptions);
    const sourceResults = parseRobloxChartsPayload(payload, enabledSources, generatedAt);
    return { ...base, success: true, sourceResults };
  } catch (error) {
    return {
      ...base,
      success: false,
      errors: [{ message: error.message, code: error.code || null, status: error.status || null, retryAfterMs: error.retryAfterMs || 0, validationErrors: error.validationErrors || [] }],
    };
  }
}

export function parseRobloxGamesPayload(payload = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (!rows) {
    throw new RobloxSchemaValidationError(
      'Roblox Games response structure changed: data array missing',
      [validationError('games', 'MISSING_DATA_ARRAY', 'data', 'Games response must contain a data array')],
    );
  }
  const games = new Map();
  const errors = [];
  rows.forEach((row, index) => {
    const scope = 'games';
    const universeId = positiveIntegerId(row?.id ?? row?.universeId);
    const rootPlaceId = positiveIntegerId(row?.rootPlaceId);
    const originalName = typeof row?.name === 'string' ? row.name.trim() : '';
    const normalizedName = normalizeRobloxTitle(originalName).normalizedKeyword;
    const creatorId = positiveIntegerId(row?.creator?.id);
    const creatorName = typeof row?.creator?.name === 'string' ? row.creator.name.trim() : '';
    const creatorType = typeof row?.creator?.type === 'string' ? row.creator.type.trim() : '';
    const playing = nonNegativeApiInteger(row?.playing);
    const visits = nonNegativeApiInteger(row?.visits);
    const favorites = nonNegativeApiInteger(row?.favoritedCount ?? row?.favorites);
    if (!universeId) errors.push(validationError(scope, 'INVALID_UNIVERSE_ID', 'id', 'Games Universe ID must be a positive integer string', { itemIndex: index }));
    if (!rootPlaceId) errors.push(validationError(scope, 'INVALID_ROOT_PLACE_ID', 'rootPlaceId', 'Games Root Place ID must be a positive integer string', { itemIndex: index, universeId }));
    if (!originalName || !normalizedName) errors.push(validationError(scope, 'INVALID_NAME', 'name', 'Games name must be a non-empty string after normalization', { itemIndex: index, universeId }));
    if (!row?.creator || typeof row.creator !== 'object' || !creatorId || !creatorName || !creatorType) {
      errors.push(validationError(scope, 'INVALID_CREATOR', 'creator', 'Creator must contain a positive ID, non-empty name, and non-empty type', { itemIndex: index, universeId }));
    }
    if (playing === null) errors.push(validationError(scope, 'INVALID_PLAYING', 'playing', 'Playing must be a non-negative integer', { itemIndex: index, universeId }));
    if (visits === null) errors.push(validationError(scope, 'INVALID_VISITS', 'visits', 'Visits must be a non-negative integer', { itemIndex: index, universeId }));
    if (favorites === null) errors.push(validationError(scope, 'INVALID_FAVORITES', 'favoritedCount', 'Favorites must be a non-negative integer', { itemIndex: index, universeId }));
    if (!validNullableDate(row?.created ?? row?.createdAt)) errors.push(validationError(scope, 'INVALID_CREATED_AT', 'created', 'Created date must be parseable or null', { itemIndex: index, universeId }));
    if (!validNullableDate(row?.updated ?? row?.updatedAt)) errors.push(validationError(scope, 'INVALID_UPDATED_AT', 'updated', 'Updated date must be parseable or null', { itemIndex: index, universeId }));
    if (!universeId || !rootPlaceId || !originalName || !normalizedName || !creatorId || !creatorName || !creatorType || playing === null || visits === null || favorites === null || !validNullableDate(row?.created ?? row?.createdAt) || !validNullableDate(row?.updated ?? row?.updatedAt)) return;
    if (games.has(universeId)) {
      errors.push(validationError(scope, 'DUPLICATE_UNIVERSE_ID', 'id', 'Games response contains a duplicate Universe ID', { itemIndex: index, universeId }));
      return;
    }
    games.set(universeId, {
      universeId,
      rootPlaceId,
      originalName,
      creator: {
        id: creatorId,
        name: creatorName,
        type: creatorType,
      },
      createdAt: row.created || row.createdAt || null,
      updatedAt: row.updated || row.updatedAt || null,
      playing,
      visits,
      favorites,
      genreL1: row.genre_l1 || row.genreL1 || null,
      genreL2: row.genre_l2 || row.genreL2 || null,
    });
  });
  if (errors.length) throw new RobloxSchemaValidationError('Roblox Games schema validation failed', errors);
  return games;
}

export async function fetchRobloxGameMetadata(universeIds, options = {}) {
  const rawIds = [...new Set((universeIds || []).map(asString))];
  const ids = rawIds.map(positiveIntegerId).filter(Boolean);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const endpoint = options.endpoints?.games || ROBLOX_DISCOVERY_ENDPOINTS.games;
  const games = new Map();
  const errors = [];
  if (ids.length !== rawIds.length) {
    errors.push(validationError('games-request', 'INVALID_UNIVERSE_ID', 'universeIds', 'Metadata request contains an invalid Universe ID'));
    return { games, errors, complete: false };
  }
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const url = new URL(endpoint);
    url.searchParams.set('universeIds', batch.join(','));
    try {
      const { response, payload } = await fetchWithTimeout(fetchImpl, url.toString(), { headers: { Accept: 'application/json' } }, {
        timeoutMs: options.timeoutMs,
        setTimeoutImpl: options.setTimeoutImpl,
        clearTimeoutImpl: options.clearTimeoutImpl,
      });
      if (!response.ok) {
        const error = new Error(`Roblox Games returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      for (const [id, game] of parseRobloxGamesPayload(payload)) games.set(id, game);
    } catch (error) {
      errors.push({ scope: 'games-request', code: error.code || 'ROBLOX_GAMES_REQUEST_FAILED', status: error.status || null, universeIds: batch, message: error.message, validationErrors: error.validationErrors || [] });
      return { games, errors, complete: false };
    }
  }
  const expected = new Set(ids);
  const missing = ids.filter((id) => !games.has(id));
  const unexpected = [...games.keys()].filter((id) => !expected.has(id));
  if (missing.length) errors.push(validationError('games-response', 'MISSING_UNIVERSES', 'data', 'Games response did not contain every requested Universe ID', { universeIds: missing }));
  if (unexpected.length) errors.push(validationError('games-response', 'UNEXPECTED_UNIVERSES', 'data', 'Games response contained unrequested Universe IDs', { universeIds: unexpected }));
  return { games, errors, complete: errors.length === 0 && games.size === ids.length };
}

function tokenSimilarity(left, right) {
  const a = new Set(canonicalLabel(left).split(' ').filter(Boolean));
  const b = new Set(canonicalLabel(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / new Set([...a, ...b]).size;
}

export function isSignificantRobloxRename(previousName, currentName) {
  const previous = normalizeRobloxTitle(previousName).normalizedKeyword;
  const current = normalizeRobloxTitle(currentName).normalizedKeyword;
  if (!previous || !current || canonicalLabel(previous) === canonicalLabel(current)) return false;
  return tokenSimilarity(previous, current) < 0.6;
}

function findSnapshot(snapshots, currentAt, hours) {
  const target = currentAt - hours * HOUR;
  return snapshots
    .map((snapshot) => ({ snapshot, distance: Math.abs(Date.parse(snapshot.at || '') - target) }))
    .filter((item) => Number.isFinite(item.distance) && item.distance <= SNAPSHOT_TOLERANCE)
    .sort((a, b) => a.distance - b.distance)[0]?.snapshot || null;
}

function delta(current, previous) {
  const currentNumber = finiteNumber(current);
  const previousNumber = finiteNumber(previous);
  return currentNumber === null || previousNumber === null ? null : currentNumber - previousNumber;
}

function growth(current, previous) {
  const change = delta(current, previous);
  const base = finiteNumber(previous);
  if (change === null || base === null || base <= 0) return null;
  return Math.round((change / base) * 1000) / 10;
}

function maxRankGain(currentRankings, previousRankings) {
  const gains = Object.entries(currentRankings || {}).map(([sourceId, current]) => {
    const previous = finiteNumber(previousRankings?.[sourceId]);
    const currentRank = finiteNumber(current);
    return previous !== null && currentRank !== null ? Math.max(0, previous - currentRank) : 0;
  });
  return gains.length ? Math.max(...gains) : 0;
}

export function calculateRobloxGrowth(currentSnapshot, historicalSnapshots = []) {
  const currentAt = Date.parse(currentSnapshot?.at || '');
  const baseline24h = Number.isFinite(currentAt) ? findSnapshot(historicalSnapshots, currentAt, 24) : null;
  const baseline48h = Number.isFinite(currentAt) ? findSnapshot(historicalSnapshots, currentAt, 48) : null;
  return {
    ccuDelta24h: baseline24h ? delta(currentSnapshot.playing, baseline24h.playing) : null,
    ccuGrowth24h: baseline24h ? growth(currentSnapshot.playing, baseline24h.playing) : null,
    ccuDelta48h: baseline48h ? delta(currentSnapshot.playing, baseline48h.playing) : null,
    ccuGrowth48h: baseline48h ? growth(currentSnapshot.playing, baseline48h.playing) : null,
    visitsDelta24h: baseline24h ? delta(currentSnapshot.visits, baseline24h.visits) : null,
    favoritesDelta24h: baseline24h ? delta(currentSnapshot.favorites, baseline24h.favorites) : null,
    maxRankGain24h: baseline24h ? maxRankGain(currentSnapshot.rankings, baseline24h.rankings) : null,
    firstChartEntry24h: baseline24h
      ? (currentSnapshot.sourceIds || []).some((sourceId) => !(baseline24h.sourceIds || []).includes(sourceId))
      : false,
    chartSourceCount: new Set(currentSnapshot.sourceIds || []).size,
  };
}

export function compactRobloxSnapshots(snapshots, nowMs = Date.now()) {
  const valid = [...(snapshots || [])]
    .filter((snapshot) => Number.isFinite(Date.parse(snapshot.at || '')) && nowMs - Date.parse(snapshot.at) <= DAILY_RETENTION)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const fine = valid.filter((snapshot) => nowMs - Date.parse(snapshot.at) <= FINE_GRAINED_RETENTION);
  const daily = new Map();
  for (const snapshot of valid.filter((item) => nowMs - Date.parse(item.at) > FINE_GRAINED_RETENTION)) {
    daily.set(snapshot.at.slice(0, 10), snapshot);
  }
  return [...daily.values(), ...fine].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function mergeNameHistory(roblox, originalName, title, now) {
  if (!originalName) return;
  if (!roblox.nameHistory.length && roblox.originalName && roblox.originalName !== originalName) {
    const previous = normalizeRobloxTitle(roblox.originalName);
    roblox.nameHistory.push({ originalName: roblox.originalName, normalizedKeyword: previous.normalizedKeyword, firstSeen: roblox.firstSeen || now, lastSeen: roblox.lastSeen || now });
  }
  const last = roblox.nameHistory.at(-1);
  if (last?.originalName === originalName) {
    last.lastSeen = now;
    return;
  }
  if (last && isSignificantRobloxRename(last.originalName, originalName)) {
    roblox.renameEvents.push({ at: now, from: last.originalName, to: originalName, significant: true });
  }
  roblox.nameHistory.push({ originalName, normalizedKeyword: title.normalizedKeyword, firstSeen: now, lastSeen: now });
}

function sourceRecordFor(candidate, source, entry, now) {
  const key = `${source.id}|${entry.universeId}`;
  let record = candidate.sources.find((item) => item.key === key);
  const observedRank = finiteNumber(entry.rank);
  const rank = entry.sponsored === false && Number.isInteger(observedRank) && observedRank > 0 ? observedRank : null;
  if (!record) {
    record = {
      key,
      sourceId: source.id,
      name: source.name,
      kind: source.kind,
      url: entry.rootPlaceId ? `https://www.roblox.com/games/${entry.rootPlaceId}` : 'https://www.roblox.com/charts',
      firstSeen: now,
      lastSeen: now,
      currentRank: rank,
      previousRank: null,
      bestRank: rank,
      sponsored: entry.sponsored,
      observedRank,
    };
    candidate.sources.push(record);
  } else {
    record.lastSeen = now;
    record.sponsored = entry.sponsored;
    record.observedRank = observedRank;
    if (rank !== null) {
      record.previousRank = record.currentRank;
      record.currentRank = rank;
      record.bestRank = record.bestRank === null || record.bestRank === undefined ? rank : Math.min(record.bestRank, rank);
    } else {
      record.previousRank = record.currentRank;
      record.currentRank = null;
    }
  }
  return record;
}

export function mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse = new Map(), now = new Date().toISOString() }) {
  const targetCandidates = candidates || [];
  const targetState = state || {};
  const candidateList = structuredClone(targetCandidates);
  const radarState = structuredClone(targetState);
  radarState.roblox ||= { universes: {} };
  radarState.roblox.universes ||= {};
  const discovered = new Map();

  for (const result of sourceResults || []) {
    for (const entry of result.entries || []) {
      const universeId = positiveIntegerId(entry.universeId);
      if (!universeId) {
        throw new RobloxSchemaValidationError(
          'Roblox merge rejected an invalid Universe ID',
          [validationError(`merge:${result.source?.id || 'unknown'}`, 'INVALID_UNIVERSE_ID', 'universeId', 'Universe ID must be validated before merge')],
        );
      }
      if (!discovered.has(universeId)) discovered.set(universeId, []);
      discovered.get(universeId).push({ source: result.source, entry });
    }
  }

  let newUniverses = 0;
  let updatedUniverses = 0;
  for (const [universeId, appearances] of discovered) {
    const metadata = metadataByUniverse.get?.(universeId) || metadataByUniverse[universeId] || {};
    const representative = appearances[0].entry;
    const originalName = String(metadata.originalName || representative.originalName || '').trim();
    const title = normalizeRobloxTitle(originalName);
    if (!title.normalizedKeyword) continue;
    let candidate = candidateList.find((item) => asString(item.roblox?.universeId) === universeId || item.id === `roblox:${universeId}`);
    const isNew = !candidate;
    if (isNew) {
      candidate = {
        id: `roblox:${universeId}`,
        gameName: title.normalizedKeyword,
        normalizedName: normalizeGameName(title.normalizedKeyword),
        firstSeen: now,
        lastSeen: now,
        status: 'new',
        sources: [],
        recommendation: 'pending',
      };
      candidateList.push(candidate);
      newUniverses += 1;
    } else {
      updatedUniverses += 1;
    }

    candidate.sources ||= [];
    const previousKeyword = candidate.roblox?.normalizedKeyword || candidate.gameName;
    candidate.roblox ||= { universeId, firstSeen: candidate.firstSeen || now, rankings: {}, nameHistory: [], renameEvents: [] };
    candidate.roblox.universeId = universeId;
    candidate.roblox.firstSeen ||= candidate.firstSeen || now;
    candidate.roblox.rankings ||= {};
    candidate.roblox.nameHistory ||= [];
    candidate.roblox.renameEvents ||= [];
    mergeNameHistory(candidate.roblox, originalName, title, now);

    if (previousKeyword && normalizeGameName(previousKeyword) !== normalizeGameName(title.normalizedKeyword)) {
      delete candidate.seo;
      delete candidate.fast;
      delete candidate.trend;
      delete candidate.youtube;
      delete candidate.social;
      delete candidate.marketFreshness;
      delete candidate.opportunity;
      delete candidate.todayReview;
      candidate.finalScore = 0;
      candidate.score = 0;
      candidate.level = 'pending';
      candidate.recommendation = 'pending';
    }
    candidate.gameName = title.normalizedKeyword;
    candidate.normalizedName = normalizeGameName(title.normalizedKeyword);
    candidate.lastSeen = now;

    const naturalSourceIds = [];
    const snapshotRankings = {};
    for (const appearance of appearances) {
      const record = sourceRecordFor(candidate, appearance.source, { ...appearance.entry, rootPlaceId: metadata.rootPlaceId || appearance.entry.rootPlaceId }, now);
      const previousRanking = candidate.roblox.rankings[appearance.source.id];
      const naturalEvidence = appearance.entry.sponsored === false && Number.isInteger(record.currentRank) && record.currentRank > 0;
      candidate.roblox.rankings[appearance.source.id] = {
        currentRank: naturalEvidence ? record.currentRank : null,
        previousRank: naturalEvidence ? record.previousRank : previousRanking?.currentRank ?? null,
        bestRank: previousRanking?.bestRank ?? (naturalEvidence ? record.bestRank : null),
        firstSeen: previousRanking?.firstSeen || now,
        lastSeen: now,
        sponsored: appearance.entry.sponsored,
      };
      if (naturalEvidence) {
        candidate.roblox.rankings[appearance.source.id].bestRank = candidate.roblox.rankings[appearance.source.id].bestRank === null
          ? record.currentRank
          : Math.min(candidate.roblox.rankings[appearance.source.id].bestRank, record.currentRank);
        naturalSourceIds.push(appearance.source.id);
        snapshotRankings[appearance.source.id] = record.currentRank;
      }
    }

    Object.assign(candidate.roblox, {
      rootPlaceId: metadata.rootPlaceId || representative.rootPlaceId || candidate.roblox.rootPlaceId || null,
      originalName,
      normalizedKeyword: title.normalizedKeyword,
      removedDecorations: title.removedDecorations,
      normalizationVersion: title.normalizationVersion,
      creator: metadata.creator || candidate.roblox.creator || { id: null, name: null, type: null },
      createdAt: metadata.createdAt || candidate.roblox.createdAt || null,
      updatedAt: metadata.updatedAt || candidate.roblox.updatedAt || null,
      playing: metadata.playing ?? representative.playing ?? candidate.roblox.playing ?? null,
      visits: metadata.visits ?? representative.visits ?? candidate.roblox.visits ?? null,
      favorites: metadata.favorites ?? representative.favorites ?? candidate.roblox.favorites ?? null,
      genreL1: metadata.genreL1 || candidate.roblox.genreL1 || null,
      genreL2: metadata.genreL2 || candidate.roblox.genreL2 || null,
      lastSeen: now,
    });

    const universeState = radarState.roblox.universes[universeId] ||= { snapshots: [] };
    universeState.snapshots ||= [];
    const snapshot = {
      at: now,
      playing: candidate.roblox.playing,
      visits: candidate.roblox.visits,
      favorites: candidate.roblox.favorites,
      rankings: snapshotRankings,
      sourceIds: [...new Set(naturalSourceIds)],
    };
    candidate.roblox.latestGrowth = calculateRobloxGrowth(snapshot, universeState.snapshots);
    universeState.snapshots = compactRobloxSnapshots([...universeState.snapshots, snapshot], Date.parse(now));
    universeState.firstSeen ||= candidate.roblox.firstSeen;
    universeState.lastSeen = now;
  }

  targetCandidates.splice(0, targetCandidates.length, ...candidateList);
  for (const key of Object.keys(targetState)) delete targetState[key];
  Object.assign(targetState, radarState);
  return { universesFound: discovered.size, newUniverses, updatedUniverses };
}

export function buildValidatedRobloxBatch(sourceResults, metadataResult) {
  const errors = [];
  const validationErrors = (sourceResults || []).flatMap((result) => result.validationErrors || []);
  const universeIds = [];
  for (const result of sourceResults || []) {
    for (const entry of result.entries || []) {
      const scope = `batch:${result.source?.id || 'unknown'}`;
      if (!positiveIntegerId(entry.universeId)) errors.push(validationError(scope, 'INVALID_UNIVERSE_ID', 'universeId', 'Prepared chart entry has an invalid Universe ID'));
      if (entry.rootPlaceId !== null && entry.rootPlaceId !== undefined && !positiveIntegerId(entry.rootPlaceId)) errors.push(validationError(scope, 'INVALID_ROOT_PLACE_ID', 'rootPlaceId', 'Prepared chart entry has an invalid Root Place ID', { universeId: entry.universeId }));
      if (typeof entry.originalName !== 'string' || !normalizeRobloxTitle(entry.originalName).normalizedKeyword) errors.push(validationError(scope, 'INVALID_NAME', 'name', 'Prepared chart entry has an invalid name', { universeId: entry.universeId }));
      if (entry.rank !== null && (!Number.isInteger(entry.rank) || entry.rank <= 0)) errors.push(validationError(scope, 'INVALID_RANK', 'rank', 'Prepared chart rank must be null or a positive integer', { universeId: entry.universeId }));
      if (![true, false, 'unknown'].includes(entry.sponsored)) errors.push(validationError(scope, 'INVALID_SPONSORED_STATUS', 'sponsored', 'Prepared chart sponsored status must be true, false, or unknown', { universeId: entry.universeId }));
      if (positiveIntegerId(entry.universeId)) universeIds.push(String(entry.universeId));
    }
  }
  const uniqueUniverseIds = [...new Set(universeIds)];
  if (!uniqueUniverseIds.length) errors.push(validationError('batch', 'EMPTY_BATCH', 'universeIds', 'Validated Roblox batch must contain at least one Universe ID'));
  for (const error of metadataResult?.errors || []) errors.push(error);
  if (metadataResult?.complete !== true) errors.push(validationError('batch', 'INCOMPLETE_ENRICHMENT', 'metadata', 'Games enrichment was not complete'));
  const metadataByUniverse = metadataResult?.games || new Map();
  const expectedIds = new Set(uniqueUniverseIds);
  const unexpectedIds = [...(metadataByUniverse.keys?.() || [])].filter((id) => !expectedIds.has(String(id)));
  if (unexpectedIds.length) errors.push(validationError('batch', 'UNEXPECTED_UNIVERSES', 'metadata', 'Games enrichment contains unrequested Universes', { universeIds: unexpectedIds }));
  if (metadataByUniverse.size !== uniqueUniverseIds.length) errors.push(validationError('batch', 'ENRICHMENT_COUNT_MISMATCH', 'metadata', 'Games enrichment count does not match the chart Universe count'));
  for (const universeId of uniqueUniverseIds) {
    const game = metadataByUniverse.get?.(universeId);
    if (!game) {
      errors.push(validationError('batch', 'MISSING_UNIVERSE', 'metadata', 'Games enrichment is missing a requested Universe', { universeId }));
      continue;
    }
    if (game.universeId !== universeId) errors.push(validationError('batch', 'UNIVERSE_ID_MISMATCH', 'universeId', 'Games enrichment Universe ID does not match the requested ID', { universeId }));
    if (!positiveIntegerId(game.rootPlaceId)) errors.push(validationError('batch', 'INVALID_ROOT_PLACE_ID', 'rootPlaceId', 'Complete enrichment requires a valid Root Place ID', { universeId }));
    if (typeof game.originalName !== 'string' || !normalizeRobloxTitle(game.originalName).normalizedKeyword) errors.push(validationError('batch', 'INVALID_NAME', 'name', 'Complete enrichment requires a valid game name', { universeId }));
    if (!game.creator || !positiveIntegerId(game.creator.id) || typeof game.creator.name !== 'string' || !game.creator.name.trim() || typeof game.creator.type !== 'string' || !game.creator.type.trim()) errors.push(validationError('batch', 'INVALID_CREATOR', 'creator', 'Complete enrichment requires a valid creator structure', { universeId }));
    if (nonNegativeApiInteger(game.playing) === null) errors.push(validationError('batch', 'INVALID_PLAYING', 'playing', 'Complete enrichment requires a non-negative playing count', { universeId }));
    if (nonNegativeApiInteger(game.visits) === null) errors.push(validationError('batch', 'INVALID_VISITS', 'visits', 'Complete enrichment requires a non-negative visits count', { universeId }));
    if (nonNegativeApiInteger(game.favorites) === null) errors.push(validationError('batch', 'INVALID_FAVORITES', 'favorites', 'Complete enrichment requires a non-negative favorites count', { universeId }));
    if (!validNullableDate(game.createdAt)) errors.push(validationError('batch', 'INVALID_CREATED_AT', 'createdAt', 'Complete enrichment createdAt must be parseable or null', { universeId }));
    if (!validNullableDate(game.updatedAt)) errors.push(validationError('batch', 'INVALID_UPDATED_AT', 'updatedAt', 'Complete enrichment updatedAt must be parseable or null', { universeId }));
  }
  return {
    valid: errors.length === 0,
    universeIds: uniqueUniverseIds,
    metadataByUniverse,
    validationErrors,
    errors,
  };
}

export async function runRobloxDiscoveryTransaction({ candidates, state, sourceResults, now = new Date().toISOString(), fetchOptions = {} }) {
  const universeIds = [...new Set((sourceResults || []).flatMap((result) => result.entries || []).map((entry) => entry.universeId).filter(Boolean))];
  const metadataResult = await fetchRobloxGameMetadata(universeIds, fetchOptions);
  const batch = buildValidatedRobloxBatch(sourceResults, metadataResult);
  if (!batch.valid) {
    return {
      success: false,
      universesFound: universeIds.length,
      newUniverses: 0,
      updatedUniverses: 0,
      validationErrors: batch.validationErrors,
      errors: batch.errors,
    };
  }
  const merged = mergeRobloxDiscovery({ candidates, state, sourceResults, metadataByUniverse: batch.metadataByUniverse, now });
  return { success: true, ...merged, validationErrors: batch.validationErrors, errors: [] };
}
