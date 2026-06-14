/**
 * Tool-call translation layer for ChatJimmy (Llama 3.1 8B).
 *
 * ChatJimmy's /api/chat has no native `tools` parameter and Llama 3.1 8B does not
 * emit native Anthropic tool_use blocks. So we:
 *   1. Inject tool definitions + STRICT formatting rules into the system prompt.
 *   2. Parse the model's text output for <tool_call>{...}</tool_call> patterns.
 *   3. Convert those into Anthropic tool_use content blocks.
 *
 * Format choice: <tool_call>{"name":...,"input":{...}}</tool_call>. JSON maps 1:1 to
 * Anthropic's tool_use (name + input), and the explicit delimiter is the most reliable
 * pattern for 8B per BFCL/Braintrust findings.
 */

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: { type?: string; properties?: Record<string, any>; required?: string[] };
}

export interface ParsedToolUse {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ParsedOutput {
  text: string;
  toolUses: ParsedToolUse[];
}

let toolUseCounter = 0;
function nextToolUseId(): string {
  toolUseCounter += 1;
  return `toolu_${Date.now()}_${toolUseCounter}`;
}

/**
 * Build the strict tool-use instruction block injected into the system prompt.
 * Strong, explicit rules are essential — Llama 3.1 8B is a weak tool-follower by default.
 */
// Compact a JSON schema down to the fields that matter for an 8B model, to fit
// ChatJimmy's ~24KB input ceiling. Keeps param names, types, required flags, and
// short descriptions; drops $schema/$defs/additionalProperties/examples/etc.
function compactSchema(schema?: AnthropicTool['input_schema']): string {
  if (!schema || !schema.properties) return '{}';
  const required = new Set(schema.required ?? []);
  const params = Object.entries(schema.properties).map(([name, def]: [string, any]) => {
    const type = def?.type ?? 'any';
    const req = required.has(name) ? ' (required)' : '';
    let desc = typeof def?.description === 'string' ? def.description.split('\n')[0] : '';
    if (desc.length > 80) desc = desc.slice(0, 80) + '…';
    const enumVals = Array.isArray(def?.enum) ? ` [${def.enum.join('|')}]` : '';
    return `${name}:${type}${req}${enumVals}${desc ? ` — ${desc}` : ''}`;
  });
  return params.join('; ');
}

export function buildToolSystemPrompt(tools: AnthropicTool[], toolChoice?: any): string {
  const toolDescriptions = tools
    .map((t) => {
      let desc = (t.description || '').split('\n')[0];
      if (desc.length > 120) desc = desc.slice(0, 120) + '…';
      return `- ${t.name}(${compactSchema(t.input_schema)})${desc ? `: ${desc}` : ''}`;
    })
    .join('\n');

  const mustUse =
    toolChoice && (toolChoice.type === 'any' || toolChoice.type === 'tool')
      ? '\nYou MUST call a tool this turn. Do not answer in plain prose.'
      : '';

  // Structure tuned by the eval optimizer (eval/best-config.json): a phased
  // "mandatory tool use + decision matrix, then plain final answer" prompt lifted the
  // agent eval score from 0.67 → 0.93 on Llama 3.1 8B.
  return `You are a coding agent. You accomplish goals using tools. You CANNOT read files, run commands, or edit anything by describing it — you MUST emit a tool call.

PHASE 1: TOOL USE (MANDATORY)
Almost every task requires a tool call. Pick the right tool for the job:
${toolDescriptions}

TOOL CALL FORMAT (exact) — output ONLY this, no prose before or after:
<tool_call>{"name": "TOOL_NAME", "input": {"PARAM": "VALUE"}}</tool_call>

Replace TOOL_NAME, PARAM and VALUE with the REAL tool and the REAL paths/values taken
from the USER'S REQUEST. The format above is a template — never copy its placeholders or
any example path literally. Always use the exact file paths and values the user gave you.

RULES:
1. Valid JSON, double quotes, exactly two keys: "name" and "input".
2. "name" MUST be one listed above — never invent one. Include every required param.
3. ONE tool call at a time. After the tool result returns, call another tool or give your final answer.
4. Use the file paths / arguments from the user's message, not from these instructions.${mustUse}

PHASE 2: FINAL ANSWER
After the tool output comes back, parse it carefully, extract the exact value requested, and state your result plainly in one line. Only answer in plain text (no tool call) when the task is fully done or genuinely needs no tool.`;
}

/**
 * Attempt to repair common malformed-JSON issues from small models.
 */
function repairJson(raw: string): Record<string, any> | null {
  try {
    return JSON.parse(raw);
  } catch {
    let c = raw.trim();
    // Strip code fences and stray closing tags
    c = c.replace(/^```(json)?/i, '').replace(/```$/, '').replace(/<\/?tool_call>/g, '').trim();
    // Single → double quotes (only if no double quotes present)
    if (!c.includes('"') && c.includes("'")) c = c.replace(/'/g, '"');
    // Remove trailing commas before a closing brace/bracket
    c = c.replace(/,(\s*[}\]])/g, '$1');
    // Balance braces/brackets — 8B models frequently truncate before closing them.
    // Count unclosed { and [ (ignoring those inside strings) and append closers.
    let depthCurly = 0;
    let depthSquare = 0;
    let inStr = false;
    let esc = false;
    for (const ch of c) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depthCurly++;
      else if (ch === '}') depthCurly--;
      else if (ch === '[') depthSquare++;
      else if (ch === ']') depthSquare--;
    }
    if (inStr) c += '"';
    c = c.replace(/,\s*$/, ''); // drop a dangling trailing comma
    while (depthSquare-- > 0) c += ']';
    while (depthCurly-- > 0) c += '}';
    try {
      return JSON.parse(c);
    } catch {
      return null;
    }
  }
}

/**
 * Parse model output text into clean text + extracted tool_use blocks.
 * Handles the canonical <tool_call>{...}</tool_call> form, plus a couple of
 * fallback patterns Llama sometimes emits.
 */
export function parseToolCalls(text: string, validToolNames: Set<string>): ParsedOutput {
  const toolUses: ParsedToolUse[] = [];
  let cleaned = text;

  // Primary: <tool_call>{...}</tool_call>
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  cleaned = cleaned.replace(tagRe, (_m, body) => {
    const obj = repairJson(body);
    if (obj && typeof obj.name === 'string' && validToolNames.has(obj.name)) {
      toolUses.push({ id: nextToolUseId(), name: obj.name, input: obj.input ?? {} });
      return '';
    }
    return ''; // drop malformed tool-call tags from visible text
  });

  // Fallback: an UNCLOSED <tool_call> (8B often forgets the closing tag). Parse from
  // the opener to end-of-text. Only runs if no well-formed tool call was found.
  if (toolUses.length === 0) {
    const openIdx = cleaned.search(/<tool_call>/i);
    if (openIdx >= 0) {
      const body = cleaned.slice(openIdx + '<tool_call>'.length);
      const obj = repairJson(body);
      if (obj && typeof obj.name === 'string' && validToolNames.has(obj.name)) {
        toolUses.push({ id: nextToolUseId(), name: obj.name, input: obj.input ?? {} });
        cleaned = cleaned.slice(0, openIdx);
      }
    }
  }

  // Fallback 2: a bare JSON object with name+input and no tags at all.
  if (toolUses.length === 0) {
    const trimmed = cleaned.trim();
    if (trimmed.startsWith('{')) {
      const obj = repairJson(trimmed);
      if (obj && typeof obj.name === 'string' && validToolNames.has(obj.name) && obj.input) {
        toolUses.push({ id: nextToolUseId(), name: obj.name, input: obj.input ?? {} });
        cleaned = '';
      }
    }
  }

  // Fallback: <function=NAME>{...}</function> (Llama's other common format)
  const fnRe = /<function=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/function>/gi;
  cleaned = cleaned.replace(fnRe, (_m, name, body) => {
    if (validToolNames.has(name)) {
      const obj = repairJson(body) ?? {};
      toolUses.push({ id: nextToolUseId(), name, input: obj });
      return '';
    }
    return '';
  });

  return { text: cleaned.trim(), toolUses };
}

/**
 * Build the Anthropic `content` array from parsed text + tool uses.
 */
export function buildContentBlocks(parsed: ParsedOutput): any[] {
  const blocks: any[] = [];
  if (parsed.text) {
    blocks.push({ type: 'text', text: parsed.text });
  }
  for (const tu of parsed.toolUses) {
    blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
  }
  // Anthropic requires at least one content block
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  return blocks;
}
