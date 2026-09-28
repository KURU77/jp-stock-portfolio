/* Googleアカウントでの端末間同期。
 *
 * サーバーを持たないアプリなので、データの置き場は「利用者自身のGoogleドライブ」です。
 * アプリが作ったファイル1つだけを読み書きする drive.file スコープを使うので、
 * ドライブの他のファイルには触れません。作者や第三者のサーバーは経由しません。
 *
 * ・ログインは Google Identity Services（トークン方式）。合言葉やパスワードは扱いません。
 * ・同期するのは保有銘柄・売買・積み立て・投資余力・記録した資産・設定まで。
 *   GeminiのAPIキーや、端末ごとの表示設定、株価のキャッシュは同期しません。
 * ・衝突（両方の端末で変更）したときは勝手に混ぜず、どちらを残すか選んでもらいます。
 */
window.Sync = (() => {
  'use strict';

  const STATE_KEY = 'jp-stock-portfolio.sync.v1';
  const BACKUP_KEY = 'jp-stock-portfolio.sync-backup.v1';
  const FILE_NAME = 'jp-stock-portfolio-sync.json';

  /** 同期する localStorage のキー。APIキーや端末固有の設定は入れない。 */
  const SYNC_KEYS = [
    'jp-stock-portfolio.holdings.v1',
    'jp-stock-portfolio.cash.v1',
    'jp-stock-portfolio.sales.v1',
    'jp-stock-portfolio.buys.v1',
    'jp-stock-portfolio.plans.v1',
    'jp-stock-portfolio.snapshots.v1',
    'jp-stock-portfolio.settings.v1',
  ];

  const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  /** @type {{value: string, expiresAt: number}|null} アクセストークン（メモリだけに置く） */
  let token = null;
  let pushTimer = null;
  let busy = false;

  let state = load();

  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') ?? {}; } catch { saved = {}; }
    return Object.assign({
      clientId: '',
      fileId: '',
      account: '',
      auto: true,
      lastSyncedAt: 0,
      localUpdatedAt: 0,
      deviceName: guessDeviceName(),
    }, saved);
  }

  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* 容量オーバーなら諦める */ }
  }

  function guessDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Mac OS X/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    return 'この端末';
  }

  // ---------- Google の認証 ----------

  async function ensureGis() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Googleのログイン用スクリプトを読み込めませんでした（通信環境を確認してください）'));
      document.head.appendChild(s);
    });
  }

  const tokenAlive = () => token && token.expiresAt > Date.now() + 60_000;

  /**
   * 認証の失敗を、そのまま出しても分からない文言から、次の行動が分かる文言に置き換える。
   * 自動更新のときは（操作していないので）ポップアップが開けず、この形で失敗する。
   */
  function friendlyAuthError(err) {
    const message = String(err?.message ?? '');
    if (/popup|interaction_required|consent|access_denied/i.test(message)) {
      return new Error('Googleへの接続が必要です。同期ページの「Googleに接続」を押してサインインしてください。');
    }
    return err instanceof Error ? err : new Error(message || 'Googleの認証に失敗しました');
  }

  /**
   * アクセストークンを取る。
   * @param {boolean} interactive true なら同意画面を出す（ボタン操作からのみ呼ぶこと）
   */
  async function getToken(interactive) {
    if (tokenAlive()) return token.value;
    if (!state.clientId) throw new Error('GoogleのクライアントIDが設定されていません');
    await ensureGis();

    try {
      return await requestAccessToken(interactive);
    } catch (err) {
      throw friendlyAuthError(err);
    }
  }

  function requestAccessToken(interactive) {
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: state.clientId,
        scope: SCOPES,
        // 初回はどのアカウントで入るか選んでもらう。以降は黙って更新を試みる。
        prompt: interactive ? 'consent' : '',
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error));
            return;
          }
          token = {
            value: resp.access_token,
            expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
          };
          resolve(token.value);
        },
        error_callback: (err) => reject(new Error(err?.message || err?.type || 'Googleの認証に失敗しました')),
      });
      try {
        client.requestAccessToken();
      } catch (err) {
        reject(err);
      }
    });
  }

  async function fetchAccount() {
    try {
      const res = await api('https://www.googleapis.com/oauth2/v3/userinfo');
      const me = await res.json();
      state.account = me.email || '';
      save();
    } catch { /* 表示用なので、取れなくても同期はできる */ }
  }

  // ---------- ドライブの読み書き ----------

  async function api(url, options = {}) {
    const access = await getToken(false);
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${access}`, ...(options.headers ?? {}) },
    });
    if (res.status === 401) {
      token = null;
      throw new Error('Googleの接続が切れました。もう一度「Googleに接続」を押してください。');
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        message = body?.error?.message || message;
      } catch { /* 本文が読めないときはステータスだけ */ }
      throw new Error(message);
    }
    return res;
  }

  /** 同期用ファイルを探す。drive.file なのでこのアプリが作ったものしか見えない。 */
  async function findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await api(`${DRIVE}/files?q=${q}&fields=files(id,name,modifiedTime,size)&pageSize=10`);
    const body = await res.json();
    const file = (body.files ?? [])[0] ?? null;
    if (file) {
      state.fileId = file.id;
      save();
    }
    return file;
  }

  async function readRemote() {
    if (!state.fileId) {
      const file = await findFile();
      if (!file) return null;
    }
    try {
      const res = await api(`${DRIVE}/files/${state.fileId}?alt=media`);
      return await res.json();
    } catch (err) {
      // ファイルが消されていたら探し直す
      if (/404|not found/i.test(err.message)) {
        state.fileId = '';
        save();
        const file = await findFile();
        if (!file) return null;
        const res = await api(`${DRIVE}/files/${state.fileId}?alt=media`);
        return await res.json();
      }
      throw err;
    }
  }

  async function writeRemote(payload) {
    const body = JSON.stringify(payload, null, 2);
    if (state.fileId) {
      await api(`${UPLOAD}/files/${state.fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return state.fileId;
    }

    // 初回はメタデータと中身をまとめて送る（multipart）
    const boundary = `sync-${Date.now()}`;
    const metadata = { name: FILE_NAME, mimeType: 'application/json', description: '日本株ポートフォリオの同期データ' };
    const multipart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      body,
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    const created = await res.json();
    state.fileId = created.id;
    save();
    return created.id;
  }

  // ---------- データの受け渡し ----------

  function collect() {
    const data = {};
    for (const key of SYNC_KEYS) {
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      // ドライブ上で中身が読めるように、できればJSONのまま入れる
      try { data[key] = JSON.parse(raw); } catch { data[key] = raw; }
    }
    return data;
  }

  function apply(data) {
    // 上書きする前に、この端末の内容を1世代だけ残しておく
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: Date.now(), data: collect() }));
    } catch { /* 容量が足りなければ諦める */ }

    for (const key of SYNC_KEYS) {
      const value = data?.[key];
      if (value === undefined) { localStorage.removeItem(key); continue; }
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  function payloadOf() {
    return {
      app: 'jp-stock-portfolio',
      version: 1,
      updatedAt: state.localUpdatedAt || Date.now(),
      device: state.deviceName,
      savedAt: new Date().toISOString(),
      data: collect(),
    };
  }

  /** 中身のざっくりした件数（どちらを残すか選ぶときの手がかり） */
  function summarize(data) {
    const count = (key) => {
      const v = data?.[key];
      if (Array.isArray(v)) return v.length;
      if (typeof v === 'string') { try { return JSON.parse(v).length ?? 0; } catch { return 0; } }
      return 0;
    };
    return {
      holdings: count('jp-stock-portfolio.holdings.v1'),
      sales: count('jp-stock-portfolio.sales.v1'),
      buys: count('jp-stock-portfolio.buys.v1'),
      plans: count('jp-stock-portfolio.plans.v1'),
    };
  }

  const describe = (s) => `銘柄${s.holdings}件・売却${s.sales}件・買付${s.buys}件・積立${s.plans}件`;

  // ---------- 同期の本体 ----------

  async function push() {
    const payload = payloadOf();
    await writeRemote(payload);
    state.lastSyncedAt = payload.updatedAt;
    save();
    return payload;
  }

  async function pull(remote) {
    const data = remote ?? await readRemote();
    if (!data) throw new Error('Google側にまだデータがありません');
    apply(data.data ?? {});
    state.lastSyncedAt = Number(data.updatedAt) || Date.now();
    state.localUpdatedAt = state.lastSyncedAt;
    save();
    return data;
  }

  /**
   * 自動同期。新しいほうへ合わせる。
   * 両方が前回同期のあとに変わっていたら、勝手に混ぜずに結果を返して呼び出し側に判断を委ねる。
   */
  async function syncNow({ interactive = false } = {}) {
    if (busy) return { status: 'busy' };
    busy = true;
    try {
      if (!state.clientId) return { status: 'not-configured' };
      await getToken(interactive);
      if (!state.account) await fetchAccount();

      const remote = await readRemote();
      const localAt = state.localUpdatedAt || 0;
      const remoteAt = Number(remote?.updatedAt) || 0;

      if (!remote) {
        await push();
        return { status: 'pushed', reason: 'first' };
      }
      if (remoteAt === localAt) return { status: 'in-sync' };

      const localChanged = localAt > state.lastSyncedAt;
      const remoteChanged = remoteAt > state.lastSyncedAt;

      if (localChanged && remoteChanged) {
        return {
          status: 'conflict',
          remote,
          localAt,
          remoteAt,
          localSummary: summarize(collect()),
          remoteSummary: summarize(remote.data ?? {}),
        };
      }
      if (remoteAt > localAt) {
        await pull(remote);
        return { status: 'pulled', remote };
      }
      await push();
      return { status: 'pushed' };
    } finally {
      busy = false;
    }
  }

  // ---------- 外から使うもの ----------

  /** データが変わったことを知らせる。少し待ってからまとめてアップロードする。 */
  function markDirty() {
    state.localUpdatedAt = Date.now();
    save();
    if (!state.clientId || !state.auto) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        if (!tokenAlive()) await getToken(false);
        await push();
        window.dispatchEvent(new CustomEvent('sync:done', { detail: { status: 'pushed' } }));
      } catch (err) {
        console.warn('自動アップロードに失敗しました', err);
        window.dispatchEvent(new CustomEvent('sync:error', { detail: { message: err.message } }));
      }
    }, 4000);
  }

  /** ページを開いたときの取り込み。衝突したときは何もせずに知らせるだけ。 */
  async function start() {
    if (!state.clientId || !state.auto) return { status: 'off' };
    try {
      const result = await syncNow({ interactive: false });
      window.dispatchEvent(new CustomEvent('sync:done', { detail: result }));
      return result;
    } catch (err) {
      window.dispatchEvent(new CustomEvent('sync:error', { detail: { message: err.message } }));
      return { status: 'error', message: err.message };
    }
  }

  async function connect() {
    if (!state.clientId) throw new Error('先にクライアントIDを保存してください');
    token = null;
    await getToken(true);
    await fetchAccount();
    return syncNow({ interactive: false });
  }

  function disconnect() {
    if (token?.value && window.google?.accounts?.oauth2) {
      try { google.accounts.oauth2.revoke(token.value); } catch { /* 失敗しても手元は消す */ }
    }
    token = null;
    state.account = '';
    state.fileId = '';
    state.lastSyncedAt = 0;
    save();
  }

  function setClientId(value) {
    state.clientId = String(value ?? '').trim();
    token = null;
    save();
  }

  function setAuto(value) {
    state.auto = !!value;
    save();
  }

  function restoreBackup() {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) throw new Error('この端末に控えはありません');
    const backup = JSON.parse(raw);
    apply(backup.data ?? {});
    state.localUpdatedAt = Date.now();
    save();
    return backup;
  }

  return {
    SYNC_KEYS,
    FILE_NAME,
    get state() { return { ...state }; },
    isConfigured: () => !!state.clientId,
    isConnected: () => !!state.account,
    setClientId,
    setAuto,
    connect,
    disconnect,
    syncNow,
    push,
    pull,
    start,
    markDirty,
    summarize,
    describe,
    collect,
    restoreBackup,
    hasBackup: () => !!localStorage.getItem(BACKUP_KEY),
  };
})();
