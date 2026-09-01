const vscode = require('vscode');
const { buildSegmentContext } = require('./analysis');
const { localizeGlossary } = require('./glossary');
const { formatUi, localizeUi } = require('./ui-strings');
const { buildSummary } = require('./activity-summary');
const { buildGpsRoute: buildGpsRouteFromModule, buildLineChart: buildLineChartFromModule } = require('./chart-model');
const { extractGpsPoints, mapSegmentsToDistanceRanges } = require('./chart-data');
const { buildDistanceMarkers, formatTick } = require('./chart-geometry');
const { createChartSvgRenderer } = require('./chart-svg');
const {
  buildChartClientPayload: buildChartClientPayloadFromModule,
  buildOverlayMetrics: buildOverlayMetricsFromModule,
  buildOverlayOptions: buildOverlayOptionsFromModule,
} = require('./chart-overlays');
const { computeHeartRateZones, getHeartRateZoneIndex } = require('./heart-rate');
const {
  addEstimatedPowerWhenMissing,
  asNumber,
  createNonce,
  escapeHtml,
  formatHms,
  formatNumber,
  normalizeRecordSpeeds,
  safeJson,
  toDateOnly,
} = require('./utils');

const { renderGpsRouteSvg, renderOverlayControls, renderScaledLineChartSvg } = createChartSvgRenderer({
  buildDistanceMarkers,
  escapeHtml,
  formatTick,
  getHrZoneIndex: getHeartRateZoneIndex,
});

function renderActivityBrowserHtml(webview, extensionUri, activities, selectedId, fitData, compId, compData, hrConfig, athleteProfile, analysis, analysisChat, wheelCalibration, generatedTranslations, segments, analysisVersion, comparisonText) {
  const translate = (message) => generatedTranslations?.[message] || vscode.l10n.t(message);
  const ui = localizeUi(translate);
  const glossary = localizeGlossary(translate);
  const locale = String(vscode.env.language || 'en').replace(/_/g, '-');
  const shouldOfferTranslations = !generatedTranslations && !locale.startsWith('en') && ui.activity === 'Activity';
  const hasData = fitData && Array.isArray(fitData.records) && fitData.records.length > 0;
  const hasComp = compData && Array.isArray(compData.records) && compData.records.length > 0;

  const actOptions = activities.map((a) => {
    const label = escapeHtml(formatActivityLabel(a));
    const sel = Number(a.id) === Number(selectedId) ? ' selected' : '';
    return `<option value="${escapeHtml(String(a.id))}"${sel}>${label}</option>`;
  }).join('');

  const compOptions = [
    `<option value="">- ${escapeHtml(ui.noComparison)} -</option>`,
    ...activities.filter((a) => Number(a.id) !== Number(selectedId)).map((a) => {
      const label = escapeHtml(formatActivityLabel(a));
      const sel = Number(a.id) === Number(compId) ? ' selected' : '';
      return `<option value="${escapeHtml(String(a.id))}"${sel}>${label}</option>`;
    }),
  ].join('');

  const nonce = createNonce();

  const selectorScript = `
    (function () {
      const api = window.fitVisualizerApi || acquireVsCodeApi();
      window.fitVisualizerApi = api;
      function send() {
        api.postMessage({
          type: 'selectActivity',
          id: document.getElementById('actSel').value || null,
          compId: document.getElementById('compSel').value || null,
        });
      }
      document.getElementById('actSel').addEventListener('change', send);
      document.getElementById('compSel').addEventListener('change', send);
    }());
  `;

  const primaryHtml = hasData
    ? renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, false, hasComp ? compData : null, athleteProfile, analysis, analysisChat, wheelCalibration, ui, glossary, shouldOfferTranslations, displayLanguage(locale), segments, analysisVersion, comparisonText)
    : `<div style="padding:24px;color:var(--muted)">${escapeHtml(ui.noDataForActivity)}</div>`;

  const { leafletCss, leafletJs, csp } = buildWebviewAssets(webview, extensionUri, nonce);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${leafletCss}">
  <title>FIT Visualizer</title>
  <style>
    ${sharedCss()}
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 1100;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--border);
      padding: 8px clamp(12px, 2vw, 24px);
      display: flex;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }
    .selectorGroup { display: flex; flex-direction: column; gap: 3px; min-width: 260px; flex: 1; }
    .selLabel { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .actSelector {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      font-size: 0.9rem;
    }
    .compDivider {
      font-size: 0.9rem;
      font-weight: bold;
      color: var(--muted);
      border-top: 2px solid var(--border);
      padding: 12px 0 4px;
      margin: 12px 0 8px;
    }
    .lineAComp,.lineBComp,.lineCComp {
      fill: none; stroke-width: 2; stroke-dasharray: 8 4;
      vector-effect: non-scaling-stroke; opacity: 0.85;
    }
    .lineAComp { stroke: var(--vscode-charts-purple, #b88fce); }
    .lineBComp { stroke: var(--vscode-charts-green); }
    .lineCComp { stroke: var(--vscode-charts-yellow); }
    .cmpTable { width:100%; border-collapse:collapse; font-size:0.9rem; }
    .cmpTable th, .cmpTable td { padding:5px 10px; border-bottom:1px solid var(--border); }
    .cmpTable th { color:var(--muted); font-size:0.75rem; text-transform:uppercase; }
    .cmpLabel { color:var(--muted); }
    .cmpA { font-weight:700; color:var(--accent); }
    .cmpB { font-weight:700; color: var(--vscode-charts-purple, #b88fce); }
    .compLegend { font-size:0.75rem; font-weight:normal; color:var(--muted); margin-left:6px; }
  </style>
</head>
<body>
  <nav class="toolbar">
    <div class="selectorGroup">
      <label class="selLabel" for="actSel">${escapeHtml(ui.activity)}</label>
      <select id="actSel" class="actSelector">${actOptions}</select>
    </div>
    <div class="selectorGroup">
      <label class="selLabel" for="compSel">${escapeHtml(ui.compareWith)}</label>
      <select id="compSel" class="actSelector">${compOptions}</select>
    </div>
  </nav>
  <script nonce="${nonce}" src="${leafletJs}"></script>
  <script nonce="${nonce}">
    function setupResizablePanels(onResized) {
      document.querySelectorAll('.resizable').forEach(function(panel) {
        if (panel.classList.contains('_resizeReady')) return;
        panel.classList.add('_resizeReady');
        const handles = panel.querySelectorAll('.resizeHandle');
        const targetId = panel.getAttribute('data-resize-target');
        const resizeKey = panel.getAttribute('data-resize-key');
        const targetType = panel.getAttribute('data-target-type') || 'svg';
        const minH = Number(panel.getAttribute('data-min-height') || 180);
        const maxH = Number(panel.getAttribute('data-max-height') || 1400);
        const targetEl = document.getElementById(targetId);
        if (!handles.length || !targetEl) return;
        const saved = Number(localStorage.getItem(resizeKey));
        if (Number.isFinite(saved) && saved >= minH && saved <= maxH) applyHeight(panel, targetEl, saved, targetType);
        handles.forEach(function(handle) {
          handle.addEventListener('mousedown', function(ev) {
            ev.preventDefault();
            const anchor = handle.getAttribute('data-anchor') || 'bottom-right';
            const startY = ev.clientY, startX = ev.clientX;
            const startH = targetEl.getBoundingClientRect().height;
            panel.classList.add('resizing');
            function onMove(e) {
              const dy = e.clientY - startY, dx = e.clientX - startX;
              const vert = anchor.startsWith('top') ? -dy : dy;
              const next = Math.max(minH, Math.min(maxH, startH + vert + dx * 0.15));
              applyHeight(panel, targetEl, next, targetType);
              if (typeof onResized === 'function') onResized(targetId);
            }
            function onUp() {
              panel.classList.remove('resizing');
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              localStorage.setItem(resizeKey, String(Math.round(targetEl.getBoundingClientRect().height)));
              if (typeof onResized === 'function') onResized(targetId);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          });
        });
      });
    }
    function applyHeight(panel, targetEl, h, type) {
      const px = Math.round(h) + 'px';
      if (type === 'map') { targetEl.style.height = px; targetEl.style.setProperty('--map-height', px); return; }
      panel.style.setProperty('--panel-height', px);
      panel.style.setProperty('--panel-max-height', px);
      targetEl.style.height = px;
    }
    ${selectorScript}
  </script>
  ${primaryHtml}
</body>
</html>`;
}

function formatActivityLabel(a) {
  const dt = parseActivityTime(a.start_time || a.file_name);
  const dateStr = dt ? dt.toLocaleString(vscode.env.language || 'en', { dateStyle: 'short', timeStyle: 'short' }) : (a.file_name || String(a.id));
  const sport = a.sport || '';
  const dist = a.total_distance_km ? `${Number(a.total_distance_km).toFixed(1)} km` : '';
  const dur = a.total_timer_s ? formatHms(Number(a.total_timer_s)) : '';
  return [dateStr, sport, dist, dur].filter(Boolean).join(' · ');
}

function renderActivityTable(segments, laps, ui) {
  const segmentContext = buildSegmentContext(segments);
  const segmentRows = segmentContext.displayRows.map((row, index) => ({ ...row, number: row.time ? String(index + 1) : '' }));
  const lapRows = (Array.isArray(laps) ? laps : []).map((lap, index) => ({
    label: String(index + 1),
    time: formatDuration(lap.total_timer_time ?? lap.total_elapsed_time),
    distance: displayNumber(lap.total_distance, ' km', 2),
    heartRate: displayNumber(lap.avg_heart_rate ?? lap.avg_hr, ' bpm', 0),
    power: displayNumber(lap.avg_power, ' W', 0),
    grade: displayNumber(lap.avg_grade, '%', 1),
    elevation: Number(lap.total_ascent) > 0 ? displayNumber(lap.total_ascent, ' m', 0, '+') : '',
  }));
  const lapColumns = [['label', ui.lap], ['time', ui.time], ['distance', ui.distance], ['heartRate', ui.heartRate], ['power', ui.power], ['grade', ui.grade], ['elevation', ui.elevation]];
  const renderRows = (rows, name, hidden, columns) => {
    const visible = columns.filter(([key]) => rows.some((row) => row[key]));
    return `<div class="activityTableWrap" data-activity-table="${name}"${hidden ? ' hidden' : ''}><table class="activityTable"><thead><tr>${visible.map(([, heading]) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${visible.map(([key]) => `<td>${escapeHtml(row[key] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };

  if (!segmentRows.length) return '';
  const tabs = lapRows.length ? `<div class="activityTableTabs"><button type="button" data-activity-table-tab="segments" aria-pressed="true">${escapeHtml(ui.segments)}</button><button type="button" data-activity-table-tab="laps" aria-pressed="false">${escapeHtml(ui.laps)}</button></div>` : '';
  const segmentView = renderGroupedSegmentRows(segmentRows, ui);
  return `<section class="chart"><h2>${escapeHtml(lapRows.length ? ui.segments : ui.segment)}</h2>${tabs}${segmentView}${lapRows.length ? renderRows(lapRows, 'laps', true, lapColumns) : ''}</section>`;
}

function renderGroupedSegmentRows(rows, ui) {
  const headings = [ui.segment, ui.time, ui.distance, ui.terrain, ui.grade, ui.effort, ui.heartRate, ui.speed, ui.elevation];
  const body = rows.map((row) => {
    const members = Array.isArray(row.members) ? row.members : [];
    if (members.length !== 1) {
      return `<tr class="segmentSummaryRow"><td>${escapeHtml(row.number)}</td><td colspan="8">${escapeHtml(row.details)}</td></tr>`;
    }
    const segment = members[0];
    const terrain = segment.technical ? ui.technical : (ui[segment.type] || ui.segment);
    const elevation = segment.type === 'climb' && Number(segment.elevGainM) > 0
      ? displayNumber(segment.elevGainM, ' m', 0, '+') : '';
    return `<tr><td>${escapeHtml(row.number)}</td><td>${escapeHtml(row.time)}</td><td>${escapeHtml(rangeDistance(segment))}</td><td>${escapeHtml(terrain)}</td><td>${escapeHtml(displayNumber(segment.avgGrade, '%', 1))}</td><td>${escapeHtml(displaySegmentEffort(segment, ui))}</td><td>${escapeHtml(displayNumber(segment.avgHr, ' bpm', 0))}</td><td>${escapeHtml(displayNumber(segment.avgSpeedKmh, ' km/h', 1))}</td><td>${escapeHtml(elevation)}</td></tr>`;
  }).join('');
  return `<div class="activityTableWrap" data-activity-table="segments"><table class="activityTable"><thead><tr>${headings.map((heading) => `<th>${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function displaySegmentEffort(segment, ui) {
  if (segment.type === 'descent' || segment.type === 'stopped' || !Number.isFinite(Number(segment.avgPower))) return '';
  if (segment.effortBasis === 'power') return `${ui.power} ${Math.round(Number(segment.avgPower))} W`;
  if (segment.effortBasis === 'vpower') return `${ui.virtualPower} ${Math.round(Number(segment.avgPower))} W`;
  return '';
}

function positiveNumberOrBlank(value) {
  const number = asNumber(value);
  return Number.isFinite(number) && number > 0 ? escapeHtml(String(Math.round(number))) : '';
}

function formatDuration(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? formatHms(seconds) : '';
}

function rangeDistance(segment) {
  if (segment?.type === 'stopped') return '';
  const distance = Number(segment.endDistanceKm) - Number(segment.startDistanceKm);
  return Number.isFinite(distance) && distance >= 0 ? `${distance.toFixed(2)} km` : '';
}

function displayNumber(value, suffix, digits, prefix = '') {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? `${prefix}${number.toFixed(digits)}${suffix}` : '';
}

function segmentColor(index) {
  return `hsl(${Math.round((index * 137.508 + 20) % 360)} 58% 43%)`;
}

function parseActivityTime(value) {
  if (!value) return null;
  const iso = new Date(value);
  if (!isNaN(iso.getTime())) return iso;
  const m = String(value).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return null;
}

function displayLanguage(locale) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) || locale;
  } catch {
    return locale;
  }
}

function buildTranslationPrompt(locale) {
  return `Translate the following FIT Visualizer UI string catalog into the language identified by locale "${locale}". Return only one valid JSON object: the exact English source strings must remain keys, every key must be present exactly once, placeholders such as {0} and {1} must remain unchanged, and values must be plain text without markdown, HTML, or commentary. This catalog contains application UI text and glossary definitions only; it contains no activity, location, or user data.\n\n${JSON.stringify(Object.fromEntries(translationMessages().map((message) => [message, ''])))} `;
}

function buildWebviewAssets(webview, extensionUri, nonce) {
  const leafletCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'leaflet', 'dist', 'leaflet.css')).toString();
  const leafletJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'leaflet', 'dist', 'leaflet.js')).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    'connect-src https:',
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return { leafletCss, leafletJs, csp };
}

function renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, isComparison, compData, athleteProfile, analysis, analysisChat, wheelCalibration, ui, glossary, shouldOfferTranslations, language, segments, analysisVersion, comparisonText) {
  const records = normalizeRecordSpeeds(Array.isArray(fitData.records) ? fitData.records : []);
  const sessions = Array.isArray(fitData.sessions) ? fitData.sessions : [];
  const compRecords = compData && Array.isArray(compData.records) ? normalizeRecordSpeeds(compData.records) : [];
  const hasOverlay = compRecords.length > 0;
  const athleteFtp = asNumber(athleteProfile?.ftp);
  const athleteRestingHrNumber = asNumber(athleteProfile?.restingHeartRate);
  const athleteSex = String(athleteProfile?.sex || '').toLowerCase();
  const powerInput = {
    riderMassKg: athleteProfile?.riderMassKg,
    bikeMassKg: athleteProfile?.bikeMassKg,
  };
  const primaryPower = addEstimatedPowerWhenMissing(records, powerInput);
  const comparisonPower = hasOverlay ? addEstimatedPowerWhenMissing(compRecords, powerInput) : null;

  const summary = buildSummary(primaryPower.records, sessions, {
    ftp: athleteFtp,
    restingHeartRate: athleteRestingHrNumber,
    sex: athleteSex,
    maxHeartRateForHrr: asNumber(hrConfig?.maxHeartRate),
  });
  const compSummary = hasOverlay
    ? buildSummary(comparisonPower.records, Array.isArray(compData.sessions) ? compData.sessions : [], {
      ftp: athleteFtp,
      restingHeartRate: athleteRestingHrNumber,
      sex: athleteSex,
      maxHeartRateForHrr: NaN,
    })
    : null;
  const mapId = isComparison ? 'fitMapComp' : 'fitMap';
  const chartPointBudget = Math.min(4000, Math.max(900, Math.floor(records.length / 2)));
  const speedChart = buildLineChartFromModule(records, 'distance', 'speed', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const hrChart = buildLineChartFromModule(records, 'distance', 'heart_rate', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const altitudeChart = buildLineChartFromModule(records, 'distance', 'altitude', 1400, 380, chartPointBudget, { yTransform: (v) => v * 1000, compRecords: hasOverlay ? compRecords : [] });
  const overlayMetrics = buildOverlayMetricsFromModule(records, chartPointBudget);
  const speedOverlays = buildOverlayOptionsFromModule(overlayMetrics, 'speed');
  const hrOverlays = buildOverlayOptionsFromModule(overlayMetrics, 'heart_rate');
  const altitudeOverlays = buildOverlayOptionsFromModule(overlayMetrics, 'altitude');
  const segmentPresentation = buildSegmentContext(segments);
  const presentationByIndex = new Map();
  segmentPresentation.displayRows.forEach((row, index) => row.members.forEach((segment) => {
    presentationByIndex.set(segment.index, { time: row.time, details: row.details, index, color: segmentColor(index) });
  }));
  const presentationSegments = (Array.isArray(segments) ? segments : []).map((segment) => ({
    ...segment,
    displayTime: presentationByIndex.get(segment.index)?.time || '',
    displayDetails: presentationByIndex.get(segment.index)?.details || '',
    displayIndex: presentationByIndex.get(segment.index)?.index ?? -1,
    displayColor: presentationByIndex.get(segment.index)?.color || '#7f8c8d',
  }));
  const chartSegments = mapSegmentsToDistanceRanges(presentationSegments, records);
  const segmentTooltipPayload = safeJson(chartSegments);
  const activityTable = renderActivityTable(chartSegments, fitData.laps, ui);
  const chartClientPayloads = safeJson({
    [mapId + 'SpeedSvg']: buildChartClientPayloadFromModule(speedChart, 'km', 'km/h', speedOverlays),
    [mapId + 'HrSvg']: buildChartClientPayloadFromModule(hrChart, 'km', 'bpm', hrOverlays),
    [mapId + 'AltSvg']: buildChartClientPayloadFromModule(altitudeChart, 'km', 'm', altitudeOverlays),
  });
  const hrZones = computeHeartRateZones(records, hrConfig?.maxHeartRate, hrConfig?.thresholds);
  const gpsRoutePointBudget = Math.min(6000, Math.max(1200, records.length));
  const gpsRoute = buildGpsRouteFromModule(records, 1400, 420, gpsRoutePointBudget);
  const compGpsPoints = hasOverlay ? safeJson(extractGpsPoints(compRecords).slice(0, gpsRoutePointBudget).map((p) => ({ lat: p.y, lon: p.x }))) : 'null';

  const mapPayload = safeJson(gpsRoute.geoPoints);
  const segmentPayload = safeJson(presentationSegments);
  const safeFile = escapeHtml(fitData._fileName || '');
  const activitySession = sessions[0] || {};
  const avgHrValue = positiveNumberOrBlank(activitySession.avg_hr);
  const maxHrValue = positiveNumberOrBlank(activitySession.max_hr);
  const activityDate = toDateOnly(activitySession.start_time) || '';
  const profileMaxHr = positiveNumberOrBlank(hrConfig?.maxHeartRate);
  const profileThresholds = Array.isArray(hrConfig?.thresholds) ? hrConfig.thresholds : [];
  const athleteSexValue = escapeHtml(athleteProfile?.sex || '');
  const athleteAge = escapeHtml(athleteProfile?.age || '');
  const athleteRestingHr = escapeHtml(athleteProfile?.restingHeartRate || '');
  const athleteFtpValue = escapeHtml(athleteProfile?.ftp || '');
  const riderMassValue = escapeHtml(athleteProfile?.riderMassKg || '');
  const bikeMassValue = escapeHtml(athleteProfile?.bikeMassKg || '');
  const wheelCircumferenceValue = escapeHtml(athleteProfile?.wheelCircumferenceMm || '');
  // Recomputed live from whatever is typed in the field below (client script), not only after Save Zones -
  // waiting for a round trip to see a number was the confusing part.
    const wheelCalibrationHint = wheelCalibration ? `<div class="calibrationHint" id="${mapId}WheelHint" data-ratio="${wheelCalibration.ratio}">
      ${escapeHtml(formatUi(ui.wheelCalibrationEvidence, wheelCalibration.trustedDistanceKm, wheelCalibration.deviationPct))}
      <span id="${mapId}WheelSuggestion"></span>
      <button type="button" id="${mapId}ApplyWheelHint" style="display:none"></button>
      <button type="button" id="${mapId}DismissWheelHint">Dismiss</button>
    </div>` : '';
  const powerMetricSuffix = primaryPower.source === 'estimated' ? ' (estimated)' : '';

  const compStatsRow = hasOverlay && compSummary
    ? renderComparisonTable(summary, compSummary, fitData._fileName, compData._fileName, glossary, ui)
    : '';

  return `<main class="wrap">
    <section class="hero">
      <h1>${escapeHtml(ui.fitActivity)}</h1>
      <div class="muted">${safeFile}</div>
    </section>
    ${shouldOfferTranslations ? `<section class="calibrationHint"><span>${escapeHtml(formatUi(ui.translationsAvailable, language))}</span><button type="button" id="generateTranslationsBtn">${escapeHtml(formatUi(ui.generateTranslations, language))}</button><span id="translationStatus"></span></section>` : ''}
    ${compStatsRow}
    <section class="grid">
      ${metric('Records', summary.records, 'records', glossary)}
      ${metric('Sessions', sessions.length, 'sessions', glossary)}
      ${metric('Distance (km)', summary.distanceKm.toFixed(2), 'distance', glossary)}
      ${metric('Duration (h:m:s)', summary.durationText, 'duration', glossary)}
      ${metric('Avg Speed (km/h)', summary.avgSpeed.toFixed(2), 'averageSpeed', glossary)}
      ${metric('Max Speed (km/h)', summary.maxSpeed.toFixed(2), 'maximumSpeed', glossary)}
      ${metric('Avg Power (W)' + powerMetricSuffix, summary.avgPower.toFixed(0), 'averagePower', glossary)}
      ${metric('Max Power (W)' + powerMetricSuffix, summary.maxPower.toFixed(0), 'maximumPower', glossary)}
      ${metric('Normalized Power (W)' + powerMetricSuffix, summary.normalizedPower?.toFixed(0) ?? 'n/a', 'normalizedPower', glossary)}
      ${metric('Intensity Factor (IF)' + powerMetricSuffix, summary.intensityFactor > 0 ? summary.intensityFactor.toFixed(2) : 'n/a', 'intensityFactor', glossary)}
      ${metric('TSS' + powerMetricSuffix, summary.trainingStressScore > 0 ? summary.trainingStressScore.toFixed(1) : 'n/a', 'trainingStressScore', glossary)}
      ${metric('xPower (GC) (W)' + powerMetricSuffix, summary.xPower > 0 ? summary.xPower.toFixed(0) : 'n/a', 'xpower', glossary)}
      ${metric('RI (GC)' + powerMetricSuffix, summary.relativeIntensityGc > 0 ? summary.relativeIntensityGc.toFixed(2) : 'n/a', 'relativeIntensity', glossary)}
      ${metric('BikeStress (GC)' + powerMetricSuffix, summary.bikeStressScore > 0 ? summary.bikeStressScore.toFixed(1) : 'n/a', 'bikeStress', glossary)}
      ${metric('Decoupling % (Intervals)' + powerMetricSuffix, Number.isFinite(summary.decouplingPct) ? summary.decouplingPct.toFixed(1) + '%' : 'n/a', 'decoupling', glossary)}
      ${metric('TRIMP', summary.trimp > 0 ? summary.trimp.toFixed(1) : 'n/a', 'trimp', glossary)}
      ${metric('hrTSS', summary.hrTss > 0 ? summary.hrTss.toFixed(1) : 'n/a', 'hrTss', glossary)}
      ${metric('Avg HR (bpm)', summary.avgHr.toFixed(0), 'averageHeartRate', glossary)}
      ${metric('Max HR (bpm)', summary.maxHr.toFixed(0), 'maximumHeartRate', glossary)}
      ${metric('Elevation Gain (m)', summary.elevationGainM.toFixed(0), 'elevationGain', glossary)}
      ${metric('Elevation Loss (m)', summary.elevationLossM.toFixed(0), 'elevationLoss', glossary)}
      ${metric('GPS Points', gpsRoute.pointCount, 'gpsPoints', glossary)}
    </section>
    ${primaryPower.source === 'estimated' ? `<section style="padding:12px;margin-bottom:16px;background:rgba(255,193,7,0.1);border-left:4px solid #ffc107;color:var(--ink);font-size:0.95rem;line-height:1.5;">
      <strong>⚠ Data Quality Note:</strong> Power metrics are motion-estimated (from speed, altitude, and mass) and may be physiologically implausible, especially peak values. These figures and derived metrics (NP, IF, TSS, xPower, RI, BikeStress, Decoupling) should be disregarded for training-load decisions. Use heart-rate trends and effort perception instead.
    </section>` : ''}
    <section class="chart manualData">
      <h2>${escapeHtml(ui.manualActivityData)}</h2>
      <form id="${mapId}ManualDataForm" class="manualDataForm">
        <label>
          <span>${escapeHtml(ui.averageHeartRate)}</span>
          <input id="${mapId}ManualAvgHr" type="number" min="30" max="240" step="1" value="${avgHrValue}" placeholder="${escapeHtml(ui.notAvailable)}">
        </label>
        <label>
          <span>${escapeHtml(ui.maximumHeartRate)}</span>
          <input id="${mapId}ManualMaxHr" type="number" min="30" max="240" step="1" value="${maxHrValue}" placeholder="${escapeHtml(ui.notAvailable)}">
        </label>
        <button type="submit">${escapeHtml(ui.saveHeartRate)}</button>
        <span id="${mapId}ManualDataStatus" class="manualDataStatus"></span>
      </form>
      <div class="mapHint">Manual summary values are used in metrics and analysis. A heart-rate chart requires time-series samples.</div>
    </section>
    <section class="chart manualData">
      <h2>${escapeHtml(ui.heartRateZoneProfile)}</h2>
      <form id="${mapId}HrProfileForm" class="manualDataForm">
        <label>
          <span>${escapeHtml(ui.effectiveFrom)}</span>
          <input id="${mapId}HrEffectiveDate" type="date" value="${escapeHtml(activityDate)}" required>
        </label>
        <label>
          <span>Maximum HR</span>
          <input id="${mapId}ProfileMaxHr" type="number" min="100" max="240" step="1" value="${profileMaxHr}" required>
        </label>
        ${[2, 3, 4, 5].map((zone, index) => `<label>
          <span>Zone ${zone} starts</span>
          <input id="${mapId}Zone${zone}Start" type="number" min="30" max="240" step="1" value="${positiveNumberOrBlank(profileThresholds[index])}" placeholder="${escapeHtml(ui.auto)}">
        </label>`).join('')}
        <label>
          <span>Sex</span>
          <select id="${mapId}AthleteSex">
            <option value=""${athleteSexValue ? '' : ' selected'}>${escapeHtml(ui.select)}</option>
            <option value="male"${athleteSexValue === 'male' ? ' selected' : ''}>Male</option>
            <option value="female"${athleteSexValue === 'female' ? ' selected' : ''}>Female</option>
            <option value="other"${athleteSexValue === 'other' ? ' selected' : ''}>Other</option>
          </select>
        </label>
        <label>
          <span>${escapeHtml(ui.age)}</span>
          <input id="${mapId}AthleteAge" type="number" min="10" max="100" step="1" value="${athleteAge}" placeholder="${escapeHtml(ui.years)}">
        </label>
        <label>
          <span>${escapeHtml(ui.restingHeartRate)}</span>
          <input id="${mapId}AthleteRestingHr" type="number" min="30" max="120" step="1" value="${athleteRestingHr}" placeholder="bpm">
        </label>
        <label>
          <span>FTP</span>
          <input id="${mapId}AthleteFtp" type="number" min="80" max="500" step="1" value="${athleteFtpValue}" placeholder="${escapeHtml(ui.watts)}">
        </label>
        <label>
          <span>${escapeHtml(ui.riderMass)}</span>
          <input id="${mapId}RiderMass" type="number" min="30" max="250" step="0.1" value="${riderMassValue}" placeholder="${escapeHtml(ui.requiredForEstimatedPower)}">
        </label>
        <label>
          <span>${escapeHtml(ui.bikeMass)}</span>
          <input id="${mapId}BikeMass" type="number" min="3" max="50" step="0.1" value="${bikeMassValue}" placeholder="${escapeHtml(ui.requiredForEstimatedPower)}">
        </label>
        <label>
          <span>${escapeHtml(ui.wheelCircumference)}</span>
          <input id="${mapId}WheelCircumference" type="number" min="1000" max="2500" step="0.1" value="${wheelCircumferenceValue}" placeholder="e.g. 2105">
        </label>
        <button type="button" id="${mapId}AutoCalcZonesBtn">${escapeHtml(ui.autoCalculate)}</button>
        <button type="submit">${escapeHtml(ui.saveZones)}</button>
        <span id="${mapId}HrProfileStatus" class="manualDataStatus"></span>
      </form>
      ${wheelCalibrationHint}
      <div class="mapHint">Auto-calc estimates power from the saved rider and bike mass, speed, GPS altitude, and distance when power-meter data is unavailable. The last saved masses are reused for the next ride. FTP is used for IF/TSS on activity summaries. The latest profile effective on an activity date is used.${hrConfig?.effectiveDate ? ` Currently applied: ${escapeHtml(hrConfig.effectiveDate)}.` : ''}</div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}SpeedSvg" data-resize-key="fitviz_speed_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.speedVsDistance)}${hasOverlay ? ' <span class="compLegend">- ' + escapeHtml(ui.primary) + ' / ' + escapeHtml(ui.comparison) + '</span>' : ''}</h2>
      <label class="segmentBandControls"><input id="${mapId}SegmentBands" type="checkbox" checked> ${escapeHtml(ui.showTerrainBands)}</label>
      ${renderStatsRow(speedChart.stats, 'km/h')}${hasOverlay && speedChart.compStats ? renderStatsRow(speedChart.compStats, 'km/h', true) : ''}
      ${renderOverlayControls(mapId + 'SpeedSvg', speedOverlays)}
      ${renderScaledLineChartSvg(speedChart, 'lineA', 'Distance (km)', 'Speed (km/h)', true, { svgId: mapId + 'SpeedSvg', segmentBands: chartSegments })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}HrSvg" data-resize-key="fitviz_hr_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.heartRateVsDistance)}</h2>
      ${renderStatsRow(hrChart.stats, 'bpm')}
      ${renderHeartRateZones(hrZones)}
      ${renderOverlayControls(mapId + 'HrSvg', hrOverlays)}
      ${renderScaledLineChartSvg(hrChart, 'lineB', 'Distance (km)', 'Heart rate (bpm)', true, { svgId: mapId + 'HrSvg', zoneThresholds: hrZones.enabled ? hrZones.thresholds : null, segmentBands: chartSegments })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}AltSvg" data-resize-key="fitviz_alt_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.altitudeVsDistance)}${hasOverlay ? ' <span class="compLegend">- ' + escapeHtml(ui.primary) + ' / ' + escapeHtml(ui.comparison) + '</span>' : ''}</h2>
      ${renderStatsRow(altitudeChart.stats, 'm')}${hasOverlay && altitudeChart.compStats ? renderStatsRow(altitudeChart.compStats, 'm', true) : ''}
      ${renderOverlayControls(mapId + 'AltSvg', altitudeOverlays)}
      ${renderScaledLineChartSvg(altitudeChart, 'lineC', 'Distance (km)', 'Altitude (m)', true, { svgId: mapId + 'AltSvg', segmentBands: chartSegments })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    ${activityTable}
    <div id="${mapId}SegmentTooltip" class="segmentTooltip" role="tooltip" hidden></div>
    <section id="${mapId}RouteSection" class="chart">
      <h2>${escapeHtml(ui.gpsRoute)}</h2>
      ${renderGpsRouteSvg(gpsRoute, 1400, 420)}
      <div class="legend">Route (${escapeHtml(gpsRoute.boundsText)})</div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}" data-resize-key="fitviz_map_height" data-min-height="260" data-max-height="1400" data-target-type="map">
      <h2>${escapeHtml(ui.interactiveMap)}</h2>
      ${renderMapStats(gpsRoute)}
      <div class="mapWrap">
        <div class="mapControls">
          <label for="${mapId}Mode">${escapeHtml(ui.colorRouteBy)}</label>
          <select id="${mapId}Mode">
            <option value="speed">${escapeHtml(ui.speed)}</option>
            <option value="heart_rate">${escapeHtml(ui.heartRate)}</option>
            <option value="segment" selected>${escapeHtml(ui.segment)}</option>
          </select>
        </div>
        <div id="${mapId}SegmentLegend" class="segmentLegend" style="display:none"></div>
        <div id="${mapId}"></div>
        <div class="mapHint">${escapeHtml(ui.mapTiles)}</div>
      </div>
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart">
      <h2>${escapeHtml(ui.aiAnalysis)}</h2>
      <div id="analysisContent" style="padding:12px;color:var(--muted);min-height:80px;line-height:1.5;">
        <p style="margin:0;">${escapeHtml(ui.loadingAnalysis)}</p>
      </div>
      <button id="analyzeBtn" style="margin-top:10px;padding:8px 16px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">${escapeHtml(ui.analyzeActivity)}</button>
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
        <h3 style="margin:0 0 8px 0;font-size:0.95rem;color:var(--muted);">${escapeHtml(ui.followUpChat)}</h3>
        <div id="analysisChatMessages" style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--vscode-editor-background);"></div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:flex-start;">
          <textarea id="analysisChatInput" rows="3" placeholder="${escapeHtml(ui.followUpPlaceholder)}" style="flex:1;min-height:62px;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--input-bg);color:var(--input-fg);"></textarea>
          <button id="analysisChatSendBtn" style="padding:8px 14px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">${escapeHtml(ui.send)}</button>
        </div>
        <div id="analysisChatStatus" style="margin-top:6px;font-size:0.85rem;color:var(--muted);"></div>
      </div>
    </section>
    ${hasOverlay ? `
    <section class="chart">
      <h2>${escapeHtml(ui.compareWithAI)}</h2>
      <div id="comparisonContent" style="padding:12px;color:var(--muted);min-height:60px;line-height:1.5;">
        <p style="margin:0;">${escapeHtml(ui.clickCompare)}</p>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button id="compareBtn" style="padding:8px 16px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">${escapeHtml(ui.compareWithAI)}</button>
        <button id="removeComparisonBtn" style="padding:8px 16px;background:transparent;color:var(--ink);border:1px solid var(--border);border-radius:4px;cursor:pointer;display:none;">${escapeHtml(ui.removeComparison)}</button>
      </div>
    </section>
    ` : ''}
  </main>
  <script nonce="${nonce}">
    (function () {
      const ui = ${safeJson(ui)};
      function formatMessage(template) {
        const values = Array.prototype.slice.call(arguments, 1);
        return String(template || '').replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
      }
      // Helper to escape HTML
      function escapeHtml(text) {
        return String(text)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      const analysisContent = document.getElementById('analysisContent');
      const analyzeBtn = document.getElementById('analyzeBtn');
      const analysisChatMessagesEl = document.getElementById('analysisChatMessages');
      const analysisChatInput = document.getElementById('analysisChatInput');
      const analysisChatSendBtn = document.getElementById('analysisChatSendBtn');
      const analysisChatStatus = document.getElementById('analysisChatStatus');
      const generateTranslationsBtn = document.getElementById('generateTranslationsBtn');
      const translationStatus = document.getElementById('translationStatus');
      const manualDataForm = document.getElementById('${mapId}ManualDataForm');
      const manualDataStatus = document.getElementById('${mapId}ManualDataStatus');
      const hrProfileForm = document.getElementById('${mapId}HrProfileForm');
      const hrProfileStatus = document.getElementById('${mapId}HrProfileStatus');
      const autoCalcZonesBtn = document.getElementById('${mapId}AutoCalcZonesBtn');
      const comparisonContent = document.getElementById('comparisonContent');
      const compareBtn = document.getElementById('compareBtn');
      const removeComparisonBtn = document.getElementById('removeComparisonBtn');
      const vscode = window.fitVisualizerApi;
      const initialAnalysis = ${safeJson(analysis?.text || '')};
      let hasAnalysis = Boolean(initialAnalysis);
      let analysisOutdated = ${analysis && asNumber(analysis.version) < analysisVersion ? 'true' : 'false'};
      let chatMessages = ${safeJson(Array.isArray(analysisChat) ? analysisChat : [])};
      const initialComparison = ${safeJson(comparisonText || '')};
      let hasComparison = Boolean(initialComparison);
      let compareActivityId = ${compData && compData._activityId ? compData._activityId : 'null'};

      function analyzeButtonLabel() {
        if (!hasAnalysis) return ui.analyzeActivity;
        return analysisOutdated ? ui.reanalyze : ui.analyzeAgain;
      }

      function showAnalysisText(text) {
        const note = analysisOutdated
          ? '<div style="margin:0 0 10px 0;padding:8px 10px;border-left:4px solid #ffc107;background:rgba(255,193,7,0.1);font-size:0.92rem;">' + escapeHtml(ui.olderAnalysis) + '</div>'
          : '';
        analysisContent.innerHTML = note + '<div style="color:var(--ink);font-size:1.08rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;">' + escapeHtml(text) + '</div>';
      }

      function compareButtonLabel() {
        return hasComparison ? ui.compareAgain : ui.compareWithAI;
      }

      function showComparisonText(text) {
        if (!comparisonContent) return;
        comparisonContent.innerHTML = '<div style="color:var(--ink);font-size:1.08rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;">' + escapeHtml(text) + '</div>';
        if (removeComparisonBtn) removeComparisonBtn.style.display = '';
      }

      if (comparisonContent) {
        if (initialComparison) {
          showComparisonText(initialComparison);
        }
        if (compareBtn) compareBtn.textContent = compareButtonLabel();
      }

      function renderChatMessages() {
        if (!analysisChatMessagesEl) return;
        if (!Array.isArray(chatMessages) || !chatMessages.length) {
          analysisChatMessagesEl.innerHTML = '<div style="color:var(--muted);font-size:0.9rem;">' + escapeHtml(ui.noMessages) + '</div>';
          return;
        }
        analysisChatMessagesEl.innerHTML = chatMessages.map((entry) => {
          const role = entry.role === 'assistant' ? ui.coach : ui.you;
          const bg = entry.role === 'assistant' ? 'var(--vscode-editorWidget-background)' : 'var(--vscode-inputOption-activeBackground)';
          return '<div style="margin:0 0 8px 0;padding:8px;border:1px solid var(--border);border-radius:6px;background:' + bg + ';">'
            + '<div style="font-size:0.75rem;color:var(--muted);margin-bottom:4px;">' + role + '</div>'
            + '<div style="white-space:pre-wrap;line-height:1.45;">' + escapeHtml(entry.content || '') + '</div>'
            + '</div>';
        }).join('');
        analysisChatMessagesEl.scrollTop = analysisChatMessagesEl.scrollHeight;
      }

      renderChatMessages();
      if (initialAnalysis) {
        showAnalysisText(initialAnalysis);
        analyzeBtn.textContent = analyzeButtonLabel();
      } else {
        analysisContent.innerHTML = '<p style="margin:0;color:var(--muted);">' + escapeHtml(ui.clickAnalyze) + '</p>';
      }
      
      window.addEventListener('message', (event) => {
        const msg = event.data;
        const currentId = Number(window.currentActivityId);
        if ((msg.type === 'analysisResult'
          || msg.type === 'analysisError'
          || msg.type === 'noAnalysis'
          || msg.type === 'analysisChatState'
          || msg.type === 'analysisChatError')
          && Number.isFinite(currentId)
          && Number(msg.id) !== currentId) {
          return;
        }
        if ((msg.type === 'comparisonResult' || msg.type === 'comparisonError' || msg.type === 'comparisonRemoved')
          && Number.isFinite(currentId)
          && (Number(msg.id) !== currentId || Number(msg.compId) !== Number(compareActivityId))) {
          return;
        }
        if (msg.type === 'analysisResult') {
          hasAnalysis = true;
          analysisOutdated = false;
          showAnalysisText(msg.analysis);
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = analyzeButtonLabel();
        } else if (msg.type === 'noAnalysis') {
          hasAnalysis = false;
          analysisOutdated = false;
          analysisContent.innerHTML = '<p style="margin:0;color:var(--muted);">' + escapeHtml(ui.clickAnalyze) + '</p>';
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = analyzeButtonLabel();
        } else if (msg.type === 'analysisError') {
          analysisContent.innerHTML = '<div style="color:#ff6b6b;">' + escapeHtml(formatMessage(ui.error, msg.error)) + '</div>';
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = analyzeButtonLabel();
        } else if (msg.type === 'analysisChatState') {
          chatMessages = Array.isArray(msg.messages) ? msg.messages : [];
          renderChatMessages();
          analysisChatSendBtn.disabled = false;
          analysisChatStatus.textContent = '';
        } else if (msg.type === 'analysisChatError') {
          analysisChatSendBtn.disabled = false;
          analysisChatStatus.textContent = formatMessage(ui.error, String(msg.error || ui.chatFailed));
          analysisChatStatus.style.color = '#ff6b6b';
        } else if (msg.type === 'comparisonResult') {
          hasComparison = true;
          showComparisonText(msg.comparison);
          if (compareBtn) {
            compareBtn.disabled = false;
            compareBtn.textContent = compareButtonLabel();
          }
        } else if (msg.type === 'comparisonError') {
          if (comparisonContent) {
            comparisonContent.innerHTML = '<div style="color:#ff6b6b;">' + escapeHtml(formatMessage(ui.error, msg.error)) + '</div>';
          }
          if (compareBtn) {
            compareBtn.disabled = false;
            compareBtn.textContent = compareButtonLabel();
          }
        } else if (msg.type === 'comparisonRemoved') {
          hasComparison = false;
          if (comparisonContent) {
            comparisonContent.innerHTML = '<p style="margin:0;color:var(--muted);">' + escapeHtml(ui.clickCompare) + '</p>';
          }
          if (compareBtn) compareBtn.textContent = compareButtonLabel();
          if (removeComparisonBtn) {
            removeComparisonBtn.disabled = false;
            removeComparisonBtn.textContent = ui.removeComparison;
            removeComparisonBtn.style.display = 'none';
          }
        } else if (msg.type === 'translationError') {
          if (translationStatus) translationStatus.textContent = formatMessage(ui.error, String(msg.error || ''));
          if (generateTranslationsBtn) generateTranslationsBtn.disabled = false;
        } else if (msg.type === 'manualDataError') {
          manualDataStatus.textContent = msg.error;
          manualDataStatus.classList.add('error');
        } else if (msg.type === 'heartRateProfileError') {
          hrProfileStatus.textContent = msg.error;
          hrProfileStatus.classList.add('error');
        } else if (msg.type === 'heartRateProfileAuto') {
          document.getElementById('${mapId}ProfileMaxHr').value = msg.suggestion.maxHeartRate;
          [2, 3, 4, 5].forEach((zone, index) => {
            document.getElementById('${mapId}Zone' + zone + 'Start').value = msg.suggestion.thresholds[index];
          });
          if (msg.suggestion.ftp > 0) {
            document.getElementById('${mapId}AthleteFtp').value = msg.suggestion.ftp;
          }
          const ftpMessage = msg.suggestion.ftp > 0
            ? ' FTP estimate applied; review and save.'
            : ' No valid 20-minute power effort found, so FTP was left unchanged.';
          const mmpMessage = Array.isArray(msg.suggestion.mmp)
            ? (() => {
              const points = msg.suggestion.mmp
                .filter((point) => point.power > 0)
                .map((point) => Math.round(point.durationSec / 60) + 'm ' + Math.round(point.power) + 'W');
              return points.length ? ' MMP: ' + points.join(', ') + '.' : ' MMP: unavailable.';
            })()
            : '';
          const candidateMessage = msg.suggestion.ftpCandidates
            ? ' Candidates: ' + Object.entries(msg.suggestion.ftpCandidates)
              .filter(([key]) => !['cp', 'w_prime', 'r_squared'].includes(key))
              .map(([key, value]) => key + ' ' + Math.round(value) + 'W')
              .join(', ') + '.'
            : '';
          const mmpStatus = msg.suggestion.mmpStatus || {};
          const diagnosticMessage = mmpStatus.validTimedPowerCount === 0
            ? (mmpStatus.powerSource === 'estimated'
              ? ' MMP source: estimated from mass, speed, GPS altitude, and distance.'
              : ' MMP unavailable: ' + mmpStatus.activityCount + ' rides and '
                + mmpStatus.totalRecordCount + ' records loaded, but no measured or estimable motion data was found.')
            : ' MMP source: measured power from ' + mmpStatus.validTimedPowerCount
              + ' timed power records across ' + mmpStatus.activityCount + ' rides.';
          const candidateStatus = Object.keys(msg.suggestion.ftpCandidates || {}).length
            ? candidateMessage
            : ' Candidates: unavailable.';
          hrProfileStatus.textContent = 'Auto values applied. Review and save to keep them.'
            + ftpMessage + mmpMessage + candidateStatus + diagnosticMessage;
          hrProfileStatus.classList.remove('error');
        }
      });

      autoCalcZonesBtn?.addEventListener('click', () => {
        hrProfileStatus.textContent = ui.calculating;
        hrProfileStatus.classList.remove('error');
        vscode.postMessage({
          type: 'autoCalculateHeartRateProfile',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
          effectiveDate: document.getElementById('${mapId}HrEffectiveDate').value,
          sex: document.getElementById('${mapId}AthleteSex').value,
          age: document.getElementById('${mapId}AthleteAge').value,
          restingHr: document.getElementById('${mapId}AthleteRestingHr').value,
          riderMassKg: document.getElementById('${mapId}RiderMass').value,
          bikeMassKg: document.getElementById('${mapId}BikeMass').value,
        });
      });

      manualDataForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        manualDataStatus.textContent = ui.saving;
        manualDataStatus.classList.remove('error');
        vscode.postMessage({
          type: 'updateActivityHeartRate',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
          avgHr: document.getElementById('${mapId}ManualAvgHr').value,
          maxHr: document.getElementById('${mapId}ManualMaxHr').value,
        });
      });

      hrProfileForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        hrProfileStatus.textContent = ui.saving;
        hrProfileStatus.classList.remove('error');
        vscode.postMessage({
          type: 'updateHeartRateProfile',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
          effectiveDate: document.getElementById('${mapId}HrEffectiveDate').value,
          maxHr: document.getElementById('${mapId}ProfileMaxHr').value,
          thresholds: [2, 3, 4, 5].map((zone) => document.getElementById('${mapId}Zone' + zone + 'Start').value),
          sex: document.getElementById('${mapId}AthleteSex').value,
          age: document.getElementById('${mapId}AthleteAge').value,
          restingHr: document.getElementById('${mapId}AthleteRestingHr').value,
          ftp: document.getElementById('${mapId}AthleteFtp').value,
          riderMassKg: document.getElementById('${mapId}RiderMass').value,
          bikeMassKg: document.getElementById('${mapId}BikeMass').value,
          wheelCircumferenceMm: document.getElementById('${mapId}WheelCircumference').value,
        });
      });

      (function () {
        const hint = document.getElementById('${mapId}WheelHint');
        if (!hint) return;
        const ratio = parseFloat(hint.getAttribute('data-ratio'));
        const suggestionEl = document.getElementById('${mapId}WheelSuggestion');
        const applyBtn = document.getElementById('${mapId}ApplyWheelHint');
        const dismissBtn = document.getElementById('${mapId}DismissWheelHint');
        const wheelInput = document.getElementById('${mapId}WheelCircumference');

        // Recomputes on every keystroke: no need to save first to see whether a number appears.
        function updateSuggestion() {
          const current = Number(wheelInput.value);
          if (!wheelInput.value || !Number.isFinite(current) || current <= 0) {
            suggestionEl.textContent = ui.wheelPrompt;
            applyBtn.style.display = 'none';
            return;
          }
          const recommended = Math.round((current / ratio) * 10) / 10;
          suggestionEl.textContent = formatMessage(ui.wheelSuggestion, recommended, current);
          applyBtn.textContent = formatMessage(ui.useWheelSuggestion, recommended);
          applyBtn.dataset.recommended = String(recommended);
          applyBtn.style.display = '';
        }

        wheelInput?.addEventListener('input', updateSuggestion);
        applyBtn?.addEventListener('click', () => {
          if (wheelInput && applyBtn.dataset.recommended) wheelInput.value = applyBtn.dataset.recommended;
          suggestionEl.textContent = ui.wheelApplied;
          applyBtn.style.display = 'none';
        });
        dismissBtn?.addEventListener('click', () => hint.remove());
        updateSuggestion();
      }());

      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', () => {
          if (!window.currentActivityId || window.currentActivityId === 'null') {
            analysisContent.innerHTML = '<div style="color:#ff6b6b;">' + escapeHtml(formatMessage(ui.error, ui.noActivityLoaded)) + '</div>';
            return;
          }
          analyzeBtn.disabled = true;
          analyzeBtn.textContent = ui.analyzing;
          vscode.postMessage({ type: 'analyzeActivity', id: window.currentActivityId, force: hasAnalysis });
        });
      }

      compareBtn?.addEventListener('click', () => {
        if (!window.currentActivityId || window.currentActivityId === 'null' || !compareActivityId) {
          return;
        }
        compareBtn.disabled = true;
        compareBtn.textContent = ui.comparing;
        vscode.postMessage({ type: 'compareActivitiesAI', id: window.currentActivityId, compId: compareActivityId, force: hasComparison });
      });

      removeComparisonBtn?.addEventListener('click', () => {
        if (!window.currentActivityId || window.currentActivityId === 'null' || !compareActivityId) {
          return;
        }
        removeComparisonBtn.disabled = true;
        removeComparisonBtn.textContent = ui.removingComparison;
        vscode.postMessage({ type: 'removeComparison', id: window.currentActivityId, compId: compareActivityId });
      });

      generateTranslationsBtn?.addEventListener('click', () => {
        generateTranslationsBtn.disabled = true;
        if (translationStatus) translationStatus.textContent = ui.translationGenerating;
        vscode.postMessage({
          type: 'generateTranslations',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
        });
      });

      function sendChatTurn() {
        if (!window.currentActivityId || window.currentActivityId === 'null') {
          analysisChatStatus.textContent = ui.noActivitySelected;
          analysisChatStatus.style.color = '#ff6b6b';
          return;
        }
        const text = String(analysisChatInput.value || '').trim();
        if (!text) {
          analysisChatStatus.textContent = ui.enterFollowUp;
          analysisChatStatus.style.color = '#ff6b6b';
          return;
        }
        analysisChatStatus.textContent = ui.thinking;
        analysisChatStatus.style.color = 'var(--muted)';
        analysisChatSendBtn.disabled = true;
        chatMessages = [...chatMessages, { role: 'user', content: text }];
        renderChatMessages();
        analysisChatInput.value = '';
        vscode.postMessage({
          type: 'analysisChatTurn',
          id: window.currentActivityId,
          text,
        });
      }

      analysisChatSendBtn?.addEventListener('click', sendChatTurn);
      analysisChatInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendChatTurn();
        }
      });

      window.currentActivityId = ${fitData && fitData._activityId ? fitData._activityId : 'null'};

      if (!window.currentActivityId) {
        analysisContent.innerHTML = '<p style="margin:0;color:#ff6b6b;">' + escapeHtml(ui.noActivityDataForAnalysis) + '</p>';
        analysisChatSendBtn.disabled = true;
      }
    }());
  </script>
  <script nonce="${nonce}">
    (function () {
      const routePoints = ${mapPayload};
      const activitySegments = ${segmentPayload};
      const ui = ${safeJson(ui)};
      const mapEl = document.getElementById('${mapId}');
      const gpsRouteSection = document.getElementById('${mapId}RouteSection');

      setupResizablePanels(function onResized(targetId) {
        if (targetId === '${mapId}' && map) {
          setTimeout(() => { map.invalidateSize(false); map.eachLayer((l) => { if (window.L && l instanceof L.TileLayer) l.redraw(); }); }, 0);
        }
      });

      let map = null;
      const hasRoute = Array.isArray(routePoints) && routePoints.length >= 2;

      function escapeSegmentHtml(text) {
        return String(text)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      window.formatSegmentDetails = function formatSegmentDetails(segment) {
        if (!segment) return '';
        if (segment.displayDetails) {
          return (segment.displayTime ? '<strong>' + escapeSegmentHtml(segment.displayTime) + '</strong><br>' : '')
            + escapeSegmentHtml(segment.displayDetails);
        }
        const fields = [];
        const type = segment.technical ? ui.technical : ui[segment.type];
        if (type) fields.push('<strong>' + escapeSegmentHtml(type) + '</strong>');
        if (Number.isFinite(Number(segment.durationS))) fields.push(escapeSegmentHtml(ui.duration) + ': ' + Math.round(Number(segment.durationS) / 60) + ':' + String(Math.round(Number(segment.durationS)) % 60).padStart(2, '0'));
        if (Number.isFinite(Number(segment.startDistanceKm)) && Number.isFinite(Number(segment.endDistanceKm))) fields.push(escapeSegmentHtml(ui.distance) + ': ' + Math.max(0, Number(segment.endDistanceKm) - Number(segment.startDistanceKm)).toFixed(2) + ' km');
        if (Number.isFinite(Number(segment.avgGrade))) fields.push(escapeSegmentHtml(ui.grade) + ': ' + Number(segment.avgGrade).toFixed(1) + '%');
        if (Number.isFinite(Number(segment.avgSpeedKmh))) fields.push(escapeSegmentHtml(ui.speed) + ': ' + Number(segment.avgSpeedKmh).toFixed(1) + ' km/h');
        if (Number.isFinite(Number(segment.avgHr))) fields.push(escapeSegmentHtml(ui.heartRate) + ': ' + Math.round(Number(segment.avgHr)) + ' bpm');
        if (Number.isFinite(Number(segment.avgPower))) fields.push(escapeSegmentHtml(ui.effort) + ': ' + Math.round(Number(segment.avgPower)) + ' W');
        if (Number.isFinite(Number(segment.elevGainM)) && Number(segment.elevGainM) > 0) fields.push(escapeSegmentHtml(ui.elevation) + ': +' + Math.round(Number(segment.elevGainM)) + ' m');
        if (segment.technical && type !== ui.technical) fields.push(escapeSegmentHtml(ui.technical));
        return fields.join('<br>');
      };

      function setupCooperativeZoom(targetMap) {
        const container = targetMap.getContainer();
        const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
        const hint = document.createElement('div');
        hint.className = 'mapZoomHint';
        hint.textContent = (isMac ? 'Cmd' : 'Ctrl') + ' + scroll to zoom';
        container.appendChild(hint);

        let hintTimer = null;
        container.addEventListener('wheel', (event) => {
          if (!event.ctrlKey && !event.metaKey) {
            hint.classList.add('visible');
            clearTimeout(hintTimer);
            hintTimer = setTimeout(() => hint.classList.remove('visible'), 1400);
            return;
          }
          // Zoom is applied manually so the very first wheel tick is not swallowed.
          event.preventDefault();
          clearTimeout(hintTimer);
          hint.classList.remove('visible');
          const current = targetMap.getZoom();
          const next = Math.max(targetMap.getMinZoom(), Math.min(targetMap.getMaxZoom(), current + (event.deltaY < 0 ? 1 : -1)));
          if (next !== current) {
            targetMap.setZoomAround(targetMap.mouseEventToContainerPoint(event), next);
          }
        }, { passive: false });
      }
      if (!window.L || !hasRoute) {
        if (mapEl) {
          let reason = !window.L
            ? 'Map library failed to load. Run npm install in fit-visualizer.'
            : 'No GPS points found in this FIT file.';
          mapEl.innerHTML = '<div style="padding:12px;color:var(--muted)">' + reason + '</div>';
        }
      } else {
        if (gpsRouteSection) gpsRouteSection.style.display = 'none';
        map = L.map('${mapId}', { preferCanvas: true, zoomControl: true, scrollWheelZoom: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
        setupCooperativeZoom(map);
        const latLngs = routePoints.map((p) => [p.lat, p.lon]);
        map.fitBounds(L.latLngBounds(latLngs).pad(0.08));
        L.circleMarker(latLngs[0], { radius: 5, color: '#149c5a', fillColor: '#149c5a', fillOpacity: 1 }).addTo(map);
        L.circleMarker(latLngs[latLngs.length - 1], { radius: 5, color: '#d63f3f', fillColor: '#d63f3f', fillOpacity: 1 }).addTo(map);
        let segments = [];
        function clearSegments() { segments.forEach((s) => map.removeLayer(s)); segments = []; }
        function colorForValue(v, mn, mx) {
          if (!Number.isFinite(v) || mn >= mx) return '#8a8a8a';
          const t = Math.max(0, Math.min(1, (v - mn) / (mx - mn)));
          return 'rgb(' + Math.round(40+(225-40)*t) + ',' + Math.round(120+(30-120)*t) + ',' + Math.round(190+(35-190)*t) + ')';
        }
        function formatRouteMetricTooltip(mode, value) {
          if (!Number.isFinite(value)) return '';
          if (mode === 'speed') return '<strong>' + escapeSegmentHtml(ui.speed) + '</strong><br>' + value.toFixed(1) + ' km/h';
          if (mode === 'heart_rate') return '<strong>' + escapeSegmentHtml(ui.heartRate) + '</strong><br>' + Math.round(value) + ' bpm';
          return '';
        }
        function drawSegments(mode) {
          clearSegments();
          const legend = document.getElementById('${mapId}SegmentLegend');
          if (legend) {
            legend.style.display = mode === 'segment' ? '' : 'none';
            if (mode === 'segment') {
              var seenSegmentIndexes = {};
              legend.innerHTML = '<span>' + escapeSegmentHtml(ui.segments) + ':</span> ' + activitySegments.filter(function (segment) {
                if (seenSegmentIndexes[segment.displayIndex]) return false;
                seenSegmentIndexes[segment.displayIndex] = true;
                return segment.displayIndex >= 0;
              }).map(function (segment) {
                return '<span class="segmentLegendItem" title="' + escapeSegmentHtml(segment.displayTime + ' ' + segment.displayDetails) + '"><i style="background:' + escapeSegmentHtml(segment.displayColor) + '"></i>' + (segment.displayIndex + 1) + '</span>';
              }).join('');
            }
          }
          const vals = routePoints
            .map((p) => p[mode])
            .filter((value) => value != null && Number.isFinite(Number(value)))
            .map(Number);
          const mn = vals.length ? Math.min(...vals) : NaN;
          const mx = vals.length ? Math.max(...vals) : NaN;
          for (let i = 1; i < routePoints.length; i++) {
            const a = routePoints[i-1], b = routePoints[i];
            const value = b[mode] == null ? NaN : Number(b[mode]);
            const matchedSegment = activitySegments.find(function (segment) {
              return b.elapsedTime >= segment.startElapsed && b.elapsedTime <= segment.endElapsed;
            });
            const color = mode === 'segment'
              ? (matchedSegment?.displayColor || '#7f8c8d')
              : colorForValue(value, mn, mx);
            const line = L.polyline([[a.lat,a.lon],[b.lat,b.lon]], { color, weight:4, opacity:0.92, lineCap:'round' }).addTo(map);
            const tooltip = mode === 'segment'
              ? (matchedSegment ? window.formatSegmentDetails(matchedSegment) : '')
              : formatRouteMetricTooltip(mode, value);
            if (tooltip) line.bindTooltip(tooltip, { sticky: true, className: 'segmentLeafletTooltip' });
            segments.push(line);
          }
        }
        const sel = document.getElementById('${mapId}Mode');
        sel.addEventListener('change', () => drawSegments(sel.value));
        drawSegments(sel.value || 'speed');

        // Overlay comparison route as a purple polyline.
        const compPoints = ${compGpsPoints};
        if (Array.isArray(compPoints) && compPoints.length >= 2) {
          const compLatLngs = compPoints.map((p) => [p.lat, p.lon]);
          L.polyline(compLatLngs, { color: '#b88fce', weight: 3, opacity: 0.75, dashArray: '8 4' }).addTo(map);
          L.circleMarker(compLatLngs[0], { radius: 4, color: '#b88fce', fillColor: '#b88fce', fillOpacity: 1 }).addTo(map);
          L.circleMarker(compLatLngs[compLatLngs.length - 1], { radius: 4, color: '#7a5fa0', fillColor: '#7a5fa0', fillOpacity: 1 }).addTo(map);
          const allLngs = [...latLngs, ...compLatLngs];
          map.fitBounds(L.latLngBounds(allLngs).pad(0.08));
        }

        map.whenReady(() => setTimeout(() => { map.invalidateSize(false); }, 0));
      }
    }());
  </script>
  <script nonce="${nonce}">
    (function () {
      var payloads = ${chartClientPayloads};
      var chartSegments = ${segmentTooltipPayload};
      var segmentTooltip = document.getElementById('${mapId}SegmentTooltip');
      document.querySelectorAll('[data-activity-table-tab]').forEach(function (button) {
        button.addEventListener('click', function () {
          var target = button.getAttribute('data-activity-table-tab');
          document.querySelectorAll('[data-activity-table]').forEach(function (table) {
            table.hidden = table.getAttribute('data-activity-table') !== target;
          });
          document.querySelectorAll('[data-activity-table-tab]').forEach(function (tab) {
            tab.setAttribute('aria-pressed', String(tab === button));
          });
        });
      });
      var svgIds = Object.keys(payloads).filter(function (id) { return payloads[id]; });
      var instances = {};

      // Ported from buildTicks/formatTick in extension.js: same "round numbers" step so the
      // client never picks a different step than the server's first render.
      function buildTicksClient(min, max, targetCount) {
        var span = Math.abs(max - min);
        if (!isFinite(span) || span === 0) return { values: [min], step: 1 };
        var rough = span / Math.max(2, targetCount - 1);
        var magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
        var residual = rough / magnitude;
        var nice = 1;
        if (residual > 5) nice = 10; else if (residual > 2) nice = 5; else if (residual > 1) nice = 2;
        var step = nice * magnitude;
        var first = Math.ceil(min / step) * step;
        var values = [];
        for (var v = first; v <= max + step * 0.5; v += step) {
          values.push(Math.round(v * 1e12) / 1e12);
        }
        if (!values.length) { values.push(min); values.push(max); }
        return { values: values, step: step };
      }

      function formatTickClient(value, step) {
        var absStep = Math.abs(step);
        if (absStep >= 10) return value.toFixed(0);
        if (absStep >= 1) return value.toFixed(1);
        if (absStep >= 0.1) return value.toFixed(2);
        return value.toFixed(4);
      }

      function escapeHtmlClient(text) {
        return String(text)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function clampCount(value, min, max) {
        return Math.max(min, Math.min(max, Math.round(value)));
      }

      function scaleX(payload, x) {
        var range = (payload.xMax - payload.xMin) || 1;
        return payload.plotLeft + ((x - payload.xMin) / range) * (payload.plotRight - payload.plotLeft);
      }

      function scaleY(payload, y) {
        var range = (payload.yMax - payload.yMin) || 1;
        return payload.plotBottom - ((y - payload.yMin) / range) * (payload.plotBottom - payload.plotTop);
      }

      function redrawTicks(svg, payload, targetXCount, targetYCount) {
        var xTicks = buildTicksClient(payload.xMin, payload.xMax, targetXCount);
        var yTicks = buildTicksClient(payload.yMin, payload.yMax, targetYCount);

        var xHtml = xTicks.values.map(function (v) {
          var px = scaleX(payload, v).toFixed(1);
          return '<g><line class="gridline" x1="' + px + '" y1="' + payload.plotTop + '" x2="' + px + '" y2="' + payload.plotBottom + '" />'
            + '<text class="tick" x="' + px + '" y="' + (payload.plotBottom + 16) + '" text-anchor="middle">'
            + escapeHtmlClient(formatTickClient(v, xTicks.step)) + '</text></g>';
        }).join('');
        var yHtml = yTicks.values.map(function (v) {
          var py = scaleY(payload, v).toFixed(1);
          var labelY = Math.max(payload.plotTop + 12, Math.min(payload.plotBottom - 4, parseFloat(py) + 4)).toFixed(1);
          return '<g><line class="gridline" x1="' + payload.plotLeft + '" y1="' + py + '" x2="' + payload.plotRight + '" y2="' + py + '" />'
            + '<text class="tick" x="' + (payload.plotLeft - 8) + '" y="' + labelY + '" text-anchor="end">'
            + escapeHtmlClient(formatTickClient(v, yTicks.step)) + '</text></g>';
        }).join('');

        var xGroup = svg.querySelector('.xTicksGroup');
        var yGroup = svg.querySelector('.yTicksGroup');
        if (xGroup) xGroup.innerHTML = xHtml;
        if (yGroup) yGroup.innerHTML = yHtml;
      }

      function updateChartTextScale(svg, payload, rect) {
        if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(payload.width > 0) || !(payload.height > 0)) return;
        var xScale = rect.width / payload.width;
        var yScale = rect.height / payload.height;
        var textScale = Math.max(0.1, Math.min(xScale, yScale));

        function setReadableFont(selector, cssPx, strokePx) {
          svg.querySelectorAll(selector).forEach(function (el) {
            el.style.fontSize = (cssPx / textScale).toFixed(2) + 'px';
            if (strokePx) el.style.strokeWidth = (strokePx / textScale).toFixed(2) + 'px';
          });
        }

        setReadableFont('.tick', 10);
        setReadableFont('.kmLabel', 9);
        setReadableFont('.crosshairLabel', 13, 3);

        var axisX = svg.querySelector('.axisLabelX');
        if (axisX) {
          var axisXx = parseFloat(axisX.getAttribute('x'));
          var axisXy = parseFloat(axisX.getAttribute('y'));
          axisX.style.fontSize = '12px';
          if (isFinite(axisXx) && isFinite(axisXy)) {
            axisX.setAttribute('transform', 'translate(' + axisXx + ' ' + axisXy + ') scale('
              + (1 / xScale).toFixed(4) + ' ' + (1 / yScale).toFixed(4) + ') translate('
              + (-axisXx) + ' ' + (-axisXy) + ')');
          }
        }
      }

      // Nearest value in a monotonic array (px positions for the hovered chart, data x for the rest).
      function nearestIndex(sortedValues, target) {
        var lo = 0, hi = sortedValues.length - 1;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (sortedValues[mid] < target) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && Math.abs(sortedValues[lo - 1] - target) <= Math.abs(sortedValues[lo] - target)) return lo - 1;
        return lo;
      }

      function formatCrosshairValue(value, unit) {
        var digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
        return value.toFixed(digits) + (unit ? ' ' + unit : '');
      }

      // Max 2 at once: more than that on top of the main line becomes unreadable.
      var OVERLAY_PALETTE = ['#e67e22', '#00acc1'];

      function initOverlayControls(svgId, payload, instance) {
        var controls = document.querySelector('.overlayControls[data-overlay-for="' + svgId + '"]');
        if (!controls || !payload.overlays) return;
        var active = {};

        function overlayLineId(metricKey) { return svgId + '_overlay_' + metricKey; }

        function drawOverlay(metricKey, color) {
          var series = payload.overlays[metricKey];
          if (!series || !instance.overlayGroup) return;
          var range = (series.max - series.min) || 1;
          var pts = series.points.map(function (p) {
            var px = scaleX(payload, p[0]);
            var py = payload.plotBottom - ((p[1] - series.min) / range) * (payload.plotBottom - payload.plotTop);
            return px.toFixed(1) + ',' + py.toFixed(1);
          }).join(' ');
          var existing = instance.overlayGroup.querySelector('#' + overlayLineId(metricKey));
          if (existing) {
            existing.setAttribute('points', pts);
            return;
          }
          var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          poly.setAttribute('id', overlayLineId(metricKey));
          poly.setAttribute('points', pts);
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', color);
          poly.setAttribute('stroke-width', '2');
          poly.setAttribute('vector-effect', 'non-scaling-stroke');
          poly.setAttribute('opacity', '0.9');
          instance.overlayGroup.appendChild(poly);
        }

        function removeOverlay(metricKey) {
          var el = instance.overlayGroup && instance.overlayGroup.querySelector('#' + overlayLineId(metricKey));
          if (el) el.parentNode.removeChild(el);
        }

        var checkboxes = controls.querySelectorAll('input[type=checkbox]');
        checkboxes.forEach(function (checkbox) {
          var metricKey = checkbox.getAttribute('data-overlay-metric');
          var series = payload.overlays[metricKey];
          var rangeEl = checkbox.parentElement.querySelector('.overlayRange');
          if (rangeEl && series) {
            rangeEl.textContent = ' (' + formatCrosshairValue(series.min, '') + '\u2026' + formatCrosshairValue(series.max, series.unit) + ')';
          }
          checkbox.addEventListener('change', function () {
            if (checkbox.checked) {
              if (Object.keys(active).length >= 2) {
                checkbox.checked = false;
                return;
              }
              var usedColors = Object.keys(active).map(function (key) { return active[key]; });
              var color = OVERLAY_PALETTE.filter(function (c) { return usedColors.indexOf(c) === -1; })[0] || OVERLAY_PALETTE[0];
              active[metricKey] = color;
              drawOverlay(metricKey, color);
              checkbox.parentElement.style.color = color;
            } else {
              delete active[metricKey];
              removeOverlay(metricKey);
              checkbox.parentElement.style.color = '';
            }
          });
        });
      }

      function initChart(svgId) {
        var payload = payloads[svgId];
        var svg = document.getElementById(svgId);
        if (!payload || !svg) return;

        var pxXs = payload.points.map(function (p) { return scaleX(payload, p[0]); });
        var dataXs = payload.points.map(function (p) { return p[0]; });
        var line = svg.querySelector('.crosshair');
        var dot = svg.querySelector('.crosshairDot');
        var label = svg.querySelector('.crosshairLabel');
        var labelX = label && label.querySelector('.crosshairLabelX');
        var labelY = label && label.querySelector('.crosshairLabelY');
        var capture = svg.querySelector('.crosshairCapture');
        var instance = { payload: payload, pxXs: pxXs, dataXs: dataXs, overlayGroup: svg.querySelector('.overlayGroup') };
        instances[svgId] = instance;

        instance.showAt = function (index) {
          if (index < 0 || index >= payload.points.length || !line || !dot) return;
          var point = payload.points[index];
          var pxNum = scaleX(payload, point[0]);
          var px = pxNum.toFixed(1);
          var py = scaleY(payload, point[1]).toFixed(1);
          line.setAttribute('x1', px);
          line.setAttribute('x2', px);
          line.style.display = '';
          dot.setAttribute('cx', px);
          dot.setAttribute('cy', py);
          dot.style.display = '';
          if (label && labelX && labelY) {
            // Anchored near the plot top (not the point itself) so it never overlaps the line/dot
            // and never clips off the top/bottom edge regardless of the point's Y value.
            var nearRightEdge = pxNum > (payload.plotLeft + payload.plotRight) / 2;
            var anchorX = (nearRightEdge ? pxNum - 8 : pxNum + 8).toFixed(1);
            label.setAttribute('text-anchor', nearRightEdge ? 'end' : 'start');
            labelX.setAttribute('x', anchorX);
            labelY.setAttribute('x', anchorX);
            labelX.textContent = formatCrosshairValue(point[0], payload.xUnit);
            labelY.textContent = formatCrosshairValue(point[1], payload.yUnit);
            label.style.display = '';
            if (instance.lastRect) updateChartTextScale(svg, payload, instance.lastRect);
          }
        };
        instance.hide = function () {
          if (line) line.style.display = 'none';
          if (dot) dot.style.display = 'none';
          if (label) label.style.display = 'none';
        };

        function showSegmentTooltip(event, local) {
          if (!segmentTooltip || local.y < payload.plotBottom - 9) return;
          var segment = chartSegments.find(function (candidate) {
            return local.x >= scaleX(payload, candidate.startDistanceKm) && local.x <= scaleX(payload, candidate.endDistanceKm);
          });
          if (!segment) return;
          segmentTooltip.innerHTML = window.formatSegmentDetails(segment);
          segmentTooltip.hidden = false;
          var maxLeft = Math.max(8, window.innerWidth - segmentTooltip.offsetWidth - 8);
          var maxTop = Math.max(8, window.innerHeight - segmentTooltip.offsetHeight - 8);
          segmentTooltip.style.left = Math.max(8, Math.min(maxLeft, event.clientX + 14)) + 'px';
          segmentTooltip.style.top = Math.max(8, Math.min(maxTop, event.clientY + 14)) + 'px';
        }

        if (capture) {
          capture.addEventListener('mousemove', function (evt) {
            var pt = svg.createSVGPoint();
            pt.x = evt.clientX; pt.y = evt.clientY;
            var ctm = svg.getScreenCTM();
            if (!ctm) return;
            var local = pt.matrixTransform(ctm.inverse());
            showSegmentTooltip(evt, local);
            var hoveredIdx = nearestIndex(pxXs, local.x);
            var dataX = payload.points[hoveredIdx][0];
            // All three charts share the distance axis, so one hover moves every crosshair.
            svgIds.forEach(function (id) {
              var target = instances[id];
              if (!target) return;
              var idx = id === svgId ? hoveredIdx : nearestIndex(target.dataXs, dataX);
              target.showAt(idx);
            });
          });
          capture.addEventListener('mouseleave', function () {
            if (segmentTooltip) segmentTooltip.hidden = true;
            svgIds.forEach(function (id) {
              if (instances[id]) instances[id].hide();
            });
          });
        }

        if (window.ResizeObserver) {
          var lastWidth = 0;
          var lastHeight = 0;
          var observer = new ResizeObserver(function (entries) {
            var rect = entries[0].contentRect;
            if (Math.abs(rect.width - lastWidth) < 1 && Math.abs(rect.height - lastHeight) < 1) return;
            lastWidth = rect.width;
            lastHeight = rect.height;
            instance.lastRect = rect;
            var plotWidthPx = (payload.plotRight - payload.plotLeft) * (rect.width / payload.width);
            var plotHeightPx = (payload.plotBottom - payload.plotTop) * (rect.height / payload.height);
            redrawTicks(svg, payload, clampCount(plotWidthPx / 72, 4, 18), clampCount(plotHeightPx / 30, 6, 18));
            updateChartTextScale(svg, payload, rect);
          });
          observer.observe(svg);
        }

        initOverlayControls(svgId, payload, instance);
        svg.querySelectorAll('.segmentBand[data-segment-index]').forEach(function (band) {
          band.addEventListener('mousemove', function (event) {
            var segment = chartSegments.find(function (candidate) { return String(candidate.index) === band.getAttribute('data-segment-index'); });
            if (!segment || !segmentTooltip) return;
            segmentTooltip.innerHTML = window.formatSegmentDetails(segment);
            segmentTooltip.hidden = false;
            var maxLeft = Math.max(8, window.innerWidth - segmentTooltip.offsetWidth - 8);
            var maxTop = Math.max(8, window.innerHeight - segmentTooltip.offsetHeight - 8);
            segmentTooltip.style.left = Math.max(8, Math.min(maxLeft, event.clientX + 14)) + 'px';
            segmentTooltip.style.top = Math.max(8, Math.min(maxTop, event.clientY + 14)) + 'px';
          });
          band.addEventListener('mouseleave', function () { if (segmentTooltip) segmentTooltip.hidden = true; });
        });
      }

      svgIds.forEach(initChart);
      var segmentBandToggle = document.getElementById('${mapId}SegmentBands');
      if (segmentBandToggle) {
        segmentBandToggle.addEventListener('change', function () {
          document.querySelectorAll('.segmentBandGroup').forEach(function (group) {
            group.style.display = segmentBandToggle.checked ? '' : 'none';
          });
        });
      }
    }());
  </script>`;
}

function sharedCss() {
  return `
    :root {
      --bg: var(--vscode-editor-background);
      --card: color-mix(in srgb, var(--vscode-sideBar-background) 76%, var(--vscode-editor-background));
      --ink: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
      --line-a: var(--vscode-charts-blue);
      --line-b: var(--vscode-charts-red);
      --line-c: var(--vscode-charts-orange);
      --line-d: var(--vscode-charts-green);
      --hr-zone-recovery: #808080;
      --hr-zone-endurance: #1e88e5;
      --hr-zone-aerobic: #43a047;
      --hr-zone-anaerobic: #fb8c00;
      --hr-zone-max: #e53935;
      --grid: color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
      --border: color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
    }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Georgia,"Iowan Old Style","Palatino Linotype",serif; color:var(--ink); background:var(--bg); line-height:1.4; }
    .wrap { width:100%; margin:0 auto; padding:clamp(12px,2vw,24px); display:grid; gap:18px; }
    .hero { border:1px solid var(--border); border-radius:16px; background:linear-gradient(160deg,color-mix(in srgb,var(--card) 80%,var(--bg)),color-mix(in srgb,var(--card) 65%,var(--bg))); padding:20px; }
    h1 { margin:0 0 6px; font-size:1.4rem; letter-spacing:0.02em; }
    h2 { font-size:1rem; margin:2px 0 8px; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; }
    .metric { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:10px 12px; }
    .metric .k { color:var(--muted); font-size:0.82rem; text-transform:uppercase; letter-spacing:0.08em; }
    .term { text-decoration:underline dotted; text-underline-offset:3px; cursor:help; }
    .metric .v { font-size:1.3rem; margin-top:3px; font-weight:bold; color:var(--accent); }
    .chart { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:12px; position:relative; }
    /* Traps Leaflet's internal z-index layers (up to 1000) inside the map card. */
    .chart[data-target-type="map"] { z-index:0; isolation:isolate; }
    .resizable { padding-bottom:26px; }
    .resizable.resizing { user-select:none; cursor:nwse-resize; }
    .resizeHandle { position:absolute; width:18px; height:18px; border-radius:4px; border:1px solid var(--border); background:linear-gradient(135deg,transparent 42%,color-mix(in srgb,var(--muted) 70%,transparent) 43%,color-mix(in srgb,var(--muted) 70%,transparent) 48%,transparent 49%),linear-gradient(135deg,transparent 56%,color-mix(in srgb,var(--muted) 70%,transparent) 57%,color-mix(in srgb,var(--muted) 70%,transparent) 62%,transparent 63%),color-mix(in srgb,var(--card) 86%,var(--bg)); }
    .resizeHandle:hover { border-color:color-mix(in srgb,var(--accent) 60%,var(--border)); }
    .resizeHandleBottomRight { right:8px; bottom:8px; cursor:nwse-resize; }
    .resizeHandleTopRight { right:8px; top:8px; cursor:nesw-resize; transform:rotate(90deg); }
    svg { width:100%; height:var(--panel-height,auto); max-height:var(--panel-max-height,min(62vh,560px)); display:block; border-radius:10px; background:color-mix(in srgb,var(--card) 70%,var(--bg)); }
    .axis { stroke:color-mix(in srgb,var(--ink) 45%,transparent); stroke-width:1; }
    .gridline { stroke:var(--grid); stroke-width:1; stroke-dasharray:4 4; }
    .lineA,.lineB,.lineC { fill:none; stroke-width:2.2; vector-effect:non-scaling-stroke; }
    .lineA { stroke:var(--line-a); } .lineB { stroke:var(--line-b); } .lineC { stroke:var(--line-c); }
    .lineD { fill:none; stroke:var(--line-d); stroke-width:2; vector-effect:non-scaling-stroke; }
    .zoneLine { fill:none; stroke-width:2.6; vector-effect:non-scaling-stroke; stroke-linecap:round; stroke-linejoin:round; }
    .zoneLine1 { stroke:var(--hr-zone-recovery); } .zoneLine2 { stroke:var(--hr-zone-endurance); }
    .zoneLine3 { stroke:var(--hr-zone-aerobic); } .zoneLine4 { stroke:var(--hr-zone-anaerobic); }
    .zoneLine5 { stroke:var(--hr-zone-max); }
    .tick { fill:var(--muted); font-size:10px; }
    .axisLabel { fill:var(--ink); font-size:11px; font-weight:bold; letter-spacing:0.03em; text-transform:uppercase; }
    .routeStart { fill:var(--vscode-testing-iconPassed); } .routeEnd { fill:var(--vscode-testing-iconFailed); }
    .kmMarker { stroke:color-mix(in srgb,var(--ink) 30%,transparent); stroke-width:1; stroke-dasharray:2 5; }
    .kmLabel { fill:var(--muted); font-size:9px; }
    .segmentBand { pointer-events:all; cursor:help; }
    .segmentBandClimb { fill:#d35400; fill-opacity:0.72; } .segmentBandDescent { fill:#2980b9; fill-opacity:0.72; }
    .segmentBandFlat { fill:#3d8b40; fill-opacity:0.66; } .segmentBandStopped { fill:#7f8c8d; fill-opacity:0.72; }
    .segmentBandTechnical { fill:#c0392b; fill-opacity:0.72; }
    .segmentTooltip, .segmentLeafletTooltip { max-width:260px; padding:7px 9px; border:1px solid var(--border); border-radius:6px; background:var(--vscode-editorHoverWidget-background, var(--card)); color:var(--ink); box-shadow:0 3px 12px rgba(0,0,0,.22); font-size:.82rem; line-height:1.4; pointer-events:none; }
    .segmentTooltip { position:fixed; z-index:1300; }
    .activityTableTabs { display:flex; gap:6px; margin:0 0 10px; }
    .activityTableTabs button { border:1px solid var(--border); border-radius:4px; padding:5px 9px; background:var(--input-bg); color:var(--input-fg); cursor:pointer; }
    .activityTableTabs button[aria-pressed="true"] { background:var(--accent); color:var(--bg); }
    .activityTableWrap { overflow:auto; }
    .activityTable { width:100%; border-collapse:collapse; font-size:.84rem; white-space:nowrap; }
    .activityTable th, .activityTable td { padding:6px 8px; border-bottom:1px solid var(--border); text-align:right; }
    .activityTable th:first-child, .activityTable td:first-child { text-align:left; }
    .activityTable th { color:var(--muted); font-size:.75rem; text-transform:uppercase; }
    .segmentBandControls { display:inline-flex; align-items:center; gap:4px; margin:0 0 6px; color:var(--muted); font-size:0.82rem; cursor:pointer; }
    .crosshair { stroke:color-mix(in srgb,var(--ink) 55%,transparent); stroke-width:1; pointer-events:none; }
    .crosshairDot { fill:var(--accent); stroke:var(--bg); stroke-width:1.5; pointer-events:none; }
    .crosshairLabel { font-size:11px; font-weight:700; fill:var(--ink); paint-order:stroke; stroke:var(--card); stroke-width:3px; stroke-linejoin:round; pointer-events:none; }
    .crosshairCapture { cursor:crosshair; }
    .overlayControls { display:flex; gap:12px; flex-wrap:wrap; margin:4px 0 8px; font-size:0.82rem; color:var(--muted); }
    .overlayControls label { display:flex; align-items:center; gap:4px; cursor:pointer; }
    .overlayRange { font-size:0.75rem; }
    .statRow { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; margin:8px 0 10px; }
    .stat { border:1px solid var(--border); border-radius:10px; padding:6px 8px; background:color-mix(in srgb,var(--card) 84%,var(--bg)); }
    .statK { color:var(--muted); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.06em; }
    .statV { color:var(--ink); font-weight:700; margin-top:2px; font-size:0.95rem; }
    .legend { margin-top:6px; color:var(--muted); font-size:0.9rem; }
    .zones { border:1px solid var(--border); border-radius:10px; padding:10px; background:color-mix(in srgb,var(--card) 84%,var(--bg)); margin:8px 0 10px; }
    .zonesHead { color:var(--muted); font-size:0.85rem; margin-bottom:8px; }
    .zoneRow { display:grid; grid-template-columns:58px 1fr auto; gap:10px; align-items:center; margin:6px 0; }
    .zoneLabel { color:var(--ink); font-weight:700; font-size:0.84rem; }
    .zoneBar { height:10px; border-radius:999px; background:color-mix(in srgb,var(--ink) 12%,transparent); overflow:hidden; min-width:60px; }
    .zoneFill { height:100%; border-radius:999px; }
    .zoneMeta { color:var(--muted); font-size:0.78rem; min-width:130px; text-align:right; white-space:nowrap; }
    .mapWrap { display:grid; gap:8px; }
    .mapControls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; color:var(--muted); font-size:0.9rem; }
    .segmentLegend { display:flex; gap:8px; flex-wrap:wrap; align-items:center; color:var(--muted); font-size:0.78rem; }
    .segmentLegendItem { display:inline-flex; align-items:center; gap:4px; }
    .segmentLegendItem i { width:10px; height:10px; border-radius:2px; display:inline-block; }
    .mapControls select { border:1px solid var(--border); border-radius:6px; padding:4px 8px; background:var(--input-bg); color:var(--input-fg); font-size:0.9rem; }
    #fitMap, #fitMapComp { height:var(--map-height,clamp(320px,52vh,760px)); border:1px solid var(--border); border-radius:10px; overflow:hidden; background:color-mix(in srgb,var(--card) 65%,var(--bg)); }
    .mapHint { color:var(--muted); font-size:0.85rem; }
    .mapZoomHint { position:absolute; inset:0; z-index:1200; display:flex; align-items:center; justify-content:center; pointer-events:none; opacity:0; transition:opacity 140ms ease; background:color-mix(in srgb,var(--bg) 55%,transparent); color:var(--ink); font-size:1.05rem; font-weight:700; letter-spacing:0.03em; }
    .mapZoomHint.visible { opacity:1; }
    .manualDataForm { display:flex; align-items:end; gap:12px; flex-wrap:wrap; }
    .manualDataForm label { display:grid; gap:4px; color:var(--muted); font-size:0.82rem; }
    .manualDataForm input { width:150px; border:1px solid var(--border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); }
    .manualDataForm select { width:150px; border:1px solid var(--border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); }
    .manualDataForm button { border:0; border-radius:6px; padding:7px 14px; background:var(--accent); color:var(--bg); font-weight:700; cursor:pointer; }
    .manualDataStatus { color:var(--muted); font-size:0.82rem; align-self:center; }
    .manualDataStatus.error { color:var(--vscode-errorForeground); }
    .calibrationHint { margin-top:10px; padding:8px 10px; border-left:4px solid var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); font-size:0.85rem; line-height:1.5; }
    .calibrationHint button { margin-left:8px; border:1px solid var(--border); border-radius:4px; padding:3px 8px; background:var(--input-bg); color:var(--input-fg); cursor:pointer; font-size:0.8rem; }
  `;
}

function metric(label, value, term, glossary) {
  return `<div class="metric"><div class="k">${renderTerm(label, term, glossary)}</div><div class="v">${escapeHtml(String(value))}</div></div>`;
}

function renderTerm(label, term, glossary) {
  const description = glossary?.[term];
  const text = escapeHtml(String(label));
  return description
    ? `<span class="term" title="${escapeHtml(description)}">${text}</span>`
    : text;
}


function renderStatsRow(stats, unit, isComp) {
  if (!stats || !stats.count) {
    return '';
  }
  const style = isComp ? ' style="opacity:0.72"' : '';
  const prefix = isComp ? 'comp · ' : '';
  return `<div class="statRow"${style}>
    ${statChip(prefix + 'Samples', stats.count)}
    ${statChip(prefix + 'Min', `${formatNumber(stats.min)} ${unit}`)}
    ${statChip(prefix + 'Avg', `${formatNumber(stats.avg)} ${unit}`)}
    ${statChip(prefix + 'Median', `${formatNumber(stats.median)} ${unit}`)}
    ${statChip(prefix + 'P95', `${formatNumber(stats.p95)} ${unit}`)}
    ${statChip(prefix + 'Max', `${formatNumber(stats.max)} ${unit}`)}
  </div>`;
}

function renderComparisonTable(a, b, aName, bName, glossary) {
  const rows = [
    ['Distance (km)', a.distanceKm.toFixed(2), b.distanceKm.toFixed(2), 'distance'],
    ['Duration', a.durationText, b.durationText, 'duration'],
    ['Avg Speed (km/h)', a.avgSpeed.toFixed(2), b.avgSpeed.toFixed(2), 'averageSpeed'],
    ['Max Speed (km/h)', a.maxSpeed.toFixed(2), b.maxSpeed.toFixed(2), 'maximumSpeed'],
    ['Avg Power (W)', a.avgPower.toFixed(0), b.avgPower.toFixed(0), 'averagePower'],
    ['Max Power (W)', a.maxPower.toFixed(0), b.maxPower.toFixed(0), 'maximumPower'],
    ['Normalized Power (W)', a.normalizedPower?.toFixed(0) ?? 'n/a', b.normalizedPower?.toFixed(0) ?? 'n/a', 'normalizedPower'],
    ['Intensity Factor (IF)', a.intensityFactor > 0 ? a.intensityFactor.toFixed(2) : 'n/a', b.intensityFactor > 0 ? b.intensityFactor.toFixed(2) : 'n/a', 'intensityFactor'],
    ['TSS', a.trainingStressScore > 0 ? a.trainingStressScore.toFixed(1) : 'n/a', b.trainingStressScore > 0 ? b.trainingStressScore.toFixed(1) : 'n/a', 'trainingStressScore'],
    ['xPower (GC) (W)', a.xPower > 0 ? a.xPower.toFixed(0) : 'n/a', b.xPower > 0 ? b.xPower.toFixed(0) : 'n/a', 'xpower'],
    ['RI (GC)', a.relativeIntensityGc > 0 ? a.relativeIntensityGc.toFixed(2) : 'n/a', b.relativeIntensityGc > 0 ? b.relativeIntensityGc.toFixed(2) : 'n/a', 'relativeIntensity'],
    ['BikeStress (GC)', a.bikeStressScore > 0 ? a.bikeStressScore.toFixed(1) : 'n/a', b.bikeStressScore > 0 ? b.bikeStressScore.toFixed(1) : 'n/a', 'bikeStress'],
    ['Decoupling % (Intervals)', Number.isFinite(a.decouplingPct) ? `${a.decouplingPct.toFixed(1)}%` : 'n/a', Number.isFinite(b.decouplingPct) ? `${b.decouplingPct.toFixed(1)}%` : 'n/a', 'decoupling'],
    ['TRIMP', a.trimp > 0 ? a.trimp.toFixed(1) : 'n/a', b.trimp > 0 ? b.trimp.toFixed(1) : 'n/a', 'trimp'],
    ['hrTSS', a.hrTss > 0 ? a.hrTss.toFixed(1) : 'n/a', b.hrTss > 0 ? b.hrTss.toFixed(1) : 'n/a', 'hrTss'],
    ['Avg HR (bpm)', a.avgHr.toFixed(0), b.avgHr.toFixed(0), 'averageHeartRate'],
    ['Max HR (bpm)', a.maxHr.toFixed(0), b.maxHr.toFixed(0), 'maximumHeartRate'],
    ['Elevation Gain (m)', a.elevationGainM.toFixed(0), b.elevationGainM.toFixed(0), 'elevationGain'],
    ['Elevation Loss (m)', a.elevationLossM.toFixed(0), b.elevationLossM.toFixed(0), 'elevationLoss'],
  ].map(([label, va, vb, term]) => `<tr><td class="cmpLabel">${renderTerm(label, term, glossary)}</td><td class="cmpA">${escapeHtml(va)}</td><td class="cmpB">${escapeHtml(vb)}</td></tr>`).join('');
  return `<section class="chart"><h2>Comparison</h2><table class="cmpTable">
    <thead><tr><th></th><th>${escapeHtml(aName || 'Activity')}</th><th>${escapeHtml(bName || 'Comparison')}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></section>`;
}

function renderMapStats(route) {
  if (!route || !route.pointCount) {
    return '<div class="muted">No GPS stats available.</div>';
  }

  const speed = route.speedStats || {};
  const hr = route.hrStats || {};

  return `<div class="statRow">
    ${statChip('Points', route.pointCount)}
    ${statChip('Route Dist', `${formatNumber(route.routeDistanceKm)} km`)}
    ${statChip('Avg Speed', speed.count ? `${formatNumber(speed.avg)} km/h` : 'n/a')}
    ${statChip('Max Speed', speed.count ? `${formatNumber(speed.max)} km/h` : 'n/a')}
    ${statChip('Avg HR', hr.count ? `${formatNumber(hr.avg)} bpm` : 'n/a')}
    ${statChip('Max HR', hr.count ? `${formatNumber(hr.max)} bpm` : 'n/a')}
  </div>`;
}

function statChip(label, value) {
  return `<div class="stat"><div class="statK">${escapeHtml(String(label))}</div><div class="statV">${escapeHtml(String(value))}</div></div>`;
}

function renderHeartRateZones(zoneData) {
  if (!zoneData.enabled) {
    return `<div class="zones"><div class="zonesHead">Heart-rate zones are disabled. Enter a dated profile above to enable zone analysis.</div></div>`;
  }

  const rows = zoneData.zones.map((zone, colorIndex) => ({ zone, colorIndex })).reverse().map(({ zone: z, colorIndex: idx }) => {
    const fill = Math.max(0, Math.min(100, z.percent));
    const colors = [
      'var(--hr-zone-recovery)',
      'var(--hr-zone-endurance)',
      'var(--hr-zone-aerobic)',
      'var(--hr-zone-anaerobic)',
      'var(--hr-zone-max)',
    ];
    const color = colors[idx] || 'var(--accent)';
    return `<div class="zoneRow">
      <div class="zoneLabel">${escapeHtml(z.name)}</div>
      <div class="zoneBar"><div class="zoneFill" style="width:${fill.toFixed(1)}%; background:${color};"></div></div>
      <div class="zoneMeta">${escapeHtml(z.range)} | ${escapeHtml(formatHms(z.seconds))} (${escapeHtml(formatNumber(z.percent))}%)</div>
    </div>`;
  }).join('');

  return `<div class="zones">
    <div class="zonesHead">Zones based on ${zoneData.customThresholds ? 'custom watch thresholds and ' : ''}max HR ${escapeHtml(String(zoneData.maxHeartRate))} bpm. Time is estimated from elapsed record deltas.</div>
    ${rows}
  </div>`;
}

module.exports = { renderActivityBrowserHtml, renderActivityContentHtml };
