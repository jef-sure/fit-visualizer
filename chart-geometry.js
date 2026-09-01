const { roundTo } = require('./utils');

function padRange(min, max) {
  if (min !== max) {
    return { min, max };
  }
  const pad = Math.abs(min || 1) * 0.05;
  return { min: min - pad, max: max + pad };
}

function padYAxisRange(min, max) {
  const range = padRange(min, max);
  return { min: range.min, max: range.max + (range.max - range.min) * 0.08 };
}

function buildTicks(min, max, targetCount) {
  const span = Math.abs(max - min);
  if (!Number.isFinite(span) || span === 0) {
    return { values: [min], step: 1 };
  }

  const rough = span / Math.max(2, targetCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  let nice = 1;
  if (residual > 5) nice = 10;
  else if (residual > 2) nice = 5;
  else if (residual > 1) nice = 2;

  const step = nice * magnitude;
  const first = Math.ceil(min / step) * step;
  const values = [];
  for (let value = first; value <= max + step * 0.5; value += step) {
    values.push(roundTo(value, 12));
  }
  if (!values.length) {
    values.push(roundTo(min, 12), roundTo(max, 12));
  }
  return { values, step };
}

function formatTick(value, step) {
  const absStep = Math.abs(step);
  if (absStep >= 10) return value.toFixed(0);
  if (absStep >= 1) return value.toFixed(1);
  if (absStep >= 0.1) return value.toFixed(2);
  return value.toFixed(4);
}

function buildDistanceMarkers(chart, intervalKm) {
  if (!Number.isFinite(chart.xMin) || !Number.isFinite(chart.xMax) || chart.xMax <= chart.xMin) {
    return [];
  }
  let step = intervalKm;
  const span = chart.xMax - chart.xMin;
  if (span / step > 60) step = Math.ceil(span / 60);

  const markers = [];
  const first = Math.ceil(chart.xMin / step) * step;
  for (let km = first; km <= chart.xMax; km += step) {
    const px = chart.plotLeft + ((km - chart.xMin) / (chart.xMax - chart.xMin)) * (chart.plotRight - chart.plotLeft);
    markers.push({ px, label: `${roundTo(km, 3)} km` });
  }
  return markers;
}

function buildCartesianGeometry(points, width, height, margin) {
  if (points.length < 2) {
    return {
      points, pathPoints: [], pathData: '', width, height,
      plotLeft: margin.left, plotRight: width - margin.right, plotTop: margin.top + 8, plotBottom: height - margin.bottom,
      xTicks: [], yTicks: [], xStep: 1, yStep: 1, xMin: 0, xMax: 0, yMin: 0, yMax: 0,
    };
  }
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const yMin = Math.min(...points.map((point) => point.y));
  const yMax = Math.max(...points.map((point) => point.y));
  const safeX = padRange(xMin, xMax);
  const safeY = padYAxisRange(yMin, yMax);
  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top + 8;
  const plotBottom = height - margin.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const scaleX = (value) => plotLeft + ((value - safeX.min) / (safeX.max - safeX.min)) * plotWidth;
  const scaleY = (value) => plotBottom - ((value - safeY.min) / (safeY.max - safeY.min)) * plotHeight;
  const pathPoints = points.map((point) => ({ x: scaleX(point.x), y: scaleY(point.y), source: point }));
  const xTickInfo = buildTicks(safeX.min, safeX.max, 6);
  const yTickInfo = buildTicks(safeY.min, safeY.max, 6);
  return {
    points, pathPoints, pathData: pathPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    width, height, plotLeft, plotRight, plotTop, plotBottom,
    xTicks: xTickInfo.values.map((value) => ({ value, px: scaleX(value) })),
    yTicks: yTickInfo.values.map((value) => ({ value, py: scaleY(value) })),
    xStep: xTickInfo.step, yStep: yTickInfo.step, xMin: safeX.min, xMax: safeX.max, yMin: safeY.min, yMax: safeY.max,
  };
}

module.exports = { buildCartesianGeometry, buildDistanceMarkers, buildTicks, formatTick, padRange, padYAxisRange };