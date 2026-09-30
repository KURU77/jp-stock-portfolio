/* Google同期のページ。実際の処理は js/sync.js が持っていて、ここは画面だけ。 */
(() => {
  'use strict';

  const THEME_KEY = 'jp-stock-portfolio.theme';
  const $ = (sel) => document.querySelector(sel);

  const el = {
    statusTiles: $('#statusTiles'),
    statusNote: $('#statusNote'),
    inAppWarn: $('#inAppWarn'),
    loginBtn: $('#loginBtn'),
    syncBtn: $('#syncBtn'),
    logoutBtn: $('#logoutBtn'),
    themeToggle: $('#themeToggle'),
    toast: $('#toast'),
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function count(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v.length : 0;
    } catch { return 0; }
  }

  function render() {
    const signedIn = window.Sync.signedIn;
    const tile = (label, value) =>
      `<div class="stat"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`;

    el.statusTiles.innerHTML =
      tile('アカウント', signedIn ? (window.Sync.account || 'ログイン中') : '未ログイン')
      + tile('同期の状態', window.Sync.label())
      + tile('この端末のデータ', `銘柄${count('jp-stock-portfolio.holdings.v1')}件・売却${count('jp-stock-portfolio.sales.v1')}件`)
      + tile('保存先', 'Googleドライブのアプリ専用領域');

    el.loginBtn.textContent = signedIn ? 'ログインし直す' : 'Googleでログイン';
    el.syncBtn.disabled = !signedIn;
    el.logoutBtn.disabled = !signedIn;
    el.inAppWarn.hidden = !window.Sync.inAppBrowser();

    el.statusNote.textContent = signedIn
      ? 'ほかの端末でも同じGoogleアカウントでログインすると、同じ内容になります。'
      : 'ログインすると、この端末のデータとドライブのデータを合わせ、以後は自動で同期します。';
  }

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
  }

  function applyTheme(theme) {
    const t = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
    el.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  function bind() {
    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    el.loginBtn.addEventListener('click', () => window.Sync.login(false));
    el.syncBtn.addEventListener('click', () => window.Sync.syncNow(true));

    el.logoutBtn.addEventListener('click', () => {
      if (!confirm('この端末の同期をやめますか？\nデータはこの端末にもドライブにも残ります。')) return;
      window.Sync.logout();
      render();
      toast('ログアウトしました');
    });

    // 同期の状態が変わったら表示を作り直す
    window.addEventListener('sync:state', render);
  }

  function init() {
    applyTheme(localStorage.getItem(THEME_KEY));
    bind();
    const back = window.Sync.start({
      toast,
      busy: () => false,
      onApplied: () => { render(); toast('ほかの端末の変更を取り込みました'); },
    });
    render();
    // Googleからの戻り先はアプリの入口に固定なので、このページから始めた場合は通らない
    if (back && back !== 'sync.html' && back !== '') location.replace(back);
  }

  init();
})();
