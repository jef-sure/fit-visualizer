// Offline checks for analysis responses (B9). Pure module, not part of the packaged extension:
// used by scripts/prompt-eval/check.js on the LLM logs.

const { normalizeSessionType, parseAnalysisSummary } = require('./analysis-summary');

// Hedging clauses the model tends to append after every number. Each occurrence counts, so the
// metric is "disclaimers per answer", and hedgeSharePct is the share of sentences carrying one.
const DEFENSIVE_PHRASES = Object.freeze([
  'не доказыва', 'не подтвержда', 'не позволяет', 'не позволяют', 'не установлен', 'маршрут не подтвержд',
  'не свидетельств', 'не обоснован', 'это описание', 'а не вывод', 'не доказательство', 'не контролировал', 'нельзя',
  'does not prove', 'does not establish', 'cannot be concluded', 'route identity not established', 'not evidence of',
  'is a description, not', 'were not controlled', 'cannot be judged',
]);

// English class/zone words left inside a non-English answer (the data feeds them in English).
const ENGLISH_TERMS = /\b(mixed|tempo|threshold|endurance|recovery|undetermined|unstructured|vo2max)\b/gi;
// Informal vs polite second person in Russian answers; mixing them in one answer is the defect.
// \b is ASCII-only in JavaScript, so Cyrillic words need explicit letter-boundary lookarounds.
const RU_INFORMAL = /(?<![а-яё])(отметь|держи|проверь|запиши|сравни|попробуй|начни|следи|не ускоряйся|ты|тебя|тебе|тобой|твой|твоя|твоё|твои)(?![а-яё])/i;
const RU_POLITE = /(?<![а-яё])(отметьте|держите|проверьте|запишите|сравните|попробуйте|начните|следите|не ускоряйтесь|вы|вас|вам|вами|ваш|ваша|ваше|ваши|вы сообщили)(?![а-яё])/i;

function countOccurrences(text, phrases) {
  const lower = String(text).toLowerCase();
  return phrases.reduce((sum, phrase) => sum + lower.split(phrase).length - 1, 0);
}

function sentenceCount(text) {
  return (String(text).match(/[.!?](\s|$)/g) || []).length || 1;
}

// Flags present in the prompt (one line each, from the Altitude Quality / Data Quality Flags
// blocks) and the words that count as the answer using them. Patterns anchor on the flag line so
// that the general principle text ("Device temperature ... may be the device's") never counts as
// a flag. Altitude words include the integrated wording the model prefers ("early altitude
// unreliable") rather than only the flag code.
const FLAG_KEYWORDS = Object.freeze([
  { pattern: /^- ALT_(SETTLING|MISSING_START|GAP):/m, words: /altitude|elevation|barometer|высот|барометр|unreliable|ненадёжн/i },
  { pattern: /^- TEMP_DEVICE_HOT:/m, words: /temperature|heat|warm|sun|температур|жар|тепл|солнц/i },
  { pattern: /^- HR_(DROPOUT|LATE_START|CONTACT_LOSS):/m, words: /heart.?rate|HR|strap|contact|dropout|coverage|пульс|ремн|контакт|покрыти|пропуск/i },
  { pattern: /^- ELAPSED_MISMATCH:/m, words: /elapsed|left running|stopp|session time|общее время|не остановл|остановк/i },
  { pattern: /^- OFFSET_CHANGED:/m, words: /time ?zone|UTC|offset|local time|часово|пояс|смещени|локальн/i },
]);

// Thousands written with a space ("386 897") are one number. Only groups of exactly three digits
// after a 1-3 digit head are joined, so "2026 120" and "5 149" stay apart. Joining can only make
// an unsupported number more visible, never hide one.
const joinThousands = (text) => String(text).replace(/(?<![\d.,])(\d{1,3})((?:[    ]\d{3})+)(?![\d])/g,
  (match, head, groups) => head + groups.replace(/[^\d]/g, ''));

const numbersIn = (text) => (joinThousands(text).match(/\d+(?:[.,]\d+)?/g) || []).map((raw) => Number(raw.replace(',', '.'))).filter(Number.isFinite);

// A quoted value that is a supplied number rounded the usual way: to a whole number, or to two or
// more significant digits (382024 -> 382000). A different leading digit pair is not rounding.
function isRoundingOf(value, supplied) {
  if (!(supplied > 0) || supplied === value) return false;
  if (Number.isInteger(value) && Math.round(supplied) === value) return true;
  const digits = Math.floor(Math.log10(supplied)) + 1;
  for (let keep = 2; keep < digits; keep += 1) {
    const unit = 10 ** (digits - keep);
    if (Math.round(supplied / unit) * unit === value) return true;
  }
  return false;
}

// Numbers above 10 in the answer that neither appear in the prompt, nor are a supplied number
// rounded, nor equal the difference of two numbers on the same prompt line (derived deltas are
// legitimate); a rough hallucination signal.
function findUnsupportedNumbers(body, prompt) {
  const lines = String(prompt).split('\n').map(numbersIn).filter((values) => values.length);
  const all = [...new Set(lines.flat())];
  const supported = new Set(all.map((value) => Math.round(value * 10)));
  const near = (value) => [-1, 0, 1].some((offset) => supported.has(Math.round(value * 10) + offset));
  const rounded = (value) => all.some((supplied) => isRoundingOf(value, supplied));
  // A supplied length in km quoted in metres (0.5 km -> 500 m).
  const asMetres = (value) => value >= 100 && value % 50 === 0 && supported.has(Math.round(value / 100));
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
    .filter((value) => !near(value) && !rounded(value) && !asMetres(value) && !isDifference(value));
}

// The three computed indicators of the Trends block. `line` finds the indicator in the prompt;
// an answer uses it when it quotes one of that line's own numbers or names the indicator itself.
// A mention of heart rate or weekly volume in general is not use of the indicator.
const TREND_INDICATORS = Object.freeze([
  { key: 'effort', line: /^Route (?:efficiency|effort)[^\n]*$/m,
    words: /время\s*[×x*х]\s*(пульс|HR|ЧСС)|time\s*[×x*]\s*HR|произведени\S+ времени|показател\S+ усили|effort (index|proxy|product)/i },
  { key: 'load', line: /^Load rhythm[^\n]*$/m,
    words: /монотонн|monoton|ритм\S* нагрузк|недельн\S+ ритм|load rhythm|(выше|ниже) привычн|привычн\S+ (нагрузк|уровн)|above habit|below habit|7[- ]?(дн|day)\S*[^.\n]{0,60}28/i },
  { key: 'recovery', line: /^Post-climb HR recovery[^\n]*$/m,
    words: /восстановлени\S+ пульс|пульс\S* (опуска|пада|снижа)\S+[^.\n]{0,40}(после подъ|за 60|за минут)|HR (drop|recovery)|post-climb/i },
]);

function trendUse(prompt, body) {
  const quoted = new Set(numbersIn(body).map((value) => Math.round(value * 100)));
  const result = {};
  for (const indicator of TREND_INDICATORS) {
    const line = indicator.line.exec(prompt)?.[0];
    if (!line) { result[indicator.key] = null; continue; }
    // "km 20.2" and "5 prior rides" sit on the line too but identify nothing.
    const own = numbersIn(line.replace(/at km [\d.]+|of \d+ prior rides|7-day|28-day|in 60 s/g, ''))
      .filter((value) => !Number.isInteger(value) || value > 60);
    result[indicator.key] = own.some((value) => quoted.has(Math.round(value * 100))) || indicator.words.test(body);
  }
  return result;
}

// Sentences that speak about health, form or physiological state. A sentence that denies the
// inference ("this does not show a change in form") is what the prompt asks for; one that asserts
// it is a candidate defect, listed for a person to judge - the wording alone cannot settle it.
const STATE_WORDS = /здоров|самочувств|сердечно-сосудист|cardiovascular|\bhealth|\bfitness|фитнес|тренированност|(?<![а-яё])форм(а|ы|у|е|ой)(?![а-яё])|перегруз|перетренир|overreach|overtrain|недовосстанов|отсутстви\S+ (отдых|восстановлен)|без (отдых|восстановлен)|no (rest|recovery)/i;
const DENIAL_WORDS = /не (доказыва|подтвержда|позволя|означа|говор|свидетельств|явля|установ|да[её]т|показыва|следует)|нельзя|не доказ|, а не | а не (доказ|признак|изменени)|без доказ|not evidence|does not|doesn't|cannot|can't|no evidence|not a (fitness|health)|rather than/i;

function findStateClaims(body) {
  const sentences = String(body).split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const about = sentences.filter((sentence) => STATE_WORDS.test(sentence));
  return {
    denials: about.filter((sentence) => DENIAL_WORDS.test(sentence)),
    candidates: about.filter((sentence) => !DENIAL_WORDS.test(sentence)),
  };
}

// A prompt is logged as one string, or as the list of messages that was sent.
function normalizePrompt(prompt) {
  if (Array.isArray(prompt)) {
    return prompt.map((part) => (typeof part === 'string' ? part : String(part?.content ?? part?.text ?? ''))).join('\n');
  }
  return prompt == null ? '' : String(prompt);
}

// From a folder of logs: the last attempt per activity for one analysis format, oldest first.
// A last attempt that failed is reported, not replaced by an earlier success - the earlier answer
// is not what the user sees for a ride whose re-analysis broke.
function selectLatestAttempts(entries, { analysisVersion = null } = {}) {
  const analyses = (entries || []).filter((entry) => entry && (!entry.kind || entry.kind === 'analysis'));
  const versions = [...new Set(analyses.map((entry) => entry.analysisVersion).filter((value) => value != null))].sort((a, b) => a - b);
  const version = analysisVersion ?? (versions.length ? versions[versions.length - 1] : null);
  const stamp = (entry) => String(entry.timestamp || entry.file || '');
  const latest = new Map();
  let attempts = 0;
  for (const entry of analyses) {
    if (version != null && entry.analysisVersion != null && entry.analysisVersion !== version) continue;
    attempts += 1;
    const key = entry.activityId ?? entry.file;
    const current = latest.get(key);
    if (!current || stamp(entry) > stamp(current)) latest.set(key, entry);
  }
  const ordered = [...latest.values()].sort((a, b) => (stamp(a) < stamp(b) ? -1 : 1))
    .map((entry) => ({ ...entry, prompt: normalizePrompt(entry.prompt) }));
  const failed = ordered.filter((entry) => entry.error || !String(entry.response || '').trim() || !entry.prompt);
  return {
    analysisVersion: version, versionsFound: versions, attempts,
    entries: ordered.filter((entry) => !failed.includes(entry)),
    failed: failed.map((entry) => ({ file: entry.file, activityId: entry.activityId ?? null, error: String(entry.error || 'empty response') })),
    models: ordered.reduce((counts, entry) => ({ ...counts, [entry.modelId || 'unknown']: (counts[entry.modelId || 'unknown'] || 0) + 1 }), {}),
  };
}

// "Keep HR strictly below 136 bpm", "aim for about 22.3 km/h": a numeric target in the advice.
const TARGET_ADVICE = /(строго )?(ниже|не выше|не превыша\S+|до|в пределах|около)\s+\d{2,3}([.,]\d)?\s?(bpm|уд)|(удерж\S+|держ\S+|ориентир\S+)[^.\n]{0,80}\d{1,3}([.,]\d)?\s?(bpm|уд\S*|км\/ч)|(below|under|at or below|no higher than|around)\s+\d{2,3}\s?bpm|(hold|keep|aim for|target)[^.\n]{0,60}\d{1,3}(\.\d)?\s?(bpm|km\/h)/i;
// Advice built on traffic, lights, start time or the choice of road.
const GIVENS_ADVICE = /трафик|светофор|сдвин\S+ старт|старт\S* на \d+[^.\n]{0,20}(позже|раньше)|меньш\S+ числом (пересечен|перекр)|менее загруженн|traffic|traffic light|start (earlier|later)|shift the start/i;

// "km 3.3-8.4" from each line of the Route Sections block, as the answer would quote it.
function sectionRanges(prompt) {
  return [...String(prompt).matchAll(/^\d+\. km ([\d.]+)-([\d.]+) /gm)].map((match) => `${match[1]}`)
    .filter((start) => start !== '0');
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
  const promptText = String(prompt || '');
  const bodyLower = body.toLowerCase();
  return {
    validTail: Boolean(summary),
    openPresent: Boolean(summary?.open),
    openAboutSlowdown: Boolean(summary?.open) && /(ровн|flat|замедлен|slowdown|speed drop|после 10|после десят)/i.test(summary.open),
    asksForEffort: /запиш|record|отметь|note down|enter your|fill in/i.test(String(summary?.advice || '')) && /rpe|усили|effort|услови|condition|ветер|wind/i.test(String(summary?.advice || '')),
    hasNotesBlock: /Athlete's Session Notes/.test(promptText),
    usesNotes: /Athlete's Session Notes/.test(promptText) && /(rpe|усили|заявлен|declared|услови)/i.test(body) && !/запиш.*(rpe|усили)/i.test(body),
    usesDirection: /Route Profile|Same-Route/.test(promptText) && /(направлени|direction|typical for this direction|типичн[аояМ]* (для )?направлен)/i.test(body),
    deviceZeroZero: /device reports 0\/0/.test(promptText),
    hasAltitudeBlock: /^\*\*Altitude Quality/m.test(promptText),
    hasRouteBlocks: /Route Profile|Same-Route/.test(promptText),
    // A number to hit or stay under next time, and advice about what the rider does not control.
    setsTarget: TARGET_ADVICE.test(body),
    advisesOnGivens: GIVENS_ADVICE.test(body),
    hasSections: /^\*\*Route Sections/m.test(promptText),
    // The answer speaks about the ride by route section: a section's km range or its verdict wording.
    usesSections: /^\*\*Route Sections/m.test(promptText)
      && (sectionRanges(promptText).some((range) => bodyLower.replace(/,/g, '.').includes(range))
        || /участ(ок|ке|ка|ки|ках)|section/i.test(body)),
    reversedRide: /\(reversed\)/.test(promptText),
    detectedClass,
    typeMatchesCode,
    categoryRepeat,
    adviceCategory: summary?.adviceCategory ?? null,
    unsupportedNumbers: findUnsupportedNumbers(body, prompt || ''),
    trendUse: trendUse(promptText, body),
    stateClaims: findStateClaims(body),
    flagsMissed: flagsMentioned.filter((mentioned) => !mentioned).length,
    chars: body.length,
    cyrillicShare: Math.round(cyrillicShare(body) * 100) / 100,
    defensivePhrases: countOccurrences(body, DEFENSIVE_PHRASES),
    hedgeSharePct: Math.round((100 * countOccurrences(body, DEFENSIVE_PHRASES)) / sentenceCount(body)),
    englishTerms: cyrillicShare(body) > 0.5 ? (body.match(ENGLISH_TERMS) || []).length : 0,
    mixedAddress: cyrillicShare(body) > 0.5 && RU_INFORMAL.test(body) && RU_POLITE.test(body),
    informalAddress: cyrillicShare(body) > 0.5 && RU_INFORMAL.test(body) && !RU_POLITE.test(body),
    // The prompt asks for the informal form; a polite-only answer ignored it.
    politeAddress: cyrillicShare(body) > 0.5 && RU_POLITE.test(body) && !RU_INFORMAL.test(body),
  };
}

function aggregateChecks(results) {
  const count = results.length || 1;
  // predicate returns true/false for covered items and null for items it does not cover.
  const shareWhere = (predicate) => {
    const covered = results.map(predicate).filter((value) => value !== null && value !== undefined);
    return covered.length ? Math.round((100 * covered.filter(Boolean).length) / covered.length) : 0;
  };
  const share = (predicate) => Math.round((100 * results.filter(predicate).length) / count);
  const mean = (selector) => Math.round(results.reduce((sum, item) => sum + selector(item), 0) / count);
  return {
    runs: results.length,
    validTailPct: share((item) => item.validTail),
    typeMismatchPct: share((item) => item.typeMatchesCode === false),
    categoryRepeatPct: share((item) => item.categoryRepeat),
    withUnsupportedNumbersPct: share((item) => (item.unsupportedNumbers || []).length > 0),
    flagsMissedPct: share((item) => (item.flagsMissed || 0) > 0),
    meanChars: mean((item) => item.chars || 0),
    meanDefensivePhrases: Math.round((10 * results.reduce((sum, item) => sum + (item.defensivePhrases || 0), 0)) / count) / 10,
    meanHedgeSharePct: mean((item) => item.hedgeSharePct || 0),
    meanEnglishTerms: Math.round((10 * results.reduce((sum, item) => sum + (item.englishTerms || 0), 0)) / count) / 10,
    mixedAddressCount: results.filter((item) => item.mixedAddress).length,
    informalAddressCount: results.filter((item) => item.informalAddress).length,
    politeAddressCount: results.filter((item) => item.politeAddress).length,
    openPresentPct: share((item) => item.openPresent),
    openAboutSlowdownCount: results.filter((item) => item.openAboutSlowdown).length,
    asksForEffortCount: results.filter((item) => item.asksForEffort).length,
    deviceZeroZeroCount: results.filter((item) => item.deviceZeroZero).length,
    notesBlockCount: results.filter((item) => item.hasNotesBlock).length,
    usesNotesPctOfWithNotes: shareWhere((item) => item.hasNotesBlock ? item.usesNotes : null),
    usesDirectionPctOfRoute: shareWhere((item) => (item.hasRouteBlocks ? item.usesDirection : null)),
    altitudeBlockPctOfReversed: shareWhere((item) => (item.reversedRide ? item.hasAltitudeBlock : null)),
    altitudeBlockCount: results.filter((item) => item.hasAltitudeBlock).length,
    sectionsBlockCount: results.filter((item) => item.hasSections).length,
    setsTargetCount: results.filter((item) => item.setsTarget).length,
    advisesOnGivensCount: results.filter((item) => item.advisesOnGivens).length,
    usesSectionsPctOfWithSections: shareWhere((item) => (item.hasSections ? item.usesSections : null)),
    trends: aggregateTrends(results),
    stateClaimAnswers: results.filter((item) => item.stateClaims?.candidates.length).length,
    stateDenialAnswers: results.filter((item) => item.stateClaims?.denials.length).length,
  };
}

// Coverage and use per indicator, with the denominators. An indicator that no prompt carried is
// "not tested": zero misses out of zero prompts is not a pass.
function aggregateTrends(results) {
  const withTrends = results.filter((item) => item.trendUse && Object.values(item.trendUse).some((value) => value !== null));
  const indicators = {};
  for (const { key } of TREND_INDICATORS) {
    const present = results.filter((item) => item.trendUse?.[key] != null);
    indicators[key] = { present: present.length, used: present.filter((item) => item.trendUse[key]).length };
  }
  const usedAny = withTrends.filter((item) => Object.values(item.trendUse).some((value) => value === true)).length;
  return {
    prompts: withTrends.length, usedAny,
    usedAnyPct: withTrends.length ? Math.round((100 * usedAny) / withTrends.length) : null,
    indicators,
  };
}

function formatTrends(trends) {
  const share = (used, total) => (total ? `${used}/${total} (${Math.round((100 * used) / total)}%)` : 'not tested (0 prompts)');
  return [
    `answers using at least one supplied trend indicator: ${share(trends.usedAny, trends.prompts)}`,
    ...Object.entries(trends.indicators).map(([key, value]) => `  ${key}: in ${value.present} prompts, used in ${share(value.used, value.present)}`),
  ].join('\n');
}

function formatAggregate(aggregate, baseline = null) {
  const rows = [
    ['runs', 'runs', ''], ['validTailPct', 'valid SUMMARY tail', '%'], ['typeMismatchPct', 'type differs from code class', '%'],
    ['categoryRepeatPct', 'advice category repeated 4x', '%'], ['withUnsupportedNumbersPct', 'answers with numbers not in prompt', '%'],
    ['flagsMissedPct', 'present quality flag not mentioned', '%'], ['meanChars', 'mean answer length', ' chars'],
    ['meanDefensivePhrases', 'defensive phrases per answer', ''],
    ['meanHedgeSharePct', 'sentences carrying a disclaimer', '%'],
    ['meanEnglishTerms', 'English class/zone words per non-English answer', ''],
    ['mixedAddressCount', 'answers mixing informal and polite address (ru)', ' of N'],
    ['informalAddressCount', 'answers in informal address only (ru; the form the prompt asks for)', ' of N'],
    ['politeAddressCount', 'answers in polite address only (ru)', ' of N'],
    ['openPresentPct', 'open question present', '%'],
    ['openAboutSlowdownCount', 'open questions about the flat/slowdown', ' of N'],
    ['asksForEffortCount', 'advices asking to record RPE/conditions', ' of N'],
    ['deviceZeroZeroCount', 'prompts with device 0/0 ascent', ' of N'],
    ['notesBlockCount', 'prompts with session notes', ' of N'],
    ['usesNotesPctOfWithNotes', 'answers using declared notes', '% of with-notes'],
    ['usesDirectionPctOfRoute', 'answers using route direction facts', '% of on-route'],
    ['altitudeBlockCount', 'prompts with altitude block', ' of N'],
    ['altitudeBlockPctOfReversed', 'altitude block on reversed rides', '% of reversed'],
    ['setsTargetCount', 'answers setting a numeric target (bpm, km/h)', ' of N'],
    ['advisesOnGivensCount', 'answers advising on traffic, lights or start time', ' of N'],
    ['sectionsBlockCount', 'prompts with route sections', ' of N'],
    ['usesSectionsPctOfWithSections', 'answers speaking by route section', '% of with-sections'],
    ['stateClaimAnswers', 'answers with a health/form statement to review', ' of N'],
    ['stateDenialAnswers', 'answers that only decline such an inference somewhere', ' of N'],
  ];
  const lines = rows.map(([key, label, unit]) => {
    const delta = baseline && baseline[key] != null && key !== 'runs' ? ` (${aggregate[key] - baseline[key] >= 0 ? '+' : ''}${Math.round((aggregate[key] - baseline[key]) * 10) / 10})` : '';
    return `${label}: ${aggregate[key]}${unit}${delta}`;
  });
  return [...lines, aggregate.trends ? formatTrends(aggregate.trends) : null].filter(Boolean).join('\n');
}

// The same figures as one markdown column, for the table in part 0 of the plan.
function formatTableColumn(aggregate, title) {
  const trends = aggregate.trends;
  const cell = (used, total) => (total ? `${used}/${total}` : 'not tested');
  const rows = [
    ['Валидный хвост SUMMARY', `${aggregate.validTailPct} %`],
    ['Тип ≠ класс кода (допустимо при обосновании)', `${aggregate.typeMismatchPct} %`],
    ['Повтор категории 4 раза подряд', `${aggregate.categoryRepeatPct} %`],
    ['Флаг качества не упомянут', `${aggregate.flagsMissedPct} %`],
    ['Открытый вопрос есть', `${aggregate.openPresentPct} %`],
    ['Защитных фраз на ответ', String(aggregate.meanDefensivePhrases)],
    ['Советов «запишите RPE/условия»', `${aggregate.asksForEffortCount}/${aggregate.runs}`],
    ['Ответов с числами вне промпта', `${aggregate.withUnsupportedNumbersPct} %`],
    ['Trends: использован хотя бы один показатель', cell(trends.usedAny, trends.prompts)],
    ['Trends: усилие', cell(trends.indicators.effort.used, trends.indicators.effort.present)],
    ['Trends: нагрузка', cell(trends.indicators.load.used, trends.indicators.load.present)],
    ['Trends: восстановление', cell(trends.indicators.recovery.used, trends.indicators.recovery.present)],
    ['Утверждения о здоровье/форме на ручную проверку', `${aggregate.stateClaimAnswers}/${aggregate.runs}`],
  ];
  return [`| Показатель | ${title} |`, '|---|---|', ...rows.map(([label, value]) => `| ${label} | ${value} |`)].join('\n');
}

// entries: [{ file, prompt, response, kind? }] in chronological order; advice categories carry over.
function evaluateEntries(entries) {
  const results = [];
  const categories = [];
  for (const entry of entries) {
    if (!entry?.prompt || !entry?.response || entry.error || (entry.kind && entry.kind !== 'analysis')) continue;
    const prompt = normalizePrompt(entry.prompt);
    const result = checkAnalysisResponse({ response: entry.response, prompt, previousCategories: categories });
    categories.push(result.adviceCategory);
    results.push({ file: entry.file, activityId: entry.activityId ?? null, modelId: entry.modelId ?? null, ...result });
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
  findStateClaims,
  findUnsupportedNumbers,
  formatAggregate,
  formatTableColumn,
  normalizePrompt,
  selectLatestAttempts,
  trendUse,
};
