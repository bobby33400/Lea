'use strict';
/* Plain-node smoke tests for the pure logic (no electron, no token spend). */
const assert = require('assert');
const { buildSeatbeltProfile, buildCommand, chooseFallback, DOCKER_WORKDIR } = require('../src/sandbox');
const { parseCcusageBlocks, classifyClaudeResult } = require('../src/classify');

let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ok ${n} - ${name}`);
};

const base = {
  claudeBin: '/opt/homebrew/bin/claude',
  prompt: 'refactor the parser',
  cwd: '/Users/u/proj',
  model: 'opus',
  fallbackModel: 'sonnet',
  permissionMode: 'bypassPermissions',
};

// --- seatbelt backend ---
{
  const cmd = buildCommand({ ...base, backend: 'seatbelt', sbFile: '/tmp/x.sb' });
  assert.strictEqual(cmd.bin, '/usr/bin/sandbox-exec');
  assert.deepStrictEqual(cmd.args.slice(0, 3), ['-f', '/tmp/x.sb', '/opt/homebrew/bin/claude']);
  assert.ok(cmd.args.includes('refactor the parser'), 'prompt passed as a single arg');
  assert.ok(cmd.args.includes('--output-format') && cmd.args.includes('stream-json') && cmd.args.includes('--verbose'));
  assert.ok(cmd.args.includes('bypassPermissions'));
  assert.ok(cmd.args.includes('--model') && cmd.args.includes('opus'));
  ok('seatbelt backend wraps claude in sandbox-exec');
}

// --- none backend ---
{
  const cmd = buildCommand({ ...base, backend: 'none' });
  assert.strictEqual(cmd.bin, '/opt/homebrew/bin/claude');
  assert.strictEqual(cmd.args[0], '-p');
  ok('none backend runs claude directly');
}

// --- docker backend ---
{
  const cmd = buildCommand({
    ...base,
    backend: 'docker',
    dockerImage: 'lea-claude:latest',
    containerName: 'lea-t1',
    dockerToken: true,
  });
  assert.strictEqual(cmd.bin, 'docker');
  assert.ok(cmd.args.includes('run') && cmd.args.includes('--rm'));
  assert.ok(cmd.args.includes('-v') && cmd.args.includes(`/Users/u/proj:${DOCKER_WORKDIR}`), 'mounts project at workdir');
  assert.ok(cmd.args.includes('--name') && cmd.args.includes('lea-t1'));
  assert.ok(cmd.args.includes('-e') && cmd.args.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'passes token by name only');
  assert.ok(cmd.args.includes('lea-claude:latest') && cmd.args.includes('claude'));
  // claude should be told the container path, not the host path
  const addIdx = cmd.args.lastIndexOf('--add-dir');
  assert.strictEqual(cmd.args[addIdx + 1], DOCKER_WORKDIR, '--add-dir uses container path');
  ok('docker backend mounts only the project dir and uses container paths');
}

// --- model switch: --fallback-model must never duplicate or escalate the model ---
// Regression: the fallback is hardcoded to 'sonnet'. Fine for the default 'opus',
// but switching the model in Settings to sonnet/haiku produced a broken argv
// ('--model sonnet --fallback-model sonnet', which Claude rejects) or a silent
// cost escalation ('--model haiku' overflowing to the pricier sonnet).
{
  const fbOf = (o) => {
    const a = buildCommand(o).args;
    const i = a.indexOf('--fallback-model');
    return i === -1 ? null : a[i + 1];
  };
  assert.strictEqual(fbOf({ ...base, backend: 'none', model: 'opus', fallbackModel: 'sonnet' }), 'sonnet', 'opus keeps the sonnet fallback');
  assert.strictEqual(fbOf({ ...base, backend: 'none', model: 'sonnet', fallbackModel: 'sonnet' }), null, 'sonnet drops the duplicate fallback');
  assert.strictEqual(fbOf({ ...base, backend: 'none', model: 'haiku', fallbackModel: 'sonnet' }), null, 'haiku drops the escalating fallback');
  // pure helper: unknown/custom model ids keep whatever was configured
  assert.strictEqual(chooseFallback('opus', 'sonnet'), 'sonnet');
  assert.strictEqual(chooseFallback('sonnet', 'sonnet'), null);
  assert.strictEqual(chooseFallback('haiku', 'sonnet'), null);
  assert.strictEqual(chooseFallback('claude-3-5-custom', 'sonnet'), 'sonnet', 'unknown primary keeps the configured fallback');
  ok('fallback-model only applies as a genuine cheaper safety net below the chosen model');
}

// --- image attachments (docker mounts the attachment dir read-only) ---
{
  const cmd = buildCommand({
    ...base,
    backend: 'docker',
    dockerImage: 'lea-claude:latest',
    prompt: 'what is in this screenshot?\n\n[The user attached 1 image. ...]\n- /lea-attachments/a.png',
    attachmentMounts: [{ hostDir: '/data/attachments/t1', containerDir: '/lea-attachments' }],
  });
  assert.ok(cmd.args.includes('/data/attachments/t1:/lea-attachments:ro'), 'mounts attachment dir read-only');
  // both the project workdir and the attachment dir are exposed via --add-dir
  const addDirs = cmd.args.filter((_, i) => cmd.args[i - 1] === '--add-dir');
  assert.ok(addDirs.includes(DOCKER_WORKDIR) && addDirs.includes('/lea-attachments'), 'add-dir covers both');
  ok('docker backend mounts image-attachment dirs read-only with container paths');
}

// --- no attachments → no extra mounts (default path unchanged) ---
{
  const cmd = buildCommand({ ...base, backend: 'docker', dockerImage: 'lea-claude:latest' });
  assert.ok(!cmd.args.some((a) => String(a).includes(':ro')), 'no read-only mounts without attachments');
  ok('docker backend adds no extra mounts when there are no attachments');
}

// --- seatbelt profile ---
{
  const prof = buildSeatbeltProfile({
    home: '/Users/u',
    cwd: '/Users/u/proj',
    dataDir: '/Users/u/Library/Application Support/Lea',
    extraDirs: ['/Users/u/scratch'],
  });
  assert.ok(/^\(version 1\)/.test(prof), 'starts with version');
  assert.ok(prof.includes('(allow default)'));
  assert.ok(prof.includes('(deny file-write* (subpath "/Users/u"))'), 'denies home writes');
  assert.ok(prof.includes('(subpath "/Users/u/proj")'), 're-allows project dir');
  assert.ok(prof.includes('(subpath "/Users/u/scratch")'), 're-allows extra dir');
  assert.ok(prof.lastIndexOf('.ssh') > prof.indexOf('(allow file-write*'), '.ssh denied last (wins)');
  ok('seatbelt profile confines writes and protects secrets in order');
}

// --- ccusage parsing (active block) ---
{
  const snap = parseCcusageBlocks(
    JSON.stringify({
      blocks: [
        {
          isActive: true,
          startTime: '2026-06-05T10:00:00.000Z',
          endTime: '2026-06-05T15:00:00.000Z',
          totalTokens: 143673,
          costUSD: 0.7655,
          models: ['claude-opus-4-8'],
        },
      ],
    })
  );
  assert.strictEqual(snap.active, true);
  assert.strictEqual(snap.totalTokens, 143673);
  assert.strictEqual(snap.resetAt, Date.parse('2026-06-05T15:00:00.000Z'));
  ok('parseCcusageBlocks extracts reset time + tokens');
}

// --- ccusage parsing (idle) ---
{
  const snap = parseCcusageBlocks(JSON.stringify({ blocks: [] }));
  assert.strictEqual(snap.active, false);
  assert.strictEqual(snap.resetAt, null);
  ok('parseCcusageBlocks handles idle (no active block)');
}

// --- classify: success ---
{
  const r = classifyClaudeResult({
    code: 0,
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      total_cost_usd: 0.0123,
      session_id: 'sess_abc',
    }),
    stderr: '',
  });
  assert.strictEqual(r.kind, 'ok');
  assert.strictEqual(r.costUSD, 0.0123);
  ok('classify recognizes a successful JSON result');
}

// --- classify: usage limit ---
{
  const r = classifyClaudeResult({ code: 1, stdout: '', stderr: 'Claude AI usage limit reached. Resets at 3 PM.' });
  assert.strictEqual(r.kind, 'limited');
  ok('classify detects a usage-limit hit');
}

// --- classify: rate limit in JSON error ---
{
  const r = classifyClaudeResult({
    code: 0,
    stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'rate limit exceeded' }),
    stderr: '',
  });
  assert.strictEqual(r.kind, 'limited');
  ok('classify maps a rate-limit JSON error to limited');
}

// --- classify: generic error ---
{
  const r = classifyClaudeResult({ code: 2, stdout: '', stderr: 'boom: broke' });
  assert.strictEqual(r.kind, 'error');
  assert.ok(/boom/.test(r.message));
  ok('classify surfaces a generic error');
}

// --- classify: auth/login failure (distinct from limit + generic error) ---
{
  const r = classifyClaudeResult({ code: 1, stdout: '', stderr: 'API Error: 401 Invalid authentication credentials' });
  assert.strictEqual(r.kind, 'auth', '401 maps to auth, not error/limited');
  const j = classifyClaudeResult({
    code: 0,
    stdout: JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid authentication credentials' }),
    stderr: '',
  });
  assert.strictEqual(j.kind, 'auth', 'auth detected inside JSON result too');
  ok('classify detects an auth/login failure as kind=auth');
}

// --- classify: transcript noise must NOT trigger limit/auth ---
// A failed run whose stream-json transcript (assistant text / tool output)
// merely mentions "401"/"rate limit" must stay kind=error, not be misread as an
// expired login or usage cap (which would pause auto-run or loop forever).
{
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I saw a 401 unauthorized and a rate limit in the logs.' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'curl: server returned HTTP 429 Too Many Requests' }] } }),
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'The test suite failed: 3 assertions did not pass.' }),
  ].join('\n');
  const r = classifyClaudeResult({ code: 0, stdout, stderr: '' });
  assert.strictEqual(r.kind, 'error', 'transcript mentioning 401/rate-limit must not override the real error result');
  // and a genuine cap (signalled in the result message itself) still classifies
  const cap = classifyClaudeResult({
    code: 0,
    stdout: [stdout.split('\n')[0], JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Claude AI usage limit reached. Resets at 3 PM.' })].join('\n'),
    stderr: '',
  });
  assert.strictEqual(cap.kind, 'limited', 'a real limit in the result message still maps to limited');
  ok('classify ignores 401/limit text in the transcript, trusts the result/stderr signal');
}

// --- precise reset window ---
{
  const { earliestTimestampInRange, FIVE_HOURS_MS } = require('../src/window');
  const lo = Date.parse('2026-06-05T12:00:00.000Z'); // ccusage floored start
  const hi = Date.parse('2026-06-05T17:00:00.000Z'); // ccusage floored end
  const ts = [
    Date.parse('2026-06-05T11:59:00.000Z'), // before the block — ignored
    Date.parse('2026-06-05T12:17:03.000Z'), // the real first message
    Date.parse('2026-06-05T13:30:00.000Z'),
    Date.parse('2026-06-05T18:00:00.000Z'), // after the block — ignored
  ];
  const first = earliestTimestampInRange(ts, lo, hi);
  assert.strictEqual(first, Date.parse('2026-06-05T12:17:03.000Z'), 'picks the real first message');
  assert.strictEqual(first + FIVE_HOURS_MS, Date.parse('2026-06-05T17:17:03.000Z'), 'reset = first message + 5h');
  assert.ok(first + FIVE_HOURS_MS > hi, 'precise reset is later than ccusage floored reset');
  ok('precise window: reset is first-message + 5h, not the floored hour');
}

// --- per-model usage tally ---
{
  const { tallyModelUsage } = require('../src/window');
  const records = [
    { t: 100, model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, key: 'a' },
    { t: 100, model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, key: 'a' }, // duplicate
    { t: 150, model: 'claude-haiku-4-5', usage: { input_tokens: 2, output_tokens: 3 }, key: 'b' },
    { t: 5, model: 'claude-opus-4-8', usage: { input_tokens: 999 }, key: 'c' }, // out of range
  ];
  const out = tallyModelUsage(records, 50, 200);
  assert.strictEqual(out['claude-opus-4-8'].total, 115, 'opus = 10+5+100; dup ignored; out-of-range excluded');
  assert.strictEqual(out['claude-opus-4-8'].cacheRead, 100);
  assert.strictEqual(out['claude-haiku-4-5'].total, 5);
  ok('tallyModelUsage aggregates per model, dedupes by key, filters by range');
}

// --- follow-up extraction ---
{
  const { extractFollowups } = require('../src/classify');
  // structured block
  const a = extractFollowups('Report.\n===LEA-FOLLOWUPS===\n- Run `supabase db push`\n- Review the diff\n===END-FOLLOWUPS===');
  assert.deepStrictEqual(a, ['Run `supabase db push`', 'Review the diff'], 'parses structured block');
  // explicit NONE
  assert.deepStrictEqual(extractFollowups('done\n===LEA-FOLLOWUPS===\nNONE\n===END-FOLLOWUPS==='), [], 'NONE => empty');
  // heuristic markdown section
  const c = extractFollowups('# Summary\nok\n## Action required from you\n- Push to git\n- Apply migration\n## Notes\nx');
  assert.deepStrictEqual(c, ['Push to git', 'Apply migration'], 'heuristic action-required section');
  // nothing actionable
  assert.deepStrictEqual(extractFollowups('All good, nothing for you to do.'), [], 'no section => empty');
  ok('extractFollowups: structured block, NONE, heuristic section, and empty');
}

// --- report snapshot diff ---
{
  const { diffSnapshots } = require('../src/report');
  const before = new Map([['a.txt', '1:10'], ['b.txt', '2:20'], ['c.txt', '3:30']]);
  const after = new Map([['a.txt', '1:10'], ['b.txt', '9:25'], ['d.txt', '4:40']]);
  const d = diffSnapshots(before, after);
  assert.deepStrictEqual(d.added, ['d.txt'], 'added');
  assert.deepStrictEqual(d.modified, ['b.txt'], 'modified (mtime/size changed)');
  assert.deepStrictEqual(d.deleted, ['c.txt'], 'deleted');
  ok('diffSnapshots detects added / modified / deleted');
}

// --- stream-json progress summarizer ---
{
  const { summarizeStreamEvent, describeTool } = require('../src/classify');
  assert.strictEqual(describeTool('Read', { file_path: '/a/b/c.ts' }), 'Reading /a/b/c.ts');
  assert.ok(describeTool('Bash', { command: 'npm test' }).startsWith('Running: npm test'));
  const ev = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Looking at the code' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'x.js' } }] },
  };
  const out = summarizeStreamEvent(ev);
  assert.strictEqual(out.length, 2);
  assert.ok(out[0].includes('Looking at the code'));
  assert.ok(out[1].includes('Editing x.js'));
  assert.deepStrictEqual(summarizeStreamEvent({ type: 'result' }), [], 'result event produces no progress line');
  assert.deepStrictEqual(summarizeStreamEvent({ type: 'system', subtype: 'init' }), []);
  ok('summarizeStreamEvent + describeTool produce readable progress lines');
}

console.log(`\nselftest OK — ${n} checks passed`);
