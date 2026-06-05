'use strict';
/* window.js — compute the PRECISE usage-window reset.
 *
 * ccusage floors the 5-hour block start to the top of the hour, but Anthropic
 * resets exactly 5 hours after your first message. That makes ccusage's reset
 * read up to ~59 min early. Here we recover the real window start by finding the
 * earliest actual message timestamp inside the active block, and set
 * reset = firstMessage + 5h.
 *
 * The pure helper (earliestTimestampInRange) is unit-tested; the file scan is
 * thin and bounded by file mtime so it's cheap to call on each poll.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Pure: earliest timestamp within [lo, hi], or null. */
function earliestTimestampInRange(timestamps, lo, hi) {
  let min = null;
  for (const t of timestamps) {
    if (t >= lo && t <= hi && (min === null || t < min)) min = t;
  }
  return min;
}

function collectJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

/**
 * Scan recent transcripts for the earliest QUOTA-CONSUMING message in
 * [loMs, hiMs] — an entry with `message.usage`, i.e. a real API request.
 *
 * Anthropic anchors the 5-hour window to your first request that actually spends
 * quota, NOT to when you started typing. The transcript can log user/attachment
 * lines a few minutes before the first API call lands, so anchoring on "any
 * timestamp" reads the reset a few minutes early. Filtering to usage-bearing
 * entries matches the website.
 */
function scanFirstMessage(loMs, hiMs, projectsDir = PROJECTS_DIR) {
  let files;
  try {
    files = collectJsonl(projectsDir);
  } catch {
    return null;
  }
  const skipBefore = loMs - 2 * 60 * 60 * 1000; // ignore clearly-stale files
  let min = null;
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (st.mtimeMs < skipBefore) continue;
    let data;
    try {
      data = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of data.split('\n')) {
      if (line.indexOf('"usage"') === -1) continue; // quota-consuming entries only
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o.message || !o.message.usage) continue;
      const t = Date.parse(o.timestamp);
      if (!isNaN(t) && t >= loMs && t <= hiMs && (min === null || t < min)) min = t;
    }
  }
  return min;
}

/**
 * Given ccusage's floored block bounds, return the precise {startAt, resetAt}
 * from the real first-message time. Falls back to the floored values.
 */
function preciseWindow(flooredStartMs, flooredEndMs, projectsDir = PROJECTS_DIR) {
  const realStart = scanFirstMessage(flooredStartMs, flooredEndMs, projectsDir);
  if (realStart == null) return { startAt: flooredStartMs, resetAt: flooredEndMs, precise: false };
  return { startAt: realStart, resetAt: realStart + FIVE_HOURS_MS, precise: true };
}

/** Pure: aggregate per-model token usage from records, de-duping by key and
 * filtering to [loMs, hiMs]. records: [{ t, model, usage, key }]. */
function tallyModelUsage(records, loMs, hiMs) {
  const out = {};
  const seen = new Set();
  for (const r of records) {
    if (r.t < loMs || r.t > hiMs) continue;
    if (!r.model || !r.usage) continue;
    if (r.key) {
      if (seen.has(r.key)) continue; // same logical message can appear in >1 file
      seen.add(r.key);
    }
    const u = r.usage;
    const inp = u.input_tokens || 0;
    const op = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const e = out[r.model] || (out[r.model] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });
    e.input += inp;
    e.output += op;
    e.cacheWrite += cw;
    e.cacheRead += cr;
    e.total += inp + op + cw + cr;
  }
  return out;
}

/** Impure: scan recent transcripts and tally per-model usage within [loMs, hiMs]. */
function modelUsageInRange(loMs, hiMs, projectsDir = PROJECTS_DIR) {
  let files;
  try {
    files = collectJsonl(projectsDir);
  } catch {
    return {};
  }
  const skipBefore = loMs - 2 * 60 * 60 * 1000;
  const records = [];
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (st.mtimeMs < skipBefore) continue;
    let data;
    try {
      data = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of data.split('\n')) {
      if (line.indexOf('"usage"') === -1) continue; // cheap pre-filter
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(o.timestamp);
      if (isNaN(t)) continue;
      const msg = o.message;
      if (!msg || !msg.usage || !msg.model) continue;
      records.push({ t, model: msg.model, usage: msg.usage, key: (o.requestId || '') + '|' + (msg.id || o.uuid || '') });
    }
  }
  return tallyModelUsage(records, loMs, hiMs);
}

module.exports = {
  earliestTimestampInRange,
  scanFirstMessage,
  preciseWindow,
  tallyModelUsage,
  modelUsageInRange,
  FIVE_HOURS_MS,
  PROJECTS_DIR,
};
