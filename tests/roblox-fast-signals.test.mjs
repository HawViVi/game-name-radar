import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFastSignals, FAST_MODEL_VERSION } from '../lib/fast-signals.mjs';
import { allowsPaidRobloxVerification, calculateRobloxFastSignals } from '../lib/roblox-fast-signals.mjs';
import { classifySiteType } from '../lib/site-type.mjs';
import { buildTodayReview } from '../lib/today-review.mjs';
import { classifyTrendTier, SEO_MODEL_VERSION } from '../lib/trend-queue.mjs';

const NOW = Date.parse('2026-09-10T00:00:00Z');

function robloxCandidate(overrides = {}) {
  const growth = {
    ccuDelta24h: 400,
    ccuGrowth24h: 80,
    ccuDelta48h: 650,
    ccuGrowth48h: 180,
    visitsDelta24h: 30000,
    favoritesDelta24h: 300,
    maxRankGain24h: 12,
    firstChartEntry24h: false,
    chartSourceCount: 2,
    ...overrides.growth,
  };
  return {
    id: 'roblox:101',
    gameName: 'Fresh Quest',
    normalizedName: 'fresh quest',
    firstSeen: '2026-09-08T00:00:00Z',
    recommendation: 'pending',
    sources: [
      { sourceId: 'roblox-top-trending', kind: 'roblox-chart', url: 'https://www.roblox.com/games/201', firstSeen: '2026-09-08T00:00:00Z' },
      { sourceId: 'roblox-up-and-coming', kind: 'roblox-chart', url: 'https://www.roblox.com/games/201', firstSeen: '2026-09-08T00:00:00Z' },
    ],
    roblox: {
      universeId: '101',
      rootPlaceId: '201',
      originalName: 'Fresh Quest',
      normalizedKeyword: 'Fresh Quest',
      creator: { id: '301', name: 'Studio', type: 'Group' },
      createdAt: '2026-09-02T00:00:00Z',
      firstSeen: '2026-09-08T00:00:00Z',
      playing: 900,
      rankings: {
        'roblox-top-trending': { currentRank: 8 },
        'roblox-up-and-coming': { currentRank: 12 },
      },
      latestGrowth: growth,
      ...overrides.roblox,
    },
    seo: { classification: 'pending', score: 0, nameRisk: 5, entityConflict: false, ...overrides.seo },
    trend: { classification: 'pending', keywordFreshness: 'unknown', entityConflict: false, ...overrides.trend },
    marketFreshness: { status: 'unknown', confidence: 'low', ...overrides.marketFreshness },
    social: { classification: 'pending' },
  };
}

test('Roblox siteType remains wiki with a Roblox ecosystem and no browser-play assumption', () => {
  const type = classifySiteType(robloxCandidate());
  assert.equal(type.type, 'wiki');
  assert.equal(type.ecosystem, 'roblox');
  assert.equal(type.browserPlayable, false);
});

test('Roblox Fast uses CCU absolute and relative growth plus engagement without Steam dependencies', () => {
  const candidate = robloxCandidate();
  const fast = calculateFastSignals(candidate, {}, NOW);
  assert.equal(fast.profile, 'roblox');
  assert.equal(fast.classification, 'pass');
  assert.ok(fast.components.ccuGrowth >= 28);
  assert.ok(fast.components.engagementGrowth >= 13);
  assert.equal(fast.growthSignals.includes('ccu-growth'), true);
  assert.equal(candidate.sources.some((source) => /steam/i.test(source.sourceId)), false);
});

test('high current CCU without history cannot be treated as growth or pass by itself', () => {
  const candidate = robloxCandidate({ growth: { ccuDelta24h: null, ccuGrowth24h: null, ccuDelta48h: null, ccuGrowth48h: null, visitsDelta24h: null, favoritesDelta24h: null, maxRankGain24h: null, firstChartEntry24h: false, chartSourceCount: 1 }, roblox: { playing: 50000, rankings: { 'roblox-top-trending': { currentRank: 1 } } } });
  const fast = calculateRobloxFastSignals(candidate, NOW);
  assert.equal(fast.components.ccuGrowth, 0);
  assert.notEqual(fast.classification, 'pass');
  assert.match(fast.reasons.join(' '), /基线/);
});

test('a newly created game entering Up-and-Coming top 20 can use the explicit special rule', () => {
  const candidate = robloxCandidate({
    growth: { ccuDelta24h: null, ccuGrowth24h: null, ccuDelta48h: null, ccuGrowth48h: null, visitsDelta24h: null, favoritesDelta24h: null, maxRankGain24h: null, firstChartEntry24h: false, chartSourceCount: 1 },
    roblox: { rankings: { 'roblox-up-and-coming': { currentRank: 12, previousRank: null, firstSeen: '2026-09-10T00:00:00Z' } }, playing: 150 },
  });
  const fast = calculateRobloxFastSignals(candidate, NOW);
  assert.equal(fast.strongGrowth, true);
  assert.equal(fast.classification, 'pass');
});

test('ordinary pass requires at least two growth signals', () => {
  const candidate = robloxCandidate({ growth: { visitsDelta24h: null, favoritesDelta24h: null, maxRankGain24h: 0, firstChartEntry24h: false, chartSourceCount: 1 } });
  const fast = calculateRobloxFastSignals(candidate, NOW);
  assert.equal(fast.growthSignalCount, 1);
  assert.notEqual(fast.classification, 'pass');
});

test('multiple Roblox charts confirm momentum but remain one independent platform', () => {
  const fast = calculateRobloxFastSignals(robloxCandidate(), NOW);
  assert.equal(fast.robloxChartSourceCount, 2);
  assert.equal(fast.independentPlatformCount, 1);
});

test('SEO and Trends pending Roblox candidate can enter Today Review roblox-growth', () => {
  const candidate = robloxCandidate();
  candidate.siteType = classifySiteType(candidate);
  candidate.fast = calculateFastSignals(candidate, {}, NOW);
  const recommendationBefore = candidate.recommendation;
  const result = buildTodayReview([candidate], { nowMs: NOW, minSelected: 0 });
  assert.equal(result.report.selectedCount, 1);
  assert.equal(candidate.todayReview?.lane, 'roblox-growth');
  assert.match(candidate.todayReview.warnings.join(' '), /SEO搜索意图待验证/);
  assert.match(candidate.todayReview.warnings.join(' '), /Trends尚未完成验证/);
  assert.equal(candidate.recommendation, recommendationBefore);
});

test('existing Roblox keyword remains a Today Review hard exclusion', () => {
  const candidate = robloxCandidate({ marketFreshness: { keywordFreshness: 'existing' } });
  candidate.fast = calculateFastSignals(candidate, {}, NOW);
  buildTodayReview([candidate], { nowMs: NOW });
  assert.equal(candidate.todayReview, undefined);
});

test('Roblox lane can occupy at most five Today Review slots', () => {
  const candidates = Array.from({ length: 7 }, (_, index) => {
    const item = robloxCandidate({ roblox: { universeId: String(100 + index), rootPlaceId: String(200 + index), originalName: `Quest ${index}`, normalizedKeyword: `Quest ${index}` } });
    item.id = `roblox:${100 + index}`;
    item.gameName = `Quest ${index}`;
    item.normalizedName = `quest ${index}`;
    item.fast = calculateFastSignals(item, {}, NOW);
    return item;
  });
  const result = buildTodayReview(candidates, { nowMs: NOW, minSelected: 0, platformLimit: 15 });
  assert.equal(result.report.laneCounts['roblox-growth'], 5);
});

test('ordinary new Roblox candidate cannot consume paid SEO quota', () => {
  const ordinary = robloxCandidate({ growth: { ccuDelta24h: null, ccuGrowth24h: null, ccuDelta48h: null, ccuGrowth48h: null, visitsDelta24h: null, favoritesDelta24h: null, maxRankGain24h: null, firstChartEntry24h: false, chartSourceCount: 1 } });
  ordinary.fast = calculateFastSignals(ordinary, {}, NOW);
  assert.equal(allowsPaidRobloxVerification(ordinary), false);

  const passed = robloxCandidate();
  passed.fast = calculateFastSignals(passed, {}, NOW);
  assert.equal(passed.fast.classification, 'pass');
  assert.equal(allowsPaidRobloxVerification(passed), true);

  const nonRoblox = { id: 'ordinary-game' };
  assert.equal(allowsPaidRobloxVerification(nonRoblox), true);
});

test('high-priority Roblox Today Review can unlock paid verification while ordinary candidates stay out of Trends queues', () => {
  const highPriority = robloxCandidate({ growth: { ccuDelta24h: null, ccuGrowth24h: null, ccuDelta48h: null, ccuGrowth48h: null, visitsDelta24h: null, favoritesDelta24h: null, maxRankGain24h: null, firstChartEntry24h: false, chartSourceCount: 1 } });
  highPriority.fast = { modelVersion: FAST_MODEL_VERSION, profile: 'roblox', classification: 'watch', score: 40 };
  highPriority.todayReview = { selected: true, lane: 'roblox-growth', score: 65 };
  assert.equal(allowsPaidRobloxVerification(highPriority), true);

  const ordinary = robloxCandidate({ seo: { modelVersion: SEO_MODEL_VERSION, classification: 'page', score: 60 } });
  ordinary.fast = { modelVersion: FAST_MODEL_VERSION, profile: 'roblox', classification: 'watch', score: 40 };
  assert.equal(classifyTrendTier(ordinary, NOW), null);
});
