#!/usr/bin/env node
// The open stretch of the loop (km 9-17): does a strategy separate "easy" (25-26 km/h) from "hard"
// (19-20 km/h) stretches, and how uniform is the effort inside its segments?
//   node scripts/segmentation-lab/open-stretch.js <fit-data.sqlite> [--from 9] [--to 17] [--density 10]

const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('../../vendor/sql-wasm/sql-wasm.js');
const U = require('../../utils');
const { buildSignals } = require('./signals');
const { STRATEGIES } = require('./strategies');

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : d; };
const FROM = arg('--from', 9); const TO = arg('--to', 17); const density = arg('--density', 10);
const dbPath = process.argv[2];
const namesArg = process.argv.indexOf('--names');
const NAMES = namesArg > 0 ? process.argv[namesArg + 1].split(',') : ['effort-hr', 'effort-pw', 'effort-both', 'regime-both', 'long-both'];

async function main() {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, '..', '..', 'vendor', 'sql-wasm', f) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const rows = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const profile = rows('SELECT rider_mass_kg, bike_mass_kg FROM athlete_profile WHERE id = 1')[0] || {};
  const same = rows("SELECT a.id, a.start_time, a.sport FROM activities a JOIN activity_routes r ON r.activity_id = a.id WHERE r.relation LIKE 'same%' AND a.source != 'manual' ORDER BY a.start_time");
  const prepared = [];
  for (const act of same) {
    const recs = rows('SELECT elapsed_s, speed_kmh, altitude_m, distance_km, heart_rate, power FROM records WHERE activity_id = ? ORDER BY record_index', [act.id]);
    if (recs.length < 600) continue;
    const records = U.normalizeRecordSpeeds(recs.map((r) => ({ elapsed_time: r.elapsed_s, speed: r.speed_kmh, altitude: r.altitude_m == null ? null : r.altitude_m / 1000, distance: r.distance_km, heart_rate: r.heart_rate, power: r.power })));
    const powered = U.addEstimatedPowerWhenMissing(records, { riderMassKg: profile.rider_mass_kg || 80, bikeMassKg: profile.bike_mass_kg || 10 });
    const total = powered.records[powered.records.length - 1].distance;
    if (total < 18 || total > 23) continue;
    prepared.push({ ride: { id: act.id, start: act.start_time, sport: act.sport, records: powered.records, powerSource: powered.source }, sig: null });
  }
  prepared.forEach((p) => { p.sig = buildSignals(p.ride.records); });
  console.log(`${prepared.length} loop rides; stretch km ${FROM}-${TO}\n`);

  const secOfKm = (ride, sig, km) => { const r = ride.records.find((x) => x.distance >= km); return r ? Math.round(r.elapsed_time - sig.t0) : null; };
  const bins = [['<=21', 0, 21], ['21-23', 21, 23], ['23-25', 23, 25], ['>=25', 25, 99]];
  const mean = (arr, a, b) => { let s = 0; let n = 0; for (let t = a; t < b; t += 1) if (Number.isFinite(arr[t])) { s += arr[t]; n += 1; } return n ? s / n : NaN; };

  console.log('strategy       segs/ride  med len  | HR sd within seg  ||  mean aligned HR by segment speed:  <=21     21-23    23-25    >=25   | HR gap (<=21 minus >=25)');
  const keep = {};
  for (const name of NAMES) {
    const strategy = STRATEGIES.find((s) => s.name === name);
    const inRegion = []; const lens = []; const hrSd = []; const perBin = bins.map(() => []);
    let nSeg = 0;
    for (const { ride, sig } of prepared) {
      const a = secOfKm(ride, sig, FROM); const b = secOfKm(ride, sig, TO);
      if (a == null || b == null) continue;
      const out = strategy.run(ride, sig, { density });
      const segs = out.segs.filter((s) => s.a < b && s.b > a).map((s) => ({ a: Math.max(a, s.a), b: Math.min(b, s.b) })).filter((s) => s.b - s.a >= 30);
      nSeg += segs.length;
      for (const s of segs) {
        const sp = mean(sig.spd, s.a, s.b); const hr = mean(sig.hrAligned, s.a, s.b);
        lens.push(s.b - s.a);
        let v = 0; let n = 0; for (let t = s.a; t < s.b; t += 1) if (Number.isFinite(sig.hrAligned[t])) { v += (sig.hrAligned[t] - hr) ** 2; n += 1; }
        if (n > 10) hrSd.push(Math.sqrt(v / n));
        const k = bins.findIndex(([, lo, hi]) => sp >= lo && sp < hi);
        if (k >= 0 && Number.isFinite(hr)) perBin[k].push(hr);
      }
      inRegion.push({ id: ride.id, segs, sig, ride });
    }
    keep[name] = inRegion;
    const m = (x) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : NaN);
    const med = (x) => { const s = [...x].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
    const cells = perBin.map((x) => (x.length ? `${m(x).toFixed(0)} (${x.length})` : '-').padStart(9));
    const gap = m(perBin[0]) - m(perBin[3]);
    console.log(`${name.padEnd(13)} ${(nSeg / inRegion.length).toFixed(1).padStart(9)} ${med(lens).toFixed(0).padStart(7)}s  | ${m(hrSd).toFixed(1).padStart(10)} bpm       ||                                   ${cells.join(' ')}   | ${Number.isFinite(gap) ? gap.toFixed(1) : '-'} bpm`);
  }

  // within-ride view: speed and heart-rate deviations from the ride's own mean over the stretch
  console.log('\nwithin each ride (deviation from the ride\'s own mean over the stretch), pooled over rides:');
  console.log('strategy       segs  slope bpm per +1 km/h   corr(speed,HR)   rides with slower=harder   spread of effort between segments (sd bpm)');
  const within = (units) => {
    const xs = []; const ys = []; let neg = 0; let n = 0; const sds = [];
    for (const u of units) {
      if (u.length < 2) continue;
      const mx = u.reduce((p, q) => p + q.sp, 0) / u.length; const my = u.reduce((p, q) => p + q.hr, 0) / u.length;
      let sxy = 0; let sxx = 0; let syy = 0;
      for (const q of u) { xs.push(q.sp - mx); ys.push(q.hr - my); sxy += (q.sp - mx) * (q.hr - my); sxx += (q.sp - mx) ** 2; syy += (q.hr - my) ** 2; }
      if (sxx > 0 && syy > 0) { n += 1; if (sxy < 0) neg += 1; }
      sds.push(Math.sqrt(syy / u.length));
    }
    const sxy = xs.reduce((p, q, i) => p + q * ys[i], 0); const sxx = xs.reduce((p, q) => p + q * q, 0); const syy = ys.reduce((p, q) => p + q * q, 0);
    return { slope: sxy / sxx, corr: sxy / Math.sqrt(sxx * syy), neg, n, sd: sds.reduce((p, q) => p + q, 0) / sds.length };
  };
  const rowOf = (name, units) => { const w = within(units); console.log(`${name.padEnd(13)} ${String(units.reduce((p, q) => p + q.length, 0)).padStart(5)}  ${w.slope.toFixed(2).padStart(10)}              ${w.corr.toFixed(2).padStart(6)}          ${String(w.neg).padStart(3)} of ${String(w.n).padEnd(3)}                  ${w.sd.toFixed(1)}`); };
  for (const name of NAMES) {
    const units = keep[name].map(({ segs, sig }) => segs.map((x) => ({ sp: mean(sig.spd, x.a, x.b), hr: mean(sig.hrAligned, x.a, x.b) })).filter((q) => Number.isFinite(q.sp) && Number.isFinite(q.hr)));
    rowOf(name, units);
  }
  const winUnits = prepared.map(({ ride, sig }) => { const u = []; for (let km = FROM; km < TO; km += 1) { const a = secOfKm(ride, sig, km); const b = secOfKm(ride, sig, km + 1); if (a == null || b == null) continue; u.push({ sp: mean(sig.spd, a, b), hr: mean(sig.hrAligned, a, b) }); } return u.filter((q) => Number.isFinite(q.sp) && Number.isFinite(q.hr)); });
  rowOf('1-km windows', winUnits);

  // fixed 1 km windows as a yardstick: same question without any segmentation
  const perBin = bins.map(() => []);
  for (const { ride, sig } of prepared) for (let km = FROM; km < TO; km += 1) {
    const a = secOfKm(ride, sig, km); const b = secOfKm(ride, sig, km + 1); if (a == null || b == null) continue;
    const sp = mean(sig.spd, a, b); const hr = mean(sig.hrAligned, a, b);
    const k = bins.findIndex(([, lo, hi]) => sp >= lo && sp < hi); if (k >= 0 && Number.isFinite(hr)) perBin[k].push(hr);
  }
  const m = (x) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : NaN);
  console.log(`${'1-km windows'.padEnd(13)} ${'-'.padStart(9)} ${'-'.padStart(8)}  | ${'-'.padStart(10)}           ||                                   ${perBin.map((x) => `${m(x).toFixed(0)} (${x.length})`.padStart(9)).join(' ')}   | ${(m(perBin[0]) - m(perBin[3])).toFixed(1)} bpm`);
  console.log('\n(count of segments in brackets). A good segmentation of "how it felt" gives a clear HR gap between slow and fast segments and a small HR spread inside each.');
  fs.writeFileSync('/tmp/open-stretch.json', JSON.stringify({ FROM, TO, rides: prepared.map((p) => p.ride.id) }));
}
main().catch((e) => { console.error(e); process.exit(1); });
