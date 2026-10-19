// What has to happen to a database after the extension is updated, decided here so that nobody has
// to read upgrade notes: a ride read by an earlier version is re-read from its file when a page or
// a prompt needs it, and saved analyses of an earlier format are offered for an update. Pure
// helpers over a sql.js database; no vscode.

// Bump when a release changes what is read from a FIT file into the activity and record rows
// (a new field, a corrected unit or factor). Each row carries the version that read it, so a ride
// is re-read on its own when it is next needed, and nothing is re-read in bulk. Derived data has
// its own FEATURES_VERSION.
const INDEX_VERSION = 1;

const { PROMPT_HISTORY_DAYS, RECENT_HISTORY_RIDES } = require('./training-context');

// A ride read by an earlier version, or before rows carried a version at all. A manual activity
// has no file to read.
function needsReread(row) {
  return !!row && row.source !== 'manual' && Number(row.index_version) !== INDEX_VERSION;
}

// Before 0.30.1 was released the version was one stamp for the whole database. A database that
// carries it was read in full under that version: its rows take the value over, and the stamp goes.
function migrateIndexVersionStamp(db) {
  const value = db.exec("SELECT value FROM derived_state WHERE key = 'index_version'")[0]?.values?.[0]?.[0];
  if (value == null) return;
  db.run('UPDATE activities SET index_version = ? WHERE index_version IS NULL', [Number(value)]);
  db.run("DELETE FROM derived_state WHERE key = 'index_version'");
}

// Only analyses that exist and were written by an earlier format: a ride that was never analysed
// is not something an update made stale, and nobody asked to spend a request on it. And only as deep
// as a prompt reads: a saved analysis reaches the AI as the history of a later ride, and the next
// ride reads the latest RECENT_HISTORY_RIDES of its sport within PROMPT_HISTORY_DAYS before it. The next
// ride is today at the earliest, so a ride older than that window is read by no prompt to come: after
// a long break (an injury, an operation, a winter) nothing may be left to offer. An outdated analysis
// further back keeps its mark and is updated from its page or by the command. The offer of 0.30.1 took
// every outdated analysis in the database, oldest first.
// rows: every activity in chronological order, with startTime, sport, source and analysisVersion.
function outdatedAnalysesInHistory(rows, currentVersion, { now = Date.now(), perSport = RECENT_HISTORY_RIDES, days = PROMPT_HISTORY_DAYS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const since = now - days * 86400000;
  const latest = new Set();
  const bySport = new Map();
  for (const row of list) {
    if (!(Date.parse(row?.startTime) >= since)) continue;
    const sport = String(row?.sport || '');
    if (!bySport.has(sport)) bySport.set(sport, []);
    bySport.get(sport).push(row);
  }
  for (const rides of bySport.values()) rides.slice(-perSport).forEach((row) => latest.add(row));
  // A manual activity's analysis is not part of the history a prompt reads.
  return list.filter((row) => latest.has(row) && row.source !== 'manual'
    && Number.isFinite(row.analysisVersion) && row.analysisVersion < currentVersion);
}

// Asked once per analysis format and database; the mark on the page and the command remain.
function shouldOfferReanalysis(offeredVersion, currentVersion, outdatedCount) {
  return outdatedCount > 0 && Number(offeredVersion) !== Number(currentVersion);
}

module.exports = {
  INDEX_VERSION,
  migrateIndexVersionStamp,
  needsReread,
  outdatedAnalysesInHistory,
  shouldOfferReanalysis,
};
