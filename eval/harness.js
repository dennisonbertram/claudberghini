/**
 * Minimal agentic loop — a tiny stand-in for Claude Code — that drives the model
 * through the Claudberghini proxy using the Anthropic SDK. Full control over system
 * prompt and toolset, so we can optimize them.
 */
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: 'eval-key',
  baseURL: process.env.PROXY_URL || 'http://localhost:3000',
});

const MODEL = process.env.EVAL_MODEL || 'claude-3-5-sonnet-20241022';

/**
 * Run one agent episode.
 * @returns {finalText, turns, toolCalls, timedOut}
 */
async function runAgentLoop({ system, tools, userPrompt, executeTool, maxTurns = 6 }) {
  const messages = [{ role: 'user', content: userPrompt }];
  let toolCalls = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools,
        messages,
      });
    } catch (e) {
      return { finalText: `__ERROR__ ${e.message}`, turns: turn + 1, toolCalls, error: true };
    }

    const blocks = Array.isArray(resp.content) ? resp.content : [];
    messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });

    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { finalText: text, turns: turn + 1, toolCalls, timedOut: false };
    }

    // Execute each tool call and feed results back
    const results = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      const out = await executeTool(tu.name, tu.input || {});
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
    }
    messages.push({ role: 'user', content: results });
  }

  return { finalText: null, turns: maxTurns, toolCalls, timedOut: true };
}

module.exports = { runAgentLoop };
