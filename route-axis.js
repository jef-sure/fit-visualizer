// Route axis: the road of a route as a line of metres, and a ride laid onto it by its own ridden
// distance, with GPS pulling it onto the road. Pure module: no DB, no vscode.
//
// Why: matching every fix to the nearest point of the road let an out-and-back jump onto its
// return leg (the two legs are metres apart) and lost a loop entered before its start. Ridden
// distance says where along the road the rider can be; GPS only corrects it. Each correction
// starts the count again, so a wheel 4 % off or a shortcut does not add up along the ride.
//
// Measured on 34 rides of one 20 km loop (one device): the same road is within 3 m in 95 % of
// fixes, 18 m at worst; the wheel and GPS distances of a ride differ by 3-5 %.

const { hasGpsFix } = require('./route-match');

const AXIS = Object.freeze({
  stepM: 10,              // spacing of the axis points
  offRoadM: 30,           // a fix farther than this from the road is off it
  minOffRunM: 50,         // ... for this much riding in a row; one wild fix is not a detour
  windowM: 60,            // how far from where ridden distance puts the rider the road is searched
  scaleTolerance: 0.05,   // the window widens by this share of the distance since the last fix on the road
  backJitterM: 15,        // a fix may fall this far behind the last one on the road (GPS at a stop)
  rejoinBackM: 200,       // after a detour the ride may come back a little behind where it left
  minRejoinM: 50,         // on the road again for this much riding before a detour is closed
  gpsCheckM: 200,         // GPS path against ridden distance over this much riding ...
  gpsDisagreement: 0.15,  // ... differing by more than this share: the positions are not trusted there
  closedLoopM: 150,       // a route whose ends are this close is a loop
  cellM: 50,              // spatial index cell
});

function projector(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return (lat, lon) => {
    // Across ±180° the difference of longitudes is taken the short way round.
    const dLon = ((((Number(lon) - lon0) % 360) + 540) % 360) - 180;
    return { x: dLon * kx, y: (Number(lat) - lat0) * ky };
  };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// The axis of a route from one ride: points every stepM metres along its GPS track.
function buildRouteAxis(records, { stepM = AXIS.stepM } = {}) {
  const tracked = (Array.isArray(records) ? records : []).filter((record) => hasGpsFix(record?.position_lat, record?.position_long));
  if (tracked.length < 2) return null;
  const lat0 = Number(tracked[0].position_lat);
  const lon0 = Number(tracked[0].position_long);
  const project = projector(lat0, lon0);
  const track = [project(lat0, lon0)];
  const along = [0];
  for (let index = 1; index < tracked.length; index += 1) {
    const point = project(tracked[index].position_lat, tracked[index].position_long);
    const step = distance(track[track.length - 1], point);
    // GPS wandering while the rider stands is not road.
    if (step < 1) continue;
    track.push(point);
    along.push(along[along.length - 1] + step);
  }
  const lengthM = along[along.length - 1];
  if (lengthM < 10 * stepM) return null;
  const points = [];
  let cursor = 0;
  for (let s = 0; s <= lengthM; s += stepM) {
    while (cursor + 1 < track.length - 1 && along[cursor + 1] < s) cursor += 1;
    const span = along[cursor + 1] - along[cursor];
    const t = span > 0 ? Math.max(0, Math.min(1, (s - along[cursor]) / span)) : 0;
    points.push({ x: track[cursor].x + (track[cursor + 1].x - track[cursor].x) * t, y: track[cursor].y + (track[cursor + 1].y - track[cursor].y) * t });
  }
  const closingGapM = distance(points[0], points[points.length - 1]);
  const closed = closingGapM <= AXIS.closedLoopM && lengthM > 20 * AXIS.closedLoopM && !retracesItself(points);
  return indexAxis({ lat0, lon0, stepM, points, closed, loopM: closed ? (points.length - 1) * stepM + closingGapM : null });
}

// An out-and-back also ends where it starts, but its way back runs along its way out: most of the
// second half lies on the first. A loop's does not, and only a loop may be entered anywhere.
function retracesItself(points) {
  const half = Math.floor(points.length / 2);
  const first = indexAxis({ lat0: 0, lon0: 0, stepM: 1, points: points.slice(0, half), closed: false, loopM: null });
  const second = points.slice(half);
  const onFirst = second.filter((point) => nearbyOnAxis(first, point, AXIS.offRoadM).length).length;
  return onFirst > second.length / 2;
}

function indexAxis(axis) {
  const grid = new Map();
  axis.points.forEach((point, index) => {
    const key = `${Math.floor(point.x / AXIS.cellM)},${Math.floor(point.y / AXIS.cellM)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });
  return { ...axis, lengthM: (axis.points.length - 1) * axis.stepM, project: projector(axis.lat0, axis.lon0), grid };
}

// Where a position falls on the axis within radiusM: each place where the distance to the axis has
// a minimum along it (two on an out-and-back, one on a plain road), the foot of the perpendicular.
// Every nearby axis point as a candidate would let the ride stick anywhere between the foot and
// where its distance puts it; one per run of nearby points would merge the two legs at the turn.
function nearbyOnAxis(axis, point, radiusM) {
  const reach = Math.ceil(radiusM / AXIS.cellM);
  const cx = Math.floor(point.x / AXIS.cellM);
  const cy = Math.floor(point.y / AXIS.cellM);
  const indices = [];
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (const index of axis.grid.get(`${cx + dx},${cy + dy}`) || []) indices.push(index);
    }
  }
  indices.sort((a, b) => a - b);
  const placed = indices.map((index) => ({ index, ...placeOnAxis(axis, index, point) }));
  const found = [];
  for (let k = 0; k < placed.length; k += 1) {
    const here = placed[k];
    if (here.offsetM > radiusM) continue;
    const before = k > 0 && placed[k - 1].index === here.index - 1 ? placed[k - 1] : null;
    const after = k + 1 < placed.length && placed[k + 1].index === here.index + 1 ? placed[k + 1] : null;
    // A minimum: no neighbour closer (on a flat stretch of equal distances, its first point).
    if ((before && before.offsetM <= here.offsetM) || (after && after.offsetM < here.offsetM)) continue;
    // Neighbouring points project to the same foot; keep one.
    if (found.length && Math.abs(found[found.length - 1].s - here.s) < axis.stepM / 2) continue;
    found.push({ s: here.s, offsetM: here.offsetM });
  }
  return found;
}

// The position projected onto the axis segments either side of a point: metres along the axis and
// the distance from it.
function placeOnAxis(axis, index, point) {
  let best = { s: index * axis.stepM, offsetM: distance(axis.points[index], point) };
  for (const from of [index - 1, index]) {
    const a = axis.points[from];
    const b = axis.points[from + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (!lengthSq) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    const offsetM = Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
    if (offsetM < best.offsetM) best = { s: (from + t) * axis.stepM, offsetM };
  }
  return best;
}

// Of the road points near a fix, the one that fits both: close to the fix and close to where the
// ridden distance puts the rider. By distance from the fix alone, near the turn of an out-and-back
// the GPS noise would pick the leg. A rider does not ride back along the axis: a point behind the
// farthest one reached by more than GPS jitter at a stop is not taken (riding back is off the route).
// (Measured from the last point instead, small steps back add up: a GPS track turns a few metres
// before the real turn, and step by step the ride went back out along the leg it came in on.)
function nearestToExpected(places, expected, along, from) {
  const forward = places.filter((place) => along(from, place.s) >= -AXIS.backJitterM);
  if (!forward.length) return null;
  const score = (place) => place.offsetM + Math.abs(along(expected, place.s));
  return forward.reduce((a, b) => (score(b) < score(a) ? b : a));
}

// The ridden distance of every record in metres: the device's distance, else the GPS path.
function riddenMetres(records, positions) {
  const ridden = new Array(records.length).fill(Number.NaN);
  let gpsPath = 0;
  let lastPosition = null;
  let offset = null;
  for (let index = 0; index < records.length; index += 1) {
    const position = positions[index];
    if (position && lastPosition) gpsPath += distance(lastPosition, position);
    if (position) lastPosition = position;
    const device = records[index]?.distance == null || records[index].distance === '' ? Number.NaN : Number(records[index].distance) * 1000;
    if (Number.isFinite(device)) {
      ridden[index] = device;
      offset = device - gpsPath;
    } else {
      ridden[index] = offset == null ? gpsPath : gpsPath + offset;
    }
  }
  return ridden;
}

// Positions the ride's own distance contradicts: over the last gpsCheckM of riding the GPS path is
// more than gpsDisagreement longer or shorter. Typical of the first minute before a fix settles.
function untrustedPositions(positions, ridden) {
  const untrusted = new Array(positions.length).fill(false);
  const gpsAlong = new Array(positions.length).fill(Number.NaN);
  let path = 0;
  let last = null;
  positions.forEach((position, index) => {
    if (!position) return;
    // Standing still the GPS wanders; only steps while the wheel turns are path.
    if (last != null && ridden[index] > ridden[last]) path += distance(positions[last], position);
    gpsAlong[index] = path;
    last = index;
  });
  let back = 0;
  for (let index = 0; index < positions.length; index += 1) {
    if (!positions[index]) continue;
    while (back < index && (!positions[back] || ridden[index] - ridden[back] > AXIS.gpsCheckM)) back += 1;
    const span = ridden[index] - ridden[back];
    // Nothing to check a position against yet (the first metres, after a gap): not trusted.
    if (!(span >= AXIS.minOffRunM)) {
      untrusted[index] = true;
      continue;
    }
    const gps = gpsAlong[index] - gpsAlong[back];
    if (Math.abs(gps - span) / span > AXIS.gpsDisagreement) untrusted[index] = true;
  }
  return untrusted;
}

// One ride laid onto an axis. Returns, per record, its place on the axis in km (null off the road
// or before the ride reaches it), the stretches ridden off the road, the metres ridden off it and
// the metres of the axis not ridden; deviationM is the larger of the two. With maxDeviationM the
// laying stops as soon as either exceeds it (aborted: true): the ride is not this route.
function layRideOnAxis(records, axis, { maxDeviationM = Infinity } = {}) {
  const list = Array.isArray(records) ? records : [];
  const positions = list.map((record) => (hasGpsFix(record?.position_lat, record?.position_long) ? axis.project(record.position_lat, record.position_long) : null));
  const ridden = riddenMetres(list, positions);
  const untrusted = untrustedPositions(positions, ridden);
  const usable = (index) => positions[index] && !untrusted[index] && Number.isFinite(ridden[index]);
  const bins = axis.points.length;
  const covered = new Uint8Array(bins);
  const axisKm = new Array(list.length).fill(null);
  const offStretches = [];
  const loop = axis.closed ? axis.loopM : null;
  const wrap = (s) => (loop ? ((s % loop) + loop) % loop : s);
  // Signed shortest way from a to b along the axis (round the loop when it is one).
  const along = (a, b) => {
    if (!loop) return b - a;
    const d = (((b - a) % loop) + loop) % loop;
    return d > loop / 2 ? d - loop : d;
  };
  const cover = (from, to) => {
    const length = loop ? (((to - from) % loop) + loop) % loop : to - from;
    if (!(length >= 0)) return;
    for (let s = from; s <= from + length + axis.stepM / 2; s += axis.stepM) {
      const bin = Math.round(wrap(s) / axis.stepM);
      if (bin >= 0 && bin < bins) covered[bin] = 1;
    }
  };
  const clampOpen = (s) => (loop ? wrap(s) : Math.max(0, Math.min(axis.lengthM, s)));

  // The ride is either 'on' the road or seeking it: before it first reaches the road, and after
  // leaving it. Reaching it counts only after minRejoinM of riding forward along it, so a ride
  // that starts on the last metres of a lollipop's stem is not taken for its way home.
  let state = 'seek';
  let s = null;           // place on the axis at the last fix on the road
  let reachedS = null;    // the farthest place reached along the axis
  let anchorM = null;     // ridden distance at that fix
  let offRun = null;      // fixes off the road, not yet long enough to be a detour
  let left = null;        // { startIndex, startM, leftS, leftAnchorM } once the ride has left the road
  let rejoin = null;      // { atM, reachedS, places: [[index, s]] } on the road again, not yet confirmed
  let offM = 0;
  let missedSoFarM = 0;
  let firstOffM = null;   // ridden distance at the first fix off the road before the road was reached
  let reached = false;
  let lastIndex = -1;
  const startM = ridden.find(Number.isFinite);

  const offNow = (index) => offM + (left ? ridden[index] - left.startM : 0);
  const abortedResult = () => ({ aborted: true, axisKm, offStretches, offM, missedM: missedSoFarM, deviationM: Math.max(offM, missedSoFarM) });

  const confirmRejoin = (d) => {
    const [firstIndex, firstS] = rejoin.places[0];
    if (left) {
      const rideM = ridden[firstIndex] - left.startM;
      offM += rideM;
      offStretches.push({ fromIndex: left.startIndex, toIndex: firstIndex - 1, rideM, leftAtKm: left.leftS / 1000, rejoinedAtKm: firstS / 1000 });
      // Road skipped: the stretch between leaving it and coming back further on.
      const skipped = along(left.leftS, firstS);
      if (skipped > 0 && !loop) missedSoFarM += skipped;
    } else {
      // Ridden with GPS before reaching the road: a lead-in from elsewhere.
      const leadInM = firstOffM == null ? 0 : ridden[firstIndex] - firstOffM;
      if (leadInM >= AXIS.minOffRunM) {
        offM += leadInM;
        offStretches.push({ fromIndex: list.findIndex((_, i) => ridden[i] >= firstOffM), toIndex: firstIndex - 1, rideM: leadInM, leftAtKm: null, rejoinedAtKm: firstS / 1000 });
      }
      // Ridden before the first fix that could be placed (no GPS yet, or one that wandered):
      // along the road, as far back as the distance reaches.
      const blindM = firstOffM == null ? ridden[firstIndex] - startM : 0;
      const headFrom = loop ? firstS - Math.min(blindM, loop) : Math.max(0, firstS - blindM);
      cover(headFrom, firstS);
      if (!loop) missedSoFarM += headFrom;
    }
    let previous = firstS;
    for (const [i, place] of rejoin.places) {
      axisKm[i] = place / 1000;
      if (along(previous, place) > 0) cover(previous, place);
      previous = place;
    }
    s = loop ? wrap(previous) : previous;
    reachedS = rejoin.reachedS;
    anchorM = d;
    left = null;
    rejoin = null;
    reached = true;
    state = 'on';
  };

  for (let index = 0; index < list.length; index += 1) {
    if (!Number.isFinite(ridden[index])) continue;
    lastIndex = index;
    const d = ridden[index];
    const fix = usable(index) ? positions[index] : null;

    if (state === 'on') {
      const expected = s + (d - anchorM);
      if (!fix) {
        axisKm[index] = clampOpen(expected) / 1000;
        continue;
      }
      const windowM = AXIS.windowM + AXIS.scaleTolerance * (d - anchorM);
      const near = nearbyOnAxis(axis, fix, AXIS.offRoadM).filter((place) => Math.abs(along(expected, place.s)) <= windowM);
      const best = nearestToExpected(near, expected, along, reachedS);
      if (best) {
        if (along(s, best.s) > 0) cover(s, best.s);
        s = loop ? wrap(best.s) : best.s;
        if (along(reachedS, s) > 0) reachedS = s;
        anchorM = d;
        offRun = null;
        axisKm[index] = s / 1000;
        continue;
      }
      if (!offRun) offRun = { startIndex: index, startM: d, leftS: s, leftAnchorM: anchorM };
      if (d - offRun.startM < AXIS.minOffRunM) {
        axisKm[index] = clampOpen(expected) / 1000;
        continue;
      }
      // Off the road (or riding back along it) for long enough: a detour from where it began.
      for (let i = offRun.startIndex; i <= index; i += 1) axisKm[i] = null;
      left = offRun;
      offRun = null;
      state = 'seek';
      if (offNow(index) > maxDeviationM) return abortedResult();
      continue;
    }

    // Seeking the road: where it is near, nearest to where the ridden distance puts the ride.
    if (left && offNow(index) > maxDeviationM) return abortedResult();
    if (!fix) continue;
    if (rejoin) {
      const [atIndex, atS] = rejoin.places[rejoin.places.length - 1];
      const expected = atS + (d - ridden[atIndex]);
      const windowM = AXIS.windowM + AXIS.scaleTolerance * (d - ridden[atIndex]);
      const near = nearbyOnAxis(axis, fix, AXIS.offRoadM).filter((place) => Math.abs(along(expected, place.s)) <= windowM);
      const best = nearestToExpected(near, expected, along, rejoin.reachedS);
      if (best) {
        rejoin.places.push([index, best.s]);
        if (along(rejoin.reachedS, best.s) > 0) rejoin.reachedS = best.s;
        if (d - rejoin.atM >= AXIS.minRejoinM) {
          confirmRejoin(d);
          if (Math.max(offM, missedSoFarM) > maxDeviationM) return abortedResult();
        }
        continue;
      }
      rejoin = null;
    }
    const expectedHere = left ? left.leftS + (d - left.leftAnchorM) : d - startM;
    const candidates = nearbyOnAxis(axis, fix, AXIS.offRoadM)
      .filter((place) => !left || loop || place.s >= left.leftS - AXIS.rejoinBackM);
    if (!candidates.length) {
      if (!left && firstOffM == null) firstOffM = d;
      continue;
    }
    const best = candidates.reduce((a, b) => (Math.abs(along(expectedHere, b.s)) < Math.abs(along(expectedHere, a.s)) ? b : a));
    rejoin = { atM: d, reachedS: best.s, places: [[index, best.s]] };
  }

  if (!reached) {
    const total = lastIndex >= 0 ? ridden[lastIndex] - startM : 0;
    return { aborted: false, axisKm, offStretches, offM: total, missedM: axis.lengthM, deviationM: Math.max(total, axis.lengthM) };
  }
  if (state === 'seek') {
    const rideM = ridden[lastIndex] - left.startM;
    offM += rideM;
    offStretches.push({ fromIndex: left.startIndex, toIndex: lastIndex, rideM, leftAtKm: left.leftS / 1000, rejoinedAtKm: null });
  } else if (ridden[lastIndex] > anchorM) {
    // Ridden on after the last fix (the GPS gave up near the end): along the road.
    cover(s, clampOpen(s + (ridden[lastIndex] - anchorM)));
  }
  let missedBins = 0;
  for (let bin = 0; bin < bins; bin += 1) if (!covered[bin]) missedBins += 1;
  const missedM = missedBins * axis.stepM;
  return { aborted: false, axisKm, offStretches, offM, missedM, deviationM: Math.max(offM, missedM) };
}

// Stored with the route: the points as metres east and north of its origin, to a decimetre.
function serializeAxis(axis) {
  if (!axis) return null;
  const round = (value) => Math.round(value * 10) / 10;
  return JSON.stringify({ lat0: axis.lat0, lon0: axis.lon0, stepM: axis.stepM, closed: axis.closed, loopM: axis.loopM,
    points: axis.points.map((point) => [round(point.x), round(point.y)]) });
}

function parseAxis(json) {
  try {
    const stored = JSON.parse(json);
    if (!Array.isArray(stored?.points) || stored.points.length < 10 || !Number.isFinite(stored.lat0) || !Number.isFinite(stored.lon0)) return null;
    return indexAxis({ lat0: stored.lat0, lon0: stored.lon0, stepM: stored.stepM, closed: Boolean(stored.closed), loopM: stored.loopM ?? null,
      points: stored.points.map(([x, y]) => ({ x, y })) });
  } catch {
    return null;
  }
}

// The same road ridden the other way.
function reverseAxis(axis) {
  return indexAxis({ lat0: axis.lat0, lon0: axis.lon0, stepM: axis.stepM, closed: axis.closed, loopM: axis.loopM, points: [...axis.points].reverse() });
}

module.exports = { AXIS, buildRouteAxis, layRideOnAxis, parseAxis, reverseAxis, serializeAxis };
