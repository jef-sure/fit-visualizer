const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateAnalysisPrompt, requestCopilotAnalysis } = require('./analysis');
const { registerCommands } = require('./commands');
const { ensureDatabaseSchema } = require('./database-schema');
const { fileExists, getFitUris, parseFitFile } = require('./fit-files');
const {
  calculateAutoHeartRateProfile,
  computeHeartRateZones,
  getHeartRateZoneIndex: getHrZoneIndex,
} = require('./heart-rate');
const {
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
} = require('./utils');

let extensionContextRef;
let sqlJsInitPromise = null;
const LAST_DB_PATH_KEY = 'fitVisualizer.lastDatabasePath';
const ANALYSIS_VERSION = 4;
const COMPARABLE_DISTANCE_MIN_RATIO = 0.75;
const COMPARABLE_DISTANCE_MAX_RATIO = 1.25;

function activate(context) {
  extensionContextRef = context;
  context.subscriptions.push(...registerCommands(context, {
    escapeHtml,
    getLocalDbPath,
    indexFitFolder,
    indexFitUris,
    openActivityBrowser,
    pickSingleFitFile,
    prepareFitForVisualization,
    rememberDatabasePath,
    resolveActiveDbPath,
    resolveFitUri,
    selectDatabaseFolder,
    showActivityBrowserInPanel,
  }));
}

async function indexFitFolder(onlyNew) {
  const baseDir = await pickIndexBaseDir();
  if (!baseDir) {
    return;
  }

  let fitUris = await getFitUris(baseDir, true);
  if (!fitUris.length) {
    vscode.window.showInformationMessage(`No FIT files found in ${baseDir}`);
    return;
  }

  const dbPath = await getLocalDbPath(baseDir);
  await rememberDatabasePath(dbPath);
  if (onlyNew) {
    const indexedPaths = await getIndexedFilePaths(dbPath);
    fitUris = fitUris.filter((uri) => !indexedPaths.has(path.resolve(uri.fsPath)));
    if (!fitUris.length) {
      vscode.window.showInformationMessage('FIT index is up to date. No new files found.');
      return;
    }
  }

  const result = await indexFitUris(
    fitUris,
    dbPath,
    `Indexing ${fitUris.length} ${onlyNew ? 'new ' : ''}FIT file(s)...`
  );
  vscode.window.showInformationMessage(`FIT DB index complete: ${result.saved} indexed, ${result.failed} failed.`);
}

async function pickIndexBaseDir() {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (workspaceRoot) {
    return workspaceRoot;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select FIT Folder',
    title: 'Select folder containing FIT files',
  });
  return picked?.[0]?.fsPath || null;
}

async function pickSingleFitFile() {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: 'Index FIT File',
    filters: { 'FIT Files': ['fit'] },
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0] || null;
}

async function indexFitUris(fitUris, dbPath, heading) {
  const output = vscode.window.createOutputChannel('FIT Visualizer: DB Index');
  output.clear();
  output.show(true);
  output.appendLine(heading);

  let saved = 0;
  let failed = 0;
  for (const fitUri of fitUris) {
    try {
      const parsed = await parseFitFile(fitUri.fsPath);
      await saveFitToLocalDb(fitUri.fsPath, parsed, dbPath);
      saved += 1;
      output.appendLine(`Indexed: ${fitUri.fsPath}`);
    } catch (error) {
      failed += 1;
      output.appendLine(`Failed: ${fitUri.fsPath} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { saved, failed };
}

async function resolveFitUri(resource) {
  if (resource && resource.fsPath && resource.fsPath.toLowerCase().endsWith('.fit')) {
    return resource;
  }

  const active = vscode.window.activeTextEditor?.document?.uri;
  if (active?.fsPath?.toLowerCase().endsWith('.fit')) {
    return active;
  }

  const pickedFromWorkspace = await pickFitFromWorkspace();
  if (pickedFromWorkspace) {
    return pickedFromWorkspace;
  }

  const pickedFromDialog = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: 'Visualize FIT File',
    filters: {
      'FIT Files': ['fit'],
    },
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  if (pickedFromDialog?.length) {
    return pickedFromDialog[0];
  }

  return null;
}

async function pickFitFromWorkspace() {
  const fitFiles = await vscode.workspace.findFiles('**/*.fit', '**/node_modules/**', 200);
  if (!fitFiles.length) {
    return null;
  }

  if (fitFiles.length === 1) {
    return fitFiles[0];
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
  const items = fitFiles.map((uri) => {
    const filePath = uri.fsPath;
    const label = root && filePath.startsWith(root)
      ? filePath.slice(root.length + 1)
      : filePath;
    return {
      label,
      description: uri.fsPath,
      uri,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Select a FIT file to visualize',
    placeHolder: 'Choose a .fit file from the workspace',
    matchOnDescription: true,
  });

  return selected?.uri || null;
}

async function getFitDataWithDbFallback(filePath) {
  try {
    const dbPath = fitFileToDbPath(filePath);
    if (await fileExists(dbPath)) {
      const activityId = await getActivityIdByPath(dbPath, filePath);
      if (activityId) {
        const data = await loadFitDataFromDb(dbPath, activityId);
        if (data && data.records.length > 0) {
          return { data, source: 'db' };
        }
      }
    }
  } catch {
    // fall through to direct FIT parsing
  }
  const data = await parseFitFile(filePath);
  return { data, source: 'fit' };
}

function fitFileToDbPath(fitFilePath) {
  const fitUri = vscode.Uri.file(fitFilePath);
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(fitUri)?.uri.fsPath;
  return path.join(workspaceRoot || path.dirname(fitFilePath), '.fit-visualizer', 'fit-data.sqlite');
}

async function prepareFitForVisualization(filePath) {
  const dbPath = fitFileToDbPath(filePath);
  const { data: parsed, source: dataSource } = await getFitDataWithDbFallback(filePath);
  if (dataSource === 'fit') {
    await saveFitToLocalDb(filePath, parsed, dbPath);
  }

  const activityId = await getActivityIdByPath(dbPath, filePath);
  if (!activityId) {
    throw new Error(`Indexed activity was not found for ${filePath}`);
  }
  await rememberDatabasePath(dbPath);
  return { dbPath, activityId };
}

async function resolveActiveDbPath(preferredDir) {
  const candidates = [];
  const addCandidate = (candidate) => {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  if (preferredDir) {
    addCandidate(path.join(preferredDir, '.fit-visualizer', 'fit-data.sqlite'));
  }

  const activeResourcePaths = [];
  const activeDocumentPath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (activeDocumentPath) {
    activeResourcePaths.push(activeDocumentPath);
  }

  const activeTabPath = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.fsPath;
  if (activeTabPath && !activeResourcePaths.includes(activeTabPath)) {
    activeResourcePaths.push(activeTabPath);
  }

  for (const resourcePath of activeResourcePaths) {
    if (resourcePath.toLowerCase().endsWith('.fit')) {
      addCandidate(fitFileToDbPath(resourcePath));
    }
  }

  for (const folder of vscode.workspace.workspaceFolders || []) {
    addCandidate(path.join(folder.uri.fsPath, '.fit-visualizer', 'fit-data.sqlite'));
  }

  if (extensionContextRef?.extensionUri?.fsPath) {
    const extensionParent = path.dirname(extensionContextRef.extensionUri.fsPath);
    addCandidate(path.join(extensionParent, '.fit-visualizer', 'fit-data.sqlite'));
  }

  if (extensionContextRef?.globalStorageUri?.fsPath) {
    addCandidate(path.join(extensionContextRef.globalStorageUri.fsPath, 'fit-data.sqlite'));
  }

  const lastDbPath = extensionContextRef?.globalState?.get(LAST_DB_PATH_KEY);
  addCandidate(lastDbPath);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      await rememberDatabasePath(candidate);
      return candidate;
    }
  }

  for (const resourcePath of activeResourcePaths) {
    let directory = path.dirname(resourcePath);
    while (true) {
      const candidate = path.join(directory, '.fit-visualizer', 'fit-data.sqlite');
      if (await fileExists(candidate)) {
        await rememberDatabasePath(candidate);
        return candidate;
      }

      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }

  return null;
}

async function selectDatabaseFolder() {
  const extensionParent = extensionContextRef?.extensionUri?.fsPath
    ? path.dirname(extensionContextRef.extensionUri.fsPath)
    : undefined;
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use FIT Data Folder',
    title: 'Select the folder containing FIT files and .fit-visualizer',
    defaultUri: extensionParent ? vscode.Uri.file(extensionParent) : undefined,
  });
  if (!selected?.length) {
    return null;
  }

  const dbPath = path.join(selected[0].fsPath, '.fit-visualizer', 'fit-data.sqlite');
  if (!await fileExists(dbPath)) {
    vscode.window.showErrorMessage(`No FIT database found in ${selected[0].fsPath}. Run FIT: Index All Files first.`);
    return null;
  }

  await rememberDatabasePath(dbPath);
  return dbPath;
}

async function rememberDatabasePath(dbPath) {
  if (dbPath && extensionContextRef?.globalState) {
    await extensionContextRef.globalState.update(LAST_DB_PATH_KEY, dbPath);
  }
}

async function getActivityIdByPath(dbPath, filePath) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const absPath = path.resolve(filePath);
    const stmt = db.prepare('SELECT id FROM activities WHERE file_path = ? OR file_path = ?');
    stmt.bind([absPath, filePath]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return Number(row.id);
  } finally {
    db.close();
  }
}

async function loadActivityListFromDb(dbPath) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const stmt = db.prepare(`
          SELECT id, file_name, start_time, sport, sub_sport,
             total_distance_km, total_timer_s, total_elapsed_s,
            COALESCE(manual_avg_hr, avg_hr) AS avg_hr,
            COALESCE(manual_max_hr, max_hr) AS max_hr,
            avg_speed_kmh, total_calories, record_count
      FROM activities ORDER BY start_time DESC, imported_at DESC
    `);
    const list = [];
    while (stmt.step()) { list.push(stmt.getAsObject()); }
    stmt.free();
    return list;
  } finally {
    db.close();
  }
}

async function getIndexedFilePaths(dbPath) {
  if (!await fileExists(dbPath)) {
    return new Set();
  }

  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    ensureDatabaseSchema(db);
    const stmt = db.prepare('SELECT file_path FROM activities');
    const indexedPaths = new Set();
    while (stmt.step()) {
      indexedPaths.add(path.resolve(String(stmt.getAsObject().file_path)));
    }
    stmt.free();
    return indexedPaths;
  } finally {
    db.close();
  }
}

async function openActivityBrowser(context, dbPath, preselectId, compId) {
  const panel = vscode.window.createWebviewPanel(
    'fitVisualizer.view',
    'FIT Visualizer',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [
        context.extensionUri,
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'leaflet', 'dist'),
      ],
      retainContextWhenHidden: true,
    }
  );

  await showActivityBrowserInPanel(context, panel, dbPath, preselectId, compId);
}

async function showActivityBrowserInPanel(context, panel, dbPath, preselectId, compId) {
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [
      context.extensionUri,
      vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'leaflet', 'dist'),
    ],
  };

  const activities = await loadActivityListFromDb(dbPath);
  const selectedId = preselectId || (activities[0]?.id ? Number(activities[0].id) : null);
  async function render(selId, selCompId) {
    const data = selId ? await loadFitDataFromDb(dbPath, selId) : null;
    const comp = selCompId ? await loadFitDataFromDb(dbPath, selCompId) : null;
    const athleteProfile = await getAthleteProfile(dbPath);
    const hrConfig = data
      ? await getHeartRateConfigForActivity(dbPath, data.sessions?.[0]?.start_time)
      : getHeartRateConfig();
    panel.webview.html = renderActivityBrowserHtml(
      panel.webview, context.extensionUri,
      activities, selId, data, selCompId, comp, hrConfig, athleteProfile
    );
    if (selId) {
      const cached = await getAnalysisFromDb(dbPath, selId);
      panel.webview.postMessage(cached
        ? { type: 'analysisResult', id: Number(selId), analysis: cached }
        : { type: 'noAnalysis', id: Number(selId) });
    }
  }

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'selectActivity') {
      await render(msg.id ? Number(msg.id) : null, msg.compId ? Number(msg.compId) : null);
    } else if (msg.type === 'analyzeActivity') {
      try {
        const requestedActivityId = Number(msg.id);
        const analysis = await generateActivityAnalysis(dbPath, requestedActivityId, msg.force);
        panel.webview.postMessage({ type: 'analysisResult', id: requestedActivityId, analysis });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'analysisError', id: Number(msg.id), error: errorMsg });
      }
    } else if (msg.type === 'updateActivityHeartRate') {
      try {
        await updateActivityHeartRate(dbPath, msg.id, msg.avgHr, msg.maxHr);
        await render(Number(msg.id), msg.compId ? Number(msg.compId) : null);
        vscode.window.showInformationMessage('Manual heart-rate data saved.');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'manualDataError', error: errorMsg });
      }
    } else if (msg.type === 'updateHeartRateProfile') {
      try {
        await updateHeartRateProfile(dbPath, msg);
        await render(Number(msg.id), msg.compId ? Number(msg.compId) : null);
        vscode.window.showInformationMessage('Dated heart-rate profile saved.');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'heartRateProfileError', error: errorMsg });
      }
    } else if (msg.type === 'autoCalculateHeartRateProfile') {
      try {
        const suggestion = await autoCalculateHeartRateProfileFromDb(dbPath, msg);
        panel.webview.postMessage({ type: 'heartRateProfileAuto', suggestion });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'heartRateProfileError', error: errorMsg });
      }
    }
  });

  await render(selectedId, compId || null);
}

async function loadFitDataFromDb(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const actStmt = db.prepare('SELECT * FROM activities WHERE id = ?');
    actStmt.bind([activityId]);
    if (!actStmt.step()) {
      actStmt.free();
      return null;
    }
    const activity = actStmt.getAsObject();
    actStmt.free();

    const recStmt = db.prepare('SELECT * FROM records WHERE activity_id = ? ORDER BY record_index');
    recStmt.bind([activityId]);
    const records = [];
    while (recStmt.step()) {
      const r = recStmt.getAsObject();
      records.push({
        distance:               r.distance_km,
        speed:                  r.speed_kmh,
        heart_rate:             r.heart_rate,
        altitude:               r.altitude_m != null ? r.altitude_m / 1000 : null,
        position_lat:           r.latitude,
        position_long:          r.longitude,
        elapsed_time:           r.elapsed_s,
        timestamp:              r.timestamp,
        cadence:                r.cadence,
        power:                  r.power,
        temperature:            r.temperature_c,
        grade:                  r.grade_pct,
        vertical_oscillation:   r.vertical_oscillation_mm,
        stance_time:            r.stance_time_ms,
      });
    }
    recStmt.free();

    return {
      records,
      sessions: [{
        total_distance:        activity.total_distance_km,
        total_distance_km:     activity.total_distance_km,
        total_timer_time:      activity.total_timer_s,
        total_timer_s:         activity.total_timer_s,
        total_elapsed_time:    activity.total_elapsed_s,
        total_elapsed_s:       activity.total_elapsed_s,
        sport:                 activity.sport,
        sub_sport:             activity.sub_sport,
        start_time:            activity.start_time,
        total_ascent:          activity.total_ascent_m,
        total_ascent_m:        activity.total_ascent_m,
        total_descent:         activity.total_descent_m,
        total_descent_m:       activity.total_descent_m,
        total_calories:        activity.total_calories,
        avg_cadence:           activity.avg_cadence,
        normalized_power:      activity.normalized_power,
        training_stress_score: activity.training_stress_score,
        intensity_factor:      activity.intensity_factor,
        avg_speed_kmh:         activity.avg_speed_kmh,
        max_speed_kmh:         activity.max_speed_kmh,
        avg_hr:                activity.manual_avg_hr ?? activity.avg_hr,
        max_hr:                activity.manual_max_hr ?? activity.max_hr,
      }],
      laps: [],
      _activityId: Number(activity.id),
      _fileName: activity.file_name,
    };
  } finally {
    db.close();
  }
}

async function saveFitToLocalDb(filePath, fitData, targetDbPath) {
  const dbPath = targetDbPath || await getLocalDbPath(path.dirname(filePath));
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);

  try {
    ensureDatabaseSchema(db);
    upsertActivity(db, filePath, fitData);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function getSqlJs() {
  if (!sqlJsInitPromise) {
    const vendorDir = path.join(__dirname, 'vendor', 'sql-wasm');
    const sqlWasmJsPath = path.join(vendorDir, 'sql-wasm.js');
    if (!require('node:fs').existsSync(sqlWasmJsPath)) {
      throw new Error('sql.js not found in vendor/sql-wasm. Re-run the extension setup or restore the vendor folder.');
    }
    const initSqlJs = require(sqlWasmJsPath);
    sqlJsInitPromise = initSqlJs({ locateFile: () => path.join(vendorDir, 'sql-wasm.wasm') });
  }
  return sqlJsInitPromise;
}

async function getLocalDbPath(preferredDir) {
  if (preferredDir) {
    const dbDir = path.join(preferredDir, '.fit-visualizer');
    await fs.mkdir(dbDir, { recursive: true });
    return path.join(dbDir, 'fit-data.sqlite');
  }

  const globalPath = extensionContextRef?.globalStorageUri?.fsPath;
  if (globalPath) {
    await fs.mkdir(globalPath, { recursive: true });
    return path.join(globalPath, 'fit-data.sqlite');
  }

  throw new Error('Cannot determine a writable FIT database location. Open a workspace or select a FIT folder.');
}

async function openDatabase(SQL, dbPath) {
  if (await fileExists(dbPath)) {
    const data = await fs.readFile(dbPath);
    const db = new SQL.Database(new Uint8Array(data));
    ensureDatabaseSchema(db);
    return db;
  }
  const db = new SQL.Database();
  ensureDatabaseSchema(db);
  return db;
}

async function persistDatabase(db, dbPath) {
  const bytes = db.export();
  await fs.writeFile(dbPath, Buffer.from(bytes));
}

function upsertActivity(db, filePath, fitData) {
  const records = Array.isArray(fitData.records) ? fitData.records : [];
  const sessions = Array.isArray(fitData.sessions) ? fitData.sessions : [];
  const laps = Array.isArray(fitData.laps) ? fitData.laps : [];

  const summary = buildSummary(records, sessions);
  const session = sessions[0] || {};
  const nowIso = new Date().toISOString();

  const upsertStmt = db.prepare(`
    INSERT INTO activities (
      file_path, file_name, imported_at, start_time, sport, sub_sport,
      total_distance_km, total_ascent_m, total_descent_m,
      total_timer_s, total_elapsed_s,
      avg_hr, max_hr, avg_speed_kmh, max_speed_kmh,
      avg_cadence, max_cadence, avg_power, max_power, normalized_power,
      training_stress_score, intensity_factor,
      total_training_effect, aerobic_training_effect, anaerobic_training_effect,
      total_calories, record_count, lap_count
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_name=excluded.file_name, imported_at=excluded.imported_at,
      start_time=excluded.start_time, sport=excluded.sport, sub_sport=excluded.sub_sport,
      total_distance_km=excluded.total_distance_km,
      total_ascent_m=excluded.total_ascent_m, total_descent_m=excluded.total_descent_m,
      total_timer_s=excluded.total_timer_s, total_elapsed_s=excluded.total_elapsed_s,
      avg_hr=excluded.avg_hr, max_hr=excluded.max_hr,
      avg_speed_kmh=excluded.avg_speed_kmh, max_speed_kmh=excluded.max_speed_kmh,
      avg_cadence=excluded.avg_cadence, max_cadence=excluded.max_cadence,
      avg_power=excluded.avg_power, max_power=excluded.max_power,
      normalized_power=excluded.normalized_power,
      training_stress_score=excluded.training_stress_score,
      intensity_factor=excluded.intensity_factor,
      total_training_effect=excluded.total_training_effect,
      aerobic_training_effect=excluded.aerobic_training_effect,
      anaerobic_training_effect=excluded.anaerobic_training_effect,
      total_calories=excluded.total_calories,
      record_count=excluded.record_count, lap_count=excluded.lap_count
  `);

  upsertStmt.run([
    filePath, path.basename(filePath), nowIso,
    toSqlStr(session.start_time) || null,
    toSqlStr(session.sport) || null,
    toSqlStr(session.sub_sport) || null,
    summary.distanceKm, summary.elevationGainM || null, summary.elevationLossM || null,
    asNumber(session.total_timer_time),
    asNumber(session.total_elapsed_time),
    summary.avgHr, summary.maxHr,
    summary.avgSpeed, summary.maxSpeed,
    null, null, null, null, null,
    null, null, null, null, null,
    null, records.length, laps.length,
  ]);
  upsertStmt.free();

  const idStmt = db.prepare('SELECT id FROM activities WHERE file_path = ?');
  idStmt.bind([filePath]);
  if (!idStmt.step()) {
    idStmt.free();
    throw new Error(`Failed to resolve activity id for ${filePath}`);
  }
  const row = idStmt.getAsObject();
  idStmt.free();
  const activityId = Number(row.id);

  db.run('DELETE FROM records WHERE activity_id = ?', [activityId]);

  const insertRecord = db.prepare(`
    INSERT INTO records (
      activity_id, record_index, timestamp, elapsed_s,
      distance_km, speed_kmh, heart_rate, altitude_m,
      latitude, longitude, cadence, power,
      temperature_c, grade_pct, vertical_oscillation_mm, stance_time_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    const lat = normalizeCoordinate(r.position_lat, 90);
    const lon = normalizeCoordinate(r.position_long, 180);
    insertRecord.run([
      activityId, i,
      toSqlStr(r.timestamp) || null,
      asNumber(r.elapsed_time),
      asNumber(r.distance),
      asNumber(r.speed),
      asNumber(r.heart_rate),
      Number.isFinite(asNumber(r.altitude)) ? asNumber(r.altitude) * 1000 : null,
      Number.isFinite(lat) ? lat : null,
      Number.isFinite(lon) ? lon : null,
      asNumber(r.cadence) || null,
      asNumber(r.power) || null,
      asNumber(r.temperature) || null,
      null, null, null,
    ]);
  }

  insertRecord.free();
}

function getHeartRateConfig() {
  const config = vscode.workspace.getConfiguration('fitVisualizer');
  const maxHeartRateRaw = Number(config.get('maxHeartRate'));
  const maxHeartRate = Number.isFinite(maxHeartRateRaw) && maxHeartRateRaw >= 100 && maxHeartRateRaw <= 240
    ? maxHeartRateRaw
    : null;

  return {
    maxHeartRate,
    thresholds: null,
    effectiveDate: null,
    source: maxHeartRate ? 'VS Code setting' : null,
  };
}

async function getHeartRateConfigForActivity(dbPath, startTime) {
  const activityDate = toDateOnly(startTime);
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  let fallbackStmt;
  try {
    if (activityDate) {
      stmt = db.prepare(`
        SELECT effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start
        FROM heart_rate_profiles
        WHERE effective_date <= ?
        ORDER BY effective_date DESC
        LIMIT 1
      `);
      stmt.bind([activityDate]);
      if (stmt.step()) {
        return profileRowToConfig(stmt.getAsObject());
      }
    }

    fallbackStmt = db.prepare(`
      SELECT effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start
      FROM heart_rate_profiles
      ORDER BY effective_date DESC
      LIMIT 1
    `);
    if (fallbackStmt.step()) {
      return profileRowToConfig(fallbackStmt.getAsObject());
    }

    return getHeartRateConfig();
  } finally {
    stmt?.free();
    fallbackStmt?.free();
    db.close();
  }
}

function profileRowToConfig(profile) {
  const thresholds = [profile.zone2_start, profile.zone3_start, profile.zone4_start, profile.zone5_start];
  return {
    maxHeartRate: Number(profile.max_hr),
    thresholds: thresholds.every((value) => Number.isFinite(value)) ? thresholds.map(Number) : null,
    effectiveDate: String(profile.effective_date),
    source: 'dated profile',
  };
}

async function getAthleteProfile(dbPath) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare('SELECT sex, age, resting_hr FROM athlete_profile WHERE id = 1');
    if (!stmt.step()) {
      return { sex: '', age: '', restingHeartRate: '' };
    }
    const row = stmt.getAsObject();
    return {
      sex: String(row.sex || ''),
      age: Number.isFinite(Number(row.age)) ? String(Math.round(Number(row.age))) : '',
      restingHeartRate: Number.isFinite(Number(row.resting_hr)) ? String(Math.round(Number(row.resting_hr))) : '',
    };
  } finally {
    stmt?.free();
    db.close();
  }
}

function toDateOnly(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function renderActivityBrowserHtml(webview, extensionUri, activities, selectedId, fitData, compId, compData, hrConfig, athleteProfile) {
  const hasData = fitData && Array.isArray(fitData.records) && fitData.records.length > 0;
  const hasComp = compData && Array.isArray(compData.records) && compData.records.length > 0;

  const actOptions = activities.map((a) => {
    const label = escapeHtml(formatActivityLabel(a));
    const sel = Number(a.id) === Number(selectedId) ? ' selected' : '';
    return `<option value="${escapeHtml(String(a.id))}"${sel}>${label}</option>`;
  }).join('');

  const compOptions = [
    `<option value="">— no comparison —</option>`,
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
          id: document.getElementById('actSel').value,
          compId: document.getElementById('compSel').value || null,
        });
      }
      document.getElementById('actSel').addEventListener('change', send);
      document.getElementById('compSel').addEventListener('change', send);
    }());
  `;

  const primaryHtml = hasData
    ? renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, false, hasComp ? compData : null, athleteProfile)
    : `<div style="padding:24px;color:var(--muted)">No data for this activity.</div>`;

  const { leafletCss, leafletJs, csp } = buildWebviewAssets(webview, extensionUri, nonce);

  return `<!DOCTYPE html>
<html lang="en">
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
      z-index: 50;
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
      <label class="selLabel" for="actSel">Activity</label>
      <select id="actSel" class="actSelector">${actOptions}</select>
    </div>
    <div class="selectorGroup">
      <label class="selLabel" for="compSel">Compare with</label>
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
  const dateStr = dt ? dt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : (a.file_name || String(a.id));
  const sport = a.sport || '';
  const dist = a.total_distance_km ? `${Number(a.total_distance_km).toFixed(1)} km` : '';
  const dur = a.total_timer_s ? formatHms(Number(a.total_timer_s)) : '';
  return [dateStr, sport, dist, dur].filter(Boolean).join(' · ');
}

function parseActivityTime(value) {
  if (!value) return null;
  const iso = new Date(value);
  if (!isNaN(iso.getTime())) return iso;
  const m = String(value).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return null;
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

function renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, isComparison, compData, athleteProfile) {
  const records = Array.isArray(fitData.records) ? fitData.records : [];
  const sessions = Array.isArray(fitData.sessions) ? fitData.sessions : [];
  const compRecords = compData && Array.isArray(compData.records) ? compData.records : [];
  const hasOverlay = compRecords.length > 0;

  const summary = buildSummary(records, sessions);
  const compSummary = hasOverlay ? buildSummary(compRecords, Array.isArray(compData.sessions) ? compData.sessions : []) : null;
  const chartPointBudget = Math.min(4000, Math.max(900, Math.floor(records.length / 2)));
  const speedChart = buildLineChart(records, 'distance', 'speed', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const hrChart = buildLineChart(records, 'distance', 'heart_rate', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const altitudeChart = buildLineChart(records, 'distance', 'altitude', 1400, 380, chartPointBudget, { yTransform: (v) => v * 1000, compRecords: hasOverlay ? compRecords : [] });
  const hrZones = computeHeartRateZones(records, hrConfig?.maxHeartRate, hrConfig?.thresholds);
  const gpsRoutePointBudget = Math.min(6000, Math.max(1200, records.length));
  const gpsRoute = buildGpsRoute(records, 1400, 420, gpsRoutePointBudget);
  const compGpsPoints = hasOverlay ? safeJson(extractGpsPoints(compRecords).slice(0, gpsRoutePointBudget).map((p) => ({ lat: p.y, lon: p.x }))) : 'null';

  const mapId = isComparison ? 'fitMapComp' : 'fitMap';
  const mapPayload = safeJson(gpsRoute.geoPoints);
  const safeFile = escapeHtml(fitData._fileName || '');
  const activitySession = sessions[0] || {};
  const avgHrValue = positiveNumberOrBlank(activitySession.avg_hr);
  const maxHrValue = positiveNumberOrBlank(activitySession.max_hr);
  const activityDate = toDateOnly(activitySession.start_time) || '';
  const profileMaxHr = positiveNumberOrBlank(hrConfig?.maxHeartRate);
  const profileThresholds = Array.isArray(hrConfig?.thresholds) ? hrConfig.thresholds : [];
  const athleteSex = escapeHtml(athleteProfile?.sex || '');
  const athleteAge = escapeHtml(athleteProfile?.age || '');
  const athleteRestingHr = escapeHtml(athleteProfile?.restingHeartRate || '');

  const compStatsRow = hasOverlay && compSummary
    ? renderComparisonTable(summary, compSummary, fitData._fileName, compData._fileName)
    : '';

  return `<main class="wrap">
    <section class="hero">
      <h1>FIT Activity</h1>
      <div class="muted">${safeFile}</div>
    </section>
    ${compStatsRow}
    <section class="grid">
      ${metric('Records', summary.records)}
      ${metric('Sessions', sessions.length)}
      ${metric('Distance (km)', summary.distanceKm.toFixed(2))}
      ${metric('Duration (h:m:s)', summary.durationText)}
      ${metric('Avg Speed (km/h)', summary.avgSpeed.toFixed(2))}
      ${metric('Max Speed (km/h)', summary.maxSpeed.toFixed(2))}
      ${metric('Avg HR (bpm)', summary.avgHr.toFixed(0))}
      ${metric('Max HR (bpm)', summary.maxHr.toFixed(0))}
      ${metric('Elevation Gain (m)', summary.elevationGainM.toFixed(0))}
      ${metric('Elevation Loss (m)', summary.elevationLossM.toFixed(0))}
      ${metric('GPS Points', gpsRoute.pointCount)}
    </section>
    <section class="chart manualData">
      <h2>Manual Activity Data</h2>
      <form id="${mapId}ManualDataForm" class="manualDataForm">
        <label>
          <span>Average HR (bpm)</span>
          <input id="${mapId}ManualAvgHr" type="number" min="30" max="240" step="1" value="${avgHrValue}" placeholder="Not available">
        </label>
        <label>
          <span>Maximum HR (bpm)</span>
          <input id="${mapId}ManualMaxHr" type="number" min="30" max="240" step="1" value="${maxHrValue}" placeholder="Not available">
        </label>
        <button type="submit">Save HR</button>
        <span id="${mapId}ManualDataStatus" class="manualDataStatus"></span>
      </form>
      <div class="mapHint">Manual summary values are used in metrics and analysis. A heart-rate chart requires time-series samples.</div>
    </section>
    <section class="chart manualData">
      <h2>Heart Rate Zone Profile</h2>
      <form id="${mapId}HrProfileForm" class="manualDataForm">
        <label>
          <span>Effective from</span>
          <input id="${mapId}HrEffectiveDate" type="date" value="${escapeHtml(activityDate)}" required>
        </label>
        <label>
          <span>Maximum HR</span>
          <input id="${mapId}ProfileMaxHr" type="number" min="100" max="240" step="1" value="${profileMaxHr}" required>
        </label>
        ${[2, 3, 4, 5].map((zone, index) => `<label>
          <span>Zone ${zone} starts</span>
          <input id="${mapId}Zone${zone}Start" type="number" min="30" max="240" step="1" value="${positiveNumberOrBlank(profileThresholds[index])}" placeholder="Auto">
        </label>`).join('')}
        <label>
          <span>Sex</span>
          <select id="${mapId}AthleteSex">
            <option value=""${athleteSex ? '' : ' selected'}>Select</option>
            <option value="male"${athleteSex === 'male' ? ' selected' : ''}>Male</option>
            <option value="female"${athleteSex === 'female' ? ' selected' : ''}>Female</option>
            <option value="other"${athleteSex === 'other' ? ' selected' : ''}>Other</option>
          </select>
        </label>
        <label>
          <span>Age</span>
          <input id="${mapId}AthleteAge" type="number" min="10" max="100" step="1" value="${athleteAge}" placeholder="years">
        </label>
        <label>
          <span>Resting HR</span>
          <input id="${mapId}AthleteRestingHr" type="number" min="30" max="120" step="1" value="${athleteRestingHr}" placeholder="bpm">
        </label>
        <button type="button" id="${mapId}AutoCalcZonesBtn">Auto-calc</button>
        <button type="submit">Save Zones</button>
        <span id="${mapId}HrProfileStatus" class="manualDataStatus"></span>
      </form>
      <div class="mapHint">Auto-calc uses sex, age, resting HR, and your saved activity heart-rate history. Then you can manually override before saving. The latest profile effective on an activity date is used.${hrConfig?.effectiveDate ? ` Currently applied: ${escapeHtml(hrConfig.effectiveDate)}.` : ''}</div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}SpeedSvg" data-resize-key="fitviz_speed_height" data-min-height="200" data-max-height="1200">
      <h2>Speed vs Distance${hasOverlay ? ' <span class="compLegend">— primary &nbsp;– – comparison</span>' : ''}</h2>
      ${renderStatsRow(speedChart.stats, 'km/h')}${hasOverlay && speedChart.compStats ? renderStatsRow(speedChart.compStats, 'km/h', true) : ''}
      ${renderScaledLineChartSvg(speedChart, 'lineA', 'Distance (km)', 'Speed (km/h)', true, { svgId: mapId + 'SpeedSvg' })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}HrSvg" data-resize-key="fitviz_hr_height" data-min-height="200" data-max-height="1200">
      <h2>Heart Rate vs Distance</h2>
      ${renderStatsRow(hrChart.stats, 'bpm')}
      ${renderHeartRateZones(hrZones)}
      ${renderScaledLineChartSvg(hrChart, 'lineB', 'Distance (km)', 'Heart rate (bpm)', true, { svgId: mapId + 'HrSvg', zoneThresholds: hrZones.enabled ? hrZones.thresholds : null })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}AltSvg" data-resize-key="fitviz_alt_height" data-min-height="200" data-max-height="1200">
      <h2>Altitude vs Distance${hasOverlay ? ' <span class="compLegend">— primary &nbsp;– – comparison</span>' : ''}</h2>
      ${renderStatsRow(altitudeChart.stats, 'm')}${hasOverlay && altitudeChart.compStats ? renderStatsRow(altitudeChart.compStats, 'm', true) : ''}
      ${renderScaledLineChartSvg(altitudeChart, 'lineC', 'Distance (km)', 'Altitude (m)', true, { svgId: mapId + 'AltSvg' })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section id="${mapId}RouteSection" class="chart">
      <h2>GPS Route</h2>
      ${renderGpsRouteSvg(gpsRoute, 1400, 420)}
      <div class="legend">Route (${escapeHtml(gpsRoute.boundsText)})</div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}" data-resize-key="fitviz_map_height" data-min-height="260" data-max-height="1400" data-target-type="map">
      <h2>Interactive Map</h2>
      ${renderMapStats(gpsRoute)}
      <div class="mapWrap">
        <div class="mapControls">
          <label for="${mapId}Mode">Color route by</label>
          <select id="${mapId}Mode">
            <option value="speed" selected>Speed</option>
            <option value="heart_rate">Heart Rate</option>
            <option value="none">Single Color</option>
          </select>
        </div>
        <div id="${mapId}"></div>
        <div class="mapHint">Map tiles from OpenStreetMap.</div>
      </div>
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart">
      <h2>AI Analysis</h2>
      <div id="analysisContent" style="padding:12px;color:var(--muted);min-height:80px;line-height:1.5;">
        <p style="margin:0;">Loading analysis...</p>
      </div>
      <button id="analyzeBtn" style="margin-top:10px;padding:8px 16px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer;font-weight:600;">Analyze Activity</button>
    </section>
  </main>
  <script nonce="${nonce}">
    (function () {
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
      const manualDataForm = document.getElementById('${mapId}ManualDataForm');
      const manualDataStatus = document.getElementById('${mapId}ManualDataStatus');
      const hrProfileForm = document.getElementById('${mapId}HrProfileForm');
      const hrProfileStatus = document.getElementById('${mapId}HrProfileStatus');
      const autoCalcZonesBtn = document.getElementById('${mapId}AutoCalcZonesBtn');
      const vscode = window.fitVisualizerApi;
      let hasAnalysis = false;
      
      window.addEventListener('message', (event) => {
        const msg = event.data;
        const currentId = Number(window.currentActivityId);
        if ((msg.type === 'analysisResult' || msg.type === 'analysisError' || msg.type === 'noAnalysis')
          && Number.isFinite(currentId)
          && Number(msg.id) !== currentId) {
          return;
        }
        if (msg.type === 'analysisResult') {
          hasAnalysis = true;
          analysisContent.innerHTML = '<div style="color:var(--ink);white-space:pre-wrap;word-break:break-word;">' + escapeHtml(msg.analysis) + '</div>';
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = 'Analyze Again';
        } else if (msg.type === 'noAnalysis') {
          hasAnalysis = false;
          analysisContent.innerHTML = '<p style="margin:0;color:var(--muted);">Click &ldquo;Analyze Activity&rdquo; to analyze this ride with Copilot.</p>';
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = 'Analyze Activity';
        } else if (msg.type === 'analysisError') {
          analysisContent.innerHTML = '<div style="color:#ff6b6b;">Error: ' + escapeHtml(msg.error) + '</div>';
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = hasAnalysis ? 'Analyze Again' : 'Analyze Activity';
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
          hrProfileStatus.textContent = 'Auto values applied. Review and save to keep them.';
          hrProfileStatus.classList.remove('error');
        }
      });

      autoCalcZonesBtn?.addEventListener('click', () => {
        hrProfileStatus.textContent = 'Calculating...';
        hrProfileStatus.classList.remove('error');
        vscode.postMessage({
          type: 'autoCalculateHeartRateProfile',
          id: window.currentActivityId,
          compId: document.getElementById('compSel')?.value || null,
          effectiveDate: document.getElementById('${mapId}HrEffectiveDate').value,
          sex: document.getElementById('${mapId}AthleteSex').value,
          age: document.getElementById('${mapId}AthleteAge').value,
          restingHr: document.getElementById('${mapId}AthleteRestingHr').value,
        });
      });

      manualDataForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        manualDataStatus.textContent = 'Saving...';
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
        hrProfileStatus.textContent = 'Saving...';
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
        });
      });

      if (analyzeBtn) {
        analyzeBtn.addEventListener('click', () => {
          if (!window.currentActivityId || window.currentActivityId === 'null') {
            analysisContent.innerHTML = '<div style="color:#ff6b6b;">Error: No activity loaded. Try refreshing.</div>';
            return;
          }
          analyzeBtn.disabled = true;
          analyzeBtn.textContent = 'Analyzing...';
          vscode.postMessage({ type: 'analyzeActivity', id: window.currentActivityId, force: hasAnalysis });
        });
      }

      window.currentActivityId = ${fitData && fitData._activityId ? fitData._activityId : 'null'};

      if (!window.currentActivityId) {
        analysisContent.innerHTML = '<p style="margin:0;color:#ff6b6b;">No activity data available for analysis.</p>';
      }
    }());
  </script>
  <script nonce="${nonce}">
    (function () {
      const routePoints = ${mapPayload};
      const mapEl = document.getElementById('${mapId}');
      const gpsRouteSection = document.getElementById('${mapId}RouteSection');

      setupResizablePanels(function onResized(targetId) {
        if (targetId === '${mapId}' && map) {
          setTimeout(() => { map.invalidateSize(false); map.eachLayer((l) => { if (window.L && l instanceof L.TileLayer) l.redraw(); }); }, 0);
        }
      });

      let map = null;
      const hasRoute = Array.isArray(routePoints) && routePoints.length >= 2;
      if (!window.L || !hasRoute) {
        if (mapEl) {
          let reason = !window.L
            ? 'Map library failed to load. Run npm install in fit-visualizer.'
            : 'No GPS points found in this FIT file.';
          mapEl.innerHTML = '<div style="padding:12px;color:var(--muted)">' + reason + '</div>';
        }
      } else {
        if (gpsRouteSection) gpsRouteSection.style.display = 'none';
        map = L.map('${mapId}', { preferCanvas: true, zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
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
        function drawSegments(mode) {
          clearSegments();
          const vals = routePoints
            .map((p) => p[mode])
            .filter((value) => value != null && Number.isFinite(Number(value)))
            .map(Number);
          const mn = vals.length ? Math.min(...vals) : NaN;
          const mx = vals.length ? Math.max(...vals) : NaN;
          for (let i = 1; i < routePoints.length; i++) {
            const a = routePoints[i-1], b = routePoints[i];
            const value = b[mode] == null ? NaN : Number(b[mode]);
            const color = mode !== 'none' ? colorForValue(value, mn, mx) : '#2f6db3';
            segments.push(L.polyline([[a.lat,a.lon],[b.lat,b.lon]], { color, weight:4, opacity:0.92, lineCap:'round' }).addTo(map));
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
    .metric .v { font-size:1.3rem; margin-top:3px; font-weight:bold; color:var(--accent); }
    .chart { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:12px; position:relative; }
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
    .mapControls select { border:1px solid var(--border); border-radius:6px; padding:4px 8px; background:var(--input-bg); color:var(--input-fg); font-size:0.9rem; }
    #fitMap, #fitMapComp { height:var(--map-height,clamp(320px,52vh,760px)); border:1px solid var(--border); border-radius:10px; overflow:hidden; background:color-mix(in srgb,var(--card) 65%,var(--bg)); }
    .mapHint { color:var(--muted); font-size:0.85rem; }
    .manualDataForm { display:flex; align-items:end; gap:12px; flex-wrap:wrap; }
    .manualDataForm label { display:grid; gap:4px; color:var(--muted); font-size:0.82rem; }
    .manualDataForm input { width:150px; border:1px solid var(--border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); }
    .manualDataForm select { width:150px; border:1px solid var(--border); border-radius:6px; padding:6px 8px; background:var(--input-bg); color:var(--input-fg); }
    .manualDataForm button { border:0; border-radius:6px; padding:7px 14px; background:var(--accent); color:var(--bg); font-weight:700; cursor:pointer; }
    .manualDataStatus { color:var(--muted); font-size:0.82rem; align-self:center; }
    .manualDataStatus.error { color:var(--vscode-errorForeground); }
  `;
}

function metric(label, value) {
  return `<div class="metric"><div class="k">${escapeHtml(String(label))}</div><div class="v">${escapeHtml(String(value))}</div></div>`;
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

function renderComparisonTable(a, b, aName, bName) {
  const rows = [
    ['Distance (km)', a.distanceKm.toFixed(2), b.distanceKm.toFixed(2)],
    ['Duration', a.durationText, b.durationText],
    ['Avg Speed (km/h)', a.avgSpeed.toFixed(2), b.avgSpeed.toFixed(2)],
    ['Max Speed (km/h)', a.maxSpeed.toFixed(2), b.maxSpeed.toFixed(2)],
    ['Avg HR (bpm)', a.avgHr.toFixed(0), b.avgHr.toFixed(0)],
    ['Max HR (bpm)', a.maxHr.toFixed(0), b.maxHr.toFixed(0)],
    ['Elevation Gain (m)', a.elevationGainM.toFixed(0), b.elevationGainM.toFixed(0)],
    ['Elevation Loss (m)', a.elevationLossM.toFixed(0), b.elevationLossM.toFixed(0)],
  ].map(([label, va, vb]) => `<tr><td class="cmpLabel">${escapeHtml(label)}</td><td class="cmpA">${escapeHtml(va)}</td><td class="cmpB">${escapeHtml(vb)}</td></tr>`).join('');
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

function buildSummary(records, sessions) {
  const speeds = records.map((r) => asNumber(r.speed)).filter((v) => Number.isFinite(v));
  const hrs = records.map((r) => asNumber(r.heart_rate)).filter((v) => Number.isFinite(v));
  const distances = records.map((r) => asNumber(r.distance)).filter((v) => Number.isFinite(v));
  const altitudeM = records
    .map((r) => asNumber(r.altitude))
    .filter((v) => Number.isFinite(v))
    .map((v) => v * 1000);

  const elevation = computeElevationGainLoss(altitudeM);

  const session = sessions[0] || {};
  const sessionDistance = asNumber(session.total_distance);
  const distanceKm = Number.isFinite(sessionDistance)
    ? sessionDistance
    : (distances.length ? Math.max(...distances) : 0);

  const totalTimer = asNumber(session.total_timer_time);
  const totalElapsed = asNumber(session.total_elapsed_time);
  const durationSec = Number.isFinite(totalTimer)
    ? totalTimer
    : (Number.isFinite(totalElapsed) ? totalElapsed : estimateDuration(records));
  const sessionAvgHr = asNumber(session.avg_hr);
  const sessionMaxHr = asNumber(session.max_hr);

  return {
    records: records.length,
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0,
    durationText: formatHms(durationSec),
    avgSpeed: average(speeds),
    maxSpeed: maxOrZero(speeds),
    avgHr: hrs.length ? average(hrs) : (Number.isFinite(sessionAvgHr) ? sessionAvgHr : 0),
    maxHr: hrs.length ? maxOrZero(hrs) : (Number.isFinite(sessionMaxHr) ? sessionMaxHr : 0),
    elevationGainM: elevation.gain,
    elevationLossM: elevation.loss,
  };
}

function positiveNumberOrBlank(value) {
  const number = asNumber(value);
  return Number.isFinite(number) && number > 0 ? escapeHtml(String(Math.round(number))) : '';
}

function buildLineChart(records, xField, yField, width, height, maxPoints, options = {}) {
  const xTransform = typeof options.xTransform === 'function' ? options.xTransform : (v) => v;
  const yTransform = typeof options.yTransform === 'function' ? options.yTransform : (v) => v;
  const series = extractXYPoints(records, xField, yField, maxPoints, { xTransform, yTransform });

  if (options.compRecords && options.compRecords.length > 0) {
    const compSeries = extractXYPoints(options.compRecords, xField, yField, maxPoints, { xTransform, yTransform });
    const allPoints = [...series.points, ...compSeries.points];
    const base = buildCartesianGeometry(allPoints, width, height, { left: 60, right: 18, top: 12, bottom: 40 });
    const xRange = (base.xMax - base.xMin) || 1;
    const yRange = (base.yMax - base.yMin) || 1;
    const pw = base.plotRight - base.plotLeft;
    const ph = base.plotBottom - base.plotTop;
    const sx = (x) => base.plotLeft + ((x - base.xMin) / xRange) * pw;
    const sy = (y) => base.plotBottom - ((y - base.yMin) / yRange) * ph;
    base.pathData = series.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    base.pathPoints = series.points.map((p) => ({ x: sx(p.x), y: sy(p.y), source: p }));
    base.points = series.points;
    base.compPathData = compSeries.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    base.stats = computeStats(series.yValues);
    base.compStats = computeStats(compSeries.yValues);
    return base;
  }

  const chart = buildCartesianGeometry(series.points, width, height, { left: 60, right: 18, top: 12, bottom: 40 });
  chart.stats = computeStats(series.yValues);
  return chart;
}

function renderScaledLineChartSvg(chart, lineClass, xLabel, yLabel, addDistanceMarkers, options = {}) {
  if (!chart || chart.points.length < 2) {
    return '<div class="muted">Not enough data for this chart.</div>';
  }

  const svgIdAttr = options.svgId ? ` id="${escapeHtml(options.svgId)}"` : '';

  const kmMarkers = addDistanceMarkers
    ? buildDistanceMarkers(chart, 1)
    : [];

  const markerSvg = kmMarkers.map((m) => `<g>
      <line class="kmMarker" x1="${m.px.toFixed(1)}" y1="${chart.plotTop}" x2="${m.px.toFixed(1)}" y2="${chart.plotBottom}" />
      <text class="kmLabel" x="${m.px.toFixed(1)}" y="${chart.plotTop + 10}" text-anchor="middle">${escapeHtml(m.label)}</text>
    </g>`).join('');

  const xTicks = chart.xTicks.map((t) => `<g>
      <line class="gridline" x1="${t.px.toFixed(1)}" y1="${chart.plotTop}" x2="${t.px.toFixed(1)}" y2="${chart.plotBottom}" />
      <text class="tick" x="${t.px.toFixed(1)}" y="${chart.plotBottom + 16}" text-anchor="middle">${escapeHtml(formatTick(t.value, chart.xStep))}</text>
    </g>`).join('');

  const yTicks = chart.yTicks.map((t) => `<g>
      <line class="gridline" x1="${chart.plotLeft}" y1="${t.py.toFixed(1)}" x2="${chart.plotRight}" y2="${t.py.toFixed(1)}" />
      <text class="tick" x="${chart.plotLeft - 8}" y="${(t.py + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatTick(t.value, chart.yStep))}</text>
    </g>`).join('');

  const zoneThresholds = Array.isArray(options.zoneThresholds) ? options.zoneThresholds : null;
  const hasZoneLine = zoneThresholds && zoneThresholds.length >= 4;

  const lineSvg = hasZoneLine
    ? buildZoneSegmentPolylines(chart, zoneThresholds)
    : `<polyline class="${lineClass}" points="${chart.pathData}" />`;

  const compLineSvg = chart.compPathData
    ? `<polyline class="${lineClass}Comp" points="${chart.compPathData}" />`
    : '';

  return `<svg${svgIdAttr} viewBox="0 0 ${chart.width} ${chart.height}" preserveAspectRatio="none" role="img" aria-label="line chart">
    ${markerSvg}
    ${xTicks}
    ${yTicks}
    <line class="axis" x1="${chart.plotLeft}" y1="${chart.plotBottom}" x2="${chart.plotRight}" y2="${chart.plotBottom}" />
    <line class="axis" x1="${chart.plotLeft}" y1="${chart.plotTop}" x2="${chart.plotLeft}" y2="${chart.plotBottom}" />
    ${compLineSvg}
    ${lineSvg}
    <text class="axisLabel" x="${(chart.plotLeft + chart.plotRight) / 2}" y="${chart.height - 4}" text-anchor="middle">${escapeHtml(xLabel)}</text>
    <text class="axisLabel" transform="translate(14 ${(chart.plotTop + chart.plotBottom) / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(yLabel)}</text>
  </svg>`;
}

function buildZoneSegmentPolylines(chart, thresholds) {
  const segmentsByZone = [[], [], [], [], []];
  const points = chart.pathPoints;
  const values = chart.points;

  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const y0 = values[i - 1]?.y;
    const y1 = values[i]?.y;
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
      continue;
    }

    const zone = getHrZoneIndex((y0 + y1) / 2, thresholds);
    segmentsByZone[zone].push({
      x1: p0.x,
      y1: p0.y,
      x2: p1.x,
      y2: p1.y,
    });
  }

  return segmentsByZone
    .map((segments, idx) => segments.map((s) =>
      `<line class="zoneLine zoneLine${idx + 1}" x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" />`
    ).join(''))
    .join('');
}

function buildGpsRoute(records, width, height, maxPoints) {
  const gpsPoints = downsamplePoints(extractGpsPoints(records), maxPoints);
  const route = buildCartesianGeometry(gpsPoints, width, height, { left: 60, right: 18, top: 12, bottom: 36 });
  const boundsText = route.points.length
    ? `lat ${formatTick(route.yMin, route.yStep)}..${formatTick(route.yMax, route.yStep)}, lon ${formatTick(route.xMin, route.xStep)}..${formatTick(route.xMax, route.xStep)}`
    : 'no GPS points available';

  return {
    ...route,
    pointCount: gpsPoints.length,
    boundsText,
    routeDistanceKm: computeRouteDistanceKm(gpsPoints),
    speedStats: computeStats(gpsPoints.map((p) => p.speed).filter((v) => Number.isFinite(v))),
    hrStats: computeStats(gpsPoints.map((p) => p.heart_rate).filter((v) => Number.isFinite(v))),
    geoPoints: gpsPoints.map((p) => ({
      lat: p.y,
      lon: p.x,
      speed: p.speed,
      heart_rate: p.heart_rate,
    })),
  };
}

function renderGpsRouteSvg(route, width, height) {
  if (!route || route.points.length < 2) {
    return '<div class="muted">No usable GPS points found in this FIT file.</div>';
  }

  const xTicks = route.xTicks.map((t) => `<g>
      <line class="gridline" x1="${t.px.toFixed(1)}" y1="${route.plotTop}" x2="${t.px.toFixed(1)}" y2="${route.plotBottom}" />
      <text class="tick" x="${t.px.toFixed(1)}" y="${route.plotBottom + 16}" text-anchor="middle">${escapeHtml(formatTick(t.value, route.xStep))}</text>
    </g>`).join('');

  const yTicks = route.yTicks.map((t) => `<g>
      <line class="gridline" x1="${route.plotLeft}" y1="${t.py.toFixed(1)}" x2="${route.plotRight}" y2="${t.py.toFixed(1)}" />
      <text class="tick" x="${route.plotLeft - 8}" y="${(t.py + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatTick(t.value, route.yStep))}</text>
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

function extractXYPoints(records, xField, yField, maxPoints, transforms) {
  const points = [];
  const yValues = [];
  const xTransform = transforms?.xTransform || ((v) => v);
  const yTransform = transforms?.yTransform || ((v) => v);

  for (const r of records) {
    const xRaw = asNumber(r[xField]);
    const yRaw = asNumber(r[yField]);
    if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) {
      continue;
    }

    const x = xTransform(xRaw);
    const y = yTransform(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    points.push({ x, y });
    yValues.push(y);
  }

  return {
    points: downsamplePoints(points, maxPoints),
    yValues,
  };
}

function extractGpsPoints(records) {
  const points = [];
  for (const r of records) {
    const lat = normalizeCoordinate(r.position_lat, 90);
    const lon = normalizeCoordinate(r.position_long, 180);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    // Skip (0, 0) — GPS not yet locked at recording start.
    if (lat === 0 && lon === 0) {
      continue;
    }
    points.push({
      x: lon,
      y: lat,
      speed: asNumber(r.speed),
      heart_rate: asNumber(r.heart_rate),
    });
  }
  return points;
}

function normalizeCoordinate(raw, degreesLimit) {
  const value = asNumber(raw);
  if (!Number.isFinite(value)) {
    return NaN;
  }

  if (Math.abs(value) <= degreesLimit) {
    return value;
  }

  const fromSemicircles = (value * 180) / 2147483648;
  if (Math.abs(fromSemicircles) <= degreesLimit) {
    return fromSemicircles;
  }

  return NaN;
}

function buildCartesianGeometry(points, width, height, margin) {
  if (points.length < 2) {
    return {
      points,
      pathPoints: [],
      pathData: '',
      width,
      height,
      plotLeft: margin.left,
      plotRight: width - margin.right,
      plotTop: margin.top,
      plotBottom: height - margin.bottom,
      xTicks: [],
      yTicks: [],
      xStep: 1,
      yStep: 1,
      xMin: 0,
      xMax: 0,
      yMin: 0,
      yMax: 0,
    };
  }

  const xMin = Math.min(...points.map((p) => p.x));
  const xMax = Math.max(...points.map((p) => p.x));
  const yMin = Math.min(...points.map((p) => p.y));
  const yMax = Math.max(...points.map((p) => p.y));

  const safeX = padRange(xMin, xMax);
  const safeY = padRange(yMin, yMax);

  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const scaleX = (x) => plotLeft + ((x - safeX.min) / (safeX.max - safeX.min)) * plotWidth;
  const scaleY = (y) => plotBottom - ((y - safeY.min) / (safeY.max - safeY.min)) * plotHeight;

  const pathPoints = points.map((p) => ({
    x: scaleX(p.x),
    y: scaleY(p.y),
    source: p,
  }));

  const pathData = pathPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const xTickInfo = buildTicks(safeX.min, safeX.max, 6);
  const yTickInfo = buildTicks(safeY.min, safeY.max, 6);

  const xTicks = xTickInfo.values.map((v) => ({ value: v, px: scaleX(v) }));
  const yTicks = yTickInfo.values.map((v) => ({ value: v, py: scaleY(v) }));

  return {
    points,
    pathPoints,
    pathData,
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    xTicks,
    yTicks,
    xStep: xTickInfo.step,
    yStep: yTickInfo.step,
    xMin: safeX.min,
    xMax: safeX.max,
    yMin: safeY.min,
    yMax: safeY.max,
  };
}

function padRange(min, max) {
  if (min !== max) {
    return { min, max };
  }
  const pad = Math.abs(min || 1) * 0.05;
  return { min: min - pad, max: max + pad };
}

function buildTicks(min, max, targetCount) {
  const span = Math.abs(max - min);
  if (!Number.isFinite(span) || span === 0) {
    return { values: [min], step: 1 };
  }

  const rough = span / Math.max(2, targetCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;

  let nice = 1;
  if (residual > 5) {
    nice = 10;
  } else if (residual > 2) {
    nice = 5;
  } else if (residual > 1) {
    nice = 2;
  }

  const step = nice * magnitude;
  const first = Math.ceil(min / step) * step;
  const values = [];
  for (let v = first; v <= max + step * 0.5; v += step) {
    values.push(roundTo(v, 12));
  }

  if (!values.length) {
    values.push(roundTo(min, 12));
    values.push(roundTo(max, 12));
  }

  return { values, step };
}

function formatTick(value, step) {
  const absStep = Math.abs(step);
  if (absStep >= 10) {
    return value.toFixed(0);
  }
  if (absStep >= 1) {
    return value.toFixed(1);
  }
  if (absStep >= 0.1) {
    return value.toFixed(2);
  }
  return value.toFixed(4);
}

function buildDistanceMarkers(chart, intervalKm) {
  if (!Number.isFinite(chart.xMin) || !Number.isFinite(chart.xMax) || chart.xMax <= chart.xMin) {
    return [];
  }

  let step = intervalKm;
  const span = chart.xMax - chart.xMin;
  if (span / step > 60) {
    step = Math.ceil(span / 60);
  }

  const markers = [];
  const first = Math.ceil(chart.xMin / step) * step;
  for (let km = first; km <= chart.xMax; km += step) {
    const px = chart.plotLeft + ((km - chart.xMin) / (chart.xMax - chart.xMin)) * (chart.plotRight - chart.plotLeft);
    markers.push({
      px,
      label: `${roundTo(km, 3)} km`,
    });
  }
  return markers;
}

function computeElevationGainLoss(altitudesM) {
  if (!altitudesM.length) {
    return { gain: 0, loss: 0 };
  }

  let gain = 0;
  let loss = 0;
  for (let i = 1; i < altitudesM.length; i += 1) {
    const delta = altitudesM[i] - altitudesM[i - 1];
    if (Math.abs(delta) < 0.5) {
      continue;
    }
    if (delta > 0) {
      gain += delta;
    } else {
      loss += Math.abs(delta);
    }
  }

  return { gain, loss };
}

function computeStats(values) {
  if (!values.length) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      median: 0,
      p95: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;

  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    median: percentileFromSorted(sorted, 50),
    p95: percentileFromSorted(sorted, 95),
  };
}

function percentileFromSorted(sortedValues, percentile) {
  if (!sortedValues.length) {
    return 0;
  }
  const p = Math.max(0, Math.min(100, percentile));
  const index = ((sortedValues.length - 1) * p) / 100;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) {
    return sortedValues[lo];
  }
  const weight = index - lo;
  return sortedValues[lo] * (1 - weight) + sortedValues[hi] * weight;
}

function computeRouteDistanceKm(points) {
  if (points.length < 2) {
    return 0;
  }

  let totalKm = 0;
  for (let i = 1; i < points.length; i += 1) {
    totalKm += haversineKm(points[i - 1].y, points[i - 1].x, points[i].y, points[i].x);
  }
  return totalKm;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

async function generateActivityAnalysis(dbPath, activityId, force = false) {
  const numId = Number(activityId);
  if (!Number.isFinite(numId) || numId <= 0) {
    throw new Error(`Invalid activity ID: ${activityId}`);
  }

  if (!force) {
    const existing = await getAnalysisFromDb(dbPath, numId);
    if (existing) {
      return existing;
    }
  }

  const current = await loadFitDataFromDb(dbPath, numId);
  if (!current) {
    throw new Error(`Activity ${numId} not found in database`);
  }

  const summary = await getProgressSummaryFromDb(dbPath, numId);
  const hrConfig = await getHeartRateConfigForActivity(dbPath, current.sessions?.[0]?.start_time);
  const prompt = generateAnalysisPrompt(current, summary, hrConfig);
  const analysis = await requestCopilotAnalysis(vscode, prompt);
  await storeAnalysisInDb(dbPath, numId, analysis);

  return analysis;
}

async function updateActivityHeartRate(dbPath, activityId, avgHrInput, maxHrInput) {
  const id = Number(activityId);
  const avgHr = parseOptionalHeartRate(avgHrInput, 'Average heart rate');
  const maxHr = parseOptionalHeartRate(maxHrInput, 'Maximum heart rate');
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid activity.');
  }
  if (avgHr != null && maxHr != null && avgHr > maxHr) {
    throw new Error('Average heart rate cannot exceed maximum heart rate.');
  }

  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    db.run(
      'UPDATE activities SET manual_avg_hr = ?, manual_max_hr = ? WHERE id = ?',
      [avgHr, maxHr, id]
    );
    db.run('DELETE FROM activity_analysis WHERE activity_id = ?', [id]);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function updateHeartRateProfile(dbPath, message) {
  const activityId = Number(message.id);
  if (!Number.isInteger(activityId) || activityId <= 0) {
    throw new Error('Invalid activity.');
  }

  const effectiveDate = String(message.effectiveDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(Date.parse(`${effectiveDate}T00:00:00Z`))) {
    throw new Error('Choose a valid effective date.');
  }

  const maxHeartRate = Number(message.maxHr);
  if (!Number.isFinite(maxHeartRate) || maxHeartRate < 100 || maxHeartRate > 240) {
    throw new Error('Maximum heart rate must be between 100 and 240 bpm.');
  }

  const rawThresholds = Array.isArray(message.thresholds) ? message.thresholds : [];
  const suppliedCount = rawThresholds.filter((value) => String(value || '').trim() !== '').length;
  if (suppliedCount !== 0 && suppliedCount !== 4) {
    throw new Error('Enter all four zone starts, or leave all four blank for automatic zones.');
  }
  const thresholds = suppliedCount === 4
    ? rawThresholds.map((value) => Number(value))
    : [null, null, null, null];
  if (suppliedCount === 4) {
    if (thresholds.some((value) => !Number.isFinite(value) || value < 30 || value > 240)) {
      throw new Error('Zone starts must be between 30 and 240 bpm.');
    }
    if (!thresholds.every((value, index) => index === 0 || value > thresholds[index - 1])) {
      throw new Error('Zone starts must increase from Zone 2 through Zone 5.');
    }
    if (thresholds[3] > maxHeartRate) {
      throw new Error('Zone 5 cannot start above maximum heart rate.');
    }
  }
  const athleteProfile = parseOptionalAthleteProfile(message);

  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO heart_rate_profiles (
        effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(effective_date) DO UPDATE SET
        max_hr = excluded.max_hr,
        zone2_start = excluded.zone2_start,
        zone3_start = excluded.zone3_start,
        zone4_start = excluded.zone4_start,
        zone5_start = excluded.zone5_start,
        updated_at = excluded.updated_at
    `, [effectiveDate, maxHeartRate, ...thresholds, now, now]);
    if (athleteProfile) {
      upsertAthleteProfile(db, athleteProfile, now);
    }
    db.run('DELETE FROM activity_analysis');
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function autoCalculateHeartRateProfileFromDb(dbPath, message) {
  const athleteProfile = parseRequiredAthleteProfile(message);
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare(`
      SELECT
        COALESCE(MAX(COALESCE(manual_max_hr, max_hr)), 0) AS max_session_hr,
        COALESCE((SELECT MAX(heart_rate) FROM records), 0) AS max_record_hr
      FROM activities
    `);
    stmt.step();
    const row = stmt.getAsObject();
    const observedMaxHeartRate = Math.max(Number(row.max_session_hr) || 0, Number(row.max_record_hr) || 0);
    const suggestion = calculateAutoHeartRateProfile({
      sex: athleteProfile.sex,
      age: athleteProfile.age,
      restingHeartRate: athleteProfile.restingHeartRate,
      observedMaxHeartRate,
    });
    const now = new Date().toISOString();
    upsertAthleteProfile(db, athleteProfile, now);
    await persistDatabase(db, dbPath);
    return suggestion;
  } finally {
    stmt?.free();
    db.close();
  }
}

function upsertAthleteProfile(db, profile, updatedAt) {
  db.run(`
    INSERT INTO athlete_profile (id, sex, age, resting_hr, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sex = excluded.sex,
      age = excluded.age,
      resting_hr = excluded.resting_hr,
      updated_at = excluded.updated_at
  `, [profile.sex, profile.age, profile.restingHeartRate, updatedAt]);
}

function parseRequiredAthleteProfile(message) {
  const profile = parseOptionalAthleteProfile(message);
  if (!profile) {
    throw new Error('Provide sex, age, and resting HR for auto calculation.');
  }
  return profile;
}

function parseOptionalAthleteProfile(message) {
  const sex = String(message.sex || '').trim().toLowerCase();
  const ageRaw = String(message.age ?? '').trim();
  const restingRaw = String(message.restingHr ?? '').trim();
  const blankCount = [sex, ageRaw, restingRaw].filter((value) => value === '').length;
  if (blankCount === 3) {
    return null;
  }
  if (blankCount > 0) {
    throw new Error('Enter sex, age, and resting HR together.');
  }
  if (!['male', 'female', 'other'].includes(sex)) {
    throw new Error('Sex must be male, female, or other.');
  }

  const age = Number(ageRaw);
  const restingHeartRate = Number(restingRaw);
  if (!Number.isFinite(age) || age < 10 || age > 100) {
    throw new Error('Age must be between 10 and 100.');
  }
  if (!Number.isFinite(restingHeartRate) || restingHeartRate < 30 || restingHeartRate > 120) {
    throw new Error('Resting HR must be between 30 and 120 bpm.');
  }
  return {
    sex,
    age: Math.round(age),
    restingHeartRate: Math.round(restingHeartRate),
  };
}

function parseOptionalHeartRate(value, label) {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const heartRate = Number(value);
  if (!Number.isFinite(heartRate) || heartRate < 30 || heartRate > 240) {
    throw new Error(`${label} must be between 30 and 240 bpm.`);
  }
  return Math.round(heartRate);
}

async function getAnalysisFromDb(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare('SELECT analysis_text FROM activity_analysis WHERE activity_id = ? AND analysis_version = ?');
    stmt.bind([activityId, ANALYSIS_VERSION]);
    if (stmt.step()) {
      return stmt.getAsObject().analysis_text;
    }
    return null;
  } finally {
    stmt?.free();
    db.close();
  }
}

async function getProgressSummaryFromDb(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare(`
      WITH selected AS (
        SELECT id, start_time, total_distance_km
        FROM activities
        WHERE id = ?
      ),
      prior AS (
        SELECT activities.*
        FROM activities, selected
        WHERE (
          datetime(activities.start_time) < datetime(selected.start_time)
          OR (datetime(activities.start_time) = datetime(selected.start_time) AND activities.id < selected.id)
        )
          AND selected.total_distance_km > 0
          AND activities.total_distance_km BETWEEN
            selected.total_distance_km * ? AND selected.total_distance_km * ?
      )
      SELECT
        COUNT(*) AS total_activities,
        (SELECT total_distance_km * ? FROM selected) AS comparison_min_distance_km,
        (SELECT total_distance_km * ? FROM selected) AS comparison_max_distance_km,
        COALESCE(SUM(total_distance_km), 0) AS total_distance_km,
        COALESCE(SUM(total_timer_s) / 3600.0, 0) AS total_hours,
        COALESCE(AVG(avg_speed_kmh), 0) AS avg_speed_kmh,
        COALESCE(AVG(COALESCE(manual_avg_hr, avg_hr)), 0) AS avg_heart_rate,
        COALESCE(MAX(COALESCE(manual_max_hr, max_hr)), 0) AS max_recorded_heart_rate,
        COUNT(CASE WHEN datetime(start_time) >= datetime((SELECT start_time FROM selected), '-7 days') THEN 1 END) AS recent_activity_count,
        COALESCE(AVG(CASE WHEN datetime(start_time) >= datetime((SELECT start_time FROM selected), '-7 days') THEN total_distance_km END), 0) AS weekly_avg_distance_km,
        COALESCE(AVG(CASE WHEN datetime(start_time) >= datetime((SELECT start_time FROM selected), '-7 days') THEN avg_speed_kmh END), 0) AS weekly_avg_speed_kmh,
        'N/A' AS trend_speed,
        'N/A' AS trend_heart_rate,
        (SELECT start_time FROM prior ORDER BY datetime(start_time) DESC, id DESC LIMIT 1) AS last_activity_date,
        COALESCE(MAX(max_speed_kmh), 0) AS best_speed_kmh,
        COALESCE(MAX(total_ascent_m), 0) AS best_elevation_m,
        MIN(100.0, COUNT(CASE WHEN datetime(start_time) >= datetime((SELECT start_time FROM selected), '-28 days') THEN 1 END) * 100.0 / 16.0) AS consistency_pct
      FROM prior
    `);
    stmt.bind([
      activityId,
      COMPARABLE_DISTANCE_MIN_RATIO,
      COMPARABLE_DISTANCE_MAX_RATIO,
      COMPARABLE_DISTANCE_MIN_RATIO,
      COMPARABLE_DISTANCE_MAX_RATIO,
    ]);
    stmt.step();
    return stmt.getAsObject();
  } finally {
    stmt?.free();
    db.close();
  }
}

async function storeAnalysisInDb(dbPath, activityId, analysis) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        analysis_text = excluded.analysis_text,
        analysis_version = excluded.analysis_version,
        updated_at = excluded.updated_at
    `, [activityId, analysis, ANALYSIS_VERSION, now, now]);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
