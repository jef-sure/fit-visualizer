const HEART_RATE_ZONES = Object.freeze([
  { name: 'Recovery', low: 0.50, high: 0.60 },
  { name: 'Endurance', low: 0.60, high: 0.70 },
  { name: 'Aerobic', low: 0.70, high: 0.80 },
  { name: 'Anaerobic', low: 0.80, high: 0.90 },
  { name: 'Max', low: 0.90, high: Number.POSITIVE_INFINITY },
]);

function computeHeartRateZones(records, maxHeartRate, customThresholds) {
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
  let totalSeconds = 0;

  for (let index = 0; index < records.length; index += 1) {
    const heartRate = Number(records[index].heart_rate);
    const seconds = durations[index] || 0;
    if (!Number.isFinite(heartRate) || heartRate <= 0 || seconds <= 0) {
      continue;
    }

    const zoneIndex = getHeartRateZoneIndex(heartRate, thresholds);
    if (heartRate >= HEART_RATE_ZONES[0].low * maxHeartRate) {
      zoneSeconds[zoneIndex] += seconds;
      totalSeconds += seconds;
    }
  }

  const zones = HEART_RATE_ZONES.map((zone, index) => {
    const lowerBpm = index === 0 ? Math.round(zone.low * maxHeartRate) : Math.round(thresholds[index - 1]);
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

  const formulaMax = Math.round(getFormulaMaxHeartRate(sex, age));
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

function getFormulaMaxHeartRate(sex, age) {
  if (sex === 'female') {
    return 226 - age;
  }
  if (sex === 'male') {
    return 220 - age;
  }
  return 223 - age;
}

module.exports = {
  calculateAutoHeartRateProfile,
  HEART_RATE_ZONES,
  computeHeartRateZones,
  getHeartRateZoneIndex,
};
