'use strict';
/* spawnutil.js — run a command and buffer its output, using cross-spawn so
 * Windows `.cmd`/`.bat` shims and quoting work the same as on macOS/Linux. */
const spawn = require('cross-spawn');

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const max = opts.maxBuffer || 16 * 1024 * 1024;

    let child;
    try {
      child = spawn(bin, args, { env: opts.env, cwd: opts.cwd });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e), error: e });
    }

    let timer = null;
    if (opts.timeout) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, opts.timeout);
    }

    if (child.stdout) {
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.length > max) stdout = stdout.slice(-max);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > max) stderr = stderr.slice(-max);
      });
    }
    child.on('error', (e) => {
      stderr += String((e && e.message) || e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

module.exports = { run };
