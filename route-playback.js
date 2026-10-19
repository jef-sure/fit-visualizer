'use strict';

// The ride replayed on the map: where the rider was and what the sensors read, sample by sample.
// The track is thinned the same way as the drawn route, so the moving point stays on the line.
// A break in the recording (auto-pause, a device switched off for lunch) plays as a short step
// instead of minutes of a point standing still; a stop the device did record plays as it was.
// Pure: records in, a compact payload for the page out.

const { asNumber, computeGrade, downsamplePoints, normalizeCoordinate } = require('./utils');

// A gap between two samples longer than this is a break in the recording, not riding.
const PLAYBACK_MAX_GAP_S = 10;

// The values the page can show beside the moving point, in the order it shows them.
const PLAYBACK_FIELDS = ['distance', 'speed', 'heart_rate', 'power', 'cadence', 'altitude', 'grade'];

const DIGITS = { t: 1, elapsed: 1, lat: 6, lon: 6, distance: 3, speed: 1, heart_rate: 0, power: 0, cadence: 0, altitude: 1, grade: 1 };

function rounded(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value) {
  const number = asNumber(value);
  return Number.isFinite(number) ? number : null;
}

// Records as the page reads them (distance in km, altitude in km, speed in km/h). Power is taken
// as recorded: an estimate from speed and grade swings by a hundred watts from one second to the
// next and is not shown sample by sample.
function buildPlaybackTrack(records, maxPoints, { maxGapS = PLAYBACK_MAX_GAP_S } = {}) {
  const list = Array.isArray(records) ? records : [];
  const grades = computeGrade(list);
  const samples = [];
  let clock = 0;
  let previousElapsed = null;
  list.forEach((record, index) => {
    const elapsed = asNumber(record?.elapsed_time);
    if (!Number.isFinite(elapsed)) return;
    // The playback clock runs over every record, with or without a position: a tunnel is ridden
    // through, a break in the recording is skipped.
    if (previousElapsed != null && elapsed > previousElapsed) clock += Math.min(elapsed - previousElapsed, maxGapS);
    if (previousElapsed == null || elapsed > previousElapsed) previousElapsed = elapsed;
    const lat = normalizeCoordinate(record.position_lat, 90);
    const lon = normalizeCoordinate(record.position_long, 180);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
    const heartRate = finiteOrNull(record.heart_rate);
    const altitude = finiteOrNull(record.altitude);
    samples.push({
      t: clock, elapsed, lat, lon,
      distance: finiteOrNull(record.distance),
      speed: finiteOrNull(record.speed),
      heart_rate: heartRate != null && heartRate > 0 ? heartRate : null,
      power: finiteOrNull(record.power),
      cadence: finiteOrNull(record.cadence),
      altitude: altitude == null ? null : altitude * 1000,
      grade: grades[index] && Number.isFinite(grades[index].grade) ? grades[index].grade * 100 : null,
    });
  });
  if (samples.length < 2) return null;
  const thinned = downsamplePoints(samples, Math.max(2, maxPoints));
  // Thinning keeps the first sample but may drop the last; the point has to reach the finish.
  if (thinned[thinned.length - 1] !== samples[samples.length - 1]) thinned.push(samples[samples.length - 1]);
  const column = (key) => thinned.map((sample) => rounded(sample[key], DIGITS[key]));
  const fields = {};
  for (const key of PLAYBACK_FIELDS) {
    const values = column(key);
    fields[key] = values.some((value) => value != null) ? values : null;
  }
  return { t: column('t'), elapsed: column('elapsed'), lat: column('lat'), lon: column('lon'), fields };
}

module.exports = { PLAYBACK_FIELDS, PLAYBACK_MAX_GAP_S, buildPlaybackTrack };
