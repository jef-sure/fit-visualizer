const { asNumber, formatHms, groupSimilarSegments, segmentLineBudget, collapseShortStops } = require('./utils');
const { calculatePeakHeartRates, computeHeartRateZones } = require('./heart-rate');
const { localClock, localDate } = require('./activity-time');
const { computeElevationGainLoss } = require('./chart-data');
const { rankModelsByCost } = require('./model-pricing');
const { describeStretches } = require('./route-features');
const { buildDataQualityFlagBlock } = require('./data-quality');
const { buildRouteSignature, matchRoutes, haversineM } = require('./route-match');
const { computeCheckpoints, priorKmOnAxis } = require('./route-store');
const { describeSpeed, normalizeSport, profileFor, sportPromptAdditions } = require('./sport-profiles');
const { SUMMARY_TAIL_INSTRUCTION, describeAnalysisForHistory } = require('./analysis-summary');
const { buildInferredNotesBlock, buildSessionNotesBlock, describeNotesShort } = require('./activity-notes');

function formatPositive(value, digits) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num.toFixed(digits) : null;
}

// Zero is a real reading for signed metrics like decoupling, so only a missing value is dropped.
function formatFinite(value, digits) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : null;
}

// Missing values are left out of the prompt entirely: an "N/A" only invites the model to speculate.
function formatFieldsSkippingEmpty(fields, prefix = '- ') {
  return fields
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && !Number.isNaN(value))
    .map(([label, value, unit]) => `${prefix}${label}: ${value}${unit ? ` ${unit}` : ''}`)
    .join('\n');
}

function joinNonEmpty(parts, separator = ', ') {
  return parts.filter((part) => part !== null && part !== undefined && part !== '').join(separator);
}

function formatClock(seconds) {
  const total = Number.isFinite(Number(seconds)) ? Math.max(0, Math.round(Number(seconds))) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function segmentEffortText(segment) {
  if (segment.effortBasis === 'power') {
    return segment.avgPower != null ? `avg power ${segment.avgPower} W` : null;
  }
  if (segment.effortBasis === 'vpower') {
    return segment.avgPower != null ? `vpower ~${segment.avgPower} W` : null;
  }
  if (segment.effortBasis === 'hr') {
    return segment.avgHr != null ? `avg HR ${segment.avgHr}` : null;
  }
  return null;
}

// The heart-rate drop in the 60 s after a climb, only when it is unambiguous: the climb lasts at
// least 3 min, the following minute is continuous movement above 5 km/h with no gap, and HR is
// covered for the whole window. A missing or positive change yields null (nothing is reported).
function postClimbHrDrop(segment, records) {
  if (!records || segment.type !== 'climb' || !(segment.durationS >= 180) || segment.endIndex == null) return null;
  const climbEndHr = asNumber(records[segment.endIndex]?.heart_rate);
  if (!(climbEndHr > 0)) return null;
  const endTime = asNumber(records[segment.endIndex]?.elapsed_time) + 60;
  const window = [];
  for (let index = segment.endIndex + 1; index < records.length; index += 1) {
    const record = records[index];
    if (asNumber(record.elapsed_time) > endTime) break;
    if (!(asNumber(record.speed) > 5) || !(asNumber(record.heart_rate) > 0)) return null;
    window.push(record);
  }
  if (window.length < 2) return null;
  const afterHr = asNumber(window[window.length - 1].heart_rate);
  if (!(afterHr > 0)) return null;
  const drop = Math.round(climbEndHr - afterHr);
  if (drop < 0) return null;
  return `post-climb HR drop 60 s: −${drop} bpm (descriptive)`;
}

function describeSegment(segment, records, profile = null) {
  if (segment.type === 'stopped') {
    return joinNonEmpty(['stopped', segment.distanceKm != null ? `${segment.distanceKm} km` : null]);
  }
  const cadenceUnit = profile?.cadenceUnit === 'spm' ? 'spm' : 'rpm';
  const speedText = profile && profile.speedUnit !== 'kmh'
    ? describeSpeed(segment.avgSpeedKmh, profile)
    : segment.avgSpeedKmh != null ? `${segment.avgSpeedKmh} km/h` : null;
  // The basis is implied by which metric is quoted, so it is explained once per block instead of per line.
  return joinNonEmpty([
    segment.type,
    segment.technical ? 'technical, no reliable effort estimate' : null,
    postClimbHrDrop(segment, records),
    segment.avgGrade != null ? `avg grade ${segment.avgGrade}%` : null,
    segmentEffortText(segment),
    segment.avgHr != null && segment.effortBasis !== 'hr' ? `avg HR ${segment.avgHr}` : null,
    segment.hrDriftPct != null ? `HR drift ${segment.hrDriftPct > 0 ? '+' : ''}${segment.hrDriftPct}%` : null,
    segment.avgCadence != null && segment.durationS >= 600 ? `cadence ${segment.avgCadence} ${cadenceUnit}` : null,
    segment.durationS >= 600 && segment.tempStart != null && segment.tempEnd != null
      ? `temp ${segment.tempStart}→${segment.tempEnd} °C` : null,
    speedText,
    segment.distanceKm != null ? `${segment.distanceKm} km` : null,
    segment.type === 'climb' && segment.elevGainM ? `+${segment.elevGainM} m` : null,
    segment.type === 'climb' && segment.elevGainM >= 25 && segment.durationS - (segment.pausedS || 0) >= 120
      ? `VAM ~${Math.round(segment.elevGainM / (segment.durationS - (segment.pausedS || 0)) * 3600)} m/h` : null,
    segment.pausedS != null ? `interrupted by a ${formatClock(segment.pausedS)} stop` : null,
    segment.hrCoveragePct != null && segment.hrCoveragePct < 100 ? `HR coverage ${segment.hrCoveragePct}%` : null,
    // Grade/vpower diagnostics only matter where vpower is the quoted effort.
    segment.effortBasis === 'vpower' && segment.gradeWindowM != null ? `grade window ~${segment.gradeWindowM} m, residual ~${segment.gradeResidualM} m, coverage ${segment.gradeCoveragePct}%` : null,
    segment.effortBasis !== 'vpower' && segment.gradeCoveragePct != null && segment.gradeCoveragePct < 80 ? `grade coverage ${segment.gradeCoveragePct}%` : null,
    segment.effortBasis === 'vpower' && segment.vpowerUse && segment.vpowerUse !== 'not assessed' ? `vpower use: ${segment.vpowerUse}; power coverage ${segment.powerCoveragePct}%` : null,
    segment.effortBasis === 'vpower' && segment.gradeSensitivityWPerPct != null ? `local uncapped sensitivity ~${segment.gradeSensitivityWPerPct} W per grade percentage point, ~${segment.massSensitivityWPerKg} W/kg mass (not error bounds)` : null,
    segment.routeStretches
      ? joinNonEmpty([
        `by route stretch (this ride / typical for this direction): ${segment.routeStretches.map((stretch) => `km ${stretch.fromKm}-${stretch.toKm} ${stretch.kmh}${stretch.typicalKmh != null ? ` / ${stretch.typicalKmh}` : ''} km/h${stretch.hr != null ? `, HR ${stretch.hr}` : ''}`).join('; ')}`,
        describeStretches(segment.routeStretches),
      ], '. ')
      : segment.dynamics ? joinNonEmpty([
        segment.dynamics.firstHalfSpeed != null && segment.dynamics.secondHalfSpeed != null
          ? `speed ${segment.dynamics.firstHalfSpeed}->${segment.dynamics.secondHalfSpeed} km/h` : null,
        segment.dynamics.firstHalfHr != null && segment.dynamics.secondHalfHr != null
          ? `HR ${segment.dynamics.firstHalfHr}->${segment.dynamics.secondHalfHr} bpm` : null,
        segment.effortBasis === 'power' && segment.dynamics.firstHalfPower != null && segment.dynamics.secondHalfPower != null
          ? `measured power ${segment.dynamics.firstHalfPower}->${segment.dynamics.secondHalfPower} W` : null,
        segment.tempStart != null && segment.tempEnd != null
          ? `temp ${segment.tempStart}->${segment.tempEnd} °C` : null,
      ], '; ') + ' (temporal halves; descriptive, not a fitness/recovery test)' : null,
  ]);
}

function describeRepeat(row) {
  const pattern = [];
  for (let offset = 0; offset < row.period; offset += 1) {
    const members = row.members.filter((_, index) => index % row.period === offset);
    const efforts = members.map((member) => (member.effortBasis === 'hr' ? member.avgHr : member.avgPower))
      .filter((value) => value != null);
    const durations = members.map((member) => member.durationS);
    const sample = members[0];
    const effortRange = efforts.length
      ? `${Math.min(...efforts)}-${Math.max(...efforts)}${sample.effortBasis === 'hr' ? ' bpm' : ' W'}`
      : null;
    const coverageRange = (field, label) => {
      const values = members.map((member) => member[field]).filter((value) => value != null);
      return values.length ? `${label} coverage ${Math.min(...values) === Math.max(...values) ? Math.min(...values) : `${Math.min(...values)}-${Math.max(...values)}`}%${values.length < members.length ? '; some unknown' : ''}` : null;
    };
    const vpowerUses = members.map((member) => member.vpowerUse);
    const hasVpower = vpowerUses.some((value) => value && value !== 'not assessed');
    pattern.push(joinNonEmpty([
      `~${formatClock(durations.reduce((sum, value) => sum + value, 0) / durations.length)}`,
      sample.type,
      effortRange ? `${sample.effortBasis === 'hr' ? 'HR' : sample.effortBasis} ${effortRange}` : null,
      coverageRange('hrCoveragePct', 'HR'),
      coverageRange('gradeCoveragePct', 'grade'),
      hasVpower ? `vpower use: ${vpowerUses.every((value) => value === 'conditional relative comparison') ? 'conditional relative comparison' : 'rough description only'}` : null,
      hasVpower ? coverageRange('powerCoveragePct', 'power') : null,
    ], ' '));
  }
  return `${row.repeats}x [ ${pattern.join(' | ')} ]`;
}

function buildSegmentContext(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) {
    return { text: '', lines: 0, maxLines: 0, exceeded: false, displayRows: [] };
  }
  const records = Array.isArray(options.records) ? options.records : null;
  const profile = options.sport ? profileFor(options.sport) : null;

  const notableStopSeconds = Number(options.notableStopSeconds) || 300;
  const shortStops = list.filter((segment) => segment.type === 'stopped' && segment.durationS < notableStopSeconds);
  const shortStopIndexes = new Set(shortStops.map((segment) => segment.index));
  const rows = groupSimilarSegments(list.filter((segment) => !shortStopIndexes.has(segment.index)), options);

  const displayRows = rows.map((row) => {
    const members = row.kind === 'repeat' ? row.members : [row.segment];
    const first = members[0];
    const last = members[members.length - 1];
    const span = `${formatHms(first.startElapsed)}-${formatHms(last.endElapsed)}`;
    const body = row.kind === 'repeat' ? describeRepeat(row) : describeSegment(first, records, profile);
    return { time: `${span} (${formatClock(last.endElapsed - first.startElapsed)})`, details: body, members };
  });

  if (shortStops.length) {
    const total = shortStops.reduce((sum, segment) => sum + segment.durationS, 0);
    const longest = Math.max(...shortStops.map((segment) => segment.durationS));
    displayRows.push({ time: '', details: `Plus ${shortStops.length} short stops, ${formatClock(total)} total (longest ${formatClock(longest)})`, members: shortStops });
  }

  const lines = displayRows.map((row) => `${row.time ? `${row.time} ` : ''}${row.details}`);
  const totalDuration = Math.max(...list.map((segment) => segment.endElapsed)) - list[0].startElapsed;
  const maxLines = segmentLineBudget(totalDuration, options);
  const numbered = lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
  const bases = new Set(list.map((segment) => segment.effortBasis));
  const notes = [
    'Segments follow changes in effort, not terrain: the type names the average terrain, and a flat segment may hold gentle rises and falls.',
    bases.has('vpower') && bases.has('hr')
      ? 'Effort basis is implied by the metric quoted. vpower is a motion estimate with segment-specific use limits, not measured power; HR describes internal response, not mechanical work.'
      : null,
    'Segments marked technical or stopped have no reliable effort estimate; never compare vpower numbers against HR numbers directly.',
  ].filter(Boolean).join('\n');

  return {
    text: `**Segment Breakdown:**\n${numbered}\n${notes}`,
    lines: lines.length,
    maxLines,
    exceeded: lines.length > maxLines,
    displayRows,
  };
}

// Older entries keep only type and advice category; the latest ones carry the full summary.
const SUMMARY_DETAIL_ENTRIES = 3;
const HISTORY_CHAR_LIMIT = 4500;


// Whether an advice to record notes appeared in the recent analyses already, so the model does not
// keep asking for them in every answer.
function notesSuggestedRecently(recentHistory) {
  const entries = Array.isArray(recentHistory) ? recentHistory.slice(-5) : [];
  return entries.some((entry) => entry.analysisSummary?.adviceCategory === 'data'
    && /record|note|rpe|запиш|заметк/i.test(String(entry.analysisSummary?.advice || '')));
}

function buildRecentHistoryContext(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    return '';
  }

  const detailedCount = Number(options.detailedCount) || 4;
  const detailedFrom = Math.max(0, list.length - detailedCount);
  const rendered = list.map((entry, index) => {
    const date = localDate(entry.startTime, entry.utcOffsetS);
    const intensity = Array.isArray(entry.zoneSeconds) && entry.zoneSeconds.some((value) => Number(value) > 0)
      ? (() => {
        const total = entry.zoneSeconds.reduce((sum, value) => sum + Number(value || 0), 0);
        const pct = (value) => Math.round(100 * value / total);
        return `L/M/H ${pct(Number(entry.zoneSeconds[0]) + Number(entry.zoneSeconds[1]))}/${pct(entry.zoneSeconds[2])}/${pct(Number(entry.zoneSeconds[3]) + Number(entry.zoneSeconds[4]))}%`;
      })()
      : null;
    const classText = entry.sessionClass?.label ? `class ${entry.sessionClass.label}${entry.sessionClass.confidence === 'low' ? ' (low confidence)' : ''}` : null;
    const summary = joinNonEmpty([
      entry.distanceKm != null ? `${Number(entry.distanceKm).toFixed(1)} km` : null,
      entry.durationS != null ? formatHms(Math.round(entry.durationS)) : null,
      entry.trainingStressScore != null && entry.powerSource === 'measured' ? `measured-power TSS ${Number(entry.trainingStressScore).toFixed(0)}` : null,
      entry.avgHr != null ? `FIT avg HR ${Number(entry.avgHr).toFixed(0)} bpm` : null,
      entry.reportedAvgHr != null
        ? `user-reported avg/max HR ${Number(entry.reportedAvgHr).toFixed(0)}/${Number.isFinite(Number(entry.reportedMaxHr)) ? Number(entry.reportedMaxHr).toFixed(0) : '?'} bpm (summary only, no time series)` : null,
      intensity,
      entry.trimp != null ? `TRIMP ${Number(entry.trimp).toFixed(0)}` : null,
      classText,
      describeNotesShort(entry.notes),
      entry.routeId && entry.ascentM == null ? null : entry.routeId ? null : entry.elevationM != null ? `ascent ${Number(entry.elevationM).toFixed(0)} m` : null,
      ['threshold', 'vo2max/anaerobic'].includes(entry.sessionClass?.label) && entry.peak20 != null ? `peak20 ${entry.peak20} bpm` : null,
      entry.hrProfileDate && entry.hrProfileDate !== list[index - 1]?.hrProfileDate ? `HR profile ${entry.hrProfileDate}` : null,
      entry.source && entry.source !== 'fit' ? `source ${entry.source}` : null,
    ]);
    const hasSummary = entry.analysisSummary && (entry.analysisSummary.finding || entry.analysisSummary.advice || entry.analysisSummary.type);
    const interpretation = hasSummary
      ? `\n  AI summary: ${describeAnalysisForHistory(entry.analysisSummary, null, entry.sessionClass?.label, { brief: index < list.length - SUMMARY_DETAIL_ENTRIES })}`
      : index >= detailedFrom && String(entry.analysisText || '').trim()
        ? `\n  Prior AI hypothesis (not evidence), relative dates refer to activity ${date}, not the current activity: ${describeAnalysisForHistory(null, entry.analysisText)}` : '';
    return `${date}: ${summary || 'no numeric summary'}${interpretation}`;
  });

  const categories = list.map((entry) => entry.analysisSummary?.adviceCategory).filter((category) => category && category !== 'none');
  const categoryLine = categories.length
    ? `\n\nRecent advice categories (oldest first): ${categories.slice(-6).join(', ')}. Choose a different category for the practical step unless this activity's data requires repeating; if repeating, state what changed. Use "revised" to retract an earlier hypothesis.`
    : '';
  const summaryNote = list.some((entry) => entry.analysisSummary)
    ? 'Lines marked "AI summary" are earlier model hypotheses, not evidence; their relative dates refer to that activity\'s own date. An unchanged HR profile date is shown only where it starts.\n'
    : '';
  // Hard cap on the whole block: whole oldest entries are dropped, lines are never cut mid-way.
  const blockLength = (items) => `**Recent Activity History (earlier workouts, oldest first):**\n${summaryNote}${items.join('\n\n')}${categoryLine}`.length;
  let renderedList = rendered;
  let omitted = 0;
  while (renderedList.length > 1 && blockLength(renderedList) > HISTORY_CHAR_LIMIT) {
    renderedList = renderedList.slice(1);
    omitted += 1;
  }
  const omittedNote = omitted ? `\n${omitted} older ride${omitted > 1 ? 's' : ''} omitted to fit the block; their facts remain in the period totals.` : '';
  return `**Recent Activity History (earlier workouts, oldest first):**\n${summaryNote}${renderedList.join('\n\n')}${omittedNote}${categoryLine}`;
}

function formatConversation(history) {
  return (Array.isArray(history) ? history : [])
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && String(entry.content || '').trim())
    .slice(-24).map((entry) => `${entry.role === 'user' ? 'User report' : 'Assistant hypothesis'} (${entry.ts || 'message date unknown'}): ${String(entry.content).trim()}`).join('\n');
}

function buildRouteContextBlock(routeContext) {
  if (!routeContext || !(routeContext.checkpointLines?.length || routeContext.climbLine || routeContext.patternLine || routeContext.routeNote)) return '';
  const lines = (routeContext.checkpointLines || []).join('\n');
  return joinNonEmpty([
    `**Same-Route Context (GPS-confirmed):**\nRoute "${routeContext.routeName}" (${routeContext.relation}); ${routeContext.priorRideCount} earlier comparable rides (same direction).`,
    routeContext.routeNote ? `User note about this route (user-declared, applies to every ride on it): ${routeContext.routeNote}` : null,
    lines ? `Checkpoint splits at this ride's segment boundaries (plus every 2 km inside long segments); prior rides are matched by place on the road, so differing segmentation does not break the comparison. Each line is one place with its own delta; quote places separately, never as a range summary. Median of up to 5 prior same-route rides:\n${lines}` : null,
    routeContext.patternLine,
    routeContext.verdictLine,
    routeContext.climbLine,
    routeContext.note,
  ], '\n');
}

function buildRouteProfileBlock(routeProfile) {
  const described = routeProfile?.described;
  if (!described?.rows?.length) return '';
  const reversed = routeProfile.direction === 'reversed';
  const ascent = reversed ? routeProfile.descentM : routeProfile.ascentM;
  const descent = reversed ? routeProfile.ascentM : routeProfile.descentM;
  const fmtGrade = (value) => (value == null ? '?' : `${value > 0 ? '+' : ''}${value}%`);
  const climbs = described.climbs.length
    ? described.climbs.map((climb) => `km ${climb.fromKm}-${climb.toKm} +${climb.gainM} m (avg ${climb.avgGradePct}%)`).join('; ')
    : 'no sustained climb steeper than 3%';
  const effects = described.asymmetric.map((stretch) =>
    `- km ${stretch.fromKm}-${stretch.toKm} is near-flat, yet about ${stretch.ownKmh} km/h here vs ${stretch.otherKmh} km/h in the opposite direction`).join('\n');
  return joinNonEmpty([
    `**Route Profile (derived from earlier rides of this route${routeProfile.rideCounts ? `: ${routeProfile.rideCounts.same} in the first-ride direction, ${routeProfile.rideCounts.reversed} opposite` : ''}; riding ${reversed ? 'opposite to the first ride' : 'in the first-ride direction'}):**`,
    `Length ${routeProfile.lengthKm} km, ascent ~${ascent} m, descent ~${descent} m. Climbs in this direction: ${climbs}.`,
    effects ? `Direction effects on near-flat ground (grade does not explain them; consistent with prevailing wind, surface or junctions, not with fitness):\n${effects}` : null,
    'These are medians of earlier rides, not the conditions of this day. When this ride\'s slow stretch coincides with a listed direction effect, say so and do not list wind as an open question.',
  ], '\n');
}

function buildAltitudeQualityBlock(altitudeQuality, qualityFlags = []) {
  const otherFlags = buildDataQualityFlagBlock(qualityFlags);
  if (!altitudeQuality || !(altitudeQuality.flags?.length || altitudeQuality.routeLine)) return otherFlags;
  const flags = (altitudeQuality.flags || []).map((flag) => `- ${flag.code}: ${flag.detail}`).join('\n');
  const altitudeBlock = `**Altitude Quality (measured facts about this recording):**\n${joinNonEmpty([flags, altitudeQuality.routeLine], '\n')}\nUse these as the explanation for ascent/descent and first-segment grade discrepancies; the route consensus is the steadier figure for comparing days.`;
  return joinNonEmpty([altitudeBlock, otherFlags], '\n\n');
}

function buildTrainingHistoryContext(context) {
  if (!context) return '';
  const volume = context.volume.map((period) => {
    const dates = `${period.start} to ${period.end} (end exclusive)`;
    const sports = period.sports.map((row) => joinNonEmpty([
      `${row.sport || 'unspecified sport'}: ${row.activities} imported activities`,
      `${formatHms(Math.round(row.durationS))} recorded timer time (${row.durationKnownActivities}/${row.activities} durations known)`,
      `${row.distanceKm.toFixed(1)} km`, `${row.activeDays} recorded active days`,
      row.trimpActivities ? `TRIMP sum ${Math.round(row.trimpSum)} (${row.trimpActivities}/${row.activities} activities with HR-based load)` : null,
      row.rpeCount ? `RPE recorded for ${row.rpeCount}/${row.activities} rides${row.medianRpe != null ? `; median RPE ${row.medianRpe}${row.medianTrimpOfRpeRides != null ? ` at median TRIMP ${Math.round(row.medianTrimpOfRpeRides)}` : ''}` : ''}${row.highRpeRides?.length ? `; rides with RPE ≥ 8: ${row.highRpeRides.length} (TRIMP ${row.highRpeRides.join(', ')})` : ''} (descriptive, no correlation at n < 6)` : null,
      row.classMix && Object.keys(row.classMix).length
        ? `session classes: ${Object.entries(row.classMix).map(([label, count]) => `${label} ${count}`).join(', ')}` : null,
      row.zonedActivities ? `${row.zonedActivities}/${row.activities} activities with covered HR zones; covered time ${formatHms(Math.round(row.coveredHrSeconds))}; zone 1-5 seconds ${row.zoneSeconds.map(Math.round).join(', ')}; ${intensityDistribution(row.zoneSeconds)}`
        : 'HR-zone distribution unavailable, not zero intensity',
    ])).join('\n');
    return `${period.days}-day period ${dates}:\n${sports || 'No imported activities; this does not establish rest.'}`;
  }).join('\n\n');
  const describeTrend = (label, trend) => trend
    ? `${label}: ${trend.direction}, change ${trend.changePct.toFixed(1)}%, heuristic noise threshold ${trend.thresholdPct.toFixed(1)}%; not a significance test or fitness measure`
    : `${label}: insufficient observations`;
  const matches = context.comparisons.map((candidate) => {
    const rows = candidate.matches.map((match) => {
      const values = (segment) => joinNonEmpty([
        `${formatClock(segment.durationS)}, grade ${segment.avgGrade}%`,
        segment.avgSpeedKmh != null ? `${segment.avgSpeedKmh} km/h` : null,
        segment.avgHr != null ? `HR ${segment.avgHr} bpm (${segment.hrCoveragePct}% coverage)` : null,
        segment.effortBasis === 'power' || segment.effortBasis === 'vpower'
          ? `${segment.effortBasis} ${segment.avgPower} W (${segment.vpowerUse})` : null,
      ]);
      return `- current segment ${match.currentIndex + 1} vs prior segment ${match.priorIndex + 1}: ${match.type}; duration ratio ${match.durationRatio.toFixed(2)}, grade difference ${match.gradeDifference.toFixed(1)} percentage points; ${match.route}. Current: ${values(match.current)}. Prior: ${values(match.prior)}.`;
    }).join('\n');
    return `Reference ${String(candidate.startTime).slice(0, 10)}: structurally matched ${candidate.matchedDurationPct.toFixed(0)}% of eligible moving duration (not a confidence score).\n${rows}`;
  }).join('\n\n');
  const interruptions = context.interruptions.map((gap) =>
    `No imported same-sport activity between ${String(gap.before).slice(0, 10)} and ${String(gap.after).slice(0, 10)} (~${gap.gapDays.toFixed(0)} days); possible change of phase or missing records, cause unknown.`).join('\n');
  const monotony = context.monotony
    ? `Week monotony (Foster, TRIMP-based, imported days only): mean daily ${context.monotony.meanDailyTrimp.toFixed(0)} over ${context.monotony.activeDays} active days, monotony ${context.monotony.monotony.toFixed(2)}, strain ${Math.round(context.monotony.strain)}; descriptive, not a validated readiness measure.`
    : null;
  const reports = (context.userReports || []).map((report) =>
    `Activity ${String(report.startTime).slice(0, 10)}, message ${report.ts || 'date unknown'}, user report: ${report.content}`).join('\n');
  return joinNonEmpty([
    `**Training Volume and Covered Intensity:**\nHistorical baseline anchored at ${context.windowEnd}: all periods end at or before the current activity start; the current activity is excluded from every historical total. These are rolling windows, not calendar weeks.\n${volume}\n${context.intensityNote}\n${context.coverageNote}`,
    `**Adaptive Observation Window:**\n${context.windowDays} days: ${context.windowStart.slice(0, 10)} to ${context.windowEnd.slice(0, 10)}; ${context.activities} same-sport activities. Window selection is not evidence of fitness.\n${describeTrend('Duration pattern', context.durationTrend)}\n${describeTrend('Distance pattern', context.distanceTrend)}\n${joinNonEmpty([interruptions, monotony], '\n')}`,
    context.routeContext
      ? null
      : matches ? `**Candidate Segment Comparisons:**\n${matches}\nMatching uses ordered terrain, duration and distance, not equal HR/power. Similar structure does not establish identical route, intent, weather or training stimulus; consider intensity separately.` : '**Candidate Segment Comparisons:** No eligible matches; training-volume context remains available.',
    context.routeContext ? buildRouteContextBlock(context.routeContext) : null,
    context.routeProfile ? buildRouteProfileBlock(context.routeProfile) : null,
    // Altitude consensus only: the data-quality flags are printed once, in the workout body, so
    // they are present even without history and never duplicated.
    buildAltitudeQualityBlock(context.altitudeQuality, []),
    reports ? `**Dated User Context Across Activities:**\n${reports}\nMessage date and activity date are different. Reports may describe another effective period; do not apply later circumstances retrospectively without support.` : null,
  ], '\n\n');
}

function buildDataQualityContext(fitData, heartRateConfig = fitData.analysisHeartRateConfig) {
  const quality = fitData.analysisQuality || {};
  const lines = formatFieldsSkippingEmpty([
    ['HR provenance', quality.hrSource], ['Altitude provenance', quality.altitudeSource],
    ['Mass provenance', quality.massSource], ['Rider mass used', formatPositive(quality.riderMassKg, 1), 'kg'],
    ['Bike mass used', formatFinite(quality.bikeMassKg, 1), 'kg'], ['FTP provenance', quality.ftpSource],
    ['HR profile provenance', heartRateConfig?.source || (heartRateConfig ? 'supplied profile; derivation not retained' : null)],
    ['TRIMP coefficients', quality.trimpCoefficientNote],
  ]);
  return lines ? `**Measurement and Estimate Provenance:**\n${lines}\nGrade residual/window diagnostics describe local consistency, not calibrated uncertainty. Unknown wind, surface, mass error and sensor bias can still affect vpower. HR zone names do not establish tested lactate threshold or VO2max.` : '';
}

function buildLapContext(fitData) {
  const laps = Array.isArray(fitData.laps) ? fitData.laps : [];
  if (laps.length < 2) return '';
  const measuredPower = fitData.sessions?.[0]?.power_source === 'measured';
  const rows = laps.slice(0, 40).map((lap, index) => `${index + 1}. ${joinNonEmpty([
    lap.total_timer_time > 0 ? formatHms(Math.round(lap.total_timer_time)) : null,
    lap.total_distance > 0 ? `${Number(lap.total_distance).toFixed(2)} km` : null,
    lap.avg_hr > 0 ? `HR ${Number(lap.avg_hr).toFixed(0)} bpm` : null,
    measuredPower && lap.avg_power > 0 ? `device avg power ${Number(lap.avg_power).toFixed(0)} W` : null,
    lap.avg_cadence > 0 ? `cadence ${Number(lap.avg_cadence).toFixed(0)}` : null,
    lap.lap_trigger ? `trigger ${lap.lap_trigger}` : null,
  ])}`).join('\n');
  return `**Device-recorded Laps:**\n${rows}\n${laps.length > 40 ? `First 40 of ${laps.length} laps shown. ` : ''}Lap boundaries can be automatic and do not establish intended intervals.`;
}

function sportsEvidenceRules() {
  return [
    'Separate recorded observations, calculated estimates, user reports, and AI hypotheses. Support important conclusions with specific supplied evidence.',
    'Use general sports knowledge to explain possible mechanisms, not to invent circumstances. Offer relevant alternative explanations and what would distinguish them.',
    'Goals may be absent, multiple, or change over time. Infer likely training direction from repeated patterns, not the athlete\'s intentions; distinguish a single session from a sustained pattern.',
    'Distinguish changes in training behaviour, likely training stimulus, and demonstrated performance/fitness change. Faster speed or lower HR alone does not establish improved fitness.',
    'Consider endurance, intense efforts, pacing, variability and enjoyment/return to activity where relevant; do not force one goal or assume increasing load is always desirable.',
    'Re-evaluate previous AI hypotheses against facts and user corrections. Repeated AI claims are not independent corroboration; explicitly revise unsupported earlier conclusions.',
    'Historical volume totals exclude the current activity. Never add the current session to a historical total or declare a contradiction by comparing totals with different activity membership.',
    'Relative periods in an earlier analysis are anchored to that earlier activity date. Rolling windows shift between analyses; equal duration does not mean identical boundaries. Before declaring an earlier aggregate wrong, verify identical start/end boundaries, sport, inclusion rules and data coverage. If earlier boundaries are unavailable, mark the comparison unverified, not erroneous.',
    'Revise an earlier conclusion only with relevant new facts, user corrections or genuinely comparable evidence. Missing detail in the current summary does not disprove an earlier observation.',
    'Use dated user context to distinguish phases. After a reported operation, illness or changed restrictions, do not mix earlier training into the current baseline as if circumstances were unchanged. Imported gaps alone do not prove a phase change.',
    'FIT data cannot establish postoperative healing, medical clearance or safe load progression. Respect reported clinician restrictions; do not prescribe progression from HR/speed alone.',
    'Compare volume over equal periods and intensity only with known coverage and compatible dated thresholds. Missing imported activity is not a rest day; TSS, hrTSS and TRIMP are different scales, not independent proofs or additive totals.',
    'vpower use limits apply per segment. Relative comparisons require similar route/conditions and assumptions; do not use rough vpower for absolute performance, FTP zones or whole-session load claims.',
    'Temperature may be device temperature, not ambient air temperature. Absent fields may be unmeasured, withheld, unavailable or inapplicable; distinguish unknown from zero.',
    'Describe meaningful findings and their practical implications rather than narrating every metric. Ask a focused question only when its answer would materially change the interpretation or advice.',
    'Classify session type (recovery, endurance, tempo, threshold, VO2max/anaerobic, mixed or unstructured) only from HR zone distribution, peak sustained HR, measured power and segment structure, citing the evidence; without HR or measured power state that it cannot be determined.',
    'Judge the stimulus mix over periods from covered intensity distribution (for example mostly low, pyramidal, polarized or mostly moderate) and the variety of session types; partial HR coverage limits this judgement.',
    'Peak HR and VAM describe the demand of this session. Compare them across activities only on similar climbs or efforts and conditions; VAM depends on climb length, gradient, wind and pacing.',
  ];
}

function buildZoneContext(records, heartRateConfig) {
  const hasProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const zoneData = hasProfile
    ? computeHeartRateZones(Array.isArray(records) ? records : [], heartRateConfig.maxHeartRate, heartRateConfig.thresholds, { restingHeartRate: heartRateConfig.restingHeartRate })
    : { enabled: false };
  if (!zoneData.enabled || !(zoneData.totalSeconds > 0)) {
    return '**Time in Heart-Rate Zones:** Not available.';
  }
  const lines = zoneData.zones
    .map((zone) => `- ${zone.name} (${zone.range}): ${formatHms(zone.seconds)} (${zone.percent.toFixed(0)}%)`)
    .join('\n');
  return `**Time in Heart-Rate Zones (percentages cover time at/above 50% of max HR; time below is excluded):**\n${lines}\nIntensity distribution: ${intensityDistribution(zoneData.zones.map((zone) => zone.seconds))}.`;
}

// Approximate three-zone grouping of the five %HRmax zones, not lactate-tested boundaries.
function intensityDistribution(zoneSeconds) {
  const total = zoneSeconds.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return 'intensity distribution unavailable';
  const pct = (value) => Math.round(100 * value / total);
  return `low (Recovery+Endurance) ${pct(zoneSeconds[0] + zoneSeconds[1])}%, moderate (Tempo) ${pct(zoneSeconds[2])}%, high (Threshold+VO2max) ${pct(zoneSeconds[3] + zoneSeconds[4])}% (approximate three-zone grouping)`;
}

function buildPeakHeartRateContext(records, trainingContext, label = '') {
  const peaks = calculatePeakHeartRates(records);
  if (!peaks.length) return '';
  const history = new Map((trainingContext?.peakHeartRates || []).map((row) => [row.seconds, row]));
  const prior = (best) => (best ? `${best.bpm} bpm (${String(best.startTime).slice(0, 10)})` : 'none');
  const lines = peaks.map((peak) => {
    const row = history.get(peak.seconds);
    const same = row?.best28 && row.best90 && row.best28.bpm === row.best90.bpm && row.best28.startTime === row.best90.startTime;
    return `- ${peak.seconds >= 3600 ? `${peak.seconds / 3600} h` : `${peak.seconds / 60} min`}: ${peak.bpm} bpm${!row ? ''
      : same ? `; prior same-sport best: 28 and 90 days ${prior(row.best28)}`
      : `; prior same-sport best: 28 days ${prior(row.best28)}, 90 days ${prior(row.best90)}`}`;
  }).join('\n');
  return `**Peak Sustained Heart Rate${label ? ` (${label})` : ''} (highest time-weighted rolling averages):**\n${lines}\nPeaks show the hardest sustained parts of the session. They depend on effort, heat, fatigue, hydration and sensor; higher or lower peaks than before do not establish a fitness change.${history.size ? ' Prior bests cover only earlier activities with detailed records.' : ''}`;
}

async function requestCopilotAnalysis(vscode, prompt, options = {}) {
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Number(options.retryDelayMs) : 1200;
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? options.maxRetries
    : 1;
  const vendor = String(options.vendor || '').trim() || 'copilot';
  const wantedId = String(options.modelId || '').trim();
  // A pinned or picked model id may belong to another vendor (BYOK providers register under
  // their own ids), so an explicit id searches every model the editor offers.
  const models = wantedId
    ? (await vscode.lm.selectChatModels()).filter((model) => model.id === wantedId || model.name === wantedId)
    : await vscode.lm.selectChatModels({ vendor });
  if (!models.length) {
    throw new Error(wantedId
      ? `Configured analysis model "${wantedId}" is not available. Clear fitVisualizer.analysisModelId or pick an available model.`
      : vendor === 'copilot'
        ? 'Copilot Chat is not installed or you are not signed in.'
        : `No language models are available for vendor "${vendor}".`);
  }

  // When an explicit id was requested the list already holds only that model (searched across
  // vendors); selectPreferredModel then just confirms the exact match.
  const chosenModel = await selectPreferredModel(vscode, wantedId ? '' : vendor, models, options);
  // Copilot may hand out different models over time, so the log has to record which one answered.
  const modelId = chosenModel.id || chosenModel.family || 'unknown';
  // A prompt may be several User messages (instructions first, data last); logs keep the joined text.
  const messages = Array.isArray(prompt) ? prompt : [prompt];
  const promptText = messages.join('\n\n');
  const report = async (result) => {
    try {
      await options.onCompleted?.({ modelId, prompt: promptText, ...result });
    } catch {
      // Logging must never break an analysis.
    }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await chosenModel.sendRequest(
        messages.map((message) => vscode.LanguageModelChatMessage.User(message))
      );
      let analysis = '';
      for await (const chunk of response.text) {
        analysis += chunk;
      }

      if (!analysis.trim()) {
        throw new Error('Copilot returned an empty analysis.');
      }
      await report({ response: analysis.trim() });
      return analysis.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryableRateLimit = isRateLimitError(message) && attempt < maxRetries;
      if (isRetryableRateLimit) {
        await delay(retryDelayMs);
        continue;
      }
      await report({ error: message });
      if (isRateLimitError(message)) {
        throw new Error('Copilot rate limit reached. Please wait a bit and try Analyze again.');
      }
      const lmErrorMessage = describeLanguageModelError(vscode, error);
      if (lmErrorMessage) {
        throw new Error(lmErrorMessage);
      }
      throw error;
    }
  }

  throw new Error('Copilot analysis failed unexpectedly.');
}

// Bare model names for widely known budget/small tiers; not tied to any one vendor's naming scheme.
const DEFAULT_CHEAP_MODEL_MARKERS = ['haiku', 'mini', 'flash', 'nano', 'lite', 'small', 'luna'];

// Cheapest model by published price; Auto and name markers cover models missing from the price table.
// A fixed model id wins when set, so prompt experiments stay reproducible.
async function selectPreferredModel(vscode, vendor, models, options) {
  const wantedId = String(options.modelId || '').trim();
  if (wantedId) {
    const exact = models.find((model) => model.id === wantedId || model.name === wantedId);
    if (exact) {
      return exact;
    }
    throw new Error(`Analysis model "${wantedId}" is not available. Clear fitVisualizer.analysisModelId or pick an available model.`);
  }
  if (!options.preferCheapModel) {
    return models[0];
  }

  const ranked = rankModelsByCost(models);
  if (ranked.length) {
    return ranked[0].model;
  }

  try {
    const autoModels = await vscode.lm.selectChatModels({ vendor, family: 'auto' });
    if (Array.isArray(autoModels) && autoModels.length) {
      return autoModels[0];
    }
  } catch {
    // family:'auto' is not a documented selector; fall through to the name heuristic below.
  }

  const markers = (Array.isArray(options.cheapModelMarkers) && options.cheapModelMarkers.length
    ? options.cheapModelMarkers
    : DEFAULT_CHEAP_MODEL_MARKERS)
    .map((marker) => String(marker).trim().toLowerCase())
    .filter(Boolean);
  const matchesMarker = (model) => {
    const name = `${model.id || ''} ${model.family || ''} ${model.name || ''}`.toLowerCase();
    return markers.some((marker) => name.includes(marker));
  };
  if (options.tier === 'middle') {
    // The default for comparison and chat: a middle-tier model, not the cheapest and not the
    // flagship. Prefer names carrying a mid-tier marker; otherwise drop the marker-matched
    // cheapest/flagship ends from the price-ranked list and take the cheapest of what remains.
    const MIDDLE_MARKERS = ['sonnet', 'gemini', 'gpt-5', 'pro', 'plus'];
    const mid = models.find((model) => {
      const name = `${model.id || ''} ${model.family || ''} ${model.name || ''}`.toLowerCase();
      return MIDDLE_MARKERS.some((marker) => name.includes(marker)) && !name.includes('ultra');
    });
    if (mid) return mid;
    const rankedAll = rankModelsByCost(models);
    if (rankedAll.length >= 3) {
      return rankedAll[Math.floor(rankedAll.length / 2)].model;
    }
    return models[Math.min(1, models.length - 1)] || models[0];
  }
  const match = models.find(matchesMarker);
  return match || models[0];
}


function describeLanguageModelError(vscode, error) {
  const ctor = vscode?.LanguageModelError;
  const isLanguageModelError = Boolean(ctor && error instanceof ctor) || typeof error?.code === 'string';
  if (!isLanguageModelError) {
    return null;
  }

  if (error.code === 'NoPermissions') {
    return 'GitHub Copilot is installed, but FIT Visualizer is not authorized to use it yet. Run Analyze again and grant access when VS Code asks.';
  }
  if (error.code === 'Blocked') {
    return 'GitHub Copilot blocked this analysis request. Check your Copilot policy settings and try again.';
  }
  if (error.code === 'NotFound') {
    return 'The selected Copilot language model was not found. Choose an available Copilot model and try again.';
  }
  return null;
}

// Splits a prompt on its bold headings so the log shows which block dominates the request.
// Character budgets per block (reference: a ~1 h, 1 Hz ride). Matching is by heading prefix; the
// log shows budget/actual and an overshoot is reported as a warning, never truncated.
const PROMPT_BLOCK_BUDGETS = Object.freeze([
  ['This Workout', 1500], ['Segment Breakdown', 4000], ['Same-Route Context', 2200], ['Route Profile', 1000], ['Altitude Quality', 1800], ['Heuristic Session Class', 400],
  ['Time in Heart-Rate Zones', 900], ['Peak Sustained', 900], ['Recent Activity History', 4500],
  ['Training Volume and Covered Intensity', 3200], ['Dated User Context', 3200], ['Principles', 4400],
  ['Questions for Analysis', 1800],
]);

function summarizePromptBlocks(prompt) {
  const text = String(prompt || '');
  const blocks = [];
  let title = 'Preamble';
  let start = 0;

  const headingPattern = /^\*\*(.+?)\*\*/gm;
  let match = headingPattern.exec(text);
  while (match) {
    if (match.index > start) {
      blocks.push({ title, chars: match.index - start });
    }
    title = match[1].replace(/:$/, '');
    start = match.index;
    match = headingPattern.exec(text);
  }
  blocks.push({ title, chars: text.length - start });

  const sized = blocks.filter((block) => block.chars > 0).map((block) => {
    const budget = PROMPT_BLOCK_BUDGETS.find(([prefix]) => block.title.startsWith(prefix))?.[1];
    return budget ? { ...block, budget, over: block.chars > budget } : block;
  });
  const overBudget = sized.filter((block) => block.over).map((block) => `${block.title}: ${block.chars}/${block.budget} chars`);
  return { totalChars: text.length, blocks: sized, overBudget };
}

function isRateLimitError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('rate limit') || text.includes('too many requests') || text.includes('429');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function responseLanguageInstruction(locale, isChat = false) {
  const languages = {
    cs: 'Czech', de: 'German', en: 'English', es: 'Spanish', fr: 'French', hu: 'Hungarian',
    it: 'Italian', ja: 'Japanese', ko: 'Korean', pl: 'Polish', 'pt-br': 'Brazilian Portuguese',
    ru: 'Russian', tr: 'Turkish', 'zh-cn': 'Simplified Chinese', 'zh-tw': 'Traditional Chinese',
  };
  const normalized = String(locale || '').trim().toLowerCase().replace(/_/g, '-');
  const language = languages[normalized] || languages[normalized.split('-')[0]];
  if (!language) return '';
  const currentQuestionRule = isChat
    ? ' Only the Latest user question may override this language: if it is written in a different language or explicitly requests another response language, use that language.'
    : ' This response has no new user question that can override the selected language.';
  return `Respond in ${language}.${currentQuestionRule} Historical user reports, archived questions, previous AI responses, quoted text and the English wording of this prompt must not change the response language. Translate technical terms from this prompt (for example elapsed time, rolling window, pacing) into the response language; keep only standard abbreviations such as HR zones, VAM or VO2max.`;
}

function buildWorkoutFields(session, records, altitudeSettlingWindow = null) {
  const activityDateTime = formatActivityDateTime(session.start_time);
  const profile = profileFor(session.sport, session.sub_sport);
  const powerSource = session.power_source === 'estimated'
    ? 'estimated from motion data'
    : session.power_source === 'measured' ? 'measured' : null;
  // Power is a cycling-only training-load metric; for other sports it is hidden entirely rather
  // than shown as an estimate.
  const wholeRidePowerIsEstimated = powerSource === 'estimated from motion data';
  const showPower = profile.usesPower;
  // Local wall-clock time comes from the device-configured UTC offset; without it the UTC stamp stands.
  const localStart = Number.isFinite(Number(session.utc_offset_s))
    ? localClock(session.start_time, session.utc_offset_s)
    : null;
  const startTimeText = localStart
    ? `${localStart.time} local (${localStart.zoneLabel}${session.offset_source === 'filename' ? ', offset inferred from file name' : ''})`
    : activityDateTime.time;
  const deviceElapsedS = Number(session.device_elapsed_s);
  const elapsedS = Number(session.total_elapsed_s);
  const elapsedText = Number.isFinite(elapsedS) && elapsedS > 0 ? formatHms(Math.round(elapsedS)) : null;
  const elapsedNote = Number.isFinite(deviceElapsedS) && deviceElapsedS > 0 && Number.isFinite(elapsedS)
    && deviceElapsedS - elapsedS > Math.max(300, 0.1 * elapsedS)
    ? `device session elapsed ${formatHms(Math.round(deviceElapsedS))} inconsistent, recording probably left open; elapsed taken from records`
    : null;
  const ascentM = Number(session.total_ascent_m);
  const descentM = Number(session.total_descent_m);
  const deviceAscentM = Number(session.device_ascent_m);
  const deviceDescentM = Number(session.device_descent_m);
  const settling = altitudeSettlingWindow;
  // With barometer settling the start drift is not terrain: show the full computed figure and the
  // figure recomputed from the settled moment; the route consensus (in the flags block) is the
  // steadier reference for comparing days.
  let ascentText = formatPositive(ascentM, 0);
  let descentText = formatPositive(descentM, 0);
  let settlingNote = null;
  if (settling?.settleSeconds > 0 && Array.isArray(records) && records.length > 2) {
    const cutoff = Number(records[0]?.elapsed_time) + settling.settleSeconds;
    const trimmed = records.filter((record) => Number(record?.elapsed_time) >= cutoff)
      .map((record) => Number(record?.altitude))
      .filter(Number.isFinite)
      .map((value) => value * 1000);
    if (trimmed.length > 10) {
      const trimmedElevation = computeElevationGainLoss(trimmed);
      settlingNote = `settled part: ${formatPositive(trimmedElevation.gain, 0)}/${formatPositive(trimmedElevation.loss, 0)} m; see ALT_SETTLING`;
    }
  }
  // A stored 0/0 means the device wrote no ascent figure, not a flat ride: it is not a
  // disagreeing source. (Same rule as the altitude-quality block.)
  const deviceWroteAscent = deviceAscentM > 0 || deviceDescentM > 0;
  const ascentDiverges = deviceWroteAscent && [ascentM, descentM, deviceAscentM, deviceDescentM].every(Number.isFinite)
    && Math.abs(deviceAscentM - ascentM) > Math.max(15, 0.15 * Math.abs(ascentM || deviceAscentM));
  const elevationNote = ascentDiverges
    ? `device reports ${deviceAscentM.toFixed(0)}/${deviceDescentM.toFixed(0)} m; sources disagree, treat ascent/descent and first-segment grade with caution`
    : null;
  const speedLabel = profile.speedUnit === 'kmh' ? 'Speed' : 'Pace';
  const avgSpeedText = profile.speedUnit === 'kmh'
    ? formatPositive(session.avg_speed_kmh, 2)
    : describeSpeed(session.avg_speed_kmh, profile);
  const maxSpeedText = profile.speedUnit === 'kmh'
    ? formatPositive(session.max_speed_kmh, 2)
    : describeSpeed(session.max_speed_kmh, profile);
  const speedUnitSuffix = profile.speedUnit === 'kmh' ? 'km/h' : null;
  const showElevation = profile.terrain;
  const text = formatFieldsSkippingEmpty([
    ['Sport', session.sport], ['Sub-sport', session.sub_sport],
    ['Date', activityDateTime.date],
    ['Start Time', startTimeText],
    ['Average Temperature', averageTemperature(records), 'C'],
    ['Distance', session.total_distance_km?.toFixed(2), 'km'],
    ['Duration (timer)', session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : null],
    ['Elapsed Time (incl. stops)', elapsedText ? `${elapsedText}${elapsedNote ? ` (${elapsedNote})` : ''}` : null],
    [`Avg ${speedLabel}`, avgSpeedText, speedUnitSuffix],
    [`Max ${speedLabel}`, maxSpeedText, speedUnitSuffix],
    ['Avg Cadence', formatPositive(session.avg_cadence, 0), profile.cadenceUnit],
    ['Calories', formatPositive(session.total_calories, 0), 'kcal'],
    ['Average Power', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.avg_power, 0) : null, 'W'],
    ['Max Power', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.max_power, 0) : null, 'W'],
    ['Normalized Power', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.normalized_power, 0) : null, 'W'],
    ['FTP Used for Power Metrics', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.ftp, 0) : null, 'W'],
    ['Intensity Factor', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.intensity_factor, 2) : null],
    ['TSS', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.training_stress_score, 1) : null],
    ['xPower (GC)', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.xpower, 0) : null, 'W'],
    ['RI (GC)', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.relative_intensity_gc, 2) : null],
    ['BikeStress (GC)', showPower && !wholeRidePowerIsEstimated ? formatPositive(session.bike_stress_score, 1) : null],
    ['Power:HR decoupling (EF)', showPower && !wholeRidePowerIsEstimated ? formatFinite(session.decoupling_pct, 1) : null],
    ['TRIMP', formatPositive(session.trimp, 1)],
    ['hrTSS', formatPositive(session.hr_tss, 1)],
    ['Estimated threshold HR used for hrTSS', formatPositive(session.lactate_threshold_hr, 0), 'bpm'],
    ['Avg Heart Rate', formatPositive(session.avg_hr, 0), 'bpm'],
    ['Max Heart Rate', formatPositive(session.max_hr, 0), 'bpm'],
    ['Elevation Gain', showElevation && ascentText ? `${ascentText} m${settlingNote ? ` (${settlingNote})` : ''}${elevationNote ? ` (${elevationNote})` : ''}` : null],
    ['Elevation Loss', showElevation && descentText ? `${descentText} m${settlingNote || elevationNote ? ' (same notes)' : ''}` : null],
    ['Power source', showPower ? powerSource : null],
  ]);
  return { text, powerSource };
}

function buildHeartRateProfileContext(heartRateConfig) {
  const hasHeartRateProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  if (!hasHeartRateProfile) {
    return '**Heart Rate Profile:** No personal maximum HR or zone thresholds are available.';
  }
  const zoneMethod = heartRateConfig?.lthr
    ? `user-tested lactate threshold HR ${heartRateConfig.lthr} bpm (dated ${heartRateConfig.effectiveDate || 'profile'}); hrTSS threshold uses this value`
    : Array.isArray(heartRateConfig.thresholds)
      ? 'zone starts from the dated profile; hrTSS threshold is estimated as the middle of the Threshold zone, not a tested LTHR'
      : Number.isFinite(Number(heartRateConfig?.restingHeartRate))
        ? `thresholds derived from Karvonen reserve (resting ${heartRateConfig.restingHeartRate} bpm); hrTSS threshold is estimated, not a tested LTHR`
        : 'thresholds derived at 60%, 70%, 80%, and 90% of max HR; hrTSS threshold is estimated, not a tested LTHR';
  const maxSource = heartRateConfig?.observedMaxSource
    ? `observed 15 s window ${heartRateConfig.observedMaxSource.bpm} bpm on ${heartRateConfig.observedMaxSource.date}${heartRateConfig.formulaMaxHeartRate ? ` / formula ${heartRateConfig.formulaMaxHeartRate}` : ''}`
    : heartRateConfig?.formulaMaxHeartRate ? `formula ${heartRateConfig.formulaMaxHeartRate}` : null;
  return `**Heart Rate Profile Effective for This Workout:**\n${formatFieldsSkippingEmpty([
    ['Effective Date', heartRateConfig.effectiveDate || 'legacy setting'],
    ['Maximum HR', heartRateConfig.maxHeartRate, 'bpm'],
    ['Max HR Source', maxSource],
    ['Zone 2-5 Starts', Array.isArray(heartRateConfig.thresholds)
      ? `${heartRateConfig.thresholds.join(', ')} bpm`
      : 'derived at 60%, 70%, 80%, and 90% of max HR'],
    ['Zone method', zoneMethod],
  ])}`;
}

function buildReportedHeartRateContext(session) {
  const avg = formatPositive(session?._reportedAvgHr, 0);
  const max = formatPositive(session?._reportedMaxHr, 0);
  if (!avg && !max) return '';
  return `**User-Reported Heart Rate (summary from another device, not measured here):**\n${formatFieldsSkippingEmpty([
    ['Reported Avg HR', avg, 'bpm'],
    ['Reported Max HR', max, 'bpm'],
  ])}\nThese values are single numbers reported by the athlete, not a recorded heart-rate series: zones, TRIMP, hrTSS, peaks and drift cannot be derived from them. They may still indicate the internal response of that session.`;
}

function buildSessionClassContext(sessionClass, heartRateConfig) {
  if (!sessionClass) return '';
  const reasons = (Array.isArray(sessionClass.reasons) ? sessionClass.reasons : []).join('; ');
  const alternatives = (Array.isArray(sessionClass.alternatives) ? sessionClass.alternatives : []).join(', ');
  const method = heartRateConfig?.lthr ? 'threshold reference: user-tested LTHR' : 'threshold reference: estimated LTHR';
  return `**Heuristic Session Class (computed, revisable):**\n${formatFieldsSkippingEmpty([
    ['Class', sessionClass.label],
    ['Confidence', sessionClass.confidence],
    ['Evidence', reasons],
    ['Plausible alternatives', alternatives || null],
    ['Method', `${method}; classification thresholds are heuristic, not lab-tested`],
  ])}`;
}

// Positive principles for the analysis prompt; data-specific facts live in the data blocks.
const ANALYSIS_PRINCIPLES = Object.freeze([
  'Hierarchy of evidence: measurement > calculation > data-quality flag > user message > code heuristic > earlier AI hypothesis. Back each important claim with a number from the data. Repeated AI claims are not independent corroboration.',
  'Every number you quote is copied from the supplied data at its own place: the same mark, segment or date. Do not generalize a split to a stretch it does not cover, average in your head, flip a sign (slower/faster), or shift a location (segment numbers and km marks are different axes and a ride cannot reference km beyond its length). If the data does not carry a number for a point, the point is made without one or not made.',
  'Explain mechanisms (heat, drift, wind, fatigue) as hypotheses and say what observation would tell them apart.',
  'Compare only what is comparable: the same route and signal source. Without that, speed and HR are description, not a judgement of form.',
  'Separate behaviour (what was done), stimulus (what the load resembles) and form (needs repeatable comparable data; faster speed or lower HR alone does not establish it). Goals may be absent, multiple, or change over time: infer the training direction from repeated patterns, not intentions. Do not infer recovery status, aerobic control, fatigue or overreaching from average and maximum HR alone.',
  'Session type: confirm or dispute the computed class in one sentence with evidence; do not re-derive the zone distribution. Without a computed class, classify session type (recovery, endurance, tempo, threshold, VO2max/anaerobic, mixed or unstructured) only from HR zone distribution, peak sustained HR, measured power and segment structure, citing the evidence; without HR or measured power say it cannot be determined.',
  'Periods: use the supplied session-class mix and period load; missing imported activities are unknown, not rest, and TSS, hrTSS and TRIMP are different scales that are never added or compared. Judge the stimulus mix over periods from covered intensity distribution and the variety of session types; partial HR coverage limits this.',
  'Continuity: honour "revised" and the earlier advice categories; repeat a category only when new data requires it and say what changed. Revise earlier hypotheses only on relevant new facts. Missing detail in the current summary does not disprove an earlier observation. Relative periods in an earlier analysis are anchored to that activity\'s date; before declaring an earlier aggregate wrong, verify identical start/end boundaries, sport, inclusion rules and data coverage, otherwise mark the comparison unverified, not erroneous.',
  'User messages are dated and describe their own periods. Reported medical restrictions take priority; FIT data cannot establish postoperative healing, medical clearance or safe load progression.',
  'Estimates (vpower, hrTSS, TRIMP) are approximations on their own scales; vpower limits apply per segment and never support absolute performance or FTP claims.',
  'Device temperature, absent fields and partial coverage can change a conclusion: mention each once, where it matters. Temperature may be the device\'s, not ambient air. Absent fields may be unmeasured, withheld, unavailable or inapplicable; treat unknown as unknown rather than zero. Quality flags are measured facts that explain discrepancies, not hedges.',
  'Do not prescribe bpm targets from a peak; phrase effort advice through RPE and comparable stretches, labelled as general guidance.',
  'Do not fill missing data with plausible claims; say once what is missing. Never present an invented instruction, promise or preference as the user\'s own words; only the supplied session notes and user context are the user\'s. If recent analyses already pointed out the same missing sensor or data gap, mention it at most briefly and do not make it the practical step again.',
  'Ask the user only when the answer would change the advice and was not asked before; otherwise state the working assumption. Most analyses need no question.',
  'Focus on what is new relative to earlier summaries. Do not repeat advice, caveats or questions already given there unless this activity adds new evidence; do not retell tables. Attribute period statistics to their stated date range, never to one activity.',
  'Answer in the interface language. Translate every term, including the zone and class names that appear in English in the data (recovery, endurance, tempo, threshold, VO2max, mixed, unstructured, undetermined); keep only the abbreviations HR, VAM, TRIMP, RPE, bpm and units such as km/h. Never leave an English word inside a sentence in another language.',
]);

// How the answer should sound: a coach talking to the athlete, not a report about "the user".
// Shared by the analysis, chat and comparison prompts.
const ANALYSIS_VOICE = `**Voice:**
- Speak to the athlete directly in the second person and keep one register throughout (in languages with a polite form, use it consistently). Never say "the user" or "the athlete" about the person you are writing to.
- Plain sentences: one idea each, short, concrete. Write as you would speak to someone standing next to you after the ride.
- A caveat is said once, where it changes the conclusion. Do not close every sentence or paragraph with a disclaimer such as "this does not prove", "this is a description, not a judgement", "conditions were not controlled". If a limit applies to the whole section, state it in one sentence at the start or end, then move on.
- Quote at most the two or three numbers that carry the point; do not recite rows of a table or every peak window.
- Headings are yours: short, natural phrases in the response language. Do not translate the English question labels word for word.`;

function generateAnalysisPromptParts(fitData, progressSummary, heartRateConfig, previousAnalysis, followUpHistory, recentHistory, locale) {
  const session = fitData.sessions?.[0] || {};
  const { text: workoutFields, powerSource } = buildWorkoutFields(session, fitData.records, fitData.altitudeSettlingWindow);
  const priorActivityCount = Number(progressSummary?.total_activities || 0);
  const hasBaseline = priorActivityCount > 0;
  const hasTrendEvidence = priorActivityCount >= 8;
  const heartRateProfileContext = buildHeartRateProfileContext(heartRateConfig);
  const hasHeartRateProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const reportedHeartRateContext = buildReportedHeartRateContext(session);
  const baselineFields = formatFieldsSkippingEmpty([
    ['Eligible Prior Activities', priorActivityCount],
    ['Distance Range', progressSummary?.comparison_min_distance_km != null && progressSummary?.comparison_max_distance_km != null
      ? `${progressSummary.comparison_min_distance_km.toFixed(1)}-${progressSummary.comparison_max_distance_km.toFixed(1)} km (75%-125% of this workout)`
      : null],
    ['Total Distance', formatPositive(progressSummary?.total_distance_km, 1), 'km'],
    ['Total Hours', formatPositive(progressSummary?.total_hours, 1), 'hrs'],
    ['Average Speed', formatPositive(progressSummary?.avg_speed_kmh, 1), 'km/h'],
    ['Average Heart Rate', formatPositive(progressSummary?.avg_heart_rate, 0), 'bpm'],
    ['Max Heart Rate Recorded', formatPositive(progressSummary?.max_recorded_heart_rate, 0), 'bpm'],
  ]);
  const loadFields = formatFieldsSkippingEmpty([
    ['Activities', progressSummary?.recent_activity_count || null],
    ['Total Distance (7 days)', formatPositive(progressSummary?.weekly_distance_km, 1), 'km'],
    ['Avg Speed of Those Rides', formatPositive(progressSummary?.weekly_avg_speed_kmh, 1), 'km/h'],
    ['Speed Trend (comparable rides)', progressSummary?.trend_speed || null],
    ['HR Trend (comparable rides)', progressSummary?.trend_heart_rate || null],
    ['Rides in previous 28 days (same sport)', progressSummary?.rides_28_days],
    ['Active days in previous 28 days', progressSummary?.active_days_28_days],
    ['Last Comparable Activity', progressSummary?.last_activity_date
      ? new Date(progressSummary.last_activity_date).toLocaleDateString() : null],
  ]);
  const recordFields = formatFieldsSkippingEmpty([
    ['Best Speed', formatPositive(progressSummary?.best_speed_kmh, 1), 'km/h'],
    ['Best Elevation Gain', formatPositive(progressSummary?.best_elevation_m, 0), 'm'],
  ]);
  const summaryContext = progressSummary?.trainingContext
    ? buildTrainingHistoryContext(progressSummary.trainingContext)
    : hasBaseline
    ? joinNonEmpty([
      baselineFields ? `**Comparable Prior Training Baseline:**\n${baselineFields}` : null,
      loadFields ? `**Recent Prior Training Load (7 days before this workout, all ride distances):**\n${loadFields}` : null,
      recordFields ? `**Personal Records Among Comparable Rides Before This Workout:**\n${recordFields}` : null,
    ], '\n\n')
    : joinNonEmpty(['**Comparable Training History:** No earlier activities within 75%-125% of this workout\'s distance are available. This workout establishes the initial baseline for rides of this distance.',
      loadFields ? `**Recent Imported Activity Context (independent of distance matching):**\n${loadFields}` : null], '\n\n');
  // The full previous-analysis text is a fallback: the structured history rows already carry its
  // summary, and this ride's own last analysis only needs full text when nothing was parsed.
  const priorAnalysisContext = String(previousAnalysis || '').trim() && !recentHistory?.some((entry) => entry.analysisSummary)
    ? `**Previous Workout Analysis (AI hypothesis, not evidence):**\n${String(previousAnalysis).trim()}`
    : '';
  const safeFollowUpHistory = formatConversation(followUpHistory);
  const followUpContext = safeFollowUpHistory
    ? `**Follow-up Conversation About This Analysis:**\n${safeFollowUpHistory}`
    : '';
  const zoneContext = buildZoneContext(fitData.records, heartRateConfig);
  const sessionClassContext = buildSessionClassContext(fitData.sessionClass, heartRateConfig);
  const segmentContext = buildSegmentContext(fitData.segments, { records: fitData.records, sport: session.sport }).text;
  const historyContext = buildRecentHistoryContext(recentHistory);
  const hasSegments = Boolean(segmentContext);
  const hasRouteStretches = Boolean(fitData.segments?.some((segment) => segment.routeStretches?.length));

  // Data first, interpretation rules last: without a system role, closeness to the question is the only lever.
  const body = joinNonEmpty([
    joinNonEmpty([`**This Workout:**\n${workoutFields}`, buildSessionNotesBlock(fitData.sessionNotes), buildInferredNotesBlock(fitData.inferredNotes, fitData.sessionNotes), segmentContext], '\n\n'),
    buildLapContext(fitData),
    powerSource === 'estimated from motion data'
      ? '**Data Quality Note:** Whole-ride power is estimated from motion and is not supplied as a reliable training-load metric. Any vpower shown for climbs is only a rough terrain-specific estimate; do not treat it as measured power.'
      : null,
    summaryContext,
    heartRateProfileContext,
    zoneContext,
    sessionClassContext,
    buildPeakHeartRateContext(fitData.records, progressSummary?.trainingContext),
    buildAltitudeQualityBlock(null, fitData.qualityFlags),
    buildDataQualityContext(fitData, heartRateConfig),
    reportedHeartRateContext,
    historyContext,
    priorAnalysisContext,
    followUpContext,
  ], '\n\n');

  const dataNotes = [
    progressSummary?.trainingContext
      ? null
      : `There are ${priorActivityCount} earlier activities within 75%-125% of this workout's distance. ${hasBaseline ? 'A comparison against these distance-compatible rides is possible, but distance alone does not establish comparable effort, terrain or conditions.' : 'Do not infer a distance-compatible baseline; describe this workout on its own and use any separately supplied recent context.'}`,
    hasTrendEvidence && !progressSummary?.trainingContext
      ? 'Activity counts alone do not establish a fitness trend; supplied speed/HR trends are descriptive and confounded by terrain, intensity and conditions.'
      : !progressSummary?.trainingContext ? 'There is not enough history to claim improvement, decline, stability, consistency, or a plateau.' : null,
    hasHeartRateProfile
      ? 'Use the supplied dated heart-rate profile and time-in-zone distribution for zone statements; do not substitute generic thresholds.'
      : 'Do not assign HR zones because no athlete-specific thresholds or maximum HR are supplied.',
    reportedHeartRateContext
      ? 'User-reported HR values are a summary from another device, not a measurement of this recording: treat them as an approximate indication of internal response and never as zone time, peaks or load.'
      : null,
    heartRateConfig?.lthr
      ? 'hrTSS uses the user-tested lactate threshold HR from the dated profile.'
      : 'hrTSS uses an estimated threshold HR (middle of the Threshold zone), not a tested LTHR; treat it as approximate.',
    historyContext
      ? 'Entries under Recent Activity History include facts and past analyses of other workouts, not measurements of this one; past analyses are revisable hypotheses. User messages about other workouts appear only under Dated User Context.'
      : null,
    progressSummary?.trainingContext?.routeContext
      ? 'A pattern shared by nearly every ride of this route, or stated in the user\'s route note or shown in the Route Profile (a climb, a stretch that is slow in one direction and fast in the other), is a property of the route, not a finding of the day and not an open question; use only how this ride differs from it.'
      : null,
    fitData.sessionNotes
      ? null
      : notesSuggestedRecently(recentHistory)
        ? 'No session notes for this ride. Notes were already suggested in recent analyses; do not suggest them again.'
        : 'No session notes (RPE, purpose, conditions) are recorded for this ride. They are entered in the Session Notes section of the activity page. Suggest recording them only when that is the most useful next step, and then as a data suggestion, not as pacing advice.',
    hasRouteStretches
      ? 'Where a flat segment is broken down by route stretch, the speed change between stretches belongs to the route; treat only the deviation from typical speed and the HR change as this ride\'s facts. Do not list the cause of a route-typical speed change as an open question.'
      : null,
    hasSegments
      ? 'Segments state which signal their effort is based on. Never compare a vpower-based segment with an HR-based segment by raw numbers, and draw no effort conclusions on segments marked technical or stopped.'
      : null,
  ].filter(Boolean).map((note) => `- ${note}`).join('\n');

  const sportCue = sportPromptAdditions(normalizeSport(session.sport, session.sub_sport));
  const instructions = `Analyze this ${session.sport || 'sports'} activity as a thoughtful sports coach in the context of the athlete's evolving practice. An activity may be recreational, have several goals, or have no stated goal. Use only the supplied workout and prior-history data; never use later activities. This is a fresh analysis of this activity, not an answer to an archived question.${sportCue ? ` ${sportCue}` : ''}

**Principles:**
${ANALYSIS_PRINCIPLES.map((principle, index) => `${index + 1}. ${principle}`).join('\n')}

${ANALYSIS_VOICE}

**Notes for This Data:**
${dataNotes}

${responseLanguageInstruction(locale)}

${SUMMARY_TAIL_INSTRUCTION}`;

  const data = `${body}

**Questions for Analysis:**
1. **Session Character and Stimulus**: Classify the session type from the evidence and name the qualities it likely stimulates. Distinguish observed work from inferred direction and stated intentions.
2. **Execution and Comparable Segments**: What matters about pacing, sustained work, changes within segments, repeats and interruptions? Use peak sustained HR against prior bests where it adds information. Explain differences and limits of any candidate comparisons.
3. **Current Training Direction**: What patterns, stimulus mix across session types and intensity distribution, or possible phase changes are supported by the dated history? Consider multiple simultaneous priorities; discuss fitness or recovery only where evidence permits.
4. **Practical Next Step**: Recommend the option best supported by the observed pattern and dated user context, with the reason. Choose what this activity most informs: execution (pacing, climbs, starts, stops), route or format choice, data capture, or next-session load. If recent analyses already gave the same load advice and the pattern is unchanged, do not restate it; pick another relevant point. Add one number worth watching next time on this route when same-route data exist. Add an alternative only if a specific plausible circumstance would change the advice; do not branch on hypothetical goals by default. Not a universal progression plan.

Answer the four questions in order under your own short headings, 2-4 plain sentences each, in the voice described above. Explain what the numbers mean for the athlete rather than retelling the input. Do not fill unsupported topics with boilerplate or mandatory recovery claims.`;
  return { instructions, data };
}

function generateAnalysisPrompt(...args) {
  const { instructions, data } = generateAnalysisPromptParts(...args);
  return `${instructions}\n\n${data}`;
}

// Numbered coaching principles shared by the main, chat and comparison prompts. The SUMMARY tail
// and answer-format instructions are separate and only used by the one-off analysis prompt.
function renderPrinciples() {
  return ANALYSIS_PRINCIPLES.map((principle, index) => `${index + 1}. ${principle}`).join('\n');
}

// One line stating whether two rides share a route, from matchRoutes. No line when GPS is absent.
function describeRouteRelation(relation) {
  if (!relation || relation.type === 'different') return null;
  const direction = relation.type === 'same' ? 'same direction' : relation.type === 'reversed' ? 'opposite direction' : 'partial overlap';
  return `Route relation: same route, ${direction} (${relation.detail}).`;
}

// A checkpoint comparison table, only for rides on the same route: marks are aligned by rounded
// distance so a slightly different total (wheel sensor) still matches. Returns '' when the marks
// cannot be aligned (different routes) or there is nothing to compare.
function buildCheckpointComparisonTable(aCheckpoints, bCheckpoints, relation = { type: 'same' }) {
  const listA = Array.isArray(aCheckpoints) ? aCheckpoints : [];
  const listB = Array.isArray(bCheckpoints) ? bCheckpoints : [];
  if (!listA.length || !listB.length) return '';
  // Marks sit at each ride's own segment boundaries, so they are paired by place on the road
  // (GPS within 150 m and about the same position along the route, direction reflected), never by
  // ordinal position: a loop runs close to itself, and place alone would pair different legs.
  const lengthA = listA.reduce((max, row) => (Number.isFinite(row.km) && row.km > max ? row.km : max), 0);
  const lengthB = listB.reduce((max, row) => (Number.isFinite(row.km) && row.km > max ? row.km : max), 0);
  const reversed = relation.type === 'reversed';
  const distanceM = (a, b) => {
    const axisKm = priorKmOnAxis(b, lengthB, lengthA, reversed);
    if (axisKm != null && Number.isFinite(a.km) && Math.abs(axisKm - a.km) > 1) return Infinity;
    if ([a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return haversineM(a.lat, a.lon, b.lat, b.lon);
    return axisKm != null && Number.isFinite(a.km) ? Math.abs(axisKm - a.km) * 1000 : Infinity;
  };
  const rows = listA.map((checkpoint) => {
    const other = listB.reduce((best, candidate) => {
      const d = distanceM(checkpoint, candidate);
      return !best || d < best.d ? { candidate, d } : best;
    }, null)?.candidate;
    if (!other || distanceM(checkpoint, other) > 150) return null;
    const time = `${formatHms(checkpoint.elapsedS)} / ${formatHms(other.elapsedS)}`;
    const hr = checkpoint.avgHr != null && other.avgHr != null ? `, HR ${checkpoint.avgHr} / ${other.avgHr}` : '';
    return `- km ${checkpoint.km}: ${time}${hr}`;
  }).filter(Boolean);
  if (rows.length < 2) return '';
  return `**Checkpoints (This Workout / Compared Activity; paired by place, each ride's own marks):**\n${rows.join('\n')}`;
}

function generateAnalysisChatPrompt(fitData, progressSummary, heartRateConfig, baseAnalysis, history, userQuestion, locale) {
  const session = fitData.sessions?.[0] || {};
  const { text: workoutFields, powerSource } = buildWorkoutFields(session, fitData.records, fitData.altitudeSettlingWindow);
  const safeHistory = formatConversation(history);
  const segmentContext = buildSegmentContext(fitData.segments, { records: fitData.records, sport: session.sport }).text;

  // Route context and profile arrive through buildTrainingHistoryContext; they are not repeated here.
  const hasRouteStretches = Boolean(fitData.segments?.some((segment) => segment.routeStretches?.length));

  const body = joinNonEmpty([
    `Workout facts for this activity:\n${workoutFields}`,
    buildSessionNotesBlock(fitData.sessionNotes),
    buildInferredNotesBlock(fitData.inferredNotes, fitData.sessionNotes),
    buildDataQualityFlagBlock(fitData.qualityFlags),
    buildHeartRateProfileContext(heartRateConfig),
    buildZoneContext(fitData.records, heartRateConfig),
    buildPeakHeartRateContext(fitData.records, progressSummary?.trainingContext),
    buildDataQualityContext(fitData, heartRateConfig),
    buildReportedHeartRateContext(session),
    buildLapContext(fitData),
    buildTrainingHistoryContext(progressSummary?.trainingContext),
    buildRecentHistoryContext(progressSummary?.trainingContext?.recentHistory),
    powerSource === 'estimated from motion data'
      ? '**Data Quality Note:** Whole-ride power is estimated from motion and is not supplied as a reliable training-load metric. Any vpower shown for climbs is only a rough terrain-specific estimate; do not treat it as measured power.'
      : null,
    segmentContext,
    `Initial analysis (AI hypothesis to re-evaluate):\n${baseAnalysis || 'No current initial analysis is available.'}`,
    `Conversation so far:\n${safeHistory || '(no previous messages)'}`,
  ], '\n\n');

  return `You are continuing a sports coaching discussion about a ${session.sport || 'sports'} activity and the athlete's evolving practice. Address the user's question rather than repeating a fixed report.

${body}

Latest user question:
${String(userQuestion || '').trim()}

**Coaching Principles:**
${renderPrinciples()}

${ANALYSIS_VOICE}

Rules:
- Use provided workout/history facts; do not invent personal circumstances or later activities.
- hrTSS uses an estimated threshold HR (middle of the Threshold zone), not a directly tested LTHR value; treat it as approximate.
- User-reported HR values, when present, are a summary from another device, not a measurement of this recording: treat them as an approximate indication and never as zone time, peaks or load.
- If the user says the route was not flat, explicitly use elevation gain/loss context and explain what can and cannot be inferred without full grade distribution.
- Do not end your answer with a SUMMARY tail; answer in prose only.${segmentContext ? '\n- Never compare a vpower-based segment with an HR-based segment by raw numbers, and draw no effort conclusions on segments marked technical or stopped.' : ''}${hasRouteStretches ? '\n- When asked why speed changed inside a flat segment, first use the route-stretch breakdown: a change that matches the typical speed for this direction belongs to the route, and only the deviation from typical and the HR change are this ride\'s facts.' : ''}
- Be specific and concise. Answer the question directly; go longer only when the question genuinely needs the detail.
- If the data is insufficient for a claim, say so and ask one clarifying follow-up.
${sportsEvidenceRules().map((rule) => `- ${rule}`).join('\n')}

Answer concisely; length follows the question rather than a fixed sentence count.
${responseLanguageInstruction(locale, true)}`;
}

// Directed: "This Workout" is the activity under review, "Another Compared Activity" is what it is checked against.
function generateComparisonPrompt(fitData, comparedFitData, locale) {
  const session = fitData.sessions?.[0] || {};
  const comparedSession = comparedFitData.sessions?.[0] || {};
  const { text: workoutFields, powerSource } = buildWorkoutFields(session, fitData.records);
  const { text: comparedWorkoutFields, powerSource: comparedPowerSource } = buildWorkoutFields(comparedSession, comparedFitData.records);
  const segmentContext = buildSegmentContext(collapseShortStops(fitData.segments), { records: fitData.records, sport: session.sport }).text;
  const comparedSegmentContext = buildSegmentContext(collapseShortStops(comparedFitData.segments), { records: comparedFitData.records, sport: comparedSession.sport }).text;
  const hasSegments = Boolean(segmentContext) || Boolean(comparedSegmentContext);

  // Route relation and (only on the same route) an aligned checkpoint table. A different route
  // means checkpoints are not compared at all.
  const relation = matchRoutes(buildRouteSignature(fitData.records), buildRouteSignature(comparedFitData.records));
  const sameRoute = relation.type === 'same' || relation.type === 'reversed';
  const routeRelationLine = describeRouteRelation(relation);
  const checkpointTable = sameRoute
    ? buildCheckpointComparisonTable(computeCheckpoints(fitData.records, fitData.segments), computeCheckpoints(comparedFitData.records, comparedFitData.segments), relation)
    : '';

  const dataQualityNote = (label, source) => (source === 'estimated from motion data'
    ? `**Data Quality Note (${label}):** Whole-ride power is estimated from motion and is not supplied as a reliable training-load metric. Any vpower shown for climbs is only a rough terrain-specific estimate; do not treat it as measured power.`
    : null);

  // Zone context under a profile name lets the model see that the two dates may use different thresholds.
  const labelProfile = (config) => buildHeartRateProfileContext(config)
    .replace('Effective for This Workout:', `Effective for This Comparison (${config?.effectiveDate || 'legacy setting'}):`);

  const body = joinNonEmpty([
    joinNonEmpty([`**This Workout:**\n${workoutFields}`, segmentContext], '\n\n'),
    buildSessionNotesBlock(fitData.sessionNotes),
    buildInferredNotesBlock(fitData.inferredNotes, fitData.sessionNotes),
    buildDataQualityFlagBlock(fitData.qualityFlags),
    dataQualityNote('This Workout', powerSource),
    labelProfile(fitData.analysisHeartRateConfig),
    buildZoneContext(fitData.records, fitData.analysisHeartRateConfig),
    buildPeakHeartRateContext(fitData.records, null, 'This Workout'),
    buildDataQualityContext(fitData),
    buildReportedHeartRateContext(session),
    buildLapContext(fitData),
    joinNonEmpty([`**Another Compared Activity:**\n${comparedWorkoutFields}`, comparedSegmentContext], '\n\n'),
    buildSessionNotesBlock(comparedFitData.sessionNotes),
    buildInferredNotesBlock(comparedFitData.inferredNotes, comparedFitData.sessionNotes),
    buildDataQualityFlagBlock(comparedFitData.qualityFlags),
    dataQualityNote('Compared Activity', comparedPowerSource),
    labelProfile(comparedFitData.analysisHeartRateConfig),
    buildZoneContext(comparedFitData.records, comparedFitData.analysisHeartRateConfig),
    buildPeakHeartRateContext(comparedFitData.records, null, 'Compared Activity'),
    buildDataQualityContext(comparedFitData),
    buildReportedHeartRateContext(comparedSession),
    buildLapContext(comparedFitData),
    routeRelationLine,
    checkpointTable,
  ], '\n\n');

  const evidenceRules = [
    'This is a directed comparison: "This Workout" is the primary activity being reviewed; "Another Compared Activity" is only the reference it is compared against. Do not treat the two as interchangeable or the comparison as symmetric.',
    'The two activities may have been analysed under different dated heart-rate profiles with different zone thresholds; an equal heart rate then does not mean an equal relative intensity. Check the supplied profile dates and thresholds before comparing zone time or HR values.',
    'Do not assume segments correspond by their list position or index. Segment boundaries can differ between the two activities (for example, a stop may split one activity\'s segment into two while the other has a single continuous one) — align them by sequence, cumulative distance/duration and effort profile instead.',
    'A segment noted as interrupted by a stop is already merged across that stop into one logical segment for this comparison; treat it as continuous, not as two.',
    hasSegments
      ? 'Never compare a vpower-based segment with an HR-based segment by raw numbers, and draw no effort conclusions on segments marked technical or stopped.'
      : null,
    'Use only the supplied facts for both activities. Similar distance does not establish comparability; discuss route, terrain, structure, intensity and source quality separately. Equal HR/power is not required to identify candidate corresponding segments.',
    ...sportsEvidenceRules(),
  ].filter(Boolean).map((rule) => `- ${rule}`).join('\n');

  return `Compare "This Workout" against "Another Compared Activity" segment by segment, focusing on differences in pacing, effort and terrain handling.${checkpointTable ? ' The two rides are on the same route: prefer the checkpoint table over raw speed for the route-level verdict.' : routeRelationLine ? ' The two rides overlap only partly, so checkpoints are not compared; align segments by sequence and distance.' : ' The two rides are not on the same route, so compare segment structure and intensity without a checkpoint table.'}

${body}

**Coaching Principles:**
${renderPrinciples()}

${ANALYSIS_VOICE}

**Evidence Rules:**
${evidenceRules}

Provide a concise, actionable comparison (4-6 sentences) highlighting where the two workouts diverge and why that might matter for training.
${responseLanguageInstruction(locale)}`;
}

function formatActivityDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: null, time: null };
  }
  return {
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 19) + ' UTC',
  };
}

function averageTemperature(records) {
  const temperatures = Array.isArray(records)
    ? records
      .filter((record) => record?.temperature !== null && record?.temperature !== undefined && record?.temperature !== '')
      .map((record) => Number(record.temperature))
      .filter((temperature) => Number.isFinite(temperature))
    : [];
  if (!temperatures.length) {
    return null;
  }
  const average = temperatures.reduce((sum, temperature) => sum + temperature, 0) / temperatures.length;
  return average.toFixed(1);
}

module.exports = {
  buildHeartRateProfileContext,
  buildRecentHistoryContext,
  buildReportedHeartRateContext,
  buildSegmentContext,
  buildSessionClassContext,
  buildTrainingHistoryContext,
  buildAltitudeQualityBlock,
  buildRouteContextBlock,
  buildRouteProfileBlock,
  formatFieldsSkippingEmpty,
  generateAnalysisPrompt,
  generateAnalysisPromptParts,
  generateAnalysisChatPrompt,
  generateComparisonPrompt,
  requestCopilotAnalysis,
  responseLanguageInstruction,
  selectPreferredModel,
  summarizePromptBlocks,
};
