const fs = require('node:fs/promises');
const path = require('node:path');
const { GLOSSARY } = require('./glossary');
const { UI_STRINGS } = require('./ui-strings');

function normalizeLocale(locale) {
  const normalized = String(locale || '').trim().toLowerCase().replace(/_/g, '-');
  return /^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
}

function translationMessages() {
  return [...new Set([...Object.values(UI_STRINGS), ...Object.values(GLOSSARY)])].sort();
}

function placeholders(text) {
  return [...String(text).matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
}

function parseGeneratedBundle(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('The translation response did not contain a JSON object.');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validateTranslationBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('The translation response must be a JSON object.');
  }
  const expected = translationMessages();
  const actual = Object.keys(bundle).sort();
  if (expected.length !== actual.length || expected.some((message, index) => message !== actual[index])) {
    throw new Error('The translation response does not contain exactly the current UI string catalog.');
  }
  for (const message of expected) {
    const translated = bundle[message];
    if (typeof translated !== 'string' || !translated.trim()) {
      throw new Error(`The translation for "${message}" is empty.`);
    }
    if (placeholders(message).join() !== placeholders(translated).join()) {
      throw new Error(`The translation for "${message}" changed its placeholders.`);
    }
  }
  return bundle;
}

function bundlePath(storagePath, locale) {
  const normalized = normalizeLocale(locale);
  return normalized && storagePath ? path.join(storagePath, 'generated-l10n', `${normalized}.json`) : null;
}

async function loadGeneratedTranslationBundle(storagePath, locale) {
  const filePath = bundlePath(storagePath, locale);
  if (!filePath) return null;
  try {
    return validateTranslationBundle(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

async function loadBundledTranslationBundle(extensionPath, locale) {
  const normalized = normalizeLocale(locale);
  if (!normalized || !extensionPath) return null;
  const candidates = [...new Set([normalized, normalized.split('-')[0]])];
  for (const candidate of candidates) {
    try {
      const filePath = path.join(extensionPath, 'l10n', `bundle.l10n.${candidate}.json`);
      return validateTranslationBundle(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch {
      // Try the language-only fallback when a regional bundle is unavailable.
    }
  }
  return null;
}

async function saveGeneratedTranslationBundle(storagePath, locale, bundle) {
  const filePath = bundlePath(storagePath, locale);
  if (!filePath) throw new Error('The VS Code interface language is not a supported locale tag.');
  validateTranslationBundle(bundle);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
}

module.exports = {
  loadBundledTranslationBundle,
  loadGeneratedTranslationBundle,
  normalizeLocale,
  parseGeneratedBundle,
  saveGeneratedTranslationBundle,
  translationMessages,
  validateTranslationBundle,
};