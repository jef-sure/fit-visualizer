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

function mapSegmentsToDistanceRanges(segments, records) {
  const samples = (Array.isArray(records) ? records : [])
    .map((record) => ({ elapsed: asNumber(record?.elapsed_time), distance: asNumber(record?.distance) }))
    .filter((sample) => Number.isFinite(sample.elapsed) && Number.isFinite(sample.distance))
    .sort((left, right) => left.elapsed - right.elapsed);
  if (samples.length < 2 || !Array.isArray(segments)) return [];

  function distanceAt(elapsed) {
    if (!Number.isFinite(elapsed)) return Number.NaN;
    if (elapsed <= samples[0].elapsed) return samples[0].distance;
    if (elapsed >= samples[samples.length - 1].elapsed) return samples[samples.length - 1].distance;
    let low = 0;
    let high = samples.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].elapsed <= elapsed) low = middle; else high = middle;
    }
    const start = samples[low];
    const end = samples[high];
    const ratio = (elapsed - start.elapsed) / ((end.elapsed - start.elapsed) || 1);
    return start.distance + (end.distance - start.distance) * ratio;
  }

  return segments.map((segment) => ({
    ...segment,
    startDistanceKm: Number.isFinite(asNumber(segment?.startDistanceKm)) ? asNumber(segment.startDistanceKm) : distanceAt(asNumber(segment?.startElapsed)),
    endDistanceKm: Number.isFinite(asNumber(segment?.endDistanceKm)) ? asNumber(segment.endDistanceKm) : distanceAt(asNumber(segment?.endElapsed)),
  })).filter((segment) => Number.isFinite(segment.startDistanceKm) && Number.isFinite(segment.endDistanceKm));
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

module.exports = { computeElevationGainLoss, computeRouteDistanceKm, computeStats, extractGpsPoints, extractXYPoints, mapSegmentsToDistanceRanges };