const { randomUUID } = require('node:crypto');
const { saveActivityNotes } = require('./activity-notes');

/**
 * Create a manual activity (without FIT records) from user input.
 * @param {sql.Database} db
 * @param {Object} activity - { startTime, sport, durationS, distanceKm, avgHr, maxHr, elevGainM }
 * @param {Object} [notes] - optional session notes { rpe, purpose, feeling, conditions, note }
 * @returns {number} activityId
 */
function createManualActivity(db, activity, notes = null) {
  const {
    startTime,
    sport,
    durationS,
    distanceKm,
    avgHr,
    maxHr,
    elevGainM,
  } = activity;

  const manualFilePath = `manual://${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const avgSpeedKmh = (Number.isFinite(distanceKm) && Number.isFinite(durationS) && durationS > 0)
    ? distanceKm / (durationS / 3600)
    : null;

  const upsertValues = [
    manualFilePath,
    'Manual Activity',
    nowIso,
    startTime || null,
    sport || null,
    null,
    distanceKm || null,
    elevGainM || null,
    null,
    durationS || null,
    durationS || null,
    avgHr || null,
    maxHr || null,
    avgSpeedKmh,
    null,
    null, null,
    null, null, null,
    null, null, null, null, null, null, null, null,
    null, null, null,
    null,
    0,
    0,
    JSON.stringify([]),
    null,
    null,
    'manual',
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
    throw new Error('Failed to create manual activity');
  }
  const row = idStmt.getAsObject();
  idStmt.free();
  const activityId = Number(row.id);
  if (notes) {
    saveActivityNotes(db, activityId, notes);
  }
  return activityId;
}

module.exports = { createManualActivity };