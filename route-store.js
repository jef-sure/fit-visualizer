// Route storage and per-route checkpoints on top of route-match.js. No vscode, testable.
//
// Assignment policy: a ride joins an existing route on same/reversed/partial (its relation is
// recorded per ride). The canonical signature is the member with the least total deviation to
// all others (a medoid, recomputed lazily).

const { buildRouteSignature, matchRoutes } = require('./route-match');

const CHECKPOINT_SPACING_KM = 2;

// Assign (or create) a route for one ride against existing canonical signatures.
// Returns { routeId, relation, routeName, rideCount }.
function assignRoute(db, { activityId, signature, createdAt }) {
  if (!signature) return { routeId: null, relation: null };
  const routes = readRoutes(db);
  for (const route of routes) {
    const canonical = parseCanonical(route.canonical_signature);
    if (!canonical) continue;
    const match = matchRoutes(signature, canonical);
    if (['same', 'reversed', 'partial'].includes(match.type)) {
      db.run('UPDATE activity_features SET route_id = ?, route_relation = ? WHERE activity_id = ?',
        [route.id, `${match.type} (${match.detail})`, activityId]);
      db.run('UPDATE routes SET ride_count = ride_count + 1, last_seen = MAX(COALESCE(last_seen, ?), ?) WHERE id = ?',
        [createdAt, createdAt, route.id]);
      return { routeId: route.id, relation: match.type, routeName: route.name, rideCount: route.ride_count + 1 };
    }
  }
  const name = `Route ${Math.round(signature.distanceKm * 10) / 10} km`;
  db.run('INSERT INTO routes (name, canonical_signature, ride_count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)',
    [name, JSON.stringify(signature), createdAt, createdAt]);
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  db.run('UPDATE activity_features SET route_id = ?, route_relation = ? WHERE activity_id = ?',
    [id, 'same (defines the route)', activityId]);
  return { routeId: id, relation: 'same', routeName: name, rideCount: 1 };
}

function readRoutes(db) {
  const stmt = db.prepare('SELECT id, name, canonical_signature, ride_count, first_seen, last_seen FROM routes ORDER BY id');
  try {
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function parseCanonical(json) {
  try {
    const parsed = JSON.parse(json);
    return parsed?.points && parsed?.track ? parsed : null;
  } catch {
    return null;
  }
}

// Checkpoint rows for one ride: cumulative time, average HR and speed to each mark.
// Records carry elapsed_time, distance, heart_rate; speed comes from deltas.
function computeCheckpoints(records, { spacingKm = CHECKPOINT_SPACING_KM } = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => Number.isFinite(Number(record?.distance)) && Number.isFinite(Number(record?.elapsed_time)));
  if (list.length < 10) return [];
  const totalKm = list[list.length - 1].distance;
  const marks = [];
  for (let km = spacingKm; km < totalKm; km += spacingKm) marks.push(km);
  if (totalKm - (marks.at(-1) || 0) >= spacingKm / 2) marks.push(totalKm);

  const result = [];
  let prevTime = list[0].elapsed_time;
  let prevDistance = list[0].distance;
  let markIndex = 0;
  let hrSum = 0;
  let hrCount = 0;
  let spanTime = 0;
  let spanDistance = 0;
  for (let index = 1; index < list.length && markIndex < marks.length; index += 1) {
    const record = list[index];
    const dt = record.elapsed_time - prevTime;
    const dd = record.distance - prevDistance;
    if (dt > 0 && dd >= 0) {
      spanTime += dt;
      spanDistance += dd;
      const hr = Number(record.heart_rate);
      if (Number.isFinite(hr) && hr > 0) {
        hrSum += hr * dt;
        hrCount += dt;
      }
    }
    while (markIndex < marks.length && record.distance >= marks[markIndex]) {
      result.push({
        km: Math.round(marks[markIndex] * 10) / 10,
        elapsedS: Math.round(record.elapsed_time),
        avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
        avgSpeedKmh: spanTime > 0 && spanDistance > 0 ? (spanDistance / (spanTime / 3600)) : null,
      });
      spanTime = 0;
      spanDistance = 0;
      hrSum = 0;
      hrCount = 0;
      markIndex += 1;
    }
    prevTime = record.elapsed_time;
    prevDistance = record.distance;
  }
  return result;
}

// Median statistics of past same-route rides per checkpoint mark.
function summarizeCheckpoints(current, priorRides) {
  return current.map((mark) => {
    const priors = priorRides
      .flatMap((ride) => ride.checkpoints || [])
      .filter((row) => Math.abs(row.km - mark.km) < 0.05)
      .map((row) => row.elapsedS)
      .sort((a, b) => a - b);
    const median = priors.length ? priors[Math.floor(priors.length / 2)] : null;
    return { ...mark, priorMedianS: median, priorRides: priors.length };
  });
}

module.exports = {
  CHECKPOINT_SPACING_KM,
  assignRoute,
  computeCheckpoints,
  readRoutes,
  summarizeCheckpoints,
};
