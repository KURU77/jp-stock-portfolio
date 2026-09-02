/* 資産のグラフ。
 *
 * ・保有データはポートフォリオ本体（localStorage）から読むだけ。
 * ・グラフは外部ライブラリを使わず、SVGを組み立てて描いています。
 * ・折れ線グラフはタップで日付と金額を表示し、2本指のつまみ／ホイールで
 *   拡大・縮小できます。元データが日足なので、いちばん拡大すると1日ずつ見られます。
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

  /** これ以上は拡大しない点数（＝日足で数日ぶん）。 */
  const MIN_POINTS = 6;

  const $ = (sel) => document.querySelector(sel);

  const el = {
    reloadBtn: $('#reloadBtn'),
    themeToggle: $('#themeToggle'),
    empty: $('#empty'),
    toast: $('#toast'),
    historyChart: $('#historyChart'),
    historyLegend: $('#historyLegend'),
    historyNote: $('#historyNote'),
    historyWindow: $('#historyWindow'),
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

  /** @type {ReturnType<typeof mountChart>|null} */
  let historyChart = null;
  let snapshotChart = null;

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
  const ymd = (date) => `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

  // ---------- 折れ線グラフ（拡大・タップ対応） ----------

  /**
   * 折れ線グラフを box に描いて、操作を受け付けるようにする。
   *
   * @param {HTMLElement} box 描画先
   * @param {object} opts
   *   rows: [{date, values: number[]}]（描く系列＋タップ表示だけの系列）
   *   series: [{label, color, dashed?, fill?}]（描く系列。rows.values の先頭から順に対応）
   *   extra: [{label, index, signed?}]（描かないがタップ表示には出す系列）
   *   onWindowChange: (start, end) => void
   */
  function mountChart(box, opts) {
    const state = {
      rows: opts.rows,
      series: opts.series,
      extra: opts.extra ?? [],
      start: 0,
      end: opts.rows.length - 1,
      cursor: null,
      geom: null,
    };

    box.classList.add('is-interactive');
    box.innerHTML = '<div class="chart-tip" hidden></div>';
    const tip = box.querySelector('.chart-tip');

    function visibleRows() {
      return state.rows.slice(state.start, state.end + 1);
    }

    function draw() {
      const rows = visibleRows();
      const svgOld = box.querySelector('svg');
      if (svgOld) svgOld.remove();
      if (rows.length < 2) return;

      // ビューボックスを実際の表示サイズに合わせると、線も点も文字も歪まない。
      const W = Math.max(280, Math.round(box.clientWidth || 320));
      const H = Math.max(180, Math.round(box.clientHeight || 240));
      const padL = 52, padR = 10, padT = 12, padB = 24;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;

      const drawn = state.series.length;
      const all = rows.flatMap((r) => r.values.slice(0, drawn).filter((v) => Number.isFinite(v)));
      if (!all.length) return;
      let min = Math.min(...all);
      let max = Math.max(...all);
      if (min === max) { min -= 1; max += 1; }
      // 拡大しているときは細かい上下を見たいので、0まで伸ばすのは全体表示のときだけ。
      const zoomed = rows.length < state.rows.length;
      if (!zoomed && min > 0 && min < max * 0.6) min = 0;
      const span = max - min;

      const x = (i) => padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
      const y = (v) => padT + (1 - (v - min) / span) * innerH;
      state.geom = { W, H, padL, padR, padT, padB, innerW, innerH, x, y, rows };

      const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => min + span * r);
      const grid = ticks.map((v) => `
  <line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
  <text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${esc(shortYen(v))}</text>`).join('');

      const labelCount = Math.min(5, rows.length);
      const step = Math.max(1, Math.round((rows.length - 1) / (labelCount - 1 || 1)));
      const xIdx = [];
      for (let i = 0; i < rows.length; i += step) xIdx.push(i);
      if (xIdx[xIdx.length - 1] !== rows.length - 1) xIdx.push(rows.length - 1);
      const axis = xIdx.map((i) => `
  <text x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="axis">${esc(mmdd(rows[i].date))}</text>`).join('');

      // 拡大して点が少なくなったら、日足の1日ずつを丸で示す。
      const showDots = rows.length <= 60;

      const paths = state.series.map((s, si) => {
        const pts = rows.map((r, i) => ({ i, v: r.values[si] })).filter((p) => Number.isFinite(p.v));
        if (pts.length < 2) return '';
        const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
        const area = s.fill
          ? `<path d="${d} L${x(pts[pts.length - 1].i).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(pts[0].i).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="${s.color}" opacity=".10"/>`
          : '';
        const dots = showDots && !s.dashed
          ? pts.map((p) => `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.2" fill="${s.color}"/>`).join('')
          : '';
        return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
      }).join('');

      const cross = `
<g class="cross" hidden>
  <line class="cross-line" x1="0" x2="0" y1="${padT}" y2="${padT + innerH}"/>
  ${state.series.map((s) => `<circle class="cross-dot" r="4" fill="${s.color}"/>`).join('')}
</g>`;

      box.insertAdjacentHTML('afterbegin',
        `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="推移グラフ">${grid}${paths}${axis}${cross}</svg>`);

      if (state.cursor != null) updateCursor(state.cursor);
      opts.onWindowChange?.(state.start, state.end);
    }

    /** 画面のX座標 → 表示中の行番号 */
    function indexFromClientX(clientX) {
      const g = state.geom;
      if (!g) return null;
      const rect = box.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * g.W;
      const ratio = (vx - g.padL) / g.innerW;
      const i = Math.round(ratio * (g.rows.length - 1));
      return Math.min(Math.max(i, 0), g.rows.length - 1);
    }

    /** 十字線とふきだしを、表示中の i 番目に合わせる */
    function updateCursor(i) {
      const g = state.geom;
      const svg = box.querySelector('svg');
      if (!g || !svg) return;
      const row = g.rows[i];
      if (!row) return;
      state.cursor = i;

      const group = svg.querySelector('.cross');
      group.removeAttribute('hidden');
      const cx = g.x(i);
      group.querySelector('.cross-line').setAttribute('x1', cx.toFixed(1));
      group.querySelector('.cross-line').setAttribute('x2', cx.toFixed(1));
      const dots = group.querySelectorAll('.cross-dot');
      state.series.forEach((s, si) => {
        const v = row.values[si];
        const dot = dots[si];
        if (!Number.isFinite(v)) { dot.setAttribute('r', '0'); return; }
        dot.setAttribute('r', '4');
        dot.setAttribute('cx', cx.toFixed(1));
        dot.setAttribute('cy', g.y(v).toFixed(1));
      });

      const lines = state.series.map((s, si) => `
<span class="tip-row"><span class="legend-swatch" style="background:${s.color}"></span>${esc(s.label)}<strong>${esc(yen(row.values[si]))}</strong></span>`).join('')
        + state.extra.map((e) => `
<span class="tip-row tip-extra">${esc(e.label)}<strong class="${e.signed ? cls(row.values[e.index]) : ''}">${esc(e.signed ? signed(row.values[e.index]) : yen(row.values[e.index]))}</strong></span>`).join('');

      tip.innerHTML = `<span class="tip-date">${esc(ymd(row.date))}</span>${lines}`;
      tip.hidden = false;

      // ふきだしは指の反対側に出して、指で隠れないようにする。
      const boxW = box.clientWidth;
      const px = (cx / g.W) * boxW;
      const tipW = tip.offsetWidth || 150;
      let left = px + 12;
      if (left + tipW > boxW - 4) left = px - tipW - 12;
      tip.style.left = `${Math.max(4, Math.min(left, boxW - tipW - 4))}px`;
    }

    function clearCursor() {
      state.cursor = null;
      tip.hidden = true;
      box.querySelector('.cross')?.setAttribute('hidden', '');
    }

    /**
     * 表示範囲を変える。
     * @param {number} count 表示する点数
     * @param {number} anchor 0〜1。この位置を保ったまま拡大縮小する
     */
    function setCount(count, anchor = 0.5) {
      const total = state.rows.length;
      const next = Math.min(Math.max(Math.round(count), MIN_POINTS), total);
      const center = state.start + (state.end - state.start) * anchor;
      let start = Math.round(center - next * anchor);
      start = Math.min(Math.max(start, 0), total - next);
      state.start = start;
      state.end = start + next - 1;
      state.cursor = null;
      draw();
    }

    function panBy(points) {
      const total = state.rows.length;
      const count = state.end - state.start + 1;
      let start = Math.min(Math.max(state.start + Math.round(points), 0), total - count);
      if (start === state.start) return;
      state.start = start;
      state.end = start + count - 1;
      draw();
    }

    // ---- 指・マウスの操作 ----

    const pointers = new Map();
    let pinch = null;
    let moved = false;

    box.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, e);
      if (pointers.size === 1) {
        moved = false;
        // 指が画面外へ出ても追えるようにする（合成イベントでは失敗するので握りつぶす）
        try { box.setPointerCapture(e.pointerId); } catch { /* 無視してよい */ }
        const i = indexFromClientX(e.clientX);
        if (i != null) updateCursor(i);
      } else if (pointers.size === 2 && opts.zoomable !== false) {
        clearCursor();
        const [a, b] = [...pointers.values()];
        pinch = {
          dist: Math.abs(a.clientX - b.clientX) || 1,
          mid: (a.clientX + b.clientX) / 2,
          count: state.end - state.start + 1,
          start: state.start,
        };
      }
    });

    box.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e);

      if (pointers.size === 1) {
        moved = true;
        const i = indexFromClientX(e.clientX);
        if (i != null) updateCursor(i);
        e.preventDefault();
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.abs(a.clientX - b.clientX) || 1;
        const mid = (a.clientX + b.clientX) / 2;
        const rect = box.getBoundingClientRect();
        const anchor = Math.min(Math.max((pinch.mid - rect.left) / rect.width, 0), 1);

        // つまむ幅が広がったら拡大（表示点数を減らす）
        setCount(pinch.count * (pinch.dist / dist), anchor);
        // 2本指を横に動かしたら、そのぶん左右に移動
        const shift = ((pinch.mid - mid) / rect.width) * (state.end - state.start + 1);
        if (Math.abs(shift) >= 1) {
          panBy(shift);
          pinch.mid = mid;
        }
        pinch.dist = dist;
        pinch.count = state.end - state.start + 1;
        e.preventDefault();
      }
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', release);
    box.addEventListener('pointerleave', (e) => {
      // マウスで外へ出たときだけ消す（指はタップしたまま読みたいので残す）
      if (e.pointerType === 'mouse' && !moved) return;
      if (e.pointerType === 'mouse') clearCursor();
      release(e);
    });

    box.addEventListener('wheel', (e) => {
      if (opts.zoomable === false) return;
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const anchor = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      const count = state.end - state.start + 1;
      setCount(e.deltaY > 0 ? count * 1.25 : count / 1.25, anchor);
    }, { passive: false });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(draw, 150);
    });

    return {
      draw,
      state,
      clearCursor,
      setRows(rows) {
        state.rows = rows;
        state.start = 0;
        state.end = rows.length - 1;
        state.cursor = null;
        draw();
      },
      /** 直近 count 点だけ表示する（3か月ボタンなど） */
      showLast(count) {
        const total = state.rows.length;
        const next = Math.min(Math.max(count, MIN_POINTS), total);
        state.start = total - next;
        state.end = total - 1;
        state.cursor = null;
        draw();
      },
      zoom(factor) {
        setCount((state.end - state.start + 1) * factor, 0.5);
      },
      reset() {
        state.start = 0;
        state.end = state.rows.length - 1;
        state.cursor = null;
        draw();
      },
    };
  }

  function legendHtml(series, row) {
    return series.map((s, i) => `
<span class="legend-item">
  <span class="legend-swatch" style="background:${s.color}${s.dashed ? ';opacity:.6' : ''}"></span>
  ${esc(s.label)}<strong>${esc(yen(row?.values[i]))}</strong>
</span>`).join('');
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

    const priceAt = {};
    for (const c of have) priceAt[c] = new Map(daily[c].points.map((p) => [p.date, p.c]));

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

  const HISTORY_SERIES = [
    { label: '資産合計', color: SERIES[0], fill: true },
    { label: '評価額', color: SERIES[1] },
    { label: '取得金額', color: 'var(--text-muted)', dashed: true },
  ];

  function renderHistory() {
    const rows = buildHistoryRows();
    if (!rows) {
      historyChart = null;
      el.historyChart.classList.remove('is-interactive');
      el.historyChart.innerHTML = '<p class="chart-empty">まだ日足を取得していません。右上の「1年の推移を取得」を押してください。</p>';
      el.historyLegend.innerHTML = '';
      el.historyWindow.textContent = '';
      return;
    }

    if (historyChart) {
      historyChart.setRows(rows);
    } else {
      historyChart = mountChart(el.historyChart, {
        rows,
        series: HISTORY_SERIES,
        extra: [{ label: '評価損益', index: 3, signed: true }],
        onWindowChange: (start, end) => {
          const visible = rows.slice(start, end + 1);
          const first = visible[0];
          const last = visible[visible.length - 1];
          if (!first || !last) return;
          const diff = last.values[0] - first.values[0];
          el.historyWindow.innerHTML =
            `${esc(first.date)} 〜 ${esc(last.date)}（${visible.length}営業日）`
            + `<strong class="${cls(diff)}"> ${esc(signed(diff))}</strong>`;
          el.historyLegend.innerHTML = legendHtml(HISTORY_SERIES, last)
            + `<span class="legend-item">評価損益<strong class="${cls(last.values[3])}">${esc(signed(last.values[3]))}</strong></span>`;
        },
      });
      historyChart.draw();
    }

    const last = rows[rows.length - 1];
    const first = rows[0];
    const diff = last.values[0] - first.values[0];
    el.historyNote.innerHTML =
      `取得したのは ${esc(first.date)} 〜 ${esc(last.date)} の${rows.length}営業日ぶん。全体では資産合計が `
      + `<strong class="${cls(diff)}">${esc(signed(diff))}</strong>（${esc(shortYen(first.values[0]))}円 → ${esc(shortYen(last.values[0]))}円）。`
      + '<br><strong>いまの保有株数のまま持っていた場合</strong>の評価額なので、実際の売買のタイミングは反映されていません。';
  }

  // ---------- 記録された資産（スナップショット） ----------

  const SNAPSHOT_SERIES = [
    { label: '資産合計', color: SERIES[0], fill: true },
    { label: '評価額', color: SERIES[1] },
    { label: '取得金額', color: 'var(--text-muted)', dashed: true },
  ];

  function renderSnapshots() {
    const rows = snapshots
      .filter((s) => s && s.date)
      .map((s) => ({
        date: s.date,
        values: [
          (Number(s.value) || 0) + (Number(s.cash) || 0),
          Number(s.value) || 0,
          Number(s.cost) || 0,
          (Number(s.value) || 0) - (Number(s.cost) || 0),
        ],
      }));

    if (rows.length < 2) {
      snapshotChart = null;
      el.snapshotChart.classList.remove('is-interactive');
      el.snapshotChart.innerHTML = `
<p class="chart-empty">
  記録は${rows.length}日ぶんです。アプリを開いて株価を更新するたびに1日1件たまり、2日目からここに線が出ます。
</p>`;
      el.snapshotLegend.innerHTML = '';
      return;
    }

    if (snapshotChart) {
      snapshotChart.setRows(rows);
    } else {
      snapshotChart = mountChart(el.snapshotChart, {
        rows,
        series: SNAPSHOT_SERIES,
        extra: [{ label: '評価損益', index: 3, signed: true }],
        onWindowChange: (start, end) => {
          el.snapshotLegend.innerHTML = legendHtml(SNAPSHOT_SERIES, rows[end]);
        },
      });
      snapshotChart.draw();
    }
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
      const w = (Math.abs(r.pl) / max) * 50;
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
    const arcs = items.map((item) => {
      const slice = (item.value / total) * Math.PI * 2;
      const end = angle + slice;
      const large = slice > Math.PI ? 1 : 0;
      const p = (radius, a) => `${(C + radius * Math.cos(a)).toFixed(2)},${(C + radius * Math.sin(a)).toFixed(2)}`;
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
    const stocks = holdings
      .map((h) => ({ label: h.name || h.code, value: (Number(h.quote?.price) || h.avgPrice) * h.shares }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
    const top = stocks.slice(0, 7).map((s, i) => ({ ...s, color: SERIES[i % SERIES.length] }));
    const rest = stocks.slice(7).reduce((n, s) => n + s.value, 0);
    if (rest > 0) top.push({ label: `その他 ${stocks.length - 7}銘柄`, value: rest, color: 'var(--text-muted)' });

    el.stockDonut.innerHTML = donut(top);
    el.stockLegend.innerHTML = donutLegend(top);

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
    historyChart = null;
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
      if (!btn || !historyChart) return;
      historyChart.showLast(Number(btn.dataset.range));
      for (const b of el.rangeMode.querySelectorAll('button')) {
        const on = b === btn;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    });

    document.querySelector('.chart-zoom').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-zoom]');
      if (!btn || !historyChart) return;
      if (btn.dataset.zoom === 'in') historyChart.zoom(1 / 1.6);
      else if (btn.dataset.zoom === 'out') historyChart.zoom(1.6);
      else historyChart.reset();
    });
  }

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));
    bind();
    render();

    const codes = [...new Set(holdings.map((h) => h.code))];
    if (codes.length && settings.netConsent && !codes.some((c) => daily[c])) fetchHistory();
  }

  init();
})();
