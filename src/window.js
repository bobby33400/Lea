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

/** Scan recent transcripts for the earliest message timestamp in [loMs, hiMs]. */
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
    let idx = -1;
    while ((idx = data.indexOf('"timestamp":"', idx + 1)) !== -1) {
      const start = idx + 13;
      const end = data.indexOf('"', start);
      if (end === -1) break;
      const t = Date.parse(data.slice(start, end));
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

module.exports = { earliestTimestampInRange, scanFirstMessage, preciseWindow, FIVE_HOURS_MS, PROJECTS_DIR };
