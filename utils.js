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

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateNormalizedPower(records) {
  if (!Array.isArray(records) || !records.length) {
    return 0;
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
    return 0;
  }

  // Coggan NP: 30s rolling average first, then 4th-power mean and 4th root.
  const rolling = trailingTimeMovingAverage(samples, 30);
  const meanFourthPower = average(rolling.map((value) => value ** 4));
  return meanFourthPower > 0 ? meanFourthPower ** 0.25 : 0;
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

  const samples = [];
  // Records use parser units: speed in km/h, altitude and distance in km.
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
        elapsed,
        speed: Math.max(0, speed) / 3.6,
        altitude: altitude * 1000,
        distance: Number.isFinite(distance) ? distance : 0,
      });
    }
  }

  if (samples.length < 2) {
    return [];
  }

  const smoothedAltitude = smoothSeries(samples.map((s) => s.altitude), 5);
  const result = [];

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const dt = current.elapsed - previous.elapsed;
    const speed = (previous.speed + current.speed) / 2;

    if (dt <= 0 || dt > 5 || speed < 0.5) {
      continue;
    }

    const altitudeDelta = (smoothedAltitude[index] || current.altitude) - (smoothedAltitude[index - 1] || previous.altitude);
    const distanceDeltaM = Number.isFinite(current.distance) && Number.isFinite(previous.distance)
      ? (current.distance - previous.distance) * 1000
      : NaN;
    const distanceM = Number.isFinite(distanceDeltaM) && distanceDeltaM > 0
      ? distanceDeltaM
      : speed * dt;

    const rawGrade = altitudeDelta / Math.max(distanceM, 1);
    if (Math.abs(rawGrade) > 0.18) {
      continue;
    }

    const grade = Math.max(-0.18, Math.min(0.18, rawGrade));
    const angle = Math.atan(grade);

    const gravityPower = totalMassKg * gravity * Math.sin(angle) * speed;
    const rollingPower = totalMassKg * gravity * rollingCoefficient * Math.cos(angle) * speed;
    const aerodynamicPower = 0.5 * airDensity * dragArea * speed ** 3;
    const wheelPower = Math.max(0, gravityPower + rollingPower + aerodynamicPower);
    const estimatedPower = Math.min(maxPhysiologicalPower, wheelPower / drivetrainEfficiency);

    result.push({ elapsed_time: current.elapsed, power: estimatedPower });
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
    records: records.map((record) => ({
      ...record,
      power: estimatedPowerByElapsed.get(asNumber(record?.elapsed_time)) ?? record?.power,
    })),
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
    return 0;
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
    return 0;
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

  const meanFourthPower = average(fourthPowers);
  return meanFourthPower > 0 ? meanFourthPower ** 0.25 : 0;
}

function calculateIntensityFactor(normalizedPower, ftp) {
  const np = asNumber(normalizedPower);
  const threshold = asNumber(ftp);
  if (!Number.isFinite(np) || np <= 0 || !Number.isFinite(threshold) || threshold <= 0) {
    return 0;
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
    return 0;
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
    return 0;
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
    return 0;
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
    return 0;
  }

  const firstTime = efficiencies[0].t;
  const lastTime = efficiencies[efficiencies.length - 1].t;
  const midpoint = firstTime + (lastTime - firstTime) / 2;
  const firstHalf = efficiencies.filter((sample) => sample.t <= midpoint).map((sample) => sample.value);
  const secondHalf = efficiencies.filter((sample) => sample.t > midpoint).map((sample) => sample.value);

  if (firstHalf.length < 4 || secondHalf.length < 4) {
    return 0;
  }

  const firstAvg = average(firstHalf);
  const secondAvg = average(secondHalf);
  if (!Number.isFinite(firstAvg) || firstAvg <= 0 || !Number.isFinite(secondAvg)) {
    return 0;
  }

  return ((secondAvg - firstAvg) / firstAvg) * 100;
}

function trailingTimeMovingAverage(samples, windowSeconds) {
  const result = new Array(samples.length).fill(0);
  let start = 0;
  let rollingSum = 0;

  for (let end = 0; end < samples.length; end += 1) {
    rollingSum += samples[end].v;
    const minTime = samples[end].t - windowSeconds;
    while (start < end && samples[start].t <= minTime) {
      rollingSum -= samples[start].v;
      start += 1;
    }
    const size = end - start + 1;
    result[end] = size > 0 ? rollingSum / size : 0;
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
    return 0;
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
    return 0;
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
  estimateFtpCandidates,
  estimatePowerFromMotion,
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
  toSqlStr,
};
