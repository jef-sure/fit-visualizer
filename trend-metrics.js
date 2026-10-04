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
const { priorRowsNear } = require('./route-store');
const { haversineM } = require('./route-match');

const asFinite = (value) => {
  if (value == null || value === '') return null;
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
  const hr = asFinite(current?.cumulativeAvgHr ?? current?.avgHr);
  if (mark == null || elapsed == null || hr == null || !(elapsed > 0) || !(hr > 0)) return null;
  const comparable = (priors || []).filter((prior) => asFinite(prior?.km) === mark
    && asFinite(prior?.elapsedS) > 0 && asFinite(prior?.cumulativeAvgHr ?? prior?.avgHr) > 0);
  if (comparable.length < PRIOR_RIDES) return null;
  const recent = comparable.slice(-PRIOR_RIDES);
  const effortOf = (prior) => prior.elapsedS * (prior.cumulativeAvgHr ?? prior.avgHr);
  const medianEffort = median(recent.map(effortOf));
  const effort = elapsed * hr;
  if (!(medianEffort > 0)) return null;
  const deltaPct = 100 * (effort - medianEffort) / medianEffort;
  // "3 in a row the same way" turns a single deviation into a tendency: the last 3 rides,
  // including this one, all on the same side of their own comparison base.
  const priorDeltas = [comparable.length - 2, comparable.length - 1].map((index) => {
    const baseRides = comparable.slice(Math.max(0, index - PRIOR_RIDES), index);
    if (baseRides.length < PRIOR_RIDES) return null;
    const base = median(baseRides.map(effortOf));
    return base > 0 ? 100 * (effortOf(comparable[index]) - base) / base : null;
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
  const lengthKm = Math.max(0, ...(currentCheckpoints || []).map((cp) => cp.km).filter(Number.isFinite));
  const effort = (cp) => {
    const elapsed = asFinite(cp?.elapsedS);
    const hr = asFinite(cp?.cumulativeAvgHr ?? cp?.avgHr);
    return elapsed > 0 && hr > 0 ? Math.round(elapsed * hr) : null;
  };
  const matching = (activity, mark) => priorRowsNear([activity], mark, { lengthKm })[0] || null;
  let lastMark = null;
  let efficiency = null;
  for (const mark of [...(currentCheckpoints || [])].sort((a, b) => b.km - a.km)) {
    if (effort(mark) == null) continue;
    const matches = priorSameRoute.map((activity) => matching(activity, mark))
      .filter((cp) => effort(cp) != null).map((cp) => ({ ...cp, km: mark.km }));
    if (matches.length < minPriorRides) continue;
    const candidate = routeEfficiency(mark, matches);
    if (candidate) { lastMark = mark; efficiency = candidate; break; }
  }
  const markKm = lastMark?.km ?? null;
  const pickPrior = (checkpoints) => lastMark ? matching({ checkpoints }, lastMark) : null;
  const finalClimbOf = (segments) => (segments || []).filter((segment) => segment.type === 'climb').at(-1);
  const finalClimb = finalClimbOf(currentSegments);
  const climbDrop = (segments) => {
    const last = finalClimbOf(segments);
    const drop = asFinite(last?.postClimbHrDropBpm);
    return last?.durationS >= 180 && drop != null && drop >= 0 ? drop : null;
  };
  const currentDrop = climbDrop(currentSegments);
  const comparableClimb = (segments) => {
    const prior = finalClimbOf(segments);
    if (!prior || !finalClimb) return false;
    if (prior.routePoints?.length === 5 && finalClimb.routePoints?.length === 5) {
      return finalClimb.routePoints.every((point, index) => {
        const other = prior.routePoints[index];
        return haversineM(point.latitude, point.longitude, other.latitude, other.longitude) <= 150;
      });
    }
    const start = asFinite(finalClimb.startDistanceKm);
    const priorStart = asFinite(prior.startDistanceKm);
    const distance = asFinite(finalClimb.distanceKm);
    const priorDistance = asFinite(prior.distanceKm);
    return start != null && priorStart != null && distance > 0 && priorDistance > 0
      && Math.abs(start - priorStart) <= 0.15
      && Math.abs(start + distance - priorStart - priorDistance) <= 0.15;
  };
  const priorDrops = priorSameRoute.filter((activity) => comparableClimb(activity.segments))
    .map((activity) => climbDrop(activity.segments)).filter((drop) => drop != null);
  const recovery = postClimbRecovery(currentDrop, priorDrops, finalClimb?.avgHr);
  // Per-ride values for the card's history strip (oldest first, current last). Each entry is
  // { date, value, current? } so the UI can draw a small trend and highlight this ride.
  const efficiencyHistory = markKm == null ? [] : [
    ...priorSameRoute.map((activity) => {
      const value = effort(pickPrior(activity.checkpoints));
      return value == null ? null : { date: activity.startTime, value };
    }).filter(Boolean),
    ...(effort(lastMark) == null ? [] : [{ date: currentStartTime, value: effort(lastMark), current: true }]),
  ];
  const recoveryHistory = [
    ...priorSameRoute.map((activity) => {
      if (!comparableClimb(activity.segments)) return null;
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
