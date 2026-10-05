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

const { haversineM, hasGpsFix } = require('./route-match');

const SECTION_DEFAULTS = Object.freeze({
  minSharePct: 90,        // a slow-down is a point of the route when this share of rides has it
  minSharePctFloor: 70,   // auto-adjust never goes below this
  toleranceM: 0,          // how far from the reference road a ride may be; 0 = 60 m
  minRides: 5,            // fewer rides agree by coincidence too often
  autoAdjust: true,       // relax the share step by step when no slow-down reaches it
});

const SKELETON = Object.freeze({
  version: 5,
  binM: 50,               // resolution along the road
  roadToleranceM: 60,     // GPS noise plus the width of a road with a cycle path beside it
  backBins: 6,            // a ride may be matched this far behind its last position (GPS jitter)
  aheadBins: 40,          // ... and this far ahead (a gap, a short cut); never onto another leg
  dipDropPct: 20,         // slow-down: the median speed falls this far below the speed before it
  dipRisePct: 10,         // ... and picks up again by at least this much afterwards
  dipWindowBins: 10,      // "before" and "after" are looked for within 500 m
  rideDipPct: 15,         // one ride has the slow-down when its own speed falls this far
  minStretchBins: 6,      // 300 m: shorter than that is the point's own braking and pulling away
  gradeThresholdPct: 2.5,
  gradeSpanBins: 4,       // grade over 200 m
  keepRoadShare: 0.95,    // recent rides on the stored road: keep it instead of picking a new one
  keepPointSharePct: 15,  // a stored point is kept down to this far below the required share
  stickyBins: 2,          // a boundary within 100 m of the stored one stays where it was
  detourM: 150,           // this much of a stretch on another road and the ride is not compared
  pointWindowBins: 2,     // a point is timed over 250 m around it
  stoppedKmh: 3,
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

// The road as one ride rode it: a point every `binM` metres along its GPS track. The length is
// measured on the map, not taken from the device: a wheel sensor that reads a few percent long
// would otherwise move every kilometre mark of the route.
function referenceTrack(records, binM = SKELETON.binM) {
  const tracked = cleanRecords(records).filter((record) => hasGpsFix(record.position_lat, record.position_long));
  if (tracked.length < 20) return null;
  const along = [0];
  for (let index = 1; index < tracked.length; index += 1) {
    const step = haversineM(Number(tracked[index - 1].position_lat), Number(tracked[index - 1].position_long),
      Number(tracked[index].position_lat), Number(tracked[index].position_long));
    // A jump of GPS while standing still is not road.
    along.push(along[index - 1] + (step < 1 ? 0 : step));
  }
  const bins = Math.floor(along[along.length - 1] / binM);
  if (bins < 10) return null;
  const points = [];
  let cursor = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const target = (bin + 0.5) * binM;
    while (cursor + 1 < tracked.length && along[cursor + 1] < target) cursor += 1;
    const a = tracked[cursor];
    const b = tracked[Math.min(cursor + 1, tracked.length - 1)];
    const span = along[Math.min(cursor + 1, tracked.length - 1)] - along[cursor];
    const t = span > 0 ? Math.max(0, Math.min(1, (target - along[cursor]) / span)) : 0;
    points.push({
      lat: Number(a.position_lat) + (Number(b.position_lat) - Number(a.position_lat)) * t,
      lon: Number(a.position_long) + (Number(b.position_long) - Number(a.position_long)) * t,
    });
  }
  return points;
}

// One ride laid onto the reference road: per bin, the time spent there, how much of it stopped,
// heart rate, altitude and the lowest speed. A record is matched to the nearest reference point
// in a window around the ride's last position, so two legs of a loop that share a road are never
// confused. Time ridden away from the road is kept, attached to the bins it bypasses, and those
// bins are flagged: the ride's time there is real, but it was not ridden on this road.
function layRideOnRoad(records, ref, { toleranceM = SKELETON.roadToleranceM, stops = null } = {}) {
  const list = cleanRecords(records);
  const bins = ref?.length || 0;
  if (list.length < 10 || bins < 10) return null;
  const make = () => new Float64Array(bins);
  const lay = { time: make(), stopped: make(), hrSum: make(), hrTime: make(), altSum: make(), altCount: make(), speedSum: make(), speedCount: make(),
    minKmh: new Float64Array(bins).fill(Number.POSITIVE_INFINITY), off: new Uint8Array(bins), reachedS: new Float64Array(bins).fill(NaN), matched: 0 };
  const tolerance = toleranceM > 0 ? toleranceM : SKELETON.roadToleranceM;
  const nearest = (record, from, to) => {
    let best = null;
    for (let bin = Math.max(0, from); bin <= Math.min(bins - 1, to); bin += 1) {
      const distance = haversineM(Number(record.position_lat), Number(record.position_long), ref[bin].lat, ref[bin].lon);
      if (!best || distance < best.distance) best = { bin, distance };
    }
    return best && best.distance <= tolerance ? best.bin : null;
  };

  // With the ride's own stop segments at hand they decide what counts as stopped, so the page
  // and the route table agree; without them (building the skeleton) the speed does.
  const stopList = Array.isArray(stops)
    ? stops.filter((stop) => Number.isFinite(stop?.startElapsed) && Number.isFinite(stop?.endElapsed)) : null;
  const inStop = (time) => stopList.some((stop) => time > stop.startElapsed && time <= stop.endElapsed);
  let cursor = null;
  let previousTime = null;
  let previousKm = null;
  let pending = 0;        // seconds since the last matched record that had no match
  let pendingStopped = 0;
  let pendingOff = false; // some of that time was ridden with GPS, away from the road
  for (const record of list) {
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
    const hasFix = hasGpsFix(record.position_lat, record.position_long);
    // The start may lie anywhere on a loop; after that the ride only moves along the road.
    const bin = !hasFix ? null : cursor == null
      ? (nearest(record, 0, Math.floor(bins * 0.15)) ?? nearest(record, 0, bins - 1))
      : nearest(record, cursor - SKELETON.backBins, cursor + SKELETON.aheadBins);
    if (bin == null) {
      if (cursor != null) {
        pending += step;
        if (isStopped) pendingStopped += step;
        if (hasFix) pendingOff = true;
      }
      continue;
    }
    lay.matched += 1;
    const span = cursor == null || bin <= cursor ? [bin] : Array.from({ length: bin - cursor }, (_, index) => cursor + 1 + index);
    // Time since the last match belongs to the bins passed since then, in equal parts.
    const share = (pending + step) / span.length;
    const stoppedShare = (pendingStopped + (isStopped ? step : 0)) / span.length;
    for (const index of span) {
      lay.time[index] += share;
      lay.stopped[index] += stoppedShare;
      if (pendingOff) lay.off[index] = 1;
      if (Number.isNaN(lay.reachedS[index])) lay.reachedS[index] = time;
    }
    const hr = record.heart_rate == null ? NaN : Number(record.heart_rate);
    if (hr > 0 && step > 0) { lay.hrSum[bin] += hr * step; lay.hrTime[bin] += step; }
    const altitude = record.altitude == null ? NaN : Number(record.altitude);
    if (Number.isFinite(altitude)) { lay.altSum[bin] += altitude; lay.altCount[bin] += 1; }
    if (kmh != null && Number.isFinite(kmh) && kmh < lay.minKmh[bin]) lay.minKmh[bin] = kmh;
    if (kmh != null && Number.isFinite(kmh) && !isStopped) { lay.speedSum[bin] += kmh; lay.speedCount[bin] += 1; }
    cursor = Math.max(cursor ?? bin, bin);
    pending = 0;
    pendingStopped = 0;
    pendingOff = false;
  }
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

// The skeleton of a route from its rides (oldest first; the last ones define the current road).
// rides: [{ records }] with elapsed_time, distance, speed (km/h), heart_rate, altitude (m),
// position_lat, position_long. Returns null when there are too few rides.
function buildRouteSkeleton(rides, options = {}, previous = null) {
  const settings = { ...SECTION_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value != null)) };
  const usable = (rides || []).filter((ride) => cleanRecords(ride?.records).length >= 20);
  if (usable.length < Math.max(2, settings.minRides)) return null;
  const toleranceM = settings.toleranceM > 0 ? settings.toleranceM : SKELETON.roadToleranceM;
  const binM = SKELETON.binM;

  // The reference is a recent ride, not the first: a route is found over several tries and the
  // first one is the least typical. Among the last five, the one the others follow most closely.
  const recent = usable.slice(-5);
  const followed = (track) => recent.reduce((sum, ride) => {
    const lay = layRideOnRoad(ride.records, track, { toleranceM });
    return sum + (lay ? lay.time.filter((seconds, bin) => seconds > 0 && !lay.off[bin]).length / track.length : 0);
  }, 0) / recent.length;
  // The road is kept while recent rides still follow it: every ride's segments are cut at the
  // skeleton's boundaries, and a new reference each time a ride is added would move them all.
  // ... but not when the route itself has moved: if most recent rides leave the stored road
  // somewhere for 150 m or more, they are the route now and the stored road is the old variant.
  const strayed = (track) => recent.filter((ride) => {
    const lay = layRideOnRoad(ride.records, track, { toleranceM });
    if (!lay) return true;
    let run = 0;
    for (let bin = 0; bin < track.length; bin += 1) {
      run = lay.off[bin] ? run + 1 : 0;
      if (run * binM >= SKELETON.detourM) return true;
    }
    return false;
  }).length;
  const kept = previous?.version === SKELETON.version && previous.binM === binM && Array.isArray(previous.ref)
    && previous.ref.length >= 10 && followed(previous.ref) >= SKELETON.keepRoadShare
    && strayed(previous.ref) * 2 < recent.length;
  let ref = kept ? previous.ref : null;
  let bestScore = -1;
  for (const candidate of kept ? [] : recent) {
    const track = referenceTrack(candidate.records, binM);
    if (!track) continue;
    const score = recent.reduce((sum, other) => {
      if (other === candidate) return sum;
      const lay = layRideOnRoad(other.records, track, { toleranceM });
      return sum + (lay ? lay.time.filter((seconds, bin) => seconds > 0 && !lay.off[bin]).length / track.length : 0);
    }, 0);
    if (score > bestScore) { bestScore = score; ref = track; }
  }
  if (!ref) return null;
  const bins = ref.length;
  const lays = usable.map((ride) => layRideOnRoad(ride.records, ref, { toleranceM })).filter(Boolean);
  if (lays.length < Math.max(2, settings.minRides)) return null;

  // Median speed along the road over the rides that were on it there.
  const onRoad = (lay, bin) => lay.time[bin] > 0 && !lay.off[bin];
  const speed = smooth(Array.from({ length: bins }, (_, bin) =>
    median(lays.filter((lay) => onRoad(lay, bin)).map((lay) => binSpeedKmh(lay, bin, binM)))), 1);

  // Altitude: every ride's barometer has its own offset, removed against the running consensus.
  const altitudeOf = (lay, bin) => (lay.altCount[bin] > 0 ? lay.altSum[bin] / lay.altCount[bin] : null);
  const offsets = lays.map(() => 0);
  let altitude = new Array(bins).fill(null);
  for (let pass = 0; pass < 3; pass += 1) {
    altitude = Array.from({ length: bins }, (_, bin) =>
      median(lays.map((lay, index) => { const value = altitudeOf(lay, bin); return value == null || !onRoad(lay, bin) ? null : value - offsets[index]; })));
    lays.forEach((lay, index) => {
      const delta = median(Array.from({ length: bins }, (_, bin) => {
        const value = altitudeOf(lay, bin);
        return value == null || altitude[bin] == null ? null : value - altitude[bin];
      }));
      if (delta != null) offsets[index] = delta;
    });
  }
  altitude = smooth(altitude, 2);

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
    const present = lays.filter((lay) => onRoad(lay, bin));
    if (!present.length) return null;
    const having = present.filter((lay) => {
      const here = Math.min(...Array.from({ length: 5 }, (_, offset) => binSpeedKmh(lay, Math.max(0, Math.min(bins - 1, bin - 2 + offset)), binM) ?? Infinity));
      const earlier = Math.max(...Array.from({ length: bin - from }, (_, offset) => binSpeedKmh(lay, from + offset, binM) ?? 0), 0);
      return earlier > 0 && here <= earlier * (1 - SKELETON.rideDipPct / 100);
    });
    return { sharePct: (100 * having.length) / present.length, typicalMinKmh: speed[bin] };
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
    stretches.push({
      fromBin, toBin, fromKm: (fromBin * binM) / 1000, toKm: (toBin * binM) / 1000,
      type,
      gradePct: Math.round(gradePct * 10) / 10, gainM: Math.round(gainM), lossM: Math.round(lossM),
      typicalKmh: typical == null ? null : Math.round(typical * 10) / 10,
      endsAtPoint: points.some((point) => point.bin === toBin),
    });
  }
  // What the route's rides do on each stretch, taken over all of them: the yardstick for telling
  // an unusual ride from an ordinary one without asking which rides came before it.
  const draft = { binM, stretches, points: [] };
  const all = lays.map((lay) => measureLay(lay, draft, 0).stretches);
  stretches.forEach((stretch, index) => {
    const rows = all.map((ride) => ride[index]).filter((row) => row && !row.absent && !row.detour);
    const speed = median(rows.map((row) => row.speedKmh));
    const hr = median(rows.map((row) => row.avgHr));
    stretch.routeKmh = speed == null ? null : Math.round(speed * 10) / 10;
    stretch.routeHr = hr == null ? null : Math.round(hr);
  });
  return {
    version: SKELETON.version, binM, toleranceM, sharePct, rides: lays.length,
    // What a ride's segments depend on: the road, where it is cut, and the terrain of each piece.
    frameKey: `${SKELETON.version}|${bins}|${ref[0].lat.toFixed(3)},${ref[0].lon.toFixed(3)}|${stretches.map((stretch) => `${stretch.fromBin}${stretch.type[0]}`).join(',')}`,
    lengthKm: (bins * binM) / 1000,
    ref: ref.map((point) => ({ lat: Math.round(point.lat * 1e6) / 1e6, lon: Math.round(point.lon * 1e6) / 1e6 })),
    points: points.map((point) => ({ bin: point.bin, km: (point.bin * binM) / 1000, typicalMinKmh: Math.round(point.typicalMinKmh * 10) / 10, sharePct: Math.round(point.sharePct) })),
    stretches,
  };
}

// One ride on the skeleton. Returns { stretches, points } or null when the ride cannot be laid
// on the road at all. A stretch ridden partly elsewhere carries `detour: true`; one the ride did
// not reach carries `absent: true`.
function measureRideOnSkeleton(records, skeleton, { stops = null } = {}) {
  if (!skeleton?.ref?.length) return null;
  const lay = layRideOnRoad(records, skeleton.ref, { toleranceM: skeleton.toleranceM, stops });
  if (!lay) return null;
  const measured = measureLay(lay, skeleton, Number(cleanRecords(records)[0].elapsed_time));
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
    for (let bin = stretch.fromBin; bin < stretch.toBin; bin += 1) {
      time += lay.time[bin];
      stopped += lay.stopped[bin];
      hrSum += lay.hrSum[bin];
      hrTime += lay.hrTime[bin];
      if (lay.off[bin]) offBins += 1;
      if (lay.time[bin] > 0) covered += 1;
    }
    const bins = stretch.toBin - stretch.fromBin;
    // Not ridden (the ride started later or ended earlier) is absent, not a detour.
    if (covered < bins * 0.9) { offRouteBefore = true; return { index, absent: true }; }
    const detour = offBins * binM >= SKELETON.detourM;
    const movingS = Math.max(1, time - stopped);
    const lengthKm = (bins * binM) / 1000;
    let reachedS = null;
    for (let bin = stretch.toBin - 1; bin >= stretch.fromBin && reachedS == null; bin -= 1) {
      if (!Number.isNaN(lay.reachedS[bin])) reachedS = lay.reachedS[bin] - startS;
    }
    let enteredS = null;
    for (let bin = stretch.fromBin; bin < stretch.toBin && enteredS == null; bin += 1) {
      if (!Number.isNaN(lay.reachedS[bin])) enteredS = lay.reachedS[bin];
    }
    const row = {
      index, detour, lengthKm, movingS, stoppedS: stopped,
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
      if (lay.off[bin] || !(lay.time[bin] > 0)) off = true;
    }
    return off ? { index, absent: true } : { index, passS: time, stoppedS: stopped, minKmh: Number.isFinite(minKmh) ? minKmh : null };
  });
  return { stretches, points };
}

// Where one ride enters each stretch of the skeleton, on its own clock: the boundaries its
// segments are cut at, so that every segment lies inside one stretch and takes its terrain from
// the road instead of from its own average grade. Stretches the ride did not reach are left out.
function rideFrame(records, skeleton) {
  if (!skeleton?.ref?.length) return null;
  const lay = layRideOnRoad(records, skeleton.ref, { toleranceM: skeleton.toleranceM });
  if (!lay) return null;
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
    if (!row || row.absent || row.detour || stretch.type === 'descent') return;
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
  const lastValid = (pick) => measured.map(pick).filter((row) => row && !row.absent && !row.detour).slice(-recent);
  const stretches = skeleton.stretches.map((stretch, index) => {
    const row = current.stretches[index];
    const rows = lastValid((ride) => ride.stretches[index]);
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
  buildRouteSkeleton,
  layRideOnRoad,
  measureRideOnSkeleton,
  rideCharacter,
  referenceTrack,
  rideFrame,
  stretchVerdict,
  summarizeSections,
};
