function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function createNonce() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return '0';
  }

  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1000) {
    return value.toFixed(0);
  }
  if (absoluteValue >= 100) {
    return value.toFixed(1);
  }
  if (absoluteValue >= 10) {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

function downsamplePoints(points, maxPoints) {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = points.length / maxPoints;
  const sampled = [];
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.floor(index * step)]);
  }
  return sampled;
}

function estimateDuration(records) {
  const elapsed = records
    .map((record) => asNumber(record.elapsed_time))
    .filter((value) => Number.isFinite(value));
  return elapsed.length ? Math.max(...elapsed) : 0;
}

function formatHms(value) {
  const total = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function toDateOnly(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateNormalizedPower(records) {
  if (!Array.isArray(records) || !records.length) {
    return null;
  }

  const samples = [];
  for (let index = 0; index < records.length; index += 1) {
    const power = asNumber(records[index]?.power);
    if (!Number.isFinite(power) || power < 0) {
      continue;
    }
    const elapsed = asNumber(records[index]?.elapsed_time);
    samples.push({ t: Number.isFinite(elapsed) ? elapsed : index, v: power });
  }

  if (!samples.length) {
    return null;
  }

  // Coggan NP: 30s rolling average first, then 4th-power mean and 4th root.
  const rolling = trailingTimeMovingAverage(samples, 30);
  const meanFourthPower = weightedMean(rolling.map((value) => value ** 4), sampleDurations(samples));
  return meanFourthPower > 0 ? meanFourthPower ** 0.25 : null;
}

function calculateAutoFtp(records) {
  if (!Array.isArray(records) || !records.length) {
    return 0;
  }

  const samples = records
    .map((record, index) => ({
      t: asNumber(record?.elapsed_time),
      p: asNumber(record?.power),
      index,
    }))
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.p) && sample.p >= 0)
    .sort((left, right) => left.t - right.t || left.index - right.index);
  const windowSeconds = 20 * 60;
  const minimumSpan = 19 * 60;
  let bestAverage = 0;

  for (let start = 0; start < samples.length; start += 1) {
    let end = start;
    let sum = 0;
    while (end < samples.length && samples[end].t - samples[start].t <= windowSeconds) {
      if (end > start && samples[end].t - samples[end - 1].t > 5) {
        break;
      }
      sum += samples[end].p;
      end += 1;
    }
    const last = end - 1;
    const span = last >= start ? samples[last].t - samples[start].t : 0;
    if (span >= minimumSpan && sum / (last - start + 1) > bestAverage) {
      bestAverage = sum / (last - start + 1);
    }
  }

  const estimate = Math.round(bestAverage * 0.95);
  return estimate >= 80 && estimate <= 500 ? estimate : 0;
}

function calculateMeanMaximalPower(records, durations = [60, 300, 600, 1200, 1800, 3000, 3300, 3600]) {
  if (!Array.isArray(records) || !records.length) {
    return durations.map((durationSec) => ({ durationSec, power: 0 }));
  }

  const samples = records
    .map((record, index) => ({
      t: asNumber(record?.elapsed_time),
      p: asNumber(record?.power),
      index,
    }))
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.p) && sample.p >= 0)
    .sort((left, right) => left.t - right.t || left.index - right.index);

  const segments = [];
  let segmentStart = 0;
  for (let index = 1; index <= samples.length; index += 1) {
    if (index === samples.length || samples[index].t - samples[index - 1].t > 5) {
      segments.push(samples.slice(segmentStart, index));
      segmentStart = index;
    }
  }

  return durations.map((durationSec) => {
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return { durationSec, power: 0 };
    }

    let bestAverage = 0;
    for (const segment of segments) {
      const prefix = new Array(segment.length + 1).fill(0);
      for (let index = 0; index < segment.length; index += 1) {
        prefix[index + 1] = prefix[index] + segment[index].p;
      }

      let end = 0;
      for (let start = 0; start < segment.length; start += 1) {
        if (end < start) {
          end = start;
        }
        while (end < segment.length && segment[end].t - segment[start].t <= durationSec) {
          end += 1;
        }

        const last = end - 1;
        const span = last >= start ? segment[last].t - segment[start].t : 0;
        if (span >= durationSec) {
          const windowAverage = (prefix[end] - prefix[start]) / (end - start);
          bestAverage = Math.max(bestAverage, windowAverage);
        }
      }
    }

    return { durationSec, power: bestAverage };
  });
}

function calculateHistoricalMeanMaximalPower(activityRecords, durations) {
  if (!Array.isArray(activityRecords) || !activityRecords.length) {
    return calculateMeanMaximalPower([], durations);
  }

  const curve = calculateMeanMaximalPower([], durations);
  for (const records of activityRecords) {
    const activityCurve = calculateMeanMaximalPower(records, durations);
    for (let index = 0; index < curve.length; index += 1) {
      curve[index].power = Math.max(curve[index].power, activityCurve[index].power);
    }
  }
  return curve;
}

// Grade per record (fraction, e.g. 0.06 = 6%), aligned with the input array; null where unknown.
function computeGrade(records) {
  const grades = Array.isArray(records) ? records.map(() => null) : [];
  if (!Array.isArray(records) || records.length < 2) {
    return grades;
  }

  // Records use parser units: speed in km/h, altitude and distance in km.
  const samples = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] || {};
    const elapsed = asNumber(record.elapsed_time);
    const speed = asNumber(record.speed);
    const altitude = asNumber(record.altitude);
    const distance = asNumber(record.distance);
    const hasValidGpsFix = Number.isFinite(asNumber(record.position_lat))
      && Number.isFinite(asNumber(record.position_long))
      && !(asNumber(record.position_lat) === 0 && asNumber(record.position_long) === 0);

    if (Number.isFinite(elapsed) && Number.isFinite(speed) && Number.isFinite(altitude) && hasValidGpsFix) {
      samples.push({
        index: i,
        elapsed,
        speed: Math.max(0, speed) / 3.6,
        altitude: altitude * 1000,
        distance: Number.isFinite(distance) ? distance : 0,
      });
    }
  }

  if (samples.length < 2) {
    return grades;
  }

  const smoothedAltitude = smoothSeries(samples.map((s) => s.altitude), 5);

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const dt = current.elapsed - previous.elapsed;
    const speed = (previous.speed + current.speed) / 2;
    const altitudeDelta = (smoothedAltitude[index] || current.altitude) - (smoothedAltitude[index - 1] || previous.altitude);
    const distanceDeltaM = Number.isFinite(current.distance) && Number.isFinite(previous.distance)
      ? (current.distance - previous.distance) * 1000
      : NaN;
    const distanceM = Number.isFinite(distanceDeltaM) && distanceDeltaM > 0
      ? distanceDeltaM
      : speed * dt;

    grades[current.index] = {
      elapsed_time: current.elapsed,
      grade: altitudeDelta / Math.max(distanceM, 1),
      dt,
      speed,
      distanceM,
    };
  }

  return grades;
}

function estimatePowerFromMotion(records, input = {}) {
  const riderMassKg = asNumber(input.riderMassKg);
  const bikeMassKg = asNumber(input.bikeMassKg);
  const totalMassKg = riderMassKg + bikeMassKg;
  if (!Array.isArray(records) || records.length < 2
      || !Number.isFinite(riderMassKg) || riderMassKg <= 0
      || !Number.isFinite(bikeMassKg) || bikeMassKg < 0) {
    return [];
  }

  const gravity = 9.80665;
  const airDensity = Number.isFinite(asNumber(input.airDensity)) ? asNumber(input.airDensity) : 1.225;
  const rollingCoefficient = Number.isFinite(asNumber(input.rollingCoefficient))
    ? asNumber(input.rollingCoefficient) : 0.004;
  const dragArea = Number.isFinite(asNumber(input.dragArea)) ? asNumber(input.dragArea) : 0.25;
  const drivetrainEfficiency = Number.isFinite(asNumber(input.drivetrainEfficiency))
    ? asNumber(input.drivetrainEfficiency) : 0.97;
  const maxPhysiologicalPower = 1200;

  const result = [];

  for (const sample of computeGrade(records)) {
    if (!sample) {
      continue;
    }

    const { dt, speed, grade } = sample;
    // Beyond +-18% the motion model is dominated by altitude noise rather than real slope.
    if (dt <= 0 || dt > 5 || speed < 0.5 || Math.abs(grade) > 0.18) {
      continue;
    }

    const angle = Math.atan(grade);
    const gravityPower = totalMassKg * gravity * Math.sin(angle) * speed;
    const rollingPower = totalMassKg * gravity * rollingCoefficient * Math.cos(angle) * speed;
    const aerodynamicPower = 0.5 * airDensity * dragArea * speed ** 3;
    const wheelPower = Math.max(0, gravityPower + rollingPower + aerodynamicPower);
    const estimatedPower = Math.min(maxPhysiologicalPower, wheelPower / drivetrainEfficiency);

    result.push({ elapsed_time: sample.elapsed_time, power: estimatedPower });
  }

  return result;
}

function smoothSeries(values, windowSize = 5) {
  if (!Array.isArray(values) || values.length === 0) {
    return values;
  }
  const half = Math.floor(windowSize / 2);
  return values.map((_, index) => {
    const start = Math.max(0, index - half);
    const end = Math.min(values.length, index + half + 1);
    const window = values.slice(start, end).filter((v) => Number.isFinite(v));
    return window.length ? average(window) : values[index];
  });
}

function deriveSpeedsFromDistance(records) {
  if (!Array.isArray(records) || !records.length) {
    return [];
  }

  // Distance in km, elapsed in s -> speed in km/h.
  const raw = new Array(records.length).fill(Number.NaN);
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const t = asNumber(records[index]?.elapsed_time);
    const d = asNumber(records[index]?.distance);
    if (!Number.isFinite(t) || !Number.isFinite(d)) {
      continue;
    }
    if (previous) {
      const dt = t - previous.t;
      const dd = d - previous.d;
      if (dt > 0 && dt <= 30 && dd >= 0) {
        raw[index] = (dd / dt) * 3600;
      }
    }
    previous = { t, d };
  }

  return smoothSeries(raw, 5);
}

function normalizeCoordinate(raw, degreesLimit) {
  const value = asNumber(raw);
  if (!Number.isFinite(value)) {
    return NaN;
  }

  if (Math.abs(value) <= degreesLimit) {
    return value;
  }

  const fromSemicircles = (value * 180) / 2147483648;
  if (Math.abs(fromSemicircles) <= degreesLimit) {
    return fromSemicircles;
  }

  return NaN;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function gpsFixAt(records, index) {
  const record = records[index];
  if (!record || typeof record !== 'object') {
    return null;
  }
  const elapsed = asNumber(record.elapsed_time);
  const lat = normalizeCoordinate(record.position_lat, 90);
  const lon = normalizeCoordinate(record.position_long, 180);
  if (!Number.isFinite(elapsed) || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    return null;
  }
  return { elapsed, lat, lon };
}

// Speed from GPS positions only - the one signal independent of the wheel sensor.
function computeGpsDerivedSpeed(records) {
  if (!Array.isArray(records) || !records.length) {
    return [];
  }

  const raw = new Array(records.length).fill(Number.NaN);
  let previous = null;
  for (let index = 0; index < records.length; index += 1) {
    const fix = gpsFixAt(records, index);
    if (!fix) {
      continue;
    }
    if (previous) {
      const dt = fix.elapsed - previous.elapsed;
      if (dt > 0 && dt <= 30) {
        raw[index] = (haversineKm(previous.lat, previous.lon, fix.lat, fix.lon) / dt) * 3600;
      }
    }
    previous = fix;
  }

  return smoothSeries(raw, 5);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) {
    return Number.NaN;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Confidence in the recorded speed channel, per record. Defaults to 'low': GPS only earns
// trust on a long, straight, clean stretch, because drift under tree cover accumulates
// smoothly and never shows up as a single obvious jump.
function estimateSpeedConfidence(records, options = {}) {
  const verdicts = Array.isArray(records) ? records.map(() => 'low') : [];
  if (!Array.isArray(records) || records.length < 2) {
    return verdicts;
  }

  for (const window of findTrustedSpeedWindows(records, options)) {
    for (let index = window.startIndex; index <= window.endIndex; index += 1) {
      verdicts[index] = 'high';
    }
  }

  return verdicts;
}

// Shared by estimateSpeedConfidence (which only needs the index ranges) and
// estimateWheelCalibrationRatio (which also needs each window's GPS path length).
function findTrustedSpeedWindows(records, options = {}) {
  if (!Array.isArray(records) || records.length < 2) {
    return [];
  }

  const windowSeconds = Number.isFinite(asNumber(options.windowSeconds)) ? asNumber(options.windowSeconds) : 180;
  const minWindowKm = Number.isFinite(asNumber(options.minWindowKm)) ? asNumber(options.minWindowKm) : 1;
  const tolerancePct = Number.isFinite(asNumber(options.tolerancePct)) ? asNumber(options.tolerancePct) : 5;
  const ratioSpreadTolerancePct = Number.isFinite(asNumber(options.ratioSpreadTolerancePct))
    ? asNumber(options.ratioSpreadTolerancePct) : tolerancePct;
  const minStraightness = Number.isFinite(asNumber(options.minStraightness)) ? asNumber(options.minStraightness) : 0.9;
  const minCoverage = Number.isFinite(asNumber(options.minCoverage)) ? asNumber(options.minCoverage) : 0.9;
  const maxAccelerationMs2 = Number.isFinite(asNumber(options.maxAccelerationMs2))
    ? asNumber(options.maxAccelerationMs2) : 4;
  const requireAbsoluteAgreement = options.requireAbsoluteAgreement !== false;
  const minCalibrationRatio = Number.isFinite(asNumber(options.minCalibrationRatio))
    ? asNumber(options.minCalibrationRatio) : 0.7;
  const maxCalibrationRatio = Number.isFinite(asNumber(options.maxCalibrationRatio))
    ? asNumber(options.maxCalibrationRatio) : 1.4;

  const gpsSpeeds = computeGpsDerivedSpeed(records);
  const windows = [];

  let windowStart = 0;
  while (windowStart < records.length) {
    const startFix = gpsFixAt(records, windowStart);
    if (!startFix) {
      windowStart += 1;
      continue;
    }

    let windowEnd = windowStart;
    while (windowEnd + 1 < records.length) {
      const next = gpsFixAt(records, windowEnd + 1);
      if (next && next.elapsed - startFix.elapsed > windowSeconds) {
        break;
      }
      windowEnd += 1;
    }

    const evaluation = evaluateSpeedWindow(records, gpsSpeeds, windowStart, windowEnd, {
      minWindowKm,
      tolerancePct,
      ratioSpreadTolerancePct,
      minStraightness,
      minCoverage,
      maxAccelerationMs2,
      requireAbsoluteAgreement,
      minCalibrationRatio,
      maxCalibrationRatio,
    });
    if (evaluation) {
      windows.push({ startIndex: windowStart, endIndex: windowEnd, pathKm: evaluation.pathKm });
    }

    windowStart = windowEnd + 1;
  }

  return windows;
}

function evaluateSpeedWindow(records, gpsSpeeds, startIndex, endIndex, limits) {
  const fixes = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const fix = gpsFixAt(records, index);
    if (fix) {
      fixes.push({ ...fix, index });
    }
  }

  if (fixes.length < 3 || fixes.length < (endIndex - startIndex + 1) * limits.minCoverage) {
    return false;
  }

  let pathKm = 0;
  for (let i = 1; i < fixes.length; i += 1) {
    pathKm += haversineKm(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);

    const previousSpeed = asNumber(gpsSpeeds[fixes[i - 1].index]);
    const currentSpeed = asNumber(gpsSpeeds[fixes[i].index]);
    const dt = fixes[i].elapsed - fixes[i - 1].elapsed;
    if (Number.isFinite(previousSpeed) && Number.isFinite(currentSpeed) && dt > 0
      && Math.abs(currentSpeed - previousSpeed) / 3.6 > limits.maxAccelerationMs2 * dt) {
      return false;
    }
  }

  if (pathKm < limits.minWindowKm) {
    return false;
  }

  const straightKm = haversineKm(fixes[0].lat, fixes[0].lon, fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon);
  if (straightKm / pathKm < limits.minStraightness) {
    return false;
  }

  const deviations = [];
  const ratios = [];
  for (const fix of fixes) {
    const sensorSpeed = asNumber(records[fix.index]?.speed);
    const gpsSpeed = asNumber(gpsSpeeds[fix.index]);
    if (Number.isFinite(sensorSpeed) && sensorSpeed > 0 && Number.isFinite(gpsSpeed) && gpsSpeed > 0) {
      deviations.push(Math.abs(gpsSpeed - sensorSpeed) / Math.max(sensorSpeed, 1));
      ratios.push(gpsSpeed / sensorSpeed);
    }
  }

  if (ratios.length < fixes.length * limits.minCoverage) {
    return false;
  }

  const sortedRatios = ratios.sort((left, right) => left - right);
  const p10 = sortedRatios[Math.floor((sortedRatios.length - 1) * 0.1)];
  const p90 = sortedRatios[Math.ceil((sortedRatios.length - 1) * 0.9)];
  const medianRatio = median(sortedRatios);
  if (!Number.isFinite(medianRatio) || medianRatio <= 0) {
    return false;
  }

  const ratioSpreadPct = ((p90 - p10) / medianRatio) * 100;
  if (!Number.isFinite(ratioSpreadPct) || ratioSpreadPct > limits.ratioSpreadTolerancePct) {
    return false;
  }

  if (limits.requireAbsoluteAgreement) {
    return median(deviations) * 100 <= limits.tolerancePct ? { pathKm } : false;
  }

  return medianRatio >= limits.minCalibrationRatio && medianRatio <= limits.maxCalibrationRatio ? { pathKm } : false;
}

// Compares the wheel sensor's own distance channel against the GPS path on trusted windows only,
// weighted by each window's GPS distance so longer, cleaner stretches count for more.
function estimateWheelCalibrationRatio(records, options = {}) {
  if (!Array.isArray(records) || records.length < 2) {
    return null;
  }

  let weightedRatioSum = 0;
  let trustedDistanceKm = 0;

  for (const window of findTrustedSpeedWindows(records, { ...options, requireAbsoluteAgreement: false })) {
    const wheelDistanceKm = asNumber(records[window.endIndex]?.distance) - asNumber(records[window.startIndex]?.distance);
    if (!Number.isFinite(wheelDistanceKm) || wheelDistanceKm <= 0 || !(window.pathKm > 0)) {
      continue;
    }
    weightedRatioSum += (wheelDistanceKm / window.pathKm) * window.pathKm;
    trustedDistanceKm += window.pathKm;
  }

  return trustedDistanceKm > 0
    ? { ratio: weightedRatioSum / trustedDistanceKm, trustedDistanceKm }
    : null;
}

// Stops and recording gaps, so pauses stop blurring segment averages.
function detectStops(records, options = {}) {
  if (!Array.isArray(records) || !records.length) {
    return [];
  }

  const speedThresholdKmh = Number.isFinite(asNumber(options.speedThresholdKmh))
    ? asNumber(options.speedThresholdKmh) : 1;
  const minDurationSeconds = Number.isFinite(asNumber(options.minDurationSeconds))
    ? asNumber(options.minDurationSeconds) : 10;
  const gapSeconds = Number.isFinite(asNumber(options.gapSeconds)) ? asNumber(options.gapSeconds) : 10;

  const elapsedAt = (index) => asNumber(records[index]?.elapsed_time);
  const intervals = [];
  const pushInterval = (startIndex, endIndex, minimumSeconds) => {
    const startElapsed = elapsedAt(startIndex);
    const endElapsed = elapsedAt(endIndex);
    if (!Number.isFinite(startElapsed) || !Number.isFinite(endElapsed)) {
      return;
    }
    const durationS = endElapsed - startElapsed;
    if (durationS >= minimumSeconds) {
      intervals.push({ startIndex, endIndex, startElapsed, endElapsed, durationS });
    }
  };

  let runStart = null;
  for (let index = 0; index < records.length; index += 1) {
    const speed = asNumber(records[index]?.speed);
    const isStopped = Number.isFinite(speed) && speed <= speedThresholdKmh;
    if (isStopped) {
      if (runStart === null) {
        runStart = index;
      }
      continue;
    }
    if (runStart !== null) {
      pushInterval(runStart, index - 1, minDurationSeconds);
      runStart = null;
    }
  }
  if (runStart !== null) {
    pushInterval(runStart, records.length - 1, minDurationSeconds);
  }

  // A recording gap is an auto-paused stop even though no zero-speed samples exist.
  for (let index = 1; index < records.length; index += 1) {
    pushInterval(index - 1, index, gapSeconds);
  }

  intervals.sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);

  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.startIndex <= last.endIndex) {
      if (interval.endIndex > last.endIndex) {
        last.endIndex = interval.endIndex;
        last.endElapsed = interval.endElapsed;
        last.durationS = last.endElapsed - last.startElapsed;
      }
      continue;
    }
    merged.push({ ...interval });
  }

  return merged;
}

function optionNumber(options, key, fallback) {
  const value = asNumber(options?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

// Grade in percent per record: stored values win, otherwise recomputed from altitude.
function gradeSeriesPct(records, smoothWindow = 15) {
  if (!Array.isArray(records) || !records.length) {
    return [];
  }
  const computed = computeGrade(records);
  const raw = records.map((record, index) => {
    const stored = asNumber(record?.grade);
    if (Number.isFinite(stored)) {
      return stored;
    }
    const entry = computed[index];
    return entry && entry.dt > 0 && entry.dt <= 5 && entry.distanceM >= 1 ? entry.grade * 100 : Number.NaN;
  });
  return smoothSeries(raw, smoothWindow);
}

function segmentByGrade(records, options = {}) {
  if (!Array.isArray(records) || !records.length) {
    return [];
  }

  const threshold = optionNumber(options, 'gradeThresholdPct', 2.5);
  const hysteresis = optionNumber(options, 'gradeHysteresisPct', 0.5);
  const minDurationSeconds = optionNumber(options, 'minSegmentSeconds', 45);
  const grades = Array.isArray(options.grades)
    ? options.grades
    : gradeSeriesPct(records, optionNumber(options, 'gradeSmoothWindow', 15));

  const stopped = new Array(records.length).fill(false);
  for (const stop of Array.isArray(options.stops) ? options.stops : []) {
    for (let index = stop.startIndex; index <= stop.endIndex && index < records.length; index += 1) {
      stopped[index] = true;
    }
  }

  const types = new Array(records.length);
  let state = 'flat';
  for (let index = 0; index < records.length; index += 1) {
    if (stopped[index]) {
      types[index] = 'stopped';
      continue;
    }
    const grade = asNumber(grades[index]);
    if (Number.isFinite(grade)) {
      if (state === 'climb' && grade < threshold - hysteresis) {
        state = 'flat';
      } else if (state === 'descent' && grade > -(threshold - hysteresis)) {
        state = 'flat';
      }
      if (state === 'flat') {
        if (grade > threshold + hysteresis) {
          state = 'climb';
        } else if (grade < -(threshold + hysteresis)) {
          state = 'descent';
        }
      }
    }
    types[index] = state;
  }

  const runs = [];
  for (let index = 0; index < types.length; index += 1) {
    const last = runs[runs.length - 1];
    if (last && last.type === types[index]) {
      last.endIndex = index;
    } else {
      runs.push({ startIndex: index, endIndex: index, type: types[index] });
    }
  }

  return mergeShortRuns(runs, records, minDurationSeconds);
}

function rangeDurationSeconds(records, startIndex, endIndex) {
  const start = asNumber(records[startIndex]?.elapsed_time);
  const end = asNumber(records[endIndex]?.elapsed_time);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
}

function mergeShortRuns(runs, records, minDurationSeconds) {
  let current = runs.slice();
  // Each pass merges at most one run, so the budget has to come from the starting count.
  const maxPasses = runs.length + 2;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let merged = false;

    for (let index = 0; index < current.length && current.length > 1; index += 1) {
      const run = current[index];
      if (run.type === 'stopped' || rangeDurationSeconds(records, run.startIndex, run.endIndex) >= minDurationSeconds) {
        continue;
      }

      const previous = current[index - 1];
      const next = current[index + 1];
      // A brief moving stretch between two stops is stop-and-go traffic, not a segment of its own.
      const moving = [previous, next].filter((candidate) => candidate && candidate.type !== 'stopped');
      const candidates = moving.length ? moving : [previous, next].filter(Boolean);
      if (!candidates.length) {
        continue;
      }

      const target = candidates.length === 2
        && rangeDurationSeconds(records, next.startIndex, next.endIndex)
          > rangeDurationSeconds(records, previous.startIndex, previous.endIndex)
        ? next
        : candidates[0];

      if (target === previous) {
        previous.endIndex = run.endIndex;
      } else {
        target.startIndex = run.startIndex;
      }
      current.splice(index, 1);
      merged = true;
      break;
    }

    current = current.reduce((accumulator, run) => {
      const last = accumulator[accumulator.length - 1];
      if (last && last.type === run.type) {
        last.endIndex = run.endIndex;
        return accumulator;
      }
      accumulator.push({ ...run });
      return accumulator;
    }, []);

    if (!merged) {
      break;
    }
  }

  return current;
}

// Bottom-up merging: repeatedly join the adjacent pair that costs the least extra variance.
function bottomUpSegment(series, options = {}) {
  const values = (Array.isArray(series) ? series : []).map((value) => asNumber(value));
  if (values.length <= 1) {
    return values.length ? [{ start: 0, end: 0 }] : [];
  }

  const finite = values.filter((value) => Number.isFinite(value));
  const relativeNoise = optionNumber(options, 'effortRelativeNoise', 0.1);
  const costThreshold = Number.isFinite(asNumber(options.effortCostThreshold))
    ? asNumber(options.effortCostThreshold)
    : (relativeNoise * Math.abs(median(finite) || 1)) ** 2 * 3;

  const segments = values.map((value, index) => ({
    start: index,
    end: index,
    count: Number.isFinite(value) ? 1 : 0,
    sum: Number.isFinite(value) ? value : 0,
  }));

  const mergeCost = (left, right) => {
    if (!left.count || !right.count) {
      return 0;
    }
    const delta = (left.sum / left.count) - (right.sum / right.count);
    return ((left.count * right.count) / (left.count + right.count)) * delta ** 2;
  };

  while (segments.length > 1) {
    let bestIndex = -1;
    let bestCost = Infinity;
    for (let index = 0; index + 1 < segments.length; index += 1) {
      const cost = mergeCost(segments[index], segments[index + 1]);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }

    if (bestIndex < 0 || bestCost > costThreshold) {
      break;
    }

    const left = segments[bestIndex];
    const right = segments[bestIndex + 1];
    left.end = right.end;
    left.count += right.count;
    left.sum += right.sum;
    segments.splice(bestIndex + 1, 1);
  }

  return segments.map(({ start, end }) => ({ start, end }));
}

const EFFORT_SIGNAL_STRATEGIES = {
  cycling(segment, context) {
    if (segment.type === 'stopped') {
      return { basis: 'none', reason: 'stopped' };
    }
    if (segment.technical) {
      return { basis: 'none', reason: 'technical descent, speed data unreliable' };
    }
    if (context.powerSource === 'measured' && segment.hasPower) {
      return { basis: 'power', reason: 'power meter' };
    }
    if (segment.type === 'climb' && segment.hasPower
      && asNumber(segment.avgGrade) >= optionNumber(context, 'vpowerMinGradePct', 3)) {
      return { basis: 'vpower', reason: 'gravity dominates on this climb' };
    }
    if (segment.hasHeartRate) {
      return { basis: 'hr', reason: segment.hasPower ? 'vpower unreliable off the climbs' : 'no power data' };
    }
    return segment.hasPower
      ? { basis: 'vpower', reason: 'no heart-rate data' }
      : { basis: 'none', reason: 'no effort data' };
  },

  running(segment) {
    if (segment.type === 'stopped') {
      return { basis: 'none', reason: 'stopped' };
    }
    // Grade-adjusted pace is not implemented yet, so running falls back to heart rate.
    return segment.hasHeartRate
      ? { basis: 'hr', reason: 'grade-adjusted pace not available' }
      : { basis: 'none', reason: 'no effort data' };
  },

  other(segment) {
    if (segment.type === 'stopped') {
      return { basis: 'none', reason: 'stopped' };
    }
    return segment.hasHeartRate
      ? { basis: 'hr', reason: 'heart rate only for this sport' }
      : { basis: 'none', reason: 'no effort data' };
  },
};

function normalizeSport(sport) {
  const value = String(sport || '').toLowerCase();
  if (value.includes('cycl') || value.includes('bik')) {
    return 'cycling';
  }
  if (value.includes('run')) {
    return 'running';
  }
  return 'other';
}

function selectEffortSignal(segment, context = {}) {
  const strategy = EFFORT_SIGNAL_STRATEGIES[normalizeSport(context.sport)] || EFFORT_SIGNAL_STRATEGIES.other;
  return strategy(segment || {}, context);
}

function summarizeSegmentRange(records, range, shared, options) {
  const { startIndex, endIndex, type } = range;
  const speeds = [];
  const heartRates = [];
  const powers = [];
  const segmentGrades = [];
  let elevGainM = 0;
  let highConfidence = 0;
  let confidenceSamples = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const record = records[index] || {};
    const speed = asNumber(record.speed);
    const heartRate = asNumber(record.heart_rate);
    const power = asNumber(record.power);
    const grade = asNumber(shared.grades[index]);

    if (Number.isFinite(speed)) speeds.push(speed);
    if (Number.isFinite(heartRate) && heartRate > 0) heartRates.push(heartRate);
    if (Number.isFinite(power) && power >= 0) powers.push(power);
    if (Number.isFinite(grade)) segmentGrades.push(grade);

    if (index > startIndex) {
      const rise = shared.altitudesM[index] - shared.altitudesM[index - 1];
      if (Number.isFinite(rise) && rise > 0) {
        elevGainM += rise;
      }
    }

    if (shared.speedConfidence[index]) {
      confidenceSamples += 1;
      if (shared.speedConfidence[index] === 'high') {
        highConfidence += 1;
      }
    }
  }

  const avgSpeedKmh = speeds.length ? average(speeds) : Number.NaN;
  const speedSpread = speeds.length > 1 && avgSpeedKmh > 0
    ? Math.sqrt(average(speeds.map((value) => (value - avgSpeedKmh) ** 2))) / avgSpeedKmh
    : 0;
  const avgGrade = segmentGrades.length ? average(segmentGrades) : Number.NaN;
  const technical = type === 'descent'
    && avgGrade <= optionNumber(options, 'technicalGradePct', -8)
    && speedSpread >= optionNumber(options, 'technicalSpeedSpread', 0.25);
  // A stop spans either idle samples or a recording gap; averaging across it says nothing.
  const moving = type !== 'stopped';
  const startDistanceKm = asNumber(records[startIndex]?.distance);
  const endDistanceKm = asNumber(records[endIndex]?.distance);
  const distanceKm = Number.isFinite(startDistanceKm) && Number.isFinite(endDistanceKm)
    ? Math.max(0, endDistanceKm - startDistanceKm)
    : Number.NaN;

  return {
    startIndex,
    endIndex,
    type,
    startElapsed: asNumber(records[startIndex]?.elapsed_time),
    endElapsed: asNumber(records[endIndex]?.elapsed_time),
    durationS: rangeDurationSeconds(records, startIndex, endIndex),
    avgGrade: moving && Number.isFinite(avgGrade) ? roundTo(avgGrade, 1) : null,
    elevGainM: moving ? roundTo(elevGainM, 0) : null,
    distanceKm: Number.isFinite(distanceKm) ? roundTo(distanceKm, 1) : null,
    avgSpeedKmh: moving && Number.isFinite(avgSpeedKmh) ? roundTo(avgSpeedKmh, 1) : null,
    avgHr: heartRates.length ? roundTo(average(heartRates), 0) : null,
    avgPower: moving && powers.length ? roundTo(average(powers), 0) : null,
    hasHeartRate: heartRates.length > 0,
    hasPower: powers.length > 0,
    speedConfidence: confidenceSamples && highConfidence / confidenceSamples >= 0.8 ? 'high' : 'low',
    technical,
  };
}

function buildActivitySegments(records, context = {}) {
  if (!Array.isArray(records) || records.length < 2) {
    return [];
  }

  const options = context.thresholds || {};
  const stops = detectStops(records, options);
  const grades = gradeSeriesPct(records, optionNumber(options, 'gradeSmoothWindow', 15));
  const macros = segmentByGrade(records, { ...options, grades, stops });
  const shared = {
    grades,
    speedConfidence: estimateSpeedConfidence(records, options),
    altitudesM: smoothSeries(records.map((record) => {
      const altitude = asNumber(record?.altitude);
      return Number.isFinite(altitude) ? altitude * 1000 : Number.NaN;
    }), 5),
  };
  const windowSeconds = optionNumber(options, 'effortWindowSeconds', 10);
  const minSegmentSeconds = optionNumber(options, 'minSegmentSeconds', 45);
  const athlete = context.athlete || {};

  const segments = [];
  for (const macro of macros) {
    const macroSummary = summarizeSegmentRange(records, macro, shared, options);
    const effort = selectEffortSignal(macroSummary, context);

    const ranges = effort.basis === 'none'
      ? [macro]
      : splitByEffort(records, macro, effort.basis, windowSeconds, minSegmentSeconds, options);

    for (const range of ranges) {
      const summary = ranges.length === 1 ? macroSummary : summarizeSegmentRange(records, range, shared, options);
      segments.push({
        ...summary,
        effortBasis: effort.basis,
        effortReason: effort.reason,
        hrDriftPct: segmentHrDrift(records, range, summary, effort.basis, athlete, options),
      });
    }
  }

  return segments.map((segment, index) => ({ ...segment, index }));
}

// Pw:HR drift needs a trusted power signal and enough time for a half-vs-half split to mean anything.
function segmentHrDrift(records, range, summary, basis, athlete, options) {
  const minSeconds = optionNumber(options, 'hrDriftMinSeconds', 600);
  if ((basis !== 'power' && basis !== 'vpower') || summary.durationS < minSeconds) {
    return null;
  }

  const drift = calculateIntervalsDecoupling(records.slice(range.startIndex, range.endIndex + 1), {
    ftp: athlete.ftp,
    restingHeartRate: athlete.restingHeartRate,
    maxHeartRate: athlete.maxHeartRate,
  });
  return Number.isFinite(drift) ? roundTo(drift, 1) : null;
}

function splitByEffort(records, macro, basis, windowSeconds, minSegmentSeconds, options) {  const valueOf = basis === 'hr'
    ? (record) => asNumber(record?.heart_rate)
    : (record) => asNumber(record?.power);

  // A short climb or descent cannot carry enough stable windows to distinguish effort changes from vPower/HR noise.
  if (rangeDurationSeconds(records, macro.startIndex, macro.endIndex) < optionNumber(options, 'minEffortMacroSeconds', 600)) {
    return [macro];
  }

  const windows = [];
  for (let index = macro.startIndex; index <= macro.endIndex; index += 1) {
    const elapsed = asNumber(records[index]?.elapsed_time);
    const last = windows[windows.length - 1];
    if (!last || (Number.isFinite(elapsed) && Number.isFinite(last.startElapsed)
      && elapsed - last.startElapsed >= windowSeconds)) {
      windows.push({ startIndex: index, endIndex: index, startElapsed: elapsed, values: [] });
    } else {
      windows[windows.length - 1].endIndex = index;
    }
    const value = valueOf(records[index]);
    if (Number.isFinite(value)) {
      windows[windows.length - 1].values.push(value);
    }
  }

  if (windows.length < 2) {
    return [macro];
  }

  const parts = bottomUpSegment(
    windows.map((window) => (window.values.length ? average(window.values) : Number.NaN)),
    options
  ).map((part) => ({
    startIndex: windows[part.start].startIndex,
    endIndex: windows[part.end].endIndex,
    type: macro.type,
    effortValues: windows.slice(part.start, part.end + 1).flatMap((window) => window.values),
  }));

  const effortMergeTolerance = optionNumber(options, 'effortMergeTolerancePct', 12) / 100;
  const merged = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    const effort = part.effortValues.length ? average(part.effortValues) : Number.NaN;
    const previousEffort = last?.effortValues?.length ? average(last.effortValues) : Number.NaN;
    if (last && Number.isFinite(effort) && Number.isFinite(previousEffort)
      && Math.abs(effort - previousEffort) <= Math.max(effort, previousEffort) * effortMergeTolerance) {
      last.endIndex = part.endIndex;
      last.effortValues.push(...part.effortValues);
      continue;
    }
    if (last && rangeDurationSeconds(records, last.startIndex, last.endIndex) < minSegmentSeconds) {
      last.endIndex = part.endIndex;
      last.effortValues.push(...part.effortValues);
      continue;
    }
    merged.push({ ...part });
  }
  if (merged.length > 1
    && rangeDurationSeconds(records, merged[merged.length - 1].startIndex, merged[merged.length - 1].endIndex) < minSegmentSeconds) {
    merged[merged.length - 2].endIndex = merged[merged.length - 1].endIndex;
    merged.pop();
  }

  return merged.map(({ effortValues, ...part }) => part);
}

function segmentEffortValue(segment) {
  if (segment?.effortBasis === 'power' || segment?.effortBasis === 'vpower') {
    return asNumber(segment.avgPower);
  }
  if (segment?.effortBasis === 'hr') {
    return asNumber(segment.avgHr);
  }
  return Number.NaN;
}

function segmentsAreSimilar(left, right, options = {}) {
  if (!left || !right || left.type !== right.type || left.effortBasis !== right.effortBasis) {
    return false;
  }

  const durationTolerance = optionNumber(options, 'groupDurationTolerancePct', 25) / 100;
  const effortTolerance = optionNumber(options, 'groupEffortTolerancePct', 10) / 100;
  const longest = Math.max(left.durationS, right.durationS);
  if (Math.abs(left.durationS - right.durationS) > longest * durationTolerance) {
    return false;
  }

  const leftEffort = segmentEffortValue(left);
  const rightEffort = segmentEffortValue(right);
  if (!Number.isFinite(leftEffort) || !Number.isFinite(rightEffort)) {
    return true;
  }
  return Math.abs(leftEffort - rightEffort) <= Math.max(leftEffort, rightEffort) * effortTolerance;
}

// Collapses runs of near-identical segments, including alternating work/rest intervals (period 2).
function groupSimilarSegments(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const rows = [];
  let index = 0;

  const cycleRepeats = (start, period) => {
    let repeats = 1;
    while (start + (repeats + 1) * period <= list.length) {
      let matches = true;
      for (let offset = 0; offset < period && matches; offset += 1) {
        matches = segmentsAreSimilar(list[start + offset], list[start + repeats * period + offset], options);
      }
      if (!matches) {
        break;
      }
      repeats += 1;
    }
    return repeats;
  };

  while (index < list.length) {
    let best = null;
    for (const period of [1, 2]) {
      const repeats = cycleRepeats(index, period);
      const minRepeats = period === 1 ? 3 : 2;
      if (repeats >= minRepeats && (!best || repeats * period > best.repeats * best.period)) {
        best = { period, repeats };
      }
    }

    if (best) {
      rows.push({
        kind: 'repeat',
        period: best.period,
        repeats: best.repeats,
        members: list.slice(index, index + best.period * best.repeats),
      });
      index += best.period * best.repeats;
    } else {
      rows.push({ kind: 'single', segment: list[index] });
      index += 1;
    }
  }

  return rows;
}

// Not a cap to truncate at: exceeding it means the segmentation thresholds themselves misfired.
function segmentLineBudget(durationSeconds, options = {}) {
  const hours = Math.max(0, asNumber(durationSeconds) || 0) / 3600;
  const perHour = optionNumber(options, 'promptLinesPerHour', 10);
  const minLines = optionNumber(options, 'promptMinLines', 10);
  const hardCeiling = optionNumber(options, 'promptMaxLines', 150);
  return clamp(Math.round(hours * perHour), minLines, hardCeiling);
}

// A short stop (traffic light, gate) that splits one continuous stretch into two identical-type
// segments is noise for cross-activity comparison; merge it back into a single logical segment.
function collapseShortStops(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length < 3) {
    return list.slice();
  }

  const maxPauseSeconds = optionNumber(options, 'notableStopSeconds', 300);
  const weightedAverage = (a, b, weightA, weightB) => {
    if (a == null && b == null) return null;
    const totalWeight = (weightA || 0) + (weightB || 0);
    if (!totalWeight) return a ?? b;
    return roundTo(((a ?? 0) * weightA + (b ?? 0) * weightB) / totalWeight, 1);
  };
  const summedOrNull = (a, b) => (a == null && b == null ? null : roundTo((a || 0) + (b || 0), 1));

  const result = [];
  let index = 0;
  while (index < list.length) {
    const before = list[index];
    const pause = list[index + 1];
    const after = list[index + 2];
    const canMerge = before && pause && after
      && before.type !== 'stopped' && pause.type === 'stopped' && after.type === before.type
      && pause.durationS < maxPauseSeconds;

    if (canMerge) {
      const weightBefore = before.durationS || 0;
      const weightAfter = after.durationS || 0;
      result.push({
        ...before,
        endIndex: after.endIndex,
        endElapsed: after.endElapsed,
        durationS: before.durationS + pause.durationS + after.durationS,
        distanceKm: summedOrNull(before.distanceKm, after.distanceKm),
        elevGainM: summedOrNull(before.elevGainM, after.elevGainM),
        avgGrade: weightedAverage(before.avgGrade, after.avgGrade, weightBefore, weightAfter),
        avgSpeedKmh: weightedAverage(before.avgSpeedKmh, after.avgSpeedKmh, weightBefore, weightAfter),
        avgHr: weightedAverage(before.avgHr, after.avgHr, weightBefore, weightAfter),
        avgPower: weightedAverage(before.avgPower, after.avgPower, weightBefore, weightAfter),
        pausedS: pause.durationS,
      });
      index += 3;
    } else {
      result.push(before);
      index += 1;
    }
  }
  return result;
}

function normalizeRecordSpeeds(records) {
  if (!Array.isArray(records) || !records.length) {
    return [];
  }

  const withEnhanced = records.map((record) => {
    if (!record || typeof record !== 'object') {
      return record;
    }
    const speed = asNumber(record.speed);
    const enhancedSpeed = asNumber(record.enhanced_speed);
    const altitude = asNumber(record.altitude);
    const enhancedAltitude = asNumber(record.enhanced_altitude);
    const useEnhancedSpeed = !(Number.isFinite(speed) && speed > 0)
      && Number.isFinite(enhancedSpeed) && enhancedSpeed > 0;
    const useEnhancedAltitude = !Number.isFinite(altitude) && Number.isFinite(enhancedAltitude);
    if (!useEnhancedSpeed && !useEnhancedAltitude) {
      return record;
    }
    return {
      ...record,
      ...(useEnhancedSpeed ? { speed: enhancedSpeed } : {}),
      ...(useEnhancedAltitude ? { altitude: enhancedAltitude } : {}),
    };
  });

  const derived = deriveSpeedsFromDistance(withEnhanced);
  return withEnhanced.map((record, index) => {
    const speed = asNumber(record?.speed);
    const derivedSpeed = derived[index];
    if (Number.isFinite(speed) && speed > 0) {
      return record;
    }
    if (!Number.isFinite(derivedSpeed)) {
      return record;
    }
    if (!Number.isFinite(speed)) {
      return { ...record, speed: derivedSpeed };
    }
    // Recorded 0 is trusted unless distance clearly advances (broken speed channel).
    return derivedSpeed > 1 ? { ...record, speed: derivedSpeed } : record;
  });
}

const STOPPED_SPEED_KMH = 1.8;

function addEstimatedPowerWhenMissing(records, input = {}) {
  if (!Array.isArray(records) || records.some((record) => {
    const power = asNumber(record?.power);
    return Number.isFinite(power) && power >= 0;
  })) {
    return { records, source: 'measured' };
  }

  const estimates = estimatePowerFromMotion(records, input);
  if (!estimates.length) {
    return { records, source: 'unavailable' };
  }

  const estimatedPowerByElapsed = new Map(estimates.map((estimate) => [estimate.elapsed_time, estimate.power]));
  return {
    records: records.map((record) => {
      const estimated = estimatedPowerByElapsed.get(asNumber(record?.elapsed_time));
      if (estimated !== undefined) {
        return { ...record, power: estimated };
      }
      // Standing still is a measurement of zero work, not a hole in the data. Leaving it
      // undefined would drop the stop from NP/TSS entirely and inflate them.
      const speed = asNumber(record?.speed);
      if (Number.isFinite(speed) && speed < STOPPED_SPEED_KMH) {
        return { ...record, power: 0 };
      }
      return record;
    }),
    source: 'estimated',
  };
}

function estimateFtpCandidates(mmpCurve) {
  const points = (Array.isArray(mmpCurve) ? mmpCurve : Object.entries(mmpCurve || {})
    .map(([durationSec, power]) => ({ durationSec: Number(durationSec), power })))
    .map((point) => ({
      durationSec: asNumber(point.durationSec),
      power: asNumber(point.power),
    }))
    .filter((point) => Number.isFinite(point.durationSec)
      && point.durationSec > 0
      && Number.isFinite(point.power)
      && point.power > 0);
  const candidates = {};

  if (points.length >= 3) {
    const xMean = average(points.map((point) => 1 / point.durationSec));
    const yMean = average(points.map((point) => point.power));
    const denominator = points.reduce((sum, point) => sum + ((1 / point.durationSec) - xMean) ** 2, 0);
    if (denominator > 0) {
      const slope = points.reduce((sum, point) => (
        sum + ((1 / point.durationSec) - xMean) * (point.power - yMean)
      ), 0) / denominator;
      const cp = yMean - slope * xMean;
      const totalSquares = points.reduce((sum, point) => sum + (point.power - yMean) ** 2, 0);
      const residualSquares = points.reduce((sum, point) => {
        const predicted = cp + slope / point.durationSec;
        return sum + (point.power - predicted) ** 2;
      }, 0);
      const rSquared = totalSquares > 0 ? 1 - residualSquares / totalSquares : 0;
      if (Number.isFinite(cp) && cp > 0 && Number.isFinite(slope) && slope >= 0 && rSquared >= 0.85) {
        candidates.cp_derived = cp * 0.97;
        candidates.cp = cp;
        candidates.w_prime = slope;
        candidates.r_squared = rSquared;
      }
    }
  }

  const byDuration = new Map(points.map((point) => [point.durationSec, point.power]));
  if (byDuration.has(3600)) {
    candidates.mmp_60min = byDuration.get(3600);
  } else if (byDuration.has(3300) || byDuration.has(3000)) {
    const durationSec = byDuration.has(3300) ? 3300 : 3000;
    candidates.mmp_close_to_60min = byDuration.get(durationSec);
  }
  if (byDuration.has(1200)) {
    candidates['20min_proxy'] = byDuration.get(1200) * 0.95;
  }

  return candidates;
}

function selectFtpEstimate(candidates) {
  const keys = ['cp_derived', 'mmp_60min', 'mmp_close_to_60min', '20min_proxy'];
  for (const key of keys) {
    const value = asNumber(candidates?.[key]);
    if (Number.isFinite(value) && value >= 80 && value <= 500) {
      return Math.round(value);
    }
  }
  return 0;
}

function calculateXPower(records) {
  if (!Array.isArray(records) || !records.length) {
    return null;
  }

  const samples = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] || {};
    const power = asNumber(record.power);
    if (!Number.isFinite(power) || power < 0) {
      continue;
    }
    const elapsed = asNumber(record.elapsed_time);
    samples.push({
      t: Number.isFinite(elapsed) ? elapsed : index,
      p: power,
    });
  }

  if (!samples.length) {
    return null;
  }

  // GoldenCheetah-style xPower uses an exponentially-weighted power trace (~25s time constant),
  // then 4th-power averaging and 4th root.
  const tauSeconds = 25;
  let filtered = samples[0].p;
  const fourthPowers = [filtered ** 4];

  for (let index = 1; index < samples.length; index += 1) {
    const dtRaw = samples[index].t - samples[index - 1].t;
    const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? Math.min(dtRaw, 30) : 1;
    const alpha = 1 - Math.exp(-dt / tauSeconds);
    filtered += alpha * (samples[index].p - filtered);
    fourthPowers.push(filtered ** 4);
  }

  const meanFourthPower = weightedMean(fourthPowers, sampleDurations(samples));
  return meanFourthPower > 0 ? meanFourthPower ** 0.25 : null;
}

function calculateIntensityFactor(normalizedPower, ftp) {
  const np = asNumber(normalizedPower);
  const threshold = asNumber(ftp);
  if (!Number.isFinite(np) || np <= 0 || !Number.isFinite(threshold) || threshold <= 0) {
    return null;
  }
  return np / threshold;
}

function calculateTrainingStressScore(durationSec, normalizedPower, intensityFactor, ftp) {
  const duration = asNumber(durationSec);
  const np = asNumber(normalizedPower);
  const ifValue = asNumber(intensityFactor);
  const threshold = asNumber(ftp);
  if (!Number.isFinite(duration) || duration <= 0
      || !Number.isFinite(np) || np <= 0
      || !Number.isFinite(ifValue) || ifValue <= 0
      || !Number.isFinite(threshold) || threshold <= 0) {
    return null;
  }
  return ((duration * np * ifValue) / (threshold * 3600)) * 100;
}

function calculateBikeStressScore(durationSec, xPower, relativeIntensity, ftp) {
  return calculateTrainingStressScore(durationSec, xPower, relativeIntensity, ftp);
}

function calculateIntervalsDecoupling(records, input) {
  const ftp = asNumber(input?.ftp);
  const restingHeartRate = asNumber(input?.restingHeartRate);
  const maxHeartRate = asNumber(input?.maxHeartRate);
  if (!Array.isArray(records) || records.length < 10
      || !Number.isFinite(ftp) || ftp <= 0
      || !Number.isFinite(restingHeartRate)
      || !Number.isFinite(maxHeartRate)
      || maxHeartRate <= restingHeartRate) {
    return null;
  }

  const samples = [];
  for (let i = 0; i < records.length; i += 1) {
    const t = asNumber(records[i]?.elapsed_time);
    const p = asNumber(records[i]?.power);
    const hr = asNumber(records[i]?.heart_rate);
    if (!Number.isFinite(t) || !Number.isFinite(p) || !Number.isFinite(hr) || p < 0 || hr <= 0) {
      continue;
    }
    samples.push({ t, p, hr });
  }

  if (samples.length < 10) {
    return null;
  }

  const powerSeries = despikeSeries(samples.map((s) => s.p), { absThreshold: 250, ratioThreshold: 0.6 });
  const hrSeries = despikeSeries(samples.map((s) => s.hr), { absThreshold: 25, ratioThreshold: 0.25 });
  const smoothedPower = trailingTimeMovingAverage(samples.map((s, i) => ({ t: s.t, v: powerSeries[i] })), 60);
  const smoothedHr = trailingTimeMovingAverage(samples.map((s, i) => ({ t: s.t, v: hrSeries[i] })), 60);

  const hrDenominator = maxHeartRate - restingHeartRate;
  const efficiencies = [];
  for (let i = 0; i < samples.length; i += 1) {
    const powerReservePct = clamp(smoothedPower[i] / ftp, 0, 2);
    const hrReservePct = clamp((smoothedHr[i] - restingHeartRate) / hrDenominator, 0, 2);
    if (powerReservePct < 0.05 || hrReservePct <= 0) {
      continue;
    }
    efficiencies.push({ t: samples[i].t, value: hrReservePct / powerReservePct });
  }

  if (efficiencies.length < 8) {
    return null;
  }

  const firstTime = efficiencies[0].t;
  const lastTime = efficiencies[efficiencies.length - 1].t;
  const midpoint = firstTime + (lastTime - firstTime) / 2;
  const firstHalf = efficiencies.filter((sample) => sample.t <= midpoint).map((sample) => sample.value);
  const secondHalf = efficiencies.filter((sample) => sample.t > midpoint).map((sample) => sample.value);

  if (firstHalf.length < 4 || secondHalf.length < 4) {
    return null;
  }

  const firstAvg = average(firstHalf);
  const secondAvg = average(secondHalf);
  if (!Number.isFinite(firstAvg) || firstAvg <= 0 || !Number.isFinite(secondAvg)) {
    return null;
  }

  return ((secondAvg - firstAvg) / firstAvg) * 100;
}

// Seconds each sample stands for. Capped so that the single sample after a recording gap
// does not outweigh the whole ride; uniform 1 Hz data comes out as all-ones.
function sampleDurations(samples, maxGapSeconds = 5) {
  return samples.map((sample, index) => {
    if (index === 0) {
      return 1;
    }
    const dt = sample.t - samples[index - 1].t;
    return Number.isFinite(dt) && dt > 0 ? Math.min(dt, maxGapSeconds) : 1;
  });
}

function weightedMean(values, weights) {
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const weight = weights[index];
    if (!Number.isFinite(value) || !(weight > 0)) {
      continue;
    }
    weighted += value * weight;
    total += weight;
  }
  return total > 0 ? weighted / total : Number.NaN;
}

function trailingTimeMovingAverage(samples, windowSeconds) {
  const result = new Array(samples.length).fill(0);
  const durations = sampleDurations(samples);
  let start = 0;
  let weightedSum = 0;
  let weightSum = 0;

  for (let end = 0; end < samples.length; end += 1) {
    weightedSum += samples[end].v * durations[end];
    weightSum += durations[end];
    const minTime = samples[end].t - windowSeconds;
    while (start < end && samples[start].t <= minTime) {
      weightedSum -= samples[start].v * durations[start];
      weightSum -= durations[start];
      start += 1;
    }
    result[end] = weightSum > 0 ? weightedSum / weightSum : 0;
  }

  return result;
}

function despikeSeries(values, limits) {
  const fixed = values.slice();
  const absThreshold = Number.isFinite(limits?.absThreshold) ? limits.absThreshold : 100;
  const ratioThreshold = Number.isFinite(limits?.ratioThreshold) ? limits.ratioThreshold : 0.5;

  for (let i = 1; i < fixed.length - 1; i += 1) {
    const prev = fixed[i - 1];
    const curr = fixed[i];
    const next = fixed[i + 1];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || !Number.isFinite(next)) {
      continue;
    }

    const baseline = (prev + next) / 2;
    const absDelta = Math.abs(curr - baseline);
    const ratioDelta = absDelta / Math.max(1, Math.abs(baseline));
    const neighborsClose = Math.abs(next - prev) / Math.max(1, Math.abs(baseline)) < ratioThreshold;
    if (neighborsClose && absDelta > absThreshold && ratioDelta > ratioThreshold) {
      fixed[i] = baseline;
    }
  }

  return fixed;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function calculateBanisterTrimp(input) {
  const durationSec = asNumber(input?.durationSec);
  const avgHeartRate = asNumber(input?.avgHeartRate);
  const restingHeartRate = asNumber(input?.restingHeartRate);
  const maxHeartRate = asNumber(input?.maxHeartRate);
  const sex = String(input?.sex || '').toLowerCase();

  if (!Number.isFinite(durationSec) || durationSec <= 0
      || !Number.isFinite(avgHeartRate)
      || !Number.isFinite(restingHeartRate)
      || !Number.isFinite(maxHeartRate)
      || maxHeartRate <= restingHeartRate) {
    return null;
  }

  const deltaHrRatio = (avgHeartRate - restingHeartRate) / (maxHeartRate - restingHeartRate);
  const clampedRatio = Math.max(0, Math.min(1.5, deltaHrRatio));
  const durationMin = durationSec / 60;

  const male = { coeff: 0.64, exponent: 1.92 };
  const female = { coeff: 0.86, exponent: 1.67 };
  const factors = sex === 'female'
    ? female
    : sex === 'male'
      ? male
      : { coeff: (male.coeff + female.coeff) / 2, exponent: (male.exponent + female.exponent) / 2 };

  return durationMin * clampedRatio * factors.coeff * Math.exp(factors.exponent * clampedRatio);
}

function calculateHrTss(input) {
  const durationSec = asNumber(input?.durationSec);
  const avgHeartRate = asNumber(input?.avgHeartRate);
  const restingHeartRate = asNumber(input?.restingHeartRate);
  const maxHeartRate = asNumber(input?.maxHeartRate);
  if (!Number.isFinite(durationSec) || durationSec <= 0
      || !Number.isFinite(avgHeartRate)
      || !Number.isFinite(restingHeartRate)
      || !Number.isFinite(maxHeartRate)
      || maxHeartRate <= restingHeartRate) {
    return null;
  }

  const relativeIntensity = (avgHeartRate - restingHeartRate) / (maxHeartRate - restingHeartRate);
  const clampedIntensity = Math.max(0, Math.min(1.5, relativeIntensity));
  const durationHours = durationSec / 3600;
  return durationHours * (clampedIntensity ** 2) * 100;
}

function maxOrZero(values) {
  return values.length ? Math.max(...values) : 0;
}

function asNumber(value) {
  if (value == null || value === '') {
    return Number.NaN;
  }
  return typeof value === 'number' ? value : Number(value);
}

function toSqlStr(value) {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = {
  addEstimatedPowerWhenMissing,
  asNumber,
  average,
  calculateBanisterTrimp,
  calculateAutoFtp,
  deriveSpeedsFromDistance,
  despikeSeries,
  normalizeRecordSpeeds,
  smoothSeries,
  calculateBikeStressScore,
  calculateHrTss,
  calculateIntensityFactor,
  calculateIntervalsDecoupling,
  calculateHistoricalMeanMaximalPower,
  calculateMeanMaximalPower,
  calculateNormalizedPower,
  bottomUpSegment,
  buildActivitySegments,
  collapseShortStops,
  computeGpsDerivedSpeed,
  computeGrade,
  detectStops,
  estimateFtpCandidates,
  estimatePowerFromMotion,
  estimateSpeedConfidence,
  estimateWheelCalibrationRatio,
  groupSimilarSegments,
  haversineKm,
  normalizeCoordinate,
  segmentByGrade,
  segmentLineBudget,
  selectEffortSignal,
  selectFtpEstimate,
  calculateTrainingStressScore,
  calculateXPower,
  createNonce,
  downsamplePoints,
  escapeHtml,
  estimateDuration,
  formatHms,
  formatNumber,
  maxOrZero,
  roundTo,
  safeJson,
  toDateOnly,
  toSqlStr,
};
