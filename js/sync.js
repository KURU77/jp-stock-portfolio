/* 端末間の同期（Googleドライブのアプリ専用領域）。
 *
 * ・データは本人のGoogleドライブの「アプリ専用フォルダ」（appDataFolder）に
 *   jp-stock-portfolio.json として置く。ドライブの画面には出ず、このアプリ以外からは見えない。
 *   サーバーもSDKも使わず、Drive API を fetch で直接叩く。
 * ・銘柄・売却・買付・積み立ては1件ごとに更新時刻 _u を持ち、削除は墓標（id → 削除時刻）で残す。
 *   同期のたびに双方をマージするので、別々の端末で別の銘柄を直しても両方残る。
 *   同じものを両方で直したときは、後から直したほうが勝つ。
 * ・投資余力は口座ごと、設定は丸ごと1単位で、新しいほうを採る。
 * ・認証はリダイレクト方式（トークンはURLの # で受け取る）。ホーム画面に追加した
 *   iPhoneではポップアップが使えないため。
 * ・GeminiのAPIキー、夜間PTSの手入力、株価のキャッシュ、見た目の設定は同期しない。
 */
window.Sync = (() => {
  'use strict';

  /* このアプリ専用のOAuthクライアント（公開してよい値） */
  const CLIENT_ID = '1088975026923-oq392ecoi9ncqlvsc0qvbpf53ceal68b.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const SYNC_FILE = 'jp-stock-portfolio.json';

  const STATE_KEY = 'jp-stock-portfolio.sync.v1';
  const META_KEY = 'jp-stock-portfolio.syncmeta.v1';
  const OAUTH_KEY = 'jp-stock-portfolio.oauth';
  const SILENT_KEY = 'jp-stock-portfolio.silent-login';

  /** id を持つ一覧（レコード単位でマージする） */
  const LISTS = {
    holdings: 'jp-stock-portfolio.holdings.v1',
    sales: 'jp-stock-portfolio.sales.v1',
    buys: 'jp-stock-portfolio.buys.v1',
    plans: 'jp-stock-portfolio.plans.v1',
  };
  const SNAPSHOTS_KEY = 'jp-stock-portfolio.snapshots.v1';
  const CASH_KEY = 'jp-stock-portfolio.cash.v1';
  const SETTINGS_KEY = 'jp-stock-portfolio.settings.v1';

  /** 同期しないキー（参考としてここに書き出しておく）
   *  jp-stock-portfolio.gemini.v1 / .daily.v1 / .pts.v1 / .theme / .night-view.v1 / .chart-view.v1 */

  const sync = { running: false, again: false, timer: 0, state: 'off', detail: '', justLoggedIn: false, flash: '' };
  let sm = readJSON(STATE_KEY) || {};
  let meta = normalizeMeta(readJSON(META_KEY));
  let applying = false;
  let hooks = { toast: () => {}, busy: () => false, onApplied: () => {} };

  // ---------- 小物 ----------

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量オーバーなら諦める */ }
  }

  const saveSM = () => writeJSON(STATE_KEY, sm);
  const saveMeta = () => writeJSON(META_KEY, meta);

  function normalizeMeta(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    return {
      deleted: m.deleted && typeof m.deleted === 'object' ? m.deleted : {},
      cashU: m.cashU && typeof m.cashU === 'object' ? m.cashU : {},
      settingsU: Number(m.settingsU) || 0,
      shadows: m.shadows && typeof m.shadows === 'object' ? m.shadows : {},
    };
  }

  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const listOf = (key) => {
    const v = readJSON(key);
    return Array.isArray(v) ? v : [];
  };

  const objOf = (key) => {
    const v = readJSON(key);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };

  /** _u を除いた中身の指紋。中身が変わったかどうかの判定に使う */
  function sig(rec) {
    const o = {};
    Object.keys(rec).sort().forEach((k) => { if (k !== '_u') o[k] = rec[k]; });
    return JSON.stringify(o);
  }

  // ---------- 変更の記録（更新時刻と墓標） ----------

  /**
   * 前回の保存から変わったレコードに時刻を押し、消えたレコードは墓標にする。
   * 保存のたびに呼ぶ（同期の反映中は押さない）。
   */
  function stampAll() {
    if (applying) return;
    const now = Date.now();

    for (const [name, key] of Object.entries(LISTS)) {
      const list = listOf(key);
      const shadow = meta.shadows[name] && typeof meta.shadows[name] === 'object' ? meta.shadows[name] : {};
      const next = {};
      let changed = false;

      for (const rec of list) {
        if (!rec || !rec.id) continue;
        const s = sig(rec);
        if (shadow[rec.id] !== s) {
          rec._u = now;
          changed = true;
        } else if (!rec._u) {
          rec._u = 1;
          changed = true;
        }
        next[rec.id] = s;
        // 消したあとに同じidが戻ってきたら、墓標を外す
        if (meta.deleted[rec.id] && meta.deleted[rec.id] < rec._u) delete meta.deleted[rec.id];
      }
      for (const id of Object.keys(shadow)) {
        if (!next[id]) meta.deleted[id] = now;
      }
      meta.shadows[name] = next;
      if (changed) writeJSON(key, list);
    }

    // 記録した資産：日付ごとに時刻を持たせる
    const snaps = listOf(SNAPSHOTS_KEY);
    const snapShadow = meta.shadows.snapshots && typeof meta.shadows.snapshots === 'object' ? meta.shadows.snapshots : {};
    const nextSnap = {};
    let snapChanged = false;
    for (const s of snaps) {
      if (!s || !s.date) continue;
      const fingerprint = sig(s);
      if (snapShadow[s.date] !== fingerprint) { s._u = now; snapChanged = true; }
      else if (!s._u) { s._u = 1; snapChanged = true; }
      nextSnap[s.date] = fingerprint;
    }
    meta.shadows.snapshots = nextSnap;
    if (snapChanged) writeJSON(SNAPSHOTS_KEY, snaps);

    // 投資余力：口座ごとに時刻を持たせる
    const cash = objOf(CASH_KEY);
    const cashShadow = meta.shadows.cash && typeof meta.shadows.cash === 'object' ? meta.shadows.cash : {};
    for (const [account, amount] of Object.entries(cash)) {
      if (cashShadow[account] !== amount) meta.cashU[account] = now;
    }
    meta.shadows.cash = { ...cash };

    // 設定：丸ごと1単位
    const settings = JSON.stringify(objOf(SETTINGS_KEY));
    if (meta.shadows.settings !== settings) {
      meta.settingsU = now;
      meta.shadows.settings = settings;
    }

    saveMeta();
  }

  // ---------- マージ ----------

  function mergeDeleted(a, b) {
    const out = {};
    for (const d of [a || {}, b || {}]) {
      for (const id of Object.keys(d)) out[id] = Math.max(out[id] || 0, Number(d[id]) || 0);
    }
    return out;
  }

  /** id ごとに新しいほうを採り、墓標より古いものは落とす */
  function mergeList(local, remote, deleted) {
    const out = [];
    const byRemote = new Map();
    const used = new Set();
    for (const r of remote || []) if (r && r.id) byRemote.set(r.id, r);
    const alive = (r) => !(deleted[r.id] && deleted[r.id] >= (r._u || 0));

    for (const r of local || []) {
      if (!r || !r.id) continue;
      used.add(r.id);
      const other = byRemote.get(r.id);
      const winner = other && (other._u || 0) > (r._u || 0) ? other : r;
      if (alive(winner)) out.push({ ...winner });
    }
    for (const r of remote || []) {
      if (!r || !r.id || used.has(r.id)) continue;
      if (alive(r)) out.push({ ...r });
    }
    return out;
  }

  /** 記録した資産：日付ごとに新しいほうを採る（消すことはない） */
  function mergeSnapshots(local, remote) {
    const byDate = new Map();
    for (const s of [...(local || []), ...(remote || [])]) {
      if (!s || !s.date) continue;
      const cur = byDate.get(s.date);
      if (!cur || (s._u || 0) > (cur._u || 0)) byDate.set(s.date, { ...s });
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-1830);
  }

  /** 投資余力：口座ごとに、新しく変えたほうを採る */
  function mergeCash(local, localU, remote, remoteU) {
    const cash = {};
    const cashU = {};
    const accounts = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
    for (const account of accounts) {
      const lu = Number(localU?.[account]) || 0;
      const ru = Number(remoteU?.[account]) || 0;
      const useRemote = ru > lu;
      cash[account] = Number((useRemote ? remote : local)?.[account]) || 0;
      cashU[account] = Math.max(lu, ru);
    }
    return { cash, cashU };
  }

  // ---------- ドライブに置くJSON ----------

  /** 比較に使うので、並びとキーの順を毎回そろえる */
  function payload() {
    const sortRecords = (list) => list.slice()
      .sort((x, y) => String(x.id).localeCompare(String(y.id)))
      .map((rec) => {
        const o = {};
        Object.keys(rec).sort().forEach((k) => { o[k] = rec[k]; });
        return o;
      });

    const sorted = (obj) => {
      const o = {};
      Object.keys(obj || {}).sort().forEach((k) => { o[k] = obj[k]; });
      return o;
    };

    return JSON.stringify({
      v: 1,
      app: 'jp-stock-portfolio',
      holdings: sortRecords(listOf(LISTS.holdings)),
      sales: sortRecords(listOf(LISTS.sales)),
      buys: sortRecords(listOf(LISTS.buys)),
      plans: sortRecords(listOf(LISTS.plans)),
      snapshots: listOf(SNAPSHOTS_KEY).slice().sort((a, b) => String(a.date).localeCompare(String(b.date))),
      cash: sorted(objOf(CASH_KEY)),
      cashU: sorted(meta.cashU),
      settings: objOf(SETTINGS_KEY),
      settingsU: meta.settingsU,
      deleted: sorted(meta.deleted),
    });
  }

  /** 同名ファイルが複数できてしまったとき（2台が同時に初回同期した等）にまとめる */
  function mergeRemote(a, b) {
    const deleted = mergeDeleted(a.deleted, b.deleted);
    const cash = mergeCash(a.cash, a.cashU, b.cash, b.cashU);
    const useB = (Number(b.settingsU) || 0) > (Number(a.settingsU) || 0);
    return {
      holdings: mergeList(a.holdings, b.holdings, deleted),
      sales: mergeList(a.sales, b.sales, deleted),
      buys: mergeList(a.buys, b.buys, deleted),
      plans: mergeList(a.plans, b.plans, deleted),
      snapshots: mergeSnapshots(a.snapshots, b.snapshots),
      cash: cash.cash,
      cashU: cash.cashU,
      settings: useB ? b.settings : a.settings,
      settingsU: Math.max(Number(a.settingsU) || 0, Number(b.settingsU) || 0),
      deleted,
    };
  }

  // ---------- 認証（リダイレクト方式） ----------

  const tokenOK = () => !!(sm.token && sm.exp && Date.now() < sm.exp);

  /** 登録してあるリダイレクト先はアプリの入口だけなので、どのページからでもそこへ戻す */
  function redirectURI() {
    return location.origin + location.pathname.replace(/[^/]*$/, '');
  }

  /** LINE・Instagram などのアプリ内ブラウザは Google がログインを拒否する */
  function inAppBrowser() {
    return /Line\/|Instagram|FBAN|FBAV|FB_IAB|MicroMessenger/i.test(navigator.userAgent);
  }

  function login(silent) {
    if (inAppBrowser()) {
      if (!silent) hooks.toast('アプリ内ブラウザではログインできません。Safariで開いてください');
      return;
    }
    const st = uid() + uid();
    try {
      sessionStorage.setItem(OAUTH_KEY, JSON.stringify({
        st,
        silent: !!silent,
        // ログインを始めたページへ戻すため（戻り先はアプリの入口に固定されている）
        back: location.pathname.split('/').pop() || '',
      }));
    } catch { /* 無視 */ }

    const q = {
      client_id: CLIENT_ID,
      redirect_uri: redirectURI(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state: st,
    };
    if (sm.email) q.login_hint = sm.email;
    if (silent) q.prompt = 'none';
    location.href = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(q)}`;
  }

  /** 起動時：Googleから戻ってきたところならトークンを受け取り、URLを掃除する */
  function takeOAuthReturn() {
    const hash = location.hash;
    if (hash.indexOf('access_token=') < 0 && hash.indexOf('error=') < 0) return null;

    const q = new URLSearchParams(hash.replace(/^#\/?/, ''));
    let saved = {};
    try {
      saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY)) || {};
      sessionStorage.removeItem(OAUTH_KEY);
    } catch { saved = {}; }

    if (q.get('state') && q.get('state') === saved.st) {
      if (q.get('access_token')) {
        sm.token = q.get('access_token');
        sm.exp = Date.now() + (Math.max(60, Number(q.get('expires_in')) || 3600) - 120) * 1000;
        sm.signedIn = true;
        sm.needLogin = false;
        saveSM();
        sync.justLoggedIn = true;
      } else if (q.get('error')) {
        sm.needLogin = true;
        saveSM();
        if (!saved.silent) sync.flash = `ログインできませんでした（${q.get('error')}）`;
      }
    }
    // トークンをURLに残さない
    history.replaceState(null, '', location.pathname + location.search);
    return saved.back || '';
  }

  function logout() {
    if (sm.token) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(sm.token)}`, { method: 'POST', mode: 'no-cors' })
        .catch(() => {});
    }
    clearTimeout(sync.timer);
    sm = {};
    saveSM();
    setState('off');
  }

  // ---------- Googleドライブ API ----------

  async function gfetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${sm.token}`, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const err = new Error(`Googleドライブ ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function driveList() {
    let all = [];
    let page = '';
    do {
      const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime)');
      const url = `${DRIVE}?spaces=appDataFolder&pageSize=100&fields=${fields}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
      const json = await (await gfetch(url)).json();
      all = all.concat(json.files || []);
      page = json.nextPageToken || '';
    } while (page);
    return all;
  }

  const driveGetJSON = async (id) => (await gfetch(`${DRIVE}/${id}?alt=media`)).json();

  async function driveCreate(name, body) {
    const boundary = `jpstock${uid()}`;
    const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });
    const blob = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`, body, `\r\n--${boundary}--`,
    ]);
    return (await gfetch(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: blob,
    })).json();
  }

  const driveUpdate = (id, body) => gfetch(`${UPLOAD}/${id}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  async function driveDelete(id) {
    try {
      await gfetch(`${DRIVE}/${id}`, { method: 'DELETE' });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  const driveAbout = async () =>
    (await gfetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)')).json();

  // ---------- 同期の本体 ----------

  function setState(state, detail) {
    sync.state = state;
    sync.detail = detail || '';
    window.dispatchEvent(new CustomEvent('sync:state', { detail: { state, detail: sync.detail } }));
  }

  function label() {
    const ago = sm.last ? `（${agoLabel(sm.last)}）` : '';
    return {
      off: 'ログインしていません',
      ok: `同期済み${ago}`,
      syncing: '同期中…',
      login: '再ログインが必要です',
      error: `同期できませんでした：${sync.detail}`,
      offline: 'オフライン（つながったら同期します）',
    }[sync.state] || '';
  }

  function agoLabel(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'たった今';
    if (m < 60) return `${m}分前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}時間前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function scheduleSync(ms) {
    if (!sm.signedIn || applying) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => syncNow(false), ms == null ? 3000 : ms);
  }

  /** 保存のたびに呼ぶ。時刻を押して、少し待ってから同期する */
  function markDirty() {
    stampAll();
    scheduleSync();
  }

  async function syncNow(interactive) {
    if (!sm.signedIn) { if (interactive) login(false); return; }
    if (!tokenOK()) {
      if (interactive) login(false);
      else setState('login');
      return;
    }
    if (!navigator.onLine) { setState('offline'); return; }
    if (sync.running) { sync.again = true; return; }
    if (hooks.busy()) { scheduleSync(4000); return; }

    sync.running = true;
    setState('syncing');
    try {
      const files = (await driveList()).filter((f) => f.name === SYNC_FILE);
      let remote = null;
      for (const f of files) {
        const data = await driveGetJSON(f.id);
        remote = remote ? mergeRemote(remote, data) : data;
      }

      if (remote) {
        if (hooks.busy()) { const e = new Error('busy'); e.busy = true; throw e; }
        stampAll(); // まだ時刻を押していない手元の変更を先に確定させる

        const before = payload();
        const deleted = mergeDeleted(meta.deleted, remote.deleted);
        const cash = mergeCash(objOf(CASH_KEY), meta.cashU, remote.cash, remote.cashU);
        const useRemoteSettings = (Number(remote.settingsU) || 0) > meta.settingsU;

        applying = true;
        try {
          for (const [name, key] of Object.entries(LISTS)) {
            writeJSON(key, mergeList(listOf(key), remote[name], deleted));
          }
          writeJSON(SNAPSHOTS_KEY, mergeSnapshots(listOf(SNAPSHOTS_KEY), remote.snapshots));
          writeJSON(CASH_KEY, cash.cash);
          if (useRemoteSettings && remote.settings && typeof remote.settings === 'object') {
            // APIキーなどは元から入っていないが、念のため手元の値を土台にして上書きする
            writeJSON(SETTINGS_KEY, { ...objOf(SETTINGS_KEY), ...remote.settings });
          }
          meta.deleted = deleted;
          meta.cashU = cash.cashU;
          meta.settingsU = Math.max(meta.settingsU, Number(remote.settingsU) || 0);
          saveMeta();
          // 取り込んだ内容を「変更なし」として覚え直す（次の同期で押し直さないため）
          rebuildShadows();
        } finally {
          applying = false;
        }

        if (payload() !== before) hooks.onApplied();
      }

      const mine = payload();
      if (!files.length) await driveCreate(SYNC_FILE, mine);
      else if (files.length > 1 || mine !== JSON.stringify(normalizeRemote(remote))) await driveUpdate(files[0].id, mine);
      for (const f of files.slice(1)) await driveDelete(f.id);

      sm.last = Date.now();
      saveSM();
      setState('ok');
      if (interactive) hooks.toast('同期しました');
    } catch (err) {
      if (err.busy) {
        scheduleSync(4000);
        setState('ok');
      } else if (err.status === 401 || err.status === 403) {
        sm.token = '';
        sm.exp = 0;
        saveSM();
        setState('login');
        if (interactive) login(false);
      } else if (!navigator.onLine) {
        setState('offline');
      } else {
        console.warn('同期に失敗しました', err);
        setState('error', err.message || '通信エラー');
      }
    } finally {
      sync.running = false;
      if (sync.again) { sync.again = false; scheduleSync(500); }
    }
  }

  /** ドライブ側の中身を、手元と同じ並びのJSONにして比べられるようにする */
  function normalizeRemote(remote) {
    if (!remote) return null;
    const sorted = (obj) => {
      const o = {};
      Object.keys(obj || {}).sort().forEach((k) => { o[k] = obj[k]; });
      return o;
    };
    const sortRecords = (list) => (list || []).slice()
      .sort((x, y) => String(x.id).localeCompare(String(y.id)))
      .map((rec) => {
        const o = {};
        Object.keys(rec).sort().forEach((k) => { o[k] = rec[k]; });
        return o;
      });
    return {
      v: 1,
      app: 'jp-stock-portfolio',
      holdings: sortRecords(remote.holdings),
      sales: sortRecords(remote.sales),
      buys: sortRecords(remote.buys),
      plans: sortRecords(remote.plans),
      snapshots: (remote.snapshots || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date))),
      cash: sorted(remote.cash),
      cashU: sorted(remote.cashU),
      settings: remote.settings || {},
      settingsU: Number(remote.settingsU) || 0,
      deleted: sorted(remote.deleted),
    };
  }

  /** いまの中身を「変更なし」として覚え直す */
  function rebuildShadows() {
    for (const [name, key] of Object.entries(LISTS)) {
      const shadow = {};
      for (const rec of listOf(key)) if (rec && rec.id) shadow[rec.id] = sig(rec);
      meta.shadows[name] = shadow;
    }
    const snapShadow = {};
    for (const s of listOf(SNAPSHOTS_KEY)) if (s && s.date) snapShadow[s.date] = sig(s);
    meta.shadows.snapshots = snapShadow;
    meta.shadows.cash = { ...objOf(CASH_KEY) };
    meta.shadows.settings = JSON.stringify(objOf(SETTINGS_KEY));
    saveMeta();
  }

  /** ページを開いたときの入り口。戻り先のページ名を返す（あれば呼び出し側で移動する） */
  function start(options = {}) {
    hooks = { ...hooks, ...options };
    const back = takeOAuthReturn();

    if (sync.flash) { hooks.toast(sync.flash); sync.flash = ''; }
    setState(sm.signedIn ? (tokenOK() ? 'ok' : 'login') : 'off');

    // 初回は影が無いので、stampAll がすべてのレコードに時刻を押す。
    // ここで rebuildShadows を使うと「変更なし」と覚えてしまい、_u が入らないまま
    // ドライブへ上がって、他の端末との比較で必ず負ける側になる。
    if (!meta.shadows.holdings) stampAll();

    if (sm.signedIn) {
      if (sync.justLoggedIn) {
        sync.justLoggedIn = false;
        driveAbout().then((about) => {
          if (about.user) {
            sm.email = about.user.emailAddress;
            sm.name = about.user.displayName;
            saveSM();
            window.dispatchEvent(new CustomEvent('sync:state', { detail: { state: sync.state, detail: sync.detail } }));
          }
        }).catch(() => {});
        hooks.toast('ログインしました。同期します');
        syncNow(false);
      } else if (tokenOK()) {
        syncNow(false);
      } else {
        // トークン切れ：オンラインなら黙って取り直しに行く（10分に1回まで）
        const last = Number(localStorage.getItem(SILENT_KEY)) || 0;
        if (navigator.onLine && !sm.needLogin && Date.now() - last > 10 * 60000) {
          try { localStorage.setItem(SILENT_KEY, String(Date.now())); } catch { /* 無視 */ }
          login(true);
        } else {
          setState('login');
        }
      }
    }

    window.addEventListener('online', () => { if (sm.signedIn) scheduleSync(500); });
    return back;
  }

  return {
    CLIENT_ID,
    SYNC_FILE,
    start,
    login,
    logout,
    syncNow,
    markDirty,
    scheduleSync,
    label,
    agoLabel,
    inAppBrowser,
    redirectURI,
    get status() { return { ...sync }; },
    get account() { return sm.email || ''; },
    get signedIn() { return !!sm.signedIn; },
    get lastSyncedAt() { return sm.last || 0; },
    isConfigured: () => true,
  };
})();
