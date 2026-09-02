/* 日本株ポートフォリオ — localStorage だけで動く単一ページアプリ。
 *
 * 保有株（取得単価・株数）はこの端末にだけ保存され、株価と配当実績だけを
 * 外部から取得してキャッシュします（js/quotes.js）。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'jp-stock-portfolio.holdings.v1';
  const SETTINGS_KEY = 'jp-stock-portfolio.settings.v1';
  const THEME_KEY = 'jp-stock-portfolio.theme';
  const CASH_KEY = 'jp-stock-portfolio.cash.v1';
  const SALES_KEY = 'jp-stock-portfolio.sales.v1';

  /** 上場株式の配当にかかる税率（所得税15.315% + 住民税5%）。設定で変更可。 */
  const DEFAULT_TAX_RATE = 20.315;

  /** 口座区分。NISA は配当が非課税なので taxable: false にしている。 */
  const ACCOUNTS = [
    { value: 'tokutei', label: '特定口座', short: '特定', taxable: true },
    { value: 'nisa-growth', label: 'NISA（成長投資枠）', short: 'NISA成長', taxable: false, nisa: 'growth' },
    { value: 'nisa-tsumitate', label: 'NISA（つみたて投資枠）', short: 'NISAつみたて', taxable: false, nisa: 'tsumitate' },
    { value: 'ippan', label: '一般口座', short: '一般', taxable: true },
  ];
  const DEFAULT_ACCOUNT = 'tokutei';

  /** NISA の生涯非課税保有限度額（簿価）。うち成長投資枠は1,200万円まで。 */
  const NISA_TOTAL_LIMIT = 18_000_000;
  const NISA_GROWTH_LIMIT = 12_000_000;

  const accountOf = (h) => ACCOUNTS.find((a) => a.value === h.account) ?? ACCOUNTS[0];

  const $ = (sel) => document.querySelector(sel);

  const el = {
    list: $('#list'),
    empty: $('#empty'),
    search: $('#search'),
    sortBy: $('#sortBy'),
    filterAccount: $('#filterAccount'),
    accountPanel: $('#accountPanel'),
    accountGrid: $('#accountGrid'),
    nisaPanel: $('#nisaPanel'),
    nisaGauges: $('#nisaGauges'),
    viewMode: $('#viewMode'),
    afterTax: $('#afterTax'),
    updatedLine: $('#updatedLine'),
    calendarPanel: $('#calendarPanel'),
    calendar: $('#calendar'),
    yutaiPanel: $('#yutaiPanel'),
    yutaiList: $('#yutaiList'),
    codeSuggest: $('#codeSuggest'),
    menuBtn: $('#menuBtn'),
    menuList: $('#menuList'),
    refreshBtn: $('#refreshBtn'),
    addBtn: $('#addBtn'),
    themeToggle: $('#themeToggle'),
    importFile: $('#importFile'),
    toast: $('#toast'),
    // 銘柄ダイアログ
    holdingDialog: $('#holdingDialog'),
    holdingForm: $('#holdingForm'),
    holdingDialogTitle: $('#holdingDialogTitle'),
    holdingError: $('#holdingError'),
    codeInput: $('#codeInput'),
    nameInput: $('#nameInput'),
    accountInput: $('#accountInput'),
    priceInput: $('#priceInput'),
    sharesInput: $('#sharesInput'),
    unitInput: $('#unitInput'),
    divInput: $('#divInput'),
    monthsInput: $('#monthsInput'),
    memoInput: $('#memoInput'),
    tierRows: $('#tierRows'),
    addTierBtn: $('#addTierBtn'),
    yutaiNoteInput: $('#yutaiNoteInput'),
    // 買い増し
    buyDialog: $('#buyDialog'),
    buyForm: $('#buyForm'),
    buyTargetName: $('#buyTargetName'),
    buyShares: $('#buyShares'),
    buyPrice: $('#buyPrice'),
    buyFee: $('#buyFee'),
    buyFromCash: $('#buyFromCash'),
    buyPreview: $('#buyPreview'),
    // 売却
    sellDialog: $('#sellDialog'),
    sellForm: $('#sellForm'),
    sellTargetName: $('#sellTargetName'),
    sellShares: $('#sellShares'),
    sellPrice: $('#sellPrice'),
    sellFee: $('#sellFee'),
    sellDate: $('#sellDate'),
    sellQuick: $('#sellQuick'),
    sellToCash: $('#sellToCash'),
    sellWithholding: $('#sellWithholding'),
    sellPreview: $('#sellPreview'),
    sellError: $('#sellError'),
    // 投資余力
    cashDialog: $('#cashDialog'),
    cashForm: $('#cashForm'),
    cashRows: $('#cashRows'),
    // 売却履歴
    salesPanel: $('#salesPanel'),
    salesTotals: $('#salesTotals'),
    salesList: $('#salesList'),
    showSold: $('#showSold'),
    // シミュレーション
    simDialog: $('#simDialog'),
    simForm: $('#simForm'),
    simTargetName: $('#simTargetName'),
    simAdd: $('#simAdd'),
    simRange: $('#simRange'),
    simQuick: $('#simQuick'),
    simResult: $('#simResult'),
    simApplyBtn: $('#simApplyBtn'),
    // 通信確認・設定
    netDialog: $('#netDialog'),
    netAgreeBtn: $('#netAgreeBtn'),
    settingsDialog: $('#settingsDialog'),
    settingsForm: $('#settingsForm'),
    taxRateInput: $('#taxRateInput'),
    relayInput: $('#relayInput'),
    autoRefreshInput: $('#autoRefreshInput'),
  };

  /** @type {Array<object>} */
  let holdings = [];
  /** @type {Record<string, number>} 口座ごとの投資余力（現金） */
  let cash = {};
  /** @type {Array<object>} 売却の記録（実現損益） */
  let sales = [];
  let settings = defaultSettings();
  let editingId = null;
  let buyTargetId = null;
  let sellTargetId = null;
  let simTargetId = null;
  /** 通信の同意を取ったあとに実行する処理 */
  let pendingNetAction = null;

  const presetByCode = new Map();
  for (const p of (window.STOCK_PRESETS || [])) presetByCode.set(String(p.code), p);

  // ---------- 銘柄マスタ（js/stocks.js） ----------

  /** @type {Array<{code:string,name:string,mk:string,key:string}>} */
  const master = [];
  const masterByCode = new Map();

  const MARKET_LABEL = {
    P: 'プライム', S: 'スタンダード', G: 'グロース',
    E: 'ETF・ETN', R: 'REIT等', O: '出資証券', X: 'PRO Market',
  };
  /** 候補の並び順。現物株を上に、ETF・REIT、PRO Market は後ろに。 */
  const MARKET_WEIGHT = { P: 0, S: 0, G: 0, O: 1, E: 2, R: 2, X: 3 };

  function initMaster() {
    for (const line of String(window.STOCK_MASTER_RAW ?? '').split('\n')) {
      const [code, name, mk] = line.split('\t');
      if (!code || !name) continue;
      const item = { code, name, mk: mk || 'X', key: `${code} ${name}`.toLowerCase() };
      master.push(item);
      masterByCode.set(code, item);
    }
  }

  /** 全角の英数字を半角へ。iPhoneの日本語キーボードだと全角で入ることがある。 */
  function toHalfWidth(s) {
    return String(s ?? '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/　/g, ' ');
  }

  const normalizeCode = (s) => toHalfWidth(s).trim().toUpperCase();

  /** 証券コードでも銘柄名でも引ける検索。前方一致を優先して返す。 */
  function searchMaster(query, limit = 12) {
    const q = toHalfWidth(query).trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const m of master) {
      const code = m.code.toLowerCase();
      let score;
      if (code === q) score = 0;
      else if (code.startsWith(q)) score = 1;
      else if (m.name.toLowerCase().startsWith(q)) score = 2;
      else if (m.key.includes(q)) score = 3;
      else continue;
      hits.push({ m, score });
    }
    hits.sort((a, b) =>
      a.score - b.score ||
      MARKET_WEIGHT[a.m.mk] - MARKET_WEIGHT[b.m.mk] ||
      a.m.code.localeCompare(b.m.code));
    return hits.slice(0, limit).map((h) => h.m);
  }

  /** マスタ優先で銘柄名を引く（優待プリセットしか無い銘柄はそちらを使う） */
  function nameOfCode(code) {
    return masterByCode.get(code)?.name ?? presetByCode.get(code)?.name ?? '';
  }

  // ---------- storage ----------

  function defaultSettings() {
    return {
      taxRate: DEFAULT_TAX_RATE,
      relay: '',
      autoRefresh: false,
      netConsent: false,
      afterTax: false,
      view: 'card',
      sort: 'value',
      /** '' | 'nisa' | ACCOUNTS の value */
      account: '',
      /** 全部売った銘柄（0株）も一覧に出すか */
      showSold: false,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      holdings = Array.isArray(parsed) ? parsed.map(normalize) : [];
    } catch (err) {
      console.error('保存データの読み込みに失敗しました', err);
      holdings = [];
    }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      settings = Object.assign(defaultSettings(), raw ? JSON.parse(raw) : {});
    } catch {
      settings = defaultSettings();
    }
    window.Quotes.setCustomRelay(settings.relay);

    try {
      cash = normalizeCash(JSON.parse(localStorage.getItem(CASH_KEY) || '{}'));
    } catch { cash = normalizeCash({}); }

    try {
      const raw = JSON.parse(localStorage.getItem(SALES_KEY) || '[]');
      sales = Array.isArray(raw) ? raw.map(normalizeSale) : [];
    } catch { sales = []; }
  }

  /** 口座ごとの余力。知らないキーは捨て、足りないキーは0で埋める。 */
  function normalizeCash(raw) {
    const out = {};
    for (const a of ACCOUNTS) {
      const v = num(raw?.[a.value]);
      out[a.value] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    return out;
  }

  function normalizeSale(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof s.id === 'string' && s.id ? s.id : newId(),
      holdingId: typeof s.holdingId === 'string' ? s.holdingId : '',
      code: normalizeCode(s.code),
      name: String(s.name ?? ''),
      account: ACCOUNTS.some((a) => a.value === s.account) ? s.account : DEFAULT_ACCOUNT,
      date: typeof s.date === 'string' && s.date ? s.date : todayIso(),
      shares: Math.max(0, Math.floor(num(s.shares) ?? 0)),
      price: Math.max(0, num(s.price) ?? 0),
      avgPrice: Math.max(0, num(s.avgPrice) ?? 0),
      fee: Math.max(0, num(s.fee) ?? 0),
      tax: Math.max(0, num(s.tax) ?? 0),
      realized: num(s.realized) ?? 0,
      proceeds: num(s.proceeds) ?? 0,
      cashApplied: num(s.cashApplied) ?? 0,
      createdAt: Number(s.createdAt) || Date.now(),
    };
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const saveCash = () => localStorage.setItem(CASH_KEY, JSON.stringify(cash));
  const saveSales = () => localStorage.setItem(SALES_KEY, JSON.stringify(sales));

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
    } catch (err) {
      console.error('保存に失敗しました', err);
      toast('保存に失敗しました（保存容量が上限の可能性があります）');
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      console.error('設定の保存に失敗しました', err);
    }
  }

  function normalize(raw) {
    const h = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof h.id === 'string' && h.id ? h.id : newId(),
      code: normalizeCode(h.code),
      name: String(h.name ?? ''),
      // 口座区分。旧データ（口座なし）は特定口座として扱う。
      account: ACCOUNTS.some((a) => a.value === h.account) ? h.account : DEFAULT_ACCOUNT,
      shares: Math.max(0, Math.floor(num(h.shares) ?? 0)),
      avgPrice: Math.max(0, num(h.avgPrice) ?? 0),
      unit: Math.max(1, Math.floor(num(h.unit) ?? 100)),
      divPerShare: num(h.divPerShare),
      months: Array.isArray(h.months) ? h.months.map((m) => Math.round(num(m) ?? 0)).filter((m) => m >= 1 && m <= 12) : [],
      yutai: normalizeYutai(h.yutai),
      memo: String(h.memo ?? ''),
      quote: h.quote && typeof h.quote === 'object' ? h.quote : null,
      createdAt: Number(h.createdAt) || Date.now(),
      updatedAt: Number(h.updatedAt) || Date.now(),
    };
  }

  function normalizeYutai(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const tiers = Array.isArray(raw.tiers)
      ? raw.tiers
          .map((t) => ({
            shares: Math.max(1, Math.floor(num(t?.shares) ?? 100)),
            text: String(t?.text ?? ''),
            value: Math.max(0, num(t?.value) ?? 0),
          }))
          .filter((t) => t.text)
          .sort((a, b) => a.shares - b.shares)
      : [];
    const note = String(raw.note ?? '');
    const asOf = String(raw.asOf ?? '');
    const abolished = raw.abolished === true;
    if (!tiers.length && !note && !abolished) return null;
    return { tiers, note, asOf, abolished };
  }

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function newId() {
    return crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // ---------- 計算 ----------

  function taxFactor() {
    const r = Number(settings.taxRate);
    const rate = Number.isFinite(r) ? Math.min(Math.max(r, 0), 100) : DEFAULT_TAX_RATE;
    return 1 - rate / 100;
  }

  /** 銘柄ごとの手取り率。NISA口座は配当が非課税なので 1 のまま。 */
  function taxFactorFor(h) {
    return accountOf(h).taxable ? taxFactor() : 1;
  }

  /** 口座の絞り込み。'nisa' は成長・つみたての両方にあたる。 */
  function matchAccount(h, filter) {
    if (!filter) return true;
    if (filter === 'nisa') return !accountOf(h).taxable;
    return h.account === filter;
  }

  /** いま選ばれている口座に属する銘柄（検索語は含めない） */
  function accountFiltered() {
    return holdings.filter((h) => matchAccount(h, settings.account));
  }

  /** 選ばれている口座の投資余力の合計 */
  function cashOf(filter = settings.account) {
    return ACCOUNTS
      .filter((a) => matchAccount({ account: a.value }, filter))
      .reduce((sum, a) => sum + (cash[a.value] ?? 0), 0);
  }

  const totalCash = () => ACCOUNTS.reduce((sum, a) => sum + (cash[a.value] ?? 0), 0);

  /** 保有株数に対して有効な優待の段（同株数の段が複数あるときはまとめて返す） */
  function currentTier(yutai, shares) {
    if (!yutai || yutai.abolished || !yutai.tiers.length) return null;
    const reached = yutai.tiers.filter((t) => shares >= t.shares);
    if (!reached.length) return null;
    const top = reached[reached.length - 1].shares;
    const matched = reached.filter((t) => t.shares === top);
    return {
      shares: top,
      text: matched.map((t) => t.text).join('／'),
      value: Math.max(...matched.map((t) => t.value)),
    };
  }

  /** 次に到達できる優待の段 */
  function nextTier(yutai, shares) {
    if (!yutai || yutai.abolished || !yutai.tiers.length) return null;
    const upper = yutai.tiers.filter((t) => t.shares > shares);
    if (!upper.length) return null;
    const need = upper[0].shares;
    const matched = upper.filter((t) => t.shares === need);
    return {
      shares: need,
      text: matched.map((t) => t.text).join('／'),
      value: Math.max(...matched.map((t) => t.value)),
      lack: need - shares,
    };
  }

  /** 1銘柄ぶんの指標。shares を渡すと「その株数だったら」の値を計算する。 */
  function calc(h, sharesOverride) {
    const shares = sharesOverride ?? h.shares;
    const price = num(h.quote?.price);
    const dps = h.divPerShare ?? num(h.quote?.divTtm);
    const cost = h.avgPrice * shares;
    const value = price != null ? price * shares : null;
    const divGross = dps != null ? dps * shares : null;
    const divShown = divGross != null ? (settings.afterTax ? divGross * taxFactorFor(h) : divGross) : null;
    const tier = currentTier(h.yutai, shares);
    const yutaiValue = tier ? tier.value : 0;
    return {
      shares,
      price,
      dps,
      cost,
      value,
      pl: value != null ? value - cost : null,
      plRate: value != null && cost > 0 ? (value - cost) / cost : null,
      divGross,
      divShown,
      yieldNow: dps != null && price ? dps / price : null,
      yoc: dps != null && h.avgPrice > 0 ? dps / h.avgPrice : null,
      tier,
      next: nextTier(h.yutai, shares),
      yutaiValue,
      totalYield: cost > 0 && divShown != null ? (divShown + yutaiValue) / cost : null,
    };
  }

  function totals(rows = accountFiltered()) {
    let cost = 0, value = 0, divShown = 0, yutai = 0;
    let hasPrice = false, hasDiv = false;
    for (const h of rows) {
      const c = calc(h);
      cost += c.cost;
      if (c.value != null) { value += c.value; hasPrice = true; }
      if (c.divShown != null) { divShown += c.divShown; hasDiv = true; }
      yutai += c.yutaiValue;
    }
    return {
      cost,
      value: hasPrice ? value : null,
      pl: hasPrice ? value - cost : null,
      plRate: hasPrice && cost > 0 ? (value - cost) / cost : null,
      div: hasDiv ? divShown : null,
      yutai,
      totalYield: cost > 0 && hasDiv ? (divShown + yutai) / cost : null,
      divYield: hasPrice && value > 0 && hasDiv ? divShown / value : null,
    };
  }

  // ---------- 表示のためのフォーマット ----------

  const yen = (n, digits = 0) =>
    n == null || !Number.isFinite(n)
      ? '—'
      : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}円`;

  const pct = (r, digits = 2) => (r == null || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(digits)}%`);
  const signed = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${yen(n)}`);
  const plClass = (n) => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

  /** これより長い優待テキストは、カードが縦に伸びすぎるので折りたたむ。 */
  const FOLD_LENGTH = 42;

  /**
   * 長い文章を details で折りたたむ。短ければそのまま段落として出す。
   * 株主優待は1行が長くなりがちで、畳まないと画面からはみ出して読めなくなる。
   */
  function foldable(summary, text, cls = '') {
    const t = String(text ?? '').trim();
    if (!t) return '';
    if (t.length <= FOLD_LENGTH) return `<p class="${cls}">${esc(t)}</p>`;
    return `<details class="fold"><summary>${esc(summary)}</summary><p class="${cls}">${esc(t)}</p></details>`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return `${min}分前`;
    const hour = Math.round(min / 60);
    if (hour < 24) return `${hour}時間前`;
    return `${Math.round(hour / 24)}日前`;
  }

  // ---------- 描画 ----------

  function render() {
    renderStats();
    renderAccountPanel();
    renderNisaPanel();
    renderList();
    renderCalendar();
    renderYutaiPanel();
    renderSalesPanel();
  }

  function renderStats() {
    const t = totals();
    const filterLabel = settings.account
      ? (settings.account === 'nisa' ? 'NISA合計' : (ACCOUNTS.find((a) => a.value === settings.account)?.label ?? ''))
      : '';
    $('#statValueLabel').textContent = filterLabel ? `評価額（${filterLabel}）` : '評価額';
    $('#statValue').textContent = t.value == null ? '—' : yen(t.value);
    $('#statCost').textContent = yen(t.cost);

    const plEl = $('#statPl');
    plEl.className = `stat-value ${plClass(t.pl)}`;
    plEl.innerHTML = t.pl == null
      ? '—'
      : `${esc(signed(t.pl))}<span class="sub">${esc(t.plRate == null ? '' : `(${t.plRate > 0 ? '+' : ''}${(t.plRate * 100).toFixed(2)}%)`)}</span>`;

    $('#statDivLabel').textContent = settings.afterTax
      ? `年間配当（税引後 ${settings.taxRate}%・NISAは非課税）`
      : '年間配当（税引前）';
    $('#statDiv').innerHTML = t.div == null
      ? '—'
      : `${esc(yen(t.div))}<span class="sub">${esc(t.divYield == null ? '' : `利回り ${(t.divYield * 100).toFixed(2)}%`)}</span>`;

    $('#statYutai').textContent = yen(t.yutai);
    $('#statYield').textContent = pct(t.totalYield);

    const money = cashOf();
    $('#statCash').textContent = money ? yen(money) : '—';
    const assets = (t.value ?? t.cost) + money;
    $('#statAssets').textContent = assets ? yen(assets) : '—';

    const stamps = holdings.map((h) => h.quote?.fetchedAt).filter(Boolean);
    if (stamps.length) {
      el.updatedLine.hidden = false;
      el.updatedLine.textContent = `株価の最終取得：${relTime(Math.max(...stamps))}（${new Date(Math.max(...stamps)).toLocaleString('ja-JP')}）／ 出所：Yahoo Finance・遅延あり`;
    } else {
      el.updatedLine.hidden = true;
    }
  }

  /** 口座ごとの小計。2口座以上を使っているか、余力を入れていれば表示する。 */
  function renderAccountPanel() {
    const used = ACCOUNTS
      .map((a) => ({ account: a, rows: holdings.filter((h) => h.account === a.value) }))
      .filter((g) => g.rows.length || (cash[g.account.value] ?? 0) > 0);

    el.accountPanel.hidden = used.length < 2;
    if (used.length < 2) return;

    el.accountGrid.innerHTML = used.map(({ account, rows }) => {
      const t = totals(rows);
      const active = settings.account === account.value || (settings.account === 'nisa' && !account.taxable);
      return `
<button type="button" class="account-card${active ? ' is-on' : ''}" data-account="${esc(account.value)}">
  <span class="ac-head">
    <span class="badge ${account.taxable ? '' : 'ok'}">${esc(account.label)}</span>
    <span class="ac-count">${rows.length}銘柄</span>
  </span>
  <span class="ac-value">${esc(yen(t.value ?? t.cost))}</span>
  <span class="ac-rows">
    <span>取得 ${esc(yen(t.cost))}</span>
    <span class="${plClass(t.pl)}">損益 ${esc(signed(t.pl))}${t.plRate == null ? '' : `（${t.plRate > 0 ? '+' : ''}${(t.plRate * 100).toFixed(1)}%）`}</span>
    <span>配当 ${esc(yen(t.div))}${!account.taxable && settings.afterTax ? '（非課税）' : ''}</span>
    <span>余力 ${esc(yen(cash[account.value] ?? 0))}${(cash[account.value] ?? 0) > 0 ? `／合計 ${esc(yen((t.value ?? t.cost) + (cash[account.value] ?? 0)))}` : ''}</span>
  </span>
</button>`;
    }).join('');
  }

  /** 売却履歴と実現損益。 */
  function renderSalesPanel() {
    const rows = sales
      .filter((s) => matchAccount(s, settings.account))
      .slice()
      .sort((a, b) => (b.date === a.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));

    el.salesPanel.hidden = rows.length === 0;
    if (!rows.length) return;

    const thisYear = String(new Date().getFullYear());
    const sum = (list, key) => list.reduce((n, s) => n + (s[key] ?? 0), 0);
    const yearRows = rows.filter((s) => s.date.startsWith(thisYear));

    const tile = (label, value, klass) =>
      `<div class="stat"><span class="stat-value ${klass ?? ''}">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`;

    el.salesTotals.innerHTML =
      tile(`${thisYear}年の実現損益（税引前）`, signed(sum(yearRows, 'realized')), plClass(sum(yearRows, 'realized')))
      + tile(`${thisYear}年の税額の目安`, yen(sum(yearRows, 'tax')))
      + tile('全期間の実現損益（税引前）', signed(sum(rows, 'realized')), plClass(sum(rows, 'realized')))
      + tile('売却の記録', `${rows.length}件`);

    el.salesList.innerHTML = rows.map((s) => {
      const account = ACCOUNTS.find((a) => a.value === s.account) ?? ACCOUNTS[0];
      const afterTax = s.realized - s.tax;
      return `
<li data-sale="${esc(s.id)}">
  <div class="sale-head">
    <span class="sale-date num">${esc(s.date)}</span>
    <span class="sale-name">${esc(s.name || s.code)}</span>
    <span class="badge ${account.taxable ? '' : 'ok'}">${esc(account.short)}</span>
    <button type="button" class="row-btn" data-act="undo-sale">取り消し</button>
  </div>
  <div class="sale-body">
    <span>${esc(s.shares.toLocaleString('ja-JP'))}株 × ${esc(yen(s.price, 2))}</span>
    <span>取得 ${esc(yen(s.avgPrice, 2))}</span>
    <span class="${plClass(s.realized)}">実現損益 ${esc(signed(s.realized))}</span>
    ${s.tax > 0 ? `<span>税 ${esc(yen(s.tax))} → 手取り ${esc(signed(afterTax))}</span>` : (account.taxable ? '' : '<span class="badge ok">非課税</span>')}
    <span>受取額 ${esc(yen(s.proceeds))}</span>
  </div>
</li>`;
    }).join('');
  }

  /** NISA の生涯非課税保有限度額（簿価）の使用状況 */
  function renderNisaPanel() {
    const nisaRows = holdings.filter((h) => !accountOf(h).taxable);
    el.nisaPanel.hidden = nisaRows.length === 0;
    if (!nisaRows.length) return;

    const growth = nisaRows
      .filter((h) => accountOf(h).nisa === 'growth')
      .reduce((s, h) => s + h.avgPrice * h.shares, 0);
    const tsumitate = nisaRows
      .filter((h) => accountOf(h).nisa === 'tsumitate')
      .reduce((s, h) => s + h.avgPrice * h.shares, 0);

    const gauge = (label, used, limit) => {
      const rate = limit > 0 ? Math.min(used / limit, 1) : 0;
      const over = used > limit;
      return `
<div class="gauge">
  <div class="gauge-head">
    <span>${esc(label)}</span>
    <span class="num">${esc(yen(used))} / ${esc(yen(limit))}（${(rate * 100).toFixed(1)}%）</span>
  </div>
  <div class="gauge-bar"><span class="${over ? 'over' : ''}" style="width:${(rate * 100).toFixed(1)}%"></span></div>
  <p class="gauge-rest">残り ${esc(yen(Math.max(limit - used, 0)))}${over ? '（上限を超えています）' : ''}</p>
</div>`;
    };

    // つみたて投資枠に単独の上限は無い（全体1,800万円の内数）ので、金額だけ添える。
    el.nisaGauges.innerHTML =
      gauge('NISA全体（簿価）', growth + tsumitate, NISA_TOTAL_LIMIT) +
      gauge('うち成長投資枠', growth, NISA_GROWTH_LIMIT) +
      (tsumitate > 0 ? `<p class="gauge-rest">うちつみたて投資枠：${esc(yen(tsumitate))}</p>` : '');
  }

  function visibleHoldings() {
    const q = el.search.value.trim().toLowerCase();
    let rows = accountFiltered().filter((h) => {
      // 全部売った銘柄は既定で隠す（記録は残っているので、いつでも戻せる）。
      if (h.shares <= 0 && !settings.showSold) return false;
      if (!q) return true;
      return [h.code, h.name, h.memo, h.quote?.nameEn].filter(Boolean).join(' ').toLowerCase().includes(q);
    });

    const key = settings.sort;
    rows = rows.slice().sort((a, b) => {
      const ca = calc(a), cb = calc(b);
      switch (key) {
        case 'div': return (cb.divShown ?? -1) - (ca.divShown ?? -1);
        case 'yield': return (cb.yieldNow ?? -1) - (ca.yieldNow ?? -1);
        case 'pl': return (cb.plRate ?? -Infinity) - (ca.plRate ?? -Infinity);
        case 'code': return a.code.localeCompare(b.code, 'ja');
        case 'created': return b.createdAt - a.createdAt;
        case 'value':
        default: return (cb.value ?? cb.cost) - (ca.value ?? ca.cost);
      }
    });
    return rows;
  }

  function renderList() {
    const rows = visibleHoldings();
    el.empty.hidden = holdings.length > 0;
    el.list.classList.toggle('table-view', settings.view === 'table');

    if (!rows.length) {
      el.list.innerHTML = holdings.length ? '<p class="empty">条件に合う銘柄がありません。</p>' : '';
      return;
    }
    el.list.innerHTML = settings.view === 'table' ? tableHtml(rows) : rows.map(cardHtml).join('');
  }

  function cardHtml(h) {
    const c = calc(h);
    const chg = c.price != null && h.quote?.prevClose ? c.price - h.quote.prevClose : null;
    const chgRate = chg != null && h.quote.prevClose ? chg / h.quote.prevClose : null;
    const stale = h.quote?.fetchedAt ? relTime(h.quote.fetchedAt) : '未取得';

    const yutaiBlock = (() => {
      const noteText = h.yutai?.note
        ? `${h.yutai.note}${h.yutai.asOf ? `（参考：${h.yutai.asOf}時点）` : ''}`
        : '';
      const note = foldable('条件・注意点を読む', noteText, 'note');

      if (h.yutai?.abolished) {
        return `<p class="yutai-none">優待は廃止されています。</p>${note}`;
      }
      if (!h.yutai || !h.yutai.tiers.length) {
        return '<p class="yutai-none">優待は登録されていません（「編集」から追加できます）。</p>';
      }

      const now = c.tier
        ? `<p class="badges"><span class="badge ok">${esc(c.tier.shares)}株以上</span>${c.tier.value ? `<span class="badge">年 ${esc(yen(c.tier.value))}相当</span>` : ''}</p>`
          + foldable('優待の内容を全部見る', c.tier.text, 'yutai-now')
        : '<p class="yutai-none">いまの株数では優待の対象外です。</p>';

      // 次のランクは、内容が長いときだけ「◯株で次のランク」+折りたたみに分ける。
      const next = (() => {
        if (!c.next) return '';
        const lead = `あと ${c.next.lack.toLocaleString('ja-JP')}株（${yen(c.next.lack * (c.price ?? h.avgPrice))}）で`;
        return c.next.text.length <= FOLD_LENGTH
          ? `<p class="yutai-next">${esc(lead)}「${esc(c.next.text)}」</p>`
          : `<p class="yutai-next">${esc(lead)}次のランクに到達します</p>`
            + foldable('次のランクの内容を見る', c.next.text, 'note');
      })();

      return now + next + note;
    })();

    const sold = h.shares <= 0;

    return `
<article class="card${sold ? ' is-sold' : ''}" data-id="${esc(h.id)}">
  <div class="card-top">
    <h3 class="card-title">${esc(h.name || '(名称未設定)')}
      <span class="card-code">${sold ? '<span class="badge">売却済み</span> ' : ''}<span class="badge ${accountOf(h).taxable ? '' : 'ok'}">${esc(accountOf(h).short)}</span> ${esc(h.code)}${h.quote?.nameEn ? ` ・ ${esc(h.quote.nameEn)}` : ''}</span></h3>
    <div class="price-box">
      <span class="price-now">${c.price == null ? '—' : esc(c.price.toLocaleString('ja-JP', { maximumFractionDigits: 1 }))}<span style="font-size:.7em">円</span></span>
      ${chg == null ? '' : `<span class="price-chg ${plClass(chg)}">${chg > 0 ? '+' : ''}${esc(chg.toLocaleString('ja-JP', { maximumFractionDigits: 1 }))} (${chgRate > 0 ? '+' : ''}${esc((chgRate * 100).toFixed(2))}%)</span>`}
      <span class="price-stale">${esc(stale)}</span>
    </div>
  </div>

  <div class="kv">
    <div><p class="k">保有株数</p><p class="v">${esc(h.shares.toLocaleString('ja-JP'))}株</p></div>
    <div><p class="k">取得単価</p><p class="v">${esc(yen(h.avgPrice, 2))}</p></div>
    <div><p class="k">取得金額</p><p class="v">${esc(yen(c.cost))}</p></div>
    <div><p class="k">評価額</p><p class="v">${esc(yen(c.value))}</p></div>
    <div><p class="k">評価損益</p><p class="v ${plClass(c.pl)}">${esc(signed(c.pl))}</p></div>
    <div><p class="k">損益率</p><p class="v ${plClass(c.pl)}">${c.plRate == null ? '—' : `${c.plRate > 0 ? '+' : ''}${esc((c.plRate * 100).toFixed(2))}%`}</p></div>
  </div>

  <div class="section-mini">
    <p class="mini-title">年間配当${settings.afterTax ? (accountOf(h).taxable ? '（税引後）' : '（NISA・非課税）') : '（税引前）'}${h.divPerShare != null ? '<span class="badge accent">手入力</span>' : ''}</p>
    <div class="dividend-line">
      <span class="dividend-amount">${esc(yen(c.divShown))}</span>
      <span class="badge">1株 ${c.dps == null ? '—' : esc(`${c.dps.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}円`)}</span>
      <span class="badge">利回り ${esc(pct(c.yieldNow))}</span>
      <span class="badge">取得比 ${esc(pct(c.yoc))}</span>
      ${h.months.length ? `<span class="badge">権利 ${esc(h.months.join('・'))}月</span>` : ''}
    </div>
  </div>

  <div class="section-mini">
    <p class="mini-title">株主優待</p>
    ${yutaiBlock}
  </div>

  ${h.memo ? `<p class="memo">${esc(h.memo)}</p>` : ''}

  <div class="card-actions">
    <button type="button" class="btn" data-act="sim">シミュレーション</button>
    <button type="button" class="btn" data-act="buy">買い増し</button>
    ${sold ? '' : '<button type="button" class="btn" data-act="sell">売却</button>'}
    <button type="button" class="btn" data-act="refresh">株価更新</button>
    <button type="button" class="btn" data-act="edit">編集</button>
    <button type="button" class="btn link-danger" data-act="delete">削除</button>
  </div>
</article>`;
  }

  function tableHtml(rows) {
    const t = totals();
    const body = rows.map((h) => {
      const c = calc(h);
      return `
<tr data-id="${esc(h.id)}">
  <td>${esc(h.name || h.code)}<br><span class="k" style="font-size:.72rem;color:var(--text-muted)">${esc(h.code)}</span></td>
  <td><span class="badge ${accountOf(h).taxable ? '' : 'ok'}">${esc(accountOf(h).short)}</span></td>
  <td>${esc(h.shares.toLocaleString('ja-JP'))}</td>
  <td>${esc(yen(h.avgPrice, 2))}</td>
  <td>${c.price == null ? '—' : esc(yen(c.price, 1))}</td>
  <td>${esc(yen(c.cost))}</td>
  <td>${esc(yen(c.value))}</td>
  <td class="${plClass(c.pl)}">${esc(signed(c.pl))}</td>
  <td class="${plClass(c.pl)}">${c.plRate == null ? '—' : `${c.plRate > 0 ? '+' : ''}${esc((c.plRate * 100).toFixed(2))}%`}</td>
  <td>${esc(yen(c.divShown))}</td>
  <td>${esc(pct(c.yieldNow))}</td>
  <td>${c.tier ? esc(yen(c.yutaiValue)) : '—'}</td>
  <td><button type="button" class="row-btn" data-act="sim">試算</button></td>
</tr>`;
    }).join('');

    return `
<table class="holdings-table">
  <thead>
    <tr>
      <th>銘柄</th><th>口座</th><th>株数</th><th>取得単価</th><th>現在値</th><th>取得金額</th><th>評価額</th>
      <th>評価損益</th><th>損益率</th><th>年間配当</th><th>利回り</th><th>優待/年</th><th></th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
  <tfoot>
    <tr>
      <td>合計</td><td></td><td></td><td></td><td></td>
      <td>${esc(yen(t.cost))}</td>
      <td>${esc(yen(t.value))}</td>
      <td class="${plClass(t.pl)}">${esc(signed(t.pl))}</td>
      <td class="${plClass(t.pl)}">${t.plRate == null ? '—' : `${t.plRate > 0 ? '+' : ''}${esc((t.plRate * 100).toFixed(2))}%`}</td>
      <td>${esc(yen(t.div))}</td>
      <td>${esc(pct(t.divYield))}</td>
      <td>${esc(yen(t.yutai))}</td>
      <td></td>
    </tr>
  </tfoot>
</table>`;
  }

  /** 権利確定月ごとの配当見込み。取得済みの権利落ち日、なければ手入力の権利月を使う。 */
  function monthlyDividends() {
    const months = new Array(12).fill(0);
    let any = false;
    for (const h of holdings) {
      const c = calc(h);
      if (c.divShown == null || c.divShown <= 0) continue;
      const events = Array.isArray(h.quote?.divEvents) ? h.quote.divEvents : [];
      if (events.length) {
        const sum = events.reduce((s, e) => s + (num(e.amount) ?? 0), 0);
        if (sum > 0) {
          for (const e of events) {
            const m = Math.min(Math.max(Math.round(num(e.month) ?? 0), 1), 12);
            months[m - 1] += c.divShown * ((num(e.amount) ?? 0) / sum);
          }
          any = true;
          continue;
        }
      }
      if (h.months.length) {
        for (const m of h.months) months[m - 1] += c.divShown / h.months.length;
        any = true;
      }
    }
    return any ? months : null;
  }

  function renderCalendar() {
    const months = monthlyDividends();
    el.calendarPanel.hidden = !months;
    if (!months) return;
    const max = Math.max(...months);
    el.calendar.innerHTML = months.map((amount, i) => {
      const h = max > 0 ? Math.round((amount / max) * 100) : 0;
      return `
<div class="cal-col">
  <span class="cal-amount">${amount > 0 ? esc(Math.round(amount).toLocaleString('ja-JP')) : ''}</span>
  <div class="cal-bar ${amount > 0 ? '' : 'is-empty'}" style="height:${Math.max(h, amount > 0 ? 6 : 3)}px" title="${i + 1}月 ${esc(yen(amount))}"></div>
  <span class="cal-month">${i + 1}</span>
</div>`;
    }).join('');
  }

  function renderYutaiPanel() {
    const rows = holdings
      .map((h) => ({ h, c: calc(h) }))
      .filter(({ c }) => c.tier);
    el.yutaiPanel.hidden = rows.length === 0;
    if (!rows.length) return;
    el.yutaiList.innerHTML = rows.map(({ h, c }) => `
<li>
  <div class="y-head">
    <span class="y-name">${esc(h.name || h.code)}</span>
    <span class="badge">${esc(h.shares.toLocaleString('ja-JP'))}株</span>
    <span class="y-value">${c.tier.value ? `年 ${esc(yen(c.tier.value))}相当` : '金額換算なし'}</span>
  </div>
  ${foldable('内容を全部見る', c.tier.text, 'y-text')}
</li>`).join('');
  }

  // ---------- 銘柄の追加・編集 ----------

  function openHoldingDialog(id) {
    editingId = id ?? null;
    const h = id ? holdings.find((x) => x.id === id) : null;
    el.holdingDialogTitle.textContent = h ? '銘柄を編集' : '銘柄を追加';
    el.holdingError.hidden = true;
    hideSuggest();

    el.codeInput.value = h?.code ?? '';
    el.nameInput.value = h?.name ?? '';
    // 新規追加のときは、いま絞り込んでいる口座を初期値にすると入力が早い
    el.accountInput.value = h?.account
      ?? (ACCOUNTS.some((a) => a.value === settings.account) ? settings.account : DEFAULT_ACCOUNT);
    el.priceInput.value = h ? String(h.avgPrice) : '';
    el.sharesInput.value = h ? String(h.shares) : '';
    el.unitInput.value = String(h?.unit ?? 100);
    el.divInput.value = h?.divPerShare != null ? String(h.divPerShare) : '';
    el.monthsInput.value = (h?.months ?? []).join(',');
    el.memoInput.value = h?.memo ?? '';
    el.yutaiNoteInput.value = h?.yutai?.note ?? '';
    renderTierRows(h?.yutai?.tiers ?? []);

    el.holdingDialog.showModal();
  }

  function renderTierRows(tiers) {
    el.tierRows.innerHTML = '';
    for (const t of tiers) addTierRow(t);
  }

  function addTierRow(tier) {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.innerHTML = `
<input type="number" class="t-shares" min="1" step="1" inputmode="numeric" placeholder="100" aria-label="必要株数">
<input type="text" class="t-text" placeholder="食事券 2,000円分 × 年2回" aria-label="優待の内容">
<input type="number" class="t-value" min="0" step="1" inputmode="numeric" placeholder="年の価値" aria-label="年間の価値（円）">
<button type="button" class="t-del" title="この段を削除" aria-label="この段を削除">✕</button>`;
    row.querySelector('.t-shares').value = tier?.shares != null ? String(tier.shares) : '';
    row.querySelector('.t-text').value = tier?.text ?? '';
    row.querySelector('.t-value').value = tier?.value != null ? String(tier.value) : '';
    row.querySelector('.t-del').addEventListener('click', () => row.remove());
    el.tierRows.appendChild(row);
  }

  function readTierRows() {
    return Array.from(el.tierRows.querySelectorAll('.tier-row'))
      .map((row) => ({
        shares: num(row.querySelector('.t-shares').value),
        text: row.querySelector('.t-text').value.trim(),
        value: num(row.querySelector('.t-value').value) ?? 0,
      }))
      .filter((t) => t.text && t.shares);
  }

  function parseMonths(text) {
    return [...new Set(
      String(text || '')
        .split(/[^0-9]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => n >= 1 && n <= 12)
    )].sort((a, b) => a - b);
  }

  /** 証券コードを入れたときに、銘柄マスタと優待プリセットから内容を補う。 */
  function applyPreset(force) {
    const code = normalizeCode(el.codeInput.value);
    const name = nameOfCode(code);
    const p = presetByCode.get(code);
    if (!name && !p) return;
    if (name && (force || !el.nameInput.value.trim())) el.nameInput.value = name;
    if (p?.unit && (force || !el.unitInput.value)) el.unitInput.value = String(p.unit);
    if (p?.months && (force || !el.monthsInput.value.trim())) el.monthsInput.value = p.months.join(',');
    // 優待は自分で書き換えていることがあるので、空のときだけ入れる。
    const hasTiers = el.tierRows.querySelector('.tier-row');
    if (p?.yutai && !hasTiers && !el.yutaiNoteInput.value.trim()) {
      renderTierRows(p.yutai.tiers ?? []);
      el.yutaiNoteInput.value = p.yutai.abolished
        ? `【優待廃止】${p.yutai.note ?? ''}`
        : `${p.yutai.note ?? ''}${p.yutai.asOf ? `（参考：${p.yutai.asOf}時点・要確認）` : ''}`;
    }
  }

  // ---------- 証券コードの候補表示 ----------

  function showSuggest() {
    const hits = searchMaster(el.codeInput.value, 12);
    if (!hits.length) return hideSuggest();
    el.codeSuggest.innerHTML = hits.map((m) => `
<li role="option">
  <button type="button" data-code="${esc(m.code)}">
    <span class="sg-code">${esc(m.code)}</span>
    <span class="sg-name">${esc(m.name)}</span>
    <span class="sg-mk">${esc(MARKET_LABEL[m.mk] ?? '')}</span>
  </button>
</li>`).join('');
    el.codeSuggest.hidden = false;
  }

  function hideSuggest() {
    el.codeSuggest.hidden = true;
    el.codeSuggest.innerHTML = '';
  }

  /** 候補を選んだとき。コードを確定して、銘柄名などを入れ直す。 */
  function pickSuggest(code) {
    el.codeInput.value = code;
    hideSuggest();
    applyPreset(true);
    el.priceInput.focus();
  }

  function submitHolding(event) {
    const code = normalizeCode(el.codeInput.value);
    const avgPrice = num(el.priceInput.value);
    const shares = num(el.sharesInput.value);

    if (!code) return failHolding(event, '証券コードを入力してください。');
    if (avgPrice == null || avgPrice < 0) return failHolding(event, '取得単価を正しく入力してください。');
    if (shares == null || shares < 0) return failHolding(event, '取得株数を正しく入力してください。');

    // 同じ銘柄でも口座が違えば別枠で持てる（特定口座とNISAの併有）。
    const account = el.accountInput.value;
    const dup = holdings.find((h) => h.code === code && h.account === account && h.id !== editingId);
    if (dup) {
      const label = ACCOUNTS.find((a) => a.value === account)?.label ?? '';
      return failHolding(event, `証券コード ${code} は${label}にすでに登録されています（買い増しは「買い増し」ボタンから）。`);
    }

    const tiers = readTierRows();
    const yutaiNote = el.yutaiNoteInput.value.trim();
    const base = editingId ? holdings.find((h) => h.id === editingId) : null;

    const next = normalize({
      ...(base ?? {}),
      id: base?.id,
      code,
      account,
      name: el.nameInput.value.trim() || nameOfCode(code),
      avgPrice,
      shares: Math.floor(shares),
      unit: num(el.unitInput.value) ?? 100,
      divPerShare: num(el.divInput.value),
      months: parseMonths(el.monthsInput.value),
      yutai: tiers.length || yutaiNote
        ? { tiers, note: yutaiNote, asOf: base?.yutai?.asOf ?? '', abolished: base?.yutai?.abolished ?? false }
        : null,
      memo: el.memoInput.value.trim(),
      quote: base?.quote ?? null,
      createdAt: base?.createdAt,
      updatedAt: Date.now(),
    });

    if (base) {
      holdings = holdings.map((h) => (h.id === base.id ? next : h));
    } else {
      holdings.push(next);
    }
    save();
    render();
    toast(base ? '保存しました' : `${next.name || next.code} を追加しました`);
    if (!base || !next.quote) requestQuotes([next.id], { quiet: true });
  }

  function failHolding(event, message) {
    event.preventDefault();
    el.holdingError.textContent = message;
    el.holdingError.hidden = false;
  }

  // ---------- 買い増し ----------

  function openBuyDialog(id, presetShares, presetPrice) {
    const h = holdings.find((x) => x.id === id);
    if (!h) return;
    buyTargetId = id;
    el.buyTargetName.textContent = `${h.name || h.code}［${accountOf(h).label}］（現在 ${h.shares.toLocaleString('ja-JP')}株・平均 ${yen(h.avgPrice, 2)}）`;
    el.buyShares.value = presetShares != null ? String(presetShares) : String(h.unit || 100);
    el.buyPrice.value = presetPrice != null ? String(Math.round(presetPrice * 10) / 10) : (h.quote?.price != null ? String(h.quote.price) : '');
    el.buyFee.value = '';
    el.buyFromCash.checked = true;
    updateBuyPreview();
    el.buyDialog.showModal();
  }

  function updateBuyPreview() {
    const h = holdings.find((x) => x.id === buyTargetId);
    if (!h) return;
    const addShares = num(el.buyShares.value);
    const addPrice = num(el.buyPrice.value);
    const fee = num(el.buyFee.value) ?? 0;
    if (!addShares || addPrice == null) { el.buyPreview.textContent = ''; return; }
    const shares = h.shares + addShares;
    const payment = addPrice * addShares + fee;
    const avg = (h.avgPrice * h.shares + addPrice * addShares + fee) / shares;
    const money = cash[h.account] ?? 0;
    const rest = money - payment;
    el.buyPreview.textContent =
      `→ ${shares.toLocaleString('ja-JP')}株 / 平均取得単価 ${yen(avg, 2)} / 支払額 ${yen(payment)}`
      + (el.buyFromCash.checked && money > 0
        ? `／余力 ${yen(money)} → ${rest < 0 ? `${yen(0)}（${yen(-rest)}不足）` : yen(rest)}`
        : '');
  }

  function submitBuy(event) {
    const h = holdings.find((x) => x.id === buyTargetId);
    const addShares = num(el.buyShares.value);
    const addPrice = num(el.buyPrice.value);
    const fee = Math.max(0, num(el.buyFee.value) ?? 0);
    if (!h || !addShares || addPrice == null) { event.preventDefault(); return; }

    const shares = h.shares + Math.floor(addShares);
    // 手数料は取得価額に含める（実務の扱いに合わせる）。
    h.avgPrice = Math.round(((h.avgPrice * h.shares + addPrice * addShares + fee) / shares) * 100) / 100;
    h.shares = shares;
    h.updatedAt = Date.now();

    let short = 0;
    if (el.buyFromCash.checked) {
      const payment = addPrice * addShares + fee;
      const money = cash[h.account] ?? 0;
      short = Math.max(0, payment - money);
      cash[h.account] = Math.max(0, money - payment);
      saveCash();
    }

    save();
    render();
    toast(`${h.name || h.code} を ${Math.floor(addShares).toLocaleString('ja-JP')}株 買い増しました`
      + (short > 0 ? `（余力が ${yen(short)} 足りなかったので0にしました）` : ''));
  }

  // ---------- 売却 ----------

  function openSellDialog(id) {
    const h = holdings.find((x) => x.id === id);
    if (!h || h.shares <= 0) return;
    sellTargetId = id;
    el.sellError.hidden = true;
    el.sellTargetName.textContent =
      `${h.name || h.code}［${accountOf(h).label}］（保有 ${h.shares.toLocaleString('ja-JP')}株・平均取得単価 ${yen(h.avgPrice, 2)}）`;

    el.sellShares.value = String(h.shares);
    el.sellShares.max = String(h.shares);
    el.sellPrice.value = h.quote?.price != null ? String(h.quote.price) : '';
    el.sellFee.value = '';
    el.sellDate.value = todayIso();
    el.sellToCash.checked = true;
    el.sellWithholding.checked = accountOf(h).taxable;

    const unit = h.unit || 100;
    const half = Math.floor(h.shares / 2 / unit) * unit;
    const quick = [];
    const addQuick = (label, shares) => {
      if (shares <= 0 || shares > h.shares) return;
      if (quick.some((q) => q.shares === shares)) return; // 同じ株数のボタンは1つでいい
      quick.push({ label, shares });
    };
    addQuick('全部', h.shares);
    addQuick(`半分（${half.toLocaleString('ja-JP')}株）`, half);
    addQuick(`${unit.toLocaleString('ja-JP')}株`, unit);
    el.sellQuick.innerHTML = quick
      .map((q) => `<button type="button" class="btn btn-sm" data-sell-shares="${q.shares}">${esc(q.label)}</button>`)
      .join('');

    updateSellPreview();
    el.sellDialog.showModal();
  }

  /** 売却の内訳を計算する。実現損益は「（売値 − 平均取得単価）× 株数 − 手数料」。 */
  function calcSell(h) {
    const shares = Math.floor(num(el.sellShares.value) ?? 0);
    const price = num(el.sellPrice.value);
    const fee = Math.max(0, num(el.sellFee.value) ?? 0);
    if (!h || shares <= 0 || price == null) return null;

    const gross = price * shares;
    const realized = (price - h.avgPrice) * shares - fee;
    const taxable = accountOf(h).taxable && realized > 0;
    const tax = taxable ? Math.floor(realized * (1 - taxFactor())) : 0;
    const withheld = el.sellWithholding.checked ? tax : 0;
    return {
      shares, price, fee, gross, realized, tax, withheld,
      proceeds: gross - fee - withheld,
      restShares: h.shares - shares,
    };
  }

  function updateSellPreview() {
    const h = holdings.find((x) => x.id === sellTargetId);
    const c = calcSell(h);
    if (!c) { el.sellPreview.innerHTML = ''; return; }

    const money = cash[h.account] ?? 0;
    const row = (label, value, klass) =>
      `<tr><td>${esc(label)}</td><td class="${klass ?? ''}">${esc(value)}</td></tr>`;

    el.sellPreview.innerHTML = `
<table class="sim-table">
  <tbody>
    ${row('売却代金', `${c.shares.toLocaleString('ja-JP')}株 × ${yen(c.price, 2)} = ${yen(c.gross)}`)}
    ${c.fee > 0 ? row('手数料', `-${yen(c.fee)}`) : ''}
    ${row('実現損益（税引前）', signed(c.realized), plClass(c.realized))}
    ${accountOf(h).taxable
      ? row(`税金の目安（${settings.taxRate}%）`, c.tax > 0 ? `-${yen(c.tax)}${el.sellWithholding.checked ? '' : '（受取額からは引かない）'}` : '利益が出ていないので0円')
      : row('税金', 'NISAのため非課税', 'up')}
    ${row('受取額', yen(c.proceeds))}
    ${el.sellToCash.checked ? row('投資余力', `${yen(money)} → ${yen(money + c.proceeds)}`) : ''}
    ${row('売却後の保有', `${c.restShares.toLocaleString('ja-JP')}株${c.restShares === 0 ? '（全部売却）' : ''}`)}
  </tbody>
</table>`;
  }

  function submitSell(event) {
    const h = holdings.find((x) => x.id === sellTargetId);
    const c = calcSell(h);
    if (!h || !c) {
      event.preventDefault();
      el.sellError.textContent = '売却する株数と約定単価を入力してください。';
      el.sellError.hidden = false;
      return;
    }
    if (c.shares > h.shares) {
      event.preventDefault();
      el.sellError.textContent = `保有株数（${h.shares.toLocaleString('ja-JP')}株）を超えています。`;
      el.sellError.hidden = false;
      return;
    }

    const cashApplied = el.sellToCash.checked ? c.proceeds : 0;
    sales.push(normalizeSale({
      holdingId: h.id,
      code: h.code,
      name: h.name,
      account: h.account,
      date: el.sellDate.value || todayIso(),
      shares: c.shares,
      price: c.price,
      avgPrice: h.avgPrice,
      fee: c.fee,
      tax: c.tax,
      realized: c.realized,
      proceeds: c.proceeds,
      cashApplied,
      createdAt: Date.now(),
    }));

    // 売っても平均取得単価は変わらない（残った株の取得価額はそのまま）。
    h.shares = c.restShares;
    h.updatedAt = Date.now();

    if (cashApplied) {
      cash[h.account] = (cash[h.account] ?? 0) + cashApplied;
      saveCash();
    }

    saveSales();
    save();
    render();
    toast(`${h.name || h.code} を ${c.shares.toLocaleString('ja-JP')}株 売却しました（実現損益 ${signed(c.realized)}）`);
  }

  /** 売却の取り消し。株数と余力を元に戻す。 */
  function undoSale(saleId) {
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) return;
    const h = holdings.find((x) => x.id === sale.holdingId)
      ?? holdings.find((x) => x.code === sale.code && x.account === sale.account);

    if (!confirm(`${sale.name || sale.code} の売却（${sale.date}・${sale.shares.toLocaleString('ja-JP')}株）を取り消しますか？`
      + (h ? '\n株数と投資余力を元に戻します。' : '\n※銘柄が削除されているため、投資余力だけ元に戻します。'))) return;

    if (h) {
      h.shares += sale.shares;
      h.updatedAt = Date.now();
      save();
    }
    if (sale.cashApplied) {
      cash[sale.account] = Math.max(0, (cash[sale.account] ?? 0) - sale.cashApplied);
      saveCash();
    }
    sales = sales.filter((s) => s.id !== saleId);
    saveSales();
    render();
    toast('売却の記録を取り消しました');
  }

  // ---------- 投資余力 ----------

  function openCashDialog() {
    el.cashRows.innerHTML = ACCOUNTS.map((a) => `
<label class="field">
  <span>${esc(a.label)}</span>
  <input type="number" class="cash-input" data-account="${esc(a.value)}" min="0" step="1"
         inputmode="numeric" value="${cash[a.value] ? String(cash[a.value]) : ''}" placeholder="0">
</label>`).join('');
    el.cashDialog.showModal();
  }

  function submitCash() {
    for (const input of el.cashRows.querySelectorAll('.cash-input')) {
      const v = num(input.value);
      cash[input.dataset.account] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    saveCash();
    render();
    toast(`投資余力を保存しました（合計 ${yen(totalCash())}）`);
  }

  // ---------- シミュレーション ----------

  function openSimDialog(id) {
    const h = holdings.find((x) => x.id === id);
    if (!h) return;
    simTargetId = id;
    el.simTargetName.textContent = `${h.name || h.code}［${accountOf(h).label}］（現在 ${h.shares.toLocaleString('ja-JP')}株・現在値 ${h.quote?.price != null ? yen(h.quote.price, 1) : '未取得'}）`;

    const unit = h.unit || 100;
    const next = nextTier(h.yutai, h.shares);
    const quick = [
      { label: `＋${unit.toLocaleString('ja-JP')}株`, add: unit },
      { label: `＋${(unit * 5).toLocaleString('ja-JP')}株`, add: unit * 5 },
      { label: `＋${(unit * 10).toLocaleString('ja-JP')}株`, add: unit * 10 },
    ];
    if (next) quick.unshift({ label: `次の優待まで（＋${next.lack.toLocaleString('ja-JP')}株）`, add: next.lack });

    el.simQuick.innerHTML = quick
      .map((q) => `<button type="button" class="btn btn-sm" data-add="${q.add}">${esc(q.label)}</button>`)
      .join('');

    const maxAdd = Math.max(unit * 10, next ? next.lack * 2 : 0, 1000);
    el.simRange.max = String(Math.ceil(maxAdd / unit) * unit);
    el.simRange.step = String(unit);
    const initial = next ? next.lack : unit;
    el.simAdd.value = String(initial);
    el.simRange.value = String(Math.min(initial, Number(el.simRange.max)));
    renderSim();
    el.simDialog.showModal();
  }

  function renderSim() {
    const h = holdings.find((x) => x.id === simTargetId);
    if (!h) return;
    const add = Math.max(0, Math.floor(num(el.simAdd.value) ?? 0));
    const price = h.quote?.price ?? h.avgPrice;

    const before = calc(h);
    const after = calc(h, h.shares + add);
    const addCost = price * add;
    const newAvg = h.shares + add > 0 ? (h.avgPrice * h.shares + price * add) / (h.shares + add) : 0;
    // 買い増し後の取得金額は「いまの取得金額 + 現在値での追加投資」
    const afterCost = before.cost + addCost;
    const afterTotalYield = afterCost > 0 && after.divShown != null ? (after.divShown + after.yutaiValue) / afterCost : null;

    const row = (label, b, a, diff) => `
<tr${diff ? ' class="highlight"' : ''}>
  <td>${esc(label)}</td><td>${b}</td><td>${a}</td><td class="diff">${diff ?? ''}</td>
</tr>`;

    const divDiff = before.divShown != null && after.divShown != null ? after.divShown - before.divShown : null;

    const yutaiLine = (() => {
      const b = before.tier ? `${before.tier.shares}株：${before.tier.text}` : '対象外';
      const a = after.tier ? `${after.tier.shares}株：${after.tier.text}` : '対象外';
      const changed = (before.tier?.shares ?? 0) !== (after.tier?.shares ?? 0);
      const nextAfter = after.next
        ? `<p class="sim-note">さらに ${after.next.lack.toLocaleString('ja-JP')}株（${yen(after.next.lack * price)}）で「${esc(after.next.text)}」に到達します。</p>`
        : '<p class="sim-note">これ以上の優待の段は登録されていません。</p>';
      return `
<div class="sim-yutai">
  <strong>株主優待</strong>：${esc(b)}<span class="arrow">→</span>${changed ? '<strong>' : ''}${esc(a)}${changed ? '</strong>' : ''}
  ${changed && after.tier ? `<span class="badge ok">ランクアップ</span>` : ''}
  ${nextAfter}
</div>`;
    })();

    el.simResult.innerHTML = `
<div class="table-scroll">
<table class="sim-table">
  <thead><tr><th>項目</th><th>現在</th><th>買い増し後</th><th>差分</th></tr></thead>
  <tbody>
    ${row('保有株数', `${h.shares.toLocaleString('ja-JP')}株`, `${(h.shares + add).toLocaleString('ja-JP')}株`, add ? `+${add.toLocaleString('ja-JP')}株` : '')}
    ${row('必要な追加資金', '—', yen(addCost), '')}
    ${(cash[h.account] ?? 0) > 0
      ? row('投資余力', yen(cash[h.account]), addCost > (cash[h.account] ?? 0)
        ? `${yen(0)}（${yen(addCost - cash[h.account])}不足）`
        : yen((cash[h.account] ?? 0) - addCost), '')
      : ''}
    ${row('取得金額', yen(before.cost), yen(afterCost), signed(addCost))}
    ${row('平均取得単価', yen(h.avgPrice, 2), yen(newAvg, 2), '')}
    ${row(`年間配当${settings.afterTax ? (accountOf(h).taxable ? '（税引後）' : '（NISA・非課税）') : '（税引前）'}`, yen(before.divShown), yen(after.divShown), divDiff != null ? signed(divDiff) : '', true)}
    ${row('優待の価値（年・目安）', yen(before.yutaiValue), yen(after.yutaiValue), signed(after.yutaiValue - before.yutaiValue), after.yutaiValue !== before.yutaiValue)}
    ${row('配当＋優待の合計', yen((before.divShown ?? 0) + before.yutaiValue), yen((after.divShown ?? 0) + after.yutaiValue), signed(((after.divShown ?? 0) + after.yutaiValue) - ((before.divShown ?? 0) + before.yutaiValue)))}
    ${row('総合利回り（取得ベース）', pct(before.totalYield), pct(afterTotalYield), '')}
  </tbody>
</table>
</div>
${yutaiLine}
<p class="sim-note">追加ぶんは現在値（${h.quote?.price != null ? yen(h.quote.price, 1) : '未取得のため取得単価'}）で買えたものとして計算しています。配当は1株あたり ${before.dps != null ? `${before.dps}円` : '不明'} が続く前提です。</p>`;
  }

  // ---------- 株価の取得 ----------

  function requestQuotes(ids, opts = {}) {
    const run = () => fetchQuotes(ids, opts);
    if (settings.netConsent) return run();
    pendingNetAction = run;
    el.netDialog.showModal();
  }

  async function fetchQuotes(ids, opts = {}) {
    const targets = holdings.filter((h) => ids.includes(h.id) && h.code);
    if (!targets.length) return;
    el.refreshBtn.disabled = true;
    el.refreshBtn.textContent = '取得中…';
    let ok = 0;
    const failed = [];

    // 同じ銘柄を複数の口座で持っていても、取得は1回で済ませる。
    const codes = [...new Set(targets.map((h) => h.code))];
    for (const code of codes) {
      try {
        const q = await window.Quotes.fetchQuote(code);
        for (const h of targets.filter((x) => x.code === code)) {
          h.quote = q;
          if (!h.name && q.nameEn) h.name = q.nameEn;
          if (!h.months.length && q.divMonths?.length) h.months = q.divMonths;
        }
        ok++;
      } catch (err) {
        console.warn(`${code} の取得に失敗`, err);
        failed.push(code);
      }
    }

    save();
    render();
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = '株価を更新';

    if (opts.quiet && !failed.length) return;
    if (failed.length && !ok) toast(`取得に失敗しました（${failed.join('・')}）。時間をおいて試すか、設定で中継先を変更してください。`);
    else if (failed.length) toast(`${ok}銘柄を更新（失敗：${failed.join('・')}）`);
    else toast(`${ok}銘柄の株価を更新しました`);
  }

  // ---------- 読み書き（JSON） ----------

  function exportJson() {
    const payload = {
      app: 'jp-stock-portfolio',
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: { taxRate: settings.taxRate },
      holdings,
      cash,
      sales,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `japan-stock-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('JSONを書き出しました');
  }

  async function importJson(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : parsed.holdings;
      if (!Array.isArray(rows)) throw new Error('holdings が見つかりません');
      const incoming = rows.map(normalize);
      // 銘柄コードだけでなく口座も見て突き合わせる（同じ銘柄を別口座で持てるため）
      const keyOf = (h) => `${h.code}:${h.account}`;
      const byKey = new Map(holdings.map((h) => [keyOf(h), h]));
      let added = 0, updated = 0;
      for (const h of incoming) {
        const key = keyOf(h);
        if (byKey.has(key)) {
          const cur = byKey.get(key);
          Object.assign(cur, h, { id: cur.id, createdAt: cur.createdAt });
          updated++;
        } else {
          holdings.push(h);
          byKey.set(key, h);
          added++;
        }
      }
      if (parsed.settings?.taxRate != null) settings.taxRate = Number(parsed.settings.taxRate);

      // 投資余力は「入っていれば置き換える」。売却履歴はIDで重複を避けて足す。
      let cashLoaded = false;
      if (parsed.cash && typeof parsed.cash === 'object') {
        cash = normalizeCash(parsed.cash);
        saveCash();
        cashLoaded = true;
      }
      let salesAdded = 0;
      if (Array.isArray(parsed.sales)) {
        const known = new Set(sales.map((s) => s.id));
        for (const raw of parsed.sales) {
          const s = normalizeSale(raw);
          if (known.has(s.id)) continue;
          sales.push(s);
          known.add(s.id);
          salesAdded++;
        }
        saveSales();
      }

      save();
      saveSettings();
      render();
      toast(`読み込みました（追加 ${added}件 / 更新 ${updated}件`
        + (salesAdded ? ` / 売却 ${salesAdded}件` : '')
        + (cashLoaded ? ' / 投資余力も反映' : '') + '）');
    } catch (err) {
      console.error(err);
      toast('読み込みに失敗しました（JSONの形式を確認してください）');
    }
  }

  function addSample() {
    const samples = [
      { code: '7203', account: 'nisa-growth', avgPrice: 2450, shares: 200, memo: '' },
      { code: '2702', account: 'tokutei', avgPrice: 5600, shares: 100, memo: '優待めあて' },
      { code: '8058', account: 'nisa-growth', avgPrice: 2980, shares: 300, memo: '' },
      { code: '8058', account: 'tokutei', avgPrice: 3450, shares: 100, memo: 'NISA枠を使い切ったぶん' },
    ];
    let added = 0;
    for (const s of samples) {
      if (holdings.some((h) => h.code === s.code && h.account === s.account)) continue;
      const p = presetByCode.get(s.code);
      holdings.push(normalize({
        ...s,
        name: nameOfCode(s.code),
        unit: p?.unit ?? 100,
        months: p?.months ?? [],
        yutai: p?.yutai ?? null,
      }));
      added++;
    }
    save();
    render();
    toast(added ? `サンプルを${added}件追加しました` : 'サンプルはすでに登録済みです');
    if (added) requestQuotes(holdings.map((h) => h.id), { quiet: true });
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

  function closestId(target) {
    const holder = target.closest('[data-id]');
    return holder ? holder.dataset.id : null;
  }

  // ---------- イベント ----------

  function bind() {
    el.addBtn.addEventListener('click', () => openHoldingDialog(null));
    el.refreshBtn.addEventListener('click', () => {
      if (!holdings.length) return toast('先に銘柄を追加してください');
      requestQuotes(holdings.map((h) => h.id));
    });

    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    // メニュー
    el.menuBtn.addEventListener('click', () => {
      const open = el.menuList.hidden;
      el.menuList.hidden = !open;
      el.menuBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu') && !el.menuList.hidden) {
        el.menuList.hidden = true;
        el.menuBtn.setAttribute('aria-expanded', 'false');
      }
    });

    $('#exportBtn').addEventListener('click', exportJson);
    $('#importBtn').addEventListener('click', () => el.importFile.click());
    el.importFile.addEventListener('change', () => {
      const file = el.importFile.files?.[0];
      if (file) importJson(file);
      el.importFile.value = '';
    });
    $('#sampleBtn').addEventListener('click', addSample);
    $('#clearBtn').addEventListener('click', () => {
      if (!confirm('登録した銘柄・売却履歴・投資余力をすべて削除します。よろしいですか？')) return;
      holdings = [];
      sales = [];
      cash = normalizeCash({});
      save();
      saveSales();
      saveCash();
      render();
      toast('すべて削除しました');
    });
    $('#settingsBtn').addEventListener('click', () => {
      el.taxRateInput.value = String(settings.taxRate);
      el.relayInput.value = settings.relay;
      el.autoRefreshInput.checked = !!settings.autoRefresh;
      el.settingsDialog.showModal();
    });

    // 一覧の操作
    el.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = closestId(btn);
      if (!id) return;
      switch (btn.dataset.act) {
        case 'sim': openSimDialog(id); break;
        case 'buy': openBuyDialog(id); break;
        case 'sell': openSellDialog(id); break;
        case 'edit': openHoldingDialog(id); break;
        case 'refresh': requestQuotes([id]); break;
        case 'delete': {
          const h = holdings.find((x) => x.id === id);
          if (!h) return;
          if (!confirm(`${h.name || h.code} を削除しますか？`)) return;
          holdings = holdings.filter((x) => x.id !== id);
          save();
          render();
          toast('削除しました');
          break;
        }
      }
    });

    // 表示の設定
    el.search.addEventListener('input', renderList);
    el.sortBy.addEventListener('change', () => {
      settings.sort = el.sortBy.value;
      saveSettings();
      renderList();
    });
    el.filterAccount.addEventListener('change', () => {
      settings.account = el.filterAccount.value;
      saveSettings();
      render();
    });
    // 口座別サマリーのカードを押したら、その口座に絞り込む（もう一度押すと解除）
    el.accountGrid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-account]');
      if (!card) return;
      settings.account = settings.account === card.dataset.account ? '' : card.dataset.account;
      el.filterAccount.value = settings.account;
      saveSettings();
      render();
    });
    el.viewMode.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (!btn) return;
      settings.view = btn.dataset.view;
      saveSettings();
      for (const b of el.viewMode.querySelectorAll('button')) {
        const on = b === btn;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      renderList();
    });
    el.afterTax.addEventListener('change', () => {
      settings.afterTax = el.afterTax.checked;
      saveSettings();
      render();
    });

    // 銘柄ダイアログ
    el.holdingForm.addEventListener('submit', submitHolding);
    // 全角で入力されることがあるので半角へ寄せる（英字は候補を出したあとに大文字化する）。
    el.codeInput.addEventListener('input', () => {
      const half = toHalfWidth(el.codeInput.value);
      if (half !== el.codeInput.value) {
        const pos = el.codeInput.selectionStart;
        el.codeInput.value = half;
        el.codeInput.setSelectionRange(pos, pos);
      }
      showSuggest();
    });
    el.codeInput.addEventListener('focus', () => { if (el.codeInput.value.trim()) showSuggest(); });
    el.codeInput.addEventListener('change', () => applyPreset(false));
    el.codeInput.addEventListener('blur', () => {
      // 候補のボタンを押す前に閉じてしまわないよう、少しだけ待つ。
      setTimeout(() => {
        hideSuggest();
        // 「7203」のようにコードだけ入れて確定したときは大文字に揃えて補完する。
        el.codeInput.value = normalizeCode(el.codeInput.value);
        applyPreset(false);
      }, 150);
    });
    el.codeSuggest.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-code]');
      if (btn) pickSuggest(btn.dataset.code);
    });
    el.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.codeSuggest.hidden) {
        e.stopPropagation();
        hideSuggest();
      } else if (e.key === 'ArrowDown' && !el.codeSuggest.hidden) {
        e.preventDefault();
        el.codeSuggest.querySelector('button')?.focus();
      }
    });
    el.codeSuggest.addEventListener('keydown', (e) => {
      const buttons = [...el.codeSuggest.querySelectorAll('button')];
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); buttons[Math.min(i + 1, buttons.length - 1)]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? el.codeInput : buttons[i - 1]).focus(); }
      else if (e.key === 'Escape') { e.stopPropagation(); hideSuggest(); el.codeInput.focus(); }
    });
    el.addTierBtn.addEventListener('click', () => addTierRow(null));

    // 買い増しダイアログ
    el.buyForm.addEventListener('submit', submitBuy);
    el.buyShares.addEventListener('input', updateBuyPreview);
    el.buyPrice.addEventListener('input', updateBuyPreview);
    el.buyFee.addEventListener('input', updateBuyPreview);
    el.buyFromCash.addEventListener('change', updateBuyPreview);

    // 売却ダイアログ
    el.sellForm.addEventListener('submit', submitSell);
    for (const node of [el.sellShares, el.sellPrice, el.sellFee]) {
      node.addEventListener('input', updateSellPreview);
    }
    for (const node of [el.sellToCash, el.sellWithholding]) {
      node.addEventListener('change', updateSellPreview);
    }
    el.sellQuick.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sell-shares]');
      if (!btn) return;
      el.sellShares.value = btn.dataset.sellShares;
      updateSellPreview();
    });

    // 投資余力
    $('#cashBtn').addEventListener('click', openCashDialog);
    el.cashForm.addEventListener('submit', submitCash);

    // 売却履歴の取り消し
    el.salesList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="undo-sale"]');
      if (!btn) return;
      undoSale(btn.closest('[data-sale]')?.dataset.sale);
    });

    el.showSold.addEventListener('change', () => {
      settings.showSold = el.showSold.checked;
      saveSettings();
      renderList();
    });

    // シミュレーション
    el.simAdd.addEventListener('input', () => {
      el.simRange.value = String(Math.min(Number(el.simAdd.value) || 0, Number(el.simRange.max)));
      renderSim();
    });
    el.simRange.addEventListener('input', () => {
      el.simAdd.value = el.simRange.value;
      renderSim();
    });
    el.simQuick.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-add]');
      if (!btn) return;
      el.simAdd.value = btn.dataset.add;
      el.simRange.value = String(Math.min(Number(btn.dataset.add), Number(el.simRange.max)));
      renderSim();
    });
    el.simApplyBtn.addEventListener('click', () => {
      const h = holdings.find((x) => x.id === simTargetId);
      const add = Math.floor(num(el.simAdd.value) ?? 0);
      if (!h || add <= 0) return;
      el.simDialog.close();
      openBuyDialog(h.id, add, h.quote?.price ?? h.avgPrice);
    });

    // 通信の確認
    el.netAgreeBtn.addEventListener('click', () => {
      settings.netConsent = true;
      saveSettings();
      el.netDialog.close();
      const action = pendingNetAction;
      pendingNetAction = null;
      action?.();
    });
    el.netDialog.addEventListener('close', () => { pendingNetAction = null; });

    // 設定
    el.settingsForm.addEventListener('submit', () => {
      settings.taxRate = Math.min(Math.max(num(el.taxRateInput.value) ?? DEFAULT_TAX_RATE, 0), 100);
      settings.relay = el.relayInput.value.trim();
      settings.autoRefresh = el.autoRefreshInput.checked;
      window.Quotes.setCustomRelay(settings.relay);
      saveSettings();
      render();
      toast('設定を保存しました');
    });

    // ダイアログの「キャンセル」
    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => btn.closest('dialog')?.close());
    }
  }

  // ---------- 起動 ----------

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));
    initMaster();

    if (master.length && window.STOCK_MASTER_AS_OF) {
      $('#codeHint').textContent =
        `東証の全上場銘柄（${master.length.toLocaleString('ja-JP')}件・${window.STOCK_MASTER_AS_OF}時点）から検索できます。`
        + '数字4桁のコードのほか、186A のような英数字コードや銘柄名（ispace・神島化学 など）でも探せます。';
    }

    el.sortBy.value = settings.sort;
    el.filterAccount.value = settings.account ?? '';
    el.afterTax.checked = !!settings.afterTax;
    el.showSold.checked = !!settings.showSold;
    for (const b of el.viewMode.querySelectorAll('button')) {
      const on = b.dataset.view === settings.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }

    bind();
    render();

    if (settings.autoRefresh && settings.netConsent && holdings.length) {
      fetchQuotes(holdings.map((h) => h.id), { quiet: true });
    }
  }

  init();
})();
