(() => {
  'use strict';

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const els = {
    home: $('#view-home'),
    name: $('#view-name'),
    app:  $('#view-app'),

    btnCreate: $('#btnCreate'),
    formJoin:  $('#formJoin'),
    joinKey:   $('#joinKey'),

    formName: $('#formName'),
    nameInput: $('#nameInput'),
    nameSessionId: $('#nameSessionId'),
    btnBack: $('#btnBack'),

    sessionKey: $('#sessionKey'),
    btnCopy: $('#btnCopy'),
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
    sessionId: null,
    pendingSessionId: null,
    name: null,
    you: null,
    users: new Map(),
    ws: null,
    wsRetries: 0,
    mdVersion: 0,
    mdLocalDirty: false,
    mdRemoteApplyLock: false,
    mdSendTimer: null,
    mdLastEditAt: 0,
    editingUsers: new Map(), // userId -> timeout
  };

  // ---------- View routing ----------
  function showView(which) {
    for (const v of ['home', 'name', 'app']) {
      els[v].classList.toggle('hidden', v !== which);
    }
  }

  function toast(text, ms = 1800) {
    els.toast.textContent = text;
    els.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.add('hidden'), ms);
  }

  // ---------- Routing via URL ----------
  function readUrlSession() {
    const m = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  }

  function setUrlSession(id) {
    const target = id ? `/s/${id}` : '/';
    if (location.pathname !== target) history.replaceState({}, '', target);
  }

  // ---------- Home actions ----------
  els.btnCreate.addEventListener('click', async () => {
    els.btnCreate.disabled = true;
    try {
      const res = await fetch('/api/sessions', { method: 'POST' });
      if (!res.ok) throw new Error('create failed');
      const data = await res.json();
      goToName(data.id);
    } catch (e) {
      toast('Could not create session');
    } finally {
      els.btnCreate.disabled = false;
    }
  });

  els.formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = els.joinKey.value.trim();
    if (!id) return;
    try {
      const res = await fetch('/api/sessions/' + encodeURIComponent(id));
      if (!res.ok) { toast('Session not found'); return; }
      goToName(id);
    } catch {
      toast('Network error');
    }
  });

  function goToName(sessionId) {
    state.pendingSessionId = sessionId;
    setUrlSession(sessionId);
    els.nameSessionId.textContent = sessionId;
    showView('name');
    const saved = localStorage.getItem('cnctd:name');
    if (saved) els.nameInput.value = saved;
    setTimeout(() => els.nameInput.focus(), 0);
  }

  els.btnBack.addEventListener('click', () => {
    state.pendingSessionId = null;
    setUrlSession(null);
    showView('home');
  });

  els.formName.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim().slice(0, 40);
    if (!name) return;
    localStorage.setItem('cnctd:name', name);
    state.name = name;
    state.sessionId = state.pendingSessionId;
    state.pendingSessionId = null;
    connect();
  });

  // ---------- App connection ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws?session=${encodeURIComponent(state.sessionId)}&name=${encodeURIComponent(state.name)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    setStatus('connecting');

    ws.addEventListener('open', () => {
      state.wsRetries = 0;
      setStatus('online');
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', (e) => {
      setStatus('offline');
      state.ws = null;
      if (e.code === 1008 || e.code === 4404 || e.code === 4503) {
        toast('Disconnected');
        leave(false);
        return;
      }
      // auto-reconnect
      if (state.sessionId && state.name) {
        const delay = Math.min(1000 * 2 ** state.wsRetries, 15000);
        state.wsRetries++;
        setTimeout(() => { if (state.sessionId) connect(); }, delay);
      }
    });

    ws.addEventListener('error', () => {
      // close handler will reconnect
    });
  }

  function setStatus(s) {
    els.statusDot.className = 'status-dot ' + (s === 'online' ? 'online' : s === 'offline' ? 'offline' : '');
    els.statusDot.title = s;
  }

  function leave(updateUrl = true) {
    if (state.ws) try { state.ws.close(); } catch {}
    state.ws = null;
    state.sessionId = null;
    state.users.clear();
    els.userList.innerHTML = '';
    els.messages.innerHTML = '';
    els.mdEditor.value = '';
    els.mdPreview.innerHTML = '';
    if (updateUrl) setUrlSession(null);
    showView('home');
  }

  els.btnLeave.addEventListener('click', () => leave());

  els.btnCopy.addEventListener('click', async () => {
    if (!state.sessionId) return;
    const link = `${location.origin}/s/${state.sessionId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Link copied'); } catch { toast(link); }
      document.body.removeChild(ta);
    }
  });

  els.btnTogglePane.addEventListener('click', () => {
    els.appMain.classList.toggle('no-md');
  });

  // ---------- Server messages ----------
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'init': onInit(msg); break;
      case 'message': onMessage(msg.message); break;
      case 'user_joined': onUserJoined(msg); break;
      case 'user_left': onUserLeft(msg); break;
      case 'md_update': onRemoteMd(msg); break;
      case 'md_cursor': onMdCursor(msg); break;
    }
  }

  function onInit(msg) {
    state.you = msg.you;
    state.users.clear();
    msg.users.forEach(u => state.users.set(u.id, u));
    renderUsers();
    els.sessionKey.textContent = msg.sessionId;
    els.userCount.textContent = state.users.size;
    els.userCount2.textContent = state.users.size;

    els.messages.innerHTML = '';
    msg.messages.forEach(m => appendMessage(m, false));
    scrollMessagesToBottom();

    state.mdVersion = msg.markdownVersion;
    state.mdRemoteApplyLock = true;
    els.mdEditor.value = msg.markdown;
    state.mdRemoteApplyLock = false;
    renderPreview();

    showView('app');
    setTimeout(() => els.messageInput.focus(), 50);
  }

  function onMessage(m) {
    appendMessage(m, true);
  }

  function onUserJoined(msg) {
    state.users.set(msg.user.id, msg.user);
    renderUsers();
    appendSystem(`${msg.user.name} joined`);
    if (typeof msg.userCount === 'number') updateUserCount(msg.userCount);
  }

  function onUserLeft(msg) {
    const u = state.users.get(msg.userId);
    state.users.delete(msg.userId);
    if (u) appendSystem(`${u.name} left`);
    renderUsers();
    if (typeof msg.userCount === 'number') updateUserCount(msg.userCount);
  }

  function updateUserCount(n) {
    els.userCount.textContent = n;
    els.userCount2.textContent = n;
  }

  function onRemoteMd(msg) {
    state.mdVersion = msg.version;
    // Preserve local cursor selection if possible
    const ed = els.mdEditor;
    const had = document.activeElement === ed;
    const start = ed.selectionStart, end = ed.selectionEnd;
    const oldLen = ed.value.length;

    state.mdRemoteApplyLock = true;
    ed.value = msg.content;
    state.mdRemoteApplyLock = false;

    if (had) {
      const newLen = ed.value.length;
      const delta = newLen - oldLen;
      // Adjust cursor only if our position likely sits past changes
      const ns = Math.min(newLen, Math.max(0, start + (delta > 0 ? 0 : 0)));
      const ne = Math.min(newLen, Math.max(0, end + (delta > 0 ? 0 : 0)));
      try { ed.setSelectionRange(ns, ne); } catch {}
    }
    flashMdStatus(msg.by ? `updated by ${msg.by.name}` : 'updated');
    renderPreview();
  }

  function onMdCursor(msg) {
    if (!msg.editing) {
      state.editingUsers.delete(msg.userId);
    } else {
      // mark briefly; expire after 4s of no follow-up
      clearTimeout(state.editingUsers.get(msg.userId));
      const t = setTimeout(() => {
        state.editingUsers.delete(msg.userId);
        renderUsers();
      }, 4000);
      state.editingUsers.set(msg.userId, t);
    }
    renderUsers();
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
      if (state.you && u.id === state.you.id) li.classList.add('you');
      li.appendChild(avatarFor(u));
      const span = document.createElement('span');
      span.className = 'user-name';
      span.textContent = u.name + (state.you && u.id === state.you.id ? ' (you)' : '');
      li.appendChild(span);
      if (state.editingUsers.has(u.id)) {
        const m = document.createElement('span');
        m.className = 'editing-mark';
        m.textContent = 'editing';
        li.appendChild(m);
      }
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

  function appendSystem(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg system';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const t = document.createElement('div');
    t.className = 'msg-text';
    t.textContent = text;
    body.appendChild(t);
    wrap.appendChild(body);
    els.messages.appendChild(wrap);
    scrollMessagesToBottom();
  }

  function scrollMessagesToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function flashMdStatus(text) {
    els.mdStatus.textContent = text;
    clearTimeout(flashMdStatus._t);
    flashMdStatus._t = setTimeout(() => { els.mdStatus.textContent = ''; }, 2000);
  }

  // ---------- Sending ----------
  function sendChat() {
    const text = els.messageInput.value.trim();
    if (!text || !state.ws || state.ws.readyState !== 1) return;
    state.ws.send(JSON.stringify({ type: 'message', text }));
    els.messageInput.value = '';
    autosize(els.messageInput);
  }

  els.formSend.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });

  els.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  els.messageInput.addEventListener('input', () => autosize(els.messageInput));

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }

  // ---------- Markdown editing ----------
  let cursorTimer = null;

  els.mdEditor.addEventListener('input', () => {
    if (state.mdRemoteApplyLock) return;
    state.mdLocalDirty = true;
    state.mdLastEditAt = Date.now();
    scheduleMdSend();
    sendCursorEditing(true);
    renderPreview();
  });

  els.mdEditor.addEventListener('blur', () => sendCursorEditing(false));

  function sendCursorEditing(editing) {
    if (!state.ws || state.ws.readyState !== 1) return;
    clearTimeout(cursorTimer);
    if (editing) {
      state.ws.send(JSON.stringify({ type: 'md_cursor', editing: true }));
      cursorTimer = setTimeout(() => sendCursorEditing(false), 3000);
    } else {
      state.ws.send(JSON.stringify({ type: 'md_cursor', editing: false }));
    }
  }

  function scheduleMdSend() {
    clearTimeout(state.mdSendTimer);
    state.mdSendTimer = setTimeout(flushMdSend, 350);
  }

  function flushMdSend() {
    if (!state.mdLocalDirty) return;
    if (!state.ws || state.ws.readyState !== 1) return;
    state.mdLocalDirty = false;
    state.ws.send(JSON.stringify({
      type: 'md_update',
      content: els.mdEditor.value,
      baseVersion: state.mdVersion,
    }));
  }

  // Markdown preview tabs
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
        const html = marked.parse(els.mdEditor.value || '');
        els.mdPreview.innerHTML = html;
      } catch { /* noop */ }
    }, 80);
  }

  // ---------- Bootstrap ----------
  function boot() {
    showView('home');
    const fromUrl = readUrlSession();
    if (fromUrl) {
      // Verify and route to name entry
      fetch('/api/sessions/' + encodeURIComponent(fromUrl)).then(r => {
        if (r.ok) goToName(fromUrl);
        else { setUrlSession(null); showView('home'); }
      }).catch(() => showView('home'));
    }
  }

  // Flush any pending md update before close
  window.addEventListener('beforeunload', () => {
    if (state.mdLocalDirty) flushMdSend();
  });

  boot();
})();
