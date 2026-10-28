const {
  asNumber, average, calculateBanisterTrimp, calculateBikeStressScore, calculateHrTss,
  calculateIntensityFactor, calculateIntervalsDecoupling, calculateNormalizedPower,
  calculateTrainingStressScore, calculateXPower, despikeSeries, estimateDuration, formatHms, maxOrZero,
} = require('./utils');
const { computeElevationGainLoss } = require('./chart-data');
const { estimateLactateThresholdHeartRate } = require('./heart-rate');

// Mean of a field over the time each sample stands for. A plain mean of samples counts a sample
// that covers eight seconds of smart recording the same as one that covers a single second, and
// smart recording writes fewer samples exactly where nothing changes. Equal to the plain mean at
// a steady 1 Hz.
function timeWeightedMean(records, read) {
  const steps = [];
  for (let index = 1; index < records.length; index += 1) {
    const step = asNumber(records[index]?.elapsed_time) - asNumber(records[index - 1]?.elapsed_time);
    if (step > 0 && step <= 30) steps.push(step);
  }
  steps.sort((left, right) => left - right);
  const typical = steps.length ? steps[Math.floor(steps.length / 2)] : 1;
  let sum = 0;
  let seconds = 0;
  for (let index = 0; index < records.length; index += 1) {
    const value = read(records[index]);
    if (value == null) continue;
    const step = asNumber(records[index + 1]?.elapsed_time) - asNumber(records[index]?.elapsed_time);
    const weight = step > 0 && step <= 30 ? step : typical;
    sum += value * weight;
    seconds += weight;
  }
  return seconds > 0 ? sum / seconds : 0;
}

// A file with several sessions (a multisport file, a ride the device split in two) is one
// activity: its distance, times, climbing and calories are those of all its sessions, its start
// the first one's, its maxima the highest. Averages are left to the records.
function wholeSession(sessions) {
  const list = (Array.isArray(sessions) ? sessions : []).filter(Boolean);
  if (list.length <= 1) return list[0] || {};
  const sum = (field) => {
    const values = list.map((session) => asNumber(session[field])).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const max = (field) => {
    const values = list.map((session) => asNumber(session[field])).filter(Number.isFinite);
    return values.length ? Math.max(...values) : undefined;
  };
  const first = [...list].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))[0];
  return {
    ...first,
    total_distance: sum('total_distance'), total_timer_time: sum('total_timer_time'), total_elapsed_time: sum('total_elapsed_time'),
    total_moving_time: sum('total_moving_time'), total_ascent: sum('total_ascent'), total_descent: sum('total_descent'),
    total_calories: sum('total_calories'),
    max_hr: max('max_hr'), max_heart_rate: max('max_heart_rate'), max_speed: max('max_speed'), max_power: max('max_power'),
    avg_speed: undefined, avg_speed_kmh: undefined, avg_hr: undefined, avg_heart_rate: undefined, avg_power: undefined,
  };
}

function buildSummary(records, sessions, options = {}) {
  const speeds = records.map((record) => asNumber(record.speed)).filter(Number.isFinite);
  const hrs = records.map((record) => asNumber(record.heart_rate)).filter((value) => Number.isFinite(value) && value > 0);
  const powers = records.map((record) => asNumber(record.power)).filter(Number.isFinite);
  const distances = records.map((record) => asNumber(record.distance)).filter(Number.isFinite);
  const cadences = records.map((record) => asNumber(record.cadence)).filter((value) => Number.isFinite(value) && value > 0);
  const altitudeM = records.map((record) => asNumber(record.altitude)).filter(Number.isFinite).map((value) => value * 1000);
  const elevation = computeElevationGainLoss(altitudeM);
  const session = wholeSession(sessions);
  const sessionDistance = asNumber(session.total_distance);
  const distanceKm = Number.isFinite(sessionDistance) ? sessionDistance : maxOrZero(distances);
  const totalTimer = asNumber(session.total_timer_time);
  const totalElapsed = asNumber(session.total_elapsed_time);
  const durationSec = Number.isFinite(totalTimer) ? totalTimer : (Number.isFinite(totalElapsed) ? totalElapsed : estimateDuration(records));
  const positive = (field) => (record) => { const value = asNumber(record?.[field]); return Number.isFinite(value) && value > 0 ? value : null; };
  const finite = (field) => (record) => { const value = asNumber(record?.[field]); return Number.isFinite(value) ? value : null; };
  const avgHr = hrs.length ? timeWeightedMean(records, positive('heart_rate')) : (Number.isFinite(asNumber(session.avg_hr)) ? asNumber(session.avg_hr) : 0);
  const maxHr = hrs.length ? maxOrZero(hrs) : (Number.isFinite(asNumber(session.max_hr)) ? asNumber(session.max_hr) : 0);
  const normalizedPower = calculateNormalizedPower(records);
  const sessionAvgSpeed = [session.avg_speed, session.avg_speed_kmh].map(asNumber).find((value) => Number.isFinite(value) && value > 0) || 0;
  const sessionMaxSpeed = [session.max_speed, session.max_speed_kmh].map(asNumber).find((value) => Number.isFinite(value) && value > 0) || 0;
  const distanceBasedAvgSpeed = distanceKm > 0 && durationSec > 0 ? distanceKm / (durationSec / 3600) : 0;
  const avgSpeed = sessionAvgSpeed || distanceBasedAvgSpeed || average(speeds.filter((value) => value > 0));
  const maxSpeed = sessionMaxSpeed || maxOrZero(despikeSeries(speeds, { absThreshold: 12, ratioThreshold: 0.5 }));
  const ftp = asNumber(options.ftp);
  const intensityFactor = calculateIntensityFactor(normalizedPower, ftp);
  const trainingStressScore = calculateTrainingStressScore(durationSec, normalizedPower, intensityFactor, ftp);
  const xPower = calculateXPower(records);
  const relativeIntensityGc = calculateIntensityFactor(xPower, ftp);
  const bikeStressScore = calculateBikeStressScore(durationSec, xPower, relativeIntensityGc, ftp);
  const restingHeartRate = asNumber(options.restingHeartRate);
  const maxHeartRateForHrr = Number.isFinite(asNumber(options.maxHeartRateForHrr)) ? asNumber(options.maxHeartRateForHrr) : maxHr;
  const trimp = calculateBanisterTrimp({ durationSec, avgHeartRate: avgHr, records, restingHeartRate, maxHeartRate: maxHeartRateForHrr, sex: options.sex });
  const hrTss = calculateHrTss({
    durationSec, avgHeartRate: avgHr, records, restingHeartRate,
    lactateThresholdHeartRate: estimateLactateThresholdHeartRate(maxHeartRateForHrr, options.heartRateThresholds, options.restingHeartRate, options.lactateThresholdHeartRate),
  });
  const decouplingPct = options.powerSource === 'estimated'
    ? null
    : calculateIntervalsDecoupling(records);
  return {
    records: records.length, distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0, durationText: formatHms(durationSec), durationSec,
    avgSpeed, maxSpeed, avgPower: timeWeightedMean(records, finite('power')), maxPower: maxOrZero(powers),
    avgCadence: timeWeightedMean(records, positive('cadence')), maxCadence: maxOrZero(cadences),
    // How many samples stand behind each figure: zero means "not recorded", which is not 0.
    samples: { heartRate: hrs.length || (Number.isFinite(asNumber(session.avg_hr)) && asNumber(session.avg_hr) > 0 ? 1 : 0), power: powers.length, cadence: cadences.length, altitude: altitudeM.length },
    normalizedPower, intensityFactor, trainingStressScore, xPower, relativeIntensityGc, bikeStressScore, decouplingPct, trimp, hrTss,
    avgHr, maxHr, elevationGainM: elevation.gain, elevationLossM: elevation.loss,
  };
}

module.exports = { buildSummary, timeWeightedMean, wholeSession };