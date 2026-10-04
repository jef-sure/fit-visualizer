'use strict';

// Splits a stretch of moving records into pieces of similar effort. The change points of heart rate
// and estimated or measured power are found by optimal partitioning (dynamic programming) of a
// piecewise-constant model on 5 s bins. Both channels are measured in absolute steps (default
// 5 bpm and 30 W), so a boundary needs a difference the athlete could feel, not just one that is
// large against the spread of this particular ride. Chosen on 39 rides in scripts/segmentation-lab.

const BIN_SECONDS = 5;
const HR_LAG_BINS = 2; // heart rate trails the effort that causes it by about 20 s
const HR_WINDOW_BINS = 5;
const POWER_WINDOW_BINS = 5;

const DEFAULTS = {
  hrStepBpm: 5,
  powerStepWatts: 30,
  penalty: 9,
  minSeconds: 60,
};

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

// Mean of bins [from, to] ignoring holes; NaN when the window holds nothing.
function windowMean(values, from, to) {
  let sum = 0;
  let count = 0;
  for (let index = Math.max(0, from); index <= Math.min(values.length - 1, to); index += 1) {
    if (Number.isFinite(values[index])) {
      sum += values[index];
      count += 1;
    }
  }
  return count ? sum / count : Number.NaN;
}

// Holes take the nearest value so that the cost model never sees a gap.
function fillHoles(values) {
  const out = Float64Array.from(values);
  let last = Number.NaN;
  for (let index = 0; index < out.length; index += 1) {
    if (Number.isFinite(out[index])) last = out[index];
    else out[index] = last;
  }
  last = Number.NaN;
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(out[index])) last = out[index];
    else out[index] = last;
  }
  return out;
}

// Start index of every piece. Cost of a piece is its squared deviation from its own mean, in units
// of the channel step; `penalty` is the price of one more piece.
function partition(channels, penalty, minBins) {
  const n = channels[0].length;
  if (n < 2 * minBins) return [0];
  const sums = channels.map((values) => {
    const prefix = new Float64Array(n + 1);
    for (let index = 0; index < n; index += 1) prefix[index + 1] = prefix[index] + values[index];
    return prefix;
  });
  const squares = channels.map((values) => {
    const prefix = new Float64Array(n + 1);
    for (let index = 0; index < n; index += 1) prefix[index + 1] = prefix[index] + values[index] * values[index];
    return prefix;
  });
  const best = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);
  best[0] = -penalty;
  for (let end = minBins; end <= n; end += 1) {
    let bestCost = Infinity;
    let bestStart = 0;
    for (let start = 0; start <= end - minBins; start += 1) {
      if (start !== 0 && start < minBins) continue;
      if (!Number.isFinite(best[start])) continue;
      const length = end - start;
      let cost = 0;
      for (let k = 0; k < channels.length; k += 1) {
        const sum = sums[k][end] - sums[k][start];
        cost += (squares[k][end] - squares[k][start]) - (sum * sum) / length;
      }
      const total = best[start] + cost + penalty;
      if (total < bestCost) {
        bestCost = total;
        bestStart = start;
      }
    }
    best[end] = bestCost;
    from[end] = bestStart;
  }
  const starts = [];
  for (let end = n; end > 0; end = from[end]) starts.push(from[end]);
  return starts.reverse();
}

// Which channels a set of moving records can support: heart rate when it is recorded for most of
// the time, power when it exists for at least half of it (measured or estimated).
function usableChannels(records, isMoving) {
  let moving = 0;
  let withHr = 0;
  let withPower = 0;
  records.forEach((record, index) => {
    if (!isMoving(index)) return;
    moving += 1;
    if (finiteNumber(record?.heart_rate) > 0) withHr += 1;
    if (finiteNumber(record?.power) >= 0) withPower += 1;
  });
  if (!moving) return { hr: false, power: false };
  const hr = withHr / moving >= 0.7;
  return { hr, power: withPower / moving >= 0.5 || (!hr && withPower / moving >= 0.2) };
}

// Pieces of records[startIndex..endIndex] as [startIndex, endIndex] pairs (inclusive, contiguous).
function splitMovingRun(records, startIndex, endIndex, channelFlags, config = {}) {
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => Number.isFinite(v))) };
  const whole = [[startIndex, endIndex]];
  const minBins = Math.max(2, Math.round(settings.minSeconds / BIN_SECONDS));
  const t0 = finiteNumber(records[startIndex]?.elapsed_time);
  const t1 = finiteNumber(records[endIndex]?.elapsed_time);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return whole;
  const bins = Math.floor((t1 - t0) / BIN_SECONDS);
  if (bins < 2 * minBins) return whole;

  const accumulate = (read, accept) => {
    const sums = new Float64Array(bins);
    const counts = new Int32Array(bins);
    for (let index = startIndex; index <= endIndex; index += 1) {
      const elapsed = finiteNumber(records[index]?.elapsed_time);
      const value = read(records[index]);
      if (!Number.isFinite(elapsed) || !accept(value)) continue;
      const bin = Math.min(bins - 1, Math.max(0, Math.floor((elapsed - t0) / BIN_SECONDS)));
      sums[bin] += value;
      counts[bin] += 1;
    }
    return Float64Array.from(sums, (sum, bin) => (counts[bin] ? sum / counts[bin] : Number.NaN));
  };

  const channels = [];
  if (channelFlags.hr) {
    const raw = accumulate((record) => finiteNumber(record?.heart_rate), (value) => value > 0);
    const aligned = Float64Array.from(raw, (_, bin) =>
      windowMean(raw, bin + HR_LAG_BINS, bin + HR_LAG_BINS + HR_WINDOW_BINS - 1));
    channels.push(Float64Array.from(fillHoles(aligned), (value) => value / settings.hrStepBpm));
  }
  if (channelFlags.power) {
    const raw = accumulate((record) => finiteNumber(record?.power), (value) => value >= 0);
    const half = Math.floor(POWER_WINDOW_BINS / 2);
    const smoothed = Float64Array.from(raw, (_, bin) => windowMean(raw, bin - half, bin + half));
    channels.push(Float64Array.from(fillHoles(smoothed), (value) => value / settings.powerStepWatts));
  }
  if (!channels.length || channels.some((values) => !Number.isFinite(values[0]))) return whole;

  const starts = partition(channels, settings.penalty, minBins);
  if (starts.length < 2) return whole;

  // First record at or after every boundary; the last piece keeps the tail shorter than one bin.
  const firstIndexAt = (bin) => {
    const target = t0 + bin * BIN_SECONDS;
    let index = startIndex;
    while (index < endIndex && finiteNumber(records[index]?.elapsed_time) < target) index += 1;
    return index;
  };
  const boundaries = starts.map((bin, position) => (position === 0 ? startIndex : firstIndexAt(bin)));
  const pieces = [];
  boundaries.forEach((from, position) => {
    const to = position + 1 < boundaries.length ? boundaries[position + 1] - 1 : endIndex;
    if (to >= from) pieces.push([from, to]);
  });
  return pieces.length ? pieces : whole;
}

module.exports = { DEFAULTS, partition, splitMovingRun, usableChannels };
