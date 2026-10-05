'use strict';

// One spelling per file, so the same FIT file is recognised however it was reached: through a
// symlinked folder, with another drive-letter case on Windows, or as a relative path. Pure apart
// from the optional realpath lookup; a file that no longer exists keeps its resolved path.

const fs = require('node:fs');
const path = require('node:path');

function normalizeFilePath(filePath, { platform = process.platform, realpath = fs.realpathSync.native || fs.realpathSync } = {}) {
  if (filePath == null || filePath === '') return '';
  const pathApi = platform === 'win32' ? path.win32 : path;
  let resolved = pathApi.resolve(String(filePath));
  try {
    resolved = realpath(resolved);
  } catch {
    // Not on disk (moved, deleted, another machine): the resolved spelling is all there is.
  }
  // Windows paths differ only by case; the file system does not tell them apart.
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Where a FIT file opened by hand may be saved. A file whose folder has a database belongs
// there. Otherwise, while no database exists anywhere, its folder becomes the first one. But once
// the rider has a database elsewhere, a stray file - a download, a friend's ride - must not start
// a new database beside itself and take over as "the last one used": the caller asks.
function openedFitDatabaseRule({ ownDbPath, ownDbExists, lastDbPath, lastDbExists }) {
  if (ownDbExists) return 'own';
  if (!lastDbPath || !lastDbExists) return 'own';
  if (normalizeFilePath(lastDbPath) === normalizeFilePath(ownDbPath)) return 'own';
  return 'ask';
}

module.exports = { normalizeFilePath, openedFitDatabaseRule };
