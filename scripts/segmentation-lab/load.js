// Loads the rides of a FIT Visualizer database the way the extension prepares them for analysis.
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('../../vendor/sql-wasm/sql-wasm.js');
const U = require('../../utils');

async function loadRides(dbPath, only) {
  const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, '..', '..', 'vendor', 'sql-wasm', file) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const rows = (sql, params = []) => {
    const st = db.prepare(sql);
    st.bind(params);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  };
  const profile = rows('SELECT rider_mass_kg, bike_mass_kg FROM athlete_profile WHERE id = 1')[0] || {};
  const acts = rows("SELECT id, start_time, sport FROM activities WHERE source != 'manual' ORDER BY start_time");
  const rides = [];
  for (const act of acts) {
    if (only && act.id !== only) continue;
    const recs = rows('SELECT elapsed_s, speed_kmh, altitude_m, distance_km, heart_rate, power, cadence, latitude, longitude FROM records WHERE activity_id = ? ORDER BY record_index', [act.id]);
    if (recs.length < 120) continue;
    const records = U.normalizeRecordSpeeds(recs.map((r) => ({
      elapsed_time: r.elapsed_s, speed: r.speed_kmh, altitude: r.altitude_m == null ? null : r.altitude_m / 1000,
      distance: r.distance_km, heart_rate: r.heart_rate, power: r.power, cadence: r.cadence,
      position_lat: r.latitude, position_long: r.longitude,
    })));
    const powered = U.addEstimatedPowerWhenMissing(records, { riderMassKg: profile.rider_mass_kg || 80, bikeMassKg: profile.bike_mass_kg || 10 });
    rides.push({ id: act.id, start: act.start_time, sport: act.sport, records: powered.records, powerSource: powered.source });
  }
  db.close();
  return rides;
}

module.exports = { loadRides };
