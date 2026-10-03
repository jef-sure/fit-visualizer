// Deterministic session classification from computed evidence. Pure module: no DB, no vscode.
//
// Why: the model currently re-derives session type from zone percentages on every analysis,
// which is not reproducible across runs or models and cannot feed period summaries. The code
// produces a stable label with reasons; the prompt asks the model to confirm or dispute it
// with evidence instead of re-counting zones.

// Thresholds are collected here on purpose: calibration against real rides (see tests) should
// happen by editing this one object, not by scattering magic numbers through the rules.
const RULES = Object.freeze({
  minHrCoveragePct: 60,          // below this the label is undetermined
  recovery: { lowPct: 85, peak20Lthr: 0.85, maxMinutes: 90 },
  endurance: { lowPct: 70, highPct: 10, peak20Lthr: 0.95 },
  tempo: { moderatePct: 30, highPct: 20 },
  threshold: { z4Pct: 25, peak20Lthr: 0.95, sustainedZ4Minutes: 15 },
  vo2max: { z5Pct: 10, minEfforts: 3 },
  unstructured: { minMinutes: 20, stopShare: 0.25 },
  closeCallMarginPct: 5,         // passing a threshold within this margin lowers confidence
});

// zoneSeconds: five zone buckets [Z1..Z5] in seconds under the profile effective for the session.
// peak20VsLthr: sustained 20-minute peak HR as a fraction of the (estimated or tested) LTHR.
// hrCoveragePct: share of timer time with a usable HR sample.
function classifySession(input) {
  const zones = (Array.isArray(input?.zoneSeconds) ? input.zoneSeconds : []).map(Number);
  const total = zones.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const hrCoveragePct = Number(input?.hrCoveragePct);
  const timerS = Number(input?.timerS);
  const peak20VsLthr = Number(input?.peak20VsLthr);
  const sustainedZ4Seconds = Number(input?.sustainedZ4Seconds);
  const hardEfforts = Number(input?.hardEfforts);
  const stopSeconds = Number(input?.stopSeconds);
  const reasons = [];

  if (!Number.isFinite(hrCoveragePct) || hrCoveragePct < RULES.minHrCoveragePct || total <= 0) {
    return {
      label: 'undetermined',
      confidence: 'low',
      reasons: [Number.isFinite(hrCoveragePct)
        ? `HR coverage ${Math.round(hrCoveragePct)}% below ${RULES.minHrCoveragePct}%`
        : 'HR coverage unknown'],
      alternatives: [],
    };
  }

  const pct = zones.map((seconds) => 100 * seconds / total);
  const lowPct = pct[0] + pct[1];
  const moderatePct = pct[2];
  const z4Pct = pct[3];
  const z5Pct = pct[4];
  const highPct = z4Pct + z5Pct;
  const zoneText = `Z1-Z2 ${Math.round(lowPct)}%, Z3 ${Math.round(moderatePct)}%, Z4 ${Math.round(z4Pct)}%, Z5 ${Math.round(z5Pct)}%`;
  reasons.push(zoneText);
  if (Number.isFinite(peak20VsLthr) && peak20VsLthr > 0) {
    reasons.push(`peak20 ${Math.round(peak20VsLthr * 100)}% of LTHR estimate`);
  }

  const close = (value, threshold, direction) => direction === 'above'
    ? value >= threshold && value < threshold + RULES.closeCallMarginPct
    : value <= threshold && value > threshold - RULES.closeCallMarginPct;

  // Short chaotic sessions carry no trainable structure worth naming.
  if (Number.isFinite(timerS) && Number.isFinite(stopSeconds) && timerS > 0) {
    if (timerS < RULES.unstructured.minMinutes * 60 || stopSeconds / (timerS + stopSeconds) > RULES.unstructured.stopShare) {
      reasons.push(timerS < RULES.unstructured.minMinutes * 60
        ? `timer ${Math.round(timerS / 60)} min below ${RULES.unstructured.minMinutes}`
        : `stops ${Math.round(100 * stopSeconds / (timerS + stopSeconds))}% of elapsed`);
      return { label: 'unstructured', confidence: 'medium', reasons, alternatives: [] };
    }
  }

  if (lowPct >= RULES.recovery.lowPct
    && Number.isFinite(peak20VsLthr) && peak20VsLthr < RULES.recovery.peak20Lthr
    && Number.isFinite(timerS) && timerS <= RULES.recovery.maxMinutes * 60) {
    return {
      label: 'recovery',
      confidence: close(lowPct, RULES.recovery.lowPct, 'above') ? 'medium' : 'high',
      reasons,
      alternatives: ['endurance'],
    };
  }

  if (lowPct >= RULES.endurance.lowPct
    && highPct < RULES.endurance.highPct
    && !(Number.isFinite(peak20VsLthr) && peak20VsLthr >= RULES.endurance.peak20Lthr)) {
    return {
      label: 'endurance',
      confidence: close(lowPct, RULES.endurance.lowPct, 'above') ? 'medium' : 'high',
      reasons,
      alternatives: ['recovery'],
    };
  }

  if (Number.isFinite(peak20VsLthr) && peak20VsLthr >= RULES.threshold.peak20Lthr
    && Number.isFinite(sustainedZ4Seconds) && sustainedZ4Seconds >= RULES.threshold.sustainedZ4Minutes * 60) {
    return { label: 'threshold', confidence: 'high', reasons, alternatives: ['tempo'] };
  }
  if (z4Pct >= RULES.threshold.z4Pct) {
    return {
      label: 'threshold',
      confidence: close(z4Pct, RULES.threshold.z4Pct, 'above') ? 'medium' : 'high',
      reasons,
      alternatives: ['tempo', 'vo2max'],
    };
  }

  if (Number.isFinite(hardEfforts) && hardEfforts >= RULES.vo2max.minEfforts && z5Pct + z4Pct >= RULES.tempo.highPct) {
    return {
      label: 'vo2max/anaerobic',
      confidence: 'medium',
      reasons: [...reasons, `${hardEfforts} efforts at/above Z5 floor`],
      alternatives: ['threshold'],
    };
  }

  if (moderatePct >= RULES.tempo.moderatePct && highPct < RULES.tempo.highPct) {
    return {
      label: 'tempo',
      confidence: close(moderatePct, RULES.tempo.moderatePct, 'above') ? 'medium' : 'high',
      reasons,
      alternatives: ['endurance', 'threshold'],
    };
  }

  // Two near-equal stimuli or everything just under the thresholds.
  return {
    label: 'mixed',
    confidence: 'medium',
    reasons,
    alternatives: [moderatePct > z4Pct + z5Pct ? 'tempo' : 'threshold'],
  };
}

// Longest continuous run at or above the Zone 4 floor, in seconds, from time-ordered samples.
function longestSustainedZ4Seconds(samples) {
  let best = 0;
  let run = 0;
  for (const sample of Array.isArray(samples) ? samples : []) {
    const seconds = Number(sample?.seconds);
    if (Number.isFinite(seconds) && seconds > 0 && Number(sample?.atOrAboveZ4)) {
      run += seconds;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

// Count of distinct efforts of at least one minute at or above the Zone 5 floor.
function countHardEfforts(samples, { minEffortSeconds = 60 } = {}) {
  let count = 0;
  let run = 0;
  const flush = () => {
    if (run >= minEffortSeconds) count += 1;
    run = 0;
  };
  for (const sample of Array.isArray(samples) ? samples : []) {
    const seconds = Number(sample?.seconds);
    if (Number.isFinite(seconds) && seconds > 0 && Number(sample?.atOrAboveZ5)) {
      run += seconds;
    } else {
      flush();
    }
  }
  flush();
  return count;
}

module.exports = {
  RULES,
  classifySession,
  countHardEfforts,
  longestSustainedZ4Seconds,
};
