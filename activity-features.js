// Derived-feature cache: segments, zones, peaks, session class and load metrics per activity,
// keyed by the inputs they were computed from so stale rows recompute lazily.
// Pure key/row helpers live here; the vscode-bound compute pipeline stays in extension.js.

const FEATURES_VERSION = 8;

const { createHash } = require('node:crypto');

function settingsKey(options) {
  const payload = {
    segmentation: options?.segmentation ?? null,
    powerModel: options?.powerModel ?? null,
  };
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function hrProfileKey(hrConfig) {
  if (!hrConfig || !Number.isFinite(Number(hrConfig.maxHeartRate))) return 'none';
  return [
    hrConfig.effectiveDate || 'legacy',
    hrConfig.maxHeartRate,
    ...(Array.isArray(hrConfig.thresholds) ? hrConfig.thresholds : []),
    hrConfig.lthr ?? '-',
  ].join('|');
}

function athleteKey(athleteProfile) {
  if (!athleteProfile) return 'none';
  return [
    athleteProfile.sex ?? '-',
    athleteProfile.restingHeartRate ?? '-',
    athleteProfile.ftp ?? '-',
    athleteProfile.riderMassKg ?? '-',
    athleteProfile.bikeMassKg ?? '-',
  ].join('|');
}

function featureCacheKey({ featuresVersion, settingsHash, hrProfile, athlete }) {
  return JSON.stringify([featuresVersion, settingsHash, hrProfileKey(hrProfile), athleteKey(athlete)]);
}

// A stored row is fresh when its whole key matches; any input change forces a lazy recompute.
function isFeatureRowFresh(row, key) {
  return row
    && row.feature_cache_key === key
    && Number(row.features_version) === FEATURES_VERSION;
}

module.exports = {
  FEATURES_VERSION,
  athleteKey,
  featureCacheKey,
  hrProfileKey,
  isFeatureRowFresh,
  settingsKey,
};
