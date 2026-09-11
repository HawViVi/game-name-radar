import { sourcePlatformKey } from './site-type.mjs';

export const TODAY_REVIEW_MODEL_VERSION = 2;

const DAY = 86400000;
const DIRECT_RISING_PATTERN = /^trends-rising-(7d|30d)(-|$)/;
const TREND_SCORES = { breakout: 100, rising: 90, strong: 75, moderate: 60, weak: 25, none: 0, pending: 10, error: 5 };
const COMPETITION_SCORES = { greenfield: 100, 'unconfirmed-new': 75, unknown: 55, contested: 20, occupied: 0, established: 0 };
const TREND_REASONS = { breakout: 'Trends Breakout', rising: 'Trends Rising', strong: 'Trends需求较强', moderate: 'Trends需求开始形成' };
const NON_SPECIALIST_HOSTS = [
  'steampowered.com', 'steamcommunity.com', 'itch.io', 'crazygames.com', 'poki.com', 'y8.com',
  'gamepix.com', 'lagged.com', 'newgrounds.com', 'roblox.com', 'xbox.com', 'playstation.com',
  'epicgames.com', 'nintendo.com', 'play.google.com', 'apps.apple.com', 'amazon.com', 'youtube.com',
  'youtu.be', 'twitch.tv', 'reddit.com', 'wikipedia.org', 'yandex.com', 'azgames.io', 'plays.org',
  'topgames.gg', 'solarsmash.co',
];
const MATURE_ECOSYSTEM_HOSTS = [
  ...NON_SPECIALIST_HOSTS,
  'ign.com', 'gamespot.com', 'pcgamer.com', 'polygon.com', 'eurogamer.net', 'kotaku.com',
];
const DEDICATED_WIKI_HOSTS = ['fandom.com', 'wiki.gg', 'wikidot.com'];
const MATURE_BRAND_PATTERN = /\b(?:star wars|marvel|dc comics|disney|pixar|pokemon|minecraft|fortnite|call of duty|grand theft auto|gta|league of legends|valorant|sonic|super mario|the legend of zelda|final fantasy|warhammer|dungeons and dragons|dragon ball|one piece|naruto|harry potter|lord of the rings|jurassic (?:world|park)|transformers|fallout|elder scrolls|resident evil|silent hill|metal gear|mortal kombat|street fighter|assassin s creed|fifa|nfl|nba|wwe|lego)\b/i;

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

function normalized(value = '') {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

function compact(value = '') {
  return normalized(value).replace(/\s+/g, '');
}

function parseUrl(value = '') {
  try {
    const url = new URL(value);
    return { url, host: url.hostname.replace(/^www\./, '').toLowerCase(), path: `${url.pathname}${url.search}`.toLowerCase() };
  } catch {
    return null;
  }
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function matchesAnyHost(host, domains) {
  return domains.some((domain) => hostMatches(host, domain));
}

function pathMentionsName(path, nameCompact) {
  return nameCompact.length >= 4 && compact(path).includes(nameCompact);
}

function hostMentionsName(host, nameCompact) {
  return nameCompact.length >= 4 && host.split('.').some((label) => compact(label).includes(nameCompact));
}

function productKey(record) {
  if (hostMatches(record.host, 'play.google.com')) return `google-play:${record.url.searchParams.get('id') || record.path}`;
  if (hostMatches(record.host, 'apps.apple.com')) return `apple:${record.path.match(/\/id(\d+)/)?.[1] || record.path}`;
  if (hostMatches(record.host, 'steampowered.com')) return `steam:${record.path.match(/\/app\/(\d+)/)?.[1] || record.path}`;
  if (hostMatches(record.host, 'roblox.com')) return `roblox:${record.path.match(/\/games\/(\d+)/)?.[1] || record.path}`;
  return null;
}

function keywordHistory(candidate) {
  const trend = candidate.trend || {};
  const explicit = trend.keywordFreshness || candidate.marketFreshness?.keywordFreshness || 'unknown';
  const main = trend.ninetyDay || {};
  const qualified = trend.ninetyDayQualified || {};
  const qualifiedEmerging = Number(qualified.earlierCoverage || 0) <= 0.1
    && Number(qualified.earlierAverage || 0) <= 0.25
    && Number(qualified.recentCoverage || 0) >= 0.35
    && Number(qualified.recentAverage || 0) > 0;
  const historicalSeries = Number(main.points || 0) >= 80
    && Number(main.earlierCoverage || 0) >= 0.6
    && Number(main.earlierAverage || 0) >= 1
    && !qualifiedEmerging;
  return {
    explicit,
    qualifiedEmerging,
    historicallyEstablished: explicit === 'existing' || historicalSeries,
  };
}

function serpRisk(candidate) {
  const seo = candidate.seo || {};
  const exactUrls = [...new Set((seo.exactResultUrls || []).filter(Boolean))];
  const allUrls = [...new Set([...exactUrls, ...(seo.gameResultUrls || []), ...(candidate.fast?.serpSnapshot || [])].filter(Boolean))];
  const exactRecords = exactUrls.map(parseUrl).filter(Boolean);
  const records = allUrls.map(parseUrl).filter(Boolean);
  const nameCompact = compact(candidate.normalizedName || candidate.gameName);
  const trusted = Boolean(seo.provider)
    && seo.provider !== 'evidence-fallback'
    && seo.provisional !== true
    && !['pending', 'error'].includes(seo.classification);
  const derivedDedicatedDomains = trusted ? [...new Set(records.filter((record) => {
    if (matchesAnyHost(record.host, NON_SPECIALIST_HOSTS)) return false;
    if (hostMentionsName(record.host, nameCompact)) return true;
    return matchesAnyHost(record.host, DEDICATED_WIKI_HOSTS) && pathMentionsName(record.path, nameCompact);
  }).map((record) => record.host))] : [];
  const market = candidate.marketFreshness || {};
  const dedicatedDomains = [...new Set([...(market.dedicatedDomains || []), ...derivedDedicatedDomains])];
  const highConfidenceDedicated = dedicatedDomains.length > 0
    && (market.confidence === 'high' || derivedDedicatedDomains.length > 0);
  const ecosystemRecords = exactRecords.filter((record) => matchesAnyHost(record.host, MATURE_ECOSYSTEM_HOSTS));
  const matureEcosystem = trusted
    && exactRecords.length >= 6
    && ecosystemRecords.length / exactRecords.length >= 0.5;
  const productsByNamespace = new Map();
  for (const record of exactRecords) {
    const key = productKey(record);
    if (!key) continue;
    const [namespace] = key.split(':');
    if (!productsByNamespace.has(namespace)) productsByNamespace.set(namespace, new Set());
    productsByNamespace.get(namespace).add(key);
  }
  const multipleEntities = [...productsByNamespace.values()].some((keys) => keys.size >= 2);
  return { trusted, dedicatedDomains, highConfidenceDedicated, matureEcosystem, multipleEntities };
}

function calibrationRisk(candidate, options = {}) {
  const history = keywordHistory(candidate);
  const serp = serpRisk(candidate);
  const normalizedName = normalized(candidate.normalizedName || candidate.gameName);
  const matureBrand = MATURE_BRAND_PATTERN.test(normalizedName)
    || (/[™®]/.test(candidate.gameName || '') && (candidate.sources || []).some((source) => /steam|xbox|playstation|nintendo|epic/i.test(`${source.sourceId || ''} ${source.url || ''}`)));
  const duplicateEntityConflict = Number(options.sameNameEntityCount || 1) > 1;
  const explicitEntityConflict = Boolean(candidate.seo?.entityConflict || candidate.trend?.entityConflict);
  return { ...history, ...serp, matureBrand, duplicateEntityConflict, explicitEntityConflict };
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

function freshnessScore(candidate, nowMs, risk) {
  const age = ageDays(candidate.firstSeen, nowMs);
  let score = age <= 1 ? 100 : age <= 3 ? 85 : age <= 7 ? 65 : age <= 14 ? 35 : 0;
  if (risk.historicallyEstablished) return 5;
  if (risk.explicit === 'new') score = Math.max(score, 100);
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

function competitionScore(candidate, metrics, risk) {
  let score = COMPETITION_SCORES[candidate.marketFreshness?.status || 'unknown'] ?? COMPETITION_SCORES.unknown;
  if (risk.historicallyEstablished) score = Math.min(score, 15);
  if (risk.matureEcosystem) score = Math.min(score, 10);
  if (risk.multipleEntities || risk.duplicateEntityConflict) score = Math.min(score, 5);
  if (risk.highConfidenceDedicated || risk.matureBrand || risk.explicitEntityConflict) score = 0;
  const provisionalCompetition = candidate.marketFreshness?.status === 'unknown'
    && (candidate.seo?.provisional === true || candidate.seo?.provider === 'evidence-fallback');
  const hasIndependentAcceleration = metrics.platformCount >= 3
    || metrics.maxRankGain >= 3
    || metrics.directRising
    || ['rising', 'breakout'].includes(candidate.trend?.classification);
  if (provisionalCompetition && !hasIndependentAcceleration) score = Math.min(score, 35);
  return clamp(score);
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

function buildWarnings(candidate, age, risk) {
  const warnings = [];
  const market = candidate.marketFreshness || {};
  const trendClass = candidate.trend?.classification;
  if (!candidate.seo || ['pending', 'error'].includes(candidate.seo.classification)) warnings.push('SEO搜索意图待验证');
  else if (candidate.seo.provisional || candidate.seo.provider === 'evidence-fallback') warnings.push('SEO仅有平台证据，仍需真实SERP复核');
  if (!candidate.trend || ['pending', 'error'].includes(trendClass)) warnings.push('Trends尚未完成验证');
  if (risk.explicit === 'unknown') warnings.push('关键词新鲜度未知，需人工区分新实体与新关键词');
  if (risk.historicallyEstablished) warnings.push('90天前已存在持续关键词需求，新游戏实体不等于新关键词');
  if (risk.multipleEntities || risk.duplicateEntityConflict) warnings.push('同名词对应多个游戏或商品实体');
  if (risk.highConfidenceDedicated) warnings.push(`已有专站占位：${risk.dedicatedDomains.slice(0, 3).join('、')}`);
  if (risk.matureEcosystem) warnings.push('SERP已被成熟平台、商店或大型内容生态占据');
  if (risk.matureBrand) warnings.push('明显大型IP或成熟品牌词');
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
  const risk = calibrationRisk(candidate, options);
  const robloxStrongGrowth = hasRobloxStrongGrowth(candidate);
  const trendClass = candidate.trend?.classification;
  const trendQualified = ['moderate', 'rising', 'breakout'].includes(trendClass);
  const signals = {
    fresh: age <= 7 && !risk.historicallyEstablished,
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
  const exclusionReasons = [];
  if (risk.explicitEntityConflict) exclusionReasons.push('明确 entity conflict');
  if (risk.duplicateEntityConflict) exclusionReasons.push('同一 normalizedName 对应多个候选实体');
  if (risk.multipleEntities) exclusionReasons.push('SERP显示同名词对应多个游戏或商品实体');
  if (risk.highConfidenceDedicated) exclusionReasons.push(`高置信度专站占位：${risk.dedicatedDomains.slice(0, 3).join('、')}`);
  if (risk.matureBrand) exclusionReasons.push('明显大型IP或成熟品牌词');
  if (candidate.seo?.classification === 'reject') exclusionReasons.push('SEO classification 为 reject');
  if (Number.isFinite(nameRisk) && nameRisk > 24) exclusionReasons.push(`nameRisk ${nameRisk} 超过24`);
  if (['occupied', 'established'].includes(market.status) && market.confidence === 'high') exclusionReasons.push(`市场状态为高置信度 ${market.status}`);
  const hardExcluded = risk.explicitEntityConflict
    || risk.duplicateEntityConflict
    || risk.multipleEntities
    || risk.highConfidenceDedicated
    || risk.matureBrand
    || candidate.seo?.classification === 'reject'
    || (Number.isFinite(nameRisk) && nameRisk > 24)
    || (['occupied', 'established'].includes(market.status) && market.confidence === 'high');
  const eligible = !hardExcluded && (specialAccess || signalCount >= 2);

  const components = {
    freshness: freshnessScore(candidate, nowMs, risk),
    growth: growthScore(candidate, metrics, robloxStrongGrowth),
    trends: trendsScore(candidate, metrics.directRising),
    searchFormation: searchFormationScore(candidate),
    competition: competitionScore(candidate, metrics, risk),
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
    exclusionReasons,
    calibrationRisk: risk,
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
      warnings: buildWarnings(candidate, age, risk),
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
  const generatedAtMs = Number(options.generatedAtMs || nowMs);
  const maxSelected = Math.max(1, Math.min(15, Number(options.maxSelected || 15)));
  const minSelected = Math.max(0, Math.min(maxSelected, Number(options.minSelected ?? 5)));
  const platformLimit = Math.max(1, Number(options.platformLimit || 5));
  const sameNameEntityIds = new Map();
  for (const candidate of candidates) {
    const key = normalized(candidate.normalizedName || candidate.gameName);
    if (!sameNameEntityIds.has(key)) sameNameEntityIds.set(key, new Set());
    sameNameEntityIds.get(key).add(candidate.id || key);
  }
  const evaluations = candidates.map((candidate) => {
    const key = normalized(candidate.normalizedName || candidate.gameName);
    return evaluateTodayReviewCandidate(candidate, { nowMs, sameNameEntityCount: sameNameEntityIds.get(key)?.size || 1 });
  });
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
      generatedAt: new Date(generatedAtMs).toISOString(),
    },
  };
}
