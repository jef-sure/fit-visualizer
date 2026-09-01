const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const test = require('node:test');
const initSqlJs = require('../vendor/sql-wasm/sql-wasm.js');
const {
  buildRecentHistoryContext,
  buildSegmentContext,
  formatFieldsSkippingEmpty,
  generateAnalysisPrompt,
  generateAnalysisChatPrompt,
  requestCopilotAnalysis,
  responseLanguageInstruction,
  summarizePromptBlocks,
} = require('../analysis');
const { ensureDatabaseSchema } = require('../database-schema');
const { padYAxisRange } = require('../chart-geometry');
const { computeStats, extractXYPoints, mapSegmentsToDistanceRanges } = require('../chart-data');
const { buildChartClientPayload, buildOverlayOptions } = require('../chart-overlays');
const { buildSummary } = require('../activity-summary');
const { buildLineChart } = require('../chart-model');
const { createChartSvgRenderer } = require('../chart-svg');
const { GLOSSARY, localizeGlossary } = require('../glossary');
const { UI_STRINGS, formatUi, localizeUi } = require('../ui-strings');
const {
  loadGeneratedTranslationBundle,
  parseGeneratedBundle,
  saveGeneratedTranslationBundle,
  validateTranslationBundle,
} = require('../dynamic-localization');

function loadActivityWebviewForTest() {
  const modulePath = require.resolve('../activity-webview');
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return { env: { language: 'en' }, l10n: { t: (text) => text } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../activity-webview');
  } finally {
    Module._load = originalLoad;
  }
}
const {
  calculateAutoHeartRateProfile,
  computeHeartRateZones,
  getHeartRateZoneIndex,
} = require('../heart-rate');
const {
  addEstimatedPowerWhenMissing,
  asNumber,
  bottomUpSegment,
  buildActivitySegments,
  calculateBanisterTrimp,
  calculateAutoFtp,
  calculateBikeStressScore,
  calculateHrTss,
  calculateHistoricalMeanMaximalPower,
  calculateIntensityFactor,
  calculateIntervalsDecoupling,
  calculateMeanMaximalPower,
  calculateNormalizedPower,
  calculateTrainingStressScore,
  calculateXPower,
  computeGpsDerivedSpeed,
  computeGrade,
  deriveSpeedsFromDistance,
  detectStops,
  downsamplePoints,
  escapeHtml,
  estimateSpeedConfidence,
  estimateWheelCalibrationRatio,
  formatHms,
  formatNumber,
  estimateFtpCandidates,
  estimatePowerFromMotion,
  haversineKm,
  normalizeRecordSpeeds,
  roundTo,
  segmentByGrade,
  segmentLineBudget,
  selectEffortSignal,
  selectFtpEstimate,
} = require('../utils');

// Terrain profile as [grade percent, seconds] pairs, sampled once per second.
function terrainRecords(profile, options = {}) {
  const records = [];
  let elapsed = 0;
  let altitudeM = 100;
  let distanceKm = 0;
  const speedKmh = options.speedKmh ?? 18;
  const startLat = 52;
  const startLon = 21;
  const lonPerMetre = 1 / (111320 * Math.cos((startLat * Math.PI) / 180));

  for (const [gradePct, seconds] of profile) {
    for (let i = 0; i < seconds; i += 1) {
      const metres = speedKmh / 3.6;
      altitudeM += (metres * gradePct) / 100;
      distanceKm += speedKmh / 3600;
      records.push({
        elapsed_time: elapsed,
        speed: speedKmh,
        distance: distanceKm,
        altitude: altitudeM / 1000,
        grade: gradePct,
        heart_rate: options.heartRateFor ? options.heartRateFor(elapsed) : 140,
        power: options.powerFor ? options.powerFor(elapsed) : undefined,
        position_lat: startLat,
        position_long: startLon + distanceKm * 1000 * lonPerMetre,
      });
      elapsed += 1;
    }
  }
  return records;
}

// Straight west-to-east leg at a steady speed, roughly one point per second.
function straightGpsRecords(count, speedKmh, options = {}) {
  const startLat = options.startLat ?? 52.0;
  const startLon = options.startLon ?? 21.0;
  const lonPerMetre = 1 / (111320 * Math.cos((startLat * Math.PI) / 180));
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const metres = (speedKmh / 3.6) * i;
    records.push({
      elapsed_time: i,
      speed: speedKmh,
      distance: (speedKmh / 3600) * i,
      altitude: 0.1,
      position_lat: startLat,
      position_long: startLon + metres * lonPerMetre,
    });
  }
  return records;
}

function gradeFixtureRecords() {
  const altitudes = [100, 101, 102.5, 104, 105, 105.2, 105.1, 104, 102, 100.5, 100.4, 100.4];
  const speeds = [18, 17, 16, 15, 14, 22, 30, 34, 36, 20, 0.9, 12];
  const records = [];
  let distance = 0;
  for (let i = 0; i < altitudes.length; i += 1) {
    distance += speeds[i] / 3600;
    records.push({
      elapsed_time: i,
      speed: speeds[i],
      altitude: altitudes[i] / 1000,
      distance,
      position_lat: 52.1 + i * 0.0001,
      position_long: 21.0 + i * 0.0001,
    });
  }
  return records;
}

test('webview selector script keeps a valid selectActivity payload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /type:\s*'selectActivity',\s*Number\.isFinite\(athleteProfile\.riderMassKg\)/s
  );
  assert.match(source, /type:\s*'selectActivity',\s*id:\s*document\.getElementById\('actSel'\)\.value/s);
  assert.match(source, /type:\s*'selectActivity'[\s\S]*?compId:/);
});

test('map card isolates leaflet stacking layers below the sticky toolbar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /\.chart\[data-target-type="map"\] \{[^}]*isolation:isolate/);
  assert.match(source, /\.toolbar \{[\s\S]*?z-index: 1100;/);
});

test('map zooms only with ctrl or cmd held', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /L\.map\('\$\{mapId\}', \{[^}]*scrollWheelZoom: false/);
  assert.match(source, /if \(!event\.ctrlKey && !event\.metaKey\)/);
  assert.match(source, /setZoomAround\(targetMap\.mouseEventToContainerPoint\(event\), next\)/);
});

test('map can color route segments from the existing activity segmentation', () => {
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const modelSource = fs.readFileSync(path.join(__dirname, '..', 'chart-model.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(extensionSource, /const segments = buildDisplaySegments\(data, athleteProfile, hrConfig\);/);
  assert.match(extensionSource, /function buildDisplaySegments\(fitData, athleteProfile, heartRateConfig\)/);
  assert.match(modelSource, /elapsedTime: point\.elapsed_time/);
  assert.match(webviewSource, /const activitySegments = \$\{segmentPayload\};/);
  assert.match(webviewSource, /<option value="segment" selected>\$\{escapeHtml\(ui\.segment\)\}<\/option>/);
  assert.match(webviewSource, /function segmentColor\(index\)/);
  assert.match(webviewSource, /displayColor: presentationByIndex\.get\(segment\.index\)\?\.color/);
  assert.match(webviewSource, /matchedSegment\?\.displayColor/);
  assert.match(webviewSource, /seenSegmentIndexes/);
  assert.doesNotMatch(webviewSource, /value="none"|singleColor|Single Color/);
});

test('rendered map initializer draws segment route polylines', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const records = straightGpsRecords(4, 18);
  const html = renderActivityContentHtml({}, {}, { records, sessions: [], laps: [] }, null, 'test-nonce', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en', [{
    index: 0, type: 'flat', startElapsed: 0, endElapsed: 3,
  }], null);
  const mapIife = html.match(/<script nonce="test-nonce">\s*(\(function \(\) \{\s*const routePoints =[\s\S]*?\n    \}\(\)\);)\s*<\/script>/)?.[1];
  assert.ok(mapIife, 'rendered HTML must contain the map initializer');

  const elements = new Map();
  const listeners = new Map();
  const mapElement = {
    style: {},
    appendChild() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const modeSelect = {
    value: 'segment',
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  elements.set('fitMap', mapElement);
  elements.set('fitMapMode', modeSelect);
  elements.set('fitMapSegmentLegend', { style: {}, innerHTML: '' });
  elements.set('fitMapRouteSection', { style: {} });
  const polylines = [];
  const tooltips = [];
  const map = {
    removeLayer() {},
    fitBounds() {},
    whenReady(callback) { callback(); },
    invalidateSize() {},
    getContainer() { return mapElement; },
    getZoom() { return 10; },
    getMinZoom() { return 0; },
    getMaxZoom() { return 20; },
    mouseEventToContainerPoint() { return {}; },
    setZoomAround() {},
  };
  const leaflet = {
    map() { return map; },
    tileLayer() { return { addTo() {} }; },
    latLngBounds() { return { pad() { return {}; } }; },
    circleMarker() { return { addTo() {} }; },
    polyline(points) {
      const line = { points, addTo() { polylines.push(line); return line; }, bindTooltip(content) { tooltips.push(content); } };
      return line;
    },
    TileLayer: function TileLayer() {},
  };
  const context = {
    window: { L: leaflet }, L: leaflet,
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement() { return { classList: { add() {}, remove() {} }, style: {}, textContent: '' }; },
    },
    navigator: { platform: 'Linux', userAgent: 'node' },
    setupResizablePanels() {}, setTimeout(callback) { callback(); }, clearTimeout() {},
    Number, Math, String, Array, Object, Map, NaN,
  };
  require('node:vm').runInNewContext(mapIife, context);
  assert.equal(polylines.length, records.length - 1);
  assert.equal(polylines.every((line) => line.points.length === 2), true);
  assert.equal(tooltips.length, records.length - 1);
});

test('chart and map segment hover reuse grouped AI presentation details', () => {
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const svgSource = fs.readFileSync(path.join(__dirname, '..', 'chart-svg.js'), 'utf8');
  assert.match(webviewSource, /const segmentPresentation = buildSegmentContext\(segments\);/);
  assert.match(webviewSource, /displayTime: presentationByIndex\.get\(segment\.index\)\?\.time/);
  assert.match(webviewSource, /if \(segment\.displayDetails\)/);
  assert.match(svgSource, /y="\$\{chart\.plotBottom - 9\}"[\s\S]*?height="9"/);
  assert.match(svgSource, /style="fill:\$\{escapeHtml\(segment\.displayColor\)\}"/);
});

test('segment map and chart hover tooltips reuse existing details without unavailable placeholders', () => {
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const svgSource = fs.readFileSync(path.join(__dirname, '..', 'chart-svg.js'), 'utf8');
  assert.match(webviewSource, /window\.formatSegmentDetails = function formatSegmentDetails/);
  assert.match(webviewSource, /function escapeSegmentHtml\(text\)/);
  assert.match(webviewSource, /function formatRouteMetricTooltip\(mode, value\)/);
  assert.match(webviewSource, /mode === 'speed'.*?km\/h/);
  assert.match(webviewSource, /mode === 'heart_rate'.*?bpm/);
  const mapFormatter = webviewSource.match(/window\.formatSegmentDetails = function formatSegmentDetails\(segment\) \{([\s\S]*?)\n      \};/)?.[1] || '';
  assert.doesNotMatch(mapFormatter, /escapeHtmlClient/);
  const mapDrawSegments = webviewSource.match(/function drawSegments\(mode\) \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.doesNotMatch(mapDrawSegments, /escapeHtmlClient/);
  assert.match(webviewSource, /const tooltip = mode === 'segment'/);
  assert.match(webviewSource, /if \(tooltip\) line\.bindTooltip\(tooltip/);
  assert.match(webviewSource, /id="\$\{mapId\}SegmentTooltip"/);
  assert.match(webviewSource, /chartSegments\.find/);
  assert.match(webviewSource, /Number\.isFinite\(Number\(segment\.avgHr\)\)/);
  assert.doesNotMatch(webviewSource, /N\/A/);
  assert.match(svgSource, /data-segment-index/);
  assert.match(webviewSource, /function showSegmentTooltip\(event, local\)/);
  assert.match(webviewSource, /showSegmentTooltip\(evt, local\);/);
});

test('FIT parser lap lists are retained only from its documented data.laps field', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'fit-files.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /function getParsedLaps\(data\) \{\s*return Array\.isArray\(data\?\.laps\) \? data\.laps : \[\];/);
  assert.match(extensionSource, /const laps = getParsedLaps\(fitData\);/);
});

test('activity table conditionally offers device laps alongside segment rendering input', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /const activityTable = renderActivityTable\(chartSegments, fitData\.laps, ui\)/);
  assert.match(source, /data-activity-table-tab="laps"/);
  assert.match(source, /lapRows\.length \?/);
  assert.match(source, /total_timer_time \?\? lap\.total_elapsed_time/);
  assert.match(extensionSource, /laps_json/);
  assert.match(extensionSource, /laps: parseStoredLaps\(activity\.laps_json\)/);
});

test('mapId is declared before it is used to build chart payloads (no TDZ crash)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const declarationIndex = source.indexOf("const mapId = isComparison ? 'fitMapComp' : 'fitMap';");
  const firstUseIndex = source.indexOf('const chartClientPayloads = safeJson({');
  assert.ok(declarationIndex > 0, 'mapId declaration must exist');
  assert.ok(declarationIndex < firstUseIndex, 'mapId must be declared before chartClientPayloads uses it');
});

test('chart client payload carries geometry and a trimmed point series', () => {
  const chart = {
    points: [{ x: 0, y: 10 }, { x: 1, y: 12.3456 }],
    plotLeft: 60, plotRight: 1380, plotTop: 12, plotBottom: 340,
    xMin: 0, xMax: 1, yMin: 10, yMax: 12.3456, width: 1400, height: 380,
  };
  const payload = buildChartClientPayload(chart, 'km', 'bpm');
  assert.deepEqual(payload.points, [[0, 10], [1, 12.346]]);
  assert.equal(payload.width, 1400);
  assert.equal(payload.yUnit, 'bpm');
  assert.equal(payload.overlays, undefined);
  assert.equal(buildChartClientPayload({ points: [{ x: 0, y: 1 }] }, 'km', 'bpm'), null);
});

test('chart SVG renderer outputs ticks, markers, zones, and a crosshair capture rect', () => {
  const renderer = createChartSvgRenderer({
    buildDistanceMarkers: () => [{ px: 50, label: '1 < km' }],
    escapeHtml,
    formatTick: (value) => `tick:${value}`,
    getHrZoneIndex: () => 2,
  });
  const chart = {
    points: [{ x: 0, y: 100 }, { x: 1, y: 120 }],
    pathPoints: [{ x: 20, y: 80 }, { x: 100, y: 30 }],
    pathData: '20,80 100,30',
    compPathData: '20,70 100,20',
    xTicks: [{ px: 20, value: 0 }], yTicks: [{ py: 80, value: 100 }],
    xStep: 1, yStep: 10, plotLeft: 20, plotRight: 100, plotTop: 10, plotBottom: 90, width: 120, height: 110,
  };
  const svg = renderer.renderScaledLineChartSvg(chart, 'lineA', 'Distance', 'Heart rate', true, {
    svgId: 'chart<id>', zoneThresholds: [100, 120, 140, 160],
  });

  assert.match(svg, /id="chart&lt;id&gt;"/);
  assert.match(svg, /class="kmMarker"/);
  assert.match(svg, /1 &lt; km/);
  assert.match(svg, /class="xTicksGroup"/);
  assert.match(svg, /class="yTicksGroup"/);
  assert.match(svg, /class="zoneLine zoneLine3"/);
  assert.match(svg, /class="lineAComp"/);
  assert.match(svg, /class="crosshairCapture"/);
  assert.equal(renderer.renderScaledLineChartSvg({ points: [] }, 'lineA', 'x', 'y', false), '<div class="muted">Not enough data for this chart.</div>');
});

test('chart segment bands use distance ranges and are rendered behind chart ticks', () => {
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const chart = {
    points: [{ x: 0, y: 1 }, { x: 10, y: 2 }], pathPoints: [{ x: 20, y: 80 }, { x: 100, y: 30 }], pathData: '20,80 100,30',
    xTicks: [{ px: 20, value: 0 }], yTicks: [{ py: 80, value: 1 }], xStep: 1, yStep: 1,
    plotLeft: 20, plotRight: 100, plotTop: 10, plotBottom: 90, xMin: 0, xMax: 10, width: 120, height: 110,
  };
  const svg = renderer.renderScaledLineChartSvg(chart, 'lineA', 'Distance', 'Speed', false, {
    segmentBands: [{ type: 'climb', startDistanceKm: 2, endDistanceKm: 5 }],
  });
  assert.match(svg, /class="segmentBandGroup"><rect class="segmentBand segmentBandClimb" x="36\.0"/);
  assert.ok(svg.indexOf('segmentBandGroup') < svg.indexOf('class="xTicksGroup"'));
});

test('chart segment distance ranges interpolate elapsed boundaries and preserve provided distances', () => {
  const ranges = mapSegmentsToDistanceRanges([
    { type: 'climb', startElapsed: 5, endElapsed: 15 },
    { type: 'flat', startElapsed: 1, endElapsed: 2, startDistanceKm: 7, endDistanceKm: 8 },
  ], [
    { elapsed_time: 0, distance: 0 }, { elapsed_time: 10, distance: 2 }, { elapsed_time: 20, distance: 5 },
  ]);
  assert.deepEqual(ranges.map(({ type, startDistanceKm, endDistanceKm }) => ({ type, startDistanceKm, endDistanceKm })), [
    { type: 'climb', startDistanceKm: 1, endDistanceKm: 3.5 }, { type: 'flat', startDistanceKm: 7, endDistanceKm: 8 },
  ]);
});

test('GPS SVG renderer outputs route endpoints and handles missing routes', () => {
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const route = {
    points: [{}, {}], pathPoints: [{ x: 10, y: 20 }, { x: 90, y: 80 }], pathData: '10,20 90,80',
    xTicks: [{ px: 10, value: 1 }], yTicks: [{ py: 20, value: 2 }], xStep: 1, yStep: 1,
    plotLeft: 10, plotRight: 90, plotTop: 10, plotBottom: 90,
  };
  const svg = renderer.renderGpsRouteSvg(route, 100, 100);

  assert.match(svg, /aria-label="gps route"/);
  assert.match(svg, /class="routeStart" cx="10\.0" cy="20\.0"/);
  assert.match(svg, /class="routeEnd" cx="90\.0" cy="80\.0"/);
  assert.equal(renderer.renderGpsRouteSvg({ points: [] }, 100, 100), '<div class="muted">No usable GPS points found in this FIT file.</div>');
});

test('chart interactions script ports buildTicks, syncs a shared crosshair and adapts tick density', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /function buildTicksClient\(min, max, targetCount\)/);
  assert.match(source, /Math\.floor\(Math\.log10\(rough\)\)/);
  assert.match(source, /var payloads = \$\{chartClientPayloads\};/);
  assert.match(source, /new ResizeObserver\(function \(entries\) \{/);
  assert.match(source, /svgIds\.forEach\(function \(id\) \{\s*var target = instances\[id\];/);
  assert.match(source, /getScreenCTM\(\)/);
});

test('adaptive chart ticks recompute when only height changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const geometrySource = fs.readFileSync(path.join(__dirname, '..', 'chart-geometry.js'), 'utf8');
  assert.match(source, /var lastWidth = 0;\s*var lastHeight = 0;/);
  assert.match(source, /Math\.abs\(rect\.width - lastWidth\) < 1 && Math\.abs\(rect\.height - lastHeight\) < 1/);
  assert.match(source, /lastWidth = rect\.width;\s*lastHeight = rect\.height;/);
  assert.match(source, /var labelY = Math\.max\(payload\.plotTop \+ 12, Math\.min\(payload\.plotBottom - 4, parseFloat\(py\) \+ 4\)\)\.toFixed\(1\);/);
  assert.match(geometrySource, /const plotTop = margin\.top \+ 8;/);
  assert.match(geometrySource, /const safeY = padYAxisRange\(yMin, yMax\);/);
  assert.match(source, /clampCount\(plotWidthPx \/ 72, 4, 18\)/);
  assert.match(source, /clampCount\(plotHeightPx \/ 30, 6, 18\)/);
});

test('Y-axis range reserves headroom above the highest data value', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /require\('\.\/chart-geometry'\)/);
  assert.deepEqual(padYAxisRange(0, 50), { min: 0, max: 54 });
  assert.equal(padYAxisRange(42, 42).max > 42, true);
});

test('chart data module filters invalid samples and preserves chart statistics', () => {
  const series = extractXYPoints([
    { distance: 0, speed: 10 },
    { distance: 1, speed: null },
    { distance: 2, speed: 30 },
  ], 'distance', 'speed', 10, {});
  assert.deepEqual(series.points, [{ x: 0, y: 10 }, { x: 2, y: 30 }]);
  assert.deepEqual(series.yValues, [10, 30]);
  assert.deepEqual(computeStats(series.yValues), { count: 2, min: 10, max: 30, avg: 20, median: 20, p95: 29 });
});

test('activity summary falls back to records and preserves unavailable workload metrics', () => {
  const summary = buildSummary([
    { elapsed_time: 0, distance: 0, speed: 20, heart_rate: 120 },
    { elapsed_time: 60, distance: 0.5, speed: 30, heart_rate: 140 },
  ], [{}]);
  assert.equal(summary.distanceKm, 0.5);
  assert.equal(summary.durationSec, 60);
  assert.equal(summary.avgHr, 130);
  assert.equal(summary.normalizedPower, null);
  assert.equal(summary.trainingStressScore, null);
});

test('chart model builds a shared geometry for primary and comparison series', () => {
  const chart = buildLineChart(
    [{ distance: 0, speed: 10 }, { distance: 2, speed: 20 }],
    'distance', 'speed', 200, 100, 10,
    { compRecords: [{ distance: 0, speed: 12 }, { distance: 2, speed: 22 }] }
  );
  assert.equal(chart.points.length, 2);
  assert.equal(chart.compStats.max, 22);
  assert.match(chart.pathData, /,/);
  assert.match(chart.compPathData, /,/);
});

test('client tick rounding keeps the server step at powers of ten', () => {
  const span = 2000;
  const targetCount = 3;
  const rough = span / Math.max(2, targetCount - 1);

  const oldMagnitude = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
  const clientMagnitude = Math.pow(10, Math.floor(Math.log10(rough)));

  assert.equal(rough, 1000);
  assert.equal(oldMagnitude, 100);
  assert.equal(clientMagnitude, 1000);
});

test('speed-axis tick density keeps a 10 km/h step for a 0-50 km/h range', () => {
  const min = 0;
  const max = 50;
  const targetCount = 6;
  const span = Math.abs(max - min);
  const rough = span / Math.max(2, targetCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  const nice = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  const step = nice * magnitude;

  assert.equal(step, 10);
});

test('crosshair shows a text label with the actual X/Y values at the hovered point', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const svg = renderer.renderScaledLineChartSvg({
    points: [{}, {}], pathData: '0,0 1,1', xTicks: [], yTicks: [], xStep: 1, yStep: 1,
    plotLeft: 0, plotRight: 100, plotTop: 0, plotBottom: 100, width: 100, height: 100,
  }, 'lineA', 'x', 'y', false, { svgId: 'chart' });
  assert.match(svg, /<text class="crosshairLabel" style="display:none">/);
  assert.match(svg, /<tspan class="crosshairLabelX"/);
  assert.match(svg, /<tspan class="crosshairLabelY"/);
  assert.match(source, /labelX\.textContent = formatCrosshairValue\(point\[0\], payload\.xUnit\);/);
  assert.match(source, /labelY\.textContent = formatCrosshairValue\(point\[1\], payload\.yUnit\);/);
  // Flips side near the right edge so the label text never runs off the chart.
  assert.match(source, /var nearRightEdge = pxNum > \(payload\.plotLeft \+ payload\.plotRight\) \/ 2;/);
  assert.match(source, /if \(label\) label\.style\.display = 'none';/);
});

test('chart text labels adapt to the rendered SVG scale', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const svg = renderer.renderScaledLineChartSvg({
    points: [{}, {}], pathData: '0,0 1,1', xTicks: [], yTicks: [], xStep: 1, yStep: 1,
    plotLeft: 0, plotRight: 100, plotTop: 0, plotBottom: 100, width: 100, height: 100,
  }, 'lineA', 'Distance', 'Value', false);
  assert.match(source, /function updateChartTextScale\(svg, payload, rect\)/);
  assert.match(source, /var xScale = rect\.width \/ payload\.width;/);
  assert.match(source, /var yScale = rect\.height \/ payload\.height;/);
  assert.match(source, /var textScale = Math\.max\(0\.1, Math\.min\(xScale, yScale\)\);/);
  assert.match(source, /function setReadableFont\(selector, cssPx, strokePx\)/);
  assert.match(source, /el\.style\.fontSize = \(cssPx \/ textScale\)\.toFixed\(2\) \+ 'px';/);
  const readableFontBody = source.match(/function setReadableFont\(selector, cssPx, strokePx\) \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.doesNotMatch(readableFontBody, /setAttribute\('transform'/);
  assert.match(source, /setReadableFont\('\.tick', 10\);/);
  assert.match(source, /setReadableFont\('\.kmLabel', 9\);/);
  assert.match(source, /setReadableFont\('\.crosshairLabel', 13, 3\);/);
  assert.match(svg, /class="axisLabel axisLabelX"/);
  assert.match(source, /var axisX = svg\.querySelector\('\.axisLabelX'\);/);
  assert.match(source, /var axisXx = parseFloat\(axisX\.getAttribute\('x'\)\);/);
  assert.match(source, /var axisXy = parseFloat\(axisX\.getAttribute\('y'\)\);/);
  assert.match(source, /axisX\.style\.fontSize = '12px';/);
  assert.match(source, /axisX\.setAttribute\('transform', 'translate\(' \+ axisXx \+ ' ' \+ axisXy \+ '\) scale\('/);
  assert.match(source, /\+ \(-axisXx\) \+ ' ' \+ \(-axisXy\) \+ '\)'/);
  assert.match(source, /if \(instance\.lastRect\) updateChartTextScale\(svg, payload, instance\.lastRect\);/);
  assert.match(source, /redrawTicks\(svg, payload,[\s\S]*?updateChartTextScale\(svg, payload, rect\);/);
});

test('metric overlays reuse computeGrade once, exclude the chart\'s own metric and cap at two active', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const overlaySource = fs.readFileSync(path.join(__dirname, '..', 'chart-overlays.js'), 'utf8');
  assert.match(overlaySource, /const grades = records\.some[\s\S]*?computeGrade\(records\)/);
  assert.match(source, /var OVERLAY_PALETTE = \['#e67e22', '#00acc1'\];/);
  assert.match(source, /if \(Object\.keys\(active\)\.length >= 2\) \{/);

  const metrics = {
    grade: { points: [{ x: 0, y: 1 }, { x: 1, y: 5 }], yValues: [1, 5] },
    altitude: { points: [{ x: 0, y: 100 }, { x: 1, y: 100 }], yValues: [100, 100] },
    speed: { points: [{ x: 0, y: 10 }, { x: 1, y: 20 }], yValues: [10, 20] },
    heart_rate: { points: [{ x: 0, y: 120 }, { x: 1, y: 140 }], yValues: [120, 140] },
  };

  const options = buildOverlayOptions(metrics, 'speed');
  assert.deepEqual(Object.keys(options).sort(), ['grade', 'heart_rate']);
  // A flat (zero-range) altitude series is not offered as an overlay: there is nothing to see.
  assert.equal(options.grade.min, 1);
  assert.equal(options.grade.max, 5);
  assert.equal(options.grade.unit, '%');
});

test('stored analyses stay visible and reusable after a version bump', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.doesNotMatch(source, /getAnalysisFromDb/);
  // Strict version equality may only gate the "skip a new Copilot request" cache check.
  assert.match(source, /if \(!force\) \{\s*const existing = await getCachedAnalysisForCurrentVersion\(dbPath, numId\);/);
  assert.equal(source.match(/analysis_version = \?/g).length, 1);
  assert.match(source, /const analysis = selId \? await getLatestAnalysisAnyVersion\(dbPath, selId\) : null;/);
  assert.match(source, /const previousAnalysis = \(await getLatestAnalysisAnyVersion\(dbPath, numId\)\)\?\.text/);
  assert.match(source, /const baseAnalysis = \(await getLatestAnalysisAnyVersion\(dbPath, activityId\)\)\?\.text/);
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(webviewSource, /escapeHtml\(ui\.olderAnalysis\)/);
});

test('bulk re-analysis command is registered end to end', () => {
  const commandsSource = fs.readFileSync(path.join(__dirname, '..', 'commands.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.match(commandsSource, /register\(\s*'fitVisualizer\.reanalyzeOutdated'/);
  assert.match(commandsSource, /return \[[^\]]*reanalyzeOutdated[^\]]*\]/);
  assert.equal(
    manifest.contributes.commands.some((entry) => entry.command === 'fitVisualizer.reanalyzeOutdated'),
    true
  );
});

test('outdated analysis lookup covers older versions and never-analyzed activities', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const currentVersion = Number(/const ANALYSIS_VERSION = (\d+)/.exec(source)[1]);
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path, file_name, start_time) VALUES
      (1, 'a.fit', 'a.fit', '2026-08-01'),
      (2, 'b.fit', 'b.fit', '2026-08-02'),
      (3, 'c.fit', 'c.fit', '2026-08-03'),
      (4, 'd.fit', 'd.fit', NULL),
      (5, 'e.fit', 'e.fit', '2026-08-02')`);
    db.run(`INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version) VALUES
      (1, 'current', ${currentVersion}),
      (2, 'stale', ${currentVersion - 1})`);

    const outdated = db.exec(`
      SELECT a.id, aa.analysis_version
      FROM activities a
      LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE aa.activity_id IS NULL OR aa.analysis_version < ${currentVersion}
      ORDER BY a.start_time IS NULL, a.start_time, a.id
    `)[0].values;

    // Oldest first, so each re-analysis can cite already-refreshed earlier activities.
    assert.deepEqual(outdated, [[2, currentVersion - 1], [5, null], [3, null], [4, null]]);

    const latestForStale = db.exec(`
      SELECT analysis_text, analysis_version FROM activity_analysis
      WHERE activity_id = 2 ORDER BY analysis_version DESC LIMIT 1
    `)[0].values[0];
    assert.deepEqual(latestForStale, ['stale', currentVersion - 1]);
  } finally {
    db.close();
  }
});

test('bulk re-analysis runs one Copilot request at a time', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const loop = /for \(let index = 0; index < targets\.length; index \+= 1\) \{[\s\S]*?\n    \}/.exec(source)[0];

  assert.match(loop, /await generateActivityAnalysis\(dbPath, target\.id, true\);/);
  assert.doesNotMatch(loop, /Promise\.(all|allSettled|race)/);
  // Analyses started from the webview must not interleave with a bulk run: sql.js rewrites the whole file.
  assert.match(source, /return enqueueLlmTask\(\(\) => runActivityAnalysis\(dbPath, activityId, force\)\)/);
  assert.match(source, /async function appendActivityChatTurn[\s\S]*?return enqueueLlmTask\(async \(\) => \{/);
});

test('extracting computeGrade keeps estimatePowerFromMotion output identical', () => {
  // Snapshot captured from the pre-refactor implementation.
  const expected = [
    [1, 654.331735], [2, 579.278761], [5, 247.575428], [6, 0],
    [7, 0], [8, 0], [9, 0], [11, 0],
  ];
  const actual = estimatePowerFromMotion(gradeFixtureRecords(), { riderMassKg: 75, bikeMassKg: 10 })
    .map((entry) => [entry.elapsed_time, Number(entry.power.toFixed(6))]);

  assert.deepEqual(actual, expected);
});

test('computeGrade aligns with input records and reports slope as a fraction', () => {
  const records = gradeFixtureRecords();
  const grades = computeGrade(records);

  assert.equal(grades.length, records.length);
  assert.equal(grades[0], null);
  assert.equal(grades[1].elapsed_time, 1);
  assert.equal(grades[1].dt, 1);
  assert.ok(grades[1].grade > 0, 'climbing section has positive grade');
  assert.ok(grades[8].grade < 0, 'descending section has negative grade');
  assert.ok(Math.abs(grades[1].grade) < 1, 'grade is a fraction, not a percentage');
});

test('computeGrade skips records without a usable position or altitude', () => {
  const grades = computeGrade([
    { elapsed_time: 0, speed: 20, altitude: 0.1, distance: 0, position_lat: 52, position_long: 21 },
    { elapsed_time: 1, speed: 20, altitude: 0.101, distance: 0.005, position_lat: 0, position_long: 0 },
    { elapsed_time: 2, speed: 20, altitude: 0.102, distance: 0.01, position_lat: 52, position_long: 21 },
    { elapsed_time: 3, speed: 20, distance: 0.015, position_lat: 52, position_long: 21 },
  ]);

  assert.deepEqual(grades.map((entry) => entry === null), [true, true, false, true]);
  assert.equal(grades[2].dt, 2);
});

test('record insert stores grade only for meaningful movement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /const grades = computeGrade\(records\);/);
  assert.match(source, /grade\.dt > 0 && grade\.dt <= 5 && grade\.distanceM >= 1\s*\?\s*roundTo\(grade\.grade \* 100, 2\)/);
  assert.match(source, /gradePct, null, null,/);
});

test('GPS derived speed reconstructs speed from positions alone', () => {
  const records = straightGpsRecords(20, 30);
  const gpsSpeeds = computeGpsDerivedSpeed(records);

  assert.equal(gpsSpeeds.length, records.length);
  assert.ok(Number.isNaN(gpsSpeeds[0]) || gpsSpeeds[0] > 0, 'first sample has no predecessor');
  for (let i = 5; i < records.length - 5; i += 1) {
    assert.ok(Math.abs(gpsSpeeds[i] - 30) < 1, `sample ${i} should be near 30 km/h, got ${gpsSpeeds[i]}`);
  }
});

test('GPS derived speed accepts semicircle coordinates and skips missing fixes', () => {
  const toSemicircles = (degrees) => Math.round((degrees * 2147483648) / 180);
  const records = straightGpsRecords(12, 36).map((record, index) => ({
    ...record,
    position_lat: index === 4 ? null : toSemicircles(record.position_lat),
    position_long: index === 4 ? null : toSemicircles(record.position_long),
  }));
  const gpsSpeeds = computeGpsDerivedSpeed(records);

  assert.ok(Math.abs(gpsSpeeds[8] - 36) < 1.5, `expected ~36 km/h, got ${gpsSpeeds[8]}`);
});

test('speed confidence stays low unless the stretch is long, straight and consistent', () => {
  const longStraight = straightGpsRecords(400, 30);
  const trusted = estimateSpeedConfidence(longStraight);
  assert.ok(trusted.includes('high'), 'a long clean straight should earn trust');

  const short = estimateSpeedConfidence(straightGpsRecords(40, 30));
  assert.ok(!short.includes('high'), 'a 300 m stretch is too short to average out GPS noise');

  const drifting = longStraight.map((record) => ({ ...record, speed: record.speed * 1.25 }));
  assert.ok(
    !estimateSpeedConfidence(drifting).includes('high'),
    'a systematic gap between wheel and GPS speed must not be trusted'
  );

  const winding = longStraight.map((record, index) => ({
    ...record,
    position_lat: record.position_lat + (index % 2 ? 0.0004 : -0.0004),
  }));
  assert.ok(!estimateSpeedConfidence(winding).includes('high'), 'a twisty track is not a trusted window');
});

test('stops cover both zero-speed runs and recording gaps', () => {
  const records = [];
  for (let i = 0; i < 20; i += 1) {
    records.push({ elapsed_time: i, speed: 25 });
  }
  for (let i = 20; i < 45; i += 1) {
    records.push({ elapsed_time: i, speed: 0 });
  }
  for (let i = 45; i < 50; i += 1) {
    records.push({ elapsed_time: i, speed: 25 });
  }
  records.push({ elapsed_time: 400, speed: 25 });

  const stops = detectStops(records);

  assert.deepEqual(stops.map((stop) => [stop.startIndex, stop.endIndex, stop.durationS]), [
    [20, 44, 24],
    [49, 50, 351],
  ]);
  assert.deepEqual(detectStops([{ elapsed_time: 0, speed: 0 }, { elapsed_time: 3, speed: 0 }]), []);
});

test('haversine distance matches a known one-degree separation', () => {
  assert.ok(Math.abs(haversineKm(52, 21, 53, 21) - 111.19) < 0.1);
  assert.equal(haversineKm(52, 21, 52, 21), 0);
});

test('wheel calibration ratio compares the wheel distance channel against GPS distance on trusted windows', () => {
  const base = straightGpsRecords(400, 30);
  // A miscalibrated wheel circumference scales both recorded speed and distance; GPS positions stay honest.
  const miscalibrated = base.map((record) => ({
    ...record,
    speed: record.speed * 1.05,
    distance: record.distance * 1.05,
  }));

  const result = estimateWheelCalibrationRatio(miscalibrated);
  assert.ok(result, 'a long straight trusted stretch should produce a calibration sample');
  assert.ok(Math.abs(result.ratio - 1.05) < 0.01, `expected ratio near 1.05, got ${result.ratio}`);
  assert.ok(result.trustedDistanceKm > 1);

  const badlyMiscalibrated = base.map((record) => ({
    ...record,
    speed: record.speed * 1.15,
    distance: record.distance * 1.15,
  }));
  const largeError = estimateWheelCalibrationRatio(badlyMiscalibrated);
  assert.ok(largeError, 'a large but stable wheel/GPS mismatch is exactly what calibration should detect');
  assert.ok(Math.abs(largeError.ratio - 1.15) < 0.01, `expected ratio near 1.15, got ${largeError.ratio}`);
  assert.ok(!estimateSpeedConfidence(badlyMiscalibrated).includes('high'), 'speed confidence still requires absolute agreement');

  assert.equal(estimateWheelCalibrationRatio(straightGpsRecords(20, 30)), null, 'a 150 m stretch is too short to trust');
  assert.equal(estimateWheelCalibrationRatio([]), null);
});

test('wheel calibration integration: sample storage, recommendation gating and profile wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /DELETE FROM wheel_calibration_samples WHERE activity_id = \?/);
  assert.match(source, /INSERT INTO wheel_calibration_samples[\s\S]*?ON CONFLICT\(activity_id\) DO UPDATE SET/);
  assert.match(source, /Only stored when a calibration ratio was actually computable/);

  assert.match(source, /if \(rows\.length >= 15 \|\| cumulativeKm >= 20\)/);
  assert.match(source, /if \(totalKm < 15\) \{\s*return null;/);
  assert.match(source, /if \(Math\.abs\(deviationPct\) <= 1\) \{\s*return null;/);
  assert.match(source, /recommendedCircumferenceMm: currentMm != null \? roundTo\(currentMm \/ ratio, 1\) : null/);

  assert.match(source, /function parseOptionalWheelCircumference\(value\)/);
  assert.match(source, /mm < 1000 \|\| mm > 2500/);

  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(webviewSource, /wheelCircumferenceMm: document\.getElementById\('\$\{mapId\}WheelCircumference'\)\.value,/);
  assert.match(source, /const wheelCalibration = await getWheelCalibrationRecommendation\(dbPath\);/);
});

test('wheel calibration hint recomputes live from the typed value instead of waiting for Save Zones', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');

  // The recommendation must not depend on a saved profile value: it reruns on every keystroke.
  assert.match(source, /data-ratio="\$\{wheelCalibration\.ratio\}"/);
  assert.match(source, /const ratio = parseFloat\(hint\.getAttribute\('data-ratio'\)\);/);
  assert.match(source, /wheelInput\?\.addEventListener\('input', updateSuggestion\);/);
  assert.match(source, /const recommended = Math\.round\(\(current \/ ratio\) \* 10\) \/ 10;/);
  assert.match(source, /updateSuggestion\(\);\s*\}\(\)\);/);

  // Applying the suggestion must not re-offer a second correction on top of the corrected value.
  assert.match(source, /applyBtn\.style\.display = 'none';/);
});

test('grade segmentation labels terrain and absorbs short wobbles', () => {
  const records = terrainRecords([[0.2, 120], [6, 300], [0.4, 180], [-7, 240], [0.1, 120]]);
  const segments = segmentByGrade(records);

  assert.deepEqual(segments.map((segment) => segment.type), ['flat', 'climb', 'flat', 'descent', 'flat']);
  assert.equal(segments[0].startIndex, 0);
  assert.equal(segments[segments.length - 1].endIndex, records.length - 1);

  const wobbly = terrainRecords([[0.2, 120], [3.4, 8], [0.2, 120]]);
  assert.deepEqual(segmentByGrade(wobbly).map((segment) => segment.type), ['flat']);
});

test('grade segmentation keeps stops as their own segments', () => {
  const records = terrainRecords([[0.2, 90], [0.2, 90], [0.2, 90]]);
  for (let i = 90; i < 130; i += 1) {
    records[i].speed = 0;
  }

  const types = segmentByGrade(records, { stops: detectStops(records) }).map((segment) => segment.type);
  assert.deepEqual(types, ['flat', 'stopped', 'flat']);
});

test('bottom-up segmentation finds level changes and ignores noise', () => {
  const steady = new Array(40).fill(200).map((value, index) => value + (index % 2 ? 4 : -4));
  assert.equal(bottomUpSegment(steady).length, 1);

  const stepped = [...new Array(20).fill(150), ...new Array(20).fill(300)];
  const parts = bottomUpSegment(stepped);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].end, 19);
  assert.equal(parts[1].start, 20);
});

test('effort signal follows the sport and the reliability of the segment', () => {
  const climb = { type: 'climb', avgGrade: 6, hasPower: true, hasHeartRate: true };
  assert.equal(selectEffortSignal(climb, { sport: 'cycling', powerSource: 'estimated' }).basis, 'vpower');
  assert.equal(selectEffortSignal(climb, { sport: 'cycling', powerSource: 'measured' }).basis, 'power');

  const flat = { type: 'flat', avgGrade: 0.5, hasPower: true, hasHeartRate: true };
  assert.equal(selectEffortSignal(flat, { sport: 'cycling', powerSource: 'estimated' }).basis, 'hr');

  const technical = { type: 'descent', avgGrade: -12, technical: true, hasPower: true, hasHeartRate: true };
  assert.equal(selectEffortSignal(technical, { sport: 'cycling', powerSource: 'estimated' }).basis, 'none');

  assert.equal(selectEffortSignal({ type: 'stopped' }, { sport: 'cycling' }).basis, 'none');
  assert.equal(selectEffortSignal(climb, { sport: 'running', powerSource: 'estimated' }).basis, 'hr');
  // Unknown sports fall back to heart rate instead of guessing with a cycling model.
  assert.equal(selectEffortSignal(climb, { sport: 'hiking', powerSource: 'estimated' }).basis, 'hr');
});

test('activity segments combine terrain, effort basis and aggregates', () => {
  const records = terrainRecords([[0.2, 180], [6, 300], [-9, 180]], {
    speedKmh: 20,
    powerFor: (elapsed) => (elapsed >= 180 && elapsed < 480 ? 240 : 120),
    heartRateFor: (elapsed) => (elapsed >= 180 && elapsed < 480 ? 160 : 130),
  });
  const segments = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' });

  assert.ok(segments.length >= 3);
  assert.deepEqual(segments.map((segment) => segment.index), segments.map((segment, index) => index));
  assert.equal(segments[0].startIndex, 0);
  assert.equal(segments[segments.length - 1].endIndex, records.length - 1);

  const climb = segments.find((segment) => segment.type === 'climb');
  assert.equal(climb.effortBasis, 'vpower');
  assert.ok(climb.avgGrade > 5 && climb.avgGrade < 7);
  assert.ok(climb.elevGainM > 0);
  // Terrain boundaries shift by a sample or two because of the hysteresis.
  assert.ok(Math.abs(climb.avgPower - 240) <= 5, `expected ~240 W, got ${climb.avgPower}`);

  const flat = segments.find((segment) => segment.type === 'flat');
  assert.equal(flat.effortBasis, 'hr');
  assert.ok(Math.abs(flat.avgHr - 130) <= 3, `expected ~130 bpm, got ${flat.avgHr}`);
  // GPS never confirms a wheel sensor by default, so speed stays untrusted.
  assert.equal(flat.speedConfidence, 'low');

  assert.deepEqual(buildActivitySegments([], {}), []);
});

test('short continuous climbs are not fragmented into effort micro-segments', () => {
  const records = terrainRecords([[0.2, 80], [5, 330], [0.2, 80]], {
    speedKmh: 14,
    powerFor: (elapsed) => 100 + (Math.floor(elapsed / 50) % 4) * 35,
  });
  const climbs = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' })
    .filter((segment) => segment.type === 'climb');

  assert.equal(climbs.length, 1);
  assert.ok(climbs[0].durationS > 300);
});

test('continuous flat terrain merges adjacent micro-segments with similar heart rate', () => {
  const records = terrainRecords([[0.2, 800]], {
    speedKmh: 24,
    heartRateFor: (elapsed) => 116 + (Math.floor(elapsed / 49) % 4) * 3,
  });
  const flats = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' })
    .filter((segment) => segment.type === 'flat');

  assert.equal(flats.length, 1);
  assert.ok(flats[0].durationS >= 790);
});

test('segments drop meaningless aggregates and drift', () => {
  const records = terrainRecords([[0.2, 120], [0.2, 120], [0.2, 120]], {
    powerFor: () => 150,
  });
  for (let i = 120; i < 180; i += 1) {
    records[i].speed = 0;
  }
  const segments = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' });

  const stop = segments.find((segment) => segment.type === 'stopped');
  // Averaging speed or grade across a stop (or a recording gap) says nothing about the ride.
  assert.equal(stop.avgSpeedKmh, null);
  assert.equal(stop.avgGrade, null);
  assert.equal(stop.avgPower, null);
  assert.equal(stop.elevGainM, null);

  // Half-vs-half drift on a two-minute stretch is noise, and HR-based segments have no Pw:HR at all.
  assert.ok(segments.every((segment) => segment.hrDriftPct === null));
});

test('segmentation thresholds are exposed as settings', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;

  for (const key of [
    'fitVisualizer.segmentation.gradeThresholdPct',
    'fitVisualizer.segmentation.gradeHysteresisPct',
    'fitVisualizer.segmentation.minSegmentSeconds',
    'fitVisualizer.segmentation.technicalGradePct',
    'fitVisualizer.segmentation.effortWindowSeconds',
    'fitVisualizer.segmentation.minEffortMacroSeconds',
    'fitVisualizer.segmentation.effortMergeTolerancePct',
    'fitVisualizer.segmentation.effortCostThreshold',
    'fitVisualizer.segmentation.stopSpeedKmh',
    'fitVisualizer.segmentation.stopMinSeconds',
    'fitVisualizer.segmentation.gpsTrustMinKm',
  ]) {
    assert.ok(properties[key], `${key} must be configurable`);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /thresholds: getSegmentationOptions\(\)/);
});

test('heart-rate zones use semantic order and stable boundaries', () => {
  const records = [100, 110, 120, 140, 160, 180]
    .map((heart_rate, elapsed_time) => ({ heart_rate, elapsed_time }));
  const result = computeHeartRateZones(records, 190);

  assert.deepEqual(
    result.zones.map((zone) => zone.name),
    ['Recovery', 'Endurance', 'Aerobic', 'Anaerobic', 'Max']
  );
  assert.deepEqual(result.zones.map((zone) => zone.seconds), [2, 1, 1, 1, 1]);
  assert.equal(getHeartRateZoneIndex(180, result.thresholds), 4);
});

test('heart-rate zones accept dated watch thresholds', () => {
  const records = [110, 125, 145, 165, 180]
    .map((heart_rate, elapsed_time) => ({ heart_rate, elapsed_time }));
  const result = computeHeartRateZones(records, 190, [120, 140, 160, 175]);

  assert.deepEqual(result.thresholds, [120, 140, 160, 175]);
  assert.deepEqual(result.zones.map((zone) => zone.range), [
    '95-119 bpm', '120-139 bpm', '140-159 bpm', '160-174 bpm', '175-190 bpm',
  ]);
});

test('auto HR profile uses sex age resting HR and observed maxima', () => {
  const result = calculateAutoHeartRateProfile({
    sex: 'male',
    age: 40,
    restingHeartRate: 55,
    observedMaxHeartRate: 186,
  });

  assert.equal(result.maxHeartRate, 186);
  assert.deepEqual(result.thresholds, [134, 147, 160, 173]);
  assert.equal(result.formulaMaxHeartRate, 180);
  assert.equal(result.observedMaxHeartRate, 186);
});

test('shared formatting utilities preserve display behavior', () => {
  assert.equal(formatHms(3661), '01:01:01');
  assert.equal(formatNumber(12.3456), '12.35');
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
  assert.deepEqual(downsamplePoints([0, 1, 2, 3], 2), [0, 2]);
  assert.equal(Number.isNaN(asNumber(null)), true);
  assert.equal(Number.isNaN(asNumber('')), true);
});

test('activity glossary localizes visible metric descriptions from one source', () => {
  const translated = localizeGlossary((text) => text === GLOSSARY.trainingStressScore ? 'TSS: показатель тренировочной нагрузки.' : text);
  assert.equal(translated.trainingStressScore, 'TSS: показатель тренировочной нагрузки.');
  assert.match(translated.averagePower, /Average power/);
  assert.match(translated.maximumHeartRate, /Maximum heart rate/);
  assert.match(translated.normalizedPower, /Normalized Power/);
  assert.match(GLOSSARY.technical, /Technical/);

  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /asNumber,/);
  assert.match(source, /normalizeRecordSpeeds,/);
  assert.match(source, /const translate = \(message\) => generatedTranslations\?\.\[message\] \|\| vscode\.l10n\.t\(message\);/);
  assert.match(source, /const glossary = localizeGlossary\(translate\);/);
  assert.match(source, /class="term" title="\$\{escapeHtml\(description\)\}"/);
  assert.match(source, /metric\('Avg Power \(W\)' \+ powerMetricSuffix, summary\.avgPower\.toFixed\(0\), 'averagePower', glossary\)/);
  assert.match(source, /\['Max HR \(bpm\)', a\.maxHr\.toFixed\(0\), b\.maxHr\.toFixed\(0\), 'maximumHeartRate'\]/);
  assert.match(source, /metric\('TSS' \+ powerMetricSuffix,[\s\S]*?'trainingStressScore', glossary\)/);
});

test('activity webview renderer executes its complete server-side render path', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const html = renderActivityContentHtml(
    {}, {}, {
      _fileName: 'ride.fit',
      records: [
        { elapsed_time: 0, distance: 0, speed: 18, heart_rate: 120, altitude: 0.1, position_lat: 50, position_long: 6 },
        { elapsed_time: 60, distance: 0.5, speed: 24, heart_rate: 140, altitude: 0.105, position_lat: 50.001, position_long: 6.001 },
      ],
      sessions: [{ total_distance: 0.5, total_timer_time: 60 }],
      laps: [],
    }, {}, 'nonce', false, null, {}, { text: 'Older analysis', version: 1 }, [], null,
    localizeUi(), localizeGlossary(), false, 'English', [{
      index: 0, type: 'descent', effortBasis: 'hr', startElapsed: 0, endElapsed: 60,
      durationS: 60, startDistanceKm: 0, endDistanceKm: 0.5, avgHr: 130, avgPower: 86, avgGrade: -4.4, elevGainM: 2,
    }], 8
  );
  assert.match(html, /fitMapSpeedSvg/);
  assert.match(html, /Interactive Map/);
  assert.match(html, /<th>Segment<\/th><th>Time<\/th><th>Distance<\/th><th>Terrain<\/th><th>Grade<\/th><th>Effort<\/th><th>Heart Rate<\/th><th>Speed<\/th><th>Elevation<\/th>/);
  assert.match(html, /<td>Descent<\/td>/);
  assert.match(html, /<td>-4\.4%<\/td>/);
  assert.match(html, /<td>130 bpm<\/td>/);
  assert.doesNotMatch(html, /vPower 86 W|Power 86 W|\+2 m|0\.00 km/);
});

test('localized webview UI uses one complete string catalog', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  for (const message of Object.values(UI_STRINGS)) {
    assert.ok(bundle[message], `Missing Russian UI translation: ${message}`);
  }
  const localized = localizeUi((text) => bundle[text] || text);
  assert.equal(localized.analyzeActivity, 'Анализировать активность');
  assert.equal(formatUi(localized.error, 'Нет данных'), 'Ошибка: Нет данных');
  assert.equal(formatUi('{0} / {1}', 0, 2), '0 / 2');

  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /const ui = localizeUi\(translate\);/);
  assert.match(source, /<html lang="\$\{escapeHtml\(locale\)\}">/);
  assert.match(source, /const ui = \$\{safeJson\(ui\)\};/);
});

test('generated translation bundles must exactly match the UI and glossary catalogs', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  assert.equal(validateTranslationBundle(bundle), bundle);
  assert.throws(() => validateTranslationBundle({}), /exactly the current UI string catalog/);
  assert.throws(() => validateTranslationBundle({ ...bundle, 'Error: {0}': 'Ошибка' }), /changed its placeholders/);
  assert.equal(parseGeneratedBundle(`\`\`\`json\n${JSON.stringify(bundle)}\n\`\`\``)['Activity'], 'Активность');
});

test('generated translation bundles are stored per locale outside the extension package', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'fitviz-l10n-'));
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  try {
    await saveGeneratedTranslationBundle(storagePath, 'es-MX', bundle);
    assert.deepEqual(await loadGeneratedTranslationBundle(storagePath, 'es_MX'), bundle);
    assert.equal(await loadGeneratedTranslationBundle(storagePath, 'invalid locale'), null);
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('normalized power equals constant power for steady efforts', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 120; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 250 });
  }

  const normalizedPower = calculateNormalizedPower(records);
  assert.ok(Math.abs(normalizedPower - 250) < 0.001);
});

test('auto FTP estimates a sustained 20-minute power effort', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 250 });
  }

  assert.equal(calculateAutoFtp(records), 238);
});

test('auto FTP ignores rides without a continuous 20-minute effort', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += 1) {
    records.push({ elapsed_time: elapsed < 600 ? elapsed : elapsed + 10, power: 250 });
  }

  assert.equal(calculateAutoFtp(records), 0);
});

test('MMP curve captures a short hard effort at its matching duration', () => {
  const records = [];
  for (let elapsed = 0; elapsed <= 300; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: elapsed < 240 ? 100 : 300 });
  }

  const curve = calculateMeanMaximalPower(records, [60, 300]);
  assert.equal(curve[0].power, 300);
  assert.ok(curve[1].power > 100);
  assert.ok(curve[1].power < 300);
});

test('historical MMP takes the best duration from each ride independently', () => {
  const firstRide = [];
  const secondRide = [];
  for (let elapsed = 0; elapsed <= 300; elapsed += 1) {
    firstRide.push({ elapsed_time: elapsed, power: 200 });
    secondRide.push({ elapsed_time: elapsed, power: 250 });
  }

  const curve = calculateHistoricalMeanMaximalPower([firstRide, secondRide], [300]);
  assert.equal(curve[0].power, 250);
});

test('FTP candidates prefer a well-fit critical-power estimate', () => {
  const curve = [60, 300, 1200, 3000].map((durationSec) => ({
    durationSec,
    power: 250 + (10000 / durationSec),
  }));

  const candidates = estimateFtpCandidates(curve);
  assert.ok(Math.abs(candidates.cp - 250) < 0.001);
  assert.ok(Math.abs(candidates.w_prime - 10000) < 0.001);
  assert.ok(candidates.r_squared > 0.999);
  assert.equal(selectFtpEstimate(candidates), 242);
});

test('motion power estimates uphill gravitational power', () => {
  // Parser units: speed km/h, altitude and distance km. 10 m/s at 10% grade.
  const records = [];
  for (let elapsed = 0; elapsed <= 10; elapsed += 1) {
    records.push({
      elapsed_time: elapsed,
      distance: elapsed * 0.01,
      speed: 36,
      altitude: elapsed * 0.001,
      position_lat: 50,
      position_long: 6,
    });
  }

  const estimated = estimatePowerFromMotion(records, { riderMassKg: 75, bikeMassKg: 10 });
  assert.ok(estimated.length > 0, 'Should produce at least one estimate');
  assert.ok(estimated.every((record) => record.power >= 0), 'All estimates should be non-negative');
  assert.ok(estimated.every((record) => record.power <= 2500), 'All estimates should stay under physiological limit');
  const avgEstimate = estimated.reduce((s, r) => s + r.power, 0) / estimated.length;
  assert.ok(avgEstimate > 200, 'Average power during uphill climb should be substantial');
  assert.ok(avgEstimate < 2000, 'Average power should stay in reasonable bounds');
});

test('motion power ignores zero-distance spikes and caps estimates', () => {
  const records = [0, 1, 2].map((elapsed_time) => ({
    elapsed_time,
    distance: 0,
    speed: 36,
    altitude: elapsed_time * 100,
    position_lat: 50,
    position_long: 6,
  }));

  const estimated = estimatePowerFromMotion(records, { riderMassKg: 75, bikeMassKg: 10 });
  assert.equal(estimated.length, 2);
  assert.ok(estimated.every((record) => record.power <= 1200));
});

test('summary power fallback preserves measured power and estimates missing power', () => {
  const missingPower = [0, 1, 2].map((elapsed_time) => ({
    elapsed_time,
    distance: elapsed_time * 0.01,
    speed: 36,
    altitude: elapsed_time * 0.001,
    position_lat: 50,
    position_long: 6,
  }));
  const estimated = addEstimatedPowerWhenMissing(missingPower, { riderMassKg: 75, bikeMassKg: 10 });
  assert.equal(estimated.source, 'estimated');
  assert.equal(estimated.records[0].power, undefined);
  assert.ok(estimated.records[1].power > 0);

  const measured = addEstimatedPowerWhenMissing([{ elapsed_time: 0, power: 0 }], { riderMassKg: 75, bikeMassKg: 10 });
  assert.equal(measured.source, 'measured');
  assert.equal(measured.records[0].power, 0);
});

test('normalized power weights variable efforts above arithmetic mean', () => {
  // 20 min of alternating 2-min blocks at 100/200 W.
  const records = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += 1) {
    const power = Math.floor(elapsed / 120) % 2 === 0 ? 100 : 200;
    records.push({ elapsed_time: elapsed, power });
  }

  const normalizedPower = calculateNormalizedPower(records);
  assert.ok(normalizedPower > 150);
  assert.ok(normalizedPower < 200);
});

test('normalized power includes zero-power samples and ignores missing power values', () => {
  const records = [
    { elapsed_time: 0, power: 0 },
    { elapsed_time: 1, power: 0 },
    { elapsed_time: 2, power: null },
    { elapsed_time: 3, power: 100 },
    { elapsed_time: 4, power: 100 },
  ];

  const normalizedPower = calculateNormalizedPower(records);
  assert.ok(normalizedPower > 0);
  assert.ok(normalizedPower < 100);
});

test('intensity factor and TSS follow standard power formulas', () => {
  const intensityFactor = calculateIntensityFactor(250, 300);
  assert.ok(Math.abs(intensityFactor - (250 / 300)) < 1e-9);

  const tss = calculateTrainingStressScore(3600, 250, intensityFactor, 300);
  assert.ok(Math.abs(tss - 69.4444) < 0.001);
});

test('unavailable workload metrics use null rather than a misleading zero', () => {
  assert.equal(calculateNormalizedPower([]), null);
  assert.equal(calculateNormalizedPower([{ elapsed_time: 0, power: null }]), null);
  assert.equal(calculateXPower([]), null);
  assert.equal(calculateXPower([{ elapsed_time: 0, power: null }]), null);
  assert.equal(calculateIntensityFactor(null, 300), null);
  assert.equal(calculateTrainingStressScore(3600, null, null, 300), null);
  assert.equal(calculateBikeStressScore(3600, null, null, 300), null);
  assert.equal(calculateHrTss({ durationSec: 3600, avgHeartRate: null, restingHeartRate: 50, maxHeartRate: 190 }), null);
});

test('record speeds are derived from distance when the speed channel is zero', () => {
  const records = [];
  for (let elapsed = 0; elapsed <= 60; elapsed += 1) {
    records.push({ elapsed_time: elapsed, distance: elapsed * 0.005, speed: 0 }); // 18 km/h
  }

  const normalized = normalizeRecordSpeeds(records);
  assert.ok(normalized.slice(1).every((record) => record.speed > 15 && record.speed < 21));
});

test('record speed normalization keeps genuine stops and measured speeds', () => {
  const stopped = normalizeRecordSpeeds([
    { elapsed_time: 0, distance: 1, speed: 0 },
    { elapsed_time: 1, distance: 1, speed: 0 },
    { elapsed_time: 2, distance: 1, speed: 0 },
  ]);
  assert.ok(stopped.every((record) => record.speed === 0));

  const measured = normalizeRecordSpeeds([
    { elapsed_time: 0, distance: 0, speed: 20 },
    { elapsed_time: 1, distance: 0.01, speed: 22 },
  ]);
  assert.deepEqual(measured.map((record) => record.speed), [20, 22]);
});

test('record speed normalization falls back to enhanced_speed', () => {
  const normalized = normalizeRecordSpeeds([{ elapsed_time: 0, enhanced_speed: 25 }]);
  assert.equal(normalized[0].speed, 25);
});

test('derived speeds convert km distance and seconds to km/h', () => {
  const derived = deriveSpeedsFromDistance([
    { elapsed_time: 0, distance: 0 },
    { elapsed_time: 10, distance: 0.05 },
    { elapsed_time: 20, distance: 0.1 },
  ]);
  assert.ok(derived.slice(1).every((speed) => Math.abs(speed - 18) < 0.001));
});

test('xPower equals steady power and BikeStress follows stress equation', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 180; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 240 });
  }

  const xPower = calculateXPower(records);
  assert.ok(Math.abs(xPower - 240) < 0.01);

  const ftp = 300;
  const ri = calculateIntensityFactor(xPower, ftp);
  const bikeStress = calculateBikeStressScore(3600, xPower, ri, ftp);
  assert.ok(Math.abs(bikeStress - 64) < 0.2);
});

test('Intervals-style decoupling is near zero on stable power/HR', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1800; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 200, heart_rate: 140 });
  }

  const decoupling = calculateIntervalsDecoupling(records, {
    ftp: 260,
    restingHeartRate: 50,
    maxHeartRate: 190,
  });

  assert.ok(Math.abs(decoupling) < 1);
});

test('Intervals-style decoupling increases with heart-rate drift at constant power', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1800; elapsed += 1) {
    const heartRate = elapsed < 900 ? 135 : 150;
    records.push({ elapsed_time: elapsed, power: 200, heart_rate: heartRate });
  }

  const decoupling = calculateIntervalsDecoupling(records, {
    ftp: 260,
    restingHeartRate: 50,
    maxHeartRate: 190,
  });

  assert.ok(decoupling > 0);
});

test('Banister TRIMP and hrTSS are computed from HR reserve intensity', () => {
  const input = {
    durationSec: 3600,
    avgHeartRate: 150,
    restingHeartRate: 50,
    maxHeartRate: 190,
    sex: 'male',
  };

  const trimp = calculateBanisterTrimp(input);
  const hrTss = calculateHrTss(input);

  assert.ok(trimp > 0);
  assert.ok(hrTss > 0);
  assert.ok(hrTss < 100);
});

test('database schema migrates manual HR overrides onto existing activities', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    db.run('CREATE TABLE activities (id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, avg_hr REAL, max_hr REAL)');
    ensureDatabaseSchema(db);
    const columns = db.exec('PRAGMA table_info(activities)')[0].values.map((row) => row[1]);
    assert.equal(columns.includes('manual_avg_hr'), true);
    assert.equal(columns.includes('manual_max_hr'), true);
    const analysisColumns = db.exec('PRAGMA table_info(activity_analysis)')[0].values.map((row) => row[1]);
    assert.equal(analysisColumns.includes('analysis_version'), true);
    const profileColumns = db.exec('PRAGMA table_info(athlete_profile)')[0].values.map((row) => row[1]);
    assert.equal(profileColumns.includes('wheel_circumference_mm'), true);
    const calibrationColumns = db.exec('PRAGMA table_info(wheel_calibration_samples)')[0].values.map((row) => row[1]);
    assert.deepEqual(calibrationColumns, ['id', 'activity_id', 'computed_at', 'ratio', 'trusted_distance_km']);
  } finally {
    db.close();
  }
});

test('database schema clears legacy zero sentinels from derived workload metrics', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (
      file_path, normalized_power, training_stress_score, intensity_factor,
      xpower, relative_intensity_gc, bike_stress_score, hr_tss
    ) VALUES ('legacy.fit', 0, 0, 0, 0, 0, 0, 0)`);
    ensureDatabaseSchema(db);
    const row = db.exec(`SELECT normalized_power, training_stress_score, intensity_factor,
      xpower, relative_intensity_gc, bike_stress_score, hr_tss
      FROM activities WHERE file_path = 'legacy.fit'`)[0].values[0];

    assert.deepEqual(row, [null, null, null, null, null, null, null]);
  } finally {
    db.close();
  }
});

test('database schema creates only extension-owned tables', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]
      .values
      .flat();
    assert.deepEqual(tables, ['activities', 'activity_analysis', 'activity_analysis_chat', 'athlete_profile', 'heart_rate_profiles', 'records', 'sqlite_sequence', 'wheel_calibration_samples']);
  } finally {
    db.close();
  }
});

test('heart-rate profiles resolve by date and fall back to latest saved profile', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run("INSERT INTO heart_rate_profiles (effective_date, max_hr) VALUES ('2026-07-01', 190), ('2026-07-20', 193)");
    const lookup = (date) => {
      const matched = db.exec(`
        SELECT effective_date, max_hr FROM heart_rate_profiles
        WHERE effective_date <= '${date}' ORDER BY effective_date DESC LIMIT 1
      `)[0]?.values[0];
      if (matched) {
        return matched;
      }
      return db.exec(`
        SELECT effective_date, max_hr FROM heart_rate_profiles
        ORDER BY effective_date DESC LIMIT 1
      `)[0]?.values[0];
    };

    assert.deepEqual(lookup('2026-07-19'), ['2026-07-01', 190]);
    assert.deepEqual(lookup('2026-07-20'), ['2026-07-20', 193]);
    assert.deepEqual(lookup('2026-06-30'), ['2026-07-20', 193]);
  } finally {
    db.close();
  }
});

test('Copilot analysis selects a model and joins streamed text', async () => {
  const requests = [];
  const vscode = {
    lm: {
      selectChatModels: async (selector) => {
        assert.deepEqual(selector, { vendor: 'copilot' });
        return [{
          sendRequest: async (messages) => {
            requests.push(messages);
            return { text: asyncChunks(['First ', 'second.']) };
          },
        }];
      },
    },
    LanguageModelChatMessage: {
      User: (content) => ({ role: 'user', content }),
    },
  };

  assert.equal(await requestCopilotAnalysis(vscode, 'Analyze this'), 'First second.');
  assert.deepEqual(requests, [[{ role: 'user', content: 'Analyze this' }]]);
});

test('Copilot analysis accepts a configured language-model vendor and defaults blank values', async () => {
  const selectors = [];
  const vscode = {
    lm: {
      selectChatModels: async (selector) => {
        selectors.push(selector);
        return [{ sendRequest: async () => ({ text: asyncChunks(['ok']) }) }];
      },
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  await requestCopilotAnalysis(vscode, 'test', { vendor: 'example-provider' });
  await requestCopilotAnalysis(vscode, 'test', { vendor: '   ' });

  assert.deepEqual(selectors, [{ vendor: 'example-provider' }, { vendor: 'copilot' }]);
});

test('Copilot analysis reports unavailable and empty models', async () => {
  const noModel = {
    lm: { selectChatModels: async () => [] },
    LanguageModelChatMessage: { User: (content) => content },
  };
  await assert.rejects(() => requestCopilotAnalysis(noModel, 'test'), /not installed or you are not signed in/);

  const emptyResponse = {
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => ({ text: asyncChunks(['  ']) }),
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  await assert.rejects(() => requestCopilotAnalysis(emptyResponse, 'test'), /empty analysis/);
});

test('Copilot analysis explains language model permission and policy failures', async () => {
  class LanguageModelError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  const vscode = (code) => ({
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => { throw new LanguageModelError(code); },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
    LanguageModelError,
  });

  await assert.rejects(() => requestCopilotAnalysis(vscode('NoPermissions'), 'test'), /not authorized/);
  await assert.rejects(() => requestCopilotAnalysis(vscode('Blocked'), 'test'), /blocked this analysis request/);
  await assert.rejects(() => requestCopilotAnalysis(vscode('NotFound'), 'test'), /model was not found/);
});

test('Copilot request logging captures the model, the prompt and the reply', async () => {
  const logged = [];
  const vscode = {
    lm: {
      selectChatModels: async () => [{
        id: 'gpt-test-1',
        sendRequest: async () => ({ text: asyncChunks(['Analysed.']) }),
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  await requestCopilotAnalysis(vscode, 'Prompt body', { onCompleted: (entry) => logged.push(entry) });
  assert.deepEqual(logged, [{ modelId: 'gpt-test-1', prompt: 'Prompt body', response: 'Analysed.' }]);

  const failing = {
    lm: {
      selectChatModels: async () => [{
        id: 'gpt-test-2',
        sendRequest: async () => { throw new Error('boom'); },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  const failures = [];
  await assert.rejects(() => requestCopilotAnalysis(failing, 'Prompt body', {
    onCompleted: (entry) => failures.push(entry),
  }));
  assert.equal(failures[0].error, 'boom');

  // A broken logger must never take down an analysis.
  const noisy = {
    lm: {
      selectChatModels: async () => [{ sendRequest: async () => ({ text: asyncChunks(['ok']) }) }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  assert.equal(await requestCopilotAnalysis(noisy, 'p', {
    onCompleted: () => { throw new Error('log failure'); },
  }), 'ok');
});

test('prompt block sizes are reported per heading', () => {
  const summary = summarizePromptBlocks([
    'Analyze this workout.',
    '',
    '**This Workout:**',
    '- Distance: 20 km',
    '',
    '**Segment Breakdown:**',
    '1. climb',
    '2. flat',
  ].join('\n'));

  assert.deepEqual(summary.blocks.map((block) => block.title), ['Preamble', 'This Workout', 'Segment Breakdown']);
  assert.equal(summary.blocks.reduce((sum, block) => sum + block.chars, 0), summary.totalChars);
  assert.ok(summary.blocks[2].chars > 0);
});

test('LLM request logging is configurable and wired into both call sites', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['fitVisualizer.logLlmRequests'].default, true);
  assert.ok(properties['fitVisualizer.llmLogRetentionDays']);
  assert.equal(properties['fitVisualizer.lmVendor'].default, 'copilot');

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /function getLanguageModelVendor\(\)/);
  assert.match(source, /vendor: getLanguageModelVendor\(\),/);
  assert.match(source, /kind: 'analysis',/);
  assert.match(source, /kind: 'chat', \.\.\.result/);
  assert.match(source, /path\.join\(path\.dirname\(dbPath\), 'logs'\)/);
});

test('Copilot analysis retries once when rate limited and then succeeds', async () => {
  let calls = 0;
  const retryOnce = {
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('Upstream provider rate limit hit');
          }
          return { text: asyncChunks(['Recovered analysis']) };
        },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  const result = await requestCopilotAnalysis(retryOnce, 'test', { retryDelayMs: 0, maxRetries: 1 });
  assert.equal(result, 'Recovered analysis');
  assert.equal(calls, 2);
});

test('Copilot analysis returns a friendly message after rate-limit retries are exhausted', async () => {
  let calls = 0;
  const alwaysRateLimited = {
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => {
          calls += 1;
          throw new Error('Upstream provider rate limit hit');
        },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  await assert.rejects(
    () => requestCopilotAnalysis(alwaysRateLimited, 'test', { retryDelayMs: 0, maxRetries: 1 }),
    /Copilot rate limit reached/
  );
  assert.equal(calls, 2);
});

test('analysis prompt treats the first workout as an initial baseline', () => {
  const prompt = generateAnalysisPrompt({ sessions: [{ avg_hr: 131, max_hr: 177 }] }, {
    total_activities: 0,
  });

  assert.match(prompt, /No earlier activities within 75%-125%/);
  assert.match(prompt, /There are 0 earlier activities within 75%-125%/);
  assert.match(prompt, /not enough history to claim improvement, decline, stability, consistency, or a plateau/);
  assert.match(prompt, /Do not infer recovery status/);
  assert.match(prompt, /Do not assign HR zones/);
  assert.doesNotMatch(prompt, /A limited baseline comparison is possible/);
});

test('analysis prompt labels a single prior workout as limited history', () => {
  const prompt = generateAnalysisPrompt({ sessions: [{}] }, {
    total_activities: 1,
    recent_activity_count: 1,
    comparison_min_distance_km: 15,
    comparison_max_distance_km: 25,
  });

  assert.match(prompt, /Eligible Prior Activities: 1/);
  assert.match(prompt, /Distance Range: 15\.0-25\.0 km/);
  assert.match(prompt, /comparison against these distance-compatible rides is possible/);
  assert.match(prompt, /not enough history to claim improvement/);
});

test('analysis prompt uses the dated heart-rate profile', () => {
  const prompt = generateAnalysisPrompt({ sessions: [{}] }, { total_activities: 0 }, {
    effectiveDate: '2026-07-19',
    maxHeartRate: 193,
    thresholds: [118, 139, 159, 177],
  });

  assert.match(prompt, /Effective Date: 2026-07-19/);
  assert.match(prompt, /Maximum HR: 193 bpm/);
  assert.match(prompt, /Zone 2-5 Starts: 118, 139, 159, 177 bpm/);
  assert.match(prompt, /Use the supplied dated heart-rate profile/);
  assert.doesNotMatch(prompt, /Do not assign HR zones because/);
});

test('empty fields are dropped from the prompt instead of becoming N/A', () => {
  assert.equal(
    formatFieldsSkippingEmpty([['Distance', '20.0', 'km'], ['Cadence', null], ['TSS', undefined], ['Power', '']]),
    '- Distance: 20.0 km'
  );

  const sparse = generateAnalysisPrompt({ sessions: [{ total_distance_km: 20.1, avg_hr: 140 }] }, { total_activities: 0 });
  assert.doesNotMatch(sparse, /N\/A/);
  assert.doesNotMatch(sparse, /Avg Cadence/);
  assert.doesNotMatch(sparse, /xPower/);
  assert.match(sparse, /- Distance: 20\.10 km/);
  assert.match(sparse, /Fields that are absent were not measured/);

  const chat = generateAnalysisChatPrompt({ sessions: [{ total_distance_km: 20.1 }] }, {}, {}, '', [], 'why?');
  assert.doesNotMatch(chat, /N\/A/);
});

test('analysis prompts use the VS Code language and leave unknown locales alone', () => {
  assert.match(responseLanguageInstruction('ru'), /Respond in Russian/);
  assert.match(responseLanguageInstruction('de-CH'), /Respond in German/);
  assert.match(responseLanguageInstruction('pt_BR'), /Respond in Brazilian Portuguese/);
  assert.equal(responseLanguageInstruction('xx-YY'), '');

  const prompt = generateAnalysisPrompt({ sessions: [{}] }, { total_activities: 0 }, {}, null, [], [], 'ru');
  const chat = generateAnalysisChatPrompt({ sessions: [{}] }, {}, {}, '', [], 'why?', 'de-CH');
  assert.match(prompt, /Questions for Analysis:[\s\S]*Respond in Russian/);
  assert.match(chat, /Respond in 4-8 sentences\.\nRespond in German/);
});

test('segment breakdown lists segments, collapses repeats and folds short stops', () => {
  const segments = [
    { index: 0, type: 'climb', effortBasis: 'vpower', startElapsed: 0, endElapsed: 300, durationS: 300, avgGrade: 6.2, avgPower: 215, avgHr: 148, elevGainM: 90, hrDriftPct: 3 },
    { index: 1, type: 'stopped', effortBasis: 'none', startElapsed: 300, endElapsed: 323, durationS: 23 },
    { index: 2, type: 'flat', effortBasis: 'hr', effortReason: 'vpower unreliable off the climbs', startElapsed: 323, endElapsed: 1123, durationS: 800, avgGrade: 0.2, avgHr: 152, avgSpeedKmh: 26.4 },
    { index: 3, type: 'descent', effortBasis: 'none', technical: true, startElapsed: 1123, endElapsed: 1213, durationS: 90, avgGrade: -11 },
  ];

  const context = buildSegmentContext(segments);
  assert.match(context.text, /\*\*Segment Breakdown:\*\*/);
  assert.match(context.text, /climb, avg grade 6\.2%, vpower ~215 W/);
  assert.match(context.text, /HR drift \+3%/);
  assert.match(context.text, /flat, avg grade 0\.2%, avg HR 152/);
  // The basis rule is stated once, not repeated on every heart-rate line.
  assert.match(context.text, /Effort basis is implied by the metric quoted/);
  assert.equal(context.text.match(/vpower only on climbs/g).length, 1);
  assert.match(context.text, /technical, no reliable effort estimate/);
  // A 23-second stop is folded into a summary line rather than spending a line of its own.
  assert.match(context.text, /Plus 1 short stops, 0:23 total/);
  assert.doesNotMatch(context.text, /\d\. .*stopped/);
  assert.equal(context.displayRows[0].time, '00:00:00-00:05:00 (5:00)');
  assert.equal(context.displayRows[0].details, 'climb, avg grade 6.2%, vpower ~215 W, avg HR 148, HR drift +3%, +90 m');
  assert.deepEqual(context.displayRows[0].members.map((segment) => segment.index), [0]);
  assert.equal(context.displayRows.at(-1).time, '');

  const intervals = [];
  for (let i = 0; i < 8; i += 1) {
    const start = i * 300;
    intervals.push({ index: i * 2, type: 'flat', effortBasis: 'power', startElapsed: start, endElapsed: start + 240, durationS: 240, avgPower: 250 + i, avgGrade: 0.1 });
    intervals.push({ index: i * 2 + 1, type: 'flat', effortBasis: 'power', startElapsed: start + 240, endElapsed: start + 300, durationS: 60, avgPower: 120 + i, avgGrade: 0.1 });
  }
  const grouped = buildSegmentContext(intervals);
  assert.equal(grouped.lines, 1, 'eight identical work/rest pairs collapse to one line');
  assert.match(grouped.text, /8x \[ ~4:00 flat power 250-257 W \| ~1:00 flat power 120-127 W \]/);
});

test('segment line budget scales with duration and never truncates', () => {
  assert.equal(segmentLineBudget(0), 10);
  assert.equal(segmentLineBudget(3600), 10);
  assert.equal(segmentLineBudget(10 * 3600), 100);
  assert.equal(segmentLineBudget(1000 * 3600), 150);

  const noisy = [];
  for (let i = 0; i < 40; i += 1) {
    noisy.push({
      index: i,
      // Cycling three terrain types defeats both period-1 and period-2 grouping.
      type: ['climb', 'flat', 'descent'][i % 3],
      effortBasis: 'hr',
      startElapsed: i * 20,
      endElapsed: i * 20 + 20,
      durationS: 20,
      avgHr: 100 + i,
      avgGrade: i % 3 === 0 ? 5 : (i % 3 === 1 ? 0.2 : -5),
    });
  }
  const context = buildSegmentContext(noisy);
  assert.equal(context.lines, 40, 'the list is reported in full');
  assert.equal(context.maxLines, 10);
  assert.equal(context.exceeded, true, 'and flagged so the thresholds get reviewed');
});

test('recent history keeps the latest analyses verbose and older ones compact', () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) {
    entries.push({
      startTime: `2026-08-0${i + 1}T10:00:00.000Z`,
      distanceKm: 20 + i,
      durationS: 3600,
      trainingStressScore: 100 + i,
      analysisText: `Full analysis ${i}`,
      chatCount: i === 5 ? 2 : 0,
    });
  }

  const text = buildRecentHistoryContext(entries);
  assert.match(text, /\*\*Recent Activity History \(earlier workouts, oldest first\):\*\*/);
  assert.match(text, /2026-08-01: 20\.0 km, 01:00:00, TSS 100/);
  assert.doesNotMatch(text, /Full analysis 0/);
  assert.match(text, /Full analysis 5/);
  assert.match(text, /\(follow-up chat: 2 questions\)/);
  assert.equal(buildRecentHistoryContext([]), '');
});

test('prompt places data before rules and carries segment guidance', () => {
  const segments = [
    { index: 0, type: 'climb', effortBasis: 'vpower', startElapsed: 0, endElapsed: 300, durationS: 300, avgGrade: 6, avgPower: 210 },
  ];
  const prompt = generateAnalysisPrompt(
    { sessions: [{ total_distance_km: 20 }], segments },
    { total_activities: 0 },
    {},
    null,
    [],
    [{ startTime: '2026-08-01T10:00:00.000Z', distanceKm: 20, analysisText: 'Earlier ride was steady.' }]
  );

  assert.ok(prompt.indexOf('**Segment Breakdown:**') < prompt.indexOf('**Evidence Rules:**'));
  assert.ok(prompt.indexOf('**Recent Activity History') < prompt.indexOf('**Segment Breakdown:**'));
  assert.ok(prompt.indexOf('**Evidence Rules:**') < prompt.indexOf('**Questions for Analysis:**'));
  assert.match(prompt, /never compare vpower numbers against HR numbers directly/);
  assert.match(prompt, /past analyses of other workouts/);

  const withoutSegments = generateAnalysisPrompt({ sessions: [{}] }, { total_activities: 0 });
  assert.doesNotMatch(withoutSegments, /Segment Breakdown/);
  assert.doesNotMatch(withoutSegments, /Never compare a vpower-based segment/);
});

test('recent-history lookup reads earlier activities and falls back to the last one', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path, start_time) VALUES
      (1, 'old.fit', '2026-01-01T10:00:00.000Z'),
      (2, 'recent.fit', '2026-08-01T10:00:00.000Z'),
      (3, 'current.fit', '2026-08-10T10:00:00.000Z'),
      (4, 'later.fit', '2026-08-20T10:00:00.000Z')`);
    db.run(`INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version) VALUES
      (1, 'old text', 8), (2, 'recent text', 8), (4, 'later text', 8)`);

    const windowed = db.exec(`
      SELECT a.id FROM activities a
      JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE a.id != 3 AND a.start_time >= date('2026-08-10T10:00:00.000Z', '-30 days')
        AND a.start_time < '2026-08-10T10:00:00.000Z'
      ORDER BY a.start_time ASC
    `)[0].values.flat();
    // Only earlier activities inside the window: never the older one, never a later ride.
    assert.deepEqual(windowed, [2]);

    const fallback = db.exec(`
      SELECT a.id FROM activities a
      JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE a.id != 2 AND a.start_time < '2026-02-01T10:00:00.000Z'
      ORDER BY a.start_time DESC LIMIT 1
    `)[0].values.flat();
    assert.deepEqual(fallback, [1]);
  } finally {
    db.close();
  }
});

async function* asyncChunks(chunks) {
  yield* chunks;
}
