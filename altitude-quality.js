// Consensus elevation for repeated routes and altitude-quality flags. Pure module.
//
// The CYCPLUS barometer settles during the first minutes of a ride: loop rides all end at the
// same true elevation while their recorded start altitudes drift by over a hundred metres. A
// per-route consensus profile (median across offset-aligned rides) turns that into a measurable
// settling diagnostic instead of an invisible ascent error.

const { hasGpsFix, haversineM } = require('./route-match');

const ELEVATION_BIN_M = 25;

const ALT = Object.freeze({
  minConsensusRides: 5,
  minBinRides: 3,
  minRideCoverage: 0.9,        // a ride must span this share of the median ride length
  startRadiusM: 300,           // rides starting further from the median start are not aligned by distance
  hysteresisM: 1,              // consensus ascent ignores wiggles below this
  closedLoopM: 100,
  settlingDeltaM: 15,          // start offset (or start-vs-end difference) that counts as drift
  settledWithinM: 5,
  settlingWindowS: 300,
  settlingShare: 0.6,          // share of the start-vs-end difference that happens in the first minutes
  missingStartSeconds: 30,
  missingStartKm: 0.3,
  gapRecords: 30,
});

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Ride input shape used by this module: altitude in metres (null when the record has none),
// distance in km, elapsed in seconds. Source records carry altitude in kilometres.
function buildAltitudeRide(records) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => Number.isFinite(Number(record?.distance)) && Number.isFinite(Number(record?.elapsed_time)));
  if (list.length < 20) return null;
  const altitudes = list.map((record) => {
    const value = record.altitude == null ? NaN : Number(record.altitude);
    return { distance: Number(record.distance), elapsed: Number(record.elapsed_time), altitude: Number.isFinite(value) ? value * 1000 : null };
  });
  const gps = (record) => hasGpsFix(record?.position_lat, record?.position_long);
  const first = list.find(gps);
  const last = [...list].reverse().find(gps);
  return {
    altitudes,
    distanceKm: altitudes[altitudes.length - 1].distance - altitudes[0].distance,
    start: first ? { lat: Number(first.position_lat), lon: Number(first.position_long) } : null,
    end: last ? { lat: Number(last.position_lat), lon: Number(last.position_long) } : null,
  };
}

// Bins are fractions of each ride's own length, so a wheel-sensor distance scale error (rides of
// the same loop differ by several percent in recorded distance) does not smear the profile.
function binIndex(ride, point, bins) {
  return Math.floor(((point.distance - ride.altitudes[0].distance) / ride.distanceKm) * bins);
}

function binAltitudes(ride, bins) {
  const sums = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);
  for (const point of ride.altitudes) {
    if (!Number.isFinite(point.altitude)) continue;
    const bin = binIndex(ride, point, bins);
    if (bin >= 0 && bin < bins) {
      sums[bin] += point.altitude;
      counts[bin] += 1;
    }
  }
  return sums.map((sum, index) => (counts[index] ? sum / counts[index] : null));
}

function ascentDescent(values, hysteresisM = ALT.hysteresisM) {
  let ascent = 0;
  let descent = 0;
  let anchor = null;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (anchor == null) {
      anchor = value;
      continue;
    }
    const delta = value - anchor;
    if (delta >= hysteresisM) {
      ascent += delta;
      anchor = value;
    } else if (delta <= -hysteresisM) {
      descent -= delta;
      anchor = value;
    }
  }
  return { ascentM: ascent, descentM: descent };
}

// Align each ride's altitude to a shared consensus by removing its own constant offset: the
// consensus is the per-bin median, each offset the median difference to it, iterated three times.
// Rides must share a start point (same loop start) to be comparable by distance.
function computeConsensusProfile(rides, { binM = ELEVATION_BIN_M } = {}) {
  const valid = (Array.isArray(rides) ? rides : []).filter((ride) => ride?.altitudes?.length > 20 && ride.distanceKm > 1);
  if (valid.length < ALT.minConsensusRides) return null;

  const referenceLengthKm = median(valid.map((ride) => ride.distanceKm));
  const starts = valid.filter((ride) => ride.start);
  const centre = starts.length ? { lat: median(starts.map((ride) => ride.start.lat)), lon: median(starts.map((ride) => ride.start.lon)) } : null;
  const usable = valid.filter((ride) => ride.distanceKm >= referenceLengthKm * ALT.minRideCoverage
    && (!centre || !ride.start || haversineM(ride.start.lat, ride.start.lon, centre.lat, centre.lon) <= ALT.startRadiusM));
  if (usable.length < ALT.minConsensusRides) return null;

  const lengthKm = median(usable.map((ride) => ride.distanceKm));
  const bins = Math.max(2, Math.round((lengthKm * 1000) / binM));
  const rows = usable.map((ride) => binAltitudes(ride, bins));
  const offsets = rows.map(() => 0);
  let consensus = null;
  for (let pass = 0; pass < 3; pass += 1) {
    consensus = new Array(bins).fill(null);
    for (let bin = 0; bin < bins; bin += 1) {
      const values = rows.map((row, index) => (Number.isFinite(row[bin]) ? row[bin] + offsets[index] : null)).filter(Number.isFinite);
      if (values.length >= ALT.minBinRides) consensus[bin] = median(values);
    }
    rows.forEach((row, index) => {
      const diffs = [];
      for (let bin = 0; bin < bins; bin += 1) {
        if (Number.isFinite(row[bin]) && Number.isFinite(consensus[bin])) diffs.push(consensus[bin] - row[bin]);
      }
      if (diffs.length > bins / 2) offsets[index] = median(diffs);
    });
  }
  if (consensus.filter(Number.isFinite).length < bins * 0.5) return null;
  const { ascentM, descentM } = ascentDescent(consensus);
  return {
    binM: (lengthKm * 1000) / bins,
    lengthKm,
    rides: usable.length,
    consensus: consensus.map((value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
  };
}


// Settling diagnostics for one ride against the consensus: the ride's constant offset comes from
// its settled second half; the start is flagged when the first minutes deviate from that offset
// and converge afterwards.
function detectAltitudeSettling(ride, profile) {
  if (!ride?.altitudes?.length || !profile?.consensus) return null;
  const { consensus } = profile;
  const deviations = [];
  for (const point of ride.altitudes) {
    if (!Number.isFinite(point.altitude)) continue;
    const bin = binIndex(ride, point, consensus.length);
    if (bin >= 0 && bin < consensus.length && Number.isFinite(consensus[bin])) {
      deviations.push({ elapsed: point.elapsed - ride.altitudes[0].elapsed, delta: point.altitude - consensus[bin] });
    }
  }
  if (deviations.length < 60) return null;
  const lastElapsed = deviations[deviations.length - 1].elapsed;
  const settledOffset = median(deviations.filter((d) => d.elapsed >= lastElapsed / 2).map((d) => d.delta));
  const windowDelta = (fromS, toS) => median(deviations.filter((d) => d.elapsed >= fromS && d.elapsed < toS).map((d) => d.delta - settledOffset));
  const startDelta = windowDelta(0, 60) ?? windowDelta(0, ALT.settlingWindowS);
  const earlyDelta = windowDelta(0, ALT.settlingWindowS);
  if (startDelta == null || earlyDelta == null) return null;
  const worst = Math.abs(startDelta) >= Math.abs(earlyDelta) ? startDelta : earlyDelta;
  if (Math.abs(worst) <= ALT.settlingDeltaM) return null;

  // Settled after the last 30 s window (within the first 20 minutes) that still deviates.
  let settleS = 0;
  for (let from = 0; from < Math.min(lastElapsed, 1200); from += 30) {
    const window = windowDelta(from, from + 30);
    if (window != null && Math.abs(window) > ALT.settledWithinM) settleS = from + 30;
  }
  const delta = Math.round(worst);
  return {
    startDeltaM: delta,
    settleSeconds: settleS,
    detail: `recorded altitude starts ${Math.abs(delta)} m ${delta < 0 ? 'below' : 'above'} the route consensus level${settleS >= 1200 ? ' and keeps deviating through the first 20 min' : settleS > 0 ? ` and converges after about ${Math.max(1, Math.round(settleS / 60))} min` : ''}; early ascent/descent and the first segment's grade are unreliable`,
  };
}

// A reversed ride mirrored onto the route's canonical axis for consensus building: distances flip
// (d' = L - d). Point order and elapsed stay as recorded; only the distance axis is flipped, and
// the result is re-sorted by distance so binning works.
function mirrorAltitudeRide(ride) {
  if (!ride?.altitudes?.length) return null;
  const first = ride.altitudes[0].distance;
  const total = ride.distanceKm;
  const altitudes = ride.altitudes
    .map((point) => ({ ...point, distance: first + (total - (point.distance - first)) }))
    .sort((a, b) => a.distance - b.distance);
  // The ride now starts where it ended: the consensus keeps rides by their start point.
  return { ...ride, altitudes, start: ride.end ?? null, end: ride.start ?? null };
}

// Mirrors a canonical-axis elevation consensus onto the reversed direction: bin i becomes
// bin n-1-i, so a reversed ride can be compared directly in its own distance order.
function mirrorConsensusProfile(profile) {
  if (!profile?.consensus?.length) return null;
  return { ...profile, consensus: [...profile.consensus].reverse() };
}

// Whole-ride altitude flags from the recorded series alone (no consensus needed).
function computeAltitudeFlags(ride) {
  const flags = [];
  const points = ride?.altitudes;
  if (!points?.length) return flags;

  const firstValid = points.findIndex((point) => Number.isFinite(point.altitude));
  if (firstValid < 0) {
    flags.push({ code: 'ALT_MISSING_START', detail: 'no altitude samples in this ride; ascent, descent and grade are unavailable' });
    return flags;
  }
  const missingS = points[firstValid].elapsed - points[0].elapsed;
  const missingKm = points[firstValid].distance - points[0].distance;
  if (missingS >= ALT.missingStartSeconds || missingKm >= ALT.missingStartKm) {
    flags.push({ code: 'ALT_MISSING_START', detail: `no altitude for the first ${Math.round(missingS)} s (${missingKm.toFixed(2)} km); the start's ascent/descent is unknown, not zero` });
  }

  const interiorGaps = points.slice(firstValid).filter((point) => !Number.isFinite(point.altitude)).length;
  if (interiorGaps >= ALT.gapRecords) {
    flags.push({ code: 'ALT_GAP', detail: `${interiorGaps} records without altitude after the first valid sample` });
  }

  // Closed loop whose start altitude differs from the end while most of that difference happens
  // in the first minutes: barometer/GPS settling even without a route consensus.
  if (ride.start && ride.end && haversineM(ride.start.lat, ride.start.lon, ride.end.lat, ride.end.lon) <= ALT.closedLoopM) {
    const valid = points.filter((point) => Number.isFinite(point.altitude));
    const t0 = valid[0].elapsed;
    const tEnd = valid[valid.length - 1].elapsed;
    if (tEnd - t0 > ALT.settlingWindowS * 2) {
      const startAlt = median(valid.filter((point) => point.elapsed - t0 <= 30).map((point) => point.altitude));
      const earlyAlt = median(valid.filter((point) => Math.abs(point.elapsed - t0 - ALT.settlingWindowS) <= 30).map((point) => point.altitude));
      const endAlt = median(valid.filter((point) => tEnd - point.elapsed <= 30).map((point) => point.altitude));
      const net = endAlt - startAlt;
      const early = earlyAlt - startAlt;
      if (Math.abs(net) > ALT.settlingDeltaM && Math.sign(early) === Math.sign(net) && Math.abs(early) >= ALT.settlingShare * Math.abs(net)) {
        flags.push({ code: 'ALT_SETTLING', detail: `closed loop but the recorded altitude changes ${Math.round(net)} m start to finish, ${Math.round(early)} m of it within the first ${ALT.settlingWindowS / 60} min; early ascent/descent and the first segment's grade are unreliable` });
      }
    }
  }
  return flags;
}

module.exports = {
  ALT,
  ELEVATION_BIN_M,
  ascentDescent,
  buildAltitudeRide,
  computeAltitudeFlags,
  computeConsensusProfile,
  detectAltitudeSettling,
  mirrorAltitudeRide,
  mirrorConsensusProfile,
};
