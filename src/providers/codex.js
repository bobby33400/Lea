'use strict';
/*
 * providers/codex.js — the OpenAI Codex agent adapter.
 *
 * Drives `codex exec --json …` headlessly and maps its JSONL event stream onto
 * the same {ok|limited|auth|error} contract the runner expects from Claude.
 *
 * Key differences from Claude, handled here:
 *   - Codex sandboxes itself (Seatbelt/Landlock via --sandbox), so it is NOT
 *     wrapped in sandbox-exec (see providers.selfSandboxed).
 *   - There is no ccusage equivalent, so the runner falls back to a timed retry
 *     when Codex reports a rate limit (usesCcusage = false).
 *   - Follow-ups for the human are folded into the prompt (no append-system-prompt).
 */
const config = require('../config');
const { summarizeCodexEvent, classifyCodexResult } = require('../classify');

module.exports = {
  id: 'codex',
  label: 'Codex',
  blurb: 'OpenAI’s codex CLI. Sign in with ChatGPT (codex login) or an API key.',

  selfSandboxed: true, // codex brings its own Seatbelt/Landlock sandbox
  usesCcusage: false, // no ccusage for OpenAI — limit → timed retry
  imageMode: 'flag', // attachments passed via `-i <file>`
  containerBin: 'codex',

  // Model ids change often; keep a short suggested list + free-text in the UI.
  // Empty default means "let codex use its configured default model".
  models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
  defaultModel: '',
  modelKey: 'codexModel',
  awayModelKey: 'codexAwayModel',

  authModes: [
    { value: 'cli', label: 'Signed-in CLI (codex login)', needsKey: false },
    { value: 'apikey', label: 'API key (OPENAI_API_KEY)', needsKey: true, keySetting: 'openaiApiKey' },
  ],
  authModeKey: 'codexAuthMode',

  resolveBin: (cfg = config) => cfg.resolveCodexBin(),

  env(cfg = config, _opts = {}) {
    const out = {};
    if ((cfg.get('codexAuthMode') || 'cli') === 'apikey') {
      const k = (cfg.get('openaiApiKey') || '').trim();
      if (k) out.OPENAI_API_KEY = k;
    }
    return out;
  },
  dockerEnvKeys(cfg = config, opts = {}) {
    return Object.keys(this.env(cfg, opts));
  },

  // Codex exec has no --append-system-prompt; fold the ask into the prompt.
  injectFollowups(prompt, instruction) {
    return { prompt: String(prompt || '').trim() + '\n\n' + instruction, appendSystemPrompt: null };
  },

  // One JSONL event → readable progress line(s).
  parseStreamEvent: (o) => summarizeCodexEvent(o),
  classifyResult: (res) => classifyCodexResult(res),

  authStatus(cfg = config) {
    if ((cfg.get('codexAuthMode') || 'cli') === 'apikey') return (cfg.get('openaiApiKey') || '').trim() ? 'apikey' : null;
    return 'cli';
  },
};
