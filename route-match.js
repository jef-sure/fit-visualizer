// Route identity from GPS geometry: a signature of 32 points at fixed distance fractions,
// compared ride-to-ride with tolerance. Pure module: no DB, no vscode.
//
// Why: 33 of 39 rides in the development history are the same loop, yet the prompt says
// "route identity not established" because structural segment matching cannot see geometry.

const SIGNATURE_POINTS = 32;
const TRACK_SAMPLE_POINTS = 160;

const MATCH = Object.freeze({
  sameMeanM: 60,
  partialMaxMeanM: 80,
  partialWithinM: 100,
  partialMinCoveragePct: 50,
  // Below this, a "partial" match carries too little shared road to matter (test rides, GPS glitches).
  partialMinKm: 5,
});

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Signature over GPS-tracked records: a fraction grid for storage/medoid use, plus a
// uniformly downsampled track for nearest-point comparison (loop-start tolerant).
function buildRouteSignature(records, { points = SIGNATURE_POINTS, trackPoints = TRACK_SAMPLE_POINTS } = {}) {
  const tracked = (Array.isArray(records) ? records : [])
    .filter((record) => Number.isFinite(Number(record?.position_lat)) && Number.isFinite(Number(record?.position_long))
      && Number.isFinite(Number(record?.distance)))
    .map((record) => ({
      lat: Number(record.position_lat),
      lon: Number(record.position_long),
      distance: Number(record.distance),
    }));
  if (tracked.length < 10) return null;
  const total = tracked[tracked.length - 1].distance - tracked[0].distance;
  if (!(total > 0.5)) return null;

  const signature = [];
  for (let index = 0; index < points; index += 1) {
    const target = tracked[0].distance + (total * (index + 0.5)) / points;
    // Linear interpolation between neighbours keeps sub-record precision on 1 Hz data.
    let low = 0;
    while (low + 1 < tracked.length && tracked[low + 1].distance < target) low += 1;
    const high = Math.min(low + 1, tracked.length - 1);
    const span = tracked[high].distance - tracked[low].distance;
    const t = span > 0 ? (target - tracked[low].distance) / span : 0;
    signature.push({
      lat: tracked[low].lat + (tracked[high].lat - tracked[low].lat) * t,
      lon: tracked[low].lon + (tracked[high].lon - tracked[low].lon) * t,
    });
  }
  const step = Math.max(1, Math.floor(tracked.length / trackPoints));
  const track = tracked.filter((_, index) => index % step === 0 || index === tracked.length - 1)
    .map(({ lat, lon, distance }) => ({ lat, lon, distance }));
  return {
    points: signature,
    track,
    distanceKm: total,
    start: { lat: tracked[0].lat, lon: tracked[0].lon },
    end: { lat: tracked[tracked.length - 1].lat, lon: tracked[tracked.length - 1].lon },
  };
}

// Compare two signatures. Returns null when GPS geometry cannot support a decision.
function compareRouteSignatures(a, b, { reversed = false } = {}) {
  if (!a || !b || a.points.length !== b.points.length) return null;
  const deviations = a.points.map((point, index) => {
    const other = b.points[reversed ? b.points.length - 1 - index : index];
    return haversineM(point.lat, point.lon, other.lat, other.lon);
  });
  const sorted = [...deviations].sort((x, y) => x - y);
  const mean = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  return { meanM: mean, p90M: p90 };
}

// Full decision: same / reversed / partial / different, with the supporting numbers.
// The core metric is symmetric mean nearest-point distance between downsampled GPS tracks:
// it tolerates different start points on a loop (a distance-fraction grid does not) and
// small distance-scale differences between wheel sensors.
function matchRoutes(a, b) {
  if (!a || !b) return { type: 'different', detail: 'insufficient GPS' };
  const distRatio = Math.min(a.distanceKm, b.distanceKm) / Math.max(a.distanceKm, b.distanceKm);
  if (distRatio >= 0.9) {
    const forward = meanNearestDistanceM(a.track, b.track);
    const backward = meanNearestDistanceM(a.track, [...b.track].reverse());
    const forwardReverseRef = meanNearestDistanceM([...a.track].reverse(), b.track);
    // Symmetric: min over direction readings, comparing both traversal orders.
    const sameScore = Math.max(forward, forwardReverseRef);
    const reversedScore = backward;
    if (sameScore < MATCH.sameMeanM && reversedScore >= sameScore) {
      return { type: 'same', detail: `mean nearest-point deviation ${Math.round(sameScore)} m`, distRatio };
    }
    if (reversedScore < MATCH.sameMeanM) {
      return { type: 'reversed', detail: `mean nearest-point deviation ${Math.round(reversedScore)} m (opposite direction)`, distRatio };
    }
    return { type: 'different', detail: `mean deviation ${Math.round(Math.min(sameScore, reversedScore))} m exceeds ${MATCH.sameMeanM} m`, distRatio };
  }

  // A much shorter ride can still cover a stretch of a longer one (a turnaround, a puncture,
  // a different start point on a loop). The SHORTER track must be covered by the LONGER one;
  // the reverse (a subset route, like a long loop containing the short one) is its own route.
  const shorter = a.distanceKm < b.distanceKm ? a : b;
  const longer = shorter === a ? b : a;
  const coverage = trackCoverage(shorter.track, longer.track, MATCH.partialWithinM);
  if (coverage.coveragePct >= MATCH.partialMinCoveragePct && coverage.coveredMeanM < MATCH.partialMaxMeanM
    && shorter.distanceKm >= MATCH.partialMinKm) {
    return {
      type: 'partial',
      detail: `${Math.round(coverage.coveragePct)}% of this track follows the longer route, covered part mean deviation ${Math.round(coverage.coveredMeanM)} m`,
      distRatio,
    };
  }
  return { type: 'different', detail: `covered ${Math.round(coverage.coveragePct)}% (mean ${Math.round(coverage.coveredMeanM)} m within ${MATCH.partialWithinM} m)`, distRatio };
}

// Share of trackA points within maxM of trackB, and the mean deviation of those points.
function trackCoverage(trackA, trackB, maxM) {
  if (!trackA?.length || !trackB?.length) return { coveragePct: 0, coveredMeanM: Number.POSITIVE_INFINITY };
  const devs = trackA.map((point) => {
    let best = Number.POSITIVE_INFINITY;
    for (const other of trackB) {
      const d = haversineM(point.lat, point.lon, other.lat, other.lon);
      if (d < best) best = d;
    }
    return best;
  });
  const covered = devs.filter((d) => d < maxM);
  return {
    coveragePct: (100 * covered.length) / devs.length,
    coveredMeanM: covered.length ? covered.reduce((sum, value) => sum + value, 0) / covered.length : Number.POSITIVE_INFINITY,
  };
}

// Symmetric mean of nearest-point distances between two downsampled tracks.
function meanNearestDistanceM(trackA, trackB) {
  if (!trackA?.length || !trackB?.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const point of trackA) {
    let best = Number.POSITIVE_INFINITY;
    for (const other of trackB) {
      const d = haversineM(point.lat, point.lon, other.lat, other.lon);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / trackA.length;
}

module.exports = {
  MATCH,
  SIGNATURE_POINTS,
  buildRouteSignature,
  compareRouteSignatures,
  haversineM,
  matchRoutes,
};
