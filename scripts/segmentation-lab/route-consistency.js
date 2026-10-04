#!/usr/bin/env node
// Do the segment boundaries of a strategy land at the same places of a route in different rides?
// The loop is ridden 34 times in the same direction, so boundaries that follow the athlete's
// effort on the terrain must repeat by kilometre; noise and ride-specific drift must not.
//   node scripts/segmentation-lab/route-consistency.js <fit-data.sqlite> [--density 10]

const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('../../vendor/sql-wasm/sql-wasm.js');
const U = require('../../utils');
const { buildSignals } = require('./signals');
const { STRATEGIES } = require('./strategies');

const args = process.argv.slice(2);
const dbPath = args[0];
const density = Number(args[args.indexOf('--density') + 1]) || 10;
const CANDIDATES = ['effort-hr', 'effort-pw', 'effort-both', 'regime-both', 'long-both'];

async function main() {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, '..', '..', 'vendor', 'sql-wasm', f) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const rows = (sql, p = []) => { const st = db.prepare(sql); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const profile = rows('SELECT rider_mass_kg, bike_mass_kg FROM athlete_profile WHERE id = 1')[0] || {};
  const same = rows("SELECT a.id, a.start_time, a.sport FROM activities a JOIN activity_routes r ON r.activity_id = a.id WHERE r.relation LIKE 'same%' AND a.source != 'manual' ORDER BY a.start_time");
  const rides = [];
  for (const act of same) {
    const recs = rows('SELECT elapsed_s, speed_kmh, altitude_m, distance_km, heart_rate, power FROM records WHERE activity_id = ? ORDER BY record_index', [act.id]);
    if (recs.length < 600) continue;
    const records = U.normalizeRecordSpeeds(recs.map((r) => ({ elapsed_time: r.elapsed_s, speed: r.speed_kmh, altitude: r.altitude_m == null ? null : r.altitude_m / 1000, distance: r.distance_km, heart_rate: r.heart_rate, power: r.power })));
    const powered = U.addEstimatedPowerWhenMissing(records, { riderMassKg: profile.rider_mass_kg || 80, bikeMassKg: profile.bike_mass_kg || 10 });
    const total = powered.records[powered.records.length - 1].distance;
    if (total < 18 || total > 23) continue; // the full loop only
    rides.push({ id: act.id, start: act.start_time, sport: act.sport, records: powered.records, powerSource: powered.source, total });
  }
  console.log(`${rides.length} full-loop rides in the same direction\n`);

  const kmAt = (ride, sig, sec) => {
    const target = sig.t0 + sec;
    let lo = 0; let hi = ride.records.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ride.records[m].elapsed_time < target) lo = m + 1; else hi = m; }
    return ride.records[lo].distance;
  };
  const prepared = rides.map((ride) => ({ ride, sig: buildSignals(ride.records) }));

  // pairwise boundary agreement by kilometre, with a random-boundary baseline of the same counts
  const f1 = (x, y, tol) => {
    if (!x.length || !y.length) return 0;
    const used = new Set(); let hits = 0;
    for (const bx of x) { let b = -1; let bd = Infinity; y.forEach((by, j) => { const d = Math.abs(by - bx); if (d <= tol && d < bd && !used.has(j)) { bd = d; b = j; } }); if (b >= 0) { used.add(b); hits += 1; } }
    const p = hits / x.length; const r = hits / y.length; return p + r ? (2 * p * r) / (p + r) : 0;
  };
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const km = new Map();
  const per = new Map();
  for (const name of CANDIDATES) {
    const strategy = STRATEGIES.find((s) => s.name === name);
    const list = [];
    for (const { ride, sig } of prepared) {
      const out = strategy.run(ride, sig, { density });
      const bs = [];
      for (let i = 1; i < out.segs.length; i += 1) if (out.segs[i].a - out.segs[i - 1].b <= 2) bs.push(kmAt(ride, sig, out.segs[i].a));
      list.push({ id: ride.id, bs, segs: out.segs, total: ride.total, sig, ride });
    }
    per.set(name, list);
    for (const tol of [0.25, 0.5]) {
      let sum = 0; let base = 0; let n = 0;
      for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
        sum += f1(list[i].bs, list[j].bs, tol);
        const rb = (c, tot) => Array.from({ length: c }, () => rnd() * tot);
        base += f1(rb(list[i].bs.length, list[i].total), rb(list[j].bs.length, list[j].total), tol);
        n += 1;
      }
      km.set(`${name}@${tol}`, { agree: sum / n, base: base / n });
    }
  }
  console.log('boundary agreement between two rides of the same loop (F1 by kilometre; random boundaries of the same count for scale)');
  console.log('strategy       seg/h   ±250 m   random   lift     ±500 m   random   lift');
  for (const name of CANDIDATES) {
    const list = per.get(name);
    const sh = list.reduce((n, r) => n + r.segs.length, 0) / (list.reduce((n, r) => n + r.sig.movingSeconds, 0) / 3600);
    const a = km.get(`${name}@0.25`); const b = km.get(`${name}@0.5`);
    console.log(`${name.padEnd(13)} ${sh.toFixed(1).padStart(6)}   ${a.agree.toFixed(2)}     ${a.base.toFixed(2)}    x${(a.agree / a.base).toFixed(1)}      ${b.agree.toFixed(2)}     ${b.base.toFixed(2)}    x${(b.agree / b.base).toFixed(1)}`);
  }

  // how the loop looks per kilometre: speed, effort-aligned HR, grade and where boundaries pile up
  console.log('\nper kilometre of the loop (median over rides): speed, HR, grade; boundary share per strategy, % of rides with a boundary in that km');
  const header = ['km', 'speed', 'HR', 'grade'].concat(CANDIDATES.map((n) => n.slice(0, 9))).map((h, i) => (i ? h.padStart(9) : h.padEnd(4))).join('');
  console.log(header);
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  for (let k = 0; k < 20; k += 1) {
    const sp = []; const hr = []; const gr = [];
    for (const { ride, sig } of prepared) {
      const a = ride.records.findIndex((r) => r.distance >= k); const b = ride.records.findIndex((r) => r.distance >= k + 1);
      if (a < 0 || b < 0) continue;
      const s0 = Math.round(ride.records[a].elapsed_time - sig.t0); const s1 = Math.round(ride.records[b].elapsed_time - sig.t0);
      let ss = 0; let hh = 0; let n = 0; let hn = 0; let g = 0;
      for (let t = s0; t < s1; t += 1) { if (Number.isFinite(sig.spd[t])) { ss += sig.spd[t]; n += 1; g += sig.grade[t]; } if (Number.isFinite(sig.hrAligned[t])) { hh += sig.hrAligned[t]; hn += 1; } }
      if (n) { sp.push(ss / n); gr.push(g / n); } if (hn) hr.push(hh / hn);
    }
    const cells = CANDIDATES.map((name) => {
      const list = per.get(name);
      return (100 * list.filter((r) => r.bs.some((b) => b >= k && b < k + 1)).length / list.length).toFixed(0) + '%';
    });
    console.log([String(k).padEnd(4), med(sp).toFixed(1).padStart(9), med(hr).toFixed(0).padStart(9), med(gr).toFixed(1).padStart(9), ...cells.map((c) => c.padStart(9))].join(''));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
