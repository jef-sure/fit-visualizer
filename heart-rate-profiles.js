// Pure heart-rate-profile storage helpers, kept free of the vscode import so tests can exercise them directly.

function readHeartRateProfiles(db) {
  const stmt = db.prepare('SELECT effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start, lthr, observed_max_source_json FROM heart_rate_profiles ORDER BY effective_date');
  try {
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function normalizeOptional(value) {
  const num = Number(value);
  return value != null && Number.isFinite(num) ? num : null;
}

// Saving the same values again must not fork history: the effective profile is reused instead of inserting a row,
// and a directly following duplicate is removed. A max-HR flip against a neighbouring profile is reported, not blocked.
function applyHeartRateProfileUpsert(db, { effectiveDate, maxHeartRate, thresholds, lthr = null, observedMaxSource = null }, now) {
  const sameValues = (row) => row
    && Number(row.max_hr) === maxHeartRate
    && normalizeOptional(row.lthr) === normalizeOptional(lthr)
    && [row.zone2_start, row.zone3_start, row.zone4_start, row.zone5_start]
      .every((value, index) => Number(value) === Number(thresholds[index]));

  const rows = readHeartRateProfiles(db);
  const exact = rows.find((row) => row.effective_date === effectiveDate);
  if (exact && sameValues(exact)) {
    db.run('UPDATE heart_rate_profiles SET updated_at = ? WHERE effective_date = ?', [now, effectiveDate]);
    return { inserted: false, notice: null };
  }

  const effective = [...rows].filter((row) => row.effective_date < effectiveDate).sort((a, b) => a.effective_date.localeCompare(b.effective_date)).at(-1);
  const following = rows.filter((row) => row.effective_date > effectiveDate).sort((a, b) => a.effective_date.localeCompare(b.effective_date))[0];
  if (effective && sameValues(effective)) {
    // Only when the new date simply extends the effective run is this a no-op; a different profile
    // after the new date means the athlete consciously re-entered the older values — keep the new row.
    const hasDifferentAfter = following && !sameValues(following);
    if (!hasDifferentAfter) {
      db.run('UPDATE heart_rate_profiles SET updated_at = ? WHERE effective_date = ?', [now, effective.effective_date]);
      const redundantLater = rows.find((row) => row.effective_date > effectiveDate && sameValues(row));
      if (redundantLater) {
        db.run('DELETE FROM heart_rate_profiles WHERE effective_date = ?', [redundantLater.effective_date]);
      }
      return { inserted: false, notice: null };
    }
  }
  db.run(`
    INSERT INTO heart_rate_profiles (
      effective_date, max_hr, zone2_start, zone3_start, zone4_start, zone5_start, lthr, observed_max_source_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(effective_date) DO UPDATE SET
      max_hr = excluded.max_hr,
      zone2_start = excluded.zone2_start,
      zone3_start = excluded.zone3_start,
      zone4_start = excluded.zone4_start,
      zone5_start = excluded.zone5_start,
      lthr = excluded.lthr,
      observed_max_source_json = excluded.observed_max_source_json,
      updated_at = excluded.updated_at
  `, [effectiveDate, maxHeartRate, ...thresholds, lthr ?? null, observedMaxSource ? JSON.stringify(observedMaxSource) : null, now, now]);
  if (following && sameValues(following)) {
    db.run('DELETE FROM heart_rate_profiles WHERE effective_date = ?', [following.effective_date]);
  }

  let notice = null;
  const neighbours = [effective, following].filter(Boolean);
  const prevMax = effective ? Number(effective.max_hr) : null;
  const nextMax = following ? Number(following.max_hr) : null;
  // A flip is a return to an earlier value with a different value in between (171 -> 173 -> 171).
  if (Number.isFinite(prevMax) && Number.isFinite(nextMax) && prevMax === maxHeartRate && nextMax !== maxHeartRate
    && Math.abs(nextMax - maxHeartRate) < 5) {
    notice = 'This maximum HR returns to a value used before and after this date. If it is not a new measurement, consider tidying the heart-rate profiles.';
  }
  return { inserted: true, notice };
}

// Collapses consecutive profiles with identical values (keeps the earliest) and reports flips between neighbours.
// Pure list logic so it is testable without sql.js; the command only applies it after a preview confirmation.
function planHeartRateProfileTidy(rows) {
  const sorted = [...rows].sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
  const values = (row) => [
    Number(row.max_hr), Number(row.zone2_start), Number(row.zone3_start), Number(row.zone4_start), Number(row.zone5_start),
  ].concat([normalizeOptional(row.lthr)]);
  const redundant = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1];
    const row = sorted[index];
    const prevValues = values(prev);
    const rowValues = values(row);
    // Threshold columns must be present; lthr may legitimately be null on both sides.
    const hasGaps = prevValues.slice(0, 5).some((value) => !Number.isFinite(value))
      || rowValues.slice(0, 5).some((value) => !Number.isFinite(value));
    if (!hasGaps && prevValues.every((value, i) => value === rowValues[i])) {
      redundant.push(row.effective_date);
    }
  }
  const flips = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const prevMax = Number(sorted[index - 1].max_hr);
    const rowMax = Number(sorted[index].max_hr);
    if (Number.isFinite(prevMax) && Number.isFinite(rowMax) && prevMax !== rowMax) {
      flips.push(`${sorted[index].effective_date}: max HR ${prevMax} -> ${rowMax}`);
    }
  }
  return { redundant, flips };
}

module.exports = {
  applyHeartRateProfileUpsert,
  planHeartRateProfileTidy,
  readHeartRateProfiles,
};
