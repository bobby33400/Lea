'use strict';
/* app.js — renderer logic for the menu-bar panel. Talks to main via window.api. */
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

let usage = { active: false, resetAt: null, startAt: null, totalTokens: 0, costUSD: 0, models: [] };
let runnerState = { busy: false, waitUntil: null, waitReason: null, autoRun: true, phase: 'idle' };
let tasks = [];
let settings = {};
let doneCollapsed = false;
let liveActivity = {}; // taskId -> [recent short activity lines]
let logTimer = null; // refresh timer while a log panel is open
let chatTaskId = null; // task whose chat panel is currently open

const fmtDur = (ms) => {
  if (ms == null) return '—:—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
};
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const basename = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p;
const doneTime = (t) => {
  const r = t.runs && t.runs.length ? t.runs[t.runs.length - 1] : null;
  return (r && r.endedAt) || t.updatedAt || 0;
};

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function renderUsage() {
  let status = 'idle';
  if (runnerState.busy) status = 'running task';
  else if (!runnerState.autoRun) status = 'auto-run off';
  else if (runnerState.phase === 'quiet') status = 'quiet hours';
  else if (runnerState.waitUntil && runnerState.waitUntil > Date.now()) status = runnerState.waitReason || 'waiting';
  else if (tasks.some((t) => t.status === 'queued')) status = 'ready';
  if (usage.error) status = 'usage err';
  if (runnerState.away) status += ' 💤'; // efficient mode (you're idle)
  $('#u-status').textContent = status;

  let target = null;
  let label = 'until reset';
  if (runnerState.waitUntil && runnerState.waitUntil > Date.now()) {
    target = runnerState.waitUntil;
    label = runnerState.waitReason && /reset/.test(runnerState.waitReason) ? 'until reset' : 'until retry';
  } else if (usage.active && usage.resetAt) {
    target = usage.resetAt;
    label = 'until window reset';
  }
  $('#u-countdown').textContent = target ? fmtDur(target - Date.now()) : usage.active ? '—' : 'FULL';
  $('#u-countlabel').textContent = target ? label : 'no active window — full capacity';

  let frac = 0;
  if (usage.active && usage.startAt && usage.resetAt && usage.resetAt > usage.startAt) {
    frac = (Date.now() - usage.startAt) / (usage.resetAt - usage.startAt);
  }
  $('#u-bar').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  $('#u-tokens').textContent = fmtTokens(usage.totalTokens) + ' tokens this session';
  $('#u-cost').textContent = '$' + (usage.costUSD || 0).toFixed(2) + ' value';
  renderModelBreakdown();
}

// Per-model token usage for the current session (which models, how much each).
function renderModelBreakdown() {
  const cont = $('#u-models');
  cont.innerHTML = '';
  const mb = (usage.modelBreakdown || []).filter((m) => m.total > 0);
  if (!mb.length) return;
  const max = mb[0].total || 1;
  const clean = (m) => m.replace(/^claude-/, '').replace(/-\d{6,}$/, '');
  for (const m of mb) {
    const row = el('div', 'mrow');
    row.appendChild(el('span', 'mname', clean(m.model)));
    const bar = el('div', 'mbar');
    const fill = el('div', 'mbarfill');
    fill.style.width = Math.max(4, (m.total / max) * 100) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'mval', fmtTokens(m.total)));
    cont.appendChild(row);
  }
}

// Render text with inline `code` and ```fenced``` blocks.
function renderInline(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split('```');
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      frag.appendChild(el('pre', 'fu-code', parts[i].replace(/^[a-z0-9]*\n/i, '').replace(/\s+$/, '')));
    } else {
      const seg = parts[i].split('`');
      for (let j = 0; j < seg.length; j++) {
        if (j % 2 === 1) frag.appendChild(el('code', null, seg[j]));
        else if (seg[j]) frag.appendChild(document.createTextNode(seg[j]));
      }
    }
  }
  return frag;
}

function followupsBox(items) {
  const box = el('div', 'followups');
  box.appendChild(el('div', 'fu-title', '📋 Things for you to do'));
  for (const it of items) {
    const line = el('div', 'fu-item');
    line.appendChild(renderInline(it));
    box.appendChild(line);
  }
  return box;
}

function renderActivityInto(node, lines) {
  node.innerHTML = '';
  const arr = lines && lines.length ? lines : ['• starting…'];
  for (const l of arr) {
    node.appendChild(el('div', 'act-line', l.length > 64 ? l.slice(0, 63) + '…' : l));
  }
}

function taskRow(t) {
  const row = el('div', 'task ' + t.status);
  const main = el('div', 'task-main');
  main.appendChild(el('div', 'task-title', t.title));
  const meta = el('div', 'task-meta');
  meta.appendChild(el('span', 'badge ' + t.status, t.status));
  meta.appendChild(el('span', 'muted small', '📁 ' + (basename(t.cwd) || 'no folder')));
  if (t.model) meta.appendChild(el('span', 'muted small', '· ' + t.model));
  if (t.attempts) meta.appendChild(el('span', 'muted small', '· try ' + t.attempts));
  const lastRun = t.runs && t.runs.length ? t.runs[t.runs.length - 1] : null;
  if (lastRun && lastRun.costUSD) meta.appendChild(el('span', 'muted small', '· $' + lastRun.costUSD.toFixed(3)));
  if (t.status === 'done' && lastRun) {
    const s = Math.round((lastRun.endedAt - lastRun.startedAt) / 1000);
    meta.appendChild(el('span', 'muted small', '· ' + (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's')));
  }
  main.appendChild(meta);
  if (t.lastError) main.appendChild(el('div', 'err small', String(t.lastError).slice(0, 160)));
  if (t.status === 'running') {
    const act = el('div', 'task-activity');
    act.id = 'act-' + t.id;
    renderActivityInto(act, liveActivity[t.id]);
    main.appendChild(act);
  }
  if (t.followups && t.followups.length) main.appendChild(followupsBox(t.followups));
  row.appendChild(main);

  const actions = el('div', 'task-actions');
  const mk = (glyph, title, fn, disabled) => {
    const b = el('button', 'icon', glyph);
    b.title = title;
    if (disabled) b.disabled = true;
    else b.onclick = fn;
    return b;
  };
  actions.appendChild(mk('💬', 'Chat / reply', () => openChat(t.id)));
  if (t.status === 'failed') actions.appendChild(mk('↻', 'Requeue', () => window.api.tasksRequeue(t.id)));
  if (t.status === 'queued') {
    actions.appendChild(mk('▲', 'Move up', () => window.api.tasksReorder(t.id, 'up')));
    actions.appendChild(mk('▼', 'Move down', () => window.api.tasksReorder(t.id, 'down')));
  }
  if (t.status !== 'done') {
    actions.appendChild(
      mk('▶', 'Run now', async () => {
        const r = await window.api.tasksRunNow(t.id);
        if (r && !r.ok && r.error) toast(r.error);
      }, runnerState.busy)
    );
  }
  if (t.reportFile) actions.appendChild(mk('🧾', 'Open change report', () => window.api.openPath(t.reportFile)));
  actions.appendChild(mk('📄', 'View log', () => showLog(t)));
  actions.appendChild(mk('🗑', 'Delete', () => window.api.tasksRemove(t.id)));
  row.appendChild(actions);
  return row;
}

function renderTasks() {
  const list = $('#tasks');
  list.innerHTML = '';
  const active = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done').sort((a, b) => doneTime(b) - doneTime(a)); // newest first

  if (active.length === 0 && done.length === 0) {
    list.appendChild(
      el('div', 'empty', 'No tasks yet.\nClick ＋ Task to queue work for Claude to run automatically when your tokens reset.')
    );
    return;
  }

  for (const t of active) list.appendChild(taskRow(t));

  if (done.length) {
    const hdr = el('div', 'section-hdr foldable');
    hdr.onclick = () => {
      doneCollapsed = !doneCollapsed;
      renderTasks();
    };
    hdr.appendChild(el('span', null, (doneCollapsed ? '▸' : '▾') + '  ✓ Done (' + done.length + ')'));
    const clear = el('button', 'linkbtn', 'Clear');
    clear.title = 'Remove all done tasks';
    clear.onclick = (e) => {
      e.stopPropagation();
      const count = done.length;
      confirmDialog({
        title: 'Clear done tasks?',
        message: `Remove ${count} completed task${count > 1 ? 's' : ''} from Lea’s list? This only clears the list — your project files and the saved reports are not deleted.`,
        confirmLabel: 'Clear',
        danger: true,
        onConfirm: () => window.api.tasksClearDone(),
      });
    };
    hdr.appendChild(clear);
    list.appendChild(hdr);
    if (!doneCollapsed) for (const t of done) list.appendChild(taskRow(t));
  }
}

/* ---- overlays ---- */
function openOverlay(node) {
  const o = $('#overlay');
  o.innerHTML = '';
  const panel = el('div', 'panel');
  panel.appendChild(node);
  o.appendChild(panel);
  o.classList.remove('hidden');
  o.onclick = (e) => {
    if (e.target === o) closeOverlay();
  };
}
function closeOverlay() {
  const o = $('#overlay');
  o.classList.add('hidden');
  o.innerHTML = '';
  chatTaskId = null;
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

// Chat / reply panel for a task: shows the conversation, lets you send a
// follow-up ("approve", "also do X") that continues the same claude session.
function openChat(taskId) {
  chatTaskId = taskId;
  const t = tasks.find((x) => x.id === taskId) || {};
  const wrap = el('div', 'form');
  const head = el('div', 'row between');
  head.appendChild(el('h3', null, '💬 ' + (t.title || 'Task')));
  const close = el('button', 'btn', 'Close');
  close.onclick = closeOverlay;
  head.appendChild(close);
  wrap.appendChild(head);

  const thread = el('div', 'chat-thread');
  thread.id = 'chat-thread';
  wrap.appendChild(thread);

  const att = makeAttachUI();
  wrap.appendChild(att.strip);

  const row = el('div', 'chat-input');
  const ta = el('textarea', 'in');
  ta.id = 'chat-ta';
  ta.rows = 2;
  const send = el('button', 'btn primary', 'Send');
  send.id = 'chat-send';
  const doSend = async () => {
    const v = ta.value.trim();
    if (!v && !att.list.length) return;
    const payload = att.payload();
    ta.value = '';
    att.clear();
    const r = await window.api.tasksReply(taskId, v, payload);
    if (r && !r.ok && r.error) toast(r.error);
  };
  send.onclick = doSend;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSend();
    }
  };
  ta.onpaste = att.onPaste;
  row.appendChild(att.attachBtn);
  row.appendChild(ta);
  row.appendChild(send);
  wrap.appendChild(row);

  openOverlay(wrap);
  renderChat();
  setTimeout(() => ta.focus(), 30);
}

// Reusable image-attachment control: a 📎 button, clipboard-paste handler, and a
// strip of removable thumbnails. Bound to its own in-memory list of pending
// images. Returns the pieces a form wires up + helpers to read/clear them.
function makeAttachUI() {
  const list = [];
  const strip = el('div', 'chat-attach');
  const render = () => {
    strip.innerHTML = '';
    list.forEach((a, i) => {
      const chip = el('div', 'attach-chip');
      const img = el('img', 'attach-thumb');
      img.src = a.preview;
      chip.appendChild(img);
      chip.appendChild(el('span', 'attach-name', a.name.length > 18 ? a.name.slice(0, 17) + '…' : a.name));
      const x = el('button', 'attach-x', '✕');
      x.title = 'Remove';
      x.onclick = () => {
        list.splice(i, 1);
        render();
      };
      chip.appendChild(x);
      strip.appendChild(chip);
    });
  };
  const push = (a) => {
    if (list.length >= 8) return toast('Up to 8 images per message.');
    list.push(a);
    render();
  };
  const attachBtn = el('button', 'btn icon-btn', '📎');
  attachBtn.title = 'Attach image(s)';
  attachBtn.onclick = async () => {
    const picked = await window.api.pickImages();
    for (const p of picked || []) push({ name: p.name, path: p.path, preview: 'file://' + p.path });
  };
  // Paste a screenshot / image straight from the clipboard.
  const onPaste = (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (!file) continue;
        const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        const reader = new FileReader();
        reader.onload = () =>
          push({ name: file.name || 'pasted-' + (list.length + 1) + '.' + ext, dataUrl: reader.result, preview: reader.result });
        reader.readAsDataURL(file);
      }
    }
  };
  return {
    strip,
    attachBtn,
    onPaste,
    list,
    payload: () => list.map((a) => ({ name: a.name, path: a.path, dataUrl: a.dataUrl })),
    clear: () => {
      list.length = 0;
      render();
    },
  };
}

function renderChat() {
  if (!chatTaskId) return;
  const t = tasks.find((x) => x.id === chatTaskId);
  const thread = document.getElementById('chat-thread');
  if (!t || !thread) return;
  const wasNearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  thread.innerHTML = '';
  for (const m of t.thread || []) {
    const b = el('div', 'bubble ' + (m.role || 'assistant') + (m.error ? ' err' : ''));
    if (m.text) b.appendChild(renderInline(m.text));
    if (m.attachments && m.attachments.length) {
      const imgs = el('div', 'bubble-imgs');
      for (const a of m.attachments) {
        const im = el('img', 'bubble-img');
        im.src = 'file://' + a.path;
        im.title = a.name || '';
        im.onclick = () => window.api.openPath(a.path);
        imgs.appendChild(im);
      }
      b.appendChild(imgs);
    }
    thread.appendChild(b);
  }
  const running = t.status === 'running';
  if (running) {
    const b = el('div', 'bubble assistant working');
    b.appendChild(el('div', 'muted small', 'Lea is working…'));
    for (const l of liveActivity[t.id] || ['• …']) b.appendChild(el('div', 'act-line', l.length > 64 ? l.slice(0, 63) + '…' : l));
    thread.appendChild(b);
  }
  const send = document.getElementById('chat-send');
  const ta = document.getElementById('chat-ta');
  const canSend = !running && t.sessionId && !t.queuedReply;
  if (send) send.disabled = !canSend;
  if (ta) {
    ta.disabled = running;
    ta.placeholder = running
      ? 'Lea is working…'
      : t.sessionId
      ? 'Reply — e.g. “approve”, or “also update the README”…'
      : 'You can reply after the first run finishes.';
  }
  if (wasNearBottom) thread.scrollTop = thread.scrollHeight;
}

function confirmDialog(opts) {
  const wrap = el('div', 'form');
  if (opts.title) wrap.appendChild(el('h3', null, opts.title));
  wrap.appendChild(el('div', 'confirm-msg', opts.message));
  const actions = el('div', 'row end gap');
  actions.style.marginTop = '14px';
  const cancel = el('button', 'btn', opts.cancelLabel || 'Cancel');
  cancel.onclick = closeOverlay;
  const ok = el('button', 'btn ' + (opts.danger ? 'danger' : 'primary'), opts.confirmLabel || 'OK');
  ok.onclick = () => {
    closeOverlay();
    opts.onConfirm();
  };
  actions.appendChild(cancel);
  actions.appendChild(ok);
  wrap.appendChild(actions);
  openOverlay(wrap);
  setTimeout(() => ok.focus(), 30);
}

function addForm() {
  const wrap = el('div', 'form');
  wrap.appendChild(el('h3', null, 'New task'));

  wrap.appendChild(el('div', 'lbl', 'Title (optional)'));
  const title = el('input', 'in');
  title.placeholder = 'e.g. Fix failing tests';
  wrap.appendChild(title);

  wrap.appendChild(el('div', 'lbl', 'Instructions for Claude'));
  const prompt = el('textarea', 'in');
  prompt.placeholder = 'e.g. Run the test suite, fix any failing tests, then commit the changes with a clear message.';
  prompt.rows = 5;
  wrap.appendChild(prompt);

  const att = makeAttachUI();
  prompt.onpaste = att.onPaste; // paste a screenshot right into the instructions
  const imgRow = el('div', 'row gap');
  imgRow.style.marginTop = '6px';
  att.attachBtn.textContent = '📎 Attach image(s)';
  imgRow.appendChild(att.attachBtn);
  wrap.appendChild(imgRow);
  wrap.appendChild(att.strip);

  wrap.appendChild(el('div', 'lbl', 'Project folder'));
  let chosen = '';
  const folderBtn = el('button', 'in btn-folder', '📁 Choose project folder…');
  const folderLbl = el('div', 'muted small', 'No folder selected');
  folderBtn.onclick = async () => {
    const p = await window.api.pickFolder();
    if (p) {
      chosen = p;
      folderLbl.textContent = p;
    }
  };
  wrap.appendChild(folderBtn);
  wrap.appendChild(folderLbl);

  wrap.appendChild(el('div', 'lbl', 'Model'));
  const model = el('select', 'in');
  [
    ['', 'default (' + (settings.model || 'opus') + ')'],
    ['opus', 'opus'],
    ['sonnet', 'sonnet'],
    ['haiku', 'haiku'],
  ].forEach(([v, l]) => {
    const o = el('option', null, l);
    o.value = v;
    model.appendChild(o);
  });
  wrap.appendChild(model);

  const actions = el('div', 'row end gap');
  actions.style.marginTop = '12px';
  const cancel = el('button', 'btn', 'Cancel');
  cancel.onclick = closeOverlay;
  const save = el('button', 'btn primary', 'Add to queue');
  save.onclick = async () => {
    if (!prompt.value.trim()) return prompt.focus();
    if (!chosen) return toast('Pick a project folder first');
    await window.api.tasksAdd({ title: title.value, prompt: prompt.value, cwd: chosen, model: model.value, attachments: att.payload() });
    closeOverlay();
  };
  actions.appendChild(cancel);
  actions.appendChild(save);
  wrap.appendChild(actions);

  openOverlay(wrap);
  setTimeout(() => prompt.focus(), 30);
}

async function showLog(t) {
  const wrap = el('div', 'form');
  const head = el('div', 'row between');
  head.appendChild(el('h3', null, 'Log — ' + t.title));
  const close = el('button', 'btn', 'Close');
  close.onclick = closeOverlay;
  head.appendChild(close);
  wrap.appendChild(head);
  const pre = el('pre', 'log', 'loading…');
  wrap.appendChild(pre);
  openOverlay(wrap);
  const load = async () => {
    const text = await window.api.logsGet(t.id);
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = text || '(no log yet)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
  await load();
  pre.scrollTop = pre.scrollHeight;
  // While a task is running its log grows — refresh so you see live progress.
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(() => {
    if ($('#overlay').classList.contains('hidden')) {
      clearInterval(logTimer);
      logTimer = null;
      return;
    }
    load();
  }, 1500);
}

function settingsForm() {
  const wrap = el('div', 'form');
  const head = el('div', 'row between');
  head.appendChild(el('h3', null, 'Settings'));
  const close = el('button', 'btn primary', 'Done');
  close.onclick = closeOverlay;
  head.appendChild(close);
  wrap.appendChild(head);

  wrap.appendChild(
    el(
      'div',
      'intro',
      'These are your preferences — everything here is yours to change. Tweak any setting to make Lea work the way you like; changes save automatically.'
    )
  );

  const toggle = (key, label, desc) => {
    const r = el('div', 'setting');
    const left = el('div');
    left.appendChild(el('label', null, label));
    if (desc) left.appendChild(el('div', 'desc', desc));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!settings[key];
    cb.onchange = async () => {
      settings = await window.api.settingsSet({ [key]: cb.checked });
    };
    r.appendChild(left);
    r.appendChild(cb);
    return r;
  };

  const num = (key, label, desc, min, max) => {
    const r = el('div', 'setting');
    const left = el('div');
    left.appendChild(el('label', null, label));
    if (desc) left.appendChild(el('div', 'desc', desc));
    const inp = el('input', 'in');
    inp.type = 'number';
    inp.style.width = '90px';
    if (min != null) inp.min = min;
    if (max != null) inp.max = max;
    inp.value = settings[key] == null ? '' : settings[key];
    inp.onchange = async () => {
      const v = inp.value === '' ? null : Number(inp.value);
      settings = await window.api.settingsSet({ [key]: v });
    };
    r.appendChild(left);
    r.appendChild(inp);
    return r;
  };

  wrap.appendChild(toggle('autoRun', 'Auto-run', 'Run queued tasks automatically'));

  const plat = window.api.platform;
  wrap.appendChild(el('div', 'lbl', 'Sandbox / isolation'));
  const beRow = el('div', 'setting');
  const beLeft = el('div');
  beLeft.appendChild(el('label', null, 'Backend'));
  beLeft.appendChild(el('div', 'desc', 'How each unattended run is contained'));
  const beSel = el('select', 'in');
  beSel.style.width = '180px';
  const autoLabel = plat === 'darwin' ? 'Auto (Seatbelt sandbox)' : 'Auto (no sandbox on this OS)';
  [
    ['auto', autoLabel],
    ['docker', 'Docker (cross-platform)'],
    ['none', 'None — no isolation'],
  ].forEach(([v, l]) => {
    const o = el('option', null, l);
    o.value = v;
    if ((settings.sandboxBackend || 'auto') === v) o.selected = true;
    beSel.appendChild(o);
  });
  beSel.onchange = async () => {
    settings = await window.api.settingsSet({ sandboxBackend: beSel.value });
    renderDanger();
    renderDocker();
  };
  beRow.appendChild(beLeft);
  beRow.appendChild(beSel);
  wrap.appendChild(beRow);

  const danger = el('div');
  wrap.appendChild(danger);
  function effectiveNone() {
    const b = settings.sandboxBackend || 'auto';
    if (b === 'none') return true;
    if (b === 'auto' && plat !== 'darwin') return true;
    return false;
  }
  function renderDanger() {
    danger.innerHTML = '';
    if (effectiveNone()) {
      danger.appendChild(
        el(
          'div',
          'warn',
          '⚠ No OS sandbox is active. Claude will run with full write access to your machine. On Windows/Linux, install Docker and pick the Docker backend for isolation — or only queue tasks you fully trust.'
        )
      );
    }
    if ((settings.sandboxBackend || 'auto') === 'docker') {
      danger.appendChild(
        el(
          'div',
          'warn',
          'ℹ Docker backend needs Docker running, an image with the Claude CLI, and (for subscription auth) a token. See the README “Docker sandbox” section.'
        )
      );
    }
  }
  renderDanger();

  const dockerBox = el('div');
  wrap.appendChild(dockerBox);
  function renderDocker() {
    dockerBox.innerHTML = '';
    if ((settings.sandboxBackend || 'auto') !== 'docker') return;

    const imgRow = el('div', 'setting');
    const il = el('div');
    il.appendChild(el('label', null, 'Docker image'));
    il.appendChild(el('div', 'desc', 'Image that has the Claude CLI'));
    const ii = el('input', 'in');
    ii.style.width = '190px';
    ii.value = settings.dockerImage || 'lea-claude:latest';
    ii.onchange = async () => {
      settings = await window.api.settingsSet({ dockerImage: ii.value });
    };
    imgRow.appendChild(il);
    imgRow.appendChild(ii);
    dockerBox.appendChild(imgRow);

    const tkRow = el('div', 'setting');
    const tl = el('div');
    tl.appendChild(el('label', null, 'Subscription token'));
    tl.appendChild(el('div', 'desc', 'From `claude setup-token` — stored locally'));
    const ti = el('input', 'in');
    ti.type = 'password';
    ti.style.width = '190px';
    ti.placeholder = 'CLAUDE_CODE_OAUTH_TOKEN';
    ti.value = settings.claudeOAuthToken || '';
    ti.onchange = async () => {
      settings = await window.api.settingsSet({ claudeOAuthToken: ti.value });
    };
    tkRow.appendChild(tl);
    tkRow.appendChild(ti);
    dockerBox.appendChild(tkRow);
  }
  renderDocker();

  wrap.appendChild(toggle('keepAwake', 'Keep computer awake', 'Prevent sleep while tasks are pending'));
  wrap.appendChild(toggle('quietHoursEnabled', 'Quiet hours', 'Pause auto-run during a time window'));

  const qh = el('div', 'setting');
  const qhl = el('div');
  qhl.appendChild(el('label', null, 'Quiet window'));
  qhl.appendChild(el('div', 'desc', 'Pause between these times'));
  const times = el('div', 'row gap');
  const mkTime = (key) => {
    const i = el('input', 'in');
    i.type = 'time';
    i.style.width = '110px';
    i.value = settings[key] || '00:00';
    i.onchange = async () => {
      settings = await window.api.settingsSet({ [key]: i.value });
    };
    return i;
  };
  times.appendChild(mkTime('quietStart'));
  times.appendChild(el('span', 'muted', '→'));
  times.appendChild(mkTime('quietEnd'));
  qh.appendChild(qhl);
  qh.appendChild(times);
  wrap.appendChild(qh);

  // default model
  const modelRow = el('div', 'setting');
  const ml = el('div');
  ml.appendChild(el('label', null, 'Model when you’re here'));
  ml.appendChild(el('div', 'desc', 'Used when you’re active (and a task has no model set)'));
  const sel = el('select', 'in');
  sel.style.width = '120px';
  ['opus', 'sonnet', 'haiku'].forEach((m) => {
    const o = el('option', null, m);
    o.value = m;
    if (settings.model === m) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    settings = await window.api.settingsSet({ model: sel.value });
  };
  modelRow.appendChild(ml);
  modelRow.appendChild(sel);
  wrap.appendChild(modelRow);

  // efficient "away" mode
  wrap.appendChild(
    toggle('efficientWhenAway', 'Efficient mode when away', 'Run on a cheaper model while you’re idle/asleep')
  );
  const awayRow = el('div', 'setting');
  const al = el('div');
  al.appendChild(el('label', null, 'Away model'));
  al.appendChild(el('div', 'desc', 'sonnet ≈ 5× cheaper than opus · haiku ≈ 15× (but weaker on code)'));
  const asel = el('select', 'in');
  asel.style.width = '120px';
  ['sonnet', 'haiku', 'opus'].forEach((m) => {
    const o = el('option', null, m);
    o.value = m;
    if ((settings.awayModel || 'sonnet') === m) o.selected = true;
    asel.appendChild(o);
  });
  asel.onchange = async () => {
    settings = await window.api.settingsSet({ awayModel: asel.value });
  };
  awayRow.appendChild(al);
  awayRow.appendChild(asel);
  wrap.appendChild(awayRow);
  wrap.appendChild(num('awayIdleMinutes', 'Away after (min idle)', 'Count you as away after this long with no input', 1, 240));

  wrap.appendChild(num('taskTimeoutMin', 'Task timeout (min)', 'Stop a task that runs too long', 1, 600));
  wrap.appendChild(num('maxRetries', 'Max retries', 'Retries for non-limit errors', 0, 10));
  wrap.appendChild(
    num('tokenBudgetPerBlock', 'Token budget / block', 'Optional: pause after N tokens per 5h window (blank = off)', 0)
  );

  const footer = el('div', 'row between');
  footer.style.marginTop = '12px';
  const openData = el('button', 'btn', 'Open data folder');
  openData.onclick = () => window.api.openDataDir();
  const quit = el('button', 'btn', 'Quit app');
  quit.onclick = () => window.api.quit();
  footer.appendChild(openData);
  footer.appendChild(quit);
  wrap.appendChild(footer);

  openOverlay(wrap);
}

/* ---- bootstrap + live updates ---- */
async function refreshAll() {
  const [u, r, t, s] = await Promise.all([
    window.api.usageGet(),
    window.api.runnerState(),
    window.api.tasksList(),
    window.api.settingsGet(),
  ]);
  usage = u || usage;
  runnerState = r || runnerState;
  tasks = t || [];
  settings = s || {};
  $('#t-autorun').checked = !!runnerState.autoRun;
  renderUsage();
  renderTasks();
}

window.api.onUpdate(({ type, payload }) => {
  if (type === 'activity') {
    const arr = liveActivity[payload.id] || [];
    arr.push(payload.text);
    liveActivity[payload.id] = arr.slice(-3); // keep last 3 as bullets
    const node = document.getElementById('act-' + payload.id);
    if (node) renderActivityInto(node, liveActivity[payload.id]);
    if (chatTaskId === payload.id) renderChat();
    return; // targeted update, no full re-render
  }
  if (type === 'usage') usage = payload;
  else if (type === 'runner') {
    runnerState = payload;
    $('#t-autorun').checked = !!runnerState.autoRun;
  } else if (type === 'tasks') {
    tasks = payload;
    for (const id of Object.keys(liveActivity)) {
      if (!tasks.find((t) => t.id === id && t.status === 'running')) delete liveActivity[id];
    }
  }
  renderUsage();
  if (type === 'tasks' || type === 'runner') renderTasks();
  if (chatTaskId && (type === 'tasks' || type === 'runner')) renderChat();
});

$('#btn-add').onclick = addForm;
$('#btn-settings').onclick = settingsForm;
$('#t-autorun').onchange = async (e) => {
  settings = await window.api.settingsSet({ autoRun: e.target.checked });
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlay();
});

setInterval(renderUsage, 1000); // live countdown
refreshAll();
