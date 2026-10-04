// Uniform 1 Hz signals for the segmentation lab: one array per channel, seconds since the first
// record. Everything a strategy or a metric needs is derived once here so that all of them look at
// the same data.

const U = require('../../utils');

const HR_LAG_S = 20; // heart rate trails the effort that caused it by roughly this much

const num = (value) => {
  const x = Number(value);
  return Number.isFinite(x) ? x : NaN;
};

function fillShortGaps(arr, maxGap = 5) {
  let last = -1;
  for (let i = 0; i < arr.length; i += 1) {
    if (!Number.isFinite(arr[i])) continue;
    if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
      for (let k = last + 1; k < i; k += 1) arr[k] = arr[last] + ((arr[i] - arr[last]) * (k - last)) / (i - last);
    }
    last = i;
  }
  return arr;
}

// Centered rolling mean over `w` samples, ignoring NaN.
function rollMean(arr, w) {
  const n = arr.length;
  const sum = new Float64Array(n + 1);
  const cnt = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    const ok = Number.isFinite(arr[i]);
    sum[i + 1] = sum[i] + (ok ? arr[i] : 0);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
  }
  const half = Math.floor(w / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const c = cnt[b] - cnt[a];
    out[i] = c > 0 ? (sum[b] - sum[a]) / c : NaN;
  }
  return out;
}

function shift(arr, by) {
  const out = new Float64Array(arr.length).fill(NaN);
  for (let i = 0; i < arr.length; i += 1) {
    const j = i + by;
    if (j >= 0 && j < arr.length) out[i] = arr[j];
  }
  return out;
}

function buildSignals(records) {
  const t0 = num(records[0].elapsed_time);
  const T = Math.floor(num(records[records.length - 1].elapsed_time) - t0) + 1;
  const make = () => new Float64Array(T).fill(NaN);
  const spd = make(); const hr = make(); const alt = make(); const pw = make();
  for (const record of records) {
    const s = Math.round(num(record.elapsed_time) - t0);
    if (s < 0 || s >= T) continue;
    spd[s] = num(record.speed);
    const h = num(record.heart_rate);
    hr[s] = h > 0 ? h : NaN;
    alt[s] = Number.isFinite(num(record.altitude)) ? num(record.altitude) * 1000 : NaN;
    pw[s] = num(record.power);
  }
  [spd, hr, alt, pw].forEach((arr) => fillShortGaps(arr));

  // Stops and long recording gaps are not segmented; they are carved out of every strategy alike.
  const stopped = new Uint8Array(T);
  for (const stop of U.detectStops(records)) {
    const a = Math.max(0, Math.round(stop.startElapsed - t0));
    const b = Math.min(T - 1, Math.round(stop.endElapsed - t0));
    for (let s = a; s <= b; s += 1) stopped[s] = 1;
  }
  const moving = new Uint8Array(T);
  for (let s = 0; s < T; s += 1) moving[s] = !stopped[s] && Number.isFinite(spd[s]) ? 1 : 0;

  const altS = rollMean(alt, 5);
  const dist = new Float64Array(T);
  for (let s = 1; s < T; s += 1) dist[s] = dist[s - 1] + (Number.isFinite(spd[s]) ? spd[s] / 3.6 : 0);

  // Grade over +-20 s of smoothed altitude and travelled distance; distance-gated so that standing
  // still does not turn altitude noise into a slope.
  const grade = new Float64Array(T).fill(0);
  const W = 20;
  for (let s = 0; s < T; s += 1) {
    const a = Math.max(0, s - W); const b = Math.min(T - 1, s + W);
    const run = dist[b] - dist[a];
    if (run > 40 && Number.isFinite(altS[a]) && Number.isFinite(altS[b])) {
      grade[s] = Math.max(-12, Math.min(12, (100 * (altS[b] - altS[a])) / run));
    }
  }

  let movingSeconds = 0; let hrSeconds = 0;
  for (let s = 0; s < T; s += 1) {
    if (!moving[s]) continue;
    movingSeconds += 1;
    if (Number.isFinite(hr[s])) hrSeconds += 1;
  }
  return {
    T, t0, spd, hr, alt, altS, pw, dist, grade, stopped, moving,
    movingSeconds, hrCoverage: movingSeconds ? hrSeconds / movingSeconds : 0,
    hrAligned: shift(rollMean(hr, 20), HR_LAG_S), // effort-aligned response
    pwS: rollMean(pw, 20),
    // the coarse scale: terrain micro-oscillations of a minute or two average out
    hrLong: shift(rollMean(hr, 60), HR_LAG_S),
    pwLong: rollMean(pw, 60),
  };
}

module.exports = { HR_LAG_S, buildSignals, rollMean };
