/* 資産のグラフ。
 *
 * ・保有データはポートフォリオ本体（localStorage）から読むだけ。
 * ・グラフは外部ライブラリを使わず、SVGを組み立てて描いています。
 * ・「過去1年の推移」は、いまの保有株数のまま1年前から持っていた場合の評価額です。
 *   売買のタイミングまでは再現できないので、実際の推移は日々のスナップショットで見ます。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'jp-stock-portfolio.holdings.v1';
  const SETTINGS_KEY = 'jp-stock-portfolio.settings.v1';
  const CASH_KEY = 'jp-stock-portfolio.cash.v1';
  const SALES_KEY = 'jp-stock-portfolio.sales.v1';
  const SNAPSHOTS_KEY = 'jp-stock-portfolio.snapshots.v1';
  const THEME_KEY = 'jp-stock-portfolio.theme';
  const DAILY_KEY = 'jp-stock-portfolio.daily.v1';

  const ACCOUNTS = [
    { value: 'tokutei', label: '特定口座', short: '特定' },
    { value: 'nisa-growth', label: 'NISA成長', short: 'NISA成長' },
    { value: 'nisa-tsumitate', label: 'NISAつみたて', short: 'NISAつみたて' },
    { value: 'ippan', label: '一般口座', short: '一般' },
  ];

  /** グラフの色。テーマの変数に寄せつつ、系列ごとに区別できる並びにする。 */
  const SERIES = ['#3b6ef0', '#14875a', '#b7791f', '#d64545', '#7c5cd6', '#0e8f9e', '#c2568c', '#5c7a99'];

  const $ = (sel) => document.querySelector(sel);

  const el = {
    reloadBtn: $('#reloadBtn'),
    themeToggle: $('#themeToggle'),
    empty: $('#empty'),
    toast: $('#toast'),
    historyChart: $('#historyChart'),
    historyLegend: $('#historyLegend'),
    historyNote: $('#historyNote'),
    snapshotChart: $('#snapshotChart'),
    snapshotLegend: $('#snapshotLegend'),
    plChart: $('#plChart'),
    stockDonut: $('#stockDonut'),
    stockLegend: $('#stockLegend'),
    accountDonut: $('#accountDonut'),
    accountLegend: $('#accountLegend'),
    rangeMode: $('#rangeMode'),
  };

  let holdings = [];
  let cash = {};
  let sales = [];
  let snapshots = [];
  let settings = {};
  /** @type {Record<string, {points: Array<{date:string,c:number}>, fetchedAt:number}>} コード別の日足 */
  let daily = {};
  let rangeDays = 250;

  // ---------- 読み込み ----------

  function load() {
    const read = (key, fallback) => {
      try {
        const v = JSON.parse(localStorage.getItem(key) || 'null');
        return v ?? fallback;
      } catch { return fallback; }
    };
    holdings = read(STORAGE_KEY, []).filter((h) => h && Number(h.shares) > 0);
    cash = read(CASH_KEY, {});
    sales = read(SALES_KEY, []);
    snapshots = read(SNAPSHOTS_KEY, []);
    settings = read(SETTINGS_KEY, {});
    daily = read(DAILY_KEY, {});
    if (settings.relay) window.Quotes.setCustomRelay(settings.relay);
  }

  const totalCash = () => ACCOUNTS.reduce((n, a) => n + (Number(cash[a.value]) || 0), 0);
  const totalCost = () => holdings.reduce((n, h) => n + h.avgPrice * h.shares, 0);
  const totalValue = () => holdings.reduce((n, h) => n + ((Number(h.quote?.price) || 0) * h.shares), 0);

  // ---------- 表示のためのフォーマット ----------

  const yen = (n, digits = 0) =>
    n == null || !Number.isFinite(n)
      ? '—'
      : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('ja-JP', { maximumFractionDigits: digits })}円`;

  const signed = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${yen(n)}`);
  const cls = (n) => (n == null || !Number.isFinite(n) ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 目盛りに使う短い金額（1,234万 / 56.7万 のように詰める） */
  function shortYen(n) {
    const abs = Math.abs(n);
    if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(abs >= 1_000_000_000 ? 0 : 1)}億`;
    if (abs >= 10_000) return `${(n / 10_000).toFixed(abs >= 1_000_000 ? 0 : 1)}万`;
    return String(Math.round(n));
  }

  const mmdd = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

  // ---------- 折れ線グラフ ----------

  /**
   * 日付つきの複数系列を折れ線で描く。
   * @param {Array<{date: string, values: Array<number|null>}>} rows
   * @param {Array<{label: string, color: string, dashed?: boolean, fill?: boolean}>} series
   */
  function lineChart(rows, series) {
    if (rows.length < 2) return '';

    const W = 720, H = 260;
    const padL = 52, padR = 12, padT = 12, padB = 26;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    // 描く系列だけで縦軸を決める（rows には描かない値も入っている）
    const all = rows.flatMap((r) => r.values.slice(0, series.length).filter((v) => Number.isFinite(v)));
    if (!all.length) return '';
    let min = Math.min(...all);
    let max = Math.max(...all);
    if (min === max) { min -= 1; max += 1; }
    // 0円をなるべく含めて、金額の大きさが伝わるようにする。
    if (min > 0 && min < max * 0.6) min = 0;
    const span = max - min;

    const x = (i) => padL + (i / (rows.length - 1)) * innerW;
    const y = (v) => padT + (1 - (v - min) / span) * innerH;

    // 横線の目盛り（4本）
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => min + span * r);
    const grid = ticks.map((v) => `
  <line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${esc(shortYen(v))}</text>`).join('');

    // 日付の目盛り（最大5個）
    const step = Math.max(1, Math.floor((rows.length - 1) / 4));
    const xLabels = [];
    for (let i = 0; i < rows.length; i += step) xLabels.push(i);
    if (xLabels[xLabels.length - 1] !== rows.length - 1) xLabels.push(rows.length - 1);
    const axis = xLabels.map((i) => `
  <text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${esc(mmdd(rows[i].date))}</text>`).join('');

    const paths = series.map((s, si) => {
      const pts = rows
        .map((r, i) => ({ i, v: r.values[si] }))
        .filter((p) => Number.isFinite(p.v));
      if (pts.length < 2) return '';
      const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
      const area = s.fill
        ? `<path d="${d} L${x(pts[pts.length - 1].i).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(pts[0].i).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="${s.color}" opacity=".10"/>`
        : '';
      return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="推移グラフ">${grid}${paths}${axis}</svg>`;
  }

  function legendHtml(series, rows) {
    const last = rows[rows.length - 1];
    return series.map((s, i) => {
      const v = last?.values[i];
      return `
<span class="legend-item">
  <span class="legend-swatch" style="background:${s.color}${s.dashed ? ';opacity:.6' : ''}"></span>
  ${esc(s.label)}<strong class="${s.plColor ? cls(v) : ''}">${esc(yen(v))}</strong>
</span>`;
    }).join('');
  }

  // ---------- 1年の推移（日足から再現） ----------

  function buildHistoryRows() {
    const codes = [...new Set(holdings.map((h) => h.code))];
    const have = codes.filter((c) => daily[c]?.points?.length);
    if (!have.length) return null;

    // 全銘柄に共通する日付だけを使う（新規上場などで長さが違うため）
    let dates = null;
    for (const c of have) {
      const set = new Set(daily[c].points.map((p) => p.date));
      dates = dates ? dates.filter((d) => set.has(d)) : [...set];
    }
    if (!dates || dates.length < 2) return null;
    dates.sort();
    if (rangeDays && dates.length > rangeDays) dates = dates.slice(-rangeDays);

    const priceAt = {};
    for (const c of have) {
      priceAt[c] = new Map(daily[c].points.map((p) => [p.date, p.c]));
    }

    const cost = totalCost();
    const money = totalCash();
    return dates.map((date) => {
      let value = 0;
      for (const h of holdings) {
        const p = priceAt[h.code]?.get(date);
        // 日足が無い銘柄は、いまの株価で据え置く（線が途切れないように）
        value += (p ?? Number(h.quote?.price) ?? 0) * h.shares;
      }
      return { date, values: [value + money, value, cost, value - cost] };
    });
  }

  function renderHistory() {
    const rows = buildHistoryRows();
    if (!rows) {
      el.historyChart.innerHTML = '<p class="chart-empty">まだ日足を取得していません。右上の「1年の推移を取得」を押してください。</p>';
      el.historyLegend.innerHTML = '';
      return;
    }
    const series = [
      { label: '資産合計', color: SERIES[0], fill: true },
      { label: '評価額', color: SERIES[1] },
      { label: '取得金額', color: 'var(--text-muted)', dashed: true },
    ];
    el.historyChart.innerHTML = lineChart(rows, series);
    el.historyLegend.innerHTML = legendHtml(series, rows)
      + `<span class="legend-item">評価損益<strong class="${cls(rows[rows.length - 1].values[3])}">${esc(signed(rows[rows.length - 1].values[3]))}</strong></span>`;

    const first = rows[0];
    const last = rows[rows.length - 1];
    const diff = last.values[0] - first.values[0];
    el.historyNote.innerHTML =
      `${esc(first.date)} 〜 ${esc(last.date)} の${rows.length}営業日。この期間で資産合計は `
      + `<strong class="${cls(diff)}">${esc(signed(diff))}</strong>（${esc(shortYen(first.values[0]))}円 → ${esc(shortYen(last.values[0]))}円）。`
      + '<br><strong>いまの保有株数のまま持っていた場合</strong>の評価額なので、実際の売買のタイミングは反映されていません。';
  }

  // ---------- 記録された資産（スナップショット） ----------

  function renderSnapshots() {
    const rows = snapshots
      .filter((s) => s && s.date)
      .map((s) => ({
        date: s.date,
        values: [(Number(s.value) || 0) + (Number(s.cash) || 0), Number(s.value) || 0, Number(s.cost) || 0],
      }));

    if (rows.length < 2) {
      el.snapshotChart.innerHTML = `
<p class="chart-empty">
  記録は${rows.length}日ぶんです。アプリを開いて株価を更新するたびに1日1件たまり、2日目からここに線が出ます。
</p>`;
      el.snapshotLegend.innerHTML = '';
      return;
    }

    const series = [
      { label: '資産合計', color: SERIES[0], fill: true },
      { label: '評価額', color: SERIES[1] },
      { label: '取得金額', color: 'var(--text-muted)', dashed: true },
    ];
    el.snapshotChart.innerHTML = lineChart(rows, series);
    el.snapshotLegend.innerHTML = legendHtml(series, rows);
  }

  // ---------- 銘柄別の評価損益 ----------

  function renderPlChart() {
    const rows = holdings
      .map((h) => {
        const price = Number(h.quote?.price);
        const cost = h.avgPrice * h.shares;
        const value = Number.isFinite(price) ? price * h.shares : null;
        return {
          name: h.name || h.code,
          code: h.code,
          account: ACCOUNTS.find((a) => a.value === h.account)?.short ?? '特定',
          pl: value == null ? null : value - cost,
          rate: value == null || cost <= 0 ? null : (value - cost) / cost,
        };
      })
      .filter((r) => r.pl != null)
      .sort((a, b) => b.pl - a.pl);

    if (!rows.length) {
      el.plChart.innerHTML = '<p class="chart-empty">株価を取得すると、銘柄ごとの損益が並びます。</p>';
      return;
    }

    const max = Math.max(...rows.map((r) => Math.abs(r.pl)), 1);
    el.plChart.innerHTML = `
<div class="pl-bars">
  ${rows.map((r) => {
      const w = (Math.abs(r.pl) / max) * 50; // 中央から左右へ最大50%
      const up = r.pl >= 0;
      return `
<div class="pl-row">
  <span class="pl-name">${esc(r.name)}<span class="pl-sub">${esc(r.account)} ${esc(r.code)}</span></span>
  <span class="pl-track">
    <span class="pl-bar ${up ? 'is-up' : 'is-down'}" style="width:${w.toFixed(1)}%;${up ? 'left:50%' : `left:${(50 - w).toFixed(1)}%`}"></span>
    <span class="pl-zero"></span>
  </span>
  <span class="pl-value ${cls(r.pl)}">${esc(signed(r.pl))}<span class="pl-sub">${r.rate == null ? '' : `${r.rate > 0 ? '+' : ''}${(r.rate * 100).toFixed(1)}%`}</span></span>
</div>`;
    }).join('')}
</div>`;
  }

  // ---------- 構成比（ドーナツ） ----------

  function donut(items) {
    const total = items.reduce((n, i) => n + i.value, 0);
    if (total <= 0) return '<p class="chart-empty">データがありません。</p>';

    const R = 60, r = 38, C = 70;
    let angle = -Math.PI / 2;
    const arcs = items.map((item, i) => {
      const slice = (item.value / total) * Math.PI * 2;
      const end = angle + slice;
      const large = slice > Math.PI ? 1 : 0;
      const p = (radius, a) => `${(C + radius * Math.cos(a)).toFixed(2)},${(C + radius * Math.sin(a)).toFixed(2)}`;
      // 1件しかないときは円弧では描けないので、まるごと塗った輪にする。
      const d = items.length === 1
        ? `M${p(R, 0)} A${R},${R} 0 1 1 ${p(R, Math.PI)} A${R},${R} 0 1 1 ${p(R, 0)} M${p(r, 0)} A${r},${r} 0 1 0 ${p(r, Math.PI)} A${r},${r} 0 1 0 ${p(r, 0)} Z`
        : `M${p(R, angle)} A${R},${R} 0 ${large} 1 ${p(R, end)} L${p(r, end)} A${r},${r} 0 ${large} 0 ${p(r, angle)} Z`;
      angle = end;
      return `<path d="${d}" fill="${item.color}" opacity=".9"><title>${esc(item.label)} ${esc(yen(item.value))}</title></path>`;
    }).join('');

    return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="構成比">${arcs}
  <text x="70" y="68" text-anchor="middle" class="donut-total">${esc(shortYen(total))}</text>
  <text x="70" y="82" text-anchor="middle" class="donut-unit">円</text>
</svg>`;
  }

  function donutLegend(items) {
    const total = items.reduce((n, i) => n + i.value, 0) || 1;
    return items.map((i) => `
<li>
  <span class="legend-swatch" style="background:${i.color}"></span>
  <span class="dl-name">${esc(i.label)}</span>
  <span class="dl-value">${esc(yen(i.value))}<span class="dl-rate">${((i.value / total) * 100).toFixed(1)}%</span></span>
</li>`).join('');
  }

  function renderDonuts() {
    // 銘柄別（上位7件＋その他）
    const stocks = holdings
      .map((h) => ({ label: h.name || h.code, value: (Number(h.quote?.price) || h.avgPrice) * h.shares }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
    const top = stocks.slice(0, 7).map((s, i) => ({ ...s, color: SERIES[i % SERIES.length] }));
    const rest = stocks.slice(7).reduce((n, s) => n + s.value, 0);
    if (rest > 0) top.push({ label: `その他 ${stocks.length - 7}銘柄`, value: rest, color: 'var(--text-muted)' });

    el.stockDonut.innerHTML = donut(top);
    el.stockLegend.innerHTML = donutLegend(top);

    // 口座別（株の評価額＋現金）
    const byAccount = ACCOUNTS.map((a, i) => {
      const stock = holdings
        .filter((h) => (h.account || 'tokutei') === a.value)
        .reduce((n, h) => n + (Number(h.quote?.price) || h.avgPrice) * h.shares, 0);
      return { label: a.label, value: stock + (Number(cash[a.value]) || 0), color: SERIES[i % SERIES.length] };
    }).filter((a) => a.value > 0);

    el.accountDonut.innerHTML = donut(byAccount);
    el.accountLegend.innerHTML = donutLegend(byAccount);
  }

  // ---------- サマリー ----------

  function renderStats() {
    const value = totalValue();
    const cost = totalCost();
    const money = totalCash();
    const realized = sales.reduce((n, s) => n + (Number(s.realized) || 0), 0);

    $('#statAssets').textContent = value + money > 0 ? yen(value + money) : '—';
    $('#statValue').textContent = value > 0 ? yen(value) : '—';

    const pl = $('#statPl');
    pl.className = `stat-value ${cls(value - cost)}`;
    pl.textContent = value > 0 ? signed(value - cost) : '—';

    const re = $('#statRealized');
    re.className = `stat-value ${cls(realized)}`;
    re.textContent = sales.length ? signed(realized) : '—';
  }

  function render() {
    el.empty.hidden = holdings.length > 0;
    renderStats();
    renderHistory();
    renderSnapshots();
    renderPlChart();
    renderDonuts();
  }

  // ---------- 日足の取得 ----------

  async function fetchHistory() {
    const codes = [...new Set(holdings.map((h) => h.code))].filter(Boolean);
    if (!codes.length) return toast('保有銘柄がありません');

    if (!settings.netConsent) {
      const agreed = confirm(
        '過去1年の株価を Yahoo Finance から取得します。\n'
        + 'ブラウザから直接は取得できないため、公開の中継サービスを経由します。\n'
        + '送信されるのは証券コードだけで、保有株数や取得単価は送信されません。\n\n'
        + '取得してよろしいですか？'
      );
      if (!agreed) return;
      settings.netConsent = true;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    el.reloadBtn.disabled = true;
    let ok = 0;
    const failed = [];
    for (const code of codes) {
      el.reloadBtn.textContent = `取得中… ${ok + failed.length + 1}/${codes.length}`;
      try {
        const d = await window.Quotes.fetchDaily(code);
        daily[code] = { points: d.points, fetchedAt: d.fetchedAt };
        ok++;
        render();
      } catch (err) {
        console.warn(`${code} の日足が取得できません`, err);
        failed.push(code);
      }
    }

    try {
      localStorage.setItem(DAILY_KEY, JSON.stringify(daily));
    } catch (err) {
      console.warn('日足の保存に失敗しました（容量が上限の可能性）', err);
    }

    el.reloadBtn.disabled = false;
    el.reloadBtn.textContent = '1年の推移を取得';
    render();

    if (failed.length && !ok) toast(`取得に失敗しました（${failed.join('・')}）`);
    else if (failed.length) toast(`${ok}銘柄を取得（失敗：${failed.join('・')}）`);
    else toast(`${ok}銘柄の日足を取得しました`);
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

  function bind() {
    el.reloadBtn.addEventListener('click', fetchHistory);

    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    el.rangeMode.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-range]');
      if (!btn) return;
      rangeDays = Number(btn.dataset.range);
      for (const b of el.rangeMode.querySelectorAll('button')) {
        const on = b === btn;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
      renderHistory();
    });
  }

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));
    bind();
    render();

    // 日足がまだ無く、通信に同意済みなら、開いた時点で取りに行く。
    const codes = [...new Set(holdings.map((h) => h.code))];
    if (codes.length && settings.netConsent && !codes.some((c) => daily[c])) fetchHistory();
  }

  init();
})();
