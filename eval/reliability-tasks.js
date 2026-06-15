/**
 * Categorized task set for the reliability eval. Reuses the verified tasks from
 * tasks.js + tasks-hard.js (objective pass/fail verifiers) and tags each with a
 * capability CATEGORY, plus a few extra tasks to thicken thin categories so each
 * category has enough samples for a meaningful reliability read.
 *
 * Categories (what we want to know we can reliably task the model with):
 *   read-extract  — read a file and report a specific value
 *   search-find   — locate which file/line contains some text
 *   edit-inplace  — modify an existing file (change/replace/append/delete)
 *   create-write  — write a NEW file with exact content
 *   count-analyze — compute/compare over file content (counts, max, comparisons)
 */
const fs = require('fs');
const path = require('path');
const read = (ws, p) => { try { return fs.readFileSync(path.join(ws, p), 'utf8'); } catch { return null; } };

const core = require('./tasks').TASKS;
const hard = require('./tasks-hard').TASKS;

// Map existing task name → capability category.
const CATEGORY = {
  // read-extract
  'read-secret': 'read-extract',
  'read-json-field': 'read-extract',
  // search-find
  'grep-find': 'search-find',
  'find-then-read': 'search-find',
  // edit-inplace
  'edit-version': 'edit-inplace',
  'multi-edit': 'edit-inplace',
  'replace-all': 'edit-inplace',
  'append-line': 'edit-inplace',
  'delete-line': 'edit-inplace',
  // create-write
  'create-file': 'create-write',
  'create-multiline': 'create-write',
  // count-analyze
  'count-lines': 'count-analyze',
  'count-matches': 'count-analyze',
  'most-lines': 'count-analyze',
  'compare-values': 'count-analyze',
};

// Extra tasks to thicken thin categories (create-write was both weak AND under-sampled).
const extra = [
  {
    name: 'create-json', category: 'create-write', tools: ['Write', 'Read'],
    setup: () => {},
    prompt: 'Create a file config.json containing exactly this JSON: {"port": 8080}',
    verify: ({ workspace }) => {
      const v = read(workspace, 'config.json');
      if (v === null) return false;
      try { const o = JSON.parse(v); return o && o.port === 8080 && Object.keys(o).length === 1; } catch { return false; }
    },
  },
  {
    name: 'create-readme', category: 'create-write', tools: ['Write', 'Read'],
    setup: () => {},
    prompt: 'Create a file README.md whose only line is exactly: # My Project',
    verify: ({ workspace }) => (read(workspace, 'README.md') || '').replace(/\n+$/, '') === '# My Project',
  },
  {
    name: 'read-kv', category: 'read-extract', tools: ['Read', 'Bash', 'Grep'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'settings.env'), 'MODE=fast\nRETRIES=4\nLEVEL=debug\n'),
    prompt: 'In settings.env, what value is RETRIES set to? State just the value.',
    verify: ({ finalText }) => /(^|[^0-9])4([^0-9]|$)/.test(finalText || ''),
  },
  {
    name: 'which-file-token', category: 'search-find', tools: ['Grep', 'Bash', 'Read', 'LS', 'Glob'],
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, 'x.log'), 'foo\n');
      fs.writeFileSync(path.join(ws, 'y.log'), 'MARKER_Z\n');
      fs.writeFileSync(path.join(ws, 'z.log'), 'bar\n');
    },
    prompt: 'Which file contains MARKER_Z? Tell me the filename.',
    verify: ({ finalText }) => /\by\.log\b/.test(finalText || ''),
  },
];

const TASKS = [...core, ...hard]
  .map((t) => ({ ...t, category: CATEGORY[t.name] || 'other' }))
  .concat(extra);

module.exports = { TASKS, CATEGORY };
