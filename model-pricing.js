const MarkdownIt = require('markdown-it');

const MODEL_PRICING_URL = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.md';
const MODEL_PRICE_CACHE_KEY = 'fitVisualizer.modelPrices';

// Bundled default-tier USD prices per 1M tokens (2026-10-02), used until a verified update is saved.
const MODEL_PRICES = [
  ['GPT-5 mini', 0.25, 2.0],
  ['GPT-5.3-Codex', 1.75, 14.0],
  ['GPT-5.4', 2.5, 15.0],
  ['GPT-5.4 mini', 0.75, 4.5],
  ['GPT-5.4 nano', 0.2, 1.25],
  ['GPT-5.5', 5.0, 30.0],
  ['GPT-5.6 Luna', 0.2, 1.2],
  ['GPT-5.6 Sol', 4.0, 20.0],
  ['GPT-5.6 Terra', 2.0, 12.0],
  ['GPT-6 Astra', 10.0, 50.0],
  ['GPT-6 Luna', 0.1, 0.5],
  ['GPT-6 Sol', 2.0, 10.0],
  ['GPT-6.1 Sol', 2.0, 10.0],
  ['Claude Haiku 4.5', 1.0, 5.0],
  ['Claude Sonnet 4', 3.0, 15.0],
  ['Claude Sonnet 4.6', 3.0, 15.0],
  ['Claude Opus 4.8', 5.0, 25.0],
  ['Claude Opus 5', 5.0, 25.0],
  ['Claude Opus 5.5', 4.0, 20.0],
  ['Claude Sonnet 5', 2.0, 10.0],
  ['Claude Sonnet 5.5', 2.0, 10.0],
  ['Claude Opus 4.8 (fast mode) (preview)', 10.0, 50.0],
  ['Claude Fable 5', 10.0, 50.0],
  ['Claude Fable 5.1', 10.0, 50.0],
  ['Gemini 3.7 Flash', 0.75, 3.75],
  ['Gemini 3.8 Flash', 0.75, 3.75],
  ['MAI-Code-1.1-Flash', 0.2, 1.2],
  ['Grok 4.5', 2.0, 6.0],
  ['Grok 4.6', 2.0, 6.0],
  ['Grok 4.7', 2.0, 6.0],
  ['Kimi K3', 3.0, 15.0],
].map(([name, inputPrice, outputPrice]) => ({ key: normalizeModelName(name), name, inputPrice, outputPrice }));

let currentPrices = MODEL_PRICES;

// An analysis request is roughly three input tokens per output token.
const INPUT_TOKEN_WEIGHT = 3;

function validateModelPrices(prices) {
  if (!Array.isArray(prices) || !prices.length || prices.length > 2000) {
    throw new Error('No valid model prices found. Previous prices were kept.');
  }
  const keys = new Set();
  return prices.map((price) => {
    const name = typeof price?.name === 'string' ? price.name.trim() : '';
    const key = normalizeModelName(name);
    if (!key || keys.has(key) || !Number.isFinite(price.inputPrice) || price.inputPrice < 0
      || !Number.isFinite(price.outputPrice) || price.outputPrice < 0) {
      throw new Error('Invalid or duplicate model price. Previous prices were kept.');
    }
    keys.add(key);
    return { key, name, inputPrice: price.inputPrice, outputPrice: price.outputPrice };
  });
}

function setModelPrices(prices) {
  currentPrices = validateModelPrices(prices);
}

function restoreModelPriceCache(cache) {
  currentPrices = MODEL_PRICES;
  if (cache?.version !== 1 || cache.sourceUrl !== MODEL_PRICING_URL
    || !Number.isFinite(Date.parse(cache.updatedAt))) return false;
  try {
    setModelPrices(cache.prices);
    return true;
  } catch {
    return false;
  }
}

function parseModelPrices(markdown) {
  if (typeof markdown !== 'string' || !/per\s+1\s+million\s+tokens/i.test(markdown)) {
    throw new Error('Pricing units changed or are missing. Previous prices were kept.');
  }
  const tokens = new MarkdownIt().parse(markdown, {});
  const prices = [];
  let inTable = false;
  let headers = null;
  let row = [];
  let headerRow = false;
  for (const token of tokens) {
    if (token.type === 'table_open') {
      inTable = true;
      headers = null;
    } else if (token.type === 'table_close') {
      inTable = false;
    } else if (inTable && token.type === 'tr_open') {
      row = [];
      headerRow = false;
    } else if (inTable && token.type === 'th_open') {
      headerRow = true;
    } else if (inTable && token.type === 'inline') {
      row.push((token.children || []).filter((child) => child.type === 'text' || child.type === 'code_inline')
        .map((child) => child.content).join('').replace(/\[\^[^\]]+\]/g, '').trim());
    } else if (inTable && token.type === 'tr_close') {
      if (headerRow) {
        headers = row.map((cell) => cell.toLowerCase());
        continue;
      }
      const modelIndex = headers?.indexOf('model') ?? -1;
      const inputIndex = headers?.indexOf('input') ?? -1;
      const outputIndex = headers?.indexOf('output') ?? -1;
      const tierIndex = headers?.indexOf('tier') ?? -1;
      if (modelIndex >= 0 && ((inputIndex < 0) !== (outputIndex < 0))) {
        throw new Error('Pricing columns changed. Previous prices were kept.');
      }
      if (modelIndex < 0 || inputIndex < 0 || outputIndex < 0 || !row[modelIndex]) continue;
      if (tierIndex >= 0) {
        const tier = row[tierIndex]?.toLowerCase();
        if (tier === 'long context') continue;
        if (tier !== 'default') throw new Error('Unrecognized pricing tier. Previous prices were kept.');
      }
      const parsePrice = (value) => {
        if (!/^\$\d+(?:\.\d+)?$/.test(value || '')) {
          throw new Error('Unrecognized model price. Previous prices were kept.');
        }
        return Number(value.slice(1));
      };
      prices.push({ name: row[modelIndex], inputPrice: parsePrice(row[inputIndex]), outputPrice: parsePrice(row[outputIndex]) });
    }
  }
  return validateModelPrices(prices);
}

async function updateModelPrices(storage, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(MODEL_PRICING_URL, {
    signal: AbortSignal.timeout(15000), headers: { Accept: 'text/markdown, text/plain' },
  });
  if (!response.ok) throw new Error(`GitHub pricing download failed (HTTP ${response.status}). Previous prices were kept.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error('GitHub pricing response is too large. Previous prices were kept.');
    chunks.push(chunk);
  }
  const prices = parseModelPrices(Buffer.concat(chunks).toString('utf8'));
  const cache = { version: 1, sourceUrl: MODEL_PRICING_URL, updatedAt: new Date().toISOString(), prices };
  await storage.update(MODEL_PRICE_CACHE_KEY, cache);
  setModelPrices(prices);
  return cache;
}

function normalizeModelName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findModelPrice(model) {
  const candidates = [model?.id, model?.family, model?.name].map(normalizeModelName).filter(Boolean);
  for (const candidate of candidates) {
    const exact = currentPrices.find((entry) => entry.key === candidate);
    if (exact) {
      return exact;
    }
  }
  // Versioned ids such as "gpt-5.4-2026-03-01" still match; the longest key wins so "gpt-5.4-mini" is not read as "gpt-5.4".
  let best = null;
  for (const candidate of candidates) {
    for (const entry of currentPrices) {
      if (candidate.includes(entry.key) && (!best || entry.key.length > best.key.length)) {
        best = entry;
      }
    }
  }
  return best;
}

function modelCost(price) {
  return price.inputPrice * INPUT_TOKEN_WEIGHT + price.outputPrice;
}

// Models with a known price, cheapest first.
function rankModelsByCost(models) {
  return (Array.isArray(models) ? models : [])
    .map((model) => ({ model, price: findModelPrice(model) }))
    .filter((entry) => entry.price)
    .map((entry) => ({ ...entry, cost: modelCost(entry.price) }))
    .sort((left, right) => left.cost - right.cost);
}

module.exports = {
  MODEL_PRICES, MODEL_PRICING_URL, MODEL_PRICE_CACHE_KEY, findModelPrice, normalizeModelName,
  parseModelPrices, rankModelsByCost, restoreModelPriceCache, setModelPrices, updateModelPrices,
};
