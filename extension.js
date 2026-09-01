const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateAnalysisPrompt, generateAnalysisChatPrompt, requestCopilotAnalysis, summarizePromptBlocks } = require('./analysis');
const { localizeGlossary } = require('./glossary');
const { formatUi, localizeUi } = require('./ui-strings');
const { buildDistanceMarkers, buildTicks, formatTick, padRange, padYAxisRange } = require('./chart-geometry');
const { computeElevationGainLoss, computeRouteDistanceKm, computeStats, extractGpsPoints, extractXYPoints } = require('./chart-data');
const {
  loadGeneratedTranslationBundle,
  parseGeneratedBundle,
  saveGeneratedTranslationBundle,
  translationMessages,
  validateTranslationBundle,
} = require('./dynamic-localization');
const { registerCommands } = require('./commands');
const { ensureDatabaseSchema } = require('./database-schema');
const { fileExists, getFitUris, parseFitFile } = require('./fit-files');
const {
  calculateAutoHeartRateProfile,
  computeHeartRateZones,
  getHeartRateZoneIndex: getHrZoneIndex,
} = require('./heart-rate');
const {
  addEstimatedPowerWhenMissing,
  asNumber,
  average,
  buildActivitySegments,
  calculateBanisterTrimp,
  calculateBikeStressScore,
  calculateHistoricalMeanMaximalPower,
  calculateMeanMaximalPower,
  calculateHrTss,
  calculateIntensityFactor,
  calculateIntervalsDecoupling,
  calculateNormalizedPower,
  calculateTrainingStressScore,
  calculateXPower,
  computeGpsDerivedSpeed,
  computeGrade,
  createNonce,
  deriveSpeedsFromDistance,
  despikeSeries,
  detectStops,
  downsamplePoints,
  estimateFtpCandidates,
  estimatePowerFromMotion,
  escapeHtml,
  estimateDuration,
  estimateSpeedConfidence,
  estimateWheelCalibrationRatio,
  formatHms,
  formatNumber,
  groupSimilarSegments,
  haversineKm,
  maxOrZero,
  normalizeCoordinate,
  normalizeRecordSpeeds,
  roundTo,
  safeJson,
  segmentLineBudget,
  selectFtpEstimate,
  smoothSeries,
  toSqlStr,
} = require('./utils');

let extensionContextRef;
let sqlJsInitPromise = null;
const LAST_DB_PATH_KEY = 'fitVisualizer.lastDatabasePath';
const ANALYSIS_VERSION = 8;
const ANALYSIS_CHAT_HISTORY_LIMIT = 24;
const COMPARABLE_DISTANCE_MIN_RATIO = 0.75;
const COMPARABLE_DISTANCE_MAX_RATIO = 1.25;

// sql.js rewrites the whole database file, so overlapping analyses would clobber each other.
let llmTaskQueue = Promise.resolve();
let llmLogCleanupDone = false;

function enqueueLlmTask(task) {
  const result = llmTaskQueue.then(task, task);
  llmTaskQueue = result.then(() => undefined, () => undefined);
  return result;
}

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
    reanalyzeOutdatedActivities,
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
    const athleteProfile = await getAthleteProfile(dbPath, selId);
    const wheelCalibration = await getWheelCalibrationRecommendation(dbPath);
    const analysis = selId ? await getLatestAnalysisAnyVersion(dbPath, selId) : null;
    const analysisChat = selId ? await getAnalysisChatFromDb(dbPath, selId) : [];
    const hrConfig = data
      ? await getHeartRateConfigForActivity(dbPath, data.sessions?.[0]?.start_time)
      : getHeartRateConfig();
    const generatedTranslations = await loadGeneratedTranslationBundle(
      extensionContextRef?.globalStorageUri?.fsPath, vscode.env.language
    );
    panel.webview.html = renderActivityBrowserHtml(
      panel.webview, context.extensionUri,
      activities, selId, data, selCompId, comp, hrConfig, athleteProfile, analysis, analysisChat, wheelCalibration, generatedTranslations
    );
    if (selId) {
      panel.webview.postMessage({ type: 'analysisChatState', id: Number(selId), messages: analysisChat });
    }
  }

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'selectActivity') {
      await render(msg.id ? Number(msg.id) : null, msg.compId ? Number(msg.compId) : null);
    } else if (msg.type === 'generateTranslations') {
      const locale = String(vscode.env.language || '').replace(/_/g, '-');
      const language = displayLanguage(locale);
      const ui = localizeUi(vscode.l10n.t);
      const confirmed = await vscode.window.showInformationMessage(
        formatUi(ui.generateTranslationsConfirm, language), { modal: true }, ui.generate
      );
      if (confirmed !== ui.generate) {
        return;
      }
      try {
        const response = await requestCopilotAnalysis(vscode, buildTranslationPrompt(locale), { vendor: getLanguageModelVendor() });
        const bundle = validateTranslationBundle(parseGeneratedBundle(response));
        await saveGeneratedTranslationBundle(extensionContextRef?.globalStorageUri?.fsPath, locale, bundle);
        await render(msg.id ? Number(msg.id) : selectedId, msg.compId ? Number(msg.compId) : null);
        vscode.window.showInformationMessage(formatUi(ui.translationGenerated, language));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'translationError', error: message });
      }
    } else if (msg.type === 'analyzeActivity') {
      try {
        const requestedActivityId = Number(msg.id);
        const analysis = await generateActivityAnalysis(dbPath, requestedActivityId, msg.force);
        panel.webview.postMessage({ type: 'analysisResult', id: requestedActivityId, analysis });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'analysisError', id: Number(msg.id), error: errorMsg });
      }
    } else if (msg.type === 'analysisChatTurn') {
      try {
        const requestedActivityId = Number(msg.id);
        const userText = String(msg.text || '').trim();
        if (!Number.isInteger(requestedActivityId) || requestedActivityId <= 0) {
          throw new Error('Invalid activity.');
        }
        if (!userText) {
          throw new Error('Enter a question for AI chat.');
        }
        const nextChat = await appendActivityChatTurn(dbPath, requestedActivityId, userText);
        panel.webview.postMessage({ type: 'analysisChatState', id: requestedActivityId, messages: nextChat });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'analysisChatError', id: Number(msg.id), error: errorMsg });
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
      const latitude = Number.isFinite(asNumber(r.latitude)) ? asNumber(r.latitude) : null;
      const longitude = Number.isFinite(asNumber(r.longitude)) ? asNumber(r.longitude) : null;
      const hasGpsFix = !(latitude === 0 && longitude === 0);
      records.push({
        distance:               r.distance_km,
        speed:                  r.speed_kmh,
        heart_rate:             r.heart_rate,
        altitude:               r.altitude_m != null ? r.altitude_m / 1000 : null,
        position_lat:           hasGpsFix ? latitude : null,
        position_long:          hasGpsFix ? longitude : null,
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
        xpower:                activity.xpower,
        relative_intensity_gc: activity.relative_intensity_gc,
        bike_stress_score:     activity.bike_stress_score,
        decoupling_pct:        activity.decoupling_pct,
        hr_tss:                activity.hr_tss,
        trimp:                 activity.trimp,
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

function getAthleteProfileFromDbConnection(db) {
  let stmt;
  try {
    stmt = db.prepare('SELECT sex, resting_hr, ftp, rider_mass_kg, bike_mass_kg, wheel_circumference_mm FROM athlete_profile WHERE id = 1');
    if (!stmt.step()) {
      return { sex: '', restingHeartRate: NaN, ftp: NaN };
    }
    const row = stmt.getAsObject();
    return {
      sex: String(row.sex || '').toLowerCase(),
      restingHeartRate: asNumber(row.resting_hr),
      ftp: asNumber(row.ftp),
      riderMassKg: asNumber(row.rider_mass_kg),
      bikeMassKg: asNumber(row.bike_mass_kg),
      wheelCircumferenceMm: asNumber(row.wheel_circumference_mm),
    };
  } finally {
    stmt?.free();
  }
}

function upsertActivity(db, filePath, fitData) {
  const records = normalizeRecordSpeeds(Array.isArray(fitData.records) ? fitData.records : []);
  const sessions = Array.isArray(fitData.sessions) ? fitData.sessions : [];
  const laps = Array.isArray(fitData.laps) ? fitData.laps : [];
  const athleteProfile = getAthleteProfileFromDbConnection(db);

  const profileMaxHr = getProfileMaxHeartRate(db, sessions[0]?.start_time);
  const summary = buildSummary(records, sessions, {
    ftp: athleteProfile.ftp,
    restingHeartRate: athleteProfile.restingHeartRate,
    sex: athleteProfile.sex,
    maxHeartRateForHrr: profileMaxHr ?? sessions[0]?.max_hr,
  });
  const session = sessions[0] || {};
  const sessionCalories = asNumber(session.total_calories);
  const nowIso = new Date().toISOString();
  const upsertValues = [
    filePath, path.basename(filePath), nowIso,
    toSqlStr(session.start_time) || null,
    toSqlStr(session.sport) || null,
    toSqlStr(session.sub_sport) || null,
    summary.distanceKm, summary.elevationGainM || null, summary.elevationLossM || null,
    asNumber(session.total_timer_time),
    asNumber(session.total_elapsed_time),
    summary.avgHr, summary.maxHr,
    summary.avgSpeed, summary.maxSpeed,
    summary.avgCadence > 0 ? summary.avgCadence : null,
    summary.maxCadence > 0 ? summary.maxCadence : null,
    summary.avgPower, summary.maxPower, summary.normalizedPower,
    summary.trainingStressScore, summary.intensityFactor, summary.xPower, summary.relativeIntensityGc, summary.bikeStressScore, summary.decouplingPct, summary.hrTss, summary.trimp,
    null, null, null,
    Number.isFinite(sessionCalories) && sessionCalories > 0 ? sessionCalories : null,
    records.length, laps.length,
    Number.isFinite(athleteProfile.riderMassKg) ? athleteProfile.riderMassKg : null,
    Number.isFinite(athleteProfile.bikeMassKg) ? athleteProfile.bikeMassKg : null,
  ];

  const upsertStmt = db.prepare(`
    INSERT INTO activities (
      file_path, file_name, imported_at, start_time, sport, sub_sport,
      total_distance_km, total_ascent_m, total_descent_m,
      total_timer_s, total_elapsed_s,
      avg_hr, max_hr, avg_speed_kmh, max_speed_kmh,
      avg_cadence, max_cadence, avg_power, max_power, normalized_power,
      training_stress_score, intensity_factor, xpower, relative_intensity_gc, bike_stress_score, decoupling_pct, hr_tss, trimp,
      total_training_effect, aerobic_training_effect, anaerobic_training_effect,
      total_calories, record_count, lap_count, rider_mass_kg, bike_mass_kg
    ) VALUES (${upsertValues.map(() => '?').join(',')})
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
      xpower=excluded.xpower,
      relative_intensity_gc=excluded.relative_intensity_gc,
      bike_stress_score=excluded.bike_stress_score,
      decoupling_pct=excluded.decoupling_pct,
      hr_tss=excluded.hr_tss,
      trimp=excluded.trimp,
      total_training_effect=excluded.total_training_effect,
      aerobic_training_effect=excluded.aerobic_training_effect,
      anaerobic_training_effect=excluded.anaerobic_training_effect,
      total_calories=excluded.total_calories,
      record_count=excluded.record_count, lap_count=excluded.lap_count,
      rider_mass_kg=COALESCE(activities.rider_mass_kg, excluded.rider_mass_kg),
      bike_mass_kg=COALESCE(activities.bike_mass_kg, excluded.bike_mass_kg)
  `);

  upsertStmt.run(upsertValues);
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

  const grades = computeGrade(records);

  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    const lat = normalizeCoordinate(r.position_lat, 90);
    const lon = normalizeCoordinate(r.position_long, 180);
    const hasGpsFix = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    const grade = grades[i];
    // Below a metre of travel the slope is altitude noise divided by ~nothing.
    const gradePct = grade && grade.dt > 0 && grade.dt <= 5 && grade.distanceM >= 1
      ? roundTo(grade.grade * 100, 2)
      : null;
    insertRecord.run([
      activityId, i,
      toSqlStr(r.timestamp) || null,
      asNumber(r.elapsed_time),
      asNumber(r.distance),
      asNumber(r.speed),
      asNumber(r.heart_rate),
      Number.isFinite(asNumber(r.altitude)) ? asNumber(r.altitude) * 1000 : null,
      hasGpsFix ? lat : null,
      hasGpsFix ? lon : null,
      asNumber(r.cadence) || null,
      Number.isFinite(asNumber(r.power)) ? asNumber(r.power) : null,
      asNumber(r.temperature) || null,
      gradePct, null, null,
    ]);
  }

  insertRecord.free();

  // Only stored when a calibration ratio was actually computable; "no row" reads as "no trusted data yet".
  const calibration = estimateWheelCalibrationRatio(records);
  db.run('DELETE FROM wheel_calibration_samples WHERE activity_id = ?', [activityId]);
  if (calibration) {
    db.run(`
      INSERT INTO wheel_calibration_samples (activity_id, computed_at, ratio, trusted_distance_km)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        computed_at = excluded.computed_at,
        ratio = excluded.ratio,
        trusted_distance_km = excluded.trusted_distance_km
    `, [activityId, new Date().toISOString(), calibration.ratio, calibration.trustedDistanceKm]);
  }
}

function getSegmentationOptions() {
  const config = vscode.workspace.getConfiguration('fitVisualizer.segmentation');
  const read = (key) => {
    const value = Number(config.get(key));
    return Number.isFinite(value) ? value : undefined;
  };

  return {
    gradeThresholdPct: read('gradeThresholdPct'),
    gradeHysteresisPct: read('gradeHysteresisPct'),
    minSegmentSeconds: read('minSegmentSeconds'),
    technicalGradePct: read('technicalGradePct'),
    effortWindowSeconds: read('effortWindowSeconds'),
    effortCostThreshold: read('effortCostThreshold'),
    speedThresholdKmh: read('stopSpeedKmh'),
    minDurationSeconds: read('stopMinSeconds'),
    gapSeconds: read('stopMinSeconds'),
    minWindowKm: read('gpsTrustMinKm'),
  };
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

function getProfileMaxHeartRate(db, startTime) {
  const activityDate = toDateOnly(startTime);
  let stmt;
  try {
    stmt = db.prepare(activityDate
      ? 'SELECT max_hr FROM heart_rate_profiles WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1'
      : 'SELECT max_hr FROM heart_rate_profiles ORDER BY effective_date DESC LIMIT 1');
    if (activityDate) {
      stmt.bind([activityDate]);
    }
    if (stmt.step()) {
      const maxHr = asNumber(stmt.getAsObject().max_hr);
      if (Number.isFinite(maxHr) && maxHr > 0) {
        return maxHr;
      }
    }
    return null;
  } finally {
    stmt?.free();
  }
}

async function getAthleteProfile(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare('SELECT sex, age, resting_hr, ftp, rider_mass_kg, bike_mass_kg, wheel_circumference_mm FROM athlete_profile WHERE id = 1');
    const hasProfile = stmt.step();
    const row = hasProfile ? stmt.getAsObject() : {};
    const profile = {
      sex: String(row.sex || ''),
      age: Number.isFinite(asNumber(row.age)) ? String(Math.round(asNumber(row.age))) : '',
      restingHeartRate: Number.isFinite(asNumber(row.resting_hr)) ? String(Math.round(asNumber(row.resting_hr))) : '',
      ftp: Number.isFinite(asNumber(row.ftp)) ? String(Math.round(asNumber(row.ftp))) : '',
      riderMassKg: Number.isFinite(asNumber(row.rider_mass_kg)) ? String(asNumber(row.rider_mass_kg)) : '',
      bikeMassKg: Number.isFinite(asNumber(row.bike_mass_kg)) ? String(asNumber(row.bike_mass_kg)) : '',
      wheelCircumferenceMm: Number.isFinite(asNumber(row.wheel_circumference_mm)) ? String(asNumber(row.wheel_circumference_mm)) : '',
    };
    if (Number.isInteger(Number(activityId)) && Number(activityId) > 0) {
      stmt.free();
      stmt = db.prepare('SELECT rider_mass_kg, bike_mass_kg FROM activities WHERE id = ?');
      stmt.bind([Number(activityId)]);
      if (stmt.step()) {
        const activity = stmt.getAsObject();
        if (Number.isFinite(asNumber(activity.rider_mass_kg))) {
          profile.riderMassKg = String(asNumber(activity.rider_mass_kg));
        }
        if (Number.isFinite(asNumber(activity.bike_mass_kg))) {
          profile.bikeMassKg = String(asNumber(activity.bike_mass_kg));
        }
      }
    }
    return profile;
  } finally {
    stmt?.free();
    db.close();
  }
}

// Silent unless there is enough trusted GPS distance AND the deviation is outside plain GPS noise -
// the recommendation either exists and is justified, or the feature is invisible.
async function getWheelCalibrationRecommendation(dbPath) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    const profile = getAthleteProfileFromDbConnection(db);
    stmt = db.prepare(`
      SELECT wcs.ratio AS ratio, wcs.trusted_distance_km AS trusted_distance_km
      FROM wheel_calibration_samples wcs
      JOIN activities a ON a.id = wcs.activity_id
      ORDER BY a.start_time DESC
    `);
    const rows = [];
    let cumulativeKm = 0;
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row);
      cumulativeKm += asNumber(row.trusted_distance_km) || 0;
      if (rows.length >= 15 || cumulativeKm >= 20) {
        break;
      }
    }

    const totalKm = rows.reduce((sum, row) => sum + (asNumber(row.trusted_distance_km) || 0), 0);
    if (totalKm < 15) {
      return null;
    }

    const ratio = rows.reduce((sum, row) => sum + asNumber(row.ratio) * asNumber(row.trusted_distance_km), 0) / totalKm;
    const deviationPct = (ratio - 1) * 100;
    if (Math.abs(deviationPct) <= 1) {
      return null;
    }

    const currentMm = Number.isFinite(profile.wheelCircumferenceMm) ? profile.wheelCircumferenceMm : null;
    return {
      ratio: roundTo(ratio, 4),
      deviationPct: roundTo(deviationPct, 1),
      trustedDistanceKm: roundTo(totalKm, 1),
      currentCircumferenceMm: currentMm,
      recommendedCircumferenceMm: currentMm != null ? roundTo(currentMm / ratio, 1) : null,
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

function renderActivityBrowserHtml(webview, extensionUri, activities, selectedId, fitData, compId, compData, hrConfig, athleteProfile, analysis, analysisChat, wheelCalibration, generatedTranslations) {
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
    ? renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, false, hasComp ? compData : null, athleteProfile, analysis, analysisChat, wheelCalibration, ui, glossary, shouldOfferTranslations, displayLanguage(locale))
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

function renderActivityContentHtml(webview, extensionUri, fitData, hrConfig, nonce, isComparison, compData, athleteProfile, analysis, analysisChat, wheelCalibration, ui, glossary, shouldOfferTranslations, language) {
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
  const speedChart = buildLineChart(records, 'distance', 'speed', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const hrChart = buildLineChart(records, 'distance', 'heart_rate', 1400, 380, chartPointBudget, { compRecords: hasOverlay ? compRecords : [] });
  const altitudeChart = buildLineChart(records, 'distance', 'altitude', 1400, 380, chartPointBudget, { yTransform: (v) => v * 1000, compRecords: hasOverlay ? compRecords : [] });
  const overlayMetrics = buildOverlayMetrics(records, chartPointBudget);
  const speedOverlays = buildOverlayOptions(overlayMetrics, 'speed');
  const hrOverlays = buildOverlayOptions(overlayMetrics, 'heart_rate');
  const altitudeOverlays = buildOverlayOptions(overlayMetrics, 'altitude');
  const chartClientPayloads = safeJson({
    [mapId + 'SpeedSvg']: buildChartClientPayload(speedChart, 'km', 'km/h', speedOverlays),
    [mapId + 'HrSvg']: buildChartClientPayload(hrChart, 'km', 'bpm', hrOverlays),
    [mapId + 'AltSvg']: buildChartClientPayload(altitudeChart, 'km', 'm', altitudeOverlays),
  });
  const hrZones = computeHeartRateZones(records, hrConfig?.maxHeartRate, hrConfig?.thresholds);
  const gpsRoutePointBudget = Math.min(6000, Math.max(1200, records.length));
  const gpsRoute = buildGpsRoute(records, 1400, 420, gpsRoutePointBudget);
  const compGpsPoints = hasOverlay ? safeJson(extractGpsPoints(compRecords).slice(0, gpsRoutePointBudget).map((p) => ({ lat: p.y, lon: p.x }))) : 'null';

  const mapPayload = safeJson(gpsRoute.geoPoints);
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
      ${renderStatsRow(speedChart.stats, 'km/h')}${hasOverlay && speedChart.compStats ? renderStatsRow(speedChart.compStats, 'km/h', true) : ''}
      ${renderOverlayControls(mapId + 'SpeedSvg', speedOverlays)}
      ${renderScaledLineChartSvg(speedChart, 'lineA', 'Distance (km)', 'Speed (km/h)', true, { svgId: mapId + 'SpeedSvg' })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}HrSvg" data-resize-key="fitviz_hr_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.heartRateVsDistance)}</h2>
      ${renderStatsRow(hrChart.stats, 'bpm')}
      ${renderHeartRateZones(hrZones)}
      ${renderOverlayControls(mapId + 'HrSvg', hrOverlays)}
      ${renderScaledLineChartSvg(hrChart, 'lineB', 'Distance (km)', 'Heart rate (bpm)', true, { svgId: mapId + 'HrSvg', zoneThresholds: hrZones.enabled ? hrZones.thresholds : null })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
    <section class="chart resizable" data-resize-target="${mapId}AltSvg" data-resize-key="fitviz_alt_height" data-min-height="200" data-max-height="1200">
      <h2>${escapeHtml(ui.altitudeVsDistance)}${hasOverlay ? ' <span class="compLegend">- ' + escapeHtml(ui.primary) + ' / ' + escapeHtml(ui.comparison) + '</span>' : ''}</h2>
      ${renderStatsRow(altitudeChart.stats, 'm')}${hasOverlay && altitudeChart.compStats ? renderStatsRow(altitudeChart.compStats, 'm', true) : ''}
      ${renderOverlayControls(mapId + 'AltSvg', altitudeOverlays)}
      ${renderScaledLineChartSvg(altitudeChart, 'lineC', 'Distance (km)', 'Altitude (m)', true, { svgId: mapId + 'AltSvg' })}
      <div class="resizeHandle resizeHandleTopRight" data-anchor="top-right" aria-label="Resize panel from top-right"></div>
      <div class="resizeHandle resizeHandleBottomRight" data-anchor="bottom-right" aria-label="Resize panel from bottom-right"></div>
    </section>
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
            <option value="speed" selected>${escapeHtml(ui.speed)}</option>
            <option value="heart_rate">${escapeHtml(ui.heartRate)}</option>
            <option value="none">${escapeHtml(ui.singleColor)}</option>
          </select>
        </div>
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
      const vscode = window.fitVisualizerApi;
      const initialAnalysis = ${safeJson(analysis?.text || '')};
      let hasAnalysis = Boolean(initialAnalysis);
      let analysisOutdated = ${analysis && asNumber(analysis.version) < ANALYSIS_VERSION ? 'true' : 'false'};
      let chatMessages = ${safeJson(Array.isArray(analysisChat) ? analysisChat : [])};

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
      const mapEl = document.getElementById('${mapId}');
      const gpsRouteSection = document.getElementById('${mapId}RouteSection');

      setupResizablePanels(function onResized(targetId) {
        if (targetId === '${mapId}' && map) {
          setTimeout(() => { map.invalidateSize(false); map.eachLayer((l) => { if (window.L && l instanceof L.TileLayer) l.redraw(); }); }, 0);
        }
      });

      let map = null;
      const hasRoute = Array.isArray(routePoints) && routePoints.length >= 2;

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
  </script>
  <script nonce="${nonce}">
    (function () {
      var payloads = ${chartClientPayloads};
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

        if (capture) {
          capture.addEventListener('mousemove', function (evt) {
            var pt = svg.createSVGPoint();
            pt.x = evt.clientX; pt.y = evt.clientY;
            var ctm = svg.getScreenCTM();
            if (!ctm) return;
            var local = pt.matrixTransform(ctm.inverse());
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
      }

      svgIds.forEach(initChart);
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

function buildSummary(records, sessions, options = {}) {
  const speeds = records.map((r) => asNumber(r.speed)).filter((v) => Number.isFinite(v));
  const hrs = records.map((r) => asNumber(r.heart_rate)).filter((v) => Number.isFinite(v) && v > 0);
  const powers = records.map((r) => asNumber(r.power)).filter((v) => Number.isFinite(v));
  const distances = records.map((r) => asNumber(r.distance)).filter((v) => Number.isFinite(v));
  const cadences = records.map((r) => asNumber(r.cadence)).filter((v) => Number.isFinite(v) && v > 0);
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
  const avgHr = hrs.length ? average(hrs) : (Number.isFinite(sessionAvgHr) ? sessionAvgHr : 0);
  const maxHr = hrs.length ? maxOrZero(hrs) : (Number.isFinite(sessionMaxHr) ? sessionMaxHr : 0);
  const normalizedPower = calculateNormalizedPower(records);

  // Prefer device session values; fall back to distance/time, then record samples.
  const sessionAvgSpeed = [session.avg_speed, session.avg_speed_kmh]
    .map(asNumber).find((v) => Number.isFinite(v) && v > 0) || 0;
  const sessionMaxSpeed = [session.max_speed, session.max_speed_kmh]
    .map(asNumber).find((v) => Number.isFinite(v) && v > 0) || 0;
  const distanceBasedAvgSpeed = distanceKm > 0 && durationSec > 0
    ? distanceKm / (durationSec / 3600)
    : 0;
  const movingSpeeds = speeds.filter((v) => v > 0);
  const avgSpeed = sessionAvgSpeed > 0
    ? sessionAvgSpeed
    : (distanceBasedAvgSpeed > 0 ? distanceBasedAvgSpeed : average(movingSpeeds));
  const maxSpeed = sessionMaxSpeed > 0
    ? sessionMaxSpeed
    : maxOrZero(despikeSeries(speeds, { absThreshold: 12, ratioThreshold: 0.5 }));

  const ftp = asNumber(options.ftp);
  const intensityFactor = calculateIntensityFactor(normalizedPower, ftp);
  const trainingStressScore = calculateTrainingStressScore(durationSec, normalizedPower, intensityFactor, ftp);
  const xPower = calculateXPower(records);
  const relativeIntensityGc = calculateIntensityFactor(xPower, ftp);
  const bikeStressScore = calculateBikeStressScore(durationSec, xPower, relativeIntensityGc, ftp);

  const restingHeartRate = asNumber(options.restingHeartRate);
  const maxHeartRateForHrr = Number.isFinite(asNumber(options.maxHeartRateForHrr))
    ? asNumber(options.maxHeartRateForHrr)
    : maxHr;
  const trimp = calculateBanisterTrimp({
    durationSec,
    avgHeartRate: avgHr,
    restingHeartRate,
    maxHeartRate: maxHeartRateForHrr,
    sex: options.sex,
  });
  const hrTss = calculateHrTss({
    durationSec,
    avgHeartRate: avgHr,
    restingHeartRate,
    maxHeartRate: maxHeartRateForHrr,
  });
  const decouplingPct = calculateIntervalsDecoupling(records, {
    ftp,
    restingHeartRate,
    maxHeartRate: maxHeartRateForHrr,
  });

  return {
    records: records.length,
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0,
    durationText: formatHms(durationSec),
    durationSec,
    avgSpeed,
    maxSpeed,
    avgPower: average(powers),
    maxPower: maxOrZero(powers),
    avgCadence: average(cadences),
    maxCadence: maxOrZero(cadences),
    normalizedPower,
    intensityFactor,
    trainingStressScore,
    xPower,
    relativeIntensityGc,
    bikeStressScore,
    decouplingPct,
    trimp,
    hrTss,
    avgHr,
    maxHr,
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

  const xTicks = `<g class="xTicksGroup">${chart.xTicks.map((t) => `<g>
      <line class="gridline" x1="${t.px.toFixed(1)}" y1="${chart.plotTop}" x2="${t.px.toFixed(1)}" y2="${chart.plotBottom}" />
      <text class="tick" x="${t.px.toFixed(1)}" y="${chart.plotBottom + 16}" text-anchor="middle">${escapeHtml(formatTick(t.value, chart.xStep))}</text>
    </g>`).join('')}</g>`;

  const yTicks = `<g class="yTicksGroup">${chart.yTicks.map((t) => `<g>
      <line class="gridline" x1="${chart.plotLeft}" y1="${t.py.toFixed(1)}" x2="${chart.plotRight}" y2="${t.py.toFixed(1)}" />
      <text class="tick" x="${chart.plotLeft - 8}" y="${(t.py + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatTick(t.value, chart.yStep))}</text>
    </g>`).join('')}</g>`;

  const zoneThresholds = Array.isArray(options.zoneThresholds) ? options.zoneThresholds : null;
  const hasZoneLine = zoneThresholds && zoneThresholds.length >= 4;

  const lineSvg = hasZoneLine
    ? buildZoneSegmentPolylines(chart, zoneThresholds)
    : `<polyline class="${lineClass}" points="${chart.pathData}" />`;

  const compLineSvg = chart.compPathData
    ? `<polyline class="${lineClass}Comp" points="${chart.compPathData}" />`
    : '';

  // Crosshair markup is inert until the client script (chartInteractions) attaches listeners.
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
    ${markerSvg}
    ${xTicks}
    ${yTicks}
    <line class="axis" x1="${chart.plotLeft}" y1="${chart.plotBottom}" x2="${chart.plotRight}" y2="${chart.plotBottom}" />
    <line class="axis" x1="${chart.plotLeft}" y1="${chart.plotTop}" x2="${chart.plotLeft}" y2="${chart.plotBottom}" />
    ${compLineSvg}
    ${lineSvg}
    <text class="axisLabel axisLabelX" x="${(chart.plotLeft + chart.plotRight) / 2}" y="${chart.height - 4}" text-anchor="middle">${escapeHtml(xLabel)}</text>
    <text class="axisLabel axisLabelY" transform="translate(14 ${(chart.plotTop + chart.plotBottom) / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(yLabel)}</text>
    ${crosshairSvg}
  </svg>`;
}

// Compact client-side payload: raw series + plot geometry, so the browser can rescale without a round trip.
function buildChartClientPayload(chart, xUnit, yUnit, overlays) {
  if (!chart || !Array.isArray(chart.points) || chart.points.length < 2) {
    return null;
  }
  return {
    points: chart.points.map((p) => [roundTo(p.x, 4), roundTo(p.y, 3)]),
    plotLeft: chart.plotLeft,
    plotRight: chart.plotRight,
    plotTop: chart.plotTop,
    plotBottom: chart.plotBottom,
    xMin: chart.xMin,
    xMax: chart.xMax,
    yMin: chart.yMin,
    yMax: chart.yMax,
    width: chart.width,
    height: chart.height,
    xUnit,
    yUnit,
    overlays: overlays && Object.keys(overlays).length ? overlays : undefined,
  };
}

const OVERLAY_METRIC_LABELS = { grade: 'Grade', altitude: 'Altitude', speed: 'Speed', heart_rate: 'Heart Rate' };
const OVERLAY_METRIC_UNITS = { grade: '%', altitude: 'm', speed: 'km/h', heart_rate: 'bpm' };

// Computed once per activity and sliced per chart, so grade is derived at most once (reuses computeGrade).
function buildOverlayMetrics(records, maxPoints) {
  const hasStoredGrade = records.some((record) => Number.isFinite(asNumber(record?.grade)));
  const gradeSource = hasStoredGrade
    ? records
    : (() => {
      const grades = computeGrade(records);
      return records.map((record, index) => ({
        ...record,
        grade: grades[index] ? grades[index].grade * 100 : null,
      }));
    })();

  return {
    grade: extractXYPoints(gradeSource, 'distance', 'grade', maxPoints, {}),
    altitude: extractXYPoints(records, 'distance', 'altitude', maxPoints, { yTransform: (v) => v * 1000 }),
    speed: extractXYPoints(records, 'distance', 'speed', maxPoints, {}),
    heart_rate: extractXYPoints(records, 'distance', 'heart_rate', maxPoints, {}),
  };
}

// Every metric except the chart's own, and only when there is enough range to draw a line.
function buildOverlayOptions(overlayMetrics, ownKey) {
  const result = {};
  for (const key of Object.keys(overlayMetrics)) {
    if (key === ownKey) {
      continue;
    }
    const series = overlayMetrics[key];
    if (!series || series.points.length < 2 || !series.yValues.length) {
      continue;
    }
    const min = Math.min(...series.yValues);
    const max = Math.max(...series.yValues);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      continue;
    }
    result[key] = {
      points: series.points.map((p) => [roundTo(p.x, 4), roundTo(p.y, 2)]),
      min,
      max,
      label: OVERLAY_METRIC_LABELS[key] || key,
      unit: OVERLAY_METRIC_UNITS[key] || '',
    };
  }
  return result;
}

function renderOverlayControls(svgId, overlays) {
  const keys = Object.keys(overlays || {});
  if (!keys.length) {
    return '';
  }
  const items = keys.map((key) => `<label>
      <input type="checkbox" data-overlay-metric="${escapeHtml(key)}">
      ${escapeHtml(overlays[key].label)}<span class="overlayRange"></span>
    </label>`).join('');
  return `<div class="overlayControls" data-overlay-for="${escapeHtml(svgId)}">${items}</div>`;
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
      plotTop: margin.top + 8,
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
  const safeY = padYAxisRange(yMin, yMax);

  const plotLeft = margin.left;
  const plotRight = width - margin.right;
  const plotTop = margin.top + 8;
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

async function generateActivityAnalysis(dbPath, activityId, force = false) {
  return enqueueLlmTask(() => runActivityAnalysis(dbPath, activityId, force));
}

async function runActivityAnalysis(dbPath, activityId, force) {
  const numId = Number(activityId);
  if (!Number.isFinite(numId) || numId <= 0) {
    throw new Error(`Invalid activity ID: ${activityId}`);
  }

  if (!force) {
    const existing = await getCachedAnalysisForCurrentVersion(dbPath, numId);
    if (existing) {
      return existing;
    }
  }

  const current = await loadFitDataFromDb(dbPath, numId);
  if (!current) {
    throw new Error(`Activity ${numId} not found in database`);
  }

  const analysisData = await prepareAnalysisData(dbPath, current, numId);
  const summary = await getProgressSummaryFromDb(dbPath, numId);
  const hrConfig = await getHeartRateConfigForActivity(dbPath, analysisData.sessions?.[0]?.start_time);
  const previousAnalysis = (await getLatestAnalysisAnyVersion(dbPath, numId))?.text || null;
  const followUpHistory = await getAnalysisChatFromDb(dbPath, numId);
  const recentHistory = await getRecentAnalysesContext(dbPath, numId, analysisData.sessions?.[0]?.start_time);
  const prompt = generateAnalysisPrompt(
    analysisData, summary, hrConfig, previousAnalysis, followUpHistory, recentHistory, vscode.env.language
  );
  const analysis = await requestCopilotAnalysis(vscode, prompt, {
    vendor: getLanguageModelVendor(),
    onCompleted: (result) => logLlmRequest(dbPath, {
      activityId: numId,
      kind: 'analysis',
      warnings: segmentBudgetWarnings(analysisData),
      ...result,
    }),
  });
  await storeAnalysisInDb(dbPath, numId, analysis);

  return analysis;
}

// Overshooting the budget means the segmentation thresholds misfired; the list is logged, never truncated.
function segmentBudgetWarnings(analysisData) {
  const segments = Array.isArray(analysisData?.segments) ? analysisData.segments : [];
  if (!segments.length) {
    return [];
  }

  const rows = groupSimilarSegments(segments);
  const durationS = segments[segments.length - 1].endElapsed - segments[0].startElapsed;
  const maxLines = segmentLineBudget(durationS);
  return rows.length > maxLines
    ? [`Segment breakdown produced ${rows.length} lines for ${(durationS / 3600).toFixed(2)} h (budget ${maxLines}); review the segmentation thresholds.`]
    : [];
}

function getLlmLogConfig() {
  const config = vscode.workspace.getConfiguration('fitVisualizer');
  const retentionDays = Number(config.get('llmLogRetentionDays'));
  return {
    enabled: config.get('logLlmRequests') !== false,
    retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 0,
  };
}

function getLanguageModelVendor() {
  const vendor = vscode.workspace.getConfiguration('fitVisualizer').get('lmVendor');
  return typeof vendor === 'string' && vendor.trim() ? vendor.trim() : 'copilot';
}

async function logLlmRequest(dbPath, entry) {
  const { enabled, retentionDays } = getLlmLogConfig();
  if (!enabled || !dbPath) {
    return;
  }

  const logDir = path.join(path.dirname(dbPath), 'logs');
  await fs.mkdir(logDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const fileName = `${entry.activityId}-${timestamp.replace(/[:.]/g, '-')}-${entry.kind}.json`;
  const promptSummary = summarizePromptBlocks(entry.prompt);
  await fs.writeFile(path.join(logDir, fileName), JSON.stringify({
    timestamp,
    activityId: entry.activityId,
    kind: entry.kind,
    modelId: entry.modelId,
    analysisVersion: ANALYSIS_VERSION,
    promptChars: promptSummary.totalChars,
    promptBlocks: promptSummary.blocks,
    warnings: entry.warnings?.length ? entry.warnings : undefined,
    prompt: entry.prompt,
    response: entry.response ?? null,
    error: entry.error ?? null,
  }, null, 2));

  if (retentionDays && !llmLogCleanupDone) {
    llmLogCleanupDone = true;
    await pruneLlmLogs(logDir, retentionDays);
  }
}

async function pruneLlmLogs(logDir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    const names = await fs.readdir(logDir);
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(logDir, name);
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs < cutoff) {
        await fs.unlink(filePath);
      }
    }
  } catch {
    // Log housekeeping is best effort.
  }
}

async function reanalyzeOutdatedActivities() {
  const dbPath = await resolveActiveDbPath() || await selectDatabaseFolder();
  if (!dbPath) {
    return;
  }

  const rows = await getOutdatedAnalysisActivities(dbPath);
  const outdated = rows.filter((row) => row.analysisVersion != null);
  const missing = rows.filter((row) => row.analysisVersion == null);
  if (!rows.length) {
    vscode.window.showInformationMessage(`All analyses already use version ${ANALYSIS_VERSION}.`);
    return;
  }

  const choices = [];
  if (outdated.length) {
    choices.push({
      label: `Outdated analyses only (${outdated.length})`,
      detail: `Re-run Copilot for activities analyzed before version ${ANALYSIS_VERSION}.`,
      targets: outdated,
    });
  }
  choices.push({
    label: `Outdated and never analyzed (${rows.length})`,
    detail: `${outdated.length} outdated, ${missing.length} never analyzed.`,
    targets: rows,
  });

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Each activity costs one Copilot request; they run one at a time.',
  });
  if (!picked) {
    return;
  }

  const targets = picked.targets;
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Re-analyzing FIT activities',
    cancellable: true,
  }, async (progress, token) => {
    let done = 0;
    let failed = 0;
    let stoppedReason = null;
    let lastError = '';

    for (let index = 0; index < targets.length; index += 1) {
      if (token.isCancellationRequested) {
        stoppedReason = 'cancelled';
        break;
      }

      const target = targets[index];
      progress.report({
        message: `${index + 1}/${targets.length}: ${target.fileName}`,
        increment: index === 0 ? 0 : 100 / targets.length,
      });

      try {
        await generateActivityAnalysis(dbPath, target.id, true);
        done += 1;
      } catch (error) {
        failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
        // Further requests would fail the same way until the quota window resets.
        if (/rate limit/i.test(lastError)) {
          stoppedReason = 'rateLimited';
          break;
        }
      }
    }

    return { done, failed, stoppedReason, lastError, total: targets.length };
  });

  const suffix = result.stoppedReason === 'cancelled'
    ? ' Cancelled before finishing.'
    : result.stoppedReason === 'rateLimited'
      ? ' Stopped early: Copilot rate limit reached.'
      : result.failed
        ? ` Last error: ${result.lastError}`
        : '';
  vscode.window.showInformationMessage(
    `Re-analysis finished: ${result.done} of ${result.total} updated, ${result.failed} failed.${suffix}`
  );
}

async function prepareAnalysisData(dbPath, fitData, activityId) {
  const athleteProfile = await getAthleteProfile(dbPath, activityId);
  const session = fitData.sessions?.[0] || {};
  const hrConfig = await getHeartRateConfigForActivity(dbPath, session.start_time);
  const normalizedRecords = normalizeRecordSpeeds(fitData.records);
  const powerData = addEstimatedPowerWhenMissing(normalizedRecords, {
    riderMassKg: athleteProfile.riderMassKg,
    bikeMassKg: athleteProfile.bikeMassKg,
  });
  const summary = buildSummary(powerData.records, fitData.sessions, {
    ftp: athleteProfile.ftp,
    restingHeartRate: athleteProfile.restingHeartRate,
    sex: athleteProfile.sex,
    maxHeartRateForHrr: Number.isFinite(asNumber(hrConfig?.maxHeartRate))
      ? asNumber(hrConfig.maxHeartRate)
      : session.max_hr,
  });
  const athleteFtp = asNumber(athleteProfile.ftp);
  const segments = buildActivitySegments(powerData.records, {
    sport: session.sport,
    powerSource: powerData.source,
    thresholds: getSegmentationOptions(),
    athlete: {
      ftp: athleteFtp,
      restingHeartRate: athleteProfile.restingHeartRate,
      maxHeartRate: asNumber(hrConfig?.maxHeartRate),
    },
  });
  return {
    ...fitData,
    records: powerData.records,
    segments,
    sessions: [{
      ...session,
      avg_speed_kmh: summary.avgSpeed > 0 ? summary.avgSpeed : session.avg_speed_kmh,
      max_speed_kmh: summary.maxSpeed > 0 ? summary.maxSpeed : session.max_speed_kmh,
      avg_cadence: session.avg_cadence ?? (summary.avgCadence > 0 ? summary.avgCadence : null),
      avg_power: summary.avgPower,
      max_power: summary.maxPower,
      normalized_power: summary.normalizedPower,
      training_stress_score: summary.trainingStressScore,
      intensity_factor: summary.intensityFactor,
      xpower: summary.xPower,
      relative_intensity_gc: summary.relativeIntensityGc,
      bike_stress_score: summary.bikeStressScore,
      decoupling_pct: summary.decouplingPct,
      trimp: summary.trimp > 0 ? summary.trimp : session.trimp,
      hr_tss: summary.hrTss ?? (asNumber(session.hr_tss) > 0 ? session.hr_tss : null),
      ftp: Number.isFinite(athleteFtp) && athleteFtp > 0 ? athleteFtp : null,
      power_source: powerData.source,
    }, ...fitData.sessions.slice(1)],
  };
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
  const ftp = parseOptionalFtp(message.ftp);
  const wheelCircumferenceMm = parseOptionalWheelCircumference(message.wheelCircumferenceMm);

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
    if (athleteProfile || ftp != null || wheelCircumferenceMm != null) {
      upsertAthleteProfile(db, {
        sex: athleteProfile?.sex,
        age: athleteProfile?.age,
        restingHeartRate: athleteProfile?.restingHeartRate,
        riderMassKg: athleteProfile?.riderMassKg,
        bikeMassKg: athleteProfile?.bikeMassKg,
        ftp,
        wheelCircumferenceMm,
      }, now);
    }
    if (athleteProfile) {
      db.run(
        'UPDATE activities SET rider_mass_kg = ?, bike_mass_kg = ? WHERE id = ?',
        [
          Number.isFinite(athleteProfile.riderMassKg) ? athleteProfile.riderMassKg : null,
          Number.isFinite(athleteProfile.bikeMassKg) ? athleteProfile.bikeMassKg : null,
          activityId,
        ]
      );
    }
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
        COALESCE(MAX(max_hr), 0) AS max_session_hr,
        COALESCE((SELECT MAX(heart_rate) FROM records), 0) AS max_record_hr
      FROM activities
    `);
    stmt.step();
    const row = stmt.getAsObject();
    const observedMaxHeartRate = Math.max(Number(row.max_session_hr) || 0, Number(row.max_record_hr) || 0);
    stmt.free();
    stmt = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM activities) AS activity_count,
        (SELECT COUNT(*) FROM records) AS record_count,
        (SELECT COUNT(*) FROM records WHERE power IS NOT NULL AND elapsed_s IS NOT NULL AND power >= 0) AS timed_power_count,
        (SELECT COUNT(*) FROM records WHERE power IS NOT NULL AND power >= 0) AS power_count
    `);
    stmt.step();
    const counts = stmt.getAsObject();
    const activityCount = Number(counts.activity_count) || 0;
    const totalRecordCount = Number(counts.record_count) || 0;
    const validTimedPowerCount = Number(counts.timed_power_count) || 0;
    const validPowerCount = Number(counts.power_count) || 0;
    const useMeasuredPower = validTimedPowerCount > 0;
    stmt.free();
    stmt = db.prepare('SELECT id, rider_mass_kg, bike_mass_kg FROM activities');
    const activityMassById = new Map();
    while (stmt.step()) {
      const activity = stmt.getAsObject();
      activityMassById.set(activity.id, {
        riderMassKg: activity.rider_mass_kg,
        bikeMassKg: activity.bike_mass_kg,
      });
    }
    stmt.free();
    const recordStride = useMeasuredPower ? 1 : 5;
    stmt = db.prepare(`
      SELECT activity_id, record_index, elapsed_s AS elapsed_time, distance_km AS distance,
        speed_kmh AS speed, altitude_m AS altitude, power
      FROM records
      WHERE record_index % ${recordStride} = 0
      ORDER BY activity_id, record_index
    `);
    let currentActivityId = null;
    let currentRecords = [];
    let mmp = calculateMeanMaximalPower([]);
    let estimatedRideCount = 0;
    const mergeMmp = (records) => {
      const rideCurve = calculateMeanMaximalPower(records);
      for (let index = 0; index < mmp.length; index += 1) {
        mmp[index].power = Math.max(mmp[index].power, rideCurve[index].power);
      }
    };
    const finishRide = () => {
      if (!currentRecords.length) {
        return;
      }
      let recordsForMmp = currentRecords;
      if (!useMeasuredPower) {
        const masses = activityMassById.get(currentActivityId) || {};
        recordsForMmp = estimatePowerFromMotion(currentRecords, {
          riderMassKg: masses.riderMassKg != null && Number.isFinite(Number(masses.riderMassKg))
            ? Number(masses.riderMassKg) : athleteProfile.riderMassKg,
          bikeMassKg: masses.bikeMassKg != null && Number.isFinite(Number(masses.bikeMassKg))
            ? Number(masses.bikeMassKg) : athleteProfile.bikeMassKg,
        });
        if (recordsForMmp.length) {
          estimatedRideCount += 1;
        }
      }
      mergeMmp(recordsForMmp);
      currentRecords = [];
    };
    while (stmt.step()) {
      const record = stmt.getAsObject();
      if (currentActivityId !== null && record.activity_id !== currentActivityId) {
        finishRide();
      }
      currentActivityId = record.activity_id;
      currentRecords.push(record);
    }
    finishRide();
    const powerSource = useMeasuredPower ? 'measured' : estimatedRideCount > 0 ? 'estimated' : 'unavailable';
    const ftpCandidates = estimateFtpCandidates(mmp);
    const suggestion = calculateAutoHeartRateProfile({
      sex: athleteProfile.sex,
      age: athleteProfile.age,
      restingHeartRate: athleteProfile.restingHeartRate,
      observedMaxHeartRate,
    });
    suggestion.ftp = selectFtpEstimate(ftpCandidates);
    suggestion.mmp = mmp;
    suggestion.ftpCandidates = ftpCandidates;
    suggestion.mmpStatus = {
      activityCount,
      totalRecordCount,
      validPowerCount,
      validTimedPowerCount,
      powerSource,
      riderMassKg: athleteProfile.riderMassKg,
      bikeMassKg: athleteProfile.bikeMassKg,
    };
    const now = new Date().toISOString();
    upsertAthleteProfile(db, {
      sex: athleteProfile.sex,
      age: athleteProfile.age,
      restingHeartRate: athleteProfile.restingHeartRate,
      riderMassKg: athleteProfile.riderMassKg,
      bikeMassKg: athleteProfile.bikeMassKg,
    }, now);
    const requestedActivityId = Number(message?.id);
    if (Number.isInteger(requestedActivityId) && requestedActivityId > 0) {
      db.run(
        'UPDATE activities SET rider_mass_kg = ?, bike_mass_kg = ? WHERE id = ?',
        [
          Number.isFinite(athleteProfile.riderMassKg) ? athleteProfile.riderMassKg : null,
          Number.isFinite(athleteProfile.bikeMassKg) ? athleteProfile.bikeMassKg : null,
          requestedActivityId,
        ]
      );
    }
    await persistDatabase(db, dbPath);
    return suggestion;
  } finally {
    stmt?.free();
    db.close();
  }
}

function upsertAthleteProfile(db, profile, updatedAt) {
  db.run(`
    INSERT INTO athlete_profile (id, sex, age, resting_hr, ftp, rider_mass_kg, bike_mass_kg, wheel_circumference_mm, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sex = COALESCE(excluded.sex, athlete_profile.sex),
      age = COALESCE(excluded.age, athlete_profile.age),
      resting_hr = COALESCE(excluded.resting_hr, athlete_profile.resting_hr),
      ftp = COALESCE(excluded.ftp, athlete_profile.ftp),
      rider_mass_kg = COALESCE(excluded.rider_mass_kg, athlete_profile.rider_mass_kg),
      bike_mass_kg = COALESCE(excluded.bike_mass_kg, athlete_profile.bike_mass_kg),
      wheel_circumference_mm = COALESCE(excluded.wheel_circumference_mm, athlete_profile.wheel_circumference_mm),
      updated_at = excluded.updated_at
  `, [
    profile?.sex ?? null,
    Number.isFinite(asNumber(profile?.age)) ? Math.round(asNumber(profile.age)) : null,
    Number.isFinite(asNumber(profile?.restingHeartRate)) ? Math.round(asNumber(profile.restingHeartRate)) : null,
    Number.isFinite(asNumber(profile?.ftp)) ? Math.round(asNumber(profile.ftp)) : null,
    Number.isFinite(asNumber(profile?.riderMassKg)) ? asNumber(profile.riderMassKg) : null,
    Number.isFinite(asNumber(profile?.bikeMassKg)) ? asNumber(profile.bikeMassKg) : null,
    Number.isFinite(asNumber(profile?.wheelCircumferenceMm)) ? asNumber(profile.wheelCircumferenceMm) : null,
    updatedAt,
  ]);
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
  const riderMassRaw = String(message.riderMassKg ?? '').trim();
  const bikeMassRaw = String(message.bikeMassKg ?? '').trim();
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
  const riderMassKg = riderMassRaw === '' ? NaN : Number(riderMassRaw);
  const bikeMassKg = bikeMassRaw === '' ? NaN : Number(bikeMassRaw);
  if (riderMassRaw !== '' && (!Number.isFinite(riderMassKg) || riderMassKg < 30 || riderMassKg > 250)) {
    throw new Error('Rider mass must be between 30 and 250 kg.');
  }
  if (bikeMassRaw !== '' && (!Number.isFinite(bikeMassKg) || bikeMassKg < 3 || bikeMassKg > 50)) {
    throw new Error('Bike mass must be between 3 and 50 kg.');
  }
  return {
    sex,
    age: Math.round(age),
    restingHeartRate: Math.round(restingHeartRate),
    riderMassKg,
    bikeMassKg,
  };
}

function parseOptionalFtp(value) {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const ftp = Number(value);
  if (!Number.isFinite(ftp) || ftp < 80 || ftp > 500) {
    throw new Error('FTP must be between 80 and 500 watts.');
  }
  return Math.round(ftp);
}

function parseOptionalWheelCircumference(value) {
  if (value == null || String(value).trim() === '') {
    return null;
  }
  const mm = Number(value);
  if (!Number.isFinite(mm) || mm < 1000 || mm > 2500) {
    throw new Error('Wheel circumference must be between 1000 and 2500 mm.');
  }
  return roundTo(mm, 1);
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

async function getCachedAnalysisForCurrentVersion(dbPath, activityId) {
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

// Any stored analysis stays useful for display and as prompt context, even after a version bump.
async function getLatestAnalysisAnyVersion(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare('SELECT analysis_text, analysis_version FROM activity_analysis WHERE activity_id = ? ORDER BY analysis_version DESC LIMIT 1');
    stmt.bind([activityId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      const version = asNumber(row.analysis_version);
      return {
        text: row.analysis_text,
        version: Number.isFinite(version) ? version : 0,
      };
    }
    return null;
  } finally {
    stmt?.free();
    db.close();
  }
}

// Analyses of *other*, earlier activities, so the model sees a trend instead of judging each ride in a vacuum.
async function getRecentAnalysesContext(dbPath, activityId, referenceDate, windowDays = 30) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  const reference = toSqlStr(referenceDate);
  if (!reference) {
    db.close();
    return [];
  }

  const columns = `a.id AS id, a.start_time AS start_time, a.total_distance_km AS total_distance_km,
      a.total_timer_s AS total_timer_s, a.training_stress_score AS training_stress_score,
      aa.analysis_text AS analysis_text, aac.chat_json AS chat_json`;
  const from = `FROM activities a
      JOIN activity_analysis aa ON aa.activity_id = a.id
      LEFT JOIN activity_analysis_chat aac ON aac.activity_id = a.id`;

  const read = (sql, params) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      let chatCount = 0;
      try {
        const parsed = JSON.parse(row.chat_json || '[]');
        chatCount = Array.isArray(parsed) ? parsed.filter((entry) => entry?.role === 'user').length : 0;
      } catch {
        chatCount = 0;
      }
      rows.push({
        activityId: Number(row.id),
        startTime: row.start_time,
        distanceKm: row.total_distance_km,
        durationS: row.total_timer_s,
        trainingStressScore: row.training_stress_score,
        analysisText: row.analysis_text,
        chatCount,
      });
    }
    stmt.free();
    return rows;
  };

  try {
    const recent = read(
      `SELECT ${columns} ${from}
       WHERE a.id != ? AND a.start_time >= date(?, '-${Number(windowDays) || 30} days') AND a.start_time < ?
       ORDER BY a.start_time ASC`,
      [activityId, reference, reference]
    );
    if (recent.length) {
      return recent;
    }

    return read(
      `SELECT ${columns} ${from}
       WHERE a.id != ? AND a.start_time < ?
       ORDER BY a.start_time DESC
       LIMIT 1`,
      [activityId, reference]
    );
  } finally {
    db.close();
  }
}

async function getOutdatedAnalysisActivities(dbPath) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    // Chronological order matters: an activity's prompt may cite analyses of earlier activities.
    stmt = db.prepare(`
      SELECT a.id AS id, a.file_name AS file_name, aa.analysis_version AS analysis_version
      FROM activities a
      LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE aa.activity_id IS NULL OR aa.analysis_version < ?
      ORDER BY a.start_time IS NULL, a.start_time, a.id
    `);
    stmt.bind([ANALYSIS_VERSION]);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const version = asNumber(row.analysis_version);
      rows.push({
        id: Number(row.id),
        fileName: row.file_name || `Activity ${row.id}`,
        analysisVersion: Number.isFinite(version) ? version : null,
      });
    }
    return rows;
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
      all_prior AS (
        SELECT activities.*
        FROM activities, selected
        WHERE (
          datetime(activities.start_time) < datetime(selected.start_time)
          OR (datetime(activities.start_time) = datetime(selected.start_time) AND activities.id < selected.id)
        )
      ),
      prior AS (
        SELECT all_prior.*
        FROM all_prior, selected
        WHERE selected.total_distance_km > 0
          AND all_prior.total_distance_km BETWEEN
            selected.total_distance_km * ? AND selected.total_distance_km * ?
      )
      SELECT
        (SELECT COUNT(*) FROM prior) AS total_activities,
        (SELECT total_distance_km * ? FROM selected) AS comparison_min_distance_km,
        (SELECT total_distance_km * ? FROM selected) AS comparison_max_distance_km,
        (SELECT COALESCE(SUM(total_distance_km), 0) FROM prior) AS total_distance_km,
        (SELECT COALESCE(SUM(total_timer_s) / 3600.0, 0) FROM prior) AS total_hours,
        (SELECT COALESCE(AVG(avg_speed_kmh), 0) FROM prior WHERE avg_speed_kmh > 0) AS avg_speed_kmh,
        (SELECT COALESCE(AVG(COALESCE(manual_avg_hr, avg_hr)), 0) FROM prior
          WHERE COALESCE(manual_avg_hr, avg_hr) > 0) AS avg_heart_rate,
        (SELECT COALESCE(MAX(COALESCE(manual_max_hr, max_hr)), 0) FROM prior) AS max_recorded_heart_rate,
        (SELECT COUNT(*) FROM all_prior
          WHERE datetime(start_time) >= datetime((SELECT start_time FROM selected), '-7 days')) AS recent_activity_count,
        (SELECT COALESCE(SUM(total_distance_km), 0) FROM all_prior
          WHERE datetime(start_time) >= datetime((SELECT start_time FROM selected), '-7 days')) AS weekly_distance_km,
        (SELECT COALESCE(AVG(avg_speed_kmh), 0) FROM all_prior
          WHERE datetime(start_time) >= datetime((SELECT start_time FROM selected), '-7 days')
            AND avg_speed_kmh > 0) AS weekly_avg_speed_kmh,
        'N/A' AS trend_speed,
        'N/A' AS trend_heart_rate,
        (SELECT start_time FROM prior ORDER BY datetime(start_time) DESC, id DESC LIMIT 1) AS last_activity_date,
        (SELECT COALESCE(MAX(max_speed_kmh), 0) FROM prior) AS best_speed_kmh,
        (SELECT COALESCE(MAX(total_ascent_m), 0) FROM prior) AS best_elevation_m,
        (SELECT MIN(100.0, COUNT(*) * 100.0 / 16.0) FROM all_prior
          WHERE datetime(start_time) >= datetime((SELECT start_time FROM selected), '-28 days')) AS consistency_pct
    `);
    stmt.bind([
      activityId,
      COMPARABLE_DISTANCE_MIN_RATIO,
      COMPARABLE_DISTANCE_MAX_RATIO,
      COMPARABLE_DISTANCE_MIN_RATIO,
      COMPARABLE_DISTANCE_MAX_RATIO,
    ]);
    stmt.step();
    const summary = stmt.getAsObject();
    stmt.free();
    stmt = db.prepare(`
      WITH selected AS (
        SELECT start_time, total_distance_km
        FROM activities
        WHERE id = ?
      )
      SELECT activities.avg_speed_kmh, COALESCE(activities.manual_avg_hr, activities.avg_hr) AS avg_hr, activities.start_time
      FROM activities, selected
      WHERE (
        datetime(activities.start_time) < datetime(selected.start_time)
        OR (datetime(activities.start_time) = datetime(selected.start_time) AND activities.id < ?)
      )
        AND selected.total_distance_km > 0
        AND activities.total_distance_km BETWEEN selected.total_distance_km * ? AND selected.total_distance_km * ?
      ORDER BY datetime(activities.start_time) ASC, activities.id ASC
    `);
    stmt.bind([
      activityId,
      activityId,
      COMPARABLE_DISTANCE_MIN_RATIO,
      COMPARABLE_DISTANCE_MAX_RATIO,
    ]);
    const prior = [];
    while (stmt.step()) {
      prior.push(stmt.getAsObject());
    }
    summary.trend_speed = calculateProgressTrend(prior, 'avg_speed_kmh', 'km/h');
    summary.trend_heart_rate = calculateProgressTrend(prior, 'avg_hr', 'bpm');
    return summary;
  } finally {
    stmt?.free();
    db.close();
  }
}

function calculateProgressTrend(activities, field, unit) {
  const values = activities
    .map((activity) => Number(activity[field]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 4) {
    return 'insufficient data';
  }
  const midpoint = Math.floor(values.length / 2);
  const earlier = average(values.slice(0, midpoint));
  const recent = average(values.slice(midpoint));
  if (!Number.isFinite(earlier) || earlier <= 0 || !Number.isFinite(recent)) {
    return 'insufficient data';
  }
  const changePct = ((recent - earlier) / earlier) * 100;
  const direction = changePct > 2 ? 'rising' : changePct < -2 ? 'falling' : 'stable';
  return `${direction} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%, ${unit})`;
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

function appendChatTurn(messages, role, content) {
  const safeRole = role === 'assistant' ? 'assistant' : 'user';
  const text = String(content || '').trim();
  if (!text) {
    return Array.isArray(messages) ? messages : [];
  }
  const next = Array.isArray(messages) ? messages.slice() : [];
  next.push({ role: safeRole, content: text, ts: new Date().toISOString() });
  return next.slice(-ANALYSIS_CHAT_HISTORY_LIMIT);
}

async function getAnalysisChatFromDb(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare('SELECT chat_json FROM activity_analysis_chat WHERE activity_id = ?');
    stmt.bind([activityId]);
    if (!stmt.step()) {
      return [];
    }
    const raw = stmt.getAsObject().chat_json;
    try {
      const parsed = JSON.parse(String(raw || '[]'));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
        .map((entry) => ({
          role: entry.role,
          content: String(entry.content || ''),
          ts: entry.ts ? String(entry.ts) : null,
        }))
        .filter((entry) => entry.content.trim().length > 0)
        .slice(-ANALYSIS_CHAT_HISTORY_LIMIT);
    } catch {
      return [];
    }
  } finally {
    stmt?.free();
    db.close();
  }
}

async function storeAnalysisChatInDb(dbPath, activityId, messages) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const now = new Date().toISOString();
    const trimmed = (Array.isArray(messages) ? messages : []).slice(-ANALYSIS_CHAT_HISTORY_LIMIT);
    db.run(`
      INSERT INTO activity_analysis_chat (activity_id, chat_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        chat_json = excluded.chat_json,
        updated_at = excluded.updated_at
    `, [activityId, JSON.stringify(trimmed), now]);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function appendActivityChatTurn(dbPath, activityId, userText) {
  return enqueueLlmTask(async () => {
    const existing = await getAnalysisChatFromDb(dbPath, activityId);
    const withUser = appendChatTurn(existing, 'user', userText);
    const assistantReply = await runActivityChatReply(dbPath, activityId, withUser, userText);
    const nextChat = appendChatTurn(withUser, 'assistant', assistantReply);
    await storeAnalysisChatInDb(dbPath, activityId, nextChat);
    return nextChat;
  });
}

async function runActivityChatReply(dbPath, activityId, history, userQuestion) {
  const current = await loadFitDataFromDb(dbPath, activityId);
  if (!current) {
    throw new Error(`Activity ${activityId} not found in database`);
  }
  const analysisData = await prepareAnalysisData(dbPath, current, activityId);
  const summary = await getProgressSummaryFromDb(dbPath, activityId);
  const hrConfig = await getHeartRateConfigForActivity(dbPath, analysisData.sessions?.[0]?.start_time);
  const baseAnalysis = (await getLatestAnalysisAnyVersion(dbPath, activityId))?.text || null;
  const prompt = generateAnalysisChatPrompt(
    analysisData, summary, hrConfig, baseAnalysis, history, userQuestion, vscode.env.language
  );
  return requestCopilotAnalysis(vscode, prompt, {
    vendor: getLanguageModelVendor(),
    onCompleted: (result) => logLlmRequest(dbPath, { activityId: Number(activityId), kind: 'chat', ...result }),
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
