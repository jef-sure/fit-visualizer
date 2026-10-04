const { asNumber, calculateRobustTrend, haversineKm } = require('./utils');
const { computeHeartRateZones, calculatePeakHeartRates, PEAK_HEART_RATE_WINDOWS } = require('./heart-rate');
const { localDate } = require('./activity-time');
const { loadRhythm } = require('./trend-metrics');

function compareSegmentStructures(currentSegments, priorSegments) {
  const current = (currentSegments || []).filter((segment) => segment.type !== 'stopped' && segment.durationS >= 60);
  const prior = (priorSegments || []).filter((segment) => segment.type !== 'stopped' && segment.durationS >= 60);
  const matches = [];
  let previousIndex = -1;
  for (const segment of current) {
    let best = null;
    for (let index = previousIndex + 1; index < prior.length; index += 1) {
      const candidate = prior[index];
      const durationRatio = candidate.durationS / segment.durationS;
      const gradeDifference = Math.abs(asNumber(candidate.avgGrade) - asNumber(segment.avgGrade));
      if (candidate.type !== segment.type || durationRatio < 0.5 || durationRatio > 2
        || !Number.isFinite(gradeDifference) || gradeDifference > 2) continue;
      const distanceDifference = Number.isFinite(asNumber(segment.distanceKm)) && Number.isFinite(asNumber(candidate.distanceKm))
        ? Math.abs(candidate.distanceKm - segment.distanceKm) / Math.max(0.1, segment.distanceKm, candidate.distanceKm) : null;
      const difference = Math.abs(Math.log(durationRatio)) + gradeDifference / 2 + (distanceDifference || 0);
      if (!best || difference < best.difference) best = { segment, candidate, index, difference, durationRatio, gradeDifference };
    }
    if (!best) continue;
    previousIndex = best.index;
    const routePoints = best.segment.routePoints || [];
    const candidatePoints = best.candidate.routePoints || [];
    const routeSupported = routePoints.length === 5 && candidatePoints.length === 5
      && routePoints.every((point, index) => haversineKm(point.latitude, point.longitude,
        candidatePoints[index].latitude, candidatePoints[index].longitude) < 0.1);
    matches.push({ currentIndex: best.segment.index, priorIndex: best.candidate.index,
      type: best.segment.type, durationRatio: best.durationRatio, gradeDifference: best.gradeDifference,
      route: routeSupported ? 'approximate ordered GPS support; not exact route identity' : 'route identity not established',
      current: best.segment, prior: best.candidate });
  }
  const duration = current.reduce((sum, segment) => sum + segment.durationS, 0);
  const matchedDuration = matches.reduce((sum, match) => sum + match.current.durationS, 0);
  return { matches, matchedDurationPct: duration > 0 ? 100 * matchedDuration / duration : 0 };
}

function buildTrainingContext(activities, referenceTime, currentSport, currentSegments = []) {
  const reference = new Date(referenceTime).getTime();
  if (!Number.isFinite(reference)) return null;
  const dated = (activities || []).filter((activity) => {
    const time = new Date(activity.startTime).getTime();
    return Number.isFinite(time) && time < reference && time >= reference - 90 * 86400000;
  }).sort((left, right) => new Date(left.startTime) - new Date(right.startTime));
  const sameSport = dated.filter((activity) => activity.sport === currentSport);
  const windowDays = [28, 56, 90].find((days) => sameSport.filter((activity) =>
    new Date(activity.startTime).getTime() >= reference - days * 86400000).length >= 8) || 90;
  const currentWindow = sameSport.filter((activity) => new Date(activity.startTime).getTime() >= reference - windowDays * 86400000);
  const aggregate = (days, previous = false) => {
    const end = reference - (previous ? days : 0) * 86400000;
    const start = end - days * 86400000;
    const selected = dated.filter((activity) => {
      const time = new Date(activity.startTime).getTime();
      return time >= start && time < end;
    });
    const sports = [...new Set(selected.map((activity) => activity.sport))];
    return { days, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      sports: sports.map((sport) => {
        const rows = selected.filter((activity) => activity.sport === sport);
        const zoneSeconds = [0, 0, 0, 0, 0];
        let zonedActivities = 0;
        let coveredHrSeconds = 0;
        for (const activity of rows) {
          if (!activity.zones?.enabled || !(activity.zones.totalSeconds > 0)) continue;
          zonedActivities += 1;
          coveredHrSeconds += activity.zones.totalSeconds;
          activity.zones.zones.forEach((zone, index) => { zoneSeconds[index] += zone.seconds; });
        }
        // RPE vs load: the athlete's own effort number against TRIMP for the same rides. Descriptive
        // only; no correlation is drawn at n < 6.
        const rpeRides = rows
          .map((activity) => ({ rpe: asNumber(activity.notes?.rpe), trimp: asNumber(activity.trimp) }))
          .filter((entry) => Number.isFinite(entry.rpe) && entry.rpe > 0);
        const medianOf = (values) => {
          const sorted = [...values].sort((left, right) => left - right);
          return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        };
        const rpeWithLoad = rpeRides.filter((entry) => Number.isFinite(entry.trimp) && entry.trimp > 0);
        return { sport, activities: rows.length,
          durationS: rows.reduce((sum, activity) => sum + (asNumber(activity.durationS) > 0 ? Number(activity.durationS) : 0), 0),
          durationKnownActivities: rows.filter((activity) => asNumber(activity.durationS) > 0).length,
          distanceKm: rows.reduce((sum, activity) => sum + (asNumber(activity.distanceKm) > 0 ? Number(activity.distanceKm) : 0), 0),
          activeDays: new Set(rows.map((activity) => localDate(activity.startTime, activity.utcOffsetS))).size,
          trimpSum: rows.reduce((sum, activity) => sum + (asNumber(activity.trimp) > 0 ? Number(activity.trimp) : 0), 0),
          trimpActivities: rows.filter((activity) => asNumber(activity.trimp) > 0).length,
          rpeCount: rpeRides.length,
          medianRpe: medianOf(rpeRides.map((entry) => entry.rpe)),
          medianTrimpOfRpeRides: medianOf(rpeWithLoad.map((entry) => entry.trimp)),
          highRpeRides: rpeRides.filter((entry) => entry.rpe >= 8).map((entry) => Math.round(entry.trimp) || null).filter((value) => value != null),
          classMix: countSessionClasses(rows),
          zonedActivities, coveredHrSeconds, zoneSeconds };
      }) };
  };
  const candidates = currentWindow.filter((activity) => activity.segments?.length).map((activity) => ({
    activityId: activity.activityId, startTime: activity.startTime,
    ...compareSegmentStructures(currentSegments, activity.segments),
  })).filter((candidate) => candidate.matches.length)
    .sort((left, right) => right.matchedDurationPct - left.matchedDurationPct || new Date(right.startTime) - new Date(left.startTime))
    .slice(0, 4);
  const interruptions = [];
  for (let index = 1; index < sameSport.length; index += 1) {
    const gapDays = (new Date(sameSport[index].startTime) - new Date(sameSport[index - 1].startTime)) / 86400000;
    if (gapDays >= 14) interruptions.push({ before: sameSport[index - 1].startTime, after: sameSport[index].startTime, gapDays });
  }
  if (sameSport.length) {
    const last = sameSport.at(-1);
    const gapDays = (reference - new Date(last.startTime).getTime()) / 86400000;
    if (gapDays >= 14) interruptions.push({ before: last.startTime, after: referenceTime, gapDays });
  }
  const recent = sameSport.slice(-12);
  const trend = (field) => calculateRobustTrend(currentWindow.map((activity) => asNumber(activity[field])));
  const peakBest = (seconds, days) => sameSport
    .filter((activity) => new Date(activity.startTime).getTime() >= reference - days * 86400000)
    .map((activity) => ({ startTime: activity.startTime, bpm: activity.peakHr?.find((peak) => peak.seconds === seconds)?.bpm }))
    .filter((peak) => peak.bpm != null)
    .reduce((best, peak) => (!best || peak.bpm > best.bpm ? peak : best), null);
  const peakHeartRates = PEAK_HEART_RATE_WINDOWS.map((seconds) => ({ seconds, best28: peakBest(seconds, 28), best90: peakBest(seconds, 90) }))
    .filter((row) => row.best28 || row.best90);
  // Foster monotony/strain over the same-sport week before the activity: descriptive, imported days only.
  const week = aggregate(7);
  const weekLoads = week.sports.find((row) => row.sport === currentSport);
  const monotony = computeMonotony((weekLoads ? selectedActivitiesFor(week) : []).map((activity) => ({
    date: localDate(activity.startTime, activity.utcOffsetS), trimp: asNumber(activity.trimp),
  })));
  return { windowDays, windowStart: new Date(reference - windowDays * 86400000).toISOString(),
    windowEnd: new Date(reference).toISOString(), activities: currentWindow.length,
    volume: [aggregate(7), aggregate(7, true), aggregate(28), aggregate(28, true)],
    durationTrend: trend('durationS'), distanceTrend: trend('distanceKm'),
    monotony,
    comparisons: candidates, interruptions, peakHeartRates,
    recentHistory: recent.map((activity) => ({
      ...activity,
      zoneSeconds: activity.zones?.enabled ? activity.zones.zones.map((zone) => zone.seconds) : undefined,
      peak20: activity.peakHr?.find((peak) => peak.seconds === 1200)?.bpm ?? undefined,
      records: undefined, segments: undefined, zones: undefined, peakHr: undefined,
    })),
    intensityNote: 'HR zones use each activity\'s dated profile. Profile changes affect comparability; zone names do not establish physiological thresholds. Only covered time at/above the zone floor is included.',
    coverageNote: 'Only imported activities are known. Missing activities are not rest days. Different sports and load scales are not added together. Historical signal detail is limited to the latest 40 activities per sport within 90 days; uncovered intensity remains unknown.' };

  function selectedActivitiesFor(period) {
    const start = new Date(period.start).getTime();
    const end = new Date(period.end).getTime();
    return dated.filter((activity) => {
      const time = new Date(activity.startTime).getTime();
      return activity.sport === currentSport && time >= start && time < end;
    });
  }
}

function countSessionClasses(rows) {
  const counts = {};
  for (const row of rows) {
    const label = row.sessionClass?.label;
    if (label) counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

// Foster-style weekly monotony: mean daily load / SD of daily load across all calendar days of the
// period, with non-imported days counted as zero load only when the period contains any activity.
// Returns null when the period has fewer than two active days: one load spike is not monotony.
function computeMonotony(entries) {
  const days = new Map();
  let anyLoad = false;
  for (const entry of entries) {
    const trimp = Number(entry.trimp);
    if (Number.isFinite(trimp) && trimp > 0) {
      anyLoad = true;
      days.set(entry.date, (days.get(entry.date) || 0) + trimp);
    }
  }
  if (!anyLoad || days.size < 2) return null;
  const loads = [...days.values()];
  const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length;
  const variance = loads.reduce((sum, value) => sum + (value - mean) ** 2, 0) / loads.length;
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return { activeDays: loads.length, meanDailyTrimp: mean, monotony: mean / sd, strain: mean / sd * loads.reduce((sum, value) => sum + value, 0) };
}

// Part I, indicator 2 (lightweight): acute:chronic load rhythm from activity loads only, without
// the full training-context pipeline. Mirrors buildTrainingContext's volume windows and monotony
// so the route-card number equals the prompt number. `activities` entries need startTime, sport,
// trimp and utcOffsetS.
function computeLoadRhythm(activities, referenceTime, currentSport) {
  const reference = new Date(referenceTime).getTime();
  if (!Number.isFinite(reference)) return null;
  const dated = (activities || []).filter((activity) => {
    const time = new Date(activity.startTime).getTime();
    return Number.isFinite(time) && time < reference && time >= reference - 90 * 86400000;
  }).sort((left, right) => new Date(left.startTime) - new Date(right.startTime));
  const aggregate = (days, previous = false) => {
    const end = reference - (previous ? days : 0) * 86400000;
    const start = end - days * 86400000;
    const selected = dated.filter((activity) => {
      const time = new Date(activity.startTime).getTime();
      return time >= start && time < end;
    });
    return [...new Set(selected.map((activity) => activity.sport))].map((sport) => {
      const rows = selected.filter((activity) => activity.sport === sport);
      return { sport, activities: rows.length,
        trimpSum: rows.reduce((sum, activity) => sum + (asNumber(activity.trimp) > 0 ? Number(activity.trimp) : 0), 0),
        trimpActivities: rows.filter((activity) => asNumber(activity.trimp) > 0).length };
    });
  };
  const weekNow = aggregate(7)[0];
  const weekPrev = aggregate(7, true)[0];
  const monthAvg = aggregate(28)[0];
  const acute = weekNow?.trimpActivities ? weekNow.trimpSum : null;
  const chronic = monthAvg?.trimpActivities && monthAvg.activities
    ? (monthAvg.trimpSum / (28 / 7)) : null;
  const prevRatioLow = Boolean(weekPrev?.trimpActivities) && chronic > 0 && weekPrev.trimpSum / chronic < 0.8;
  const week = aggregate(7);
  const weekLoads = week.find((row) => row.sport === currentSport);
  const weekStart = reference - 7 * 86400000;
  const monotony = computeMonotony((weekLoads ? dated.filter((activity) => {
    const time = new Date(activity.startTime).getTime();
    return activity.sport === currentSport && time >= weekStart && time < reference;
  }) : []).map((activity) => ({
    date: localDate(activity.startTime, activity.utcOffsetS), trimp: asNumber(activity.trimp),
  })));
  return (monotony?.monotony != null)
    ? loadRhythm(acute, chronic, monotony.monotony, prevRatioLow) : null;
}

function attachActivityZones(activity, records, heartRateConfig) {
  return { ...activity,
    zones: Number.isFinite(heartRateConfig?.maxHeartRate)
      ? computeHeartRateZones(records, heartRateConfig.maxHeartRate, heartRateConfig.thresholds, { restingHeartRate: heartRateConfig.restingHeartRate }) : null,
    peakHr: calculatePeakHeartRates(records) };
}

module.exports = { attachActivityZones, buildTrainingContext, compareSegmentStructures, computeLoadRhythm };