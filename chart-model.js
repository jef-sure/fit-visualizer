const { downsamplePoints } = require('./utils');
const { computeRouteDistanceKm, computeStats, extractGpsPoints, extractXYPoints } = require('./chart-data');
const { buildCartesianGeometry, formatTick } = require('./chart-geometry');

function buildLineChart(records, xField, yField, width, height, maxPoints, options = {}) {
  const xTransform = typeof options.xTransform === 'function' ? options.xTransform : (value) => value;
  const yTransform = typeof options.yTransform === 'function' ? options.yTransform : (value) => value;
  const series = extractXYPoints(records, xField, yField, maxPoints, { xTransform, yTransform });
  const compSeries = options.compRecords?.length
    ? extractXYPoints(options.compRecords, xField, yField, maxPoints, { xTransform, yTransform }) : null;
  const allPoints = compSeries ? [...series.points, ...compSeries.points] : series.points;
  const chart = buildCartesianGeometry(allPoints, width, height, { left: 60, right: 18, top: 12, bottom: 40 });
  const scaleX = (value) => chart.plotLeft + ((value - chart.xMin) / ((chart.xMax - chart.xMin) || 1)) * (chart.plotRight - chart.plotLeft);
  const scaleY = (value) => chart.plotBottom - ((value - chart.yMin) / ((chart.yMax - chart.yMin) || 1)) * (chart.plotBottom - chart.plotTop);
  chart.pathData = series.points.map((point) => `${scaleX(point.x).toFixed(1)},${scaleY(point.y).toFixed(1)}`).join(' ');
  chart.pathPoints = series.points.map((point) => ({ x: scaleX(point.x), y: scaleY(point.y), source: point }));
  chart.points = series.points;
  chart.stats = computeStats(series.yValues);
  if (compSeries) {
    chart.compPathData = compSeries.points.map((point) => `${scaleX(point.x).toFixed(1)},${scaleY(point.y).toFixed(1)}`).join(' ');
    chart.compStats = computeStats(compSeries.yValues);
  }
  return chart;
}

function buildGpsRoute(records, width, height, maxPoints) {
  const gpsPoints = downsamplePoints(extractGpsPoints(records), maxPoints);
  const route = buildCartesianGeometry(gpsPoints, width, height, { left: 60, right: 18, top: 12, bottom: 36 });
  return { ...route, pointCount: gpsPoints.length,
    boundsText: route.points.length ? `lat ${formatTick(route.yMin, route.yStep)}..${formatTick(route.yMax, route.yStep)}, lon ${formatTick(route.xMin, route.xStep)}..${formatTick(route.xMax, route.xStep)}` : 'no GPS points available',
    routeDistanceKm: computeRouteDistanceKm(gpsPoints), speedStats: computeStats(gpsPoints.map((point) => point.speed).filter(Number.isFinite)), hrStats: computeStats(gpsPoints.map((point) => point.heart_rate).filter(Number.isFinite)),
    geoPoints: gpsPoints.map((point) => ({
      lat: point.y,
      lon: point.x,
      speed: point.speed,
      heart_rate: point.heart_rate,
      elapsedTime: point.elapsed_time,
    })) };
}

module.exports = { buildGpsRoute, buildLineChart };