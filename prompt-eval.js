// Offline checks for analysis responses (B9). Pure module: used by the dev command
// "FIT: Evaluate Analysis Prompt" and by scripts/prompt-eval/check.js on saved runs or LLM logs.

const { normalizeSessionType, parseAnalysisSummary } = require('./analysis-summary');

const DEFENSIVE_PHRASES = Object.freeze([
  'не доказывает', 'не подтверждает', 'не позволяет', 'не установлен', 'маршрут не подтвержд',
  'does not prove', 'does not establish', 'cannot be concluded', 'route identity not established', 'not evidence of',
]);

const FLAG_KEYWORDS = Object.freeze([
  { pattern: /^- ALT_(SETTLING|MISSING_START|GAP):/m, words: /altitude|elevation|barometer|высот|барометр/i },
  { pattern: /TEMP_DEVICE_HOT|Device temperature/i, words: /temperature|heat|warm|температур|жар|тепл/i },
]);

const numbersIn = (text) => (String(text).match(/\d+(?:[.,]\d+)?/g) || []).map((raw) => Number(raw.replace(',', '.'))).filter(Number.isFinite);

// Numbers above 10 in the answer that neither appear in the prompt nor equal the difference of
// two numbers on the same prompt line (derived deltas are legitimate); a rough hallucination signal.
function findUnsupportedNumbers(body, prompt) {
  const lines = String(prompt).split('\n').map(numbersIn).filter((values) => values.length);
  const supported = new Set(lines.flat().map((value) => Math.round(value * 10)));
  const near = (value) => [-1, 0, 1].some((offset) => supported.has(Math.round(value * 10) + offset));
  const isDifference = (value) => lines.some((values) => {
    const limited = values.slice(0, 40);
    for (let i = 0; i < limited.length; i += 1) {
      for (let j = i + 1; j < limited.length; j += 1) {
        if (Math.abs(Math.abs(limited[i] - limited[j]) - value) < 0.051) return true;
      }
    }
    return false;
  });
  return [...new Set(numbersIn(body).filter((value) => value > 10))]
    .filter((value) => !near(value) && !isDifference(value));
}

function cyrillicShare(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter((char) => /[\u0400-\u04FF]/.test(char)).length / letters.length;
}

// previousCategories: advice categories of earlier activities, oldest first.
function checkAnalysisResponse({ response, prompt, previousCategories = [], codeClass = null }) {
  const { body, summary } = parseAnalysisSummary(response);
  const lowerBody = body.toLowerCase();
  const detectedClass = codeClass || /Heuristic Session Class[^\n]*\n-\s*Class:\s*([^\n]+)/i.exec(prompt || '')?.[1]?.trim() || null;
  const typeMatchesCode = !detectedClass || !summary?.type
    ? null
    : Boolean(summary.revised) || normalizeSessionType(summary.type) === normalizeSessionType(detectedClass);
  const lastThree = previousCategories.filter(Boolean).slice(-3);
  const categoryRepeat = Boolean(summary?.adviceCategory) && summary.adviceCategory !== 'none'
    && lastThree.length === 3 && lastThree.every((category) => category === summary.adviceCategory) && !summary.revised;
  const flagsMentioned = FLAG_KEYWORDS
    .filter((rule) => rule.pattern.test(prompt || ''))
    .map((rule) => rule.words.test(body));
  return {
    validTail: Boolean(summary),
    detectedClass,
    typeMatchesCode,
    categoryRepeat,
    adviceCategory: summary?.adviceCategory ?? null,
    unsupportedNumbers: findUnsupportedNumbers(body, prompt || ''),
    flagsMissed: flagsMentioned.filter((mentioned) => !mentioned).length,
    chars: body.length,
    cyrillicShare: Math.round(cyrillicShare(body) * 100) / 100,
    defensivePhrases: DEFENSIVE_PHRASES.filter((phrase) => lowerBody.includes(phrase)).length,
  };
}

function aggregateChecks(results) {
  const count = results.length || 1;
  const share = (predicate) => Math.round((100 * results.filter(predicate).length) / count);
  const mean = (selector) => Math.round(results.reduce((sum, item) => sum + selector(item), 0) / count);
  return {
    runs: results.length,
    validTailPct: share((item) => item.validTail),
    typeMismatchPct: share((item) => item.typeMatchesCode === false),
    categoryRepeatPct: share((item) => item.categoryRepeat),
    withUnsupportedNumbersPct: share((item) => item.unsupportedNumbers.length > 0),
    flagsMissedPct: share((item) => item.flagsMissed > 0),
    meanChars: mean((item) => item.chars),
    meanDefensivePhrases: Math.round((10 * results.reduce((sum, item) => sum + item.defensivePhrases, 0)) / count) / 10,
  };
}

function formatAggregate(aggregate, baseline = null) {
  const rows = [
    ['runs', 'runs', ''], ['validTailPct', 'valid SUMMARY tail', '%'], ['typeMismatchPct', 'type differs from code class', '%'],
    ['categoryRepeatPct', 'advice category repeated 4x', '%'], ['withUnsupportedNumbersPct', 'answers with numbers not in prompt', '%'],
    ['flagsMissedPct', 'present quality flag not mentioned', '%'], ['meanChars', 'mean answer length', ' chars'],
    ['meanDefensivePhrases', 'defensive phrases per answer', ''],
  ];
  return rows.map(([key, label, unit]) => {
    const delta = baseline && baseline[key] != null && key !== 'runs' ? ` (${aggregate[key] - baseline[key] >= 0 ? '+' : ''}${Math.round((aggregate[key] - baseline[key]) * 10) / 10})` : '';
    return `${label}: ${aggregate[key]}${unit}${delta}`;
  }).join('\n');
}

// entries: [{ file, prompt, response, kind? }] in chronological order; advice categories carry over.
function evaluateEntries(entries) {
  const results = [];
  const categories = [];
  for (const entry of entries) {
    if (!entry?.prompt || !entry?.response || (entry.kind && entry.kind !== 'analysis')) continue;
    const result = checkAnalysisResponse({ response: entry.response, prompt: entry.prompt, previousCategories: categories });
    categories.push(result.adviceCategory);
    results.push({ file: entry.file, ...result });
  }
  return results;
}

function describeResult(item) {
  return `${item.file}: tail ${item.validTail ? 'ok' : 'MISSING'}, class ${item.detectedClass ?? '-'}${item.typeMatchesCode === false ? ' MISMATCH' : ''}, `
    + `category ${item.adviceCategory ?? '-'}${item.categoryRepeat ? ' REPEAT' : ''}, numbers outside prompt [${item.unsupportedNumbers.join(', ')}], ${item.chars} chars`;
}

module.exports = {
  describeResult,
  evaluateEntries,
  aggregateChecks,
  checkAnalysisResponse,
  findUnsupportedNumbers,
  formatAggregate,
};
