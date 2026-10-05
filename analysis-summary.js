// Structured carry-forward: the analysis prompt asks the model to end its answer with a short
// machine-readable SUMMARY tail. The tail is parsed here (tolerantly), stored separately, cut
// from the displayed text, and fed back into later prompts instead of full past analyses.

const ADVICE_CATEGORIES = Object.freeze(['pacing', 'load', 'route', 'data', 'recovery', 'technique', 'none']);
const SUMMARY_KEYS = Object.freeze(['type', 'finding', 'advice_category', 'advice', 'open', 'revised', 'purpose', 'conditions', 'trend']);
const PURPOSE_VALUES = Object.freeze(['commute', 'endurance', 'tempo', 'intervals', 'recovery', 'race', 'social', 'leisure', 'other', 'unknown']);
const CONDITION_VALUES = Object.freeze(['headwind', 'tailwind', 'rain', 'heat', 'cold', 'group', 'traffic', 'night', 'new_route', 'none']);
const FALLBACK_CHARS = 400;
const SESSION_TYPES = Object.freeze(['recovery', 'endurance', 'tempo', 'threshold', 'vo2max/anaerobic', 'mixed', 'unstructured', 'undetermined']);

// Stems of the response languages seen in practice; unknown wording is kept as written.
const TYPE_STEMS = Object.freeze([
  [/неструктур|unstructured|свободн/, 'unstructured'],
  [/неопредел|undetermined|indeterminate/, 'undetermined'],
  [/восстанов|recovery/, 'recovery'],
  [/выносливост|endurance|aerobic base/, 'endurance'],
  [/пороговая|пороговый|пороговое|порогов|threshold/, 'threshold'],
  [/vo2|анаэроб|anaerobic/, 'vo2max/anaerobic'],
  [/смешан|mixed/, 'mixed'],
  [/темпо|tempo/, 'tempo'],
]);

function normalizeSessionType(value) {
  const text = stripDecoration(value).toLowerCase();
  if (!text) return null;
  const hit = TYPE_STEMS.find(([pattern]) => pattern.test(text));
  return hit ? hit[1] : text;
}

const SUMMARY_TAIL_INSTRUCTION = `After the answer, end with this tail exactly, in English regardless of the answer language, one line per field and nothing after it:
---
SUMMARY
type: <one of: ${SESSION_TYPES.join(' | ')}>
finding: <the single most important observation with its number>
advice_category: <one of: ${ADVICE_CATEGORIES.join(' | ')}>
advice: <the practical step in one short sentence, or the observation given instead of a step>
open: <one question whose answer would change the advice and is not answered by the route profile, notes or flags; usually none>
revised: <what from the earlier summaries you now revise, or none>
trend: <one of: improving | steady | declining | unclear — how this ride compares with its usual on this route across the section verdicts; unclear when no route comparison was supplied or the sections disagree>
purpose: <the goal or goals this ride's data best supports, comma-separated when more than one: ${PURPOSE_VALUES.join(' | ')}; write unknown when nothing supports a claim>
conditions: <conditions this ride's data suggest: ${CONDITION_VALUES.join(' | ')}; write none when nothing supports a claim>`;

const stripDecoration = (text) => String(text ?? '')
  .replace(/[*_`]+/g, '')
  .replace(/^[\s>#-]+/, '')
  .trim();

function normalizeCategory(value) {
  const text = stripDecoration(value).toLowerCase();
  let best = null;
  for (const category of ADVICE_CATEGORIES) {
    const index = text.search(new RegExp(`\\b${category}\\b`));
    if (index >= 0 && (best == null || index < best.index)) best = { category, index };
  }
  if (best) return best.category;
  return text ? 'other' : null;
}


// A tail field restricted to a known value list: the exact value, or entries mentioned in a list;
// absent, "none" or "unknown" mean nothing was inferred.
function normalizeListed(value, allowed) {
  const text = stripDecoration(value).toLowerCase();
  if (!text || /^(none|unknown|n\/a|-)$/.test(text)) return [];
  if (allowed.includes(text)) return [text];
  return allowed.filter((entry) => new RegExp(`\\b${entry}\\b`).test(text) && entry !== 'none');
}

// Splits a model answer into the display body and its summary tail. Never throws; a missing or
// unusable tail yields { body: <full text>, summary: null }.
function parseAnalysisSummary(text) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  let headerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^[\s>#*_`-]*summary\s*[:*_`]*\s*$/i.test(lines[index])) {
      headerIndex = index;
      break;
    }
    if (lines.length - index > 20) break;
  }
  if (headerIndex < 0) return { body: source.trim(), summary: null };

  const fields = {};
  for (const line of lines.slice(headerIndex + 1)) {
    const match = /^[\s>*_`-]*([a-z_ ]+?)\s*[*_`]*\s*:\s*[*_`]*\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (SUMMARY_KEYS.includes(key) && !(key in fields)) fields[key] = stripDecoration(match[2]).replace(/[`*]+$/g, '').trim();
  }
  let end = headerIndex;
  while (end > 0 && /^[\s>*_`-]*$/.test(lines[end - 1])) end -= 1;
  const body = lines.slice(0, end).join('\n').trim();

  if (!fields.type && !fields.finding && !fields.advice) return { body: source.trim(), summary: null };
  return {
    body,
    summary: {
      type: normalizeSessionType(fields.type),
      finding: fields.finding || null,
      adviceCategory: normalizeCategory(fields.advice_category),
      advice: fields.advice || null,
      open: /^(none|n\/a|-)?$/i.test(fields.open || '') ? null : fields.open,
      revised: /^(none|n\/a|-)?$/i.test(fields.revised || '') ? null : fields.revised,
      trend: ['improving', 'steady', 'declining', 'unclear'].includes((fields.trend || '').toLowerCase().trim()) ? fields.trend.toLowerCase().trim() : null,
        purpose: normalizeListed(fields.purpose, PURPOSE_VALUES),
        conditions: normalizeListed(fields.conditions, CONDITION_VALUES),
    },
  };
}

// History line for an earlier activity: structured summary when stored, otherwise the opening of
// its analysis text.
function describeAnalysisForHistory(summary, analysisText, classLabel, { brief = false } = {}) {
  if (summary && (summary.finding || summary.advice || summary.type)) {
    const typeText = summary.type
      ? (classLabel && classLabel.toLowerCase() !== summary.type.toLowerCase()
        ? `type: code ${classLabel} / model ${summary.type}` : `type: ${summary.type}`)
      : null;
    if (brief) return [typeText, summary.adviceCategory && summary.adviceCategory !== 'none' ? `advice[${summary.adviceCategory}]` : null].filter(Boolean).join('; ');
    return [
      typeText,
      summary.finding ? `finding: ${summary.finding}` : null,
      summary.advice ? `advice[${summary.adviceCategory || 'other'}]: ${summary.advice}` : null,
      summary.open ? `open: ${summary.open}` : null,
      summary.revised ? `revised: ${summary.revised}` : null,
    ].filter(Boolean).join('; ');
  }
  const text = String(analysisText || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > FALLBACK_CHARS ? `${text.slice(0, FALLBACK_CHARS).trimEnd()}…` : text;
}

function parseStoredSummary(json) {
  try {
    const parsed = json ? JSON.parse(json) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  ADVICE_CATEGORIES,
  PURPOSE_VALUES,
  SESSION_TYPES,
  normalizeSessionType,
  FALLBACK_CHARS,
  SUMMARY_TAIL_INSTRUCTION,
  CONDITION_VALUES,
  describeAnalysisForHistory,
  parseAnalysisSummary,
  parseStoredSummary,
};
