const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('../vendor/sql-wasm/sql-wasm.js');
const { generateAnalysisPrompt, requestCopilotAnalysis, summarizePromptBlocks } = require('../analysis');
const { ensureDatabaseSchema } = require('../database-schema');
const {
  calculateAutoHeartRateProfile,
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
  calculateHistoricalMeanMaximalPower,
  calculateIntensityFactor,
  calculateIntervalsDecoupling,
  calculateMeanMaximalPower,
  calculateNormalizedPower,
  calculateTrainingStressScore,
  calculateXPower,
  computeGpsDerivedSpeed,
  computeGrade,
  deriveSpeedsFromDistance,
  detectStops,
  downsamplePoints,
  escapeHtml,
  estimateSpeedConfidence,
  formatHms,
  formatNumber,
  estimateFtpCandidates,
  estimatePowerFromMotion,
  haversineKm,
  normalizeRecordSpeeds,
  segmentByGrade,
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
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /type:\s*'selectActivity',\s*Number\.isFinite\(athleteProfile\.riderMassKg\)/s
  );
  assert.match(source, /type:\s*'selectActivity',\s*id:\s*document\.getElementById\('actSel'\)\.value/s);
  assert.match(source, /type:\s*'selectActivity'[\s\S]*?compId:/);
});

test('map card isolates leaflet stacking layers below the sticky toolbar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /\.chart\[data-target-type="map"\] \{[^}]*isolation:isolate/);
  assert.match(source, /\.toolbar \{[\s\S]*?z-index: 1100;/);
});

test('map zooms only with ctrl or cmd held', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /L\.map\('\$\{mapId\}', \{[^}]*scrollWheelZoom: false/);
  assert.match(source, /if \(!event\.ctrlKey && !event\.metaKey\)/);
  assert.match(source, /setZoomAround\(targetMap\.mouseEventToContainerPoint\(event\), next\)/);
});

test('stored analyses stay visible and reusable after a version bump', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.doesNotMatch(source, /getAnalysisFromDb/);
  // Strict version equality may only gate the "skip a new Copilot request" cache check.
  assert.match(source, /if \(!force\) \{\s*const existing = await getCachedAnalysisForCurrentVersion\(dbPath, numId\);/);
  assert.equal(source.match(/analysis_version = \?/g).length, 1);
  assert.match(source, /const analysis = selId \? await getLatestAnalysisAnyVersion\(dbPath, selId\) : null;/);
  assert.match(source, /const previousAnalysis = \(await getLatestAnalysisAnyVersion\(dbPath, numId\)\)\?\.text/);
  assert.match(source, /const baseAnalysis = \(await getLatestAnalysisAnyVersion\(dbPath, activityId\)\)\?\.text/);
  assert.match(source, /Analyzed with an older version/);
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
  assert.match(source, /return enqueueLlmTask\(\(\) => runActivityAnalysis\(dbPath, activityId, force\)\)/);
  assert.match(source, /async function appendActivityChatTurn[\s\S]*?return enqueueLlmTask\(async \(\) => \{/);
});

test('extracting computeGrade keeps estimatePowerFromMotion output identical', () => {
  // Snapshot captured from the pre-refactor implementation.
  const expected = [
    [1, 654.331735], [2, 579.278761], [5, 247.575428], [6, 0],
    [7, 0], [8, 0], [9, 0], [11, 0],
  ];
  const actual = estimatePowerFromMotion(gradeFixtureRecords(), { riderMassKg: 75, bikeMassKg: 10 })
    .map((entry) => [entry.elapsed_time, Number(entry.power.toFixed(6))]);

  assert.deepEqual(actual, expected);
});

test('computeGrade aligns with input records and reports slope as a fraction', () => {
  const records = gradeFixtureRecords();
  const grades = computeGrade(records);

  assert.equal(grades.length, records.length);
  assert.equal(grades[0], null);
  assert.equal(grades[1].elapsed_time, 1);
  assert.equal(grades[1].dt, 1);
  assert.ok(grades[1].grade > 0, 'climbing section has positive grade');
  assert.ok(grades[8].grade < 0, 'descending section has negative grade');
  assert.ok(Math.abs(grades[1].grade) < 1, 'grade is a fraction, not a percentage');
});

test('computeGrade skips records without a usable position or altitude', () => {
  const grades = computeGrade([
    { elapsed_time: 0, speed: 20, altitude: 0.1, distance: 0, position_lat: 52, position_long: 21 },
    { elapsed_time: 1, speed: 20, altitude: 0.101, distance: 0.005, position_lat: 0, position_long: 0 },
    { elapsed_time: 2, speed: 20, altitude: 0.102, distance: 0.01, position_lat: 52, position_long: 21 },
    { elapsed_time: 3, speed: 20, distance: 0.015, position_lat: 52, position_long: 21 },
  ]);

  assert.deepEqual(grades.map((entry) => entry === null), [true, true, false, true]);
  assert.equal(grades[2].dt, 2);
});

test('record insert stores grade only for meaningful movement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /const grades = computeGrade\(records\);/);
  assert.match(source, /grade\.dt > 0 && grade\.dt <= 5 && grade\.distanceM >= 1\s*\?\s*roundTo\(grade\.grade \* 100, 2\)/);
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
  const climb = { type: 'climb', avgGrade: 6, hasPower: true, hasHeartRate: true };
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

  const climb = segments.find((segment) => segment.type === 'climb');
  assert.equal(climb.effortBasis, 'vpower');
  assert.ok(climb.avgGrade > 5 && climb.avgGrade < 7);
  assert.ok(climb.elevGainM > 0);
  // Terrain boundaries shift by a sample or two because of the hysteresis.
  assert.ok(Math.abs(climb.avgPower - 240) <= 5, `expected ~240 W, got ${climb.avgPower}`);

  const flat = segments.find((segment) => segment.type === 'flat');
  assert.equal(flat.effortBasis, 'hr');
  assert.ok(Math.abs(flat.avgHr - 130) <= 3, `expected ~130 bpm, got ${flat.avgHr}`);
  // GPS never confirms a wheel sensor by default, so speed stays untrusted.
  assert.equal(flat.speedConfidence, 'low');

  assert.deepEqual(buildActivitySegments([], {}), []);
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
    'fitVisualizer.segmentation.effortWindowSeconds',
    'fitVisualizer.segmentation.effortCostThreshold',
    'fitVisualizer.segmentation.stopSpeedKmh',
    'fitVisualizer.segmentation.stopMinSeconds',
    'fitVisualizer.segmentation.gpsTrustMinKm',
  ]) {
    assert.ok(properties[key], `${key} must be configurable`);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /thresholds: getSegmentationOptions\(\)/);
});

test('heart-rate zones use semantic order and stable boundaries', () => {
  const records = [100, 110, 120, 140, 160, 180]
    .map((heart_rate, elapsed_time) => ({ heart_rate, elapsed_time }));
  const result = computeHeartRateZones(records, 190);

  assert.deepEqual(
    result.zones.map((zone) => zone.name),
    ['Recovery', 'Endurance', 'Aerobic', 'Anaerobic', 'Max']
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

test('shared formatting utilities preserve display behavior', () => {
  assert.equal(formatHms(3661), '01:01:01');
  assert.equal(formatNumber(12.3456), '12.35');
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
  assert.deepEqual(downsamplePoints([0, 1, 2, 3], 2), [0, 2]);
  assert.equal(Number.isNaN(asNumber(null)), true);
  assert.equal(Number.isNaN(asNumber('')), true);
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
  assert.equal(estimated.length, 2);
  assert.ok(estimated.every((record) => record.power <= 1200));
});

test('summary power fallback preserves measured power and estimates missing power', () => {
  const missingPower = [0, 1, 2].map((elapsed_time) => ({
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

test('Banister TRIMP and hrTSS are computed from HR reserve intensity', () => {
  const input = {
    durationSec: 3600,
    avgHeartRate: 150,
    restingHeartRate: 50,
    maxHeartRate: 190,
    sex: 'male',
  };

  const trimp = calculateBanisterTrimp(input);
  const hrTss = calculateHrTss(input);

  assert.ok(trimp > 0);
  assert.ok(hrTss > 0);
  assert.ok(hrTss < 100);
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
    assert.deepEqual(tables, ['activities', 'activity_analysis', 'activity_analysis_chat', 'athlete_profile', 'heart_rate_profiles', 'records', 'sqlite_sequence']);
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

test('Copilot analysis reports unavailable and empty models', async () => {
  const noModel = {
    lm: { selectChatModels: async () => [] },
    LanguageModelChatMessage: { User: (content) => content },
  };
  await assert.rejects(() => requestCopilotAnalysis(noModel, 'test'), /No Copilot language model/);

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
});

test('LLM request logging is configurable and wired into both call sites', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['fitVisualizer.logLlmRequests'].default, true);
  assert.ok(properties['fitVisualizer.llmLogRetentionDays']);

  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /kind: 'analysis', \.\.\.result/);
  assert.match(source, /kind: 'chat', \.\.\.result/);
  assert.match(source, /path\.join\(path\.dirname\(dbPath\), 'logs'\)/);
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

async function* asyncChunks(chunks) {
  yield* chunks;
}
