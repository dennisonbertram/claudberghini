/**
 * Tool registry for the eval harness: Anthropic-format tool schemas + real executors
 * that operate against a sandboxed workspace directory. This is a minimal stand-in for
 * Claude Code's core coding tools, so we can measure how well ChatJimmy/Llama-8B drives
 * an agent loop under different (system prompt, toolset) configs.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Full schema definitions. A config picks a subset by name.
const TOOL_SCHEMAS = {
  Read: {
    name: 'Read',
    description: 'Read a file from the workspace. Use when you need to see a file\'s contents.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Path relative to workspace, e.g. config.txt' } },
      required: ['file_path'],
    },
  },
  Write: {
    name: 'Write',
    description: 'Create or overwrite a file with given contents.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to workspace' },
        content: { type: 'string', description: 'Exact file contents to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  Edit: {
    name: 'Edit',
    description: 'Replace an exact string in a file with a new string.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to workspace' },
        old_string: { type: 'string', description: 'Exact text to find' },
        new_string: { type: 'string', description: 'Text to replace it with' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  Bash: {
    name: 'Bash',
    description: 'Run a shell command in the workspace and get its stdout/stderr.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command, e.g. ls -la' } },
      required: ['command'],
    },
  },
  Grep: {
    name: 'Grep',
    description: 'Search file contents for a pattern. Returns matching files and lines.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Text or regex to search for' } },
      required: ['pattern'],
    },
  },
  Glob: {
    name: 'Glob',
    description: 'List files matching a glob pattern, e.g. **/*.txt',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern' } },
      required: ['pattern'],
    },
  },
  LS: {
    name: 'LS',
    description: 'List files and directories in the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default ".")' } },
      required: [],
    },
  },
};

function getToolSchemas(names) {
  return names.map((n) => TOOL_SCHEMAS[n]).filter(Boolean);
}

// Safe-ish path resolution constrained to the workspace.
function resolveIn(workspace, p) {
  const full = path.resolve(workspace, p || '.');
  if (!full.startsWith(path.resolve(workspace))) {
    throw new Error('path escapes workspace');
  }
  return full;
}

// Execute a tool call against the workspace. Returns a string result.
function makeExecutor(workspace) {
  return function executeTool(name, input) {
    try {
      switch (name) {
        case 'Read': {
          const f = resolveIn(workspace, input.file_path);
          return fs.readFileSync(f, 'utf8');
        }
        case 'Write': {
          const f = resolveIn(workspace, input.file_path);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, input.content ?? '');
          return `Wrote ${input.file_path}`;
        }
        case 'Edit': {
          const f = resolveIn(workspace, input.file_path);
          const cur = fs.readFileSync(f, 'utf8');
          if (!cur.includes(input.old_string)) return `ERROR: old_string not found in ${input.file_path}`;
          fs.writeFileSync(f, cur.replace(input.old_string, input.new_string));
          return `Edited ${input.file_path}`;
        }
        case 'Bash': {
          const out = execSync(input.command, { cwd: workspace, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return out.slice(0, 4000) || '(no output)';
        }
        case 'Grep': {
          try {
            const out = execSync(`grep -rn ${JSON.stringify(input.pattern)} .`, { cwd: workspace, timeout: 10000, encoding: 'utf8' });
            return out.slice(0, 4000) || '(no matches)';
          } catch {
            return '(no matches)';
          }
        }
        case 'Glob': {
          const out = execSync(`ls -1 ${input.pattern} 2>/dev/null || find . -name ${JSON.stringify((input.pattern || '').replace(/\*\*\//g, ''))}`, { cwd: workspace, timeout: 10000, encoding: 'utf8' });
          return out.slice(0, 4000) || '(no files)';
        }
        case 'LS': {
          const out = execSync(`ls -la ${input.path || '.'}`, { cwd: workspace, timeout: 10000, encoding: 'utf8' });
          return out.slice(0, 4000);
        }
        default:
          return `ERROR: unknown tool ${name}`;
      }
    } catch (e) {
      return `ERROR: ${e.message}`;
    }
  };
}

module.exports = { TOOL_SCHEMAS, getToolSchemas, makeExecutor };
