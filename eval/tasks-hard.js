/**
 * Harder, more diverse eval task set for continuous tuning. Designed to have HEADROOM
 * on a weak 8B model: multi-step, multi-file, nested data, counting, refactors. Each task
 * follows the same shape as tasks.js (setup/tools/prompt/verify).
 */
const fs = require('fs');
const path = require('path');
const read = (ws, p) => { try { return fs.readFileSync(path.join(ws, p), 'utf8'); } catch { return null; } };

const TASKS = [
  // 1. Multi-value edit in one file
  {
    name: 'multi-edit',
    tools: ['Read', 'Edit', 'Bash'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'app.config'), 'host=localhost\nport=8080\nenv=dev\n'),
    prompt: 'In app.config, change port from 8080 to 9090 AND change env from dev to prod. Keep host unchanged.',
    verify: ({ workspace }) => {
      const v = read(workspace, 'app.config') || '';
      return v.includes('port=9090') && v.includes('env=prod') && v.includes('host=localhost') && !v.includes('8080') && !v.includes('=dev');
    },
  },
  // 2. Read a nested JSON field
  {
    name: 'read-json-field',
    tools: ['Read', 'Bash', 'Grep'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'pkg.json'), JSON.stringify({ name: 'demo', version: '3.4.5', author: { name: 'Ada' } }, null, 2)),
    prompt: 'Read pkg.json and tell me the version number. State just the version.',
    verify: ({ finalText }) => /3\.4\.5/.test(finalText || ''),
  },
  // 3. Create a multi-line file with exact content
  {
    name: 'create-multiline',
    tools: ['Write', 'Read'],
    setup: () => {},
    prompt: 'Create a file notes.md with exactly these two lines:\n# Title\n- item one',
    verify: ({ workspace }) => {
      const v = read(workspace, 'notes.md');
      return v !== null && v.replace(/\n+$/, '') === '# Title\n- item one';
    },
  },
  // 4. Count matching lines
  {
    name: 'count-matches',
    tools: ['Bash', 'Grep', 'Read'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'log.txt'), 'INFO start\nERROR a\nINFO mid\nERROR b\nERROR c\nINFO end\n'),
    prompt: 'How many lines in log.txt contain the word ERROR? Put the number in your final answer.',
    verify: ({ finalText }) => /\b3\b/.test(finalText || ''),
  },
  // 5. Replace all occurrences
  {
    name: 'replace-all',
    tools: ['Read', 'Edit', 'Bash'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'code.py'), 'foo = 1\nbar = foo + foo\nprint(foo)\n'),
    prompt: 'In code.py, rename the variable foo to count everywhere it appears.',
    verify: ({ workspace }) => {
      const v = read(workspace, 'code.py') || '';
      return !/\bfoo\b/.test(v) && /count = 1/.test(v) && /count \+ count/.test(v) && /print\(count\)/.test(v);
    },
  },
  // 6. Two-step: find a file then read a value from it
  {
    name: 'find-then-read',
    tools: ['Grep', 'Bash', 'Read', 'LS', 'Glob'],
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, 'one.txt'), 'nothing here\n');
      fs.writeFileSync(path.join(ws, 'two.txt'), 'TOKEN=xyz789\n');
      fs.writeFileSync(path.join(ws, 'three.txt'), 'other stuff\n');
    },
    prompt: 'One file here defines TOKEN. Find that file, then tell me the value of TOKEN.',
    verify: ({ finalText }) => /xyz789/.test(finalText || ''),
  },
  // 7. Append a line
  {
    name: 'append-line',
    tools: ['Read', 'Edit', 'Bash', 'Write'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'list.txt'), 'apple\nbanana\n'),
    prompt: 'Add a new line with the word cherry to the end of list.txt, keeping the existing lines.',
    verify: ({ workspace }) => {
      const v = (read(workspace, 'list.txt') || '').trim().split('\n');
      return v[0] === 'apple' && v[1] === 'banana' && v[2] === 'cherry';
    },
  },
  // 8. Which file has the most lines
  {
    name: 'most-lines',
    tools: ['Bash', 'Read', 'LS', 'Glob'],
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, 'short.txt'), 'a\nb\n');
      fs.writeFileSync(path.join(ws, 'long.txt'), 'a\nb\nc\nd\ne\n');
      fs.writeFileSync(path.join(ws, 'mid.txt'), 'a\nb\nc\n');
    },
    prompt: 'Which of the .txt files here has the most lines? Tell me the filename.',
    verify: ({ finalText }) => /long\.txt/.test(finalText || ''),
  },
  // 9. Read two files and compare
  {
    name: 'compare-values',
    tools: ['Read', 'Bash', 'Grep'],
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, 'a.env'), 'TIMEOUT=30\n');
      fs.writeFileSync(path.join(ws, 'b.env'), 'TIMEOUT=60\n');
    },
    prompt: 'a.env and b.env each set TIMEOUT. Which file has the LARGER TIMEOUT value? Tell me the filename.',
    verify: ({ finalText }) => /b\.env/.test(finalText || ''),
  },
  // 10. Delete a line containing a word
  {
    name: 'delete-line',
    tools: ['Read', 'Edit', 'Bash', 'Write'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'data.csv'), 'keep1\nDELETEME\nkeep2\n'),
    prompt: 'Remove the line containing DELETEME from data.csv. Keep the other lines.',
    verify: ({ workspace }) => {
      const v = (read(workspace, 'data.csv') || '').trim();
      return v === 'keep1\nkeep2' && !/DELETEME/.test(v);
    },
  },
];

module.exports = { TASKS };
