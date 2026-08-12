const { formatHms } = require('./utils');

async function requestCopilotAnalysis(vscode, prompt, options = {}) {
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Number(options.retryDelayMs) : 1200;
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? options.maxRetries
    : 1;
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) {
    throw new Error('No Copilot language model is available. Check that GitHub Copilot Chat is installed and signed in.');
  }

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
      return analysis.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryableRateLimit = isRateLimitError(message) && attempt < maxRetries;
      if (isRetryableRateLimit) {
        await delay(retryDelayMs);
        continue;
      }
      if (isRateLimitError(message)) {
        throw new Error('Copilot rate limit reached. Please wait a bit and try Analyze again.');
      }
      throw error;
    }
  }

  throw new Error('Copilot analysis failed unexpectedly.');
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

function generateAnalysisPrompt(fitData, progressSummary, heartRateConfig, previousAnalysis, followUpHistory) {
  const session = fitData.sessions?.[0] || {};
  const activityDateTime = formatActivityDateTime(session.start_time);
  const currentStats = {
    date: activityDateTime.date,
    time: activityDateTime.time,
    temperature: averageTemperature(fitData.records),
    distance: session.total_distance_km?.toFixed(2),
    duration: session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : 'N/A',
    avgSpeed: session.avg_speed_kmh?.toFixed(2),
    maxSpeed: session.max_speed_kmh?.toFixed(2),
    normalizedPower: session.normalized_power?.toFixed(0),
    intensityFactor: Number.isFinite(Number(session.intensity_factor)) ? Number(session.intensity_factor).toFixed(2) : null,
    trainingStressScore: Number.isFinite(Number(session.training_stress_score)) ? Number(session.training_stress_score).toFixed(1) : null,
    xPower: Number.isFinite(Number(session.xpower)) ? Number(session.xpower).toFixed(0) : null,
    relativeIntensityGc: Number.isFinite(Number(session.relative_intensity_gc)) ? Number(session.relative_intensity_gc).toFixed(2) : null,
    bikeStressScore: Number.isFinite(Number(session.bike_stress_score)) ? Number(session.bike_stress_score).toFixed(1) : null,
    decouplingPct: Number.isFinite(Number(session.decoupling_pct)) ? Number(session.decoupling_pct).toFixed(1) : null,
    trimp: Number.isFinite(Number(session.trimp)) ? Number(session.trimp).toFixed(1) : null,
    hrTss: Number.isFinite(Number(session.hr_tss)) ? Number(session.hr_tss).toFixed(1) : null,
    avgHr: session.avg_hr?.toFixed(0),
    maxHr: session.max_hr?.toFixed(0),
    elevation: session.total_ascent_m?.toFixed(0),
  };
  const priorActivityCount = Number(progressSummary?.total_activities || 0);
  const hasBaseline = priorActivityCount > 0;
  const hasTrendEvidence = priorActivityCount >= 3;
  const hasHeartRateProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const heartRateProfileContext = hasHeartRateProfile
    ? `**Heart Rate Profile Effective for This Workout:**
- Effective Date: ${heartRateConfig.effectiveDate || 'legacy setting'}
- Maximum HR: ${heartRateConfig.maxHeartRate} bpm
- Zone 2-5 Starts: ${Array.isArray(heartRateConfig.thresholds) ? heartRateConfig.thresholds.join(', ') + ' bpm' : 'derived at 60%, 70%, 80%, and 90% of max HR'}`
    : '**Heart Rate Profile:** No personal maximum HR or zone thresholds are available.';
  const summaryContext = hasBaseline
    ? `
**Comparable Prior Training Baseline:**
- Eligible Prior Activities: ${priorActivityCount}
- Distance Range: ${progressSummary.comparison_min_distance_km?.toFixed(1) || 0}-${progressSummary.comparison_max_distance_km?.toFixed(1) || 0} km (75%-125% of this workout)
- Total Distance: ${progressSummary.total_distance_km?.toFixed(1) || 0} km
- Total Hours: ${progressSummary.total_hours?.toFixed(1) || 0} hrs
- Average Speed: ${progressSummary.avg_speed_kmh?.toFixed(1) || 0} km/h
- Average Heart Rate: ${progressSummary.avg_heart_rate?.toFixed(0) || 0} bpm
- Max Heart Rate Recorded: ${progressSummary.max_recorded_heart_rate?.toFixed(0) || 0} bpm

**Recent Prior Workouts (7 days before this workout):**
- Activities: ${progressSummary.recent_activity_count || 0}
- Weekly Avg Distance: ${progressSummary.weekly_avg_distance_km?.toFixed(1) || 0} km
- Weekly Avg Speed: ${progressSummary.weekly_avg_speed_kmh?.toFixed(1) || 0} km/h
- Speed Trend: ${progressSummary.trend_speed || 'N/A'}
- HR Trend: ${progressSummary.trend_heart_rate || 'N/A'}
- 28-day Target Progress: ${progressSummary.consistency_pct?.toFixed(0) || 0}% of a 16-ride target
- Last Activity: ${progressSummary.last_activity_date ? new Date(progressSummary.last_activity_date).toLocaleDateString() : 'N/A'}

**Personal Records Before This Workout:**
- Best Speed: ${progressSummary.best_speed_kmh?.toFixed(1) || 0} km/h
- Best Elevation Gain: ${progressSummary.best_elevation_m?.toFixed(0) || 0} m
`
    : '**Comparable Training History:** No earlier activities within 75%-125% of this workout\'s distance are available. This workout establishes the initial baseline for rides of this distance.';
  const priorAnalysisContext = String(previousAnalysis || '').trim()
    ? `**Previous Analysis:**\n${String(previousAnalysis).trim()}`
    : '**Previous Analysis:** None. This is the first analysis for this activity.';
  const safeFollowUpHistory = Array.isArray(followUpHistory)
    ? followUpHistory
      .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
      .slice(-8)
      .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${String(entry.content || '').trim()}`)
      .filter((line) => line.length > 0)
    : [];
  const followUpContext = safeFollowUpHistory.length
    ? `**Follow-up Conversation About This Analysis:**\n${safeFollowUpHistory.join('\n')}`
    : '**Follow-up Conversation About This Analysis:** None.';

  return `Analyze this cycling workout in context of my training progress.

**This Workout:**
- Date: ${currentStats.date}
- Start Time: ${currentStats.time}
- Average Temperature: ${currentStats.temperature} C
- Distance: ${currentStats.distance || 'N/A'} km
- Duration: ${currentStats.duration || 'N/A'}
- Avg Speed: ${currentStats.avgSpeed || 'N/A'} km/h
- Max Speed: ${currentStats.maxSpeed || 'N/A'} km/h
- Normalized Power: ${currentStats.normalizedPower || 'N/A'} W
- Intensity Factor: ${currentStats.intensityFactor || 'N/A'}
- TSS: ${currentStats.trainingStressScore || 'N/A'}
- xPower (GC): ${currentStats.xPower || 'N/A'} W
- RI (GC): ${currentStats.relativeIntensityGc || 'N/A'}
- BikeStress (GC): ${currentStats.bikeStressScore || 'N/A'}
- Decoupling % (Intervals): ${currentStats.decouplingPct || 'N/A'}
- TRIMP: ${currentStats.trimp || 'N/A'}
- hrTSS: ${currentStats.hrTss || 'N/A'}
- Avg Heart Rate: ${currentStats.avgHr || 'N/A'} bpm
- Max Heart Rate: ${currentStats.maxHr || 'N/A'} bpm
- Elevation Gain: ${currentStats.elevation || 'N/A'} m

${summaryContext}

${heartRateProfileContext}

${priorAnalysisContext}

${followUpContext}

**Evidence Rules:**
- Use only the supplied workout and prior-history data. Never use later activities.
- There are ${priorActivityCount} earlier activities within 75%-125% of this workout's distance. Rides outside that range are excluded from all comparisons. ${hasBaseline ? 'A comparison against these distance-compatible rides is possible.' : 'Do not compare this workout to a baseline; describe it as the initial baseline for rides of this distance.'}
- ${hasTrendEvidence ? 'There are enough prior activities for cautious trend observations, but only when the supplied trend fields support them.' : 'There is not enough history to claim improvement, decline, stability, consistency, or a plateau.'}
- Do not infer recovery status, aerobic control, fatigue, overreaching, or heart-rate recovery from average and maximum HR alone.
- ${hasHeartRateProfile ? 'Use the supplied dated heart-rate profile for zone classification; do not substitute generic thresholds.' : 'Do not assign HR zones because no athlete-specific thresholds or maximum HR are supplied.'}
- Do not prescribe bpm targets from an observed peak HR. Prefer effort/RPE guidance and label it as general guidance.
- State data limitations directly instead of filling gaps with plausible claims.

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
  const currentStats = {
    date: activityDateTime.date,
    time: activityDateTime.time,
    temperature: averageTemperature(fitData.records),
    distance: session.total_distance_km?.toFixed(2) || 'N/A',
    duration: session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : 'N/A',
    avgSpeed: session.avg_speed_kmh?.toFixed(2) || 'N/A',
    maxSpeed: session.max_speed_kmh?.toFixed(2) || 'N/A',
    normalizedPower: session.normalized_power?.toFixed(0) || 'N/A',
    intensityFactor: Number.isFinite(Number(session.intensity_factor)) ? Number(session.intensity_factor).toFixed(2) : 'N/A',
    trainingStressScore: Number.isFinite(Number(session.training_stress_score)) ? Number(session.training_stress_score).toFixed(1) : 'N/A',
    xPower: Number.isFinite(Number(session.xpower)) ? Number(session.xpower).toFixed(0) : 'N/A',
    relativeIntensityGc: Number.isFinite(Number(session.relative_intensity_gc)) ? Number(session.relative_intensity_gc).toFixed(2) : 'N/A',
    bikeStressScore: Number.isFinite(Number(session.bike_stress_score)) ? Number(session.bike_stress_score).toFixed(1) : 'N/A',
    decouplingPct: Number.isFinite(Number(session.decoupling_pct)) ? Number(session.decoupling_pct).toFixed(1) : 'N/A',
    trimp: Number.isFinite(Number(session.trimp)) ? Number(session.trimp).toFixed(1) : 'N/A',
    hrTss: Number.isFinite(Number(session.hr_tss)) ? Number(session.hr_tss).toFixed(1) : 'N/A',
    avgHr: session.avg_hr?.toFixed(0) || 'N/A',
    maxHr: session.max_hr?.toFixed(0) || 'N/A',
    ascent: session.total_ascent_m?.toFixed(0) || 'N/A',
    descent: session.total_descent_m?.toFixed(0) || 'N/A',
  };
  const safeHistory = Array.isArray(history)
    ? history
      .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
      .slice(-8)
      .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${String(entry.content || '').trim()}`)
      .filter((line) => line.length > 0)
    : [];

  return `You are continuing a coaching chat about one cycling workout.

Workout facts for this activity:
- Date: ${currentStats.date}
- Start time: ${currentStats.time}
- Average temperature: ${currentStats.temperature} C
- Distance: ${currentStats.distance} km
- Duration: ${currentStats.duration}
- Avg speed: ${currentStats.avgSpeed} km/h
- Max speed: ${currentStats.maxSpeed} km/h
- Normalized power: ${currentStats.normalizedPower} W
- Intensity factor: ${currentStats.intensityFactor}
- TSS: ${currentStats.trainingStressScore}
- xPower (GC): ${currentStats.xPower} W
- RI (GC): ${currentStats.relativeIntensityGc}
- BikeStress (GC): ${currentStats.bikeStressScore}
- Decoupling % (Intervals): ${currentStats.decouplingPct}
- TRIMP: ${currentStats.trimp}
- hrTSS: ${currentStats.hrTss}
- Avg heart rate: ${currentStats.avgHr} bpm
- Max heart rate: ${currentStats.maxHr} bpm
- Elevation gain: ${currentStats.ascent} m
- Elevation loss: ${currentStats.descent} m
- Comparable prior activities: ${priorActivityCount}
- HR profile: ${hasHeartRateProfile ? `max HR ${heartRateConfig.maxHeartRate} bpm, zones ${Array.isArray(heartRateConfig.thresholds) ? heartRateConfig.thresholds.join(', ') : 'auto-derived'}` : 'not configured'}

Initial analysis:
${baseAnalysis || 'No initial analysis has been generated yet.'}

Conversation so far:
${safeHistory.length ? safeHistory.join('\n') : '(no previous messages)'}

Latest user question:
${String(userQuestion || '').trim()}

Rules:
- Use only provided workout/history data.
- If the user says the route was not flat, explicitly use elevation gain/loss context and explain what can and cannot be inferred without full grade distribution.
- Be specific and concise.
- If the data is insufficient for a claim, say so and ask one clarifying follow-up.

Respond in 4-8 sentences.`;
}

function formatActivityDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: 'N/A', time: 'N/A' };
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
    return 'N/A';
  }
  const average = temperatures.reduce((sum, temperature) => sum + temperature, 0) / temperatures.length;
  return average.toFixed(1);
}

module.exports = {
  generateAnalysisPrompt,
  generateAnalysisChatPrompt,
  requestCopilotAnalysis,
};
