const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildSegmentContext, generateAnalysisPromptParts, generateAnalysisChatPrompt, generateComparisonPrompt, requestCopilotAnalysis, summarizePromptBlocks } = require('./analysis');
const { localizeGlossary } = require('./glossary');
const { formatUi, localizeUi } = require('./ui-strings');
const { buildCartesianGeometry, buildDistanceMarkers, buildTicks, formatTick, padRange, padYAxisRange } = require('./chart-geometry');
const { computeElevationGainLoss, computeRouteDistanceKm, computeStats, extractGpsPoints, extractXYPoints } = require('./chart-data');
const { buildSummary } = require('./activity-summary');
const { attachActivityZones, buildTrainingContext } = require('./training-context');
const { buildGpsRoute: buildGpsRouteFromModule, buildLineChart: buildLineChartFromModule } = require('./chart-model');
const { createChartSvgRenderer } = require('./chart-svg');
const {
  buildChartClientPayload: buildChartClientPayloadFromModule,
  buildOverlayMetrics: buildOverlayMetricsFromModule,
  buildOverlayOptions: buildOverlayOptionsFromModule,
} = require('./chart-overlays');
const {
  loadBundledTranslationBundle,
  loadGeneratedTranslationBundle,
  parseGeneratedBundle,
  saveGeneratedTranslationBundle,
  translationMessages,
  validateTranslationBundle,
} = require('./dynamic-localization');
const { registerCommands } = require('./commands');
const { MODEL_PRICE_CACHE_KEY, restoreModelPriceCache, updateModelPrices } = require('./model-pricing');
const { displayLanguage, renderActivityBrowserHtml, renderActivityContentHtml, buildTranslationPrompt } = require('./activity-webview');
const { ensureDatabaseSchema } = require('./database-schema');
const { applyHeartRateProfileUpsert, planHeartRateProfileTidy, readHeartRateProfiles } = require('./heart-rate-profiles');
const { createManualActivity } = require('./manual-activity');
const { deriveUtcOffsetS, detectOffsetChange, formatOffsetLabel, localClock, localDate } = require('./activity-time');
const { reconcileSessionElapsed } = require('./activity-session-checks');
const { classifySession, countHardEfforts, longestSustainedZ4Seconds } = require('./session-class');
const { FEATURES_VERSION, athleteKey, featureCacheKey, hrProfileKey, isFeatureRowFresh, settingsKey } = require('./activity-features');
const { assignRoute, computeCheckpoints, ensureRouteElevationProfile, ensureRouteFeatures, readRouteAssignments, readRouteCard, describeCheckpointVerdict, readRouteNote, setRouteName, setRouteNote, summarizeCheckpoints, summarizeRoutePattern } = require('./route-store');
const { parseAnalysisSummary, parseStoredSummary } = require('./analysis-summary');
const { inferNotesPreFill, readActivityNotes, readAllActivityNotes, saveActivityNotes } = require('./activity-notes');
const { computeDataQualityFlags } = require('./data-quality');
const { computeSegmentStretches, describeRouteFeatures } = require('./route-features');
const { buildAltitudeRide, computeAltitudeFlags, detectAltitudeSettling, mirrorConsensusProfile } = require('./altitude-quality');
const { buildRouteSignature } = require('./route-match');

function safeParseJson(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
const { fileExists, getFitUris, getParsedLaps, parseFitFile } = require('./fit-files');
const {
  calculateAutoHeartRateProfile,
  calculatePeakHeartRates,
  computeHeartRateZones,
  estimateLactateThresholdHeartRate,
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
  calculateRobustTrend,
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
const ANALYSIS_VERSION = 27;
const ANALYSIS_CHAT_HISTORY_LIMIT = 24;
const COMPARABLE_DISTANCE_MIN_RATIO = 0.75;
const COMPARABLE_DISTANCE_MAX_RATIO = 1.25;

// sql.js rewrites the whole database file, so overlapping analyses would clobber each other.
let llmTaskQueue = Promise.resolve();
let llmLogCleanupDone = false;
let analysisWarningChannel = null;
let analysisWarningNotified = false;

// Segment-budget diagnostics used to live only in the JSON log; now they also go to the Output
// channel. Only a large overshoot (thresholds probably misfired) triggers the once-per-session
// notification; small overshoots are informational and silent beyond the log line.
function reportAnalysisWarning(message, severity = 'info') {
  try {
    analysisWarningChannel ??= vscode.window.createOutputChannel('FIT Visualizer: Analysis');
    analysisWarningChannel.appendLine(`[${severity}] ${new Date().toISOString()} ${message}`);
    if (severity === 'warn' && !analysisWarningNotified) {
      analysisWarningNotified = true;
      vscode.window.showWarningMessage(
        `${message} See the "FIT Visualizer: Analysis" output for later notes.`,
        'Open Output'
      ).then((choice) => {
        if (choice === 'Open Output' && analysisWarningChannel) {
          analysisWarningChannel.show();
        }
      });
    }
  } catch {
    // Diagnostics must never break an analysis.
  }
}

function enqueueLlmTask(task) {
  const result = llmTaskQueue.then(task, task);
  llmTaskQueue = result.then(() => undefined, () => undefined);
  return result;
}

function activate(context) {
  extensionContextRef = context;
  restoreModelPriceCache(context.globalState.get(MODEL_PRICE_CACHE_KEY));
  scheduleDerivedFeatureAutoRebuild();
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
    selectAnalysisModel,
    selectDatabaseFolder,
    showActivityBrowserInPanel,
    tidyHeartRateProfiles,
    updateModelPriceTable,
  }));
}

async function tidyHeartRateProfiles() {
  const dbPath = await resolveActiveDbPath() || await selectDatabaseFolder();
  if (!dbPath) {
    return;
  }
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let rows;
  try {
    rows = readHeartRateProfiles(db);
  } finally {
    db.close();
  }
  const { redundant, flips } = planHeartRateProfileTidy(rows);
  if (!redundant.length) {
    vscode.window.showInformationMessage(
      flips.length
        ? `No duplicate heart-rate profiles found. Max-HR changes: ${flips.join('; ')}.`
        : 'No duplicate heart-rate profiles found.'
    );
    return;
  }
  const detail = redundant.map((date) => `${date} (duplicate of the previous profile)`).join('\n');
  const pick = await vscode.window.showWarningMessage(
    `Remove ${redundant.length} duplicate heart-rate profile${redundant.length > 1 ? 's' : ''}?\n${detail}`,
    { modal: true },
    'Remove duplicates'
  );
  if (pick !== 'Remove duplicates') {
    return;
  }
  const db2 = await openDatabase(SQL, dbPath);
  try {
    for (const date of redundant) {
      db2.run('DELETE FROM heart_rate_profiles WHERE effective_date = ?', [date]);
    }
    await persistDatabase(db2, dbPath);
  } finally {
    db2.close();
  }
  vscode.window.showInformationMessage(`Removed ${redundant.length} duplicate heart-rate profile${redundant.length > 1 ? 's' : ''}.`);
}


// After an update that changes the derived-feature version, the cache and routes are rebuilt once,
// silently in the background — the user never runs a command for it. Runs only for the remembered
// database (the one this workspace actually uses) and only when a rebuild is actually needed.
let derivedFeatureAutoRebuildStarted = false;
function scheduleDerivedFeatureAutoRebuild() {
  if (derivedFeatureAutoRebuildStarted) return;
  derivedFeatureAutoRebuildStarted = true;
  setTimeout(() => {
    rebuildDerivedFeatures({ silent: true }).catch(() => {
      // A failed background rebuild leaves the lazy path in charge; nothing to report.
    });
  }, 1500);
}

async function rebuildDerivedFeatures({ silent = false, skipStaleCheck = false, reason } = {}) {
  const dbPath = silent ? await resolveActiveDbPath() : (await resolveActiveDbPath() || await selectDatabaseFolder());
  if (!dbPath) {
    return;
  }
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    if (silent && !skipStaleCheck && !needsDerivedFeatureRebuild(db)) {
      return;
    }
    // Routes are re-derived in chronological order so the earliest ride defines each route.
    db.run('DELETE FROM activity_features');
    db.run('DELETE FROM activity_routes');
    db.run('DELETE FROM routes');
    const ordered = (db.exec("SELECT id FROM activities WHERE source != 'manual' ORDER BY datetime(start_time), id")[0]?.values || [])
      .map((value) => Number(value[0]));
    const rebuild = async (report) => {
      let done = 0;
      for (const id of ordered) {
        try {
          ensureFeaturesForActivity(db, id);
        } catch {
          // A single broken activity must not abort the rebuild.
        }
        done += 1;
        report?.(`${done}/${ordered.length}`);
        // Yield so a background rebuild does not block the extension host.
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    if (silent) {
      await rebuild();
    } else {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'FIT Visualizer: rebuilding derived features', cancellable: false },
        (_progress, token) => rebuild((message) => { if (!token.isCancellationRequested) _progress.report({ message }); })
      );
    }
    await persistDatabase(db, dbPath);
    if (!silent && reason !== 'indexing') {
      vscode.window.showInformationMessage(`Derived features rebuilt for ${ordered.length} activities.`);
    }
  } finally {
    db.close();
  }
}

// A rebuild is needed when any stored feature row predates the current derived-feature version
// (or routes exist without assignments). Fresh databases skip it entirely.
function needsDerivedFeatureRebuild(db) {
  const activities = Number(db.exec("SELECT COUNT(*) FROM activities WHERE source != 'manual'")[0]?.values?.[0]?.[0] || 0);
  if (!activities) return false;
  const stale = Number(db.exec(`SELECT COUNT(*) FROM activity_features WHERE features_version != ${FEATURES_VERSION}`)[0]?.values?.[0]?.[0] || 0);
  const fresh = Number(db.exec(`SELECT COUNT(*) FROM activity_features WHERE features_version = ${FEATURES_VERSION}`)[0]?.values?.[0]?.[0] || 0);
  return stale > 0 || fresh < activities;
}

async function getRouteCard(dbPath, activityId) {
  if (!activityId) return null;
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const card = readRouteCard(db, activityId);
    if (!card) return null;
    const described = card.features ? describeRouteFeatures(card.features, card.relation === 'reversed' ? 'reversed' : 'same') : null;
    return {
      routeId: card.routeId, name: card.name, note: card.note, rideCount: card.rideCount, relation: card.relation,
      lengthKm: card.features?.lengthKm ?? null, ascentM: card.features?.ascentM ?? null, descentM: card.features?.descentM ?? null,
      climbs: described?.climbs ?? [],
    };
  } finally {
    db.close();
  }
}

async function updateActivityNotes(dbPath, activityId, input) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    saveActivityNotes(db, activityId, input);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function updateRoute(dbPath, { routeId, name, note }) {
  const id = Number(routeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid route.');
  }
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    setRouteName(db, id, name);
    setRouteNote(db, id, String(note || '').slice(0, 1000));
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

// Eager variant of the lazy ensure path: computes and stores features for one activity.
function ensureFeaturesForActivity(db, activityId) {
  const readRows = (sql, params) => {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  };
  const row = readRows('SELECT * FROM activities WHERE id = ?', [activityId])[0];
  if (!row || row.source === 'manual') return;
  const profile = getAthleteProfileFromDbConnection(db);
  const segmentationOptions = getSegmentationOptions();
  const powerModelOptions = getPowerModelOptions();
  const settingsHash = settingsKey({ segmentation: segmentationOptions, powerModel: powerModelOptions });
  const hrConfig = attachRestingHeartRate(getProfileHeartRateConfig(db, row.start_time), profile);
  const key = featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash, hrProfile: hrConfig, athlete: profile });
  const records = readRows('SELECT * FROM records WHERE activity_id = ? ORDER BY record_index', [row.id]).map((record) => ({
    elapsed_time: record.elapsed_s, distance: record.distance_km, speed: record.speed_kmh,
    altitude: record.altitude_m == null ? null : record.altitude_m / 1000,
    heart_rate: record.heart_rate, power: record.power, cadence: record.cadence,
    position_lat: record.latitude, position_long: record.longitude,
  }));
  const normalized = normalizeRecordSpeeds(records);
  const power = addEstimatedPowerWhenMissing(normalized, {
    riderMassKg: row.rider_mass_kg ?? profile.riderMassKg,
    bikeMassKg: row.bike_mass_kg ?? profile.bikeMassKg, ...powerModelOptions,
  });
  const segments = buildActivitySegments(power.records, { sport: row.sport, powerSource: power.source,
    thresholds: segmentationOptions, athlete: { ftp: profile.ftp, restingHeartRate: profile.restingHeartRate,
      maxHeartRate: hrConfig?.maxHeartRate } });
  const summary = buildSummary(power.records, [{ total_timer_s: row.total_timer_s, total_elapsed_s: row.total_elapsed_s, total_distance: row.total_distance_km }], {
    restingHeartRate: profile.restingHeartRate, sex: profile.sex,
    maxHeartRateForHrr: asNumber(hrConfig?.maxHeartRate) || row.max_hr,
    heartRateThresholds: hrConfig?.thresholds, lactateThresholdHeartRate: hrConfig?.lthr ?? undefined,
    powerSource: power.source,
  });
  const zones = computeHeartRateZones(power.records, hrConfig?.maxHeartRate, hrConfig?.thresholds,
    { restingHeartRate: asNumber(profile.restingHeartRate) });
  const peakHr = calculatePeakHeartRates(power.records);
  const timerS = asNumber(row.total_timer_s);
  const sessionClass = buildSessionClassForActivity(power.records, { total_timer_s: timerS }, hrConfig, profile, segments);
  assignRoute(db, { activityId: row.id, signature: buildRouteSignature(records), createdAt: row.start_time });
  db.run(`
    INSERT INTO activity_features (
      activity_id, features_version, settings_hash, hr_profile_key, athlete_key, feature_cache_key, computed_at,
      segments_json, zones_json, peak_hr_json, session_class_json, trimp, hr_tss, elapsed_coverage_pct
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET
      features_version=excluded.features_version, settings_hash=excluded.settings_hash,
      hr_profile_key=excluded.hr_profile_key, athlete_key=excluded.athlete_key,
      feature_cache_key=excluded.feature_cache_key, computed_at=excluded.computed_at,
      segments_json=excluded.segments_json, zones_json=excluded.zones_json,
      peak_hr_json=excluded.peak_hr_json, session_class_json=excluded.session_class_json,
      trimp=excluded.trimp, hr_tss=excluded.hr_tss, elapsed_coverage_pct=excluded.elapsed_coverage_pct
  `, [row.id, FEATURES_VERSION, settingsHash, hrProfileKey(hrConfig), athleteKey(profile), key, new Date().toISOString(),
    JSON.stringify(segments.map((segment) => ({ ...segment, routePoints: undefined }))),
    JSON.stringify(zones), JSON.stringify(peakHr), JSON.stringify(sessionClass),
    summary.trimp ?? null, summary.hrTss ?? null,
    zones?.enabled && timerS > 0 ? 100 * zones.totalSeconds / timerS : null]);
}

async function countFitActivities(dbPath) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const rows = db.exec("SELECT id FROM activities WHERE source != 'manual'")[0]?.values || [];
    const ids = new Set(rows.map((value) => Number(value[0])));
    return { ids, maxId: rows.reduce((max, value) => Math.max(max, Number(value[0])), 0) };
  } finally {
    db.close();
  }
}

async function updateModelPriceTable() {
  const cache = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t('Updating Copilot model prices'),
    cancellable: false,
  }, () => updateModelPrices(extensionContextRef.globalState));
  vscode.window.showInformationMessage(vscode.l10n.t(
    'Model prices updated: {0} models ({1}).', cache.prices.length, cache.updatedAt.slice(0, 10)
  ));
}

// Lets the athlete pick which model answers one-off analyses: the QuickPick lists the models the
// current vendor actually offers, plus a "default/cheapest" entry that clears the pinned id. The
// pin overrides the cheapest-model heuristic, so prompt experiments stay reproducible.
async function selectAnalysisModel() {
  const vendor = getLanguageModelVendor();
  let models = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor });
  } catch {
    models = [];
  }
  if (!models.length) {
    vscode.window.showWarningMessage(vscode.l10n.t('No language models are available for vendor "{0}".', vendor));
    return;
  }
  const current = getAnalysisModelId();
  const defaultLabel = vscode.l10n.t('Default ({0})', getPreferCheapAnalysisModel() ? 'cheapest' : 'first');
  const items = [
    { label: defaultLabel, description: vscode.l10n.t('clear the pinned model'), modelId: null },
    ...models.map((model) => ({
      label: model.name || model.id,
      description: model.id === model.name ? undefined : model.id,
      detail: current === model.id || current === model.name ? vscode.l10n.t('currently pinned') : undefined,
      modelId: model.id,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select the language model for one-off activity analysis'),
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  await vscode.workspace.getConfiguration('fitVisualizer').update(
    'analysisModelId', picked.modelId, vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(vscode.l10n.t(
    'Analysis model: {0}.', picked.modelId ? picked.label : defaultLabel
  ));
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
  // Indexing is required whenever the stored schema changes anyway, so it refreshes the
  // derived-feature cache and routes in the same run: one action covers both. The background
  // version-triggered rebuild still covers format changes after extension updates.
  await rebuildDerivedFeatures({ silent: false, skipStaleCheck: true, reason: 'indexing' });
  vscode.window.showInformationMessage(vscode.l10n.t('FIT DB index complete: {0} indexed, {1} failed.', result.saved, result.failed));
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
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t('Indexing FIT files'),
    cancellable: false,
  }, async (progress) => {
    for (const fitUri of fitUris) {
      progress.report({ message: vscode.l10n.t('{0}/{1}: {2}', saved + failed + 1, fitUris.length, path.basename(fitUri.fsPath)) });
      try {
        const parsed = await parseFitFile(fitUri.fsPath);
        await saveFitToLocalDb(fitUri.fsPath, parsed, dbPath);
        saved += 1;
        output.appendLine(`Indexed: ${fitUri.fsPath}`);
      } catch (error) {
        failed += 1;
        output.appendLine(`Failed: ${fitUri.fsPath} -> ${error instanceof Error ? error.message : String(error)}`);
      }
      progress.report({ increment: 100 / fitUris.length });
    }
  });
  output.appendLine(vscode.l10n.t('FIT DB index complete: {0} indexed, {1} failed.', saved, failed));
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

  let db;
  try {
    const SQL = await getSqlJs();
    db = await openDatabase(SQL, dbPath);
    const activityId = createManualActivity(db, {
      startTime,
      sport,
      durationS,
      distanceKm,
      avgHr: Number.isFinite(avgHr) ? avgHr : null,
      maxHr: Number.isFinite(maxHr) ? maxHr : null,
      elevGainM: Number.isFinite(elevGainM) ? elevGainM : null,
    });
    await persistDatabase(db, dbPath);

    await rememberDatabasePath(dbPath);
    await openActivityBrowser(extensionContextRef, dbPath, activityId);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create manual activity: ${err.message}`);
  } finally {
    db?.close();
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

  const activeTabPath = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input?.uri?.fsPath;
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
  let translationJustGenerated = false;
  async function render(selId, selCompId) {
    const data = selId ? await loadFitDataFromDb(dbPath, selId) : null;
    const comp = selCompId ? await loadFitDataFromDb(dbPath, selCompId) : null;
    const athleteProfile = await getAthleteProfile(dbPath, selId);
    const wheelCalibration = await getWheelCalibrationRecommendation(dbPath);
    const analysis = selId ? await getLatestAnalysisAnyVersion(dbPath, selId) : null;
    const analysisChat = selId ? await getAnalysisChatFromDb(dbPath, selId) : [];
    const comparisons = selId ? await getActivityComparisonsForActivity(dbPath, selId) : [];
    const routeCard = selId ? await getRouteCard(dbPath, selId) : null;
    // The Session Notes form pre-fills with what the model inferred for this ride; fields the
    // user has already declared are merged field by field in the webview.
    if (data) data.inferredNotes = inferNotesPreFill(data.inferredNotes);
    const hrConfig = data
      ? await getHeartRateConfigForActivity(dbPath, data.sessions?.[0]?.start_time)
      : getHeartRateConfig();
    const segments = buildDisplaySegments(data, athleteProfile, hrConfig);
    const bundledTranslations = await loadBundledTranslationBundle(
      context.extensionUri.fsPath, vscode.env.language
    );
    const generatedTranslations = bundledTranslations || await loadGeneratedTranslationBundle(
      extensionContextRef?.globalStorageUri?.fsPath, vscode.env.language
    );
    panel.webview.html = renderActivityBrowserHtml(
      panel.webview, context.extensionUri,
      activities, selId, data, selCompId, comp, hrConfig, athleteProfile, analysis, analysisChat, wheelCalibration, generatedTranslations, segments, ANALYSIS_VERSION, comparisons, translationJustGenerated, routeCard
    );
    translationJustGenerated = false;
    if (selId) {
      panel.webview.postMessage({ type: 'analysisChatState', id: Number(selId), messages: analysisChat });
    }
  }

  panel.webview.onDidReceiveMessage(async (msg) => {
    // Every branch that names an activity expects a positive integer id; anything else
    // (or a missing compId where one is required) is rejected up front instead of
    // turning into NaN lookups deep inside the DB layer.
    const asActivityId = (value) => {
      const id = Number(value);
      return Number.isInteger(id) && id > 0 ? id : null;
    };
    const hasCompId = msg.compId != null && msg.compId !== '';
    if (['selectActivity', 'analyzeActivity', 'analysisChatTurn', 'updateActivityHeartRate',
      'updateHeartRateProfile', 'updateRoute', 'updateActivityNotes', 'autoCalculateHeartRateProfile', 'compareActivitiesAI', 'removeComparison']
      .includes(msg.type)) {
      if (!asActivityId(msg.id)) {
        panel.webview.postMessage({ type: 'analysisError', id: Number(msg.id), error: 'Invalid activity id.' });
        return;
      }
    }
    if (['compareActivitiesAI', 'removeComparison'].includes(msg.type) && !asActivityId(msg.compId)) {
      panel.webview.postMessage({ type: 'comparisonError', id: Number(msg.id), compId: Number(msg.compId), error: 'Invalid comparison activity id.' });
      return;
    }
    if (msg.type === 'selectActivity') {
      await render(msg.id ? Number(msg.id) : null, msg.compId ? Number(msg.compId) : null);
    } else if (msg.type === 'generateTranslations') {
      const locale = String(vscode.env.language || '').replace(/_/g, '-');
      const language = displayLanguage(locale);
      const ui = localizeUi(vscode.l10n.t);
      let confirmed;
      try {
        // Modal dialogs can fail to render under some sandboxed VS Code installs (e.g. snap) and then
        // hang forever; a plain toast notification uses the same code path as the working reload prompt.
        const prompt = formatUi(ui.generateTranslationsConfirm, language);
        confirmed = await withTimeout(
          vscode.window.showInformationMessage(prompt, ui.generate),
          60000,
          'The confirmation prompt did not appear or was not answered within 1 minute.'
        );
      } catch (error) {
        const msg = error instanceof Error && error.message ? error.message : String(error);
        const finalMsg = msg || 'Translation generation was cancelled or failed.';
        panel.webview.postMessage({ type: 'translationError', error: finalMsg });
        return;
      }
      if (confirmed !== ui.generate) {
        panel.webview.postMessage({ type: 'translationCancelled' });
        return;
      }
      try {
        const prompt = buildTranslationPrompt(locale);
        // vscode.lm can hang indefinitely on a missed permission prompt; a visible progress toast plus
        // a hard timeout turns that silent stall into a diagnosable error instead of a dead "Generating...".
        const response = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: formatUi(ui.generateTranslations, language) },
          () => withTimeout(
            requestCopilotAnalysis(vscode, prompt, {
              vendor: getLanguageModelVendor(),
              onCompleted: (result) => logLlmRequest(dbPath, { activityId: `locale-${locale}`, kind: 'translation', ...result }),
            }),
            120000,
            'Copilot did not respond within 2 minutes. Check for a hidden VS Code notification asking to allow FIT Visualizer to use the language model, then try again.'
          )
        );
        const bundle = validateTranslationBundle(parseGeneratedBundle(response));
        await saveGeneratedTranslationBundle(extensionContextRef?.globalStorageUri?.fsPath, locale, bundle);
        translationJustGenerated = true;
        await render(msg.id ? Number(msg.id) : selectedId, msg.compId ? Number(msg.compId) : null);
        const reload = await vscode.window.showInformationMessage(
          formatUi(ui.translationGenerated, language), 'Reload Window'
        );
        if (reload === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (error) {
        const msg = error instanceof Error && error.message ? error.message : String(error);
        const finalMsg = msg || 'Translation generation failed.';
        await logLlmRequest(dbPath, { activityId: `locale-${locale}`, kind: 'translation', error: finalMsg });
        panel.webview.postMessage({ type: 'translationError', error: finalMsg });
      }
    } else if (msg.type === 'analyzeActivity') {
      try {
        const requestedActivityId = Number(msg.id);
        const { text: analysis, warnings, modelId, analyzedAt } = await generateActivityAnalysis(dbPath, requestedActivityId, msg.force);
        panel.webview.postMessage({ type: 'analysisResult', id: requestedActivityId, analysis, warnings, modelId, analyzedAt });
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
    } else if (msg.type === 'compareActivitiesAI') {
      try {
        const requestedActivityId = Number(msg.id);
        const comparedActivityId = Number(msg.compId);
        const comparison = await generateActivityComparison(dbPath, requestedActivityId, comparedActivityId, msg.force);
        panel.webview.postMessage({ type: 'comparisonResult', id: requestedActivityId, compId: comparedActivityId, comparison });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'comparisonError', id: Number(msg.id), compId: Number(msg.compId), error: errorMsg });
      }
    } else if (msg.type === 'removeComparison') {
      try {
        const requestedActivityId = Number(msg.id);
        const comparedActivityId = Number(msg.compId);
        await removeActivityComparisonFromDb(dbPath, requestedActivityId, comparedActivityId);
        panel.webview.postMessage({ type: 'comparisonRemoved', id: requestedActivityId, compId: comparedActivityId });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'comparisonError', id: Number(msg.id), compId: Number(msg.compId), error: errorMsg });
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
    } else if (msg.type === 'updateActivityNotes') {
      try {
        await updateActivityNotes(dbPath, Number(msg.id), msg);
        await render(Number(msg.id), msg.compId ? Number(msg.compId) : null);
        vscode.window.showInformationMessage('Session notes saved. Re-analyze to apply them to the AI analysis.');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'notesError', error: errorMsg });
      }
    } else if (msg.type === 'updateRoute') {
      try {
        await updateRoute(dbPath, msg);
        await render(Number(msg.id), msg.compId ? Number(msg.compId) : null);
        vscode.window.showInformationMessage('Route saved.');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        panel.webview.postMessage({ type: 'routeError', error: errorMsg });
      }
    } else if (msg.type === 'updateHeartRateProfile') {
      try {
        const { notice } = await updateHeartRateProfile(dbPath, msg);
        await render(Number(msg.id), msg.compId ? Number(msg.compId) : null);
        vscode.window.showInformationMessage(notice || 'Dated heart-rate profile saved.');
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
    ...getPowerModelOptions(),
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


// The parsed SUMMARY tail of the latest stored analysis (any version): the model's own inference
// for this ride, used for pre-filling notes and for the revisable block when the user saved none.
function readLatestSummaryForActivity(db, activityId) {
  const stmt = db.prepare('SELECT summary_json FROM activity_analysis WHERE activity_id = ? ORDER BY analysis_version DESC, updated_at DESC LIMIT 1');
  try {
    stmt.bind([activityId]);
    if (!stmt.step()) return null;
    return parseStoredSummary(stmt.getAsObject().summary_json);
  } catch {
    return null;
  } finally {
    stmt.free();
  }
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
        utc_offset_s:          activity.utc_offset_s,
        offset_source:         activity.offset_source,
        device_ascent_m:       activity.device_ascent_m,
        device_descent_m:      activity.device_descent_m,
        device_moving_time_s:  activity.device_moving_time_s,
        device_elapsed_s:      activity.device_elapsed_s,
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
        _device_avg_hr:        activity.avg_hr,
        _device_max_hr:        activity.max_hr,
        _reportedAvgHr:        activity.source !== 'manual' && (activity.manual_avg_hr != null || activity.manual_max_hr != null)
          ? activity.manual_avg_hr : null,
        _reportedMaxHr:        activity.source !== 'manual' && (activity.manual_avg_hr != null || activity.manual_max_hr != null)
          ? activity.manual_max_hr : null,
        _source:               activity.source || 'fit',
        _hasManualHrOverrides: activity.source === 'manual'
          || activity.manual_avg_hr != null
          || activity.manual_max_hr != null,
      }],
      laps: parseStoredLaps(activity.laps_json),
      sessionNotes: readActivityNotes(db, activityId),
      inferredNotes: readLatestSummaryForActivity(db, activityId),
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

function totalChanges(db) {
  return Number(db.exec('SELECT total_changes()')[0].values[0][0]);
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

  const hrProfile = getProfileHeartRateConfig(db, sessions[0]?.start_time);
  const summary = buildSummary(records, sessions, {
    ftp: athleteProfile.ftp,
    restingHeartRate: athleteProfile.restingHeartRate,
    sex: athleteProfile.sex,
    maxHeartRateForHrr: hrProfile?.maxHeartRate ?? sessions[0]?.max_hr,
    heartRateThresholds: hrProfile?.thresholds,
    powerSource: records.some((record) => Number.isFinite(asNumber(record.power))) ? 'measured' : 'unavailable',
  });
  const session = sessions[0] || {};
  const sessionCalories = asNumber(session.total_calories);
  const { utcOffsetS, offsetSource } = deriveUtcOffsetS({
    activityTimestamp: fitData.activity?.timestamp,
    activityLocalTimestamp: fitData.activity?.local_timestamp,
    fileName: path.basename(filePath),
    sessionStartTime: session.start_time,
  });
  // The CYCPLUS session elapsed can cover a device left running; records are the ground truth then.
  const timestamps = records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
  const recordSpanS = timestamps.length >= 2 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 1000 : null;
  const gapSeconds = records.length >= 2
    ? Math.max(0, recordSpanS - (records.at(-1).elapsed_time - records[0].elapsed_time)) : 0;
  const elapsed = reconcileSessionElapsed({
    sessionElapsedS: asNumber(session.total_elapsed_time),
    recordSpanS,
    gapSeconds: Number.isFinite(gapSeconds) ? gapSeconds : 0,
  });
  // fit-file-parser converts session ascent/descent to the configured length unit (km); metres are
  // what everything else expects, so a value in the km range is scaled back.
  const toDeviceMetres = (value) => {
    const number = asNumber(value);
    if (!Number.isFinite(number) || number === 0) return number === 0 ? 0 : NaN;
    return number < 5 ? number * 1000 : number;
  };
  const deviceAscentM = toDeviceMetres(session.total_ascent);
  const deviceDescentM = toDeviceMetres(session.total_descent);
  const nowIso = new Date().toISOString();
  const upsertValues = [
    filePath, path.basename(filePath), nowIso,
    toSqlStr(session.start_time) || null,
    toSqlStr(session.sport) || null,
    toSqlStr(session.sub_sport) || null,
    summary.distanceKm, summary.elevationGainM || null, summary.elevationLossM || null,
    asNumber(session.total_timer_time),
    elapsed.elapsedS,
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
    Number.isFinite(utcOffsetS) ? utcOffsetS : null,
    offsetSource,
    Number.isFinite(deviceAscentM) && deviceAscentM > 0 ? deviceAscentM : null,
    Number.isFinite(deviceDescentM) && deviceDescentM > 0 ? deviceDescentM : null,
    (() => { const moving = asNumber(session.total_moving_time); return Number.isFinite(moving) && moving > 0 ? moving : null; })(),
    elapsed.deviceElapsedS,
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
      total_calories, record_count, lap_count, laps_json, rider_mass_kg, bike_mass_kg,
      utc_offset_s, offset_source, device_ascent_m, device_descent_m, device_moving_time_s, device_elapsed_s
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
      bike_mass_kg=COALESCE(activities.bike_mass_kg, excluded.bike_mass_kg),
      utc_offset_s=excluded.utc_offset_s, offset_source=excluded.offset_source,
      device_ascent_m=excluded.device_ascent_m, device_descent_m=excluded.device_descent_m,
      device_moving_time_s=excluded.device_moving_time_s, device_elapsed_s=excluded.device_elapsed_s
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
    const gradePct = grade && grade.dt > 0 && grade.dt <= 30 && grade.distanceM > 0
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

function getPowerModelOptions() {
  const config = vscode.workspace.getConfiguration('fitVisualizer.powerModel');
  const read = (key) => {
    const value = Number(config.get(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  return {
    dragArea: read('dragArea'),
    rollingCoefficient: read('rollingResistance'),
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

// Evidence assembled where the records exist; the classifier itself stays pure and testable.
function buildSessionClassForActivity(records, session, hrConfig, athleteProfile, segments) {
  if (!Number.isFinite(asNumber(hrConfig?.maxHeartRate))) {
    return { label: 'undetermined', confidence: 'low', reasons: ['no dated heart-rate profile'], alternatives: [] };
  }
  const zones = computeHeartRateZones(records, hrConfig.maxHeartRate, hrConfig.thresholds,
    { restingHeartRate: asNumber(athleteProfile?.restingHeartRate) });
  if (!zones.enabled || !(zones.totalSeconds > 0)) {
    return { label: 'undetermined', confidence: 'low', reasons: ['no usable heart-rate samples'], alternatives: [] };
  }
  const timerS = asNumber(session.total_timer_s);
  const lthr = estimateLactateThresholdHeartRate(hrConfig.maxHeartRate, hrConfig.thresholds,
    asNumber(athleteProfile?.restingHeartRate), hrConfig?.lthr);
  const peaks = calculatePeakHeartRates(records);
  const peak20 = peaks.find((peak) => peak.seconds === 1200);
  const z4Floor = Array.isArray(hrConfig.thresholds) ? hrConfig.thresholds[2] : 0.8 * hrConfig.maxHeartRate;
  const z5Floor = Array.isArray(hrConfig.thresholds) ? hrConfig.thresholds[3] : 0.9 * hrConfig.maxHeartRate;
  const hrDurations = estimateRecordDurationsForZones(records);
  const samples = records.map((record, index) => ({
    seconds: hrDurations[index],
    atOrAboveZ4: asNumber(record.heart_rate) >= z4Floor,
    atOrAboveZ5: asNumber(record.heart_rate) >= z5Floor,
  }));
  return classifySession({
    zoneSeconds: zones.zones.map((zone) => zone.seconds),
    hrCoveragePct: timerS > 0 ? 100 * zones.totalSeconds / timerS : null,
    timerS,
    peak20VsLthr: peak20 && lthr ? peak20.bpm / lthr : null,
    sustainedZ4Seconds: longestSustainedZ4Seconds(samples),
    hardEfforts: countHardEfforts(samples),
    stopSeconds: (Array.isArray(segments) ? segments : [])
      .filter((segment) => segment.type === 'stopped')
      .reduce((sum, segment) => sum + (asNumber(segment.durationS) || 0), 0),
  });
}

// estimateRecordDurations is private to heart-rate.js; the same rule (deltas capped at 30 s,
// median fallback) is all the classifier needs and stays local to this adapter.
function estimateRecordDurationsForZones(records) {
  const elapsed = (Array.isArray(records) ? records : []).map((record) => asNumber(record.elapsed_time));
  const durations = new Array(elapsed.length).fill(1);
  const valid = [];
  for (let index = 1; index < elapsed.length; index += 1) {
    const delta = elapsed[index] - elapsed[index - 1];
    if (Number.isFinite(delta) && delta > 0 && delta <= 30) {
      durations[index - 1] = delta;
      valid.push(delta);
    }
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const fallback = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
  durations[elapsed.length - 1] = fallback;
  return durations.map((value) => (Number.isFinite(value) && value > 0 && value <= 30 ? value : fallback));
}

function attachRestingHeartRate(config, athleteProfile) {  return { ...config, restingHeartRate: asNumber(athleteProfile?.restingHeartRate) || null };
}

async function getHeartRateConfigForActivity(dbPath, startTime, athleteProfile = null) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    return attachRestingHeartRate(getProfileHeartRateConfig(db, startTime), athleteProfile);
  } finally {
    db.close();
  }
}

function profileRowToConfig(profile) {
  const thresholds = [profile.zone2_start, profile.zone3_start, profile.zone4_start, profile.zone5_start];
  const lthr = asNumber(profile.lthr);
  return {
    maxHeartRate: Number(profile.max_hr),
    thresholds: thresholds.every((value) => Number.isFinite(value)) ? thresholds.map(Number) : null,
    effectiveDate: String(profile.effective_date),
    source: 'dated profile',
    lthr: Number.isFinite(lthr) && lthr > 0 ? lthr : null,
    observedMaxSource: parseObservedMaxSource(safeParseJson(profile.observed_max_source_json, null)),
  };
}

function getProfileHeartRateConfig(db, startTime) {
  const activityDate = toDateOnly(startTime);
  let stmt;
  try {
    stmt = db.prepare(activityDate
      ? 'SELECT effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start, lthr, observed_max_source_json FROM heart_rate_profiles WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1'
      : 'SELECT effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start, lthr, observed_max_source_json FROM heart_rate_profiles ORDER BY effective_date DESC LIMIT 1');
    if (activityDate) {
      stmt.bind([activityDate]);
    }
    if (stmt.step()) {
      const row = stmt.getAsObject();
      const maxHr = asNumber(row.max_hr);
      if (Number.isFinite(maxHr) && maxHr > 0) {
        return profileRowToConfig(row);
      }
    }
    return getHeartRateConfig();
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

// Builds the analysis prompt exactly as a real run would (also used by the prompt evaluation command).
async function buildAnalysisPromptForActivity(dbPath, numId) {
  const current = await loadFitDataFromDb(dbPath, numId);
  if (!current) {
    throw new Error(`Activity ${numId} not found in database`);
  }

  const analysisData = await prepareAnalysisData(dbPath, current, numId);
  const summary = await getProgressSummaryFromDb(dbPath, numId, analysisData);
  const hrConfig = await getHeartRateConfigForActivity(dbPath, analysisData.sessions?.[0]?.start_time, await getAthleteProfile(dbPath, numId));
  const hasManualHrOverrides = Boolean(analysisData.sessions?.[0]?._hasManualHrOverrides);
  const previousResult = hasManualHrOverrides ? null : await getLatestAnalysisAnyVersion(dbPath, numId);
  const previousAnalysis = previousResult?.version >= ANALYSIS_VERSION ? previousResult.text : null;
  const storedChat = await getAnalysisChatFromDb(dbPath, numId);
  const followUpHistory = previousResult?.version >= ANALYSIS_VERSION
    ? storedChat
    : storedChat.filter((entry) => entry?.role === 'user');
  const recentHistory = summary.trainingContext?.recentHistory || [];
  const { instructions, data } = generateAnalysisPromptParts(
    analysisData, summary, hrConfig, previousAnalysis, followUpHistory, recentHistory, vscode.env.language
  );
  return { prompt: [instructions, data], analysisData };
}

async function runActivityAnalysis(dbPath, activityId, force) {
  const numId = Number(activityId);
  if (!Number.isFinite(numId) || numId <= 0) {
    throw new Error(`Invalid activity ID: ${activityId}`);
  }

  if (!force) {
    const existing = await getCachedAnalysisForCurrentVersion(dbPath, numId);
    if (existing) {
      return { text: existing.text, modelId: existing.modelId, analyzedAt: existing.analyzedAt, warnings: [] };
    }
  }

  const { prompt, analysisData } = await buildAnalysisPromptForActivity(dbPath, numId);
  let usedModelId;
  const rawAnalysis = await requestCopilotAnalysis(vscode, prompt, {
    vendor: getLanguageModelVendor(),
    preferCheapModel: getPreferCheapAnalysisModel(),
    modelId: getAnalysisModelId(),
    cheapModelMarkers: getCheapModelMarkers(),
    onCompleted: (result) => {
      usedModelId = result.modelId;
      return logLlmRequest(dbPath, {
        activityId: numId,
        kind: 'analysis',
        warnings: segmentBudgetWarnings(analysisData),
        ...result,
      });
    },
  });
  // The SUMMARY tail feeds later prompts; the displayed text never carries it.
  const { body: analysis, summary: analysisSummary } = parseAnalysisSummary(rawAnalysis);
  await storeAnalysisInDb(dbPath, numId, analysis, analysisSummary, usedModelId);
  const warnings = segmentBudgetWarnings(analysisData);
  for (const warning of warnings) {
    reportAnalysisWarning(`Activity ${numId}: ${warning.text}`, warning.severity);
  }

  return { text: analysis, modelId: usedModelId || null, analyzedAt: new Date().toISOString(), warnings: warnings.map(({ severity, text }) => `${severity}: ${text}`) };
}

// The line budget is a rough guideline for prompt size, never a truncation cap. A small overshoot
// is normal on varied terrain and only worth a log line; a large one suggests the thresholds
// actually misfired and deserves the once-per-session notification.
function segmentBudgetWarnings(analysisData) {
  const segments = Array.isArray(analysisData?.segments) ? analysisData.segments : [];
  if (!segments.length) {
    return [];
  }

  // Count the rows the prompt actually shows; the folded short-stop summary is not a segment row.
  const rows = buildSegmentContext(segments).displayRows.filter((row) => row.time);
  const durationS = segments[segments.length - 1].endElapsed - segments[0].startElapsed;
  const maxLines = segmentLineBudget(durationS);
  if (!(rows.length > maxLines)) {
    return [];
  }
  const overshoot = rows.length / maxLines;
  if (overshoot > 1.5) {
    return [{
      severity: 'warn',
      text: `Segment breakdown produced ${rows.length} lines for ${(durationS / 3600).toFixed(2)} h (guideline ${maxLines}); nothing was truncated. If this repeats, review the segmentation thresholds.`,
    }];
  }
  return [{
    severity: 'info',
    text: `Segment breakdown: ${rows.length} lines for ${(durationS / 3600).toFixed(2)} h (guideline ${maxLines}); nothing was truncated.`,
  }];
}

function getLlmLogConfig() {
  const config = vscode.workspace.getConfiguration('fitVisualizer');
  const retentionDays = Number(config.get('llmLogRetentionDays'));
  const chatRetentionDays = Number(config.get('llmChatLogRetentionDays'));
  return {
    enabled: config.get('logLlmRequests') !== false,
    retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 0,
    chatRetentionDays: Number.isFinite(chatRetentionDays) && chatRetentionDays > 0 ? chatRetentionDays : 0,
  };
}

function getLanguageModelVendor() {
  const vendor = vscode.workspace.getConfiguration('fitVisualizer').get('lmVendor');
  return typeof vendor === 'string' && vendor.trim() ? vendor.trim() : 'copilot';
}

// Guards against vscode.lm calls that hang on a missed consent prompt instead of resolving or rejecting.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getPreferCheapAnalysisModel() {
  return vscode.workspace.getConfiguration('fitVisualizer').get('preferCheapAnalysisModel') !== false;
}

function getAnalysisModelId() {
  const modelId = String(vscode.workspace.getConfiguration('fitVisualizer').get('analysisModelId') || '').trim();
  return modelId || undefined;
}

function getCheapModelMarkers() {
  const markers = vscode.workspace.getConfiguration('fitVisualizer').get('cheapModelMarkers');
  return Array.isArray(markers) ? markers.filter((marker) => typeof marker === 'string') : undefined;
}

async function logLlmRequest(dbPath, entry) {
  const { enabled, retentionDays, chatRetentionDays } = getLlmLogConfig();
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
    overBudget: promptSummary.overBudget?.length ? promptSummary.overBudget : undefined,
    prompt: entry.prompt,
    response: entry.response ?? null,
    error: entry.error ?? null,
  }, null, 2));

  if ((retentionDays || chatRetentionDays) && !llmLogCleanupDone) {
    llmLogCleanupDone = true;
    await pruneLlmLogs(logDir, retentionDays, chatRetentionDays);
  }
}

// Conversations are rarer and more valuable for debugging than one-off analyses,
// so they survive longer by default.
async function pruneLlmLogs(logDir, analysisRetentionDays, chatRetentionDays) {
  const analysisCutoff = analysisRetentionDays ? Date.now() - analysisRetentionDays * 24 * 60 * 60 * 1000 : null;
  const chatCutoff = chatRetentionDays ? Date.now() - chatRetentionDays * 24 * 60 * 60 * 1000 : null;
  try {
    const names = await fs.readdir(logDir);
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const isConversationLog = name.endsWith('-chat.json') || name.endsWith('-comparison.json');
      const cutoff = isConversationLog ? chatCutoff : analysisCutoff;
      if (!cutoff) {
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

  const targets = await getOutdatedAnalysisActivities(dbPath);
  if (!targets.length) {
    vscode.window.showInformationMessage(`All analyses already use version ${ANALYSIS_VERSION}.`);
    return;
  }

  const start = vscode.l10n.t('Start');
  const confirmed = await vscode.window.showInformationMessage(
    vscode.l10n.t('Update analyses for {0} activities? This includes outdated and missing analyses and uses one Copilot request per activity.', targets.length),
    { modal: true },
    start
  );
  if (confirmed !== start) {
    return;
  }

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
  const wheelRatio = asNumber((await getWheelCalibrationRecommendation(dbPath))?.ratio) || null;
  const sourceSession = fitData.sessions?.[0] || {};
  const session = {
    ...sourceSession,
    avg_hr: sourceSession._source === 'manual' ? null : (Object.hasOwn(sourceSession, '_device_avg_hr') ? sourceSession._device_avg_hr : sourceSession.avg_hr),
    max_hr: sourceSession._source === 'manual' ? null : (Object.hasOwn(sourceSession, '_device_max_hr') ? sourceSession._device_max_hr : sourceSession.max_hr),
  };
  const hrConfig = await getHeartRateConfigForActivity(dbPath, session.start_time, athleteProfile);
  const normalizedRecords = normalizeRecordSpeeds(fitData.records);
  const powerData = addEstimatedPowerWhenMissing(normalizedRecords, {
    riderMassKg: athleteProfile.riderMassKg,
    bikeMassKg: athleteProfile.bikeMassKg,
    ...getPowerModelOptions(),
  });
  const summary = buildSummary(powerData.records, [session], {
    ftp: athleteProfile.ftp,
    restingHeartRate: athleteProfile.restingHeartRate,
    sex: athleteProfile.sex,
    maxHeartRateForHrr: Number.isFinite(asNumber(hrConfig?.maxHeartRate))
      ? asNumber(hrConfig.maxHeartRate)
      : session.max_hr,
    heartRateThresholds: hrConfig?.thresholds,
    lactateThresholdHeartRate: hrConfig?.lthr ?? undefined,
    powerSource: powerData.source,
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
  const sessionClass = buildSessionClassForActivity(powerData.records, session, hrConfig, athleteProfile, segments);
  // Measured facts about the recording: one place, computed in code (B1).
  const qualityFlags = computeDataQualityFlags({ records: powerData.records, session, wheelRatio });
  // Route info and checkpoints are filled later by getTrainingContextFromDb (they need the
  // routes table and the same-sport history); analysisData carries the current-ride data.
  return {
    ...fitData,
    records: powerData.records,
    segments,
    sessionClass,
    qualityFlags,
    analysisHeartRateConfig: hrConfig,
    analysisQuality: {
      massSource: 'activity-specific mass when saved, otherwise current athlete profile; not measured by FIT',
      riderMassKg: asNumber(athleteProfile.riderMassKg), bikeMassKg: asNumber(athleteProfile.bikeMassKg),
      hrSource: session._source === 'manual' ? 'manual activity; HR withheld' : 'original FIT values; manual overrides withheld',
      trimpCoefficientNote: athleteProfile.sex === 'other' ? 'mean of the male and female Banister sets (sex recorded as other); an assumption, not a validated choice' : null,
      altitudeSource: 'FIT altitude; sensor provenance not retained',
      ftpSource: 'current athlete profile; threshold test date and method not retained',
    },
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
      trimp: summary.trimp,
      hr_tss: summary.hrTss,
      ftp: Number.isFinite(athleteFtp) && athleteFtp > 0 ? athleteFtp : null,
      lactate_threshold_hr: estimateLactateThresholdHeartRate(hrConfig?.maxHeartRate, hrConfig?.thresholds, athleteProfile?.restingHeartRate, hrConfig?.lthr),
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

function parseObservedMaxSource(value) {
  const parsed = typeof value === 'string' ? safeParseJson(value, null) : value;
  if (!parsed || typeof parsed !== 'object') return null;
  const value_ = parsed;
  const bpm = Number(value_.bpm);
  const source = { activityId: Number(value_.activityId) || null, date: String(value_.date || '').slice(0, 10), windowS: Number(value_.windowS) || null, bpm: Number.isFinite(bpm) ? Math.round(bpm) : null };
  return source.bpm ? source : null;
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
  const rawLthr = String(message.lthr ?? '').trim();
  const lthr = rawLthr === '' ? null : Number(rawLthr);
  if (lthr != null && (!Number.isFinite(lthr) || lthr < 100 || lthr > 240)) {
    throw new Error('Lactate threshold HR must be between 100 and 240 bpm.');
  }

  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const now = new Date().toISOString();
    const observedMaxSource = parseObservedMaxSource(message.observedMaxSource);
    const { inserted, notice } = applyHeartRateProfileUpsert(db, { effectiveDate, maxHeartRate, thresholds, lthr, observedMaxSource }, now);
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
    return { inserted, notice };
  } finally {
    db.close();
  }
}


// The highest 15-second rolling HR average across stored rides, with the activity it came from.
function observedPeakHeartRateFromDb(db, windowS) {
  const ids = db.exec("SELECT id, start_time FROM activities WHERE source = 'fit' ORDER BY datetime(start_time), id")[0]?.values || [];
  let best = null;
  const { calculatePeakHeartRates } = require('./heart-rate');
  for (const [id, startTime] of ids) {
    const stmt = db.prepare('SELECT elapsed_s, heart_rate FROM records WHERE activity_id = ? ORDER BY record_index');
    try {
      stmt.bind([id]);
      const records = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        records.push({ elapsed_time: row.elapsed_s, heart_rate: row.heart_rate });
      }
      const peaks = calculatePeakHeartRates(records, [windowS]);
      const bpm = peaks?.[0]?.bpm;
      if (Number.isFinite(bpm) && (!best || bpm > best.bpm)) {
        best = { activityId: Number(id), date: String(startTime).slice(0, 10), bpm: Math.round(bpm) };
      }
    } finally {
      stmt.free();
    }
  }
  return best;
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
        COALESCE((SELECT MAX(r.heart_rate) FROM records r JOIN activities a ON a.id = r.activity_id WHERE a.source = 'fit'), 0) AS max_record_hr
      FROM activities
      WHERE source = 'fit'
    `);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    // Observed max is a 15-second peak, not a single sample: one spurious beat cannot raise it.
    const peak = observedPeakHeartRateFromDb(db, 15);
    const observedMaxHeartRate = peak != null ? peak.bpm : Math.max(Number(row.max_session_hr) || 0, Number(row.max_record_hr) || 0);
    const observedMaxSource = peak != null
      ? { activityId: peak.activityId, date: peak.date, windowS: 15, bpm: peak.bpm }
      : null;
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
    suggestion.observedMaxSource = observedMaxSource;
    if (observedMaxSource && suggestion.formulaMaxHeartRate && observedMaxSource.bpm - suggestion.formulaMaxHeartRate > 15) {
      suggestion.observedMaxNotice = `Observed 15 s peak ${observedMaxSource.bpm} bpm is more than 15 bpm above the formula estimate (${suggestion.formulaMaxHeartRate}). Keep it only if that effort was real.`;
    }
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
    stmt = db.prepare('SELECT analysis_text, model_id, updated_at FROM activity_analysis WHERE activity_id = ? AND analysis_version = ?');
    stmt.bind([activityId, ANALYSIS_VERSION]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      return { text: row.analysis_text, modelId: row.model_id || null, analyzedAt: row.updated_at || null };
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
    stmt = db.prepare('SELECT analysis_text, analysis_version, model_id, updated_at FROM activity_analysis WHERE activity_id = ? ORDER BY analysis_version DESC LIMIT 1');
    stmt.bind([activityId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      const version = asNumber(row.analysis_version);
      return {
        text: row.analysis_text,
        version: Number.isFinite(version) ? version : 0,
        modelId: row.model_id || null,
        analyzedAt: row.updated_at || null,
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
    const measuredHrOnly = `AND a.source = 'fit' AND a.manual_avg_hr IS NULL AND a.manual_max_hr IS NULL`;

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
         AND aa.analysis_version >= ?
         AND COALESCE(a.sport, '') = COALESCE((SELECT sport FROM activities WHERE id = ?), '') ${measuredHrOnly}
       ORDER BY a.start_time ASC`,
      [activityId, reference, reference, ANALYSIS_VERSION, activityId]
    );
    if (recent.length) {
      return recent;
    }

    return read(
      `SELECT ${columns} ${from}
       WHERE a.id != ? AND a.start_time < ?
         AND aa.analysis_version >= ?
         AND COALESCE(a.sport, '') = COALESCE((SELECT sport FROM activities WHERE id = ?), '') ${measuredHrOnly}
       ORDER BY a.start_time DESC
       LIMIT 1`,
      [activityId, reference, ANALYSIS_VERSION, activityId]
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

async function getProgressSummaryFromDb(dbPath, activityId, currentData = null) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare(`
      WITH selected AS (
        SELECT id, start_time, total_distance_km, sport
        FROM activities
        WHERE id = ?
      ),
      all_prior AS (
        SELECT activities.*
        FROM activities, selected
        WHERE (
          datetime(activities.start_time) < datetime(selected.start_time)
          OR (datetime(activities.start_time) = datetime(selected.start_time) AND activities.id < selected.id)
        ) AND COALESCE(activities.sport, '') = COALESCE(selected.sport, '')
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
        (SELECT COALESCE(AVG(avg_hr), 0) FROM prior WHERE source = 'fit' AND avg_hr > 0) AS avg_heart_rate,
        (SELECT COALESCE(MAX(max_hr), 0) FROM prior WHERE source = 'fit' AND max_hr > 0) AS max_recorded_heart_rate,
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
        (SELECT COUNT(*) FROM all_prior
          WHERE datetime(start_time) >= datetime((SELECT start_time FROM selected), '-28 days')) AS rides_28_days,
        (SELECT COUNT(DISTINCT date(start_time)) FROM all_prior
          WHERE datetime(start_time) >= datetime((SELECT start_time FROM selected), '-28 days')) AS active_days_28_days
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
        SELECT start_time, total_distance_km, sport
        FROM activities
        WHERE id = ?
      )
      SELECT activities.avg_speed_kmh, activities.avg_hr, activities.start_time, activities.source
      FROM activities, selected
      WHERE (
        datetime(activities.start_time) < datetime(selected.start_time)
        OR (datetime(activities.start_time) = datetime(selected.start_time) AND activities.id < ?)
      )
        AND COALESCE(activities.sport, '') = COALESCE(selected.sport, '')
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
    summary.trend_heart_rate = calculateProgressTrend(prior.filter((activity) => activity.source === 'fit'), 'avg_hr', 'bpm');
    stmt.free();
    stmt = null;
    const changesBefore = totalChanges(db);
    summary.trainingContext = getTrainingContextFromDb(db, activityId, currentData);
    // Lazily computed features, route assignments and elevation profiles must survive the connection.
    if (totalChanges(db) !== changesBefore) await persistDatabase(db, dbPath);
    return summary;
  } finally {
    stmt?.free();
    db.close();
  }
}

function getTrainingContextFromDb(db, activityId, currentData) {
  const readRows = (sql, params) => {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  };
  const selected = readRows('SELECT * FROM activities WHERE id = ?', [activityId])[0];
  if (!selected?.start_time) return null;
  const rows = readRows(`SELECT a.*, aa.analysis_text, aa.analysis_version, aa.summary_json, aac.chat_json
    FROM activities a LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
    LEFT JOIN activity_analysis_chat aac ON aac.activity_id = a.id
    WHERE datetime(a.start_time) < datetime(?) AND datetime(a.start_time) >= datetime(?, '-90 days')
    ORDER BY datetime(a.start_time) DESC, a.id DESC`, [selected.start_time, selected.start_time]);
  const profile = getAthleteProfileFromDbConnection(db);
  const detailedPerSport = new Map();
  // The full per-record pipeline stays for the current activity and for rows whose cached
  // features are stale; fresh cache rows skip the record scan entirely.
  const segmentationOptions = getSegmentationOptions();
  const powerModelOptions = getPowerModelOptions();
  const settingsHash = settingsKey({ segmentation: segmentationOptions, powerModel: powerModelOptions });
  const readFeatureRow = (id) => readRows('SELECT * FROM activity_features WHERE activity_id = ?', [id])[0] || null;
  const storeFeatureRow = (id, payload) => {
    db.run(`
      INSERT INTO activity_features (
        activity_id, features_version, settings_hash, hr_profile_key, athlete_key, feature_cache_key, computed_at,
        segments_json, zones_json, peak_hr_json, session_class_json, trimp, hr_tss, elapsed_coverage_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        features_version=excluded.features_version, settings_hash=excluded.settings_hash,
        hr_profile_key=excluded.hr_profile_key, athlete_key=excluded.athlete_key,
        feature_cache_key=excluded.feature_cache_key, computed_at=excluded.computed_at,
        segments_json=excluded.segments_json, zones_json=excluded.zones_json,
        peak_hr_json=excluded.peak_hr_json, session_class_json=excluded.session_class_json,
        trimp=excluded.trimp, hr_tss=excluded.hr_tss, elapsed_coverage_pct=excluded.elapsed_coverage_pct
    `, [id, payload.featuresVersion, payload.settingsHash, payload.hrProfileKey, payload.athleteKey,
      payload.featureCacheKey, new Date().toISOString(),
      JSON.stringify(payload.segments ?? []), JSON.stringify(payload.zones ?? null),
      JSON.stringify(payload.peakHr ?? []), JSON.stringify(payload.sessionClass ?? null),
      payload.trimp ?? null, payload.hrTss ?? null, payload.elapsedCoveragePct ?? null]);
  };
  const buildDetail = (row) => {
    const records = readRows('SELECT * FROM records WHERE activity_id = ? ORDER BY record_index', [row.id]).map((record) => ({
      elapsed_time: record.elapsed_s, distance: record.distance_km, speed: record.speed_kmh,
      altitude: record.altitude_m == null ? null : record.altitude_m / 1000,
      heart_rate: row.source === 'manual' ? null : record.heart_rate,
      power: record.power, cadence: record.cadence,
      position_lat: record.latitude, position_long: record.longitude,
    }));
    const normalized = normalizeRecordSpeeds(records);
    const power = addEstimatedPowerWhenMissing(normalized, {
      riderMassKg: row.rider_mass_kg ?? profile.riderMassKg,
      bikeMassKg: row.bike_mass_kg ?? profile.bikeMassKg, ...powerModelOptions,
    });    const hrConfig = attachRestingHeartRate(
      getProfileHeartRateConfig(db, row.start_time),
      row.rider_mass_kg != null ? { restingHeartRate: profile.restingHeartRate } : profile,
    );
    const segments = buildActivitySegments(power.records, { sport: row.sport, powerSource: power.source,
      thresholds: segmentationOptions, athlete: { ftp: profile.ftp, restingHeartRate: profile.restingHeartRate,
        maxHeartRate: hrConfig?.maxHeartRate } });
    const summary = buildSummary(power.records, [{ total_timer_s: row.total_timer_s, total_elapsed_s: row.total_elapsed_s, total_distance: row.total_distance_km }], {
      restingHeartRate: profile.restingHeartRate, sex: profile.sex,
      maxHeartRateForHrr: asNumber(hrConfig?.maxHeartRate) || row.max_hr,
      heartRateThresholds: hrConfig?.thresholds, lactateThresholdHeartRate: hrConfig?.lthr ?? undefined,
      powerSource: power.source,
    });
    const timerS = asNumber(row.total_timer_s);
    const sessionClass = buildSessionClassForActivity(power.records, { total_timer_s: timerS }, hrConfig, profile, segments);
    const routeSignature = buildRouteSignature(records);
    const routeInfo = assignRoute(db, { activityId: row.id, signature: routeSignature, createdAt: row.start_time });
    const checkpoints = computeCheckpoints(records);
    return { records: normalized, segments, hrConfig, powerSource: power.source, sessionClass,
      trimp: summary.trimp, hrTss: summary.hrTss, routeInfo, checkpoints };
  };
  // Cached feature payload for one earlier activity; recomputes (and stores) only when the key changed.
  const ensureFeaturesRow = (row) => {
    const hrConfig = attachRestingHeartRate(getProfileHeartRateConfig(db, row.start_time), profile);
    const key = featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash, hrProfile: hrConfig, athlete: profile });
    const existing = readFeatureRow(row.id);
    if (isFeatureRowFresh(existing, key)) {
      return {
        segments: safeParseJson(existing.segments_json, []),
        zones: safeParseJson(existing.zones_json, null),
        peakHr: safeParseJson(existing.peak_hr_json, []),
        sessionClass: safeParseJson(existing.session_class_json, null),
        trimp: existing.trimp, hrTss: existing.hr_tss,
        elapsedCoveragePct: existing.elapsed_coverage_pct, hrConfig, powerSource: 'cached',
      };
    }
    const detail = buildDetail(row);
    const summary = buildSummary(detail.records, [{ total_timer_s: row.total_timer_s, total_elapsed_s: row.total_elapsed_s, total_distance: row.total_distance_km }], {
      restingHeartRate: profile.restingHeartRate, sex: profile.sex,
      maxHeartRateForHrr: asNumber(hrConfig?.maxHeartRate) || row.max_hr,
      heartRateThresholds: hrConfig?.thresholds, lactateThresholdHeartRate: hrConfig?.lthr ?? undefined,
      powerSource: detail.powerSource,
    });
    const zones = computeHeartRateZones(detail.records, hrConfig?.maxHeartRate, hrConfig?.thresholds,
      { restingHeartRate: asNumber(profile.restingHeartRate) });
    const peakHr = calculatePeakHeartRates(detail.records);
    const timerS = asNumber(row.total_timer_s);
    const sessionClass = buildSessionClassForActivity(detail.records, { total_timer_s: timerS }, hrConfig, profile, detail.segments);
    const payload = {
      featuresVersion: FEATURES_VERSION, settingsHash, hrProfileKey: hrProfileKey(hrConfig), athleteKey: athleteKey(profile),
      featureCacheKey: key,
      segments: detail.segments.map((segment) => ({ ...segment, routePoints: undefined })),
      zones, peakHr, sessionClass,
      trimp: summary.trimp, hrTss: summary.hrTss,
      elapsedCoveragePct: zones?.enabled && timerS > 0 ? 100 * zones.totalSeconds / timerS : null,
    };
    storeFeatureRow(row.id, payload);
    return { segments: payload.segments, zones, peakHr, sessionClass,
      trimp: summary.trimp, hrTss: summary.hrTss,
      elapsedCoveragePct: payload.elapsedCoveragePct, hrConfig, powerSource: detail.powerSource };
  };
  const routeAssignments = readRouteAssignments(db);
  const sessionNotes = readAllActivityNotes(db);
  const activities = rows.map((row) => {
    const count = detailedPerSport.get(row.sport) || 0;
    detailedPerSport.set(row.sport, count + 1);
    const useCache = count >= 40;
    const detail = row.source === 'manual' ? null : (useCache ? ensureFeaturesRow(row) : buildDetail(row));
    let conversation = [];
    try {
      const parsed = JSON.parse(row.chat_json || '[]');
      if (Array.isArray(parsed)) conversation = parsed.filter((entry) => entry?.role === 'user' && String(entry.content || '').trim()).slice(-8);
    } catch {}
    const activity = { activityId: row.id, startTime: row.start_time, sport: row.sport,
      utcOffsetS: row.utc_offset_s,
      subSport: row.sub_sport, durationS: row.total_timer_s, distanceKm: row.total_distance_km,
      elevationM: row.total_ascent_m, avgSpeedKmh: row.avg_speed_kmh,
      avgHr: row.source === 'fit' ? row.avg_hr : null,
      reportedAvgHr: row.source === 'fit' ? row.manual_avg_hr : null,
      reportedMaxHr: row.source === 'fit' ? row.manual_max_hr : null,
      powerSource: detail?.powerSource || 'unknown',
      trainingStressScore: detail?.powerSource === 'measured' ? row.training_stress_score : null,
      hrProfileDate: detail?.hrConfig?.effectiveDate || null,
      trimp: asNumber(detail?.trimp) > 0 ? asNumber(detail.trimp) : asNumber(row.trimp),
      hrTss: asNumber(detail?.hrTss) > 0 ? asNumber(detail.hrTss) : asNumber(row.hr_tss),
      sessionClass: detail?.sessionClass || null,
      notes: sessionNotes.get(row.id) || null,
      routeId: detail?.routeInfo?.routeId ?? routeAssignments.get(row.id)?.routeId ?? null,
      routeRelation: detail?.routeInfo?.relation ?? routeAssignments.get(row.id)?.relation ?? null,
      checkpoints: detail?.checkpoints || [],
      segments: detail?.segments || [], conversation,
      source: row.source,
      analysisText: row.source === 'fit' && row.analysis_version >= ANALYSIS_VERSION && row.manual_avg_hr == null && row.manual_max_hr == null
        ? row.analysis_text : null,
      analysisSummary: row.source === 'fit' && row.analysis_version >= ANALYSIS_VERSION && row.manual_avg_hr == null && row.manual_max_hr == null
        ? parseStoredSummary(row.summary_json) : null,
      analysisVersion: row.analysis_version,
    };
    return attachActivityZones(activity, detail?.records || [], detail?.hrConfig);
  });
  const currentDetail = currentData?.segments ? null : buildDetail(selected);
  const currentSegments = currentData?.segments || currentDetail?.segments || [];
  // The current ride also needs its route relation and checkpoints for same-route comparisons.
  // prepareAnalysisData does not know the routes table, so a ride analysed from fresh data gets its
  // route and checkpoints here from the same records.
  const currentRecords = currentData?.records || currentDetail?.records || null;
  const currentRouteInfo = currentData?.routeInfo || currentDetail?.routeInfo
    || (currentRecords
      ? assignRoute(db, { activityId: selected.id, signature: buildRouteSignature(currentRecords), createdAt: selected.start_time })
      : null);
  const currentCheckpoints = currentData?.checkpoints || currentDetail?.checkpoints
    || (currentRecords ? computeCheckpoints(currentRecords) : []);
  const context = buildTrainingContext(activities, selected.start_time, selected.sport, currentSegments);
  const offsetChange = detectOffsetChange({
    current: { startTime: selected.start_time, utcOffsetS: selected.utc_offset_s },
    others: activities.map((activity) => ({ startTime: activity.startTime, utcOffsetS: activity.utcOffsetS })),
  });
  if (offsetChange) {
    context.qualityFlags = [...(context.qualityFlags || []), {
      code: 'OFFSET_CHANGED', severity: 'warn',
      text: `device UTC offset (${formatOffsetLabel(offsetChange.utcOffsetS)}) differs from the median of ${offsetChange.neighbours} nearby same-file activities (${formatOffsetLabel(offsetChange.medianOffsetS)}); the device timezone setting probably changed, so local clock times and local dates around these rides are less reliable`,
    }];
  }
  context.routeContext = currentRouteInfo
    ? buildRouteContext({ routeInfo: currentRouteInfo, checkpoints: currentCheckpoints, segments: currentSegments }, activities, selected, readRouteNote(db, currentRouteInfo.routeId))
    : null;
  const routeProfileForStretches = ['same', 'reversed'].includes(currentRouteInfo?.relation)
    ? buildRouteProfile(db, currentRouteInfo) : null;
  context.routeProfile = routeProfileForStretches;
  // C7: long flat segments get a route-stretch breakdown instead of temporal halves, so a
  // route-typical speed change is not presented as this ride's dynamics.
  annotateSegmentsWithRouteStretches({
    segments: currentData?.segments || currentDetail?.segments || [],
    records: currentRecords,
    described: routeProfileForStretches?.described || null,
  });
  context.qualityFlags = currentData?.qualityFlags || [];
  context.altitudeQuality = buildAltitudeQuality({
    db, records: currentRecords, routeInfo: currentRouteInfo, activity: selected,
  });
  // The workout fields read the settling window, so it must land on the analysis data after it
  // is computed here and before the prompt is built.
  if (context.altitudeQuality?.settlingWindow && currentData) currentData.altitudeSettlingWindow = context.altitudeQuality.settlingWindow;
  const conversations = readRows(`SELECT a.start_time, aac.chat_json
    FROM activities a JOIN activity_analysis_chat aac ON aac.activity_id = a.id
    WHERE datetime(a.start_time) < datetime(?) ORDER BY datetime(a.start_time) DESC LIMIT 24`, [selected.start_time]);
  context.userReports = conversations.reverse().flatMap((row) => {
    try {
      const parsed = JSON.parse(row.chat_json);
      return Array.isArray(parsed) ? parsed.filter((turn) => turn?.role === 'user' && String(turn.content || '').trim())
        .slice(-8).map((turn) => ({ startTime: row.start_time, ts: turn.ts || null, content: String(turn.content) })) : [];
    } catch {
      return [];
    }
  });
  context.coverageNote += ' User context includes the latest 24 earlier activity conversations, up to 8 user reports each, independently of numeric windows. This is bounded conversation context, not a complete medical or goal record.';
  return context;
}

function calculateProgressTrend(activities, field, unit) {
  const trend = calculateRobustTrend(activities.map((activity) => activity[field]));
  if (!trend) {
    return 'insufficient data';
  }
  const changePct = trend.changePct;
  return `${trend.direction} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%, ${unit}; noise threshold ±${trend.thresholdPct.toFixed(1)}%)`;
}

// Terrain, climbs and per-direction speeds derived from the route's earlier rides.
function buildRouteProfile(db, routeInfo) {
  const features = ensureRouteFeatures(db, routeInfo.routeId);
  if (!features) return null;
  const described = describeRouteFeatures(features, routeInfo.relation);
  if (!described) return null;
  const counts = { same: 0, reversed: 0 };
  for (const row of features.rows) {
    counts.same = Math.max(counts.same, row.sameRides || 0);
    counts.reversed = Math.max(counts.reversed, row.reversedRides || 0);
  }
  return { direction: routeInfo.relation, described, rideCounts: counts, lengthKm: features.lengthKm,
    ascentM: features.ascentM, descentM: features.descentM };
}


function annotateSegmentsWithRouteStretches({ segments, records, described }) {
  if (!described?.rows?.length || !Array.isArray(segments) || !records) return;
  for (const segment of segments) {
    if (segment.type !== 'flat' || !(segment.durationS >= 600) || !(segment.distanceKm >= 4)) continue;
    const start = segment.routeStartDistanceKm ?? segmentStartKmOnRideAxis(records, segment);
    if (start == null) continue;
    const stretches = computeSegmentStretches(records, described, start, start + segment.distanceKm);
    if (stretches) segment.routeStretches = stretches;
  }
}

function segmentStartKmOnRideAxis(records, segment) {
  const record = (Array.isArray(records) ? records : []).find((entry) => Number(entry?.elapsed_time) >= (segment.startElapsed ?? -1));
  return record ? Number(record.distance) : null;
}

// Altitude-quality flags for the current ride, sharpened by the route's consensus profile when
// enough same-route rides exist. Returns null when there is nothing to report.
function buildAltitudeQuality({ db, records, routeInfo, activity }) {
  const ride = buildAltitudeRide(records);
  if (!ride) return null;
  let flags = computeAltitudeFlags(ride);
  let routeLine = null;
  let settlingWindow = null;
  const reversed = routeInfo?.relation === 'reversed';
  const profile = routeInfo?.routeId && ['same', 'reversed'].includes(routeInfo.relation)
    ? ensureRouteElevationProfile(db, routeInfo.routeId) : null;
  if (profile) {
    // The consensus is stored on the canonical axis; for a reversed ride it is mirrored instead,
    // so the ride's own first minutes stay first for settling detection.
    const settling = detectAltitudeSettling(ride, reversed ? mirrorConsensusProfile(profile) : profile);
    if (settling) {
      flags = flags.filter((flag) => flag.code !== 'ALT_SETTLING');
      flags.push({ code: 'ALT_SETTLING', detail: settling.detail });
      settlingWindow = { startDeltaM: settling.startDeltaM, settleSeconds: settling.settleSeconds };
    }
    const computed = [asNumber(activity.total_ascent_m), asNumber(activity.total_descent_m)];
    const device = [asNumber(activity.device_ascent_m), asNumber(activity.device_descent_m)];
    // A stored 0/0 means the device wrote no figure, not a flat ride.
    if (!(device[0] > 0 || device[1] > 0)) device.fill(NaN);
    routeLine = `Route elevation (offset-aligned consensus of ${profile.rides} rides of this route, both directions): ascent ~${profile.ascentM} m, descent ~${profile.descentM} m`
      + `${computed.every(Number.isFinite) ? `; this ride computed ${Math.round(computed[0])}/${Math.round(computed[1])} m` : ''}`
      + `${device.every(Number.isFinite) ? `, device ${Math.round(device[0])}/${Math.round(device[1])} m` : ''}.`;
  }
  return flags.length || routeLine ? { flags, routeLine, settlingWindow } : null;
}

// Same-route comparisons the code can state as fact: checkpoint splits against the median of
// prior same-route rides, plus the history of the final climb segment when one exists.
function buildRouteContext(currentData, activities, selected, routeNote = null) {
  const routeInfo = currentData.routeInfo;
  if (!routeInfo?.routeId) return null;
  // The activity list is newest-first; "recent" must mean the latest rides, oldest-to-newest.
  // Only rides in the same direction over the full route are comparable split for split: a loop
  // ridden both ways has different climbs and winds in each half. Partial rides get no splits.
  if (!['same', 'reversed'].includes(routeInfo.relation)) return null;
  const priorSameRoute = activities.filter((activity) => activity.routeId === routeInfo.routeId && activity.routeRelation === routeInfo.relation)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  if (!priorSameRoute.length) return null;
  const recentPriors = priorSameRoute.slice(-5);
  const summary = summarizeCheckpoints(currentData.checkpoints || [], recentPriors.map((activity) => ({ checkpoints: activity.checkpoints })));
  const marks = summary.filter((mark) => mark.priorRides > 0).slice(0, 10);
  const lines = marks.map((mark) => {
    const diff = mark.priorMedianS ? Math.round(mark.elapsedS - mark.priorMedianS) : null;
    const delta = diff == null ? '' : `${diff < 0 ? '-' : '+'}${Math.floor(Math.abs(diff) / 60)}:${String(Math.abs(diff) % 60).padStart(2, '0')}`;
    const priorHr = mark.priorMedianHr != null && mark.avgHr ? ` (prior median ${mark.priorMedianHr})` : '';
    const best = mark.priorBestS != null ? `, best ${formatHms(mark.priorBestS)}` : '';
    return `- km ${mark.km}: ${formatHms(mark.elapsedS)}${diff != null ? ` (median ${formatHms(mark.priorMedianS)}${best}, ${delta})` : ''}${mark.avgHr ? `, HR ${mark.avgHr}${priorHr}` : ''}`;
  });
  const climbs = (currentData.segments || []).filter((segment) => segment.type === 'climb' && segment.elevGainM >= 25);
  const finalClimb = climbs.at(-1);
  let climbLine = null;
  if (finalClimb) {
    const history = priorSameRoute
      .map((activity) => (activity.segments || []).find((segment) => segment.type === 'climb'
        && Math.abs((segment.startDistanceKm ?? 0) - (finalClimb.startDistanceKm ?? 0)) < 1.5))
      .filter(Boolean)
      .map((segment) => ({ durationS: segment.durationS, avgHr: segment.avgHr, date: null }))
      .slice(-5);
    if (history.length) {
      const durations = history.map((row) => row.durationS).sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)];
      const hrs = history.map((row) => row.avgHr).filter(Number.isFinite);
      climbLine = `Final climb ${formatHms(finalClimb.durationS)} (grade ${finalClimb.avgGrade}%, HR ${finalClimb.avgHr ?? 'unknown'}); prior same-route climbs: ${history.length} rides, median ${formatHms(median)}${hrs.length ? `, HR ${Math.min(...hrs)}-${Math.max(...hrs)}` : ''}.`;
    }
  }
  const pattern = summarizeRoutePattern(currentData.checkpoints || [], priorSameRoute);
  const regular = pattern && pattern.slowerCount / pattern.priorCount >= 0.6;
  const patternLine = pattern
    ? `Route-typical pattern (${pattern.priorCount} earlier rides): after km ${pattern.splitKm} the average speed is at least 3% below the first part in ${pattern.slowerCount} of ${pattern.priorCount} rides (median ${pattern.medianChangePct >= 0 ? '+' : ''}${pattern.medianChangePct}%). This ride: ${pattern.currentChangePct >= 0 ? '+' : ''}${pattern.currentChangePct}% (a bigger drop than in ${pattern.currentDropsMoreThanCount} of ${pattern.priorCount} earlier rides).${regular ? ' A pattern this regular belongs to the route, not to the day: discuss only how this ride differs from it.' : ''}`
    : null;
  const verdictLine = describeCheckpointVerdict(summary);
  return {
    routeName: routeInfo.routeName,
    relation: routeInfo.relation,
    patternLine,
    verdictLine,
    routeNote: routeNote ? String(routeNote).trim() : null,
    rideCount: routeInfo.rideCount,
    priorRideCount: priorSameRoute.length,
    checkpointLines: lines,
    climbLine,
    note: `Route identity from GPS geometry (${routeInfo.relation === 'reversed' ? 'ridden in the opposite direction to the route\'s first ride; compared only with rides in this direction' : 'same direction as the route\'s first ride'}); ${priorSameRoute.length} earlier rides in this direction in the analysis window. Checkpoint medians are descriptive splits of prior rides, not controlled time trials.`,
  };
}

async function storeAnalysisInDb(dbPath, activityId, analysis, summary = null, modelId = null) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version, summary_json, model_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        analysis_text = excluded.analysis_text,
        analysis_version = excluded.analysis_version,
        summary_json = excluded.summary_json,
        model_id = excluded.model_id,
        updated_at = excluded.updated_at
    `, [activityId, analysis, ANALYSIS_VERSION, summary ? JSON.stringify(summary) : null, modelId, now, now]);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function getActivityComparisonFromDb(dbPath, activityId, comparedActivityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare('SELECT comparison_text FROM activity_comparisons WHERE activity_id = ? AND compared_activity_id = ?');
    stmt.bind([activityId, comparedActivityId]);
    return stmt.step() ? stmt.getAsObject().comparison_text : null;
  } finally {
    stmt?.free();
    db.close();
  }
}

// All saved directed comparisons FROM this activity, so the panel can list them regardless of
// which (if any) comparison activity happens to be selected in the dropdown right now.
async function getActivityComparisonsForActivity(dbPath, activityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  let stmt;
  try {
    stmt = db.prepare(`
      SELECT compared_activity_id, comparison_text, updated_at
      FROM activity_comparisons WHERE activity_id = ? ORDER BY updated_at DESC
    `);
    stmt.bind([activityId]);
    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        comparedActivityId: Number(row.compared_activity_id),
        comparisonText: row.comparison_text,
        updatedAt: row.updated_at,
      });
    }
    return rows;
  } finally {
    stmt?.free();
    db.close();
  }
}

async function storeActivityComparisonInDb(dbPath, activityId, comparedActivityId, comparisonText) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO activity_comparisons (activity_id, compared_activity_id, comparison_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(activity_id, compared_activity_id) DO UPDATE SET
        comparison_text = excluded.comparison_text,
        updated_at = excluded.updated_at
    `, [activityId, comparedActivityId, comparisonText, now, now]);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

// Removes only this one directed pair; other accumulated comparisons for either activity are untouched.
async function removeActivityComparisonFromDb(dbPath, activityId, comparedActivityId) {
  const SQL = await getSqlJs();
  const db = await openDatabase(SQL, dbPath);
  try {
    db.run('DELETE FROM activity_comparisons WHERE activity_id = ? AND compared_activity_id = ?', [activityId, comparedActivityId]);
    await persistDatabase(db, dbPath);
  } finally {
    db.close();
  }
}

async function generateActivityComparison(dbPath, activityId, comparedActivityId, force = false) {
  return enqueueLlmTask(() => runActivityComparison(dbPath, activityId, comparedActivityId, force));
}

async function runActivityComparison(dbPath, activityId, comparedActivityId, force) {
  const numId = Number(activityId);
  const compNumId = Number(comparedActivityId);
  if (!Number.isFinite(numId) || numId <= 0 || !Number.isFinite(compNumId) || compNumId <= 0) {
    throw new Error('Choose two activities to compare.');
  }
  if (numId === compNumId) {
    throw new Error('Choose a different activity to compare against.');
  }

  if (!force) {
    const existing = await getActivityComparisonFromDb(dbPath, numId, compNumId);
    if (existing) {
      return existing;
    }
  }

  const [current, compared] = await Promise.all([
    loadFitDataFromDb(dbPath, numId),
    loadFitDataFromDb(dbPath, compNumId),
  ]);
  if (!current) {
    throw new Error(`Activity ${numId} not found in database`);
  }
  if (!compared) {
    throw new Error(`Activity ${compNumId} not found in database`);
  }

  const [analysisData, comparedData] = await Promise.all([
    prepareAnalysisData(dbPath, current, numId),
    prepareAnalysisData(dbPath, compared, compNumId),
  ]);

  const prompt = generateComparisonPrompt(analysisData, comparedData, vscode.env.language);
  const comparison = await requestCopilotAnalysis(vscode, prompt, {
    vendor: getLanguageModelVendor(),
    onCompleted: (result) => logLlmRequest(dbPath, {
      activityId: numId,
      kind: 'comparison',
      ...result,
    }),
  });
  await storeActivityComparisonInDb(dbPath, numId, compNumId, comparison);

  return comparison;
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
  const summary = await getProgressSummaryFromDb(dbPath, activityId, analysisData);
  const hrConfig = await getHeartRateConfigForActivity(dbPath, analysisData.sessions?.[0]?.start_time, await getAthleteProfile(dbPath, activityId));
  const hasManualHrOverrides = Boolean(analysisData.sessions?.[0]?._hasManualHrOverrides);
  const previousResult = hasManualHrOverrides ? null : await getLatestAnalysisAnyVersion(dbPath, activityId);
  const hasCurrentAnalysis = previousResult?.version >= ANALYSIS_VERSION;
  const baseAnalysis = hasCurrentAnalysis ? previousResult.text : null;
  const safeHistory = hasCurrentAnalysis && !hasManualHrOverrides
    ? history
    : history.filter((entry) => entry?.role === 'user');
  const prompt = generateAnalysisChatPrompt(
    analysisData, summary, hrConfig, baseAnalysis, safeHistory, userQuestion, vscode.env.language
  );
  return requestCopilotAnalysis(vscode, prompt, {
    vendor: getLanguageModelVendor(),
    onCompleted: (result) => logLlmRequest(dbPath, { activityId: Number(activityId), kind: 'chat', ...result }),
  });
}

function deactivate() {}

module.exports = {
  activate,
  createManualActivity,
  deactivate,
};
