import { sourcePlatformKey } from './site-type.mjs';

export const TODAY_REVIEW_MODEL_VERSION = 1;

const DAY = 86400000;
const DIRECT_RISING_PATTERN = /^trends-rising-(7d|30d)(-|$)/;
const TREND_SCORES = { breakout: 100, rising: 90, strong: 75, moderate: 60, weak: 25, none: 0, pending: 10, error: 5 };
const COMPETITION_SCORES = { greenfield: 100, 'unconfirmed-new': 75, unknown: 55, contested: 20, occupied: 0, established: 0 };
const TREND_REASONS = { breakout: 'Trends Breakout', rising: 'Trends Rising', strong: 'Trends需求较强', moderate: 'Trends需求开始形成' };

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function ageDays(value, nowMs) {
  const time = parseTime(value);
  return time === null ? Infinity : Math.max(0, (nowMs - time) / DAY);
}

function sourceAliases(source = {}) {
  return [source.kind, source.sourceId, source.id].filter(Boolean).map(String);
}

function isDirectRisingSource(source = {}) {
  return sourceAliases(source).some((value) => DIRECT_RISING_PATTERN.test(value));
}

function sourceMetrics(candidate, nowMs) {
  const platformFirstSeen = new Map();
  let maxRankGain = Number(candidate.fast?.maxRankGain || 0);
  let directRising = false;

  for (const source of candidate.sources || []) {
    if (isDirectRisingSource(source)) {
      directRising = true;
      continue;
    }
    const key = sourcePlatformKey(source) || source.sourceId || source.kind || source.url;
    if (!key) continue;
    const firstSeen = parseTime(source.firstSeen || candidate.firstSeen);
    const currentFirstSeen = platformFirstSeen.get(key);
    if (firstSeen !== null && (!Number.isFinite(currentFirstSeen) || firstSeen < currentFirstSeen)) platformFirstSeen.set(key, firstSeen);
    const previousRank = Number(source.previousRank || 0);
    const currentRank = Number(source.currentRank || 0);
    if (previousRank > 0 && currentRank > 0) maxRankGain = Math.max(maxRankGain, previousRank - currentRank);
  }

  const firstSeenValues = [...platformFirstSeen.values()];
  const sourceAdded24h = Math.max(Number(candidate.fast?.sourceAdded24h || 0), firstSeenValues.filter((time) => nowMs - time <= DAY).length);
  const sourceAdded48h = Math.max(Number(candidate.fast?.sourceAdded48h || 0), firstSeenValues.filter((time) => nowMs - time <= 2 * DAY).length);
  const platformCount = Math.max(Number(candidate.fast?.onlinePlatformCount || candidate.siteType?.onlinePlatformCount || 0), platformFirstSeen.size);
  return { sourceAdded24h, sourceAdded48h, platformCount, maxRankGain: Math.max(0, maxRankGain), directRising };
}

function freshnessScore(candidate, nowMs) {
  const age = ageDays(candidate.firstSeen, nowMs);
  let score = age <= 1 ? 100 : age <= 3 ? 85 : age <= 7 ? 65 : age <= 14 ? 35 : 0;
  if (candidate.trend?.keywordFreshness === 'new') score = Math.max(score, 100);
  return score;
}

function growthScore(candidate, metrics, robloxStrongGrowth) {
  const extra48h = Math.max(0, metrics.sourceAdded48h - metrics.sourceAdded24h);
  let score = Math.min(40, metrics.sourceAdded24h * 20)
    + Math.min(20, extra48h * 10)
    + Math.min(25, metrics.maxRankGain * 3)
    + (metrics.platformCount >= 2 ? Math.min(30, (metrics.platformCount - 1) * 15) : 0);
  score = Math.max(score, Number(candidate.opportunity?.components?.growthVelocity || 0));
  if (candidate.fast?.classification === 'pass') score = Math.max(score, Number(candidate.fast?.score || 0));
  if (robloxStrongGrowth) score = 100;
  return clamp(score);
}

function trendsScore(candidate, directRising) {
  let score = TREND_SCORES[candidate.trend?.classification] ?? 10;
  if (directRising) score = Math.max(score, 55);
  return clamp(score);
}

function searchFormationScore(candidate) {
  const opportunityScore = Number(candidate.opportunity?.components?.searchFormation || 0);
  const seoScore = Number(candidate.seo?.score || 0);
  return clamp(Math.max(opportunityScore, seoScore));
}

function competitionScore(candidate) {
  return clamp(COMPETITION_SCORES[candidate.marketFreshness?.status || 'unknown'] ?? COMPETITION_SCORES.unknown);
}

function hasRobloxStrongGrowth(candidate) {
  const roblox = candidate.roblox || {};
  return roblox.strongGrowth === true
    || roblox.signals?.strongGrowth === true
    || Number(roblox.ccuGrowth24h || 0) >= 50
    || Number(roblox.rankGain || 0) >= 10;
}

function socialTieBreak(candidate) {
  return { viral: 5, pass: 4, watch: 2 }[candidate.social?.classification] || 0;
}

function primaryPlatform(candidate) {
  const source = (candidate.sources || []).find((item) => !isDirectRisingSource(item));
  return source ? sourcePlatformKey(source) || source.sourceId || source.kind || 'unknown' : 'trends-rising';
}

function buildReasons(candidate, metrics, components, age) {
  const reasons = [];
  if (candidate.fast?.classification === 'pass') reasons.push('Fast Pass');
  if (TREND_REASONS[candidate.trend?.classification]) reasons.push(TREND_REASONS[candidate.trend.classification]);
  else if (metrics.directRising) reasons.push('来自直接 Trends Rising 来源');
  if (components.searchFormation >= 55) reasons.push('搜索需求已形成');
  if (age <= 1) reasons.push('首次发现不足24小时');
  else if (age <= 3) reasons.push('首次发现不足3天');
  else if (age <= 7) reasons.push('首次发现不足7天');
  if (metrics.sourceAdded24h >= 2) reasons.push(`24小时新增${metrics.sourceAdded24h}个平台来源`);
  else if (metrics.sourceAdded48h >= 2) reasons.push(`48小时新增${metrics.sourceAdded48h}个平台来源`);
  if (metrics.platformCount >= 2) reasons.push(`已覆盖${metrics.platformCount}个独立平台`);
  if (metrics.maxRankGain >= 3) reasons.push(`榜单较上轮上升${metrics.maxRankGain}位`);
  if (candidate.trend?.keywordFreshness === 'new') reasons.push('90天历史显示为新词');
  return [...new Set(reasons)];
}

function buildWarnings(candidate, age) {
  const warnings = [];
  const market = candidate.marketFreshness || {};
  const trendClass = candidate.trend?.classification;
  if (!candidate.seo || ['pending', 'error'].includes(candidate.seo.classification)) warnings.push('SEO搜索意图待验证');
  else if (candidate.seo.provisional || candidate.seo.provider === 'evidence-fallback') warnings.push('SEO仅有平台证据，仍需真实SERP复核');
  if (!candidate.trend || ['pending', 'error'].includes(trendClass)) warnings.push('Trends尚未完成验证');
  if (market.status === 'unknown' || !market.status) warnings.push('SERP竞争未知');
  else if (market.status === 'contested') warnings.push('已有早期内容竞争');
  else if (['occupied', 'established'].includes(market.status)) warnings.push('现有竞争状态仍需人工确认');
  if (candidate.opportunity?.testGates?.contentDepth === false) warnings.push('内容长尾不足');
  if (candidate.siteType?.type === 'pending') warnings.push('建站类型待确认');
  if (age > 7) warnings.push('首次发现已超过7天');
  if (Number(candidate.seo?.nameRisk || 0) >= 13) warnings.push('名称存在一定歧义');
  if (candidate.social?.evidenceStatus === 'provider-error') warnings.push('社媒Provider异常，不影响人工复核');
  else if (!candidate.social || ['pending', undefined].includes(candidate.social.classification)) warnings.push('社媒尚未验证，不影响人工复核');
  return [...new Set(warnings)];
}

export function evaluateTodayReviewCandidate(candidate, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const age = ageDays(candidate.firstSeen, nowMs);
  const metrics = sourceMetrics(candidate, nowMs);
  const robloxStrongGrowth = hasRobloxStrongGrowth(candidate);
  const trendClass = candidate.trend?.classification;
  const trendQualified = ['moderate', 'rising', 'breakout'].includes(trendClass);
  const signals = {
    fresh: age <= 7,
    growth: metrics.sourceAdded24h >= 2 || metrics.sourceAdded48h >= 2 || metrics.maxRankGain >= 3,
    fastPass: candidate.fast?.classification === 'pass',
    trendQualified,
    directRising: metrics.directRising,
    seoStrong: Number(candidate.seo?.score || 0) >= 55,
  };
  const signalCount = Object.values(signals).filter(Boolean).length;
  const specialAccess = ['rising', 'breakout'].includes(trendClass) || robloxStrongGrowth;
  const market = candidate.marketFreshness || {};
  const nameRisk = Number(candidate.seo?.nameRisk);
  const hardExcluded = Boolean(candidate.seo?.entityConflict || candidate.trend?.entityConflict)
    || candidate.seo?.classification === 'reject'
    || (Number.isFinite(nameRisk) && nameRisk > 24)
    || (['occupied', 'established'].includes(market.status) && market.confidence === 'high');
  const eligible = !hardExcluded && (specialAccess || signalCount >= 2);

  const components = {
    freshness: freshnessScore(candidate, nowMs),
    growth: growthScore(candidate, metrics, robloxStrongGrowth),
    trends: trendsScore(candidate, metrics.directRising),
    searchFormation: searchFormationScore(candidate),
    competition: competitionScore(candidate),
  };
  const score = clamp(
    components.freshness * 0.25
    + components.growth * 0.25
    + components.trends * 0.20
    + components.searchFormation * 0.15
    + components.competition * 0.15,
  );
  const lane = robloxStrongGrowth
    ? 'roblox-growth'
    : (trendQualified || metrics.directRising ? 'confirmed-acceleration' : 'fresh-platform-growth');

  return {
    candidate,
    eligible,
    hardExcluded,
    specialAccess,
    signalCount,
    socialTieBreak: socialTieBreak(candidate),
    primaryPlatform: primaryPlatform(candidate),
    age,
    review: {
      selected: false,
      rank: null,
      score,
      lane: null,
      components,
      reasons: buildReasons(candidate, metrics, components, age),
      warnings: buildWarnings(candidate, age),
    },
    suggestedLane: lane,
  };
}

function compareEvaluations(a, b) {
  return b.review.score - a.review.score
    || Number(b.specialAccess) - Number(a.specialAccess)
    || b.socialTieBreak - a.socialTieBreak
    || a.age - b.age
    || String(a.candidate.normalizedName || a.candidate.gameName).localeCompare(String(b.candidate.normalizedName || b.candidate.gameName));
}

export function buildTodayReview(candidates, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maxSelected = Math.max(1, Math.min(15, Number(options.maxSelected || 15)));
  const minSelected = Math.max(0, Math.min(maxSelected, Number(options.minSelected ?? 5)));
  const platformLimit = Math.max(1, Number(options.platformLimit || 5));
  const evaluations = candidates.map((candidate) => evaluateTodayReviewCandidate(candidate, { nowMs }));
  for (const candidate of candidates) delete candidate.todayReview;

  const eligible = evaluations.filter((item) => item.eligible).sort(compareEvaluations);
  const selected = [];
  const selectedKeys = new Set();
  const platformCounts = new Map();
  const add = (item) => {
    const key = item.candidate.id || item.candidate.normalizedName || item.candidate.gameName;
    if (selectedKeys.has(key) || selected.length >= maxSelected) return false;
    const platformCount = platformCounts.get(item.primaryPlatform) || 0;
    if (platformCount >= platformLimit) return false;
    selectedKeys.add(key);
    platformCounts.set(item.primaryPlatform, platformCount + 1);
    selected.push(item);
    return true;
  };

  for (const item of eligible.filter((entry) => entry.review.score >= 55)) add(item);
  if (selected.length < minSelected) {
    for (const item of eligible.filter((entry) => entry.age <= 3 && entry.review.score >= 40)) {
      add(item);
      if (selected.length >= minSelected) break;
    }
  }

  selected.sort(compareEvaluations);
  const laneCounts = { 'confirmed-acceleration': 0, 'fresh-platform-growth': 0, 'roblox-growth': 0 };
  selected.forEach((item, index) => {
    item.review.selected = true;
    item.review.rank = index + 1;
    item.review.lane = item.suggestedLane;
    item.candidate.todayReview = item.review;
    laneCounts[item.suggestedLane] += 1;
  });

  return {
    selected: selected.map((item) => item.candidate),
    report: {
      modelVersion: TODAY_REVIEW_MODEL_VERSION,
      selectedCount: selected.length,
      candidateCount: eligible.length,
      laneCounts,
      generatedAt: new Date(nowMs).toISOString(),
    },
  };
}
