const { asNumber, computeGrade, roundTo } = require('./utils');
const { extractXYPoints } = require('./chart-data');
const { buildTicks } = require('./chart-geometry');

const OVERLAY_METRIC_LABELS = { grade: 'Grade', altitude: 'Altitude', speed: 'Speed', heart_rate: 'Heart Rate' };
const OVERLAY_METRIC_UNITS = { grade: '%', altitude: 'm', speed: 'km/h', heart_rate: 'bpm' };

function buildChartClientPayload(chart, xUnit, yUnit, overlays) {
  if (!chart || !Array.isArray(chart.points) || chart.points.length < 2) return null;
  return {
    points: chart.points.map((point) => [roundTo(point.x, 4), roundTo(point.y, 3)]),
    plotLeft: chart.plotLeft, plotRight: chart.plotRight, plotTop: chart.plotTop, plotBottom: chart.plotBottom,
    xMin: chart.xMin, xMax: chart.xMax, yMin: chart.yMin, yMax: chart.yMax,
    width: chart.width, height: chart.height, xUnit, yUnit,
    overlays: overlays && Object.keys(overlays).length ? overlays : undefined,
  };
}

function buildOverlayMetrics(records, maxPoints) {
  const grades = records.some((record) => Number.isFinite(asNumber(record?.grade))) ? null : computeGrade(records);
  const gradeSource = grades ? records.map((record, index) => ({
    ...record,
    grade: grades[index] ? grades[index].grade * 100 : null,
  })) : records;
  return {
    grade: extractXYPoints(gradeSource, 'distance', 'grade', maxPoints, {}),
    altitude: extractXYPoints(records, 'distance', 'altitude', maxPoints, { yTransform: (value) => value * 1000 }),
    speed: extractXYPoints(records, 'distance', 'speed', maxPoints, {}),
    heart_rate: extractXYPoints(records, 'distance', 'heart_rate', maxPoints, {}),
  };
}

function buildOverlayOptions(overlayMetrics, ownKey, labels = OVERLAY_METRIC_LABELS, units = OVERLAY_METRIC_UNITS) {
  const result = {};
  for (const key of Object.keys(overlayMetrics)) {
    if (key === ownKey) continue;
    const series = overlayMetrics[key];
    if (!series || series.points.length < 2 || !series.yValues.length) continue;
    const min = Math.min(...series.yValues);
    const max = Math.max(...series.yValues);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) continue;
    const ticks = buildTicks(min, max, 18);
    result[key] = { points: series.points.map((point) => [roundTo(point.x, 4), roundTo(point.y, 2)]), min, max,
      yTicks: ticks.values, yStep: ticks.step,
      label: labels[key] || OVERLAY_METRIC_LABELS[key] || key, unit: units[key] || OVERLAY_METRIC_UNITS[key] || '' };
  }
  return result;
}

module.exports = { buildChartClientPayload, buildOverlayMetrics, buildOverlayOptions };