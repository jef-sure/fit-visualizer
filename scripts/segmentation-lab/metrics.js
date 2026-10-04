// Metrics for comparing segmentations of the same ride. All of them look at moving seconds only
// and at signals that every strategy shares (see signals.js), so no strategy grades itself on a
// private scale.

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

// Adjusted R^2 of "each segment is a constant" for one signal: how much of the ride's variation is
// explained by the segment means, corrected for the number of segments.
function adjustedR2(arr, segs) {
  const groups = [];
  let n = 0; let sum = 0;
  for (const seg of segs) {
    let c = 0; let s = 0;
    for (let t = seg.a; t < seg.b; t += 1) if (Number.isFinite(arr[t])) { c += 1; s += arr[t]; }
    if (c) { groups.push({ seg, c, mean: s / c }); n += c; sum += s; }
  }
  const k = groups.length;
  if (n <= k + 1 || k < 1) return NaN;
  const grand = sum / n;
  let sst = 0; let sse = 0;
  for (const g of groups) {
    for (let t = g.seg.a; t < g.seg.b; t += 1) {
      if (!Number.isFinite(arr[t])) continue;
      sst += (arr[t] - grand) ** 2;
      sse += (arr[t] - g.mean) ** 2;
    }
  }
  if (!(sst > 0)) return NaN;
  return 1 - (sse / (n - k)) / (sst / (n - 1));
}

// Total rise and fall, counted only for swings that reverse direction by at least `thr` metres
// (a zigzag filter: altitude noise must not add up to fake hills).
function riseFall(altS, a, b, thr = 4) {
  let rise = 0; let fall = 0;
  let pivot = NaN; let ext = NaN; let dir = 0;
  for (let t = a; t < b; t += 1) {
    const v = altS[t];
    if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(pivot)) { pivot = v; ext = v; continue; }
    if (dir === 0) {
      if (v - pivot >= thr) { dir = 1; ext = v; } else if (pivot - v >= thr) { dir = -1; ext = v; }
    } else if (dir === 1) {
      if (v > ext) ext = v;
      else if (ext - v >= thr) { rise += ext - pivot; pivot = ext; dir = -1; ext = v; }
    } else if (v < ext) ext = v;
    else if (v - ext >= thr) { fall += pivot - ext; pivot = ext; dir = 1; ext = v; }
  }
  if (dir === 1) rise += ext - pivot; else if (dir === -1) fall += pivot - ext;
  return { rise, fall };
}

function segmentStats(sig, seg) {
  const spd = []; let hr = 0; let hrN = 0; let pw = 0; let pwN = 0;
  for (let t = seg.a; t < seg.b; t += 1) {
    if (Number.isFinite(sig.spd[t])) spd.push(sig.spd[t]);
    if (Number.isFinite(sig.hrAligned[t])) { hr += sig.hrAligned[t]; hrN += 1; }
    if (Number.isFinite(sig.pwS[t])) { pw += sig.pwS[t]; pwN += 1; }
  }
  spd.sort((x, y) => x - y);
  const { rise, fall } = riseFall(sig.altS, seg.a, seg.b);
  return {
    dur: seg.b - seg.a,
    speedSpread: spd.length > 20 ? quantile(spd, 0.95) - quantile(spd, 0.05) : 0,
    meanSpeed: spd.length ? spd.reduce((x, y) => x + y, 0) / spd.length : NaN,
    hr: hrN ? hr / hrN : NaN,
    pw: pwN ? pw / pwN : NaN,
    rise, fall,
  };
}

function evaluate(sig, segs) {
  const stats = segs.map((seg) => segmentStats(sig, seg));
  const movingSec = stats.reduce((n, s) => n + s.dur, 0);
  const contrast = (key) => {
    const out = [];
    for (let i = 1; i < segs.length; i += 1) {
      if (segs[i].a - segs[i - 1].b > 2) continue; // a stop lies between them
      const d = Math.abs(stats[i][key] - stats[i - 1][key]);
      if (Number.isFinite(d)) out.push(d);
    }
    return out;
  };
  return {
    movingSec,
    k: segs.length,
    adjHr: sig.hrCoverage >= 0.7 ? adjustedR2(sig.hrAligned, segs) : NaN,
    adjPw: adjustedR2(sig.pwS, segs),
    contrastHr: sig.hrCoverage >= 0.7 ? contrast('hr') : [],
    contrastPw: contrast('pw'),
    wideSpeedSec: stats.reduce((n, s) => n + (s.speedSpread >= 18 ? s.dur : 0), 0),
    rollingSec: stats.reduce((n, s) => n + (Math.min(s.rise, s.fall) >= 10 ? s.dur : 0), 0),
    durations: stats.map((s) => s.dur),
    stats,
  };
}

function boundaries(sig, segs) {
  const out = [];
  for (let i = 1; i < segs.length; i += 1) if (segs[i].a - segs[i - 1].b <= 2) out.push(sig.t0 + segs[i - 1].b);
  return out;
}

// F1 of boundary agreement within a tolerance.
function boundaryF1(x, y, tol = 15) {
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const used = new Set();
  let hits = 0;
  for (const bx of x) {
    let best = -1; let bd = Infinity;
    y.forEach((by, j) => { const d = Math.abs(by - bx); if (d <= tol && d < bd && !used.has(j)) { bd = d; best = j; } });
    if (best >= 0) { used.add(best); hits += 1; }
  }
  const p = hits / x.length; const r = hits / y.length;
  return p + r ? (2 * p * r) / (p + r) : 0;
}

const median = (list) => { const s = [...list].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function aggregate(perRide) {
  const rides = perRide.filter((r) => r.eval);
  const sum = (f) => rides.reduce((n, r) => n + f(r), 0);
  const wmean = (f) => {
    const ok = rides.filter((r) => Number.isFinite(f(r)));
    const w = ok.reduce((n, r) => n + r.eval.movingSec, 0);
    return w ? ok.reduce((n, r) => n + f(r) * r.eval.movingSec, 0) / w : NaN;
  };
  const hours = sum((r) => r.eval.movingSec) / 3600;
  const allDur = rides.flatMap((r) => r.eval.durations);
  return {
    segsPerHour: sum((r) => r.eval.k) / hours,
    medianDurS: median(allDur),
    shortShare: allDur.filter((d) => d < 45).length / allDur.length,
    short120: allDur.filter((d) => d < 120).length / allDur.length,
    adjHr: wmean((r) => r.eval.adjHr),
    adjPw: wmean((r) => r.eval.adjPw),
    contrastHr: median(rides.flatMap((r) => r.eval.contrastHr)),
    contrastPw: median(rides.flatMap((r) => r.eval.contrastPw)),
    wideSpeed: sum((r) => r.eval.wideSpeedSec) / (hours * 3600),
    rolling: sum((r) => r.eval.rollingSec) / (hours * 3600),
    stabHr: rides.length ? rides.reduce((n, r) => n + (r.stabHr ?? 1), 0) / rides.length : NaN,
    stabTrim: rides.length ? rides.reduce((n, r) => n + (r.stabTrim ?? 1), 0) / rides.length : NaN,
    ms: sum((r) => r.ms),
  };
}

module.exports = { aggregate, boundaries, boundaryF1, evaluate, median, quantile };
