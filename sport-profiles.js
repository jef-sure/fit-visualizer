// Sport profiles for the AI prompt and the workout fields: how a FIT `sport` string maps to a
// profile, which units describe it (speed vs pace, rpm vs spm), and which metrics make sense.
// Pure module, no vscode, testable.
//
// The plan covers cycling, running, hiking, walking and swimming; anything else is `other`
// (generic), which keeps the current behaviour. Power metrics are cycling-only: for the rest,
// motion-based vpower is not a meaningful training load, so it is never shown as measured load.

const PROFILES = Object.freeze({
  cycling: { speedUnit: 'kmh', cadenceUnit: 'rpm', usesPower: true, movingLabel: 'speed', terrain: true },
  running: { speedUnit: 'minPerKm', cadenceUnit: 'spm', usesPower: false, movingLabel: 'pace', terrain: true },
  hiking: { speedUnit: 'kmh', cadenceUnit: 'spm', usesPower: false, movingLabel: 'walking speed', terrain: true },
  walking: { speedUnit: 'minPerKm', cadenceUnit: 'spm', usesPower: false, movingLabel: 'pace', terrain: false },
  swimming: { speedUnit: 'minPer100m', cadenceUnit: 'spm', usesPower: false, movingLabel: 'swim pace', terrain: false },
  other: { speedUnit: 'kmh', cadenceUnit: 'rpm', usesPower: false, movingLabel: 'speed', terrain: true },
});

// FIT `sport` values (case-insensitive substrings) to a profile key. Order matters: hiking before
// running so a hike with a "trail" sub-sport stays a hike, walking last because "hike" also
// appears in its pattern. Sub-sport is only a hint; the sport string dominates.
const SPORT_KEYWORDS = Object.freeze([
  ['cycling', /cycl|bik|mtb|mountain.?bike/i],
  ['swimming', /swim|pool|open.?water/i],
  ['hiking', /hik|mountaineer|trek|backpack/i],
  ['running', /run|jog|track|trail/i],
  ['walking', /walk|stroll/i],
]);

function normalizeSport(sport, subSport = '') {
  const value = `${sport || ''} ${subSport || ''}`.toLowerCase();
  for (const [key, pattern] of SPORT_KEYWORDS) {
    if (pattern.test(value)) return key;
  }
  return 'other';
}

function profileFor(sport, subSport = '') {
  return PROFILES[normalizeSport(sport, subSport)] || PROFILES.other;
}

// A speed in km/h as a pace string. min/km for running/walking, min/100 m for swimming.
function formatPace(kmh, speedUnit) {
  const speed = Number(kmh);
  if (!Number.isFinite(speed) || speed <= 0) return null;
  if (speedUnit === 'minPer100m') {
    const minPer100m = 6 / speed; // 100 m / (speed km/h) = 6 / speed minutes
    return `${Math.floor(minPer100m)}:${String(Math.round((minPer100m % 1) * 60)).padStart(2, '0')} /100 m`;
  }
  const minPerKm = 60 / speed;
  return `${Math.floor(minPerKm)}:${String(Math.round((minPerKm % 1) * 60)).padStart(2, '0')} /km`;
}

// A speed-or-pace field for the workout block: cycling/hiking keep km/h, running/walking become
// min/km, swimming becomes min/100 m.
function describeSpeed(kmh, profile) {
  if (profile.speedUnit === 'kmh') {
    const speed = Number(kmh);
    return Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(2)} km/h` : null;
  }
  return formatPace(kmh, profile.speedUnit);
}

// Sport-specific vocabulary/instructions appended to the analysis questions. Kept short: these
// are cues for wording and what the load is, not additional mandatory sections.
function sportPromptAdditions(profileKey) {
  switch (profileKey) {
    case 'running':
      return 'This is a running activity: describe pace in min/km, cadence in steps/min, and ground-contact/vertical-oscillation data when present. Grade-adjusted pace is not computed, so compare pace to HR rather than to measured power.';
    case 'hiking':
      return 'This is a hike: the point is sustained ascent/descent, not speed. Judge effort through elevation gain/loss and HR (VAM at walking pace), not through speed; note meaningful rests. Do not apply cycling power or vpower.';
    case 'walking':
      return 'This is a walking activity: pace in min/km and cadence in steps/min; effort is mostly HR.';
    case 'swimming':
      return 'This is a swimming activity: describe pace in min/100 m, stroke rate (strokes/min) and, when pool length and stroke count are present, SWOLF. Elevation, grade and power do not apply.';
    default:
      return null;
  }
}

module.exports = {
  PROFILES,
  describeSpeed,
  formatPace,
  normalizeSport,
  profileFor,
  sportPromptAdditions,
};
