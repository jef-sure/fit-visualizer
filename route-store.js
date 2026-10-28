// Route storage and per-route checkpoints on top of route-match.js. No vscode, testable.
//
// Assignment policy: a ride joins an existing route when it strays from the route's axis by no more
// than the smaller of a share of the route and a distance, either way round (its relation, same or
// reversed, is recorded per ride). The axis and the signature are those of the ride that created
// the route and are not updated afterwards; a rebuild assigns rides oldest first, so that is the
// earliest ride. The signature still pairs saved names and notes with re-derived routes.

const { buildRouteSignature, matchRoutes, haversineM } = require('./route-match');
const { AXIS, axisKey, buildRouteAxis, flipVariant, followsLine, indexVariant, layRideOnAxis, medianAxis, parseAxis, reverseAxis, serializeAxis, variantOfDetour } = require('./route-axis');
const { routeFeaturesFromStats } = require('./route-features');
const { SKELETON, addRideToAccumulator, createRouteAccumulator, layRideOnBins, profileFromAccumulator, sectionStatsFromAccumulator,
  skeletonFromAccumulator } = require('./route-sections');

const CHECKPOINT_SPACING_KM = 2; // extra marks inside a long segment
const CHECKPOINT_MATCH_RADIUS_M = 150;
// How far a ride of a route may stray from its axis: the smaller of a share of the route and a
// distance (settings fitVisualizer.routeMaxDeviationPct and fitVisualizer.routeMaxDeviationKm).
// Measured on 34 rides of one 20 km route: the same road strays by 0-3 %, a changed junction by 3 %,
// another way in or out by 9 % and more.
const ROUTE_MATCH_DEFAULTS = Object.freeze({ maxDeviationPct: 5, maxDeviationKm: 1 });
// Two rides of a route are compared on the road both rode the same way; a conclusion about the
// route as a whole needs this share of this ride's road shared (fitVisualizer.routeMinSharedPct).
const ROUTE_MIN_SHARED_PCT = 80;
// Rest this much over the usual (weighted seconds at stops, route-sections.js stopRests) is said
// alongside a comparison (fitVisualizer.extraRestS).
const EXTRA_REST_S = 60;
// The wheel and the GPS measure the same road a few per cent apart (3-5 % on that route).
const LENGTH_SCALE_TOLERANCE = 0.05;
// A way ridden once or twice is not yet a route: it has no card and no route comparisons, and
// its rides only count towards it. The third ride makes it habitual, and the axis then becomes the
// middle line of the first three rides instead of the first ride's track.
const HABITUAL_ROUTE_RIDES = 3;

function isHabitualRoute(routeInfo) {
  return Number(routeInfo?.rideCount) >= HABITUAL_ROUTE_RIDES;
}

function routeMatchSettings(options = {}) {
  const pick = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
  return {
    maxDeviationPct: pick(options.maxDeviationPct, ROUTE_MATCH_DEFAULTS.maxDeviationPct),
    maxDeviationKm: pick(options.maxDeviationKm, ROUTE_MATCH_DEFAULTS.maxDeviationKm),
  };
}

// Assign (or create) a route for one ride. Idempotent: a ride that already has an assignment keeps
// it, so repeated context builds do not recount. Returns { routeId, relation, routeName, rideCount }.
//
// Every route within the limit is a candidate, and the one the ride strays from least wins (two
// roads 70 m apart can both be near), a habitual route before a way ridden once or twice. The
// difference in length, beyond what the wheel gets wrong, is road one has and the other has not,
// so it is a floor of the deviation: a route whose floor is past the limit is not laid at all, and
// laying stops as soon as the ride strays more than the limit or than the best route so far.
function assignRoute(db, { activityId, signature, createdAt, records, options = {} }) {
  if (!signature) return { routeId: null, relation: null };
  const existing = readAssignment(db, activityId);
  if (existing) return existing;
  const settings = routeMatchSettings(options);
  const rideM = signature.distanceKm * 1000;
  const candidates = [];
  for (const route of readRoutes(db)) {
    const axis = routeAxis(db, route);
    if (!axis) continue;
    const limitM = Math.min((settings.maxDeviationPct / 100) * axis.lengthM, settings.maxDeviationKm * 1000);
    // A known variant is road of the route: riding it costs nothing, so the length a ride may differ
    // by and the straying laying tolerates before it stops grow by what the variants could take.
    const variants = routeVariants(route, axis);
    const slackM = variants.same.reduce((sum, variant) => sum + variant.lengthM + Math.abs(variant.toS - variant.fromS), 0);
    const floorM = Math.abs(rideM - axis.lengthM) - LENGTH_SCALE_TOLERANCE * Math.max(rideM, axis.lengthM) - slackM;
    if (floorM <= limitM) candidates.push({ route, axis, limitM, floorM, variants, slackM });
  }
  candidates.sort((a, b) => a.floorM - b.floorM);
  // A way ridden once or twice does not take a ride from a habitual route the ride fits: a ride
  // just past the limit starts one, and the next rides, often closer to it than to the route, would
  // otherwise follow it off and split the route in two.
  let best = null;
  for (const candidate of candidates) {
    const habitual = Number(candidate.route.ride_count) >= HABITUAL_ROUTE_RIDES;
    if (best?.habitual && !habitual) continue;
    // An out-and-back fits both ways equally; the same direction is tried first and kept.
    for (const [relation, axis] of [['same', candidate.axis], ['reversed', reverseAxis(candidate.axis)]]) {
      const toBeat = best && best.habitual === habitual ? best.laid.deviationM : Infinity;
      const limitM = Math.min(candidate.limitM, toBeat);
      if (candidate.floorM >= limitM) continue;
      const laid = layRideOnAxis(records, axis, { maxDeviationM: limitM + candidate.slackM, variants: candidate.variants[relation] });
      if (laid.aborted || laid.deviationM > candidate.limitM || !(laid.deviationM < toBeat)) continue;
      best = { route: candidate.route, axis: candidate.axis, relation, laid, habitual };
    }
  }
  if (best) {
    const { route, relation, laid } = best;
    const variantsRidden = new Set((laid.variantStretches || []).map((stretch) => stretch.id)).size;
    db.run('INSERT OR REPLACE INTO activity_routes (activity_id, route_id, relation) VALUES (?, ?, ?)',
      [activityId, route.id, `${relation} (${Math.round(laid.offM)} m off the route, ${Math.round(laid.missedM)} m of it not ridden${variantsRidden ? `, ${variantsRidden} of its variants` : ''})`]);
    noteDetours(db, route, best.axis, relation, records, laid, activityId);
    db.run('UPDATE routes SET ride_count = ride_count + 1, first_seen = MIN(COALESCE(first_seen, ?), ?), last_seen = MAX(COALESCE(last_seen, ?), ?) WHERE id = ?',
      [createdAt, createdAt, createdAt, createdAt, route.id]);
    const rideCount = route.ride_count + 1;
    if (rideCount >= HABITUAL_ROUTE_RIDES && !(Number(route.axis_rides) >= HABITUAL_ROUTE_RIDES)) {
      settleRouteAxis(db, route.id, { activityId, records });
    }
    return { routeId: route.id, relation, routeName: route.name, rideCount };
  }
  const name = `Route ${Math.round(signature.distanceKm * 10) / 10} km`;
  db.run('INSERT INTO routes (name, canonical_signature, axis_json, axis_rides, ride_count, first_seen, last_seen) VALUES (?, ?, ?, 1, 1, ?, ?)',
    [name, JSON.stringify(signature), serializeAxis(buildRouteAxis(records)), createdAt, createdAt]);
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

// The axis of a route that has become habitual: the middle line of its first rides, each ridden
// the way the route goes (a ride on it in reverse is turned round first). The ride just assigned
// may not be stored yet; its records come with it. Without the records of all of them the first
// ride's axis stays, and the next ride tries again.
function settleRouteAxis(db, routeId, { activityId, records }) {
  const members = [];
  const stmt = db.prepare(`SELECT ar.activity_id, ar.relation FROM activity_routes ar JOIN activities a ON a.id = ar.activity_id
    WHERE ar.route_id = ? ORDER BY datetime(a.start_time), a.id LIMIT ?`);
  try {
    stmt.bind([routeId, HABITUAL_ROUTE_RIDES]);
    while (stmt.step()) members.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  const rides = members.map((member) => {
    const own = member.activity_id === activityId && Array.isArray(records) ? records : readSkeletonRecords(db, member.activity_id);
    return String(member.relation || '').startsWith('reversed') ? [...own].reverse().map((record, index, all) => ({
      ...record, distance: Number(all[0].distance) - Number(record.distance) })) : own;
  });
  if (rides.length < HABITUAL_ROUTE_RIDES || rides.some((ride) => ride.length < 10)) return false;
  const axis = medianAxis(rides);
  if (!axis) return false;
  // Variants are kept against the axis; the few noted on the first ride's are noted again.
  db.run('UPDATE routes SET axis_json = ?, axis_rides = ?, variants_json = NULL WHERE id = ?', [serializeAxis(axis), HABITUAL_ROUTE_RIDES, routeId]);
  // The rides already on the route were placed on the old axis (or on none, before the route was
  // habitual): their checkpoints and segments are derived again on the new one.
  db.run('UPDATE activity_features SET feature_cache_key = NULL WHERE activity_id IN (SELECT activity_id FROM activity_routes WHERE route_id = ?)', [routeId]);
  return true;
}

// Parsed axes by their stored text: a context build lays a dozen rides on the same one.
const parsedAxes = new Map();

function parseStoredAxis(json) {
  if (!json) return null;
  if (!parsedAxes.has(json)) {
    if (parsedAxes.size >= 16) parsedAxes.clear();
    parsedAxes.set(json, parseAxis(json));
  }
  return parsedAxes.get(json);
}

// The axis of a route; one created before routes had an axis gets it from its earliest ride.
function routeAxis(db, route) {
  const stored = parseStoredAxis(route.axis_json);
  if (stored) return stored;
  const first = db.exec(`SELECT ar.activity_id FROM activity_routes ar JOIN activities a ON a.id = ar.activity_id
    WHERE ar.route_id = ? ORDER BY datetime(a.start_time), a.id LIMIT 1`, [route.id])[0]?.values?.[0]?.[0];
  if (first == null) return null;
  const axis = buildRouteAxis(readSkeletonRecords(db, first));
  if (axis) db.run('UPDATE routes SET axis_json = ? WHERE id = ?', [serializeAxis(axis), route.id]);
  return axis;
}

// Variants of a route's stretches, kept in routes.variants_json in the axis' own direction:
// { next, list: [{ id, fromS, toS, lengthM, points: [[x, y]], rides: [activityId] }] }. A ride on
// the route that leaves it and comes back starts a candidate with its detour, or joins the
// candidate it follows (both ends within 150 m, nine fixes in ten on its road). On its third ride a
// candidate is a variant of the route: riding it is riding the route, and the road there is
// compared between the rides that took it. A variant does not expire: roadworks can last years.
function readVariants(route) {
  try {
    const stored = JSON.parse(route?.variants_json || 'null');
    if (Array.isArray(stored?.list)) return { next: Number(stored.next) || 1, list: stored.list };
  } catch {
    // Unreadable: noted again from the next rides.
  }
  return { next: 1, list: [] };
}

const isAcceptedVariant = (variant) => Array.isArray(variant?.rides) && variant.rides.length >= HABITUAL_ROUTE_RIDES;

// The accepted variants of a route, ready for laying a ride in either direction.
function routeVariants(route, axis) {
  const accepted = readVariants(route).list.filter(isAcceptedVariant);
  return {
    same: accepted.map(indexVariant).filter(Boolean),
    reversed: accepted.map((variant) => indexVariant(flipVariant(variant, axis))).filter(Boolean),
    key: accepted.map((variant) => `${variant.id}:${Math.round(variant.fromS)}-${Math.round(variant.toS)}`).join(','),
  };
}

// The detours of a ride that joined a route become candidates for variants of it, or join one.
function noteDetours(db, route, axis, relation, records, laid, activityId) {
  const detours = (laid.offStretches || []).filter((stretch) => stretch.leftAtKm != null && stretch.rejoinedAtKm != null);
  if (!detours.length) return;
  const stored = readVariants(route);
  const ridingAxis = relation === 'reversed' ? reverseAxis(axis) : axis;
  const accepted = [];
  for (const stretch of detours) {
    const found = variantOfDetour(records, ridingAxis, stretch);
    if (!found) continue;
    const detour = relation === 'reversed' ? flipVariant(found, axis) : found;
    const match = stored.list.find((candidate) => !candidate.rides.includes(activityId)
      && Math.abs(candidate.fromS - detour.fromS) <= AXIS.variantEndM && Math.abs(candidate.toS - detour.toS) <= AXIS.variantEndM
      && followsVariant(candidate, detour));
    if (match) {
      match.rides.push(activityId);
      if (match.rides.length === HABITUAL_ROUTE_RIDES) accepted.push(match);
    } else {
      const round = (value) => Math.round(value * 10) / 10;
      stored.list.push({ id: stored.next, fromS: round(detour.fromS), toS: round(detour.toS), lengthM: round(detour.lengthM),
        points: detour.points.map((point) => [round(point.x), round(point.y)]), rides: [activityId] });
      stored.next += 1;
    }
  }
  const text = JSON.stringify(stored);
  db.run('UPDATE routes SET variants_json = ? WHERE id = ?', [text, route.id]);
  route.variants_json = text;
  // The rides that rode a new variant were laid as off the route there: they are laid again.
  const ids = [...new Set(accepted.flatMap((variant) => variant.rides))];
  if (ids.length) db.run(`UPDATE activity_features SET feature_cache_key = NULL WHERE activity_id IN (${ids.map(() => '?').join(',')})`, ids);
}

// Whether a detour runs along a candidate's road: nine of its points in ten on it.
function followsVariant(candidate, detour) {
  const line = indexVariant(candidate)?.line;
  if (!line) return false;
  const points = detour.points.map((point) => (Array.isArray(point) ? { x: point[0], y: point[1] } : point));
  return followsLine(line, points, AXIS.offRoadM);
}

function readRoutes(db) {
  const stmt = db.prepare('SELECT id, name, canonical_signature, axis_json, axis_rides, variants_json, ride_count, first_seen, last_seen, note FROM routes ORDER BY id');
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
  let cumulativeHrSum = 0;
  let cumulativeHrSeconds = 0;
  let spanTime = 0;
  let spanDistance = 0;
  for (let index = 1; index < list.length && markIndex < final.length; index += 1) {
    const record = list[index];
    const dt = record.elapsed_time - prevTime;
    const dd = record.distance - prevDistance;
    if (dt > 0 && dd >= 0) {
      spanTime += dt;
      spanDistance += dd;
      const hr = record.heart_rate == null ? NaN : Number(record.heart_rate);
      // An auto-pause leaves a gap with no ground covered; the first sample after it is not the
      // heart rate of the whole pause.
      const pausedGap = dt > 30 && dd < 0.03;
      if (Number.isFinite(hr) && hr > 0 && !pausedGap) {
        hrSum += hr * dt;
        hrCount += dt;
        cumulativeHrSum += hr * dt;
        cumulativeHrSeconds += dt;
      }
    }
    while (markIndex < final.length && record.distance >= final[markIndex]) {
      result.push({
        km: Math.round(final[markIndex] * 10) / 10,
        lat: record.position_lat != null && Number.isFinite(Number(record.position_lat)) ? Number(record.position_lat) : null,
        lon: record.position_long != null && Number.isFinite(Number(record.position_long)) ? Number(record.position_long) : null,
        elapsedS: Math.round(record.elapsed_time),
        avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
        cumulativeAvgHr: cumulativeHrSeconds > 0 ? Math.round(cumulativeHrSum / cumulativeHrSeconds) : null,
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
      const better = best == null || d < best.d
        || (d === best.d && axisGap < best.axisGap);
      if (better) best = { row, d, axisGap };
    }
    if (best != null && best.d <= radiusM) matches.push(best.row);
  }
  return matches;
}

// Marks on a route's axis (route-sections.js routeCheckpoints) are the same places on every ride,
// keyed by km. A ride's totals over a set of them: the time in motion, the road, the heart rate
// weighted by that time, the stops and the rest they gave; null when it did not ride one of them
// on the route. Stops are told apart from riding: 50 s at a light is rest, not slowness.
function splitTotals(marksByKm, kms) {
  let timeS = 0;
  let km = 0;
  let hrSum = 0;
  let hrSeconds = 0;
  let restS = 0;
  let stops = 0;
  let stoppedS = 0;
  for (const at of kms) {
    const mark = marksByKm.get(at);
    if (!mark?.ridden || !Number.isFinite(mark.splitS)) return null;
    timeS += Number.isFinite(mark.movingS) ? mark.movingS : mark.splitS;
    km += mark.km - mark.fromKm;
    restS += Number(mark.restS) || 0;
    stops += Number(mark.stops) || 0;
    stoppedS += Number(mark.stoppedS) || 0;
    if (Number.isFinite(mark.avgHr) && mark.movingS > 0) { hrSum += mark.avgHr * mark.movingS; hrSeconds += mark.movingS; }
  }
  return { timeS, km, hr: hrSeconds > 0 ? Math.round(hrSum / hrSeconds) : null, restS, stops, stoppedS };
}

// Two rides of a route side by side up to km: their totals over the stretches both rode on the
// route the same way (a variant only against the same variant). Null when they share none.
function sharedRoadTotals(marksA, marksB, km) {
  const a = marksByKm(marksA);
  const b = marksByKm(marksB);
  const kms = riddenUpTo(marksA, km).filter((at) => {
    const other = b.get(at);
    return other?.ridden && Number.isFinite(other.splitS) && (other.via || '') === (a.get(at).via || '');
  });
  if (!kms.length) return null;
  const first = splitTotals(a, kms);
  const second = splitTotals(b, kms);
  return first && second ? { a: first, b: second, km: Math.round(first.km * 10) / 10 } : null;
}

const isAxisMarks = (marks) => Array.isArray(marks) && marks.length > 0 && marks.every((mark) => mark?.axis);
const marksByKm = (marks) => new Map((Array.isArray(marks) ? marks : []).filter((mark) => mark?.axis).map((mark) => [mark.km, mark]));

// The stretches up to and including km that this ride rode on the route: what it is compared on.
function riddenUpTo(marks, km) {
  return marks.filter((mark) => mark.km <= km && mark.ridden && Number.isFinite(mark.splitS)).map((mark) => mark.km);
}

// What an earlier ride did on the road it shares with this one up to km: the stretches both rode on
// the route, and the same way (a variant counts only against the same variant). With at least
// minSharedPct of this ride's road shared, its time and heart rate there, carried over to the whole
// of this ride's road in the proportion this ride took on the shared part; null otherwise.
function priorOnSharedRoad(currentMarks, priorMarks, km, minSharedPct = ROUTE_MIN_SHARED_PCT) {
  const own = marksByKm(currentMarks);
  const prior = marksByKm(priorMarks);
  const kms = riddenUpTo(currentMarks, km);
  if (!kms.length || !prior.size) return null;
  const shared = kms.filter((at) => {
    const theirs = prior.get(at);
    return theirs?.ridden && Number.isFinite(theirs.splitS) && (theirs.via || '') === (own.get(at).via || '');
  });
  const mine = splitTotals(own, kms);
  const mineShared = shared.length ? splitTotals(own, shared) : null;
  const theirs = shared.length ? splitTotals(prior, shared) : null;
  if (!mine || !mineShared || !theirs || !(mineShared.timeS > 0)) return null;
  if (mineShared.km < (minSharedPct / 100) * mine.km - 1e-9) return null;
  return {
    timeS: Math.round(theirs.timeS * (mine.timeS / mineShared.timeS)),
    hr: theirs.hr != null && mine.hr && mineShared.hr ? Math.round(theirs.hr * (mine.hr / mineShared.hr)) : theirs.hr,
    restS: Math.round(theirs.restS * (mine.km / mineShared.km)),
    sharedKm: Math.round(mineShared.km * 10) / 10,
  };
}

// Axis marks against earlier rides: at every mark, this ride's time over the stretches it rode on
// the route so far against each earlier ride on the road the two share (priorOnSharedRoad). A
// detour or a variant, here or in an earlier ride, leaves its stretch out instead of the whole rest.
function summarizeAxisCheckpoints(current, priorRides, { minSharedPct = ROUTE_MIN_SHARED_PCT } = {}) {
  const own = marksByKm(current);
  return current.map((mark) => {
    const kms = riddenUpTo(current, mark.km);
    const mine = kms.length ? splitTotals(own, kms) : null;
    const totals = mine ? (priorRides || []).map((ride) => priorOnSharedRoad(current, ride?.checkpoints, mark.km, minSharedPct)).filter(Boolean) : [];
    const times = totals.map((row) => row.timeS).sort((a, b) => a - b);
    const heartRates = totals.map((row) => row.hr).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    const rests = totals.map((row) => row.restS).sort((a, b) => a - b);
    return {
      ...mark,
      // Time in motion; the stops and their rest beside it.
      elapsedS: mine ? mine.timeS : null,
      avgHr: mine ? mine.hr : null,
      restS: mine ? mine.restS : null,
      stops: mine ? mine.stops : null,
      priorMedianRestS: rests.length ? rests[Math.floor(rests.length / 2)] : null,
      comparedKm: mine ? Math.round(mine.km * 10) / 10 : 0,
      priorMedianS: times.length ? times[Math.floor(times.length / 2)] : null,
      priorRides: times.length,
      priorBestS: times.length ? times[0] : null,
      priorMedianHr: heartRates.length >= 3 ? heartRates[Math.floor(heartRates.length / 2)] : null,
    };
  });
}

function summarizeCheckpoints(current, priorRides, options = {}) {
  if (isAxisMarks(current)) return summarizeAxisCheckpoints(current, priorRides, options);
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
// whether that came with higher, similar or lower heart rate than the prior median. On the route's
// axis the time is in motion, and rest at stops well over the usual is said with it.
function describeCheckpointVerdict(summary, { extraRestS = EXTRA_REST_S } = {}) {
  const mark = [...summary].reverse().find((row) => row.priorMedianS && row.elapsedS);
  if (!mark) return null;
  const timeDeltaPct = 100 * (mark.elapsedS / mark.priorMedianS - 1);
  const significantTime = Math.abs(timeDeltaPct) >= 2;
  const hrDelta = Number.isFinite(mark.avgHr) && Number.isFinite(mark.priorMedianHr) ? mark.avgHr - mark.priorMedianHr : null;
  const hrKnown = hrDelta != null && Math.abs(hrDelta) >= 4;
  const speedWord = !significantTime ? 'similar time' : timeDeltaPct < 0 ? `${formatCheckDelta(mark.priorMedianS - mark.elapsedS)} faster` : `${formatCheckDelta(mark.elapsedS - mark.priorMedianS)} slower`;
  const hrWord = hrDelta == null ? null : hrKnown ? (hrDelta > 0 ? 'higher' : 'lower') : 'similar';
  const over = mark.axis && mark.comparedKm < mark.km - 0.05 ? ` (over the ${mark.comparedKm} km of it ridden on the route's road)` : '';
  const timeText = `at km ${mark.km}${over}${mark.axis ? ' (time in motion)' : ''}: ${speedWord} than the prior median`;
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
  const moreRest = mark.axis && mark.restS != null && mark.priorMedianRestS != null && mark.restS > mark.priorMedianRestS + extraRestS
    ? ` More rest at stops than usual (${formatCheckDelta(mark.restS)} against ${formatCheckDelta(mark.priorMedianRestS)}, weighted by the fall of heart rate): the time compared is the time in motion, and the rest came on top of it.` : '';
  return `${timeText}${hrText} — ${verdict}.${moreRest}`;
}

function formatCheckDelta(seconds) {
  const total = Math.abs(Math.round(seconds));
  return `${total >= 60 ? `${Math.floor(total / 60)} min ` : ''}${total % 60}s`;
}

// Consensus elevation profile of a route, from what its rides have added to it, on the axis.
function ensureRouteElevationProfile(db, routeId, options = {}) {
  const found = routeId ? ensureRouteAccumulator(db, routeId, options) : null;
  return found ? profileFromAccumulator(found.acc) : null;
}

// Whether the second half of a ride is slower than the first, for this ride and the earlier rides
// of the same route. A pattern shared by almost every ride is a property of the route (climb,
// prevailing wind), not a finding about the day.
function halfSplit(checkpoints) {
  if (isAxisMarks(checkpoints)) {
    // On the axis: the stretches ridden on the route before and after the middle of it.
    const last = checkpoints[checkpoints.length - 1];
    const middle = checkpoints.reduce((best, row) => (Math.abs(row.km - last.km / 2) < Math.abs(best.km - last.km / 2) ? row : best), checkpoints[0]);
    const byKm = marksByKm(checkpoints);
    const half = (rows) => {
      const kms = rows.filter((row) => row.ridden && Number.isFinite(row.splitS)).map((row) => row.km);
      return kms.length ? splitTotals(byKm, kms) : null;
    };
    const first = half(checkpoints.filter((row) => row.km <= middle.km));
    const second = half(checkpoints.filter((row) => row.km > middle.km));
    if (!(first?.timeS > 0 && second?.timeS > 0 && first.km > 0 && second.km > 0)) return null;
    return { changePct: (((second.km / second.timeS) / (first.km / first.timeS)) - 1) * 100, splitKm: middle.km };
  }
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

function summarizeRoutePattern(currentCheckpoints, priorRides, { slowerThresholdPct = -3, minSharedPct = ROUTE_MIN_SHARED_PCT } = {}) {
  // On the route's axis only rides that share enough of this ride's road say what is usual for it.
  const lastKm = isAxisMarks(currentCheckpoints) ? currentCheckpoints[currentCheckpoints.length - 1].km : null;
  const sharing = lastKm == null ? (priorRides || [])
    : (priorRides || []).filter((ride) => priorOnSharedRoad(currentCheckpoints, ride?.checkpoints, lastKm, minSharedPct));
  const priors = sharing.map((ride) => halfSplit(ride.checkpoints)).filter(Boolean);
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
  const stmt = db.prepare('SELECT id, name, note, ride_count, features_json, canonical_signature, skeleton_json FROM routes WHERE id = ?');
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
      shape: describeRouteShape(safeJson(row.skeleton_json)?.[assignment.relation === 'reversed' ? 'reversed' : 'same']?.skeleton),
      signatureLengthKm: Number.isFinite(Number(signature?.distanceKm)) ? Math.round(Number(signature.distanceKm) * 10) / 10 : null };
  } finally {
    stmt.free();
  }
}

// What the user typed about routes, kept across a rebuild that deletes and re-derives the routes
// table. Automatic names ("Route 20.9 km") are not user data and are left to the rebuild.
const AUTO_ROUTE_NAME = /^Route \d+(\.\d+)? km$/;

function snapshotRouteLabels(db) {
  return readRoutes(db)
    .map((route) => ({
      name: route.name && !AUTO_ROUTE_NAME.test(route.name) ? route.name : null,
      note: route.note || null,
      signature: parseCanonical(route.canonical_signature),
    }))
    .filter((label) => label.signature && (label.name || label.note));
}

// Re-derived routes get new ids, so labels return by geometry: each saved label goes to the
// closest re-derived route that is the same road (either direction), one label per route.
function restoreRouteLabels(db, labels) {
  const routes = readRoutes(db).map((route) => ({ id: route.id, signature: parseCanonical(route.canonical_signature) }))
    .filter((route) => route.signature);
  const pairs = [];
  (labels || []).forEach((label, labelIndex) => {
    for (const route of routes) {
      const match = matchRoutes(label.signature, route.signature);
      if (match.type === 'same' || match.type === 'reversed') pairs.push({ labelIndex, routeId: route.id, scoreM: match.scoreM });
    }
  });
  pairs.sort((a, b) => a.scoreM - b.scoreM);
  const usedLabels = new Set();
  const usedRoutes = new Set();
  for (const pair of pairs) {
    if (usedLabels.has(pair.labelIndex) || usedRoutes.has(pair.routeId)) continue;
    usedLabels.add(pair.labelIndex);
    usedRoutes.add(pair.routeId);
    const label = labels[pair.labelIndex];
    if (label.name) setRouteName(db, pair.routeId, label.name);
    if (label.note) setRouteNote(db, pair.routeId, label.note);
  }
  return { restored: usedLabels.size, lost: (labels || []).length - usedLabels.size };
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

// Terrain and per-direction speed features of a route, from its accumulator, cached in
// routes.features_json for the route card. Needs the elevation consensus (five or more rides).
function ensureRouteFeatures(db, routeId, options = {}) {
  const found = routeId ? ensureRouteAccumulator(db, routeId, options) : null;
  const profile = found ? profileFromAccumulator(found.acc) : null;
  if (!profile) return null;
  const features = routeFeaturesFromStats(profile, sectionStatsFromAccumulator(found.acc));
  const text = JSON.stringify({ members: Object.keys(found.acc.members).length, features });
  if (text !== found.route.features_json) db.run('UPDATE routes SET features_json = ? WHERE id = ?', [text, routeId]);
  return features;
}

// The skeleton as a list in travel order for the route card: each stretch of the road, and after
// it the slow-down point it ends at. Read-only: what the rides show, for the rider to compare
// with how the road feels. Null when the route has no skeleton yet.
function describeRouteShape(skeleton) {
  if (!Array.isArray(skeleton?.stretches) || !skeleton.stretches.length) return null;
  const round1 = (value) => Math.round(Number(value) * 10) / 10;
  const items = [];
  for (const stretch of skeleton.stretches) {
    items.push({ kind: 'stretch', fromKm: round1(stretch.fromKm), toKm: round1(stretch.toKm), type: stretch.type,
      gradePct: stretch.gradePct, gainM: stretch.gainM, lossM: stretch.lossM,
      kmh: stretch.routeKmh ?? null, hr: stretch.routeHr ?? null });
    const point = stretch.endsAtPoint ? (skeleton.points || []).find((candidate) => candidate.bin === stretch.toBin) : null;
    if (point) items.push({ kind: 'point', km: round1(point.km), minKmh: Math.round(point.typicalMinKmh), sharePct: point.sharePct });
  }
  return { rides: skeleton.rides, sharePct: skeleton.sharePct, lengthKm: round1(skeleton.lengthKm), items };
}

// The rides of a route that are laid on its axis, oldest first, with their direction.
function readRouteMembers(db, routeId) {
  const members = [];
  const stmt = db.prepare(`SELECT ar.activity_id, ar.relation FROM activity_routes ar JOIN activities a ON a.id = ar.activity_id
    WHERE ar.route_id = ? AND (ar.relation LIKE 'same%' OR ar.relation LIKE 'reversed%') ORDER BY datetime(a.start_time), a.id`);
  try {
    stmt.bind([routeId]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      members.push({ id: Number(row.activity_id), relation: String(row.relation).startsWith('reversed') ? 'reversed' : 'same' });
    }
  } finally {
    stmt.free();
  }
  return members;
}

function readRoute(db, routeId) {
  const stmt = db.prepare('SELECT id, name, axis_json, axis_rides, variants_json, ride_count, skeleton_json, features_json FROM routes WHERE id = ?');
  try {
    stmt.bind([routeId]);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally {
    stmt.free();
  }
}

// One ride laid on its route's axis in its direction (a ride the other way on the axis turned
// round), with the route's variants, per 50 m bin (route-sections.js). Null when the route has no
// axis or the ride cannot be laid on it.
function layRideOnRoute(db, routeId, relation, records, options = {}) {
  if (!routeId || !['same', 'reversed'].includes(relation)) return null;
  const route = readRoute(db, routeId);
  const routeLine = route ? routeAxis(db, route) : null;
  if (!routeLine) return null;
  const axis = relation === 'reversed' ? reverseAxis(routeLine) : routeLine;
  const lay = layRideOnBins(records, axis, { offRoadM: options.toleranceM, stops: options.stops ?? null, variants: routeVariants(route, routeLine)[relation] });
  return lay ? { axis, lay } : null;
}

// What the rides of a route have added to it (route-sections.js), kept in routes.skeleton_json
// beside the skeletons. A ride joining is laid on the axis and added; its records are read once,
// and the earlier rides' never again. A ride that left the route, a new axis or another tolerance
// start the accumulation again, ride by ride. current: { activityId, records } of a ride whose
// records may not be stored yet. options.toleranceM: undefined keeps the stored tolerance.
function ensureRouteAccumulator(db, routeId, options = {}, current = null) {
  const route = readRoute(db, routeId);
  const axis = route ? routeAxis(db, route) : null;
  if (!axis) return null;
  const cache = safeJson(route.skeleton_json) || {};
  const members = readRouteMembers(db, routeId);
  const relationOf = new Map(members.map((member) => [member.id, member.relation]));
  let acc = cache.accumulator;
  const offRoadM = options.toleranceM === undefined ? (acc?.offRoadM ?? 0) : (options.toleranceM > 0 ? options.toleranceM : 0);
  const variants = routeVariants(route, axis);
  // A variant accepted since lays its earlier rides again: they were off the road there.
  const valid = acc && acc.version === SKELETON.version && acc.axisKey === axisKey(axis) && acc.offRoadM === offRoadM
    && acc.variantsKey === variants.key
    && Object.entries(acc.members || {}).every(([id, relation]) => relationOf.get(Number(id)) === relation);
  if (!valid) acc = createRouteAccumulator(axis, { offRoadM, variants });
  if (!acc) return null;
  const joining = members.filter((member) => !Object.prototype.hasOwnProperty.call(acc.members, member.id));
  for (const member of joining) {
    const records = current && Number(current.activityId) === member.id && Array.isArray(current.records) ? current.records : readSkeletonRecords(db, member.id);
    // A ride whose records are not stored yet is added when they are.
    if (!records.length) continue;
    const lay = layRideOnBins(records, member.relation === 'reversed' ? reverseAxis(axis) : axis, { offRoadM, variants: variants[member.relation] });
    if (lay) addRideToAccumulator(acc, { activityId: member.id, relation: member.relation, lay });
    else acc.members[member.id] = member.relation;
  }
  if (!valid || joining.length) {
    const text = JSON.stringify({ ...cache, accumulator: acc });
    db.run('UPDATE routes SET skeleton_json = ? WHERE id = ?', [text, routeId]);
    route.skeleton_json = text;
  }
  return { acc, axis, route, cache: { ...cache, accumulator: acc } };
}

// The route's skeleton (slow-down points and the stretches between them) for one direction, from
// its accumulator, cached in routes.skeleton_json: worked out again for every ride that joins
// while the route is young, every third later on, and at once when the settings change.
function ensureRouteSkeleton(db, routeId, relation, options = {}, current = null) {
  if (!routeId || !['same', 'reversed'].includes(relation)) return null;
  const found = ensureRouteAccumulator(db, routeId, options, current);
  if (!found) return null;
  const { acc, cache } = found;
  const settings = JSON.stringify({ version: SKELETON.version, options });
  const entry = cache[relation];
  const rides = acc[relation].rides;
  const joined = entry ? rides - entry.members : Infinity;
  const sameRoad = entry?.skeleton ? entry.skeleton.axisKey === acc.axisKey && entry.skeleton.bins === acc.bins : true;
  if (entry && entry.settings === settings && sameRoad && joined >= 0 && joined < (entry.members < 10 ? 1 : 3)) return entry.skeleton;
  const skeleton = skeletonFromAccumulator(acc, relation, options, entry?.skeleton || null);
  db.run('UPDATE routes SET skeleton_json = ? WHERE id = ?',
    [JSON.stringify({ ...cache, [relation]: { settings, members: rides, skeleton } }), routeId]);
  // Segments are cut at the skeleton's boundaries. When those moved, the cached segments of the
  // route's rides no longer match and are recomputed the next time they are needed.
  const ids = readRouteMembers(db, routeId).filter((member) => member.relation === relation).map((member) => member.id);
  if ((entry?.skeleton?.frameKey || null) !== (skeleton?.frameKey || null) && ids.length) {
    db.run(`UPDATE activity_features SET feature_cache_key = NULL WHERE activity_id IN (${ids.map(() => '?').join(',')})`, ids);
  }
  return skeleton;
}

function readSkeletonRecords(db, activityId) {
  const stmt = db.prepare('SELECT elapsed_s, distance_km, speed_kmh, heart_rate, altitude_m, latitude, longitude FROM records WHERE activity_id = ? ORDER BY record_index');
  try {
    stmt.bind([activityId]);
    const records = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      records.push({ elapsed_time: row.elapsed_s, distance: row.distance_km, speed: row.speed_kmh, heart_rate: row.heart_rate,
        altitude: row.altitude_m, position_lat: row.latitude, position_long: row.longitude });
    }
    return records;
  } finally {
    stmt.free();
  }
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

module.exports = {
  HABITUAL_ROUTE_RIDES,
  isHabitualRoute,
  ROUTE_MATCH_DEFAULTS,
  routeMatchSettings,
  CHECKPOINT_SPACING_KM,
  assignRoute,
  computeCheckpoints,
  ensureRouteElevationProfile,
  ensureRouteFeatures,
  describeRouteShape,
  ensureRouteAccumulator,
  ensureRouteSkeleton,
  layRideOnRoute,
  readSkeletonRecords,
  readAssignment,
  readRouteCard,
  readRouteNote,
  readRouteAssignments,
  readRoutes,
  setRouteName,
  setRouteNote,
  snapshotRouteLabels,
  restoreRouteLabels,
  describeCheckpointVerdict,
  EXTRA_REST_S,
  isAxisMarks,
  marksByKm,
  priorOnSharedRoad,
  sharedRoadTotals,
  ROUTE_MIN_SHARED_PCT,
  riddenUpTo,
  splitTotals,
  summarizeCheckpoints,
  priorKmOnAxis,
  priorRowsNear,
  summarizeRoutePattern,
};
