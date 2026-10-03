const HEART_RATE_ZONES = Object.freeze([
  { name: 'Recovery', low: 0.50, high: 0.60 },
  { name: 'Endurance', low: 0.60, high: 0.70 },
  { name: 'Tempo', low: 0.70, high: 0.80 },
  { name: 'Threshold', low: 0.80, high: 0.90 },
  { name: 'VO2max', low: 0.90, high: Number.POSITIVE_INFINITY },
]);

function computeHeartRateZones(records, maxHeartRate, customThresholds, options = {}) {
  if (!Number.isFinite(maxHeartRate) || maxHeartRate <= 0) {
    return {
      enabled: false,
      maxHeartRate: null,
      zones: [],
    };
  }

  const zoneSeconds = HEART_RATE_ZONES.map(() => 0);
  const durations = estimateRecordDurations(records);
  const thresholds = normalizeThresholds(maxHeartRate, customThresholds);
  // Zone 1's floor follows the same reserve the auto profile uses when a resting HR is known,
  // so the Karvonen thresholds and the 50 % HRmax floor stop contradicting each other.
  const restingHeartRate = Number(options.restingHeartRate);
  const zoneFloorBpm = Number.isFinite(restingHeartRate) && restingHeartRate > 0 && restingHeartRate < maxHeartRate
    ? Math.round(restingHeartRate + HEART_RATE_ZONES[0].low * (maxHeartRate - restingHeartRate))
    : Math.round(HEART_RATE_ZONES[0].low * maxHeartRate);
  let totalSeconds = 0;

  for (let index = 0; index < records.length; index += 1) {
    const heartRate = Number(records[index].heart_rate);
    const seconds = durations[index] || 0;
    if (!Number.isFinite(heartRate) || heartRate <= 0 || seconds <= 0) {
      continue;
    }

    const zoneIndex = getHeartRateZoneIndex(heartRate, thresholds);
    if (heartRate >= zoneFloorBpm) {
      zoneSeconds[zoneIndex] += seconds;
      totalSeconds += seconds;
    }
  }

  const zones = HEART_RATE_ZONES.map((zone, index) => {
    const lowerBpm = index === 0 ? zoneFloorBpm : Math.round(thresholds[index - 1]);
    const upperBpm = index < thresholds.length ? Math.round(thresholds[index]) - 1 : Math.round(maxHeartRate);
    const seconds = zoneSeconds[index];

    return {
      name: zone.name,
      range: `${lowerBpm}-${upperBpm} bpm`,
      seconds,
      percent: totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0,
    };
  });

  return {
    enabled: true,
    maxHeartRate: Math.round(maxHeartRate),
    thresholds,
    customThresholds: Array.isArray(customThresholds),
    zones,
    totalSeconds,
  };
}

function normalizeThresholds(maxHeartRate, customThresholds) {
  if (Array.isArray(customThresholds)
      && customThresholds.length === 4
      && customThresholds.every((value) => Number.isFinite(value))
      && customThresholds.every((value, index) => index === 0 || value > customThresholds[index - 1])
      && customThresholds[3] <= maxHeartRate) {
    return [...customThresholds];
  }
  return getHeartRateThresholds(maxHeartRate);
}

function getHeartRateThresholds(maxHeartRate) {
  return HEART_RATE_ZONES.slice(1).map((zone) => zone.low * maxHeartRate);
}

function getHeartRateZoneIndex(heartRate, thresholds) {
  for (let index = 0; index < thresholds.length; index += 1) {
    if (heartRate < thresholds[index]) {
      return index;
    }
  }
  return thresholds.length;
}

function estimateRecordDurations(records) {
  if (!records.length) {
    return [];
  }

  const elapsed = records.map((record) => Number(record.elapsed_time));
  const durations = new Array(records.length).fill(1);
  const validDeltas = [];

  for (let index = 1; index < elapsed.length; index += 1) {
    const delta = elapsed[index] - elapsed[index - 1];
    if (Number.isFinite(delta) && delta > 0 && delta <= 30) {
      durations[index - 1] = delta;
      validDeltas.push(delta);
    }
  }

  const fallback = median(validDeltas) || 1;
  durations[durations.length - 1] = fallback;
  return durations.map((duration) => (
    Number.isFinite(duration) && duration > 0 && duration <= 30 ? duration : fallback
  ));
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calculateAutoHeartRateProfile(input) {
  const sex = String(input?.sex || '').toLowerCase();
  const age = Number(input?.age);
  const restingHeartRate = Number(input?.restingHeartRate);
  const observedMaxHeartRate = Number(input?.observedMaxHeartRate);

  if (!['male', 'female', 'other'].includes(sex)) {
    throw new Error('Sex must be male, female, or other.');
  }
  if (!Number.isFinite(age) || age < 10 || age > 100) {
    throw new Error('Age must be between 10 and 100.');
  }
  if (!Number.isFinite(restingHeartRate) || restingHeartRate < 30 || restingHeartRate > 120) {
    throw new Error('Resting heart rate must be between 30 and 120 bpm.');
  }

  const formulaMax = Math.round(getFormulaMaxHeartRate(age));
  const observed = Number.isFinite(observedMaxHeartRate) && observedMaxHeartRate >= 100
    ? Math.round(observedMaxHeartRate)
    : null;
  const maxHeartRate = Math.max(formulaMax, observed || 0);
  const reserve = Math.max(1, maxHeartRate - restingHeartRate);
  const intensities = [0.6, 0.7, 0.8, 0.9];
  const thresholds = intensities.map((intensity) => Math.round(restingHeartRate + reserve * intensity));

  // Ensure strictly increasing integer thresholds and clamp to max HR.
  for (let index = 1; index < thresholds.length; index += 1) {
    if (thresholds[index] <= thresholds[index - 1]) {
      thresholds[index] = thresholds[index - 1] + 1;
    }
  }
  thresholds[thresholds.length - 1] = Math.min(thresholds[thresholds.length - 1], maxHeartRate);

  return {
    maxHeartRate,
    thresholds,
    formulaMaxHeartRate: formulaMax,
    observedMaxHeartRate: observed,
    method: 'karvonen',
  };
}

// Proxy for lactate-threshold HR. A directly tested value wins; otherwise the middle of the
// Threshold zone (custom or Karvonen thresholds), and only without thresholds does 85 % of
// the reserve (resting HR known) or of max HR stand in.
function estimateLactateThresholdHeartRate(maxHeartRate, thresholds, restingHeartRate, testedLthr) {
  const tested = Number(testedLthr);
  if (Number.isFinite(tested) && tested >= 100 && tested <= 240) {
    return Math.round(tested);
  }
  const max = Number(maxHeartRate);
  if (!Number.isFinite(max) || max <= 0) {
    return null;
  }
  if (Array.isArray(thresholds) && thresholds.length === 4 && thresholds.every((value) => Number.isFinite(Number(value)))) {
    return Math.round((Number(thresholds[2]) + Number(thresholds[3])) / 2);
  }
  const rest = Number(restingHeartRate);
  if (Number.isFinite(rest) && rest > 0 && rest < max) {
    return Math.round(rest + 0.85 * (max - rest));
  }
  return Math.round(max * 0.85);
}

function getFormulaMaxHeartRate(age) {
  return 208 - (0.7 * age);
}

const PEAK_HEART_RATE_WINDOWS = Object.freeze([60, 300, 1200, 3600]);

// Highest time-weighted HR per window; missing HR or a recording gap over 30 s breaks the window.
function calculatePeakHeartRates(records, windows = PEAK_HEART_RATE_WINDOWS) {
  const list = Array.isArray(records) ? records : [];
  const durations = estimateRecordDurations(list);
  const runs = [];
  let run = [];
  for (let index = 0; index < list.length; index += 1) {
    const heartRate = Number(list[index].heart_rate);
    if (!Number.isFinite(heartRate) || heartRate <= 0) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push({ heartRate, seconds: durations[index] });
    const gap = Number(list[index + 1]?.elapsed_time) - Number(list[index].elapsed_time);
    if (Number.isFinite(gap) && (gap <= 0 || gap > 30)) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  return windows.map((windowSeconds) => {
    let best = null;
    for (const samples of runs) {
      let start = 0;
      let seconds = 0;
      let weighted = 0;
      for (const sample of samples) {
        seconds += sample.seconds;
        weighted += sample.heartRate * sample.seconds;
        while (seconds - samples[start].seconds >= windowSeconds) {
          seconds -= samples[start].seconds;
          weighted -= samples[start].heartRate * samples[start].seconds;
          start += 1;
        }
        if (seconds >= windowSeconds && (best === null || weighted / seconds > best)) best = weighted / seconds;
      }
    }
    return best === null ? null : { seconds: windowSeconds, bpm: Math.round(best) };
  }).filter(Boolean);
}

module.exports = {
  calculateAutoHeartRateProfile,
  calculatePeakHeartRates,
  estimateLactateThresholdHeartRate,
  HEART_RATE_ZONES,
  PEAK_HEART_RATE_WINDOWS,
  computeHeartRateZones,
  getHeartRateZoneIndex,
};
