const {
  asNumber, average, calculateBanisterTrimp, calculateBikeStressScore, calculateHrTss,
  calculateIntensityFactor, calculateIntervalsDecoupling, calculateNormalizedPower,
  calculateTrainingStressScore, calculateXPower, despikeSeries, estimateDuration, formatHms, maxOrZero,
} = require('./utils');
const { computeElevationGainLoss } = require('./chart-data');

function buildSummary(records, sessions, options = {}) {
  const speeds = records.map((record) => asNumber(record.speed)).filter(Number.isFinite);
  const hrs = records.map((record) => asNumber(record.heart_rate)).filter((value) => Number.isFinite(value) && value > 0);
  const powers = records.map((record) => asNumber(record.power)).filter(Number.isFinite);
  const distances = records.map((record) => asNumber(record.distance)).filter(Number.isFinite);
  const cadences = records.map((record) => asNumber(record.cadence)).filter((value) => Number.isFinite(value) && value > 0);
  const altitudeM = records.map((record) => asNumber(record.altitude)).filter(Number.isFinite).map((value) => value * 1000);
  const elevation = computeElevationGainLoss(altitudeM);
  const session = sessions[0] || {};
  const sessionDistance = asNumber(session.total_distance);
  const distanceKm = Number.isFinite(sessionDistance) ? sessionDistance : (distances.length ? Math.max(...distances) : 0);
  const totalTimer = asNumber(session.total_timer_time);
  const totalElapsed = asNumber(session.total_elapsed_time);
  const durationSec = Number.isFinite(totalTimer) ? totalTimer : (Number.isFinite(totalElapsed) ? totalElapsed : estimateDuration(records));
  const avgHr = hrs.length ? average(hrs) : (Number.isFinite(asNumber(session.avg_hr)) ? asNumber(session.avg_hr) : 0);
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
  const trimp = calculateBanisterTrimp({ durationSec, avgHeartRate: avgHr, restingHeartRate, maxHeartRate: maxHeartRateForHrr, sex: options.sex });
  const hrTss = calculateHrTss({ durationSec, avgHeartRate: avgHr, restingHeartRate, maxHeartRate: maxHeartRateForHrr });
  const decouplingPct = calculateIntervalsDecoupling(records, { ftp, restingHeartRate, maxHeartRate: maxHeartRateForHrr });
  return {
    records: records.length, distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0, durationText: formatHms(durationSec), durationSec,
    avgSpeed, maxSpeed, avgPower: average(powers), maxPower: maxOrZero(powers), avgCadence: average(cadences), maxCadence: maxOrZero(cadences),
    normalizedPower, intensityFactor, trainingStressScore, xPower, relativeIntensityGc, bikeStressScore, decouplingPct, trimp, hrTss,
    avgHr, maxHr, elevationGainM: elevation.gain, elevationLossM: elevation.loss,
  };
}

module.exports = { buildSummary };