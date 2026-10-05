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

// Travel-order test: how far along the other track a point may sit from where the ridden
// distance puts it (wheel-sensor scale, detours), how finely the alignment point is searched,
// and by how much the opposite order must fit better before a ride is called reversed.
const DIRECTION = Object.freeze({
  windowFraction: 0.06,
  minWindowKm: 0.5,
  alignmentSteps: 40,
  marginM: 10,
});

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// A usable GPS fix: both coordinates present and not the (0, 0) placeholder some devices write
// before the first lock. Number(null) is 0, so "finite" alone would let empty fixes through.
function hasGpsFix(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return false;
  const latitude = Number(lat);
  const longitude = Number(lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0);
}

// Signature over GPS-tracked records: a fraction grid of the track for storage, plus a uniformly
// downsampled track that the comparison works on.
function buildRouteSignature(records, { points = SIGNATURE_POINTS, trackPoints = TRACK_SAMPLE_POINTS } = {}) {
  const tracked = (Array.isArray(records) ? records : [])
    .filter((record) => hasGpsFix(record?.position_lat, record?.position_long)
      && record?.distance != null && Number.isFinite(Number(record.distance)))
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

// A track as a polyline in local metres with the distance ridden to each vertex (km from the
// first vertex). Signatures stored before 0.29.0 can carry (0, 0) vertices; they are dropped.
function projectTrack(track, refLat) {
  const kx = 111320 * Math.cos((refLat * Math.PI) / 180);
  const usable = (Array.isArray(track) ? track : []).filter((point) => hasGpsFix(point?.lat, point?.lon));
  if (usable.length < 2) return null;
  const firstKm = Number(usable[0].distance);
  const vertices = usable.map((point) => ({ x: point.lon * kx, y: point.lat * 110540, km: Number(point.distance) - firstKm }));
  return { vertices, lengthKm: vertices[vertices.length - 1].km };
}

function pointToSegmentM(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq)) : 0;
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

// Distance from every vertex of A to every segment of B. Vertex-to-vertex distance would add
// about a quarter of B's vertex spacing (~30 m on a 20 km loop) to every reading, which is most
// of the tolerance; vertex-to-segment leaves GPS noise and the real offset between the roads.
function deviationMatrix(a, b) {
  return a.vertices.map((point) => {
    const row = new Float64Array(b.vertices.length - 1);
    for (let index = 0; index + 1 < b.vertices.length; index += 1) {
      row[index] = pointToSegmentM(point, b.vertices[index], b.vertices[index + 1]);
    }
    return row;
  });
}

function rowMinimums(matrix) {
  return matrix.map((row) => {
    let best = Number.POSITIVE_INFINITY;
    for (const value of row) if (value < best) best = value;
    return best;
  });
}

const meanOf = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY);

// How well A follows B in a given travel order. A vertex ridden x km into A is expected x km
// into B (same order) or x km before the alignment point (opposite order); only B's segments
// within a window of that expected place count. The alignment point is searched over B, so a
// loop entered elsewhere still fits, and the place wraps around B's length for the same reason.
// The plain nearest distance cannot tell the orders apart: it is the same for both.
function orderedDeviationM(a, b, matrix, reversed) {
  const length = b.lengthKm;
  if (!(length > 0)) return Number.POSITIVE_INFINITY;
  const windowKm = Math.max(DIRECTION.minWindowKm, length * DIRECTION.windowFraction);
  const middles = [];
  for (let index = 0; index + 1 < b.vertices.length; index += 1) middles.push((b.vertices[index].km + b.vertices[index + 1].km) / 2);
  let best = Number.POSITIVE_INFINITY;
  for (let step = 0; step < DIRECTION.alignmentSteps; step += 1) {
    const offset = (length * step) / DIRECTION.alignmentSteps;
    let sum = 0;
    for (let i = 0; i < a.vertices.length && sum < best * a.vertices.length; i += 1) {
      const expected = reversed ? offset - a.vertices[i].km : offset + a.vertices[i].km;
      const wrapped = ((expected % length) + length) % length;
      const clamped = Math.max(0, Math.min(length, expected));
      let nearest = Number.POSITIVE_INFINITY;
      for (let j = 0; j < middles.length; j += 1) {
        const along = Math.abs(middles[j] - wrapped);
        const gap = Math.min(along, length - along, Math.abs(middles[j] - clamped));
        if (gap <= windowKm && matrix[i][j] < nearest) nearest = matrix[i][j];
      }
      sum += nearest;
    }
    const mean = sum / a.vertices.length;
    if (mean < best) best = mean;
  }
  return best;
}

// Full decision: same / reversed / partial / different, with the supporting numbers.
// Two separate questions. Is it the same road? The mean distance from each track to the other
// one's polyline, taken both ways so a track that merely lies inside a longer one does not pass.
// Which way was it ridden? The ordered deviation above, for both travel orders.
// `scoreM` is the number to rank candidates by (lower is closer); `detail` is for people.
function matchRoutes(a, b) {
  if (!a || !b) return { type: 'different', detail: 'insufficient GPS' };
  const refLat = Number(b.track?.find((point) => hasGpsFix(point?.lat, point?.lon))?.lat);
  const trackA = projectTrack(a.track, refLat);
  const trackB = projectTrack(b.track, refLat);
  if (!trackA || !trackB) return { type: 'different', detail: 'insufficient GPS' };
  const distRatio = Math.min(a.distanceKm, b.distanceKm) / Math.max(a.distanceKm, b.distanceKm);
  const aToB = deviationMatrix(trackA, trackB);
  if (distRatio >= 0.9) {
    const meanM = Math.max(meanOf(rowMinimums(aToB)), meanOf(rowMinimums(deviationMatrix(trackB, trackA))));
    if (!(meanM < MATCH.sameMeanM)) {
      return { type: 'different', detail: `mean deviation ${Math.round(meanM)} m exceeds ${MATCH.sameMeanM} m`, distRatio, scoreM: meanM };
    }
    const sameOrderM = orderedDeviationM(trackA, trackB, aToB, false);
    const oppositeOrderM = orderedDeviationM(trackA, trackB, aToB, true);
    // An out-and-back ridden on one road fits both orders; it stays "same".
    const reversed = oppositeOrderM + DIRECTION.marginM < sameOrderM;
    return {
      type: reversed ? 'reversed' : 'same',
      detail: `mean nearest-point deviation ${Math.round(meanM)} m${reversed ? ' (opposite direction)' : ''}`,
      distRatio, scoreM: meanM, sameOrderM, oppositeOrderM,
    };
  }

  // A much shorter ride can still cover a stretch of a longer one (a turnaround, a puncture,
  // a different start point on a loop). The SHORTER track must be covered by the LONGER one;
  // the reverse (a subset route, like a long loop containing the short one) is its own route.
  const shorterIsA = a.distanceKm < b.distanceKm;
  const deviations = rowMinimums(shorterIsA ? aToB : deviationMatrix(trackB, trackA));
  const covered = deviations.filter((value) => value < MATCH.partialWithinM);
  const coveragePct = (100 * covered.length) / deviations.length;
  const coveredMeanM = meanOf(covered);
  const shorterKm = Math.min(a.distanceKm, b.distanceKm);
  if (coveragePct >= MATCH.partialMinCoveragePct && coveredMeanM < MATCH.partialMaxMeanM && shorterKm >= MATCH.partialMinKm) {
    return {
      type: 'partial',
      detail: `${Math.round(coveragePct)}% of this track follows the longer route, covered part mean deviation ${Math.round(coveredMeanM)} m`,
      distRatio, scoreM: coveredMeanM, coveragePct,
    };
  }
  return { type: 'different', detail: `covered ${Math.round(coveragePct)}% (mean ${Math.round(coveredMeanM)} m within ${MATCH.partialWithinM} m)`, distRatio, scoreM: coveredMeanM, coveragePct };
}

module.exports = {
  DIRECTION,
  MATCH,
  SIGNATURE_POINTS,
  buildRouteSignature,
  compareRouteSignatures,
  hasGpsFix,
  haversineM,
  matchRoutes,
};
