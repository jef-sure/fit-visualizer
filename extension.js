const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateAnalysisPrompt, generateAnalysisChatPrompt, requestCopilotAnalysis, summarizePromptBlocks } = require('./analysis');
const { localizeGlossary } = require('./glossary');
const { formatUi, localizeUi } = require('./ui-strings');
const { buildCartesianGeometry, buildDistanceMarkers, buildTicks, formatTick, padRange, padYAxisRange } = require('./chart-geometry');
const { computeElevationGainLoss, computeRouteDistanceKm, computeStats, extractGpsPoints, extractXYPoints } = require('./chart-data');
const { buildSummary } = require('./activity-summary');
const { buildGpsRoute: buildGpsRouteFromModule, buildLineChart: buildLineChartFromModule } = require('./chart-model');
const { createChartSvgRenderer } = require('./chart-svg');
const {
  buildChartClientPayload: buildChartClientPayloadFromModule,
  buildOverlayMetrics: buildOverlayMetricsFromModule,
  buildOverlayOptions: buildOverlayOptionsFromModule,
} = require('./chart-overlays');
const {
  loadGeneratedTranslationBundle,
  parseGeneratedBundle,
  saveGeneratedTranslationBundle,
  translationMessages,
  validateTranslationBundle,
} = require('./dynamic-localization');
const { registerCommands } = require('./commands');
const { renderActivityBrowserHtml, renderActivityContentHtml } = require('./activity-webview');
const { ensureDatabaseSchema } = require('./database-schema');
const { fileExists, getFitUris, getParsedLaps, parseFitFile } = require('./fit-files');
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
  toDateOnly,
  toSqlStr,
} = require('./utils');

const { renderGpsRouteSvg, renderOverlayControls, renderScaledLineChartSvg } = createChartSvgRenderer({
  buildDistanceMarkers,
  escapeHtml,
  formatTick,
  getHrZoneIndex: getHrZoneIndex,
});

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
    addAndBrowseManualActivity,
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

async function addAndBrowseManualActivity() {
  const dbPath = await resolveActiveDbPath() || await selectDatabaseFolder();
  if (!dbPath) {
    vscode.window.showInformationMessage('No database folder selected.');
    return;
  }

  // Prompt user for input
  const startTimeStr = await vscode.window.showInputBox({
    prompt: 'Activity start time (YYYY-MM-DD HH:MM)',
    placeHolder: '2026-09-01 12:00',
  });
  if (!startTimeStr) return;

  let startTime;
  try {
    const parsed = new Date(startTimeStr.replace(' ', 'T'));
    startTime = parsed.toISOString();
  } catch {
    vscode.window.showErrorMessage('Invalid date format. Use YYYY-MM-DD HH:MM');
    return;
  }

  const sport = await vscode.window.showQuickPick(
    ['cycling', 'running', 'other'],
    { placeHolder: 'Select sport' }
  );
  if (!sport) return;

  const distanceStr = await vscode.window.showInputBox({
    prompt: 'Total distance (km)',
    placeHolder: '20.0',
  });
  if (!distanceStr) return;

  const durationStr = await vscode.window.showInputBox({
    prompt: 'Duration (seconds)',
    placeHolder: '3600',
  });
  if (!durationStr) return;

  const avgHrStr = await vscode.window.showInputBox({
    prompt: 'Average heart rate (bpm)',
    placeHolder: '140',
  });

  const maxHrStr = await vscode.window.showInputBox({
    prompt: 'Maximum heart rate (bpm)',
    placeHolder: '165',
  });

  const elevGainStr = await vscode.window.showInputBox({
    prompt: 'Elevation gain (m, optional)',
    placeHolder: '0',
  });

  // Parse and validate
  const distanceKm = parseFloat(distanceStr);
  const durationS = parseInt(durationStr, 10);
  const avgHr = avgHrStr ? parseFloat(avgHrStr) : null;
  const maxHr = maxHrStr ? parseFloat(maxHrStr) : null;
  const elevGainM = elevGainStr ? parseFloat(elevGainStr) : null;

  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    vscode.window.showErrorMessage('Distance must be a positive number');
    return;
  }
  if (!Number.isFinite(durationS) || durationS <= 0) {
    vscode.window.showErrorMessage('Duration must be a positive number');
    return;
  }

  try {
    const db = await getDb(dbPath);
    const activityId = createManualActivity(db, {
      startTime,
      sport,
      durationS,
      distanceKm,
      avgHr: Number.isFinite(avgHr) ? avgHr : null,
      maxHr: Number.isFinite(maxHr) ? maxHr : null,
      elevGainM: Number.isFinite(elevGainM) ? elevGainM : null,
    });
    db.close();

    await rememberDatabasePath(dbPath);
    await openActivityBrowser(extensionContextRef, dbPath, activityId);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create manual activity: ${err.message}`);
  }
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
    const segments = buildDisplaySegments(data, athleteProfile, hrConfig);
    const generatedTranslations = await loadGeneratedTranslationBundle(
      extensionContextRef?.globalStorageUri?.fsPath, vscode.env.language
    );
    panel.webview.html = renderActivityBrowserHtml(
      panel.webview, context.extensionUri,
      activities, selId, data, selCompId, comp, hrConfig, athleteProfile, analysis, analysisChat, wheelCalibration, generatedTranslations, segments, ANALYSIS_VERSION
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

function buildDisplaySegments(fitData, athleteProfile, heartRateConfig) {
  // Guard: skip segmentation for manual activities (no records)
  if (!fitData || !Array.isArray(fitData.records) || fitData.records.length < 2) return [];
  
  const records = normalizeRecordSpeeds(fitData.records);
  const powerData = addEstimatedPowerWhenMissing(records, {
    riderMassKg: athleteProfile?.riderMassKg,
    bikeMassKg: athleteProfile?.bikeMassKg,
  });
  const session = fitData.sessions?.[0] || {};
  return buildActivitySegments(powerData.records, {
    sport: session.sport,
    powerSource: powerData.source,
    thresholds: getSegmentationOptions(),
    athlete: {
      ftp: asNumber(athleteProfile?.ftp),
      restingHeartRate: athleteProfile?.restingHeartRate,
      maxHeartRate: asNumber(heartRateConfig?.maxHeartRate),
    },
  });
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
      laps: parseStoredLaps(activity.laps_json),
      _activityId: Number(activity.id),
      _fileName: activity.file_name,
      _source: activity.source || 'fit',
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
  const laps = getParsedLaps(fitData);
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
    records.length, laps.length, JSON.stringify(laps),
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
      total_calories, record_count, lap_count, laps_json, rider_mass_kg, bike_mass_kg
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
      record_count=excluded.record_count, lap_count=excluded.lap_count, laps_json=excluded.laps_json,
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

function parseStoredLaps(raw) {
  try {
    const laps = JSON.parse(String(raw || '[]'));
    return Array.isArray(laps) ? laps : [];
  } catch {
    return [];
  }
}

/**
 * Create a manual activity (without FIT records) from user input.
 * @param {sql.Database} db
 * @param {Object} activity - { startTime, sport, durationS, distanceKm, avgHr, maxHr, elevGainM }
 * @returns {number} activityId
 */
function createManualActivity(db, activity) {
  const {
    startTime,    // ISO string
    sport,        // 'cycling', 'running', or 'other'
    durationS,    // total_elapsed_s
    distanceKm,
    avgHr,
    maxHr,
    elevGainM,
  } = activity;

  // Synthetic file path for manual entries: manual://2026-09-01T120000Z
  const manualFilePath = `manual://${new Date().toISOString().replace(/[:.]/g, '')}`;
  const nowIso = new Date().toISOString();
  
  // Compute average speed from distance and duration
  const avgSpeedKmh = (Number.isFinite(distanceKm) && Number.isFinite(durationS) && durationS > 0)
    ? distanceKm / (durationS / 3600)
    : null;

  const upsertValues = [
    manualFilePath,
    'Manual Activity',
    nowIso,
    startTime || null,
    sport || null,
    null, // sub_sport
    distanceKm || null,
    elevGainM || null,
    null, // total_descent_m
    durationS || null,
    durationS || null, // total_elapsed_s = total_timer_s for manual
    avgHr || null,
    maxHr || null,
    avgSpeedKmh, // computed avg_speed_kmh
    null, // max_speed_kmh
    null, null, // avg_cadence, max_cadence
    null, null, null, // avg_power, max_power, normalized_power
    null, null, null, null, null, null, null, null, // TSS, IF, xPower, relIntensity, bikeStress, decoupling, hrTss, trimp
    null, null, null, // training effects
    null, // total_calories
    0, // record_count (no records for manual activity)
    0, // lap_count
    JSON.stringify([]), // laps_json
    null, // rider_mass_kg
    null, // bike_mass_kg
    'manual', // source
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
      total_calories, record_count, lap_count, laps_json, rider_mass_kg, bike_mass_kg, source
    ) VALUES (${upsertValues.map(() => '?').join(',')})
    ON CONFLICT(file_path) DO UPDATE SET
      file_name=excluded.file_name, imported_at=excluded.imported_at,
      start_time=excluded.start_time, sport=excluded.sport,
      total_distance_km=excluded.total_distance_km,
      total_ascent_m=excluded.total_ascent_m,
      total_elapsed_s=excluded.total_elapsed_s,
      avg_hr=excluded.avg_hr, max_hr=excluded.max_hr,
      avg_speed_kmh=excluded.avg_speed_kmh,
      laps_json=excluded.laps_json
  `);

  upsertStmt.run(upsertValues);
  upsertStmt.free();

  const idStmt = db.prepare('SELECT id FROM activities WHERE file_path = ?');
  idStmt.bind([manualFilePath]);
  if (!idStmt.step()) {
    idStmt.free();
    throw new Error(`Failed to create manual activity`);
  }
  const row = idStmt.getAsObject();
  idStmt.free();
  const activityId = Number(row.id);

  return activityId;
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
    preferCheapModel: getPreferCheapAnalysisModel(),
    cheapModelMarkers: getCheapModelMarkers(),
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

function getPreferCheapAnalysisModel() {
  return vscode.workspace.getConfiguration('fitVisualizer').get('preferCheapAnalysisModel') === true;
}

function getCheapModelMarkers() {
  const markers = vscode.workspace.getConfiguration('fitVisualizer').get('cheapModelMarkers');
  return Array.isArray(markers) ? markers.filter((marker) => typeof marker === 'string') : undefined;
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
