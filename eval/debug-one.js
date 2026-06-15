/**
 * Diagnostic: run ONE named task once, printing every turn (model text, tool calls,
 * tool results) + the final workspace state. Reveals WHY a task times out / fails.
 *   node debug-one.js <task-name>
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getToolSchemas, makeExecutor } = require('./tools-registry');
const { TASKS } = require('./reliability-tasks');

const client = new Anthropic({ apiKey: 'k', baseURL: process.env.PROXY_URL || 'http://localhost:3000' });
const MODEL = process.env.EVAL_MODEL || 'claude-3-5-sonnet-20241022';
const sys = fs.readFileSync(path.join(__dirname, '..', 'llama-system-prompt.txt'), 'utf8');
const MAX = Number(process.env.EVAL_MAX_TURNS || 6);

(async () => {
  const name = process.argv[2];
  const task = TASKS.find((t) => t.name === name);
  if (!task) { console.error('unknown task', name); process.exit(1); }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
  task.setup(ws);
  const tools = getToolSchemas(task.tools);
  const exec = makeExecutor(ws);
  const messages = [{ role: 'user', content: task.prompt }];
  console.log(`TASK ${name} [${task.category}] :: ${task.prompt.replace(/\n/g, ' ')}`);
  let finalText = null;
  for (let turn = 0; turn < MAX; turn++) {
    let resp;
    try { resp = await client.messages.create({ model: MODEL, max_tokens: 1024, system: sys, tools, messages }); }
    catch (e) { console.log(`turn ${turn + 1}: ERROR ${e.message}`); break; }
    const blocks = resp.content || [];
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const tus = blocks.filter((b) => b.type === 'tool_use');
    console.log(`\n--- turn ${turn + 1} (stop=${resp.stop_reason}) ---`);
    if (texts.trim()) console.log('  TEXT:', JSON.stringify(texts.slice(0, 240)));
    for (const t of tus) console.log('  TOOL_USE:', t.name, JSON.stringify(t.input).slice(0, 220));
    messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    if (tus.length === 0) { finalText = texts; console.log('  >>> FINAL (plain text) — stopping'); break; }
    const results = [];
    for (const t of tus) { const out = await exec(t.name, t.input || {}); console.log('  TOOL_RESULT:', JSON.stringify(String(out).slice(0, 180))); results.push({ type: 'tool_result', tool_use_id: t.id, content: String(out) }); }
    messages.push({ role: 'user', content: results });
  }
  console.log(`\nterminated: ${finalText !== null ? 'plain-text final answer' : 'TIMED OUT (never gave final answer)'}`);
  console.log('verify(by state, finalText=""):', task.verify({ finalText: '', workspace: ws }));
  if (finalText !== null) console.log('verify(by finalText):', task.verify({ finalText, workspace: ws }));
  console.log('workspace files:');
  for (const f of fs.readdirSync(ws)) console.log(`  ${f} =`, JSON.stringify(fs.readFileSync(path.join(ws, f), 'utf8')));
  fs.rmSync(ws, { recursive: true, force: true });
})();
