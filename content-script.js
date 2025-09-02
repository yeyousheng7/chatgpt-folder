(() => {
  'use strict';

  const STORAGE_KEY = 'cgpt_folders_v1';
  const FOLDER_COLLAPSE_THRESHOLD = 8;
  const HOSTS = ['chatgpt.com', 'chat.openai.com'];
  const ENABLE_NATIVE_MENU_INJECTION = false; // Disable brittle native menu path by default
  if (!HOSTS.includes(location.hostname)) return;

  // State
  let state = { folders: [], assignments: {} }; // assignments: { [chatId]: string[] }
  let mounted = false;
  let sidebarObserver = null;
  let chatMenuObserver = null;
  let suppressObserver = 0;
  let refreshQueued = false;
  let lastInteractedChat = null;
  let lastInteractedChatId = null;
  let lastMouse = { x: 0, y: 0 };
  let menuHintChatId = null;
  let menuHintTs = 0;
  let headerAddMounted = false;
  // Navigation cooldown to avoid heavy re-renders during first SPA navigation
  let navCooldownUntil = 0;

;(function(){
  try {
    if (window.__ccNavGuardApplied) return;
    window.__ccNavGuardApplied = true;

    var lastUrl = location.href;
    var lastTs = 0;
    var throttleMs = 800;

    function norm(href){
      try { return new URL(href, location.href).href; } catch (_) { return href + ""; }
    }

    function shouldSkip(url){
      var now = Date.now();
      if (url === lastUrl && (now - lastTs) < throttleMs) return true;
      lastUrl = url;
      lastTs = now;
      return false;
    }

    var origPush = history.pushState;
    var origReplace = history.replaceState;

    if (typeof origPush === 'function') {
      history.pushState = function(state, title, url){
        var target = url == null ? location.href : norm(url);
        if (shouldSkip(target)) return;
        return origPush.apply(this, arguments);
      };
    }

    if (typeof origReplace === 'function') {
      history.replaceState = function(state, title, url){
        var target = url == null ? location.href : norm(url);
        if (shouldSkip(target)) return;
        return origReplace.apply(this, arguments);
      };
    }

    if (!window.__ccClickSingleFlight) {
      window.__ccClickSingleFlight = true;
      var navigating = false;
      window.addEventListener('click', function(ev){
        // Only act for primary button without modifiers
        if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        var el = ev.target && (ev.target.closest ? ev.target.closest('a,[role="link"],[data-href]') : null);
        if (!el) return;
        if (navigating) {
          ev.stopImmediatePropagation();
          ev.stopPropagation();
          ev.preventDefault();
          return;
        }
        navigating = true;
        setTimeout(function(){ navigating = false; }, throttleMs);
      }, true);
    }
  } catch (_) { /* no-op to avoid breaking page */ }
})();

  function startNavCooldown(ms = 1200) {
    try { navCooldownUntil = Date.now() + Math.max(200, ms|0); } catch { navCooldownUntil = Date.now() + 1200; }
  }

  // Storage helpers
  const storage = {
    async get() {
      try {
        const data = await chrome.storage.sync.get(STORAGE_KEY);
        return data[STORAGE_KEY] || { folders: [], assignments: {} };
      } catch (e) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          return raw ? JSON.parse(raw) : { folders: [], assignments: {} };
        } catch {
          return { folders: [], assignments: {} };
        }
      }
    },
    async set(value) {
      try {
        await chrome.storage.sync.set({ [STORAGE_KEY]: value });
      } catch (e) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      }
    }
  };

  // --- Folder depth helpers and constraints ---
  function getFolderById(id) {
    return state.folders.find(f => f.id === id) || null;
  }

  // Zero-based depth: 0=root, 1=child, 2=grandchild...
  function getFolderDepthZeroBased(id) {
    let depth = 0;
    const seen = new Set();
    let cur = getFolderById(id);
    while (cur && cur.parentId) {
      if (seen.has(cur.id)) break; // safety against corrupt cycles
      seen.add(cur.id);
      const parent = getFolderById(cur.parentId);
      if (!parent) break;
      depth++;
      cur = parent;
    }
    return depth;
  }

  // Assert that no folder exceeds max depth (inclusive of root level count)
  // Example: assertMaxDepth(2) means root+one-child level only.
  function assertMaxDepth(maxLevelsInclRoot = 2) {
    const violations = [];
    for (const f of state.folders) {
      const zeroBased = getFolderDepthZeroBased(f.id);
      const levelsInclRoot = zeroBased + 1;
      if (levelsInclRoot > maxLevelsInclRoot) {
        violations.push({ id: f.id, depth: levelsInclRoot });
      }
    }
    return { ok: violations.length === 0, violations };
  }

  // Enforce two-level constraint by flattening deeper folders under their top-most root
  function enforceTwoLevelConstraint() {
    let changed = 0;
    const idToFolder = Object.fromEntries(state.folders.map(f => [f.id, f]));
    function rootAncestorId(id) {
      let cur = idToFolder[id];
      const seen = new Set();
      while (cur && cur.parentId) {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        const parent = idToFolder[cur.parentId];
        if (!parent) break;
        if (!parent.parentId) return parent.id; // parent is root
        cur = parent;
      }
      return cur ? cur.id : null; // already root or invalid
    }
    for (const f of state.folders) {
      const zeroBased = getFolderDepthZeroBased(f.id);
      if (zeroBased >= 2) { // deeper than child
        const rid = rootAncestorId(f.id);
        if (rid && f.parentId !== rid) {
          f.parentId = rid;
          changed++;
        } else if (!rid) {
          // If cannot determine, fallback to root
          f.parentId = null;
          changed++;
        }
      }
    }
    return changed;
  }

  // --- Collapse/expand animation helpers ---
  const FOLDER_ANIM_MS = 180;
  const FOLDER_DRAG_HOVER_EXPAND_DELAY = 150;

  function setItemExpandedAnimated(itemEl, expand) {
    const chatsEl = itemEl.querySelector('.cgpt-folder-chats');
    if (!chatsEl) return Promise.resolve();
    if (itemEl._animating) return Promise.resolve();
    itemEl._animating = true;
    return new Promise((resolve) => {
      let cleaned = false;
      const finish = () => {
        if (cleaned) return;
        cleaned = true;
        chatsEl.removeEventListener('transitionend', onEnd);
        clearTimeout(tid);
        try {
          if (!expand) {
            chatsEl.style.display = 'none';
          } else {
            chatsEl.style.display = 'flex';
          }
        } catch {}
        itemEl._animating = false;
        resolve();
      };
      const onEnd = (e) => { if (e.target === chatsEl) finish(); };
      const tid = setTimeout(finish, FOLDER_ANIM_MS + 80);
      try { chatsEl.style.overflow = 'hidden'; chatsEl.style.transition = `max-height ${FOLDER_ANIM_MS}ms ease, opacity ${FOLDER_ANIM_MS}ms ease`; } catch {}
      if (expand) {
        try { itemEl.classList.add('expanded'); chatsEl.style.display = 'flex'; chatsEl.style.opacity = '0'; chatsEl.style.maxHeight = '0px'; } catch {}
        const h = (chatsEl.scrollHeight || 6);
        requestAnimationFrame(() => {
          try { chatsEl.addEventListener('transitionend', onEnd); chatsEl.style.opacity = '1'; chatsEl.style.maxHeight = h + 'px'; } catch {}
        });
      } else {
        try { itemEl.classList.remove('expanded'); } catch {}
        const h = (chatsEl.scrollHeight || 6);
        try { chatsEl.style.display = 'flex'; chatsEl.style.opacity = '1'; chatsEl.style.maxHeight = h + 'px'; } catch {}
        requestAnimationFrame(() => {
          try { chatsEl.addEventListener('transitionend', onEnd); chatsEl.style.opacity = '0'; chatsEl.style.maxHeight = '0px'; } catch {}
        });
      }
    }).finally(() => {
      try { chatsEl.style.transition = ''; chatsEl.style.maxHeight = ''; chatsEl.style.opacity = ''; } catch {}
    });
  }

  async function collapseSubtreeThenSelf(itemEl) {
    // Collapse deepest expanded descendants first, then the item itself
    const selfChats = itemEl.querySelector('.cgpt-folder-chats');
    try {
      const preH = (selfChats?.scrollHeight || 0);
      selfChats.style.overflow = 'hidden';
      selfChats.style.display = 'flex';
      selfChats.style.maxHeight = (preH > 0 ? preH : 6) + 'px';
    } catch {}
    const descendants = Array.from(itemEl.querySelectorAll('.cgpt-folder-item.expanded'))
      .filter(el => el !== itemEl);
    const depthOf = (el) => {
      let d = 0, cur = el;
      while (cur && cur !== itemEl) { if (cur.classList?.contains('cgpt-folder-item')) d++; cur = cur.parentElement; }
      return d;
    };
    descendants.sort((a,b) => depthOf(b) - depthOf(a));
    for (const el of descendants) {
      await setItemExpandedAnimated(el, false);
    }
    await setItemExpandedAnimated(itemEl, false);
  }

  function uid(prefix = 'f') {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function toast(msg) {
    let t = document.getElementById('cgpt-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cgpt-toast';
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => { t.style.display = 'none'; }, 1800);
  }

  // DOM helpers
  function findAnyChatLink() {
    return document.querySelector('a[href^="/c/"]');
  }

  function findFirstChatRowAndParent() {
    const first = findAnyChatLink();
    if (!first) return null;
    const row = first.closest('li, [role="listitem"], div[role="option"], div[role="treeitem"], div[data-testid*="conversation"], a[href^="/c/"]');
    if (!row) return null;
    let container = row.parentElement;
    for (let i = 0; i < 8 && container; i++) {
      const count = container.querySelectorAll('a[href^="/c/"]').length;
      const parentCount = container.parentElement?.querySelectorAll?.('a[href^="/c/"]').length || 0;
      if (count >= 2 && parentCount > count) break;
      if (count < 2) container = container.parentElement; else break;
    }
    return container ? { container, row } : null;
  }

  function createPanel() {
    const existing = document.getElementById('cgpt-folder-panel');
    if (existing) return existing;
    const panel = document.createElement('section');
    panel.id = 'cgpt-folder-panel';
    panel.innerHTML = `
      <h3>
        <span>Folders</span>
        <span class="cgpt-folder-actions">
          <button class="cgpt-icon-btn" id="cgpt-add-folder" title="Create folder">＋</button>
        </span>
      </h3>
      <div id="cgpt-folder-list" aria-label="ChatGPT Folders"></div>
    `;
    return panel;
  }

  function mountPanel() {
    if (mounted) return;
    const panel = createPanel();
    const listPair = findFirstChatRowAndParent();
    if (!listPair) return; // wait until sidebar exists
    runWithoutObserving(() => {
      listPair.container.insertBefore(panel, listPair.row);
      mounted = true;
      bindPanelEvents();
      renderFolders();
    });
  }

  function bindPanelEvents() {
    const addBtn = document.getElementById('cgpt-add-folder');
    addBtn?.addEventListener('click', async () => {
      const name = await openNamePromptModal({ title: '新建文件夹', placeholder: '输入文件夹名称', initial: '' });
      if (!name) return;
      state.folders.push({ id: uid('folder'), name: name.trim(), createdAt: Date.now() });
      await storage.set(state);
      renderFolders();
    });
    // When navigating via our panel links, briefly suppress sidebar refresh thrash
    try {
      const panel = document.getElementById('cgpt-folder-panel');
      panel?.addEventListener('click', (e) => {
        const t = e.target;
        const a = (t && t.closest) ? t.closest('a[href^="/c/"]') : null;
        if (a && panel.contains(a)) {
          startNavCooldown(1400);
        }
      }, true);
    } catch {}
  }

  function saveAndRender() {
    storage.set(state);
    renderFolders();
  }

  function renderFolders() {
    const list = document.getElementById('cgpt-folder-list');
    if (!list) return;
    // Preserve which folders are expanded before re-rendering
    const expandedIds = new Set(
      Array.from(list.querySelectorAll('.cgpt-folder-item.expanded'))
        .map(el => el.getAttribute('data-folder-id'))
        .filter(Boolean)
    );
    // Also auto-expand the path to the currently open chat, so refresh keeps it visible
    const currentChatId = getCurrentChatIdFromUrl();
    const expandByActive = new Set();
    function addAncestorsIncludingSelf(fid) {
      let cur = state.folders.find(f => f.id === fid);
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        expandByActive.add(cur.id);
        guard.add(cur.id);
        if (!cur.parentId) break;
        cur = state.folders.find(f => f.id === cur.parentId);
      }
    }
    if (currentChatId && state.assignments[currentChatId]) {
      for (const fid of state.assignments[currentChatId]) addAncestorsIncludingSelf(fid);
    }
    runWithoutObserving(() => { list.innerHTML = ''; });
    const folders = state.folders;
    runWithoutObserving(() => {
      list.style.maxHeight = folders.length > FOLDER_COLLAPSE_THRESHOLD ? '220px' : 'none';
      list.style.overflowY = folders.length > FOLDER_COLLAPSE_THRESHOLD ? 'auto' : 'visible';
    });

    // --- Nested folders helpers ---
    function getFolderChildren(id) { return state.folders.filter(f => (f.parentId || null) === id); }
    function renderFolderRecursive(folder, depth) {
      const indent = Math.max(0, depth) * 12;
      const item = document.createElement('div');
      item.className = 'cgpt-folder-item';
      item.dataset.folderId = folder.id;
      item.innerHTML = `
        <div class="cgpt-folder-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div class="name" title="拖动对话到此" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:${indent}px;">${escapeHtml(folder.name)}</div>
          <div class="actions" style="flex:0 0 auto;white-space:nowrap;"></div>
        </div>
        <div class="cgpt-folder-chats"></div>
      `;
      const actions = item.querySelector('.actions');
      // Toggle
      const tBtn = document.createElement('button'); tBtn.className = 'cgpt-icon-btn'; tBtn.setAttribute('data-action','toggle'); tBtn.innerHTML = svgChevronDown(); actions.appendChild(tBtn);
      // Add child
      const addBtn = document.createElement('button'); addBtn.className = 'cgpt-icon-btn'; addBtn.setAttribute('data-action','add-child'); addBtn.title = '新建子文件夹'; addBtn.setAttribute('aria-label','新建子文件夹'); addBtn.innerHTML = svgFolderPlus(); actions.appendChild(addBtn);
      if (depth >= 1) { try { addBtn.style.opacity = '0.6'; addBtn.title = '仅支持父/子两级'; } catch {} }
      // Rename
      const rBtn = document.createElement('button'); rBtn.className = 'cgpt-icon-btn'; rBtn.setAttribute('data-action','rename'); rBtn.title = '重命名'; rBtn.setAttribute('aria-label','重命名'); rBtn.innerHTML = svgPencil(); actions.appendChild(rBtn);
      // Delete
      const dBtn = document.createElement('button'); dBtn.className = 'cgpt-icon-btn danger'; dBtn.setAttribute('data-action','delete'); dBtn.title = '删除'; dBtn.setAttribute('aria-label','删除'); dBtn.innerHTML = svgTrash(); actions.appendChild(dBtn);

      // Expanded state handling: keep prior expands, and expand path to current chat
      if (expandedIds.has(folder.id) || expandByActive.has(folder.id)) item.classList.add('expanded');
      const chatsEl = item.querySelector('.cgpt-folder-chats');
      const setExpandedInstant = (v) => { if (v) { item.classList.add('expanded'); chatsEl.style.display='flex'; } else { item.classList.remove('expanded'); chatsEl.style.display='none'; } };
      // Keep prior state only; do not auto-expand siblings
      setExpandedInstant(item.classList.contains('expanded'));

      // Bind actions
      tBtn.addEventListener('click', async (e) => {
        try { e.stopPropagation(); e.preventDefault(); } catch {}
        if (item._animating) return;
        await withObserverSuppressed(async () => {
          const wantExpand = !item.classList.contains('expanded');
          if (wantExpand) {
            await setItemExpandedAnimated(item, true);
          } else {
            await collapseSubtreeThenSelf(item);
          }
        });
      });
      rBtn.addEventListener('click', async () => { const newName = await openNamePromptModal({ title: '重命名文件夹', placeholder: '输入新名称', initial: folder.name }); if (!newName) return; folder.name = newName.trim(); await storage.set(state); renderFolders(); });
      dBtn.addEventListener('click', async () => {
        const ok = await openConfirmModal('删除该文件夹及其子文件夹？（不会删除对话本身）');
        if (!ok) return;
        const idsToDelete = []; (function collect(id){ getFolderChildren(id).forEach(f=>{ idsToDelete.push(f.id); collect(f.id); }); })(folder.id);
        idsToDelete.push(folder.id);
        state.folders = state.folders.filter(f => !idsToDelete.includes(f.id));
        for (const cid of Object.keys(state.assignments)) {
          state.assignments[cid] = (state.assignments[cid] || []).filter(fid => !idsToDelete.includes(fid));
          if (state.assignments[cid].length === 0) delete state.assignments[cid];
        }
        await storage.set(state); renderFolders();
      });
      addBtn.addEventListener('click', async () => {
        const parentDepth = getFolderDepthZeroBased(folder.id);
        if (parentDepth >= 1) { toast('仅支持父/子两级，不能在子文件夹下创建子级'); return; }
        const name = await openNamePromptModal({ title: '新建子文件夹', placeholder: '输入名称', initial: '' });
        if (!name) return;
        state.folders.push({ id: uid('folder'), name: name.trim(), createdAt: Date.now(), parentId: folder.id });
        const chk = assertMaxDepth(2);
        if (!chk.ok) { state.folders.pop(); toast('创建失败：超过两级限制'); return; }
        try { item.classList.add('expanded'); const ce = item.querySelector('.cgpt-folder-chats'); if (ce) ce.style.display = 'flex'; } catch {}
        await storage.set(state); renderFolders();
      });

      // DnD for chats
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.add('cgpt-folder-drop');
        // Expand only the folder being hovered during drag
        if (!item.classList.contains('expanded') && !item._animating) {
          // Start once; do not reset on every dragover (dragover fires continuously)
          if (!item._hoverExpandTimer) {
            item._hoverExpandTimer = setTimeout(() => {
              if (!item.classList.contains('expanded') && !item._animating) {
                try { setItemExpandedAnimated(item, true); } catch {}
              }
              item._hoverExpandTimer = null;
            }, FOLDER_DRAG_HOVER_EXPAND_DELAY);
          }
        }
      });
      item.addEventListener('dragleave', () => { item.classList.remove('cgpt-folder-drop'); if (item._hoverExpandTimer) { clearTimeout(item._hoverExpandTimer); item._hoverExpandTimer = null; } });
      item.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation(); item.classList.remove('cgpt-folder-drop'); if (item._hoverExpandTimer) { clearTimeout(item._hoverExpandTimer); item._hoverExpandTimer = null; }
        const chatId = e.dataTransfer.getData('application/x-chatgpt-chat-id') || extractChatId(e.dataTransfer.getData('text/uri-list')) || extractChatId(e.dataTransfer.getData('text/plain'));
        if (!chatId) return; assignChatToFolder(chatId, folder.id); await storage.set(state); renderFolders(); toast('已添加到文件夹');
      });

      // Render children first (subfolders above chats)
      const kids = getFolderChildren(folder.id);
      kids.forEach(k => { const child = renderFolderRecursive(k, depth + 1); chatsEl.appendChild(child); });

      // Render chats
      const entries = getChatsForFolder(folder.id);
      entries.forEach(chat => {
        const row = document.createElement('div'); row.className = 'cgpt-folder-chat';
        try { row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '6px'; row.style.paddingLeft = (indent + 12) + 'px'; } catch {}
        const title = escapeHtml(chat.title || chat.id);
        row.innerHTML = `<a href="/c/${chat.id}" title="${title}">${title}</a><button class="cgpt-icon-btn danger" data-action="remove" title="从文件夹移除">${svgMinusCircle()}</button>`;
        // Highlight the currently open chat
        try { if (chat.id === getCurrentChatIdFromUrl()) row.classList.add('active'); } catch {}
        try {
          const a = row.querySelector('a'); const btn = row.querySelector('button');
          if (a) {
            a.setAttribute('draggable','false');
            a.style.flex = '1 1 auto'; a.style.minWidth = '0'; a.style.overflow = 'hidden'; a.style.textOverflow = 'ellipsis'; a.style.whiteSpace = 'nowrap'; a.style.display = 'block';
            // Robust navigation to avoid first-click SPA crash: force full navigation once
            a.addEventListener('click', (e) => {
              try { e.preventDefault(); e.stopPropagation(); } catch {}
              startNavCooldown(1400);
              try { window.location.assign(a.getAttribute('href')); } catch { window.location.href = a.getAttribute('href'); }
            });
          }
          if (btn) btn.style.flex = '0 0 auto';
        } catch {}
        row.querySelector('button[data-action="remove"]')?.addEventListener('click', async () => { unassignChatFromFolder(chat.id, folder.id); await storage.set(state); renderFolders(); });
        chatsEl.appendChild(row);
      });

      return item;
    }

    // Render only root folders; subfolders handled recursively
    folders.forEach(folder => {
      if (folder.parentId) return;
      const rootEl = renderFolderRecursive(folder, 0);
      runWithoutObserving(() => list.appendChild(rootEl));
      return;
      // Unreachable legacy code retained below
      const item = document.createElement('div');
      item.className = 'cgpt-folder-item';
      item.dataset.folderId = folder.id;
      item.innerHTML = `
        <div class="cgpt-folder-header">
          <div class="name" title="拖动对话到此">${escapeHtml(folder.name)}</div>
          <div>
            <button class="cgpt-icon-btn" data-action="toggle" aria-label="展开/折叠" title="展开/折叠">${svgChevronDown()}</button>
            <button class="cgpt-icon-btn" data-action="rename" aria-label="重命名" title="重命名">${svgPencil()}</button>
            <button class="cgpt-icon-btn danger" data-action="delete" aria-label="删除" title="删除">${svgTrash()}</button>
          </div>
        </div>
        <div class="cgpt-folder-chats"></div>
      `;

      // Restore expanded state if it was previously expanded
      if (expandedIds.has(folder.id)) item.classList.add('expanded');

      // Handlers for action buttons
      (function bindActionHandlers(){
        const tBtn = item.querySelector('button[data-action="toggle"]');
        const rBtn = item.querySelector('button[data-action="rename"]');
        const dBtn = item.querySelector('button[data-action="delete"]');
        tBtn?.addEventListener('click', () => { item.classList.toggle('expanded'); });
        rBtn?.addEventListener('click', async () => {
          const newName = await openNamePromptModal({ title: '重命名文件夹', placeholder: '输入新名称', initial: folder.name });
          if (!newName) return; folder.name = newName.trim();
          await storage.set(state); renderFolders();
        });
        dBtn?.addEventListener('click', async () => {
          const ok = await openConfirmModal('删除该文件夹？（不会删除对话本身）');
          if (!ok) return;
          state.folders = state.folders.filter(f => f.id !== folder.id);
          for (const cid of Object.keys(state.assignments)) {
            state.assignments[cid] = (state.assignments[cid] || []).filter(fid => fid !== folder.id);
            if (state.assignments[cid].length === 0) delete state.assignments[cid];
          }
          await storage.set(state); renderFolders();
        });
      })();

      // DnD
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('cgpt-folder-drop'); });
      item.addEventListener('dragleave', () => item.classList.remove('cgpt-folder-drop'));
      item.addEventListener('drop', async (e) => {
        e.preventDefault(); item.classList.remove('cgpt-folder-drop');
        const chatId = e.dataTransfer.getData('application/x-chatgpt-chat-id') || extractChatId(e.dataTransfer.getData('text/uri-list')) || extractChatId(e.dataTransfer.getData('text/plain'));
        if (!chatId) return;
        assignChatToFolder(chatId, folder.id);
        await storage.set(state);
        renderFolders();
        toast('已添加到文件夹');
      });

      // Render chats in this folder
      const container = item.querySelector('.cgpt-folder-chats');
      const entries = getChatsForFolder(folder.id);
      entries.forEach(chat => {
        const row = document.createElement('div');
        row.className = 'cgpt-folder-chat';
        // Ensure layout keeps the remove icon visible
        try {
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.gap = '6px';
        } catch {}
        const title = escapeHtml(chat.title || chat.id);
        row.innerHTML = `<a href="/c/${chat.id}" title="${title}">${title}</a><button class="cgpt-icon-btn danger" data-action="remove" title="从文件夹移除">${svgMinusCircle()}</button>`;
        // Truncate long titles with ellipsis and prevent button from shifting
        try {
          const a = row.querySelector('a');
          const btn = row.querySelector('button');
          if (a) {
            a.style.flex = '1 1 auto';
            a.style.minWidth = '0';
            a.style.overflow = 'hidden';
            a.style.textOverflow = 'ellipsis';
            a.style.whiteSpace = 'nowrap';
            a.style.display = 'block';
          }
          if (btn) btn.style.flex = '0 0 auto';
        } catch {}
        row.querySelector('button[data-action="remove"]')?.addEventListener('click', async () => {
          unassignChatFromFolder(chat.id, folder.id);
          await storage.set(state);
          renderFolders();
        });
        container.appendChild(row);
      });

      runWithoutObserving(() => list.appendChild(item));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  function extractChatId(text) {
    if (!text) return null;
    const m = text.match(/\/c\/([0-9a-fA-F-]{20,})/);
    return m ? m[1] : null;
  }

  function getChatTitleById(id) {
    const a = document.querySelector(`a[href="/c/${id}"]`);
    return a?.textContent?.trim() || id;
  }

  function getChatsForFolder(folderId) {
    const result = [];
    for (const [cid, fids] of Object.entries(state.assignments)) {
      if (fids.includes(folderId)) result.push({ id: cid, title: getChatTitleById(cid) });
    }
    result.sort((a,b) => a.title.localeCompare(b.title, 'zh-Hans'));
    return result;
  }

  function assignChatToFolder(chatId, folderId) {
    if (!chatId || !folderId) return;
    const arr = state.assignments[chatId] || [];
    if (!arr.includes(folderId)) arr.push(folderId);
    state.assignments[chatId] = arr;
  }

  function unassignChatFromFolder(chatId, folderId) {
    const arr = state.assignments[chatId] || [];
    state.assignments[chatId] = arr.filter(x => x !== folderId);
    if (state.assignments[chatId].length === 0) delete state.assignments[chatId];
  }

  // Custom context menu (extension-owned)
  function ensureContextMenuEl() {
    let menu = document.getElementById('cgpt-context-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'cgpt-context-menu';
      document.documentElement.appendChild(menu);
      document.addEventListener('click', () => hideContextMenu());
      window.addEventListener('blur', () => hideContextMenu());
      window.addEventListener('resize', () => hideContextMenu());
      document.addEventListener('scroll', () => hideContextMenu(), true);
    }
    return menu;
  }

  function hideContextMenu() {
    const menu = document.getElementById('cgpt-context-menu');
    if (!menu) return;
    menu.classList.remove('show');
    clearTimeout(menu._hideTimer);
    menu._hideTimer = setTimeout(() => { if (!menu.classList.contains('show')) menu.style.display = 'none'; }, 140);
  }

  function showFolderContextMenu(x, y, chatAnchor) {
    const menu = ensureContextMenuEl();
    const chatId = extractChatId(chatAnchor.getAttribute('href'));
    const title = chatAnchor.textContent?.trim() || chatId;
    // Build richer menu content with icons
    menu.innerHTML = `
      <div class="label" aria-hidden="true">
        <div class="title" title="${escapeHtml(title)}">对话：${escapeHtml(title)}</div>
      </div>
      <div class="sep" aria-hidden="true"></div>
      <div class="item" data-action="picker" role="menuitem" tabindex="0">
        <span class="icon">${svgFolderPlus()}</span>
        <span class="text">添加到文件夹…</span>
      </div>
      <div class="item" data-action="new" role="menuitem" tabindex="0">
        <span class="icon">${svgPlus()}</span>
        <span class="text">新建文件夹…</span>
      </div>
    `;
    // Prepare for positioning and animation
    menu.style.display = 'block';
    menu.classList.remove('show');
    menu.style.visibility = 'hidden';
    // Compute clamped position using measured size
    const mw = menu.offsetWidth || 240;
    const mh = menu.offsetHeight || 160;
    const left = Math.min(Math.max(8, x), window.innerWidth - mw - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.visibility = '';
    // Animate in
    requestAnimationFrame(() => { menu.classList.add('show'); });

    menu.querySelectorAll('.item').forEach(el => {
      el.addEventListener('click', async () => {
        const action = el.getAttribute('data-action');
        if (action === 'picker') {
          hideContextMenu();
          await openFolderPicker(chatId);
        } else if (action === 'new') {
          const name = await openNamePromptModal({ title: '新建文件夹', placeholder: '输入文件夹名称', initial: '' });
          if (!name) return hideContextMenu();
          const folder = { id: uid('folder'), name: name.trim(), createdAt: Date.now() };
          state.folders.push(folder);
          assignChatToFolder(chatId, folder.id);
          await storage.set(state);
          renderFolders();
          toast('已创建并添加');
        }
        hideContextMenu();
      }, { once: true });
    });
  }

  function observeAndAugmentNativeMenu() {
    if (!ENABLE_NATIVE_MENU_INJECTION) return;
    if (chatMenuObserver) return;
    chatMenuObserver = new MutationObserver((mutations) => {
      const ensureMenuBound = (menu) => {
        // Always (re)bind likely chat id for this menu
        try {
          const fromFocus = findChatAnchorFromEventTarget(document.activeElement);
          const near = anchorNearPoint(lastMouse.x, lastMouse.y) || findNearestChatAnchorToPoint(lastMouse.x, lastMouse.y);
          const selected = document.querySelector('a[href^="/c/"][aria-current="page"]');
          const fromMenu = menu.querySelector?.('a[href^="/c/"]');
          const src = (menuHintChatId && Date.now() - menuHintTs < 5000 && document.querySelector(`a[href^="/c/${menuHintChatId}"]`))
            || fromMenu || fromFocus || lastInteractedChat || near || selected;
          const idAtOpen = src ? extractChatId(src.getAttribute('href')) : (menuHintChatId || null);
          if (idAtOpen) menu.dataset.cgptChatId = idAtOpen; else delete menu.dataset.cgptChatId;
        } catch {}

        // Inject our item once
        if (menu.dataset.cgptAugmented === '1') return;
        menu.dataset.cgptAugmented = '1';
        const item = createNativeLikeMenuItem(menu, 'Add to Folder…');
        const recomputeId = async () => {
          if (menuHintChatId && Date.now() - menuHintTs < 5000) return menuHintChatId;
          if (menu.dataset.cgptChatId) return menu.dataset.cgptChatId;
          return await getLikelyChatIdRetry(2, 50);
        };
        item.addEventListener('mouseenter', async () => {
          const id = await recomputeId();
          if (id) menu.dataset.cgptChatId = id;
        });
        item.addEventListener('focus', async () => {
          const id = await recomputeId();
          if (id) menu.dataset.cgptChatId = id;
        });
        item.addEventListener('click', async () => {
          const chatId = await recomputeId();
          if (!chatId) { toast('未识别对话ID'); return; }
          await openFolderPicker(chatId);
        });
        item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); } });
        menu.insertBefore(item, menu.firstChild);
      };

      for (const m of mutations) {
        if (m.type === 'attributes') {
          const target = m.target;
          if (target instanceof HTMLElement && (target.getAttribute('role') === 'menu' || target.matches?.('[role="menu"]'))) {
            ensureMenuBound(target);
          }
        }
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const menu = node.matches?.('div[role="menu"], [role="menu"]') ? node : node.querySelector?.('[role="menu"]');
          if (!menu) continue;
          ensureMenuBound(menu);
        }
      }
    });
    chatMenuObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
  }

  function createNativeLikeMenuItem(menu, label) {
    const exemplar = menu.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
    if (exemplar) {
      const cloned = exemplar.cloneNode(true);
      cloned.setAttribute('data-cgpt-menu-item', '1');
      cloned.removeAttribute('aria-disabled');
      if (!cloned.getAttribute('role')) cloned.setAttribute('role', 'menuitem');
      if (!cloned.hasAttribute('tabindex')) cloned.tabIndex = 0;
      const labelEl = findBestTextElement(cloned) || cloned;
      labelEl.textContent = label;
      return cloned;
    }
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-cgpt-menu-item', '1');
    item.tabIndex = 0;
    item.textContent = label;
    item.style.padding = '8px 12px';
    item.style.borderRadius = '8px';
    return item;
  }

  function findBestTextElement(root) {
    const els = Array.from(root.querySelectorAll('*:not(svg):not(path)'));
    let best = null; let bestLen = -1;
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      if (txt && txt.length > bestLen) { best = el; bestLen = txt.length; }
    }
    return best;
  }

  function observeSidebar() {
    if (sidebarObserver) return;
    const scheduleRefresh = () => {
      if (suppressObserver) return;
      if (Date.now() < navCooldownUntil) return; // avoid re-render storms during SPA nav
      if (refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(() => {
        refreshQueued = false;
        if (Date.now() < navCooldownUntil) return;
        mountPanel();
        enhanceChatItemsForDnDAndMenu(document);
        renderFolders();
      });
    };
    sidebarObserver = new MutationObserver((mutations) => {
      if (suppressObserver) return;
      const panel = document.getElementById('cgpt-folder-panel');
      if (panel && mutations.every(m => { const t = m.target instanceof Node ? m.target : null; return t && panel.contains(t); })) return;
      scheduleRefresh();
    });
    sidebarObserver.observe(document.body, { childList: true, subtree: true });
  }

  function enhanceChatItemsForDnDAndMenu(root = document) {
    const links = root.querySelectorAll('a[href^="/c/"]');
    links.forEach(a => {
      // Skip our own panel links to avoid accidental drags blocking navigation
      if (a.closest('#cgpt-folder-panel')) return;
      if (a.dataset.cgptEnhanced === '1') return;
      a.dataset.cgptEnhanced = '1';
      a.setAttribute('draggable', 'true');
      a.addEventListener('dragstart', (e) => {
        try {
          const id = extractChatId(a.getAttribute('href'));
          const title = a.textContent?.trim() || '';
          e.dataTransfer?.setData('text/uri-list', location.origin + a.getAttribute('href'));
          e.dataTransfer?.setData('text/plain', `${title}\n${location.origin + a.getAttribute('href')}`);
          e.dataTransfer?.setData('application/x-chatgpt-chat-id', id || '');
        } catch {}
      });
      a.addEventListener('contextmenu', (e) => {
        lastInteractedChat = a;
        lastInteractedChatId = extractChatId(a.getAttribute('href')) || null;
        showFolderContextMenu(e.pageX, e.pageY, a);
        e.preventDefault();
      }, { capture: true });
      a.addEventListener('mousedown', () => { lastInteractedChat = a; lastInteractedChatId = extractChatId(a.getAttribute('href')) || null; }, { capture: true });
      a.addEventListener('click', () => hideContextMenu());

      // Also enhance the entire chat row to capture interactions on the "…" button
      const row = a.closest('li, [role="listitem"], div[role="option"], div[role="treeitem"], div[data-testid*="conversation"]');
      if (row && row.dataset.cgptRowEnhanced !== '1') {
        row.dataset.cgptRowEnhanced = '1';
        const setFromRow = () => { lastInteractedChat = a; lastInteractedChatId = extractChatId(a.getAttribute('href')) || null; };
        row.addEventListener('pointerdown', setFromRow, { capture: true });
        row.addEventListener('mousedown', setFromRow, { capture: true });
        row.addEventListener('contextmenu', setFromRow, { capture: true });

        // Inline "Add to folder" button using the same reliable id source as drag
        try {
          if (!row.querySelector('.cgpt-inline-add')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cgpt-icon-btn cgpt-inline-add';
            btn.setAttribute('aria-label', '添加到文件夹');
            btn.title = '添加到文件夹';
            btn.innerHTML = svgFolderPlus();
            btn.addEventListener('click', async (e) => {
              e.preventDefault(); e.stopPropagation(); hideContextMenu();
              const id = extractChatId(a.getAttribute('href'));
              if (!id) { toast('未识别对话ID'); return; }
              await openFolderPicker(id);
            });
            // Ensure the row can anchor an absolutely-positioned button without layout shift
            try { const cs = getComputedStyle(row); if (cs.position === 'static') row.style.position = 'relative'; } catch {}
            row.appendChild(btn);
          }
        } catch {}
      }
    });
  }

  function getCurrentChatIdFromUrl() {
    return extractChatId(location.pathname) || null;
  }

  // Robust chat anchor detection
  function findChatAnchorFromNode(node) {
    if (!node) return null;
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    for (let i = 0; i < 8 && el; i++) {
      if (el.matches && el.matches('a[href^="/c/"]')) return el;
      const inner = el.querySelector?.('a[href^="/c/"]');
      if (inner) return inner;
      el = el.parentElement;
    }
    return null;
  }

  function findChatAnchorFromEventTarget(target) {
    // Try direct/descendant first
    let a = findChatAnchorFromNode(target);
    if (a) return a;
    // Then try a likely row container and search within
    const row = target && (target.closest ? target.closest('li, [role="listitem"], div[role="option"], div[role="treeitem"], div[data-testid*="conversation"], nav[aria-label*="Conversation" i]') : null);
    if (row) {
      a = row.querySelector?.('a[href^="/c/"]');
      if (a) return a;
    }
    return null;
  }

  function anchorNearPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    return findChatAnchorFromNode(el);
  }

  function findNearestChatAnchorToPoint(x, y) {
    const anchors = Array.from(document.querySelectorAll('a[href^="/c/"]'));
    let best = null;
    let bestDist = Infinity;
    for (const a of anchors) {
      if (a.closest('#cgpt-folder-panel')) continue; // ignore anchors in our panel
      const rect = a.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      // distance from point to rect (0 if inside)
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const d = dx + dy;
      if (d < bestDist) { bestDist = d; best = a; }
    }
    return best;
  }

  function getLikelyChatId() {
    // Prefer recent menu hint within 5 seconds
    const now = Date.now();
    if (menuHintChatId && now - menuHintTs < 5000) return menuHintChatId;
    const a = lastInteractedChat || document.querySelector('a[href^="/c/"][aria-current="page"]') || anchorNearPoint(lastMouse.x, lastMouse.y) || findNearestChatAnchorToPoint(lastMouse.x, lastMouse.y);
    return lastInteractedChatId || (a ? extractChatId(a.getAttribute('href')) : null) || getCurrentChatIdFromUrl();
  }

  async function getLikelyChatIdRetry(retries = 10, delayMs = 80) {
    let id = getLikelyChatId();
    for (let i = 0; !id && i < retries; i++) {
      await new Promise(r => setTimeout(r, delayMs));
      id = getLikelyChatId();
    }
    return id;
  }

  async function init() {
    state = await storage.get();
    // Migrate any existing data exceeding two levels (non-destructive reparenting)
    const _migratedCount = enforceTwoLevelConstraint();
    if (_migratedCount > 0) {
      try { await storage.set(state); } catch {}
      try { toast(`已调整 ${_migratedCount} 个子文件夹到二级以符合两级限制`); } catch {}
    }
    // Remove legacy header button if present
    try { const legacy = document.getElementById('cgpt-header-add'); if (legacy) legacy.remove(); } catch {}
    // Track mouse position for proximity-based fallback
    document.addEventListener('mousemove', (e) => { try { lastMouse.x = e.clientX; lastMouse.y = e.clientY; } catch {} }, true);
    // Helper to update last interacted chat from any event target within a chat row
    const updateLastFromTarget = (target) => {
      try {
        const a = findChatAnchorFromEventTarget(target);
        if (a) {
          lastInteractedChat = a;
          lastInteractedChatId = extractChatId(a.getAttribute('href')) || null;
        }
      } catch {}
    };
    // Capture interactions that likely precede opening native menus/buttons
    document.addEventListener('contextmenu', (e) => { updateLastFromTarget(e.target); menuHintChatId = lastInteractedChatId; menuHintTs = Date.now(); }, true);
    document.addEventListener('mousedown', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; updateLastFromTarget(e.target); menuHintChatId = lastInteractedChatId; menuHintTs = Date.now(); }, true);
    document.addEventListener('pointerdown', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; updateLastFromTarget(e.target); menuHintChatId = lastInteractedChatId; menuHintTs = Date.now(); }, true);
    document.addEventListener('focusin', (e) => { updateLastFromTarget(e.target); }, true);
    observeSidebar();
    enhanceChatItemsForDnDAndMenu(document);
    mountPanel();
    // Removed header add button per request
    if (ENABLE_NATIVE_MENU_INJECTION) observeAndAugmentNativeMenu();
  }

  // Kick off
  init();

  function runWithoutObserving(fn) {
    try { suppressObserver++; fn(); } finally { suppressObserver--; }
  }

  async function withObserverSuppressed(fn) {
    try { suppressObserver++; return await fn(); } finally { suppressObserver--; }
  }

  // SVG icons
  function svgChevronDown() {
    return '<svg class="cgpt-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M6 9l6 6 6-6"></path></svg>';
  }
  function svgPencil() {
    return '<svg class="cgpt-icon solid" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"></path><path d="M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>';
  }
  function svgTrash() {
    return '<svg class="cgpt-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
  }
  function svgMinusCircle() {
    return '<svg class="cgpt-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path></svg>';
  }
  function svgFolderPlus() {
    // Simple folder with plus icon
    return '<svg class="cgpt-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path><path d="M12 11v6"></path><path d="M9 14h6"></path></svg>';
  }
  function svgPlus() {
    return '<svg class="cgpt-icon" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
  }

  // Modals
  function ensureFolderModal() {
    let overlay = document.getElementById('cgpt-modal-overlay');
    let modal = document.getElementById('cgpt-folder-modal');
    if (!overlay) { overlay = document.createElement('div'); overlay.id = 'cgpt-modal-overlay'; document.documentElement.appendChild(overlay); }
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cgpt-folder-modal';
      modal.innerHTML = `
        <div class="header">添加到文件夹</div>
        <div class="sub" id="cgpt-folder-chat-title" style="opacity:.75;font-size:12px;margin:-6px 0 6px 0;"></div>
        <div class="body">
          <div class="list" id="cgpt-folder-modal-list"></div>
          <div class="new-row">
            <input type="text" id="cgpt-folder-new-name" placeholder="新建文件夹名称" />
            <button class="btn" id="cgpt-folder-new-btn">添加</button>
          </div>
          <div class="actions">
            <button class="btn" id="cgpt-folder-cancel">取消</button>
            <button class="btn primary" id="cgpt-folder-ok">确定</button>
          </div>
        </div>`;
      document.documentElement.appendChild(modal);
    }
    return { overlay, modal };
  }

  async function openFolderPicker(chatId) {
    const { overlay, modal } = ensureFolderModal();
    const list = modal.querySelector('#cgpt-folder-modal-list');
    const titleEl = modal.querySelector('#cgpt-folder-chat-title');
    const newInput = modal.querySelector('#cgpt-folder-new-name');
    const newBtn = modal.querySelector('#cgpt-folder-new-btn');
    const btnOk = modal.querySelector('#cgpt-folder-ok');
    const btnCancel = modal.querySelector('#cgpt-folder-cancel');

    list.innerHTML = '';
    // Show which conversation is being edited to eliminate ambiguity
    try { titleEl.textContent = `对话：${escapeHtml(getChatTitleById(chatId))}`; } catch {}
    const assigned = new Set(state.assignments[chatId] || []);
    if (state.folders.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '暂无文件夹，请先新建';
      empty.style.opacity = '0.7';
      empty.className = 'cgpt-folder-empty-hint';
      list.appendChild(empty);
    }
    function addRowForFolder(f, depth) {
      const row = document.createElement('label');
      row.className = 'opt';
      const pad = Math.max(0, depth) * 16; // clearer parent/child hierarchy
      row.style.setProperty('--depth-indent', pad + 'px');
      row.innerHTML = `<input type="checkbox" value="${f.id}" ${assigned.has(f.id) ? 'checked' : ''}/> <span style="display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;">${escapeHtml(f.name)}</span>`;
      list.appendChild(row);
    }
    function traverse(parentId, depth) {
      state.folders.filter(ff => (ff.parentId || null) === parentId)
        .forEach(ff => {
          addRowForFolder(ff, depth);
          traverse(ff.id, depth + 1);
        });
    }
    traverse(null, 0);

    function close() { overlay.style.display = 'none'; modal.style.display = 'none'; document.removeEventListener('keydown', onKey); overlay.removeEventListener('click', onOverlayClick); }
    function onKey(e) { if (e.key === 'Escape') close(); if (e.key === 'Enter') btnOk.click(); }
    function onOverlayClick() { close(); }

    newBtn.onclick = async () => {
      const val = newInput.value.trim(); if (!val) return;
      const folder = { id: uid('folder'), name: val, createdAt: Date.now() };
      state.folders.push(folder); await storage.set(state);
      // Remove the empty hint if it exists now that we have at least one folder
      const emptyHint = list.querySelector('.cgpt-folder-empty-hint');
      if (emptyHint) emptyHint.remove();
      const row = document.createElement('label'); row.className = 'opt';
      row.innerHTML = `<input type="checkbox" value="${folder.id}" checked/> <span>${escapeHtml(folder.name)}</span>`;
      list.appendChild(row); newInput.value = ''; newInput.focus();
    };

    btnOk.onclick = async () => {
      const selected = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(i => i.value);
      state.assignments[chatId] = Array.from(new Set(selected));
      if (state.assignments[chatId].length === 0) delete state.assignments[chatId];
      await storage.set(state); renderFolders(); toast('已更新文件夹归类'); close();
    };
    btnCancel.onclick = () => close();
    document.addEventListener('keydown', onKey); overlay.addEventListener('click', onOverlayClick);
    overlay.style.display = 'block'; modal.style.display = 'block'; if (state.folders.length === 0) newInput.focus();
  }

  // Simple input modal used for creating/renaming folders
  function ensureInputModal() {
    let overlay = document.getElementById('cgpt-modal-overlay'); if (!overlay) { overlay = document.createElement('div'); overlay.id = 'cgpt-modal-overlay'; document.documentElement.appendChild(overlay); }
    let modal = document.getElementById('cgpt-input-modal');
    if (!modal) {
      modal = document.createElement('div'); modal.id = 'cgpt-input-modal';
      modal.innerHTML = `
        <div class="header" id="cgpt-input-title"></div>
        <div class="body">
          <input type="text" id="cgpt-input-text" placeholder="" />
          <div class="actions">
            <button class="btn" id="cgpt-input-cancel">取消</button>
            <button class="btn primary" id="cgpt-input-ok">确定</button>
          </div>
        </div>`;
      document.documentElement.appendChild(modal);
    }
    return { overlay, modal };
  }

  function openNamePromptModal({ title, placeholder, initial }) {
    return new Promise((resolve) => {
      const { overlay, modal } = ensureInputModal();
      const titleEl = modal.querySelector('#cgpt-input-title');
      const inputEl = modal.querySelector('#cgpt-input-text');
      const okBtn = modal.querySelector('#cgpt-input-ok');
      const cancelBtn = modal.querySelector('#cgpt-input-cancel');
      titleEl.textContent = title || '输入';
      inputEl.placeholder = placeholder || '';
      inputEl.value = initial || '';
      function close(val) { overlay.style.display = 'none'; modal.style.display = 'none'; document.removeEventListener('keydown', onKey); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') return close(null); if (e.key === 'Enter') return okBtn.click(); }
      okBtn.onclick = () => { const v = inputEl.value.trim(); if (!v) return close(null); close(v); };
      cancelBtn.onclick = () => close(null);
      document.addEventListener('keydown', onKey);
      overlay.style.display = 'block'; modal.style.display = 'block'; setTimeout(() => inputEl.focus(), 0);
    });
  }

  function ensureConfirmModal() {
    let overlay = document.getElementById('cgpt-modal-overlay'); if (!overlay) { overlay = document.createElement('div'); overlay.id = 'cgpt-modal-overlay'; document.documentElement.appendChild(overlay); }
    let modal = document.getElementById('cgpt-confirm-modal');
    if (!modal) {
      modal = document.createElement('div'); modal.id = 'cgpt-confirm-modal';
      modal.innerHTML = `
        <div class="header" id="cgpt-confirm-title">确认操作</div>
        <div class="body" id="cgpt-confirm-body"></div>
        <div class="actions">
          <button class="btn" id="cgpt-confirm-cancel">取消</button>
          <button class="btn primary" id="cgpt-confirm-ok">确定</button>
        </div>`;
      document.documentElement.appendChild(modal);
    }
    return { overlay, modal };
  }

  function openConfirmModal(message) {
    return new Promise((resolve) => {
      const { overlay, modal } = ensureConfirmModal();
      modal.querySelector('#cgpt-confirm-body').textContent = message || '确认？';
      const okBtn = modal.querySelector('#cgpt-confirm-ok');
      const cancelBtn = modal.querySelector('#cgpt-confirm-cancel');
      function close(val) { overlay.style.display = 'none'; modal.style.display = 'none'; document.removeEventListener('keydown', onKey); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') return close(false); if (e.key === 'Enter') return okBtn.click(); }
      okBtn.onclick = () => close(true);
      cancelBtn.onclick = () => close(false);
      document.addEventListener('keydown', onKey);
      overlay.style.display = 'block'; modal.style.display = 'block';
    });
  }

})();
