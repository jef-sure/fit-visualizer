// Consistency checks between the device-written session summary and the recorded series.
// The CYCPLUS M1 (and similar devices) can leave a session "open" for hours after a ride:
// total_elapsed_time then covers a whole day while records cover under an hour.

// Returns the elapsed time the analysis should use, plus diagnostics for the prompt.
function reconcileSessionElapsed({ sessionElapsedS, recordSpanS, gapSeconds = 0 }) {
  const session = Number(sessionElapsedS);
  const span = Number(recordSpanS);
  if (!Number.isFinite(session) || session <= 0) {
    return { elapsedS: Number.isFinite(span) && span > 0 ? span + gapSeconds : null, deviceElapsedS: null, mismatch: null };
  }
  if (!Number.isFinite(span) || span <= 0) {
    return { elapsedS: session, deviceElapsedS: session, mismatch: null };
  }
  const toleranceS = Math.max(300, 0.1 * span);
  const extra = session - span;
  if (extra > toleranceS) {
    return {
      elapsedS: span + gapSeconds,
      deviceElapsedS: session,
      mismatch: { deviceElapsedS: session, recordSpanS: span, extraS: Math.round(extra) },
    };
  }
  return { elapsedS: session, deviceElapsedS: session, mismatch: null };
}

module.exports = {
  reconcileSessionElapsed,
};
