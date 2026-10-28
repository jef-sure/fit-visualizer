'use strict';

// Two points on the trend of a route, for "has something changed since then". Pure module: no DB,
// no vscode.
//
// Two rides compare two days: a minute between them may be form, or heat, or three weeks of riding
// in a row, or a ride taken easy. A point is therefore a ride with its neighbours on the same route,
// in the same direction and with the same purpose - up to three before it and three after - and
// each figure is the median of the point with its range. A difference between the points that the
// ranges do not cover is worth a closer look; one inside them is a day's difference.
//
// Rides near both chosen ones go to the point whose ride is nearer in time.
//
// Purposes match when both rides state the same one, or neither states any: a purpose left out
// was not important to the rider, and is not told apart here either. One the AI inferred does not
// count: it is a guess.

const { riddenUpTo, splitTotals, marksByKm, isAxisMarks } = require('./route-store');

const TREND_POINTS = Object.freeze({
  neighbours: 3,          // rides before and after the chosen one (fitVisualizer.comparisonNeighbourRides)
  minRides: 2,            // fewer in a point and it is one day, not a point
  breakDays: 7,           // a gap this long inside a point is said
});

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const purposeKey = (purpose) => (purpose == null || String(purpose).trim() === '' ? '' : String(purpose).trim().toLowerCase());

// The rides of a point: the chosen one and up to `neighbours` rides of the same purpose either side
// of it, in the order the rides were ridden. rides: oldest first, each { id, purpose }.
function pointRides(rides, anchorId, { neighbours = TREND_POINTS.neighbours } = {}) {
  const index = rides.findIndex((ride) => ride.id === anchorId);
  if (index < 0) return [];
  const purpose = purposeKey(rides[index].purpose);
  const same = (ride) => purposeKey(ride.purpose) === purpose;
  // slice(-0) would be every ride before.
  const before = neighbours > 0 ? rides.slice(0, index).filter(same).slice(-neighbours) : [];
  const after = neighbours > 0 ? rides.slice(index + 1).filter(same).slice(0, neighbours) : [];
  return [...before, rides[index], ...after];
}

// The road both chosen rides rode on the route the same way: the stretches between marks both rode,
// a variant only against the same variant. Every ride of both points is measured over this road.
function sharedRoad(marksA, marksB) {
  if (!isAxisMarks(marksA) || !isAxisMarks(marksB)) return [];
  const b = marksByKm(marksB);
  const lastKm = marksA[marksA.length - 1].km;
  const a = marksByKm(marksA);
  return riddenUpTo(marksA, lastKm).filter((km) => {
    const other = b.get(km);
    return other?.ridden && Number.isFinite(other.splitS) && (other.via || '') === (a.get(km).via || '');
  });
}

// What one ride shows on the shared road and on the route's final climb.
// ride: { checkpoints, segments, decouplingPct, finalClimbStretch }.
function rideIndicators(ride, road, viaOf) {
  const marks = marksByKm(ride.checkpoints);
  // The ride must have ridden every stretch of the road, and each the way the chosen rides did.
  const onRoad = road.length && road.every((km) => {
    const mark = marks.get(km);
    return mark?.ridden && Number.isFinite(mark.splitS) && (mark.via || '') === viaOf(km);
  });
  const totals = onRoad ? splitTotals(marks, road) : null;
  // Holding the pace: the second half of the road against the first, in speed and heart rate.
  let halves = null;
  if (totals) {
    const lengthOf = (km) => km - marks.get(km).fromKm;
    let sofar = 0;
    const first = [];
    for (const km of road) {
      if (sofar >= totals.km / 2) break;
      first.push(km);
      sofar += lengthOf(km);
    }
    const second = road.filter((km) => !first.includes(km));
    const a = first.length ? splitTotals(marks, first) : null;
    const b = second.length ? splitTotals(marks, second) : null;
    if (a?.timeS > 0 && b?.timeS > 0) {
      halves = { pacePct: ((b.km / b.timeS) / (a.km / a.timeS) - 1) * 100, hrDelta: a.hr != null && b.hr != null ? b.hr - a.hr : null };
    }
  }
  const moving = (Array.isArray(ride.segments) ? ride.segments : []).filter((segment) => segment && segment.type !== 'stopped');
  // On the flat: speed and heart rate over the ride's flat segments, by their time.
  let flatKm = 0;
  let flatS = 0;
  let flatHrSum = 0;
  let flatHrS = 0;
  for (const segment of moving) {
    if (segment.type !== 'flat' || !(segment.durationS > 0) || !(segment.distanceKm > 0)) continue;
    flatKm += segment.distanceKm;
    flatS += segment.durationS;
    if (segment.avgHr > 0) { flatHrSum += segment.avgHr * segment.durationS; flatHrS += segment.durationS; }
  }
  const flatKmh = flatS >= 300 ? flatKm / (flatS / 3600) : null;
  const flatHr = flatHrS >= flatS * 0.8 && flatHrS > 0 ? flatHrSum / flatHrS : null;
  // The final climb: the segments in the route's last climbing stretch when the ride is cut at the
  // route's stretches, else its own last climb.
  const climb = ride.finalClimbStretch != null && moving.some((segment) => segment.stretchIndex === ride.finalClimbStretch)
    ? moving.filter((segment) => segment.stretchIndex === ride.finalClimbStretch && segment.type === 'climb')
    : moving.filter((segment) => segment.type === 'climb').slice(-1);
  const climbS = climb.reduce((sum, segment) => sum + (segment.durationS || 0), 0);
  const climbHrS = climb.reduce((sum, segment) => sum + (segment.avgHr > 0 ? segment.durationS : 0), 0);
  const last = climb[climb.length - 1];
  return {
    movingS: totals ? totals.timeS : null,
    kmh: totals && totals.timeS > 0 ? totals.km / (totals.timeS / 3600) : null,
    hr: totals ? totals.hr : null,
    restS: totals ? totals.restS : null,
    stops: totals ? totals.stops : null,
    flatKmh,
    flatHr,
    flatKmhPer100Bpm: flatKmh != null && flatHr > 0 ? (100 * flatKmh) / flatHr : null,
    climbS: climbS >= 60 ? climbS : null,
    climbHr: climbHrS >= climbS * 0.8 && climbHrS > 0 ? climb.reduce((sum, segment) => sum + (segment.avgHr > 0 ? segment.avgHr * segment.durationS : 0), 0) / climbHrS : null,
    climbHrDrop: Number.isFinite(last?.postClimbHrDropBpm) ? last.postClimbHrDropBpm : null,
    halfPacePct: halves ? halves.pacePct : null,
    halfHrDelta: halves ? halves.hrDelta : null,
  };
}

// The figures compared between the points, in the order shown. better: which way is better for the
// rider, where it is clear; null where a higher or lower value is no judgement by itself.
const INDICATORS = Object.freeze([
  { key: 'movingS', unit: 's', better: 'lower' },
  { key: 'hr', unit: 'bpm', better: null },
  { key: 'flatKmh', unit: 'km/h', better: null },
  { key: 'flatHr', unit: 'bpm', better: null },
  { key: 'flatKmhPer100Bpm', unit: 'km/h per 100 bpm', better: 'higher' },
  { key: 'climbS', unit: 's', better: 'lower' },
  { key: 'climbHr', unit: 'bpm', better: null },
  { key: 'climbHrDrop', unit: 'bpm', better: 'higher' },
  { key: 'halfPacePct', unit: '%', better: 'higher' },
  { key: 'halfHrDelta', unit: 'bpm', better: null },
]);

// What surrounded the rides of a point: not form, but what may explain a difference instead.
const CIRCUMSTANCES = Object.freeze([
  { key: 'weekLoadPct', unit: '%' },
  { key: 'daysInRow', unit: 'days' },
  { key: 'daysSincePrevious', unit: 'days' },
  { key: 'temperatureC', unit: 'C' },
  { key: 'restS', unit: 's' },
]);

// values: the rides' own, in the order they were ridden - a median can hide a point that mixes
// rides of different days (the end of a long streak and rides after a rest).
function summarize(values) {
  const known = values.filter((value) => Number.isFinite(value));
  return known.length ? { median: median(known), min: Math.min(...known), max: Math.max(...known), n: known.length, values: known } : null;
}

// rides: every ride of the route in this direction, oldest first, each { id, startTime, purpose,
// checkpoints (axis marks), segments, decouplingPct, circumstances }. currentId: the ride on the
// page; referenceId: the one it is compared with. Returns null when the two cannot be compared on
// the route (either lacks axis marks, or they share no road).
function buildTrendPoints(rides, currentId, referenceId, { neighbours = TREND_POINTS.neighbours, finalClimbStretch = null } = {}) {
  const current = rides.find((ride) => ride.id === currentId);
  const reference = rides.find((ride) => ride.id === referenceId);
  if (!current || !reference) return null;
  const road = sharedRoad(current.checkpoints, reference.checkpoints);
  if (!road.length) return null;
  const currentMarks = marksByKm(current.checkpoints);
  const viaOf = (km) => currentMarks.get(km).via || '';
  const [earlier, later] = Date.parse(current.startTime) <= Date.parse(reference.startTime) ? [current, reference] : [reference, current];
  let thenRides = pointRides(rides, earlier.id, { neighbours });
  let nowRides = pointRides(rides, later.id, { neighbours });
  // A ride near both chosen ones belongs to the point whose ride is nearer in time: in both it
  // would say nothing about the difference, and dropped from both it could leave a point empty.
  const timeOf = (ride) => Date.parse(ride.startTime);
  const nearer = (ride) => (Math.abs(timeOf(ride) - timeOf(earlier)) <= Math.abs(timeOf(ride) - timeOf(later)) ? earlier.id : later.id);
  const inNow = new Set(nowRides.map((ride) => ride.id));
  const inThen = new Set(thenRides.map((ride) => ride.id));
  thenRides = thenRides.filter((ride) => ride.id !== later.id && (!inNow.has(ride.id) || nearer(ride) === earlier.id));
  nowRides = nowRides.filter((ride) => ride.id !== earlier.id && (!inThen.has(ride.id) || nearer(ride) === later.id));
  const measure = (ride) => ({ ...ride, indicators: rideIndicators({ ...ride, finalClimbStretch }, road, viaOf) });
  const point = (list, anchor) => {
    const measured = list.map(measure);
    const times = list.map((ride) => Date.parse(ride.startTime)).sort((a, b) => a - b);
    const longestGapDays = times.slice(1).reduce((max, time, index) => Math.max(max, (time - times[index]) / 86400000), 0);
    return {
      anchorId: anchor.id,
      rides: measured,
      from: list[0].startTime,
      to: list[list.length - 1].startTime,
      gapDays: longestGapDays >= TREND_POINTS.breakDays ? Math.round(longestGapDays) : null,
      figures: Object.fromEntries(INDICATORS.map(({ key }) => [key, summarize(measured.map((ride) => ride.indicators[key]))])),
      circumstances: Object.fromEntries(CIRCUMSTANCES.map(({ key }) => [key, summarize(measured.map((ride) => (key === 'restS' ? ride.indicators.restS : ride.circumstances?.[key])))])),
    };
  };
  const then = point(thenRides, earlier);
  const now = point(nowRides, later);
  const roadKm = splitTotals(currentMarks, road)?.km ?? null;
  const compare = (a, b) => {
    if (!a || !b) return { delta: null, beyondSpread: null };
    // The ranges of the two points do not meet: the difference is wider than either point's own spread.
    const beyondSpread = a.n >= TREND_POINTS.minRides && b.n >= TREND_POINTS.minRides ? (a.max < b.min || b.max < a.min) : null;
    return { delta: b.median - a.median, beyondSpread };
  };
  // A figure neither point has is left out; one only one point has stays, to say it is missing.
  const rows = INDICATORS.filter(({ key }) => then.figures[key] || now.figures[key])
    .map(({ key, unit, better }) => ({ key, unit, better, then: then.figures[key], now: now.figures[key], ...compare(then.figures[key], now.figures[key]) }));
  const circumstanceRows = CIRCUMSTANCES.filter(({ key }) => then.circumstances[key] || now.circumstances[key])
    .map(({ key, unit }) => ({ key, unit, then: then.circumstances[key], now: now.circumstances[key], ...compare(then.circumstances[key], now.circumstances[key]) }));
  return {
    currentIsLater: later.id === currentId,
    purpose: purposeKey(current.purpose) || null,
    roadKm: roadKm == null ? null : Math.round(roadKm * 10) / 10,
    then,
    now,
    rows,
    circumstanceRows,
    // With fewer than two rides in a point it is the difference of two days, not of two points.
    twoDays: then.rides.length < TREND_POINTS.minRides || now.rides.length < TREND_POINTS.minRides,
  };
}

module.exports = { CIRCUMSTANCES, INDICATORS, TREND_POINTS, buildTrendPoints, pointRides, rideIndicators, sharedRoad };
