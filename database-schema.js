function ensureDatabaseSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS activities (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path                 TEXT NOT NULL UNIQUE,
      file_name                 TEXT,
      imported_at               TEXT,
      start_time                TEXT,
      sport                     TEXT,
      sub_sport                 TEXT,
      total_distance_km         REAL,
      total_ascent_m            REAL,
      total_descent_m           REAL,
      total_timer_s             REAL,
      total_elapsed_s           REAL,
      avg_hr                    REAL,
      max_hr                    REAL,
      manual_avg_hr             REAL,
      manual_max_hr             REAL,
      avg_speed_kmh             REAL,
      max_speed_kmh             REAL,
      avg_cadence               REAL,
      max_cadence               REAL,
      avg_power                 REAL,
      max_power                 REAL,
      normalized_power          REAL,
      training_stress_score     REAL,
      intensity_factor          REAL,
      xpower                    REAL,
      relative_intensity_gc     REAL,
      bike_stress_score         REAL,
      decoupling_pct            REAL,
      hr_tss                    REAL,
      trimp                     REAL,
      total_training_effect     REAL,
      aerobic_training_effect   REAL,
      anaerobic_training_effect REAL,
      total_calories            INTEGER,
      record_count              INTEGER,
      lap_count                 INTEGER,
      rider_mass_kg             REAL,
      bike_mass_kg              REAL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      activity_id             INTEGER NOT NULL REFERENCES activities(id),
      record_index            INTEGER NOT NULL,
      timestamp               TEXT,
      elapsed_s               REAL,
      distance_km             REAL,
      speed_kmh               REAL,
      heart_rate              REAL,
      altitude_m              REAL,
      latitude                REAL,
      longitude               REAL,
      cadence                 REAL,
      power                   INTEGER,
      temperature_c           REAL,
      grade_pct               REAL,
      vertical_oscillation_mm REAL,
      stance_time_ms          REAL,
      PRIMARY KEY (activity_id, record_index)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS activity_analysis (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id   INTEGER NOT NULL UNIQUE REFERENCES activities(id),
      analysis_text TEXT NOT NULL,
      analysis_version INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT,
      updated_at    TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS activity_analysis_chat (
      activity_id   INTEGER PRIMARY KEY REFERENCES activities(id),
      chat_json     TEXT NOT NULL,
      updated_at    TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS heart_rate_profiles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_date TEXT NOT NULL UNIQUE,
      max_hr        REAL NOT NULL,
      zone2_start   REAL,
      zone3_start   REAL,
      zone4_start   REAL,
      zone5_start   REAL,
      created_at    TEXT,
      updated_at    TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS athlete_profile (
      id          INTEGER PRIMARY KEY CHECK(id = 1),
      sex         TEXT,
      age         INTEGER,
      resting_hr  REAL,
      ftp         REAL,
      rider_mass_kg REAL,
      bike_mass_kg REAL,
      updated_at  TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wheel_calibration_samples (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id         INTEGER NOT NULL REFERENCES activities(id),
      computed_at         TEXT,
      ratio               REAL NOT NULL,
      trusted_distance_km REAL NOT NULL,
      UNIQUE(activity_id)
    );
  `);

  addColumnIfMissing(db, 'activities', 'manual_avg_hr', 'REAL');
  addColumnIfMissing(db, 'activities', 'manual_max_hr', 'REAL');
  addColumnIfMissing(db, 'activities', 'rider_mass_kg', 'REAL');
  addColumnIfMissing(db, 'activities', 'bike_mass_kg', 'REAL');
  addColumnIfMissing(db, 'activities', 'normalized_power', 'REAL');
  addColumnIfMissing(db, 'activities', 'training_stress_score', 'REAL');
  addColumnIfMissing(db, 'activities', 'intensity_factor', 'REAL');
  addColumnIfMissing(db, 'activities', 'xpower', 'REAL');
  addColumnIfMissing(db, 'activities', 'relative_intensity_gc', 'REAL');
  addColumnIfMissing(db, 'activities', 'bike_stress_score', 'REAL');
  addColumnIfMissing(db, 'activities', 'decoupling_pct', 'REAL');
  addColumnIfMissing(db, 'activities', 'hr_tss', 'REAL');
  addColumnIfMissing(db, 'activities', 'trimp', 'REAL');
  db.run(`
    UPDATE activities
    SET normalized_power = NULL,
        training_stress_score = NULL,
        intensity_factor = NULL,
        xpower = NULL,
        relative_intensity_gc = NULL,
        bike_stress_score = NULL,
        hr_tss = NULL
    WHERE normalized_power = 0
       OR training_stress_score = 0
       OR intensity_factor = 0
       OR xpower = 0
       OR relative_intensity_gc = 0
       OR bike_stress_score = 0
       OR hr_tss = 0;
  `);
  addColumnIfMissing(db, 'athlete_profile', 'ftp', 'REAL');
  addColumnIfMissing(db, 'athlete_profile', 'rider_mass_kg', 'REAL');
  addColumnIfMissing(db, 'athlete_profile', 'bike_mass_kg', 'REAL');
  addColumnIfMissing(db, 'athlete_profile', 'wheel_circumference_mm', 'REAL');
  addColumnIfMissing(db, 'activity_analysis', 'analysis_version', 'INTEGER NOT NULL DEFAULT 1');
}

function addColumnIfMissing(db, table, column, type) {
  const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values || [];
  if (!columns.some((row) => row[1] === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

module.exports = {
  ensureDatabaseSchema,
};
