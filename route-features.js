// Derived route features: terrain by section from the elevation consensus, typical speed per
// section in each riding direction, climbs and flat sections whose speed differs by direction.
// Pure module: no DB, no vscode. Everything here is measured or computed from rides; wind is
// never inferred, only a direction asymmetry that is consistent with it.

const SECTION_KM = 2;
const FEATURES = Object.freeze({
  minRidesPerDirection: 3,
  climbGradePct: 2.5,        // consecutive sections at or above this form a climb
  minClimbGainM: 15,
  flatGradePct: 1,
  asymmetryRatio: 0.88,      // opposite directions differing by more than this on a flat section
  movingGapS: 10,            // longer gaps between records are stops, not riding
});

const CLIMB = Object.freeze({ windowBins: 4, gradePct: 3, mergeGapBins: 3, minGainM: 15, minLengthKm: 0.2 });

function fillGaps(values) {
  const out = [...values];
  for (let i = 0; i < out.length; i += 1) {
    if (Number.isFinite(out[i])) continue;
    let left = i - 1;
    while (left >= 0 && !Number.isFinite(out[left])) left -= 1;
    let right = i + 1;
    while (right < out.length && !Number.isFinite(values[right])) right += 1;
    out[i] = left >= 0 ? out[left] : (right < out.length ? values[right] : null);
  }
  return out;
}

// Climbs along the ride direction from the consensus profile (fine resolution, so a short steep
// ramp is not averaged away inside a 2 km section).
function findClimbs(consensus, binKm, reversed) {
  const filled = fillGaps(reversed ? [...consensus].reverse() : consensus);
  if (filled.some((value) => !Number.isFinite(value))) return [];
  const w = CLIMB.windowBins;
  const steep = [];
  for (let i = 0; i + w < filled.length; i += 1) {
    steep.push(((filled[i + w] - filled[i]) / (w * binKm * 1000)) * 100 >= CLIMB.gradePct);
  }
  const spans = [];
  for (let i = 0; i < steep.length; i += 1) {
    if (!steep[i]) continue;
    const last = spans[spans.length - 1];
    if (last && i - last.end <= CLIMB.mergeGapBins) last.end = i;
    else spans.push({ start: i, end: i });
  }
  return spans.map(({ start, end }) => {
    const to = Math.min(filled.length - 1, end + w);
    let low = start;
    for (let i = start; i <= to; i += 1) if (filled[i] < filled[low]) low = i;
    const lengthKm = (to - low) * binKm;
    const gainM = filled[to] - filled[low];
    return { fromKm: Math.round(low * binKm * 10) / 10, toKm: Math.round(to * binKm * 10) / 10, lengthKm: Math.round(lengthKm * 100) / 100,
      gainM: Math.round(gainM), avgGradePct: lengthKm > 0 ? Math.round((gainM / (lengthKm * 1000)) * 1000) / 10 : null };
  }).filter((climb) => climb.gainM >= CLIMB.minGainM && climb.lengthKm >= CLIMB.minLengthKm);
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Moving speed per section of a ride, sections being equal fractions of the ride's own length.
// records: [{ elapsed_time, distance }] (distance in km, elapsed in seconds).
function sectionSpeeds(records, sections) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => Number.isFinite(Number(record?.distance)) && Number.isFinite(Number(record?.elapsed_time)));
  if (list.length < 20 || sections < 2) return null;
  const start = Number(list[0].distance);
  const total = Number(list[list.length - 1].distance) - start;
  if (!(total > 1)) return null;
  const km = new Array(sections).fill(0);
  const seconds = new Array(sections).fill(0);
  for (let index = 1; index < list.length; index += 1) {
    const dt = Number(list[index].elapsed_time) - Number(list[index - 1].elapsed_time);
    const dd = Number(list[index].distance) - Number(list[index - 1].distance);
    if (!(dt > 0 && dt <= FEATURES.movingGapS) || !(dd >= 0)) continue;
    const section = Math.min(sections - 1, Math.floor(((Number(list[index].distance) - start) / total) * sections));
    km[section] += dd;
    seconds[section] += dt;
  }
  return km.map((value, index) => (seconds[index] >= 30 && value > 0 ? value / (seconds[index] / 3600) : null));
}

// profile: consensus elevation profile (canonical direction). rides: [{ relation: 'same'|'reversed', speeds: [...] }]
// where speeds are indexed in the ride's own direction.
function sectionCount(profile) {
  return Math.max(4, Math.round(profile.lengthKm / SECTION_KM));
}

function computeRouteFeatures(profile, rides) {
  if (!profile?.consensus?.length || !(profile.lengthKm > 1)) return null;
  const sections = sectionCount(profile);
  const altitudeAt = (fraction) => {
    const bin = Math.min(profile.consensus.length - 1, Math.max(0, Math.round(fraction * profile.consensus.length)));
    for (let step = 0; step < 4; step += 1) {
      for (const candidate of [bin - step, bin + step]) {
        if (Number.isFinite(profile.consensus[candidate])) return profile.consensus[candidate];
      }
    }
    return null;
  };
  const sectionKm = profile.lengthKm / sections;
  const rows = [];
  for (let index = 0; index < sections; index += 1) {
    const from = altitudeAt(index / sections);
    const to = altitudeAt((index + 1) / sections);
    const gainM = from != null && to != null ? to - from : null;
    rows.push({
      index,
      fromKm: Math.round(index * sectionKm * 10) / 10,
      toKm: Math.round((index + 1) * sectionKm * 10) / 10,
      gradePct: gainM == null ? null : Math.round((gainM / (sectionKm * 1000)) * 1000) / 10,
      gainM: gainM == null ? null : Math.round(gainM),
    });
  }
  // Speeds are stored on the canonical axis: a reversed ride's section i is canonical section n-1-i.
  const same = rows.map(() => []);
  const reversed = rows.map(() => []);
  for (const ride of rides || []) {
    if (!Array.isArray(ride?.speeds) || ride.speeds.length !== sections) continue;
    ride.speeds.forEach((speed, index) => {
      if (!Number.isFinite(speed)) return;
      if (ride.relation === 'same') same[index].push(speed);
      else if (ride.relation === 'reversed') reversed[sections - 1 - index].push(speed);
    });
  }
  rows.forEach((row, index) => {
    row.sameKmh = same[index].length >= FEATURES.minRidesPerDirection ? Math.round(median(same[index]) * 10) / 10 : null;
    row.sameRides = same[index].length;
    row.reversedKmh = reversed[index].length >= FEATURES.minRidesPerDirection ? Math.round(median(reversed[index]) * 10) / 10 : null;
    row.reversedRides = reversed[index].length;
  });
  return { sections, sectionKm: Math.round(sectionKm * 10) / 10, lengthKm: Math.round(profile.lengthKm * 10) / 10,
    ascentM: profile.ascentM, descentM: profile.descentM, rows,
    consensus: profile.consensus, binKm: Math.round((profile.lengthKm / profile.consensus.length) * 1000) / 1000 };
}

// Adjacent asymmetric sections are one stretch.
function mergeAsymmetric(rows) {
  const merged = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    const previous = last?.parts[last.parts.length - 1];
    if (last && Math.abs(last.toKm - row.fromKm) < 0.05 && Math.sign(previous.ownKmh - previous.otherKmh) === Math.sign(row.ownKmh - row.otherKmh)) {
      last.toKm = row.toKm;
      last.parts.push(row);
    } else {
      merged.push({ fromKm: row.fromKm, toKm: row.toKm, parts: [row] });
    }
  }
  return merged.map((stretch) => ({
    fromKm: stretch.fromKm, toKm: stretch.toKm,
    ownKmh: Math.round(median(stretch.parts.map((part) => part.ownKmh)) * 10) / 10,
    otherKmh: Math.round(median(stretch.parts.map((part) => part.otherKmh)) * 10) / 10,
  }));
}

// Texts for one riding direction. For 'reversed' the sections are read from the end and grades flip.
function describeRouteFeatures(features, direction = 'same') {
  if (!features?.rows?.length) return null;
  const reversed = direction === 'reversed';
  const ordered = (reversed ? [...features.rows].reverse() : features.rows).map((row, index) => {
    const own = reversed ? row.reversedKmh : row.sameKmh;
    const other = reversed ? row.sameKmh : row.reversedKmh;
    return {
      fromKm: Math.round(index * features.sectionKm * 10) / 10,
      toKm: Math.round((index + 1) * features.sectionKm * 10) / 10,
      gradePct: row.gradePct == null ? null : (reversed ? -row.gradePct : row.gradePct),
      gainM: row.gainM == null ? null : (reversed ? -row.gainM : row.gainM),
      ownKmh: own, otherKmh: other,
    };
  });

  const climbs = features.consensus ? findClimbs(features.consensus, features.binKm, reversed) : [];
  const half = features.lengthKm / 2;
  const firstHalfGain = climbs.filter((climb) => climb.toKm <= half).reduce((sum, climb) => sum + climb.gainM, 0);
  const secondHalfGain = climbs.filter((climb) => climb.fromKm >= half).reduce((sum, climb) => sum + climb.gainM, 0);

  // Flat sections where this direction is clearly slower (or faster) than the opposite one.
  const asymmetric = ordered.filter((row) => row.gradePct != null && Math.abs(row.gradePct) < FEATURES.flatGradePct
    && row.ownKmh && row.otherKmh && (row.ownKmh / row.otherKmh < FEATURES.asymmetryRatio || row.otherKmh / row.ownKmh < FEATURES.asymmetryRatio))
    .map((row) => ({ fromKm: row.fromKm, toKm: row.toKm, ownKmh: row.ownKmh, otherKmh: row.otherKmh }));

  return { rows: ordered, climbs, firstHalfClimbGainM: Math.round(firstHalfGain), secondHalfClimbGainM: Math.round(secondHalfGain), asymmetric: mergeAsymmetric(asymmetric) };
}

module.exports = {
  FEATURES,
  SECTION_KM,
  computeRouteFeatures,
  describeRouteFeatures,
  sectionCount,
  findClimbs,
  sectionSpeeds,
};
