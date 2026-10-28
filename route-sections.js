'use strict';

// Route skeleton: what the road itself looks like, read from all rides of a route together, and
// one ride measured against it. Pure module: no DB, no vscode.
//
// Why: a ride's own segments follow its effort, so the same road is cut differently every day
// (11 to 40 segments on one 20 km loop), and what structures a real route - a junction where
// every ride brakes to 18 km/h, a turn without a view, the foot of a climb - lasts seconds and
// leaves no mark in heart rate. Those places show in the median speed along the road, taken
// over all rides: a slow-down that nearly every ride shares is the route's, not the day's.
//
// The skeleton has two kinds of things, compared differently:
//  - points   places where rides slow down (junction, crossing, blind turn). Speed there is set by
//             safety, so only the time lost against the usual passage means anything.
//  - stretches the road between points, split again where the terrain changes. A climb is read by
//             time and heart rate, flat ground by speed against heart rate, a steep descent hardly
//             at all: gravity and nerve set its speed.
// A ride that leaves the road for part of a stretch (roadworks, an early variant of the route) is
// not compared on that stretch and does not count towards its usual values; the rest still does.

const { hasGpsFix } = require('./route-match');
const { AXIS, axisKey, axisLatLon, buildRouteAxis, layRideOnAxis, medianAxis } = require('./route-axis');
const { ascentDescent } = require('./altitude-quality');

const SECTION_DEFAULTS = Object.freeze({
  minSharePct: 90,        // a slow-down is a point of the route when this share of rides has it
  minSharePctFloor: 70,   // auto-adjust never goes below this
  toleranceM: 0,          // how far from the route's axis a ride may be; 0 = the axis' own 30 m
  minRides: 5,            // fewer rides agree by coincidence too often
  autoAdjust: true,       // relax the share step by step when no slow-down reaches it
});

const SKELETON = Object.freeze({
  version: 6,
  binM: 50,               // resolution along the road
  dipDropPct: 20,         // slow-down: the median speed falls this far below the speed before it
  dipRisePct: 10,         // ... and picks up again by at least this much afterwards
  dipWindowBins: 10,      // "before" and "after" are looked for within 500 m
  rideDipPct: 15,         // one ride has the slow-down when its own speed falls this far
  minStretchBins: 6,      // 300 m: shorter than that is the point's own braking and pulling away
  gradeThresholdPct: 2.5,
  gradeSpanBins: 4,       // grade over 200 m
  keepPointSharePct: 15,  // a stored point is kept down to this far below the required share
  stickyBins: 2,          // a boundary within 100 m of the stored one stays where it was
  detourM: 150,           // this much of a stretch on another road and the ride is not compared
  pointWindowBins: 2,     // a point is timed over 250 m around it
  stoppedKmh: 3,
  // Rest at a stop is what it did for the rider: the heart rate's fall over it. This fall is a full
  // rest (fitVisualizer.stopFullRestHrDrop); 5 s at a light do not let it fall, 50 s do by 15-20.
  fullRestHrDropBpm: 15,
  // ... without heart rate, the fall a stop of that length gives this rider, else full at 50 s.
  restFullAfterS: 50,
  // The route's usual values are kept as counts per value, so a ride is added without reading
  // the earlier ones again: speed to 0.5 km/h, heart rate to 1 bpm, altitude to 0.5 m.
  speedStepKmh: 0.5,
  hrStepBpm: 1,
  altitudeStepM: 0.5,
  sectionStepKmh: 0.1,
  sectionKm: 2,           // the route's speed by direction is told in sections of about 2 km
  minSectionShare: 0.9,   // a ride counts towards a section it rode at least this much of
  minProfileRides: 5,     // the elevation consensus needs this many rides ...
  minProfileBinRides: 3,  // ... and this many in each place
});

// Comparison thresholds: speed by 2%, heart rate by 4 bpm, as the checkpoint verdict used.
const VERDICT = Object.freeze({ speedPct: 2, hrBpm: 4, minHrCoveragePct: 80, descentSpeedPct: 10, lostAtPointS: 10 });

const median = (values) => {
  const sorted = values.filter((value) => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function cleanRecords(records) {
  return (Array.isArray(records) ? records : []).filter((record) => record
    && record.elapsed_time != null && Number.isFinite(Number(record.elapsed_time))
    && record.distance != null && Number.isFinite(Number(record.distance)));
}

// The bins of an axis: 50 m of its road each, round the loop when it is one.
function axisBins(axis) {
  const lengthM = axis?.closed && axis.loopM ? axis.loopM : axis?.lengthM;
  return Number.isFinite(lengthM) ? Math.floor(lengthM / SKELETON.binM) : 0;
}

// One ride laid onto the route: its records placed on the axis by ridden distance and GPS
// (route-axis.js), then per 50 m bin of the axis the time spent there, how much of it stopped,
// heart rate, altitude and the lowest speed. Time ridden away from the road is kept, attached to
// the bins it bypasses, and those bins are flagged: the ride's time there is real, but it was not
// ridden on this road. Time before the ride reaches the road belongs to no bin.
//
// variants: the route's accepted variants in this direction (route-axis.js indexVariant). A bin
// ridden on a variant instead of the axis' own road carries its id in `via`, and `metres` holds the
// road the ride actually rode for that bin's 50 m of the axis.
function layRideOnBins(records, axis, { stops = null, offRoadM = 0, variants = [] } = {}) {
  const list = cleanRecords(records);
  const bins = axisBins(axis);
  if (list.length < 10 || bins < 10) return null;
  const binM = SKELETON.binM;
  const loop = Boolean(axis.closed && axis.loopM);
  const placed = layRideOnAxis(list, axis, { offRoadM, variants });
  const scaleOf = new Map((variants || []).map((variant) => [variant.id, variant.lengthM / Math.max(binM, Math.abs(variant.toS - variant.fromS))]));
  const make = () => new Float64Array(bins);
  const lay = { bins, binM, loop, time: make(), stopped: make(), hrSum: make(), hrTime: make(), altSum: make(), altCount: make(), speedSum: make(), speedCount: make(),
    minKmh: new Float64Array(bins).fill(Number.POSITIVE_INFINITY), off: new Uint8Array(bins), reachedS: new Float64Array(bins).fill(NaN), matched: 0,
    via: new Int32Array(bins).fill(-1), metres: new Float64Array(bins).fill(binM),
    axisKm: null, startS: Number(list[0].elapsed_time), offM: placed.offM, missedM: placed.missedM };
  // The place on the axis of every record given, in the order given (records the laying could not
  // use - no time, no distance - have none).
  const kept = new Set(list);
  let next = 0;
  lay.axisKm = (Array.isArray(records) ? records : []).map((record) => (kept.has(record) ? placed.axisKm[next++] : null));

  // With the ride's own stop segments at hand they decide what counts as stopped, so the page
  // and the route table agree; without them (the route's usual values) the speed does.
  const stopList = Array.isArray(stops)
    ? stops.filter((stop) => Number.isFinite(stop?.startElapsed) && Number.isFinite(stop?.endElapsed)) : null;
  const inStop = (time) => stopList.some((stop) => time > stop.startElapsed && time <= stop.endElapsed);
  let cursor = null;
  let previousTime = null;
  let previousKm = null;
  let pending = 0;        // seconds since the last placed record that had no place
  let pendingStopped = 0;
  let pendingOff = false; // some of that time was ridden with GPS, away from the road
  list.forEach((record, index) => {
    const time = Number(record.elapsed_time);
    const dt = previousTime == null ? 0 : time - previousTime;
    previousTime = time;
    // A gap in the recording with no ground covered is an auto-paused stop; with ground covered
    // it is a recording gap, and its time is unknown rather than ridden.
    const pausedHere = dt > 30 && previousKm != null && Number(record.distance) - previousKm < 0.03;
    previousKm = Number(record.distance);
    const step = dt > 0 && (dt <= 30 || pausedHere) ? dt : 0;
    const kmh = record.speed == null ? null : Number(record.speed);
    const isStopped = pausedHere || (stopList ? inStop(time) : (kmh != null && kmh < SKELETON.stoppedKmh));
    const km = placed.axisKm[index];
    if (km == null) {
      if (cursor != null) {
        pending += step;
        if (isStopped) pendingStopped += step;
        if (hasGpsFix(record.position_lat, record.position_long)) pendingOff = true;
      }
      return;
    }
    const raw = Math.floor((km * 1000) / binM);
    const bin = loop ? ((raw % bins) + bins) % bins : Math.max(0, Math.min(bins - 1, raw));
    lay.matched += 1;
    // Forward along the road (round the loop) the bins passed since the last placed record share
    // the time since then; a step back (GPS at a stop) stays in its own bin.
    const ahead = cursor == null ? 0 : loop ? (((bin - cursor) % bins) + bins) % bins : bin - cursor;
    const forward = ahead > 0 && (!loop || ahead < bins / 2);
    const span = forward ? Array.from({ length: ahead }, (_, offset) => (cursor + 1 + offset) % bins) : [bin];
    const share = (pending + step) / span.length;
    const stoppedShare = (pendingStopped + (isStopped ? step : 0)) / span.length;
    const variant = placed.via?.[index] ?? null;
    for (const at of span) {
      lay.time[at] += share;
      lay.stopped[at] += stoppedShare;
      if (pendingOff) lay.off[at] = 1;
      if (Number.isNaN(lay.reachedS[at])) lay.reachedS[at] = time;
      if (variant != null) { lay.via[at] = variant; lay.metres[at] = binM * (scaleOf.get(variant) || 1); }
    }
    const hr = record.heart_rate == null ? NaN : Number(record.heart_rate);
    // The first sample after an auto-pause is not the heart rate of the whole pause.
    if (hr > 0 && step > 0 && !pausedHere) { lay.hrSum[bin] += hr * step; lay.hrTime[bin] += step; }
    const altitude = record.altitude == null ? NaN : Number(record.altitude);
    if (Number.isFinite(altitude)) { lay.altSum[bin] += altitude; lay.altCount[bin] += 1; }
    if (kmh != null && Number.isFinite(kmh) && kmh < lay.minKmh[bin]) lay.minKmh[bin] = kmh;
    if (kmh != null && Number.isFinite(kmh) && !isStopped) { lay.speedSum[bin] += kmh; lay.speedCount[bin] += 1; }
    if (cursor == null || forward) cursor = bin;
    pending = 0;
    pendingStopped = 0;
    pendingOff = false;
  });
  return lay.matched >= 10 ? lay : null;
}

// Speed of a ride in one bin, for the shape of the road: the recorded speed where there is one.
// Time spent in a 50 m bin is whole seconds, so a speed derived from it jumps by a third at
// 60 km/h; it is the fallback for rides without a speed field.
function binSpeedKmh(lay, bin, binM) {
  if (lay.speedCount[bin] > 0) return lay.speedSum[bin] / lay.speedCount[bin];
  const moving = lay.time[bin] - lay.stopped[bin];
  return moving > 0 ? (binM / 1000) / (moving / 3600) : null;
}

function smooth(values, radius) {
  return values.map((_, index) => median(values.slice(Math.max(0, index - radius), index + radius + 1)));
}

// Counts per value, as the route keeps them: { value-step index: rides }.
function addCount(hist, value, step) {
  const key = Math.round(value / step);
  hist[key] = (hist[key] || 0) + 1;
}

function histMedian(hist, step, minCount = 1) {
  const keys = Object.keys(hist || {}).map(Number).sort((a, b) => a - b);
  const total = keys.reduce((sum, key) => sum + hist[key], 0);
  if (!total || total < minCount) return null;
  // The middle value, or the mean of the two middle ones.
  const at = (rank) => {
    let seen = 0;
    for (const key of keys) {
      seen += hist[key];
      if (seen > rank) return key * step;
    }
    return keys[keys.length - 1] * step;
  };
  return total % 2 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2;
}

const histTotal = (hist) => Object.values(hist || {}).reduce((sum, count) => sum + count, 0);

// The sections of about 2 km the route's speed by direction is told in, as bins of the axis.
function sectionBins(bins) {
  const lengthKm = (bins * SKELETON.binM) / 1000;
  const count = Math.max(4, Math.round(lengthKm / SKELETON.sectionKm));
  return Array.from({ length: count }, (_, index) => [Math.floor((index * bins) / count), Math.floor(((index + 1) * bins) / count)]);
}

// What one ride adds to its route: per bin whether it rode there on the road, its speed and heart
// rate there, whether it slowed down there, its altitude; per section its moving speed.
function layContribution(lay) {
  const { bins, binM } = lay;
  const onRoad = (bin) => lay.time[bin] > 0 && !lay.off[bin];
  const speed = Array.from({ length: bins }, (_, bin) => (onRoad(bin) ? binSpeedKmh(lay, bin, binM) : null));
  const window = SKELETON.dipWindowBins;
  // This ride slowed down here: its slowest speed within 100 m is a good deal below its fastest
  // in the 500 m before.
  const dip = Array.from({ length: bins }, (_, bin) => {
    if (!onRoad(bin)) return false;
    const from = Math.max(0, bin - window);
    const here = Math.min(...Array.from({ length: 5 }, (_, offset) => binSpeedKmh(lay, Math.max(0, Math.min(bins - 1, bin - 2 + offset)), binM) ?? Infinity));
    const earlier = Math.max(...Array.from({ length: bin - from }, (_, offset) => binSpeedKmh(lay, from + offset, binM) ?? 0), 0);
    return earlier > 0 && here <= earlier * (1 - SKELETON.rideDipPct / 100);
  });
  const hr = Array.from({ length: bins }, (_, bin) => (onRoad(bin) && lay.hrTime[bin] > 0 ? lay.hrSum[bin] / lay.hrTime[bin] : null));
  const altitude = Array.from({ length: bins }, (_, bin) => (onRoad(bin) && lay.altCount[bin] > 0 ? lay.altSum[bin] / lay.altCount[bin] : null));
  const sections = sectionBins(bins).map(([from, to]) => {
    let ridden = 0;
    let metres = 0;
    let moving = 0;
    for (let bin = from; bin < to; bin += 1) {
      if (!onRoad(bin)) continue;
      ridden += 1;
      metres += lay.metres ? lay.metres[bin] : binM;
      moving += lay.time[bin] - lay.stopped[bin];
    }
    return ridden >= (to - from) * SKELETON.minSectionShare && moving >= 30 ? metres / 1000 / (moving / 3600) : null;
  });
  const via = Array.from({ length: bins }, (_, bin) => (lay.via && lay.via[bin] >= 0 ? lay.via[bin] : null));
  return { speed, dip, hr, altitude, sections, via, present: Array.from({ length: bins }, (_, bin) => onRoad(bin)) };
}

// spans: the route's variants in this direction as bins of the axis they stand for. A variant's
// rides are kept apart on its span (via), and `option` says which way the latest ride through the
// span took: the variant, or the axis' own road.
function emptyDirection(bins, spans = []) {
  return { rides: 0, speed: Array.from({ length: bins }, () => ({})), hr: Array.from({ length: bins }, () => ({})),
    present: new Array(bins).fill(0), dips: new Array(bins).fill(0), sections: sectionBins(bins).map(() => ({})),
    spans, via: Object.fromEntries(spans.map((span) => [span.id, { speed: {}, hr: {}, present: {} }])), option: {} };
}

function variantSpans(variants, binM, bins) {
  return (variants || []).map((variant) => ({ id: variant.id,
    fromBin: Math.max(0, Math.floor(Math.min(variant.fromS, variant.toS) / binM)), toBin: Math.min(bins, Math.ceil(Math.max(variant.fromS, variant.toS) / binM)) }));
}

// Everything a route keeps about its rides, per bin of its axis: added to ride by ride, never read
// back from the records. The elevation is one for both directions, on the axis' own direction, and
// is the axis' own road's. variants: { same, reversed, key } of the route's accepted variants.
function createRouteAccumulator(axis, { offRoadM = 0, variants = null } = {}) {
  const bins = axisBins(axis);
  if (bins < 10) return null;
  const binM = SKELETON.binM;
  return { version: SKELETON.version, axisKey: axisKey(axis), offRoadM: offRoadM > 0 ? offRoadM : 0, variantsKey: variants?.key || '', binM, bins,
    members: {}, altitude: { rides: 0, hist: Array.from({ length: bins }, () => ({})) },
    same: emptyDirection(bins, variantSpans(variants?.same, binM, bins)), reversed: emptyDirection(bins, variantSpans(variants?.reversed, binM, bins)) };
}

// The elevation consensus so far, per bin of the axis.
function accumulatedAltitude(acc, minCount = 1) {
  return acc.altitude.hist.map((hist) => histMedian(hist, SKELETON.altitudeStepM, minCount));
}

// Adds one ride, laid on the axis in its own direction (relation 'same' or 'reversed').
function addRideToAccumulator(acc, { activityId, relation, lay }) {
  const direction = acc?.[relation];
  if (!direction || !lay || lay.bins !== acc.bins) return false;
  const ride = layContribution(lay);
  const { bins } = acc;
  for (let bin = 0; bin < bins; bin += 1) {
    if (!ride.present[bin]) continue;
    const variant = ride.via[bin] == null ? null : direction.via[ride.via[bin]];
    if (variant) {
      // Ridden on a variant: its own values, apart from the axis' road.
      variant.present[bin] = (variant.present[bin] || 0) + 1;
      if (ride.speed[bin] != null) addCount(variant.speed[bin] ??= {}, ride.speed[bin], SKELETON.speedStepKmh);
      if (ride.hr[bin] != null) addCount(variant.hr[bin] ??= {}, ride.hr[bin], SKELETON.hrStepBpm);
      ride.altitude[bin] = null;
      continue;
    }
    direction.present[bin] += 1;
    if (ride.dip[bin]) direction.dips[bin] += 1;
    if (ride.speed[bin] != null) addCount(direction.speed[bin], ride.speed[bin], SKELETON.speedStepKmh);
    if (ride.hr[bin] != null) addCount(direction.hr[bin], ride.hr[bin], SKELETON.hrStepBpm);
  }
  // Which way this ride took through each variant's span: the latest decides what the route card
  // shows there.
  for (const span of direction.spans || []) {
    let onVariant = 0;
    let onRoad = 0;
    for (let bin = span.fromBin; bin < span.toBin; bin += 1) {
      if (ride.via[bin] === span.id) onVariant += 1;
      else if (ride.present[bin] && ride.via[bin] == null) onRoad += 1;
    }
    if (onVariant) direction.option[span.id] = 'variant';
    else if (onRoad >= (span.toBin - span.fromBin) / 2) direction.option[span.id] = 'road';
  }
  ride.sections.forEach((kmh, index) => { if (kmh != null) addCount(direction.sections[index], kmh, SKELETON.sectionStepKmh); });
  direction.rides += 1;
  // Every barometer has its own offset: the ride's is the median difference from the consensus
  // so far (the first ride sets the level), and the ride goes in without it.
  const canonical = (bin) => (relation === 'reversed' ? bins - 1 - bin : bin);
  const consensus = accumulatedAltitude(acc);
  const diffs = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const own = ride.altitude[bin];
    const usual = consensus[canonical(bin)];
    if (own != null && usual != null) diffs.push(own - usual);
  }
  const offset = acc.altitude.rides && diffs.length ? median(diffs) : 0;
  let anyAltitude = false;
  for (let bin = 0; bin < bins; bin += 1) {
    if (ride.altitude[bin] == null) continue;
    addCount(acc.altitude.hist[canonical(bin)], ride.altitude[bin] - offset, SKELETON.altitudeStepM);
    anyAltitude = true;
  }
  if (anyAltitude) acc.altitude.rides += 1;
  if (activityId != null) acc.members[activityId] = relation;
  return true;
}

// The skeleton of a route in one direction from what its rides have added. previous: the stored
// skeleton, whose points and boundaries stay unless clearly gone. Null when there are too few rides.
function skeletonFromAccumulator(acc, relation, options = {}, previous = null) {
  const settings = { ...SECTION_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value != null)) };
  const direction = acc?.[relation];
  if (!direction || direction.rides < Math.max(2, settings.minRides)) return null;
  const { bins, binM } = acc;
  const kept = previous?.version === SKELETON.version && previous.axisKey === acc.axisKey && previous.bins === bins;

  // Median speed along the road over the rides that were on it there.
  const speed = smooth(direction.speed.map((hist) => histMedian(hist, SKELETON.speedStepKmh)), 1);
  const hrAt = direction.hr.map((hist) => histMedian(hist, SKELETON.hrStepBpm));
  // Where the latest rides take a variant, the route as it is ridden now is the variant: its rides'
  // speed and heart rate stand for the usual there, and the axis' slow-downs there are not the route's.
  const usualSpeed = [...speed];
  const usualHr = [...hrAt];
  const inUse = (direction.spans || []).filter((span) => direction.option?.[span.id] === 'variant' && direction.via?.[span.id]);
  for (const span of inUse) {
    const variant = direction.via[span.id];
    for (let bin = span.fromBin; bin < span.toBin; bin += 1) {
      usualSpeed[bin] = histMedian(variant.speed[bin], SKELETON.speedStepKmh);
      usualHr[bin] = histMedian(variant.hr[bin], SKELETON.hrStepBpm);
    }
  }
  const replaced = (bin) => inUse.some((span) => bin >= span.fromBin && bin < span.toBin);
  const canonicalAltitude = accumulatedAltitude(acc);
  const altitude = smooth(relation === 'reversed' ? [...canonicalAltitude].reverse() : canonicalAltitude, 2);

  // Terrain: where the road turns from flat to climb or descent and holds it for 300 m.
  const span = SKELETON.gradeSpanBins;
  const label = Array.from({ length: bins }, (_, bin) => {
    const a = altitude[Math.max(0, bin - span / 2)];
    const b = altitude[Math.min(bins - 1, bin + span / 2)];
    if (a == null || b == null) return 'flat';
    const grade = (100 * (b - a)) / (span * binM);
    return grade >= SKELETON.gradeThresholdPct ? 'climb' : grade <= -SKELETON.gradeThresholdPct ? 'descent' : 'flat';
  });

  // Points: minima of the median speed that most rides share.
  // A boundary appears when it is clearly there and goes when it is clearly gone: a stored point
  // or terrain change is judged by half the thresholds a new one has to meet. Every ride's
  // segments are cut at these boundaries, so they must not come and go with each new ride.
  const window = SKELETON.dipWindowBins;
  const storedPoints = kept ? (previous.points || []).map((point) => point.bin) : [];
  const storedCuts = kept ? previous.stretches.slice(1).map((stretch) => stretch.fromBin) : [];
  const dipAt = (bin, ease) => {
    if (speed[bin] == null || label[bin] === 'climb') return null;
    const from = Math.max(0, bin - window);
    const to = Math.min(bins - 1, bin + window);
    const before = Math.max(...speed.slice(from, bin).filter((value) => value != null), 0);
    const after = Math.max(...speed.slice(bin + 1, to + 1).filter((value) => value != null), 0);
    if (!(before > 0) || (100 * (before - speed[bin])) / before < SKELETON.dipDropPct * ease) return null;
    if ((100 * (after - speed[bin])) / speed[bin] < SKELETON.dipRisePct * ease) return null;
    if (!direction.present[bin]) return null;
    return { sharePct: (100 * direction.dips[bin]) / direction.present[bin], typicalMinKmh: speed[bin] };
  };
  const candidates = [];
  for (const stored of storedPoints) {
    // Any bin within 100 m of the stored point may stand for it, the slowest first.
    const near = [];
    for (let bin = Math.max(1, stored - SKELETON.stickyBins); bin <= Math.min(bins - 2, stored + SKELETON.stickyBins); bin += 1) {
      if (speed[bin] != null) near.push(bin);
    }
    near.sort((x, y) => speed[x] - speed[y]);
    let dip = null;
    for (const bin of near) { dip = dipAt(bin, 0.5); if (dip) break; }
    if (dip) candidates.push({ bin: stored, stored: true, ...dip });
  }
  for (let bin = 1; bin < bins - 1; bin += 1) {
    if (speed[bin] == null || storedPoints.some((stored) => Math.abs(stored - bin) <= SKELETON.stickyBins)) continue;
    const from = Math.max(0, bin - window);
    const to = Math.min(bins - 1, bin + window);
    if (speed.slice(from, to + 1).some((value) => value != null && value < speed[bin])) continue;
    // Slowing on a climb has a cause - the gradient - and is part of the stretch, not a point.
    const dip = dipAt(bin, 1);
    if (dip) candidates.push({ bin, stored: false, ...dip });
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) if (replaced(candidates[index].bin)) candidates.splice(index, 1);
  candidates.sort((x, y) => x.bin - y.bin);
  const shares = [settings.minSharePct];
  if (settings.autoAdjust) for (let share = settings.minSharePct - 10; share >= settings.minSharePctFloor; share -= 10) shares.push(share);
  let sharePct = settings.minSharePct;
  let points = [];
  for (const share of shares) {
    sharePct = share;
    points = [];
    const holds = (item) => item.sharePct >= (item.stored ? share - SKELETON.keepPointSharePct : share);
    for (const candidate of candidates.filter(holds)) {
      const last = points[points.length - 1];
      if (last && candidate.bin - last.bin < SKELETON.minStretchBins) {
        // Two slow-downs within 300 m are one place; the one the route already had stays.
        if (!last.stored && (candidate.stored || candidate.typicalMinKmh < last.typicalMinKmh)) points[points.length - 1] = candidate;
      } else points.push(candidate);
    }
    if (points.length) break;
  }

  // Terrain changes that hold for 300 m.
  const terrainEdges = [];
  let runStart = 0;
  let confirmed = null;
  for (let bin = 1; bin <= bins; bin += 1) {
    if (bin < bins && label[bin] === label[runStart]) continue;
    if (bin - runStart >= SKELETON.minStretchBins && label[runStart] !== confirmed) {
      if (confirmed != null) terrainEdges.push(runStart);
      confirmed = label[runStart];
    }
    runStart = bin;
  }
  // A stored terrain boundary stays while the grade still differs across it by half the threshold.
  const gradeOver = (from, to) => {
    const a = altitude[Math.max(0, from)];
    const b = altitude[Math.min(bins - 1, to)];
    return a == null || b == null || to <= from ? null : (100 * (b - a)) / ((Math.min(bins - 1, to) - Math.max(0, from)) * binM);
  };
  const settle = (bin) => storedCuts.find((stored) => Math.abs(stored - bin) <= SKELETON.stickyBins) ?? bin;
  const edges = points.map((point) => point.bin);
  const apart = (bin) => [0, bins, ...edges].every((other) => Math.abs(other - bin) >= SKELETON.minStretchBins);
  for (const stored of storedCuts.filter((cut) => !storedPoints.includes(cut))) {
    const before = gradeOver(stored - SKELETON.minStretchBins, stored);
    const after = gradeOver(stored, stored + SKELETON.minStretchBins);
    if (before != null && after != null && Math.abs(after - before) >= SKELETON.gradeThresholdPct / 2 && apart(stored)) edges.push(stored);
  }
  // Stretch boundaries: every point, and a terrain change that is not next to a point or an end.
  for (const edge of terrainEdges) {
    const settled = settle(edge);
    if (apart(settled)) edges.push(settled);
  }
  edges.sort((x, y) => x - y);
  const cuts = [0, ...edges.filter((edge) => edge >= SKELETON.minStretchBins && bins - edge >= SKELETON.minStretchBins), bins];
  const stretches = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const fromBin = cuts[index];
    const toBin = cuts[index + 1];
    const heights = altitude.slice(fromBin, toBin).filter((value) => value != null);
    let gainM = 0;
    let lossM = 0;
    let anchor = heights[0];
    for (const height of heights) {
      if (height - anchor >= 2) { gainM += height - anchor; anchor = height; }
      else if (anchor - height >= 2) { lossM += anchor - height; anchor = height; }
    }
    const lengthM = (toBin - fromBin) * binM;
    const gradePct = heights.length >= 2 ? (100 * (heights[heights.length - 1] - heights[0])) / lengthM : 0;
    const typical = median(speed.slice(fromBin, toBin));
    // A stretch whose grade sits at the threshold keeps the type it had.
    const stored = kept ? previous.stretches.find((stretch) => stretch.fromBin === fromBin && stretch.toBin === toBin) : null;
    const nearThreshold = Math.abs(Math.abs(gradePct) - SKELETON.gradeThresholdPct) <= 0.5;
    const type = stored && nearThreshold ? stored.type
      : gradePct >= SKELETON.gradeThresholdPct ? 'climb' : gradePct <= -SKELETON.gradeThresholdPct ? 'descent' : 'flat';
    // What the route's rides do on the stretch: the usual time through each bin added up, and the
    // usual heart rate over that time. The yardstick for telling an unusual ride from an ordinary
    // one without asking which rides came before it.
    let usualS = 0;
    let usualKm = 0;
    let hrSum = 0;
    let hrS = 0;
    for (let bin = fromBin; bin < toBin; bin += 1) {
      if (!(usualSpeed[bin] > 0)) continue;
      const seconds = (binM / 1000 / usualSpeed[bin]) * 3600;
      usualS += seconds;
      usualKm += binM / 1000;
      if (usualHr[bin] != null) { hrSum += usualHr[bin] * seconds; hrS += seconds; }
    }
    stretches.push({
      fromBin, toBin, fromKm: (fromBin * binM) / 1000, toKm: (toBin * binM) / 1000,
      type,
      gradePct: Math.round(gradePct * 10) / 10, gainM: Math.round(gainM), lossM: Math.round(lossM),
      typicalKmh: typical == null ? null : Math.round(typical * 10) / 10,
      endsAtPoint: points.some((point) => point.bin === toBin),
      routeKmh: usualS > 0 && usualKm >= ((toBin - fromBin) * binM) / 2000 ? Math.round((usualKm / (usualS / 3600)) * 10) / 10 : null,
      routeHr: hrS > 0 && hrS >= usualS * 0.5 ? Math.round(hrSum / hrS) : null,
    });
  }
  return {
    version: SKELETON.version, binM, bins, axisKey: acc.axisKey, toleranceM: acc.offRoadM > 0 ? acc.offRoadM : AXIS.offRoadM, sharePct, rides: direction.rides,
    // What a ride's segments depend on: the road, where it is cut, and the terrain of each piece.
    frameKey: `${SKELETON.version}|${bins}|${acc.axisKey}|${stretches.map((stretch) => `${stretch.fromBin}${stretch.type[0]}`).join(',')}`,
    lengthKm: (bins * binM) / 1000,
    points: points.map((point) => ({ bin: point.bin, km: (point.bin * binM) / 1000, typicalMinKmh: Math.round(point.typicalMinKmh * 10) / 10, sharePct: Math.round(point.sharePct) })),
    stretches,
  };
}

// The elevation consensus of a route from its accumulator, on the axis' own direction: per bin the
// median of the offset-aligned rides that rode there, with ascent and descent.
function profileFromAccumulator(acc) {
  if (!acc || acc.altitude.rides < SKELETON.minProfileRides) return null;
  const consensus = accumulatedAltitude(acc, SKELETON.minProfileBinRides);
  if (consensus.filter((value) => value != null).length < acc.bins * 0.5) return null;
  const { ascentM, descentM } = ascentDescent(consensus.map((value) => value ?? NaN));
  return {
    binM: acc.binM, lengthKm: (acc.bins * acc.binM) / 1000, rides: acc.altitude.rides,
    consensus: consensus.map((value) => (value == null ? null : Math.round(value * 10) / 10)),
    ascentM: Math.round(ascentM), descentM: Math.round(descentM),
  };
}

// The route's usual moving speed per section in each direction, sections in that direction's
// own order: [{ kmh, rides }].
function sectionStatsFromAccumulator(acc) {
  if (!acc) return null;
  const of = (direction) => direction.sections.map((hist) => ({ kmh: histMedian(hist, SKELETON.sectionStepKmh), rides: histTotal(hist) }));
  return { same: of(acc.same), reversed: of(acc.reversed) };
}

// The skeleton of a route from its rides (oldest first), all ridden in the axis' direction: the
// whole accumulation at once, for a route not stored anywhere. Without an axis the middle line of
// the first three rides is taken, as a habitual route has.
function buildRouteSkeleton(rides, options = {}, previous = null, axis = null) {
  const settings = { ...SECTION_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value != null)) };
  const usable = (rides || []).filter((ride) => cleanRecords(ride?.records).length >= 20);
  if (usable.length < Math.max(2, settings.minRides)) return null;
  const road = axis || medianAxis(usable.slice(0, 3).map((ride) => cleanRecords(ride.records))) || buildRouteAxis(cleanRecords(usable[0].records));
  const acc = road ? createRouteAccumulator(road, { offRoadM: settings.toleranceM }) : null;
  if (!acc) return null;
  for (const ride of usable) addRideToAccumulator(acc, { relation: 'same', lay: layRideOnBins(ride.records, road, { offRoadM: settings.toleranceM }) });
  const skeleton = skeletonFromAccumulator(acc, 'same', options, previous);
  // Kept beside the skeleton, not stored with it: measuring a ride needs the road it is laid on.
  if (skeleton) Object.defineProperty(skeleton, 'axis', { value: road, enumerable: false });
  return skeleton;
}

// One ride on the skeleton, laid on the route's axis in the skeleton's direction. Returns
// { stretches, points } or null when the ride cannot be laid on the road at all. A stretch ridden
// partly elsewhere carries `detour: true`; one the ride did not reach carries `absent: true`.
function measureRideOnSkeleton(records, skeleton, { stops = null, axis = skeleton?.axis, lay = null } = {}) {
  if (!skeleton?.stretches?.length) return null;
  const laid = lay || (axis ? layRideOnBins(records, axis, { stops, offRoadM: skeleton.toleranceM }) : null);
  if (!laid || laid.bins !== skeleton.bins) return null;
  const measured = measureLay(laid, skeleton, Number(cleanRecords(records)[0].elapsed_time));
  return { ...measured, character: rideCharacter(measured, skeleton) };
}

function measureLay(lay, skeleton, startS) {
  const binM = skeleton.binM;
  let offRouteBefore = false;
  const stretches = skeleton.stretches.map((stretch, index) => {
    let time = 0;
    let stopped = 0;
    let hrSum = 0;
    let hrTime = 0;
    let offBins = 0;
    let covered = 0;
    let metres = 0;
    const via = new Set();
    for (let bin = stretch.fromBin; bin < stretch.toBin; bin += 1) {
      time += lay.time[bin];
      stopped += lay.stopped[bin];
      hrSum += lay.hrSum[bin];
      hrTime += lay.hrTime[bin];
      metres += lay.metres ? lay.metres[bin] : binM;
      if (lay.off[bin]) offBins += 1;
      if (lay.time[bin] > 0) covered += 1;
      if (lay.via && lay.via[bin] >= 0) via.add(lay.via[bin]);
    }
    const bins = stretch.toBin - stretch.fromBin;
    // Not ridden (the ride started later or ended earlier) is absent, not a detour.
    if (covered < bins * 0.9) { offRouteBefore = true; return { index, absent: true }; }
    const detour = offBins * binM >= SKELETON.detourM;
    const movingS = Math.max(1, time - stopped);
    // On a variant the ride rode its road, not the axis' 50 m per bin.
    const lengthKm = metres / 1000;
    let reachedS = null;
    for (let bin = stretch.toBin - 1; bin >= stretch.fromBin && reachedS == null; bin -= 1) {
      if (!Number.isNaN(lay.reachedS[bin])) reachedS = lay.reachedS[bin] - startS;
    }
    let enteredS = null;
    for (let bin = stretch.fromBin; bin < stretch.toBin && enteredS == null; bin += 1) {
      if (!Number.isNaN(lay.reachedS[bin])) enteredS = lay.reachedS[bin];
    }
    const row = {
      index, detour, lengthKm, movingS, stoppedS: stopped, via: [...via].sort((a, b) => a - b).join(','),
      // Elapsed times of the ride's own clock, to find its segments that fall inside the stretch.
      startElapsed: enteredS, endElapsed: reachedS == null ? null : reachedS + startS,
      speedKmh: lengthKm / (movingS / 3600),
      avgHr: hrTime > 0 && (100 * hrTime) / movingS >= VERDICT.minHrCoveragePct ? hrSum / hrTime : null,
      // Time since the start is comparable only while the ride has stayed on the route's road.
      reachedS: offRouteBefore || detour ? null : reachedS,
    };
    if (detour) offRouteBefore = true;
    return row;
  });
  const points = skeleton.points.map((point, index) => {
    const from = Math.max(0, point.bin - SKELETON.pointWindowBins);
    const to = Math.min(lay.time.length - 1, point.bin + SKELETON.pointWindowBins);
    let time = 0;
    let stopped = 0;
    let minKmh = Number.POSITIVE_INFINITY;
    let off = false;
    for (let bin = from; bin <= to; bin += 1) {
      time += lay.time[bin];
      stopped += lay.stopped[bin];
      if (lay.minKmh[bin] < minKmh) minKmh = lay.minKmh[bin];
      // A point is the axis' own road's: a ride through it on a variant did not pass it.
      if (lay.off[bin] || !(lay.time[bin] > 0) || (lay.via && lay.via[bin] >= 0)) off = true;
    }
    return off ? { index, absent: true } : { index, passS: time, stoppedS: stopped, minKmh: Number.isFinite(minKmh) ? minKmh : null };
  });
  return { stretches, points };
}

// The stops of a ride, each with what it gave as rest: records below walking speed in a row, or a
// gap of the recording with no ground covered (an auto-pause). drop: how far the heart rate fell,
// from the last moving record before the stop to the lowest within it and the 10 s after; weight:
// that fall against a full rest (fullRestHrDrop), 0 to 1. A stop without heart rate weighs what a
// stop of its length does on this ride's stops that have it, or grows to full over 50 s.
function stopRests(records, { fullRestHrDrop = SKELETON.fullRestHrDropBpm } = {}) {
  const list = Array.isArray(records) ? records : [];
  const time = (index) => Number(list[index]?.elapsed_time);
  const hr = (index) => (list[index]?.heart_rate == null ? NaN : Number(list[index].heart_rate));
  const stops = [];
  let start = null;
  const close = (endIndex) => {
    const startElapsed = start === 0 ? time(0) : time(start - 1);
    const endElapsed = time(endIndex);
    const durationS = endElapsed - startElapsed;
    if (durationS > 0) stops.push({ startIndex: start, endIndex, startElapsed, endElapsed, durationS });
    start = null;
  };
  for (let index = 0; index < list.length; index += 1) {
    const speed = list[index]?.speed == null ? null : Number(list[index].speed);
    const dt = index ? time(index) - time(index - 1) : 0;
    const paused = dt > 30 && Number(list[index].distance) - Number(list[index - 1].distance) < 0.03;
    if (paused) {
      if (start != null) close(index - 1);
      start = index;
      close(index);
      continue;
    }
    const stopped = speed != null && Number.isFinite(speed) && speed < SKELETON.stoppedKmh;
    if (stopped && start == null) start = index;
    else if (!stopped && start != null) close(index - 1);
  }
  if (start != null) close(list.length - 1);
  for (const stop of stops) {
    let before = NaN;
    for (let index = stop.startIndex - 1; index >= 0 && !(before > 0); index -= 1) before = hr(index);
    let lowest = Infinity;
    for (let index = stop.startIndex; index < list.length && time(index) <= stop.endElapsed + 10; index += 1) {
      if (hr(index) > 0 && hr(index) < lowest) lowest = hr(index);
    }
    stop.drop = before > 0 && Number.isFinite(lowest) ? Math.max(0, Math.round(before - lowest)) : null;
  }
  // This rider's fall per second of stop, from the stops of this ride that have heart rate.
  const rates = stops.filter((stop) => stop.drop != null && stop.durationS >= 5 && stop.durationS <= 120).map((stop) => stop.drop / stop.durationS);
  const rate = rates.length >= 3 ? median(rates) : null;
  for (const stop of stops) {
    const fall = stop.drop ?? (rate != null ? rate * stop.durationS : null);
    stop.weight = Math.round(100 * (fall != null ? Math.min(1, fall / fullRestHrDrop) : Math.min(1, Math.max(0, stop.durationS / SKELETON.restFullAfterS)))) / 100;
  }
  return stops;
}

// Checkpoints of a ride on its route: a mark every 2 km of the route's axis and one at its end, the
// same places for every ride of the route. Each mark carries the road since the previous mark: its
// time on the clock and moving, the time stopped, heart rate. `ridden` is false when the ride did
// not ride all of that road on the route (a detour, a start further on, an end short of it): rides
// are compared on the stretches both of them rode.
// records (the ones laid) give the stops: their number, the rest they gave (seconds weighted by
// stopRests) and the largest fall of heart rate at one of them, per stretch between marks.
function routeCheckpoints(lay, axis, { spacingKm = 2, records = null, fullRestHrDrop } = {}) {
  if (!lay || !axis) return [];
  const { bins, binM } = lay;
  const stops = Array.isArray(records) && lay.axisKm ? stopRests(records, { fullRestHrDrop })
    .map((stop) => ({ ...stop, km: lay.axisKm[stop.startIndex] ?? lay.axisKm[Math.max(0, stop.startIndex - 1)] }))
    .filter((stop) => stop.km != null) : [];
  const lengthKm = (bins * binM) / 1000;
  const marks = [];
  for (let km = spacingKm; km < lengthKm - spacingKm / 2; km += spacingKm) marks.push(km);
  marks.push(lengthKm);
  const round1 = (value) => Math.round(value * 10) / 10;
  let fromBin = 0;
  let fromKm = 0;
  let hrSoFar = 0;
  let hrSecondsSoFar = 0;
  return marks.map((km) => {
    const toBin = Math.min(bins, Math.max(fromBin + 1, Math.round((km * 1000) / binM)));
    let time = 0;
    let stopped = 0;
    let hrSum = 0;
    let hrTime = 0;
    let covered = 0;
    let offBins = 0;
    let metres = 0;
    const via = new Set();
    for (let bin = fromBin; bin < toBin; bin += 1) {
      time += lay.time[bin];
      stopped += lay.stopped[bin];
      hrSum += lay.hrSum[bin];
      hrTime += lay.hrTime[bin];
      metres += lay.metres ? lay.metres[bin] : binM;
      if (lay.time[bin] > 0) covered += 1;
      if (lay.off[bin]) offBins += 1;
      if (lay.via && lay.via[bin] >= 0) via.add(lay.via[bin]);
    }
    const ridden = covered >= (toBin - fromBin) * 0.9 && offBins * binM < SKELETON.detourM;
    const movingS = Math.max(0, time - stopped);
    const hr = hrTime > 0 && hrTime >= movingS * (VERDICT.minHrCoveragePct / 100) ? hrSum / hrTime : null;
    if (ridden && hr != null) { hrSoFar += hr * movingS; hrSecondsSoFar += movingS; }
    const reached = lay.reachedS[toBin - 1];
    const place = axisLatLon(axis, km * 1000);
    const here = stops.filter((stop) => stop.km * 1000 >= fromBin * binM && stop.km * 1000 < toBin * binM);
    const rest = {
      stops: here.length,
      restS: Math.round(here.reduce((sum, stop) => sum + stop.durationS * stop.weight, 0)),
      stopDropBpm: here.some((stop) => stop.drop != null) ? Math.max(...here.map((stop) => stop.drop ?? 0)) : null,
    };
    const mark = {
      km: round1(km), axis: true, fromKm: round1(fromKm), lat: place.lat, lon: place.lon, ridden, via: [...via].sort((a, b) => a - b).join(','),
      splitS: ridden ? Math.round(time) : null, movingS: ridden ? Math.round(movingS) : null, stoppedS: ridden ? Math.round(stopped) : null,
      ...(ridden ? rest : { stops: null, restS: null, stopDropBpm: null }),
      avgHr: ridden && hr != null ? Math.round(hr) : null,
      cumulativeAvgHr: hrSecondsSoFar > 0 ? Math.round(hrSoFar / hrSecondsSoFar) : null,
      avgSpeedKmh: ridden && movingS > 0 ? (metres / 1000) / (movingS / 3600) : null,
      elapsedS: Number.isFinite(reached) ? Math.round(reached - lay.startS) : null,
    };
    fromBin = toBin;
    fromKm = km;
    return mark;
  });
}

// Where one ride enters each stretch of the skeleton, on its own clock: the boundaries its
// segments are cut at, so that every segment lies inside one stretch and takes its terrain from
// the road instead of from its own average grade. Stretches the ride did not reach are left out.
function rideFrame(records, skeleton, { axis = skeleton?.axis, lay: given = null } = {}) {
  if (!skeleton?.stretches?.length) return null;
  const lay = given || (axis ? layRideOnBins(records, axis, { offRoadM: skeleton.toleranceM }) : null);
  if (!lay || lay.bins !== skeleton.bins) return null;
  const cuts = [];
  skeleton.stretches.forEach((stretch, stretchIndex) => {
    for (let bin = stretch.fromBin; bin < stretch.toBin; bin += 1) {
      if (Number.isNaN(lay.reachedS[bin])) continue;
      cuts.push({ startElapsed: lay.reachedS[bin], stretchIndex, type: stretch.type, gradePct: stretch.gradePct,
        fromKm: stretch.fromKm, toKm: stretch.toKm });
      break;
    }
  });
  return cuts.length ? { frameKey: skeleton.frameKey, cuts } : null;
}

// A ride that is slower than the route's rides nearly everywhere, at a clearly lower heart rate,
// was not ridden as the others were: a ride with company, a recovery spin, a child to wait for.
// It is described as such, and it is left out of the usual values of later rides, so one easy
// outing does not make the next ordinary ride look fast. Descents do not count: speed there is
// not effort. Returns null for an ordinary ride.
const CHARACTER = Object.freeze({ slowerPct: 12, lowerHrBpm: 8, shareOfRoad: 0.6, minStretches: 3 });

function rideCharacter(measured, skeleton) {
  let comparedKm = 0;
  let easyKm = 0;
  const speedDeltas = [];
  const hrDeltas = [];
  measured.stretches.forEach((row, index) => {
    const stretch = skeleton.stretches[index];
    // On a variant the usual values may be the axis' road's: not this road's.
    if (!row || row.absent || row.detour || row.via || stretch.type === 'descent') return;
    if (!(stretch.routeKmh > 0) || stretch.routeHr == null || row.avgHr == null) return;
    const speedPct = 100 * (row.speedKmh / stretch.routeKmh - 1);
    const hrDelta = row.avgHr - stretch.routeHr;
    comparedKm += row.lengthKm;
    speedDeltas.push(speedPct);
    hrDeltas.push(hrDelta);
    if (speedPct <= -CHARACTER.slowerPct && hrDelta <= -CHARACTER.lowerHrBpm) easyKm += row.lengthKm;
  });
  if (speedDeltas.length < CHARACTER.minStretches || !(comparedKm > 0) || easyKm / comparedKm < CHARACTER.shareOfRoad) return null;
  return { kind: 'easy', speedPct: Math.round(median(speedDeltas)), hrDelta: Math.round(median(hrDeltas)), sharePct: Math.round((100 * easyKm) / comparedKm) };
}

// How this ride differs from the usual one on a stretch. The wording depends on the road:
// a steep descent is not an effort, so only a clear difference in speed is reported there.
function stretchVerdict(current, usual, type) {
  if (!usual || !(usual.speedKmh > 0) || !(current.speedKmh > 0)) return null;
  const speedPct = 100 * (current.speedKmh / usual.speedKmh - 1);
  if (type === 'descent') {
    return Math.abs(speedPct) < VERDICT.descentSpeedPct ? 'as usual'
      : `${speedPct > 0 ? 'faster' : 'slower'} descent (speed here follows the gradient and caution, not effort)`;
  }
  const speedWord = Math.abs(speedPct) < VERDICT.speedPct ? 'similar' : speedPct > 0 ? 'faster' : 'slower';
  const hrDelta = current.avgHr != null && usual.avgHr != null ? current.avgHr - usual.avgHr : null;
  if (hrDelta == null) {
    return speedWord === 'similar' ? 'similar speed; heart rate cannot be compared'
      : `${speedWord}; heart rate cannot be compared, so the effort behind it is unknown`;
  }
  const hrWord = Math.abs(hrDelta) < VERDICT.hrBpm ? 'similar' : hrDelta > 0 ? 'higher' : 'lower';
  if (speedWord === 'similar') {
    return hrWord === 'similar' ? 'as usual' : `similar speed at ${hrWord} HR (${hrWord === 'higher' ? 'more' : 'less'} internal load for the same speed)`;
  }
  if (speedWord === 'faster') {
    return hrWord === 'higher' ? 'faster at higher HR (more effort)' : hrWord === 'lower' ? 'faster at lower HR' : 'faster at similar HR';
  }
  return hrWord === 'higher' ? 'slower at higher HR (conditions, fatigue or heat; not a fitness statement)'
    : hrWord === 'lower' ? 'slower at lower HR (less effort)' : 'slower at similar HR';
}

// current: this ride on the skeleton; priors: earlier rides on it, oldest first (null when a ride
// could not be laid on the road). The usual value of a stretch is the median of the last
// `recent` rides that rode that stretch on the route's road.
function summarizeSections(skeleton, current, priors, { recent = 5 } = {}) {
  if (!skeleton || !current) return null;
  // An unusually easy earlier ride says nothing about what is usual here.
  const measured = (priors || []).filter((ride) => ride && ride.character?.kind !== 'easy');
  const lastValid = (pick, via = '') => measured.map(pick).filter((row) => row && !row.absent && !row.detour && (row.via || '') === via).slice(-recent);
  const stretches = skeleton.stretches.map((stretch, index) => {
    const row = current.stretches[index];
    // A stretch with a variant on it is compared between the rides that took the same way.
    const rows = lastValid((ride) => ride.stretches[index], row?.via || '');
    const hrRows = rows.filter((prior) => prior.avgHr != null);
    const reached = rows.map((prior) => prior.reachedS).filter((value) => value != null);
    const usual = rows.length ? {
      rides: rows.length,
      speedKmh: median(rows.map((prior) => prior.speedKmh)),
      movingS: median(rows.map((prior) => prior.movingS)),
      avgHr: hrRows.length >= Math.min(3, rows.length) ? median(hrRows.map((prior) => prior.avgHr)) : null,
      reachedS: reached.length >= Math.min(3, rows.length) ? median(reached) : null,
    } : null;
    const base = { ...stretch, ...row, usual };
    if (row.absent || row.detour) return { ...base, verdict: null, timeDeltaS: null };
    return { ...base, timeDeltaS: usual ? Math.round(row.movingS - usual.movingS) : null, verdict: stretchVerdict(row, usual, stretch.type) };
  });
  const points = skeleton.points.map((point, index) => {
    const row = current.points[index];
    const rows = lastValid((ride) => ride.points[index]);
    const usualPassS = rows.length ? median(rows.map((prior) => prior.passS)) : null;
    const lostS = row.absent || usualPassS == null ? null : Math.round(row.passS - usualPassS);
    return { ...point, ...row, usualPassS, lostS, notable: lostS != null && lostS >= VERDICT.lostAtPointS };
  });
  const stoppedS = current.stretches.reduce((sum, row) => sum + (row.stoppedS || 0), 0);
  return { stretches, points, character: current.character || null, stoppedS, excludedEasyRides: (priors || []).filter((ride) => ride?.character?.kind === 'easy').length };
}

module.exports = {
  SECTION_DEFAULTS,
  SKELETON,
  addRideToAccumulator,
  axisBins,
  buildRouteSkeleton,
  createRouteAccumulator,
  layRideOnBins,
  measureRideOnSkeleton,
  profileFromAccumulator,
  rideCharacter,
  rideFrame,
  routeCheckpoints,
  sectionBins,
  stopRests,
  sectionStatsFromAccumulator,
  skeletonFromAccumulator,
  stretchVerdict,
  summarizeSections,
};
