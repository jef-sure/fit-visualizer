// LLM request-log retention. Kept free of the vscode import so tests can exercise the retention
// stages directly on a temp directory.
//
// A log past its retention keeps the metric history but drops the bulky prompt; only after three
// times the retention is the whole file removed. `check.js` still sees response / promptBlocks /
// overBudget / modelId / analysisVersion, so metric history survives while space is reclaimed.

const fs = require('node:fs/promises');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

function stripPromptFromLogFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || !('prompt' in parsed)) {
    return null;
  }
  const { prompt: _prompt, ...rest } = parsed;
  return rest;
}

async function pruneLlmLogs(logDir, analysisRetentionDays, chatRetentionDays) {
  const analysisCutoff = analysisRetentionDays ? Date.now() - analysisRetentionDays * DAY_MS : null;
  const chatCutoff = chatRetentionDays ? Date.now() - chatRetentionDays * DAY_MS : null;
  const analysisHardCutoff = analysisRetentionDays ? Date.now() - 3 * analysisRetentionDays * DAY_MS : null;
  const chatHardCutoff = chatRetentionDays ? Date.now() - 3 * chatRetentionDays * DAY_MS : null;
  try {
    const names = await fs.readdir(logDir);
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const isConversationLog = name.endsWith('-chat.json') || name.endsWith('-comparison.json');
      const cutoff = isConversationLog ? chatCutoff : analysisCutoff;
      const hardCutoff = isConversationLog ? chatHardCutoff : analysisHardCutoff;
      if (!cutoff) {
        continue;
      }
      const filePath = path.join(logDir, name);
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs >= cutoff) {
        continue;
      }
      if (hardCutoff && stats.mtimeMs < hardCutoff) {
        await fs.unlink(filePath);
        continue;
      }
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const compressed = stripPromptFromLogFile(parsed);
        if (compressed) {
          const atime = new Date(stats.atimeMs);
          const mtime = new Date(stats.mtimeMs);
          await fs.writeFile(filePath, JSON.stringify(compressed, null, 2));
          // Preserve the original timestamp so the 3x-retention clock is not reset by rewriting.
          await fs.utimes(filePath, atime, mtime);
        }
      } catch {
        // A single unreadable file must not stop the sweep.
      }
    }
  } catch {
    // Log housekeeping is best effort.
  }
}

module.exports = { stripPromptFromLogFile, pruneLlmLogs };
