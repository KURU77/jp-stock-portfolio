/* Google同期の設定ページ。実際の処理は js/sync.js が持っていて、ここは画面だけ。 */
(() => {
  'use strict';

  const THEME_KEY = 'jp-stock-portfolio.theme';
  const $ = (sel) => document.querySelector(sel);

  const el = {
    statusTiles: $('#statusTiles'),
    statusNote: $('#statusNote'),
    connectBtn: $('#connectBtn'),
    syncBtn: $('#syncBtn'),
    disconnectBtn: $('#disconnectBtn'),
    autoSync: $('#autoSync'),
    pushBtn: $('#pushBtn'),
    pullBtn: $('#pullBtn'),
    restoreBtn: $('#restoreBtn'),
    clientId: $('#clientId'),
    saveIdBtn: $('#saveIdBtn'),
    originValue: $('#originValue'),
    copyOriginBtn: $('#copyOriginBtn'),
    conflictDialog: $('#conflictDialog'),
    conflictInfo: $('#conflictInfo'),
    keepLocalBtn: $('#keepLocalBtn'),
    keepRemoteBtn: $('#keepRemoteBtn'),
    themeToggle: $('#themeToggle'),
    toast: $('#toast'),
  };

  let pendingConflict = null;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const when = (ms) => (ms ? new Date(ms).toLocaleString('ja-JP') : 'まだありません');

  function render() {
    const s = window.Sync.state;
    const tile = (label, value, klass) =>
      `<div class="stat"><span class="stat-value ${klass ?? ''}">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`;

    el.statusTiles.innerHTML =
      tile('接続しているアカウント', s.account || '未接続')
      + tile('前回の同期', when(s.lastSyncedAt))
      + tile('この端末の最終更新', when(s.localUpdatedAt))
      + tile('この端末', s.deviceName);

    el.clientId.value = s.clientId;
    el.autoSync.checked = s.auto;
    el.originValue.textContent = location.origin;

    const ready = window.Sync.isConfigured();
    el.connectBtn.disabled = !ready;
    el.syncBtn.disabled = !ready;
    el.pushBtn.disabled = !ready;
    el.pullBtn.disabled = !ready;
    el.disconnectBtn.disabled = !window.Sync.isConnected();
    el.restoreBtn.disabled = !window.Sync.hasBackup();

    el.statusNote.textContent = ready
      ? (window.Sync.isConnected()
        ? `${window.Sync.describe(window.Sync.summarize(window.Sync.collect()))} をこの端末に持っています。`
        : '「Googleに接続」を押すと、Googleのログイン画面が出ます。')
      : '下の「最初の設定」を済ませてから接続してください。';
  }

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
  }

  /** 取り込んだあとは、画面の数字を作り直すために読み込み直す。 */
  const reloadSoon = () => setTimeout(() => location.reload(), 900);

  function showConflict(result) {
    pendingConflict = result;
    const row = (title, at, summary) => `
<div class="conflict-side">
  <h3>${esc(title)}</h3>
  <p class="num">${esc(when(at))}</p>
  <p>${esc(window.Sync.describe(summary))}</p>
</div>`;
    el.conflictInfo.innerHTML =
      row(`この端末（${window.Sync.state.deviceName}）`, result.localAt, result.localSummary)
      + row(`Google側（${result.remote?.device ?? '別の端末'}）`, result.remoteAt, result.remoteSummary);
    el.conflictDialog.showModal();
  }

  async function run(label, fn) {
    try {
      const result = await fn();
      render();
      return result;
    } catch (err) {
      console.warn(`${label} に失敗`, err);
      toast(`${label}に失敗しました：${err.message}`);
      render();
      return null;
    }
  }

  function reportSync(result) {
    if (!result) return;
    switch (result.status) {
      case 'pulled': toast('Googleの内容を取り込みました'); reloadSoon(); break;
      case 'pushed': toast('この端末の内容をGoogleへ送りました'); break;
      case 'in-sync': toast('すでに同じ内容です'); break;
      case 'conflict': showConflict(result); break;
      case 'not-configured': toast('先にクライアントIDを保存してください'); break;
      default: break;
    }
  }

  function bind() {
    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    el.saveIdBtn.addEventListener('click', () => {
      const value = el.clientId.value.trim();
      if (value && !/\.apps\.googleusercontent\.com$/.test(value)) {
        toast('クライアントIDは …apps.googleusercontent.com で終わる文字列です');
        return;
      }
      window.Sync.setClientId(value);
      render();
      toast(value ? '保存しました。「Googleに接続」を押してください' : 'クライアントIDを消しました');
    });

    el.copyOriginBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.origin);
        toast('コピーしました');
      } catch {
        toast(`手動でコピーしてください：${location.origin}`);
      }
    });

    el.connectBtn.addEventListener('click', async () => {
      el.connectBtn.disabled = true;
      const result = await run('接続', () => window.Sync.connect());
      el.connectBtn.disabled = false;
      if (result) {
        toast(`${window.Sync.state.account} に接続しました`);
        reportSync(result);
      }
    });

    el.syncBtn.addEventListener('click', async () => {
      const result = await run('同期', () => window.Sync.syncNow({ interactive: false }));
      reportSync(result);
    });

    el.disconnectBtn.addEventListener('click', () => {
      if (!confirm('Googleとの接続を切りますか？\nこの端末のデータはそのまま残ります。')) return;
      window.Sync.disconnect();
      render();
      toast('接続を切りました');
    });

    el.autoSync.addEventListener('change', () => {
      window.Sync.setAuto(el.autoSync.checked);
      toast(el.autoSync.checked ? '自動で同期します' : '自動同期をやめました');
    });

    el.pushBtn.addEventListener('click', async () => {
      if (!confirm('Google側の内容を、この端末の内容で上書きします。よろしいですか？')) return;
      const done = await run('アップロード', () => window.Sync.push());
      if (done) toast('この端末の内容でGoogle側を上書きしました');
    });

    el.pullBtn.addEventListener('click', async () => {
      if (!confirm('この端末の内容を、Google側の内容で上書きします。よろしいですか？\n（上書き前の内容は1世代だけ控えを取ります）')) return;
      const done = await run('ダウンロード', () => window.Sync.pull());
      if (done) { toast('Googleの内容を取り込みました'); reloadSoon(); }
    });

    el.restoreBtn.addEventListener('click', () => {
      if (!confirm('取り込む前の内容に戻しますか？')) return;
      try {
        window.Sync.restoreBackup();
        toast('戻しました');
        reloadSoon();
      } catch (err) {
        toast(err.message);
      }
    });

    el.keepLocalBtn.addEventListener('click', async () => {
      el.conflictDialog.close();
      const done = await run('アップロード', () => window.Sync.push());
      if (done) toast('この端末の内容に揃えました');
      pendingConflict = null;
    });

    el.keepRemoteBtn.addEventListener('click', async () => {
      const remote = pendingConflict?.remote;
      el.conflictDialog.close();
      const done = await run('ダウンロード', () => window.Sync.pull(remote));
      if (done) { toast('Google側の内容に揃えました'); reloadSoon(); }
      pendingConflict = null;
    });

    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => btn.closest('dialog')?.close());
    }
  }

  function applyTheme(theme) {
    const t = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
    el.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  function init() {
    applyTheme(localStorage.getItem(THEME_KEY));
    bind();
    render();

    // 接続済みなら、開いたときに新しいほうへ合わせる
    if (window.Sync.isConfigured()) {
      window.Sync.syncNow({ interactive: false })
        .then((result) => { render(); reportSync(result); })
        .catch((err) => {
          if (!/クライアントID/.test(err.message)) toast(`同期できませんでした：${err.message}`);
        });
    }
  }

  init();
})();
