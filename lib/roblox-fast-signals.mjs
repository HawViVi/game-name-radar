import { isMeaningfulRobloxTitle, isRobloxCandidate } from './roblox-discovery.mjs';

export const ROBLOX_FAST_MODEL_VERSION = 1;
export const ROBLOX_TODAY_REVIEW_HIGH_PRIORITY = 65;

const DAY = 86400000;

function clamp(value, max = 100) {
  return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}

function positive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function freshnessScore(roblox, nowMs) {
  const created = Date.parse(roblox.createdAt || '');
  const firstSeen = Date.parse(roblox.firstSeen || '');
  const reference = Number.isFinite(created) ? created : firstSeen;
  if (!Number.isFinite(reference)) return 0;
  const age = Math.max(0, nowMs - reference);
  if (age <= 3 * DAY) return 15;
  if (age <= 7 * DAY) return 12;
  if (age <= 14 * DAY) return 8;
  if (age <= 30 * DAY) return 3;
  return 0;
}

function ccuScore(growth) {
  const delta24h = Number(growth.ccuDelta24h);
  const relative24h = Number(growth.ccuGrowth24h);
  const delta48h = Number(growth.ccuDelta48h);
  const relative48h = Number(growth.ccuGrowth48h);
  let absolute = 0;
  if (delta24h >= 1000) absolute = 18;
  else if (delta24h >= 250) absolute = 14;
  else if (delta24h >= 50) absolute = 10;
  else if (delta24h > 0) absolute = 4;
  else if (delta48h >= 1500) absolute = 12;
  else if (delta48h >= 400) absolute = 9;
  else if (delta48h >= 100) absolute = 6;

  let relative = 0;
  if (relative24h >= 100) relative = 17;
  else if (relative24h >= 50) relative = 14;
  else if (relative24h >= 25) relative = 10;
  else if (relative24h >= 10) relative = 6;
  else if (relative24h > 0) relative = 3;
  else if (relative48h >= 100) relative = 11;
  else if (relative48h >= 50) relative = 8;
  else if (relative48h >= 20) relative = 5;
  return clamp(absolute + relative, 35);
}

function engagementScore(growth) {
  const visits = Number(growth.visitsDelta24h);
  const favorites = Number(growth.favoritesDelta24h);
  let score = visits >= 100000 ? 12 : visits >= 20000 ? 8 : visits >= 5000 ? 5 : visits > 0 ? 2 : 0;
  score += favorites >= 1000 ? 8 : favorites >= 200 ? 5 : favorites >= 50 ? 3 : favorites > 0 ? 1 : 0;
  return clamp(score, 20);
}

function chartScore(roblox, growth) {
  const upAndComing = roblox.rankings?.['roblox-up-and-coming'];
  const upAndComingRank = Number(upAndComing?.currentRank || 0);
  const rankGain = Number(growth.maxRankGain24h || 0);
  let score = 0;
  if (growth.firstChartEntry24h) score += 10;
  if (rankGain >= 20) score += 12;
  else if (rankGain >= 10) score += 9;
  else if (rankGain >= 5) score += 5;
  if (upAndComingRank > 0 && upAndComingRank <= 20) score += 8;
  else if (upAndComingRank > 0 && upAndComingRank <= 50) score += 4;
  if (Number(growth.chartSourceCount || 0) >= 2) score += 5;
  return clamp(score, 25);
}

function qualityScore(candidate) {
  const roblox = candidate.roblox || {};
  let score = 0;
  if (isMeaningfulRobloxTitle(roblox.normalizedKeyword || candidate.gameName)) score += 3;
  if (roblox.rootPlaceId && roblox.creator?.id) score += 2;
  return clamp(score, 5);
}

function evidence(growth) {
  const signals = [];
  if (positive(growth.ccuDelta24h) && positive(growth.ccuGrowth24h)) signals.push('ccu-growth');
  else if (positive(growth.ccuDelta48h) && positive(growth.ccuGrowth48h)) signals.push('ccu-growth');
  if (positive(growth.visitsDelta24h)) signals.push('visits-growth');
  if (positive(growth.favoritesDelta24h)) signals.push('favorites-growth');
  if (Number(growth.maxRankGain24h || 0) >= 5) signals.push('rank-growth');
  if (growth.firstChartEntry24h) signals.push('first-chart-entry');
  if (Number(growth.chartSourceCount || 0) >= 2) signals.push('multiple-roblox-charts');
  return signals;
}

function ageDays(value, nowMs) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? Math.max(0, (nowMs - time) / DAY) : Infinity;
}

export function calculateRobloxFastSignals(candidate, nowMs = Date.now()) {
  const roblox = candidate.roblox || {};
  const growth = roblox.latestGrowth || {};
  const components = {
    freshness: freshnessScore(roblox, nowMs),
    ccuGrowth: ccuScore(growth),
    engagementGrowth: engagementScore(growth),
    chartMomentum: chartScore(roblox, growth),
    quality: qualityScore(candidate),
  };
  let score = Object.values(components).reduce((sum, value) => sum + value, 0);
  const growthSignals = evidence(growth);
  const upAndComing = roblox.rankings?.['roblox-up-and-coming'];
  const upAndComingRank = Number(upAndComing?.currentRank || 0);
  const firstUpAndComingEntry = upAndComingRank > 0
    && upAndComing?.previousRank === null
    && ageDays(upAndComing?.firstSeen, nowMs) <= 1;
  const newUpAndComing = ageDays(roblox.createdAt || roblox.firstSeen, nowMs) <= 14
    && firstUpAndComingEntry
    && upAndComingRank > 0
    && upAndComingRank <= 20
    && Number(roblox.playing || 0) >= 100;
  const ccuAcceleration = Number(growth.ccuDelta24h || 0) >= 250
    && Number(growth.ccuGrowth24h || 0) >= 50
    && growthSignals.some((signal) => signal !== 'ccu-growth');
  const rankAndAudienceGrowth = Number(growth.maxRankGain24h || 0) >= 10
    && (positive(growth.ccuDelta24h) || positive(growth.visitsDelta24h));
  const strongGrowth = ccuAcceleration || newUpAndComing || rankAndAudienceGrowth;
  if (strongGrowth) score = Math.max(score, 55);
  score = clamp(score);

  let classification = score >= 35 ? 'watch' : 'weak';
  if (score >= 55 && (growthSignals.length >= 2 || strongGrowth)) classification = 'pass';

  const reasons = ['使用 Roblox 专属快速增长模型'];
  if (!roblox.latestGrowth || (growth.ccuDelta24h === null && growth.ccuDelta48h === null)) reasons.push('当前仅建立 Roblox 基线，尚不推断增长');
  if (positive(growth.ccuDelta24h) && positive(growth.ccuGrowth24h)) reasons.push(`CCU 24小时增加${growth.ccuDelta24h}（${growth.ccuGrowth24h}%）`);
  if (positive(growth.visitsDelta24h)) reasons.push(`Visits 24小时增加${growth.visitsDelta24h}`);
  if (positive(growth.favoritesDelta24h)) reasons.push(`Favorites 24小时增加${growth.favoritesDelta24h}`);
  if (growth.firstChartEntry24h) reasons.push('24小时内首次进入 Roblox 榜单');
  else if (firstUpAndComingEntry) reasons.push('首次进入 Roblox Up-and-Coming 榜单');
  if (Number(growth.maxRankGain24h || 0) >= 5) reasons.push(`Roblox 榜单最高上升${growth.maxRankGain24h}位`);
  if (Number(growth.chartSourceCount || 0) >= 2) reasons.push('同时出现在两个 Roblox 榜单（仍计为单一平台）');
  if (strongGrowth) reasons.push('命中 Roblox 强增长特殊规则');
  if (classification !== 'pass' && score >= 55 && growthSignals.length < 2) reasons.push('分数达到门槛，但不足两个增长证据');

  return {
    robloxModelVersion: ROBLOX_FAST_MODEL_VERSION,
    profile: 'roblox',
    checkedAt: new Date(nowMs).toISOString(),
    score,
    classification,
    reasons,
    components,
    growthSignalCount: growthSignals.length,
    growthSignals,
    strongGrowth,
    independentPlatformCount: 1,
    robloxChartSourceCount: Number(growth.chartSourceCount || 0),
  };
}

export function allowsPaidRobloxVerification(candidate = {}) {
  if (!isRobloxCandidate(candidate)) return true;
  if (candidate.fast?.profile === 'roblox' && candidate.fast?.classification === 'pass') return true;
  if (candidate.fast?.profile === 'roblox' && candidate.fast?.strongGrowth === true) return true;
  return candidate.todayReview?.selected === true
    && candidate.todayReview?.lane === 'roblox-growth'
    && Number(candidate.todayReview?.score || 0) >= ROBLOX_TODAY_REVIEW_HIGH_PRIORITY;
}
