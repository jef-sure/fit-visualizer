const { formatHms, groupSimilarSegments, segmentLineBudget } = require('./utils');
const { computeHeartRateZones } = require('./heart-rate');

function formatPositive(value, digits) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num.toFixed(digits) : null;
}

function formatNonZero(value, digits) {
  const num = Number(value);
  return Number.isFinite(num) && num !== 0 ? num.toFixed(digits) : null;
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

function describeSegment(segment) {
  if (segment.type === 'stopped') {
    return 'stopped';
  }
  // The basis is implied by which metric is quoted, so it is explained once per block instead of per line.
  return joinNonEmpty([
    segment.type,
    segment.technical ? 'technical, no reliable effort estimate' : null,
    segment.avgGrade != null ? `avg grade ${segment.avgGrade}%` : null,
    segmentEffortText(segment),
    segment.avgHr != null && segment.effortBasis !== 'hr' ? `avg HR ${segment.avgHr}` : null,
    segment.hrDriftPct != null ? `HR drift ${segment.hrDriftPct > 0 ? '+' : ''}${segment.hrDriftPct}%` : null,
    segment.avgSpeedKmh != null ? `${segment.avgSpeedKmh} km/h` : null,
    segment.elevGainM ? `+${segment.elevGainM} m` : null,
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
    pattern.push(joinNonEmpty([
      `~${formatClock(durations.reduce((sum, value) => sum + value, 0) / durations.length)}`,
      sample.type,
      effortRange ? `${sample.effortBasis === 'hr' ? 'HR' : sample.effortBasis} ${effortRange}` : null,
    ], ' '));
  }
  return `${row.repeats}x [ ${pattern.join(' | ')} ]`;
}

function buildSegmentContext(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) {
    return { text: '', lines: 0, maxLines: 0, exceeded: false };
  }

  const notableStopSeconds = Number(options.notableStopSeconds) || 300;
  const shortStops = list.filter((segment) => segment.type === 'stopped' && segment.durationS < notableStopSeconds);
  const shortStopIndexes = new Set(shortStops.map((segment) => segment.index));
  const rows = groupSimilarSegments(list.filter((segment) => !shortStopIndexes.has(segment.index)), options);

  const lines = rows.map((row) => {
    const members = row.kind === 'repeat' ? row.members : [row.segment];
    const first = members[0];
    const last = members[members.length - 1];
    const span = `${formatHms(first.startElapsed)}-${formatHms(last.endElapsed)}`;
    const body = row.kind === 'repeat' ? describeRepeat(row) : describeSegment(first);
    return `${span} (${formatClock(last.endElapsed - first.startElapsed)}) ${body}`;
  });

  if (shortStops.length) {
    const total = shortStops.reduce((sum, segment) => sum + segment.durationS, 0);
    const longest = Math.max(...shortStops.map((segment) => segment.durationS));
    lines.push(`Plus ${shortStops.length} short stops, ${formatClock(total)} total (longest ${formatClock(longest)})`);
  }

  const totalDuration = Math.max(...list.map((segment) => segment.endElapsed)) - list[0].startElapsed;
  const maxLines = segmentLineBudget(totalDuration, options);
  const numbered = lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
  const bases = new Set(list.map((segment) => segment.effortBasis));
  const notes = [
    bases.has('vpower') && bases.has('hr')
      ? 'Effort basis is implied by the metric quoted: vpower only on climbs, where gravity dominates and the physical model is trustworthy; heart rate everywhere else.'
      : null,
    'Segments marked technical or stopped have no reliable effort estimate; never compare vpower numbers against HR numbers directly.',
  ].filter(Boolean).join('\n');

  return {
    text: `**Segment Breakdown:**\n${numbered}\n${notes}`,
    lines: lines.length,
    maxLines,
    exceeded: lines.length > maxLines,
  };
}

function buildRecentHistoryContext(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    return '';
  }

  const detailedCount = Number(options.detailedCount) || 4;
  const detailedFrom = Math.max(0, list.length - detailedCount);
  const rendered = list.map((entry, index) => {
    const date = String(entry.startTime || '').slice(0, 10);
    const summary = joinNonEmpty([
      entry.distanceKm != null ? `${Number(entry.distanceKm).toFixed(1)} km` : null,
      entry.durationS != null ? formatHms(Math.round(entry.durationS)) : null,
      entry.trainingStressScore != null ? `TSS ${Number(entry.trainingStressScore).toFixed(0)}` : null,
    ]);

    if (index < detailedFrom) {
      return `${date}: ${summary || 'analysed'}`;
    }
    const chatNote = entry.chatCount ? `\n  (follow-up chat: ${entry.chatCount} questions)` : '';
    return `${date}${summary ? ` (${summary})` : ''}:\n${String(entry.analysisText || '').trim()}${chatNote}`;
  });

  return `**Recent Activity History (earlier workouts, oldest first):**\n${rendered.join('\n\n')}`;
}

function buildZoneContext(records, heartRateConfig) {
  const hasProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const zoneData = hasProfile
    ? computeHeartRateZones(Array.isArray(records) ? records : [], heartRateConfig.maxHeartRate, heartRateConfig.thresholds)
    : { enabled: false };
  if (!zoneData.enabled || !(zoneData.totalSeconds > 0)) {
    return '**Time in Heart-Rate Zones:** Not available.';
  }
  const lines = zoneData.zones
    .map((zone) => `- ${zone.name} (${zone.range}): ${formatHms(zone.seconds)} (${zone.percent.toFixed(0)}%)`)
    .join('\n');
  return `**Time in Heart-Rate Zones (percentages cover time at/above 50% of max HR; time below is excluded):**\n${lines}`;
}

async function requestCopilotAnalysis(vscode, prompt, options = {}) {
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Number(options.retryDelayMs) : 1200;
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? options.maxRetries
    : 1;
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    throw new Error('Copilot Chat is not installed or you are not signed in.');
  }

  // Copilot may hand out different models over time, so the log has to record which one answered.
  const modelId = models[0].id || models[0].family || 'unknown';
  const report = async (result) => {
    try {
      await options.onCompleted?.({ modelId, prompt, ...result });
    } catch {
      // Logging must never break an analysis.
    }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await models[0].sendRequest([
        vscode.LanguageModelChatMessage.User(prompt),
      ]);
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

  return { totalChars: text.length, blocks: blocks.filter((block) => block.chars > 0) };
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

function generateAnalysisPrompt(fitData, progressSummary, heartRateConfig, previousAnalysis, followUpHistory, recentHistory) {
  const session = fitData.sessions?.[0] || {};
  const activityDateTime = formatActivityDateTime(session.start_time);
  const powerSource = session.power_source === 'estimated'
    ? 'estimated from motion data'
    : session.power_source === 'measured' ? 'measured' : null;
  const workoutFields = formatFieldsSkippingEmpty([
    ['Date', activityDateTime.date],
    ['Start Time', activityDateTime.time],
    ['Average Temperature', averageTemperature(fitData.records), 'C'],
    ['Distance', session.total_distance_km?.toFixed(2), 'km'],
    ['Duration (timer)', session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : null],
    ['Elapsed Time (incl. stops)', session.total_elapsed_s ? formatHms(Math.round(session.total_elapsed_s)) : null],
    ['Avg Speed', formatPositive(session.avg_speed_kmh, 2), 'km/h'],
    ['Max Speed', formatPositive(session.max_speed_kmh, 2), 'km/h'],
    ['Avg Cadence', formatPositive(session.avg_cadence, 0), 'rpm'],
    ['Calories', formatPositive(session.total_calories, 0), 'kcal'],
    ['Average Power', formatPositive(session.avg_power, 0), 'W'],
    ['Max Power', formatPositive(session.max_power, 0), 'W'],
    ['Normalized Power', formatPositive(session.normalized_power, 0), 'W'],
    ['FTP Used for Power Metrics', formatPositive(session.ftp, 0), 'W'],
    ['Intensity Factor', formatPositive(session.intensity_factor, 2)],
    ['TSS', formatPositive(session.training_stress_score, 1)],
    ['xPower (GC)', formatPositive(session.xpower, 0), 'W'],
    ['RI (GC)', formatPositive(session.relative_intensity_gc, 2)],
    ['BikeStress (GC)', formatPositive(session.bike_stress_score, 1)],
    ['Decoupling % (Intervals)', formatNonZero(session.decoupling_pct, 1)],
    ['TRIMP', formatPositive(session.trimp, 1)],
    ['hrTSS', formatPositive(session.hr_tss, 1)],
    ['Avg Heart Rate', formatPositive(session.avg_hr, 0), 'bpm'],
    ['Max Heart Rate', formatPositive(session.max_hr, 0), 'bpm'],
    ['Elevation Gain', formatPositive(session.total_ascent_m, 0), 'm'],
    ['Elevation Loss', formatPositive(session.total_descent_m, 0), 'm'],
    ['Power source', powerSource],
  ]);
  const priorActivityCount = Number(progressSummary?.total_activities || 0);
  const hasBaseline = priorActivityCount > 0;
  const hasTrendEvidence = priorActivityCount >= 3;
  const hasHeartRateProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const heartRateProfileContext = hasHeartRateProfile
    ? `**Heart Rate Profile Effective for This Workout:**\n${formatFieldsSkippingEmpty([
      ['Effective Date', heartRateConfig.effectiveDate || 'legacy setting'],
      ['Maximum HR', heartRateConfig.maxHeartRate, 'bpm'],
      ['Zone 2-5 Starts', Array.isArray(heartRateConfig.thresholds)
        ? `${heartRateConfig.thresholds.join(', ')} bpm`
        : 'derived at 60%, 70%, 80%, and 90% of max HR'],
    ])}`
    : '**Heart Rate Profile:** No personal maximum HR or zone thresholds are available.';
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
    ['28-day Ride Count (all distances)', progressSummary?.consistency_pct != null
      ? `${progressSummary.consistency_pct.toFixed(0)}% of a 16-ride benchmark` : null],
    ['Last Comparable Activity', progressSummary?.last_activity_date
      ? new Date(progressSummary.last_activity_date).toLocaleDateString() : null],
  ]);
  const recordFields = formatFieldsSkippingEmpty([
    ['Best Speed', formatPositive(progressSummary?.best_speed_kmh, 1), 'km/h'],
    ['Best Elevation Gain', formatPositive(progressSummary?.best_elevation_m, 0), 'm'],
  ]);
  const summaryContext = hasBaseline
    ? joinNonEmpty([
      baselineFields ? `**Comparable Prior Training Baseline:**\n${baselineFields}` : null,
      loadFields ? `**Recent Prior Training Load (7 days before this workout, all ride distances):**\n${loadFields}` : null,
      recordFields ? `**Personal Records Among Comparable Rides Before This Workout:**\n${recordFields}` : null,
    ], '\n\n')
    : '**Comparable Training History:** No earlier activities within 75%-125% of this workout\'s distance are available. This workout establishes the initial baseline for rides of this distance.';
  const priorAnalysisContext = String(previousAnalysis || '').trim()
    ? `**Previous Analysis:**\n${String(previousAnalysis).trim()}`
    : '';
  const safeFollowUpHistory = Array.isArray(followUpHistory)
    ? followUpHistory
      .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
      .slice(-8)
      .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${String(entry.content || '').trim()}`)
      .filter((line) => line.length > 0)
    : [];
  const followUpContext = safeFollowUpHistory.length
    ? `**Follow-up Conversation About This Analysis:**\n${safeFollowUpHistory.join('\n')}`
    : '';
  const zoneContext = buildZoneContext(fitData.records, heartRateConfig);
  const segmentContext = buildSegmentContext(fitData.segments).text;
  const historyContext = buildRecentHistoryContext(recentHistory);
  const hasSegments = Boolean(segmentContext);

  // Data first, interpretation rules last: without a system role, closeness to the question is the only lever.
  const body = joinNonEmpty([
    `**This Workout:**\n${workoutFields}`,
    powerSource === 'estimated from motion data'
      ? '**Data Quality Note:** Power metrics are motion-estimated (from speed, altitude, and mass) and may be physiologically implausible, especially peak values. These figures and derived metrics (NP, IF, TSS, xPower, RI, BikeStress, Decoupling) should be disregarded for training-load decisions. Use heart-rate trends and effort perception instead.'
      : null,
    summaryContext,
    heartRateProfileContext,
    zoneContext,
    historyContext,
    segmentContext,
    priorAnalysisContext,
    followUpContext,
  ], '\n\n');

  const evidenceRules = [
    'Use only the supplied workout and prior-history data. Never use later activities.',
    `There are ${priorActivityCount} earlier activities within 75%-125% of this workout's distance. Rides outside that range are excluded from all comparisons. ${hasBaseline ? 'A comparison against these distance-compatible rides is possible.' : 'Do not compare this workout to a baseline; describe it as the initial baseline for rides of this distance.'}`,
    hasTrendEvidence
      ? 'There are enough prior activities for cautious trend observations, but only when the supplied trend fields support them.'
      : 'There is not enough history to claim improvement, decline, stability, consistency, or a plateau.',
    'Do not infer recovery status, aerobic control, fatigue, overreaching, or heart-rate recovery from average and maximum HR alone.',
    hasHeartRateProfile
      ? 'Use the supplied dated heart-rate profile and the supplied time-in-zone distribution for zone statements; do not substitute generic thresholds.'
      : 'Do not assign HR zones because no athlete-specific thresholds or maximum HR are supplied.',
    'Do not prescribe bpm targets from an observed peak HR. Prefer effort/RPE guidance and label it as general guidance.',
    hasSegments
      ? 'Segments state which signal their effort is based on. Never compare a vpower-based segment with an HR-based segment by raw numbers, and draw no effort conclusions on segments marked technical or stopped.'
      : null,
    historyContext
      ? 'Entries under Recent Activity History are past analyses of other workouts, not measurements of this one; treat them as chronology.'
      : null,
    'State data limitations directly instead of filling gaps with plausible claims.',
    'Fields that are absent were not measured. Do not speculate about them.',
  ].filter(Boolean).map((rule) => `- ${rule}`).join('\n');

  return `Analyze this cycling workout in context of my training progress.

${body}

**Evidence Rules:**
${evidenceRules}

**Questions for Analysis:**
1. **Baseline Context**: What can responsibly be said relative to the available prior history?
2. **Fitness Trend**: Is there enough evidence to assess a trend? If not, say what future data would make this possible.
3. **Heart Rate & Recovery**: Describe only what the supplied HR summary shows and what cannot be inferred from it.
4. **Recommendations**: What should I focus on for the next rides?

Provide a concise, actionable analysis with 2-3 sentences per question. Do not repeat the input data verbatim.`;
}

function generateAnalysisChatPrompt(fitData, progressSummary, heartRateConfig, baseAnalysis, history, userQuestion) {
  const session = fitData.sessions?.[0] || {};
  const activityDateTime = formatActivityDateTime(session.start_time);
  const priorActivityCount = Number(progressSummary?.total_activities || 0);
  const hasHeartRateProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const powerSource = session.power_source === 'estimated'
    ? 'estimated from motion data'
    : session.power_source === 'measured' ? 'measured' : null;
  const workoutFields = formatFieldsSkippingEmpty([
    ['Date', activityDateTime.date],
    ['Start time', activityDateTime.time],
    ['Average temperature', averageTemperature(fitData.records), 'C'],
    ['Distance', session.total_distance_km?.toFixed(2), 'km'],
    ['Duration', session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : null],
    ['Avg speed', formatPositive(session.avg_speed_kmh, 2), 'km/h'],
    ['Max speed', formatPositive(session.max_speed_kmh, 2), 'km/h'],
    ['Average power', formatPositive(session.avg_power, 0), 'W'],
    ['Max power', formatPositive(session.max_power, 0), 'W'],
    ['Normalized power', formatPositive(session.normalized_power, 0), 'W'],
    ['FTP used for power metrics', formatPositive(session.ftp, 0), 'W'],
    ['Intensity factor', formatPositive(session.intensity_factor, 2)],
    ['TSS', formatPositive(session.training_stress_score, 1)],
    ['xPower (GC)', formatPositive(session.xpower, 0), 'W'],
    ['RI (GC)', formatPositive(session.relative_intensity_gc, 2)],
    ['BikeStress (GC)', formatPositive(session.bike_stress_score, 1)],
    ['Decoupling % (Intervals)', formatNonZero(session.decoupling_pct, 1)],
    ['TRIMP', formatPositive(session.trimp, 1)],
    ['hrTSS', formatPositive(session.hr_tss, 1)],
    ['Avg heart rate', formatPositive(session.avg_hr, 0), 'bpm'],
    ['Max heart rate', formatPositive(session.max_hr, 0), 'bpm'],
    ['Elevation gain', formatPositive(session.total_ascent_m, 0), 'm'],
    ['Elevation loss', formatPositive(session.total_descent_m, 0), 'm'],
    ['Power source', powerSource],
    ['Comparable prior activities', priorActivityCount],
    ['HR profile', hasHeartRateProfile
      ? `max HR ${heartRateConfig.maxHeartRate} bpm, zones ${Array.isArray(heartRateConfig.thresholds) ? heartRateConfig.thresholds.join(', ') : 'auto-derived'}`
      : null],
  ]);
  const safeHistory = Array.isArray(history)
    ? history
      .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
      .slice(-8)
      .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${String(entry.content || '').trim()}`)
      .filter((line) => line.length > 0)
    : [];
  const segmentContext = buildSegmentContext(fitData.segments).text;

  const body = joinNonEmpty([
    `Workout facts for this activity:\n${workoutFields}`,
    buildZoneContext(fitData.records, heartRateConfig),
    powerSource === 'estimated from motion data'
      ? '**Data Quality Note:** Power metrics are motion-estimated (from speed, altitude, and mass) and may be physiologically implausible, especially peak values. These figures and derived metrics (NP, IF, TSS, xPower, RI, BikeStress, Decoupling) should be disregarded for training-load decisions. Use heart-rate trends and effort perception instead.'
      : null,
    segmentContext,
    `Initial analysis:\n${baseAnalysis || 'No initial analysis has been generated yet.'}`,
    `Conversation so far:\n${safeHistory.length ? safeHistory.join('\n') : '(no previous messages)'}`,
  ], '\n\n');

  return `You are continuing a coaching chat about one cycling workout.

${body}

Latest user question:
${String(userQuestion || '').trim()}

Rules:
- Use only provided workout/history data. Fields that are absent were not measured; do not speculate about them.
- If the user says the route was not flat, explicitly use elevation gain/loss context and explain what can and cannot be inferred without full grade distribution.${segmentContext ? '\n- Never compare a vpower-based segment with an HR-based segment by raw numbers, and draw no effort conclusions on segments marked technical or stopped.' : ''}
- Be specific and concise.
- If the data is insufficient for a claim, say so and ask one clarifying follow-up.

Respond in 4-8 sentences.`;
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
      .map((record) => Number(record?.temperature))
      .filter((temperature) => Number.isFinite(temperature))
    : [];
  if (!temperatures.length) {
    return null;
  }
  const average = temperatures.reduce((sum, temperature) => sum + temperature, 0) / temperatures.length;
  return average.toFixed(1);
}

module.exports = {
  buildRecentHistoryContext,
  buildSegmentContext,
  formatFieldsSkippingEmpty,
  generateAnalysisPrompt,
  generateAnalysisChatPrompt,
  requestCopilotAnalysis,
  summarizePromptBlocks,
};
