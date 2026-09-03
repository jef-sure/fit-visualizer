function createChartSvgRenderer({ buildDistanceMarkers, escapeHtml, formatTick, getHrZoneIndex }) {
  function renderOverlayControls(svgId, overlays) {
    const keys = Object.keys(overlays || {});
    if (!keys.length) return '';
    return `<div class="overlayControls" data-overlay-for="${escapeHtml(svgId)}">${keys.map((key) => `<label>
      <input type="checkbox" data-overlay-metric="${escapeHtml(key)}">
      ${escapeHtml(overlays[key].label)}<span class="overlayRange"></span>
    </label>`).join('')}</div>`;
  }

  function buildZoneSegmentPolylines(chart, thresholds) {
    const segments = [[], [], [], [], []];
    for (let index = 1; index < chart.pathPoints.length; index += 1) {
      const previous = chart.pathPoints[index - 1];
      const current = chart.pathPoints[index];
      const y0 = chart.points[index - 1]?.y;
      const y1 = chart.points[index]?.y;
      if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
      segments[getHrZoneIndex((y0 + y1) / 2, thresholds)].push({ x1: previous.x, y1: previous.y, x2: current.x, y2: current.y });
    }
    return segments.map((zone, index) => zone.map((segment) =>
      `<line class="zoneLine zoneLine${index + 1}" x1="${segment.x1.toFixed(1)}" y1="${segment.y1.toFixed(1)}" x2="${segment.x2.toFixed(1)}" y2="${segment.y2.toFixed(1)}" />`
    ).join('')).join('');
  }

  function renderScaledLineChartSvg(chart, lineClass, xLabel, yLabel, addDistanceMarkers, options = {}) {
    if (!chart || chart.points.length < 2) {
      return '<div class="muted">Not enough data for this chart.</div>';
    }

    const svgIdAttr = options.svgId ? ` id="${escapeHtml(options.svgId)}"` : '';
    const segmentBands = (Array.isArray(options.segmentBands) ? options.segmentBands : []).map((segment) => {
      const start = Number(segment.startDistanceKm);
      const end = Number(segment.endDistanceKm);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
      const range = (chart.xMax - chart.xMin) || 1;
      const scaleX = (value) => chart.plotLeft + ((value - chart.xMin) / range) * (chart.plotRight - chart.plotLeft);
      const x1 = Math.max(chart.plotLeft, Math.min(chart.plotRight, scaleX(start)));
      const x2 = Math.max(chart.plotLeft, Math.min(chart.plotRight, scaleX(end)));
      if (x2 <= x1) return '';
      const type = segment.technical ? 'technical' : segment.type;
      const bandClass = { climb: 'Climb', descent: 'Descent', flat: 'Flat', stopped: 'Stopped', technical: 'Technical' }[type];
      const segmentIndex = Number.isInteger(segment.index) ? ` data-segment-index="${segment.index}"` : '';
      const color = typeof segment.displayColor === 'string' ? ` style="fill:${escapeHtml(segment.displayColor)}"` : '';
      return bandClass ? `<rect class="segmentBand segmentBand${bandClass}"${segmentIndex}${color} x="${x1.toFixed(1)}" y="${chart.plotBottom - 9}" width="${(x2 - x1).toFixed(1)}" height="9" />` : '';
    }).join('');
    const kmMarkers = addDistanceMarkers ? buildDistanceMarkers(chart, 1) : [];
    const markerSvg = kmMarkers.map((marker) => `<g>
      <line class="kmMarker" x1="${marker.px.toFixed(1)}" y1="${chart.plotTop}" x2="${marker.px.toFixed(1)}" y2="${chart.plotBottom}" />
    </g>`).join('');

    const xTicks = `<g class="xTicksGroup">${chart.xTicks.map((tick) => `<g>
      <line class="gridline" x1="${tick.px.toFixed(1)}" y1="${chart.plotTop}" x2="${tick.px.toFixed(1)}" y2="${chart.plotBottom}" />
      <text class="tick" x="${tick.px.toFixed(1)}" y="${chart.plotBottom + 16}" text-anchor="middle">${escapeHtml(formatTick(tick.value, chart.xStep))}</text>
    </g>`).join('')}</g>`;
    const yTicks = `<g class="yTicksGroup">${chart.yTicks.map((tick) => `<g>
      <line class="gridline" x1="${chart.plotLeft}" y1="${tick.py.toFixed(1)}" x2="${chart.plotRight}" y2="${tick.py.toFixed(1)}" />
      <text class="tick" x="${chart.plotLeft - 8}" y="${(tick.py + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatTick(tick.value, chart.yStep))}</text>
    </g>`).join('')}</g>`;
    const zoneThresholds = Array.isArray(options.zoneThresholds) ? options.zoneThresholds : null;
    const lineSvg = zoneThresholds && zoneThresholds.length >= 4
      ? buildZoneSegmentPolylines(chart, zoneThresholds)
      : `<polyline class="${lineClass}" points="${chart.pathData}" />`;
    const compLineSvg = chart.compPathData ? `<polyline class="${lineClass}Comp" points="${chart.compPathData}" />` : '';
    const crosshairSvg = options.svgId ? `
    <g class="overlayGroup"></g>
    <line class="crosshair" x1="0" y1="${chart.plotTop}" x2="0" y2="${chart.plotBottom}" style="display:none" />
    <circle class="crosshairDot" r="4" style="display:none" />
    <text class="crosshairLabel" style="display:none">
      <tspan class="crosshairLabelX" x="0" y="${chart.plotTop + 14}"></tspan>
      <tspan class="crosshairLabelY" x="0" y="${chart.plotTop + 28}"></tspan>
    </text>
    <rect class="crosshairCapture" x="${chart.plotLeft}" y="${chart.plotTop}" width="${chart.plotRight - chart.plotLeft}" height="${chart.plotBottom - chart.plotTop}" fill="transparent" />` : '';

    return `<svg${svgIdAttr} viewBox="0 0 ${chart.width} ${chart.height}" preserveAspectRatio="none" role="img" aria-label="line chart">
    <g class="segmentBandGroup">${segmentBands}</g>
    ${markerSvg}
    ${xTicks}
    ${yTicks}
    <g class="overlayYAxisGroup"></g>
    <line class="axis" x1="${chart.plotLeft}" y1="${chart.plotBottom}" x2="${chart.plotRight}" y2="${chart.plotBottom}" />
    <line class="axis" x1="${chart.plotLeft}" y1="${chart.plotTop}" x2="${chart.plotLeft}" y2="${chart.plotBottom}" />
    ${compLineSvg}
    ${lineSvg}
    <text class="axisLabel axisLabelX" x="${(chart.plotLeft + chart.plotRight) / 2}" y="${chart.height - 4}" text-anchor="middle">${escapeHtml(xLabel)}</text>
    <text class="axisLabel axisLabelY" transform="translate(14 ${(chart.plotTop + chart.plotBottom) / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(yLabel)}</text>
    ${crosshairSvg}
  </svg>`;
  }

  function renderGpsRouteSvg(route, width, height) {
    if (!route || route.points.length < 2) {
      return '<div class="muted">No usable GPS points found in this FIT file.</div>';
    }

    const xTicks = route.xTicks.map((tick) => `<g>
      <line class="gridline" x1="${tick.px.toFixed(1)}" y1="${route.plotTop}" x2="${tick.px.toFixed(1)}" y2="${route.plotBottom}" />
      <text class="tick" x="${tick.px.toFixed(1)}" y="${route.plotBottom + 16}" text-anchor="middle">${escapeHtml(formatTick(tick.value, route.xStep))}</text>
    </g>`).join('');
    const yTicks = route.yTicks.map((tick) => `<g>
      <line class="gridline" x1="${route.plotLeft}" y1="${tick.py.toFixed(1)}" x2="${route.plotRight}" y2="${tick.py.toFixed(1)}" />
      <text class="tick" x="${route.plotLeft - 8}" y="${(tick.py + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatTick(tick.value, route.yStep))}</text>
    </g>`).join('');
    const start = route.pathPoints[0];
    const end = route.pathPoints[route.pathPoints.length - 1];

    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="gps route">
    ${xTicks}
    ${yTicks}
    <line class="axis" x1="${route.plotLeft}" y1="${route.plotBottom}" x2="${route.plotRight}" y2="${route.plotBottom}" />
    <line class="axis" x1="${route.plotLeft}" y1="${route.plotTop}" x2="${route.plotLeft}" y2="${route.plotBottom}" />
    <polyline class="lineD" points="${route.pathData}" />
    <circle class="routeStart" cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="4" />
    <circle class="routeEnd" cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="4" />
    <text class="axisLabel" x="${(route.plotLeft + route.plotRight) / 2}" y="${height - 4}" text-anchor="middle">Longitude</text>
    <text class="axisLabel" transform="translate(14 ${(route.plotTop + route.plotBottom) / 2}) rotate(-90)" text-anchor="middle">Latitude</text>
  </svg>`;
  }

  return { buildZoneSegmentPolylines, renderGpsRouteSvg, renderOverlayControls, renderScaledLineChartSvg };
}

module.exports = { createChartSvgRenderer };