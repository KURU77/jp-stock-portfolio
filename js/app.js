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

  /** 上場株式の配当にかかる税率（所得税15.315% + 住民税5%）。設定で変更可。 */
  const DEFAULT_TAX_RATE = 20.315;

  const $ = (sel) => document.querySelector(sel);

  const el = {
    list: $('#list'),
    empty: $('#empty'),
    search: $('#search'),
    sortBy: $('#sortBy'),
    viewMode: $('#viewMode'),
    afterTax: $('#afterTax'),
    updatedLine: $('#updatedLine'),
    calendarPanel: $('#calendarPanel'),
    calendar: $('#calendar'),
    yutaiPanel: $('#yutaiPanel'),
    yutaiList: $('#yutaiList'),
    codeOptions: $('#codeOptions'),
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
    buyPreview: $('#buyPreview'),
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
  let settings = defaultSettings();
  let editingId = null;
  let buyTargetId = null;
  let simTargetId = null;
  /** 通信の同意を取ったあとに実行する処理 */
  let pendingNetAction = null;

  const presetByCode = new Map();
  for (const p of (window.STOCK_PRESETS || [])) presetByCode.set(String(p.code), p);

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
  }

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
      code: String(h.code ?? '').trim().toUpperCase(),
      name: String(h.name ?? ''),
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
    const divShown = divGross != null ? (settings.afterTax ? divGross * taxFactor() : divGross) : null;
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

  function totals() {
    let cost = 0, value = 0, divShown = 0, yutai = 0;
    let hasPrice = false, hasDiv = false;
    for (const h of holdings) {
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
    renderList();
    renderCalendar();
    renderYutaiPanel();
  }

  function renderStats() {
    const t = totals();
    $('#statValue').textContent = t.value == null ? '—' : yen(t.value);
    $('#statCost').textContent = yen(t.cost);

    const plEl = $('#statPl');
    plEl.className = `stat-value ${plClass(t.pl)}`;
    plEl.innerHTML = t.pl == null
      ? '—'
      : `${esc(signed(t.pl))}<span class="sub">${esc(t.plRate == null ? '' : `(${t.plRate > 0 ? '+' : ''}${(t.plRate * 100).toFixed(2)}%)`)}</span>`;

    $('#statDivLabel').textContent = settings.afterTax ? `年間配当（税引後 ${settings.taxRate}%）` : '年間配当（税引前）';
    $('#statDiv').innerHTML = t.div == null
      ? '—'
      : `${esc(yen(t.div))}<span class="sub">${esc(t.divYield == null ? '' : `利回り ${(t.divYield * 100).toFixed(2)}%`)}</span>`;

    $('#statYutai').textContent = yen(t.yutai);
    $('#statYield').textContent = pct(t.totalYield);

    const stamps = holdings.map((h) => h.quote?.fetchedAt).filter(Boolean);
    if (stamps.length) {
      el.updatedLine.hidden = false;
      el.updatedLine.textContent = `株価の最終取得：${relTime(Math.max(...stamps))}（${new Date(Math.max(...stamps)).toLocaleString('ja-JP')}）／ 出所：Yahoo Finance・遅延あり`;
    } else {
      el.updatedLine.hidden = true;
    }
  }

  function visibleHoldings() {
    const q = el.search.value.trim().toLowerCase();
    let rows = holdings.filter((h) => {
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
      if (h.yutai?.abolished) {
        return `<p class="yutai-none">優待は廃止されています。${esc(h.yutai.note || '')}</p>`;
      }
      if (!h.yutai || !h.yutai.tiers.length) {
        return '<p class="yutai-none">優待は登録されていません（「編集」から追加できます）。</p>';
      }
      const now = c.tier
        ? `<p class="yutai-now"><span class="badge ok">${esc(c.tier.shares)}株以上</span> ${esc(c.tier.text)}${c.tier.value ? ` <span class="badge">年 ${esc(yen(c.tier.value))}相当</span>` : ''}</p>`
        : '<p class="yutai-none">いまの株数では優待の対象外です。</p>';
      const next = c.next
        ? `<p class="yutai-next">あと ${c.next.lack.toLocaleString('ja-JP')}株（${esc(yen(c.next.lack * (c.price ?? h.avgPrice)))}）で「${esc(c.next.text)}」</p>`
        : '';
      const note = h.yutai.note ? `<p class="note">${esc(h.yutai.note)}${h.yutai.asOf ? `（参考：${esc(h.yutai.asOf)}時点）` : ''}</p>` : '';
      return now + next + note;
    })();

    return `
<article class="card" data-id="${esc(h.id)}">
  <div class="card-top">
    <h3 class="card-title">${esc(h.name || '(名称未設定)')}<span class="card-code">${esc(h.code)}${h.quote?.nameEn ? ` ・ ${esc(h.quote.nameEn)}` : ''}</span></h3>
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
    <p class="mini-title">年間配当${settings.afterTax ? '（税引後）' : '（税引前）'}${h.divPerShare != null ? '<span class="badge accent">手入力</span>' : ''}</p>
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
      <th>銘柄</th><th>株数</th><th>取得単価</th><th>現在値</th><th>取得金額</th><th>評価額</th>
      <th>評価損益</th><th>損益率</th><th>年間配当</th><th>利回り</th><th>優待/年</th><th></th>
    </tr>
  </thead>
  <tbody>${body}</tbody>
  <tfoot>
    <tr>
      <td>合計</td><td></td><td></td><td></td>
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
  <div class="cal-bar ${amount > 0 ? '' : 'empty'}" style="height:${Math.max(h, amount > 0 ? 6 : 3)}px" title="${i + 1}月 ${esc(yen(amount))}"></div>
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
  <span class="y-name">${esc(h.name || h.code)}</span>
  <span class="badge">${esc(h.shares.toLocaleString('ja-JP'))}株</span>
  <span class="y-text">${esc(c.tier.text)}</span>
  <span class="y-value">${c.tier.value ? `年 ${esc(yen(c.tier.value))}相当` : '金額換算なし'}</span>
</li>`).join('');
  }

  // ---------- 銘柄の追加・編集 ----------

  function openHoldingDialog(id) {
    editingId = id ?? null;
    const h = id ? holdings.find((x) => x.id === id) : null;
    el.holdingDialogTitle.textContent = h ? '銘柄を編集' : '銘柄を追加';
    el.holdingError.hidden = true;

    el.codeInput.value = h?.code ?? '';
    el.nameInput.value = h?.name ?? '';
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

  /** 証券コードを入れたときに、プリセットから名前・優待などを補う。 */
  function applyPreset(force) {
    const code = el.codeInput.value.trim().toUpperCase();
    const p = presetByCode.get(code);
    if (!p) return;
    if (force || !el.nameInput.value.trim()) el.nameInput.value = p.name;
    if (force || !el.unitInput.value) el.unitInput.value = String(p.unit ?? 100);
    if ((force || !el.monthsInput.value.trim()) && p.months) el.monthsInput.value = p.months.join(',');
    const hasTiers = el.tierRows.querySelector('.tier-row');
    if (p.yutai && (force || !hasTiers)) {
      renderTierRows(p.yutai.tiers ?? []);
      el.yutaiNoteInput.value = p.yutai.abolished
        ? `【優待廃止】${p.yutai.note ?? ''}`
        : `${p.yutai.note ?? ''}${p.yutai.asOf ? `（参考：${p.yutai.asOf}時点・要確認）` : ''}`;
    }
  }

  function submitHolding(event) {
    const code = el.codeInput.value.trim().toUpperCase();
    const avgPrice = num(el.priceInput.value);
    const shares = num(el.sharesInput.value);

    if (!code) return failHolding(event, '証券コードを入力してください。');
    if (avgPrice == null || avgPrice < 0) return failHolding(event, '取得単価を正しく入力してください。');
    if (shares == null || shares < 0) return failHolding(event, '取得株数を正しく入力してください。');

    const dup = holdings.find((h) => h.code === code && h.id !== editingId);
    if (dup) return failHolding(event, `証券コード ${code} はすでに登録されています（買い増しは「買い増し」ボタンから）。`);

    const tiers = readTierRows();
    const yutaiNote = el.yutaiNoteInput.value.trim();
    const base = editingId ? holdings.find((h) => h.id === editingId) : null;

    const next = normalize({
      ...(base ?? {}),
      id: base?.id,
      code,
      name: el.nameInput.value.trim() || presetByCode.get(code)?.name || '',
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
    el.buyTargetName.textContent = `${h.name || h.code}（現在 ${h.shares.toLocaleString('ja-JP')}株・平均 ${yen(h.avgPrice, 2)}）`;
    el.buyShares.value = presetShares != null ? String(presetShares) : String(h.unit || 100);
    el.buyPrice.value = presetPrice != null ? String(Math.round(presetPrice * 10) / 10) : (h.quote?.price != null ? String(h.quote.price) : '');
    updateBuyPreview();
    el.buyDialog.showModal();
  }

  function updateBuyPreview() {
    const h = holdings.find((x) => x.id === buyTargetId);
    if (!h) return;
    const addShares = num(el.buyShares.value);
    const addPrice = num(el.buyPrice.value);
    if (!addShares || addPrice == null) { el.buyPreview.textContent = ''; return; }
    const shares = h.shares + addShares;
    const avg = (h.avgPrice * h.shares + addPrice * addShares) / shares;
    el.buyPreview.textContent =
      `→ ${shares.toLocaleString('ja-JP')}株 / 平均取得単価 ${yen(avg, 2)} / 追加投資額 ${yen(addPrice * addShares)}`;
  }

  function submitBuy(event) {
    const h = holdings.find((x) => x.id === buyTargetId);
    const addShares = num(el.buyShares.value);
    const addPrice = num(el.buyPrice.value);
    if (!h || !addShares || addPrice == null) { event.preventDefault(); return; }
    const shares = h.shares + Math.floor(addShares);
    h.avgPrice = Math.round(((h.avgPrice * h.shares + addPrice * addShares) / shares) * 100) / 100;
    h.shares = shares;
    h.updatedAt = Date.now();
    save();
    render();
    toast(`${h.name || h.code} を ${Math.floor(addShares).toLocaleString('ja-JP')}株 買い増しました`);
  }

  // ---------- シミュレーション ----------

  function openSimDialog(id) {
    const h = holdings.find((x) => x.id === id);
    if (!h) return;
    simTargetId = id;
    el.simTargetName.textContent = `${h.name || h.code}（現在 ${h.shares.toLocaleString('ja-JP')}株・現在値 ${h.quote?.price != null ? yen(h.quote.price, 1) : '未取得'}）`;

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
<table class="sim-table">
  <thead><tr><th>項目</th><th>現在</th><th>買い増し後</th><th>差分</th></tr></thead>
  <tbody>
    ${row('保有株数', `${h.shares.toLocaleString('ja-JP')}株`, `${(h.shares + add).toLocaleString('ja-JP')}株`, add ? `+${add.toLocaleString('ja-JP')}株` : '')}
    ${row('必要な追加資金', '—', yen(addCost), '')}
    ${row('取得金額', yen(before.cost), yen(afterCost), signed(addCost))}
    ${row('平均取得単価', yen(h.avgPrice, 2), yen(newAvg, 2), '')}
    ${row(`年間配当${settings.afterTax ? '（税引後）' : '（税引前）'}`, yen(before.divShown), yen(after.divShown), divDiff != null ? signed(divDiff) : '', true)}
    ${row('優待の価値（年・目安）', yen(before.yutaiValue), yen(after.yutaiValue), signed(after.yutaiValue - before.yutaiValue), after.yutaiValue !== before.yutaiValue)}
    ${row('配当＋優待の合計', yen((before.divShown ?? 0) + before.yutaiValue), yen((after.divShown ?? 0) + after.yutaiValue), signed(((after.divShown ?? 0) + after.yutaiValue) - ((before.divShown ?? 0) + before.yutaiValue)))}
    ${row('総合利回り（取得ベース）', pct(before.totalYield), pct(afterTotalYield), '')}
  </tbody>
</table>
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

    for (const h of targets) {
      try {
        const q = await window.Quotes.fetchQuote(h.code);
        h.quote = q;
        if (!h.name && q.nameEn) h.name = q.nameEn;
        if (!h.months.length && q.divMonths?.length) h.months = q.divMonths;
        ok++;
      } catch (err) {
        console.warn(`${h.code} の取得に失敗`, err);
        failed.push(h.code);
      }
    }

    save();
    render();
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = '株価を更新';

    if (opts.quiet && !failed.length) return;
    if (failed.length && !ok) toast(`取得に失敗しました（${failed.join('・')}）。時間をおいて試すか、設定で中継先を変更してください。`);
    else if (failed.length) toast(`${ok}件を更新（失敗：${failed.join('・')}）`);
    else toast(`${ok}件の株価を更新しました`);
  }

  // ---------- 読み書き（JSON） ----------

  function exportJson() {
    const payload = {
      app: 'jp-stock-portfolio',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { taxRate: settings.taxRate },
      holdings,
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
      const byCode = new Map(holdings.map((h) => [h.code, h]));
      let added = 0, updated = 0;
      for (const h of incoming) {
        if (byCode.has(h.code)) {
          const cur = byCode.get(h.code);
          Object.assign(cur, h, { id: cur.id, createdAt: cur.createdAt });
          updated++;
        } else {
          holdings.push(h);
          byCode.set(h.code, h);
          added++;
        }
      }
      if (parsed.settings?.taxRate != null) settings.taxRate = Number(parsed.settings.taxRate);
      save();
      saveSettings();
      render();
      toast(`読み込みました（追加 ${added}件 / 更新 ${updated}件）`);
    } catch (err) {
      console.error(err);
      toast('読み込みに失敗しました（JSONの形式を確認してください）');
    }
  }

  function addSample() {
    const samples = [
      { code: '7203', avgPrice: 2450, shares: 200, memo: 'NISA成長投資枠' },
      { code: '2702', avgPrice: 5600, shares: 100, memo: '優待めあて' },
      { code: '8058', avgPrice: 2980, shares: 300, memo: '' },
    ];
    let added = 0;
    for (const s of samples) {
      if (holdings.some((h) => h.code === s.code)) continue;
      const p = presetByCode.get(s.code);
      holdings.push(normalize({
        ...s,
        name: p?.name ?? '',
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
      if (!confirm('登録した銘柄をすべて削除します。よろしいですか？')) return;
      holdings = [];
      save();
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
    el.codeInput.addEventListener('change', () => applyPreset(false));
    el.codeInput.addEventListener('blur', () => applyPreset(false));
    el.addTierBtn.addEventListener('click', () => addTierRow(null));

    // 買い増しダイアログ
    el.buyForm.addEventListener('submit', submitBuy);
    el.buyShares.addEventListener('input', updateBuyPreview);
    el.buyPrice.addEventListener('input', updateBuyPreview);

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

  function buildCodeOptions() {
    el.codeOptions.innerHTML = (window.STOCK_PRESETS || [])
      .map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`)
      .join('');
  }

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));
    buildCodeOptions();

    el.sortBy.value = settings.sort;
    el.afterTax.checked = !!settings.afterTax;
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
