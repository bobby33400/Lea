'use strict';
/*
 * attachments.js — copy user-picked images into a task's project folder so
 * Claude can read them under EVERY sandbox backend.
 *
 * Why copy at all? The Docker backend mounts ONLY the project dir into the
 * container, so an image sitting anywhere else on disk is invisible to Claude.
 * Copying into <cwd>/.lea-attachments/ guarantees the file is in scope for
 * Seatbelt, Docker, and none alike, and lets us hand Claude a project-relative
 * POSIX path that resolves the same natively or inside a container.
 *
 * Pure-ish (fs only, no electron) so it stays unit-testable.
 */
const fs = require('fs');
const path = require('path');

const ATTACH_DIRNAME = '.lea-attachments';

/**
 * Copy `absPaths` into `<cwd>/.lea-attachments/` and return attachment records:
 *   [{ name, rel, abs }]
 * where `name` is the original filename, `rel` is a POSIX project-relative path
 * (what we put in the prompt), and `abs` is the on-disk copy (for UI previews).
 * Unreadable sources are skipped. Returns [] when there's nothing to do.
 */
function materializeAttachments(cwd, absPaths, now, rand) {
  const out = [];
  if (!cwd || !Array.isArray(absPaths) || !absPaths.length) return out;
  const stamp = typeof now === 'function' ? now : () => Date.now();
  const noise = typeof rand === 'function' ? rand : () => Math.floor(Math.random() * 1e6);
  const destDir = path.join(cwd, ATTACH_DIRNAME);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    // Keep attachments out of the user's git history automatically.
    const gi = path.join(destDir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  } catch {}
  for (const src of absPaths) {
    try {
      const base = path.basename(String(src));
      const tag = stamp().toString(36) + noise().toString(36);
      const safe = tag + '-' + base.replace(/[^\w.\-]+/g, '_');
      const abs = path.join(destDir, safe);
      fs.copyFileSync(src, abs);
      out.push({ name: base, rel: ATTACH_DIRNAME + '/' + safe, abs });
    } catch {
      // skip a source we couldn't read/copy
    }
  }
  return out;
}

module.exports = { materializeAttachments, ATTACH_DIRNAME };
