(() => {
  'use strict';

  const BASE = location.pathname.replace(/\/+$/, '');
  const listEl = document.getElementById('list');
  const bannerEl = document.getElementById('banner');
  const stampEl = document.getElementById('stamp');
  const storeEl = document.getElementById('store');
  const editorEl = document.getElementById('editor');
  const editorTitleEl = document.getElementById('editor-title');
  const editorErrorEl = document.getElementById('editor-error');
  const form = document.getElementById('editor-form');
  const toastEl = document.getElementById('toast');

  let state = null;
  /** null when the editor is closed, otherwise `{ original: string | null }`. */
  let editing = null;
  let busy = false;

  /* ------------------------------------------------------------ helpers */

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'open') node[key] = Boolean(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function statusOf(server) {
    if (!server.enabled) return { cls: 'off', text: '已停用' };
    if (server.connected) return { cls: 'ok', text: '已连接' };
    if (server.phase === 'failed') return { cls: 'bad', text: '连接失败' };
    if (server.phase === 'active') return { cls: 'warn', text: '运行中 · 无工具' };
    if (server.phase === 'loading' || server.phase === 'pending' || server.phase === 'unloading') {
      return { cls: 'warn', text: '连接中' };
    }
    if (server.phase === 'missing') return { cls: 'off', text: '未挂载' };
    return { cls: 'off', text: server.phase || '未知' };
  }

  function quoteArgs(args) {
    return args.map((item) => (/[\s"]/.test(item) ? `"${item}"` : item)).join(' ');
  }

  function commandLine(server) {
    if (server.transport === 'streamable-http') return server.url || '(缺少地址)';
    const parts = [server.command].filter(Boolean);
    if (server.args.length > 0) parts.push(quoteArgs(server.args));
    return parts.length > 0 ? parts.join(' ') : '(缺少命令)';
  }

  /* --------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(message, bad) {
    toastEl.textContent = message;
    toastEl.classList.toggle('bad', Boolean(bad));
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2800);
  }

  /* ------------------------------------------------------------- network */

  async function api(path, options) {
    const request = options || {};
    const response = await fetch(BASE + path, {
      method: request.method || 'GET',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: request.body,
      cache: 'no-store',
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error((data && data.error) || `HTTP ${response.status}`);
    }
    return data;
  }

  /* ------------------------------------------------------------ render */

  function applyState(next) {
    state = next;
    render();
  }

  function renderBanner() {
    const parts = [];
    if (state && state.storeError) {
      parts.push(el('div', {}, `无法读取服务器列表：${state.storeError}`));
    }
    if (state && state.reloadError) {
      parts.push(el('div', {}, `列表已保存，但热加载没有成功：${state.reloadError}`));
    }
    if (state && state.includeInstalled === false) {
      parts.push(
        el(
          'div',
          {},
          '服务器列表还没有被组合挂载：请在 profile 的 cordis.patch.yml 中加入下面这段（只需一次），然后重启 Host：',
          el(
            'pre',
            {},
            `- insert:\n    - id: ${state.includeId}\n      name: 'cordis:include'\n      config:\n        path: 'mcp-servers.json'`,
          ),
        ),
      );
    }
    if (parts.length === 0) {
      bannerEl.hidden = true;
      bannerEl.textContent = '';
      return;
    }
    bannerEl.className = 'banner bad';
    bannerEl.hidden = false;
    bannerEl.replaceChildren(...parts);
  }

  function renderCard(server) {
    const status = statusOf(server);
    const card = el('section', { class: 'card', dataset: { server: server.serverName } });

    const toggle = server.managed
      ? el(
          'label',
          { class: 'switch', title: server.enabled ? '点击停用' : '点击启用' },
          el('input', {
            type: 'checkbox',
            'data-act': 'toggle',
            checked: server.enabled,
            disabled: busy,
          }),
          el('i'),
        )
      : null;

    const header = el(
      'header',
      {},
      el('span', { class: `dot ${status.cls}`, title: status.text }),
      el('span', { class: 'name mono', text: server.serverName }),
      el('span', { class: 'badge', text: status.text }),
      el('span', { class: 'badge dim', text: server.transport }),
      server.managed
        ? null
        : el('span', { class: 'badge ext', text: '外部配置', title: '这一条来自 cordis.patch.yml，面板里只读' }),
      el('span', { class: 'count', text: `${server.toolCount} 个工具` }),
      el(
        'div',
        { class: 'row-actions' },
        toggle,
        server.managed ? el('button', { type: 'button', 'data-act': 'edit', disabled: busy }, '编辑') : null,
        server.managed ? el('button', { type: 'button', 'data-act': 'restart', disabled: busy }, '重连') : null,
        server.managed
          ? el('button', { type: 'button', class: 'danger', 'data-act': 'delete', disabled: busy }, '删除')
          : null,
      ),
    );

    const body = el('div', { class: 'body' }, el('p', { class: 'mono cmd', text: commandLine(server) }));

    const envEntries = Object.entries(server.env || {});
    if (envEntries.length > 0) {
      const table = el('table', { class: 'env' });
      const tbody = el('tbody');
      for (const [key, value] of envEntries) {
        tbody.append(el('tr', {}, el('td', { text: key }), el('td', { class: 'mono', text: value })));
      }
      table.append(tbody);
      body.append(table);
    }
    if (server.cwd) {
      body.append(el('p', { class: 'note', text: `工作目录：${server.cwd}` }));
    }
    if (server.managed === false) {
      body.append(
        el('p', {
          class: 'note off',
          text: '这条 MCP 服务器定义在 cordis.patch.yml 里。想在这里编辑，请先在面板里新建同名以外的服务器并从配置文件删掉旧的一条。',
        }),
      );
    }
    if (server.warning) {
      body.append(el('p', { class: 'note warn', text: `⚠ ${server.warning}` }));
    }
    if (server.lastLog) {
      const prefix = server.lastLogIsProgress ? '最近状态' : '最近一次报错';
      body.append(
        el('p', {
          class: server.lastLog.level === 'error' ? 'note bad' : 'note warn',
          text: `${prefix}：${server.lastLog.text}`,
        }),
      );
    }

    if (server.toolCount > 0) {
      const items = el('ul');
      for (const tool of server.tools) {
        items.append(
          el(
            'li',
            {},
            el('span', { class: 'mono tool', text: tool.raw }),
            tool.description ? el('span', { class: 'desc', text: tool.description.split('\n')[0] }) : null,
          ),
        );
      }
      body.append(el('details', { class: 'tools' }, el('summary', { text: `工具列表（${server.toolCount}）` }), items));
    } else if (server.enabled && server.phase !== 'failed') {
      body.append(el('p', { class: 'note', text: '暂无已注册的工具' }));
    }

    card.append(header, body);
    return card;
  }

  function render() {
    renderBanner();
    if (!state) return;
    storeEl.textContent = state.storePath || '—';
    stampEl.textContent = new Date(state.generatedAt).toLocaleTimeString();

    const servers = state.servers || [];
    if (servers.length === 0) {
      listEl.replaceChildren(
        el(
          'p',
          { class: 'empty' },
          '还没有配置任何 MCP 服务器。点右上角「＋ 新增服务器」填一条，保存后工具会立刻出现。',
        ),
      );
      return;
    }
    listEl.replaceChildren(...servers.map(renderCard));
  }

  /* ------------------------------------------------------------ refresh */

  async function refresh() {
    try {
      applyState(await api('/api/state'));
    } catch (error) {
      stampEl.textContent = `刷新失败：${error.message}`;
    }
  }

  /* ------------------------------------------------------------- editor */

  function syncTransport() {
    const transport = form.transport.value;
    for (const node of document.querySelectorAll('.only-stdio')) node.hidden = transport !== 'stdio';
    for (const node of document.querySelectorAll('.only-http')) node.hidden = transport !== 'streamable-http';
  }

  function showEditorError(message) {
    editorErrorEl.textContent = message;
    editorErrorEl.hidden = false;
  }

  function openEditor(server) {
    editing = { original: server ? server.serverName : null };
    editorTitleEl.textContent = server ? `编辑服务器 · ${server.serverName}` : '新增服务器';
    form.serverName.value = server ? server.serverName : '';
    form.transport.value = server && server.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    form.command.value = server ? server.command : '';
    form.args.value = server ? (server.args || []).join('\n') : '';
    form.env.value = server
      ? Object.entries(server.env || {})
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')
      : '';
    form.cwd.value = server ? server.cwd : '';
    form.url.value = server ? server.url : '';
    form.headers.value = server
      ? Object.entries(server.headers || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n')
      : '';
    form.toolCallTimeoutMs.value = server ? server.toolCallTimeoutMs : 60000;
    form.reconnectAttempts.value = server && server.reconnect ? server.reconnect.maxAttempts || 10 : 10;
    form.autoReconnect.checked = server && server.reconnect ? server.reconnect.enabled !== false : true;
    form.failOnStartupError.checked = Boolean(server && server.failOnStartupError);
    form.enabled.checked = server ? server.enabled : true;
    editorErrorEl.hidden = true;
    editorEl.hidden = false;
    syncTransport();
    editorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    form.serverName.focus();
    form.serverName.select();
  }

  function closeEditor() {
    editing = null;
    editorEl.hidden = true;
    editorErrorEl.hidden = true;
  }

  function readForm() {
    return {
      server: {
        serverName: form.serverName.value.trim(),
        transport: form.transport.value,
        command: form.command.value.trim(),
        args: form.args.value,
        env: form.env.value,
        cwd: form.cwd.value.trim(),
        url: form.url.value.trim(),
        headers: form.headers.value,
        toolCallTimeoutMs: form.toolCallTimeoutMs.value,
        reconnectAttempts: form.reconnectAttempts.value,
        autoReconnect: form.autoReconnect.checked,
        failOnStartupError: form.failOnStartupError.checked,
        enabled: form.enabled.checked,
      },
    };
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (!editing || busy) return;
    busy = true;
    try {
      const body = JSON.stringify(readForm());
      const next = editing.original
        ? await api(`/api/servers/${encodeURIComponent(editing.original)}`, { method: 'PUT', body })
        : await api('/api/servers', { method: 'POST', body });
      applyState(next);
      closeEditor();
      toast('已保存，正在连接…');
    } catch (error) {
      showEditorError(error.message);
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------ actions */

  async function setEnabled(server, enabled) {
    if (busy) return;
    busy = true;
    try {
      const next = await api(`/api/servers/${encodeURIComponent(server.serverName)}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      applyState(next);
      toast(enabled ? '已启用，正在连接…' : '已停用');
    } catch (error) {
      toast(error.message, true);
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function restartServer(server) {
    if (busy) return;
    busy = true;
    try {
      const next = await api(`/api/servers/${encodeURIComponent(server.serverName)}/restart`, { method: 'POST' });
      applyState(next);
      toast('已重连');
    } catch (error) {
      toast(error.message, true);
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function removeServer(server) {
    if (busy) return;
    const ok = confirm(`删除 MCP 服务器「${server.serverName}」？它的工具会立刻下线。`);
    if (!ok) return;
    busy = true;
    try {
      const next = await api(`/api/servers/${encodeURIComponent(server.serverName)}`, { method: 'DELETE' });
      applyState(next);
      toast('已删除');
    } catch (error) {
      toast(error.message, true);
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function reloadFromDisk() {
    if (busy) return;
    busy = true;
    try {
      const next = await api('/api/reload', { method: 'POST' });
      applyState(next);
      toast('已按文件内容重新加载');
    } catch (error) {
      toast(error.message, true);
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------- wiring */

  document.getElementById('btn-new').addEventListener('click', () => openEditor(null));
  document.getElementById('btn-refresh').addEventListener('click', () => refresh());
  document.getElementById('btn-reload').addEventListener('click', () => reloadFromDisk());
  document.getElementById('btn-cancel').addEventListener('click', () => closeEditor());
  form.addEventListener('submit', submitEditor);
  form.transport.addEventListener('change', syncTransport);

  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const card = button.closest('.card');
    const server = card && state ? (state.servers || []).find((item) => item.serverName === card.dataset.server) : null;
    if (!server) return;
    if (button.dataset.act === 'edit') openEditor(server);
    else if (button.dataset.act === 'restart') restartServer(server);
    else if (button.dataset.act === 'delete') removeServer(server);
  });

  listEl.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-act="toggle"]');
    if (!input) return;
    const card = input.closest('.card');
    const server = card && state ? (state.servers || []).find((item) => item.serverName === card.dataset.server) : null;
    if (server) setEnabled(server, input.checked);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && editing) closeEditor();
  });

  syncTransport();
  refresh();
  setInterval(() => {
    if (!editing && !busy && !document.hidden) refresh();
  }, 4000);
})();
