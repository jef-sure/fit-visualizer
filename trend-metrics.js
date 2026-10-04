'use strict';

// Part I of the segmentation plan: three computed trend indicators per route, each with a
// code-issued verdict. The model explains what moved; it never computes or names these as
// health or fitness. Everything here is pure and testable — no DB, no vscode.
//
//  1  Route efficiency — elapsed × HR at the last shared checkpoint against the median of the
//     last 5 prior rides of the same route and direction.
//  2  Load rhythm — acute (7-day TRIMP) to chronic (28-day weekly average) ratio plus the
//     Foster monotony of the week.
//  3  Post-climb HR recovery — bpm drop in the 60 s after the final climb, against the median
//     of the last 5 prior rides of the same route and direction.

const PRIOR_RIDES = 5;

const asFinite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
};

const round1 = (value) => Math.round(value * 10) / 10;

// Indicator 1. `effort = elapsedS × avgHr` at the last checkpoint both this ride and the medians
// share (the highest km present in at least half of the priors). Returns null when there is
// nothing comparable.
function routeEfficiency(current, priors) {
  const mark = asFinite(current?.km);
  const elapsed = asFinite(current?.elapsedS);
  const hr = asFinite(current?.avgHr);
  if (mark == null || elapsed == null || hr == null || !(elapsed > 0) || !(hr > 0)) return null;
  const comparable = (priors || []).filter((prior) => asFinite(prior?.km) === mark
    && asFinite(prior?.elapsedS) > 0 && asFinite(prior?.avgHr) > 0);
  if (comparable.length < PRIOR_RIDES) return null;
  const recent = comparable.slice(-PRIOR_RIDES);
  const medianEffort = median(recent.map((prior) => prior.elapsedS * prior.avgHr));
  const effort = elapsed * hr;
  if (!(medianEffort > 0)) return null;
  const deltaPct = 100 * (effort - medianEffort) / medianEffort;
  // "3 in a row the same way" turns a single deviation into a tendency: the last 3 rides,
  // including this one, all on the same side of their own comparison base.
  const series = [comparable[comparable.length - 2], comparable[comparable.length - 3]].filter(Boolean);
  const priorDeltas = series.map((prior) => {
    const base = median(recent.filter((r) => r !== prior).map((r) => r.elapsedS * r.avgHr));
    return base > 0 ? 100 * (prior.elapsedS * prior.avgHr - base) / base : null;
  });
  const lastThree = [deltaPct, ...priorDeltas].filter(Number.isFinite);
  const sameSide = lastThree.length === 3
    && (lastThree.every((d) => d <= -3) || lastThree.every((d) => d >= 3));
  const verdict = Math.abs(deltaPct) < 3 ? 'usual'
    : deltaPct <= -3 ? (sameSide ? 'tendency-better' : 'better-once')
      : sameSide ? 'tendency-worse' : 'worse-once';
  return { km: mark, effort: Math.round(effort), medianEffort: Math.round(medianEffort),
    deltaPct: round1(deltaPct), verdict, samples: recent.length };
}

// Indicator 2. acute:chronic ratio from TRIMP sums; "two weeks low" needs the previous week too.
function loadRhythm(acuteTrimp, chronicWeeklyTrimp, monotonyValue, previousWeekRatioLow = false) {
  const acute = asFinite(acuteTrimp);
  const chronic = asFinite(chronicWeeklyTrimp);
  const monotony = asFinite(monotonyValue);
  if (acute == null || chronic == null || !(chronic > 0) || monotony == null) return null;
  const ratio = acute / chronic;
  const verdict = ratio >= 0.8 && ratio <= 1.3 ? 'steady'
    : ratio > 1.5 && monotony > 2 ? 'spike-monotonous'
      : ratio > 1.3 ? 'above-habit'
        : previousWeekRatioLow ? 'below-habit-weeks' : 'below-habit';
  return { ratio: Math.round(ratio * 100) / 100, monotony: Math.round(monotony * 100) / 100, verdict };
}

// Indicator 3. The drop after the final climb, in bpm, against the median of priors with a drop.
function postClimbRecovery(currentDrop, priorDrops, climbPeakHr = null) {
  const drop = asFinite(currentDrop);
  if (drop == null || drop < 0) return null;
  const priors = (priorDrops || []).map(asFinite).filter((d) => d != null && d >= 0);
  if (priors.length < PRIOR_RIDES) return null;
  const medianDrop = median(priors.slice(-PRIOR_RIDES));
  const delta = drop - medianDrop;
  const verdict = Math.abs(delta) <= 5 ? 'usual' : delta < 0 ? 'slower' : 'faster';
  return { drop, medianDrop, delta: Math.round(delta), climbPeakHr: asFinite(climbPeakHr), verdict,
    samples: Math.min(priors.length, PRIOR_RIDES) };
}

// The two route-dependent indicators (efficiency, recovery) as a pair. Shared by the analysis
// prompt and the lightweight route-card path so both report the same numbers. Each priorSameRoute
// entry carries `checkpoints` and `segments` for earlier rides of the same route and direction.
function computeRouteTrends(currentCheckpoints, currentSegments, currentStartTime, priorSameRoute, minPriorRides = PRIOR_RIDES) {
  // Marks sit at each ride's own segment boundaries, so exact km values differ ride to ride;
  // place identity is approximated by km within 150 m (route length differences are tiny here).
  // The indicator uses the current ride's LAST mark that at least minPriorRides priors reach.
  const priorMarkCounts = new Map();
  for (const activity of priorSameRoute) {
    for (const cp of activity.checkpoints || []) {
      const bucket = Math.round(cp.km * 2) / 2;
      priorMarkCounts.set(bucket, (priorMarkCounts.get(bucket) || 0) + 1);
    }
  }
  const nearMark = (km) => {
    const bucket = Math.round(km * 2) / 2;
    return priorMarkCounts.get(bucket) || 0;
  };
  const currentMarks = (currentCheckpoints || []).filter((cp) => nearMark(cp.km) >= minPriorRides);
  const lastMark = currentMarks.at(-1) || null;
  const markKm = lastMark ? lastMark.km : null;
  const pickPrior = (checkpoints) => (checkpoints || [])
    .reduce((best, cp) => (Number.isFinite(cp.km) && Math.abs(cp.km - markKm) <= 0.2
      && (!best || Math.abs(cp.km - markKm) < Math.abs(best.km - markKm)) ? cp : best), null);
  const efficiency = lastMark
    ? routeEfficiency(lastMark,
        priorSameRoute.map((activity) => pickPrior(activity.checkpoints)).filter(Boolean))
    : null;
  const recovery = (() => {
    const climbs = (currentSegments || []).filter((segment) => segment.type === 'climb');
    const finalClimb = climbs.at(-1);
    if (!finalClimb || !(finalClimb.durationS >= 180) || finalClimb.postClimbHrDropBpm == null) return null;
    const priorDrops = priorSameRoute
      .map((activity) => (activity.segments || [])
        .filter((segment) => segment.type === 'climb' && segment.durationS >= 180)
        .map((segment) => segment.postClimbHrDropBpm))
      .flat().filter((drop) => Number.isFinite(drop));
    return postClimbRecovery(finalClimb.postClimbHrDropBpm, priorDrops, finalClimb.avgHr);
  })();
  // Per-ride values for the card's history strip (oldest first, current last). Each entry is
  // { date, value, current? } so the UI can draw a small trend and highlight this ride.
  const effort = (cp) => (Number.isFinite(Number(cp?.elapsedS)) && Number.isFinite(Number(cp?.avgHr))
    && Number(cp.elapsedS) > 0 && Number(cp.avgHr) > 0
    ? Math.round(Number(cp.elapsedS) * Number(cp.avgHr)) : null);
  const efficiencyHistory = markKm == null ? [] : [
    ...priorSameRoute.map((activity) => {
      const value = effort(pickPrior(activity.checkpoints));
      return value == null ? null : { date: activity.startTime, value };
    }).filter(Boolean),
    ...(effort(lastMark) == null ? [] : [{ date: currentStartTime, value: effort(lastMark), current: true }]),
  ];
  const climbDrop = (segments) => {
    const climbs = (segments || []).filter((segment) => segment.type === 'climb' && segment.durationS >= 180);
    const last = climbs.at(-1);
    return (last && Number.isFinite(Number(last.postClimbHrDropBpm)) && last.postClimbHrDropBpm != null)
      ? Number(last.postClimbHrDropBpm) : null;
  };
  const currentDrop = climbDrop(currentSegments);
  const recoveryHistory = [
    ...priorSameRoute.map((activity) => {
      const value = climbDrop(activity.segments);
      return value == null ? null : { date: activity.startTime, value };
    }).filter(Boolean),
    ...(currentDrop == null ? [] : [{ date: currentStartTime, value: currentDrop, current: true }]),
  ];
  return { efficiency, recovery,
    efficiencyHistory: efficiencyHistory.slice(-6),
    recoveryHistory: recoveryHistory.slice(-6) };
}

// One short localized phrase per indicator; no hypotheses about causes. The wording never says
// health or fitness — it says what the number did relative to habit.
function describeTrendVerdicts(trends, t) {
  const lines = [];
  if (trends?.efficiency) {
    const e = trends.efficiency;
    const word = e.verdict === 'usual' ? t('trendUsual')
      : e.verdict === 'tendency-better' ? t('trendTendencyBetter')
        : e.verdict === 'better-once' ? t('trendBetterOnce')
          : e.verdict === 'tendency-worse' ? t('trendTendencyWorse') : t('trendWorseOnce');
    lines.push(t('trendEfficiencyLine', e.km, `${e.deltaPct > 0 ? '+' : ''}${e.deltaPct}%`, word));
  }
  if (trends?.rhythm) {
    const r = trends.rhythm;
    const word = r.verdict === 'steady' ? t('trendSteady')
      : r.verdict === 'above-habit' ? t('trendAboveHabit')
        : r.verdict === 'spike-monotonous' ? t('trendSpikeMonotonous')
          : r.verdict === 'below-habit-weeks' ? t('trendBelowHabitWeeks') : t('trendBelowHabit');
    lines.push(t('trendRhythmLine', r.ratio, word));
  }
  if (trends?.recovery) {
    const c = trends.recovery;
    const word = c.verdict === 'usual' ? t('trendUsual')
      : c.verdict === 'slower' ? t('trendHrSlower') : t('trendHrFaster');
    lines.push(t('trendRecoveryLine', c.drop, c.medianDrop, word));
  }
  return lines;
}

module.exports = { PRIOR_RIDES, loadRhythm, postClimbRecovery, routeEfficiency, computeRouteTrends, describeTrendVerdicts };
