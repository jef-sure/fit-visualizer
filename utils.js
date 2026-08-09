function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function createNonce() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return '0';
  }

  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1000) {
    return value.toFixed(0);
  }
  if (absoluteValue >= 100) {
    return value.toFixed(1);
  }
  if (absoluteValue >= 10) {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

function downsamplePoints(points, maxPoints) {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = points.length / maxPoints;
  const sampled = [];
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.floor(index * step)]);
  }
  return sampled;
}

function estimateDuration(records) {
  const elapsed = records
    .map((record) => asNumber(record.elapsed_time))
    .filter((value) => Number.isFinite(value));
  return elapsed.length ? Math.max(...elapsed) : 0;
}

function formatHms(value) {
  const total = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxOrZero(values) {
  return values.length ? Math.max(...values) : 0;
}

function asNumber(value) {
  if (value == null || value === '') {
    return Number.NaN;
  }
  return typeof value === 'number' ? value : Number(value);
}

function toSqlStr(value) {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = {
  asNumber,
  average,
  createNonce,
  downsamplePoints,
  escapeHtml,
  estimateDuration,
  formatHms,
  formatNumber,
  maxOrZero,
  roundTo,
  safeJson,
  toSqlStr,
};
