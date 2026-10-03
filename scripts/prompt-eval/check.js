#!/usr/bin/env node
// Usage: node scripts/prompt-eval/check.js <dir-with-json-runs> [baseline-dir]
// Each *.json file needs { prompt, response, kind? }; files whose kind is not "analysis" are
// skipped. Meant for the extension's LLM logs (<database folder>/logs), ideally copied into a
// folder per run with names that sort chronologically so advice-category history builds up.
// The optional second directory is a baseline run for the deltas.

const fs = require('node:fs');
const path = require('node:path');
const { aggregateChecks, describeResult, evaluateEntries, formatAggregate } = require('../../prompt-eval');

function evaluateDirectory(dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    try {
      entries.push({ file: name, ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) });
    } catch {
      // unreadable log files are skipped
    }
  }
  return evaluateEntries(entries);
}

function main() {
  const [dir, baselineDir] = process.argv.slice(2);
  if (!dir) {
    console.error('Usage: node scripts/prompt-eval/check.js <dir> [baseline-dir]');
    process.exit(2);
  }
  const results = evaluateDirectory(dir);
  for (const item of results) console.log(describeResult(item));
  const baseline = baselineDir ? aggregateChecks(evaluateDirectory(baselineDir)) : null;
  console.log(`\n${formatAggregate(aggregateChecks(results), baseline)}`);
}

if (require.main === module) main();
module.exports = { evaluateDirectory };
