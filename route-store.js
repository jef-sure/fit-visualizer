// Route storage and per-route checkpoints on top of route-match.js. No vscode, testable.
//
// Assignment policy: a ride joins an existing route on same/reversed/partial (its relation is
// recorded per ride). The canonical signature is the member with the least total deviation to
// all others (a medoid, recomputed lazily).

const { buildRouteSignature, matchRoutes } = require('./route-match');
const { buildAltitudeRide, computeConsensusProfile } = require('./altitude-quality');
const { computeRouteFeatures, sectionCount, sectionSpeeds } = require('./route-features');

const CHECKPOINT_SPACING_KM = 2;

// Assign (or create) a route for one ride against existing canonical signatures. Idempotent:
// a ride that already has an assignment keeps it, so repeated context builds do not recount.
// Returns { routeId, relation, routeName, rideCount }.
function assignRoute(db, { activityId, signature, createdAt }) {
  if (!signature) return { routeId: null, relation: null };
  const existing = readAssignment(db, activityId);
  if (existing) return existing;
  const routes = readRoutes(db);
  for (const route of routes) {
    const canonical = parseCanonical(route.canonical_signature);
    if (!canonical) continue;
    const match = matchRoutes(signature, canonical);
    if (['same', 'reversed', 'partial'].includes(match.type)) {
      db.run('INSERT OR REPLACE INTO activity_routes (activity_id, route_id, relation) VALUES (?, ?, ?)',
        [activityId, route.id, `${match.type} (${match.detail})`]);
      db.run('UPDATE routes SET ride_count = ride_count + 1, first_seen = MIN(COALESCE(first_seen, ?), ?), last_seen = MAX(COALESCE(last_seen, ?), ?) WHERE id = ?',
        [createdAt, createdAt, createdAt, createdAt, route.id]);
      return { routeId: route.id, relation: match.type, routeName: route.name, rideCount: route.ride_count + 1 };
    }
  }
  const name = `Route ${Math.round(signature.distanceKm * 10) / 10} km`;
  db.run('INSERT INTO routes (name, canonical_signature, ride_count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)',
    [name, JSON.stringify(signature), createdAt, createdAt]);
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  db.run('INSERT OR REPLACE INTO activity_routes (activity_id, route_id, relation) VALUES (?, ?, ?)',
    [activityId, id, 'same (defines the route)']);
  return { routeId: id, relation: 'same', routeName: name, rideCount: 1 };
}

function readAssignment(db, activityId) {
  const stmt = db.prepare(`SELECT ar.route_id, ar.relation, r.name, r.ride_count
    FROM activity_routes ar JOIN routes r ON r.id = ar.route_id WHERE ar.activity_id = ?`);
  try {
    stmt.bind([activityId]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    return { routeId: row.route_id, relation: String(row.relation || '').split(' ')[0] || 'same', routeName: row.name, rideCount: row.ride_count };
  } finally {
    stmt.free();
  }
}

// Route id per activity for rides already assigned (cheap lookup for cached history rows).
function readRouteAssignments(db) {
  const stmt = db.prepare('SELECT activity_id, route_id, relation FROM activity_routes');
  try {
    const map = new Map();
    while (stmt.step()) {
      const row = stmt.getAsObject();
      map.set(row.activity_id, { routeId: row.route_id, relation: String(row.relation || '').split(' ')[0] || 'same' });
    }
    return map;
  } finally {
    stmt.free();
  }
}

function readRoutes(db) {
  const stmt = db.prepare('SELECT id, name, canonical_signature, ride_count, first_seen, last_seen, note FROM routes ORDER BY id');
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

// Consensus elevation profile of a route, cached in routes.elevation_profile_json and refreshed
// when enough new same-route rides have joined since it was computed.
function ensureRouteElevationProfile(db, routeId) {
  if (!routeId) return null;
  const memberIds = [];
  const members = db.prepare("SELECT activity_id FROM activity_routes WHERE route_id = ? AND relation LIKE 'same%' ORDER BY activity_id");
  try {
    members.bind([routeId]);
    while (members.step()) memberIds.push(members.getAsObject().activity_id);
  } finally {
    members.free();
  }
  const stored = db.prepare('SELECT elevation_profile_json FROM routes WHERE id = ?');
  let cached = null;
  try {
    stored.bind([routeId]);
    if (stored.step()) cached = safeJson(stored.getAsObject().elevation_profile_json);
  } finally {
    stored.free();
  }
  const storedMembers = Number(cached?.members);
  if (cached && Number.isFinite(storedMembers) && memberIds.length - storedMembers < (storedMembers < 10 ? 1 : 3)) {
    return cached.profile || null;
  }
  const rides = memberIds.map((id) => {
    const stmt = db.prepare('SELECT elapsed_s, distance_km, altitude_m, latitude, longitude FROM records WHERE activity_id = ? ORDER BY record_index');
    try {
      stmt.bind([id]);
      const records = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        records.push({ elapsed_time: row.elapsed_s, distance: row.distance_km,
          altitude: row.altitude_m == null ? null : row.altitude_m / 1000,
          position_lat: row.latitude, position_long: row.longitude });
      }
      return buildAltitudeRide(records);
    } finally {
      stmt.free();
    }
  }).filter(Boolean);
  const profile = computeConsensusProfile(rides);
  db.run('UPDATE routes SET elevation_profile_json = ?, elevation_updated_at = ? WHERE id = ?',
    [JSON.stringify({ members: memberIds.length, profile }), new Date().toISOString(), routeId]);
  return profile;
}

// Whether the second half of a ride is slower than the first, for this ride and the earlier rides
// of the same route. A pattern shared by almost every ride is a property of the route (climb,
// prevailing wind), not a finding about the day.
function halfSplit(checkpoints) {
  const rows = (Array.isArray(checkpoints) ? checkpoints : []).filter((row) => Number.isFinite(row?.km) && Number.isFinite(row?.elapsedS));
  if (rows.length < 4) return null;
  const last = rows[rows.length - 1];
  const middle = rows.reduce((best, row) => (Math.abs(row.km - last.km / 2) < Math.abs(best.km - last.km / 2) ? row : best), rows[0]);
  const firstS = middle.elapsedS;
  const secondS = last.elapsedS - middle.elapsedS;
  const secondKm = last.km - middle.km;
  if (!(firstS > 0 && secondS > 0 && middle.km > 0 && secondKm > 0)) return null;
  const firstKmh = middle.km / (firstS / 3600);
  const secondKmh = secondKm / (secondS / 3600);
  return { changePct: ((secondKmh / firstKmh) - 1) * 100, splitKm: middle.km };
}

function summarizeRoutePattern(currentCheckpoints, priorRides, { slowerThresholdPct = -3 } = {}) {
  const priors = (priorRides || []).map((ride) => halfSplit(ride.checkpoints)).filter(Boolean);
  const current = halfSplit(currentCheckpoints);
  if (priors.length < 5 || !current) return null;
  const changes = priors.map((row) => row.changePct).sort((a, b) => a - b);
  const median = changes[Math.floor(changes.length / 2)];
  const slower = changes.filter((value) => value <= slowerThresholdPct).length;
  return {
    priorCount: priors.length,
    slowerCount: slower,
    medianChangePct: Math.round(median * 10) / 10,
    currentChangePct: Math.round(current.changePct * 10) / 10,
    currentDropsMoreThanCount: changes.filter((value) => value > current.changePct).length,
    splitKm: current.splitKm,
  };
}

function setRouteNote(db, routeId, note) {
  db.run('UPDATE routes SET note = ? WHERE id = ?', [String(note || '').trim() || null, routeId]);
}

function setRouteName(db, routeId, name) {
  const clean = String(name || '').trim().slice(0, 80);
  if (clean) db.run('UPDATE routes SET name = ? WHERE id = ?', [clean, routeId]);
}

// Everything the activity page shows about the route of one ride; features come from the cache only.
function readRouteCard(db, activityId) {
  const assignment = readAssignment(db, activityId);
  if (!assignment?.routeId) return null;
  const stmt = db.prepare('SELECT id, name, note, ride_count, features_json FROM routes WHERE id = ?');
  try {
    stmt.bind([assignment.routeId]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    if (!(row.ride_count >= 2) && !row.note) return null;
    const features = safeJson(row.features_json)?.features || null;
    return { routeId: row.id, name: row.name || '', note: row.note || '', rideCount: row.ride_count,
      relation: assignment.relation, features };
  } finally {
    stmt.free();
  }
}

function readRouteNote(db, routeId) {
  const stmt = db.prepare('SELECT note FROM routes WHERE id = ?');
  try {
    stmt.bind([routeId]);
    return stmt.step() ? stmt.getAsObject().note || null : null;
  } finally {
    stmt.free();
  }
}

// Terrain and per-direction speed features of a route, cached in routes.features_json and refreshed
// as new rides join. Needs the elevation consensus (five or more same-direction rides).
function ensureRouteFeatures(db, routeId) {
  if (!routeId) return null;
  const profile = ensureRouteElevationProfile(db, routeId);
  if (!profile) return null;
  const members = [];
  const memberStmt = db.prepare("SELECT activity_id, relation FROM activity_routes WHERE route_id = ? AND (relation LIKE 'same%' OR relation LIKE 'reversed%') ORDER BY activity_id");
  try {
    memberStmt.bind([routeId]);
    while (memberStmt.step()) {
      const row = memberStmt.getAsObject();
      members.push({ id: row.activity_id, relation: String(row.relation).startsWith('same') ? 'same' : 'reversed' });
    }
  } finally {
    memberStmt.free();
  }
  const stored = db.prepare('SELECT features_json FROM routes WHERE id = ?');
  let cached = null;
  try {
    stored.bind([routeId]);
    if (stored.step()) cached = safeJson(stored.getAsObject().features_json);
  } finally {
    stored.free();
  }
  const storedMembers = Number(cached?.members);
  if (cached && Number.isFinite(storedMembers) && members.length - storedMembers < (storedMembers < 10 ? 1 : 3)) {
    return cached.features || null;
  }
  const sections = sectionCount(profile);
  const rides = members.map((member) => {
    const stmt = db.prepare('SELECT elapsed_s, distance_km FROM records WHERE activity_id = ? ORDER BY record_index');
    try {
      stmt.bind([member.id]);
      const records = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        records.push({ elapsed_time: row.elapsed_s, distance: row.distance_km });
      }
      return { relation: member.relation, speeds: sectionSpeeds(records, sections) };
    } finally {
      stmt.free();
    }
  }).filter((ride) => ride.speeds);
  const features = computeRouteFeatures(profile, rides);
  db.run('UPDATE routes SET features_json = ? WHERE id = ?', [JSON.stringify({ members: members.length, features }), routeId]);
  return features;
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

module.exports = {
  CHECKPOINT_SPACING_KM,
  assignRoute,
  computeCheckpoints,
  ensureRouteElevationProfile,
  ensureRouteFeatures,
  readAssignment,
  readRouteCard,
  readRouteNote,
  readRouteAssignments,
  readRoutes,
  setRouteName,
  setRouteNote,
  summarizeCheckpoints,
  summarizeRoutePattern,
};
