import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTodayReview, evaluateTodayReviewCandidate } from '../lib/today-review.mjs';

const NOW = Date.parse('2026-09-08T12:00:00Z');

function source(sourceId, host, firstSeen = '2026-09-08T06:00:00Z') {
  return { sourceId, kind: sourceId, name: sourceId, url: `https://${host}/games/example`, firstSeen };
}

function candidate(name, overrides = {}) {
  const base = {
    id: name,
    gameName: name,
    normalizedName: name.toLowerCase(),
    firstSeen: '2026-09-08T06:00:00Z',
    recommendation: 'watch',
    sources: [source('crazygames-new', 'crazygames.com'), source('poki-new', 'poki.com')],
    seo: { classification: 'page', score: 62, nameRisk: 5, entityConflict: false },
    fast: { classification: 'pass', score: 72, sourceAdded24h: 2, sourceAdded48h: 2, onlinePlatformCount: 2 },
    trend: { classification: 'moderate', score: 60, keywordFreshness: 'unknown', entityConflict: false },
    marketFreshness: { status: 'unknown', confidence: 'low' },
    opportunity: { components: { growthVelocity: 70, searchFormation: 70 }, testGates: { contentDepth: true } },
    social: { classification: 'pending', evidenceStatus: 'unknown' },
  };
  return {
    ...base,
    ...overrides,
    seo: { ...base.seo, ...overrides.seo },
    fast: { ...base.fast, ...overrides.fast },
    trend: { ...base.trend, ...overrides.trend },
    marketFreshness: { ...base.marketFreshness, ...overrides.marketFreshness },
    opportunity: {
      ...base.opportunity,
      ...overrides.opportunity,
      components: { ...base.opportunity.components, ...overrides.opportunity?.components },
      testGates: { ...base.opportunity.testGates, ...overrides.opportunity?.testGates },
    },
    social: { ...base.social, ...overrides.social },
  };
}

test('missing social provider does not exclude an otherwise qualified candidate', () => {
  const item = candidate('No Social', { social: { classification: 'pending', evidenceStatus: 'provider-error' } });
  const result = buildTodayReview([item], { nowMs: NOW, minSelected: 0 });
  assert.equal(item.todayReview.selected, true);
  assert.equal(result.report.selectedCount, 1);
  assert.match(item.todayReview.warnings.join(' '), /社媒Provider异常/);
});

test('SEO pending can enter from fresh multi-platform growth', () => {
  const item = candidate('SEO Pending', { seo: { classification: 'pending', score: 0 } });
  buildTodayReview([item], { nowMs: NOW, minSelected: 0 });
  assert.equal(item.todayReview.selected, true);
  assert.match(item.todayReview.warnings.join(' '), /SEO搜索意图待验证/);
});

test('trend pending can enter when fresh platform growth is strong', () => {
  const item = candidate('Trend Pending', { trend: { classification: 'pending', score: 0 } });
  buildTodayReview([item], { nowMs: NOW, minSelected: 0 });
  assert.equal(item.todayReview.selected, true);
  assert.equal(item.todayReview.lane, 'fresh-platform-growth');
  assert.match(item.todayReview.warnings.join(' '), /Trends尚未完成验证/);
});

test('breakout receives special access even without two ordinary signals', () => {
  const item = candidate('Breakout Direct', {
    firstSeen: '2026-08-01T00:00:00Z',
    sources: [source('trends-rising-30d-indie-game', 'trends.google.com', '2026-08-01T00:00:00Z')],
    seo: { score: 20 },
    fast: { classification: 'watch', score: 20, sourceAdded24h: 0, sourceAdded48h: 0, onlinePlatformCount: 0 },
    trend: { classification: 'breakout', score: 95 },
    opportunity: { components: { growthVelocity: 20, searchFormation: 20 } },
  });
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.specialAccess, true);
  assert.equal(evaluation.eligible, true);
});

test('high-confidence occupied candidate is excluded', () => {
  const item = candidate('Occupied', { marketFreshness: { status: 'occupied', confidence: 'high' }, trend: { classification: 'breakout' } });
  const result = buildTodayReview([item], { nowMs: NOW });
  assert.equal(result.report.selectedCount, 0);
  assert.equal(item.todayReview, undefined);
});

test('explicit entity conflict is excluded', () => {
  const item = candidate('Wrong Entity', { seo: { entityConflict: true }, trend: { classification: 'breakout' } });
  buildTodayReview([item], { nowMs: NOW });
  assert.equal(item.todayReview, undefined);
});

test('SEO reject and name risk above 24 are hard exclusions', () => {
  const rejected = candidate('SEO Reject', { seo: { classification: 'reject' }, trend: { classification: 'breakout' } });
  const risky = candidate('Risky Name', { seo: { nameRisk: 25 }, trend: { classification: 'breakout' } });
  buildTodayReview([rejected, risky], { nowMs: NOW });
  assert.equal(rejected.todayReview, undefined);
  assert.equal(risky.todayReview, undefined);
});

test('removes stale Today Review data when a candidate is no longer selected', () => {
  const item = candidate('Previously Selected', {
    todayReview: { selected: true, rank: 1, score: 99 },
    marketFreshness: { status: 'occupied', confidence: 'high' },
  });
  buildTodayReview([item], { nowMs: NOW });
  assert.equal(item.todayReview, undefined);
});

test('existing keyword history sharply reduces freshness without changing recommendation', () => {
  const item = candidate('Established Phrase', {
    trend: { keywordFreshness: 'existing', classification: 'breakout' },
    marketFreshness: { status: 'unknown', confidence: 'low', keywordFreshness: 'existing' },
  });
  const before = item.recommendation;
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.review.components.freshness, 5);
  assert.ok(evaluation.review.score < 55);
  assert.equal(item.recommendation, before);
});

test('unknown keyword freshness warns but does not hard-exclude', () => {
  const item = candidate('Unknown Freshness');
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.hardExcluded, false);
  assert.match(evaluation.review.warnings.join(' '), /关键词新鲜度未知/);
});

test('90-day established bare term loses freshness unless game-intent demand is newly forming', () => {
  const established = candidate('Long Running Phrase', {
    trend: {
      keywordFreshness: 'unknown',
      ninetyDay: { points: 93, earlierAverage: 4, earlierCoverage: 0.9 },
      ninetyDayQualified: { earlierAverage: 0, earlierCoverage: 0, recentAverage: 0, recentCoverage: 0 },
    },
  });
  const emerging = candidate('New Game Intent', {
    trend: {
      keywordFreshness: 'unknown',
      ninetyDay: { points: 93, earlierAverage: 4, earlierCoverage: 0.9 },
      ninetyDayQualified: { earlierAverage: 0, earlierCoverage: 0, recentAverage: 1, recentCoverage: 0.5 },
    },
  });
  const oldEvaluation = evaluateTodayReviewCandidate(established, { nowMs: NOW });
  const newEvaluation = evaluateTodayReviewCandidate(emerging, { nowMs: NOW });
  assert.equal(oldEvaluation.review.components.freshness, 5);
  assert.equal(newEvaluation.review.components.freshness, 100);
});

test('high-confidence dedicated domain and derived exact-match specialist site are excluded', () => {
  const known = candidate('Known Site', {
    marketFreshness: { status: 'occupied', confidence: 'high', dedicatedDomains: ['knownsite.com'] },
  });
  const derived = candidate('Fresh Quest', {
    seo: { provider: 'serper+autocomplete', provisional: false, exactResultUrls: ['https://freshquestwiki.com/guide'] },
  });
  buildTodayReview([known, derived], { nowMs: NOW });
  assert.equal(known.todayReview, undefined);
  assert.equal(derived.todayReview, undefined);
});

test('ordinary game platforms are not treated as dedicated specialist sites', () => {
  const item = candidate('Portal Game', {
    seo: {
      provider: 'serper+autocomplete',
      provisional: false,
      exactResultUrls: ['https://poki.com/en/g/portal-game', 'https://store.steampowered.com/app/123/portal_game/'],
    },
  });
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.calibrationRisk.highConfidenceDedicated, false);
  assert.equal(evaluation.hardExcluded, false);
});

test('multiple same-platform product entities are excluded as an entity conflict', () => {
  const item = candidate('Shared Product Name', {
    seo: {
      provider: 'serper+autocomplete',
      provisional: false,
      exactResultUrls: [
        'https://play.google.com/store/apps/details?id=studio.one.shared',
        'https://play.google.com/store/apps/details?id=studio.two.shared',
      ],
    },
  });
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.hardExcluded, true);
  assert.match(evaluation.exclusionReasons.join(' '), /多个游戏或商品实体/);
});

test('duplicate normalized names are excluded from the review pool', () => {
  const first = candidate('Same Name', { id: 'entity-one', sources: [source('itch-newest-web', 'one.itch.io')] });
  const second = candidate('Same Name', { id: 'entity-two', sources: [source('steam-popular-new', 'store.steampowered.com')] });
  const result = buildTodayReview([first, second], { nowMs: NOW });
  assert.equal(result.report.selectedCount, 0);
  assert.equal(first.todayReview, undefined);
  assert.equal(second.todayReview, undefined);
});

test('mature franchise terms are excluded by generic brand rules', () => {
  const item = candidate('Marvel Galaxy Tactics');
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.hardExcluded, true);
  assert.match(evaluation.exclusionReasons.join(' '), /大型IP/);
});

test('mature SERP ecosystems sharply reduce competition score', () => {
  const item = candidate('Crowded Launch', {
    seo: {
      provider: 'serper+autocomplete',
      provisional: false,
      exactResultUrls: [
        'https://store.steampowered.com/app/1/crowded_launch/',
        'https://www.nintendo.com/store/products/crowded-launch-switch/',
        'https://www.xbox.com/games/store/crowded-launch/1',
        'https://www.ign.com/games/crowded-launch',
        'https://www.reddit.com/r/games/crowded-launch',
        'https://www.youtube.com/watch?v=123',
      ],
    },
  });
  const evaluation = evaluateTodayReviewCandidate(item, { nowMs: NOW });
  assert.equal(evaluation.calibrationRisk.matureEcosystem, true);
  assert.equal(evaluation.review.components.competition, 10);
});

test('fresh growth ranks ahead of a mature high-score term', () => {
  const fresh = candidate('Fresh Growth');
  const mature = candidate('Mature Strong', {
    firstSeen: '2026-07-01T00:00:00Z',
    sources: [source('steam-top-wishlist', 'store.steampowered.com', '2026-07-01T00:00:00Z')],
    seo: { score: 90 },
    fast: { score: 90, sourceAdded24h: 0, sourceAdded48h: 0, onlinePlatformCount: 0 },
    trend: { classification: 'breakout', score: 95 },
    opportunity: { components: { growthVelocity: 90, searchFormation: 90 } },
  });
  buildTodayReview([mature, fresh], { nowMs: NOW, minSelected: 0 });
  assert.equal(fresh.todayReview.rank, 1);
  assert.equal(mature.todayReview.rank, 2);
});

test('daily selection is capped at 15', () => {
  const items = Array.from({ length: 20 }, (_, index) => candidate(`Breakout ${index}`, {
    sources: [source(`platform-${index}`, `platform-${index}.example`)],
    trend: { classification: 'breakout' },
  }));
  const result = buildTodayReview(items, { nowMs: NOW });
  assert.equal(result.report.selectedCount, 15);
  assert.equal(items.filter((item) => item.todayReview?.selected === true).length, 15);
});

test('building Today Review does not modify recommendation', () => {
  const items = [candidate('Keep Watch'), candidate('Keep Pending', { recommendation: 'pending' })];
  const before = items.map((item) => item.recommendation);
  buildTodayReview(items, { nowMs: NOW });
  assert.deepEqual(items.map((item) => item.recommendation), before);
});

test('wardogs-like candidate is selected while occupied choicer-voicer-like candidate is not', () => {
  const wardogs = candidate('wardogs', {
    firstSeen: '2026-08-16T09:06:12.534Z',
    sources: [source('itch-newest-web', 'itch.io', '2026-08-16T09:06:12.534Z'), source('steam-top-wishlist', 'store.steampowered.com', '2026-08-16T09:06:12.534Z'), source('trends-rising-30d-indie-game', 'trends.google.com', '2026-08-31T20:49:42.970Z')],
    seo: { provider: 'evidence-fallback', provisional: true, score: 62 },
    fast: { score: 73, sourceAdded24h: 0, sourceAdded48h: 0, onlinePlatformCount: 1 },
    trend: { classification: 'breakout', score: 95 },
    opportunity: { components: { growthVelocity: 15, searchFormation: 100 }, testGates: { contentDepth: false } },
    social: { evidenceStatus: 'provider-error' },
  });
  const occupied = candidate('choicer voicer', {
    trend: { classification: 'breakout' },
    marketFreshness: { status: 'occupied', confidence: 'high' },
  });
  buildTodayReview([wardogs, occupied], { nowMs: NOW });
  assert.equal(wardogs.todayReview.selected, true);
  assert.deepEqual(wardogs.todayReview.reasons.slice(0, 3), ['Fast Pass', 'Trends Breakout', '搜索需求已形成']);
  assert.match(wardogs.todayReview.warnings.join(' '), /SERP竞争未知/);
  assert.match(wardogs.todayReview.warnings.join(' '), /内容长尾不足/);
  assert.equal(occupied.todayReview, undefined);
});
