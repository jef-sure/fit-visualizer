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

  return { buildZoneSegmentPolylines, renderOverlayControls };
}

module.exports = { createChartSvgRenderer };