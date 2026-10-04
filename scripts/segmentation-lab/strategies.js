// Segmentation strategies for the lab. Every strategy returns moving segments as seconds
// intervals { a, b, type } (b exclusive); stops are carved out beforehand and never segmented.
//
//   production   the shipped algorithm (grade threshold 2.5 %, then an HR split of long macros)
//   grade1.5     the same with a 1.5 % grade threshold
//   effort-hr    change-points of the effort-aligned heart rate
//   effort-pw    change-points of the estimated mechanical power (vpower)
//   effort-both  change-points of heart rate and vpower together
//   effort+grade the same plus the slope, so a hill that changes the regime starts a segment
//   hybrid       grade macros stay as hard boundaries; effort change-points split them further
//
// The change-point strategies use optimal partitioning (dynamic programming) of a piecewise-
// constant model on 5 s bins with a minimum segment of 60 s. The penalty is searched per ride so
// that every strategy produces the same number of segments per hour: differences are then about
// where the boundaries go, not about how many there are.

const U = require('../../utils');

const BIN_S = 5;
const MIN_BINS = 12; // 60 s

function movingRuns(sig, minSeconds = 20) {
  const runs = [];
  let start = -1;
  for (let s = 0; s <= sig.T; s += 1) {
    const on = s < sig.T && sig.moving[s];
    if (on && start < 0) start = s;
    if (!on && start >= 0) {
      if (s - start >= minSeconds) runs.push([start, s]);
      start = -1;
    }
  }
  return runs;
}

function binMean(arr, a, b) {
  const n = Math.floor((b - a) / BIN_S);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0; let c = 0;
    for (let s = a + i * BIN_S; s < a + (i + 1) * BIN_S; s += 1) if (Number.isFinite(arr[s])) { sum += arr[s]; c += 1; }
    out[i] = c ? sum / c : NaN;
  }
  // carry over holes so the cost model never sees NaN
  let last = NaN;
  for (let i = 0; i < n; i += 1) { if (Number.isFinite(out[i])) last = out[i]; else out[i] = last; }
  last = NaN;
  for (let i = n - 1; i >= 0; i -= 1) { if (Number.isFinite(out[i])) last = out[i]; else out[i] = last; }
  return out;
}

// Ride-level mean and spread of a channel over moving seconds, for standardizing.
function scaleOf(arr, sig) {
  let n = 0; let m = 0;
  for (let s = 0; s < sig.T; s += 1) if (sig.moving[s] && Number.isFinite(arr[s])) { n += 1; m += arr[s]; }
  if (!n) return { mean: 0, sd: 1 };
  m /= n;
  let v = 0;
  for (let s = 0; s < sig.T; s += 1) if (sig.moving[s] && Number.isFinite(arr[s])) v += (arr[s] - m) ** 2;
  return { mean: m, sd: Math.sqrt(v / n) || 1 };
}

// Optimal partitioning of d standardized channels (rows of `dims`) into pieces of at least
// `minBins` bins. cost 'sse': piecewise-constant mean (a boundary where the level changes);
// cost 'gauss': mean and variance (a boundary also where steady turns into surging).
// Returns the start index of every piece.
function partition(dims, beta, cfg = {}) {
  const minBins = cfg.minBins || MIN_BINS;
  const gauss = cfg.cost === 'gauss';
  const n = dims[0].length;
  if (n < 2 * minBins) return [0];
  const d = dims.length;
  const S1 = dims.map((x) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i += 1) p[i + 1] = p[i] + x[i]; return p; });
  const S2 = dims.map((x) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i += 1) p[i + 1] = p[i] + x[i] * x[i]; return p; });
  const F = new Float64Array(n + 1).fill(Infinity);
  const P = new Int32Array(n + 1);
  F[0] = -beta;
  for (let j = minBins; j <= n; j += 1) {
    let best = Infinity; let bi = 0;
    for (let i = 0; i <= j - minBins; i += 1) {
      if (i !== 0 && i < minBins) continue;
      if (!Number.isFinite(F[i])) continue;
      const len = j - i;
      let c = 0;
      for (let k = 0; k < d; k += 1) {
        const s1 = S1[k][j] - S1[k][i];
        const sse = (S2[k][j] - S2[k][i]) - (s1 * s1) / len;
        c += gauss ? 0.5 * len * Math.log(sse / len + 0.05) : sse;
      }
      const v = F[i] + c + beta;
      if (v < best) { best = v; bi = i; }
    }
    F[j] = best; P[j] = bi;
  }
  const starts = [];
  for (let j = n; j > 0; j = P[j]) starts.push(P[j]);
  return starts.reverse();
}

// A boundary must separate states the athlete could tell apart: neighbouring segments whose
// mean heart rate differs by less than `hr` bpm and mean power by less than `pw` W are merged
// (smallest difference first). Segments of different grade macros are never merged.
function applyGuard(segs, sig, tol = { hr: 4, pw: 15 }) {
  const mean = (arr, a, b) => { let sum = 0; let n = 0; for (let t = a; t < b; t += 1) if (Number.isFinite(arr[t])) { sum += arr[t]; n += 1; } return n ? sum / n : NaN; };
  const useHr = sig.hrCoverage >= 0.7;
  let list = segs.map((x) => ({ ...x, hr: useHr ? mean(sig.hrAligned, x.a, x.b) : NaN, pw: mean(sig.pwS, x.a, x.b) }));
  for (;;) {
    let bestI = -1; let bestEffect = 1;
    for (let i = 1; i < list.length; i += 1) {
      const p = list[i - 1]; const q = list[i];
      if (q.a - p.b > 2 || (p.macro != null && p.macro !== q.macro)) continue;
      const effect = Math.max(useHr ? Math.abs(q.hr - p.hr) / tol.hr : 0, Math.abs(q.pw - p.pw) / tol.pw);
      if (effect < bestEffect) { bestEffect = effect; bestI = i; }
    }
    if (bestI < 0) break;
    const p = list[bestI - 1]; const q = list[bestI];
    const merged = { a: p.a, b: q.b, macro: p.macro, hr: useHr ? mean(sig.hrAligned, p.a, q.b) : NaN, pw: mean(sig.pwS, p.a, q.b) };
    list = [...list.slice(0, bestI - 1), merged, ...list.slice(bestI + 1)];
  }
  return list.map((x) => ({ a: x.a, b: x.b, type: typeOf(sig, x.a, x.b), macro: x.macro }));
}

function typeOf(sig, a, b) {
  const run = sig.dist[b - 1] - sig.dist[a];
  const net = Number.isFinite(sig.altS[b - 1]) && Number.isFinite(sig.altS[a]) ? sig.altS[b - 1] - sig.altS[a] : 0;
  const grade = run > 50 ? (100 * net) / run : 0;
  return grade >= 2.5 ? 'climb' : grade <= -2.5 ? 'descent' : 'flat';
}

// A channel set for a ride: only channels that exist enough to be meaningful.
function channelsFor(kind, sig, cfg = {}) {
  const hrArr = cfg.long ? sig.hrLong : sig.hrAligned;
  const pwArr = cfg.long ? sig.pwLong : sig.pwS;
  const list = [];
  const hrOk = sig.hrCoverage >= 0.7;
  if ((kind === 'hr' || kind === 'both' || kind === 'both+grade') && hrOk) list.push(['hr', hrArr, 1]);
  if (kind === 'pw' || kind === 'both' || kind === 'both+grade' || !hrOk) list.push(['pw', pwArr, 1]);
  if (kind === 'both+grade') list.push(['grade', sig.grade, 0.7]);
  const seen = new Set();
  return list.filter(([name]) => (seen.has(name) ? false : seen.add(name)));
}

// Runs the partitioner over a set of ranges for one penalty; returns segments.
function segmentRanges(ranges, channels, sig, beta, cfg = {}) {
  const scales = channels.map(([name, arr]) => (cfg.absScale ? { mean: 0, sd: cfg.absScale[name] || 1 } : scaleOf(arr, sig)));
  const segs = [];
  for (const [ra, rb, macro] of ranges) {
    const dims = channels.map(([, arr, w], k) => {
      const m = binMean(arr, ra, rb);
      return Float64Array.from(m, (v) => ((v - scales[k].mean) / scales[k].sd) * w);
    });
    if (!dims.length || !dims[0].length) { segs.push({ a: ra, b: rb, type: typeOf(sig, ra, rb), macro }); continue; }
    const starts = partition(dims, beta, cfg);
    for (let i = 0; i < starts.length; i += 1) {
      const a = ra + starts[i] * BIN_S;
      const b = i + 1 < starts.length ? ra + starts[i + 1] * BIN_S : rb;
      if (b > a) segs.push({ a, b, type: typeOf(sig, a, b), macro });
    }
  }
  return segs;
}

function searchPenalty(ranges, channels, sig, perHour, cfg = {}) {
  const hours = ranges.reduce((n, [a, b]) => n + (b - a), 0) / 3600;
  const target = Math.max(ranges.length, Math.round(hours * perHour));
  let lo = Math.log(0.05); let hi = Math.log(20000);
  let best = null;
  for (let it = 0; it < 18; it += 1) {
    const beta = Math.exp((lo + hi) / 2);
    const segs = segmentRanges(ranges, channels, sig, beta, cfg);
    if (!best || Math.abs(segs.length - target) < Math.abs(best.segs.length - target)) best = { beta, segs };
    if (segs.length === target) break;
    if (segs.length > target) lo = Math.log(beta); else hi = Math.log(beta);
  }
  return best;
}

function effortStrategy(kind, cfg = {}) {
  return (ride, sig, opts) => {
    const ranges = movingRuns(sig).map(([a, b]) => [a, b, null]);
    const channels = channelsFor(kind, sig, cfg);
    const names = channels.map((c) => c[0]);
    const finish = (segs) => (cfg.guard ? applyGuard(segs, sig) : segs);
    // Fixed penalty (cfg.fixedBeta): the number of segments is a result, not a target.
    const fixed = cfg.fixedBeta != null ? cfg.fixedBeta : opts.beta;
    if (fixed != null) return { segs: finish(segmentRanges(ranges, channels, sig, fixed, cfg)), beta: fixed, channels: names };
    const found = searchPenalty(ranges, channels, sig, opts.density, cfg);
    return { beta: found.beta, segs: finish(found.segs), channels: names };
  };
}

function productionLike(thresholds) {
  return (ride, sig) => {
    const segments = U.buildActivitySegments(ride.records, {
      sport: ride.sport,
      powerSource: ride.powerSource,
      thresholds,
      athlete: { ftp: 117 },
    });
    const segs = segments.filter((s) => s.type !== 'stopped').map((s) => ({
      a: Math.max(0, Math.round(s.startElapsed - sig.t0)),
      b: Math.min(sig.T, Math.round(s.endElapsed - sig.t0)),
      type: s.type,
    })).filter((s) => s.b - s.a >= 5);
    return { segs, beta: null, channels: ['grade'] };
  };
}

function hybridStrategy(cfg = {}) {
  return (ride, sig, opts) => {
    // Production's grade macros (no effort split) as hard boundaries; effort splits inside them.
    const stops = U.detectStops(ride.records);
    const macros = U.segmentByGrade(ride.records, { stops }).filter((m) => m.type !== 'stopped');
    const ranges = macros.map((m, i) => [
      Math.max(0, Math.round(ride.records[m.startIndex].elapsed_time - sig.t0)),
      Math.min(sig.T, Math.round(ride.records[m.endIndex].elapsed_time - sig.t0)),
      i,
    ]).filter(([a, b]) => b - a >= 20);
    const channels = channelsFor('both', sig, cfg);
    const names = channels.map((c) => c[0]);
    const finish = (segs) => (cfg.guard ? applyGuard(segs, sig) : segs);
    if (opts.beta != null) return { segs: finish(segmentRanges(ranges, channels, sig, opts.beta, cfg)), beta: opts.beta, channels: names };
    const found = searchPenalty(ranges, channels, sig, opts.density, cfg);
    return { beta: found.beta, segs: finish(found.segs), channels: names };
  };
}

const STRATEGIES = [
  { name: 'shipped', run: productionLike({}), fixed: true },
  { name: 'grade1.5', run: productionLike({ gradeThresholdPct: 1.5 }), fixed: true },
  { name: 'effort-hr', run: effortStrategy('hr') },
  { name: 'effort-pw', run: effortStrategy('pw') },
  { name: 'effort-both', run: effortStrategy('both') },
  { name: 'effort+grade', run: effortStrategy('both+grade') },
  { name: 'hybrid', run: hybridStrategy() },
  { name: 'regime-both', run: effortStrategy('both', { cost: 'gauss', minBins: 24 }) },
  { name: 'long-both', run: effortStrategy('both', { long: true, minBins: 36 }) },
  { name: 'long+grade', run: effortStrategy('both+grade', { long: true, minBins: 36 }) },
  { name: 'hybrid-regime', run: hybridStrategy({ cost: 'gauss', minBins: 24 }) },
  { name: 'regime-guard', run: effortStrategy('both', { cost: 'gauss', minBins: 24, guard: true }) },
  { name: 'hybrid-guard', run: hybridStrategy({ cost: 'gauss', minBins: 24, guard: true }) },
  // Absolute units: 1 unit = 5 bpm / 30 W. A boundary needs a difference of about one unit that
  // lasts for at least the minimum length; the penalty is the price of such a step.
  { name: 'abs-hr', run: effortStrategy('hr', { absScale: { hr: 5 }, fixedBeta: 12, minBins: 24 }) },
  { name: 'abs-both', run: effortStrategy('both', { absScale: { hr: 5, pw: 30 }, fixedBeta: 12, minBins: 24 }) },
  { name: 'abs-hr-fine', run: effortStrategy('hr', { absScale: { hr: 5 }, fixedBeta: 6, minBins: 24 }) },
  { name: 'abs-hr-coarse', run: effortStrategy('hr', { absScale: { hr: 5 }, fixedBeta: 24, minBins: 24 }) },
  { name: 'abs-both-fine', run: effortStrategy('both', { absScale: { hr: 5, pw: 30 }, fixedBeta: 6, minBins: 24 }) },
  { name: 'abs-both-pw60', run: effortStrategy('both', { absScale: { hr: 5, pw: 60 }, fixedBeta: 6, minBins: 24 }) },
  { name: 'abs-pw-fine', run: effortStrategy('pw', { absScale: { pw: 30 }, fixedBeta: 6, minBins: 24 }) },
  { name: 'abs-hr-3bpm', run: effortStrategy('hr', { absScale: { hr: 3 }, fixedBeta: 12, minBins: 24 }) },
];

module.exports = { STRATEGIES, movingRuns };
