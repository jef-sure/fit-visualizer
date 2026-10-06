// What has to happen to a database after the extension is updated, decided here so that nobody has
// to read upgrade notes: stored activity rows are re-read from their files when the reading itself
// changed, and saved analyses of an earlier format are offered for an update. Pure helpers over a
// sql.js database; no vscode.

// Bump when a release changes what is read from a FIT file into the activity and record rows
// (a new field, a corrected unit or factor). Derived data has its own FEATURES_VERSION.
const INDEX_VERSION = 1;

function readIndexVersion(db) {
  try {
    const value = db.exec("SELECT value FROM derived_state WHERE key = 'index_version'")[0]?.values?.[0]?.[0];
    return value == null ? null : Number(value);
  } catch {
    return null;
  }
}

function markIndexVersion(db) {
  db.run("INSERT INTO derived_state (key, value) VALUES ('index_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(INDEX_VERSION)]);
}

function indexedActivityCount(db) {
  return Number(db.exec("SELECT COUNT(*) FROM activities WHERE source != 'manual'")[0]?.values?.[0]?.[0] || 0);
}

// A database with no indexed file has nothing read by an earlier version: whatever is indexed
// into it from now on is read by this one.
function stampFreshDatabase(db) {
  if (readIndexVersion(db) == null && indexedActivityCount(db) === 0) markIndexVersion(db);
}

function needsReindex(db) {
  return indexedActivityCount(db) > 0 && readIndexVersion(db) !== INDEX_VERSION;
}

function indexedFilePaths(db) {
  return (db.exec("SELECT file_path FROM activities WHERE source != 'manual' ORDER BY datetime(start_time), id")[0]?.values || [])
    .map((row) => String(row[0] || '')).filter(Boolean);
}

// Only analyses that exist and were written by an earlier format: a ride that was never analysed
// is not something an update made stale, and nobody asked to spend a request on it.
function outdatedSavedAnalyses(rows, currentVersion) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => Number.isFinite(row?.analysisVersion) && row.analysisVersion < currentVersion);
}

// Asked once per analysis format and database; the mark on the page and the command remain.
function shouldOfferReanalysis(offeredVersion, currentVersion, outdatedCount) {
  return outdatedCount > 0 && Number(offeredVersion) !== Number(currentVersion);
}

module.exports = {
  INDEX_VERSION,
  indexedFilePaths,
  markIndexVersion,
  needsReindex,
  outdatedSavedAnalyses,
  readIndexVersion,
  shouldOfferReanalysis,
  stampFreshDatabase,
};
