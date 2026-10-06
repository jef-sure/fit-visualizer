// The rider's plan and circumstances: dated notes in the rider's own words about what a period is
// for and what limits it ("one month on one route, every day", "weekdays only after work, an hour
// at most"). A note is in force from its date until its own end date when it has one - a plan
// for a month ends with the month - and otherwise until the next note. Pure helpers plus small
// DB accessors; no vscode.
//
// Why: statistics of a period mean nothing without the intent behind it. Thirty rides in thirty
// days read as overload - unless the rider set out to ride every day for a month.

const PLAN_NOTE_MAX_CHARS = 1000;
const PLAN_PROMPT_EARLIER_ENTRIES = 3;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(value) {
  const text = String(value ?? '').trim().slice(0, 10);
  if (!ISO_DATE.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? text : null;
}

// Accepts untrusted webview input. Returns { effectiveDate, note } with an empty note meaning
// "remove the entry of this date", or null when the date itself is unusable.
function normalizePlanEntry(input) {
  const effectiveDate = normalizeDate(input?.effectiveDate);
  if (!effectiveDate) return null;
  const note = String(input?.note ?? '').replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').trim().slice(0, PLAN_NOTE_MAX_CHARS);
  // The end date is optional; one that is given must be a real date not before the start.
  const rawEnd = String(input?.effectiveTo ?? '').trim();
  const effectiveTo = rawEnd ? normalizeDate(rawEnd) : null;
  if (rawEnd && (!effectiveTo || effectiveTo < effectiveDate)) return null;
  return { effectiveDate, effectiveTo, note };
}

// All entries, oldest first.
function readRiderPlan(db) {
  const stmt = db.prepare('SELECT effective_date, effective_to, note FROM rider_plan ORDER BY effective_date');
  const entries = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (row.note) entries.push({ effectiveDate: row.effective_date, effectiveTo: normalizeDate(row.effective_to), note: row.note });
    }
  } finally {
    stmt.free();
  }
  return entries;
}

// One entry per date; saving an empty note deletes the entry of that date.
function saveRiderPlanEntry(db, input) {
  const entry = normalizePlanEntry(input);
  if (!entry) throw new Error('Invalid dates for the plan note: the start must be a real date, and the end, when given, a real date not before it.');
  if (!entry.note) {
    db.run('DELETE FROM rider_plan WHERE effective_date = ?', [entry.effectiveDate]);
    return null;
  }
  db.run(`INSERT INTO rider_plan (effective_date, effective_to, note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(effective_date) DO UPDATE SET effective_to=excluded.effective_to, note=excluded.note, updated_at=excluded.updated_at`,
  [entry.effectiveDate, entry.effectiveTo, entry.note, new Date().toISOString()]);
  return entry;
}

// What was in force on a date and what came before it. Entries dated after the ride are left
// out: an analysis reads a ride as of its own day, not with a plan made later. The latest entry
// that has started is in force unless its own end date has passed; a plan that has ended is an
// earlier period, and the day of the ride then has no stated plan.
function planForDate(entries, isoDate) {
  const date = normalizeDate(isoDate);
  const known = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.note && normalizeDate(entry.effectiveDate))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const upTo = date ? known.filter((entry) => entry.effectiveDate <= date) : known;
  const latest = upTo[upTo.length - 1] ?? null;
  const ended = Boolean(latest && date && latest.effectiveTo && latest.effectiveTo < date);
  return ended || !latest
    ? { current: null, earlier: upTo }
    : { current: latest, earlier: upTo.slice(0, -1) };
}

// "from 2026-07-19 to 2026-08-19", or "from 2026-07-19" for a note with no end of its own.
function planSpan(entry) {
  return entry.effectiveTo ? `from ${entry.effectiveDate} to ${entry.effectiveTo}` : `from ${entry.effectiveDate}`;
}

function buildRiderPlanBlock(entries, isoDate) {
  const { current, earlier } = planForDate(entries, isoDate);
  if (!current && !earlier.length) return '';
  const shown = earlier.slice(-PLAN_PROMPT_EARLIER_ENTRIES);
  const earlierLines = shown.length
    ? `\nEarlier periods (each explains the history rows of its own dates; one with an end date is over):\n${shown.map((entry) => `- ${planSpan(entry)}: "${entry.note}"`).join('\n')}`
    : '';
  const head = current
    ? `In force for this ride, ${planSpan(current)}: "${current.note}"`
    : 'No plan is stated for the day of this ride: the last stated period had ended before it. What that period said about what comes after it still stands as the rider\'s stated intention.';
  return `**Rider's Plan and Circumstances (the rider's own words, dated):**\n${head}${earlierLines}\n`
    + 'These are stated facts about what a period is for and what limits it. Read frequency of riding, rest days, repetition of one route, ride length and time of day against the plan in force at that time: what the plan states is intent carried out, not a finding, not a flaw and not a risk to warn about. Do not advise against the plan. Where the data departs from the plan in force, say where and by how much.';
}

module.exports = {
  PLAN_NOTE_MAX_CHARS,
  buildRiderPlanBlock,
  normalizePlanEntry,
  planForDate,
  readRiderPlan,
  saveRiderPlanEntry,
};
