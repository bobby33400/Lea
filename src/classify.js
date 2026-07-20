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

// Login/token problems — distinct from usage limits. The user must re-auth
// (`claude` → /login); retrying won't help, so we surface it specially.
const AUTH_RE =
  /(invalid authentication credentials|\b401\b|unauthorized|authentication[_ ]error|invalid[_ ]api[_ ]key|oauth.{0,20}(?:expired|invalid)|please run .{0,10}login|not logged in|login expired|token (?:has )?expired|session expired)/i;

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

  const parsed = tryParse(stdout) || lastJsonObject(stdout);

  // Detect limit/auth from the actual failure signal — the result/error message
  // plus claude's own stderr — NOT the whole stream-json transcript. stdout
  // carries every assistant message and tool result, so scanning all of it makes
  // a task whose output merely mentions "401" or "rate limit" (very common for
  // web/API work) get misread as an expired login or usage cap. That would
  // wrongly flip auto-run off or trap the task in an endless wait-for-reset retry
  // loop. When there's no parseable result we fall back to stdout+stderr.
  const signal = parsed && parsed.type === 'result' ? `${parsed.result || ''}\n${stderr}` : `${stdout}\n${stderr}`;
  const auth = AUTH_RE.test(signal);
  const limited = !auth && LIMIT_RE.test(signal); // a 401 is auth, not a usage cap

  if (parsed && parsed.type === 'result') {
    const isError = parsed.is_error === true || (parsed.subtype && parsed.subtype !== 'success');
    if (isError) {
      if (auth)
        return { kind: 'auth', message: String(parsed.result || 'Claude login expired — please sign in again.').slice(0, 600) };
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

  if (auth) return { kind: 'auth', message: 'Claude login expired — please sign in again.' };
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

/* ---------------------------------------------------------------------------
 * Codex (`codex exec --json`) — the JSONL event stream has a different shape
 * from claude's stream-json, so it gets its own pure parse/classify helpers.
 * ------------------------------------------------------------------------- */

// Parse a "try again in 42s / 3 minutes" hint into ms, if present.
function codexRetryAfterMs(text) {
  if (!text) return null;
  const m = /(?:try again|retry|resets?)\D{0,20}?(\d+)\s*(second|sec|minute|min|hour|hr)/i.exec(String(text));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit.startsWith('sec') ? 1000 : unit.startsWith('min') ? 60000 : 3600000;
  return n > 0 ? n * mult : null;
}

// One codex `item.completed` item → a readable progress line (or null to skip).
function describeCodexItem(item) {
  if (!item || typeof item !== 'object') return null;
  const short = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
  switch (item.type) {
    case 'agent_message':
    case 'assistant_message':
      return '💬 ' + short(item.text || item.message || '', 240);
    case 'command_execution':
    case 'command':
      return '🔧 Running: ' + short(item.command || item.cmd || '');
    case 'file_change':
    case 'patch': {
      const paths = (item.changes || item.files || [])
        .map((c) => (typeof c === 'string' ? c : c && c.path))
        .filter(Boolean);
      return '🔧 Editing ' + short(paths.join(', ') || item.path || 'files', 120);
    }
    case 'mcp_tool_call':
      return '🔧 ' + short([item.server, item.tool || item.name].filter(Boolean).join('.'));
    case 'web_search':
      return '🔍 ' + short(item.query || '');
    case 'todo_list':
      return 'Updating its plan';
    case 'error':
      return '⚠️ ' + short(item.message || item.error || 'error', 200);
    default:
      return null; // reasoning / started / etc. — too noisy for the play-by-play
  }
}

// One codex JSONL event → readable progress line(s) (or [] to skip).
function summarizeCodexEvent(o) {
  if (!o || typeof o !== 'object') return [];
  if (o.type === 'item.completed' && o.item) {
    const line = describeCodexItem(o.item);
    return line ? [line] : [];
  }
  return [];
}

/**
 * Classify a finished `codex exec --json` run. Same contract as claude's
 * classifier: { kind: 'ok'|'limited'|'auth'|'error', ... }.
 */
function classifyCodexResult(o) {
  const { code, stdout = '', stderr = '', timedOut = false } = o || {};
  if (timedOut) {
    return { kind: 'error', error: 'timeout', message: 'Task exceeded its time limit and was stopped.' };
  }

  let sessionId = null;
  let lastText = '';
  let failure = '';
  let usage = null;
  let sawJson = false;

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    const ev = tryParse(t);
    if (!ev) continue;
    sawJson = true;
    switch (ev.type) {
      case 'thread.started':
      case 'session.created':
        sessionId = ev.thread_id || ev.session_id || ev.id || sessionId;
        break;
      case 'item.completed':
        if (ev.item && (ev.item.type === 'agent_message' || ev.item.type === 'assistant_message')) {
          lastText = ev.item.text || ev.item.message || lastText;
        } else if (ev.item && ev.item.type === 'error') {
          failure = ev.item.message || ev.item.error || failure;
        }
        break;
      case 'turn.completed':
        usage = ev.usage || usage;
        break;
      case 'turn.failed':
        failure = (ev.error && (ev.error.message || ev.error)) || failure;
        break;
      case 'error':
        failure = ev.message || ev.error || failure;
        break;
      default:
        break;
    }
  }

  const signal = `${failure}\n${lastText}\n${stderr}`;
  const auth = AUTH_RE.test(signal);
  const limited = !auth && LIMIT_RE.test(signal);

  if (failure) {
    if (auth) return { kind: 'auth', message: String(failure).slice(0, 600) };
    if (limited) return { kind: 'limited', message: String(failure).slice(0, 600), retryAfterMs: codexRetryAfterMs(signal) };
    return { kind: 'error', error: 'codex', message: String(failure).slice(0, 600) };
  }

  if (auth) return { kind: 'auth', message: 'Codex sign-in expired — please sign in again.' };
  if (limited) return { kind: 'limited', message: 'Rate limit reached.', retryAfterMs: codexRetryAfterMs(signal) };

  if (code === 0 || (sawJson && lastText)) {
    const result = lastText || (sawJson ? '' : stdout.trim());
    return {
      kind: 'ok',
      result,
      costUSD: null, // codex exec does not report a dollar cost
      sessionId,
      usage,
      followups: extractFollowups(result),
    };
  }

  return {
    kind: 'error',
    error: `exit ${code}`,
    message: (stderr || stdout || '').trim().slice(0, 600) || `codex exited with code ${code}`,
  };
}

module.exports = {
  parseCcusageBlocks,
  classifyClaudeResult,
  classifyCodexResult,
  extractFollowups,
  describeTool,
  describeCodexItem,
  summarizeStreamEvent,
  summarizeCodexEvent,
  codexRetryAfterMs,
  LIMIT_RE,
  AUTH_RE,
};
