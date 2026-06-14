/**
 * Verifiable coding tasks for the eval harness. Each task:
 *  - setup(workspace): create initial files
 *  - tools: which tool names are offered for this task
 *  - prompt: the user instruction
 *  - verify({finalText, workspace}): return true if the task was accomplished
 *
 * Tasks are designed so success REQUIRES using a tool (not just chatting), and so
 * verification is objective (file state or a specific value in the final answer).
 */
const fs = require('fs');
const path = require('path');

function read(workspace, p) {
  try { return fs.readFileSync(path.join(workspace, p), 'utf8'); } catch { return null; }
}

const TASKS = [
  {
    name: 'read-secret',
    tools: ['Read', 'Bash', 'Grep', 'LS'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'config.txt'), 'APP_NAME=demo\nSECRET_VALUE=banana42\nDEBUG=true\n'),
    prompt: 'Read the file config.txt and tell me what SECRET_VALUE equals. State just the value in your final answer.',
    verify: ({ finalText }) => /banana42/.test(finalText || ''),
  },
  {
    name: 'create-file',
    tools: ['Write', 'Read', 'LS'],
    setup: () => {},
    prompt: 'Create a file named greeting.txt whose exact contents are: Hello World',
    verify: ({ workspace }) => (read(workspace, 'greeting.txt') || '').trim() === 'Hello World',
  },
  {
    name: 'edit-version',
    tools: ['Read', 'Edit', 'Bash'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'version.txt'), 'name: myapp\nversion: 1.0.0\n'),
    prompt: 'In version.txt, change the version from 1.0.0 to 2.0.0. Keep everything else the same.',
    verify: ({ workspace }) => {
      const v = read(workspace, 'version.txt') || '';
      return v.includes('2.0.0') && !v.includes('1.0.0') && v.includes('name: myapp');
    },
  },
  {
    name: 'grep-find',
    tools: ['Grep', 'Bash', 'Read', 'LS', 'Glob'],
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\nbeta\n');
      fs.writeFileSync(path.join(ws, 'b.txt'), 'gamma\nNEEDLE_TOKEN\ndelta\n');
      fs.writeFileSync(path.join(ws, 'c.txt'), 'epsilon\n');
    },
    prompt: 'Exactly one file in this workspace contains the text NEEDLE_TOKEN. Find it and tell me the filename in your final answer.',
    verify: ({ finalText }) => /\bb\.txt\b/.test(finalText || ''),
  },
  {
    name: 'count-lines',
    tools: ['Bash', 'Read', 'LS'],
    setup: (ws) => fs.writeFileSync(path.join(ws, 'data.txt'), Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'),
    prompt: 'How many lines are in data.txt? Put the number in your final answer.',
    verify: ({ finalText }) => /\b7\b/.test(finalText || ''),
  },
];

module.exports = { TASKS };
