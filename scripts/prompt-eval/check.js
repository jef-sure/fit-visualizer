#!/usr/bin/env node
// Usage: node scripts/prompt-eval/check.js <logs-dir> [baseline-dir] [--format N] [--baseline-format N] [--table] [--claims]
//
// Reads the extension's LLM logs (<database folder>/logs) directly: for the chosen analysis format
// (the newest one found unless --format is given) it takes the LAST attempt per activity, lists
// attempts that ended in an error separately, and evaluates the rest oldest first. Each *.json
// file needs { prompt, response } and may carry { activityId, timestamp, analysisVersion, kind,
// modelId, error }; the prompt may be a string or a list of messages.
//   --table   also print the figures as a markdown column for the plan's results table
//   --claims  also print every health/form sentence that needs a person's judgement

const fs = require('node:fs');
const path = require('node:path');
const {
  aggregateChecks, describeResult, evaluateEntries, formatAggregate, formatTableColumn, selectLatestAttempts,
} = require('../../prompt-eval');

function readDirectory(dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    try {
      entries.push({ file: name, ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) });
    } catch {
      // unreadable log files are skipped
    }
  }
  return entries;
}

function evaluateDirectory(dir, { analysisVersion = null } = {}) {
  const selection = selectLatestAttempts(readDirectory(dir), { analysisVersion });
  return { selection, results: evaluateEntries(selection.entries) };
}

function parseArgs(argv) {
  const options = { dirs: [], table: false, claims: false, format: null, baselineFormat: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--table') options.table = true;
    else if (arg === '--claims') options.claims = true;
    else if (arg === '--format') options.format = Number(argv[index += 1]);
    else if (arg === '--baseline-format') options.baselineFormat = Number(argv[index += 1]);
    else options.dirs.push(arg);
  }
  return options;
}

function describeSelection(selection) {
  const models = Object.entries(selection.models).map(([id, count]) => `${id} x${count}`).join(', ');
  const lines = [
    `format ${selection.analysisVersion ?? 'unknown'} (found: ${selection.versionsFound.join(', ') || 'none'}); `
      + `${selection.attempts} attempts, ${selection.entries.length + selection.failed.length} activities, `
      + `${selection.entries.length} evaluated, ${selection.failed.length} failed`,
    `models of the last attempts: ${models || 'none'}${Object.keys(selection.models).length > 1 ? '  <- mixed: compare with care' : ''}`,
  ];
  for (const failure of selection.failed) lines.push(`FAILED activity ${failure.activityId ?? '?'} (${failure.file}): ${failure.error}`);
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [dir, baselineDir] = options.dirs;
  if (!dir) {
    console.error('Usage: node scripts/prompt-eval/check.js <logs-dir> [baseline-dir] [--format N] [--baseline-format N] [--table] [--claims]');
    process.exit(2);
  }
  const { selection, results } = evaluateDirectory(dir, { analysisVersion: options.format });
  for (const item of results) console.log(describeResult(item));
  console.log(`\n${describeSelection(selection)}`);
  if (!results.length) {
    console.log('\nNothing to evaluate: no criterion is tested by an empty sample.');
    process.exit(1);
  }
  const baseline = baselineDir || options.baselineFormat != null
    ? aggregateChecks(evaluateDirectory(baselineDir || dir, { analysisVersion: options.baselineFormat }).results) : null;
  const aggregate = aggregateChecks(results);
  console.log(`\n${formatAggregate(aggregate, baseline)}`);
  if (options.claims) {
    console.log('\nHealth/form statements to review (a denial in the same sentence is already excluded):');
    for (const item of results) {
      for (const sentence of item.stateClaims.candidates) console.log(`- ${item.activityId ?? item.file}: ${sentence}`);
    }
  }
  if (options.table) console.log(`\n${formatTableColumn(aggregate, `v${selection.analysisVersion ?? '?'}`)}`);
}

if (require.main === module) main();
module.exports = { evaluateDirectory };
