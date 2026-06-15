/**
 * Unit tests for src/tools.ts pure helpers.
 *
 * Run via: node --import tsx --test test/tools.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { repairJson, parseToolCalls, buildContentBlocks } from '../src/tools.ts';

// ─── repairJson ───────────────────────────────────────────────────────────────

describe('repairJson', () => {
  test('valid double-quoted JSON parses unchanged', () => {
    const input = '{"name":"Read","input":{"file_path":"/tmp/x"}}';
    const result = repairJson(input);
    assert.ok(result !== null, 'should not return null for valid JSON');
    assert.strictEqual(result!.name, 'Read');
    assert.deepStrictEqual(result!.input, { file_path: '/tmp/x' });
  });

  test('truncated / unclosed brace gets balanced', () => {
    // Missing closing braces — 8B model truncation
    const input = '{"name":"Bash","input":{"command":"ls -la"';
    const result = repairJson(input);
    assert.ok(result !== null, 'truncated JSON should be repaired');
    assert.strictEqual(result!.name, 'Bash');
    assert.strictEqual(result!.input?.command, 'ls -la');
  });

  test('single-quoted JSON with embedded double quote parses', () => {
    // {'command':'echo "hi"'} — single quotes with internal double quote
    const input = `{'command':'echo "hi"'}`;
    const result = repairJson(input);
    assert.ok(result !== null, 'single-quoted JSON with embedded double quote should parse');
    assert.strictEqual(result!.command, 'echo "hi"');
  });

  test('value containing ",}" is NOT mutated — round-trips correctly', () => {
    // The value "a,}" must survive the trailing-comma stripper untouched.
    // We force through the repair path by using single-quoted form that fails strict JSON.parse.
    const input = `{'name':'Write','input':{'content':'a,}'}}`;
    const result = repairJson(input);
    assert.ok(result !== null, 'should parse successfully');
    assert.strictEqual(
      result!.input?.content,
      'a,}',
      `content value must be exactly "a,}" not mutated by comma stripper`
    );
  });

  test('already-valid JSON with ",}" value round-trips content correctly', () => {
    // This test uses proper double-quoted JSON so it hits the fast path.
    // Verifies the value is not corrupted in the already-valid branch either.
    const obj = { name: 'Write', input: { content: 'a,}' } };
    const raw = JSON.stringify(obj);
    const result = repairJson(raw);
    assert.ok(result !== null);
    assert.strictEqual(result!.input?.content, 'a,}');
  });

  test('JSON with trailing comma inside object gets comma stripped', () => {
    // {"name":"Bash","input":{"command":"ls",}} — trailing comma before }}
    const input = '{"name":"Bash","input":{"command":"ls",}}';
    const result = repairJson(input);
    assert.ok(result !== null, 'trailing comma should be stripped and object repaired');
    assert.strictEqual(result!.name, 'Bash');
  });

  test('completely invalid input returns null', () => {
    const result = repairJson('not json at all !!!');
    assert.strictEqual(result, null);
  });

  test('unclosed string value gets closed', () => {
    const input = '{"name":"Bash","input":{"command":"ls -la';
    const result = repairJson(input);
    // Should repair even deeply truncated input
    assert.ok(result !== null, 'unclosed string should be repaired');
    assert.strictEqual(result!.name, 'Bash');
  });
});

// ─── parseToolCalls ───────────────────────────────────────────────────────────

describe('parseToolCalls', () => {
  const validTools = new Set(['Bash', 'Read', 'Write', 'Edit', 'ListFiles']);

  test('single clean tool_call block is extracted from text', () => {
    const text = 'Some preamble.\n<tool_call>{"name":"Read","input":{"file_path":"/tmp/x"}}</tool_call>\nTrailing.';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 1);
    assert.strictEqual(result.toolUses[0].name, 'Read');
    assert.deepStrictEqual(result.toolUses[0].input, { file_path: '/tmp/x' });
    // Text output should not include the tool_call block
    assert.ok(!result.text.includes('<tool_call>'), 'tool_call tags should be stripped from text');
  });

  test('tool_call whose Bash command contains "</tool_call>" parses with full untruncated command', () => {
    // The value of command legitimately contains the literal "</tool_call>" string.
    // A naive non-greedy regex would truncate the JSON here.
    const command = 'echo "</tool_call>" && ls';
    const json = JSON.stringify({ name: 'Bash', input: { command } });
    const text = `<tool_call>${json}</tool_call>`;
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 1, 'should extract exactly one tool call');
    assert.strictEqual(result.toolUses[0].name, 'Bash');
    assert.strictEqual(
      result.toolUses[0].input.command,
      command,
      'command containing </tool_call> must be preserved in full'
    );
  });

  test('multiple sequential tool_call blocks all parse', () => {
    const text =
      '<tool_call>{"name":"Read","input":{"file_path":"/a"}}</tool_call>\n' +
      '<tool_call>{"name":"Bash","input":{"command":"ls"}}</tool_call>';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 2, 'should parse both tool calls');
    assert.strictEqual(result.toolUses[0].name, 'Read');
    assert.strictEqual(result.toolUses[1].name, 'Bash');
  });

  test('invalid tool name is dropped and not included in toolUses', () => {
    const text = '<tool_call>{"name":"INVALID_TOOL","input":{"x":"y"}}</tool_call>';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 0, 'invalid tool name should be dropped');
    // The tag text itself should not appear in output text
    assert.ok(!result.text.includes('<tool_call>'), 'orphaned tag fragments stripped from text');
  });

  test('<function=Name>{...}</function> fallback form works', () => {
    const text = '<function=Bash>{"command":"npm test"}</function>';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 1, 'function= form should parse');
    assert.strictEqual(result.toolUses[0].name, 'Bash');
    assert.strictEqual(result.toolUses[0].input.command, 'npm test');
  });

  test('<function=Name> form with invalid name is dropped from output', () => {
    const text = 'Hello world\n<function=UNKNOWN>{"x":"y"}</function>';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 0);
    // Tag should be stripped from visible text
    assert.ok(!result.text.includes('<function='), 'function tag should be stripped');
  });

  test('text with no tool calls is returned as-is (trimmed)', () => {
    const text = 'Just a normal answer with no tool calls.';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 0);
    assert.strictEqual(result.text, text);
  });

  test('tool IDs are unique across multiple calls', () => {
    const text =
      '<tool_call>{"name":"Read","input":{"file_path":"/a"}}</tool_call>\n' +
      '<tool_call>{"name":"Bash","input":{"command":"ls"}}</tool_call>';
    const result = parseToolCalls(text, validTools);
    const ids = result.toolUses.map((t) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'tool IDs must be unique');
  });

  test('stray orphaned </tool_call> tags are stripped from text output', () => {
    const text = 'Some text </tool_call> more text';
    const result = parseToolCalls(text, validTools);
    assert.strictEqual(result.toolUses.length, 0);
    assert.ok(!result.text.includes('</tool_call>'), 'orphaned closing tag should be stripped');
  });
});

// ─── buildContentBlocks ───────────────────────────────────────────────────────

describe('buildContentBlocks', () => {
  test('text-only output produces a single text block', () => {
    const parsed = { text: 'Hello!', toolUses: [] };
    const blocks = buildContentBlocks(parsed);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[0].text, 'Hello!');
  });

  test('tool-use-only output produces a tool_use block', () => {
    const parsed = {
      text: '',
      toolUses: [{ id: 'tu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
    };
    const blocks = buildContentBlocks(parsed);
    // No text block (empty string), one tool_use block
    const tuBlocks = blocks.filter((b) => b.type === 'tool_use');
    assert.strictEqual(tuBlocks.length, 1);
    assert.strictEqual(tuBlocks[0].name, 'Read');
    assert.strictEqual(tuBlocks[0].id, 'tu_1');
    assert.deepStrictEqual(tuBlocks[0].input, { file_path: '/tmp/x' });
  });

  test('empty output still produces at least one block (Anthropic requirement)', () => {
    const parsed = { text: '', toolUses: [] };
    const blocks = buildContentBlocks(parsed);
    assert.ok(blocks.length >= 1, 'must produce at least one content block');
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[0].text, '');
  });

  test('mixed text + tool_use output preserves both', () => {
    const parsed = {
      text: 'Looking at the file...',
      toolUses: [{ id: 'tu_2', name: 'Bash', input: { command: 'ls' } }],
    };
    const blocks = buildContentBlocks(parsed);
    const textBlock = blocks.find((b) => b.type === 'text');
    const tuBlock = blocks.find((b) => b.type === 'tool_use');
    assert.ok(textBlock, 'text block should be present');
    assert.ok(tuBlock, 'tool_use block should be present');
    assert.strictEqual(textBlock!.text, 'Looking at the file...');
    assert.strictEqual(tuBlock!.name, 'Bash');
  });
});
