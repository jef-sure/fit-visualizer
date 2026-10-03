// UTC-offset derivation and local-time helpers, free of the vscode import for testability.
//
// FIT carries activity.timestamp (UTC) and activity.local_timestamp (the device's wall clock).
// Their difference is the offset configured on the bike computer, which is the best available
// source for "when did this ride actually happen" for the athlete.

const MAX_OFFSET_HOURS = 14;
const MAX_ABSOLUTE_OFFSET_S = MAX_OFFSET_HOURS * 3600;

// Derive the offset in whole quarters of an hour (device settings are usually exact hours or
// half hours; quarter-hour rounding rejects sub-minute clock drift as a fake offset).
function deriveUtcOffsetS({ activityTimestamp, activityLocalTimestamp, fileName, sessionStartTime }) {
  const fromTimestamps = offsetFromTimestamps(activityTimestamp, activityLocalTimestamp);
  if (fromTimestamps != null) {
    return { utcOffsetS: fromTimestamps, offsetSource: 'fit' };
  }
  const fromName = offsetFromFileName(fileName, sessionStartTime);
  if (fromName != null) {
    return { utcOffsetS: fromName, offsetSource: 'filename' };
  }
  return { utcOffsetS: null, offsetSource: null };
}

function offsetFromTimestamps(timestampIso, localTimestampIso) {
  const utc = Date.parse(timestampIso);
  const local = Date.parse(localTimestampIso);
  if (!Number.isFinite(utc) || !Number.isFinite(local)) {
    return null;
  }
  return quantizeOffset(local - utc);
}

// CYCPLUS (and some other devices) name files by local start time: 20260819190608.fit for 17:06:08Z.
function offsetFromFileName(fileName, sessionStartTimeIso) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(fileName || ''));
  const start = Date.parse(sessionStartTimeIso);
  if (!match || !Number.isFinite(start)) {
    return null;
  }
  const named = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  if (!Number.isFinite(named)) {
    return null;
  }
  return quantizeOffset(named - start);
}

function quantizeOffset(rawMs) {
  if (!Number.isFinite(rawMs)) {
    return null;
  }
  const quantized = Math.round(rawMs / 900000) * 900;
  return Math.abs(quantized) <= MAX_ABSOLUTE_OFFSET_S ? quantized : null;
}

// Local calendar date (YYYY-MM-DD) of a UTC ISO timestamp under a known offset.
function localDate(isoTimestamp, utcOffsetS) {
  const time = Date.parse(isoTimestamp);
  const offset = Number(utcOffsetS);
  if (!Number.isFinite(time) || !Number.isFinite(offset)) {
    return String(isoTimestamp || '').slice(0, 10);
  }
  return new Date(time + offset * 1000).toISOString().slice(0, 10);
}

// Local wall-clock time (HH:MM) plus a short, prompt-friendly zone label.
function localClock(isoTimestamp, utcOffsetS) {
  const time = Date.parse(isoTimestamp);
  const offset = Number(utcOffsetS);
  if (!Number.isFinite(time) || !Number.isFinite(offset)) {
    return null;
  }
  const local = new Date(time + offset * 1000);
  const hhmm = local.toISOString().slice(11, 16);
  return { time: hhmm, zoneLabel: formatOffsetLabel(offset) };
}

function formatOffsetLabel(utcOffsetS) {
  const totalMinutes = Math.round(Number(utcOffsetS) / 60);
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// A device offset that disagrees with the median of nearby rides usually means the timezone
// setting was changed (or misconfigured), which quietly distorts local dates and day counts.
function detectOffsetChange(activities, { windowDays = 14 } = {}) {
  const reference = Date.parse(activities?.current?.startTime);
  const utcOffsetS = Number(activities?.current?.utcOffsetS);
  if (!Number.isFinite(reference) || !Number.isFinite(utcOffsetS)) {
    return null;
  }
  const neighbours = (activities?.others || [])
    .filter((row) => Number.isFinite(Number(row.utcOffsetS)))
    .map((row) => ({ offset: Number(row.utcOffsetS), time: Date.parse(row.startTime) }))
    .filter((row) => Number.isFinite(row.time) && Math.abs(reference - row.time) <= windowDays * 86400000);
  if (neighbours.length < 2) {
    return null;
  }
  const sorted = neighbours.map((row) => row.offset).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median !== utcOffsetS
    ? { utcOffsetS, medianOffsetS: median, neighbours: neighbours.length }
    : null;
}

module.exports = {
  deriveUtcOffsetS,
  detectOffsetChange,
  formatOffsetLabel,
  localClock,
  localDate,
};
