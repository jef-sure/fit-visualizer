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

  const rollingFourthPowers = [];
  let start = 0;
  let rollingSum = 0;
  for (let end = 0; end < samples.length; end += 1) {
    rollingSum += samples[end].p;
    const minTime = samples[end].t - 30;
    while (start < end && samples[start].t <= minTime) {
      rollingSum -= samples[start].p;
      start += 1;
    }

    const windowSize = end - start + 1;
    const rollingAverage = rollingSum / windowSize;
    rollingFourthPowers.push(rollingAverage ** 4);
  }

  const meanFourthPower = average(rollingFourthPowers);
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
  asNumber,
  average,
  calculateBanisterTrimp,
  calculateAutoFtp,
  calculateBikeStressScore,
  calculateHrTss,
  calculateIntensityFactor,
  calculateIntervalsDecoupling,
  calculateNormalizedPower,
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
