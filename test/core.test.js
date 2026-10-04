const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const test = require('node:test');
const initSqlJs = require('../vendor/sql-wasm/sql-wasm.js');
const {
  buildRecentHistoryContext,
  buildSegmentContext,
  formatFieldsSkippingEmpty,
  generateAnalysisPrompt,
  generateAnalysisPromptParts,
  generateAnalysisChatPrompt,
  generateComparisonPrompt,
  requestCopilotAnalysis,
  responseLanguageInstruction,
  selectPreferredModel,
  summarizePromptBlocks,
} = require('../analysis');
const { ensureDatabaseSchema } = require('../database-schema');
const { attachActivityZones, buildTrainingContext, compareSegmentStructures } = require('../training-context');
const {
  MODEL_PRICES, MODEL_PRICING_URL, MODEL_PRICE_CACHE_KEY, findModelPrice, parseModelPrices,
  rankModelsByCost, restoreModelPriceCache, setModelPrices, updateModelPrices,
} = require('../model-pricing');
const { padYAxisRange } = require('../chart-geometry');
const { computeStats, extractXYPoints, mapSegmentsToDistanceRanges } = require('../chart-data');
const { buildChartClientPayload, buildOverlayOptions } = require('../chart-overlays');
const { buildSummary } = require('../activity-summary');
const { buildLineChart } = require('../chart-model');
const { createChartSvgRenderer } = require('../chart-svg');
const { GLOSSARY, localizeGlossary } = require('../glossary');
const { UI_STRINGS, formatUi, localizeUi } = require('../ui-strings');
const { createManualActivity } = require('../manual-activity');
const { deriveUtcOffsetS, detectOffsetChange, formatOffsetLabel, localClock, localDate } = require('../activity-time');
const { reconcileSessionElapsed } = require('../activity-session-checks');
const { classifySession, countHardEfforts, longestSustainedZ4Seconds } = require('../session-class');
const pricingMarkdown = `All prices are **per 1 million tokens**.

| Model | Output | Tier | Cached input | Input |
| --- | --- | --- | --- | --- |
| [GPT-6 Luna](https://example.com) | $0.50 | Default | $0.01 | $0.10 |
| GPT-6 Luna | $0.75 | Long context | $0.02 | $0.20 |
| | | | | |

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| Claude Fable 5 | $10.00 | $1.00 | $50.00 |
| Gemini Flash[^promo] | $0.75 | $0.075 | $3.75 |
`;

test('model price parsing uses named columns, default tiers and plain model names', () => {
  const prices = parseModelPrices(pricingMarkdown);
  assert.equal(prices.length, 3);
  assert.deepEqual(prices[0], { key: 'gpt6luna', name: 'GPT-6 Luna', inputPrice: 0.1, outputPrice: 0.5 });
  assert.equal(prices[2].name, 'Gemini Flash');
  assert.throws(() => parseModelPrices('No prices available'), /units/);
  assert.throws(() => parseModelPrices(pricingMarkdown.replace('$0.50', 'unknown')), /Unrecognized/);
  assert.throws(() => parseModelPrices(pricingMarkdown.replace('Claude Fable 5', 'GPT-6 Luna')), /duplicate/);
  assert.throws(() => parseModelPrices(pricingMarkdown.replace('| Input |', '| Input price |')), /columns/);
  assert.throws(() => parseModelPrices(pricingMarkdown.replace('Default', 'Unknown tier')), /tier/);
});

test('model price update persists validated prices and restores them after restart', async () => {
  const writes = [];
  try {
    const cache = await updateModelPrices({ update: async (...args) => writes.push(args) }, async (url, options) => {
      assert.equal(url, MODEL_PRICING_URL);
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(pricingMarkdown);
    });
    assert.equal(writes[0][0], MODEL_PRICE_CACHE_KEY);
    assert.equal(writes[0][1], cache);
    assert.equal(findModelPrice({ name: 'Gemini Flash' }).outputPrice, 3.75);
    setModelPrices(MODEL_PRICES);
    assert.equal(findModelPrice({ name: 'Gemini Flash' }), null);
    assert.equal(restoreModelPriceCache(cache), true);
    assert.equal(rankModelsByCost([{ name: 'Gemini Flash' }, { id: 'gpt-6-luna' }])[0].model.id, 'gpt-6-luna');
    assert.equal(restoreModelPriceCache({ ...cache, sourceUrl: 'https://example.com' }), false);
  } finally {
    setModelPrices(MODEL_PRICES);
  }
});

test('model price update preserves previous prices on network, format and storage failures', async () => {
  let writes = 0;
  const storage = { update: async () => { writes += 1; } };
  const previous = findModelPrice({ id: 'gpt-6-luna' });
  try {
    await assert.rejects(updateModelPrices(storage, async () => { throw new Error('Offline'); }), /Offline/);
    await assert.rejects(updateModelPrices(storage, async () => new Response('Unavailable', { status: 503 })), /HTTP 503/);
    await assert.rejects(updateModelPrices(storage, async () => new Response('Page format changed')), /units/);
    await assert.rejects(updateModelPrices(storage, async () => new Response('x'.repeat(1024 * 1024 + 1))), /too large/);
    assert.equal(writes, 0);
    await assert.rejects(updateModelPrices({ update: async () => { throw new Error('Disk full'); } }, async () => new Response(pricingMarkdown)), /Disk full/);
    assert.equal(findModelPrice({ id: 'gpt-6-luna' }), previous);
    assert.equal(restoreModelPriceCache({ version: 1, sourceUrl: MODEL_PRICING_URL, updatedAt: 'invalid', prices: [] }), false);
  } finally {
    setModelPrices(MODEL_PRICES);
  }
});

test('model price update is contributed to the palette and routes through the command service', async () => {
  const registered = new Map();
  const errors = [];
  let updates = 0;
  let fail = false;
  const originalLoad = Module._load;
  const modulePath = require.resolve('../commands');
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return {
      l10n: { t: (text) => text },
      commands: { registerCommand: (name, handler) => { registered.set(name, handler); return { dispose() {} }; } },
      window: { registerCustomEditorProvider: () => ({ dispose() {} }), showErrorMessage: (message) => errors.push(message) },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const loaded = new Module(modulePath, module);
    loaded.filename = modulePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(modulePath));
    loaded._compile(fs.readFileSync(modulePath, 'utf8'), modulePath);
    loaded.exports.registerCommands({}, {
      updateModelPriceTable: async () => {
        updates += 1;
        if (fail) throw new Error('Offline');
      },
    });
  } finally {
    Module._load = originalLoad;
  }
  const command = registered.get('fitVisualizer.updateModelPrices');
  assert.equal(typeof command, 'function');
  await command();
  assert.equal(updates, 1);
  fail = true;
  await command();
  assert.deepEqual(errors, ['FIT model price update failed: Offline']);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'fitVisualizer.updateModelPrices' && entry.title === 'FIT: Update Model Prices'));
  assert.ok(!manifest.contributes.commands.some((entry) => entry.command === 'fitVisualizer.rebuildDerivedFeatures'), 'the rebuild command is gone from the palette');
  assert.equal(manifest.l10n, './l10n');
});
const {
  loadBundledTranslationBundle,
  loadGeneratedTranslationBundle,
  parseGeneratedBundle,
  saveGeneratedTranslationBundle,
  validateTranslationBundle,
} = require('../dynamic-localization');

function loadActivityWebviewForTest() {
  const modulePath = require.resolve('../activity-webview');
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return {
      env: { language: 'en' },
      l10n: { t: (text) => text },
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      Uri: { joinPath: (...parts) => ({ toString: () => parts.slice(1).join('/') }) },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../activity-webview');
  } finally {
    Module._load = originalLoad;
  }
}

function loadExtensionInternalsForTest(vscodeOverrides = {}, fitFileOverrides = {}) {
  const modulePath = require.resolve('../extension');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return {
      env: { language: 'en' }, l10n: { t: (text) => text },
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
      ...vscodeOverrides,
    };
    if (request === './fit-files' && parent.filename === modulePath) {
      return { ...originalLoad.call(this, request, parent, isMain), ...fitFileOverrides };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const loaded = new Module(modulePath, module);
    loaded.filename = modulePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(modulePath));
    loaded._compile(fs.readFileSync(modulePath, 'utf8')
      + '\nmodule.exports.__test = { getTrainingContextFromDb, getProfileHeartRateConfig, prepareAnalysisData, indexFitUris, reanalyzeOutdatedActivities, needsDerivedFeatureRebuild, enqueueLlmTask, awaitDerivedFeatureRebuild, setPendingRebuildForTest: (promise) => { pendingDerivedRebuild = promise; }, setContext: (context) => { extensionContextRef = context; } };', modulePath);
    return loaded.exports.__test;
  } finally {
    Module._load = originalLoad;
  }
}
const { applyHeartRateProfileUpsert, planHeartRateProfileTidy, readHeartRateProfiles } = require('../heart-rate-profiles');

function insertProfile(db, date, maxHr, thresholds) {
  db.run(`INSERT INTO heart_rate_profiles (effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start)
    VALUES (?, ?, ?, ?, ?, ?)`, [date, maxHr, ...thresholds]);
}

test('saving an identical heart-rate profile reuses the effective row instead of forking history', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    insertProfile(db, '2026-08-01', 171, [127, 138, 149, 160]);

    const reused = applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-10', maxHeartRate: 171, thresholds: [127, 138, 149, 160] }, '2026-08-10T10:00:00Z');
    assert.equal(reused.inserted, false, 'identical values do not create a new row');
    assert.equal(readHeartRateProfiles(db).length, 1);

    const changed = applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-10', maxHeartRate: 173, thresholds: [128, 139, 150, 161] }, '2026-08-10T10:00:00Z');
    assert.equal(changed.inserted, true, 'different values do create a row');
    assert.deepEqual(readHeartRateProfiles(db).map((row) => row.effective_date), ['2026-08-01', '2026-08-10']);

    // Inserting a value identical to the directly following profile removes that redundant duplicate.
    const collapse = applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-05', maxHeartRate: 173, thresholds: [128, 139, 150, 161] }, '2026-08-11T10:00:00Z');
    assert.equal(collapse.inserted, true);
    assert.deepEqual(readHeartRateProfiles(db).map((row) => row.effective_date), ['2026-08-01', '2026-08-05'], 'the later duplicate is removed');
  } finally {
    db.close();
  }
});

test('a max-HR flip between neighbours is reported but still saved', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    insertProfile(db, '2026-08-05', 171, [127, 138, 149, 160]);
    insertProfile(db, '2026-08-15', 173, [128, 139, 150, 161]);

    const result = applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-10', maxHeartRate: 171, thresholds: [127, 138, 149, 160] }, '2026-08-10T10:00:00Z');
    assert.equal(result.inserted, true);
    assert.match(result.notice, /returns to a value used before and after this date/);
  } finally {
    db.close();
  }
});

test('profile tidy-up collapses consecutive duplicates and lists max-HR flips', () => {
  const rows = [
    { effective_date: '2026-08-12', max_hr: 168, zone2_start: 126, zone3_start: 136, zone4_start: 147, zone5_start: 157 },
    { effective_date: '2026-08-13', max_hr: 168, zone2_start: 126, zone3_start: 136, zone4_start: 147, zone5_start: 157 },
    { effective_date: '2026-08-14', max_hr: 171, zone2_start: 127, zone3_start: 138, zone4_start: 149, zone5_start: 160 },
    { effective_date: '2026-08-16', max_hr: 171, zone2_start: 127, zone3_start: 138, zone4_start: 149, zone5_start: 160 },
  ];
  const { redundant, flips } = planHeartRateProfileTidy(rows);
  assert.deepEqual(redundant, ['2026-08-13', '2026-08-16']);
  assert.deepEqual(flips, ['2026-08-14: max HR 168 -> 171']);
});

test('batch re-analysis includes stale and missing analyses together and respects confirmation', async () => {
  const currentVersion = Number(/const ANALYSIS_VERSION = (\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'))[1]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-batch-analysis-'));
  const dbPath = path.join(directory, 'fit-data.sqlite');
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  ensureDatabaseSchema(db);
  db.run(`INSERT INTO activities (id, file_path, file_name, start_time, source, sport, total_timer_s, total_distance_km)
    VALUES (1, 'old.fit', 'old.fit', '2026-08-30T12:00:00.000Z', 'fit', 'cycling', 600, 5),
           (2, 'new.fit', 'new.fit', '2026-09-01T12:00:00.000Z', 'fit', 'cycling', 600, 5),
           (3, 'current.fit', 'current.fit', '2026-09-02T12:00:00.000Z', 'fit', 'cycling', 600, 5)`);
  db.run("INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version) VALUES (1, 'Old analysis', ?), (3, 'Current analysis', ?)", [currentVersion - 1, currentVersion]);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  let accept = false;
  let requests = 0;
  const reports = [];
  const messages = [];
  const internals = loadExtensionInternalsForTest({
    workspace: { getConfiguration: () => ({ get: (key) => key === 'logLlmRequests' ? false : undefined }) },
    l10n: { t: (text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index]) },
    ProgressLocation: { Notification: 15 },
    LanguageModelChatMessage: { User: (content) => ({ content }) },
    lm: { selectChatModels: async () => [{
      id: 'gpt-6-luna', sendRequest: async () => {
        requests += 1;
        return { text: (async function* () { yield 'Updated test analysis'; })() };
      },
    }] },
    window: {
      showQuickPick: () => { throw new Error('No mode selection should be shown'); },
      tabGroups: { activeTabGroup: { activeTab: null } },
      showInformationMessage: async (message, options, action) => {
        messages.push(message);
        if (options?.modal) {
          assert.match(message, /for 2 activities/);
          assert.match(message, /outdated and missing/);
          return accept ? action : undefined;
        }
      },
      withProgress: async (options, task) => task({ report: (report) => reports.push(report) }, { isCancellationRequested: false }),
    },
  });
  internals.setContext({ globalState: {
    get: (key) => key === 'fitVisualizer.lastDatabasePath' ? dbPath : undefined,
    update: async () => {},
  } });
  try {
    await internals.reanalyzeOutdatedActivities();
    assert.equal(requests, 0, 'Dismissing confirmation must not consume requests');
    accept = true;
    await internals.reanalyzeOutdatedActivities();
    assert.equal(requests, 2);
    assert.deepEqual(reports.map((report) => report.message), ['1/2: old.fit', '2/2: new.fit']);
    assert.equal(messages.at(-1), 'Re-analysis finished: 2 of 2 updated, 0 failed.');
    const updated = new SQL.Database(fs.readFileSync(dbPath));
    try {
      assert.deepEqual(updated.exec('SELECT activity_id, analysis_text, analysis_version FROM activity_analysis ORDER BY activity_id')[0].values,
        [[1, 'Updated test analysis', currentVersion], [2, 'Updated test analysis', currentVersion], [3, 'Current analysis', currentVersion]]);
    } finally {
      updated.close();
    }
    await internals.reanalyzeOutdatedActivities();
    assert.equal(requests, 2);
    assert.equal(messages.at(-1), `All analyses already use version ${currentVersion}.`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('FIT indexing reports progress and a persistent completion summary including failures', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-index-feedback-'));
  const lines = [];
  const reports = [];
  const events = [];
  const internals = loadExtensionInternalsForTest({
    l10n: { t: (text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index]) },
    ProgressLocation: { Notification: 15 },
    window: {
      createOutputChannel: () => ({ clear() {}, show() {}, appendLine: (line) => { lines.push(line); events.push(line); } }),
      withProgress: async (options, task) => {
        assert.equal(options.location, 15);
        assert.equal(options.title, 'Indexing FIT files');
        const result = await task({ report: (report) => reports.push(report) });
        events.push('progress finished');
        return result;
      },
    },
  }, {
    parseFitFile: async (file) => {
      if (file.endsWith('bad.fit')) throw new Error('Unreadable FIT');
      return { records: [], sessions: [] };
    },
  });
  try {
    const result = await internals.indexFitUris([
      { fsPath: path.join(directory, 'good.fit') }, { fsPath: path.join(directory, 'bad.fit') },
    ], path.join(directory, 'fit-data.sqlite'), 'Indexing two FIT files...');
    assert.deepEqual(result, { saved: 1, failed: 1 });
    assert.equal(lines.at(-1), 'FIT DB index complete: 1 indexed, 1 failed.');
    assert.match(lines.at(-2), /Failed: .*bad.fit -> Unreadable FIT/);
    assert.deepEqual(reports.filter((report) => report.message).map((report) => report.message), ['1/2: good.fit', '2/2: bad.fit']);
    assert.equal(reports.reduce((sum, report) => sum + (report.increment || 0), 0), 100);
    assert.equal(events.at(-2), 'progress finished');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const {
  calculateAutoHeartRateProfile,
  calculatePeakHeartRates,
  estimateLactateThresholdHeartRate,
  computeHeartRateZones,
  getHeartRateZoneIndex,
} = require('../heart-rate');
const {
  addEstimatedPowerWhenMissing,
  asNumber,
  bottomUpSegment,
  buildActivitySegments,
  calculateBanisterTrimp,
  calculateAutoFtp,
  calculateBikeStressScore,
  calculateHrTss,
  calculateRobustTrend,
  calculateHistoricalMeanMaximalPower,
  calculateIntensityFactor,
  calculateIntervalsDecoupling,
  calculateMeanMaximalPower,
  calculateNormalizedPower,
  calculateTrainingStressScore,
  calculateXPower,
  collapseShortStops,
  computeGpsDerivedSpeed,
  computeGrade,
  deriveSpeedsFromDistance,
  detectStops,
  downsamplePoints,
  escapeHtml,
  estimateSpeedConfidence,
  estimateWheelCalibrationRatio,
  formatHms,
  formatNumber,
  estimateFtpCandidates,
  estimatePowerFromMotion,
  haversineKm,
  normalizeRecordSpeeds,
  roundTo,
  segmentByGrade,
  segmentLineBudget,
  segmentByEffort,
  selectEffortSignal,
  selectFtpEstimate,
} = require('../utils');

// Terrain profile as [grade percent, seconds] pairs, sampled once per second.
function terrainRecords(profile, options = {}) {
  const records = [];
  let elapsed = 0;
  let altitudeM = 100;
  let distanceKm = 0;
  const speedKmh = options.speedKmh ?? 18;
  const startLat = 52;
  const startLon = 21;
  const lonPerMetre = 1 / (111320 * Math.cos((startLat * Math.PI) / 180));

  for (const [gradePct, seconds] of profile) {
    for (let i = 0; i < seconds; i += 1) {
      const metres = speedKmh / 3.6;
      altitudeM += (metres * gradePct) / 100;
      distanceKm += speedKmh / 3600;
      records.push({
        elapsed_time: elapsed,
        speed: speedKmh,
        distance: distanceKm,
        altitude: altitudeM / 1000,
        grade: gradePct,
        heart_rate: options.heartRateFor ? options.heartRateFor(elapsed) : 140,
        power: options.powerFor ? options.powerFor(elapsed) : undefined,
        position_lat: startLat,
        position_long: startLon + distanceKm * 1000 * lonPerMetre,
      });
      elapsed += 1;
    }
  }
  return records;
}

// Straight west-to-east leg at a steady speed, roughly one point per second.
function straightGpsRecords(count, speedKmh, options = {}) {
  const startLat = options.startLat ?? 52.0;
  const startLon = options.startLon ?? 21.0;
  const lonPerMetre = 1 / (111320 * Math.cos((startLat * Math.PI) / 180));
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const metres = (speedKmh / 3.6) * i;
    records.push({
      elapsed_time: i,
      speed: speedKmh,
      distance: (speedKmh / 3600) * i,
      altitude: 0.1,
      position_lat: startLat,
      position_long: startLon + metres * lonPerMetre,
    });
  }
  return records;
}

function gradeFixtureRecords() {
  const altitudes = [100, 101, 102.5, 104, 105, 105.2, 105.1, 104, 102, 100.5, 100.4, 100.4];
  const speeds = [18, 17, 16, 15, 14, 22, 30, 34, 36, 20, 0.9, 12];
  const records = [];
  let distance = 0;
  for (let i = 0; i < altitudes.length; i += 1) {
    distance += speeds[i] / 3600;
    records.push({
      elapsed_time: i,
      speed: speeds[i],
      altitude: altitudes[i] / 1000,
      distance,
      position_lat: 52.1 + i * 0.0001,
      position_long: 21.0 + i * 0.0001,
    });
  }
  return records;
}

test('webview selector script keeps a valid selectActivity payload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /type:\s*'selectActivity',\s*Number\.isFinite\(athleteProfile\.riderMassKg\)/s
  );
  assert.match(source, /type:\s*'selectActivity',\s*id:\s*document\.getElementById\('actSel'\)\.value/s);
  assert.match(source, /type:\s*'selectActivity'[\s\S]*?compId:/);
});

test('map card isolates leaflet stacking layers below the sticky toolbar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /\.chart\[data-target-type="map"\] \{[^}]*isolation:isolate/);
  assert.match(source, /\.toolbar \{[\s\S]*?z-index: 1100;/);
});

test('map zooms only with ctrl or cmd held', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /L\.map\('\$\{mapId\}', \{[^}]*scrollWheelZoom: false/);
  assert.match(source, /if \(!event\.ctrlKey && !event\.metaKey\)/);
  assert.match(source, /setZoomAround\(targetMap\.mouseEventToContainerPoint\(event\), next\)/);
});

test('map can color route segments from the existing activity segmentation', () => {
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const modelSource = fs.readFileSync(path.join(__dirname, '..', 'chart-model.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(extensionSource, /const segments = buildDisplaySegments\(data, athleteProfile, hrConfig\);/);
  assert.match(extensionSource, /function buildDisplaySegments\(fitData, athleteProfile, heartRateConfig\)/);
  assert.match(modelSource, /elapsedTime: point\.elapsed_time/);
  assert.match(webviewSource, /const activitySegments = \$\{segmentPayload\};/);
  assert.match(webviewSource, /<option value="segment" selected>\$\{escapeHtml\(ui\.segment\)\}<\/option>/);
  assert.match(webviewSource, /function segmentColor\(index\)/);
  assert.match(webviewSource, /displayColor: presentationByIndex\.get\(segment\.index\)\?\.color/);
  assert.match(webviewSource, /matchedSegment\?\.displayColor/);
  assert.match(webviewSource, /seenSegmentIndexes/);
  assert.doesNotMatch(webviewSource, /value="none"|singleColor|Single Color/);
});

test('rendered map initializer draws segment route polylines', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const records = straightGpsRecords(4, 18);
  const html = renderActivityContentHtml({}, {}, { records, sessions: [], laps: [] }, null, 'test-nonce', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en', [{
    index: 0, type: 'flat', startElapsed: 0, endElapsed: 3,
  }], null);
  const mapIife = html.match(/<script nonce="test-nonce">\s*(\(function \(\) \{\s*const routePoints =[\s\S]*?\n    \}\(\)\);)\s*<\/script>/)?.[1];
  assert.ok(mapIife, 'rendered HTML must contain the map initializer');

  const elements = new Map();
  const listeners = new Map();
  const mapElement = {
    style: {},
    appendChild() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const modeSelect = {
    value: 'segment',
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  elements.set('fitMap', mapElement);
  elements.set('fitMapMode', modeSelect);
  elements.set('fitMapSegmentLegend', { style: {}, innerHTML: '' });
  elements.set('fitMapRouteSection', { style: {} });
  const polylines = [];
  const tooltips = [];
  const map = {
    removeLayer() {},
    fitBounds() {},
    whenReady(callback) { callback(); },
    invalidateSize() {},
    getContainer() { return mapElement; },
    getZoom() { return 10; },
    getMinZoom() { return 0; },
    getMaxZoom() { return 20; },
    mouseEventToContainerPoint() { return {}; },
    setZoomAround() {},
  };
  const leaflet = {
    map() { return map; },
    tileLayer() { return { addTo() {} }; },
    latLngBounds() { return { pad() { return {}; } }; },
    circleMarker() { return { addTo() {} }; },
    polyline(points) {
      const line = { points, addTo() { polylines.push(line); return line; }, bindTooltip(content) { tooltips.push(content); } };
      return line;
    },
    TileLayer: function TileLayer() {},
  };
  const context = {
    window: { L: leaflet }, L: leaflet,
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement() { return { classList: { add() {}, remove() {} }, style: {}, textContent: '' }; },
    },
    navigator: { platform: 'Linux', userAgent: 'node' },
    setupResizablePanels() {}, setTimeout(callback) { callback(); }, clearTimeout() {},
    Number, Math, String, Array, Object, Map, NaN,
  };
  require('node:vm').runInNewContext(mapIife, context);
  assert.equal(polylines.length, records.length - 1);
  assert.equal(polylines.every((line) => line.points.length === 2), true);
  assert.equal(tooltips.length, records.length - 1);
});

test('chart and map segment hover reuse grouped AI presentation details', () => {
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const svgSource = fs.readFileSync(path.join(__dirname, '..', 'chart-svg.js'), 'utf8');
  assert.match(webviewSource, /const segmentPresentation = buildSegmentContext\(segments\);/);
  assert.match(webviewSource, /displayTime: presentationByIndex\.get\(segment\.index\)\?\.time/);
  assert.match(webviewSource, /if \(segment\.displayDetails\)/);
  assert.match(svgSource, /y="\$\{chart\.plotBottom - 9\}"[\s\S]*?height="9"/);
  assert.match(svgSource, /style="fill:\$\{escapeHtml\(segment\.displayColor\)\}"/);
});

test('segment map and chart hover tooltips reuse existing details without unavailable placeholders', () => {
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const svgSource = fs.readFileSync(path.join(__dirname, '..', 'chart-svg.js'), 'utf8');
  assert.match(webviewSource, /window\.formatSegmentDetails = function formatSegmentDetails/);
  assert.match(webviewSource, /function escapeSegmentHtml\(text\)/);
  assert.match(webviewSource, /function formatRouteMetricTooltip\(mode, value\)/);
  assert.match(webviewSource, /mode === 'speed'.*?km\/h/);
  assert.match(webviewSource, /mode === 'heart_rate'.*?bpm/);
  const mapFormatter = webviewSource.match(/window\.formatSegmentDetails = function formatSegmentDetails\(segment\) \{([\s\S]*?)\n      \};/)?.[1] || '';
  assert.doesNotMatch(mapFormatter, /escapeHtmlClient/);
  const mapDrawSegments = webviewSource.match(/function drawSegments\(mode\) \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.doesNotMatch(mapDrawSegments, /escapeHtmlClient/);
  assert.match(webviewSource, /const tooltip = mode === 'segment'/);
  assert.match(webviewSource, /if \(tooltip\) line\.bindTooltip\(tooltip/);
  assert.match(webviewSource, /id="\$\{mapId\}SegmentTooltip"/);
  assert.match(webviewSource, /chartSegments\.find/);
  assert.match(webviewSource, /Number\.isFinite\(Number\(segment\.avgHr\)\)/);
  assert.doesNotMatch(webviewSource, /N\/A/);
  assert.match(svgSource, /data-segment-index/);
  assert.match(webviewSource, /function showSegmentTooltip\(event, local\)/);
  assert.match(webviewSource, /showSegmentTooltip\(evt, local\);/);
});

test('FIT parser lap lists are retained only from its documented data.laps field', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'fit-files.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /function getParsedLaps\(data\) \{\s*return Array\.isArray\(data\?\.laps\) \? data\.laps : \[\];/);
  assert.match(extensionSource, /const laps = getParsedLaps\(fitData\);/);
});

test('activity table conditionally offers device laps alongside segment rendering input', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /const activityTable = renderActivityTable\(chartSegments, fitData\.laps, ui\)/);
  assert.match(source, /data-activity-table-tab="laps"/);
  assert.match(source, /lapRows\.length \?/);
  assert.match(source, /total_timer_time \?\? lap\.total_elapsed_time/);
  assert.match(extensionSource, /laps_json/);
  assert.match(extensionSource, /laps: parseStoredLaps\(activity\.laps_json\)/);
});

test('mapId is declared before it is used to build chart payloads (no TDZ crash)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const declarationIndex = source.indexOf("const mapId = isComparison ? 'fitMapComp' : 'fitMap';");
  const firstUseIndex = source.indexOf('const chartClientPayloads = safeJson({');
  assert.ok(declarationIndex > 0, 'mapId declaration must exist');
  assert.ok(declarationIndex < firstUseIndex, 'mapId must be declared before chartClientPayloads uses it');
});

test('chart client payload carries geometry and a trimmed point series', () => {
  const chart = {
    points: [{ x: 0, y: 10 }, { x: 1, y: 12.3456 }],
    plotLeft: 60, plotRight: 1380, plotTop: 12, plotBottom: 340,
    xMin: 0, xMax: 1, yMin: 10, yMax: 12.3456, width: 1400, height: 380,
  };
  const payload = buildChartClientPayload(chart, 'km', 'bpm');
  assert.deepEqual(payload.points, [[0, 10], [1, 12.346]]);
  assert.equal(payload.width, 1400);
  assert.equal(payload.yUnit, 'bpm');
  assert.equal(payload.overlays, undefined);
  assert.equal(buildChartClientPayload({ points: [{ x: 0, y: 1 }] }, 'km', 'bpm'), null);
});

test('chart SVG renderer outputs ticks, markers, zones, and a crosshair capture rect', () => {
  const renderer = createChartSvgRenderer({
    buildDistanceMarkers: () => [{ px: 50, label: '1 < km' }],
    escapeHtml,
    formatTick: (value) => `tick:${value}`,
    getHrZoneIndex: () => 2,
  });
  const chart = {
    points: [{ x: 0, y: 100 }, { x: 1, y: 120 }],
    pathPoints: [{ x: 20, y: 80 }, { x: 100, y: 30 }],
    pathData: '20,80 100,30',
    compPathData: '20,70 100,20',
    xTicks: [{ px: 20, value: 0 }], yTicks: [{ py: 80, value: 100 }],
    xStep: 1, yStep: 10, plotLeft: 20, plotRight: 100, plotTop: 10, plotBottom: 90, width: 120, height: 110,
  };
  const svg = renderer.renderScaledLineChartSvg(chart, 'lineA', 'Distance', 'Heart rate', true, {
    svgId: 'chart<id>', zoneThresholds: [100, 120, 140, 160],
  });

  assert.match(svg, /id="chart&lt;id&gt;"/);
  assert.match(svg, /class="kmMarker"/);
  assert.doesNotMatch(svg, /class="kmLabel"/);
  assert.match(svg, /class="xTicksGroup"/);
  assert.match(svg, /class="yTicksGroup"/);
  assert.match(svg, /class="overlayYAxisGroup"/);
  assert.equal((svg.match(/class="chartDataLayer"/g) || []).length, 2);
  const dataLayers = (svg.match(/<g class="chartDataLayer">[\s\S]*?<\/g><\/g>|<g class="chartDataLayer">[\s\S]*?<\/g>/g) || []).join('');
  assert.doesNotMatch(dataLayers, /<text/);
  assert.match(svg, /class="axis axisLineX"/);
  assert.equal((svg.match(/class="overlayYAxisGroup"/g) || []).length, 1);
  assert.match(svg, /<g class="overlayYAxisGroup"><\/g>\s*<\/svg>/);
  assert.match(svg, /class="zoneLine zoneLine3"/);
  assert.match(svg, /class="lineAComp"/);
  assert.match(svg, /class="crosshairCapture"/);
  assert.equal(renderer.renderScaledLineChartSvg({ points: [] }, 'lineA', 'x', 'y', false), '<div class="muted">Not enough data for this chart.</div>');
});

test('chart segment bands use distance ranges and are rendered behind chart ticks', () => {
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const chart = {
    points: [{ x: 0, y: 1 }, { x: 10, y: 2 }], pathPoints: [{ x: 20, y: 80 }, { x: 100, y: 30 }], pathData: '20,80 100,30',
    xTicks: [{ px: 20, value: 0 }], yTicks: [{ py: 80, value: 1 }], xStep: 1, yStep: 1,
    plotLeft: 20, plotRight: 100, plotTop: 10, plotBottom: 90, xMin: 0, xMax: 10, width: 120, height: 110,
  };
  const svg = renderer.renderScaledLineChartSvg(chart, 'lineA', 'Distance', 'Speed', false, {
    segmentBands: [{ type: 'climb', startDistanceKm: 2, endDistanceKm: 5 }],
  });
  assert.match(svg, /class="segmentBandGroup"><rect class="segmentBand segmentBandClimb" x="36\.0"/);
  assert.ok(svg.indexOf('segmentBandGroup') < svg.indexOf('class="xTicksGroup"'));
});

test('chart segment distance ranges interpolate elapsed boundaries and preserve provided distances', () => {
  const ranges = mapSegmentsToDistanceRanges([
    { type: 'climb', startElapsed: 5, endElapsed: 15 },
    { type: 'flat', startElapsed: 1, endElapsed: 2, startDistanceKm: 7, endDistanceKm: 8 },
  ], [
    { elapsed_time: 0, distance: 0 }, { elapsed_time: 10, distance: 2 }, { elapsed_time: 20, distance: 5 },
  ]);
  assert.deepEqual(ranges.map(({ type, startDistanceKm, endDistanceKm }) => ({ type, startDistanceKm, endDistanceKm })), [
    { type: 'climb', startDistanceKm: 1, endDistanceKm: 3.5 }, { type: 'flat', startDistanceKm: 7, endDistanceKm: 8 },
  ]);
});

test('GPS SVG renderer outputs route endpoints and handles missing routes', () => {
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const route = {
    points: [{}, {}], pathPoints: [{ x: 10, y: 20 }, { x: 90, y: 80 }], pathData: '10,20 90,80',
    xTicks: [{ px: 10, value: 1 }], yTicks: [{ py: 20, value: 2 }], xStep: 1, yStep: 1,
    plotLeft: 10, plotRight: 90, plotTop: 10, plotBottom: 90,
  };
  const svg = renderer.renderGpsRouteSvg(route, 100, 100);

  assert.match(svg, /aria-label="gps route"/);
  assert.match(svg, /class="routeStart" cx="10\.0" cy="20\.0"/);
  assert.match(svg, /class="routeEnd" cx="90\.0" cy="80\.0"/);
  assert.equal(renderer.renderGpsRouteSvg({ points: [] }, 100, 100), '<div class="muted">No usable GPS points found in this FIT file.</div>');
});

test('chart interactions script ports buildTicks, syncs a shared crosshair and adapts tick density', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /function buildTicksClient\(min, max, targetCount\)/);
  assert.match(source, /Math\.floor\(Math\.log10\(rough\)\)/);
  assert.match(source, /var payloads = \$\{chartClientPayloads\};/);
  assert.match(source, /new ResizeObserver\(function \(entries\) \{/);
  assert.match(source, /svgIds\.forEach\(function \(id\) \{\s*var target = instances\[id\];/);
  assert.match(source, /getScreenCTM\(\)/);
});

test('adaptive chart ticks recompute when only height changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const geometrySource = fs.readFileSync(path.join(__dirname, '..', 'chart-geometry.js'), 'utf8');
  assert.match(source, /var lastWidth = 0;\s*var lastHeight = 0;/);
  assert.match(source, /Math\.abs\(rect\.width - lastWidth\) < 1 && Math\.abs\(rect\.height - lastHeight\) < 1/);
  assert.match(source, /lastWidth = rect\.width;\s*lastHeight = rect\.height;/);
  assert.match(source, /withinRange\(yTicks, payload\.yMin, payload\.yMax\)/);
  assert.match(source, /withinRange\(xTicks, payload\.xMin, payload\.xMax\)/);
  assert.doesNotMatch(source, /Math\.max\(payload\.plotTop \+ 12, Math\.min\(payload\.plotBottom - 4/);
  // Gutters are CSS px, so labels fit regardless of how the viewBox is stretched.
  assert.match(source, /var plotLeft = LEFT_GUTTER_PX \/ xScale;/);
  assert.match(source, /var plotTop = TOP_GUTTER_PX \/ yScale;/);
  assert.match(source, /payload\.height - BOTTOM_GUTTER_PX \/ yScale/);
  assert.match(geometrySource, /const plotTop = margin\.top \+ 18;/);
  assert.match(geometrySource, /const plotBottom = height - margin\.bottom - 10;/);
  assert.match(geometrySource, /const safeY = padYAxisRange\(yMin, yMax\);/);
  assert.match(source, /clampCount\(plotWidthPx \/ 72, 4, 18\)/);
  assert.match(source, /function fitYTickCount\(payload, plotHeightPx\)/);
  assert.match(source, /for \(var count = clampCount\(plotHeightPx \/ 30, 6, 18\); count >= 2; count--\)/);
});

test('Y-axis range reserves headroom above the highest data value', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /require\('\.\/chart-geometry'\)/);
  assert.deepEqual(padYAxisRange(0, 50), { min: 0, max: 54 });
  assert.equal(padYAxisRange(42, 42).max > 42, true);
});

test('chart data module filters invalid samples and preserves chart statistics', () => {
  const series = extractXYPoints([
    { distance: 0, speed: 10 },
    { distance: 1, speed: null },
    { distance: 2, speed: 30 },
  ], 'distance', 'speed', 10, {});
  assert.deepEqual(series.points, [{ x: 0, y: 10 }, { x: 2, y: 30 }]);
  assert.deepEqual(series.yValues, [10, 30]);
  assert.deepEqual(computeStats(series.yValues), { count: 2, min: 10, max: 30, avg: 20, median: 20, p95: 29 });
});

test('activity summary falls back to records and preserves unavailable workload metrics', () => {
  const summary = buildSummary([
    { elapsed_time: 0, distance: 0, speed: 20, heart_rate: 120 },
    { elapsed_time: 60, distance: 0.5, speed: 30, heart_rate: 140 },
  ], [{}]);
  assert.equal(summary.distanceKm, 0.5);
  assert.equal(summary.durationSec, 60);
  assert.equal(summary.avgHr, 130);
  assert.equal(summary.normalizedPower, null);
  assert.equal(summary.trainingStressScore, null);
});

test('activity summary omits power-HR decoupling when power is motion-estimated', () => {
  const records = Array.from({ length: 1200 }, (_, elapsed_time) => ({
    elapsed_time,
    power: 200,
    heart_rate: 140,
  }));
  const session = [{ total_timer_time: 1200 }];

  assert.equal(buildSummary(records, session, { ftp: 250, powerSource: 'estimated' }).decouplingPct, null);
  assert.ok(Number.isFinite(buildSummary(records, session, { ftp: 250, powerSource: 'measured' }).decouplingPct));
});

test('chart model builds a shared geometry for primary and comparison series', () => {
  const chart = buildLineChart(
    [{ distance: 0, speed: 10 }, { distance: 2, speed: 20 }],
    'distance', 'speed', 200, 100, 10,
    { compRecords: [{ distance: 0, speed: 12 }, { distance: 2, speed: 22 }] }
  );
  assert.equal(chart.points.length, 2);
  assert.equal(chart.compStats.max, 22);
  assert.match(chart.pathData, /,/);
  assert.match(chart.compPathData, /,/);
});

test('client tick rounding keeps the server step at powers of ten', () => {
  const span = 2000;
  const targetCount = 3;
  const rough = span / Math.max(2, targetCount - 1);

  const oldMagnitude = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
  const clientMagnitude = Math.pow(10, Math.floor(Math.log10(rough)));

  assert.equal(rough, 1000);
  assert.equal(oldMagnitude, 100);
  assert.equal(clientMagnitude, 1000);
});

test('speed-axis tick density keeps a 10 km/h step for a 0-50 km/h range', () => {
  const min = 0;
  const max = 50;
  const targetCount = 6;
  const span = Math.abs(max - min);
  const rough = span / Math.max(2, targetCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  const nice = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  const step = nice * magnitude;

  assert.equal(step, 10);
});

test('crosshair shows a text label with the actual X/Y values at the hovered point', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const svg = renderer.renderScaledLineChartSvg({
    points: [{}, {}], pathData: '0,0 1,1', xTicks: [], yTicks: [], xStep: 1, yStep: 1,
    plotLeft: 0, plotRight: 100, plotTop: 0, plotBottom: 100, width: 100, height: 100,
  }, 'lineA', 'x', 'y', false, { svgId: 'chart' });
  assert.match(svg, /<text class="crosshairLabel" style="display:none">/);
  assert.match(svg, /<tspan class="crosshairLabelX"/);
  assert.match(svg, /<tspan class="crosshairLabelY"/);
  assert.match(source, /labelX\.textContent = formatCrosshairValue\(point\[0\], payload\.xUnit\);/);
  assert.match(source, /labelY\.textContent = formatCrosshairValue\(point\[1\], payload\.yUnit\);/);
  // Flips side near the right edge so the label text never runs off the chart.
  assert.match(source, /var nearRightEdge = pxNum > \(payload\.plotLeft \+ payload\.plotRight\) \/ 2;/);
  assert.match(source, /if \(label\) label\.style\.display = 'none';/);
});

test('chart text labels adapt to the rendered SVG scale', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const renderer = createChartSvgRenderer({ buildDistanceMarkers: () => [], escapeHtml, formatTick: String, getHrZoneIndex: () => 0 });
  const svg = renderer.renderScaledLineChartSvg({
    points: [{}, {}], pathData: '0,0 1,1', xTicks: [], yTicks: [], xStep: 1, yStep: 1,
    plotLeft: 0, plotRight: 100, plotTop: 0, plotBottom: 100, width: 100, height: 100,
  }, 'lineA', 'Distance', 'Value', false);
  assert.match(source, /function updateChartTextScale\(svg, payload, rect\)/);
  assert.match(source, /var xScale = rect\.width \/ payload\.width;/);
  assert.match(source, /var yScale = rect\.height \/ payload\.height;/);
  // Every text node undoes the non-uniform X/Y stretch around its own anchor.
  assert.match(source, /var unscale = ' scale\(' \+ \(1 \/ xScale\)\.toFixed\(4\) \+ ' ' \+ \(1 \/ yScale\)\.toFixed\(4\) \+ '\)';/);
  assert.match(source, /svg\.querySelectorAll\('\.tick, \.overlayTick'\)/);
  assert.match(source, /unstretch\(axisX, AXIS_TITLE_FONT_PX,/);
  assert.match(source, /unstretch\(crosshairLabel, 13,/);
  assert.match(source, /axisY\.setAttribute\('transform', 'translate\(' \+ \(16 \/ xScale\)/);
  assert.match(source, /var TICK_FONT_PX = 13;/);
  assert.match(source, /unstretch\(el, TICK_FONT_PX,/);
  assert.doesNotMatch(source, /setReadableFont|textScale/);
  assert.match(source, /var chartRect = svg\.getBoundingClientRect\(\);[\s\S]*?updateChartTextScale\(svg, payload, chartRect\);/);
  assert.match(svg, /class="axisLabel axisLabelX"/);
  assert.match(source, /if \(instance\.lastRect\) updateChartTextScale\(svg, payload, instance\.lastRect\);/);
  assert.match(source, /redrawTicks\(svg, payload,[\s\S]*?updateChartTextScale\(svg, payload, rect\);/);
});

test('metric overlays reuse computeGrade once, exclude the chart\'s own metric and cap at two active', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  const overlaySource = fs.readFileSync(path.join(__dirname, '..', 'chart-overlays.js'), 'utf8');
  assert.match(overlaySource, /const grades = records\.some[\s\S]*?computeGrade\(records\)/);
  assert.match(source, /var OVERLAY_PALETTE = \['#e67e22', '#00acc1'\];/);
  assert.match(source, /if \(Object\.keys\(active\)\.length >= 2\) \{/);
  assert.doesNotMatch(source, /occupiedLabelYs/);
  assert.match(source, /value >= series\.min - tickEpsilon && value <= series\.max \+ tickEpsilon/);
  assert.match(source, /function redrawActiveOverlayAxes\(\)/);
  assert.match(source, /function initOverlayControls\(svgId, payload, instance, svg\)/);
  assert.match(source, /var OVERLAY_GUTTER_PX = 8 \+ OVERLAY_PALETTE\.length \* OVERLAY_AXIS_COLUMN_PX;/);
  // Plot width depends only on the SVG width, never on how many overlays are active.
  const layoutBody = source.match(/function applyLayout\(rect\) \{([\s\S]*?)\n        \}/)?.[1] || '';
  assert.match(layoutBody, /payload\.width - rightGutterPx \/ xScale/);
  assert.match(layoutBody, /payload\.overlays \? OVERLAY_GUTTER_PX : PLAIN_RIGHT_GUTTER_PX/);
  assert.doesNotMatch(layoutBody, /active/);
  assert.match(source, /payload\.plotRight \+ \(8 \+ slot \* OVERLAY_AXIS_COLUMN_PX\) \/ xScale/);
  assert.match(source, /nearestIndex\(instance\.pxXs, local\.x\)/);
  assert.doesNotMatch(source, /plotXScale|chartPlotGroup|gutterPx|targetPlotRight/);

  const metrics = {
    grade: { points: [{ x: 0, y: 1 }, { x: 1, y: 5 }], yValues: [1, 5] },
    altitude: { points: [{ x: 0, y: 100 }, { x: 1, y: 100 }], yValues: [100, 100] },
    speed: { points: [{ x: 0, y: 10 }, { x: 1, y: 20 }], yValues: [10, 20] },
    heart_rate: { points: [{ x: 0, y: 120 }, { x: 1, y: 140 }], yValues: [120, 140] },
  };

  const options = buildOverlayOptions(metrics, 'speed', { grade: 'Уклон', heart_rate: 'Пульс' }, { heart_rate: 'уд/мин' });
  assert.deepEqual(Object.keys(options).sort(), ['grade', 'heart_rate']);
  assert.match(overlaySource, /const \{ buildTicks \} = require\('\.\/chart-geometry'\);/);
  assert.match(source, /overlayYAxisGroup/);
  assert.match(source, /overlayTick/);
  assert.match(source, /crosshairOverlayValue/);
  assert.match(source, /series\.label \+ ': ' \+ formatCrosshairValue\(overlayPoint\[1\], series\.unit\)/);
  // A flat (zero-range) altitude series is not offered as an overlay: there is nothing to see.
  assert.equal(options.grade.min, 1);
  assert.equal(options.grade.max, 5);
  assert.deepEqual(options.grade.yTicks, [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  assert.equal(options.grade.yStep, 0.5);
  assert.equal(options.grade.unit, '%');
  assert.equal(options.grade.label, 'Уклон');
  assert.equal(options.heart_rate.label, 'Пульс');
  assert.equal(options.heart_rate.unit, 'уд/мин');
  const russianBundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  const russianUi = localizeUi((text) => russianBundle[text] || text);
  assert.equal(russianUi.avg, 'Средн.');
  assert.equal(russianUi.max, 'Макс.');
  assert.equal(russianUi.gpsPointsLabel, 'Точки GPS');
  assert.equal(russianUi.kilometersPerHour, 'км/ч');
});

test('stored analyses stay visible and reusable after a version bump', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.doesNotMatch(source, /getAnalysisFromDb/);
  // Strict version equality may only gate the "skip a new Copilot request" cache check.
  assert.match(source, /if \(!force\) \{\s*const existing = await getCachedAnalysisForCurrentVersion\(dbPath, numId\);/);
  assert.equal(source.match(/analysis_version = \?/g).length, 1);
  assert.match(source, /const analysis = selId \? await getLatestAnalysisAnyVersion\(dbPath, selId\) : null;/);
  assert.match(source, /const previousResult = hasManualHrOverrides \? null : await getLatestAnalysisAnyVersion\(dbPath, numId\)/);
  assert.match(source, /previousResult\?\.version >= ANALYSIS_VERSION/);
  assert.match(source, /const previousResult = hasManualHrOverrides \? null : await getLatestAnalysisAnyVersion\(dbPath, activityId\)/);
  assert.match(source, /const baseAnalysis = hasCurrentAnalysis \? previousResult\.text : null/);
  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(webviewSource, /escapeHtml\(ui\.olderAnalysis\)/);
});

test('bulk re-analysis command is registered end to end', () => {
  const commandsSource = fs.readFileSync(path.join(__dirname, '..', 'commands.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  assert.match(commandsSource, /register\(\s*'fitVisualizer\.reanalyzeOutdated'/);
  assert.match(commandsSource, /return \[[^\]]*reanalyzeOutdated[^\]]*\]/);
  assert.equal(
    manifest.contributes.commands.some((entry) => entry.command === 'fitVisualizer.reanalyzeOutdated'),
    true
  );
});

test('outdated analysis lookup covers older versions and never-analyzed activities', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const currentVersion = Number(/const ANALYSIS_VERSION = (\d+)/.exec(source)[1]);
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path, file_name, start_time) VALUES
      (1, 'a.fit', 'a.fit', '2026-08-01'),
      (2, 'b.fit', 'b.fit', '2026-08-02'),
      (3, 'c.fit', 'c.fit', '2026-08-03'),
      (4, 'd.fit', 'd.fit', NULL),
      (5, 'e.fit', 'e.fit', '2026-08-02')`);
    db.run(`INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version) VALUES
      (1, 'current', ${currentVersion}),
      (2, 'stale', ${currentVersion - 1})`);

    const outdated = db.exec(`
      SELECT a.id, aa.analysis_version
      FROM activities a
      LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE aa.activity_id IS NULL OR aa.analysis_version < ${currentVersion}
      ORDER BY a.start_time IS NULL, a.start_time, a.id
    `)[0].values;

    // Oldest first, so each re-analysis can cite already-refreshed earlier activities.
    assert.deepEqual(outdated, [[2, currentVersion - 1], [5, null], [3, null], [4, null]]);

    const latestForStale = db.exec(`
      SELECT analysis_text, analysis_version FROM activity_analysis
      WHERE activity_id = 2 ORDER BY analysis_version DESC LIMIT 1
    `)[0].values[0];
    assert.deepEqual(latestForStale, ['stale', currentVersion - 1]);
  } finally {
    db.close();
  }
});

test('bulk re-analysis runs one Copilot request at a time', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const loop = /for \(let index = 0; index < targets\.length; index \+= 1\) \{[\s\S]*?\n    \}/.exec(source)[0];

  assert.match(loop, /await generateActivityAnalysis\(dbPath, target\.id, true\);/);
  assert.doesNotMatch(loop, /Promise\.(all|allSettled|race)/);
  // Analyses started from the webview must not interleave with a bulk run: sql.js rewrites the whole file.
  assert.match(source, /return enqueueLlmTask\(\(\) => runActivityAnalysis\(dbPath, activityId, force, modelOverride\)\)/);
  assert.match(source, /async function appendActivityChatTurn[\s\S]*?return enqueueLlmTask\(async \(\) => \{/);
});

function constantGradeRecords(grade = 0.06, noise = false, interval = 1) {
  return Array.from({ length: 121 }, (_, index) => ({
    elapsed_time: index * interval, speed: 18 / interval, distance: index * 0.005,
    altitude: (100 + index * 5 * grade + (noise ? Math.sin(index * 2) * 0.3 + (index === 50 ? 8 : 0) : 0)) / 1000,
  }));
}

test('computeGrade spatial smoothing preserves noisy steep climbs and does not need GPS', () => {
  const records = constantGradeRecords(0.22, true);
  const grades = computeGrade(records).slice(10, -10).filter(Boolean);
  assert.ok(grades.length > 90);
  assert.ok(grades.every((sample) => Math.abs(sample.grade - 0.22) < 0.025));
  const powers = estimatePowerFromMotion(records, { riderMassKg: 75, bikeMassKg: 10 });
  assert.ok(powers.length > 90, 'real slopes above 18% remain usable');
  assert.ok(powers.every((sample) => sample.power > 800 && sample.power < 1100));
});

test('computeGrade supports sparse recording and preserves changes in terrain', () => {
  const sparse = computeGrade(constantGradeRecords(0.08, false, 15));
  assert.ok(Math.abs(sparse[60].grade - 0.08) < 1e-9);
  const records = constantGradeRecords(0);
  records.forEach((record, index) => { record.altitude = (100 + Math.max(0, index - 60) * 0.5) / 1000; });
  const grades = computeGrade(records);
  assert.ok(Math.abs(grades[40].grade) < 1e-9);
  assert.ok(Math.abs(grades[80].grade - 0.1) < 1e-9);
});

test('computeGrade does not bridge pauses, resets, or insufficient spatial coverage', () => {
  assert.ok(computeGrade(constantGradeRecords().slice(0, 4)).every((sample) => sample === null));
  const records = constantGradeRecords();
  records[60].speed = 0;
  records[60].altitude = 10;
  const grades = computeGrade(records);
  assert.equal(grades[60], null);
  assert.equal(grades[61], null);
  assert.ok(Math.abs(grades[55].grade - 0.06) < 1e-9);
  records[60].speed = 18;
  records[60].elapsed_time = 2000;
  assert.equal(computeGrade(records)[60], null);
});

test('motion power charges for accelerating the rider and bike', () => {
  // Same flat ground, same speed, but one rider is accelerating into it.
  const steady = [];
  const accelerating = [];
  let steadyKm = 0;
  let acceleratingKm = 0;
  for (let elapsed = 0; elapsed <= 10; elapsed += 1) {
    const acceleratingKmh = 10 + elapsed;
    steadyKm += 20 / 3600;
    acceleratingKm += acceleratingKmh / 3600;
    const shared = { elapsed_time: elapsed, altitude: 0.1, position_lat: 50 + elapsed * 1e-5, position_long: 30 };
    steady.push({ ...shared, speed: 20, distance: steadyKm });
    accelerating.push({ ...shared, speed: acceleratingKmh, distance: acceleratingKm });
  }

  const mass = { riderMassKg: 80, bikeMassKg: 12 };
  const steadyAt20 = estimatePowerFromMotion(steady, mass).at(-1).power;
  const acceleratingAt20 = estimatePowerFromMotion(accelerating, mass).find((entry) => entry.elapsed_time === 10).power;

  assert.ok(acceleratingAt20 > steadyAt20 * 1.5,
    `accelerating must cost clearly more than holding speed: ${acceleratingAt20} vs ${steadyAt20}`);

  const withoutTerm = estimatePowerFromMotion(accelerating, { ...mass, includeAcceleration: false })
    .find((entry) => entry.elapsed_time === 10).power;
  assert.ok(withoutTerm < acceleratingAt20, 'switching the term off must drop the estimate back down');
});

test('computeGrade aligns with input records and reports slope as a fraction', () => {
  const records = constantGradeRecords();
  const grades = computeGrade(records);

  assert.equal(grades.length, records.length);
  assert.equal(grades[0], null);
  assert.equal(grades[1].elapsed_time, 1);
  assert.equal(grades[1].dt, 1);
  assert.ok(grades[1].grade > 0, 'climbing section has positive grade');
  assert.ok(Math.abs(grades[60].grade - 0.06) < 1e-9);
  assert.ok(Math.abs(grades[1].grade) < 1, 'grade is a fraction, not a percentage');
});

test('computeGrade skips missing altitude and starts a new spatial window', () => {
  const records = constantGradeRecords();
  delete records[60].altitude;
  const grades = computeGrade(records);
  assert.equal(grades[60], null);
  assert.equal(grades[61], null);
  assert.ok(grades[70]);
});

test('record insert stores grade only for meaningful movement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /const grades = computeGrade\(records\);/);
  assert.match(source, /grade\.dt > 0 && grade\.dt <= 30 && grade\.distanceM > 0\s*\?\s*roundTo\(grade\.grade \* 100, 2\)/);
  assert.match(source, /gradePct, null, null,/);
});

test('GPS derived speed reconstructs speed from positions alone', () => {
  const records = straightGpsRecords(20, 30);
  const gpsSpeeds = computeGpsDerivedSpeed(records);

  assert.equal(gpsSpeeds.length, records.length);
  assert.ok(Number.isNaN(gpsSpeeds[0]) || gpsSpeeds[0] > 0, 'first sample has no predecessor');
  for (let i = 5; i < records.length - 5; i += 1) {
    assert.ok(Math.abs(gpsSpeeds[i] - 30) < 1, `sample ${i} should be near 30 km/h, got ${gpsSpeeds[i]}`);
  }
});

test('GPS derived speed accepts semicircle coordinates and skips missing fixes', () => {
  const toSemicircles = (degrees) => Math.round((degrees * 2147483648) / 180);
  const records = straightGpsRecords(12, 36).map((record, index) => ({
    ...record,
    position_lat: index === 4 ? null : toSemicircles(record.position_lat),
    position_long: index === 4 ? null : toSemicircles(record.position_long),
  }));
  const gpsSpeeds = computeGpsDerivedSpeed(records);

  assert.ok(Math.abs(gpsSpeeds[8] - 36) < 1.5, `expected ~36 km/h, got ${gpsSpeeds[8]}`);
});

test('speed confidence stays low unless the stretch is long, straight and consistent', () => {
  const longStraight = straightGpsRecords(400, 30);
  const trusted = estimateSpeedConfidence(longStraight);
  assert.ok(trusted.includes('high'), 'a long clean straight should earn trust');

  const short = estimateSpeedConfidence(straightGpsRecords(40, 30));
  assert.ok(!short.includes('high'), 'a 300 m stretch is too short to average out GPS noise');

  const drifting = longStraight.map((record) => ({ ...record, speed: record.speed * 1.25 }));
  assert.ok(
    !estimateSpeedConfidence(drifting).includes('high'),
    'a systematic gap between wheel and GPS speed must not be trusted'
  );

  const winding = longStraight.map((record, index) => ({
    ...record,
    position_lat: record.position_lat + (index % 2 ? 0.0004 : -0.0004),
  }));
  assert.ok(!estimateSpeedConfidence(winding).includes('high'), 'a twisty track is not a trusted window');
});

test('stops cover both zero-speed runs and recording gaps', () => {
  const records = [];
  for (let i = 0; i < 20; i += 1) {
    records.push({ elapsed_time: i, speed: 25 });
  }
  for (let i = 20; i < 45; i += 1) {
    records.push({ elapsed_time: i, speed: 0 });
  }
  for (let i = 45; i < 50; i += 1) {
    records.push({ elapsed_time: i, speed: 25 });
  }
  records.push({ elapsed_time: 400, speed: 25 });

  const stops = detectStops(records);

  assert.deepEqual(stops.map((stop) => [stop.startIndex, stop.endIndex, stop.durationS]), [
    [20, 44, 24],
    [49, 50, 351],
  ]);
  assert.deepEqual(detectStops([{ elapsed_time: 0, speed: 0 }, { elapsed_time: 3, speed: 0 }]), []);
});

test('haversine distance matches a known one-degree separation', () => {
  assert.ok(Math.abs(haversineKm(52, 21, 53, 21) - 111.19) < 0.1);
  assert.equal(haversineKm(52, 21, 52, 21), 0);
});

test('wheel calibration ratio compares the wheel distance channel against GPS distance on trusted windows', () => {
  const base = straightGpsRecords(400, 30);
  // A miscalibrated wheel circumference scales both recorded speed and distance; GPS positions stay honest.
  const miscalibrated = base.map((record) => ({
    ...record,
    speed: record.speed * 1.05,
    distance: record.distance * 1.05,
  }));

  const result = estimateWheelCalibrationRatio(miscalibrated);
  assert.ok(result, 'a long straight trusted stretch should produce a calibration sample');
  assert.ok(Math.abs(result.ratio - 1.05) < 0.01, `expected ratio near 1.05, got ${result.ratio}`);
  assert.ok(result.trustedDistanceKm > 1);

  const badlyMiscalibrated = base.map((record) => ({
    ...record,
    speed: record.speed * 1.15,
    distance: record.distance * 1.15,
  }));
  const largeError = estimateWheelCalibrationRatio(badlyMiscalibrated);
  assert.ok(largeError, 'a large but stable wheel/GPS mismatch is exactly what calibration should detect');
  assert.ok(Math.abs(largeError.ratio - 1.15) < 0.01, `expected ratio near 1.15, got ${largeError.ratio}`);
  assert.ok(!estimateSpeedConfidence(badlyMiscalibrated).includes('high'), 'speed confidence still requires absolute agreement');

  assert.equal(estimateWheelCalibrationRatio(straightGpsRecords(20, 30)), null, 'a 150 m stretch is too short to trust');
  assert.equal(estimateWheelCalibrationRatio([]), null);
});

test('wheel calibration stays accurate on noisy GPS and rejects windows it cannot trust', () => {
  const mPerDegLat = 111320;
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const scatter = (noiseM) => {
    seed = 42;
    return straightGpsRecords(400, 30).map((record) => ({
      ...record,
      position_lat: record.position_lat + (random() * 2 * noiseM) / mPerDegLat,
      position_long: record.position_long
        + (random() * 2 * noiseM) / (mPerDegLat * Math.cos((record.position_lat * Math.PI) / 180)),
    }));
  };

  // The wheel is honest here, so any drift away from 1.0 is the measurement method's own error.
  const usable = estimateWheelCalibrationRatio(scatter(0.6));
  assert.ok(usable, 'mild scatter on a straight stretch is still usable');
  assert.ok(Math.abs(usable.ratio - 1) < 0.005, `expected a ratio near 1.0, got ${usable.ratio}`);

  // Once the scatter is large enough to matter, the window is dropped rather than mis-measured:
  // summing raw chords there would understate the ratio and hide a real wheel error.
  assert.equal(estimateWheelCalibrationRatio(scatter(2)), null);
});

test('wheel calibration integration: sample storage, recommendation gating and profile wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /DELETE FROM wheel_calibration_samples WHERE activity_id = \?/);
  assert.match(source, /INSERT INTO wheel_calibration_samples[\s\S]*?ON CONFLICT\(activity_id\) DO UPDATE SET/);
  assert.match(source, /Only stored when a calibration ratio was actually computable/);

  assert.match(source, /if \(rows\.length >= 15 \|\| cumulativeKm >= 20\)/);
  assert.match(source, /if \(totalKm < 15\) \{\s*return null;/);
  assert.match(source, /if \(Math\.abs\(deviationPct\) <= 1\) \{\s*return null;/);
  assert.match(source, /recommendedCircumferenceMm: currentMm != null \? roundTo\(currentMm \/ ratio, 1\) : null/);

  assert.match(source, /function parseOptionalWheelCircumference\(value\)/);
  assert.match(source, /mm < 1000 \|\| mm > 2500/);

  const webviewSource = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(webviewSource, /wheelCircumferenceMm: document\.getElementById\('\$\{mapId\}WheelCircumference'\)\.value,/);
  assert.match(source, /const wheelCalibration = await getWheelCalibrationRecommendation\(dbPath\);/);
});

test('wheel calibration hint recomputes live from the typed value instead of waiting for Save Zones', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');

  // The recommendation must not depend on a saved profile value: it reruns on every keystroke.
  assert.match(source, /data-ratio="\$\{wheelCalibration\.ratio\}"/);
  assert.match(source, /const ratio = parseFloat\(hint\.getAttribute\('data-ratio'\)\);/);
  assert.match(source, /wheelInput\?\.addEventListener\('input', updateSuggestion\);/);
  assert.match(source, /const recommended = Math\.round\(\(current \/ ratio\) \* 10\) \/ 10;/);
  assert.match(source, /updateSuggestion\(\);\s*\}\(\)\);/);

  // Applying the suggestion must not re-offer a second correction on top of the corrected value.
  assert.match(source, /applyBtn\.style\.display = 'none';/);
});

test('grade segmentation labels terrain and absorbs short wobbles', () => {
  const records = terrainRecords([[0.2, 120], [6, 300], [0.4, 180], [-7, 240], [0.1, 120]]);
  const segments = segmentByGrade(records);

  assert.deepEqual(segments.map((segment) => segment.type), ['flat', 'climb', 'flat', 'descent', 'flat']);
  assert.equal(segments[0].startIndex, 0);
  assert.equal(segments[segments.length - 1].endIndex, records.length - 1);

  const wobbly = terrainRecords([[0.2, 120], [3.4, 8], [0.2, 120]]);
  assert.deepEqual(segmentByGrade(wobbly).map((segment) => segment.type), ['flat']);
});

test('grade segmentation keeps stops as their own segments', () => {
  const records = terrainRecords([[0.2, 90], [0.2, 90], [0.2, 90]]);
  for (let i = 90; i < 130; i += 1) {
    records[i].speed = 0;
  }

  const types = segmentByGrade(records, { stops: detectStops(records) }).map((segment) => segment.type);
  assert.deepEqual(types, ['flat', 'stopped', 'flat']);
});

test('bottom-up segmentation finds level changes and ignores noise', () => {
  const steady = new Array(40).fill(200).map((value, index) => value + (index % 2 ? 4 : -4));
  assert.equal(bottomUpSegment(steady).length, 1);

  const stepped = [...new Array(20).fill(150), ...new Array(20).fill(300)];
  const parts = bottomUpSegment(stepped);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].end, 19);
  assert.equal(parts[1].start, 20);
});

test('effort signal follows the sport and the reliability of the segment', () => {
  const climb = { type: 'climb', avgGrade: 6, hasPower: true, hasHeartRate: true, vpowerUse: 'conditional relative comparison' };
  assert.equal(selectEffortSignal(climb, { sport: 'cycling', powerSource: 'estimated' }).basis, 'vpower');
  assert.equal(selectEffortSignal(climb, { sport: 'cycling', powerSource: 'measured' }).basis, 'power');

  const flat = { type: 'flat', avgGrade: 0.5, hasPower: true, hasHeartRate: true };
  assert.equal(selectEffortSignal(flat, { sport: 'cycling', powerSource: 'estimated' }).basis, 'hr');

  const technical = { type: 'descent', avgGrade: -12, technical: true, hasPower: true, hasHeartRate: true };
  assert.equal(selectEffortSignal(technical, { sport: 'cycling', powerSource: 'estimated' }).basis, 'none');

  assert.equal(selectEffortSignal({ type: 'stopped' }, { sport: 'cycling' }).basis, 'none');
  assert.equal(selectEffortSignal(climb, { sport: 'running', powerSource: 'estimated' }).basis, 'hr');
  // Unknown sports fall back to heart rate instead of guessing with a cycling model.
  assert.equal(selectEffortSignal(climb, { sport: 'hiking', powerSource: 'estimated' }).basis, 'hr');
});

test('activity segments combine terrain, effort basis and aggregates', () => {
  const records = terrainRecords([[0.2, 180], [6, 300], [-9, 180]], {
    speedKmh: 20,
    powerFor: (elapsed) => (elapsed >= 180 && elapsed < 480 ? 240 : 120),
    heartRateFor: (elapsed) => (elapsed >= 180 && elapsed < 480 ? 160 : 130),
  });
  const segments = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' });

  assert.ok(segments.length >= 3);
  assert.deepEqual(segments.map((segment) => segment.index), segments.map((segment, index) => index));
  assert.equal(segments[0].startIndex, 0);
  assert.equal(segments[segments.length - 1].endIndex, records.length - 1);

  // Heart rate and power in this synthetic ride change at the same second, so a short transition piece is expected.
  const climb = segments.filter((segment) => segment.type === 'climb').sort((x, y) => y.durationS - x.durationS)[0];
  assert.equal(climb.effortBasis, 'hr');
  assert.equal(climb.vpowerUse, 'not assessed');
  assert.ok(climb.avgGrade > 5 && climb.avgGrade < 7);
  assert.ok(climb.elevGainM > 0);
  // Heart rate lags the effort, so its change points are placed about 20 s early.
  assert.ok(Math.abs(climb.avgPower - 240) <= 12, `expected ~240 W, got ${climb.avgPower}`);
  assert.ok(climb.distanceKm > 0, `expected a positive segment distance, got ${climb.distanceKm}`);

  const flat = segments.find((segment) => segment.type === 'flat');
  assert.equal(flat.effortBasis, 'hr');
  assert.ok(Math.abs(flat.avgHr - 130) <= 3, `expected ~130 bpm, got ${flat.avgHr}`);
  // GPS never confirms a wheel sensor by default, so speed stays untrusted.
  assert.equal(flat.speedConfidence, 'low');

  assert.deepEqual(buildActivitySegments([], {}), []);
});

test('short continuous climbs are not fragmented into effort micro-segments', () => {
  const records = terrainRecords([[0.2, 80], [5, 330], [0.2, 80]], {
    speedKmh: 14,
    powerFor: (elapsed) => 100 + (Math.floor(elapsed / 50) % 4) * 8,
  });
  const climbs = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' })
    .filter((segment) => segment.type === 'climb');

  assert.equal(climbs.length, 1);
  assert.ok(climbs[0].durationS > 300);
});

test('estimated segment effort includes quality gates and shared spatial grade', () => {
  const records = constantGradeRecords(0.1).map((record) => ({ ...record, grade: -12, heart_rate: 140 }));
  const power = addEstimatedPowerWhenMissing(records, { riderMassKg: 75, bikeMassKg: 10 });
  const segments = buildActivitySegments(power.records, { sport: 'cycling', powerSource: power.source });
  const climb = segments.find((segment) => segment.type === 'climb');
  assert.ok(climb);
  assert.equal(climb.effortBasis, 'vpower');
  assert.equal(climb.vpowerUse, 'conditional relative comparison');
  assert.ok(climb.gradeWindowM >= 30);
  assert.ok(climb.gradeCoveragePct >= 80);
  assert.equal(climb.hrCoveragePct, 100);
  assert.equal(selectEffortSignal({ ...climb, vpowerUse: 'not assessed' }, { sport: 'cycling', powerSource: 'estimated' }).basis, 'hr');
});

test('long segments expose half-by-half dynamics without labelling HR change as recovery', () => {
  const records = terrainRecords([[0, 800]], { speedKmh: 24,
    heartRateFor: (elapsed) => elapsed < 400 ? 130 : 131 });
  const segments = buildActivitySegments(records, { sport: 'cycling' });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].dynamics.firstHalfHr, 130);
  assert.ok(segments[0].dynamics.secondHalfHr >= 130.5);
  assert.equal(segments[0].hrDriftPct, null);
});

test('rough flat vpower does not create pseudo-intervals and coverage uses time rather than record count', () => {
  const noHr = addEstimatedPowerWhenMissing(constantGradeRecords(0, true), { riderMassKg: 75, bikeMassKg: 10 });
  const segments = buildActivitySegments(noHr.records, { sport: 'cycling', powerSource: noHr.source });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].effortBasis, 'none');
  const sparse = Array.from({ length: 20 }, (_, index) => {
    const elapsed_time = index < 10 ? index : 9 + (index - 9) * 10;
    return { elapsed_time, distance: elapsed_time * 0.005, altitude: 0.1, speed: 18,
      heart_rate: index < 10 ? 130 : null };
  });
  const summary = buildActivitySegments(sparse, { sport: 'cycling' });
  assert.equal(summary.length, 1);
  assert.ok(summary[0].hrCoveragePct < 12 && summary[0].hrCoveragePct > 5);
});

test('segment comparisons use ordered terrain and duration, not identical effort', () => {
  const segment = { index: 0, type: 'climb', durationS: 600, distanceKm: 2, avgGrade: 6, avgHr: 130 };
  const prior = { ...segment, index: 3, avgHr: 170, avgPower: 400 };
  const comparison = compareSegmentStructures([segment], [prior]);
  assert.equal(comparison.matches.length, 1);
  assert.equal(comparison.matchedDurationPct, 100);
  assert.equal(comparison.matches[0].route, 'route identity not established');
  assert.equal(compareSegmentStructures([segment], [{ ...prior, type: 'flat' }]).matches.length, 0);
});

test('training windows preserve volume without comparable rides and separate sports and equal periods', () => {
  const activities = [
    { activityId: 1, startTime: '2026-08-24', sport: 'cycling', durationS: 3600, distanceKm: 40 },
    { activityId: 2, startTime: '2026-08-23', sport: 'running', durationS: 1800, distanceKm: 5 },
    { activityId: 3, startTime: '2026-08-15', sport: 'cycling', durationS: 7200, distanceKm: 80 },
    { activityId: 4, startTime: '2026-08-26', sport: 'cycling', durationS: 9999, distanceKm: 999 },
  ];
  const context = buildTrainingContext(activities, '2026-08-25', 'cycling');
  assert.equal(context.windowDays, 90);
  assert.equal(context.comparisons.length, 0);
  assert.equal(context.volume[0].sports.find((row) => row.sport === 'cycling').durationS, 3600);
  assert.equal(context.volume[0].sports.find((row) => row.sport === 'running').durationS, 1800);
  assert.equal(context.volume[1].sports[0].durationS, 7200);
  assert.equal(context.recentHistory.length, 2);
  assert.equal(context.durationTrend, null);
  assert.match(context.coverageNote, /not rest days/);
});

test('adaptive training context includes covered intensity with dated thresholds', () => {
  const records = Array.from({ length: 60 }, (_, elapsed_time) => ({ elapsed_time, heart_rate: 140 }));
  const activity = attachActivityZones({ activityId: 1, startTime: '2026-08-20', sport: 'cycling', durationS: 60 },
    records, { maxHeartRate: 180, thresholds: [120, 130, 150, 160] });
  const context = buildTrainingContext([activity], '2026-08-25', 'cycling');
  assert.equal(context.volume[0].sports[0].coveredHrSeconds, 60);
  assert.equal(context.volume[0].sports[0].zoneSeconds[2], 60);
  const frequent = Array.from({ length: 8 }, (_, index) => ({ ...activity, startTime: `2026-08-${10 + index}` }));
  assert.equal(buildTrainingContext(frequent, '2026-08-25', 'cycling').windowDays, 28);
});

test('peak sustained heart rate is time-weighted and broken by missing HR or recording gaps', () => {
  const records = [
    ...Array.from({ length: 600 }, (_, elapsed_time) => ({ elapsed_time, heart_rate: elapsed_time >= 100 && elapsed_time < 160 ? 180 : 140 })),
    { elapsed_time: 600, heart_rate: null },
    ...Array.from({ length: 30 }, (_, index) => ({ elapsed_time: 700 + index * 5, heart_rate: 175 })),
  ];
  const peaks = calculatePeakHeartRates(records);
  assert.deepEqual(peaks, [{ seconds: 60, bpm: 180 }, { seconds: 300, bpm: 148 }]);
  const splitByGap = [...Array.from({ length: 40 }, (_, elapsed_time) => ({ elapsed_time, heart_rate: 190 })),
    ...Array.from({ length: 40 }, (_, index) => ({ elapsed_time: 100 + index, heart_rate: 190 }))];
  assert.deepEqual(calculatePeakHeartRates(splitByGap), []);

  const activity = (startTime, bpm) => attachActivityZones({ activityId: startTime, startTime, sport: 'cycling', durationS: 120 },
    Array.from({ length: 120 }, (_, elapsed_time) => ({ elapsed_time, heart_rate: bpm })), null);
  const context = buildTrainingContext([activity('2026-06-20', 185), activity('2026-08-20', 170)], '2026-08-25', 'cycling');
  assert.deepEqual(context.peakHeartRates, [{ seconds: 60,
    best28: { startTime: '2026-08-20', bpm: 170 }, best90: { startTime: '2026-06-20', bpm: 185 } }]);
  assert.equal(context.recentHistory[0].peakHr, undefined);
});

test('analysis prompt adds session-type evidence: intensity distribution, peak HR history and climb VAM', () => {
  const records = Array.from({ length: 1300 }, (_, elapsed_time) => ({ elapsed_time, heart_rate: elapsed_time < 600 ? 120 : 165 }));
  const context = buildTrainingContext([attachActivityZones({ activityId: 1, startTime: '2026-08-20', sport: 'cycling', durationS: 400 },
    Array.from({ length: 400 }, (_, elapsed_time) => ({ elapsed_time, heart_rate: 160 })), { maxHeartRate: 180 })], '2026-08-25', 'cycling');
  const segments = [
    { index: 0, type: 'climb', effortBasis: 'hr', startElapsed: 0, endElapsed: 600, durationS: 600, avgGrade: 6, avgHr: 150, elevGainM: 90 },
    { index: 1, type: 'climb', effortBasis: 'hr', startElapsed: 600, endElapsed: 690, durationS: 90, avgGrade: 6, avgHr: 160, elevGainM: 30 },
  ];
  const prompt = generateAnalysisPrompt({ sessions: [{ start_time: '2026-08-25', sport: 'cycling' }], records, segments },
    { total_activities: 1, trainingContext: context }, { maxHeartRate: 180 }, null, [], [], 'ru');
  assert.match(prompt, /Intensity distribution: low \(Recovery\+Endurance\) 46%, moderate \(Tempo\) 0%, high \(Threshold\+VO2max\) 54%/);
  assert.match(prompt, /high \(Threshold\+VO2max\) 100%/, 'period rows include the same grouping');
  assert.match(prompt, /- 5 min: 165 bpm; prior same-sport best: 28 and 90 days 160 bpm \(2026-08-20\)/);
  assert.match(prompt, /- 20 min: 146 bpm\n/);
  assert.match(prompt, /\+90 m, VAM ~540 m\/h/);
  assert.doesNotMatch(prompt, /\+30 m, VAM/);
  assert.match(prompt, /classify session type \(recovery, endurance, tempo, threshold, VO2max\/anaerobic, mixed or unstructured\)/);
  assert.match(prompt, /stimulus mix over periods/);
  const comparison = generateComparisonPrompt({ sessions: [{}], records }, { sessions: [{}], records: [] }, 'ru');
  assert.match(comparison, /Peak Sustained Heart Rate \(This Workout\)/);
  assert.doesNotMatch(comparison, /Peak Sustained Heart Rate \(Compared Activity\)|prior same-sport best/);
});

test('continuous flat terrain merges adjacent micro-segments with similar heart rate', () => {
  const records = terrainRecords([[0.2, 800]], {
    speedKmh: 24,
    heartRateFor: (elapsed) => 116 + (Math.floor(elapsed / 49) % 4) * 3,
  });
  const flats = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' })
    .filter((segment) => segment.type === 'flat');

  assert.equal(flats.length, 1);
  assert.ok(flats[0].durationS >= 790);
});

test('segments follow effort on a flat road: an 8 bpm step splits, a 2 bpm wobble does not', () => {
  const stepped = terrainRecords([[0, 900]], {
    speedKmh: 24,
    heartRateFor: (elapsed) => (elapsed < 450 ? 128 : 138) + (elapsed % 7 < 3 ? 1 : -1),
  });
  const parts = buildActivitySegments(stepped, { sport: 'cycling' });
  assert.equal(parts.length, 2);
  assert.ok(parts.every((segment) => segment.type === 'flat'));
  assert.ok(Math.abs(parts[0].endElapsed - 450) <= 30, `boundary near the HR step, got ${parts[0].endElapsed}`);
  assert.ok(parts[0].avgHr < 131 && parts[1].avgHr > 135);

  const wobble = terrainRecords([[0, 900]], { speedKmh: 24, heartRateFor: (elapsed) => 130 + (Math.floor(elapsed / 60) % 2 ? 1 : -1) });
  assert.equal(buildActivitySegments(wobble, { sport: 'cycling' }).length, 1);
});

test('effort segments are at least a minute, are named by terrain and never cross a stop', () => {
  const records = terrainRecords([[0, 240], [0, 240], [6, 360], [0, 240]], {
    speedKmh: 20,
    heartRateFor: (elapsed) => (elapsed < 240 ? 120 : elapsed < 480 ? 140 : elapsed < 840 ? 160 : 135),
  });
  for (let i = 400; i < 460; i += 1) records[i].speed = 0;
  const segments = buildActivitySegments(records, { sport: 'cycling' });
  const moving = segments.filter((segment) => segment.type !== 'stopped');
  assert.ok(moving.every((segment) => segment.durationS >= 59), 'no moving segment shorter than the minimum');
  assert.ok(segments.some((segment) => segment.type === 'stopped'));
  assert.ok(moving.some((segment) => segment.type === 'climb'));
  segments.forEach((segment, index) => {
    if (index) assert.equal(segment.startIndex, segments[index - 1].endIndex + 1, 'segments tile the ride');
  });
});

test('power steps split segments when heart rate is missing, and the grade is the fallback without either', () => {
  const noHr = terrainRecords([[0, 900]], {
    speedKmh: 24,
    heartRateFor: () => null,
    powerFor: (elapsed) => (elapsed < 450 ? 120 : 190),
  });
  assert.equal(buildActivitySegments(noHr, { sport: 'cycling', powerSource: 'estimated' }).length, 2);

  const bare = terrainRecords([[0.2, 300], [6, 300], [0.2, 300]], { speedKmh: 20, heartRateFor: () => null });
  const types = buildActivitySegments(bare, { sport: 'cycling' }).map((segment) => segment.type);
  assert.deepEqual(types, ['flat', 'climb', 'flat']);
});

test('segmentByEffort leaves the pieces contiguous and keeps stops as they are', () => {
  const records = terrainRecords([[0, 600]], { speedKmh: 22, heartRateFor: (elapsed) => (elapsed < 300 ? 125 : 140) });
  const stops = detectStops(records);
  const ranges = segmentByEffort(records, { stops });
  assert.equal(ranges[0].startIndex, 0);
  assert.equal(ranges.at(-1).endIndex, records.length - 1);
  ranges.forEach((range, index) => { if (index) assert.equal(range.startIndex, ranges[index - 1].endIndex + 1); });
  assert.equal(segmentByEffort(records.map((r) => ({ ...r, heart_rate: null, power: undefined })), { stops }), null);
});

test('segments drop meaningless aggregates and drift', () => {
  const records = terrainRecords([[0.2, 120], [0.2, 120], [0.2, 120]], {
    powerFor: () => 150,
  });
  for (let i = 120; i < 180; i += 1) {
    records[i].speed = 0;
  }
  const segments = buildActivitySegments(records, { sport: 'cycling', powerSource: 'estimated' });

  const stop = segments.find((segment) => segment.type === 'stopped');
  // Averaging speed or grade across a stop (or a recording gap) says nothing about the ride.
  assert.equal(stop.avgSpeedKmh, null);
  assert.equal(stop.avgGrade, null);
  assert.equal(stop.avgPower, null);
  assert.equal(stop.elevGainM, null);

  // Half-vs-half drift on a two-minute stretch is noise, and HR-based segments have no Pw:HR at all.
  assert.ok(segments.every((segment) => segment.hrDriftPct === null));
});

test('segmentation thresholds are exposed as settings', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;

  for (const key of [
    'fitVisualizer.segmentation.gradeThresholdPct',
    'fitVisualizer.segmentation.gradeHysteresisPct',
    'fitVisualizer.segmentation.minSegmentSeconds',
    'fitVisualizer.segmentation.technicalGradePct',
    'fitVisualizer.segmentation.effortMinSegmentSeconds',
    'fitVisualizer.segmentation.effortHrStepBpm',
    'fitVisualizer.segmentation.effortPowerStepWatts',
    'fitVisualizer.segmentation.stopSpeedKmh',
    'fitVisualizer.segmentation.stopMinSeconds',
    'fitVisualizer.segmentation.gpsTrustMinKm',
  ]) {
    assert.ok(properties[key], `${key} must be configurable`);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /thresholds: getSegmentationOptions\(\)/);
});

test('power model coefficients are configurable and reach every estimation call site', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['fitVisualizer.powerModel.dragArea'].default, 0.32);
  assert.equal(properties['fitVisualizer.powerModel.rollingResistance'].default, 0.004);

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /function getPowerModelOptions\(\)/);
  const callSites = source.match(/addEstimatedPowerWhenMissing\([\s\S]*?\}\);/g) || [];
  assert.equal(callSites.length, 5);
  for (const callSite of callSites) {
    assert.match(callSite, /\.\.\.(getPowerModelOptions\(\)|powerModelOptions)/);
  }
});

test('heart-rate zones use semantic order and stable boundaries', () => {
  const records = [100, 110, 120, 140, 160, 180]
    .map((heart_rate, elapsed_time) => ({ heart_rate, elapsed_time }));
  const result = computeHeartRateZones(records, 190);

  assert.deepEqual(
    result.zones.map((zone) => zone.name),
    ['Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO2max']
  );
  assert.deepEqual(result.zones.map((zone) => zone.seconds), [2, 1, 1, 1, 1]);
  assert.equal(getHeartRateZoneIndex(180, result.thresholds), 4);
});

test('heart-rate zones accept dated watch thresholds', () => {
  const records = [110, 125, 145, 165, 180]
    .map((heart_rate, elapsed_time) => ({ heart_rate, elapsed_time }));
  const result = computeHeartRateZones(records, 190, [120, 140, 160, 175]);

  assert.deepEqual(result.thresholds, [120, 140, 160, 175]);
  assert.deepEqual(result.zones.map((zone) => zone.range), [
    '95-119 bpm', '120-139 bpm', '140-159 bpm', '160-174 bpm', '175-190 bpm',
  ]);
});

test('auto HR profile uses sex age resting HR and observed maxima', () => {
  const result = calculateAutoHeartRateProfile({
    sex: 'male',
    age: 40,
    restingHeartRate: 55,
    observedMaxHeartRate: 186,
  });

  assert.equal(result.maxHeartRate, 186);
  assert.deepEqual(result.thresholds, [134, 147, 160, 173]);
  assert.equal(result.formulaMaxHeartRate, 180);
  assert.equal(result.observedMaxHeartRate, 186);
});

test('auto HR profile uses the Tanaka max-HR estimate across sex selections', () => {
  for (const sex of ['male', 'female', 'other']) {
    const result = calculateAutoHeartRateProfile({ sex, age: 50, restingHeartRate: 60 });
    assert.equal(result.formulaMaxHeartRate, 173);
    assert.equal(result.maxHeartRate, 173);
  }
});

test('shared formatting utilities preserve display behavior', () => {
  assert.equal(formatHms(3661), '01:01:01');
  assert.equal(formatNumber(12.3456), '12.35');
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
  assert.deepEqual(downsamplePoints([0, 1, 2, 3], 2), [0, 2]);
  assert.equal(Number.isNaN(asNumber(null)), true);
  assert.equal(Number.isNaN(asNumber('')), true);
});

test('activity glossary localizes visible metric descriptions from one source', () => {
  const translated = localizeGlossary((text) => text === GLOSSARY.trainingStressScore ? 'TSS: показатель тренировочной нагрузки.' : text);
  assert.equal(translated.trainingStressScore, 'TSS: показатель тренировочной нагрузки.');
  assert.match(translated.averagePower, /Average power/);
  assert.match(translated.maximumHeartRate, /Maximum heart rate/);
  assert.match(translated.normalizedPower, /Normalized Power/);
  assert.match(GLOSSARY.technical, /Technical/);

  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /asNumber,/);
  assert.match(source, /normalizeRecordSpeeds,/);
  assert.match(source, /const translate = \(message\) => generatedTranslations\?\.\[message\] \|\| vscode\.l10n\.t\(message\);/);
  assert.match(source, /const glossary = localizeGlossary\(translate\);/);
  assert.match(source, /class="term" title="\$\{escapeHtml\(description\)\}"/);
  assert.match(source, /metric\(ui\.avgPowerW \+ powerMetricSuffix, summary\.avgPower\.toFixed\(0\), 'averagePower', glossary\)/);
  assert.match(source, /\[ui\.maxHrBpm, a\.maxHr\.toFixed\(0\), b\.maxHr\.toFixed\(0\), 'maximumHeartRate'\]/);
  assert.match(source, /metric\(ui\.tssScore \+ powerMetricSuffix,[\s\S]*?'trainingStressScore', glossary\)/);
});

test('activity webview renderer executes its complete server-side render path', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const html = renderActivityContentHtml(
    {}, {}, {
      _fileName: 'ride.fit',
      records: [
        { elapsed_time: 0, distance: 0, speed: 18, heart_rate: 120, altitude: 0.1, position_lat: 50, position_long: 6 },
        { elapsed_time: 60, distance: 0.5, speed: 24, heart_rate: 140, altitude: 0.105, position_lat: 50.001, position_long: 6.001 },
      ],
      sessions: [{ total_distance: 0.5, total_timer_time: 60 }],
      laps: [],
    }, {}, 'nonce', false, null, {}, { text: 'Older analysis', version: 1 }, [], null,
    localizeUi(), localizeGlossary(), false, 'English', [{
      index: 0, type: 'descent', effortBasis: 'hr', startElapsed: 0, endElapsed: 60,
      durationS: 60, startDistanceKm: 0, endDistanceKm: 0.5, avgHr: 130, avgPower: 86, avgGrade: -4.4, elevGainM: 2,
    }], 8
  );
  assert.match(html, /fitMapSpeedSvg/);
  assert.match(html, /Interactive Map/);
  assert.match(html, /<th>Segment<\/th><th>Time<\/th><th>Distance<\/th><th>Terrain<\/th><th>Grade<\/th><th>Effort<\/th><th>Heart Rate<\/th><th>Speed<\/th><th>Elevation<\/th>/);
  assert.match(html, /<td>Descent<\/td>/);
  assert.match(html, /<td>-4\.4%<\/td>/);
  assert.match(html, /<td>130 bpm<\/td>/);
  assert.doesNotMatch(html, /vPower 86 W|Power 86 W|\+2 m|0\.00 km/);
});

test('localized webview UI uses one complete string catalog', () => {
  const defaultBundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.json'), 'utf8'));
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  assert.equal(validateTranslationBundle(defaultBundle), defaultBundle);
  for (const message of Object.values(UI_STRINGS)) {
    assert.equal(defaultBundle[message], message, `Missing default VS Code localization entry: ${message}`);
    assert.ok(bundle[message], `Missing Russian UI translation: ${message}`);
  }
  const localized = localizeUi((text) => bundle[text] || text);
  assert.equal(localized.analyzeActivity, 'Анализировать активность');
  assert.equal(formatUi(localized.error, 'Нет данных'), 'Ошибка: Нет данных');
  assert.equal(formatUi('{0} / {1}', 0, 2), '0 / 2');

  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /const ui = localizeUi\(translate\);/);
  assert.match(source, /<html lang="\$\{escapeHtml\(locale\)\}">/);
  assert.match(source, /const ui = \$\{safeJson\(ui\)\};/);
});

test('generated translation bundles must exactly match the UI and glossary catalogs', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  assert.equal(validateTranslationBundle(bundle), bundle);
  assert.throws(() => validateTranslationBundle({}), /exactly the current UI string catalog/);
  assert.throws(() => validateTranslationBundle({ ...bundle, 'Error: {0}': 'Ошибка' }), /changed its placeholders/);
  assert.equal(parseGeneratedBundle(`\`\`\`json\n${JSON.stringify(bundle)}\n\`\`\``)['Activity'], 'Активность');
});

test('webview translation prompt builds the complete generated bundle request', () => {
  const { buildTranslationPrompt } = loadActivityWebviewForTest();
  const prompt = buildTranslationPrompt('de');
  assert.match(prompt, /locale "de"/);
  assert.match(prompt, /Return only one valid JSON object/);
  assert.match(prompt, /"Activity":""/);
  assert.match(prompt, /"Error: \{0\}":""/);
});

test('generated translation bundles are stored per locale outside the extension package', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'fitviz-l10n-'));
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  try {
    await saveGeneratedTranslationBundle(storagePath, 'es-MX', bundle);
    assert.deepEqual(await loadGeneratedTranslationBundle(storagePath, 'es_MX'), bundle);
    assert.equal(await loadGeneratedTranslationBundle(storagePath, 'invalid locale'), null);
  } finally {
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
});

test('bundled translations fall back from regional Russian to the Russian bundle', async () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.ru.json'), 'utf8'));
  assert.deepEqual(await loadBundledTranslationBundle(path.join(__dirname, '..'), 'ru-RU'), bundle);
  assert.equal(await loadBundledTranslationBundle(path.join(__dirname, '..'), 'en-US'), null);
});

test('normalized power equals constant power for steady efforts', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 120; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 250 });
  }

  const normalizedPower = calculateNormalizedPower(records);
  assert.ok(Math.abs(normalizedPower - 250) < 0.001);
});

test('auto FTP estimates a sustained 20-minute power effort', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 250 });
  }

  assert.equal(calculateAutoFtp(records), 238);
});

test('auto FTP ignores rides without a continuous 20-minute effort', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += 1) {
    records.push({ elapsed_time: elapsed < 600 ? elapsed : elapsed + 10, power: 250 });
  }

  assert.equal(calculateAutoFtp(records), 0);
});

test('MMP curve captures a short hard effort at its matching duration', () => {
  const records = [];
  for (let elapsed = 0; elapsed <= 300; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: elapsed < 240 ? 100 : 300 });
  }

  const curve = calculateMeanMaximalPower(records, [60, 300]);
  assert.equal(curve[0].power, 300);
  assert.ok(curve[1].power > 100);
  assert.ok(curve[1].power < 300);
});

test('historical MMP takes the best duration from each ride independently', () => {
  const firstRide = [];
  const secondRide = [];
  for (let elapsed = 0; elapsed <= 300; elapsed += 1) {
    firstRide.push({ elapsed_time: elapsed, power: 200 });
    secondRide.push({ elapsed_time: elapsed, power: 250 });
  }

  const curve = calculateHistoricalMeanMaximalPower([firstRide, secondRide], [300]);
  assert.equal(curve[0].power, 250);
});

test('FTP candidates prefer a well-fit critical-power estimate', () => {
  const curve = [60, 300, 1200, 3000].map((durationSec) => ({
    durationSec,
    power: 250 + (10000 / durationSec),
  }));

  const candidates = estimateFtpCandidates(curve);
  assert.ok(Math.abs(candidates.cp - 250) < 0.001);
  assert.ok(Math.abs(candidates.w_prime - 10000) < 0.001);
  assert.ok(candidates.r_squared > 0.999);
  assert.equal(selectFtpEstimate(candidates), 242);
});

test('motion power estimates uphill gravitational power', () => {
  // Parser units: speed km/h, altitude and distance km. 10 m/s at 10% grade.
  const records = [];
  for (let elapsed = 0; elapsed <= 10; elapsed += 1) {
    records.push({
      elapsed_time: elapsed,
      distance: elapsed * 0.01,
      speed: 36,
      altitude: elapsed * 0.001,
      position_lat: 50,
      position_long: 6,
    });
  }

  const estimated = estimatePowerFromMotion(records, { riderMassKg: 75, bikeMassKg: 10 });
  assert.ok(estimated.length > 0, 'Should produce at least one estimate');
  assert.ok(estimated.every((record) => record.power >= 0), 'All estimates should be non-negative');
  assert.ok(estimated.every((record) => record.power <= 2500), 'All estimates should stay under physiological limit');
  const avgEstimate = estimated.reduce((s, r) => s + r.power, 0) / estimated.length;
  assert.ok(avgEstimate > 200, 'Average power during uphill climb should be substantial');
  assert.ok(avgEstimate < 2000, 'Average power should stay in reasonable bounds');
});

test('motion power ignores zero-distance spikes and caps estimates', () => {
  const records = [0, 1, 2].map((elapsed_time) => ({
    elapsed_time,
    distance: 0,
    speed: 36,
    altitude: elapsed_time * 100,
    position_lat: 50,
    position_long: 6,
  }));

  const estimated = estimatePowerFromMotion(records, { riderMassKg: 75, bikeMassKg: 10 });
  assert.equal(estimated.length, 0);
  const steep = estimatePowerFromMotion(constantGradeRecords(0.4), { riderMassKg: 75, bikeMassKg: 10 });
  assert.ok(steep.length > 0);
  assert.ok(steep.every((record) => record.power === 1200 && record.capped));
});

test('summary power fallback preserves measured power and estimates missing power', () => {
  const missingPower = Array.from({ length: 20 }, (_, elapsed_time) => ({
    elapsed_time,
    distance: elapsed_time * 0.01,
    speed: 36,
    altitude: elapsed_time * 0.001,
    position_lat: 50,
    position_long: 6,
  }));
  const estimated = addEstimatedPowerWhenMissing(missingPower, { riderMassKg: 75, bikeMassKg: 10 });
  assert.equal(estimated.source, 'estimated');
  assert.equal(estimated.records[0].power, undefined);
  assert.ok(estimated.records[1].power > 0);

  const measured = addEstimatedPowerWhenMissing([{ elapsed_time: 0, power: 0 }], { riderMassKg: 75, bikeMassKg: 10 });
  assert.equal(measured.source, 'measured');
  assert.equal(measured.records[0].power, 0);
});

test('estimated power counts a stop as zero watts instead of dropping it', () => {
  const records = [];
  let distanceKm = 0;
  for (let elapsed = 0; elapsed < 220; elapsed += 1) {
    const speed = elapsed < 100 || elapsed >= 160 ? 20 : 0;
    distanceKm += speed / 3600;
    records.push({
      elapsed_time: elapsed, speed, distance: distanceKm, altitude: 0.1,
      position_lat: 50 + elapsed * 1e-5, position_long: 30,
    });
  }

  const estimated = addEstimatedPowerWhenMissing(records, { riderMassKg: 80, bikeMassKg: 12 });
  assert.equal(estimated.source, 'estimated');

  const stopped = estimated.records.slice(105, 155);
  assert.ok(stopped.every((record) => record.power === 0), 'every stopped sample carries an explicit zero');

  // Dropping the stop instead would raise NP well above the honest, time-weighted value.
  const withoutStop = calculateNormalizedPower(estimated.records.filter((record) => record.speed > 0));
  const withStop = calculateNormalizedPower(estimated.records);
  assert.ok(withStop < withoutStop, `stopped time must lower NP: ${withStop} vs ${withoutStop}`);
});

test('normalized power weights samples by elapsed time, not sample count', () => {
  // 200 W recorded every second for 10 min, then a sparse 0 W tail of the same duration.
  const dense = [];
  for (let elapsed = 0; elapsed <= 600; elapsed += 1) {
    dense.push({ elapsed_time: elapsed, power: 200 });
  }
  const sparse = [];
  for (let elapsed = 605; elapsed <= 1200; elapsed += 5) {
    sparse.push({ elapsed_time: elapsed, power: 0 });
  }

  const normalizedPower = calculateNormalizedPower([...dense, ...sparse]);
  // Sample counting would let the 601 dense samples swamp the 120 sparse ones and land near 190 W.
  assert.ok(normalizedPower < 175, `expected the sparse half to carry its own time, got ${normalizedPower}`);
});

test('normalized power handles Garmin-style 10- and 15-second recording intervals', () => {
  const dense = Array.from({ length: 1201 }, (_, elapsed_time) => ({
    elapsed_time,
    power: elapsed_time < 600 ? 100 : 300,
  }));
  const denseNp = calculateNormalizedPower(dense);
  for (const interval of [10, 15]) {
    const sparse = Array.from({ length: 1200 / interval + 1 }, (_, index) => ({
      elapsed_time: index * interval,
      power: index * interval < 600 ? 100 : 300,
    }));
    const sparseNp = calculateNormalizedPower(sparse);
    assert.ok(Math.abs(sparseNp - denseNp) / denseNp < 0.02,
      `${interval}-second recording should stay close to 1 Hz NP: ${sparseNp} vs ${denseNp}`);
  }
});

test('normalized power weights variable efforts above arithmetic mean', () => {
  // 20 min of alternating 2-min blocks at 100/200 W.
  const records = [];
  for (let elapsed = 0; elapsed < 1200; elapsed += 1) {
    const power = Math.floor(elapsed / 120) % 2 === 0 ? 100 : 200;
    records.push({ elapsed_time: elapsed, power });
  }

  const normalizedPower = calculateNormalizedPower(records);
  assert.ok(normalizedPower > 150);
  assert.ok(normalizedPower < 200);
});

test('normalized power includes zero-power samples and ignores missing power values', () => {
  const records = [
    { elapsed_time: 0, power: 0 },
    { elapsed_time: 1, power: 0 },
    { elapsed_time: 2, power: null },
    { elapsed_time: 3, power: 100 },
    { elapsed_time: 4, power: 100 },
  ];

  const normalizedPower = calculateNormalizedPower(records);
  assert.ok(normalizedPower > 0);
  assert.ok(normalizedPower < 100);
});

test('intensity factor and TSS follow standard power formulas', () => {
  const intensityFactor = calculateIntensityFactor(250, 300);
  assert.ok(Math.abs(intensityFactor - (250 / 300)) < 1e-9);

  const tss = calculateTrainingStressScore(3600, 250, intensityFactor, 300);
  assert.ok(Math.abs(tss - 69.4444) < 0.001);
});

test('unavailable workload metrics use null rather than a misleading zero', () => {
  assert.equal(calculateNormalizedPower([]), null);
  assert.equal(calculateNormalizedPower([{ elapsed_time: 0, power: null }]), null);
  assert.equal(calculateXPower([]), null);
  assert.equal(calculateXPower([{ elapsed_time: 0, power: null }]), null);
  assert.equal(calculateIntensityFactor(null, 300), null);
  assert.equal(calculateTrainingStressScore(3600, null, null, 300), null);
  assert.equal(calculateBikeStressScore(3600, null, null, 300), null);
  assert.equal(calculateHrTss({ durationSec: 3600, avgHeartRate: null, restingHeartRate: 50, maxHeartRate: 190 }), null);
});

test('record speeds are derived from distance when the speed channel is zero', () => {
  const records = [];
  for (let elapsed = 0; elapsed <= 60; elapsed += 1) {
    records.push({ elapsed_time: elapsed, distance: elapsed * 0.005, speed: 0 }); // 18 km/h
  }

  const normalized = normalizeRecordSpeeds(records);
  assert.ok(normalized.slice(1).every((record) => record.speed > 15 && record.speed < 21));
});

test('record speed normalization keeps genuine stops and measured speeds', () => {
  const stopped = normalizeRecordSpeeds([
    { elapsed_time: 0, distance: 1, speed: 0 },
    { elapsed_time: 1, distance: 1, speed: 0 },
    { elapsed_time: 2, distance: 1, speed: 0 },
  ]);
  assert.ok(stopped.every((record) => record.speed === 0));

  const measured = normalizeRecordSpeeds([
    { elapsed_time: 0, distance: 0, speed: 20 },
    { elapsed_time: 1, distance: 0.01, speed: 22 },
  ]);
  assert.deepEqual(measured.map((record) => record.speed), [20, 22]);
});

test('record speed normalization falls back to enhanced_speed', () => {
  const normalized = normalizeRecordSpeeds([{ elapsed_time: 0, enhanced_speed: 25 }]);
  assert.equal(normalized[0].speed, 25);
});

test('derived speeds convert km distance and seconds to km/h', () => {
  const derived = deriveSpeedsFromDistance([
    { elapsed_time: 0, distance: 0 },
    { elapsed_time: 10, distance: 0.05 },
    { elapsed_time: 20, distance: 0.1 },
  ]);
  assert.ok(derived.slice(1).every((speed) => Math.abs(speed - 18) < 0.001));
});

test('xPower equals steady power and BikeStress follows stress equation', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 180; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 240 });
  }

  const xPower = calculateXPower(records);
  assert.ok(Math.abs(xPower - 240) < 0.01);

  const ftp = 300;
  const ri = calculateIntensityFactor(xPower, ftp);
  const bikeStress = calculateBikeStressScore(3600, xPower, ri, ftp);
  assert.ok(Math.abs(bikeStress - 64) < 0.2);
});

test('Intervals-style decoupling is near zero on stable power/HR', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1800; elapsed += 1) {
    records.push({ elapsed_time: elapsed, power: 200, heart_rate: 140 });
  }

  const decoupling = calculateIntervalsDecoupling(records, {
    ftp: 260,
    restingHeartRate: 50,
    maxHeartRate: 190,
  });

  assert.ok(Math.abs(decoupling) < 1);
});

test('Intervals-style decoupling increases with heart-rate drift at constant power', () => {
  const records = [];
  for (let elapsed = 0; elapsed < 1800; elapsed += 1) {
    const heartRate = elapsed < 900 ? 135 : 150;
    records.push({ elapsed_time: elapsed, power: 200, heart_rate: heartRate });
  }

  const decoupling = calculateIntervalsDecoupling(records, {
    ftp: 260,
    restingHeartRate: 50,
    maxHeartRate: 190,
  });

  assert.ok(decoupling > 0);
});

test('Banister TRIMP uses HR reserve and hrTSS uses threshold HR', () => {
  const input = {
    durationSec: 3600,
    avgHeartRate: 150,
    restingHeartRate: 50,
    maxHeartRate: 190,
    sex: 'male',
  };

  const trimp = calculateBanisterTrimp(input);
  const hrTss = calculateHrTss({ ...input, lactateThresholdHeartRate: 170 });

  assert.ok(trimp > 0);
  // Intensity is measured in the reserve between resting and threshold HR: (150-50)/(170-50).
  assert.ok(Math.abs(hrTss - (((150 - 50) / (170 - 50)) ** 2) * 100) < 1e-9);
  // One hour exactly at threshold is 100 by definition; near-resting HR must score near zero.
  assert.ok(Math.abs(calculateHrTss({ ...input, avgHeartRate: 170, lactateThresholdHeartRate: 170 }) - 100) < 1e-9);
  assert.ok(calculateHrTss({ ...input, avgHeartRate: 60, lactateThresholdHeartRate: 170 }) < 1);

  // Without an HR profile neither score is computable, and that must not look like a zero workload.
  assert.equal(calculateBanisterTrimp({ durationSec: 3600, avgHeartRate: 150 }), null);
  assert.equal(calculateHrTss({ durationSec: 3600, avgHeartRate: 150 }), null);
  // A ride with no heart-rate data at all is unscored, not zero.
  assert.equal(calculateBanisterTrimp({ ...input, avgHeartRate: 0 }), null);
  assert.equal(calculateHrTss({ ...input, avgHeartRate: 0, lactateThresholdHeartRate: 170 }), null);
});

test('estimated threshold HR uses the middle of the Threshold zone or 85% of max', () => {
  assert.equal(estimateLactateThresholdHeartRate(171, [127, 138, 149, 160]), 155);
  assert.equal(estimateLactateThresholdHeartRate(171, null), 145);
  assert.equal(estimateLactateThresholdHeartRate(NaN, null), null);
});

test('TRIMP and hrTSS integrate nonlinear HR intensity across recording intervals', () => {
  const records = Array.from({ length: 181 }, (_, index) => ({
    elapsed_time: index * 10,
    heart_rate: index >= 60 && index < 120 ? 160 : 100,
  }));
  const base = { durationSec: 1800, restingHeartRate: 50, maxHeartRate: 190, sex: 'male', records };
  const trimp = calculateBanisterTrimp({ ...base, avgHeartRate: 120 });
  const hrTss = calculateHrTss({ ...base, avgHeartRate: 120, lactateThresholdHeartRate: 170 });
  const constantTrimp = calculateBanisterTrimp({ ...base, records: [], avgHeartRate: 120 });
  const constantHrTss = calculateHrTss({ ...base, records: [], avgHeartRate: 120, lactateThresholdHeartRate: 170 });

  assert.ok(trimp > constantTrimp, 'the high-HR interval must count more under the nonlinear TRIMP curve');
  assert.ok(hrTss > constantHrTss, 'squaring each interval must preserve intensity spikes');
});

test('robust trend adapts its threshold to history noise and requires enough rides', () => {
  assert.equal(calculateRobustTrend([10, 11, 12, 13, 14, 15, 16]), null);
  const steady = calculateRobustTrend([20, 20.1, 19.9, 20, 20.1, 19.9, 20, 20.1]);
  const noisy = calculateRobustTrend([20, 15, 25, 18, 24, 16, 23, 17]);

  assert.equal(steady.direction, 'within-noise');
  assert.ok(noisy.thresholdPct > steady.thresholdPct);
});

test('decoupling reports null when it cannot be computed but keeps a genuine zero', () => {
  const profile = { ftp: 250, restingHeartRate: 50, maxHeartRate: 190 };

  assert.equal(calculateIntervalsDecoupling([], profile), null);
  // Enough samples, but no usable heart rate at all.
  const noHr = Array.from({ length: 40 }, (_, i) => ({ elapsed_time: i, power: 200, heart_rate: 0 }));
  assert.equal(calculateIntervalsDecoupling(noHr, profile), null);

  // Perfectly stable power and heart rate: 0% is the real answer, not a missing one.
  const stable = Array.from({ length: 1200 }, (_, i) => ({ elapsed_time: i, power: 200, heart_rate: 140 }));
  const coupled = calculateIntervalsDecoupling(stable, profile);
  assert.ok(Number.isFinite(coupled), 'a stable ride must produce a number, not null');
  assert.ok(Math.abs(coupled) < 1, `expected near-zero decoupling, got ${coupled}`);
});

test('database schema migrates manual HR overrides onto existing activities', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    db.run('CREATE TABLE activities (id INTEGER PRIMARY KEY, file_path TEXT UNIQUE, avg_hr REAL, max_hr REAL)');
    ensureDatabaseSchema(db);
    const columns = db.exec('PRAGMA table_info(activities)')[0].values.map((row) => row[1]);
    assert.equal(columns.includes('manual_avg_hr'), true);
    assert.equal(columns.includes('manual_max_hr'), true);
    const analysisColumns = db.exec('PRAGMA table_info(activity_analysis)')[0].values.map((row) => row[1]);
    assert.equal(analysisColumns.includes('analysis_version'), true);
    const profileColumns = db.exec('PRAGMA table_info(athlete_profile)')[0].values.map((row) => row[1]);
    assert.equal(profileColumns.includes('wheel_circumference_mm'), true);
    const calibrationColumns = db.exec('PRAGMA table_info(wheel_calibration_samples)')[0].values.map((row) => row[1]);
    assert.deepEqual(calibrationColumns, ['id', 'activity_id', 'computed_at', 'ratio', 'trusted_distance_km']);
  } finally {
    db.close();
  }
});

test('manual activity input creates a summary activity without FIT records', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const activityId = createManualActivity(db, {
      startTime: '2026-09-01T12:00:00.000Z',
      sport: 'cycling',
      durationS: 3600,
      distanceKm: 20,
      avgHr: 140,
      maxHr: 165,
      elevGainM: 250,
    });

    const activity = db.exec(`SELECT file_path, file_name, start_time, sport,
      total_distance_km, total_ascent_m, total_timer_s, total_elapsed_s,
      avg_hr, max_hr, avg_speed_kmh, record_count, lap_count, source
      FROM activities WHERE id = ${activityId}`)[0].values[0];

    assert.match(activity[0], /^manual:\/\//);
    assert.deepEqual(activity.slice(1), [
      'Manual Activity', '2026-09-01T12:00:00.000Z', 'cycling',
      20, 250, 3600, 3600, 140, 165, 20, 0, 0, 'manual',
    ]);
    assert.equal(db.exec(`SELECT COUNT(*) FROM records WHERE activity_id = ${activityId}`)[0].values[0][0], 0);
  } finally {
    db.close();
  }
});

test('manual activity handler opens, persists, and closes the sql.js database', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const handler = source.slice(source.indexOf('async function addAndBrowseManualActivity()'), source.indexOf('\nasync function resolveActiveDbPath'));

  assert.doesNotMatch(handler, /getDb\(/);
  assert.match(handler, /const SQL = await getSqlJs\(\);\s*db = await openDatabase\(SQL, dbPath\);/);
  assert.match(handler, /await persistDatabase\(db, dbPath\);/);
  assert.match(handler, /finally \{\s*db\?\.close\(\);\s*\}/);
});

test('database schema clears legacy zero sentinels from derived workload metrics', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (
      file_path, normalized_power, training_stress_score, intensity_factor,
      xpower, relative_intensity_gc, bike_stress_score, hr_tss, trimp
    ) VALUES ('legacy.fit', 0, 0, 0, 0, 0, 0, 0, 0)`);
    ensureDatabaseSchema(db);
    const row = db.exec(`SELECT normalized_power, training_stress_score, intensity_factor,
      xpower, relative_intensity_gc, bike_stress_score, hr_tss, trimp
      FROM activities WHERE file_path = 'legacy.fit'`)[0].values[0];

    assert.deepEqual(row, [null, null, null, null, null, null, null, null]);

    // A zero in one metric must not blank out genuinely measured values in the others.
    db.run(`INSERT INTO activities (
      file_path, normalized_power, training_stress_score, intensity_factor,
      xpower, relative_intensity_gc, bike_stress_score, hr_tss
    ) VALUES ('mixed.fit', 210, 95.4, 0.84, 205, 0.82, 92.1, 0)`);
    ensureDatabaseSchema(db);
    const mixed = db.exec(`SELECT normalized_power, training_stress_score, intensity_factor,
      xpower, relative_intensity_gc, bike_stress_score, hr_tss
      FROM activities WHERE file_path = 'mixed.fit'`)[0].values[0];

    assert.deepEqual(mixed, [210, 95.4, 0.84, 205, 0.82, 92.1, null]);

    // Decoupling is signed, so a stored 0 is a real reading and must survive the cleanup.
    db.run(`INSERT INTO activities (file_path, decoupling_pct, hr_tss) VALUES ('coupled.fit', 0, 0)`);
    ensureDatabaseSchema(db);
    const coupled = db.exec("SELECT decoupling_pct, hr_tss FROM activities WHERE file_path = 'coupled.fit'")[0].values[0];
    assert.deepEqual(coupled, [0, null]);
  } finally {
    db.close();
  }
});

test('database schema creates only extension-owned tables', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]
      .values
      .flat();
    assert.deepEqual(tables, ['activities', 'activity_analysis', 'activity_analysis_chat', 'activity_comparisons', 'activity_features', 'activity_notes', 'activity_routes', 'athlete_profile', 'heart_rate_profiles', 'records', 'routes', 'sqlite_sequence', 'wheel_calibration_samples']);
  } finally {
    db.close();
  }
});

test('heart-rate profiles resolve by date and fall back to latest saved profile', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run("INSERT INTO heart_rate_profiles (effective_date, max_hr) VALUES ('2026-07-01', 190), ('2026-07-20', 193)");
    const lookup = (date) => {
      const matched = db.exec(`
        SELECT effective_date, max_hr FROM heart_rate_profiles
        WHERE effective_date <= '${date}' ORDER BY effective_date DESC LIMIT 1
      `)[0]?.values[0];
      if (matched) {
        return matched;
      }
      return db.exec(`
        SELECT effective_date, max_hr FROM heart_rate_profiles
        ORDER BY effective_date DESC LIMIT 1
      `)[0]?.values[0];
    };

    assert.deepEqual(lookup('2026-07-19'), ['2026-07-01', 190]);
    assert.deepEqual(lookup('2026-07-20'), ['2026-07-20', 193]);
    assert.deepEqual(lookup('2026-06-30'), ['2026-07-20', 193]);
  } finally {
    db.close();
  }
});

test('Copilot analysis selects a model and joins streamed text', async () => {
  const requests = [];
  const vscode = {
    lm: {
      selectChatModels: async (selector) => {
        assert.deepEqual(selector, { vendor: 'copilot' });
        return [{
          sendRequest: async (messages) => {
            requests.push(messages);
            return { text: asyncChunks(['First ', 'second.']) };
          },
        }];
      },
    },
    LanguageModelChatMessage: {
      User: (content) => ({ role: 'user', content }),
    },
  };

  assert.equal(await requestCopilotAnalysis(vscode, 'Analyze this'), 'First second.');
  assert.deepEqual(requests, [[{ role: 'user', content: 'Analyze this' }]]);
});

test('Copilot analysis accepts a configured language-model vendor and defaults blank values', async () => {
  const selectors = [];
  const vscode = {
    lm: {
      selectChatModels: async (selector) => {
        selectors.push(selector);
        return [{ sendRequest: async () => ({ text: asyncChunks(['ok']) }) }];
      },
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  await requestCopilotAnalysis(vscode, 'test', { vendor: 'example-provider' });
  await requestCopilotAnalysis(vscode, 'test', { vendor: '   ' });

  assert.deepEqual(selectors, [{ vendor: 'example-provider' }, { vendor: 'copilot' }]);
});

test('Copilot analysis prefers an Auto model family when no available model has a known price', async () => {
  const selectors = [];
  const vscode = {
    lm: {
      selectChatModels: async (selector) => {
        selectors.push(selector);
        if (selector.family === 'auto') {
          return [{ id: 'auto-router', sendRequest: async () => ({ text: asyncChunks(['auto']) }) }];
        }
        return [{ id: 'mystery-model', sendRequest: async () => ({ text: asyncChunks(['default']) }) }];
      },
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  const logged = [];
  const result = await requestCopilotAnalysis(vscode, 'test', {
    preferCheapModel: true,
    onCompleted: (entry) => logged.push(entry),
  });

  assert.equal(result, 'auto');
  assert.deepEqual(selectors, [{ vendor: 'copilot' }, { vendor: 'copilot', family: 'auto' }]);
  assert.equal(logged[0].modelId, 'auto-router');
});

test('Copilot analysis falls back to a name-marker heuristic when Auto is unavailable', async () => {
  const vscode = {
    lm: {
      selectChatModels: async (selector) => {
        if (selector.family === 'auto') {
          return [];
        }
        return [
          { id: 'unknown-expensive', sendRequest: async () => ({ text: asyncChunks(['expensive']) }) },
          { id: 'unknown-haiku-model', sendRequest: async () => ({ text: asyncChunks(['cheap']) }) },
        ];
      },
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  const result = await requestCopilotAnalysis(vscode, 'test', { preferCheapModel: true });
  assert.equal(result, 'cheap');
});

test('Copilot analysis picks the cheapest model by published price', async () => {
  const pick = (id) => ({ id, sendRequest: async () => ({ text: asyncChunks([id]) }) });
  const vscode = {
    lm: {
      selectChatModels: async () => [
        pick('claude-fable-5'), pick('gpt-5.4'), pick('claude-haiku-4.5'), pick('gpt-6-luna'), pick('gpt-5.6-sol'),
      ],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  const logged = [];
  const result = await requestCopilotAnalysis(vscode, 'test', {
    preferCheapModel: true,
    onCompleted: (entry) => logged.push(entry),
  });
  assert.equal(result, 'gpt-6-luna');
  assert.equal(logged[0].modelId, 'gpt-6-luna');
});

test('model price lookup handles versioned ids, display names and mini/nano variants', () => {
  assert.equal(findModelPrice({ id: 'gpt-5.4-mini' }).name, 'GPT-5.4 mini');
  assert.equal(findModelPrice({ id: 'gpt-5.4-nano-2026-03-01' }).name, 'GPT-5.4 nano');
  assert.equal(findModelPrice({ id: 'x', name: 'Claude Fable 5.1' }).name, 'Claude Fable 5.1');
  assert.equal(findModelPrice({ family: 'claude-sonnet-5.5' }).name, 'Claude Sonnet 5.5');
  assert.equal(findModelPrice({ id: 'mystery-model' }), null);

  const ranked = rankModelsByCost([{ id: 'claude-fable-5' }, { id: 'unknown' }, { id: 'gpt-5.4-nano' }, { id: 'gpt-6-luna' }]);
  assert.deepEqual(ranked.map((entry) => entry.model.id), ['gpt-6-luna', 'gpt-5.4-nano', 'claude-fable-5']);
});

test('Copilot analysis keeps the default model when preferCheapModel is off or no marker matches', async () => {
  const vscode = {
    lm: {
      selectChatModels: async () => [
        { id: 'unknown-model-a', sendRequest: async () => ({ text: asyncChunks(['default']) }) },
        { id: 'unknown-model-b', sendRequest: async () => ({ text: asyncChunks(['also default']) }) },
      ],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  assert.equal(await requestCopilotAnalysis(vscode, 'test'), 'default');

  const vscodeAutoDisabled = {
    lm: {
      selectChatModels: async (selector) => (selector.family === 'auto' ? [] : [
        { id: 'unknown-model-a', sendRequest: async () => ({ text: asyncChunks(['default']) }) },
      ]),
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  assert.equal(await requestCopilotAnalysis(vscodeAutoDisabled, 'test', { preferCheapModel: true }), 'default');
});

test('Copilot analysis reports unavailable and empty models', async () => {
  const noModel = {
    lm: { selectChatModels: async () => [] },
    LanguageModelChatMessage: { User: (content) => content },
  };
  await assert.rejects(() => requestCopilotAnalysis(noModel, 'test'), /not installed or you are not signed in/);

  const emptyResponse = {
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => ({ text: asyncChunks(['  ']) }),
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  await assert.rejects(() => requestCopilotAnalysis(emptyResponse, 'test'), /empty analysis/);
});

test('Copilot analysis explains language model permission and policy failures', async () => {
  class LanguageModelError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  const vscode = (code) => ({
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => { throw new LanguageModelError(code); },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
    LanguageModelError,
  });

  await assert.rejects(() => requestCopilotAnalysis(vscode('NoPermissions'), 'test'), /not authorized/);
  await assert.rejects(() => requestCopilotAnalysis(vscode('Blocked'), 'test'), /blocked this analysis request/);
  await assert.rejects(() => requestCopilotAnalysis(vscode('NotFound'), 'test'), /model was not found/);
});

test('Copilot request logging captures the model, the prompt and the reply', async () => {
  const logged = [];
  const vscode = {
    lm: {
      selectChatModels: async () => [{
        id: 'gpt-test-1',
        sendRequest: async () => ({ text: asyncChunks(['Analysed.']) }),
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  await requestCopilotAnalysis(vscode, 'Prompt body', { onCompleted: (entry) => logged.push(entry) });
  assert.deepEqual(logged, [{ modelId: 'gpt-test-1', prompt: 'Prompt body', response: 'Analysed.' }]);

  const failing = {
    lm: {
      selectChatModels: async () => [{
        id: 'gpt-test-2',
        sendRequest: async () => { throw new Error('boom'); },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  const failures = [];
  await assert.rejects(() => requestCopilotAnalysis(failing, 'Prompt body', {
    onCompleted: (entry) => failures.push(entry),
  }));
  assert.equal(failures[0].error, 'boom');

  // A broken logger must never take down an analysis.
  const noisy = {
    lm: {
      selectChatModels: async () => [{ sendRequest: async () => ({ text: asyncChunks(['ok']) }) }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };
  assert.equal(await requestCopilotAnalysis(noisy, 'p', {
    onCompleted: () => { throw new Error('log failure'); },
  }), 'ok');
});

test('prompt block sizes are reported per heading', () => {
  const summary = summarizePromptBlocks([
    'Analyze this workout.',
    '',
    '**This Workout:**',
    '- Distance: 20 km',
    '',
    '**Segment Breakdown:**',
    '1. climb',
    '2. flat',
  ].join('\n'));

  assert.deepEqual(summary.blocks.map((block) => block.title), ['Preamble', 'This Workout', 'Segment Breakdown']);
  assert.equal(summary.blocks.reduce((sum, block) => sum + block.chars, 0), summary.totalChars);
  assert.ok(summary.blocks[2].chars > 0);
  assert.equal(summary.blocks[1].budget, 1500);
  assert.deepEqual(summary.overBudget, []);
  const big = summarizePromptBlocks(`**This Workout:**\n${'x'.repeat(1600)}`);
  assert.equal(big.blocks[0].over, true);
  assert.match(big.overBudget[0], /^This Workout: \d+\/1500 chars$/);
});

test('a prompt may be sent as several user messages and is logged joined', async () => {
  const requests = [];
  const reported = [];
  const vscode = {
    lm: { selectChatModels: async () => [{ sendRequest: async (messages) => { requests.push(messages); return { text: asyncChunks(['ok']) }; } }] },
    LanguageModelChatMessage: { User: (content) => ({ role: 'user', content }) },
  };
  await requestCopilotAnalysis(vscode, ['rules', 'data'], { onCompleted: (result) => reported.push(result) });
  assert.deepEqual(requests, [[{ role: 'user', content: 'rules' }, { role: 'user', content: 'data' }]]);
  assert.equal(reported[0].prompt, 'rules\n\ndata');
});

test('LLM request logging is configurable and wired into both call sites', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['fitVisualizer.logLlmRequests'].default, true);
  assert.ok(properties['fitVisualizer.llmLogRetentionDays']);
  assert.equal(properties['fitVisualizer.lmVendor'].default, 'copilot');

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /function getLanguageModelVendor\(\)/);
  assert.match(source, /vendor: getLanguageModelVendor\(\),/);
  assert.match(source, /kind: 'analysis',/);
  assert.match(source, /kind: 'chat', \.\.\.result/);
  assert.match(source, /path\.join\(path\.dirname\(dbPath\), 'logs'\)/);
});

test('cheap analysis model preference is configurable and applied only to one-off analysis', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['fitVisualizer.preferCheapAnalysisModel'].default, true);
  assert.deepEqual(properties['fitVisualizer.cheapModelMarkers'].default, ['haiku', 'mini', 'flash', 'nano', 'lite', 'small', 'luna']);

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /function getPreferCheapAnalysisModel\(\)/);
  // Unset means on: only an explicit false opts out.
  assert.match(source, /get\('preferCheapAnalysisModel'\) !== false/);
  assert.match(source, /function getCheapModelMarkers\(\)/);

  // Only the one-off analysis call site should read the cheap-model preference; chat keeps the picker's model.
  const analysisCallIndex = source.indexOf('kind: \'analysis\',');
  const chatCallIndex = source.indexOf('kind: \'chat\', ...result');
  const analysisCallStart = source.lastIndexOf('requestCopilotAnalysis(vscode, prompt, {', analysisCallIndex);
  const chatCallStart = source.lastIndexOf('requestCopilotAnalysis(vscode, prompt, {', chatCallIndex);
  const analysisCallSource = source.slice(analysisCallStart, analysisCallIndex);
  const chatCallSource = source.slice(chatCallStart, chatCallIndex);
  assert.match(analysisCallSource, /preferCheapModel: getPreferCheapAnalysisModel\(\)/);
  assert.doesNotMatch(chatCallSource, /preferCheapModel/);
});

test('Copilot analysis retries once when rate limited and then succeeds', async () => {
  let calls = 0;
  const retryOnce = {
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('Upstream provider rate limit hit');
          }
          return { text: asyncChunks(['Recovered analysis']) };
        },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  const result = await requestCopilotAnalysis(retryOnce, 'test', { retryDelayMs: 0, maxRetries: 1 });
  assert.equal(result, 'Recovered analysis');
  assert.equal(calls, 2);
});

test('Copilot analysis returns a friendly message after rate-limit retries are exhausted', async () => {
  let calls = 0;
  const alwaysRateLimited = {
    lm: {
      selectChatModels: async () => [{
        sendRequest: async () => {
          calls += 1;
          throw new Error('Upstream provider rate limit hit');
        },
      }],
    },
    LanguageModelChatMessage: { User: (content) => content },
  };

  await assert.rejects(
    () => requestCopilotAnalysis(alwaysRateLimited, 'test', { retryDelayMs: 0, maxRetries: 1 }),
    /Copilot rate limit reached/
  );
  assert.equal(calls, 2);
});

test('analysis prompt treats the first workout as an initial baseline', () => {
  const prompt = generateAnalysisPrompt({ sessions: [{ avg_hr: 131, max_hr: 177 }] }, {
    total_activities: 0,
  });

  assert.match(prompt, /No earlier activities within 75%-125%/);
  assert.match(prompt, /There are 0 earlier activities within 75%-125%/);
  assert.match(prompt, /not enough history to claim improvement, decline, stability, consistency, or a plateau/);
  assert.match(prompt, /Do not infer recovery status/);
  assert.match(prompt, /Do not assign HR zones/);
  assert.doesNotMatch(prompt, /A limited baseline comparison is possible/);
});

test('analysis prompt labels a single prior workout as limited history', () => {
  const prompt = generateAnalysisPrompt({ sessions: [{}] }, {
    total_activities: 1,
    recent_activity_count: 1,
    comparison_min_distance_km: 15,
    comparison_max_distance_km: 25,
  });

  assert.match(prompt, /Eligible Prior Activities: 1/);
  assert.match(prompt, /Distance Range: 15\.0-25\.0 km/);
  assert.match(prompt, /comparison against these distance-compatible rides is possible/);
  assert.match(prompt, /not enough history to claim improvement/);
});

test('analysis prompt uses the dated heart-rate profile', () => {
  const prompt = generateAnalysisPrompt({ sessions: [{}] }, { total_activities: 0 }, {
    effectiveDate: '2026-07-19',
    maxHeartRate: 193,
    thresholds: [118, 139, 159, 177],
  });

  assert.match(prompt, /Effective Date: 2026-07-19/);
  assert.match(prompt, /Maximum HR: 193 bpm/);
  assert.match(prompt, /Zone 2-5 Starts: 118, 139, 159, 177 bpm/);
  assert.match(prompt, /Use the supplied dated heart-rate profile/);
  assert.doesNotMatch(prompt, /Do not assign HR zones because/);
});

test('AI prompts omit whole-ride power estimates and label the hrTSS threshold as an estimate', () => {
  const fitData = { sessions: [{
    power_source: 'estimated',
    avg_power: 220, max_power: 900, normalized_power: 250, ftp: 180,
    intensity_factor: 1.39, training_stress_score: 190, xpower: 240,
    relative_intensity_gc: 1.33, bike_stress_score: 177, decoupling_pct: 12,
    hr_tss: 88, lactate_threshold_hr: 160,
  }] };
  const prompt = generateAnalysisPrompt(fitData, { total_activities: 0 });
  const chat = generateAnalysisChatPrompt(fitData, {}, {}, '', [], 'why?');

  for (const text of [prompt, chat]) {
    assert.doesNotMatch(text, /Average Power: 220|Normalized Power: 250|Intensity Factor: 1\.39|TSS: 190|xPower \(GC\): 240/);
    assert.match(text, /hrTSS: 88/);
    assert.match(text, /Estimated threshold HR used for hrTSS: 160 bpm/);
    assert.match(text, /hrTSS uses an estimated threshold HR \(middle of the Threshold zone\)/);
  }
});

test('AI context ignores manually overridden HR and stale analysis history', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /Object\.hasOwn\(sourceSession, '_device_avg_hr'\) \? sourceSession\._device_avg_hr : sourceSession\.avg_hr/);
  assert.match(source, /Object\.hasOwn\(sourceSession, '_device_max_hr'\) \? sourceSession\._device_max_hr : sourceSession\.max_hr/);
  assert.match(source, /_hasManualHrOverrides:[\s\S]*?activity\.manual_avg_hr != null[\s\S]*?activity\.manual_max_hr != null/);
  assert.match(source, /a\.manual_avg_hr IS NULL AND a\.manual_max_hr IS NULL/);
  assert.match(source, /aa\.analysis_version >= \?/);
  assert.match(source, /previousResult\?\.version >= ANALYSIS_VERSION\s*\? storedChat\s*:\s*storedChat\.filter\(\(entry\) => entry\?\.role === 'user'\)/);
  assert.match(source, /COALESCE\(activities\.sport, ''\) = COALESCE\(selected\.sport, ''\)/);
  assert.match(source, /calculateRobustTrend\(activities\.map\(\(activity\) => activity\[field\]\)\)/);
});

test('empty fields are dropped from the prompt instead of becoming N/A', () => {
  assert.equal(
    formatFieldsSkippingEmpty([['Distance', '20.0', 'km'], ['Cadence', null], ['TSS', undefined], ['Power', '']]),
    '- Distance: 20.0 km'
  );

  const sparse = generateAnalysisPrompt({ sessions: [{ total_distance_km: 20.1, avg_hr: 140 }] }, { total_activities: 0 });
  assert.doesNotMatch(sparse, /N\/A/);
  assert.doesNotMatch(sparse, /Avg Cadence/);
  assert.doesNotMatch(sparse, /xPower/);
  assert.match(sparse, /- Distance: 20\.10 km/);
  assert.match(sparse, /Absent fields may be unmeasured, withheld, unavailable or inapplicable/);

  const chat = generateAnalysisChatPrompt({ sessions: [{ total_distance_km: 20.1 }] }, {}, {}, '', [], 'why?');
  assert.doesNotMatch(chat, /N\/A/);
});

test('SQL training context keeps older user reports, excludes later activities and uses dated profiles', async () => {
  const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, '..', 'vendor', 'sql-wasm', file) });
  const db = new SQL.Database();
  const internals = loadExtensionInternalsForTest();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path, start_time, sport, total_timer_s, total_distance_km) VALUES
      (1, 'current.fit', '2026-08-25', 'cycling', 600, 10),
      (2, 'previous.fit', '2026-08-20', 'cycling', 600, 40),
      (3, 'future.fit', '2026-08-26', 'cycling', 9999, 999),
      (4, 'old.fit', '2026-04-01', 'cycling', 600, 10)`);
    db.run(`INSERT INTO heart_rate_profiles (effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start) VALUES
      ('2026-08-01', 180, 120, 130, 150, 160), ('2026-08-30', 210, 140, 160, 180, 200)`);
    db.run('INSERT INTO activity_analysis_chat (activity_id, chat_json) VALUES (?, ?)',
      [4, JSON.stringify([{ role: 'user', ts: '2026-04-02', content: 'Several goals; endurance and enjoying the ride.' }])]);
    db.run('INSERT INTO activity_analysis_chat (activity_id, chat_json) VALUES (?, ?)',
      [3, JSON.stringify([{ role: 'user', content: 'Future activity must not appear.' }])]);
    const context = internals.getTrainingContextFromDb(db, 1, { segments: [] });
    assert.equal(context.volume[0].sports[0].durationS, 600);
    assert.equal(context.volume[0].sports[0].distanceKm, 40);
    assert.equal(context.recentHistory.length, 1);
    assert.equal(context.userReports.length, 1);
    assert.match(context.userReports[0].content, /Several goals/);
    assert.equal(internals.getProfileHeartRateConfig(db, '2026-08-20').maxHeartRate, 180);
    assert.equal(internals.getProfileHeartRateConfig(db, '2026-07-01').maxHeartRate, null);
  } finally {
    db.close();
  }
});

test('analysis preparation never falls back from absent device HR to manual overrides', async () => {
  const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, '..', 'vendor', 'sql-wasm', file) });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-analysis-test-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const db = new SQL.Database();
  ensureDatabaseSchema(db);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  try {
    const prepared = await loadExtensionInternalsForTest().prepareAnalysisData(dbPath, { records: [], sessions: [{
      start_time: '2026-08-25', sport: 'cycling', avg_hr: 190, max_hr: 191,
      _device_avg_hr: null, _device_max_hr: null, _source: 'fit', _hasManualHrOverrides: true,
    }] }, 1);
    assert.equal(prepared.sessions[0].avg_hr, null);
    assert.equal(prepared.sessions[0].max_hr, null);
    assert.doesNotMatch(generateAnalysisPrompt(prepared, {}), /190 bpm|191 bpm/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sports prompts preserve multiple goals, dated corrections and evidence limits in analysis and chat', () => {
  const data = { sessions: [{ start_time: '2026-08-25', sport: 'running', total_distance_km: 10,
    decoupling_pct: null }], records: [{ temperature: null }] };
  const context = buildTrainingContext([{ startTime: '2026-08-20', sport: 'running', durationS: 3600, distanceKm: 40 }], '2026-08-25', 'running');
  const summary = { total_activities: 0, trainingContext: context };
  const history = [{ role: 'user', content: 'No single goal; returning after an operation with restrictions.', ts: '2026-08-24' }];
  const analysis = generateAnalysisPrompt(data, summary, {}, null, history, [], 'ru');
  const chat = generateAnalysisChatPrompt(data, summary, {}, '', history, 'What direction is emerging?', 'ru');
  for (const prompt of [analysis, chat]) {
    assert.match(prompt, /Goals may be absent, multiple, or change over time/);
    assert.match(prompt, /postoperative healing, medical clearance/);
    assert.match(prompt, /Repeated AI claims are not independent corroboration/);
    assert.match(prompt, /Training Volume and Covered Intensity/);
    assert.match(prompt, /Historical baseline anchored at 2026-08-25T00:00:00\.000Z/);
    assert.match(prompt, /current activity is excluded from every historical total/);
    assert.match(prompt, /rolling windows, not calendar weeks/);
    assert.match(prompt, /identical start\/end boundaries, sport, inclusion rules and data coverage/);
    assert.match(prompt, /comparison unverified, not erroneous/);
    assert.match(prompt, /Missing detail in the current summary does not disprove an earlier observation/);
    assert.match(prompt, /returning after an operation with restrictions/);
    assert.doesNotMatch(prompt, /cycling workout|Average Temperature: 0|Power:HR decoupling \(EF\): 0/);
  }
  assert.match(analysis, /Session Character and Stimulus/);
  assert.doesNotMatch(analysis, /\*\*Heart Rate & Recovery\*\*/);
});

test('analysis prompts use the VS Code language and leave unknown locales alone', () => {
  assert.match(responseLanguageInstruction('ru'), /Respond in Russian/);
  assert.match(responseLanguageInstruction('de-CH'), /Respond in German/);
  assert.match(responseLanguageInstruction('pt_BR'), /Respond in Brazilian Portuguese/);
  assert.equal(responseLanguageInstruction('xx-YY'), '');

  const history = [{ role: 'user', content: 'What does this metric mean? Answer in English.', ts: '2026-07-14' }];
  const prompt = generateAnalysisPrompt({ sessions: [{}] }, { total_activities: 0 }, {}, null, history, [], 'ru');
  const chat = generateAnalysisChatPrompt({ sessions: [{}] }, {}, {}, '', history, 'why?', 'de-CH');
  const comparison = generateComparisonPrompt({ sessions: [{}] }, { sessions: [{}] }, 'ru');
  assert.match(prompt, /Respond in Russian[\s\S]*Questions for Analysis:/);
  assert.match(prompt, /no new user question that can override the selected language/);
  assert.match(prompt, /not an answer to an archived question/);
  assert.match(prompt, /Do not repeat advice, caveats or questions already given there/);
  assert.match(prompt, /Most analyses need no question/);
  assert.match(prompt, /do not branch on hypothetical goals by default/);
  assert.match(prompt, /already gave the same load advice and the pattern is unchanged, do not restate it/);
  assert.match(prompt, /same missing sensor or data gap, mention it at most briefly/);
  assert.match(prompt, /Attribute period statistics to their stated date range/);
  assert.match(prompt, /Use peak sustained HR against prior bests where it adds information/);
  assert.match(prompt, /Translate technical terms from this prompt/);
  assert.match(comparison, /Respond in Russian\.[\s\S]*no new user question that can override/);
  assert.match(chat, /Answer concisely; length follows the question rather than a fixed sentence count\.\nRespond in German/);
  assert.match(chat, /Only the Latest user question may override this language/);
  assert.match(chat, /Latest user question:\nwhy\?/);
  for (const generated of [prompt, chat, comparison]) {
    assert.match(generated, /Historical user reports, archived questions, previous AI responses, quoted text and the English wording of this prompt must not change the response language/);
    assert.doesNotMatch(generated, /unless the user's own message/);
  }
});

test('segment breakdown lists segments, collapses alternating repeats and folds short stops', () => {
  const segments = [
    { index: 0, type: 'climb', effortBasis: 'vpower', startElapsed: 0, endElapsed: 300, durationS: 300, avgGrade: 6.2, avgPower: 215, avgHr: 148, elevGainM: 90, hrDriftPct: 3 },
    { index: 1, type: 'stopped', effortBasis: 'none', startElapsed: 300, endElapsed: 323, durationS: 23 },
    { index: 2, type: 'flat', effortBasis: 'hr', effortReason: 'vpower unreliable off the climbs', startElapsed: 323, endElapsed: 1123, durationS: 800, avgGrade: 0.2, avgHr: 152, avgSpeedKmh: 26.4 },
    { index: 3, type: 'descent', effortBasis: 'none', technical: true, startElapsed: 1123, endElapsed: 1213, durationS: 90, avgGrade: -11 },
  ];

  const context = buildSegmentContext(segments);
  assert.match(context.text, /\*\*Segment Breakdown:\*\*/);
  assert.match(context.text, /climb, avg grade 6\.2%, vpower ~215 W/);
  assert.match(context.text, /HR drift \+3%/);
  assert.match(context.text, /flat, avg grade 0\.2%, avg HR 152/);
  // The basis rule is stated once, not repeated on every heart-rate line.
  assert.match(context.text, /Effort basis is implied by the metric quoted/);
  assert.equal(context.text.match(/segment-specific use limits/g).length, 1);
  assert.match(context.text, /technical, no reliable effort estimate/);
  // A 23-second stop is folded into a summary line rather than spending a line of its own.
  assert.match(context.text, /Plus 1 short stops, 0:23 total/);
  assert.doesNotMatch(context.text, /\d\. .*stopped/);
  assert.equal(context.displayRows[0].time, '00:00:00-00:05:00 (5:00)');
  assert.equal(context.displayRows[0].details, 'climb, avg grade 6.2%, vpower ~215 W, avg HR 148, HR drift +3%, +90 m, VAM ~1080 m/h');
  assert.deepEqual(context.displayRows[0].members.map((segment) => segment.index), [0]);
  assert.equal(context.displayRows.at(-1).time, '');

  const intervals = [];
  for (let i = 0; i < 8; i += 1) {
    const start = i * 300;
    intervals.push({ index: i * 2, type: 'flat', effortBasis: 'power', startElapsed: start, endElapsed: start + 240, durationS: 240, avgPower: 250 + i, avgGrade: 0.1 });
    intervals.push({ index: i * 2 + 1, type: 'flat', effortBasis: 'power', startElapsed: start + 240, endElapsed: start + 300, durationS: 60, avgPower: 120 + i, avgGrade: 0.1 });
  }
  const grouped = buildSegmentContext(intervals);
  assert.equal(grouped.lines, 1, 'eight identical work/rest pairs collapse to one line');
  assert.match(grouped.text, /8x \[ ~4:00 flat power 250-257 W \| ~1:00 flat power 120-127 W \]/);
});

test('segment lines include distance next to speed, and for stops when known', () => {
  const segments = [
    { index: 0, type: 'descent', effortBasis: 'none', startElapsed: 24, endElapsed: 117, durationS: 93, avgGrade: -7.4, avgHr: 104, avgSpeedKmh: 34.6, distanceKm: 0.9 },
    { index: 1, type: 'stopped', effortBasis: 'none', startElapsed: 4089, endElapsed: 4401, durationS: 312, distanceKm: 0.1 },
  ];
  const context = buildSegmentContext(segments);
  assert.match(context.text, /descent, avg grade -7\.4%, avg HR 104, 34\.6 km\/h, 0\.9 km/);
  assert.match(context.text, /stopped, 0\.1 km/);
});

test('collapseShortStops merges a same-type segment interrupted by a short stop', () => {
  const segments = [
    { index: 0, type: 'flat', effortBasis: 'hr', startElapsed: 0, endElapsed: 300, durationS: 300, avgGrade: 0.2, avgHr: 140, avgSpeedKmh: 25, distanceKm: 2.0, elevGainM: 5 },
    { index: 1, type: 'stopped', effortBasis: 'none', startElapsed: 300, endElapsed: 330, durationS: 30 },
    { index: 2, type: 'flat', effortBasis: 'hr', startElapsed: 330, endElapsed: 630, durationS: 300, avgGrade: 0.2, avgHr: 150, avgSpeedKmh: 24, distanceKm: 2.1, elevGainM: 4 },
    { index: 3, type: 'climb', effortBasis: 'vpower', startElapsed: 630, endElapsed: 900, durationS: 270, avgGrade: 5, avgPower: 210 },
  ];
  const collapsed = collapseShortStops(segments);
  assert.equal(collapsed.length, 2, 'the two flat segments merge into one, the climb stays separate');
  assert.equal(collapsed[0].type, 'flat');
  assert.equal(collapsed[0].durationS, 630);
  assert.equal(collapsed[0].pausedS, 30);
  assert.equal(collapsed[0].distanceKm, 4.1);
  assert.equal(collapsed[0].avgHr, 145);
  assert.equal(collapsed[1].type, 'climb');

  // A stop long enough to matter on its own is left as a real interruption, not merged away.
  const withLongStop = [
    segments[0],
    { index: 1, type: 'stopped', effortBasis: 'none', startElapsed: 300, endElapsed: 900, durationS: 600 },
    segments[2],
  ];
  assert.equal(collapseShortStops(withLongStop).length, 3);

  const text = buildSegmentContext(collapsed).text;
  assert.match(text, /interrupted by a 0:30 stop/);
  const withDiagnostics = segments.slice(0, 3).map((segment) => ({
    ...segment, hrCoveragePct: 100, powerCoveragePct: 90, gradeCoveragePct: 80,
    vpowerUse: segment.index === 2 ? 'rough description only' : 'conditional relative comparison',
    dynamics: { firstHalfHr: 130, secondHalfHr: 140 }, hrDriftPct: 7,
    routePoints: [{ lat: 1, lon: 2 }], gradeSensitivityWPerPct: 20,
  }));
  const merged = collapseShortStops(withDiagnostics)[0];
  assert.equal(merged.hrCoveragePct, 95.2);
  assert.equal(merged.vpowerUse, 'rough description only');
  assert.equal(merged.dynamics, null);
  assert.equal(merged.hrDriftPct, null);
  assert.equal(merged.gradeSensitivityWPerPct, null);
  assert.deepEqual(merged.routePoints, []);
  const interruptedConditional = withDiagnostics.map((segment) => ({ ...segment, vpowerUse: 'conditional relative comparison' }));
  assert.equal(collapseShortStops(interruptedConditional)[0].vpowerUse, 'rough description only');
  assert.equal(collapseShortStops([segments[0], segments[1], { ...segments[2], effortBasis: 'power' }]).length, 3);
});

test('grouped repeats retain coverage and the weakest vpower use limitation', () => {
  const segments = Array.from({ length: 8 }, (_, index) => (index % 2 ? {
    index, type: 'flat', effortBasis: 'hr', startElapsed: index * 240, endElapsed: (index + 1) * 240,
    durationS: 240, avgHr: 125, avgGrade: 0.3, hrCoveragePct: 100, gradeCoveragePct: 85,
  } : {
    index, type: 'climb', effortBasis: 'vpower', startElapsed: index * 240,
    endElapsed: (index + 1) * 240, durationS: 240, avgPower: 200, avgGrade: 5,
    hrCoveragePct: index ? 100 : 70, powerCoveragePct: 90, gradeCoveragePct: 85,
    vpowerUse: index ? 'conditional relative comparison' : 'rough description only',
  }));
  const context = buildSegmentContext(segments);
  assert.equal(context.lines, 1);
  assert.match(context.text, /HR coverage 70-100%/);
  assert.match(context.text, /grade coverage 85%/);
  assert.match(context.text, /vpower use: rough description only/);
});

test('segment lines keep grade and vpower diagnostics only where vpower is the quoted effort', () => {
  const diagnostics = { gradeWindowM: 53, gradeResidualM: 0.08, gradeCoveragePct: 100, vpowerUse: 'rough description only',
    powerCoveragePct: 99, gradeSensitivityWPerPct: 62.6, massSensitivityWPerKg: 0.3 };
  const text = buildSegmentContext([
    { index: 0, type: 'flat', effortBasis: 'hr', startElapsed: 0, endElapsed: 600, durationS: 600, avgGrade: 0.1, avgHr: 138, hrCoveragePct: 100, ...diagnostics },
    { index: 1, type: 'flat', effortBasis: 'hr', startElapsed: 600, endElapsed: 1200, durationS: 600, avgGrade: 0.2, avgHr: 110, hrCoveragePct: 49, ...diagnostics, gradeCoveragePct: 60 },
    { index: 2, type: 'climb', effortBasis: 'vpower', startElapsed: 1200, endElapsed: 1500, durationS: 300, avgGrade: 6, avgPower: 220, ...diagnostics },
  ]).text.split('\n');
  assert.doesNotMatch(text[1], /coverage|grade window|vpower use|sensitivity/);
  assert.match(text[2], /HR coverage 49%, grade coverage 60%/);
  assert.doesNotMatch(text[2], /grade window|vpower use|sensitivity/);
  assert.match(text[3], /grade window ~53 m.*vpower use: rough description only; power coverage 99%.*sensitivity ~62\.6 W/);
});

test('segment line budget scales with duration and never truncates', () => {
  assert.equal(segmentLineBudget(0), 12);
  assert.equal(segmentLineBudget(3600), 32);
  assert.equal(segmentLineBudget(5 * 3600), 160);
  assert.equal(segmentLineBudget(1000 * 3600), 320);

  const noisy = [];
  for (let i = 0; i < 40; i += 1) {
    noisy.push({
      index: i,
      // Cycling three terrain types defeats both period-1 and period-2 grouping.
      type: ['climb', 'flat', 'descent'][i % 3],
      effortBasis: 'hr',
      startElapsed: i * 20,
      endElapsed: i * 20 + 20,
      durationS: 20,
      avgHr: 100 + i,
      avgGrade: i % 3 === 0 ? 5 : (i % 3 === 1 ? 0.2 : -5),
    });
  }
  const context = buildSegmentContext(noisy);
  assert.equal(context.lines, 40, 'the list is reported in full');
  assert.equal(context.maxLines, 12);
  assert.equal(context.exceeded, true, 'and flagged so the thresholds get reviewed');
});

test('recent history keeps the latest analyses verbose and older ones compact', () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) {
    entries.push({
      startTime: `2026-08-0${i + 1}T10:00:00.000Z`,
      distanceKm: 20 + i,
      durationS: 3600,
      trainingStressScore: 100 + i,
      powerSource: i === 5 ? 'estimated' : 'measured',
      analysisText: `Full analysis ${i}`,
      conversation: i === 0 ? [{ role: 'user', content: 'Only easy rides after the operation.', ts: '2026-08-02' }] : [],
    });
  }

  const text = buildRecentHistoryContext(entries);
  assert.match(text, /\*\*Recent Activity History \(earlier workouts, oldest first\):\*\*/);
  assert.match(text, /2026-08-01: 20\.0 km, 01:00:00, measured-power TSS 100/);
  assert.doesNotMatch(text, /Full analysis 0/);
  assert.match(text, /Full analysis 5/);
  // User reports belong to the Dated User Context block only; the history block carries facts and past analyses.
  assert.doesNotMatch(text, /User report, message date 2026-08-02, about activity 2026-08-01: Only easy rides after the operation/);
  assert.match(text, /Prior AI hypothesis \(not evidence\)/);
  assert.match(text, /relative dates refer to activity 2026-08-03, not the current activity/);
  assert.doesNotMatch(text, /TSS 105/);
  assert.equal(buildRecentHistoryContext([]), '');
});

test('utc offset is derived from local_timestamp first and falls back to the file name', () => {
  const fromTimestamps = deriveUtcOffsetS({
    activityTimestamp: '2026-08-19T17:06:08.000Z',
    activityLocalTimestamp: '2026-08-19T19:06:08.000Z',
    fileName: 'anything.fit',
    sessionStartTime: '2026-08-19T17:06:08.000Z',
  });
  assert.deepEqual(fromTimestamps, { utcOffsetS: 7200, offsetSource: 'fit' });

  // A misconfigured device zone (July files carried +2:30) is preserved, not "corrected".
  const halfHour = deriveUtcOffsetS({
    activityTimestamp: '2026-07-19T17:16:33.000Z',
    activityLocalTimestamp: '2026-07-19T19:46:33.000Z',
    fileName: '20260719105226.fit',
    sessionStartTime: '2026-07-19T08:22:26.000Z',
  });
  assert.deepEqual(halfHour, { utcOffsetS: 9000, offsetSource: 'fit' });

  const fromName = deriveUtcOffsetS({
    activityTimestamp: null,
    activityLocalTimestamp: null,
    fileName: '20260819190608.fit',
    sessionStartTime: '2026-08-19T17:06:08.000Z',
  });
  assert.deepEqual(fromName, { utcOffsetS: 7200, offsetSource: 'filename' });

  assert.deepEqual(deriveUtcOffsetS({ fileName: 'ride.fit' }), { utcOffsetS: null, offsetSource: null });
  // Nonsense differences (e.g. a stale local_timestamp) are rejected instead of quantized.
  assert.equal(deriveUtcOffsetS({
    activityTimestamp: '2026-08-19T17:06:08.000Z',
    activityLocalTimestamp: '2026-08-20T17:06:08.000Z',
  }).utcOffsetS, null);
});

test('local date and clock use the stored offset, including across midnight', () => {
  // 21:30 UTC on Aug 31 with UTC+3 is 00:30 Sep 1 locally; the UTC date would still say Aug 31.
  assert.equal(localDate('2026-08-31T21:30:00.000Z', 10800), '2026-09-01');
  assert.equal(localDate('2026-08-31T21:30:00.000Z', 0), '2026-08-31');
  assert.deepEqual(localClock('2026-08-19T17:06:08.000Z', 7200), { time: '19:06', zoneLabel: 'UTC+02:00' });
  assert.equal(formatOffsetLabel(9000), 'UTC+02:30');
  assert.equal(formatOffsetLabel(-10800), 'UTC-03:00');
  // Without an offset the date falls back to the UTC prefix instead of inventing a local one.
  assert.equal(localDate('2026-08-31T21:30:00.000Z', null), '2026-08-31');
});

test('offset changes against nearby rides are detected for device timezone drift', () => {
  const others = [
    { startTime: '2026-07-18T10:00:00Z', utcOffsetS: 9000 },
    { startTime: '2026-07-20T10:00:00Z', utcOffsetS: 9000 },
  ];
  assert.ok(detectOffsetChange({ current: { startTime: '2026-07-19T10:00:00Z', utcOffsetS: 7200 }, others }));
  assert.equal(detectOffsetChange({ current: { startTime: '2026-07-19T10:00:00Z', utcOffsetS: 9000 }, others }), null);
});

test('session elapsed falls back to records when the device left the session open', () => {
  const mismatch = reconcileSessionElapsed({ sessionElapsedS: 32047, recordSpanS: 3434, gapSeconds: 41 });
  assert.equal(mismatch.elapsedS, 3475);
  assert.equal(mismatch.deviceElapsedS, 32047);
  assert.equal(mismatch.mismatch.extraS, 28613);

  const consistent = reconcileSessionElapsed({ sessionElapsedS: 3520, recordSpanS: 3434, gapSeconds: 41 });
  assert.equal(consistent.elapsedS, 3520);
  assert.equal(consistent.mismatch, null);
  assert.equal(consistent.deviceElapsedS, 3520);
});

test('analysis prompt shows local start time, elapsed reconciliation and ascent divergence', () => {
  const session = {
    sport: 'cycling',
    start_time: '2026-08-19T17:06:08.000Z',
    utc_offset_s: 7200,
    offset_source: 'fit',
    total_distance_km: 20.1,
    total_timer_s: 2911,
    total_elapsed_s: 2963,
    device_elapsed_s: 32047,
    total_ascent_m: 64,
    total_descent_m: 163,
    device_ascent_m: 128,
    device_descent_m: 128,
    power_source: 'unavailable',
  };
  const prompt = generateAnalysisPrompt({ sessions: [session], records: [], segments: [] }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(prompt, /Start Time: 19:06 local \(UTC\+02:00\)/);
  assert.match(prompt, /device session elapsed 0?8:54:07 inconsistent, recording probably left open; elapsed taken from records/);
  assert.match(prompt, /device reports 128\/128 m; sources disagree, treat ascent\/descent and first-segment grade with caution/);
});

test('LTHR prefers the tested value, then zone middle, then reserve, then max percentage', () => {
  const { estimateLactateThresholdHeartRate } = require('../heart-rate');
  assert.equal(estimateLactateThresholdHeartRate(171, [127, 138, 149, 160], 62, 158), 158, 'tested value wins');
  assert.equal(estimateLactateThresholdHeartRate(171, [127, 138, 149, 160], 62), 155, 'middle of Threshold zone');
  assert.equal(estimateLactateThresholdHeartRate(171, null, 62), 155, '85 % of the reserve with resting HR');
  assert.equal(estimateLactateThresholdHeartRate(171, null, null), 145, '85 % of max HR without thresholds or rest');
  assert.equal(estimateLactateThresholdHeartRate(null, null, null), null);
});

test('zone 1 floor follows the reserve when a resting heart rate is known', () => {
  const { computeHeartRateZones } = require('../heart-rate');
  const record = (hr) => ({ heart_rate: hr, elapsed_time: hr });
  const withRest = computeHeartRateZones([{ heart_rate: 100, elapsed_time: 1 }, { heart_rate: 150, elapsed_time: 2 }], 171, [127, 138, 149, 160], { restingHeartRate: 62 });
  assert.equal(withRest.zones[0].range, '117-126 bpm', 'floor is rest + 50 % reserve');
  const withoutRest = computeHeartRateZones([{ heart_rate: 100, elapsed_time: 1 }, { heart_rate: 150, elapsed_time: 2 }], 171, [127, 138, 149, 160]);
  assert.equal(withoutRest.zones[0].range, '86-126 bpm', 'floor falls back to 50 % of max HR');
});

test('prompt names the zone method and honours a tested LTHR', () => {
  const session = { sport: 'cycling', total_distance_km: 20, power_source: 'unavailable', start_time: '2026-08-19T17:00:00Z' };
  const withLthr = generateAnalysisPrompt(
    { sessions: [session], records: [], segments: [] }, { total_activities: 0 },
    { effectiveDate: '2026-08-19', maxHeartRate: 171, thresholds: [127, 138, 149, 160], lthr: 158, restingHeartRate: 62 },
    null, [], [], 'en'
  );
  assert.match(withLthr, /Zone method: user-tested lactate threshold HR 158 bpm/);
  assert.match(withLthr, /hrTSS uses the user-tested lactate threshold HR from the dated profile/);
  assert.doesNotMatch(withLthr, /hrTSS uses an estimated threshold HR/);

  const estimated = generateAnalysisPrompt(
    { sessions: [session], records: [], segments: [] }, { total_activities: 0 },
    { effectiveDate: '2026-08-19', maxHeartRate: 171, thresholds: [127, 138, 149, 160], restingHeartRate: 62 },
    null, [], [], 'en'
  );
  assert.match(estimated, /zone starts from the dated profile; hrTSS threshold is estimated as the middle of the Threshold zone/);
  assert.match(estimated, /hrTSS uses an estimated threshold HR/);
});

test('heart-rate profiles store and compare an optional LTHR', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { applyHeartRateProfileUpsert, readHeartRateProfiles } = require('../heart-rate-profiles');
    applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-19', maxHeartRate: 171, thresholds: [127, 138, 149, 160], lthr: 158 }, 'now');
    const rows = readHeartRateProfiles(db);
    assert.equal(rows[0].lthr, 158);
    // Same everything except LTHR cleared -> a change, not a duplicate.
    const changed = applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-20', maxHeartRate: 171, thresholds: [127, 138, 149, 160], lthr: null }, 'now');
    assert.equal(changed.inserted, true);
    // Identical including LTHR -> reuse.
    const same = applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-25', maxHeartRate: 171, thresholds: [127, 138, 149, 160], lthr: null }, 'now');
    assert.equal(same.inserted, false);
  } finally {
    db.close();
  }
});

test('session classifier labels the calibrated real-ride scenarios deterministically', () => {
  // Scenarios and numbers come from the 2026-07/09 ride history calibration.
  const input = (over) => ({
    zoneSeconds: [0, 0, 0, 0, 0], hrCoveragePct: 100, timerS: 3000, stopSeconds: 0,
    peak20VsLthr: 0.9, sustainedZ4Seconds: 0, hardEfforts: 0, ...over,
  });
  const zones = (low, moderate, z4, z5) => [low * 30, 0, moderate * 30, z4 * 30, z5 * 30];

  // Ride 198 (2026-08-31): 92 % low and a quiet 20-minute peak under 85 % of LTHR.
  assert.equal(classifySession(input({ zoneSeconds: zones(92, 8, 0, 0), peak20VsLthr: 0.84 })).label, 'recovery');
  // With a stronger 20-minute peak the same distribution is endurance, not recovery.
  assert.equal(classifySession(input({ zoneSeconds: zones(92, 8, 0, 0), peak20VsLthr: 0.88 })).label, 'endurance');
  // Ride 115 (2026-08-06): 83 % low.
  assert.equal(classifySession(input({ zoneSeconds: zones(83, 17, 0, 0) })).label, 'endurance');
  // Ride 120 (2026-08-12): 37 % low, 58 % moderate.
  assert.equal(classifySession(input({ zoneSeconds: zones(37, 58, 5, 0) })).label, 'tempo');
  // Ride 158 (2026-08-19): 24 % low, 28 % Z4, 18 % Z5.
  assert.equal(classifySession(input({ zoneSeconds: zones(24, 29, 28, 18), peak20VsLthr: 1.02, sustainedZ4Seconds: 1400 })).label, 'threshold');
  // Ride 118 (2026-08-09): 32 % low, 48 % moderate, 19 % Z4 - two stimuli, neither dominant.
  assert.equal(classifySession(input({ zoneSeconds: zones(32, 48, 19, 1), peak20VsLthr: 0.95, sustainedZ4Seconds: 700 })).label, 'mixed');
  // Low HR coverage is undetermined, not guessed.
  assert.equal(classifySession(input({ zoneSeconds: zones(50, 50, 0, 0), hrCoveragePct: 40 })).label, 'undetermined');
  // 12-minute session is unstructured regardless of zones.
  assert.equal(classifySession(input({ zoneSeconds: zones(50, 50, 0, 0), timerS: 720 })).label, 'unstructured');
});

test('session classifier reports confidence, reasons and close-call alternatives', () => {
  const strong = classifySession({
    zoneSeconds: [90 * 30, 0, 10 * 30, 0, 0], hrCoveragePct: 100, timerS: 3000,
    peak20VsLthr: 0.8, sustainedZ4Seconds: 0, hardEfforts: 0, stopSeconds: 0,
  });
  assert.equal(strong.label, 'recovery');
  assert.equal(strong.confidence, 'high');
  assert.ok(strong.reasons.some((reason) => reason.includes('Z1-Z2 90%')));
  assert.ok(strong.alternatives.includes('endurance'));

  // Passing the endurance floor by less than the close-call margin drops confidence to medium.
  const borderline = classifySession({
    zoneSeconds: [73 * 30, 0, 27 * 30, 0, 0], hrCoveragePct: 100, timerS: 3000,
    peak20VsLthr: 0.89, sustainedZ4Seconds: 0, hardEfforts: 0, stopSeconds: 0,
  });
  assert.equal(borderline.label, 'endurance');
  assert.equal(borderline.confidence, 'medium');
});

test('sustained Z4 runs and hard effort counts come from the sample stream', () => {
  const mk = (hr, seconds) => ({ seconds, atOrAboveZ4: hr >= 150, atOrAboveZ5: hr >= 165 });
  const samples = [mk(140, 60), mk(155, 120), mk(160, 60), mk(140, 30), mk(158, 120), mk(140, 60), mk(170, 70), mk(140, 60), mk(170, 65)];
  assert.equal(longestSustainedZ4Seconds(samples), 180);
  assert.equal(countHardEfforts(samples), 2);
  assert.equal(countHardEfforts(samples, { minEffortSeconds: 90 }), 0);
});

test('feature cache keys change with every input factor', () => {
  const { FEATURES_VERSION, athleteKey, featureCacheKey, hrProfileKey, isFeatureRowFresh, settingsKey } = require('../activity-features');
  const settings = settingsKey({ segmentation: { gradeThresholdPct: 2.5 }, powerModel: { dragArea: 0.32 } });
  const profile = { effectiveDate: '2026-08-19', maxHeartRate: 171, thresholds: [127, 138, 149, 160], lthr: null };
  const athlete = { sex: 'male', restingHeartRate: 62, ftp: 117, riderMassKg: 88, bikeMassKg: 10 };
  const base = featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash: settings, hrProfile: profile, athlete });

  assert.notEqual(featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash: settingsKey({ segmentation: { gradeThresholdPct: 3 }, powerModel: { dragArea: 0.32 } }), hrProfile: profile, athlete }), base, 'segmentation change invalidates');
  assert.notEqual(featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash: settingsKey({ segmentation: { gradeThresholdPct: 2.5 }, powerModel: { dragArea: 0.4 } }), hrProfile: profile, athlete }), base, 'power model change invalidates');
  assert.notEqual(featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash: settings, hrProfile: { ...profile, lthr: 158 }, athlete }), base, 'LTHR change invalidates');
  assert.notEqual(featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash: settings, hrProfile: profile, athlete: { ...athlete, restingHeartRate: 64 } }), base, 'athlete change invalidates');
  assert.ok(isFeatureRowFresh({ features_version: FEATURES_VERSION, feature_cache_key: base }, base));
  assert.ok(!isFeatureRowFresh({ features_version: FEATURES_VERSION, feature_cache_key: base + 'x' }, base));
  assert.ok(!isFeatureRowFresh({ features_version: FEATURES_VERSION - 1, feature_cache_key: base }, base));
  assert.equal(hrProfileKey(null), 'none');
  assert.equal(athleteKey(null), 'none');
});

test('derived features are stored once and reused while the key is unchanged', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path, file_name, start_time, source, sport, total_timer_s, total_distance_km)
      VALUES (7, 'a.fit', 'a.fit', '2026-08-19T17:00:00.000Z', 'fit', 'cycling', 3000, 20)`);
    db.run(`INSERT INTO heart_rate_profiles (effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start)
      VALUES ('2026-08-01', 171, 127, 138, 149, 160)`);
    const { FEATURES_VERSION, athleteKey, featureCacheKey, hrProfileKey, settingsKey } = require('../activity-features');
    const settingsHash = settingsKey({ segmentation: null, powerModel: null });
    const profile = { effectiveDate: '2026-08-01', maxHeartRate: 171, thresholds: [127, 138, 149, 160], lthr: null };
    const athlete = { sex: null, restingHeartRate: null, ftp: null, riderMassKg: null, bikeMassKg: null };
    const key = featureCacheKey({ featuresVersion: FEATURES_VERSION, settingsHash, hrProfile: profile, athlete });
    db.run(`INSERT INTO activity_features (activity_id, features_version, settings_hash, hr_profile_key, athlete_key, feature_cache_key, computed_at, segments_json, zones_json, peak_hr_json, session_class_json, trimp, hr_tss)
      VALUES (7, ?, ?, ?, ?, ?, '2026-10-03T00:00:00Z', '[]', NULL, '[]', NULL, 100, 65)`,
      [FEATURES_VERSION, settingsHash, hrProfileKey(profile), athleteKey(athlete), key]);
    const row = db.prepare('SELECT * FROM activity_features WHERE activity_id = 7');
    row.step();
    const stored = row.getAsObject();
    row.free();
    const { isFeatureRowFresh } = require('../activity-features');
    assert.ok(isFeatureRowFresh(stored, key), 'same key is fresh, no recompute');
    assert.ok(!isFeatureRowFresh(stored, key.replace('171', '172')), 'different key forces recompute');
  } finally {
    db.close();
  }
});

test('recent history carries per-session intensity, peak, load and class', () => {
  const text = buildRecentHistoryContext([
    {
      startTime: '2026-08-19T17:06:00.000Z', utcOffsetS: 7200, distanceKm: 20.1, durationS: 2911,
      avgHr: 147, zoneSeconds: [300, 1200, 900, 800, 400], peak20: 158, trimp: 113,
      sessionClass: { label: 'threshold', confidence: 'high' }, source: 'fit',
    },
  ]);
  assert.match(text, /2026-08-19: 20\.1 km, 00:48:31, FIT avg HR 147 bpm, L\/M\/H 42\/25\/33%, TRIMP 113, class threshold, peak20 158 bpm/);
});

test('period volume includes TRIMP sum, session class mix and week monotony', () => {
  const activities = [];
  for (let day = 1; day <= 8; day += 1) {
    activities.push({
      activityId: day, startTime: `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`, sport: 'cycling',
      utcOffsetS: 0, durationS: 3000, distanceKm: 20, trimp: 80 + day, sessionClass: { label: 'endurance', confidence: 'high' },
      zones: null, peakHr: [], segments: [],
    });
  }
  const context = buildTrainingContext(activities, '2026-08-09T10:00:00.000Z', 'cycling');
  const week = context.volume[0];
  assert.equal(week.sports[0].trimpActivities, 7);
  assert.equal(week.sports[0].classMix.endurance, 7);
  assert.ok(context.monotony, 'monotony computes from a week with varying loads');
  assert.ok(context.monotony.monotony > 1);

  const rendered = require('../analysis') && null; // rendered through the prompt below
  const { buildTrainingHistoryContext } = require('../analysis');
  const text = buildTrainingHistoryContext(context);
  assert.match(text, /TRIMP sum \d+ \(7\/7 activities with HR-based load\)/);
  assert.match(text, /session classes: endurance 7/);
  assert.match(text, /Week monotony \(Foster, TRIMP-based, imported days only\)/);

  // A single active day is not monotony.
  const lonely = buildTrainingContext([activities[0]], '2026-08-03T10:00:00.000Z', 'cycling');
  assert.equal(lonely.monotony, null);
});

test('route signatures identify the same loop, a reversed ride, a partial ride and a different one', () => {
  const { buildRouteSignature, matchRoutes } = require('../route-match');
  // A 10 km square-ish loop: 32 fraction points along a real-looking track.
  const loop = [];
  for (let i = 0; i <= 400; i += 1) {
    const d = i / 400;
    const lat = d < 0.25 ? d : d < 0.5 ? 0.25 : d < 0.75 ? 0.25 - (d - 0.5) : 0;
    const lon = d < 0.25 ? 0 : d < 0.5 ? (d - 0.25) : d < 0.75 ? 0.25 : 0.25 - (d - 0.75);
    loop.push({ position_lat: 52 + lat * 0.05, position_long: 13 + lon * 0.07, distance: d * 10 });
  }
  const loopSig = buildRouteSignature(loop);

  // Same loop entered elsewhere: drop the first 10 % and start from there (loop shifted).
  const shifted = [...loop.slice(40), ...loop.slice(0, 40)].map((p, i) => ({ ...p, distance: (i / 400) * 10 }));
  assert.equal(matchRoutes(buildRouteSignature(shifted), loopSig).type, 'same');

  // Same geometry, opposite direction.
  const reversed = loop.map((p, i) => ({ ...p, position_lat: loop[loop.length - 1 - i].position_lat, position_long: loop[loop.length - 1 - i].position_long, distance: (i / 400) * 10 }));
  const reversedMatch = matchRoutes(buildRouteSignature(reversed), loopSig);
  assert.ok(['same', 'reversed'].includes(reversedMatch.type), 'reversed geometry still matches the route');

  // Half the loop is a partial.
  const half = loop.slice(0, 240).map((p, i) => ({ ...p, distance: (i / 400) * 10 }));
  assert.equal(matchRoutes(buildRouteSignature(half), loopSig).type, 'partial');

  // A distant route is different.
  const elsewhere = loop.map((p) => ({ ...p, position_lat: p.position_lat + 0.05, position_long: p.position_long + 0.05 }));
  assert.equal(matchRoutes(buildRouteSignature(elsewhere), loopSig).type, 'different');

  // Tiny GPS-less inputs produce no signature at all.
  assert.equal(buildRouteSignature([{ position_lat: 1, position_long: 1, distance: 0.1 }]), null);
});

test('checkpoints sit at segment boundaries, densify long segments and match priors by place', () => {
  const { computeCheckpoints, summarizeCheckpoints } = require('../route-store');
  const records = [];
  const lat0 = 52.0; const lon0 = 21.0;
  for (let s = 0; s <= 3600; s += 1) {
    const km = (s / 3600) * 20;
    records.push({ elapsed_time: s, distance: km, heart_rate: 130 + Math.floor(s / 600) * 5,
      position_lat: lat0 + km * 0.009, position_long: lon0 });
  }
  // Boundaries at 5 km and 12 km split the 20 km ride into stretches of 5, 7 and 8 km; the long
  // ones gain an extra mark every 2 km counted from the boundary.
  const segments = [
    { type: 'flat', startElapsed: 0, endElapsed: 900 },
    { type: 'flat', startElapsed: 900, endElapsed: 2160 },
    { type: 'flat', startElapsed: 2160, endElapsed: 3600 },
  ];
  const marks = computeCheckpoints(records, segments);
  assert.deepEqual(marks.map((m) => m.km), [2, 5, 7, 9, 12, 14, 16, 18, 20]);
  assert.ok(marks.every((m) => Number.isFinite(m.lat)), 'each mark carries its GPS place');
  assert.equal(marks[0].avgHr, 130);
  assert.ok(Math.abs(marks[0].avgSpeedKmh - 20) < 0.5);

  // A prior ride with different segmentation but the same road: matched by GPS, not by km.
  const priorMarks = [6, 9, 14, 20].map((km) => ({ km, lat: lat0 + km * 0.009, lon: lon0,
    elapsedS: (km / 20) * 3600 + 60, avgHr: 140 }));
  const summary = summarizeCheckpoints(marks, [{ checkpoints: priorMarks }]);
  // The nearest prior mark to the 5 km mark (0.009° ≈ 1 km) is the one at 6 km, ~1 km away:
  // same road, but beyond the 150 m radius, so it does not match — the radius is doing its job.
  assert.equal(summary[1].priorRides, 0, 'a mark 1 km away does not pair');
  const near = summarizeCheckpoints([marks[1]], [{ checkpoints: [{ km: 5.02, lat: lat0 + 5.02 * 0.009, lon: lon0, elapsedS: 960, avgHr: 140 }] }]);
  assert.equal(near[0].priorRides, 1, 'a prior mark within 150 m of the same place matches');
  assert.equal(near[0].priorMedianS, 960);

  // Without GPS on either side the fallback is the scaled position along the route (lengths from
  // the marks themselves; a full prior is required, a lone far mark proves nothing).
  const kmSummary = summarizeCheckpoints([{ km: 10, elapsedS: 1800 }, { km: 20, elapsedS: 3600 }],
    [{ checkpoints: [{ km: 10.05, elapsedS: 1860 }, { km: 10.1, elapsedS: 1880 }, { km: 20, elapsedS: 3660 }] }]);
  assert.equal(kmSummary[0].priorRides, 1);
  assert.equal(kmSummary[0].priorMedianS, 1860, 'the closest mark on the axis wins');
  assert.equal(summarizeCheckpoints([{ km: 10, elapsedS: 1800 }, { km: 20, elapsedS: 3600 }],
    [{ checkpoints: [{ km: 14, elapsedS: 2520 }, { km: 20, elapsedS: 3660 }] }])[0].priorRides, 0);

  // A ride with no segments: marks every 2 km plus the end (the densify pass over one long stretch).
  const plain = computeCheckpoints(records);
  assert.deepEqual(plain.map((m) => m.km), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test('ride-to-route assignment creates a route once and attaches later rides with their relation', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { assignRoute, readRoutes } = require('../route-store');
    const { buildRouteSignature, matchRoutes } = require('../route-match');
    const loop = [];
    for (let i = 0; i <= 200; i += 1) {
      const d = i / 200;
      loop.push({ position_lat: 52 + Math.sin(d * Math.PI * 2) * 0.02, position_long: 13 + Math.cos(d * Math.PI * 2) * 0.03, distance: d * 10 });
    }
    db.run('INSERT INTO activities (id, file_path, file_name, start_time, source) VALUES (1, ?, ?, ?, ?)', ['a', 'a', '2026-08-01T10:00:00Z', 'fit']);
    db.run('INSERT INTO activity_features (activity_id, features_version) VALUES (1, 1)');
    const first = assignRoute(db, { activityId: 1, signature: buildRouteSignature(loop), createdAt: '2026-08-01T10:00:00Z' });
    assert.equal(first.rideCount, 1);

    db.run('INSERT INTO activities (id, file_path, file_name, start_time, source) VALUES (2, ?, ?, ?, ?)', ['b', 'b', '2026-08-02T10:00:00Z', 'fit']);
    db.run('INSERT INTO activity_features (activity_id, features_version) VALUES (2, 1)');
    const second = assignRoute(db, { activityId: 2, signature: buildRouteSignature(loop.map((p) => ({ ...p, position_lat: p.position_lat + 0.0002 }))), createdAt: '2026-08-02T10:00:00Z' });
    assert.equal(second.routeId, first.routeId);
    assert.equal(second.rideCount, 2);
    assert.equal(readRoutes(db).length, 1);
  } finally {
    db.close();
  }
});

test('pinned analysis model id overrides the cheapest-model selection', async () => {
  const models = [
    { id: 'gpt-6-luna', name: 'Luna', family: 'luna' },
    { id: 'gpt-6-sol', name: 'Sol', family: 'sol' },
  ];
  const pinned = await selectPreferredModel(fakeVscode(), 'copilot', models, { modelId: 'gpt-6-sol', preferCheapModel: true });
  assert.equal(pinned.id, 'gpt-6-sol');
  await assert.rejects(
    () => selectPreferredModel(fakeVscode(), 'copilot', models, { modelId: 'missing-model', preferCheapModel: true }),
    /not available/
  );
  const unpinned = await selectPreferredModel(fakeVscode(), 'copilot', models, {});
  assert.equal(unpinned, models[0]);
});

function fakeVscode() {
  return { lm: { selectChatModels: async () => { throw new Error('unexpected call'); } } };
}

test('recent history marks user-reported heart rate as a summary without a series', () => {  const text = buildRecentHistoryContext([
    { startTime: '2026-07-19T08:22:00.000Z', distanceKm: 20.9, durationS: 3392, reportedAvgHr: 131, reportedMaxHr: 177, source: 'fit' },
  ]);
  assert.match(text, /user-reported avg\/max HR 131\/177 bpm \(summary only, no time series\)/);
});

test('prompt places data before rules and carries segment guidance', () => {
  const segments = [
    { index: 0, type: 'climb', effortBasis: 'vpower', startElapsed: 0, endElapsed: 300, durationS: 300, avgGrade: 6, avgPower: 210 },
  ];
  const prompt = generateAnalysisPrompt(
    { sessions: [{ total_distance_km: 20 }], segments },
    { total_activities: 0 },
    {},
    null,
    [],
    [{ startTime: '2026-08-01T10:00:00.000Z', distanceKm: 20, analysisText: 'Earlier ride was steady.' }]
  );

  // Instructions and principles come first (message 1); data blocks then end with the questions (message 2).
  assert.ok(prompt.indexOf('**Principles:**') < prompt.indexOf('**This Workout:**'));
  assert.ok(prompt.indexOf('**Segment Breakdown:**') < prompt.indexOf('**Recent Activity History'));
  assert.ok(prompt.indexOf('**This Workout:**') < prompt.indexOf('**Segment Breakdown:**'));
  assert.ok(prompt.indexOf('**Recent Activity History') < prompt.indexOf('**Questions for Analysis:**'));
  assert.doesNotMatch(prompt, /\*\*Evidence Rules:\*\*/);
  const { instructions, data } = generateAnalysisPromptParts({ sessions: [{ total_distance_km: 20 }], segments }, { total_activities: 0 }, {}, null, [], []);
  assert.doesNotMatch(instructions, /\*\*This Workout:\*\*/);
  assert.match(data, /\*\*Questions for Analysis:\*\*/);
  assert.equal((instructions.match(/^\d+\. /gm) || []).length, 15, 'fifteen principles');
  assert.match(prompt, /never compare vpower numbers against HR numbers directly/);
  assert.match(prompt, /past analyses of other workouts/);

  const withoutSegments = generateAnalysisPrompt({ sessions: [{}] }, { total_activities: 0 });
  assert.doesNotMatch(withoutSegments, /Segment Breakdown/);
  assert.doesNotMatch(withoutSegments, /Never compare a vpower-based segment/);
});

test('recent-history lookup reads earlier activities and falls back to the last one', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path, start_time) VALUES
      (1, 'old.fit', '2026-01-01T10:00:00.000Z'),
      (2, 'recent.fit', '2026-08-01T10:00:00.000Z'),
      (3, 'current.fit', '2026-08-10T10:00:00.000Z'),
      (4, 'later.fit', '2026-08-20T10:00:00.000Z')`);
    db.run(`INSERT INTO activity_analysis (activity_id, analysis_text, analysis_version) VALUES
      (1, 'old text', 8), (2, 'recent text', 8), (4, 'later text', 8)`);

    const windowed = db.exec(`
      SELECT a.id FROM activities a
      JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE a.id != 3 AND a.start_time >= date('2026-08-10T10:00:00.000Z', '-30 days')
        AND a.start_time < '2026-08-10T10:00:00.000Z'
      ORDER BY a.start_time ASC
    `)[0].values.flat();
    // Only earlier activities inside the window: never the older one, never a later ride.
    assert.deepEqual(windowed, [2]);

    const fallback = db.exec(`
      SELECT a.id FROM activities a
      JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE a.id != 2 AND a.start_time < '2026-02-01T10:00:00.000Z'
      ORDER BY a.start_time DESC LIMIT 1
    `)[0].values.flat();
    assert.deepEqual(fallback, [1]);
  } finally {
    db.close();
  }
});

async function* asyncChunks(chunks) {
  yield* chunks;
}

test('comparison prompt is directed and instructs against index-based segment alignment', () => {
  const fitData = {
    sessions: [{ total_distance_km: 20, start_time: '2026-08-01T10:00:00.000Z' }],
    records: [],
    segments: [{ index: 0, type: 'climb', effortBasis: 'vpower', startElapsed: 0, endElapsed: 300, durationS: 300, avgGrade: 6, avgPower: 210 }],
  };
  const comparedFitData = {
    sessions: [{ total_distance_km: 22, start_time: '2026-07-20T10:00:00.000Z' }],
    records: [],
    segments: [{ index: 0, type: 'flat', effortBasis: 'hr', startElapsed: 0, endElapsed: 400, durationS: 400, avgGrade: 0.5, avgHr: 140 }],
  };

  const prompt = generateComparisonPrompt(fitData, comparedFitData);

  assert.match(prompt, /\*\*This Workout:\*\*/);
  assert.match(prompt, /\*\*Another Compared Activity:\*\*/);
  assert.ok(prompt.indexOf('**This Workout:**') < prompt.indexOf('**Another Compared Activity:**'));
  assert.match(prompt, /directed comparison/);
  assert.match(prompt, /Do not assume segments correspond by their list position or index/);
  assert.match(prompt, /climb, avg grade 6%, vpower ~210 W/);
  assert.match(prompt, /flat, avg grade 0\.5%, avg HR 140/);
});

test('analysis prompt surfaces user-reported HR from another device with explicit limits', () => {
  const prompt = generateAnalysisPrompt(
    {
      sessions: [{ total_distance_km: 20, _reportedAvgHr: 139, _reportedMaxHr: 147 }],
      records: [],
      segments: [],
    },
    { total_activities: 0 },
    {},
    null, [], [], 'en'
  );
  assert.match(prompt, /\*\*User-Reported Heart Rate \(summary from another device, not measured here\):\*\*/);
  assert.match(prompt, /Reported Avg HR: 139 bpm/);
  assert.match(prompt, /Reported Max HR: 147 bpm/);
  assert.match(prompt, /zones, TRIMP, hrTSS, peaks and drift cannot be derived from them/);
  assert.match(prompt, /never as zone time, peaks or load/);
});

test('prompts without reported HR stay clean of the reported-HR block', () => {
  const prompt = generateAnalysisPrompt(
    { sessions: [{ total_distance_km: 20 }], records: [], segments: [] },
    { total_activities: 0 },
    {},
    null, [], [], 'en'
  );
  assert.doesNotMatch(prompt, /User-Reported Heart Rate/);
});

test('comparison prompt states each activity heart-rate profile and warns about differing thresholds', () => {
  const fitData = {
    sessions: [{ total_distance_km: 20, start_time: '2026-08-01T10:00:00.000Z' }],
    records: [],
    segments: [],
    analysisHeartRateConfig: { effectiveDate: '2026-08-01', maxHeartRate: 171, thresholds: [127, 138, 149, 160] },
  };
  const comparedFitData = {
    sessions: [{ total_distance_km: 22, start_time: '2026-07-20T10:00:00.000Z' }],
    records: [],
    segments: [],
    analysisHeartRateConfig: { effectiveDate: '2026-07-19', maxHeartRate: 168, thresholds: [126, 136, 147, 157] },
  };

  const prompt = generateComparisonPrompt(fitData, comparedFitData);
  const thisProfile = prompt.indexOf('Effective for This Comparison (2026-08-01):');
  const comparedProfile = prompt.indexOf('Effective for This Comparison (2026-07-19):');
  assert.ok(thisProfile >= 0 && comparedProfile >= 0, 'both profiles are supplied');
  assert.ok(thisProfile < comparedProfile, 'this workout profile comes first');
  assert.match(prompt, /an equal heart rate then does not mean an equal relative intensity/);
});

test('chat prompt includes the dated heart-rate profile block', () => {
  const prompt = generateAnalysisChatPrompt(
    { sessions: [{ total_distance_km: 20 }], records: [], segments: [] },
    { trainingContext: null },
    { effectiveDate: '2026-08-01', maxHeartRate: 171, thresholds: [127, 138, 149, 160] },
    'base analysis', [], 'How hard was this?', 'en'
  );
  assert.match(prompt, /\*\*Heart Rate Profile Effective for This Workout:\*\*/);
  assert.match(prompt, /Maximum HR: 171 bpm/);
  assert.match(prompt, /length follows the question rather than a fixed sentence count/);
});

test('activity_comparisons stores directed pairs independently and upserts by pair', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run(`INSERT INTO activities (id, file_path) VALUES (1, 'a.fit'), (2, 'b.fit')`);
    const upsert = (activityId, comparedId, text, updatedAt) => db.run(`
      INSERT INTO activity_comparisons (activity_id, compared_activity_id, comparison_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(activity_id, compared_activity_id) DO UPDATE SET
        comparison_text = excluded.comparison_text,
        updated_at = excluded.updated_at
    `, [activityId, comparedId, text, updatedAt, updatedAt]);

    upsert(1, 2, 'A vs B v1', '2026-01-01T10:00:00.000Z');
    upsert(2, 1, 'B vs A v1', '2026-01-01T10:00:00.000Z');
    upsert(1, 2, 'A vs B v2', '2026-01-02T10:00:00.000Z');

    const rows = db.exec('SELECT activity_id, compared_activity_id, comparison_text FROM activity_comparisons ORDER BY activity_id')[0].values;
    assert.deepEqual(rows, [[1, 2, 'A vs B v2'], [2, 1, 'B vs A v1']]);

    // The panel lists every saved comparison FROM an activity, most recently updated first.
    db.run(`INSERT INTO activities (id, file_path) VALUES (3, 'c.fit')`);
    upsert(1, 3, 'A vs C v1', '2026-01-03T10:00:00.000Z');
    const forActivity1 = db.exec(`
      SELECT compared_activity_id, comparison_text, updated_at
      FROM activity_comparisons WHERE activity_id = 1 ORDER BY updated_at DESC
    `)[0].values;
    assert.deepEqual(forActivity1.map((row) => row[0]), [3, 2], 'most recently updated pair first');
  } finally {
    db.close();
  }
});

test('comparison feature is wired: DB functions, message handlers and cheap-model exclusion', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /async function getActivityComparisonFromDb\(/);
  assert.match(source, /async function getActivityComparisonsForActivity\(/);
  assert.match(source, /async function storeActivityComparisonInDb\(/);
  assert.match(source, /async function removeActivityComparisonFromDb\(/);
  assert.match(source, /async function generateActivityComparison\(/);
  assert.match(source, /return enqueueLlmTask\(\(\) => runActivityComparison\(/);
  assert.match(source, /msg\.type === 'compareActivitiesAI'/);
  assert.match(source, /msg\.type === 'removeComparison'/);
  assert.match(source, /type: 'comparisonResult'/);
  assert.match(source, /type: 'comparisonRemoved'/);

  // The comparison call site should not opt into the cheap-model heuristic meant for one-off analysis.
  const comparisonCallIndex = source.indexOf("kind: 'comparison',");
  const comparisonCallStart = source.lastIndexOf('requestCopilotAnalysis(vscode, prompt, {', comparisonCallIndex);
  const comparisonCallSource = source.slice(comparisonCallStart, comparisonCallIndex);
  assert.doesNotMatch(comparisonCallSource, /preferCheapModel/);
});

test('segment context always returns display rows, even with nothing to show', () => {
  // The webview iterates displayRows straight away, so omitting it crashed the whole panel
  // for any activity that produced no segments.
  for (const empty of [[], null, undefined]) {
    const context = buildSegmentContext(empty);
    assert.deepEqual(context.displayRows, [], `expected display rows for ${JSON.stringify(empty)}`);
    assert.equal(context.text, '');
  }
});

test('comparison UI lists every saved comparison regardless of the current dropdown selection', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const records = straightGpsRecords(4, 18);
  const fitData = { records, sessions: [{ start_time: '2026-08-01T10:00:00.000Z' }], laps: [] };

  // Two saved comparisons exist, but neither is the activity currently picked in the dropdown.
  const savedComparisons = [
    { comparedActivityId: 5, label: '01/07/2026, 10:00 · 22.0 km', comparisonText: 'Comparison vs ride 5' },
    { comparedActivityId: 9, label: '15/06/2026, 08:00 · 18.5 km', comparisonText: 'Comparison vs ride 9' },
  ];

  const htmlWithNoSelection = renderActivityContentHtml(
    {}, {}, fitData, null, 'n', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en',
    [], null, savedComparisons, null
  );
  assert.match(htmlWithNoSelection, /Comparison vs ride 5/);
  assert.match(htmlWithNoSelection, /Comparison vs ride 9/);
  assert.doesNotMatch(htmlWithNoSelection, /id="compareBtn"/, 'no trigger button without a dropdown selection');

  const htmlWithNewSelection = renderActivityContentHtml(
    {}, {}, fitData, null, 'n', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en',
    [], null, savedComparisons, 42
  );
  assert.match(htmlWithNewSelection, /Comparison vs ride 5/, 'saved comparisons stay listed for an unrelated selection');
  assert.match(htmlWithNewSelection, />Compare with AI</, 'a new pair offers the initial label');

  const htmlWithExistingSelection = renderActivityContentHtml(
    {}, {}, fitData, null, 'n', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en',
    [], null, savedComparisons, 5
  );
  assert.match(htmlWithExistingSelection, />Compare Again</, 'an already-compared pair offers to redo it, not start it');

  const emptyHtml = renderActivityContentHtml(
    {}, {}, fitData, null, 'n', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en',
    [], null, [], null
  );
  assert.doesNotMatch(emptyHtml, /id="comparisonList"|id="compareBtn"/, 'nothing to compare and nothing saved: no section at all');
});

test('comparison UI wires Compare/Remove through a delegated click handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8');
  assert.match(source, /const comparisonBlock = \(comparisonEntriesSafe\.length \|\| canCompare\) \? `/);
  assert.match(source, /class="removeComparisonBtn"/);
  assert.match(source, /id="compareBtn"/);
  assert.match(source, /type: 'compareActivitiesAI'/);
  assert.match(source, /type: 'removeComparison'/);
  assert.match(source, /msg\.type === 'comparisonResult'/);
  assert.match(source, /msg\.type === 'comparisonRemoved'/);
  assert.match(source, /comparisonList\?\.addEventListener\('click'/);
  assert.match(source, /event\.target\.closest\('\.removeComparisonBtn'\)/);

  // Availability follows the dropdown, not whether the other ride happens to have a GPS track.
  assert.match(source, /const canCompare = Number\.isFinite\(comparedId\) && comparedId > 0;/);
  assert.doesNotMatch(source, /comparisonBlock = hasOverlay/);

  // Every AI feature lives in the one AI Analysis section, between Analyze and the follow-up chat.
  assert.ok(source.indexOf('${comparisonBlock}') > source.indexOf('id="analyzeBtn"'));
  assert.ok(source.indexOf('${comparisonBlock}') < source.indexOf('id="analysisChatMessages"'));

  // The comparison text must read as prominently as the main analysis text, not as a footnote.
  // Both are rendered as markdown now, so the three sites (analysis text, server-rendered card,
  // client-rendered card) share the same container style without the old pre-wrap.
  const cardTextStyle = /font-size:1\.08rem;line-height:1\.6;word-break:break-word;/g;
  assert.equal((source.match(cardTextStyle) || []).length, 3,
    'expected the same font-size on the analysis text, the server-rendered card, and the client-rendered card');
});

test('comparison entries are labeled from the activities list the same way as the dropdown', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'activity-webview.js'), 'utf8'),
    /const comparisonEntries = \(Array\.isArray\(comparisons\) \? comparisons : \[\]\)\.map\(\(entry\) => \{\s*\n\s*const compared = activities\.find\(\(a\) => Number\(a\.id\) === entry\.comparedActivityId\);\s*\n\s*return \{\s*\n\s*comparedActivityId: entry\.comparedActivityId,\s*\n\s*label: compared \? formatActivityLabel\(compared\) : `#\$\{entry\.comparedActivityId\}`,/);
});


function syntheticAltitudeRide({ offsetM = 0, drift = null, dropFirstS = 0, seconds = 1200, speedMs = 5 } = {}) {
  const records = [];
  for (let i = 0; i < seconds; i += 1) {
    const distanceKm = (i * speedMs) / 1000;
    const base = 100 + 30 * Math.sin((2 * Math.PI * distanceKm) / ((seconds * speedMs) / 1000));
    const driftM = drift ? drift.amplitudeM * Math.max(0, 1 - i / drift.seconds) : 0;
    const angle = (2 * Math.PI * i) / seconds;
    records.push({
      elapsed_time: i,
      distance: distanceKm,
      altitude: i < dropFirstS ? null : (base + offsetM + driftM) / 1000,
      position_lat: 52 + 0.01 * Math.sin(angle),
      position_long: 13 + 0.01 * (1 - Math.cos(angle)),
    });
  }
  return records;
}

test('consensus elevation aligns constant per-ride offsets and reports the route ascent', () => {
  const { buildAltitudeRide, computeConsensusProfile } = require('../altitude-quality');
  const offsets = [0, 40, -25, 80, -60, 15];
  const rides = offsets.map((offsetM) => buildAltitudeRide(syntheticAltitudeRide({ offsetM })));
  const profile = computeConsensusProfile(rides);
  assert.equal(profile.rides, 6);
  assert.ok(Math.abs(profile.ascentM - 60) <= 6, `ascent ${profile.ascentM}`);
  assert.ok(Math.abs(profile.descentM - 60) <= 6, `descent ${profile.descentM}`);
  assert.equal(computeConsensusProfile(rides.slice(0, 4)), null, 'fewer than five rides give no consensus');
});

test('altitude settling is detected against the consensus and not for a pure constant offset', () => {
  const { buildAltitudeRide, computeConsensusProfile, detectAltitudeSettling } = require('../altitude-quality');
  const rides = [0, 10, -10, 20, -20, 5].map((offsetM) => buildAltitudeRide(syntheticAltitudeRide({ offsetM })));
  const profile = computeConsensusProfile(rides);
  const drifting = buildAltitudeRide(syntheticAltitudeRide({ offsetM: 30, drift: { amplitudeM: -100, seconds: 180 } }));
  const settling = detectAltitudeSettling(drifting, profile);
  assert.ok(settling, 'start drift detected');
  assert.ok(settling.startDeltaM < -50);
  assert.ok(settling.settleSeconds >= 60 && settling.settleSeconds <= 240, `settles after ${settling.settleSeconds}s`);
  assert.equal(detectAltitudeSettling(buildAltitudeRide(syntheticAltitudeRide({ offsetM: 90 })), profile), null);
});

test('altitude flags cover a missing start, interior gaps and closed-loop settling', () => {
  const { buildAltitudeRide, computeAltitudeFlags } = require('../altitude-quality');
  const clean = computeAltitudeFlags(buildAltitudeRide(syntheticAltitudeRide()));
  assert.deepEqual(clean, []);
  const missing = computeAltitudeFlags(buildAltitudeRide(syntheticAltitudeRide({ dropFirstS: 90 })));
  assert.deepEqual(missing.map((flag) => flag.code), ['ALT_MISSING_START']);

  const gappy = syntheticAltitudeRide();
  for (let i = 400; i < 450; i += 1) gappy[i].altitude = null;
  assert.ok(computeAltitudeFlags(buildAltitudeRide(gappy)).some((flag) => flag.code === 'ALT_GAP'));

  // Closed loop, altitude 60 m lower at the start, nearly all of it recovered within 5 minutes.
  const settling = syntheticAltitudeRide({ drift: { amplitudeM: -60, seconds: 280 } });
  const flags = computeAltitudeFlags(buildAltitudeRide(settling));
  assert.ok(flags.some((flag) => flag.code === 'ALT_SETTLING'), JSON.stringify(flags));
});

test('route assignment is idempotent and its elevation profile is cached by member count', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { assignRoute, ensureRouteElevationProfile, readRouteAssignments } = require('../route-store');
    const { buildRouteSignature } = require('../route-match');
    let routeId = null;
    for (let id = 1; id <= 6; id += 1) {
      const records = syntheticAltitudeRide({ offsetM: id * 12 });
      db.run('INSERT INTO activities (id, file_path, file_name, start_time, source) VALUES (?, ?, ?, ?, ?)',
        [id, `f${id}`, `f${id}`, `2026-08-0${id}T10:00:00Z`, 'fit']);
      records.forEach((record, index) => {
        db.run('INSERT INTO records (activity_id, record_index, elapsed_s, distance_km, altitude_m, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, index, record.elapsed_time, record.distance, record.altitude * 1000, record.position_lat, record.position_long]);
      });
      const signature = buildRouteSignature(records);
      const first = assignRoute(db, { activityId: id, signature, createdAt: `2026-08-0${id}T10:00:00Z` });
      const again = assignRoute(db, { activityId: id, signature, createdAt: `2026-08-0${id}T10:00:00Z` });
      assert.equal(again.routeId, first.routeId);
      routeId = first.routeId;
    }
    const rideCount = db.exec('SELECT ride_count FROM routes')[0].values[0][0];
    assert.equal(rideCount, 6, 'repeated assignment does not recount rides');
    assert.equal(readRouteAssignments(db).size, 6);

    const profile = ensureRouteElevationProfile(db, routeId);
    assert.equal(profile.rides, 6);
    const stored = JSON.parse(db.exec('SELECT elevation_profile_json FROM routes')[0].values[0][0]);
    assert.equal(stored.members, 6);
    assert.deepEqual(ensureRouteElevationProfile(db, routeId), profile);
  } finally {
    db.close();
  }
});

test('altitude quality block lists flags and the route elevation line', () => {
  const { buildAltitudeQualityBlock } = require('../analysis');
  assert.equal(buildAltitudeQualityBlock(null), '');
  const text = buildAltitudeQualityBlock({
    flags: [{ code: 'ALT_SETTLING', detail: 'recorded altitude starts 80 m below the route consensus level' }],
    routeLine: 'Route elevation (offset-aligned consensus of 30 same-route rides): ascent ~115 m, descent ~114 m.',
  });
  assert.match(text, /ALT_SETTLING: recorded altitude starts 80 m below/);
  assert.match(text, /ascent ~115 m/);
});

test('analysis summary tail is parsed tolerantly and cut from the displayed text', () => {
  const { parseAnalysisSummary, describeAnalysisForHistory } = require('../analysis-summary');
  const clean = parseAnalysisSummary(`Main answer.\n\nSecond paragraph.\n\n---\nSUMMARY\ntype: threshold\nfinding: HR drift 142→157 on the 34-min flat\nadvice_category: pacing\nadvice: start the flat 1–2 km/h slower\nopen: none\nrevised: none`);
  assert.equal(clean.body, 'Main answer.\n\nSecond paragraph.');
  assert.deepEqual(clean.summary, { type: 'threshold', finding: 'HR drift 142→157 on the 34-min flat', adviceCategory: 'pacing', advice: 'start the flat 1–2 km/h slower', open: null, revised: null, purpose: [], conditions: [] });

  // Markdown decoration, case, a category with extras and missing fields.
  const messy = parseAnalysisSummary('Answer.\n\n**SUMMARY**\n- **Type:** Tempo\n- **Advice category:** `Load` (or pacing)\n- **Advice:** add one easy day\n- **Revised:** earlier heat hypothesis');
  assert.equal(messy.body, 'Answer.');
  assert.equal(messy.summary.type, 'tempo');
  assert.equal(messy.summary.adviceCategory, 'load');
  assert.equal(messy.summary.finding, null);
  assert.equal(messy.summary.revised, 'earlier heat hypothesis');

  // No tail, or a header with no usable fields, keeps the whole text.
  assert.deepEqual(parseAnalysisSummary('Just an answer.'), { body: 'Just an answer.', summary: null });
  assert.equal(parseAnalysisSummary('Answer.\nSUMMARY\nnothing useful').summary, null);
  assert.equal(parseAnalysisSummary('Answer.\nSUMMARY\nnothing useful').body, 'Answer.\nSUMMARY\nnothing useful');

  assert.equal(describeAnalysisForHistory(clean.summary, null, 'tempo'),
    'type: code tempo / model threshold; finding: HR drift 142→157 on the 34-min flat; advice[pacing]: start the flat 1–2 km/h slower');
  assert.match(describeAnalysisForHistory(null, 'x'.repeat(900)), /^x{400}…$/);
});

test('history carries structured summaries and recent advice categories', () => {
  const summary = (category, advice) => ({ type: 'endurance', finding: 'steady', adviceCategory: category, advice, open: null, revised: null });
  const entries = [
    { startTime: '2026-08-01T10:00:00.000Z', distanceKm: 20, analysisText: 'Old long text '.repeat(100), analysisSummary: summary('pacing', 'go slower') },
    { startTime: '2026-08-02T10:00:00.000Z', distanceKm: 21, analysisSummary: summary('pacing', 'pace the climb') },
    { startTime: '2026-08-03T10:00:00.000Z', distanceKm: 22, analysisSummary: summary('none', 'nothing') },
  ];
  const text = buildRecentHistoryContext(entries);
  assert.match(text, /AI summary: type: endurance; finding: steady; advice\[pacing\]: go slower/);
  assert.match(text, /earlier model hypotheses, not evidence/);
  assert.doesNotMatch(text, /Old long text/);
  assert.match(text, /Recent advice categories \(oldest first\): pacing, pacing\./);
  assert.doesNotMatch(buildRecentHistoryContext([{ startTime: '2026-08-01T10:00:00.000Z', distanceKm: 5 }]), /Recent advice categories/);
});

test('analysis prompt requests the summary tail and storage keeps it separate from the text', async () => {
  const { SUMMARY_TAIL_INSTRUCTION } = require('../analysis-summary');
  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [] }, null, null, null, [], [], 'en');
  assert.ok(prompt.includes(SUMMARY_TAIL_INSTRUCTION));
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const columns = db.exec('PRAGMA table_info(activity_analysis)')[0].values.map((row) => row[1]);
    assert.ok(columns.includes('summary_json'));
  } finally {
    db.close();
  }
});

test('every command handler used by commands.js is destructured from services and supplied by activate', () => {
  const commandsSource = fs.readFileSync(path.join(__dirname, '..', 'commands.js'), 'utf8');
  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const destructured = /const \{([^}]+)\} = services;/.exec(commandsSource)[1].split(',').map((name) => name.trim()).filter(Boolean);
  const supplied = /registerCommands\(context, \{([^}]+)\}\)/.exec(extensionSource)[1].split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of ['tidyHeartRateProfiles']) {
    assert.ok(destructured.includes(name), `${name} destructured in commands.js`);
    assert.ok(supplied.includes(name), `${name} supplied from activate`);
  }
  for (const name of destructured) assert.ok(supplied.includes(name), `${name} is supplied`);
});

test('prompt evaluation flags missing tails, class mismatches, repeated categories and foreign numbers', () => {
  const { aggregateChecks, checkAnalysisResponse, evaluateEntries, findUnsupportedNumbers } = require('../prompt-eval');
  const prompt = '**Heuristic Session Class (computed, revisable):**\n- Class: threshold\n- Evidence: Z4 28 %, peak20 158\n**Altitude Quality:**\n- ALT_SETTLING: start 80 m below\nDistance 20.4 km, 55:10';
  const tail = (type, category, revised = 'none') => `\n---\nSUMMARY\ntype: ${type}\nfinding: x\nadvice_category: ${category}\nadvice: y\nopen: none\nrevised: ${revised}`;

  const good = checkAnalysisResponse({ response: `Пороговая сессия, Z4 28 %, высота стартовала ниже.${tail('threshold', 'pacing')}`, prompt });
  assert.equal(good.validTail, true);
  assert.equal(good.detectedClass, 'threshold');
  assert.equal(good.typeMatchesCode, true);
  assert.equal(good.flagsMissed, 0);
  assert.deepEqual(good.unsupportedNumbers, []);
  assert.ok(good.cyrillicShare > 0.9);

  const bad = checkAnalysisResponse({ response: 'Easy ride with 312 W average, 75 min.', prompt });
  assert.equal(bad.validTail, false);
  assert.deepEqual(bad.unsupportedNumbers, [312, 75]);
  assert.equal(bad.flagsMissed, 1);

  // A difference of two numbers from the same prompt line is a legitimate derivation.
  assert.deepEqual(findUnsupportedNumbers('gap 130 bpm', 'avg 150 and max 280'), []);
  assert.deepEqual(findUnsupportedNumbers('gap 130 bpm', 'avg 150\nmax 280'), [130]);

  const mismatch = checkAnalysisResponse({ response: `Ok.${tail('endurance', 'load')}`, prompt });
  assert.equal(mismatch.typeMatchesCode, false);
  assert.equal(checkAnalysisResponse({ response: `Ok.${tail('endurance', 'load', 'class was wrong')}`, prompt }).typeMatchesCode, true);

  const entries = [1, 2, 3, 4].map((n) => ({ file: `${n}`, prompt, response: `Answer.${tail('threshold', 'pacing')}` }));
  const results = evaluateEntries(entries);
  assert.deepEqual(results.map((item) => item.categoryRepeat), [false, false, false, true]);
  assert.equal(aggregateChecks(results).categoryRepeatPct, 25);
});

test('summary types are normalized across languages and older history entries are brief', () => {
  const { normalizeSessionType, parseAnalysisSummary, describeAnalysisForHistory } = require('../analysis-summary');
  assert.equal(normalizeSessionType('Пороговая'), 'threshold');
  assert.equal(normalizeSessionType('темповая'), 'tempo');
  assert.equal(normalizeSessionType('выносливость'), 'endurance');
  assert.equal(normalizeSessionType('смешанная'), 'mixed');
  assert.equal(normalizeSessionType('неопределённая'), 'undetermined');
  assert.equal(normalizeSessionType('fartlek'), 'fartlek');
  assert.equal(parseAnalysisSummary('A.\nSUMMARY\ntype: пороговая\nadvice: x').summary.type, 'threshold');
  const summary = { type: 'tempo', finding: 'f', adviceCategory: 'load', advice: 'a', open: 'o', revised: null };
  assert.equal(describeAnalysisForHistory(summary, null, 'tempo', { brief: true }), 'type: tempo; advice[load]');

  const entries = Array.from({ length: 8 }, (_, i) => ({ startTime: `2026-08-0${i + 1}T10:00:00.000Z`, distanceKm: 20, analysisSummary: summary }));
  const text = buildRecentHistoryContext(entries);
  assert.equal((text.match(/finding: f/g) || []).length, 3, 'only the latest three carry the full summary');
  assert.equal((text.match(/AI summary: type: tempo; advice\[load\]\n/g) || []).length, 5);
});

test('same-route context takes the latest prior rides and formats signed split differences', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /filter\(\(activity\) => activity\.routeId === routeInfo\.routeId && activity\.routeRelation === routeInfo\.relation\)\s*\.sort\(\(a, b\) => new Date\(a\.startTime\) - new Date\(b\.startTime\)\)/);
  assert.match(source, /currentRouteInfo = currentData\?\.routeInfo \|\| currentDetail\?\.routeInfo\s*\|\| \(currentRecords/);
});

function splitCheckpoints(firstKmh, secondKmh, totalKm = 20) {
  const rows = [];
  let elapsed = 0;
  for (let km = 2; km <= totalKm; km += 2) {
    elapsed += 2 / ((km <= totalKm / 2 ? firstKmh : secondKmh) / 3600);
    rows.push({ km, elapsedS: Math.round(elapsed), avgHr: 140 });
  }
  return rows;
}

test('route-typical second-half pattern separates the route from the day', () => {
  const { summarizeRoutePattern } = require('../route-store');
  const priors = [26, 27, 25, 28, 26, 27, 30].map((first) => ({ checkpoints: splitCheckpoints(first, first - 4) }));
  const pattern = summarizeRoutePattern(splitCheckpoints(27, 21), priors);
  assert.equal(pattern.priorCount, 7);
  assert.equal(pattern.slowerCount, 7);
  assert.ok(pattern.medianChangePct < -10 && pattern.medianChangePct > -20);
  assert.ok(pattern.currentChangePct < pattern.medianChangePct, 'this ride drops more than typical');
  assert.equal(pattern.currentDropsMoreThanCount, 7);
  assert.equal(summarizeRoutePattern(splitCheckpoints(27, 21), priors.slice(0, 3)), null, 'too few rides');
  assert.equal(summarizeRoutePattern([], priors), null);
});

test('route notes are stored per route and rendered with the pattern in the prompt block', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { readRouteNote, readRoutes, setRouteNote } = require('../route-store');
    db.run("INSERT INTO routes (name, ride_count) VALUES ('Loop', 5)");
    setRouteNote(db, 1, '  second half climbs, often headwind  ');
    assert.equal(readRouteNote(db, 1), 'second half climbs, often headwind');
    assert.equal(readRoutes(db)[0].note, 'second half climbs, often headwind');
    setRouteNote(db, 1, '   ');
    assert.equal(readRouteNote(db, 1), null);
  } finally {
    db.close();
  }
  const { buildRouteContextBlock } = require('../analysis');
  const text = buildRouteContextBlock({ routeName: 'Loop', relation: 'same', priorRideCount: 7, checkpointLines: [], climbLine: null,
    patternLine: 'Route-typical pattern (7 earlier rides): ...', routeNote: 'second half climbs', note: 'Route identity from GPS geometry.' });
  assert.match(text, /User note about this route \(user-declared, applies to every ride on it\): second half climbs/);
  assert.match(text, /Route-typical pattern/);
  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [] },
    { total_activities: 0, trainingContext: { ...buildTrainingContext([], '2026-08-25', 'cycling'), routeContext: { routeName: 'Loop', relation: 'same', priorRideCount: 7, checkpointLines: [], patternLine: 'p', note: 'n' } } },
    {}, null, [], [], 'en');
  assert.match(prompt, /property of the route, not a finding of the day and not an open question/);
});

function loopRideRecords(speedAt, reversed = false, lengthKm = 20) {
  const records = [];
  let distance = 0;
  let elapsed = 0;
  while (distance < lengthKm) {
    const fraction = distance / lengthKm;
    const canonical = reversed ? 1 - fraction : fraction;
    records.push({ elapsed_time: elapsed, distance });
    elapsed += 10;
    distance += (speedAt(canonical) * 10) / 3600;
  }
  records.push({ elapsed_time: elapsed, distance: lengthKm });
  return records;
}

test('route features derive climbs, per-direction speeds and flat-ground direction effects', () => {
  const { computeRouteFeatures, describeRouteFeatures, findClimbs, sectionCount, sectionSpeeds } = require('../route-features');
  const bins = 800;
  const consensus = Array.from({ length: bins }, (_, i) => (i < bins - 24 ? 100 : 100 + ((i - (bins - 24)) / 24) * 35));
  const profile = { consensus, lengthKm: 20, ascentM: 35, descentM: 0 };
  assert.equal(sectionCount(profile), 10);

  const climbs = findClimbs(consensus, 20 / bins, false);
  assert.equal(climbs.length, 1);
  assert.ok(climbs[0].fromKm > 19.2 && climbs[0].gainM >= 30 && climbs[0].avgGradePct > 5);
  assert.equal(findClimbs(consensus, 20 / bins, true).length, 0, 'the same ramp is a descent in the opposite direction');

  // Canonical direction: fast on km 4-10, slow on km 10-16; the opposite direction is the mirror image.
  const speedAt = (position) => (position >= 0.2 && position < 0.5 ? 28 : position >= 0.5 && position < 0.8 ? 23 : 25);
  const rides = [];
  for (let i = 0; i < 4; i += 1) {
    rides.push({ relation: 'same', speeds: sectionSpeeds(loopRideRecords(speedAt), 10) });
    rides.push({ relation: 'reversed', speeds: sectionSpeeds(loopRideRecords(speedAt, true), 10) });
  }
  const features = computeRouteFeatures(profile, rides);
  assert.equal(features.rows.length, 10);
  assert.ok(Math.abs(features.rows[3].sameKmh - 28) < 0.6);
  assert.ok(Math.abs(features.rows[6].sameKmh - 23) < 0.6);
  assert.ok(Math.abs(features.rows[3].reversedKmh - 28) < 0.6, 'reversed rides are stored on the canonical axis');

  const same = describeRouteFeatures(features, 'same');
  assert.equal(same.climbs.length, 1);
  assert.equal(same.asymmetric.length, 0, 'the reversed rides mirror the speeds, so no direction effect');

  // Now the opposite direction rides the same stretch slowly: a direction effect.
  const windy = [];
  for (let i = 0; i < 4; i += 1) {
    windy.push({ relation: 'same', speeds: sectionSpeeds(loopRideRecords(speedAt), 10) });
    windy.push({ relation: 'reversed', speeds: sectionSpeeds(loopRideRecords((position) => (position >= 0.2 && position < 0.5 ? 21 : 25), true), 10) });
  }
  const effect = describeRouteFeatures(computeRouteFeatures(profile, windy), 'same');
  assert.equal(effect.asymmetric.length, 1);
  assert.equal(effect.asymmetric[0].fromKm, 4);
  assert.equal(effect.asymmetric[0].toKm, 10);
  assert.ok(effect.asymmetric[0].ownKmh > effect.asymmetric[0].otherKmh);
  const opposite = describeRouteFeatures(computeRouteFeatures(profile, windy), 'reversed');
  assert.ok(opposite.asymmetric[0].ownKmh < opposite.asymmetric[0].otherKmh);

  assert.equal(computeRouteFeatures({ consensus: [], lengthKm: 20 }, []), null);
  assert.equal(sectionSpeeds([{ elapsed_time: 0, distance: 0 }], 10), null);
});

test('route profile block lists climbs and direction effects, and is cached per member count', async () => {
  const { buildRouteProfileBlock } = require('../analysis');
  assert.equal(buildRouteProfileBlock(null), '');
  const text = buildRouteProfileBlock({
    direction: 'same', lengthKm: 20.4, ascentM: 117, descentM: 118, rideCounts: { same: 20, reversed: 14 },
    described: {
      rows: [{ fromKm: 0, toKm: 2, gradePct: -1.9, ownKmh: 27, otherKmh: 14.2 }],
      climbs: [{ fromKm: 19.8, toKm: 20.4, gainM: 35, avgGradePct: 5.6 }],
      asymmetric: [{ fromKm: 4, toKm: 10, ownKmh: 27.5, otherKmh: 23 }],
    },
  });
  assert.match(text, /20 in the first-ride direction, 14 opposite/);
  assert.match(text, /km 19\.8-20\.4 \+35 m \(avg 5\.6%\)/);
  assert.doesNotMatch(text, /Typical moving speed by section/);
  assert.match(text, /km 4-10 is near-flat, yet about 27\.5 km\/h here vs 23 km\/h in the opposite direction/);
  assert.match(text, /not with fitness/);

  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { ensureRouteFeatures } = require('../route-store');
    assert.equal(ensureRouteFeatures(db, null), null);
    db.run("INSERT INTO routes (name, ride_count) VALUES ('Loop', 0)");
    assert.equal(ensureRouteFeatures(db, 1), null, 'no rides, no consensus, no features');
  } finally {
    db.close();
  }
});

test('activity page shows an editable route card only for a repeated route and wires its save message', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const fitData = { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] };
  const render = (routeCard) => renderActivityContentHtml(
    {}, {}, fitData, null, 'n', false, null, {}, null, [], null, UI_STRINGS, GLOSSARY, false, 'en',
    [], null, [], null, false, 'osm', routeCard);
  const html = render({ routeId: 2, name: 'Home loop', note: 'climb <b>late</b>', rideCount: 36, relation: 'reversed',
    lengthKm: 20.4, ascentM: 117, descentM: 118, climbs: [{ fromKm: 19.8, toKm: 20.4, gainM: 35, avgGradePct: 5.6 }] });
  assert.match(html, />Route<\/h2>/);
  assert.match(html, /36 rides on this route; this ride goes in the opposite direction/);
  assert.match(html, /Length 20\.4 km, ascent about 117 m, descent about 118 m/);
  assert.match(html, /km 19\.8-20\.4 \+35 m \(5\.6%\)/);
  assert.match(html, /value="Home loop"/);
  assert.match(html, /climb &lt;b&gt;late&lt;\/b&gt;<\/textarea>/, 'the note is escaped');
  assert.match(html, /type: 'updateRoute'[\s\S]*routeId: 2,/);
  assert.doesNotMatch(render(null), /<form id="fitMapRouteForm"/);
  assert.match(html, /<form id="fitMapRouteForm"/);

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /'updateHeartRateProfile', 'updateRoute',/, 'activity id is validated for route saves');
  assert.match(source, /msg\.type === 'routeError'|type: 'routeError'/);
});

test('session notes are normalized from untrusted input, stored per activity and deleted when emptied', async () => {
  const { buildSessionNotesBlock, describeNotesShort, normalizeNotes, readActivityNotes, readAllActivityNotes, saveActivityNotes } = require('../activity-notes');
  assert.equal(normalizeNotes({}), null);
  assert.equal(normalizeNotes({ rpe: '', purpose: 'nonsense', conditions: ['bogus'], note: '   ' }), null);
  assert.deepEqual(normalizeNotes({ rpe: '7', purpose: 'Endurance', feeling: 'tired', conditions: ['headwind', 'heat', 'headwind', 'x'], note: ' legs heavy ' }),
    { rpe: 7, purpose: 'endurance', feeling: 'tired', conditions: ['headwind', 'heat'], note: 'legs heavy' });
  assert.equal(normalizeNotes({ rpe: 11, purpose: 'race' }).rpe, null, 'RPE outside 1-10 is dropped');
  assert.equal(normalizeNotes({ rpe: 6.5, purpose: 'race' }).rpe, null);
  assert.equal(normalizeNotes({ note: 'x'.repeat(5000) }).note.length, 1000);

  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    db.run("INSERT INTO activities (id, file_path, file_name, start_time, source) VALUES (1, 'a', 'a', '2026-08-01T10:00:00Z', 'fit')");
    assert.equal(readActivityNotes(db, 1), null);
    saveActivityNotes(db, 1, { rpe: 7, purpose: 'endurance', conditions: ['headwind'] });
    saveActivityNotes(db, 1, { rpe: 8, purpose: 'endurance', conditions: ['headwind', 'rain'], note: 'second save' });
    assert.deepEqual(readActivityNotes(db, 1), { rpe: 8, purpose: 'endurance', feeling: null, conditions: ['headwind', 'rain'], note: 'second save' });
    assert.equal(readAllActivityNotes(db).size, 1);
    saveActivityNotes(db, 1, {});
    assert.equal(readActivityNotes(db, 1), null);
  } finally {
    db.close();
  }

  const notes = { rpe: 7, purpose: 'new_route', feeling: 'tired', conditions: ['headwind', 'new_route'], note: 'first time here' };
  assert.equal(describeNotesShort(notes), 'RPE 7, new_route, tired');
  assert.equal(describeNotesShort({ rpe: null, purpose: null, feeling: 'normal', conditions: [], note: null }), null);
  const block = buildSessionNotesBlock(notes);
  assert.match(block, /Session Notes \(user-declared for this ride\)/);
  assert.match(block, /RPE 7\/10; purpose: new route; conditions: headwind, new route; feeling: tired\./);
  assert.match(block, /Note: first time here/);
  assert.match(block, /declared purpose replaces any inferred training direction/);
  assert.equal(buildSessionNotesBlock(null), '');
});

test('session notes reach the analysis and chat prompts and the history rows', () => {
  const notes = { rpe: 7, purpose: 'endurance', feeling: null, conditions: ['heat'], note: null };
  const withNotes = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], sessionNotes: notes }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(withNotes, /RPE 7\/10; purpose: endurance; conditions: heat\./);
  assert.doesNotMatch(withNotes, /No session notes \(RPE, purpose, conditions\)/);
  const without = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [] }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(without, /No session notes \(RPE, purpose, conditions\) are recorded for this ride/);
  assert.doesNotMatch(without, /Athlete's Session Notes/);
  const chat = generateAnalysisChatPrompt({ sessions: [{ sport: 'cycling' }], sessionNotes: notes }, {}, {}, '', [], 'why?');
  assert.match(chat, /RPE 7\/10/);

  const history = buildRecentHistoryContext([{ startTime: '2026-08-01T10:00:00.000Z', distanceKm: 20, notes }]);
  assert.match(history, /20\.0 km, RPE 7, endurance/);
});

test('activity page renders session notes with the saved values and escapes the note', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const base = { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] };
  const render = (sessionNotes) => renderActivityContentHtml({}, {}, { ...base, sessionNotes }, null, 'n', false, null, {}, null, [], null,
    UI_STRINGS, GLOSSARY, false, 'en', [], null, [], null, false, 'osm', null);
  const html = render({ rpe: 7, purpose: 'race', feeling: 'ill', conditions: ['rain'], note: '<i>cold</i>' });
  assert.match(html, />Session Notes<\/h2>/);
  assert.match(html, /<option value="7" selected>7<\/option>/);
  assert.match(html, /<option value="race" selected>Race<\/option>/);
  assert.match(html, /<option value="ill" selected>Unwell<\/option>/);
  assert.match(html, /value="rain" style="width:auto;" checked>/);
  assert.match(html, /&lt;i&gt;cold&lt;\/i&gt;<\/textarea>/);
  assert.match(html, /type: 'updateActivityNotes'/);
  const empty = render(null);
  assert.match(empty, /<form id="fitMapNotesForm"/);
  assert.doesNotMatch(empty, /selected>7</);

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /'updateRoute', 'updateActivityNotes',/, 'activity id is validated for note saves');
});

test('every contributed setting appears in the settings table of both READMEs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const contributed = Object.keys(manifest.contributes.configuration.properties)
    .filter((key) => key.startsWith('fitVisualizer.'));
  for (const readme of ['README.md', 'README.ru.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', readme), 'utf8');
    for (const key of contributed) {
      assert.ok(text.includes(`\`${key}\``), `${readme} settings table is missing ${key}`);
    }
  }
});

test('prompt evaluator measures open questions, notes usage, direction facts and altitude coverage', () => {
  const { aggregateChecks, checkAnalysisResponse } = require('../prompt-eval');
  const prompt = (blocks, reversed) => `${blocks}${reversed ? ' (reversed)' : ''}`;
  const tail = (open, advice) => `\n---\nSUMMARY\ntype: tempo\nfinding: f\nadvice_category: pacing\nadvice: ${advice}\nopen: ${open}\nrevised: none`;
  const onRoute = prompt('**Route Profile:** km 4-10 typical 27.5 km/h');
  const a = checkAnalysisResponse({ response: `Использовано направление маршрута.${tail('none', 'держите ровное усилие')}`, prompt: onRoute });
  assert.equal(a.openPresent, false);
  assert.equal(a.openAboutSlowdown, false);
  assert.equal(a.asksForEffort, false);
  assert.equal(a.hasRouteBlocks, true);
  assert.equal(a.usesDirection, true);

  const b = checkAnalysisResponse({ response: `Замедление на ровном участке.${tail('Что вызвало замедление после 10 км?', 'запишите RPE и условия на следующей поездке')}`, prompt: onRoute });
  assert.equal(b.openAboutSlowdown, true);
  assert.equal(b.asksForEffort, true);
  assert.equal(b.usesDirection, false);

  const withNotes = checkAnalysisResponse({ response: `Заявленное усилие RPE 7 учтено.${tail('none', 'ok')}`, prompt: prompt("**Athlete's Session Notes:** RPE 7/10") });
  assert.equal(withNotes.hasNotesBlock, true);
  assert.equal(withNotes.usesNotes, true);
  assert.equal(checkAnalysisResponse({ response: `x${tail('none', 'запишите RPE')}`, prompt: onRoute }).hasNotesBlock, false);

  const alt = checkAnalysisResponse({ response: `ok${tail('none', 'ok')}`, prompt: prompt('**Altitude Quality:**\n- ALT_SETTLING: x', true) });
  assert.equal(alt.hasAltitudeBlock, true);
  assert.equal(alt.reversedRide, true);
  assert.equal(checkAnalysisResponse({ response: `ok${tail('none', 'ok')}`, prompt: 'Elevation Gain: 64 m (device reports 0/0 m; sources disagree)' }).deviceZeroZero, true);

  const agg = aggregateChecks([a, b, withNotes, alt]);
  assert.equal(agg.openAboutSlowdownCount, 1);
  assert.equal(agg.asksForEffortCount, 1);
  assert.equal(agg.usesNotesPctOfWithNotes, 100);
  assert.equal(agg.usesDirectionPctOfRoute, 50);
  assert.equal(agg.altitudeBlockPctOfReversed, 100);
});

test('a device that wrote no ascent figure is not shown as a disagreeing source', () => {
  const base = { sport: 'cycling', start_time: '2026-08-19T17:06:08Z', total_ascent_m: 64, total_descent_m: 163 };
  const blank = generateAnalysisPrompt({ sessions: [{ ...base, device_ascent_m: 0, device_descent_m: 0 }], records: [] }, { total_activities: 0 });
  assert.doesNotMatch(blank, /device reports 0\/0/);
  const wrote = generateAnalysisPrompt({ sessions: [{ ...base, device_ascent_m: 128, device_descent_m: 128 }], records: [] }, { total_activities: 0 });
  assert.match(wrote, /device reports 128\/128 m; sources disagree/);
});

test('reversed rides join the elevation consensus mirrored onto the canonical axis', async () => {
  const { buildAltitudeRide, computeConsensusProfile, detectAltitudeSettling, mirrorConsensusProfile } = require('../altitude-quality');
  // A hill in the middle of the route: high at 50 % of the distance on the canonical axis.
  const shape = (position) => 100 + 60 * Math.sin(Math.PI * position);
  const rideOnAxis = (offsetM, driftM = 0) => buildAltitudeRide(Array.from({ length: 1200 }, (_, i) => {
    const position = i / 1200;
    const distance = position * 20;
    const drift = driftM ? driftM * Math.max(0, 1 - i / 180) : 0;
    return { elapsed_time: i, distance, altitude: (shape(position) + offsetM + drift) / 1000,
      position_lat: 52 + 0.01 * Math.sin(2 * Math.PI * position), position_long: 13 + 0.01 * (1 - Math.cos(2 * Math.PI * position)) };
  }));
  const rides = [0, 20, -20, 40, -40, 10].map((offset) => rideOnAxis(offset));
  const profile = computeConsensusProfile(rides);
  assert.ok(Math.abs(profile.ascentM - 60) <= 6);

  // The same loop ridden backwards: distances flip, so the un-mirrored ride would disagree with
  // the consensus while the mirrored one follows it exactly (up to its constant offset).
  const reversedRide = (() => {
    const points = Array.from({ length: 1200 }, (_, i) => {
      const position = i / 1200;
      return { elapsed_time: i, distance: position * 20, altitude: shape(1 - position) / 1000,
        position_lat: 52 + 0.01 * Math.sin(2 * Math.PI * (1 - position)), position_long: 13 + 0.01 * (1 - Math.cos(2 * Math.PI * (1 - position))) };
    });
    return buildAltitudeRide(points);
  })();
  // For a reversed ride the consensus itself is mirrored, so the ride's first minutes stay first.
  const mirroredProfile = mirrorConsensusProfile(profile);
  assert.equal(detectAltitudeSettling(reversedRide, mirroredProfile), null, 'a clean reversed ride is not flagged');
  const driftingReversed = buildAltitudeRide(Array.from({ length: 1200 }, (_, i) => {
    const position = i / 1200;
    const drift = -90 * Math.max(0, 1 - i / 150);
    return { elapsed_time: i, distance: position * 20, altitude: (shape(1 - position) + 30 + drift) / 1000,
      position_lat: 52 + 0.01 * Math.sin(2 * Math.PI * (1 - position)), position_long: 13 + 0.01 * (1 - Math.cos(2 * Math.PI * (1 - position))) };
  }));
  const caught = detectAltitudeSettling(driftingReversed, mirroredProfile);
  assert.ok(caught, 'reversed drift is detected');
  assert.ok(caught.startDeltaM < -50);

  // The store layer feeds both relations into the consensus.
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { assignRoute, ensureRouteElevationProfile } = require('../route-store');
    const { buildRouteSignature } = require('../route-match');
    let routeId = null;
    for (let id = 1; id <= 6; id += 1) {
      const forward = id <= 3;
      const points = Array.from({ length: 1200 }, (_, i) => {
        const position = i / 1200;
        const canonical = forward ? position : 1 - position;
        return { elapsed_time: i, distance: position * 20, altitude: (shape(canonical) + id * 10) / 1000,
          position_lat: 52 + 0.01 * Math.sin(2 * Math.PI * canonical), position_long: 13 + 0.01 * (1 - Math.cos(2 * Math.PI * canonical)) };
      });
      db.run('INSERT INTO activities (id, file_path, file_name, start_time, source) VALUES (?, ?, ?, ?, ?)', [id, `f${id}`, `f${id}`, `2026-08-0${id}T10:00:00Z`, 'fit']);
      points.forEach((point, index) => {
        db.run('INSERT INTO records (activity_id, record_index, elapsed_s, distance_km, altitude_m, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, index, point.elapsed_time, point.distance, point.altitude * 1000, point.position_lat, point.position_long]);
      });
      const signature = buildRouteSignature(forward ? points : points.map((p, i, all) => ({ ...p, position_lat: all[all.length - 1 - i].position_lat, position_long: all[all.length - 1 - i].position_long })));
      const result = assignRoute(db, { activityId: id, signature, createdAt: `2026-08-0${id}T10:00:00Z` });
      routeId = result.routeId;
    }
    const merged = ensureRouteElevationProfile(db, routeId);
    assert.equal(merged.rides, 6, 'both directions contribute');
    assert.ok(Math.abs(merged.ascentM - 60) <= 6, `ascent ${merged.ascentM} survives mixing directions`);
  } finally {
    db.close();
  }
});

test('parser kilometre ascent/descent is stored in metres', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /const toDeviceMetres = \(value\) => \{/);
  assert.match(source, /return number < 5 \? number \* 1000 : number;/);
});

test('checkpoint summaries carry prior median HR and best, and the verdict states effort vs time', () => {
  const { describeCheckpointVerdict, summarizeCheckpoints } = require('../route-store');
  const mark = (km, elapsedS, avgHr) => ({ km, elapsedS, avgHr });
  const prior = [{ checkpoints: [mark(20, 2900, 148), mark(18, 2500, 145)] }, { checkpoints: [mark(20, 3000, 150), mark(18, 2550, 147)] },
    { checkpoints: [mark(20, 2950, 149), mark(18, 2520, 146)] }];
  const summary = summarizeCheckpoints([mark(20, 3150, 140)], prior);
  assert.equal(summary[0].priorMedianS, 2950);
  assert.equal(summary[0].priorBestS, 2900);
  assert.equal(summary[0].priorMedianHr, 149);
  const slowerLower = describeCheckpointVerdict(summary);
  assert.match(slowerLower, /at km 20: 3 min 20s slower than the prior median at HR 140 vs prior median 149 — slower at lower HR \(less effort\)\./);

  const fasterHigher = describeCheckpointVerdict(summarizeCheckpoints([mark(20, 2800, 158)], prior));
  assert.match(fasterHigher, /faster at higher HR \(more effort, not evidence of efficiency\)/);
  const fasterSimilar = describeCheckpointVerdict(summarizeCheckpoints([mark(20, 2750, 150)], prior));
  assert.match(fasterSimilar, /faster at similar HR/);
  const fasterLower = describeCheckpointVerdict(summarizeCheckpoints([mark(20, 2750, 140)], prior));
  assert.match(fasterLower, /faster at lower HR \(the kind of change that, repeated, would indicate improved efficiency\)/);
  const noPriors = describeCheckpointVerdict(summarizeCheckpoints([mark(20, 2900, 140)], []));
  assert.equal(noPriors, null);
  const withoutPriorHr = describeCheckpointVerdict(summarizeCheckpoints([mark(20, 2800, 158)], [{ checkpoints: [mark(20, 2950, null)] }]));
  assert.match(withoutPriorHr, /heart rate of prior rides is unknown/);
  assert.doesNotMatch(describeCheckpointVerdict(summarizeCheckpoints([mark(20, 2940, 149)], prior)), /faster at|slower at/, 'a 0.3 % time delta with similar HR is no difference');
});

test('flat segments get a route-stretch breakdown with typical speeds and a computed verdict', () => {
  const { computeSegmentStretches, describeStretches } = require('../route-features');
  const described = {
    rows: [
      { fromKm: 4, toKm: 6, gradePct: -0.5, ownKmh: 27.5 }, { fromKm: 6, toKm: 8, gradePct: -0.5, ownKmh: 27.5 },
      { fromKm: 8, toKm: 10, gradePct: -0.2, ownKmh: 28.6 }, { fromKm: 10, toKm: 12, gradePct: 0.5, ownKmh: 23.4 },
      { fromKm: 12, toKm: 14, gradePct: 0.4, ownKmh: 23.9 }, { fromKm: 14, toKm: 16, gradePct: 0.8, ownKmh: 22.2 },
      { fromKm: 16, toKm: 18, gradePct: 0.2, ownKmh: 22.8 }, { fromKm: 18, toKm: 20, gradePct: 1.9, ownKmh: 14.9 },
    ],
    asymmetric: [{ fromKm: 10, toKm: 16, ownKmh: 23, otherKmh: 27.5 }],
    climbs: [{ fromKm: 19.8, toKm: 20.4, gainM: 35, avgGradePct: 5.6 }],
  };
  // A ride following the typical speeds with rising HR: 20 km at the section speeds.
  const records = [];
  let elapsed = 0;
  const speedAt = (km) => (km < 10 ? 27.5 : km < 16 ? 23 : 22.5);
  for (let km = 0; km <= 19.6; km += 0.02) {
    const hr = km < 10 ? 140 : 140 + Math.round((km - 10) / 9.6 * 15);
    records.push({ elapsed_time: elapsed, distance: km, heart_rate: hr });
    elapsed += (0.02 / speedAt(km)) * 3600;
  }
  const stretches = computeSegmentStretches(records, described, 4, 19.6);
  assert.ok(stretches?.length >= 3);
  assert.ok(stretches.every((stretch) => stretch.typicalKmh == null || Math.abs(stretch.deltaPct) <= 6), JSON.stringify(stretches));
  assert.match(describeStretches(stretches), /Speed follows the route; HR rises \d+ bpm at route-typical speed/);
  assert.equal(stretches.find((stretch) => stretch.fromKm === 18).typicalKmh, null, 'no typical for the pre-climb section');

  // Slower on the km 10-16 stretch at the same HR.
  const slower = [];
  elapsed = 0;
  for (let km = 0; km <= 19.6; km += 0.02) {
    const speed = km < 10 ? 27.5 : km < 16 ? 20.5 : 22.5;
    slower.push({ elapsed_time: elapsed, distance: km, heart_rate: 140 });
    elapsed += (0.02 / speed) * 3600;
  }
  const slowerStretches = computeSegmentStretches(slower, described, 4, 19.6);
  assert.match(describeStretches(slowerStretches), /Slower than route-typical on km 1[024]-1[46] by \d+(\.\d+)?%; HR steady\./);

  // Guard rails.
  assert.equal(computeSegmentStretches(records, described, 10, 13), null, 'short segment');
  assert.equal(describeStretches([{ fromKm: 4, toKm: 6, kmh: 27, typicalKmh: null, deltaPct: null, hr: 140 }]), null);
  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], segments: [
    { index: 0, type: 'flat', effortBasis: 'hr', startElapsed: 0, endElapsed: 2400, durationS: 2400, distanceKm: 15, routeStretches: stretches },
  ] }, { total_activities: 0 });
  assert.match(prompt, /by route stretch \(this ride \/ typical for this direction\)/);
  assert.match(prompt, /speed change between stretches belongs to the route/);
  assert.doesNotMatch(prompt, /temporal halves/);
});

test('history keeps a hard character budget by dropping whole oldest entries', () => {
  const summary = { type: 'tempo', finding: `${'long finding '.repeat(20)}`, adviceCategory: 'load', advice: 'a', open: null, revised: null };
  // Full summaries only for the latest three; older entries are brief, so 12 entries stay short.
  // To exercise the cap, make every entry verbose with analysisText instead.
  // The realistic worst case: verbose rows with conversation context and full summaries on top.
  const entries = Array.from({ length: 12 }, (_, i) => ({
    startTime: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`, utcOffsetS: 7200, distanceKm: 20.4,
    durationS: 3600, avgHr: 147, trimp: 113, hrTss: 68, elevationM: 118, peak20: 158,
    sessionClass: { label: 'threshold', confidence: 'high' }, notes: { rpe: 7, purpose: 'endurance' },
    hrProfileDate: '2026-08-01', routeId: 2,
    analysisSummary: { type: 'threshold', finding: `${'отчётливый вывод с подробностями '.repeat(12)}${i}`, adviceCategory: 'load',
      advice: `${'рекомендация с объяснением причины '.repeat(10)}${i}`, open: `${'вопрос с контекстом '.repeat(8)}`, revised: `${'пересмотр '.repeat(6)}` },
  }));
  const text = buildRecentHistoryContext(entries);
  assert.ok(text.length <= 4700, `${text.length} must fit the 4500 budget plus header and notes`);
  assert.match(text, /older rides? omitted to fit the block; their facts remain in the period totals/);
  assert.match(text, /2026-08-12/, 'the latest entries survive');
  assert.match(text, /2026-08-12/, 'the latest entries survive');
  assert.doesNotMatch(text, /2026-08-01: /, 'the oldest entry is dropped whole');
  
});

test('routed rides drop the ascent line and peak20 stays only for hard classes', () => {
  const base = { startTime: '2026-08-01T10:00:00.000Z', distanceKm: 20, elevationM: 110, peak20: 150, durationS: 3600 };
  const routed = buildRecentHistoryContext([{ ...base, routeId: 2 }]);
  assert.doesNotMatch(routed, /ascent 110 m/);
  const unrouted = buildRecentHistoryContext([{ ...base, sessionClass: { label: 'endurance' } }]);
  assert.match(unrouted, /ascent 110 m/);
  assert.doesNotMatch(unrouted, /peak20 150/);
  const hard = buildRecentHistoryContext([{ ...base, sessionClass: { label: 'threshold' } }]);
  assert.match(hard, /peak20 150/);
});

test('asking to record notes is suppressed when recent analyses already suggested it', () => {
  const data = { sessions: [{ sport: 'cycling' }], records: [] };
  const recentWithDataAdvice = [{ startTime: '2026-08-02T10:00:00.000Z', distanceKm: 20,
    analysisSummary: { type: 'tempo', adviceCategory: 'data', advice: 'Record perceived effort and conditions next time.', finding: 'f' } }];
  const suppressed = generateAnalysisPrompt(data, { total_activities: 0, trainingContext: buildTrainingContext(recentWithDataAdvice, '2026-08-03', 'cycling', []) }, {}, null, [], recentWithDataAdvice, 'en');
  assert.match(suppressed, /Notes were already suggested in recent analyses; do not suggest them again/);
  assert.doesNotMatch(suppressed, /Suggest recording them only when that is the most useful next step/);
  const untouched = generateAnalysisPrompt(data, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(untouched, /Suggest recording them only when that is the most useful next step/);
  const withNotes = generateAnalysisPrompt({ ...data, sessionNotes: { rpe: 7, purpose: 'endurance' } }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.doesNotMatch(withNotes, /No session notes/);
  const tail = /open: <one question whose answer would change the advice[^>]*usually none>/.exec(require('../analysis-summary').SUMMARY_TAIL_INSTRUCTION);
  assert.ok(tail, 'the tail instruction encourages none');
});

test('a stale derived-feature version triggers one background rebuild with progress, a fresh one does not', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /scheduleDerivedFeatureAutoRebuild\(\);/);
  // The automatic rebuild skips quietly when fresh; when work is due it shows progress.
  assert.match(source, /if \(\(silent \|\| background\) && !skipStaleCheck && !needsDerivedFeatureRebuild\(db\)\) \{\s*\n\s*return;/);
  assert.match(source, /reason: 'auto'/);
  assert.match(source, /WHERE features_version != \$\{FEATURES_VERSION\}/);
  assert.equal(require('../activity-features').FEATURES_VERSION, 5, 'the version bump is what makes existing caches stale');

  const { needsDerivedFeatureRebuild } = loadExtensionInternalsForTest();
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    assert.equal(needsDerivedFeatureRebuild(db), false, 'empty database needs nothing');
    db.run("INSERT INTO activities (id, file_path, file_name, start_time, source) VALUES (1, 'a', 'a', '2026-08-01T10:00:00Z', 'fit')");
    assert.equal(needsDerivedFeatureRebuild(db), true, 'an activity without feature rows is not covered');
    db.run(`INSERT INTO activity_features (activity_id, features_version, feature_cache_key) VALUES (1, ${require('../activity-features').FEATURES_VERSION}, 'k')`);
    assert.equal(needsDerivedFeatureRebuild(db), false, 'a fresh row for every activity needs nothing');
    db.run('UPDATE activity_features SET features_version = 1');
    assert.equal(needsDerivedFeatureRebuild(db), true, 'a stale version triggers the rebuild');
  } finally {
    db.close();
  }
});

test('data-quality flags detect HR dropout, late start, contact loss, hot device, elapsed mismatch and smart recording', () => {
  const { DQ, buildDataQualityFlagBlock, computeDataQualityFlags } = require('../data-quality');
  const ride = (overrides) => Array.from({ length: 900 }, (_, i) => ({
    elapsed_time: i, distance: i * 0.006, heart_rate: 140, temperature_c: 22, position_lat: 52, position_long: 13, ...overrides?.(i),
  }));
  const codes = (records, extra) => computeDataQualityFlags({ records, ...extra }).map((flag) => flag.code);

  assert.deepEqual(codes(ride()), [], 'a clean ride has no flags');

  // Dropout: 100 s of missing HR in the middle.
  assert.deepEqual(codes(ride((i) => (i >= 300 && i < 400 ? { heart_rate: null } : null))), ['HR_DROPOUT']);
  // Late start: HR appears after 400 s.
  assert.deepEqual(codes(ride((i) => (i < 400 ? { heart_rate: null } : null))), ['HR_LATE_START']);
  // No HR at all.
  assert.deepEqual(codes(ride(() => ({ heart_rate: null }))), ['HR_ABSENT']);
  // Contact loss: three spikes of +25 bpm recovering in 3 s.
  const spiky = ride((i) => ([100, 300, 600].includes(i) ? { heart_rate: 165 } : null));
  assert.ok(codes(spiky).includes('HR_CONTACT_LOSS'));
  // Hot device: max 41, avg 30.
  assert.ok(codes(ride((i) => ({ temperature_c: i > 800 ? 41 : 30 }))).includes('TEMP_DEVICE_HOT'));
  // Elapsed mismatch: device session left running.
  assert.ok(codes(ride(), { session: { device_elapsed_s: 32000, total_elapsed_s: 3400 } }).includes('ELAPSED_MISMATCH'));
  // Wheel-sensor scale error.
  assert.ok(codes(ride(), { wheelRatio: 1.04 }).includes('SPEED_SENSOR_GPS_MISMATCH'));
  // Smart recording: 2.5 s steps.
  const sparse = Array.from({ length: 400 }, (_, i) => ({ elapsed_time: i * 2.5, distance: i * 0.015, heart_rate: 140, temperature_c: 22, position_lat: 52, position_long: 13 }));
  assert.ok(codes(sparse).includes('SMART_RECORDING'));
  // GPS gap.
  assert.ok(codes(ride((i) => (i >= 200 && i < 280 ? { position_lat: null, position_long: null } : null))).includes('GPS_GAP'));
  // Offset change note becomes a flag.
  assert.ok(codes(ride(), { offsetChangeNote: 'device UTC offset differs from neighbours' }).includes('OFFSET_CHANGED'));

  const block = buildDataQualityFlagBlock([{ code: 'HR_DROPOUT', severity: 'warn', text: '110 s without heart rate' }, { code: 'HR_ABSENT', severity: 'info', text: 'no HR' }]);
  assert.match(block, /- HR_DROPOUT: 110 s without heart rate/);
  assert.doesNotMatch(block, /HR_ABSENT/, 'info flags stay out of the prompt block');
  assert.match(block, /Use each as the explanation where it changes a conclusion, once/);
  assert.equal(buildDataQualityFlagBlock([]), '');

  const flags = [{ code: 'HR_DROPOUT', severity: 'warn', text: '110 s without HR' }];
  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], qualityFlags: flags },
    { total_activities: 0, trainingContext: { ...buildTrainingContext([], '2026-08-25', 'cycling') } }, {}, null, [], [], 'en');
  assert.match(prompt, /- HR_DROPOUT: 110 s without HR/);
  // The flags block appears exactly once even when the training-history context also carries the
  // same flags (it used to be printed from both the body and the history block).
  const withContextFlags = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], qualityFlags: flags },
    { total_activities: 0, trainingContext: { ...buildTrainingContext([], '2026-08-25', 'cycling'), qualityFlags: flags } }, {}, null, [], [], 'en');
  assert.equal(withContextFlags.split('**Data Quality Flags').length - 1, 1);
  const chat = generateAnalysisChatPrompt({ sessions: [{ sport: 'cycling' }], records: [], qualityFlags: flags },
    { trainingContext: { ...buildTrainingContext([], '2026-08-25', 'cycling'), qualityFlags: flags } }, {}, '', [], 'why?', 'en');
  assert.equal(chat.split('**Data Quality Flags').length - 1, 1);
});

test('settling window lands in the workout fields with the recomputed settled part', () => {
  const records = [];
  for (let i = 0; i < 2400; i += 1) {
    const drift = -80 * Math.max(0, 1 - i / 600);
    records.push({ elapsed_time: i, distance: i * 0.006, altitude: (100 + 30 * Math.sin(i / 900) + drift) / 1000 });
  }
  const prompt = generateAnalysisPrompt({
    sessions: [{ sport: 'cycling', start_time: '2026-08-19T17:06:08Z', total_ascent_m: 64, total_descent_m: 163, device_ascent_m: 128, device_descent_m: 128 }],
    records, altitudeSettlingWindow: { startDeltaM: -80, settleSeconds: 600 },
  }, { total_activities: 0 });
  assert.match(prompt, /Elevation Gain: 64 m \(settled part: \d+\/\d+ m; see ALT_SETTLING\)/);
  assert.match(prompt, /Elevation Loss: 163 m \(same notes\)/);
  const clean = generateAnalysisPrompt({ sessions: [{ sport: 'cycling', total_ascent_m: 64, total_descent_m: 163 }], records }, { total_activities: 0 });
  assert.doesNotMatch(clean, /settled part/);
});

test('observed max HR is a 15-second peak with a persisted source and a prompt provenance line', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const { applyHeartRateProfileUpsert, readHeartRateProfiles } = require('../heart-rate-profiles');
    const source = { activityId: 123, date: '2026-08-14', windowS: 15, bpm: 171 };
    applyHeartRateProfileUpsert(db, { effectiveDate: '2026-08-14', maxHeartRate: 171, thresholds: [null, null, null, null], lthr: null, observedMaxSource: source }, 'x');
    const stored = JSON.parse(readHeartRateProfiles(db)[0].observed_max_source_json);
    assert.deepEqual(stored, source);
  } finally {
    db.close();
  }
  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [] }, { total_activities: 0 },
    { maxHeartRate: 171, effectiveDate: '2026-08-14', observedMaxSource: { bpm: 171, date: '2026-08-14', windowS: 15 }, formulaMaxHeartRate: 172 }, null, [], [], 'en');
  assert.match(prompt, /Max HR Source: observed 15 s window 171 bpm on 2026-08-14 \/ formula 172/);
  const plain = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [] }, { total_activities: 0 },
    { maxHeartRate: 172, effectiveDate: '2026-08-14', formulaMaxHeartRate: 172 }, null, [], [], 'en');
  assert.match(plain, /Max HR Source: formula 172/);
});

test('activity page shows the session-class chip with evidence and quality-flag chips', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const base = { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [], source: 'fit' };
  const render = (sessionClass, qualityFlags) => renderActivityContentHtml({}, {}, { ...base, sessionClass }, null, 'n', false, null, {}, null, [], null,
    UI_STRINGS, GLOSSARY, false, 'en', [], null, [], null, false, 'osm', null, qualityFlags);
  const html = render({ label: 'threshold', confidence: 'high', reasons: ['Z4 28 %'], alternatives: ['tempo'] },
    [{ code: 'HR_DROPOUT', severity: 'warn', text: '110 s without heart rate' }, { code: 'HR_ABSENT', severity: 'info', text: 'no HR' }]);
  assert.match(html, /Session class: threshold</);
  assert.match(html, /title="class: threshold \(high\)\nevidence: Z4 28 %\nalternatives: tempo"/);
  assert.match(html, /chipWarn[^>]*title="HR_DROPOUT: 110 s without heart rate"/);
  assert.match(html, /chipInfo[^>]*title="HR_ABSENT: no HR"/);
  assert.doesNotMatch(render(null, []), /Session class: /);
  assert.doesNotMatch(render(null, []), /class="chip/);
});

test('inferred notes from the summary tail reach the prompt as revisable and pre-fill the form', () => {
  const { buildInferredNotesBlock, inferNotesPreFill } = require('../activity-notes');
  const summary = { purpose: ['commute'], conditions: ['headwind'] };
  assert.match(buildInferredNotesBlock(summary), /Session Notes \(AI-inferred from this ride's data, revisable\)/);
  assert.match(buildInferredNotesBlock(summary), /purpose: commute \(inferred/);
  assert.match(buildInferredNotesBlock(summary), /not user statements/);
  assert.equal(buildInferredNotesBlock({ purpose: [], conditions: [] }), '');
  assert.equal(buildInferredNotesBlock({ purpose: ['unknown'], conditions: ['none'] }), '');
  // User-declared fields suppress the matching inference, field by field.
  assert.doesNotMatch(buildInferredNotesBlock(summary, { purpose: 'race' }), /purpose: commute/);
  assert.match(buildInferredNotesBlock(summary, { purpose: 'race' }), /conditions: headwind/);
  assert.equal(buildInferredNotesBlock(summary, { purpose: 'race', conditions: ['headwind'] }), '');
  assert.deepEqual(inferNotesPreFill(summary), { purpose: 'commute', conditions: ['headwind'] });
  assert.equal(inferNotesPreFill({ purpose: [], conditions: [] }), null);

  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], inferredNotes: summary }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(prompt, /AI-inferred from this ride's data, revisable/);
  const withUser = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], sessionNotes: { rpe: 7, purpose: 'race' }, inferredNotes: summary }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(withUser, /user-declared for this ride/);
  assert.doesNotMatch(withUser, /purpose: commute \(inferred/); // declared purpose suppresses the inference
  assert.match(withUser, /conditions: headwind \(inferred/); // undeclared condition is still suggested
  const fullOverride = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], sessionNotes: { purpose: 'race', conditions: ['headwind'] }, inferredNotes: summary }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.doesNotMatch(fullOverride, /AI-inferred from this ride's data/);

  const { parseAnalysisSummary, SUMMARY_TAIL_INSTRUCTION } = require('../analysis-summary');
  assert.match(SUMMARY_TAIL_INSTRUCTION, /purpose: <the purpose this ride's data best supports/);
  assert.match(SUMMARY_TAIL_INSTRUCTION, /conditions: <conditions this ride's data suggest/);
  assert.deepEqual(parseAnalysisSummary('A.\n---\nSUMMARY\ntype: tempo\npurpose: commute\nconditions: headwind').summary.purpose, ['commute']);

  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const base = { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] };
  const html = renderActivityContentHtml({}, {}, { ...base, inferredNotes: { purpose: 'commute', conditions: ['headwind'] } }, null, 'n', false, null, {}, null, [], null,
    UI_STRINGS, GLOSSARY, false, 'en', [], null, [], null, false, 'osm', null, []);
  assert.match(html, /<option value="commute" selected>/);
  assert.match(html, /value="headwind" style="width:auto;" checked>/);
  assert.match(html, /Fields marked below are the AI/);

  // Mixed case: user declared only conditions; the inferred purpose still pre-fills, while the
  // declared conditions win over the inferred ones.
  const mixed = renderActivityContentHtml({}, {}, { ...base, sessionNotes: { rpe: null, purpose: null, feeling: null, conditions: ['rain'], note: null }, inferredNotes: { purpose: 'commute', conditions: ['headwind'] } }, null, 'n', false, null, {}, null, [], null,
    UI_STRINGS, GLOSSARY, false, 'en', [], null, [], null, false, 'osm', null, []);
  assert.match(mixed, /<option value="commute" selected>/);
  assert.match(mixed, /value="rain" style="width:auto;" checked>/);
  assert.doesNotMatch(mixed, /value="headwind" style="width:auto;" checked>/);
});

test('analysis card shows the model signature and the format version', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const base = { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] };
  const html = renderActivityContentHtml({}, {}, { ...base }, null, 'n', false, null, {},
    { text: 'Analysis body', version: 27, modelId: 'gpt-6-luna', analyzedAt: '2026-10-04T09:00:00.000Z' },
    [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 27, [], null, false, 'osm', null, []);
  assert.match(html, /"modelId":"gpt-6-luna"/);
  assert.match(html, /"analyzedAt":"2026-10-04T09:00:00\.000Z"/);
  assert.match(html, /const analysisVersion = 27;/);
  assert.match(html, /analyzedBy/);
  assert.match(html, /formatMessage\(ui\.analyzedBy/);
  // No model recorded (pre-B5 rows) renders no signature.
  const bare = renderActivityContentHtml({}, {}, { ...base }, null, 'n', false, null, {},
    { text: 'Analysis body', version: 27 }, [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 27, [], null, false, 'osm', null, []);
  assert.match(bare, /let analysisMeta = null;/);
});

test('log retention compresses past-retention files and deletes only past 3x retention', async () => {
  const { stripPromptFromLogFile, pruneLlmLogs } = require('../llm-log');
  assert.deepEqual(stripPromptFromLogFile({ prompt: 'x', response: 'y', modelId: 'm' }), { response: 'y', modelId: 'm' });
  assert.equal(stripPromptFromLogFile({ response: 'y' }), null); // already stripped

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitviz-llm-log-'));
  const day = 24 * 60 * 60 * 1000;
  const write = (name, mtimeMs, obj) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  };
  // Fresh file stays untouched.
  write('fresh.json', Date.now(), { prompt: 'p', response: 'r' });
  // Past retention but not past 3x: prompt is stripped, metrics survive.
  write('old.json', Date.now() - 10 * day, { prompt: 'p', response: 'r', modelId: 'm', analysisVersion: 27, promptBlocks: [{ title: 'X', chars: 3 }] });
  // Past 3x retention: deleted outright.
  write('ancient.json', Date.now() - 40 * day, { prompt: 'p', response: 'r' });
  // A chat log keeps its own (longer) retention window.
  write('old-chat.json', Date.now() - 10 * day, { prompt: 'p', response: 'r' });

  await pruneLlmLogs(dir, 5, 180);

  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['fresh.json', 'old-chat.json', 'old.json']);
  const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'fresh.json'), 'utf8'));
  assert.equal(fresh.prompt, 'p');
  const old = JSON.parse(fs.readFileSync(path.join(dir, 'old.json'), 'utf8'));
  assert.equal(old.prompt, undefined);
  assert.equal(old.response, 'r');
  assert.equal(old.modelId, 'm');
  assert.equal(old.analysisVersion, 27);
  assert.deepEqual(old.promptBlocks, [{ title: 'X', chars: 3 }]);
  const chat = JSON.parse(fs.readFileSync(path.join(dir, 'old-chat.json'), 'utf8'));
  assert.equal(chat.prompt, 'p');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('manual activity writes session notes', async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm'),
  });
  const db = new SQL.Database();
  try {
    ensureDatabaseSchema(db);
    const activityId = createManualActivity(db, {
      startTime: '2026-09-01T12:00:00.000Z',
      sport: 'cycling',
      durationS: 3600,
      distanceKm: 20,
      avgHr: 140,
      maxHr: 165,
      elevGainM: 250,
    }, { rpe: 7, purpose: 'commute', feeling: 'tired', conditions: ['headwind'], note: 'into the wind' });

    const row = db.exec(`SELECT rpe, purpose, feeling, conditions_json, note FROM activity_notes WHERE activity_id = ${activityId}`)[0].values[0];
    assert.deepEqual(row, [7, 'commute', 'tired', JSON.stringify(['headwind']), 'into the wind']);

    // An all-empty notes object writes nothing.
    const secondId = createManualActivity(db, {
      startTime: '2026-09-02T12:00:00.000Z',
      sport: 'running',
      durationS: 1800,
      distanceKm: 5,
      avgHr: null,
      maxHr: null,
      elevGainM: null,
    }, { rpe: null, purpose: null, feeling: null, conditions: [], note: null });
    assert.equal(db.exec(`SELECT COUNT(*) FROM activity_notes WHERE activity_id = ${secondId}`)[0].values[0][0], 0);
  } finally {
    db.close();
  }
});

test('chat and comparison prompts carry principles, notes and route relation (C5)', () => {
  const chat = generateAnalysisChatPrompt(
    { sessions: [{ total_distance_km: 20 }], records: [], segments: [], sessionNotes: { rpe: 7, purpose: 'race' } },
    {}, {}, '', [], 'How hard was this?', 'en'
  );
  assert.match(chat, /Coaching Principles:/);
  assert.match(chat, /Hierarchy of evidence/);
  assert.match(chat, /Athlete's Session Notes \(user-declared for this ride\)/);
  assert.match(chat, /Do not end your answer with a SUMMARY tail/);

  // Same straight line: same route, so a checkpoint table is supplied.
  const sameA = straightGpsRecords(1200, 20, { startLat: 52.0, startLon: 21.0 });
  const sameB = straightGpsRecords(1200, 20, { startLat: 52.0, startLon: 21.0 });
  const same = generateComparisonPrompt(
    { sessions: [{ total_distance_km: 6.7 }], records: sameA, segments: [], sessionNotes: { rpe: 7 } },
    { sessions: [{ total_distance_km: 6.7 }], records: sameB, segments: [], sessionNotes: { rpe: 6 } },
    'en'
  );
  assert.match(same, /Coaching Principles:/);
  assert.match(same, /Route relation: same route, same direction/);
  assert.match(same, /Checkpoints \(This Workout \/ Compared Activity; paired by place, each ride's own marks\):/);
  assert.ok(same.includes('- km'), 'checkpoint rows appear');

  // Different start points: different route, so no checkpoint table and no route-relation line.
  const diffA = straightGpsRecords(600, 20, { startLat: 52.0, startLon: 21.0 });
  const diffB = straightGpsRecords(600, 20, { startLat: 53.0, startLon: 22.0 });
  const diff = generateComparisonPrompt(
    { sessions: [{ total_distance_km: 3.3 }], records: diffA, segments: [] },
    { sessions: [{ total_distance_km: 3.3 }], records: diffB, segments: [] },
    'en'
  );
  assert.match(diff, /not on the same route/);
  assert.doesNotMatch(diff, /Checkpoints \(This Workout \/ Compared Activity\)/);
  assert.doesNotMatch(diff, /Route relation: same route/);
});

test('long segments carry temperature and cadence, and climbs report a clean post-climb HR drop (E1, E2)', () => {
  // A 12-minute climb (endIndex 719) then a minute of level moving with a falling HR.
  const records = [];
  for (let i = 0; i < 780; i += 1) {
    records.push({
      elapsed_time: i,
      speed: 20,
      distance: (20 / 3600) * i,
      heart_rate: i < 720 ? 170 : 170 - Math.floor((i - 720) / 6),
      temperature: 24 + Math.floor(i / 360),
      cadence: 88,
      altitude: (i < 720 ? i : 720) * 0.02 / 1000,
    });
  }
  const segments = [
    { index: 0, type: 'climb', effortBasis: 'hr', startElapsed: 0, endElapsed: 720, durationS: 720, avgGrade: 6, avgHr: 170, elevGainM: 360, startIndex: 0, endIndex: 719, hrCoveragePct: 100, distanceKm: 4, avgSpeedKmh: 20, avgCadence: 88, tempStart: 24, tempEnd: 25 },
  ];
  const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records, segments }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(prompt, /post-climb HR drop 60 s: −\d+ bpm \(descriptive\)/);
  assert.match(prompt, /cadence 88 rpm/);
  assert.match(prompt, /temp 24→25 °C/);

  // A climb followed by a stop (speed <= 5) yields no drop.
  const stopped = segments.map((segment) => ({ ...segment }));
  const stoppedRecords = records.map((r, i) => (i >= 720 ? { ...r, speed: 0 } : r));
  const stoppedPrompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: stoppedRecords, segments: stopped }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.doesNotMatch(stoppedPrompt, /post-climb HR drop/);
});

test('period block reports RPE against load when notes are present (E3)', () => {
  const activities = [
    { activityId: 1, startTime: '2026-08-01', sport: 'cycling', durationS: 3600, distanceKm: 20, trimp: 80, notes: { rpe: 6 } },
    { activityId: 2, startTime: '2026-08-05', sport: 'cycling', durationS: 3600, distanceKm: 21, trimp: 100, notes: { rpe: 8 } },
    { activityId: 3, startTime: '2026-08-10', sport: 'cycling', durationS: 3600, distanceKm: 22, trimp: 120, notes: { rpe: 9 } },
  ];
  const context = buildTrainingContext(activities, '2026-08-15', 'cycling');
  const { buildTrainingHistoryContext } = require('../analysis');
  const text = buildTrainingHistoryContext(context);
  assert.match(text, /RPE recorded for 3\/3 rides; median RPE 8 at median TRIMP 100; rides with RPE ≥ 8: 2 \(TRIMP 100, 120\)/);
});

test('activity list filters by route and persists the selected route (D3)', () => {
  const { renderActivityBrowserHtml } = loadActivityWebviewForTest();
  const activities = [
    { id: 1, file_name: 'a.fit', start_time: '2026-09-01T10:00:00Z', sport: 'cycling', total_distance_km: 20, total_timer_s: 3600, route_name: 'Loop' },
    { id: 2, file_name: 'b.fit', start_time: '2026-09-02T10:00:00Z', sport: 'cycling', total_distance_km: 21, total_timer_s: 3600, route_name: 'Loop' },
    { id: 3, file_name: 'c.fit', start_time: '2026-09-03T10:00:00Z', sport: 'cycling', total_distance_km: 22, total_timer_s: 3600, route_name: null },
  ];
  const webview = { asWebviewUri: (uri) => ({ toString: () => uri.toString() }), cspSource: 'test-csp' };
  const extensionUri = { fsPath: '/tmp' };
  const render = (routeFilter) => renderActivityBrowserHtml(
    webview, extensionUri, activities, 1, null, null, null, {}, {}, null, [], null, {}, null, 28, [], false, null, [], routeFilter
  );
  const html = render(null);
  assert.match(html, /id="routeSel"/);
  assert.match(html, /All routes/);
  assert.match(html, /<option value="Loop"/);
  // With a filter, only rides on that route remain in the activity selector.
  const filtered = render('Loop');
  assert.match(filtered, /<option value="1" data-route="Loop" selected>/);
  assert.match(filtered, /<option value="2" data-route="Loop"/);
  assert.doesNotMatch(filtered, /<option value="3"/); // the unrouted ride is filtered out
  assert.match(filtered, /setRouteFilter/);
});

test('the route section shows facts and the name/note form, not checkpoint tables or a climb chart', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const routeCard = { routeId: 1, name: 'Loop', note: '', rideCount: 6, relation: 'same', lengthKm: 33, ascentM: 110, descentM: 110, climbs: [{ fromKm: 28, toKm: 32, gainM: 90, avgGradePct: 4.5 }] };
  const html = renderActivityContentHtml({}, {}, { records: straightGpsRecords(4, 18), sessions: [], laps: [] }, null, 'n', false, null, {},
    null, [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 28, [], null, false, 'osm', routeCard, [], null);
  assert.match(html, /6 rides on this route/);
  assert.match(html, /id="[^"]*RouteForm"/);
  assert.doesNotMatch(html, /Checkpoints vs the median|Typical speed by section|Final climb time by ride/);
});

test('activity_features keeps a checkpoints column for the prompt comparisons', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(__dirname, '..', 'vendor', 'sql-wasm', 'sql-wasm.wasm') });
  const db = new SQL.Database();
  try {
    db.run('CREATE TABLE activity_features (activity_id INTEGER PRIMARY KEY, segments_json TEXT, checkpoints_json TEXT)');
    ensureDatabaseSchema(db);
    const cols = db.exec('PRAGMA table_info(activity_features)')[0].values.map((row) => row[1]);
    assert.equal(cols.includes('checkpoints_json'), true);
  } finally {
    db.close();
  }
});

test('sport profiles map FIT sports and format pace per profile (C6)', () => {
  const { normalizeSport, profileFor, describeSpeed, formatPace, sportPromptAdditions } = require('../sport-profiles');
  assert.equal(normalizeSport('cycling'), 'cycling');
  assert.equal(normalizeSport('mountain_biking'), 'cycling');
  assert.equal(normalizeSport('running'), 'running');
  assert.equal(normalizeSport('trail_running'), 'running');
  assert.equal(normalizeSport('hiking'), 'hiking');
  assert.equal(normalizeSport('hiking', 'trail'), 'hiking'); // a trail sub-sport does not turn a hike into a run
  assert.equal(normalizeSport('running', 'trail'), 'running');
  assert.equal(normalizeSport('mountaineering'), 'hiking');
  assert.equal(normalizeSport('walking'), 'walking');
  assert.equal(normalizeSport('swimming'), 'swimming');
  assert.equal(normalizeSport('open_water_swimming'), 'swimming');
  assert.equal(normalizeSport('yoga'), 'other');

  assert.equal(profileFor('cycling').usesPower, true);
  assert.equal(profileFor('running').usesPower, false);
  assert.equal(profileFor('swimming').speedUnit, 'minPer100m');

  // Pace conversions: 12 km/h = 5:00 /km; 3 km/h = 20:00 /km.
  assert.equal(formatPace(12, 'minPerKm'), '5:00 /km');
  assert.equal(formatPace(3, 'minPerKm'), '20:00 /km');
  // 4 km/h swim = 1:30 /100 m.
  assert.equal(formatPace(4, 'minPer100m'), '1:30 /100 m');
  assert.equal(describeSpeed(12, profileFor('running')), '5:00 /km');
  assert.equal(describeSpeed(12, profileFor('cycling')), '12.00 km/h');
  assert.equal(describeSpeed(0, profileFor('running')), null);

  assert.match(sportPromptAdditions('hiking'), /sustained ascent\/descent/);
  assert.equal(sportPromptAdditions('cycling'), null);
});

test('running workout fields use pace and spm, and drop power and elevation for swimming (C6)', () => {
  const { generateAnalysisPrompt } = require('../analysis');
  const run = generateAnalysisPrompt({ sessions: [{ sport: 'running', total_distance_km: 10, total_timer_s: 3000, avg_speed_kmh: 12, max_speed_kmh: 14, avg_cadence: 85 }], records: [], segments: [] }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(run, /Avg Pace: 5:00 \/km/);
  assert.match(run, /Max Pace: 4:17 \/km/);
  assert.match(run, /Avg Cadence: 85 spm/);
  assert.match(run, /This is a running activity: describe pace in min\/km/);
  assert.doesNotMatch(run, /Average Power/);

  const swim = generateAnalysisPrompt({ sessions: [{ sport: 'swimming', total_distance_km: 1, total_timer_s: 1800, avg_speed_kmh: 2 }], records: [], segments: [] }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(swim, /Avg Pace: 3:00 \/100 m/);
  assert.match(swim, /This is a swimming activity/);
  assert.doesNotMatch(swim, /Elevation Gain/);
  assert.doesNotMatch(swim, /Power source/);

  // Cycling keeps km/h and power; no sport cue.
  const cycle = generateAnalysisPrompt({ sessions: [{ sport: 'cycling', total_distance_km: 20, avg_speed_kmh: 30, avg_cadence: 90, power_source: 'measured', avg_power: 200 }], records: [], segments: [] }, { total_activities: 0 }, {}, null, [], [], 'en');
  assert.match(cycle, /Avg Speed: 30\.00 km\/h/);
  assert.match(cycle, /Avg Cadence: 90 rpm/);
  assert.match(cycle, /Average Power: 200 W/);
  assert.doesNotMatch(cycle, /This is a (running|swimming|hiking)/);
});

test('OFFSET_CHANGED reaches the analysis data flags and the prompt body once', async () => {
  const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, '..', 'vendor', 'sql-wasm', file) });
  const db = new SQL.Database();
  const internals = loadExtensionInternalsForTest();
  try {
    ensureDatabaseSchema(db);
    // Two neighbours at UTC+02:30, the current ride at UTC+02:00: the device timezone changed.
    db.run(`INSERT INTO activities (id, file_path, start_time, sport, total_timer_s, total_distance_km, utc_offset_s) VALUES
      (1, 'current.fit', '2026-07-19T10:00:00Z', 'cycling', 600, 10, 7200),
      (2, 'a.fit', '2026-07-18T10:00:00Z', 'cycling', 600, 10, 9000),
      (3, 'b.fit', '2026-07-17T10:00:00Z', 'cycling', 600, 10, 9000)`);
    const analysisData = { segments: [], qualityFlags: [{ code: 'HR_DROPOUT', severity: 'warn', text: '110 s without HR' }] };
    const context = internals.getTrainingContextFromDb(db, 1, analysisData);
    assert.deepEqual(context.qualityFlags.map((flag) => flag.code), ['HR_DROPOUT', 'OFFSET_CHANGED']);
    assert.deepEqual(analysisData.qualityFlags.map((flag) => flag.code), ['HR_DROPOUT', 'OFFSET_CHANGED'], 'the current ride carries the flag the prompt body prints');
    const prompt = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], ...analysisData }, { total_activities: 0, trainingContext: context }, {}, null, [], [], 'en');
    assert.match(prompt, /- OFFSET_CHANGED: device UTC offset \(UTC\+02:00\)/);
    assert.equal(prompt.split('**Data Quality Flags').length - 1, 1);
  } finally {
    db.close();
  }
});

test('prompt evaluator counts only real flag lines and accepts integrated wording (B1 check.js)', () => {
  const { checkAnalysisResponse } = require('../prompt-eval');
  const tail = '\n---\nSUMMARY\ntype: tempo\nfinding: f\nadvice_category: pacing\nadvice: a\nopen: none\nrevised: none';
  // The principle text mentions "Device temperature" in every prompt; without a TEMP flag line it must not count.
  const principleOnly = 'Device temperature, absent fields and partial coverage can change a conclusion.';
  assert.equal(checkAnalysisResponse({ response: `Ровная поездка.${tail}`, prompt: principleOnly }).flagsMissed, 0);
  // A real TEMP flag line unmentioned is a miss; mentioning the sun on the device counts.
  const tempPrompt = `${principleOnly}\n**Data Quality Flags:**\n- TEMP_DEVICE_HOT: device temperature peaks at 40 C`;
  assert.equal(checkAnalysisResponse({ response: `Ровная поездка.${tail}`, prompt: tempPrompt }).flagsMissed, 1);
  assert.equal(checkAnalysisResponse({ response: `Датчик грелся на солнце.${tail}`, prompt: tempPrompt }).flagsMissed, 0);
  // Integrated altitude wording ("early altitude unreliable") counts as using the ALT flag.
  const altPrompt = '**Altitude Quality:**\n- ALT_SETTLING: start 80 m below';
  assert.equal(checkAnalysisResponse({ response: `Ранний профиль высоты ненадёжен.${tail}`, prompt: altPrompt }).flagsMissed, 0);
  // HR flags are recognised and matched on strap/contact wording.
  const hrPrompt = '**Data Quality Flags:**\n- HR_CONTACT_LOSS: 5 sharp heart-rate jumps';
  assert.equal(checkAnalysisResponse({ response: `Скачки связаны с потерей контакта ремня.${tail}`, prompt: hrPrompt }).flagsMissed, 0);
  assert.equal(checkAnalysisResponse({ response: `Хорошая поездка.${tail}`, prompt: hrPrompt }).flagsMissed, 1);
});

test('derived-feature rebuild is serialized with analyses and awaited by the other writers', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  // The rebuild is an item of the same serial queue as analyses/chat/comparisons.
  assert.match(source, /function rebuildDerivedFeatures\(options = \{\}\) \{\s*return enqueueLlmTask\(async \(\) => \{/);
  // Writers outside that queue wait for a running rebuild before touching the file.
  for (const site of ['async function indexFitUris', 'panel.webview.onDidReceiveMessage(async (msg) => {', 'async function tidyHeartRateProfiles', 'async function addAndBrowseManualActivity']) {
    const start = source.indexOf(site);
    assert.ok(start >= 0, site);
    const end = source.indexOf('\nasync function ', start + 1);
    assert.ok(source.slice(start, end > 0 ? end : undefined).includes('await awaitDerivedFeatureRebuild();'), `${site} waits for the rebuild`);
  }

  // Behaviour: a writer that awaits the pending rebuild runs only after it settles; with no
  // rebuild pending it runs at once; the serial queue keeps order.
  const internals = loadExtensionInternalsForTest();
  const order = [];
  let release;
  internals.setPendingRebuildForTest(new Promise((resolve) => { release = () => { order.push('rebuild'); resolve(); }; }));
  const writer = internals.awaitDerivedFeatureRebuild().then(() => order.push('writer'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  release();
  await writer;
  assert.deepEqual(order, ['rebuild', 'writer']);
  internals.setPendingRebuildForTest(null);
  await internals.awaitDerivedFeatureRebuild();

  const seen = [];
  const first = internals.enqueueLlmTask(() => new Promise((resolve) => setTimeout(() => { seen.push(1); resolve(); }, 10)));
  const second = internals.enqueueLlmTask(async () => { seen.push(2); });
  await Promise.all([first, second]);
  assert.deepEqual(seen, [1, 2]);
});

test('prompts carry the Voice block and the evaluator measures hedging, English terms and address', () => {
  const voice = /\*\*Voice:\*\*[\s\S]*second person[\s\S]*Never say "the user"/;
  const analysis = generateAnalysisPrompt({ sessions: [{ sport: 'cycling' }], records: [], segments: [] }, { total_activities: 0 }, {}, null, [], [], 'ru');
  assert.match(analysis, voice);
  assert.match(analysis, /Translate every term, including the zone and class names/);
  assert.match(analysis, /under your own short headings/);
  assert.match(generateAnalysisChatPrompt({ sessions: [{}], records: [], segments: [] }, {}, {}, '', [], 'why?', 'ru'), voice);
  assert.match(generateComparisonPrompt({ sessions: [{}], records: [], segments: [] }, { sessions: [{}], records: [], segments: [] }, 'ru'), voice);

  const { checkAnalysisResponse, aggregateChecks } = require('../prompt-eval');
  const tail = '\n---\nSUMMARY\ntype: tempo\nfinding: f\nadvice_category: pacing\nadvice: a\nopen: none\nrevised: none';
  const robotic = checkAnalysisResponse({ response: `Класс mixed подтверждается. Это описание, а не вывод о форме. Пик не доказывает изменения формы. Отметь время на 18 км.${tail}`, prompt: '' });
  assert.equal(robotic.englishTerms, 1);
  assert.equal(robotic.defensivePhrases, 3); // "это описание", "а не вывод", "не доказыва"
  assert.ok(robotic.hedgeSharePct >= 50);
  assert.equal(robotic.informalAddress, true);
  assert.equal(robotic.mixedAddress, false);
  const mixed = checkAnalysisResponse({ response: `Отметьте время, а потом проверь давление.${tail}`, prompt: '' });
  assert.equal(mixed.mixedAddress, true);
  const plain = checkAnalysisResponse({ response: `Смешанная поездка: половина времени в темповой зоне. Проверьте давление перед следующим выездом.${tail}`, prompt: '' });
  assert.equal(plain.englishTerms, 0);
  assert.equal(plain.defensivePhrases, 0);
  const aggregate = aggregateChecks([robotic, mixed, plain]);
  assert.equal(aggregate.mixedAddressCount, 1);
  assert.equal(aggregate.informalAddressCount, 1);
  assert.ok(aggregate.meanEnglishTerms > 0);
});

test('analysis card dropdown shows the model that answered and only prepares the next run (B5 UI)', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const base = { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] };
  const modelPicker = { models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'claude-fable-5.1', name: 'Claude Fable 5.1' }], defaultName: 'GPT-6 Luna' };
  const render = (analysis) => renderActivityContentHtml({}, {}, { ...base }, null, 'n', false, null, {}, analysis,
    [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 30, [], null, false, 'osm', null, [], modelPicker);

  // The model that produced the displayed analysis is preselected, and the default entry names the real default model.
  const used = render({ text: 'Body', version: 30, modelId: 'claude-fable-5.1', analyzedAt: '2026-10-04T09:00:00.000Z' });
  assert.match(used, /<option value="">Default \(GPT-6 Luna\)<\/option>/);
  assert.match(used, /<option value="claude-fable-5.1" selected>Claude Fable 5\.1<\/option>/);
  assert.doesNotMatch(used, /cheapest\/first/);
  // No recorded model (an older analysis) or one that is no longer offered: the default entry is selected.
  assert.match(render({ text: 'Body', version: 30 }), /<option value="" selected>Default \(GPT-6 Luna\)<\/option>/);
  assert.match(render({ text: 'Body', version: 30, modelId: 'retired-model' }), /<option value="" selected>/);

  // Changing the dropdown must not start an analysis: the only message that carries the model is the
  // Analyze button's, as a one-off choice.
  assert.doesNotMatch(used, /setAnalysisModel/);
  assert.doesNotMatch(used, /modelSel\??\.addEventListener\('change'/);
  assert.match(used, /type: 'analyzeActivity', id: window\.currentActivityId, force: hasAnalysis, modelId: modelSel \? modelSel\.value : ''/);
});

test('the page formatMessage really substitutes placeholders (it sits inside a template literal)', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const html = renderActivityContentHtml({}, {}, { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] }, null, 'n', false, null, {},
    { text: 'x', version: 30, modelId: 'm' }, [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 30, [], null, false, 'osm', null, [], null);
  // Take the function exactly as the browser receives it and run it.
  const source = /function formatMessage\(template\) \{[\s\S]*?\n      \}/.exec(html)?.[0];
  assert.ok(source, 'formatMessage is present in the page script');
  const formatMessage = new Function(`${source}; return formatMessage;`)();
  assert.equal(formatMessage('Analyzed by {0} · format {1} · {2}', 'GPT-6 Luna', 30, '04.10.2026'), 'Analyzed by GPT-6 Luna · format 30 · 04.10.2026');
  assert.equal(formatMessage('Error: {0}', 'boom'), 'Error: boom');
  assert.equal(formatMessage('{1}{0}{1}', 'a', 'b'), 'bab');
});

test('a one-off model from the page overrides the pinned model without changing the setting', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /async function runActivityAnalysis\(dbPath, activityId, force, modelOverride = null\)/);
  assert.match(source, /modelId: modelOverride \|\| getAnalysisModelId\(\),/);
  // The analyze handler passes the dropdown choice through and never writes the configuration.
  const handler = source.slice(source.indexOf("msg.type === 'analyzeActivity'"), source.indexOf("msg.type === 'analysisChatTurn'"));
  assert.match(handler, /generateActivityAnalysis\(dbPath, requestedActivityId, msg\.force, chosenModel\)/);
  assert.doesNotMatch(handler, /\.update\(/);
  // Batch re-analysis keeps using the default (no override).
  assert.match(source, /await generateActivityAnalysis\(dbPath, target\.id, true\);/);
});

test('every script block of the generated activity page parses', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const html = renderActivityContentHtml({}, {}, { records: straightGpsRecords(30, 20), sessions: [{ sport: 'cycling' }], laps: [] }, null, 'n', false, null, {},
    { text: 'x', version: 30, modelId: 'm' }, [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 30, [], null, false, 'osm',
    { routeId: 1, name: 'Loop', note: '', rideCount: 3, relation: 'same' }, [], { models: [{ id: 'm', name: 'M' }], defaultName: 'M' });
  const blocks = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(blocks.length >= 1);
  // A syntax error inside the template literal is invisible to `node --check`; compile each block.
  for (const block of blocks) assert.doesNotThrow(() => new Function(block));
});

test('form controls use a dedicated input border and a shared focus style', () => {
  const { renderActivityBrowserHtml } = loadActivityWebviewForTest();
  const webview = { asWebviewUri: (uri) => ({ toString: () => uri.toString() }), cspSource: 'test-csp' };
  const extensionUri = { fsPath: '/tmp' };
  const activities = [{ id: 1, file_name: 'a.fit', start_time: '2026-09-01T10:00:00Z', sport: 'cycling', total_distance_km: 20, total_timer_s: 3600 }];
  const html = renderActivityBrowserHtml(webview, extensionUri, activities, 1, { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] }, null, null, {}, {}, { text: 'x', version: 30, modelId: 'm' }, [], null, {}, null, [], 30, [], false, null, [], null, null);
  assert.match(html, /--input-border: var\(--vscode-input-border/);
  // Text inputs, selects and textareas take the stronger border, not the faint --border.
  assert.match(html, /\.manualDataForm input \{ [^}]*var\(--input-border\)/);
  assert.match(html, /\.manualDataForm select \{ [^}]*var\(--input-border\)/);
  assert.match(html, /\.manualDataForm textarea \{ [^}]*var\(--input-border\)/);
  assert.match(html, /\.actSelector \{[\s\S]*?var\(--input-border\)/);
  assert.match(html, /input:not\(\[type=checkbox\]\):focus, input\[type=checkbox\]:focus, textarea:focus, select:focus/);
  assert.match(html, /input\[type=checkbox\] \{ accent-color: var\(--accent\); \}/);
});

test('the AI text renders markdown (headings, bold, lists) and still escapes HTML', () => {
  const { renderMarkdown } = require('../activity-webview');
  const body = '### 1) Характер\nЯ **подтверждаю класс темп**: 50% времени в зоне темпа.\n\n- отставание на 20 км: +1:13\n- HR 145 vs 150\n\n`peak20 = 144`';
  const html = renderMarkdown(body);
  assert.match(html, /<h3 style="[^"]*">1\) Характер<\/h3>/);
  assert.match(html, /<strong>подтверждаю класс темп<\/strong>/);
  assert.match(html, /<ul style="[^"]*"><li>отставание на 20 км: \+1:13<\/li><li>HR 145 vs 150<\/li><\/ul>/);
  assert.match(html, /<code>peak20 = 144<\/code>/);
  assert.match(html, /<p style="[^"]*">Я <strong>подтверждаю класс темп<\/strong>: 50% времени в зоне темпа\.<\/p>/);
  // Raw HTML in the model text must not be interpreted.
  const attack = renderMarkdown('<script>alert(1)</script> and **bold**');
  assert.doesNotMatch(attack, /<script>/);
  assert.match(attack, /&lt;script&gt;/);
});

test('the generated page script carries the same markdown renderer the server uses', () => {
  const { renderActivityContentHtml } = loadActivityWebviewForTest();
  const html = renderActivityContentHtml({}, {}, { records: [{ elapsed_time: 0, distance: 0 }, { elapsed_time: 60, distance: 0.5 }], sessions: [{}], laps: [] }, null, 'n', false, null, {},
    { text: '### Title\n**bold**', version: 30, modelId: 'm' }, [], null, UI_STRINGS, GLOSSARY, false, 'en', [], 30, [], null, false, 'osm', null, [], null);
  assert.match(html, /const renderMarkdown = \(text\) => \{/);
  // The page uses it for the analysis text and chat, not the old escaped pre-wrap.
  assert.match(html, /renderMarkdown\(text\)/);
  assert.match(html, /renderMarkdown\(entry\.content \|\| ''\)/);
});
