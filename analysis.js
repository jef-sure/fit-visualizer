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

function generateAnalysisPrompt(fitData, progressSummary, heartRateConfig) {
  const session = fitData.sessions?.[0] || {};
  const currentStats = {
    distance: session.total_distance_km?.toFixed(2),
    duration: session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : 'N/A',
    avgSpeed: session.avg_speed_kmh?.toFixed(2),
    maxSpeed: session.max_speed_kmh?.toFixed(2),
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

  return `Analyze this cycling workout in context of my training progress.

**This Workout:**
- Distance: ${currentStats.distance || 'N/A'} km
- Duration: ${currentStats.duration || 'N/A'}
- Avg Speed: ${currentStats.avgSpeed || 'N/A'} km/h
- Max Speed: ${currentStats.maxSpeed || 'N/A'} km/h
- Avg Heart Rate: ${currentStats.avgHr || 'N/A'} bpm
- Max Heart Rate: ${currentStats.maxHr || 'N/A'} bpm
- Elevation Gain: ${currentStats.elevation || 'N/A'} m

${summaryContext}

${heartRateProfileContext}

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
  const priorActivityCount = Number(progressSummary?.total_activities || 0);
  const hasHeartRateProfile = Number.isFinite(heartRateConfig?.maxHeartRate);
  const currentStats = {
    distance: session.total_distance_km?.toFixed(2) || 'N/A',
    duration: session.total_timer_s ? formatHms(Math.round(session.total_timer_s)) : 'N/A',
    avgSpeed: session.avg_speed_kmh?.toFixed(2) || 'N/A',
    maxSpeed: session.max_speed_kmh?.toFixed(2) || 'N/A',
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
- Distance: ${currentStats.distance} km
- Duration: ${currentStats.duration}
- Avg speed: ${currentStats.avgSpeed} km/h
- Max speed: ${currentStats.maxSpeed} km/h
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

module.exports = {
  generateAnalysisPrompt,
  generateAnalysisChatPrompt,
  requestCopilotAnalysis,
};
