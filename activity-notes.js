// Session notes: the athlete's own record of how a ride felt and what it was for. Pure
// normalization and text helpers plus small DB accessors; no vscode.

const PURPOSES = Object.freeze(['commute', 'endurance', 'tempo', 'intervals', 'recovery', 'race', 'social', 'other']);
const FEELINGS = Object.freeze(['fresh', 'normal', 'tired', 'ill']);
const CONDITIONS = Object.freeze(['headwind', 'tailwind', 'rain', 'heat', 'cold', 'group', 'traffic', 'night', 'new_route']);
const NOTE_MAX_CHARS = 1000;

const pick = (value, allowed) => {
  const text = String(value ?? '').trim().toLowerCase();
  return allowed.includes(text) ? text : null;
};

// Accepts untrusted webview input; returns the canonical record or null when nothing is filled.
function normalizeNotes(input) {
  const rpeNumber = Number(input?.rpe);
  const rpe = input?.rpe !== '' && input?.rpe != null && Number.isInteger(rpeNumber) && rpeNumber >= 1 && rpeNumber <= 10 ? rpeNumber : null;
  const conditions = [...new Set((Array.isArray(input?.conditions) ? input.conditions : []).map((value) => pick(value, CONDITIONS)).filter(Boolean))];
  const note = String(input?.note ?? '').trim().slice(0, NOTE_MAX_CHARS);
  const notes = { rpe, purpose: pick(input?.purpose, PURPOSES), feeling: pick(input?.feeling, FEELINGS), conditions, note: note || null };
  return rpe || notes.purpose || notes.feeling || conditions.length || notes.note ? notes : null;
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
  [activityId, notes.rpe, notes.purpose, notes.feeling, JSON.stringify(notes.conditions), notes.note, new Date().toISOString()]);
  return notes;
}

const label = (value) => String(value).replace(/_/g, ' ');

// One line for the history rows of earlier activities.
function describeNotesShort(notes) {
  if (!notes) return null;
  return [notes.rpe ? `RPE ${notes.rpe}` : null, notes.purpose, notes.feeling && notes.feeling !== 'normal' ? notes.feeling : null]
    .filter(Boolean).join(', ') || null;
}

function buildSessionNotesBlock(notes) {
  if (!notes) return '';
  const parts = [
    notes.rpe ? `perceived effort RPE ${notes.rpe}/10` : null,
    notes.purpose ? `purpose: ${label(notes.purpose)}` : null,
    notes.conditions?.length ? `conditions: ${notes.conditions.map(label).join(', ')}` : null,
    notes.feeling ? `feeling: ${notes.feeling}` : null,
  ].filter(Boolean);
  return `**Athlete's Session Notes (user-declared for this ride):**\n${parts.length ? `${parts.join('; ')}.` : ''}${notes.note ? `${parts.length ? '\n' : ''}Note: ${notes.note}` : ''}\n${notes.purpose ? 'The declared purpose replaces any inferred training direction for this session. ' : ''}${notes.rpe ? 'RPE is the athlete\'s own measure of internal effort and may disagree with HR. ' : ''}${notes.conditions?.length ? 'Declared conditions are facts about this ride and may explain speed and HR changes. ' : ''}Do not ask again for what is declared here.`;
}

module.exports = {
  CONDITIONS,
  FEELINGS,
  PURPOSES,
  buildSessionNotesBlock,
  describeNotesShort,
  normalizeNotes,
  readActivityNotes,
  readAllActivityNotes,
  saveActivityNotes,
};
