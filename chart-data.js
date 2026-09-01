const { asNumber, downsamplePoints, haversineKm, normalizeCoordinate, smoothSeries } = require('./utils');

function extractXYPoints(records, xField, yField, maxPoints, transforms) {
  const points = [];
  const yValues = [];
  const xTransform = transforms?.xTransform || ((value) => value);
  const yTransform = transforms?.yTransform || ((value) => value);
  for (const record of records) {
    const xRaw = asNumber(record[xField]);
    const yRaw = asNumber(record[yField]);
    if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;
    const x = xTransform(xRaw);
    const y = yTransform(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
    yValues.push(y);
  }
  return { points: downsamplePoints(points, maxPoints), yValues };
}

function extractGpsPoints(records) {
  const points = [];
  for (const record of records) {
    const lat = normalizeCoordinate(record.position_lat, 90);
    const lon = normalizeCoordinate(record.position_long, 180);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    points.push({
      x: lon,
      y: lat,
      speed: asNumber(record.speed),
      heart_rate: asNumber(record.heart_rate),
      elapsed_time: asNumber(record.elapsed_time),
    });
  }
  return points;
}

function computeElevationGainLoss(altitudesM) {
  if (!altitudesM.length) return { gain: 0, loss: 0 };
  const smoothed = smoothSeries(altitudesM, 5);
  const hysteresisM = 3;
  let gain = 0;
  let loss = 0;
  let reference = smoothed[0];
  for (let index = 1; index < smoothed.length; index += 1) {
    const delta = smoothed[index] - reference;
    if (delta >= hysteresisM) {
      gain += delta;
      reference = smoothed[index];
    } else if (delta <= -hysteresisM) {
      loss -= delta;
      reference = smoothed[index];
    }
  }
  return { gain, loss };
}

function percentileFromSorted(sortedValues, percentile) {
  if (!sortedValues.length) return 0;
  const index = ((sortedValues.length - 1) * Math.max(0, Math.min(100, percentile))) / 100;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sortedValues[lo];
  const weight = index - lo;
  return sortedValues[lo] * (1 - weight) + sortedValues[hi] * weight;
}

function computeStats(values) {
  if (!values.length) return { count: 0, min: 0, max: 0, avg: 0, median: 0, p95: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentileFromSorted(sorted, 50),
    p95: percentileFromSorted(sorted, 95),
  };
}

function computeRouteDistanceKm(points) {
  let totalKm = 0;
  for (let index = 1; index < points.length; index += 1) {
    totalKm += haversineKm(points[index - 1].y, points[index - 1].x, points[index].y, points[index].x);
  }
  return totalKm;
}

module.exports = { computeElevationGainLoss, computeRouteDistanceKm, computeStats, extractGpsPoints, extractXYPoints };