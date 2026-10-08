/* 損益のまとめ。
 *
 * ・確定した利益（実現損益）は、記録した売却だけを年・月ごとに集計する。
 * ・税額は「その年の課税口座の実現損益を合算して、プラスのときだけ税率をかける」。
 *   1件ずつに税をかけて足すと、年内の損と相殺（損益通算）されないぶん多く出てしまう。
 * ・含み損益は、いま持っている分の「現在値 − 平均取得単価 × 株数」。
 * ・配当は受け取りの履歴を持っていないので入れない（年間の見込みだけ参考に出す）。
 */
(() => {
  'use strict';

  const HOLDINGS_KEY = 'jp-stock-portfolio.holdings.v1';
  const SALES_KEY = 'jp-stock-portfolio.sales.v1';
  const SETTINGS_KEY = 'jp-stock-portfolio.settings.v1';
  const THEME_KEY = 'jp-stock-portfolio.theme';

  const ACCOUNTS = [
    { value: 'tokutei', label: '特定口座', short: '特定', taxable: true },
    { value: 'nisa-growth', label: 'NISA（成長投資枠）', short: 'NISA成長', taxable: false },
    { value: 'nisa-tsumitate', label: 'NISA（つみたて投資枠）', short: 'NISAつみたて', taxable: false },
    { value: 'ippan', label: '一般口座', short: '一般', taxable: true },
  ];

  const DEFAULT_TAX_RATE = 20.315;

  const $ = (sel) => document.querySelector(sel);

  const el = {
    empty: $('#empty'),
    themeToggle: $('#themeToggle'),
    yearPanel: $('#yearPanel'),
    yearChart: $('#yearChart'),
    yearTable: $('#yearTable'),
    monthPanel: $('#monthPanel'),
    yearSelect: $('#yearSelect'),
    monthChart: $('#monthChart'),
    monthList: $('#monthList'),
    unrealizedPanel: $('#unrealizedPanel'),
    unrealizedTable: $('#unrealizedTable'),
    dividendNote: $('#dividendNote'),
  };

  let holdings = [];
  let sales = [];
  let settings = {};
  let selectedYear = String(new Date().getFullYear());

  function read(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v ?? fallback;
    } catch { return fallback; }
  }

  function load() {
    holdings = read(HOLDINGS_KEY, []).filter((h) => h && Number(h.shares) > 0);
    sales = read(SALES_KEY, []).filter((s) => s && s.date);
    settings = read(SETTINGS_KEY, {});
  }

  const taxRate = () => {
    const r = Number(settings.taxRate);
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 100) : DEFAULT_TAX_RATE;
  };

  const accountOf = (x) => ACCOUNTS.find((a) => a.value === x.account) ?? ACCOUNTS[0];

  // ---------- 表示のためのフォーマット ----------

  const yen = (n, digits = 0) =>
    n == null || !Number.isFinite(n)
      ? '—'
      : `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('ja-JP', { maximumFractionDigits: digits })}円`;

  const signed = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${yen(n)}`);
  const cls = (n) => (n == null || !Number.isFinite(n) ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
  const pct = (r) => (r == null || !Number.isFinite(r) ? '—' : `${r > 0 ? '+' : ''}${(r * 100).toFixed(2)}%`);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function shortYen(n) {
    const abs = Math.abs(n);
    if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}億`;
    if (abs >= 10_000) return `${(n / 10_000).toFixed(abs >= 1_000_000 ? 0 : 1)}万`;
    return String(Math.round(n));
  }

  // ---------- 集計 ----------

  /** 年ごとの確定利益。税額は年内で通算してから計算する。 */
  function byYear() {
    const map = new Map();
    for (const s of sales) {
      const year = String(s.date).slice(0, 4);
      if (!/^\d{4}$/.test(year)) continue;
      const cur = map.get(year) ?? {
        year, count: 0, shares: 0, gross: 0, fee: 0,
        realized: 0, taxable: 0, nisa: 0, withheld: 0,
      };
      const taxableAccount = accountOf(s).taxable;
      cur.count += 1;
      cur.shares += Number(s.shares) || 0;
      cur.gross += (Number(s.price) || 0) * (Number(s.shares) || 0);
      cur.fee += Number(s.fee) || 0;
      cur.realized += Number(s.realized) || 0;
      cur.withheld += Number(s.tax) || 0;
      if (taxableAccount) cur.taxable += Number(s.realized) || 0;
      else cur.nisa += Number(s.realized) || 0;
      map.set(year, cur);
    }

    const rate = taxRate() / 100;
    return [...map.values()]
      .map((y) => {
        // 年内で損と益を相殺してから、プラスぶんにだけ課税する
        const tax = y.taxable > 0 ? Math.floor(y.taxable * rate) : 0;
        return { ...y, tax, net: y.realized - tax, refund: y.withheld - tax };
      })
      .sort((a, b) => b.year.localeCompare(a.year));
  }

  /** 選んだ年の月ごとの実現損益 */
  function byMonth(year) {
    const months = Array.from({ length: 12 }, () => 0);
    for (const s of sales) {
      if (String(s.date).slice(0, 4) !== year) continue;
      const m = Number(String(s.date).slice(5, 7));
      if (m >= 1 && m <= 12) months[m - 1] += Number(s.realized) || 0;
    }
    return months;
  }

  /** いま持っている分の含み損益 */
  function unrealized() {
    const rows = holdings.map((h) => {
      const price = Number(h.quote?.price);
      const shares = Number(h.shares) || 0;
      const cost = (Number(h.avgPrice) || 0) * shares;
      const value = Number.isFinite(price) ? price * shares : null;
      return {
        name: h.name || h.code,
        code: h.code,
        account: accountOf(h),
        shares,
        cost,
        value,
        pl: value == null ? null : value - cost,
        rate: value == null || cost <= 0 ? null : (value - cost) / cost,
        since: h.since || '',
      };
    });
    const total = rows.reduce((acc, r) => ({
      cost: acc.cost + r.cost,
      value: acc.value + (r.value ?? r.cost),
      pl: acc.pl + (r.pl ?? 0),
      known: acc.known || r.pl != null,
    }), { cost: 0, value: 0, pl: 0, known: false });
    return { rows: rows.sort((a, b) => (b.pl ?? -Infinity) - (a.pl ?? -Infinity)), total };
  }

  /** 参考：いまの保有から見た年間配当の見込み */
  function dividendForecast() {
    let gross = 0;
    let net = 0;
    const factor = 1 - taxRate() / 100;
    for (const h of holdings) {
      const dps = h.divPerShare ?? Number(h.quote?.divTtm);
      if (!Number.isFinite(dps)) continue;
      const amount = dps * (Number(h.shares) || 0);
      gross += amount;
      net += accountOf(h).taxable ? amount * factor : amount;
    }
    return { gross, net };
  }

  // ---------- 棒グラフ ----------

  /**
   * 0を基準にした棒グラフ。プラスは上、マイナスは下に伸びる。
   * @param {Array<{label: string, value: number}>} data
   */
  function barChart(data, { height = 190 } = {}) {
    if (!data.length) return '<p class="chart-empty">まだ記録がありません。</p>';

    const W = 720, H = height;
    const padL = 54, padR = 10, padT = 12, padB = 22;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const values = data.map((d) => d.value);
    let max = Math.max(0, ...values);
    let min = Math.min(0, ...values);
    if (max === min) { max = 1; min = -1; }
    const span = max - min;
    const y = (v) => padT + (1 - (v - min) / span) * innerH;
    const zero = y(0);

    const slot = innerW / data.length;
    const barW = Math.max(6, Math.min(48, slot * 0.6));

    const bars = data.map((d, i) => {
      const cx = padL + slot * (i + 0.5);
      const top = Math.min(y(d.value), zero);
      const h = Math.max(1, Math.abs(y(d.value) - zero));
      const up = d.value >= 0;
      return `
  <rect x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"
        rx="2" fill="${up ? 'var(--up)' : 'var(--down)'}" opacity=".85"><title>${esc(d.label)} ${esc(signed(d.value))}</title></rect>
  <text x="${cx.toFixed(1)}" y="${(H - 7).toFixed(1)}" text-anchor="middle" class="axis">${esc(d.label)}</text>
  ${d.value !== 0 ? `<text x="${cx.toFixed(1)}" y="${(up ? top - 3 : top + h + 10).toFixed(1)}" text-anchor="middle" class="axis bar-value">${esc(shortYen(d.value))}</text>` : ''}`;
    }).join('');

    const ticks = [max, (max + min) / 2, min].map((v) => `
  <line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${esc(shortYen(v))}</text>`).join('');

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="損益の棒グラフ">
  ${ticks}
  <line x1="${padL}" y1="${zero.toFixed(1)}" x2="${W - padR}" y2="${zero.toFixed(1)}" stroke="var(--text-muted)" stroke-width="1"/>
  ${bars}
</svg>`;
  }

  // ---------- 描画 ----------

  function renderStats() {
    const years = byYear();
    const thisYear = String(new Date().getFullYear());
    const cur = years.find((y) => y.year === thisYear);
    const un = unrealized();

    const set = (id, value, n) => {
      const node = $(id);
      node.className = `stat-value ${cls(n)}`;
      node.textContent = value;
    };

    set('#statUnrealized', un.total.known ? signed(un.total.pl) : '—', un.total.known ? un.total.pl : null);
    $('#statThisYearLabel').textContent = `${thisYear}年の確定利益（税引前）`;
    set('#statThisYear', cur ? signed(cur.realized) : '0円', cur ? cur.realized : 0);
    set('#statThisYearNet', cur ? signed(cur.net) : '0円', cur ? cur.net : 0);

    const total = (cur ? cur.realized : 0) + (un.total.known ? un.total.pl : 0);
    set('#statTotal', signed(total), total);
  }

  function renderYear() {
    const years = byYear();
    el.yearPanel.hidden = years.length === 0;
    if (!years.length) return;

    el.yearChart.innerHTML = barChart(
      years.slice().reverse().map((y) => ({ label: `${y.year}年`, value: y.realized })),
    );

    const totals = years.reduce((acc, y) => ({
      count: acc.count + y.count,
      gross: acc.gross + y.gross,
      realized: acc.realized + y.realized,
      taxable: acc.taxable + y.taxable,
      nisa: acc.nisa + y.nisa,
      tax: acc.tax + y.tax,
      net: acc.net + y.net,
    }), { count: 0, gross: 0, realized: 0, taxable: 0, nisa: 0, tax: 0, net: 0 });

    el.yearTable.innerHTML = `
<thead>
  <tr>
    <th>年</th><th>売却</th><th>売却代金</th><th>実現損益</th>
    <th>うち課税口座</th><th>うちNISA</th><th>税額の目安</th><th>手取り</th>
  </tr>
</thead>
<tbody>
  ${years.map((y) => `
  <tr>
    <td data-label="年" class="row-head">${esc(y.year)}年</td>
    <td data-label="売却">${y.count}件</td>
    <td data-label="売却代金">${esc(yen(y.gross))}</td>
    <td data-label="実現損益" class="${cls(y.realized)}">${esc(signed(y.realized))}</td>
    <td data-label="うち課税口座" class="${cls(y.taxable)}">${esc(signed(y.taxable))}</td>
    <td data-label="うちNISA" class="${cls(y.nisa)}">${y.nisa === 0 ? '—' : esc(signed(y.nisa))}</td>
    <td data-label="税額の目安">${y.tax ? `-${esc(yen(y.tax))}` : '0円'}</td>
    <td data-label="手取り" class="${cls(y.net)}">${esc(signed(y.net))}</td>
  </tr>`).join('')}
</tbody>
<tfoot>
  <tr>
    <td data-label="年" class="row-head">合計</td>
    <td data-label="売却">${totals.count}件</td>
    <td data-label="売却代金">${esc(yen(totals.gross))}</td>
    <td data-label="実現損益" class="${cls(totals.realized)}">${esc(signed(totals.realized))}</td>
    <td data-label="うち課税口座" class="${cls(totals.taxable)}">${esc(signed(totals.taxable))}</td>
    <td data-label="うちNISA" class="${cls(totals.nisa)}">${totals.nisa === 0 ? '—' : esc(signed(totals.nisa))}</td>
    <td data-label="税額の目安">${totals.tax ? `-${esc(yen(totals.tax))}` : '0円'}</td>
    <td data-label="手取り" class="${cls(totals.net)}">${esc(signed(totals.net))}</td>
  </tr>
</tfoot>`;

    // 源泉徴収された額と、年内で通算した目安がずれている年を知らせる
    const gaps = years.filter((y) => Math.abs(y.refund) >= 1);
    if (gaps.length) {
      const lines = gaps.map((y) => `${y.year}年は源泉徴収 ${yen(y.withheld)} に対して目安 ${yen(y.tax)}（差 ${signed(y.refund)}）`);
      el.yearChart.insertAdjacentHTML('afterend',
        `<p class="note gap-note">年内の損と相殺すると、売却ごとに引かれた税額と差が出ます。${esc(lines.join('／'))}。特定口座（源泉徴収あり）なら、年末や確定申告で調整されます。</p>`);
    }
  }

  function renderMonth() {
    const years = byYear();
    el.monthPanel.hidden = years.length === 0;
    if (!years.length) return;

    if (!years.some((y) => y.year === selectedYear)) selectedYear = years[0].year;
    el.yearSelect.innerHTML = years
      .map((y) => `<option value="${esc(y.year)}"${y.year === selectedYear ? ' selected' : ''}>${esc(y.year)}年</option>`)
      .join('');

    const months = byMonth(selectedYear);
    el.monthChart.innerHTML = barChart(
      months.map((v, i) => ({ label: `${i + 1}`, value: v })),
      { height: 190 },
    );

    const rows = sales
      .filter((s) => String(s.date).slice(0, 4) === selectedYear)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    el.monthList.innerHTML = rows.map((s) => {
      const a = accountOf(s);
      return `
<li>
  <div class="sale-head">
    <span class="sale-date num">${esc(s.date)}</span>
    <span class="sale-name">${esc(s.name || s.code)}</span>
    <span class="badge ${a.taxable ? '' : 'ok'}">${esc(a.short)}</span>
    <span class="sale-pl ${cls(s.realized)}">${esc(signed(s.realized))}</span>
  </div>
  <div class="sale-body">
    <span>${Number(s.shares).toLocaleString('ja-JP')}株 × ${esc(yen(s.price, 2))}</span>
    <span>取得 ${esc(yen(s.avgPrice, 2))}</span>
    ${s.fee ? `<span>手数料 ${esc(yen(s.fee))}</span>` : ''}
    <span>受取 ${esc(yen(s.proceeds))}</span>
  </div>
</li>`;
    }).join('');
  }

  function renderUnrealized() {
    const { rows, total } = unrealized();
    el.unrealizedPanel.hidden = rows.length === 0;
    if (!rows.length) return;

    el.unrealizedTable.innerHTML = `
<thead>
  <tr><th>銘柄</th><th>口座</th><th>株数</th><th>取得金額</th><th>評価額</th><th>含み損益</th><th>損益率</th><th>取得日</th></tr>
</thead>
<tbody>
  ${rows.map((r) => `
  <tr>
    <td data-label="銘柄" class="row-head">${esc(r.name)}<br><span style="font-size:.72rem;color:var(--text-muted)">${esc(r.code)}</span></td>
    <td data-label="口座"><span class="badge ${r.account.taxable ? '' : 'ok'}">${esc(r.account.short)}</span></td>
    <td data-label="株数">${r.shares.toLocaleString('ja-JP')}</td>
    <td data-label="取得金額">${esc(yen(r.cost))}</td>
    <td data-label="評価額">${r.value == null ? '株価未取得' : esc(yen(r.value))}</td>
    <td data-label="含み損益" class="${cls(r.pl)}">${esc(signed(r.pl))}</td>
    <td data-label="損益率" class="${cls(r.pl)}">${esc(pct(r.rate))}</td>
    <td data-label="取得日">${esc(r.since || '—')}</td>
  </tr>`).join('')}
</tbody>
<tfoot>
  <tr>
    <td data-label="銘柄" class="row-head">合計</td><td class="hide-sm"></td><td class="hide-sm"></td>
    <td data-label="取得金額">${esc(yen(total.cost))}</td>
    <td data-label="評価額">${esc(yen(total.value))}</td>
    <td data-label="含み損益" class="${cls(total.pl)}">${esc(signed(total.pl))}</td>
    <td data-label="損益率" class="${cls(total.pl)}">${esc(pct(total.cost > 0 ? total.pl / total.cost : null))}</td>
    <td class="hide-sm"></td>
  </tr>
</tfoot>`;

    const div = dividendForecast();
    el.dividendNote.textContent = div.gross > 0
      ? `参考：いまの保有だと年間配当は ${yen(div.gross)}（税引後の目安 ${yen(div.net)}・NISAは非課税で計算）。配当は上の損益には含めていません。`
      : '配当の見込みは、株価を更新すると出ます。配当は上の損益には含めていません。';
  }

  function render() {
    const hasData = sales.length > 0 || holdings.length > 0;
    el.empty.hidden = hasData;
    renderStats();
    renderYear();
    renderMonth();
    renderUnrealized();
  }

  function applyTheme(theme) {
    const t = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
    el.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));

    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    el.yearSelect.addEventListener('change', () => {
      selectedYear = el.yearSelect.value;
      renderMonth();
    });

    render();
  }

  init();
})();
