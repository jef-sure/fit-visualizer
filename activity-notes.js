// Session notes: the athlete's own record of how a ride felt and what it was for. Pure
// normalization and text helpers plus small DB accessors; no vscode.

const PURPOSES = Object.freeze(['commute', 'endurance', 'tempo', 'intervals', 'recovery', 'race', 'social', 'leisure', 'other']);
// A ride can have several goals at once (a race that is also an endurance day), and the rider's
// own words for a goal are as good as the listed ones.
const GOAL_MAX_COUNT = 5;
const GOAL_MAX_CHARS = 40;
const FEELINGS = Object.freeze(['fresh', 'normal', 'tired', 'ill']);
const CONDITIONS = Object.freeze(['headwind', 'tailwind', 'rain', 'heat', 'cold', 'group', 'traffic', 'night', 'new_route']);
const NOTE_MAX_CHARS = 1000;

const pick = (value, allowed) => {
  const text = String(value ?? '').trim().toLowerCase();
  return allowed.includes(text) ? text : null;
};

// Goals from a form (array), a comma-separated string, a stored JSON list or a single stored
// value. Listed goals are kept by their key; anything else is the rider's own wording.
function normalizeGoals(value) {
  let list = value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (text.startsWith('[')) {
      try { list = JSON.parse(text); } catch { list = [text]; }
    } else list = text.split(',');
  }
  const seen = new Set();
  const goals = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, GOAL_MAX_CHARS);
    if (!text) continue;
    const goal = PURPOSES.includes(text.toLowerCase()) ? text.toLowerCase() : text;
    const key = goal.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    goals.push(goal);
    if (goals.length >= GOAL_MAX_COUNT) break;
  }
  return goals;
}

// Accepts untrusted webview input; returns the canonical record or null when nothing is filled.
function normalizeNotes(input) {
  const rpeNumber = Number(input?.rpe);
  const rpe = input?.rpe !== '' && input?.rpe != null && Number.isInteger(rpeNumber) && rpeNumber >= 1 && rpeNumber <= 10 ? rpeNumber : null;
  const conditions = [...new Set((Array.isArray(input?.conditions) ? input.conditions : []).map((value) => pick(value, CONDITIONS)).filter(Boolean))];
  const note = String(input?.note ?? '').trim().slice(0, NOTE_MAX_CHARS);
  const goals = normalizeGoals(input?.goals ?? input?.purpose);
  // `purpose` is the first goal, kept for the places that show one word.
  const notes = { rpe, goals, purpose: goals[0] ?? null, feeling: pick(input?.feeling, FEELINGS), conditions, note: note || null };
  return rpe || goals.length || notes.feeling || conditions.length || notes.note ? notes : null;
}

function readActivityNotes(db, activityId) {
  const stmt = db.prepare('SELECT rpe, purpose, feeling, conditions_json, note FROM activity_notes WHERE activity_id = ?');
  try {
    stmt.bind([activityId]);
    if (!stmt.step()) return null;
    const row = stmt.getAsObject();
    let conditions = [];
    try {
      conditions = JSON.parse(row.conditions_json || '[]');
    } catch {
      conditions = [];
    }
    return normalizeNotes({ rpe: row.rpe, purpose: row.purpose, feeling: row.feeling, conditions, note: row.note });
  } finally {
    stmt.free();
  }
}

function readAllActivityNotes(db) {
  const stmt = db.prepare('SELECT activity_id FROM activity_notes');
  const ids = [];
  try {
    while (stmt.step()) ids.push(stmt.getAsObject().activity_id);
  } finally {
    stmt.free();
  }
  return new Map(ids.map((id) => [id, readActivityNotes(db, id)]).filter(([, notes]) => notes));
}

// An empty form deletes the record.
function saveActivityNotes(db, activityId, input) {
  const notes = normalizeNotes(input);
  if (!notes) {
    db.run('DELETE FROM activity_notes WHERE activity_id = ?', [activityId]);
    return null;
  }
  db.run(`INSERT INTO activity_notes (activity_id, rpe, purpose, feeling, conditions_json, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET rpe=excluded.rpe, purpose=excluded.purpose, feeling=excluded.feeling,
      conditions_json=excluded.conditions_json, note=excluded.note, updated_at=excluded.updated_at`,
  // One listed goal is stored as before; several, or the rider's own wording, as a JSON list.
  [activityId, notes.rpe, storedGoals(notes.goals), notes.feeling, JSON.stringify(notes.conditions), notes.note, new Date().toISOString()]);
  return notes;
}

function storedGoals(goals) {
  if (!goals?.length) return null;
  return goals.length === 1 && PURPOSES.includes(goals[0]) ? goals[0] : JSON.stringify(goals);
}

// The rider's own goal names used so far, for offering them again on other rides.
function readKnownGoals(db) {
  const stmt = db.prepare('SELECT purpose FROM activity_notes WHERE purpose IS NOT NULL');
  const known = new Map();
  try {
    while (stmt.step()) {
      for (const goal of normalizeGoals(stmt.getAsObject().purpose)) {
        if (!PURPOSES.includes(goal)) known.set(goal.toLowerCase(), goal);
      }
    }
  } finally {
    stmt.free();
  }
  return [...known.values()].sort((a, b) => a.localeCompare(b));
}

const label = (value) => String(value).replace(/_/g, ' ');

// One line for the history rows of earlier activities.
function describeNotesShort(notes) {
  if (!notes) return null;
  return [notes.rpe ? `RPE ${notes.rpe}` : null, notes.goals?.length ? notes.goals.join(' + ') : null, notes.feeling && notes.feeling !== 'normal' ? notes.feeling : null]
    .filter(Boolean).join(', ') || null;
}

function buildSessionNotesBlock(notes) {
  if (!notes) return '';
  const parts = [
    notes.rpe ? `perceived effort RPE ${notes.rpe}/10` : null,
    notes.goals?.length ? `${notes.goals.length > 1 ? 'goals' : 'goal'}: ${notes.goals.map(label).join(', ')}` : null,
    notes.conditions?.length ? `conditions: ${notes.conditions.map(label).join(', ')}` : null,
    notes.feeling ? `feeling: ${notes.feeling}` : null,
  ].filter(Boolean);
  // The free note is the one place where the rider says in their own words what the ride was. It
  // is given first and with an instruction of its own: without one it was passed along and ignored.
  const noteLine = notes.note
    ? `The athlete's own account of this ride: "${notes.note}"\nThis is a fact about the ride, and the first thing to explain it with. Refer to it in the answer. Where it accounts for what the data shows - a slow ride because of who it was ridden with, a stop because of what happened - say so, do not present that as a finding of your own, and do not advise against it.\n`
    : '';
  return `**Athlete's Session Notes (user-declared for this ride):**\n${noteLine}${parts.length ? `${parts.join('; ')}.` : ''}\n${notes.goals?.length ? `${notes.goals.length > 1 ? 'These goals are the yardstick for this ride: for each one say whether the ride served it and by what evidence, and where they pull against each other say so. ' : 'This goal is the yardstick for this ride: say whether the ride served it and by what evidence. '}The practical step must serve what is declared here, not a goal of your own choosing. ` : ''}${notes.rpe ? 'RPE is the athlete\'s own measure of internal effort and may disagree with HR. ' : ''}${notes.conditions?.length ? 'Declared conditions are facts about this ride and may explain speed and HR changes. ' : ''}Do not ask again for what is declared here.`;
}

// The model's own inference from this ride's analysis (tail purpose/conditions). Shown to the
// model as revisable and to the user as a form pre-fill; user-declared notes always win, field by
// field: a purpose the user declared suppresses the inferred purpose, and declared conditions
// suppress the inferred conditions, leaving the rest as suggestions.
function buildInferredNotesBlock(summary, notes) {
  const purpose = summary?.purpose?.length && summary.purpose[0] !== 'unknown' && !notes?.purpose ? summary.purpose[0] : null;
  const conditions = (summary?.conditions || []).filter((condition) => condition !== 'none' && !notes?.conditions?.includes(condition));
  if (!purpose && !conditions.length) return '';
  return `**Session Notes (AI-inferred from this ride's data, revisable):**\n${[
    purpose ? `purpose: ${label(purpose)} (inferred; the user may correct it on the activity page)` : null,
    conditions.length ? `conditions: ${conditions.map(label).join(', ')} (inferred; the user may correct them)` : null,
  ].filter(Boolean).join('; ')}.\nThese are inferences from data, not user statements; treat them as working assumptions, not as the athlete's declared intent.`;
}

// Pre-fill for the Session Notes form: what the model inferred for this ride.
function inferNotesPreFill(summary) {
  const goals = (summary?.purpose || []).filter((goal) => goal && goal !== 'unknown');
  const conditions = (summary?.conditions || []).filter((condition) => condition !== 'none');
  return goals.length || conditions.length ? { goals, purpose: goals[0] ?? null, conditions } : null;
}

module.exports = {
  CONDITIONS,
  FEELINGS,
  PURPOSES,
  buildInferredNotesBlock,
  buildSessionNotesBlock,
  inferNotesPreFill,
  describeNotesShort,
  normalizeGoals,
  normalizeNotes,
  readKnownGoals,
  readActivityNotes,
  readAllActivityNotes,
  saveActivityNotes,
};
