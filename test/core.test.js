const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('../vendor/sql-wasm/sql-wasm.js');
const { generateAnalysisPrompt, requestCopilotAnalysis } = require('../analysis');
const { ensureDatabaseSchema } = require('../database-schema');
const {
  calculateAutoHeartRateProfile,
  computeHeartRateZones,
  getHeartRateZoneIndex,
} = require('../heart-rate');
const {
  addEstimatedPowerWhenMissing,
  asNumber,
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
  deriveSpeedsFromDistance,
  downsamplePoints,
  escapeHtml,
  formatHms,
  formatNumber,
  estimateFtpCandidates,
  estimatePowerFromMotion,
  normalizeRecordSpeeds,
  selectFtpEstimate,
} = require('../utils');

test('webview selector script keeps a valid selectActivity payload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /type:\s*'selectActivity',\s*Number\.isFinite\(athleteProfile\.riderMassKg\)/s
  );
  assert.match(source, /type:\s*'selectActivity',\s*id:\s*document\.getElementById\('actSel'\)\.value/s);
  assert.match(source, /type:\s*'selectActivity'[\s\S]*?compId:/);
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
