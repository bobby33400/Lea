'use strict';
/*
 * providers/claude.js — the Claude Code agent adapter.
 *
 * Wraps the existing claude-specific logic (argv in sandbox.js, output parsing
 * in classify.js) behind the common provider interface the runner speaks, so
 * Claude and Codex are interchangeable at the task level.
 */
const config = require('../config');
const { classifyClaudeResult, summarizeStreamEvent } = require('../classify');

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  blurb: 'Anthropic’s claude CLI. Subscription (claude /login) or an API key.',

  selfSandboxed: false, // needs the OS sandbox (Seatbelt/Docker) around it
  usesCcusage: true, // ccusage gives a precise reset window for the wait loop
  imageMode: 'prompt', // attachments are referenced from the prompt text
  containerBin: 'claude', // binary name inside the Docker image

  // Models offered in the UI. Config keys hold the active/away defaults.
  models: ['fable', 'opus', 'sonnet', 'haiku'],
  defaultModel: 'opus',
  modelKey: 'model',
  awayModelKey: 'awayModel',

  // Auth options surfaced in onboarding / settings.
  authModes: [
    { value: 'cli', label: 'Signed-in CLI (claude /login)', needsKey: false },
    { value: 'apikey', label: 'API key (ANTHROPIC_API_KEY)', needsKey: true, keySetting: 'anthropicApiKey' },
  ],
  authModeKey: 'claudeAuthMode',

  resolveBin: (cfg = config) => cfg.resolveClaudeBin(),

  // Extra env for the spawned child, based on the chosen auth mode.
  env(cfg = config, opts = {}) {
    const mode = cfg.get('claudeAuthMode') || 'cli';
    const out = {};
    if (mode === 'apikey') {
      const k = (cfg.get('anthropicApiKey') || '').trim();
      if (k) out.ANTHROPIC_API_KEY = k;
    } else if (mode === 'token') {
      const t = (cfg.get('claudeOAuthToken') || '').trim();
      if (t) out.CLAUDE_CODE_OAUTH_TOKEN = t;
    }
    // Back-compat: the Docker backend has always used claudeOAuthToken for
    // subscription auth, regardless of the (newer) auth-mode setting.
    if (opts.backend === 'docker' && !out.ANTHROPIC_API_KEY && !out.CLAUDE_CODE_OAUTH_TOKEN) {
      const t = (cfg.get('claudeOAuthToken') || '').trim();
      if (t) out.CLAUDE_CODE_OAUTH_TOKEN = t;
    }
    return out;
  },
  // Keys to forward into a Docker run by name (value comes from env, not argv).
  dockerEnvKeys(cfg = config, opts = {}) {
    return Object.keys(this.env(cfg, opts));
  },

  // Claude reports the human-facing follow-ups via an appended system prompt.
  injectFollowups(prompt, instruction) {
    return { prompt, appendSystemPrompt: instruction };
  },

  parseStreamEvent: (o) => summarizeStreamEvent(o),
  classifyResult: (res) => classifyClaudeResult(res),

  // How signed-in the agent looks right now (best-effort, for the UI).
  authStatus(cfg = config) {
    const mode = cfg.get('claudeAuthMode') || 'cli';
    if (mode === 'apikey') return (cfg.get('anthropicApiKey') || '').trim() ? 'apikey' : null;
    if (mode === 'token') return (cfg.get('claudeOAuthToken') || '').trim() ? 'token' : null;
    return 'cli'; // relies on the CLI's own stored login; verified at run time
  },
};
