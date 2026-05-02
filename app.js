(() => {
  'use strict';

  const TOKEN_KEY = 'cnctd:gh-token';
  const NAME_KEY  = 'cnctd:name';
  const USERID_KEY = 'cnctd:userId';

  const POLL_INTERVAL_MS = 3000;
  const MD_DEBOUNCE_MS = 1500;
  const PRESENCE_INTERVAL_MS = 25_000;
  const PRESENCE_FRESH_MS = 60_000;
  const MD_FILE = 'cnctd.md';
  const MAX_MESSAGES_PER_USER = 200;

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const els = {
    token: $('#view-token'),
    home:  $('#view-home'),
    name:  $('#view-name'),
    app:   $('#view-app'),

    formToken: $('#formToken'),
    tokenInput: $('#tokenInput'),
    tokenError: $('#tokenError'),

    btnCreate: $('#btnCreate'),
    formJoin:  $('#formJoin'),
    joinKey:   $('#joinKey'),
    btnChangeToken: $('#btnChangeToken'),

    formName: $('#formName'),
    nameInput: $('#nameInput'),
    nameSessionId: $('#nameSessionId'),
    btnBack: $('#btnBack'),

    sessionKey: $('#sessionKey'),
    btnCopy: $('#btnCopy'),
    gistLink: $('#gistLink'),
    btnLeave: $('#btnLeave'),
    btnTogglePane: $('#btnTogglePane'),
    statusDot: $('#statusDot'),

    userCount: $('#userCount'),
    userCount2: $('#userCount2'),
    userList: $('#userList'),

    messages: $('#messages'),
    formSend: $('#formSend'),
    messageInput: $('#messageInput'),

    appMain: document.querySelector('.app-main'),
    mdEditor: $('#mdEditor'),
    mdPreview: $('#mdPreview'),
    mdStatus: $('#mdStatus'),
    mdTabs: document.querySelectorAll('.tab'),

    toast: $('#toast'),
  };

  // ---------- State ----------
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    pendingGistId: null,
    gistId: null,
    gistHtmlUrl: '',
    userId: localStorage.getItem(USERID_KEY) || '',
    name: '',
    color: '',

    messages: [],
    knownMessageIds: new Set(),

    md: '',
    mdLocalDirty: false,
    mdRemoteApplyLock: false,
    mdSendTimer: null,
    mdLastEditAt: 0,
    mdLastFetchedContent: '',
    mdInflight: false,

    users: new Map(),

    pollTimer: null,
    presenceTimer: null,
    pollInflight: false,
    pollBackoff: 0,
  };

  if (!state.userId) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    state.userId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(USERID_KEY, state.userId);
  }
  state.color = colorFromSeed(state.userId);

  function colorFromSeed(s) {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360}, 70%, 55%)`;
  }

  // ---------- View routing ----------
  function showView(which) {
    for (const v of ['token', 'home', 'name', 'app']) {
      els[v].classList.toggle('hidden', v !== which);
    }
  }

  function toast(text, ms = 1900) {
    els.toast.textContent = text;
    els.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
  }

  // ---------- Hash routing ----------
  function readHash() {
    const h = location.hash.replace(/^#\/?/, '');
    return h ? h.trim() : null;
  }
  function setHash(id) {
    const target = id ? `#/${id}` : '';
    if (location.hash !== target) history.replaceState({}, '', location.pathname + (target || ''));
  }

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    let body = opts.body;
    if (body && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(`https://api.github.com${path}`, { ...opts, body, headers });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const err = new Error(`GitHub ${r.status}: ${txt.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? null : r.json();
  }

  async function checkToken(token) {
    const r = await fetch('https://api.github.com/user', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!r.ok) throw new Error(`Token check failed: ${r.status}`);
    return r.json();
  }

  function parseGistId(input) {
    const s = (input || '').trim();
    if (!s) return null;
    // accept full URL or raw id (any hex/alnum 5+ chars)
    const m = s.match(/([0-9a-fA-F]{5,})/);
    return m ? m[1] : null;
  }

  // ---------- Files / parsing ----------
  function myMessagesFilename() { return `cnctd-msg-${state.userId}.json`; }
  function presenceFilename(uid) { return `cnctd-presence-${uid}.json`; }
  function myPresenceFilename() { return presenceFilename(state.userId); }

  function parseJsonFile(file) {
    if (!file || typeof file.content !== 'string') return null;
    try { return JSON.parse(file.content); } catch { return null; }
  }

  // ---------- Token view ----------
  els.formToken.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.tokenError.textContent = '';
    const token = els.tokenInput.value.trim();
    if (!token) return;
    try {
      const user = await checkToken(token);
      state.token = token;
      localStorage.setItem(TOKEN_KEY, token);
      toast(`Signed in as ${user.login}`);
      bootRoute();
    } catch (err) {
      els.tokenError.textContent = err.message;
    }
  });

  els.btnChangeToken.addEventListener('click', () => {
    els.tokenInput.value = state.token;
    showView('token');
  });

  // ---------- Home actions ----------
  els.btnCreate.addEventListener('click', async () => {
    if (!state.token) { showView('token'); return; }
    els.btnCreate.disabled = true;
    try {
      const initialMd = '# Welcome to cnctd\n\nThis Markdown file is shared with everyone in the session.\n';
      const gist = await gh('/gists', {
        method: 'POST',
        body: {
          description: 'cnctd session',
          public: false,
          files: {
            [MD_FILE]: { content: initialMd },
            'README.md': { content: '# cnctd session\n\nData store for a [cnctd](https://github.com/) session. Files prefixed `cnctd-msg-*` are per-user message logs; `cnctd-presence-*` track live participants.\n' },
          },
        },
      });
      goToName(gist.id);
    } catch (err) {
      toast('Could not create gist: ' + err.message);
    } finally {
      els.btnCreate.disabled = false;
    }
  });

  els.formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.token) { showView('token'); return; }
    const id = parseGistId(els.joinKey.value);
    if (!id) { toast('Enter a gist id or url'); return; }
    try {
      await gh(`/gists/${id}`); // verify it exists & is reachable
      goToName(id);
    } catch (err) {
      toast('Gist not found or inaccessible');
    }
  });

  function goToName(gistId) {
    state.pendingGistId = gistId;
    setHash(gistId);
    els.nameSessionId.textContent = gistId;
    showView('name');
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) els.nameInput.value = saved;
    setTimeout(() => els.nameInput.focus(), 0);
  }

  els.btnBack.addEventListener('click', () => {
    state.pendingGistId = null;
    setHash(null);
    showView('home');
  });

  els.formName.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim().slice(0, 40);
    if (!name) return;
    localStorage.setItem(NAME_KEY, name);
    state.name = name;
    state.gistId = state.pendingGistId;
    state.pendingGistId = null;
    enterApp();
  });

  // ---------- App ----------
  function setStatus(s) {
    els.statusDot.className = 'status-dot ' + (s === 'online' ? 'online' : s === 'offline' ? 'offline' : '');
    els.statusDot.title = s;
  }

  function leave() {
    clearTimeout(state.pollTimer); state.pollTimer = null;
    clearInterval(state.presenceTimer); state.presenceTimer = null;
    // best-effort presence removal
    if (state.gistId && state.token) {
      try {
        navigator.sendBeacon ?
          // sendBeacon won't allow auth headers; skip and use fire-and-forget fetch
          null : null;
        gh(`/gists/${state.gistId}`, {
          method: 'PATCH',
          body: { files: { [myPresenceFilename()]: null } },
        }).catch(() => {});
      } catch {}
    }
    state.gistId = null;
    state.users.clear();
    state.messages = [];
    state.knownMessageIds.clear();
    els.userList.innerHTML = '';
    els.messages.innerHTML = '';
    els.mdEditor.value = '';
    els.mdPreview.innerHTML = '';
    setHash(null);
    showView('home');
  }
  els.btnLeave.addEventListener('click', leave);

  els.btnCopy.addEventListener('click', async () => {
    if (!state.gistId) return;
    const link = `${location.origin}${location.pathname}#/${state.gistId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Link copied'); }
      catch { toast(link); }
      document.body.removeChild(ta);
    }
  });

  els.btnTogglePane.addEventListener('click', () => {
    els.appMain.classList.toggle('no-md');
  });

  async function enterApp() {
    showView('app');
    setStatus('connecting');
    els.sessionKey.textContent = state.gistId;
    els.gistLink.href = `https://gist.github.com/${state.gistId}`;

    try {
      // Initial fetch — establish baseline
      await pollOnce(true);
      setStatus('online');
      // Announce presence
      await writePresence();
      // Schedule
      state.pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
      state.presenceTimer = setInterval(writePresence, PRESENCE_INTERVAL_MS);
      setTimeout(() => els.messageInput.focus(), 50);
    } catch (err) {
      setStatus('offline');
      toast('Could not load gist: ' + err.message);
      leave();
    }
  }

  async function pollLoop() {
    try {
      await pollOnce(false);
      setStatus('online');
      state.pollBackoff = 0;
    } catch (err) {
      setStatus('offline');
      // back off on errors (rate limits etc.)
      state.pollBackoff = Math.min((state.pollBackoff || 1000) * 2, 30_000);
    }
    if (!state.gistId) return; // user left
    const next = state.pollBackoff > 0 ? state.pollBackoff : POLL_INTERVAL_MS;
    state.pollTimer = setTimeout(pollLoop, next);
  }

  async function pollOnce(initial) {
    if (state.pollInflight) return;
    state.pollInflight = true;
    try {
      const gist = await gh(`/gists/${state.gistId}`);
      state.gistHtmlUrl = gist.html_url || '';
      els.gistLink.href = state.gistHtmlUrl || `https://gist.github.com/${state.gistId}`;

      // Markdown
      const mdFile = gist.files[MD_FILE];
      if (mdFile && typeof mdFile.content === 'string') {
        const remoteMd = mdFile.content;
        if (initial) {
          state.md = remoteMd;
          state.mdLastFetchedContent = remoteMd;
          applyRemoteMdToEditor(remoteMd);
        } else if (remoteMd !== state.mdLastFetchedContent) {
          state.mdLastFetchedContent = remoteMd;
          if (!state.mdLocalDirty) {
            state.md = remoteMd;
            applyRemoteMdToEditor(remoteMd);
            flashMdStatus('updated remotely');
          } else {
            // local edits pending; defer
          }
        }
      }

      // Messages from all message files
      const newMessages = [];
      for (const [filename, file] of Object.entries(gist.files)) {
        if (!filename.startsWith('cnctd-msg-')) continue;
        const arr = parseJsonFile(file);
        if (!Array.isArray(arr)) continue;
        for (const m of arr) {
          if (!m || !m.id) continue;
          if (state.knownMessageIds.has(m.id)) continue;
          state.knownMessageIds.add(m.id);
          state.messages.push(m);
          newMessages.push(m);
        }
      }
      newMessages.sort((a, b) => a.ts - b.ts);
      for (const m of newMessages) appendMessage(m, !initial);
      if (initial) {
        state.messages.sort((a, b) => a.ts - b.ts);
        // render in order
        els.messages.innerHTML = '';
        for (const m of state.messages.slice(-200)) appendMessage(m, false);
        scrollMessagesToBottom();
      }

      // Presence
      const now = Date.now();
      const seen = new Map();
      for (const [filename, file] of Object.entries(gist.files)) {
        if (!filename.startsWith('cnctd-presence-')) continue;
        const data = parseJsonFile(file);
        if (!data || !data.userId || !data.name) continue;
        if (typeof data.lastSeen !== 'number') continue;
        if (now - data.lastSeen > PRESENCE_FRESH_MS) continue;
        seen.set(data.userId, {
          id: data.userId,
          name: String(data.name).slice(0, 40),
          color: data.color || colorFromSeed(data.userId),
          lastSeen: data.lastSeen,
        });
      }
      // Always include self
      seen.set(state.userId, { id: state.userId, name: state.name, color: state.color, lastSeen: now });
      state.users = seen;
      renderUsers();
    } finally {
      state.pollInflight = false;
    }
  }

  function applyRemoteMdToEditor(content) {
    const ed = els.mdEditor;
    const had = document.activeElement === ed;
    const start = ed.selectionStart, end = ed.selectionEnd;
    state.mdRemoteApplyLock = true;
    ed.value = content;
    state.mdRemoteApplyLock = false;
    if (had) {
      const len = ed.value.length;
      try { ed.setSelectionRange(Math.min(start, len), Math.min(end, len)); } catch {}
    }
    renderPreview();
  }

  // ---------- Sending messages ----------
  async function sendChat() {
    const text = els.messageInput.value.trim();
    if (!text || !state.gistId) return;
    const m = {
      id: cryptoId(),
      userId: state.userId,
      name: state.name,
      color: state.color,
      text,
      ts: Date.now(),
    };
    state.messages.push(m);
    state.knownMessageIds.add(m.id);
    appendMessage(m, true);
    els.messageInput.value = '';
    autosize(els.messageInput);

    try {
      const myMsgs = state.messages.filter(x => x.userId === state.userId).slice(-MAX_MESSAGES_PER_USER);
      await gh(`/gists/${state.gistId}`, {
        method: 'PATCH',
        body: { files: { [myMessagesFilename()]: { content: JSON.stringify(myMsgs) } } },
      });
    } catch (err) {
      toast('Send failed: ' + err.message);
    }
  }

  function cryptoId() {
    const b = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  els.formSend.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  els.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  els.messageInput.addEventListener('input', () => autosize(els.messageInput));
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }

  // ---------- Markdown editing ----------
  els.mdEditor.addEventListener('input', () => {
    if (state.mdRemoteApplyLock) return;
    state.mdLocalDirty = true;
    state.mdLastEditAt = Date.now();
    state.md = els.mdEditor.value;
    flashMdStatus('typing…');
    scheduleMdSync();
    renderPreview();
  });

  function scheduleMdSync() {
    clearTimeout(state.mdSendTimer);
    state.mdSendTimer = setTimeout(syncMd, MD_DEBOUNCE_MS);
  }

  async function syncMd() {
    if (!state.mdLocalDirty || !state.gistId) return;
    if (state.mdInflight) { scheduleMdSync(); return; }
    state.mdInflight = true;
    state.mdLocalDirty = false;
    const content = els.mdEditor.value;
    flashMdStatus('saving…');
    try {
      await gh(`/gists/${state.gistId}`, {
        method: 'PATCH',
        body: { files: { [MD_FILE]: { content } } },
      });
      state.mdLastFetchedContent = content;
      flashMdStatus('saved');
    } catch (err) {
      state.mdLocalDirty = true; // retry next change
      flashMdStatus('save failed');
    } finally {
      state.mdInflight = false;
    }
  }

  function flashMdStatus(text) {
    els.mdStatus.textContent = text;
    clearTimeout(flashMdStatus._t);
    flashMdStatus._t = setTimeout(() => { els.mdStatus.textContent = ''; }, 2000);
  }

  els.mdTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      els.mdTabs.forEach(t => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');
      const which = tab.dataset.tab;
      els.mdEditor.classList.toggle('hidden', which !== 'edit');
      els.mdPreview.classList.toggle('hidden', which !== 'preview');
      if (which === 'preview') renderPreview();
    });
  });

  let previewTimer = null;
  function renderPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!window.marked) return;
      try {
        marked.use({ breaks: true, gfm: true });
        els.mdPreview.innerHTML = marked.parse(els.mdEditor.value || '');
      } catch {}
    }, 80);
  }

  // ---------- Presence ----------
  async function writePresence() {
    if (!state.gistId) return;
    const data = {
      userId: state.userId,
      name: state.name,
      color: state.color,
      lastSeen: Date.now(),
    };
    try {
      await gh(`/gists/${state.gistId}`, {
        method: 'PATCH',
        body: { files: { [myPresenceFilename()]: { content: JSON.stringify(data) } } },
      });
    } catch {}
  }

  // ---------- Rendering ----------
  function avatarFor(user) {
    const initials = (user.name || '?').trim().split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() || '?';
    const a = document.createElement('span');
    a.className = 'avatar';
    a.style.background = user.color || '#888';
    a.textContent = initials;
    return a;
  }

  function renderUsers() {
    els.userList.innerHTML = '';
    const arr = [...state.users.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const u of arr) {
      const li = document.createElement('li');
      if (u.id === state.userId) li.classList.add('you');
      li.appendChild(avatarFor(u));
      const span = document.createElement('span');
      span.className = 'user-name';
      span.textContent = u.name + (u.id === state.userId ? ' (you)' : '');
      li.appendChild(span);
      els.userList.appendChild(li);
    }
    els.userCount.textContent = state.users.size;
    els.userCount2.textContent = state.users.size;
  }

  function appendMessage(m, scroll) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.appendChild(avatarFor({ name: m.name, color: m.color }));
    const body = document.createElement('div');
    body.className = 'msg-body';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    name.style.color = m.color;
    meta.appendChild(name);
    const t = document.createElement('span');
    t.textContent = formatTime(m.ts);
    meta.appendChild(t);
    body.appendChild(meta);
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = m.text;
    body.appendChild(text);
    wrap.appendChild(body);
    els.messages.appendChild(wrap);
    if (scroll) scrollMessagesToBottom();
  }

  function scrollMessagesToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Boot ----------
  function bootRoute() {
    if (!state.token) { showView('token'); return; }
    const fromHash = readHash();
    if (fromHash) {
      const id = parseGistId(fromHash);
      if (id) { goToName(id); return; }
    }
    showView('home');
  }

  // Best-effort cleanup on unload
  window.addEventListener('beforeunload', () => {
    if (state.gistId && state.token) {
      // Synchronous-ish removal isn't possible with fetch; skip blocking.
      try {
        // Remove our presence file (fire-and-forget)
        fetch(`https://api.github.com/gists/${state.gistId}`, {
          method: 'PATCH',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${state.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: { [myPresenceFilename()]: null } }),
          keepalive: true,
        });
      } catch {}
    }
  });

  bootRoute();
})();
