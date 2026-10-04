const vscode = require('vscode');
const { buildSegmentContext } = require('./analysis');
const { localizeGlossary } = require('./glossary');
const { formatUi, localizeUi } = require('./ui-strings');
const { CONDITIONS, FEELINGS, PURPOSES } = require('./activity-notes');
const { buildSummary } = require('./activity-summary');
const { buildGpsRoute: buildGpsRouteFromModule, buildLineChart: buildLineChartFromModule } = require('./chart-model');
const { extractGpsPoints, mapSegmentsToDistanceRanges } = require('./chart-data');
const { buildDistanceMarkers, formatTick } = require('./chart-geometry');
const { createChartSvgRenderer } = require('./chart-svg');
const { translationMessages } = require('./dynamic-localization');
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

// A small, safe markdown renderer for the AI text (analysis, chat, comparisons). It escapes HTML
// first, then applies only headings, bold, italic, inline code, unordered lists and paragraphs —
// enough for what the model writes, and nothing that could interpret raw HTML. The same source is
// injected into the page script via toString(), so the server and the browser render identically.
const renderMarkdown = (text) => {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const blocks = [];
  let para = [];
  let list = [];

  const inline = (s) => {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return out;
  };
  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'p', html: para.map(inline).join('<br>') }); para = []; }
  };
  const flushList = () => {
    if (list.length) { blocks.push({ t: 'ul', html: list.map((item) => `<li>${inline(item)}</li>`).join('') }); list = []; }
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      blocks.push({ t: 'h', level: heading[1].length, html: inline(heading[2]) });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      flushPara(); flushList();
      continue;
    }
    if (line.trim() === '') {
      flushPara(); flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();

  const headingSize = { 1: '1.25em', 2: '1.15em', 3: '1.05em', 4: '1em', 5: '0.95em', 6: '0.9em' };
  return blocks.map((block) => {
    if (block.t === 'p') return `<p style="margin:0 0 0.6em 0;">${block.html}</p>`;
    if (block.t === 'ul') return `<ul style="margin:0 0 0.6em 0;padding-left:1.4em;">${block.html}</ul>`;
    const level = Math.min(Math.max(block.level, 1), 6);
    return `<h${level} style="margin:0.85em 0 0.35em 0;font-size:${headingSize[level]};font-weight:600;">${block.html}</h${level}>`;
  }).join('');
};

function renderActivityBrowserHtml(webview, extensionUri, activities, selectedId, fitData, compId, compData, hrConfig, athleteProfile, analysis, analysisChat, wheelCalibration, generatedTranslations, segments, analysisVersion, comparisons, translationJustGenerated = false, routeCard = null, qualityFlags = [], routeFilter = null, modelPicker = null) {
  const translate = (message) => generatedTranslations?.[message] || vscode.l10n.t(message);
  const ui = localizeUi(translate);
  const glossary = localizeGlossary(translate);
  const mapTiles = String(vscode.workspace.getConfiguration('fitVisualizer').get('map.tiles') || 'osm');
  const locale = String(vscode.env.language || 'en').replace(/_/g, '-');
  const shouldOfferTranslations = !generatedTranslations && !locale.startsWith('en') && ui.activity === 'Activity';
  const hasData = fitData && Array.isArray(fitData.records) && fitData.records.length > 0;
  const hasComp = compData && Array.isArray(compData.records) && compData.records.length > 0;

  // The route filter narrows both the activity selector and the comparison selector to rides on
  // one route (by the route card name). Rides without a route assignment are hidden under a
  // non-"all" filter.
  const routeNames = [...new Set(activities.map((a) => (a.route_name ? String(a.route_name) : null)).filter(Boolean))].sort();
  const activeRouteFilter = routeFilter && routeNames.includes(routeFilter) ? routeFilter : null;
  const filterable = activeRouteFilter ? activities.filter((a) => String(a.route_name) === activeRouteFilter) : activities;
  const routeOptions = [
    `<option value="">${escapeHtml(ui.allRoutes)}</option>`,
    ...routeNames.map((name) => `<option value="${escapeHtml(name)}"${name === activeRouteFilter ? ' selected' : ''}>${escapeHtml(name)}</option>`),
  ].join('');

  const actOptions = filterable.map((a) => {
    const label = escapeHtml(formatActivityLabel(a));
    const sel = Number(a.id) === Number(selectedId) ? ' selected' : '';
    return `<option value="${escapeHtml(String(a.id))}" data-route="${escapeHtml(String(a.route_name || ''))}"${sel}>${label}</option>`;
  }).join('');

  const compOptions = [
    `<option value="" data-route="">- ${escapeHtml(ui.noComparison)} -</option>`,
    ...filterable.filter((a) => Number(a.id) !== Number(selectedId)).map((a) => {
      const label = escapeHtml(formatActivityLabel(a));
      const sel = Number(a.id) === Number(compId) ? ' selected' : '';
      return `<option value="${escapeHtml(String(a.id))}" data-route="${escapeHtml(String(a.route_name || ''))}"${sel}>${label}</option>`;
    }),
  ].join('');

  // Labeled the same way as the dropdown, and independent of it: a saved comparison must stay
  // visible whichever (or no) activity happens to be selected in "Compare with" right now.
  const comparisonEntries = (Array.isArray(comparisons) ? comparisons : []).map((entry) => {
    const compared = activities.find((a) => Number(a.id) === entry.comparedActivityId);
    return {
      comparedActivityId: entry.comparedActivityId,
      label: compared ? formatActivityLabel(compared) : `#${entry.comparedActivityId}`,
      comparisonText: entry.comparisonText,
    };
  });

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
      // The route filter is applied server-side in one round trip: the extension persists it and
      // re-renders with the selectors narrowed, picking the newest ride on that route when the
      // current one is not on it.
      const routeSel = document.getElementById('routeSel');
      routeSel.addEventListener('change', () => {
        api.postMessage({
          type: 'setRouteFilter',
          routeName: routeSel.value || null,
          id: document.getElementById('actSel').value || null,
          compId: document.getElementById('compSel').value || null,
        });
      });
      document.getElementById('actSel').addEventListener('change', send);
      document.getElementById('compSel').addEventListener('change', send);
    }());
  `;

  const primaryHtml = hasData
    ? renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, false, hasComp ? compData : null, athleteProfile, analysis, analysisChat, wheelCalibration, ui, glossary, shouldOfferTranslations, displayLanguage(locale), segments, analysisVersion, comparisonEntries, compId, translationJustGenerated, mapTiles, routeCard, qualityFlags, modelPicker)
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
      border: 1px solid var(--input-border);
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
    <div class="selectorGroup" style="flex:0 0 200px;min-width:180px;">
      <label class="selLabel" for="routeSel">${escapeHtml(ui.routeFilter)}</label>
      <select id="routeSel" class="actSelector">${routeOptions}</select>
    </div>
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
  return `<section class="chart"><h2>${escapeHtml(lapRows.length ? ui.segments : ui.segment)}</h2><div id="segmentBudgetWarning" class="mapHint" style="display:none"></div>${tabs}${segmentView}${lapRows.length ? renderRows(lapRows, 'laps', true, lapColumns) : ''}</section>`;
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

const PURPOSE_UI = { commute: 'purposeCommute', endurance: 'purposeEndurance', tempo: 'purposeTempo', intervals: 'purposeIntervals', recovery: 'purposeRecovery', race: 'purposeRace', social: 'purposeSocial', other: 'purposeOther' };
const FEELING_UI = { fresh: 'feelingFresh', normal: 'feelingNormal', tired: 'feelingTired', ill: 'feelingIll' };
const CONDITION_UI = { headwind: 'condHeadwind', tailwind: 'condTailwind', rain: 'condRain', heat: 'condHeat', cold: 'condCold', group: 'condGroup', traffic: 'condTraffic', night: 'condNight', new_route: 'condNewRoute' };

function renderSessionNotesCard(notes, ui, mapId, inferred = null) {
  // Merge field by field: user-declared values win, the model's inference fills only what the
  // user left blank (purpose/conditions; RPE, feeling and the note are never inferred).
  const effective = {
    rpe: notes?.rpe ?? null,
    purpose: notes?.purpose ?? inferred?.purpose ?? null,
    feeling: notes?.feeling ?? null,
    conditions: notes?.conditions?.length ? notes.conditions : (inferred?.conditions ?? []),
    note: notes?.note ?? null,
  };
  const inferredHint = inferred && ((!notes?.purpose && inferred.purpose) || (!notes?.conditions?.length && inferred.conditions?.length))
    ? `<div class="mapHint" style="margin-top:0;margin-bottom:6px;">${escapeHtml(ui.notesInferredHint)}</div>` : '';
  const options = (values, uiKeys, selected) => `<option value=""${selected ? '' : ' selected'}>${escapeHtml(ui.select)}</option>`
    + values.map((value) => `<option value="${value}"${selected === value ? ' selected' : ''}>${escapeHtml(ui[uiKeys[value]])}</option>`).join('');
  const rpeOptions = `<option value=""${effective?.rpe ? '' : ' selected'}>${escapeHtml(ui.select)}</option>`
    + Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}"${effective?.rpe === index + 1 ? ' selected' : ''}>${index + 1}</option>`).join('');
  const conditions = CONDITIONS.map((value) => `<label style="display:flex;gap:4px;align-items:center;">
            <input type="checkbox" name="${mapId}Condition" value="${value}" style="width:auto;"${effective?.conditions?.includes(value) ? ' checked' : ''}>
            <span>${escapeHtml(ui[CONDITION_UI[value]])}</span>
          </label>`).join('');
  return `<section class="chart manualData">
      <h2>${escapeHtml(ui.sessionNotesSection)}</h2>
      ${inferredHint}
      <form id="${mapId}NotesForm" class="manualDataForm">
        <label><span>${escapeHtml(ui.rpeLabel)}</span><select id="${mapId}NotesRpe">${rpeOptions}</select></label>
        <label><span>${escapeHtml(ui.purposeLabel)}</span><select id="${mapId}NotesPurpose">${options(PURPOSES, PURPOSE_UI, effective?.purpose)}</select></label>
        <label><span>${escapeHtml(ui.feelingLabel)}</span><select id="${mapId}NotesFeeling">${options(FEELINGS, FEELING_UI, effective?.feeling)}</select></label>
        <fieldset style="flex:1 1 100%;border:0;padding:0;margin:0;">
          <legend style="color:var(--muted);font-size:0.82rem;padding:0 0 4px 0;">${escapeHtml(ui.conditionsLabel)}</legend>
          <div style="display:flex;gap:6px 14px;flex-wrap:wrap;color:var(--muted);font-size:0.82rem;">${conditions}</div>
        </fieldset>
        <label style="flex:1 1 100%;">
          <span>${escapeHtml(ui.sessionNoteLabel)}</span>
          <textarea id="${mapId}NotesText" rows="2" maxlength="1000" style="width:100%;box-sizing:border-box;">${escapeHtml(effective?.note || '')}</textarea>
        </label>
        <button type="submit">${escapeHtml(ui.saveNotes)}</button>
        <span id="${mapId}NotesStatus" class="manualDataStatus"></span>
      </form>
      <div class="mapHint">${escapeHtml(ui.sessionNotesHint)}</div>
    </section>`;
}

function renderRouteCard(route, ui, mapId) {
  const direction = route.relation === 'reversed' ? ui.routeDirectionReversed
    : route.relation === 'partial' ? ui.routeDirectionPartial : ui.routeDirectionSame;
  const facts = Number.isFinite(route.lengthKm)
    ? formatUi(ui.routeFacts, route.lengthKm, route.ascentM ?? '?', route.descentM ?? '?') : '';
  const climbs = route.climbs?.length
    ? formatUi(ui.routeClimbs, route.climbs.map((climb) => `km ${climb.fromKm}-${climb.toKm} +${climb.gainM} m (${climb.avgGradePct}%)`).join('; ')) : '';
  return `<section class="chart manualData">
      <h2>${escapeHtml(ui.routeSection)}</h2>
      <div class="muted">${escapeHtml(formatUi(ui.routeRides, route.rideCount, direction))}${facts ? `<br>${escapeHtml(facts)}` : ''}${climbs ? `<br>${escapeHtml(climbs)}` : ''}</div>
      <form id="${mapId}RouteForm" class="manualDataForm">
        <label>
          <span>${escapeHtml(ui.routeNameLabel)}</span>
          <input id="${mapId}RouteName" type="text" maxlength="80" style="width:260px;" value="${escapeHtml(route.name)}">
        </label>
        <label style="flex:1 1 100%;">
          <span>${escapeHtml(ui.routeNoteLabel)}</span>
          <textarea id="${mapId}RouteNote" rows="2" maxlength="1000" style="width:100%;box-sizing:border-box;" placeholder="${escapeHtml(ui.routeNotePlaceholder)}">${escapeHtml(route.note)}</textarea>
        </label>
        <button type="submit">${escapeHtml(ui.saveRoute)}</button>
        <span id="${mapId}RouteStatus" class="manualDataStatus"></span>
      </form>
      <div class="mapHint">${escapeHtml(ui.routeNoteHint)}</div>
    </section>`;
}

function renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, isComparison, compData, athleteProfile, analysis, analysisChat, wheelCalibration, ui, glossary, shouldOfferTranslations, language, segments, analysisVersion, comparisonEntries, comparedActivityId, translationJustGenerated = false, mapTiles = 'osm', routeCard = null, qualityFlags = [], modelPicker = null) {
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
    heartRateThresholds: hrConfig?.thresholds,
    powerSource: primaryPower.source,
  });
  const compSummary = hasOverlay
    ? buildSummary(comparisonPower.records, Array.isArray(compData.sessions) ? compData.sessions : [], {
      ftp: athleteFtp,
      restingHeartRate: athleteRestingHrNumber,
      sex: athleteSex,
      maxHeartRateForHrr: NaN,
      heartRateThresholds: null,
      powerSource: comparisonPower.source,
    })
    : null;
  const mapId = isComparison ? 'fitMapComp' : 'fitMap';
  const chartPointBudget = Math.min(4000, Math.max(900, Math.floor(records.length / 2)));
  const speedChart = buildLineChartFromModule(records, 'distance', 'speed', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const hrChart = buildLineChartFromModule(records, 'distance', 'heart_rate', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const altitudeChart = buildLineChartFromModule(records, 'distance', 'altitude', 1400, 380, chartPointBudget, { yTransform: (v) => v * 1000, compRecords: hasOverlay ? compRecords : [] });
  const overlayMetrics = buildOverlayMetricsFromModule(records, chartPointBudget);
  const overlayLabels = { grade: ui.grade, altitude: ui.altitude, speed: ui.speed, heart_rate: ui.heartRate };
  const overlayUnits = { speed: ui.kilometersPerHour, heart_rate: ui.beatsPerMinute };
  const speedOverlays = buildOverlayOptionsFromModule(overlayMetrics, 'speed', overlayLabels, overlayUnits);
  const hrOverlays = buildOverlayOptionsFromModule(overlayMetrics, 'heart_rate', overlayLabels, overlayUnits);
  const altitudeOverlays = buildOverlayOptionsFromModule(overlayMetrics, 'altitude', overlayLabels, overlayUnits);
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
    [mapId + 'SpeedSvg']: buildChartClientPayloadFromModule(speedChart, 'km', ui.kilometersPerHour, speedOverlays),
    [mapId + 'HrSvg']: buildChartClientPayloadFromModule(hrChart, 'km', ui.beatsPerMinute, hrOverlays),
    [mapId + 'AltSvg']: buildChartClientPayloadFromModule(altitudeChart, 'km', 'm', altitudeOverlays),
  });
  const hrZones = computeHeartRateZones(records, hrConfig?.maxHeartRate, hrConfig?.thresholds, { restingHeartRate: athleteProfile?.restingHeartRate });
  const gpsRoutePointBudget = Math.min(6000, Math.max(1200, records.length));
  const gpsRoute = buildGpsRouteFromModule(records, 1400, 420, gpsRoutePointBudget, { noPointsText: ui.noGpsPoints });
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

  // Listed regardless of the current dropdown selection - a saved comparison stays visible even
  // after picking a different (or no) activity in "Compare with", same as it stays in the DB.
  const comparisonEntriesSafe = Array.isArray(comparisonEntries) ? comparisonEntries : [];
  const comparisonListHtml = comparisonEntriesSafe.map((entry) => `
      <div class="comparisonCard" data-compared-id="${entry.comparedActivityId}" style="margin-bottom:10px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--vscode-editor-background);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
          <strong style="font-size:0.9rem;">${escapeHtml(entry.label)}</strong>
          <button class="removeComparisonBtn" data-compared-id="${entry.comparedActivityId}" style="padding:4px 10px;background:transparent;color:var(--ink);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:0.8rem;">${escapeHtml(ui.removeComparison)}</button>
        </div>
        <div style="color:var(--ink);font-size:1.08rem;line-height:1.6;word-break:break-word;">${renderMarkdown(entry.comparisonText)}</div>
      </div>`).join('');

  // The trigger targets whichever activity is picked in "Compare with" right now; the label
  // switches to "Compare Again" if that pair already has a saved comparison in the list above.
  const comparedId = Number(comparedActivityId);
  const canCompare = Number.isFinite(comparedId) && comparedId > 0;
  const alreadyCompared = canCompare && comparisonEntriesSafe.some((entry) => entry.comparedActivityId === comparedId);
  const compareTriggerHtml = canCompare
    ? `<button id="compareBtn" style="padding:8px 14px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">${escapeHtml(alreadyCompared ? ui.compareAgain : ui.compareWithAI)}</button>`
    : '';

  const comparisonBlock = (comparisonEntriesSafe.length || canCompare) ? `
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
        <h3 style="margin:0 0 8px 0;font-size:0.95rem;color:var(--muted);">${escapeHtml(ui.compareWithAI)}</h3>
        <div id="comparisonList">${comparisonListHtml || `<p id="comparisonEmpty" style="margin:0;color:var(--muted);">${escapeHtml(ui.noComparisonsYet)}</p>`}</div>
        <div id="comparisonTrigger" style="margin-top:8px;">${compareTriggerHtml}</div>
        <div id="comparisonStatus" style="margin-top:6px;font-size:0.85rem;color:var(--muted);"></div>
      </div>` : '';

  const routeCardHtml = routeCard && !isComparison ? renderRouteCard(routeCard, ui, mapId) : '';
  const notesCardHtml = isComparison ? '' : renderSessionNotesCard(fitData.sessionNotes, ui, mapId, fitData.inferredNotes);

  // The analysis-model picker. It shows the model that produced the analysis on screen (when it
  // is still offered) and otherwise the default, named by the model it actually resolves to. It
  // only prepares a choice: the analysis runs when the athlete presses the Analyze button.
  const modelPickerModels = Array.isArray(modelPicker?.models) ? modelPicker.models : [];
  const usedModelId = analysis?.modelId && modelPickerModels.some((model) => model.id === analysis.modelId) ? analysis.modelId : '';
  const modelOptions = [
    `<option value=""${usedModelId ? '' : ' selected'}>${escapeHtml(formatUi(ui.defaultModel, modelPicker?.defaultName || ui.cheapestModel))}</option>`,
    ...modelPickerModels.map((model) => `<option value="${escapeHtml(model.id)}"${model.id === usedModelId ? ' selected' : ''}>${escapeHtml(model.name)}</option>`),
  ].join('');

  return `<main class="wrap">
    <section class="hero">
      <h1>${escapeHtml(ui.fitActivity)}</h1>
      <div class="muted">${safeFile}</div>
    </section>
    ${shouldOfferTranslations ? `<section class="calibrationHint"><span>${escapeHtml(formatUi(ui.translationsAvailable, language))}</span><button type="button" id="generateTranslationsBtn">${escapeHtml(formatUi(ui.generateTranslations, language))}</button><span id="translationStatus"></span></section>` : ''}
    ${translationJustGenerated ? `<section class="calibrationHint"><span>${escapeHtml(formatUi(ui.translationGenerated, language))}</span></section>` : ''}
    ${compStatsRow}
    <section class="grid">
      ${metric(ui.recordsLabel, summary.records, 'records', glossary)}
      ${metric(ui.sessionsLabel, sessions.length, 'sessions', glossary)}
      ${metric(ui.distanceKm, summary.distanceKm.toFixed(2), 'distance', glossary)}
      ${metric(ui.durationHms, summary.durationText, 'duration', glossary)}
      ${metric(ui.avgSpeedKmh, summary.avgSpeed.toFixed(2), 'averageSpeed', glossary)}
      ${metric(ui.maxSpeedKmh, summary.maxSpeed.toFixed(2), 'maximumSpeed', glossary)}
      ${metric(ui.avgPowerW + powerMetricSuffix, summary.avgPower.toFixed(0), 'averagePower', glossary)}
      ${metric(ui.maxPowerW + powerMetricSuffix, summary.maxPower.toFixed(0), 'maximumPower', glossary)}
      ${metric(ui.normalizedPowerW + powerMetricSuffix, summary.normalizedPower?.toFixed(0) ?? 'n/a', 'normalizedPower', glossary)}
      ${metric(ui.intensityFactorIf + powerMetricSuffix, summary.intensityFactor > 0 ? summary.intensityFactor.toFixed(2) : 'n/a', 'intensityFactor', glossary)}
      ${metric(ui.tssScore + powerMetricSuffix, summary.trainingStressScore > 0 ? summary.trainingStressScore.toFixed(1) : 'n/a', 'trainingStressScore', glossary)}
      ${metric(ui.xPowerGcW + powerMetricSuffix, summary.xPower > 0 ? summary.xPower.toFixed(0) : 'n/a', 'xpower', glossary)}
      ${metric(ui.riGc + powerMetricSuffix, summary.relativeIntensityGc > 0 ? summary.relativeIntensityGc.toFixed(2) : 'n/a', 'relativeIntensity', glossary)}
      ${metric(ui.bikeStressGc + powerMetricSuffix, summary.bikeStressScore > 0 ? summary.bikeStressScore.toFixed(1) : 'n/a', 'bikeStress', glossary)}
      ${metric(ui.decouplingIntervals + powerMetricSuffix, Number.isFinite(summary.decouplingPct) ? summary.decouplingPct.toFixed(1) + '%' : 'n/a', 'decoupling', glossary)}
      ${metric(ui.trimp, Number.isFinite(summary.trimp) ? summary.trimp.toFixed(1) : 'n/a', 'trimp', glossary)}
      ${metric(ui.hrTss, summary.hrTss > 0 ? summary.hrTss.toFixed(1) : 'n/a', 'hrTss', glossary)}
      ${metric(ui.avgHrBpm, summary.avgHr.toFixed(0), 'averageHeartRate', glossary)}
      ${metric(ui.maxHrBpm, summary.maxHr.toFixed(0), 'maximumHeartRate', glossary)}
      ${metric(ui.elevationGainM, summary.elevationGainM.toFixed(0), 'elevationGain', glossary)}
      ${metric(ui.elevationLossM, summary.elevationLossM.toFixed(0), 'elevationLoss', glossary)}
      ${metric(ui.gpsPointsLabel, gpsRoute.pointCount, 'gpsPoints', glossary)}
    </section>
    ${renderSessionChips({ ...fitData, qualityFlags }, ui)}
    ${primaryPower.source === 'estimated' ? `<section style="padding:12px;margin-bottom:16px;background:rgba(255,193,7,0.1);border-left:4px solid #ffc107;color:var(--ink);font-size:0.95rem;line-height:1.5;">
      <strong>${escapeHtml(ui.dataQualityNoteTitle)}</strong> ${escapeHtml(ui.dataQualityNote)}
    </section>` : ''}
    ${notesCardHtml}
    ${routeCardHtml}
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
      <div class="mapHint">${escapeHtml(ui.manualSummaryHint)}</div>
    </section>
    <section class="chart manualData">
      <h2>${escapeHtml(ui.heartRateZoneProfile)}</h2>
      <form id="${mapId}HrProfileForm" class="manualDataForm">
        <label>
          <span>${escapeHtml(ui.effectiveFrom)}</span>
          <input id="${mapId}HrEffectiveDate" type="date" value="${escapeHtml(activityDate)}" required>
        </label>
        <label>
          <span>${escapeHtml(ui.maximumHeartRate)}</span>
          <input id="${mapId}ProfileMaxHr" type="number" min="100" max="240" step="1" value="${profileMaxHr}" required>
        </label>
        ${[2, 3, 4, 5].map((zone, index) => `<label>
          <span>${escapeHtml(formatUi(ui.zoneStarts, zone))}</span>
          <input id="${mapId}Zone${zone}Start" type="number" min="30" max="240" step="1" value="${positiveNumberOrBlank(profileThresholds[index])}" placeholder="${escapeHtml(ui.auto)}">
        </label>`).join('')}
        <label>
          <span>${escapeHtml(ui.lactateThresholdHr)}</span>
          <input id="${mapId}ProfileLthr" type="number" min="100" max="240" step="1" value="${positiveNumberOrBlank(hrConfig?.lthr)}" placeholder="${escapeHtml(ui.optional)}">
        </label>
        <label>
          <span>${escapeHtml(ui.sex)}</span>
          <select id="${mapId}AthleteSex">
            <option value=""${athleteSexValue ? '' : ' selected'}>${escapeHtml(ui.select)}</option>
            <option value="male"${athleteSexValue === 'male' ? ' selected' : ''}>${escapeHtml(ui.male)}</option>
            <option value="female"${athleteSexValue === 'female' ? ' selected' : ''}>${escapeHtml(ui.female)}</option>
            <option value="other"${athleteSexValue === 'other' ? ' selected' : ''}>${escapeHtml(ui.other)}</option>
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
          <span>${escapeHtml(ui.ftp)}</span>
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
        <input type="hidden" id="${mapId}ObservedMaxSource" value="">
        <button type="button" id="${mapId}AutoCalcZonesBtn">${escapeHtml(ui.autoCalculate)}</button>
        <button type="submit">${escapeHtml(ui.saveZones)}</button>
        <span id="${mapId}HrProfileStatus" class="manualDataStatus"></span>
      </form>
      ${wheelCalibrationHint}
      <div class="mapHint">${escapeHtml(ui.autoCalcInfo)}${hrConfig?.effectiveDate ? ` ${escapeHtml(ui.currentlyApplied)} ${escapeHtml(hrConfig.effectiveDate)}.` : ''}</div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}SpeedSvg" data-resize-key="fitviz_speed_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.speedVsDistance)}${hasOverlay ? ' <span class="compLegend">- ' + escapeHtml(ui.primary) + ' / ' + escapeHtml(ui.comparison) + '</span>' : ''}</h2>
      <label class="segmentBandControls"><input id="${mapId}SegmentBands" type="checkbox" checked> ${escapeHtml(ui.showTerrainBands)}</label>
      ${renderStatsRow(speedChart.stats, ui.kilometersPerHour, false, ui)}${hasOverlay && speedChart.compStats ? renderStatsRow(speedChart.compStats, ui.kilometersPerHour, true, ui) : ''}
      ${speedChart.points.length >= 2 ? renderOverlayControls(mapId + 'SpeedSvg', speedOverlays) : ''}
      ${renderScaledLineChartSvg(speedChart, 'lineA', ui.distanceKm, ui.avgSpeedKmh, true, { svgId: mapId + 'SpeedSvg', segmentBands: chartSegments })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}HrSvg" data-resize-key="fitviz_hr_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.heartRateVsDistance)}</h2>
      ${renderStatsRow(hrChart.stats, ui.beatsPerMinute, false, ui)}
      ${renderHeartRateZones(hrZones, ui)}
      ${hrChart.points.length >= 2 ? renderOverlayControls(mapId + 'HrSvg', hrOverlays) : ''}
      ${renderScaledLineChartSvg(hrChart, 'lineB', ui.distanceKm, ui.avgHrBpm, true, { svgId: mapId + 'HrSvg', zoneThresholds: hrZones.enabled ? hrZones.thresholds : null, segmentBands: chartSegments })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}AltSvg" data-resize-key="fitviz_alt_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.altitudeVsDistance)}${hasOverlay ? ' <span class="compLegend">- ' + escapeHtml(ui.primary) + ' / ' + escapeHtml(ui.comparison) + '</span>' : ''}</h2>
      ${renderStatsRow(altitudeChart.stats, 'm', false, ui)}${hasOverlay && altitudeChart.compStats ? renderStatsRow(altitudeChart.compStats, 'm', true, ui) : ''}
      ${altitudeChart.points.length >= 2 ? renderOverlayControls(mapId + 'AltSvg', altitudeOverlays) : ''}
      ${renderScaledLineChartSvg(altitudeChart, 'lineC', ui.distanceKm, ui.elevationGainM, true, { svgId: mapId + 'AltSvg', segmentBands: chartSegments })}
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
      ${renderMapStats(gpsRoute, ui)}
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
        <div class="mapHint">${escapeHtml(mapTiles === 'none' ? ui.mapTilesOffline : ui.mapTiles)}</div>
      </div>
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart">
      <h2>${escapeHtml(ui.aiAnalysis)}</h2>
      <div id="analysisContent" style="padding:12px;color:var(--muted);min-height:80px;line-height:1.5;">
        <p style="margin:0;">${escapeHtml(ui.loadingAnalysis)}</p>
      </div>
      <div id="analysisMeta" style="display:none;padding:0 12px 6px 12px;font-size:0.75rem;color:var(--muted);"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="analyzeBtn" style="margin-top:10px;padding:8px 16px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">${escapeHtml(ui.analyzeActivity)}</button>
        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;color:var(--muted);font-size:0.85rem;">
          <span>${escapeHtml(ui.analysisModelLabel)}</span>
          <select id="modelSel" class="actSelector" style="width:auto;min-width:160px;border:1px solid var(--input-border);">${modelOptions}</select>
        </label>
      </div>
      ${comparisonBlock}
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
        <h3 style="margin:0 0 8px 0;font-size:0.95rem;color:var(--muted);">${escapeHtml(ui.followUpChat)}</h3>
        <div id="analysisChatMessages" style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:10px;background:var(--vscode-editor-background);"></div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:flex-start;">
          <textarea id="analysisChatInput" rows="3" placeholder="${escapeHtml(ui.followUpPlaceholder)}" style="flex:1;min-height:62px;resize:vertical;border:1px solid var(--input-border);border-radius:6px;padding:8px;background:var(--input-bg);color:var(--input-fg);"></textarea>
          <button id="analysisChatSendBtn" style="padding:8px 14px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">${escapeHtml(ui.send)}</button>
        </div>
        <div id="analysisChatStatus" style="margin-top:6px;font-size:0.85rem;color:var(--muted);"></div>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    (function () {
      const ui = ${safeJson(ui)};
      function formatMessage(template) {
        const values = Array.prototype.slice.call(arguments, 1);
        // The page script sits inside a template literal: every backslash here must be doubled.
        return String(template || '').replace(/\\{(\\d+)\\}/g, (_, index) => String(values[Number(index)] ?? ''));
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

      // Same markdown renderer the server uses for the initial comparison list.
      const renderMarkdown = ${renderMarkdown.toString()};

      const analysisContent = document.getElementById('analysisContent');
      const analysisMetaEl = document.getElementById('analysisMeta');
      const analyzeBtn = document.getElementById('analyzeBtn');
      const analysisChatMessagesEl = document.getElementById('analysisChatMessages');
      const analysisChatInput = document.getElementById('analysisChatInput');
      const analysisChatSendBtn = document.getElementById('analysisChatSendBtn');
      const analysisChatStatus = document.getElementById('analysisChatStatus');
      const generateTranslationsBtn = document.getElementById('generateTranslationsBtn');
      const translationStatus = document.getElementById('translationStatus');
      const manualDataForm = document.getElementById('${mapId}ManualDataForm');
      const manualDataStatus = document.getElementById('${mapId}ManualDataStatus');
      const notesForm = document.getElementById('${mapId}NotesForm');
      const notesStatus = document.getElementById('${mapId}NotesStatus');
      const routeForm = document.getElementById('${mapId}RouteForm');
      const routeStatus = document.getElementById('${mapId}RouteStatus');
      const hrProfileForm = document.getElementById('${mapId}HrProfileForm');
      const hrProfileStatus = document.getElementById('${mapId}HrProfileStatus');
      const autoCalcZonesBtn = document.getElementById('${mapId}AutoCalcZonesBtn');
      const comparisonList = document.getElementById('comparisonList');
      const comparisonStatus = document.getElementById('comparisonStatus');
      const compareBtn = document.getElementById('compareBtn');
      const vscode = window.fitVisualizerApi;
      const analysisVersion = ${safeJson(analysisVersion)};
      const initialAnalysis = ${safeJson(analysis?.text || '')};
      let analysisMeta = ${safeJson(analysis?.modelId || analysis?.analyzedAt ? { modelId: analysis?.modelId || null, analyzedAt: analysis?.analyzedAt || null } : null)};
      let hasAnalysis = Boolean(initialAnalysis);
      let analysisOutdated = ${analysis && asNumber(analysis.version) < analysisVersion ? 'true' : 'false'};
      let chatMessages = ${safeJson(Array.isArray(analysisChat) ? analysisChat : [])};
      let comparisons = ${safeJson(comparisonEntriesSafe)};
      const compareActivityId = ${canCompare ? comparedId : 'null'};

      function analyzeButtonLabel() {
        if (!hasAnalysis) return ui.analyzeActivity;
        return analysisOutdated ? ui.reanalyze : ui.analyzeAgain;
      }

      function showAnalysisText(text) {
        const note = analysisOutdated
          ? '<div style="margin:0 0 10px 0;padding:8px 10px;border-left:4px solid #ffc107;background:rgba(255,193,7,0.1);font-size:0.92rem;">' + escapeHtml(ui.olderAnalysis) + '</div>'
          : '';
        analysisContent.innerHTML = note + '<div style="color:var(--ink);font-size:1.08rem;line-height:1.6;word-break:break-word;">' + renderMarkdown(text) + '</div>';
      }

      function showAnalysisMeta() {
        if (!analysisMeta || !analysisMeta.modelId) {
          analysisMetaEl.style.display = 'none';
          return;
        }
        const date = analysisMeta.analyzedAt ? new Date(analysisMeta.analyzedAt).toLocaleDateString() : '';
        analysisMetaEl.textContent = formatMessage(ui.analyzedBy, analysisMeta.modelId, String(analysisVersion), date).replace(/  /g, ' ');
        analysisMetaEl.style.display = 'block';
      }

      function setSegmentBudgetWarning(warnings) {
        const el = document.getElementById('segmentBudgetWarning');
        if (!el) return;
        const text = warnings.filter(Boolean).join(' ');
        el.style.display = text ? 'block' : 'none';
        el.textContent = text;
      }

      function compareButtonLabel() {
        const alreadyCompared = comparisons.some((entry) => entry.comparedActivityId === compareActivityId);
        return alreadyCompared ? ui.compareAgain : ui.compareWithAI;
      }

      function renderComparisonCard(entry) {
        return '<div class="comparisonCard" data-compared-id="' + entry.comparedActivityId + '" style="margin-bottom:10px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--vscode-editor-background);">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">'
          + '<strong style="font-size:0.9rem;">' + escapeHtml(entry.label) + '</strong>'
          + '<button class="removeComparisonBtn" data-compared-id="' + entry.comparedActivityId + '" style="padding:4px 10px;background:transparent;color:var(--ink);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:0.8rem;">' + escapeHtml(ui.removeComparison) + '</button>'
          + '</div>'
          + '<div style="color:var(--ink);font-size:1.08rem;line-height:1.6;word-break:break-word;">' + renderMarkdown(entry.comparisonText) + '</div>'
          + '</div>';
      }

      function renderComparisonList() {
        if (!comparisonList) return;
        comparisonList.innerHTML = comparisons.length
          ? comparisons.map(renderComparisonCard).join('')
          : '<p id="comparisonEmpty" style="margin:0;color:var(--muted);">' + escapeHtml(ui.noComparisonsYet) + '</p>';
      }

      function updateCompareTrigger() {
        if (compareBtn) {
          compareBtn.disabled = false;
          compareBtn.textContent = compareButtonLabel();
        }
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
            + '<div style="line-height:1.45;">' + renderMarkdown(entry.content || '') + '</div>'
            + '</div>';
        }).join('');
        analysisChatMessagesEl.scrollTop = analysisChatMessagesEl.scrollHeight;
      }

      renderChatMessages();
      if (initialAnalysis) {
        showAnalysisText(initialAnalysis);
        showAnalysisMeta();
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
          && Number(msg.id) !== currentId) {
          return;
        }
        if (msg.type === 'analysisResult') {
          hasAnalysis = true;
          analysisOutdated = false;
          analysisMeta = msg.modelId ? { modelId: msg.modelId, analyzedAt: msg.analyzedAt || null } : null;
          showAnalysisText(msg.analysis);
          showAnalysisMeta();
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = analyzeButtonLabel();
          const modelSel = document.getElementById('modelSel');
          if (modelSel && msg.modelId && Array.from(modelSel.options).some((option) => option.value === msg.modelId)) {
            modelSel.value = msg.modelId;
          }
          setSegmentBudgetWarning(Array.isArray(msg.warnings) ? msg.warnings : []);
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
          const compId = Number(msg.compId);
          const existing = comparisons.find((entry) => entry.comparedActivityId === compId);
          const label = existing ? existing.label : (function () {
            const select = document.getElementById('compSel');
            const selected = select && select.selectedOptions && select.selectedOptions[0];
            return selected ? selected.textContent : ('#' + compId);
          }());
          comparisons = comparisons.filter((entry) => entry.comparedActivityId !== compId);
          comparisons.unshift({ comparedActivityId: compId, label, comparisonText: msg.comparison });
          renderComparisonList();
          updateCompareTrigger();
          if (comparisonStatus) comparisonStatus.textContent = '';
        } else if (msg.type === 'comparisonError') {
          if (comparisonStatus) {
            comparisonStatus.textContent = formatMessage(ui.error, msg.error);
            comparisonStatus.style.color = '#ff6b6b';
          }
          updateCompareTrigger();
        } else if (msg.type === 'comparisonRemoved') {
          const removedId = Number(msg.compId);
          comparisons = comparisons.filter((entry) => entry.comparedActivityId !== removedId);
          renderComparisonList();
          updateCompareTrigger();
        } else if (msg.type === 'translationError') {
          if (translationStatus) {
            const rawError = String(msg?.error ?? '').trim();
            const fallback = 'Translation generation failed.';
            const errorText = rawError && rawError !== 'Error: {0}' ? rawError : fallback;
            translationStatus.textContent = formatMessage(ui.error, errorText);
          }
          if (generateTranslationsBtn) generateTranslationsBtn.disabled = false;
        } else if (msg.type === 'translationCancelled') {
          if (translationStatus) translationStatus.textContent = '';
          if (generateTranslationsBtn) generateTranslationsBtn.disabled = false;
        } else if (msg.type === 'manualDataError') {
          manualDataStatus.textContent = msg.error;
          manualDataStatus.classList.add('error');
        } else if (msg.type === 'notesError') {
          if (notesStatus) {
            notesStatus.textContent = msg.error;
            notesStatus.classList.add('error');
          }
        } else if (msg.type === 'routeError') {
          if (routeStatus) {
            routeStatus.textContent = msg.error;
            routeStatus.classList.add('error');
          }
        } else if (msg.type === 'heartRateProfileError') {
          hrProfileStatus.textContent = msg.error;
          hrProfileStatus.classList.add('error');
        } else if (msg.type === 'heartRateProfileAuto') {
          document.getElementById('${mapId}ObservedMaxSource').value = msg.suggestion.observedMaxSource ? JSON.stringify(msg.suggestion.observedMaxSource) : '';
          document.getElementById('${mapId}ProfileMaxHr').value = msg.suggestion.maxHeartRate;
          [2, 3, 4, 5].forEach((zone, index) => {
            document.getElementById('${mapId}Zone' + zone + 'Start').value = msg.suggestion.thresholds[index];
          });
          if (msg.suggestion.observedMaxNotice) {
            hrProfileStatus.textContent = msg.suggestion.observedMaxNotice;
            hrProfileStatus.classList.remove('error');
          }
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

      notesForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        notesStatus.textContent = ui.saving;
        notesStatus.classList.remove('error');
        vscode.postMessage({
          type: 'updateActivityNotes',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
          rpe: document.getElementById('${mapId}NotesRpe').value,
          purpose: document.getElementById('${mapId}NotesPurpose').value,
          feeling: document.getElementById('${mapId}NotesFeeling').value,
          conditions: Array.from(document.querySelectorAll('input[name="${mapId}Condition"]:checked')).map((input) => input.value),
          note: document.getElementById('${mapId}NotesText').value,
        });
      });

      routeForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        routeStatus.textContent = ui.saving;
        routeStatus.classList.remove('error');
        vscode.postMessage({
          type: 'updateRoute',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
          routeId: ${JSON.stringify(routeCard?.routeId ?? null)},
          name: document.getElementById('${mapId}RouteName').value,
          note: document.getElementById('${mapId}RouteNote').value,
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
          lthr: document.getElementById('${mapId}ProfileLthr').value,
          observedMaxSource: document.getElementById('${mapId}ObservedMaxSource').value || null,
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
          const modelSel = document.getElementById('modelSel');
          vscode.postMessage({ type: 'analyzeActivity', id: window.currentActivityId, force: hasAnalysis, modelId: modelSel ? modelSel.value : '' });
        });
      }

      compareBtn?.addEventListener('click', () => {
        if (!window.currentActivityId || window.currentActivityId === 'null' || !compareActivityId) {
          return;
        }
        const alreadyCompared = comparisons.some((entry) => entry.comparedActivityId === compareActivityId);
        compareBtn.disabled = true;
        compareBtn.textContent = ui.comparing;
        if (comparisonStatus) comparisonStatus.textContent = '';
        vscode.postMessage({ type: 'compareActivitiesAI', id: window.currentActivityId, compId: compareActivityId, force: alreadyCompared });
      });

      // Event delegation: comparison cards (and their Remove buttons) are re-rendered as a group,
      // so a per-button listener would need to be re-attached on every list update.
      comparisonList?.addEventListener('click', (event) => {
        const button = event.target.closest('.removeComparisonBtn');
        if (!button || !window.currentActivityId || window.currentActivityId === 'null') {
          return;
        }
        const removedId = Number(button.dataset.comparedId);
        button.disabled = true;
        button.textContent = ui.removingComparison;
        vscode.postMessage({ type: 'removeComparison', id: window.currentActivityId, compId: removedId });
      });

      generateTranslationsBtn?.addEventListener('click', () => {
        generateTranslationsBtn.disabled = true;
        if (translationStatus) translationStatus.textContent = ui.translationGenerating;
        try {
          vscode.postMessage({
            type: 'generateTranslations',
            id: window.currentActivityId,
            compId: document.getElementById('compSel')?.value || null,
          });
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          if (translationStatus) translationStatus.textContent = errorText || 'Translation generation failed.';
          generateTranslationsBtn.disabled = false;
        }
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
            ? ui.mapLibraryMissing
            : ui.noGpsPoints;
          mapEl.innerHTML = '<div style="padding:12px;color:var(--muted)">' + reason + '</div>';
        }
      } else {
        if (gpsRouteSection) gpsRouteSection.style.display = 'none';
        map = L.map('${mapId}', { preferCanvas: true, zoomControl: true, scrollWheelZoom: false });
        ${mapTiles === 'none' ? '' : `L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);`}
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
      var decimalSeparator = ${safeJson(ui.decimalSeparator)};
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

      function withinRange(ticks, min, max) {
        var epsilon = Math.abs(ticks.step) * 1e-6;
        return ticks.values.filter(function (v) { return v >= min - epsilon && v <= max + epsilon; });
      }

      // Densest Y grid (preferring at least 6 ticks) that still leaves two non-colliding labels.
      function fitYTickCount(payload, plotHeightPx) {
        var range = (payload.yMax - payload.yMin) || 1;
        var fallback = 2;
        for (var count = clampCount(plotHeightPx / 30, 6, 18); count >= 2; count--) {
          var ticks = buildTicksClient(payload.yMin, payload.yMax, count);
          var n = withinRange(ticks, payload.yMin, payload.yMax).length;
          var every = Math.max(1, Math.ceil((TICK_FONT_PX + 4) / (((ticks.step / range) * plotHeightPx) || 1)));
          if (n >= 2 && Math.floor((n - 1) / every) + 1 >= 2) return count;
          if (n >= 2 && fallback === 2) fallback = count;
        }
        return fallback;
      }

      function redrawTicks(svg, payload, targetXCount, targetYCount, xScale, yScale) {
        var xTicks = buildTicksClient(payload.xMin, payload.xMax, targetXCount);
        var yTicks = buildTicksClient(payload.yMin, payload.yMax, targetYCount);
        var xLabelY = payload.plotBottom + (TICK_FONT_PX + 5) / (yScale || 1);
        var yLabelX = payload.plotLeft - 6 / (xScale || 1);

        var xHtml = withinRange(xTicks, payload.xMin, payload.xMax).map(function (v) {
          var px = scaleX(payload, v).toFixed(1);
          return '<g><line class="gridline" x1="' + px + '" y1="' + payload.plotTop + '" x2="' + px + '" y2="' + payload.plotBottom + '" />'
            + '<text class="tick" x="' + px + '" y="' + xLabelY.toFixed(1) + '" text-anchor="middle">'
            + escapeHtmlClient(formatTickClient(v, xTicks.step)) + '</text></g>';
        }).join('');
        var yValues = withinRange(yTicks, payload.yMin, payload.yMax);
        var ySpacingPx = (yTicks.step / ((payload.yMax - payload.yMin) || 1)) * (payload.plotBottom - payload.plotTop) * (yScale || 1);
        // Too low for every label: keep every grid line but label only every n-th tick.
        var yLabelEvery = Math.min(Math.max(1, Math.ceil((TICK_FONT_PX + 4) / (ySpacingPx || 1))), Math.max(1, yValues.length - 1));
        var yHtml = yValues.map(function (v, index) {
          var py = scaleY(payload, v).toFixed(1);
          var labelled = (yValues.length - 1 - index) % yLabelEvery === 0;
          return '<g><line class="gridline" x1="' + payload.plotLeft + '" y1="' + py + '" x2="' + payload.plotRight + '" y2="' + py + '" />'
            + (labelled ? '<text class="tick" x="' + yLabelX.toFixed(1) + '" y="' + py + '" dy="0.35em" text-anchor="end">'
            + escapeHtmlClient(formatTickClient(v, yTicks.step)) + '</text>' : '') + '</g>';
        }).join('');

        var xGroup = svg.querySelector('.xTicksGroup');
        var yGroup = svg.querySelector('.yTicksGroup');
        if (xGroup) xGroup.innerHTML = xHtml;
        if (yGroup) yGroup.innerHTML = yHtml;
      }

      // preserveAspectRatio="none" stretches X and Y differently, so every text node undoes both around its anchor.
      function updateChartTextScale(svg, payload, rect) {
        if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(payload.width > 0) || !(payload.height > 0)) return;
        var xScale = rect.width / payload.width;
        var yScale = rect.height / payload.height;
        var unscale = ' scale(' + (1 / xScale).toFixed(4) + ' ' + (1 / yScale).toFixed(4) + ')';

        function unstretch(el, cssPx, x, y) {
          if (!el || !Number.isFinite(x) || !Number.isFinite(y)) return;
          el.style.fontSize = cssPx + 'px';
          el.setAttribute('transform', 'translate(' + x + ' ' + y + ')' + unscale + ' translate(' + (-x) + ' ' + (-y) + ')');
        }

        svg.querySelectorAll('.tick, .overlayTick').forEach(function (el) {
          unstretch(el, TICK_FONT_PX, parseFloat(el.getAttribute('x')), parseFloat(el.getAttribute('y')));
        });
        var axisX = svg.querySelector('.axisLabelX');
        if (axisX) unstretch(axisX, AXIS_TITLE_FONT_PX, parseFloat(axisX.getAttribute('x')), parseFloat(axisX.getAttribute('y')));
        var axisY = svg.querySelector('.axisLabelY');
        if (axisY) {
          axisY.style.fontSize = AXIS_TITLE_FONT_PX + 'px';
          axisY.setAttribute('transform', 'translate(' + (16 / xScale).toFixed(2) + ' ' + ((payload.plotTop + payload.plotBottom) / 2).toFixed(1) + ')' + unscale + ' rotate(-90)');
          // On a very low panel the rotated title would overflow the plot; the section heading names the metric anyway.
          axisY.style.display = '';
          axisY.style.display = axisY.getBBox().width > (payload.plotBottom - payload.plotTop) * yScale ? 'none' : '';
        }
        var crosshairLabel = svg.querySelector('.crosshairLabel');
        var crosshairAnchor = crosshairLabel && crosshairLabel.querySelector('.crosshairLabelX');
        if (crosshairAnchor) {
          unstretch(crosshairLabel, 13, parseFloat(crosshairAnchor.getAttribute('x')), parseFloat(crosshairAnchor.getAttribute('y')));
          crosshairLabel.style.strokeWidth = '3px';
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
        return value.toFixed(digits).replace('.', decimalSeparator) + (unit ? ' ' + unit : '');
      }

      // Max 2 at once: more than that on top of the main line becomes unreadable.
      var OVERLAY_PALETTE = ['#e67e22', '#00acc1'];
      // Gutter is always sized for every overlay axis so toggling overlays never resizes the plot.
      var TICK_FONT_PX = 13;
      var AXIS_TITLE_FONT_PX = 14;
      var OVERLAY_AXIS_COLUMN_PX = 50;
      var OVERLAY_GUTTER_PX = 8 + OVERLAY_PALETTE.length * OVERLAY_AXIS_COLUMN_PX;
      var PLAIN_RIGHT_GUTTER_PX = 16;
      // Rotated axis title plus the widest Y tick label.
      var LEFT_GUTTER_PX = 72;
      // Half a tick label above the top grid line; X tick labels plus the axis title below.
      var TOP_GUTTER_PX = 14;
      var BOTTOM_GUTTER_PX = 50;

      function initOverlayControls(svgId, payload, instance, svg) {
        var controls = document.querySelector('.overlayControls[data-overlay-for="' + svgId + '"]');
        if (!controls || !payload.overlays) return;
        var active = {};
        instance.activeOverlays = active;

        function overlayLineId(metricKey) { return svgId + '_overlay_' + metricKey; }

        function overlayAxisId(metricKey) { return svgId + '_overlay_axis_' + metricKey; }

        function drawOverlay(metricKey, color, axisX) {
          var series = payload.overlays[metricKey];
          if (!series || !instance.overlayGroup || !instance.overlayYAxisGroup) return null;
          var chartRect = svg.getBoundingClientRect();
          var xScale = chartRect.width / payload.width;
          var minLabelGap = (TICK_FONT_PX + 6) / ((chartRect.height / payload.height) || 1);
          var range = (series.max - series.min) || 1;
          var pts = series.points.map(function (p) {
            var px = scaleX(payload, p[0]);
            var py = payload.plotBottom - ((p[1] - series.min) / range) * (payload.plotBottom - payload.plotTop);
            return px.toFixed(1) + ',' + py.toFixed(1);
          }).join(' ');
          var existing = instance.overlayGroup.querySelector('#' + overlayLineId(metricKey));
          if (existing) {
            existing.setAttribute('points', pts);
            existing.setAttribute('stroke', color);
          } else {
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

          var existingAxis = instance.overlayYAxisGroup.querySelector('#' + overlayAxisId(metricKey));
          if (existingAxis) existingAxis.parentNode.removeChild(existingAxis);
          var axis = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          axis.setAttribute('id', overlayAxisId(metricKey));
          axis.setAttribute('class', 'overlayYAxis');
          axis.style.color = color;
          var axisLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          axisLine.setAttribute('class', 'overlayAxisLine');
          axisLine.setAttribute('x1', axisX);
          axisLine.setAttribute('x2', axisX);
          axisLine.setAttribute('y1', payload.plotTop);
          axisLine.setAttribute('y2', payload.plotBottom);
          axis.appendChild(axisLine);
          var ticks = Array.isArray(series.yTicks) ? series.yTicks : buildTicksClient(series.min, series.max, 18).values;
          var tickStep = Number.isFinite(series.yStep) ? series.yStep : buildTicksClient(series.min, series.max, 18).step;
          var tickRange = (series.max - series.min) || 1;
          var tickEpsilon = Math.abs(tickStep) * 1e-6;
          var visibleTicks = [];
          ticks.filter(function (value) {
            return value >= series.min - tickEpsilon && value <= series.max + tickEpsilon;
          }).forEach(function (value) {
            var currentPy = payload.plotBottom - ((value - series.min) / tickRange) * (payload.plotBottom - payload.plotTop);
            var currentLabelY = currentPy + 4;
            if (!visibleTicks.length) {
              visibleTicks.push(value);
              return;
            }
            var previousValue = visibleTicks[visibleTicks.length - 1];
            var previousPy = payload.plotBottom - ((previousValue - series.min) / tickRange) * (payload.plotBottom - payload.plotTop);
            var previousLabelY = previousPy + 4;
            if (Math.abs(currentLabelY - previousLabelY) >= minLabelGap) {
              visibleTicks.push(value);
            } else if (value === 0 && previousValue !== 0) {
              visibleTicks[visibleTicks.length - 1] = value;
            }
          });
          visibleTicks.forEach(function (value) {
            var py = payload.plotBottom - ((value - series.min) / range) * (payload.plotBottom - payload.plotTop);
            var tickLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tickLine.setAttribute('class', 'overlayAxisTick');
            tickLine.setAttribute('x1', axisX - 4 / xScale);
            tickLine.setAttribute('x2', axisX);
            tickLine.setAttribute('y1', py.toFixed(1));
            tickLine.setAttribute('y2', py.toFixed(1));
            axis.appendChild(tickLine);
            var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'overlayTick');
            text.setAttribute('x', axisX + 6 / xScale);
            text.setAttribute('y', py.toFixed(1));
            text.setAttribute('dy', '0.35em');
            text.textContent = formatTickClient(value, tickStep);
            axis.appendChild(text);
          });
          instance.overlayYAxisGroup.appendChild(axis);
          updateChartTextScale(svg, payload, chartRect);
          return axis;
        }

        function redrawActiveOverlayAxes() {
          Object.keys(active).forEach(function (metricKey) {
            var axis = instance.overlayYAxisGroup.querySelector('#' + overlayAxisId(metricKey));
            if (axis) axis.parentNode.removeChild(axis);
          });
          var xScale = (instance.lastRect || svg.getBoundingClientRect()).width / payload.width;
          if (!(xScale > 0)) return;
          // Each palette color owns a fixed column, so one axis never moves when the other toggles.
          var previousRight = 0;
          OVERLAY_PALETTE.forEach(function (color, slot) {
            var metricKey = Object.keys(active).filter(function (key) { return active[key] === color; })[0];
            if (!metricKey) return;
            var axisX = Math.max(payload.plotRight + (8 + slot * OVERLAY_AXIS_COLUMN_PX) / xScale, previousRight + 6 / xScale);
            var axis = drawOverlay(metricKey, color, axisX);
            var box = axis && axis.getBBox ? axis.getBBox() : null;
            previousRight = box && box.width > 0 ? box.x + box.width : axisX;
          });
        }
        instance.redrawOverlays = redrawActiveOverlayAxes;

        function removeOverlay(metricKey) {
          var el = instance.overlayGroup && instance.overlayGroup.querySelector('#' + overlayLineId(metricKey));
          if (el) el.parentNode.removeChild(el);
          var axis = instance.overlayYAxisGroup && instance.overlayYAxisGroup.querySelector('#' + overlayAxisId(metricKey));
          if (axis) axis.parentNode.removeChild(axis);
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
              if (active[metricKey]) return;
              if (Object.keys(active).length >= 2) {
                checkbox.checked = false;
                return;
              }
              var usedColors = Object.keys(active).map(function (key) { return active[key]; });
              var color = OVERLAY_PALETTE.filter(function (c) { return usedColors.indexOf(c) === -1; })[0] || OVERLAY_PALETTE[0];
              active[metricKey] = color;
              redrawActiveOverlayAxes();
              checkbox.parentElement.style.color = color;
            } else {
              delete active[metricKey];
              removeOverlay(metricKey);
              redrawActiveOverlayAxes();
              checkbox.parentElement.style.color = '';
            }
          });
        });
      }

      function initChart(svgId) {
        var payload = payloads[svgId];
        var svg = document.getElementById(svgId);
        if (!payload || !svg) return;

        var basePlotLeft = payload.plotLeft;
        var basePlotRight = payload.plotRight;
        var basePlotTop = payload.plotTop;
        var basePlotBottom = payload.plotBottom;
        var dataXs = payload.points.map(function (p) { return p[0]; });
        var line = svg.querySelector('.crosshair');
        var dot = svg.querySelector('.crosshairDot');
        var label = svg.querySelector('.crosshairLabel');
        var labelX = label && label.querySelector('.crosshairLabelX');
        var labelY = label && label.querySelector('.crosshairLabelY');
        var capture = svg.querySelector('.crosshairCapture');
        var instance = { payload: payload, pxXs: [], dataXs: dataXs,
          overlayGroup: svg.querySelector('.overlayGroup'), overlayYAxisGroup: svg.querySelector('.overlayYAxisGroup') };
        instances[svgId] = instance;

        // Gutters are in CSS px so labels fit at any panel width.
        function applyLayout(rect) {
          if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
          instance.lastRect = rect;
          var xScale = rect.width / payload.width;
          var yScale = rect.height / payload.height;
          var plotLeft = LEFT_GUTTER_PX / xScale;
          var rightGutterPx = payload.overlays ? OVERLAY_GUTTER_PX : PLAIN_RIGHT_GUTTER_PX;
          var plotRight = Math.max(plotLeft + 60 / xScale, payload.width - rightGutterPx / xScale);
          var plotTop = TOP_GUTTER_PX / yScale;
          var plotBottom = Math.max(plotTop + 40 / yScale, payload.height - BOTTOM_GUTTER_PX / yScale);
          payload.plotLeft = plotLeft;
          payload.plotRight = plotRight;
          payload.plotTop = plotTop;
          payload.plotBottom = plotBottom;
          instance.segmentBandTop = plotBottom - 9 * ((plotBottom - plotTop) / (basePlotBottom - basePlotTop));
          var layerScaleX = (plotRight - plotLeft) / (basePlotRight - basePlotLeft);
          var layerScaleY = (plotBottom - plotTop) / (basePlotBottom - basePlotTop);
          svg.querySelectorAll('.chartDataLayer').forEach(function (layer) {
            layer.setAttribute('transform', 'translate(' + (plotLeft - basePlotLeft * layerScaleX).toFixed(4) + ' ' + (plotTop - basePlotTop * layerScaleY).toFixed(4)
              + ') scale(' + layerScaleX.toFixed(4) + ' ' + layerScaleY.toFixed(4) + ')');
          });
          var axisLineX = svg.querySelector('.axisLineX');
          if (axisLineX) {
            axisLineX.setAttribute('x1', plotLeft.toFixed(1));
            axisLineX.setAttribute('x2', plotRight.toFixed(1));
            axisLineX.setAttribute('y1', plotBottom.toFixed(1));
            axisLineX.setAttribute('y2', plotBottom.toFixed(1));
          }
          var axisLineY = svg.querySelector('.axisLineY');
          if (axisLineY) {
            axisLineY.setAttribute('x1', plotLeft.toFixed(1));
            axisLineY.setAttribute('x2', plotLeft.toFixed(1));
            axisLineY.setAttribute('y1', plotTop.toFixed(1));
            axisLineY.setAttribute('y2', plotBottom.toFixed(1));
          }
          var axisLabelX = svg.querySelector('.axisLabelX');
          if (axisLabelX) {
            axisLabelX.setAttribute('x', ((plotLeft + plotRight) / 2).toFixed(1));
            axisLabelX.setAttribute('y', (payload.height - 6 / yScale).toFixed(1));
          }
          if (capture) {
            capture.setAttribute('x', plotLeft.toFixed(1));
            capture.setAttribute('y', plotTop.toFixed(1));
            capture.setAttribute('width', (plotRight - plotLeft).toFixed(1));
            capture.setAttribute('height', (plotBottom - plotTop).toFixed(1));
          }
          if (line) {
            line.setAttribute('y1', plotTop.toFixed(1));
            line.setAttribute('y2', plotBottom.toFixed(1));
          }
          if (labelX && labelY) {
            var labelTop = plotTop + 14 / yScale;
            labelX.setAttribute('y', labelTop.toFixed(1));
            labelY.setAttribute('y', (labelTop + 14).toFixed(1));
          }
          instance.pxXs = payload.points.map(function (p) { return scaleX(payload, p[0]); });
          var plotWidthPx = (plotRight - plotLeft) * xScale;
          var plotHeightPx = (payload.plotBottom - payload.plotTop) * yScale;
          var yTickCount = fitYTickCount(payload, plotHeightPx);
          redrawTicks(svg, payload, clampCount(plotWidthPx / 72, 4, 18), yTickCount, xScale, yScale);
          if (instance.redrawOverlays) instance.redrawOverlays();
          updateChartTextScale(svg, payload, rect);
        }

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
          if (instance.lastRect) {
            dot.setAttribute('transform', 'translate(' + px + ' ' + py + ') scale('
              + (payload.width / instance.lastRect.width).toFixed(4) + ' ' + (payload.height / instance.lastRect.height).toFixed(4) + ') translate(' + (-px) + ' ' + (-py) + ')');
          }
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
            label.querySelectorAll('.crosshairOverlayValue').forEach(function (element) { element.remove(); });
            Object.keys(instance.activeOverlays || {}).forEach(function (metricKey) {
              var series = payload.overlays && payload.overlays[metricKey];
              var overlayPoint = series && series.points[index];
              if (!series || !overlayPoint || !Number.isFinite(overlayPoint[1])) return;
              var overlayLabel = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
              overlayLabel.setAttribute('class', 'crosshairOverlayValue');
              overlayLabel.setAttribute('x', anchorX);
              overlayLabel.setAttribute('dy', '14');
              overlayLabel.style.fill = instance.activeOverlays[metricKey];
              overlayLabel.textContent = series.label + ': ' + formatCrosshairValue(overlayPoint[1], series.unit);
              label.appendChild(overlayLabel);
            });
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
          if (!segmentTooltip || local.y < instance.segmentBandTop) return;
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
            var hoveredIdx = nearestIndex(instance.pxXs, local.x);
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
            applyLayout(rect);
          });
          observer.observe(svg);
        }

        initOverlayControls(svgId, payload, instance, svg);
        applyLayout(svg.getBoundingClientRect());
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
      /* Form controls need a clearer edge than --border, especially on dark themes where a
         20% border disappears against the input background. Prefer the theme's own input
         border token and fall back to a stronger foreground mix. */
      --input-border: var(--vscode-input-border, color-mix(in srgb, var(--vscode-input-foreground) 40%, transparent));
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
    .tick { fill:var(--muted); font-size:13px; }
    .axisLabel { fill:var(--ink); font-size:14px; font-weight:bold; letter-spacing:0.03em; text-transform:uppercase; }
    .routeStart { fill:var(--vscode-testing-iconPassed); } .routeEnd { fill:var(--vscode-testing-iconFailed); }
    .kmMarker { stroke:color-mix(in srgb,var(--ink) 30%,transparent); stroke-width:1; stroke-dasharray:2 5; vector-effect:non-scaling-stroke; }
    .overlayYAxis { color:var(--muted); }
    .overlayAxisLine, .overlayAxisTick { stroke:currentColor; stroke-width:1; vector-effect:non-scaling-stroke; }
    .overlayTick { fill:currentColor; font-size:13px; }
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
    .mapControls select { border:1px solid var(--input-border); border-radius:6px; padding:4px 8px; background:var(--input-bg); color:var(--input-fg); font-size:0.9rem; }
    #fitMap, #fitMapComp { height:var(--map-height,clamp(320px,52vh,760px)); border:1px solid var(--border); border-radius:10px; overflow:hidden; background:color-mix(in srgb,var(--card) 65%,var(--bg)); }
    .mapHint { color:var(--muted); font-size:0.85rem; }
    .mapZoomHint { position:absolute; inset:0; z-index:1200; display:flex; align-items:center; justify-content:center; pointer-events:none; opacity:0; transition:opacity 140ms ease; background:color-mix(in srgb,var(--bg) 55%,transparent); color:var(--ink); font-size:1.05rem; font-weight:700; letter-spacing:0.03em; }
    .mapZoomHint.visible { opacity:1; }
    .chip { border:1px solid var(--border); border-radius:10px; padding:2px 9px; font-size:0.78rem; color:var(--muted); cursor:help; }
    .chipWarn { border-color:var(--vscode-editorWarning-foreground, #cca700); color:var(--vscode-editorWarning-foreground, #cca700); }
    .chipInfo { }
    .manualDataForm { display:flex; align-items:end; gap:12px; flex-wrap:wrap; }
    .manualDataForm label { display:grid; gap:4px; color:var(--muted); font-size:0.82rem; }
    .manualDataForm input { width:150px; border:1px solid var(--input-border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); }
    .manualDataForm textarea { border:1px solid var(--input-border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); font:inherit; resize:vertical; }
    .manualDataForm select { width:150px; border:1px solid var(--input-border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); }
    /* A single consistent focus treatment for every editable control: the accent edge is the
       one cue that stays legible on both light and dark themes. */
    input:not([type=checkbox]):focus, input[type=checkbox]:focus, textarea:focus, select:focus {
      border-color: var(--accent);
      outline: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
      outline-offset: 0;
    }
    input:not([type=checkbox]):hover, textarea:hover, select:hover {
      border-color: color-mix(in srgb, var(--input-border) 55%, var(--accent));
    }
    input[type=checkbox] { accent-color: var(--accent); }
    .manualDataForm button { border:0; border-radius:6px; padding:7px 14px; background:var(--accent); color:var(--bg); font-weight:700; cursor:pointer; }
    .manualDataStatus { color:var(--muted); font-size:0.82rem; align-self:center; }
    .manualDataStatus.error { color:var(--vscode-errorForeground); }
    .calibrationHint { margin-top:10px; padding:8px 10px; border-left:4px solid var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); font-size:0.85rem; line-height:1.5; }
    .calibrationHint button { margin-left:8px; border:1px solid var(--border); border-radius:4px; padding:3px 8px; background:var(--input-bg); color:var(--input-fg); cursor:pointer; font-size:0.8rem; }
  `;
}

function renderSessionChips(fitData, ui) {
  const sessionClass = fitData?.sessionClass;
  const flags = Array.isArray(fitData?.qualityFlags) ? fitData.qualityFlags : [];
  if (!sessionClass?.label && !flags.length) return '';
  const classTitle = sessionClass ? [
    `class: ${sessionClass.label} (${sessionClass.confidence || '?'})`,
    sessionClass.reasons?.length ? `evidence: ${sessionClass.reasons.join('; ')}` : null,
    sessionClass.alternatives?.length ? `alternatives: ${sessionClass.alternatives.join(', ')}` : null,
  ].filter(Boolean).join('\n') : null;
  const parts = [];
  if (sessionClass?.label) {
    parts.push(`<span class="chip" title="${escapeHtml(classTitle)}">${escapeHtml(ui.sessionClassLabel)}: ${escapeHtml(String(sessionClass.label))}${sessionClass.confidence === 'low' ? ' ⚠' : ''}</span>`);
  }
  for (const flag of flags) {
    parts.push(`<span class="chip ${flag.severity === 'warn' ? 'chipWarn' : 'chipInfo'}" title="${escapeHtml(`${flag.code}: ${flag.text || flag.detail || ''}`)}">${escapeHtml(flag.code)}</span>`);
  }
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 16px 0;align-items:center;">${parts.join('')}</div>`;
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


function renderStatsRow(stats, unit, isComp, ui) {
  if (!stats || !stats.count) {
    return '';
  }
  const style = isComp ? ' style="opacity:0.72"' : '';
  const prefix = isComp ? 'comp · ' : '';
  const formatStatNumber = (value) => formatLocalizedNumber(value, ui);
  return `<div class="statRow"${style}>
    ${statChip(prefix + ui.samples, stats.count)}
    ${statChip(prefix + ui.min, `${formatStatNumber(stats.min)} ${unit}`)}
    ${statChip(prefix + ui.avg, `${formatStatNumber(stats.avg)} ${unit}`)}
    ${statChip(prefix + ui.median, `${formatStatNumber(stats.median)} ${unit}`)}
    ${statChip(prefix + ui.p95, `${formatStatNumber(stats.p95)} ${unit}`)}
    ${statChip(prefix + ui.max, `${formatStatNumber(stats.max)} ${unit}`)}
  </div>`;
}

function renderComparisonTable(a, b, aName, bName, glossary, ui) {
  const rows = [
    [ui.distanceKm, a.distanceKm.toFixed(2), b.distanceKm.toFixed(2), 'distance'],
    [ui.duration, a.durationText, b.durationText, 'duration'],
    [ui.avgSpeedKmh, a.avgSpeed.toFixed(2), b.avgSpeed.toFixed(2), 'averageSpeed'],
    [ui.maxSpeedKmh, a.maxSpeed.toFixed(2), b.maxSpeed.toFixed(2), 'maximumSpeed'],
    [ui.avgPowerW, a.avgPower.toFixed(0), b.avgPower.toFixed(0), 'averagePower'],
    [ui.maxPowerW, a.maxPower.toFixed(0), b.maxPower.toFixed(0), 'maximumPower'],
    [ui.normalizedPowerW, a.normalizedPower?.toFixed(0) ?? 'n/a', b.normalizedPower?.toFixed(0) ?? 'n/a', 'normalizedPower'],
    [ui.intensityFactorIf, a.intensityFactor > 0 ? a.intensityFactor.toFixed(2) : 'n/a', b.intensityFactor > 0 ? b.intensityFactor.toFixed(2) : 'n/a', 'intensityFactor'],
    [ui.tssScore, a.trainingStressScore > 0 ? a.trainingStressScore.toFixed(1) : 'n/a', b.trainingStressScore > 0 ? b.trainingStressScore.toFixed(1) : 'n/a', 'trainingStressScore'],
    [ui.xPowerGcW, a.xPower > 0 ? a.xPower.toFixed(0) : 'n/a', b.xPower > 0 ? b.xPower.toFixed(0) : 'n/a', 'xpower'],
    [ui.riGc, a.relativeIntensityGc > 0 ? a.relativeIntensityGc.toFixed(2) : 'n/a', b.relativeIntensityGc > 0 ? b.relativeIntensityGc.toFixed(2) : 'n/a', 'relativeIntensity'],
    [ui.bikeStressGc, a.bikeStressScore > 0 ? a.bikeStressScore.toFixed(1) : 'n/a', b.bikeStressScore > 0 ? b.bikeStressScore.toFixed(1) : 'n/a', 'bikeStress'],
    [ui.decouplingIntervals, Number.isFinite(a.decouplingPct) ? `${a.decouplingPct.toFixed(1)}%` : 'n/a', Number.isFinite(b.decouplingPct) ? `${b.decouplingPct.toFixed(1)}%` : 'n/a', 'decoupling'],
    [ui.trimp, Number.isFinite(a.trimp) ? a.trimp.toFixed(1) : 'n/a', Number.isFinite(b.trimp) ? b.trimp.toFixed(1) : 'n/a', 'trimp'],
    [ui.hrTss, a.hrTss > 0 ? a.hrTss.toFixed(1) : 'n/a', b.hrTss > 0 ? b.hrTss.toFixed(1) : 'n/a', 'hrTss'],
    [ui.avgHrBpm, a.avgHr.toFixed(0), b.avgHr.toFixed(0), 'averageHeartRate'],
    [ui.maxHrBpm, a.maxHr.toFixed(0), b.maxHr.toFixed(0), 'maximumHeartRate'],
    [ui.elevationGainM, a.elevationGainM.toFixed(0), b.elevationGainM.toFixed(0), 'elevationGain'],
    [ui.elevationLossM, a.elevationLossM.toFixed(0), b.elevationLossM.toFixed(0), 'elevationLoss'],
  ].map(([label, va, vb, term]) => `<tr><td class="cmpLabel">${renderTerm(label, term, glossary)}</td><td class="cmpA">${escapeHtml(va)}</td><td class="cmpB">${escapeHtml(vb)}</td></tr>`).join('');
  return `<section class="chart"><h2>${escapeHtml(ui.comparison)}</h2><table class="cmpTable">
    <thead><tr><th></th><th>${escapeHtml(aName || ui.activity)}</th><th>${escapeHtml(bName || ui.comparison)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></section>`;
}

function renderMapStats(route, ui) {
  if (!route || !route.pointCount) {
    return `<div class="muted">${escapeHtml(ui.noGpsStatsAvailable)}</div>`;
  }

  const speed = route.speedStats || {};
  const hr = route.hrStats || {};

  return `<div class="statRow">
    ${statChip(ui.gpsPointsLabel, route.pointCount)}
    ${statChip(ui.distance, `${formatLocalizedNumber(route.routeDistanceKm, ui)} km`)}
    ${statChip(`${ui.avg} ${ui.speed}`, speed.count ? `${formatLocalizedNumber(speed.avg, ui)} ${ui.kilometersPerHour}` : 'n/a')}
    ${statChip(`${ui.max} ${ui.speed}`, speed.count ? `${formatLocalizedNumber(speed.max, ui)} ${ui.kilometersPerHour}` : 'n/a')}
    ${statChip(`${ui.avg} ${ui.heartRate}`, hr.count ? `${formatLocalizedNumber(hr.avg, ui)} ${ui.beatsPerMinute}` : 'n/a')}
    ${statChip(`${ui.max} ${ui.heartRate}`, hr.count ? `${formatLocalizedNumber(hr.max, ui)} ${ui.beatsPerMinute}` : 'n/a')}
  </div>`;
}

function formatLocalizedNumber(value, ui) {
  return formatNumber(value).replace('.', ui.decimalSeparator);
}

function statChip(label, value) {
  return `<div class="stat"><div class="statK">${escapeHtml(String(label))}</div><div class="statV">${escapeHtml(String(value))}</div></div>`;
}

function renderHeartRateZones(zoneData, ui) {
  if (!zoneData.enabled) {
    return `<div class="zones"><div class="zonesHead">${escapeHtml(ui.heartRateZonesDisabled)}</div></div>`;
  }

  const zoneLabels = {
    Recovery: ui.recovery,
    Endurance: ui.endurance,
    Tempo: ui.aerobic,
    Threshold: ui.anaerobic,
    VO2max: ui.maxZone,
  };
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
      <div class="zoneLabel">${escapeHtml(zoneLabels[z.name] || z.name)}</div>
      <div class="zoneBar"><div class="zoneFill" style="width:${fill.toFixed(1)}%; background:${color};"></div></div>
      <div class="zoneMeta">${escapeHtml(z.range.replace('bpm', ui.beatsPerMinute))} | ${escapeHtml(formatHms(z.seconds))} (${escapeHtml(formatLocalizedNumber(z.percent, ui))}%)</div>
    </div>`;
  }).join('');

  return `<div class="zones">
    <div class="zonesHead">${escapeHtml(formatUi(zoneData.customThresholds ? ui.heartRateZonesCustomInfo : ui.heartRateZonesInfo, zoneData.maxHeartRate).replace('bpm', ui.beatsPerMinute))}</div>
    ${rows}
  </div>`;
}

module.exports = { displayLanguage, renderActivityBrowserHtml, renderActivityContentHtml, renderMarkdown, buildTranslationPrompt };
