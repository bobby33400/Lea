'use strict';
/*
 * classify.js — pure helpers (no electron) for:
 *   - parsing ccusage's `blocks --active --json` into a usage snapshot
 *   - classifying the result of a headless `claude -p` run
 *
 * Kept dependency-free so it can be unit-tested with plain node.
 */

function parseCcusageBlocks(jsonText) {
  const data = JSON.parse(jsonText);
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const active = blocks.find((b) => b && b.isActive) || null;

  if (!active) {
    return {
      active: false,
      startAt: null,
      resetAt: null,
      totalTokens: 0,
      costUSD: 0,
      burnRate: null,
      projection: null,
      models: [],
      tokenCounts: null,
    };
  }

  return {
    active: true,
    startAt: Date.parse(active.startTime) || null,
    resetAt: Date.parse(active.endTime) || null,
    totalTokens: active.totalTokens || 0,
    costUSD: active.costUSD || 0,
    burnRate: active.burnRate || null,
    projection: active.projection || null,
    models: active.models || [],
    tokenCounts: active.tokenCounts || null,
  };
}

function tryParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s.trim());
  } catch {
    return null;
  }
}

// Scan from the end for the last line that parses as a JSON object.
function lastJsonObject(s) {
  if (!s) return null;
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      const obj = tryParse(line);
      if (obj && typeof obj === 'object') return obj;
    }
  }
  return null;
}

const LIMIT_RE =
  /(usage limit (?:reached|exceeded)|rate[- ]?limit|\b429\b|too many requests|quota (?:exceeded|reached)|limit reached|reached your .{0,30}limit|exceeded your .{0,30}limit|insufficient .{0,20}credit)/i;

/**
 * Extract the "things the human must do" follow-ups from a run's result text.
 * Prefers the structured block Lea asks Claude to emit; falls back to a
 * heuristic scan for an "Action required / Next steps" markdown section so
 * older runs still surface something.
 * @returns {string[]}
 */
function extractFollowups(text) {
  if (!text) return [];

  // 1) Structured block: ===LEA-FOLLOWUPS=== ... ===END-FOLLOWUPS===
  const block = text.match(/===LEA-FOLLOWUPS===\s*([\s\S]*?)\s*===END-FOLLOWUPS===/i);
  if (block) {
    const body = block[1].trim();
    if (!body || /^none\.?$/i.test(body)) return [];
    return body
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s?/, '').trim())
      .filter((l) => l && !/^none\.?$/i.test(l));
  }

  // 2) Heuristic: a markdown "action required / next steps / to-do" section.
  const lines = text.split('\n');
  const hdrRe =
    /^#{1,6}\s*(actions?\s+required|next\s+steps?|to[-\s]?dos?|manual\s+steps?|what\s+you\s+(?:need\s+to|should)\s+do|action\s+items?|follow[-\s]?ups?)\b/i;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s/);
    if (h && hdrRe.test(lines[i])) {
      start = i;
      level = h[1].length;
      break;
    }
  }
  if (start === -1) return [];
  const section = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s/);
    if (h && h[1].length <= level) break; // next same/higher-level header ends it
    section.push(lines[i]);
  }
  const bullets = section.filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
  if (bullets.length) return bullets;
  const note = section.join('\n').trim();
  return note ? [note] : [];
}

/**
 * Classify a finished claude run.
 * @returns {{kind:'ok'|'limited'|'error', ...}}
 *   ok      -> { result, costUSD, sessionId, usage }
 *   limited -> { message }   (usage/rate limit hit; retry after reset)
 *   error   -> { error, message }
 */
function classifyClaudeResult(o) {
  const { code, stdout = '', stderr = '', timedOut = false } = o;
  if (timedOut) {
    return { kind: 'error', error: 'timeout', message: 'Task exceeded its time limit and was stopped.' };
  }

  const text = `${stdout}\n${stderr}`;
  const limited = LIMIT_RE.test(text);
  const parsed = tryParse(stdout) || lastJsonObject(stdout);

  if (parsed && parsed.type === 'result') {
    const isError = parsed.is_error === true || (parsed.subtype && parsed.subtype !== 'success');
    if (isError) {
      if (limited) return { kind: 'limited', message: String(parsed.result || 'Usage limit reached').slice(0, 600) };
      return {
        kind: 'error',
        error: parsed.subtype || 'error',
        message: String(parsed.result || '').slice(0, 600),
        parsed,
      };
    }
    return {
      kind: 'ok',
      result: String(parsed.result || ''),
      costUSD: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      sessionId: parsed.session_id || null,
      usage: parsed.usage || null,
      followups: extractFollowups(String(parsed.result || '')),
      parsed,
    };
  }

  if (limited) return { kind: 'limited', message: 'Usage limit reached.' };
  if (code === 0)
    return { kind: 'ok', result: stdout.trim(), costUSD: null, sessionId: null, usage: null, followups: extractFollowups(stdout) };
  return {
    kind: 'error',
    error: `exit ${code}`,
    message: (stderr || stdout || '').trim().slice(0, 600) || `Process exited with code ${code}`,
  };
}

// One-line description of a tool call, for the live log / activity indicator.
function describeTool(name, input) {
  input = input || {};
  const file = input.file_path || input.path || input.notebook_path;
  const short = (p) => {
    if (!p) return '';
    const s = String(p);
    return s.length > 52 ? '…' + s.slice(-50) : s;
  };
  switch (name) {
    case 'Read':
      return 'Reading ' + short(file);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Editing ' + short(file);
    case 'Write':
      return 'Writing ' + short(file);
    case 'Bash':
      return 'Running: ' + String(input.command || '').replace(/\s+/g, ' ').slice(0, 140);
    case 'Grep':
      return 'Searching ' + JSON.stringify(input.pattern || '');
    case 'Glob':
      return 'Finding ' + JSON.stringify(input.pattern || '');
    case 'Task':
      return 'Sub-agent: ' + String(input.description || input.prompt || '').slice(0, 80);
    case 'WebFetch':
      return 'Fetching ' + String(input.url || '');
    case 'WebSearch':
      return 'Web search ' + JSON.stringify(input.query || '');
    case 'TodoWrite':
      return 'Updating its plan';
    default:
      return name + (file ? ' ' + short(file) : '');
  }
}

// Turn one stream-json event into readable progress line(s) (or [] to skip).
function summarizeStreamEvent(o) {
  if (!o || typeof o !== 'object') return [];
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const lines = [];
    for (const c of o.message.content) {
      if (c.type === 'text' && c.text && c.text.trim()) {
        lines.push('💬 ' + c.text.trim().replace(/\s+/g, ' ').slice(0, 240));
      } else if (c.type === 'tool_use') {
        lines.push('🔧 ' + describeTool(c.name, c.input));
      }
    }
    return lines;
  }
  return []; // system/init, user/tool_result, result — skipped from the play-by-play
}

module.exports = {
  parseCcusageBlocks,
  classifyClaudeResult,
  extractFollowups,
  describeTool,
  summarizeStreamEvent,
  LIMIT_RE,
};
