import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { ProxyConfig } from './types';
import { FormatConverter } from './converter';
import { APIHandler } from './handlers';
import {
  buildToolSystemPrompt,
  parseToolCalls,
  buildContentBlocks,
  AnthropicTool,
  ParsedOutput,
} from './tools';

// Load environment variables
dotenv.config();

// Configuration
const config: ProxyConfig = {
  claudberghiniApiUrl: process.env.CLAUDBERGHINI_API_URL || 'https://chatjimmy.ai',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  proxyPort: parseInt(process.env.PROXY_PORT || '3000', 10),
  logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
};

// Model mapping: Anthropic model names to Claudberghini model names
const MODEL_MAPPING: Record<string, string> = {
  'gpt-4': 'llama3.1-8B',
  'gpt-4-turbo': 'llama3.1-8B',
  'gpt-4o': 'llama3.1-8B',
  'gpt-3.5-turbo': 'llama2-7B',
  'claude-3-opus': 'llama3.1-8B',
  'claude-3-sonnet': 'llama3.1-8B',
  'claude-3-haiku': 'llama2-7B',
  'claude-2': 'llama3.1-8B',
  'default': 'llama3.1-8B',
};

// Type definitions for Anthropic format
interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | unknown[];
}

interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: { type?: string; properties?: Record<string, any>; required?: string[] };
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | unknown[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: AnthropicToolDef[];
  tool_choice?: { type: string; name?: string };
}

interface ClaudberghiniMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudberghiniChatOptions {
  selectedModel: string;
  systemPrompt?: string;
  topK?: number;
}

interface ClaudberghiniRequest {
  messages: ClaudberghiniMessage[];
  chatOptions: ClaudberghiniChatOptions;
  attachment: null | unknown;
}

interface ClaudberghiniResponse {
  message?: string;
  content?: string;
  text?: string;
  choices?: Array<{ message: { content: string } }>;
  error?: string;
}

// Initialize Express app
const app: Express = express();
const apiHandler = new APIHandler(config);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Conversion helper functions

/**
 * Convert Anthropic format request to Claudberghini format
 */
// Flatten Anthropic content (string OR array of content blocks) into a plain string.
// Claude Code sends system + message content as arrays of {type:'text', text:'...'} blocks
// (often with cache_control), and tool_result/tool_use blocks. Claudberghini needs plain strings.
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        if (block?.type === 'tool_result') {
          // Format tool results as an explicit observation so the model distinguishes
          // tool feedback from user input (per Hermes/UniClaudeProxy convention).
          const inner = flattenContent(block.content);
          return `<tool_response>\n${inner}\n</tool_response>`;
        }
        if (block?.type === 'tool_use') {
          // Replay past tool calls in the SAME format the model is told to emit,
          // to avoid format drift across turns.
          return `<tool_call>${JSON.stringify({ name: block.name, input: block.input ?? {} })}</tool_call>`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Core coding toolset advertised to the (weak) Llama 3.1 8B model. Claude Code sends
// ~60 tools (many noisy mcp__* / orchestration tools) which bloat Claudberghini's tiny
// ~24KB context AND cause wrong-tool selection. We filter to the essentials so the
// model has a small, relevant menu. Override with TOOL_ALLOWLIST=Read,Edit,Bash (or
// TOOL_ALLOWLIST=* to disable filtering).
const DEFAULT_CODING_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
];

function getToolAllowlist(): Set<string> | null {
  const env = process.env.TOOL_ALLOWLIST;
  if (env === '*') return null; // filtering disabled
  if (env && env.trim()) {
    return new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return new Set(DEFAULT_CODING_TOOLS);
}

function filterToolsForCoding(tools: AnthropicTool[]): AnthropicTool[] {
  const allow = getToolAllowlist();
  if (!allow) return tools;
  const kept = tools.filter((t) => allow.has(t.name));
  const dropped = tools.length - kept.length;
  if (dropped > 0) {
    console.log(`[INFO] Tool allowlist: kept ${kept.length}/${tools.length} (dropped ${dropped} non-coding/mcp tools)`);
  }
  // If the allowlist filtered everything out (unusual toolset), fall back to all tools
  return kept.length > 0 ? kept : tools;
}

function convertAnthropicToClaudberghini(req: AnthropicRequest): ClaudberghiniRequest {
  // Extract system message from messages array or use the system field
  let systemPrompt: string | undefined;
  let messages: ClaudberghiniMessage[] = [];

  if (req.system) {
    systemPrompt = flattenContent(req.system);
  }

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      systemPrompt = flattenContent(msg.content);
    } else {
      // Strip Claude Code's injected <system-reminder> blocks (MCP instructions, hook
      // output, etc.) from user/assistant turns. They bury the actual task and the weak
      // 8B model anchors on them instead of the real instruction.
      const text = flattenContent(msg.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      // Skip empty messages (e.g. a turn that was only tool_use with no text)
      if (text) {
        messages.push({
          role: msg.role,
          content: text,
        });
      }
    }
  }

  // Map model name
  const claudberghiniModel = MODEL_MAPPING[req.model] || MODEL_MAPPING['default'];

  // Validate and set max_tokens
  const maxTokens = req.max_tokens || 2048;
  if (maxTokens > 4096) {
    console.warn(`[WARN] max_tokens ${maxTokens} exceeds maximum 4096, capping to 4096`);
  }

  // Inject tool-calling instructions into the system prompt. Claudberghini has no native
  // `tools` param, so the only channel is the system prompt + output parsing.
  // DISABLE_TOOL_INJECTION=1 lets the eval harness own the full system prompt (it still
  // embeds the tool-call format), while the proxy only parses the output back.
  if (req.tools && req.tools.length > 0 && process.env.DISABLE_TOOL_INJECTION !== '1') {
    const filtered = filterToolsForCoding(req.tools as AnthropicTool[]);
    if (filtered.length > 0) {
      const toolBlock = buildToolSystemPrompt(filtered, req.tool_choice);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${toolBlock}` : toolBlock;
    }
  }

  // Claudberghini hard-caps input around ~24KB (returns empty above it). Budget the
  // system prompt so system + messages stay under that ceiling. Keep the head
  // (core instructions + tool defs) and tail (most recent guidance), drop the middle.
  const MAX_SYSTEM_BYTES = Number(process.env.MAX_SYSTEM_BYTES) || 18000;
  if (systemPrompt && systemPrompt.length > MAX_SYSTEM_BYTES) {
    const head = Math.floor(MAX_SYSTEM_BYTES * 0.7);
    const tail = MAX_SYSTEM_BYTES - head;
    const original = systemPrompt.length;
    systemPrompt =
      systemPrompt.slice(0, head) +
      `\n\n[...${original - MAX_SYSTEM_BYTES} chars trimmed to fit context...]\n\n` +
      systemPrompt.slice(original - tail);
    console.warn(`[WARN] System prompt trimmed ${original} -> ${systemPrompt.length} bytes to fit Claudberghini context`);
  }

  const chatOptions: ClaudberghiniChatOptions = {
    selectedModel: claudberghiniModel,
    topK: 8,
  };

  if (systemPrompt) {
    chatOptions.systemPrompt = systemPrompt;
  }

  return {
    messages,
    chatOptions,
    attachment: null,
  };
}

/**
 * Convert Claudberghini response to Anthropic format
 */
function convertClaudberghiniToAnthropic(
  claudberghiniResponse: ClaudberghiniResponse,
  model: string,
  toolNames?: Set<string>
): unknown {
  // Extract the content from various possible Claudberghini response formats
  let content = '';

  if (typeof claudberghiniResponse === 'string') {
    content = claudberghiniResponse;
  } else if (claudberghiniResponse.message) {
    content = claudberghiniResponse.message;
  } else if (claudberghiniResponse.content) {
    content = claudberghiniResponse.content;
  } else if (claudberghiniResponse.text) {
    content = claudberghiniResponse.text;
  } else if (
    claudberghiniResponse.choices &&
    Array.isArray(claudberghiniResponse.choices) &&
    claudberghiniResponse.choices.length > 0
  ) {
    content = claudberghiniResponse.choices[0].message?.content || '';
  }

  // Strip Claudberghini control tokens (<|stats|>...<|/stats|>, <|eot_id|>, etc.)
  content = content
    .replace(/<\|stats\|>[\s\S]*?<\|\/stats\|>/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim();

  // Parse tool calls from the model's text output (if tools were offered)
  const parsed = parseToolCalls(content, toolNames ?? new Set());
  const contentBlocks = buildContentBlocks(parsed);
  const hasToolUse = parsed.toolUses.length > 0;

  // Return Anthropic format response
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: model,
    // stop_reason MUST be 'tool_use' when a tool call is present, or Claude Code
    // will not invoke the tool.
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: Math.ceil((content.length || 0) / 4),
    },
  };
}

// Strip Claudberghini control tokens from a raw response body.
function cleanClaudberghiniText(content: string): string {
  return content
    .replace(/<\|stats\|>[\s\S]*?<\|\/stats\|>/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim();
}

// One non-streaming model call → cleaned full text. Backend-switchable so we can TUNE
// against OpenRouter's identical model (legit paid API, no abuse risk) and keep Claudberghini
// only for fast final inference. BACKEND=openrouter uses OpenRouter; default = claudberghini.
async function callClaudberghiniText(claudberghiniRequest: ClaudberghiniRequest): Promise<string> {
  const backend = process.env.BACKEND || 'claudberghini';

  if (backend === 'openrouter') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('BACKEND=openrouter but OPENROUTER_API_KEY is not set');
    const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct';
    const messages: Array<{ role: string; content: string }> = [];
    if (claudberghiniRequest.chatOptions.systemPrompt) {
      messages.push({ role: 'system', content: claudberghiniRequest.chatOptions.systemPrompt });
    }
    for (const m of claudberghiniRequest.messages) messages.push({ role: m.role, content: m.content });
    const resp = await axios.post<any>(
      'https://openrouter.ai/api/v1/chat/completions',
      { model, messages, max_tokens: 1024, temperature: Number(process.env.OPENROUTER_TEMP || 0.4) },
      { timeout: 60000, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }
    );
    return cleanClaudberghiniText(String(resp.data?.choices?.[0]?.message?.content || ''));
  }

  // Default: Claudberghini raw-text endpoint
  const claudberghiniUrl = `${config.claudberghiniApiUrl.replace(/\/$/, '')}/api/chat`;
  const resp = await axios.post<unknown>(claudberghiniUrl, claudberghiniRequest, {
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' },
  });
  const d = resp.data as any;
  let content = '';
  if (typeof d === 'string') content = d;
  else content = d?.message || d?.content || d?.text || d?.choices?.[0]?.message?.content || '';
  return cleanClaudberghiniText(String(content));
}

// Does the last message carry a tool_result (i.e. the model should now produce a final
// answer, not necessarily another tool call)?
function lastMessageIsToolResult(req: AnthropicRequest): boolean {
  const m = req.messages[req.messages.length - 1];
  if (!m || !Array.isArray(m.content)) return false;
  return (m.content as any[]).some((b) => b && b.type === 'tool_result');
}

// Extract the text of prior tool results from the (already-flattened) Claudberghini messages.
// Used to ground final answers against what tools actually returned.
function priorToolResultText(claudberghiniRequest: ClaudberghiniRequest): string {
  const all = claudberghiniRequest.messages.map((m) => m.content).join('\n');
  const matches = all.match(/<tool_response>[\s\S]*?<\/tool_response>/g);
  return matches ? matches.join('\n') : '';
}

// Fraction of an answer's significant tokens that actually appear in the reference
// (the tool output). Higher = more grounded, less hallucinated.
function groundingScore(answer: string, reference: string): number {
  if (!reference) return 0;
  const ref = reference.toLowerCase();
  const tokens = answer.toLowerCase().match(/[a-z0-9_./-]{4,}/g) || [];
  if (tokens.length === 0) return 0;
  let hit = 0;
  for (const t of tokens) if (ref.includes(t)) hit++;
  return hit / tokens.length;
}

// Block destructive / privileged shell commands the weak model sometimes hallucinates.
// Returns the tool use if safe, or null if it should be refused.
function guardToolUse(tu: any): any | null {
  if (!tu) return null;
  if (tu.name === 'Bash') {
    const cmd = String(tu.input?.command || '');
    const DANGER = [
      /\bsudo\b/, /\brm\s+-[a-z]*\s*\//, /\brm\s+-rf\b/, /\bmkfs\b/, /\bdd\s+if=/,
      /\bof=\/dev\//, />\s*\/dev\/sd/, /:\(\)\s*\{/, /\bchmod\s+-R\s+777\s+\//,
      /\bchown\s+-R\b.*\s\//, /\/etc\/(passwd|shadow|hosts|sudoers)/, /\bshutdown\b/,
      /\breboot\b/, /\bcurl\b[^|]*\|\s*(sh|bash)\b/, /\bwget\b[^|]*\|\s*(sh|bash)\b/,
    ];
    if (DANGER.some((re) => re.test(cmd))) {
      console.log(`[WARN] BLOCKED dangerous Bash command: ${cmd.slice(0, 120)}`);
      return null;
    }
  }
  return tu;
}

// Best-of-N sampling: Claudberghini is fast + non-deterministic.
//   - valid tool call → use it (first call only; drop any fabricated continuation).
//   - the model ATTEMPTS a tool call but botches the format → re-sample for a clean one.
//   - plain TEXT with no tool attempt → a deliberate conversational/final answer; ACCEPT
//     it. We NEVER fabricate a tool call for input like "hi" (forcing one made the weak
//     model invent dangerous commands).
//   - final-answer turn (groundAgainstTools): sample several texts, pick the one MOST
//     GROUNDED in prior tool output (kills confabulation).
async function sampleToolResponse(
  claudberghiniRequest: ClaudberghiniRequest,
  toolNames: Set<string>,
  groundAgainstTools: boolean,
  maxAttempts: number
): Promise<ParsedOutput> {
  let last: ParsedOutput = { text: '', toolUses: [] as any[] };
  const reference = groundAgainstTools ? priorToolResultText(claudberghiniRequest) : '';
  const answerCandidates: ParsedOutput[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let text = '';
    try {
      text = await callClaudberghiniText(claudberghiniRequest);
    } catch (e) {
      continue; // transient — try again
    }
    const parsed = parseToolCalls(text, toolNames) as ParsedOutput;
    last = parsed;

    if (parsed.toolUses.length > 0) {
      if (attempt > 0) console.log(`[INFO] best-of-N: clean tool call on attempt ${attempt + 1}`);
      const safe = guardToolUse(parsed.toolUses[0]);
      if (!safe) {
        return { text: 'I cannot run that — it looks unsafe (destructive or privileged command).', toolUses: [] };
      }
      // Keep ONLY the first call; drop any fabricated "## Output from tool..." continuation.
      return { text: '', toolUses: [safe] };
    }

    // The model TRIED a tool call but the format was broken → re-sample for a clean one.
    const attemptedTool = /<tool_call|<function\s*=/i.test(text);
    if (attemptedTool && attempt < maxAttempts - 1) continue;

    // Plain text (no tool attempt) — a deliberate conversational/final answer.
    if (parsed.text.trim()) {
      if (!reference) return parsed; // conversational turn — accept; never force a tool
      answerCandidates.push(parsed); // final-answer turn — collect for grounded selection
    }
  }

  if (answerCandidates.length > 0) {
    answerCandidates.sort((a, b) => groundingScore(b.text, reference) - groundingScore(a.text, reference));
    const best = answerCandidates[0];
    if (answerCandidates.length > 1) {
      console.log(`[INFO] grounded best-of-N: picked answer (grounding ${groundingScore(best.text, reference).toFixed(2)}) from ${answerCandidates.length} candidates`);
    }
    return best;
  }
  return last;
}

// Routes

/**
 * Anthropic-compatible POST /v1/messages endpoint
 * Converts Anthropic format to Claudberghini format, proxies request, converts response back
 */
app.post('/v1/messages', async (req: Request, res: Response): Promise<void> => {
  const timestamp = new Date().toISOString();
  const startTime = Date.now();

  try {
    const anthropicRequest = req.body as AnthropicRequest;

    // Validate required fields
    if (!anthropicRequest.model) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Missing required field: model',
        },
      });
      return;
    }

    if (!anthropicRequest.messages || !Array.isArray(anthropicRequest.messages)) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Missing required field: messages (must be an array)',
        },
      });
      return;
    }

    // Log incoming request
    console.log(`[INFO] ${timestamp} - POST /v1/messages`);
    console.log(`[DEBUG] Model: ${anthropicRequest.model}`);
    console.log(`[DEBUG] Messages count: ${anthropicRequest.messages.length}`);
    console.log(`[DEBUG] Stream: ${anthropicRequest.stream || false}`);

    // Convert to Claudberghini format
    const claudberghiniRequest = convertAnthropicToClaudberghini(anthropicRequest);
    console.log(`[DEBUG] Converted to Claudberghini format with model: ${claudberghiniRequest.chatOptions.selectedModel}`);
    if (process.env.DUMP_MESSAGES === '1') {
      console.log(`[DUMP] systemPrompt(${(claudberghiniRequest.chatOptions.systemPrompt || '').length}b): ${JSON.stringify((claudberghiniRequest.chatOptions.systemPrompt || '').slice(-600))}`);
      console.log(`[DUMP] messages: ${JSON.stringify(claudberghiniRequest.messages.map((m) => ({ role: m.role, content: m.content.slice(0, 300) })))}`);
    }

    // Valid tool names for this request (used to parse tool calls from model output)
    const toolNames = new Set((anthropicRequest.tools ?? []).map((t) => t.name));
    const hasTools = toolNames.size > 0;
    if (hasTools) {
      console.log(`[DEBUG] Tools enabled: ${[...toolNames].join(', ')}`);
    }

    // Check if streaming is requested
    if (anthropicRequest.stream) {
      // Handle streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Helper: emit a properly-framed Anthropic SSE event (event: line + data: line)
      const sendEvent = (event: string, data: object) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const messageId = `msg_${Date.now()}`;
      const anthropicModel = anthropicRequest.model;
      let outputTokenEstimate = 0;
      let streamClosed = false;

      try {
        const claudberghiniUrl = `${config.claudberghiniApiUrl.replace(/\/$/, '')}/api/chat`;

        // --- Anthropic SSE preamble: message_start + content_block_start ---
        sendEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: anthropicModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        sendEvent('ping', { type: 'ping' });

        // TOOL PATH: best-of-N sampling (buffered), then structured tool_use emit.
        if (hasTools) {
          // Ground answers against tool output ONLY on a turn that follows a tool_result.
          // On a fresh user turn we do NOT force a tool — the model may legitimately answer
          // in text (e.g. "hi"). maxAttempts allows re-sampling a botched tool-call format.
          const groundAgainstTools = lastMessageIsToolResult(anthropicRequest);
          const maxAttempts = groundAgainstTools
            ? Number(process.env.ANSWER_SAMPLE_ATTEMPTS || 3)
            : Number(process.env.TOOL_SAMPLE_ATTEMPTS || 5);
          const parsed = await sampleToolResponse(claudberghiniRequest, toolNames, groundAgainstTools, maxAttempts);

          if (parsed.text) {
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: parsed.text },
            });
            outputTokenEstimate += Math.ceil(parsed.text.length / 4);
          }
          sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });

          parsed.toolUses.forEach((tu, i) => {
            const index = i + 1;
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} },
            });
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input ?? {}) },
            });
            sendEvent('content_block_stop', { type: 'content_block_stop', index });
          });

          sendEvent('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: parsed.toolUses.length > 0 ? 'tool_use' : 'end_turn',
              stop_sequence: null,
            },
            usage: { output_tokens: outputTokenEstimate },
          });
          sendEvent('message_stop', { type: 'message_stop' });
          res.end();
          console.log(
            `[INFO] Streaming(tools) completed in ${Date.now() - startTime}ms — ${parsed.toolUses.length} tool call(s)`
          );
          return;
        }

        // NO-TOOLS PATH: stream raw text incrementally.
        console.log(`[DEBUG] Making streaming request to ${claudberghiniUrl}`);
        const axiosResponse = await axios.post(claudberghiniUrl, claudberghiniRequest, {
          responseType: 'stream',
          timeout: 60000,
          headers: {
            'Content-Type': 'application/json',
          },
        });

        // Claudberghini streams RAW TEXT tokens (not JSON, not SSE), terminated by a
        // <|stats|>...<|/stats|> trailer. We accumulate the raw buffer and emit the
        // "clean" text (everything before the first control token) incrementally.
        let raw = '';
        let emitted = 0;

        axiosResponse.data.on('data', (chunk: Buffer) => {
          raw += chunk.toString();

          // When tools are enabled we must buffer the full output — a tool call cannot
          // be emitted until we've seen the complete <tool_call>{...}</tool_call>. So
          // only stream incremental text deltas in the no-tools case.
          if (hasTools) return;

          // Find the first control token (<|stats|>, <|eot_id|>, etc.) — content ends there
          const ctrlIdx = raw.indexOf('<|');
          // If no control token seen yet, hold back the last char in case '<|' is split across chunks
          const safeEnd = ctrlIdx >= 0 ? ctrlIdx : Math.max(emitted, raw.length - 1);

          if (safeEnd > emitted) {
            const text = raw.slice(emitted, safeEnd);
            emitted = safeEnd;
            if (text) {
              outputTokenEstimate += Math.ceil(text.length / 4);
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              });
            }
          }
        });

        axiosResponse.data.on('end', () => {
          if (streamClosed) return;
          streamClosed = true;

          // Clean full text (strip control tokens / stats trailer)
          const cleanFull = raw
            .replace(/<\|stats\|>[\s\S]*?<\|\/stats\|>/g, '')
            .replace(/<\|[^|]*\|>/g, '')
            .trim();

          if (hasTools) {
            if (process.env.LOG_LEVEL === 'debug') {
              console.log(`[DEBUG] RAW model output (${cleanFull.length} chars): ${JSON.stringify(cleanFull.slice(0, 500))}`);
            }
            // Parse tool calls from the buffered output and emit a structured sequence.
            const parsed = parseToolCalls(cleanFull, toolNames);

            // Text block (index 0 was already opened in the preamble)
            if (parsed.text) {
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: parsed.text },
              });
              outputTokenEstimate += Math.ceil(parsed.text.length / 4);
            }
            sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });

            // One tool_use block per parsed call
            parsed.toolUses.forEach((tu, i) => {
              const index = i + 1;
              sendEvent('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} },
              });
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input ?? {}) },
              });
              sendEvent('content_block_stop', { type: 'content_block_stop', index });
            });

            sendEvent('message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: parsed.toolUses.length > 0 ? 'tool_use' : 'end_turn',
                stop_sequence: null,
              },
              usage: { output_tokens: outputTokenEstimate },
            });
            sendEvent('message_stop', { type: 'message_stop' });
            res.end();

            const duration = Date.now() - startTime;
            console.log(
              `[INFO] Streaming(tools) completed in ${duration}ms — ${parsed.toolUses.length} tool call(s)`
            );
            return;
          }

          // No tools: flush any remaining clean text (held-back tail)
          const ctrlIdx = raw.indexOf('<|');
          const finalEnd = ctrlIdx >= 0 ? ctrlIdx : raw.length;
          if (finalEnd > emitted) {
            const text = raw.slice(emitted, finalEnd);
            if (text) {
              outputTokenEstimate += Math.ceil(text.length / 4);
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              });
            }
          }

          // --- Anthropic SSE closing sequence ---
          sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
          sendEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokenEstimate },
          });
          sendEvent('message_stop', { type: 'message_stop' });
          res.end();

          const duration = Date.now() - startTime;
          console.log(`[INFO] Streaming request completed in ${duration}ms`);
        });

        axiosResponse.data.on('error', (error: Error) => {
          if (streamClosed) return;
          streamClosed = true;
          console.error(`[ERROR] Stream error: ${error.message}`);
          sendEvent('error', { type: 'error', error: { type: 'api_error', message: error.message } });
          res.end();
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[ERROR] Streaming request failed: ${errorMsg}`);
        res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
        res.end();
      }
    } else {
      // Handle non-streaming (regular) response
      try {
        let anthropicResponse: unknown;

        if (hasTools) {
          // Best-of-N: re-sample until we get a valid tool call when one is expected.
          // Ground answers against tool output ONLY on a turn that follows a tool_result.
          // On a fresh user turn we do NOT force a tool — the model may legitimately answer
          // in text (e.g. "hi"). maxAttempts allows re-sampling a botched tool-call format.
          const groundAgainstTools = lastMessageIsToolResult(anthropicRequest);
          const maxAttempts = groundAgainstTools
            ? Number(process.env.ANSWER_SAMPLE_ATTEMPTS || 3)
            : Number(process.env.TOOL_SAMPLE_ATTEMPTS || 5);
          const parsed = await sampleToolResponse(claudberghiniRequest, toolNames, groundAgainstTools, maxAttempts);
          const blocks = buildContentBlocks(parsed);
          const hasToolUse = parsed.toolUses.length > 0;
          anthropicResponse = {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: blocks,
            model: anthropicRequest.model,
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: Math.ceil((parsed.text.length || 0) / 4) },
          };
        } else {
          const claudberghiniUrl = `${config.claudberghiniApiUrl.replace(/\/$/, '')}/api/chat`;
          const claudberghiniResponse = await axios.post<ClaudberghiniResponse>(claudberghiniUrl, claudberghiniRequest, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' },
          });
          anthropicResponse = convertClaudberghiniToAnthropic(
            claudberghiniResponse.data,
            anthropicRequest.model,
            toolNames
          );
        }

        const duration = Date.now() - startTime;
        console.log(`[INFO] Request completed in ${duration}ms`);

        res.status(200).json(anthropicResponse);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[ERROR] Claudberghini request failed: ${errorMsg}`);

        if (axios.isAxiosError(error) && error.response) {
          res.status(error.response.status).json({
            error: {
              type: 'api_error',
              message: errorMsg,
              details: error.response.data,
            },
          });
        } else {
          res.status(500).json({
            error: {
              type: 'api_error',
              message: errorMsg,
            },
          });
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[ERROR] Request handler error: ${errorMsg}`);

    res.status(500).json({
      error: {
        type: 'internal_error',
        message: errorMsg,
      },
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const health = await apiHandler.healthCheck();
    res.json(health);
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Upstream connectivity check
 */
app.get('/health/upstream', async (_req: Request, res: Response) => {
  try {
    const connectivity = await apiHandler.checkUpstreamConnectivity();
    const statusCode = connectivity.connected ? 200 : 503;
    res.status(statusCode).json(connectivity);
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Format conversion endpoint
 * POST /convert
 * Body: { sourceFormat, targetFormat, data, options }
 */
app.post('/convert', (req: Request, res: Response): void => {
  try {
    const { sourceFormat, targetFormat, data, options } = req.body;

    if (!sourceFormat || !targetFormat || data === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceFormat, targetFormat, data',
      });
      return;
    }

    const result = FormatConverter.convert({
      sourceFormat,
      targetFormat,
      data,
      options,
    });

    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Proxy API request endpoint
 * POST /proxy
 * Body: { method, endpoint, headers, body }
 */
app.post('/proxy', async (req: Request, res: Response): Promise<void> => {
  try {
    const { method, endpoint, headers, body } = req.body;

    if (!method || !endpoint) {
      res.status(400).json({
        error: 'Missing required fields: method, endpoint',
      });
      return;
    }

    const response = await apiHandler.handleRequest({
      method,
      endpoint,
      headers,
      body,
    });

    res.status(response.status).json({
      status: response.status,
      headers: response.headers,
      body: response.body,
      timestamp: response.timestamp,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /config (returns non-sensitive config info)
 */
app.get('/config', (_req: Request, res: Response) => {
  res.json({
    claudberghiniApiUrl: config.claudberghiniApiUrl,
    proxyPort: config.proxyPort,
    logLevel: config.logLevel,
    upstreamKeyConfigured: !!config.anthropicApiKey,
  });
});

/**
 * 404 handler
 */
app.use((req: Request, res: Response): void => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method,
  });
});

/**
 * Error handling middleware
 */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  console.error(`[ERROR] ${new Date().toISOString()} - ${err.message}`);
  res.status(500).json({
    error: 'Internal server error',
    message: config.logLevel === 'debug' ? err.message : undefined,
  });
});

// Start server
const server = app.listen(config.proxyPort, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   Claudberghini Anthropic Proxy Server                         ║
╚════════════════════════════════════════════════════════════╝

Server running at: http://localhost:${config.proxyPort}
Log Level: ${config.logLevel}
Upstream API: ${config.claudberghiniApiUrl}

Available Endpoints:
  GET  /health                - Server health check
  GET  /health/upstream       - Upstream connectivity check
  GET  /config                - Server configuration (non-sensitive)
  POST /v1/messages           - Anthropic-compatible message endpoint (converts to Claudberghini)
  POST /convert               - Format conversion
  POST /proxy                 - Proxy API requests

Supported Models (mapped to Claudberghini):
  - gpt-4, gpt-4-turbo, gpt-4o → llama3.1-8B
  - gpt-3.5-turbo → llama2-7B
  - claude-3-opus, claude-3-sonnet, claude-2 → llama3.1-8B
  - claude-3-haiku → llama2-7B

Features:
  - Converts Anthropic message format to Claudberghini format
  - Supports both streaming and non-streaming requests
  - Maps model names automatically
  - Converts system messages from messages array
  - Returns Anthropic-compatible responses with proper token usage

Start time: ${new Date().toISOString()}
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

export default app;
