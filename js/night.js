/* 夜間PTS・場中の値動きページ。
 *
 * ・保有銘柄はポートフォリオ本体（localStorage）から読むだけで、こちらからは書き換えない。
 * ・ザラ場（東証）の値動きは Yahoo Finance の5分足を取得して表示する。
 * ・夜間PTSの株価は手入力。銘柄別のPTS株価を自動で取れる無料の窓口が無いため
 *   （株探・Yahoo!ファイナンスは中継サービスをbot判定でブロック、PTS運営元の
 *   ジャパンネクスト証券は掲載情報の再利用を禁止）、回避はせず手入力にしている。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'jp-stock-portfolio.holdings.v1';
  const SETTINGS_KEY = 'jp-stock-portfolio.settings.v1';
  const THEME_KEY = 'jp-stock-portfolio.theme';
  const PTS_KEY = 'jp-stock-portfolio.pts.v1';
  const VIEW_KEY = 'jp-stock-portfolio.night-view.v1';

  /** 東証とジャパンネクストPTSの時間割（JSTの「その日の何分目か」）。 */
  const SESSIONS = [
    { id: 'morning', label: '前場', from: 540, to: 690 },         // 9:00-11:30
    { id: 'lunch', label: '昼休み', from: 690, to: 750 },          // 11:30-12:30
    { id: 'afternoon', label: '後場', from: 750, to: 930 },        // 12:30-15:30
    { id: 'closing', label: '東証クローズ', from: 930, to: 990 },   // 15:30-16:30
    { id: 'night', label: '夜間PTS', from: 990, to: 1440 + 360 },  // 16:30-翌6:00
  ];

  const ACCOUNT_SHORT = {
    tokutei: '特定', 'nisa-growth': 'NISA成長', 'nisa-tsumitate': 'NISAつみたて', ippan: '一般',
  };

  const $ = (sel) => document.querySelector(sel);

  const el = {
    list: $('#nightList'),
    empty: $('#empty'),
    sortBy: $('#sortBy'),
    onlyPts: $('#onlyPts'),
    clearPtsBtn: $('#clearPtsBtn'),
    refreshBtn: $('#refreshBtn'),
    themeToggle: $('#themeToggle'),
    updatedLine: $('#updatedLine'),
    sessionBadge: $('#sessionBadge'),
    sessionClock: $('#sessionClock'),
    sessionNext: $('#sessionNext'),
    sessionTrack: $('#sessionTrack'),
    toast: $('#toast'),
  };

  /** @type {Array<object>} ポートフォリオ本体の保有データ */
  let holdings = [];
  /** @type {Map<string, object>} コード → 当日5分足 */
  const intraday = new Map();
  /** @type {{date: string, prices: Record<string, number>}} */
  let pts = { date: '', prices: {} };
  let settings = {};
  let view = { sort: 'move', onlyPts: false };

  // ---------- 読み書き ----------

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      holdings = JSON.parse(raw || '[]');
      if (!Array.isArray(holdings)) holdings = [];
    } catch { holdings = []; }

    try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { settings = {}; }
    if (settings.relay) window.Quotes.setCustomRelay(settings.relay);

    try { view = Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); } catch { /* 既定のまま */ }

    try {
      const saved = JSON.parse(localStorage.getItem(PTS_KEY) || 'null');
      // 夜間セッションが変わっていたら、前の晩の入力は捨てる。
      pts = saved && saved.date === sessionDate() ? saved : { date: sessionDate(), prices: {} };
    } catch { pts = { date: sessionDate(), prices: {} }; }
  }

  const savePts = () => localStorage.setItem(PTS_KEY, JSON.stringify(pts));
  const saveView = () => localStorage.setItem(VIEW_KEY, JSON.stringify(view));

  // ---------- 時刻まわり（すべてJSTで考える） ----------

  /** JSTの「いま」を UTC メソッドで読めるようにずらした Date */
  function jstNow() {
    return new Date(Date.now() + 9 * 3600 * 1000);
  }

  function jstMinutes() {
    const d = jstNow();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  /**
   * 夜間セッションの帰属日。深夜0時〜6時は前日の夜のつづきなので、前日の日付にする。
   * これで日付が変わってもPTSの入力が消えない。
   */
  function sessionDate() {
    const d = jstNow();
    if (d.getUTCHours() < 6) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  function currentSession() {
    const min = jstMinutes();
    const dow = jstNow().getUTCDay();
    // 土曜の朝6時までは金曜の夜のつづき。それ以外の土日は休み。
    const weekendClosed = dow === 0 || (dow === 6 && min >= 360);
    if (weekendClosed) return { id: 'weekend', label: '週末（お休み）', from: null, to: null };
    if (min < 360) return { id: 'night', label: '夜間PTS', from: 990 - 1440, to: 360 };
    for (const s of SESSIONS) if (min >= s.from && min < s.to) return s;
    return { id: 'pre', label: '寄り付き前', from: 360, to: 540 };
  }

  const two = (n) => String(n).padStart(2, '0');
  const hhmm = (min) => `${two(Math.floor((min % 1440) / 60))}:${two(min % 60)}`;

  function renderSession() {
    const d = jstNow();
    el.sessionClock.textContent = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;

    const s = currentSession();
    el.sessionBadge.textContent = s.label;
    el.sessionBadge.className = `session-badge is-${s.id}`;

    if (s.to == null) {
      el.sessionNext.textContent = '次の取引は月曜の前場（9:00）からです。';
    } else {
      const min = jstMinutes();
      const secLeft = (s.to - min) * 60 - d.getUTCSeconds();
      const h = Math.floor(secLeft / 3600);
      const m = Math.floor((secLeft % 3600) / 60);
      const label = s.id === 'night' ? '夜間PTSの終了' : `${s.label}の終了`;
      el.sessionNext.textContent = `${label}（${hhmm(s.to)}）まで あと ${h > 0 ? `${h}時間` : ''}${m}分`;
    }

    // 一日の帯（前場・昼休み・後場・夜間）のどこにいるかを塗る
    const min = jstMinutes();
    el.sessionTrack.innerHTML = SESSIONS.map((seg) => {
      const width = ((seg.to - seg.from) / (1440 + 360 - 540)) * 100;
      const done = min >= seg.to ? 100 : min <= seg.from ? 0 : ((min - seg.from) / (seg.to - seg.from)) * 100;
      return `<div class="track-seg is-${seg.id}" style="flex:${width}" title="${esc(seg.label)} ${hhmm(seg.from)}-${hhmm(seg.to)}"><span style="width:${done}%"></span></div>`;
    }).join('');
  }

  // ---------- 表示のためのフォーマット ----------

  const yen = (n, digits = 0) =>
    n == null || !Number.isFinite(n)
      ? '—'
      : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('ja-JP', { maximumFractionDigits: digits })}円`;

  const signedYen = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${yen(n)}`);
  const signedPct = (r) => (r == null || !Number.isFinite(r) ? '—' : `${r > 0 ? '+' : ''}${(r * 100).toFixed(2)}%`);
  const cls = (n) => (n == null || !Number.isFinite(n) ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function timeOf(sec) {
    if (!sec) return '';
    const d = new Date((sec + 9 * 3600) * 1000);
    return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  }

  // ---------- 銘柄ごとの計算 ----------

  /** 同じ銘柄を複数の口座で持っている場合はまとめる（PTSの株価は口座で変わらないため）。 */
  function rows() {
    const byCode = new Map();
    for (const h of holdings) {
      const code = String(h.code || '').toUpperCase();
      if (!code) continue;
      const shares = Number(h.shares) || 0;
      const cur = byCode.get(code) ?? {
        code,
        name: h.name || code,
        shares: 0,
        accounts: [],
        quote: h.quote ?? null,
      };
      cur.shares += shares;
      const label = ACCOUNT_SHORT[h.account] ?? '特定';
      if (shares > 0 && !cur.accounts.includes(label)) cur.accounts.push(label);
      if (!cur.quote && h.quote) cur.quote = h.quote;
      byCode.set(code, cur);
    }

    const list = [...byCode.values()].map((r) => {
      const intr = intraday.get(r.code) ?? null;
      const prevClose = intr?.prevClose ?? r.quote?.prevClose ?? null;
      const last = intr?.last ?? r.quote?.price ?? null;
      const morningClose = intr?.morningClose ?? null;
      const ptsPrice = Number.isFinite(pts.prices[r.code]) ? pts.prices[r.code] : null;

      const dayDiff = last != null && prevClose != null ? last - prevClose : null;
      const pmDiff = last != null && morningClose != null ? last - morningClose : null;
      const ptsDiff = ptsPrice != null && last != null ? ptsPrice - last : null;

      return {
        ...r,
        intr,
        prevClose,
        last,
        morningClose,
        ptsPrice,
        dayDiff,
        dayRate: dayDiff != null && prevClose ? dayDiff / prevClose : null,
        dayPl: dayDiff != null ? dayDiff * r.shares : null,
        pmDiff,
        pmRate: pmDiff != null && morningClose ? pmDiff / morningClose : null,
        pmPl: pmDiff != null ? pmDiff * r.shares : null,
        ptsDiff,
        ptsRate: ptsDiff != null && last ? ptsDiff / last : null,
        ptsPl: ptsDiff != null ? ptsDiff * r.shares : null,
        value: (ptsPrice ?? last) != null ? (ptsPrice ?? last) * r.shares : null,
      };
    });

    const sorted = list.sort((a, b) => {
      switch (view.sort) {
        case 'pts': return Math.abs(b.ptsRate ?? -1) - Math.abs(a.ptsRate ?? -1);
        case 'value': return (b.value ?? 0) - (a.value ?? 0);
        case 'code': return a.code.localeCompare(b.code);
        case 'move':
        default: return Math.abs(b.dayRate ?? -1) - Math.abs(a.dayRate ?? -1);
      }
    });

    return view.onlyPts ? sorted.filter((r) => r.ptsPrice != null) : sorted;
  }

  // ---------- 描画 ----------

  function render() {
    const all = rows();
    el.empty.hidden = holdings.length > 0;

    renderStats();
    el.list.innerHTML = all.length
      ? all.map(cardHtml).join('')
      : (holdings.length ? '<p class="empty">PTSを入力した銘柄がありません。</p>' : '');

    const stamps = [...intraday.values()].map((i) => i.fetchedAt).filter(Boolean);
    el.updatedLine.hidden = !stamps.length;
    if (stamps.length) {
      el.updatedLine.textContent =
        `ザラ場データの取得：${new Date(Math.max(...stamps)).toLocaleTimeString('ja-JP')}`
        + '／出所：Yahoo Finance（15〜20分の遅延あり・夜間PTSは含まれません）';
    }
  }

  function renderStats() {
    let dayPl = 0, pmPl = 0, ptsPl = 0, value = 0;
    let hasDay = false, hasPm = false, ptsCount = 0;
    for (const r of rows()) {
      if (r.dayPl != null) { dayPl += r.dayPl; hasDay = true; }
      if (r.pmPl != null) { pmPl += r.pmPl; hasPm = true; }
      if (r.ptsPl != null) { ptsPl += r.ptsPl; ptsCount++; }
      if (r.value != null) value += r.value;
    }

    const set = (id, n, extra) => {
      const node = $(id);
      node.className = `stat-value ${cls(n)}`;
      node.innerHTML = n == null ? '—' : `${esc(signedYen(n))}${extra ? `<span class="sub">${esc(extra)}</span>` : ''}`;
    };

    set('#statDay', hasDay ? dayPl : null);
    set('#statAfternoon', hasPm ? pmPl : null);
    set('#statPts', ptsCount ? ptsPl : null);
    $('#statPtsLabel').textContent = ptsCount ? `夜間PTS（${ptsCount}銘柄を入力済み）` : '夜間PTS（東証終値比）';

    const total = $('#statTotal');
    total.className = 'stat-value';
    total.textContent = value ? yen(value) : '—';
  }

  /** 5分足のミニチャート。前場と後場を別の線にして、昼休みの切れ目が分かるようにする。 */
  function sparkline(r) {
    const points = r.intr?.points ?? [];
    if (points.length < 2) return '<div class="spark-none">当日の値動きは未取得です</div>';

    const W = 300, H = 64, PAD = 4;
    const values = points.map((p) => p.c);
    if (r.prevClose != null) values.push(r.prevClose);
    if (r.ptsPrice != null) values.push(r.ptsPrice);
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = (v) => PAD + (1 - (v - min) / span) * (H - PAD * 2);

    const cut = r.intr.afternoonIndex;
    const toPath = (from, to) => points.slice(from, to).map((p, i) => `${x(from + i).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
    const morning = cut > 0 ? toPath(0, cut) : toPath(0, points.length);
    const afternoon = cut > 0 ? toPath(cut, points.length) : '';

    const stroke = r.dayDiff == null || r.dayDiff === 0
      ? 'var(--text-muted)'
      : r.dayDiff > 0 ? 'var(--up)' : 'var(--down)';
    const baseY = r.prevClose != null ? y(r.prevClose).toFixed(1) : null;
    const ptsY = r.ptsPrice != null ? y(r.ptsPrice).toFixed(1) : null;

    return `
<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="当日の値動き（5分足）">
  ${baseY ? `<line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>` : ''}
  ${ptsY ? `<line x1="0" y1="${ptsY}" x2="${W}" y2="${ptsY}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="2 2" opacity=".8"/>` : ''}
  <polyline points="${morning}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
  ${afternoon ? `<polyline points="${afternoon}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` : ''}
</svg>`;
  }

  function cardHtml(r) {
    const badges = r.accounts.map((a) => `<span class="badge">${esc(a)}</span>`).join('');
    const ptsValue = r.ptsPrice != null ? String(r.ptsPrice) : '';

    return `
<article class="card night-card" data-code="${esc(r.code)}">
  <div class="card-top">
    <h3 class="card-title">${esc(r.name)}
      <span class="card-code">${badges} ${esc(r.code)} ・ ${r.shares.toLocaleString('ja-JP')}株</span>
    </h3>
    <div class="price-box">
      <span class="price-now">${r.last == null ? '—' : esc(r.last.toLocaleString('ja-JP', { maximumFractionDigits: 1 }))}<span style="font-size:.7em">円</span></span>
      <span class="price-chg ${cls(r.dayDiff)}">${r.dayDiff == null ? '' : `${r.dayDiff > 0 ? '+' : ''}${esc(r.dayDiff.toLocaleString('ja-JP', { maximumFractionDigits: 1 }))}（${esc(signedPct(r.dayRate))}）`}</span>
      <span class="price-stale">${r.intr ? `${esc(timeOf(r.intr.lastTime))} 東証` : '当日足なし'}</span>
    </div>
  </div>

  ${sparkline(r)}

  <div class="kv kv-4">
    <div><p class="k">前日終値</p><p class="v">${esc(yen(r.prevClose, 1))}</p></div>
    <div><p class="k">寄付</p><p class="v">${esc(yen(r.intr?.open, 1))}</p></div>
    <div><p class="k">前引</p><p class="v">${esc(yen(r.morningClose, 1))}</p></div>
    <div><p class="k">後場寄</p><p class="v">${esc(yen(r.intr?.afternoonOpen, 1))}</p></div>
    <div><p class="k">高値</p><p class="v">${esc(yen(r.intr?.high, 1))}</p></div>
    <div><p class="k">安値</p><p class="v">${esc(yen(r.intr?.low, 1))}</p></div>
    <div><p class="k">後場の動き</p><p class="v ${cls(r.pmDiff)}">${r.pmDiff == null ? '—' : esc(signedPct(r.pmRate))}</p></div>
    <div><p class="k">後場の損益</p><p class="v ${cls(r.pmPl)}">${esc(signedYen(r.pmPl))}</p></div>
  </div>

  <div class="section-mini">
    <p class="mini-title">夜間PTS株価（手入力）</p>
    <div class="pts-input-line">
      <input type="number" class="pts-input" inputmode="decimal" step="0.1" min="0"
             value="${esc(ptsValue)}" placeholder="${r.last == null ? '例 1234' : `終値 ${r.last}`}"
             aria-label="${esc(r.name)}の夜間PTS株価">
      <button type="button" class="btn btn-sm" data-fill="last"${r.last == null ? ' disabled' : ''}>終値を入れる</button>
      <a class="btn btn-sm" href="https://kabutan.jp/stock/?code=${encodeURIComponent(r.code)}" target="_blank" rel="noopener noreferrer">PTSを見る</a>
    </div>
    ${r.ptsPrice == null
      ? '<p class="note">株探かYahoo!ファイナンスで夜間PTSの株価を見て、そのまま入力してください。</p>'
      : `<div class="pts-result">
      <span class="pts-diff ${cls(r.ptsDiff)}">${esc(signedPct(r.ptsRate))}</span>
      <span class="badge">終値比 ${r.ptsDiff > 0 ? '+' : ''}${esc(r.ptsDiff.toLocaleString('ja-JP', { maximumFractionDigits: 1 }))}円</span>
      <span class="pts-pl ${cls(r.ptsPl)}">保有分 ${esc(signedYen(r.ptsPl))}</span>
    </div>`}
  </div>
</article>`;
  }

  // ---------- 取得 ----------

  async function refresh() {
    const codes = [...new Set(holdings.map((h) => String(h.code || '').toUpperCase()).filter(Boolean))];
    if (!codes.length) return toast('保有銘柄がありません');

    if (!settings.netConsent) {
      const agreed = confirm(
        'ザラ場の値動きを Yahoo Finance から取得します。\n'
        + 'ブラウザから直接は取得できないため、公開の中継サービスを経由します。\n'
        + '送信されるのは証券コードだけで、保有株数や取得単価は送信されません。\n\n'
        + '取得してよろしいですか？'
      );
      if (!agreed) return;
      settings.netConsent = true;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    el.refreshBtn.disabled = true;
    el.refreshBtn.textContent = '取得中…';
    let ok = 0;
    const failed = [];

    for (const code of codes) {
      try {
        intraday.set(code, await window.Quotes.fetchIntraday(code));
        ok++;
        render();
      } catch (err) {
        console.warn(`${code} の当日足が取得できません`, err);
        failed.push(code);
      }
    }

    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = '値動きを取得';
    render();

    if (failed.length && !ok) toast(`取得に失敗しました（${failed.join('・')}）`);
    else if (failed.length) toast(`${ok}銘柄を取得（失敗：${failed.join('・')}）`);
    else toast(`${ok}銘柄の当日足を取得しました`);
  }

  // ---------- 小物 ----------

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4200);
  }

  function applyTheme(theme) {
    const t = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
    el.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  // ---------- イベント ----------

  function bind() {
    el.refreshBtn.addEventListener('click', refresh);

    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    el.sortBy.addEventListener('change', () => {
      view.sort = el.sortBy.value;
      saveView();
      render();
    });

    el.onlyPts.addEventListener('change', () => {
      view.onlyPts = el.onlyPts.checked;
      saveView();
      render();
    });

    el.clearPtsBtn.addEventListener('click', () => {
      if (!Object.keys(pts.prices).length) return toast('入力されているPTS株価はありません');
      if (!confirm('入力した夜間PTSの株価をすべて消しますか？')) return;
      pts = { date: sessionDate(), prices: {} };
      savePts();
      render();
      toast('PTSの入力を消しました');
    });

    // 入力のたびに全体を描き直すと入力欄からフォーカスが外れてしまうので、
    // 打っている間は保存と合計の更新だけにして、カードの描き直しは入力を離れたときに行う。
    el.list.addEventListener('input', (e) => {
      const input = e.target.closest('.pts-input');
      if (!input) return;
      const code = input.closest('[data-code]')?.dataset.code;
      if (!code) return;
      const v = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(v) || v <= 0) delete pts.prices[code];
      else pts.prices[code] = v;
      pts.date = sessionDate();
      savePts();
      renderStats();
    });

    el.list.addEventListener('change', (e) => {
      if (e.target.closest('.pts-input')) render();
    });

    el.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fill="last"]');
      if (!btn) return;
      const code = btn.closest('[data-code]')?.dataset.code;
      const row = rows().find((r) => r.code === code);
      if (!row || row.last == null) return;
      pts.prices[code] = row.last;
      pts.date = sessionDate();
      savePts();
      render();
    });
  }

  // ---------- 起動 ----------

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));
    el.sortBy.value = view.sort;
    el.onlyPts.checked = !!view.onlyPts;

    bind();
    renderSession();
    render();
    setInterval(renderSession, 1000);

    // すでに通信に同意済みなら、開いた時点で当日足を取りに行く。
    if (holdings.length && settings.netConsent) refresh();
  }

  init();
})();
