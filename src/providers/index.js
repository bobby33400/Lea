'use strict';
/* providers/index.js — the agent registry. Add a provider here to expose it. */
const claude = require('./claude');
const codex = require('./codex');

const ALL = [claude, codex];
const BY_ID = Object.fromEntries(ALL.map((p) => [p.id, p]));
const DEFAULT_ID = claude.id;

// Resolve a provider by id, falling back to the default (claude).
function get(id) {
  return BY_ID[id] || BY_ID[DEFAULT_ID];
}

function list() {
  return ALL.slice();
}

function ids() {
  return ALL.map((p) => p.id);
}

module.exports = { get, list, ids, DEFAULT_ID, claude, codex };
