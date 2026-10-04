// Data-quality flags: measured facts about a recording, computed in code so the model uses them
// as explanations instead of hedging. Pure module: no DB, no vscode.
//
// Altitude flags (ALT_*) live in altitude-quality.js and are merged in by the caller.

const DQ = Object.freeze({
  hrDropoutSeconds: 60,        // total missing HR inside a recording that has HR elsewhere
  hrMinCoveragePct: 50,        // below this the whole recording counts as "no HR", not a dropout
  hrLateStartSeconds: 300,     // HR absent at the start for longer than this
  contactLossJumpBpm: 15,      // |ΔHR| per second with recovery within the window
  contactLossWindowS: 10,
  contactLossMinCount: 3,
  tempDeviceHotDelta: 6,       // max − avg above this means sun on the device
  tempHotMaxC: 35, tempMildAvgC: 30,
  tempMinSamples: 300,         // a short warm-up in the sun is not a device-on-the-dashboard pattern
  tempHotMaxDeltaC: 8,         // a large delta alone is enough regardless of the absolute maximum
  elapsedMismatchMinS: 300,    // device session elapsed beyond records (fraction below)
  elapsedMismatchFraction: 0.1,
  speedMismatchPct: 2,         // wheel-sensor vs GPS-derived speed from calibration
  smartRecordingStepS: 1.5,    // median record step above this means smart recording
  gpsGapSeconds: 60,           // missing coordinates while the ride has GPS
  maxPromptFlags: 6,
});

function coveragePct(records, predicate) {
  let covered = 0;
  let total = 0;
  for (let index = 1; index < records.length; index += 1) {
    const dt = Number(records[index]?.elapsed_time) - Number(records[index - 1]?.elapsed_time);
    if (!(dt > 0)) continue;
    total += dt;
    if (predicate(records[index])) covered += dt;
  }
  return total > 0 ? (100 * covered) / total : 0;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// All flags for one recording. records: [{ elapsed_time, heart_rate, temperature_c, position_lat,
// position_long }]; session carries device timing; wheelRatio comes from calibration when present.
function computeDataQualityFlags({ records, session = {}, wheelRatio, elapsedMismatch, offsetChangeNote }) {
  const list = Array.isArray(records) ? records : [];
  const flags = [];
  const push = (code, severity, text, params) => flags.push({ code, severity, text, params });

  const hasHr = (record) => Number.isFinite(Number(record?.heart_rate)) && Number(record.heart_rate) > 0;
  const hrCoverage = coveragePct(list, hasHr);

  // --- Heart rate ---
  if (hrCoverage <= 0) {
    if (list.some((record) => 'heart_rate' in record)) {
      push('HR_ABSENT', 'info', 'no usable heart-rate values in this recording; zones, TRIMP and peaks are unavailable');
    }
  } else if (hrCoverage < DQ.hrMinCoveragePct) {
    push('HR_DROPOUT', 'warn', `heart rate covers only ${Math.round(hrCoverage)}% of the recording; zone shares and load describe that part only`, { coveragePct: Math.round(hrCoverage) });
  } else {
    // Late start: HR absent at the beginning while present later.
    const firstHrIndex = list.findIndex(hasHr);
    const lateStartS = firstHrIndex > 0
      ? Number(list[firstHrIndex].elapsed_time) - Number(list[0].elapsed_time) : 0;
    if (lateStartS > DQ.hrLateStartSeconds) {
      push('HR_LATE_START', 'warn', `heart rate appears only after ${Math.round(lateStartS)} s; the start's intensity is unknown`, { seconds: Math.round(lateStartS) });
    } else {
      // Interior dropout: any stretch without HR that has HR before it and after it.
      let missingS = 0;
      let gapStart = null;
      for (let index = 0; index < list.length; index += 1) {
        if (hasHr(list[index])) {
          if (gapStart != null) {
            missingS += Number(list[index].elapsed_time) - gapStart;
            gapStart = null;
          }
        } else if (gapStart == null) {
          gapStart = Number(list[index].elapsed_time);
        }
      }
      const trailingWithoutHr = gapStart != null;
      if (!trailingWithoutHr && missingS > DQ.hrDropoutSeconds) {
        push('HR_DROPOUT', 'warn', `${Math.round(missingS)} s without heart rate inside the recording; covered time excludes it`, { seconds: Math.round(missingS) });
      }
    }
    // Contact loss: sharp jumps that recover quickly.
    const jumps = [];
    for (let index = 1; index < list.length; index += 1) {
      const a = Number(list[index - 1]?.heart_rate);
      const b = Number(list[index]?.heart_rate);
      const dt = Number(list[index]?.elapsed_time) - Number(list[index - 1]?.elapsed_time);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !(dt > 0)) continue;
      if (Math.abs(b - a) / dt > DQ.contactLossJumpBpm) {
        const window = list.slice(index, index + DQ.contactLossWindowS + 1)
          .filter((record) => Number.isFinite(Number(record.heart_rate))).map((record) => Number(record.heart_rate));
        const recovered = window.some((value) => Math.abs(value - a) <= 5);
        if (recovered) jumps.push({ elapsed: Number(list[index].elapsed_time), from: a, to: b });
      }
    }
    if (jumps.length >= DQ.contactLossMinCount) {
      push('HR_CONTACT_LOSS', 'warn', `${jumps.length} sharp heart-rate jumps with quick recovery (strap contact loss); affected samples overstate effort spikes`, { count: jumps.length });
    }
  }

  // --- Temperature ---
  // The DB record shape uses temperature_c; loaded-activity records use temperature.
  const temps = list.map((record) => Number(record?.temperature_c ?? record?.temperature)).filter((value) => Number.isFinite(value));
  if (temps.length > DQ.tempMinSamples / 10) {
    const avg = temps.reduce((sum, value) => sum + value, 0) / temps.length;
    const max = Math.max(...temps);
    if (max - avg > DQ.tempHotMaxDeltaC || (max - avg > DQ.tempDeviceHotDelta && (max > DQ.tempHotMaxC || avg > DQ.tempMildAvgC))) {
      push('TEMP_DEVICE_HOT', 'warn', `device temperature peaks at ${max.toFixed(1)} C against an average of ${avg.toFixed(1)} C; likely sun on the device, not air temperature`, { maxC: Math.round(max * 10) / 10, avgC: Math.round(avg * 10) / 10 });
    }
  }

  // --- Device timezone ---
  if (offsetChangeNote) {
    flags.push({ code: 'OFFSET_CHANGED', severity: 'warn', text: offsetChangeNote, params: {} });
  }

  // --- Session timing ---
  if (elapsedMismatch == null && Number.isFinite(Number(session.device_elapsed_s))) {
    const elapsedS = Number(session.total_elapsed_s);
    if (Number.isFinite(elapsedS) && elapsedS > 0) {
      const excess = Number(session.device_elapsed_s) - elapsedS;
      if (excess > Math.max(DQ.elapsedMismatchMinS, DQ.elapsedMismatchFraction * elapsedS)) {
        push('ELAPSED_MISMATCH', 'warn', `device session elapsed ${Math.round(Number(session.device_elapsed_s))} s far exceeds the ${Math.round(elapsedS)} s covered by records; the session was probably left running`, { deviceS: Math.round(Number(session.device_elapsed_s)), recordS: Math.round(elapsedS) });
      }
    }
  } else if (elapsedMismatch) {
    flags.push(elapsedMismatch);
  }

  // --- Speed source ---
  if (Number.isFinite(Number(wheelRatio)) && wheelRatio > 0 && Math.abs(wheelRatio - 1) * 100 > DQ.speedMismatchPct) {
    const pct = Math.round(Math.abs(wheelRatio - 1) * 1000) / 10;
    push('SPEED_SENSOR_GPS_MISMATCH', 'info', `wheel-sensor distance differs from GPS-derived distance by ~${pct}%; recorded speed and distance carry that scale error`, { ratio: Math.round(wheelRatio * 1000) / 1000 });
  }

  // --- Recording pattern ---
  const steps = [];
  for (let index = 1; index < list.length; index += 1) {
    const dt = Number(list[index]?.elapsed_time) - Number(list[index - 1]?.elapsed_time);
    if (dt > 0 && dt < 30) steps.push(dt);
  }
  const step = median(steps);
  if (step != null && step > DQ.smartRecordingStepS) {
    push('SMART_RECORDING', 'info', `records arrive about every ${step.toFixed(1)} s (smart recording); time-in-zone and peaks are interpolated between samples`, { stepS: Math.round(step * 10) / 10 });
  }

  // --- GPS ---
  // Number(null) is 0 and finite, so null coordinates must be excluded explicitly.
  const hasGps = (record) => record?.position_lat != null && record?.position_long != null
    && Number.isFinite(Number(record.position_lat)) && Number.isFinite(Number(record.position_long));
  if (list.some(hasGps)) {
    let gapS = 0;
    for (let index = 1; index < list.length; index += 1) {
      const dt = Number(list[index].elapsed_time) - Number(list[index - 1].elapsed_time);
      if (dt > 0 && !hasGps(list[index])) gapS += dt;
    }
    if (gapS > DQ.gpsGapSeconds) {
      push('GPS_GAP', 'info', `${Math.round(gapS)} s without GPS fix while the ride is tracked; the route trace has gaps there`, { seconds: Math.round(gapS) });
    }
  }

  return flags;
}

// One prompt block: warn flags only, capped, each one line.
function buildDataQualityFlagBlock(flags) {
  const warn = (Array.isArray(flags) ? flags : []).filter((flag) => flag?.severity === 'warn').slice(0, DQ.maxPromptFlags);
  if (!warn.length) return '';
  return `**Data Quality Flags (measured facts about this recording):**\n${warn.map((flag) => `- ${flag.code}: ${flag.text}`).join('\n')}\nUse each as the explanation where it changes a conclusion, once; do not restate it as a caveat elsewhere.`;
}

module.exports = {
  DQ,
  buildDataQualityFlagBlock,
  computeDataQualityFlags,
};
