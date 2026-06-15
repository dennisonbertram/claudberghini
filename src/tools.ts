/**
 * Tool-call translation layer for Claudberghini (Llama 3.1 8B).
 *
 * Claudberghini's /api/chat has no native `tools` parameter and Llama 3.1 8B does not
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
// Claudberghini's ~24KB input ceiling. Keeps param names, types, required flags, and
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
  return `You are a coding agent. When a task needs you to read, run, or change something on disk, you do it by emitting a tool call — you cannot do it by describing it in prose.

WHEN TO USE A TOOL vs. JUST REPLY:
- If the user greets you, chats, or asks a general question that needs NO file/command action (e.g. "hi", "what can you do?", "explain recursion"), reply in plain text. Do NOT call a tool.
- If the user asks you to read/find/edit/create/run something, emit the right tool call.

PHASE 1: TOOL USE (for real tasks)
Pick the right tool for the job:
${toolDescriptions}

TOOL CALL FORMAT (exact) — output ONLY this, no prose before or after:
<tool_call>{"name": "TOOL_NAME", "input": {"PARAM": "VALUE"}}</tool_call>

Replace TOOL_NAME, PARAM and VALUE with the REAL tool and the REAL paths/values taken
from the USER'S REQUEST. The format above is a template — never copy its placeholders or
any example path literally. Always use the exact file paths and values the user gave you.

RULES:
1. Valid JSON, double quotes, exactly two keys: "name" and "input".
2. "name" MUST be one listed above — never invent one. Include every required param.
3. ONE tool call at a time. After emitting </tool_call>, STOP IMMEDIATELY — output nothing else.
4. NEVER write the tool's output yourself. Do NOT write "## Output from tool" or "The final answer is" right after a tool call. The REAL result will be sent to you in the next message; wait for it.
5. Use the file paths / arguments from the user's message, not from these instructions.${mustUse}

PHASE 2: FINAL ANSWER
After the tool output comes back, parse it carefully, extract the exact value requested, and state your result plainly in one line. Only answer in plain text (no tool call) when the task is fully done or genuinely needs no tool.`;
}

/**
 * Strip trailing commas (`,` immediately before `}` or `]`) that are OUTSIDE
 * string literals. A naive regex over the whole string corrupts values that
 * legitimately contain the substrings ",}" or ",]".
 */
function stripTrailingCommas(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (inStr) {
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') inStr = false;
      out += ch;
      continue;
    }
    // Outside a string: check for a comma that is immediately followed (ignoring
    // whitespace) by a closing brace or bracket.
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      // Peek ahead past whitespace
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
      if (j < s.length && (s[j] === '}' || s[j] === ']')) {
        // Drop this comma; do NOT add it to `out`
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Convert single-quoted JSON to double-quoted JSON, handling:
 *   - Single-quote string delimiters → double quotes
 *   - Literal double quotes inside single-quoted spans → escaped \"
 *   - Apostrophes inside double-quoted spans are left alone
 * This is intentionally structural (char-by-char state machine) rather than a
 * blind global replace, so {'command':'echo "hi"'} parses successfully.
 * If the input already uses double quotes it is returned unchanged.
 */
function convertSingleToDoubleQuotes(s: string): string {
  // Only attempt if there are single quotes and we can plausibly rewrite them.
  if (!s.includes("'")) return s;

  let out = '';
  let i = 0;
  // Track what delimiter opened the current string ('single' | 'double' | null)
  let strDelim: string | null = null;
  let esc = false;

  while (i < s.length) {
    const ch = s[i];

    if (esc) {
      out += ch;
      esc = false;
      i++;
      continue;
    }

    if (strDelim !== null) {
      // Inside a string
      if (ch === '\\') {
        out += ch;
        esc = true;
        i++;
        continue;
      }
      if (ch === strDelim) {
        // Close the string
        out += '"';
        strDelim = null;
        i++;
        continue;
      }
      if (strDelim === "'" && ch === '"') {
        // Literal double quote inside a single-quoted string — must be escaped
        out += '\\"';
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    // Outside any string
    if (ch === "'") {
      // Open a single-quoted string, emit double-quote
      strDelim = "'";
      out += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      // Open a double-quoted string as-is
      strDelim = '"';
      out += '"';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Attempt to repair common malformed-JSON issues from small models.
 * Exported so it can be unit-tested independently.
 */
export function repairJson(raw: string): Record<string, any> | null {
  // Fast path: already valid
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to repair
  }

  let c = raw.trim();
  // Strip code fences and stray closing tags
  c = c.replace(/^```(json)?/i, '').replace(/```$/, '').replace(/<\/?tool_call>/g, '').trim();

  // Single → double quote structural conversion (handles embedded " inside '' spans).
  // Run before the trailing-comma pass so the string scanner sees real double-quote
  // delimiters either way.
  if (c.includes("'")) c = convertSingleToDoubleQuotes(c);

  // Remove trailing commas before a closing brace/bracket — string-aware to avoid
  // corrupting values that legitimately contain ",}" or ",]".
  c = stripTrailingCommas(c);

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
  c = c.replace(/,\s*$/, ''); // drop a dangling trailing comma at end-of-string
  while (depthSquare-- > 0) c += ']';
  while (depthCurly-- > 0) c += '}';

  try {
    return JSON.parse(c);
  } catch {
    return null;
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
  //
  // We do NOT use a non-greedy regex here because a tool input value may legitimately
  // contain the substring `</tool_call>` (e.g. Bash commands, Write content, Edit strings).
  // A non-greedy match would stop at the FIRST inner occurrence and truncate the JSON.
  //
  // Instead: find each <tool_call> opener, locate the first `{`, then scan forward with
  // a STRING-AWARE brace-depth counter to find the balanced closing `}`.  That span is
  // the JSON object.  The trailing `</tool_call>` (if present) is then consumed/stripped.
  {
    let remaining = cleaned;
    let result = '';
    const openerRe = /<tool_call>/i;

    while (true) {
      const m = openerRe.exec(remaining);
      if (!m) {
        // No more openers — append whatever is left
        result += remaining;
        break;
      }

      // Text before this opener goes to output unchanged
      result += remaining.slice(0, m.index);
      // Advance past the <tool_call> tag itself
      let pos = m.index + m[0].length;

      // Skip optional whitespace between the tag and the opening brace
      while (pos < remaining.length && /\s/.test(remaining[pos])) pos++;

      if (pos >= remaining.length || remaining[pos] !== '{') {
        // No JSON object follows — drop the opener tag, keep scanning the rest
        remaining = remaining.slice(pos);
        continue;
      }

      // Scan forward from the opening `{` with a string-aware brace-depth counter
      // to find the matching closing `}`.
      let depth = 0;
      let inString = false;
      let escape = false;
      let jsonEnd = -1;
      for (let i = pos; i < remaining.length; i++) {
        const ch = remaining[i];
        if (escape) { escape = false; continue; }
        if (inString) {
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { jsonEnd = i; break; }
        }
      }

      if (jsonEnd === -1) {
        // Unbalanced / truncated — hand the remainder (from `{`) to repairJson
        const fragment = remaining.slice(pos);
        const obj = repairJson(fragment);
        if (obj && typeof obj.name === 'string' && validToolNames.has(obj.name)) {
          toolUses.push({ id: nextToolUseId(), name: obj.name, input: obj.input ?? {} });
        }
        // Consumed everything
        remaining = '';
        break;
      }

      const jsonSpan = remaining.slice(pos, jsonEnd + 1);
      const obj = repairJson(jsonSpan);
      if (obj && typeof obj.name === 'string' && validToolNames.has(obj.name)) {
        toolUses.push({ id: nextToolUseId(), name: obj.name, input: obj.input ?? {} });
        // drop it from visible text (emit nothing for this block)
      }
      // else: drop malformed tool-call tags from visible text regardless

      // Consume the optional trailing </tool_call> (with optional whitespace before it)
      let after = jsonEnd + 1;
      while (after < remaining.length && /\s/.test(remaining[after])) after++;
      const closerLen = '</tool_call>'.length;
      if (remaining.slice(after, after + closerLen).toLowerCase() === '</tool_call>') {
        after += closerLen;
      }

      remaining = remaining.slice(after);
    }

    cleaned = result;
  }

  // Fallback: a MALFORMED or UNCLOSED opener — `<tool_call>`, `<tool_call {`,
  // `<tool_call=`, missing the closing `>`, etc. (8B mangles the tag constantly). Find the
  // opener, then the first `{` after it, and parse the JSON from there to end-of-text.
  if (toolUses.length === 0) {
    const openMatch = cleaned.match(/<tool_call/i);
    if (openMatch && openMatch.index !== undefined) {
      const afterOpen = cleaned.slice(openMatch.index);
      const braceIdx = afterOpen.indexOf('{');
      if (braceIdx >= 0) {
        const obj = repairJson(afterOpen.slice(braceIdx));
        if (obj && typeof obj.name === 'string' && validToolNames.has(obj.name)) {
          toolUses.push({ id: nextToolUseId(), name: obj.name, input: obj.input ?? {} });
          cleaned = cleaned.slice(0, openMatch.index);
        }
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

  // Strip any orphaned tool-call tag fragments the model leaked (e.g. a stray
  // </tool_call> or a <tool_call> for an invalid tool name) so they don't show as text.
  cleaned = cleaned
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<function=[a-zA-Z0-9_]*>?/gi, '')
    .replace(/<\/function>/gi, '')
    .trim();

  return { text: cleaned, toolUses };
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
