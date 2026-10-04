// Route storage and per-route checkpoints on top of route-match.js. No vscode, testable.
//
// Assignment policy: a ride joins an existing route on same/reversed/partial (its relation is
// recorded per ride). The canonical signature is the member with the least total deviation to
// all others (a medoid, recomputed lazily).

const { buildRouteSignature, matchRoutes, haversineM } = require('./route-match');
const { buildAltitudeRide, computeConsensusProfile, mirrorAltitudeRide } = require('./altitude-quality');
const { computeRouteFeatures, sectionCount, sectionSpeeds } = require('./route-features');

const CHECKPOINT_SPACING_KM = 2; // extra marks inside a long segment
const CHECKPOINT_MATCH_RADIUS_M = 150;

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
    // A longer ride that only partly follows a shorter route is its own route: longer, with its
    // own climbs and its own roads. Joining it to the shorter one would forever present the short
    // route's facts as if the long ride had ridden them (and the long route would never form).
    // Partial applies only when this ride is the shorter one - a loop cut short, a late start.
    if (match.type === 'partial' && signature.distanceKm > canonical.distanceKm * 1.05) {
      continue;
    }
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
    const detail = String(row.relation || '');
    return { routeId: row.route_id, relation: detail.split(' ')[0] || 'same', relationDetail: detail, routeName: row.name, rideCount: row.ride_count };
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

// Checkpoints for one ride: a mark at every segment boundary plus extra marks every 2 km inside
// segments longer than that. A mark carries the place on the road (lat/lon at the crossing, plus
// km when GPS is missing), so rides are compared place-to-place even when their segments differ.
// Records carry elapsed_time, distance, heart_rate; speed comes from deltas.
function computeCheckpoints(records, segments = [], { spacingKm = CHECKPOINT_SPACING_KM } = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => Number.isFinite(Number(record?.distance)) && Number.isFinite(Number(record?.elapsed_time)));
  if (list.length < 10) return [];
  const first = list[0];
  const last = list[list.length - 1];
  const totalKm = last.distance - first.distance;
  if (!(totalKm > 0)) return [];

  // Segment boundaries as distances; out-of-range and duplicate values are dropped later.
  const edges = new Set();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment?.type === 'stopped') continue;
    for (const elapsed of [segment.startElapsed, segment.endElapsed]) {
      if (Number.isFinite(Number(elapsed)) && elapsed > first.elapsed_time && elapsed < last.elapsed_time) edges.add(elapsed);
    }
  }
  const kmAt = (elapsed) => {
    let previous = first;
    for (const record of list) {
      if (record.elapsed_time > elapsed) return previous.distance + (record.distance - previous.distance)
        * ((elapsed - previous.elapsed_time) / (record.elapsed_time - previous.elapsed_time || 1));
      if (record.elapsed_time === elapsed) return record.distance;
      previous = record;
    }
    return last.distance;
  };
  const marks = [...edges].sort((a, b) => a - b).map(kmAt)
    .filter((km) => km > first.distance && km < last.distance);
  // Extra marks inside stretches between boundaries that are longer than the spacing.
  const dense = [first.distance, ...marks, last.distance];
  for (let index = 0; index + 1 < dense.length; index += 1) {
    const from = dense[index];
    const to = dense[index + 1];
    if (to - from <= spacingKm) continue;
    for (let km = from + spacingKm; km < to - spacingKm / 2; km += spacingKm) marks.push(km);
  }
  marks.sort((a, b) => a - b);
  const unique = marks.filter((km, index) => index === 0 || km - marks[index - 1] > 0.2);
  const final = unique.length && last.distance - unique[unique.length - 1] >= spacingKm / 2
    ? [...unique, last.distance] : unique.length ? [...unique] : [last.distance];

  const result = [];
  let prevTime = first.elapsed_time;
  let prevDistance = first.distance;
  let markIndex = 0;
  let hrSum = 0;
  let hrCount = 0;
  let spanTime = 0;
  let spanDistance = 0;
  for (let index = 1; index < list.length && markIndex < final.length; index += 1) {
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
    while (markIndex < final.length && record.distance >= final[markIndex]) {
      result.push({
        km: Math.round(final[markIndex] * 10) / 10,
        lat: Number.isFinite(Number(record.position_lat)) ? Number(record.position_lat) : null,
        lon: Number.isFinite(Number(record.position_long)) ? Number(record.position_long) : null,
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

// Position along the route of a prior mark on this ride's axis. Same direction: km scales with
// the small length difference. Reversed: a place at fraction f of the route sits at km f·L in one
// direction and (1-f)·L in the other.
function priorKmOnAxis(row, priorLengthKm, thisLengthKm, reversed) {
  if (!Number.isFinite(row?.km) || !(priorLengthKm > 0) || !(thisLengthKm > 0)) return null;
  const fraction = reversed ? 1 - row.km / priorLengthKm : row.km / priorLengthKm;
  return fraction * thisLengthKm;
}

// Prior rides are matched to a mark by place on the road: GPS distance when both have it, km as a
// fallback (wind trainer, GPS-less rides). 150 m is generous for a point crossed at speed. A loop
// often runs close to itself, so place alone is not enough: the matched mark must also sit at
// about the same position along the route (within 1 km, after reflecting for direction).
function priorRowsNear(priorRides, mark, { radiusM = CHECKPOINT_MATCH_RADIUS_M, reversed = false, lengthKm = null } = {}) {
  const withGps = Number.isFinite(mark?.lat) && Number.isFinite(mark?.lon);
  const thisLengthKm = Number.isFinite(Number(lengthKm)) ? Number(lengthKm) : null;
  const matches = [];
  for (const ride of priorRides || []) {
    const rows = Array.isArray(ride?.checkpoints) ? ride.checkpoints : [];
    const priorLengthKm = rows.reduce((max, row) => (Number.isFinite(row?.km) && row.km > max ? row.km : max), 0);
    let best = null;
    for (const row of rows) {
      if (!Number.isFinite(row?.elapsedS)) continue;
      const axisKm = priorKmOnAxis(row, priorLengthKm, thisLengthKm, reversed);
      // A loop runs close to itself; place alone could pair different legs of it.
      const axisGap = axisKm != null && Number.isFinite(mark?.km) ? Math.abs(axisKm - mark.km) : Infinity;
      if (axisGap > 1) continue;
      // Without GPS on either side the axis distance is the place metric.
      const d = withGps && Number.isFinite(row.lat) && Number.isFinite(row.lon)
        ? haversineM(mark.lat, mark.lon, row.lat, row.lon)
        : axisGap < Infinity ? axisGap * 1000 : Infinity;
      // Place-nearest wins; the axis distance breaks ties and is the metric without GPS.
      const better = best == null || axisGap < best.axisGap
        || (axisGap === best.axisGap && d < best.d);
      if (better) best = { row, d, axisGap };
    }
    if (best != null && best.d <= radiusM) matches.push(best.row);
  }
  return matches;
}

function summarizeCheckpoints(current, priorRides) {
  // The route length is the last mark's km; a mark's own km would misplace the axis near the start.
  const lengthKm = current.reduce((max, row) => (Number.isFinite(row?.km) && row.km > max ? row.km : max), 0) || null;
  return current.map((mark) => {
    const matching = priorRowsNear(priorRides, mark, { lengthKm });
    const priors = matching.map((row) => row.elapsedS).sort((a, b) => a - b);
    const median = priors.length ? priors[Math.floor(priors.length / 2)] : null;
    const heartRates = matching.map((row) => row.avgHr).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    return {
      ...mark,
      priorMedianS: median,
      priorRides: priors.length,
      priorBestS: priors.length ? priors[0] : null,
      priorMedianHr: heartRates.length >= 3 ? heartRates[Math.floor(heartRates.length / 2)] : null,
    };
  });
}

// One computed sentence about the final checkpoint: whether this ride was faster or slower and
// whether that came with higher, similar or lower heart rate than the prior median.
function describeCheckpointVerdict(summary) {
  const mark = [...summary].reverse().find((row) => row.priorMedianS && row.elapsedS);
  if (!mark) return null;
  const timeDeltaPct = 100 * (mark.elapsedS / mark.priorMedianS - 1);
  const significantTime = Math.abs(timeDeltaPct) >= 2;
  const hrDelta = Number.isFinite(mark.avgHr) && Number.isFinite(mark.priorMedianHr) ? mark.avgHr - mark.priorMedianHr : null;
  const hrKnown = hrDelta != null && Math.abs(hrDelta) >= 4;
  const speedWord = !significantTime ? 'similar time' : timeDeltaPct < 0 ? `${formatCheckDelta(mark.priorMedianS - mark.elapsedS)} faster` : `${formatCheckDelta(mark.elapsedS - mark.priorMedianS)} slower`;
  const hrWord = hrDelta == null ? null : hrKnown ? (hrDelta > 0 ? 'higher' : 'lower') : 'similar';
  const timeText = `at km ${mark.km}: ${speedWord} than the prior median`;
  const hrText = hrWord ? ` at HR ${mark.avgHr} vs prior median ${mark.priorMedianHr}` : '';
  const verdict = !significantTime && (hrDelta == null || !hrKnown)
    ? 'no notable difference from prior rides'
    : hrWord === null
      ? (significantTime ? `a ${timeDeltaPct < 0 ? 'faster' : 'slower'} ride; heart rate of prior rides is unknown, so effort cannot be judged` : 'similar time')
      : hrWord === 'higher'
        ? (significantTime && timeDeltaPct < 0 ? 'faster at higher HR (more effort, not evidence of efficiency)'
          : significantTime ? 'slower at higher HR (conditions, fatigue or heat; not a fitness statement)'
          : 'similar time at higher HR (more internal load at the same speed)')
        : hrWord === 'lower'
          ? (significantTime && timeDeltaPct < 0 ? 'faster at lower HR (the kind of change that, repeated, would indicate improved efficiency)'
            : significantTime ? 'slower at lower HR (less effort)'
            : 'similar time at lower HR (less internal load at the same speed)')
          : significantTime ? (timeDeltaPct < 0 ? 'faster at similar HR' : 'slower at similar HR') : 'similar time and HR';
  return `${timeText}${hrText} — ${verdict}.`;
}

function formatCheckDelta(seconds) {
  const total = Math.abs(Math.round(seconds));
  return `${total >= 60 ? `${Math.floor(total / 60)} min ` : ''}${total % 60}s`;
}

// Consensus elevation profile of a route, cached in routes.elevation_profile_json and refreshed
// when enough new same-route rides have joined since it was computed.
function ensureRouteElevationProfile(db, routeId) {
  if (!routeId) return null;
  const memberRows = [];
  const members = db.prepare("SELECT activity_id, relation FROM activity_routes WHERE route_id = ? AND (relation LIKE 'same%' OR relation LIKE 'reversed%') ORDER BY activity_id");
  try {
    members.bind([routeId]);
    while (members.step()) {
      const row = members.getAsObject();
      memberRows.push({ id: row.activity_id, reversed: String(row.relation).startsWith('reversed') });
    }
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
  if (cached && Number.isFinite(storedMembers) && memberRows.length - storedMembers < (storedMembers < 10 ? 1 : 3)) {
    return cached.profile || null;
  }
  const rides = memberRows.map(({ id, reversed }) => {
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
      const ride = buildAltitudeRide(records);
      // Reversed rides are mirrored onto the canonical axis so all rides align by distance.
      return reversed && ride ? mirrorAltitudeRide(ride) : ride;
    } finally {
      stmt.free();
    }
  }).filter(Boolean);
  const profile = computeConsensusProfile(rides);
  db.run('UPDATE routes SET elevation_profile_json = ?, elevation_updated_at = ? WHERE id = ?',
    [JSON.stringify({ members: memberRows.length, profile }), new Date().toISOString(), routeId]);
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
  const stmt = db.prepare('SELECT id, name, note, ride_count, features_json, canonical_signature FROM routes WHERE id = ?');
  try {
    stmt.bind([assignment.routeId]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    // A first ride on a fresh route still gets a card: without it the section silently appears
    // and disappears across selections, which reads as a glitch. The name/note form is useful
    // right away (naming the route before more rides arrive), and the facts grow in later.
    if (!(row.ride_count >= 1) && !row.note) return null;
    const features = safeJson(row.features_json)?.features || null;
    const signature = safeJson(row.canonical_signature);
    return { routeId: row.id, name: row.name || '', note: row.note || '', rideCount: row.ride_count,
      relation: assignment.relation, relationDetail: assignment.relationDetail || null, features,
      signatureLengthKm: Number.isFinite(Number(signature?.distanceKm)) ? Math.round(Number(signature.distanceKm) * 10) / 10 : null };
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
  describeCheckpointVerdict,
  summarizeCheckpoints,
  priorKmOnAxis,
  priorRowsNear,
  summarizeRoutePattern,
};
