#!/usr/bin/env node
// Segmentation lab: compares segmentation strategies on the rides of a FIT Visualizer database.
//
//   node scripts/segmentation-lab/lab.js <fit-data.sqlite> [--density 10] [--rides 124,197,275]
//        [--out ~/fit-eval/segmentation] [--lines production,effort-both]
//
// Not part of the extension (scripts/** is excluded from the package); it reads the database
// read-only and writes an HTML report next to a printed comparison table.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../../utils');
const { loadRides } = require('./load');
const { buildSignals } = require('./signals');
const { STRATEGIES: ALL_STRATEGIES } = require('./strategies');
const { aggregate, boundaries, boundaryF1, evaluate } = require('./metrics');
const { writeReport } = require('./report');

function parseArgs(argv) {
  const args = { density: 10, rides: [124, 197, 275, 158], out: path.join(os.homedir(), 'fit-eval', 'segmentation'), lines: ['production', 'effort-both'], only: null, names: null, fromKm: null, toKm: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--density') args.density = Number(argv[++i]);
    else if (a === '--rides') args.rides = argv[++i].split(',').map(Number);
    else if (a === '--out') args.out = argv[++i].replace(/^~/, os.homedir());
    else if (a === '--lines') args.lines = argv[++i].split(',');
    else if (a === '--only') args.only = Number(argv[++i]);
    else if (a === '--names') args.names = argv[++i].split(',');
    else if (a === '--from-km') args.fromKm = Number(argv[++i]);
    else if (a === '--to-km') args.toKm = Number(argv[++i]);
    else positional.push(a);
  }
  args.db = positional[0];
  return args;
}

// Seeded Gaussian noise for the stability probe.
function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
}

function noisy(ride, sigma, seed) {
  const gauss = rng(seed);
  return { ...ride, records: ride.records.map((r) => (r.heart_rate > 0 ? { ...r, heart_rate: r.heart_rate + sigma * gauss() } : r)) };
}

function trimmed(ride, seconds) {
  const cut = ride.records[0].elapsed_time + seconds;
  return { ...ride, records: ride.records.filter((r) => r.elapsed_time >= cut) };
}

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '  -  ');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db) { console.error('Usage: node scripts/segmentation-lab/lab.js <fit-data.sqlite> [--density 10] [--rides 124,197] [--out dir] [--only id]'); process.exit(2); }
  const STRATEGIES = args.names ? ALL_STRATEGIES.filter((s) => args.names.includes(s.name)) : ALL_STRATEGIES;
  const rides = await loadRides(args.db, args.only);
  console.log(`${rides.length} rides, target density ${args.density} segments per moving hour\n`);

  const prepared = rides.map((ride) => ({ ride, sig: buildSignals(ride.records) }));
  const results = new Map(STRATEGIES.map((s) => [s.name, []]));

  for (const { ride, sig } of prepared) {
    for (const strategy of STRATEGIES) {
      const t0 = Date.now();
      const out = strategy.run(ride, sig, { density: args.density });
      const ms = Date.now() - t0;
      const ev = evaluate(sig, out.segs);
      const base = boundaries(sig, out.segs);
      // Stability: heart-rate noise (sigma 2 bpm) and a 30 s later start, at the same penalty.
      const opts = { density: args.density, beta: out.beta };
      const rideN = noisy(ride, 2, ride.id);
      const sigN = buildSignals(rideN.records);
      const outN = strategy.run(rideN, sigN, opts);
      const rideT = trimmed(ride, 30);
      const sigT = buildSignals(rideT.records);
      const outT = strategy.run(rideT, sigT, opts);
      results.get(strategy.name).push({
        ride, sig, segs: out.segs, eval: ev, ms, channels: out.channels,
        stabHr: boundaryF1(base, boundaries(sigN, outN.segs)),
        stabTrim: boundaryF1(base, boundaries(sigT, outT.segs)),
      });
    }
    process.stdout.write('.');
  }
  console.log('\n');

  const rows = STRATEGIES.map((s) => ({ name: s.name, agg: aggregate(results.get(s.name)) }));
  const printed = [];
  const log = (text = '') => { printed.push(text); console.log(text); };
  const head = ['strategy', 'seg/h', 'med s', '<2min', 'R²hr', 'R²pw', 'Δhr', 'Δpw', 'wideSpd', 'rolling', 'stabHR', 'stabTrim', 'sec'];
  log(head.map((h, i) => (i ? h.padStart(8) : h.padEnd(13))).join(' '));
  for (const { name, agg } of rows) {
    log([name.padEnd(13), fmt(agg.segsPerHour, 1), fmt(agg.medianDurS, 0), fmt(100 * agg.short120, 0) + '%', fmt(agg.adjHr), fmt(agg.adjPw),
      fmt(agg.contrastHr, 1), fmt(agg.contrastPw, 0), fmt(100 * agg.wideSpeed, 0) + '%', fmt(100 * agg.rolling, 0) + '%',
      fmt(agg.stabHr), fmt(agg.stabTrim), fmt(agg.ms / 1000, 1)].map((v, i) => (i ? String(v).padStart(8) : v)).join(' '));
  }
  log('\nR²hr / R²pw: adjusted R² of "each segment is a constant" for the effort-aligned heart rate / estimated power (higher = more uniform effort per segment)');
  log('Δhr / Δpw: median jump of the mean between neighbouring segments (bpm / W): bigger = boundaries separate real differences');
  log('wideSpd: share of time in segments whose p5-p95 speed spread is >= 18 km/h; rolling: share in segments holding both a >=10 m rise and fall');
  log('stabHR / stabTrim: boundary agreement (F1, 15 s) after 2 bpm HR noise / after dropping the first 30 s');

  const file = writeReport(args, prepared, results, printed.join('\n'));
  console.log(`\nreport: ${file}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
