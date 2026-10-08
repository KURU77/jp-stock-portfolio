/* 株価・配当の取得。
 *
 * データ元は Yahoo Finance のチャートAPI（v8/finance/chart）。
 * ブラウザから直接叩くと CORS で弾かれるため、CORS を通してくれる公開の
 * 中継サービス（プロキシ）を順番に試します。1つ落ちていても次で拾える。
 *
 * ＊注意＊ 中継サービスには「銘柄コード」だけが渡ります（保有株数や取得単価などの
 * 個人データは一切送りません）。それでも第三者を経由するのは事実なので、
 * アプリ側で初回に確認ダイアログを出しています。
 */
window.Quotes = (() => {
  'use strict';

  /** 中継サービス。上から順に試す。target をそのまま返してくれるものだけ使う。
   *  （allorigins は無料枠で 522 を返すことがあるため、安定している jina を先に置く） */
  const RELAYS = [
    {
      name: 'jina',
      // 本文の前に "Title: ... Markdown Content:" が付くので、最初の { 以降を JSON として読む。
      url: (t) => `https://r.jina.ai/${t}`,
      parse: (text) => {
        const i = text.indexOf('{');
        if (i < 0) throw new Error('JSONが見つかりません');
        return JSON.parse(text.slice(i));
      },
    },
    {
      name: 'allorigins',
      url: (t) => `https://api.allorigins.win/raw?url=${encodeURIComponent(t)}`,
      parse: (text) => JSON.parse(text),
    },
    {
      name: 'codetabs',
      url: (t) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(t)}`,
      parse: (text) => JSON.parse(text),
    },
  ];

  const TIMEOUT_MS = 12000;

  /** ユーザー設定の中継URL（{url} を置き換える）。設定されていれば最優先で試す。 */
  let customRelay = '';

  function setCustomRelay(template) {
    customRelay = typeof template === 'string' ? template.trim() : '';
  }

  /** '7203' → '7203.T' / '130A' → '130A.T' / '7203.T' → そのまま */
  function toSymbol(code) {
    const s = String(code ?? '').trim().toUpperCase();
    if (!s) return '';
    if (s.includes('.')) return s;
    return `${s}.T`;
  }

  function chartUrl(symbol) {
    const q = new URLSearchParams({
      range: '1y',
      interval: '1d',
      events: 'div',
      includePrePost: 'false',
    });
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`;
  }

  async function fetchText(url, timeoutMs = TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 同じ日か（JSTのカレンダー日で比較） */
  function sameJstDay(aSec, bSec) {
    const day = (sec) => Math.floor((sec + 9 * 3600) / 86400);
    return day(aSec) === day(bSec);
  }

  /** チャートAPIのレスポンスから必要な値だけ取り出す。 */
  function extract(json) {
    const err = json?.chart?.error;
    if (err) throw new Error(err.description || err.code || 'APIエラー');
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error('データが空です');

    const meta = r.meta || {};
    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price)) throw new Error('株価が取得できませんでした');

    // 前日終値：日足の終値配列から、当日の足を除いた最後の値を使う。
    const stamps = Array.isArray(r.timestamp) ? r.timestamp : [];
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    const rows = stamps
      .map((t, i) => ({ t, c: Number(closes[i]) }))
      .filter((row) => Number.isFinite(row.c));
    let prevClose = null;
    if (rows.length) {
      const last = rows[rows.length - 1];
      const marketTime = Number(meta.regularMarketTime) || last.t;
      const prevRow = sameJstDay(last.t, marketTime) ? rows[rows.length - 2] : last;
      prevClose = prevRow ? prevRow.c : null;
    }

    // 配当（1株あたり）。直近12か月ぶんを合計して「年間配当（実績）」とする。
    const divObj = r.events?.dividends || {};
    const nowSec = Math.floor(Date.now() / 1000);
    const dividends = Object.values(divObj)
      .map((d) => ({ amount: Number(d.amount), date: Number(d.date) }))
      .filter((d) => Number.isFinite(d.amount) && Number.isFinite(d.date))
      .sort((a, b) => a.date - b.date);
    const recent = dividends.filter((d) => d.date >= nowSec - 370 * 86400);
    const divTtm = recent.length
      ? Math.round(recent.reduce((s, d) => s + d.amount, 0) * 100) / 100
      : null;

    return {
      symbol: String(meta.symbol || ''),
      nameEn: String(meta.longName || meta.shortName || ''),
      currency: String(meta.currency || 'JPY'),
      price,
      prevClose,
      high52: Number.isFinite(meta.fiftyTwoWeekHigh) ? meta.fiftyTwoWeekHigh : null,
      low52: Number.isFinite(meta.fiftyTwoWeekLow) ? meta.fiftyTwoWeekLow : null,
      marketTime: Number(meta.regularMarketTime) || null,
      divTtm,
      // 権利落ち日の「月」。配当カレンダーに使う（1〜12）。
      divMonths: [...new Set(recent.map((d) => new Date((d.date + 9 * 3600) * 1000).getUTCMonth() + 1))].sort((a, b) => a - b),
      divEvents: recent.map((d) => ({
        amount: d.amount,
        month: new Date((d.date + 9 * 3600) * 1000).getUTCMonth() + 1,
      })),
      fetchedAt: Date.now(),
    };
  }

  /**
   * 1銘柄ぶんの株価・配当を取得する。
   * @param {string} code 証券コード（'7203' など）
   * @returns {Promise<object>} extract() の戻り値
   */
  async function fetchQuote(code) {
    const symbol = toSymbol(code);
    if (!symbol) throw new Error('証券コードが空です');
    // 名証にしか上場していない銘柄は Yahoo に無いので、はじめから日報を読む。
    if (isNseOnly(code)) return fetchNseQuote(code);

    try {
      return await fetchViaRelays(chartUrl(symbol), extract);
    } catch (err) {
      // 「その銘柄が無い」ときだけ名証の日報も見る。中継が落ちているだけのときに
      // 名証の気配値（東証銘柄だと参考にならない）へすり替わらないようにする。
      if (!isMissingSymbol(err)) throw err;
      try {
        return await fetchNseQuote(code);
      } catch {
        throw err;
      }
    }
  }

  /** 「そんな銘柄は無い」系のエラーか。中継の不調（タイムアウト・5xx）と区別する。 */
  function isMissingSymbol(err) {
    return /Not Found|HTTP 40[0-9]|見つかりません|データが空/.test(err?.message ?? '');
  }

  /** 中継サービスを順に試して、最初に成功したものを返す共通処理。 */
  async function fetchViaRelays(target, extractFn) {
    const relays = [];
    if (customRelay.includes('{url}')) {
      relays.push({
        name: 'custom',
        url: (t) => customRelay.replace('{url}', encodeURIComponent(t)),
        parse: (text) => JSON.parse(text),
      });
    }
    relays.push(...RELAYS);

    const errors = [];
    for (const relay of relays) {
      try {
        const text = await fetchText(relay.url(target));
        const json = relay.parse(text);
        const data = extractFn(json);
        data.relay = relay.name;
        return data;
      } catch (err) {
        errors.push(`${relay.name}: ${err.message}`);
        // 「銘柄が存在しない」系はどの中継でも同じ結果なので、そこで打ち切る。
        if (/Not Found|見つかりません|データが空/.test(err.message)) break;
      }
    }
    throw new Error(`取得に失敗しました（${errors.join(' / ')}）`);
  }

  // ---------- 名証（名古屋証券取引所）の日報 ----------
  //
  // 名証にしか上場していない銘柄（岡谷鋼機・名工建設・中部日本放送など64銘柄）は
  // Yahoo Finance に無いので、名証が毎営業日に出している日報から終値を読みます。
  //   https://www.nse.or.jp/market/condition/report/files/YYYYMMDD.pdf
  // PDFのままでは読めないので、テキストに変換してくれる r.jina.ai を通します。
  // 1回の取得で名証の全銘柄ぶんが手に入るので、1日1回だけ取ってキャッシュします。
  //
  // ＊引けたあとの値しか取れません＊。日報は17時すぎに出るので、ザラ場中の値動きや
  // 年間配当は分かりません（配当は銘柄ごとに手で入れてください）。

  const NSE_CACHE_KEY = 'nse-report-v1';
  const NSE_HISTORY_KEY = 'nse-history-v1';
  const NSE_TIMEOUT_MS = 30000;
  const NSE_MAX_DAYS = 6;

  const nseReportUrl = (ymd) => `https://www.nse.or.jp/market/condition/report/files/${ymd}.pdf`;

  /** 名証にしか上場していない銘柄コード。app.js が銘柄マスタから教えてくれる。 */
  let nseOnlyCodes = new Set();

  function setNseOnlyCodes(codes) {
    nseOnlyCodes = new Set([...(codes || [])].map((c) => String(c).trim().toUpperCase()));
  }

  const isNseOnly = (code) => nseOnlyCodes.has(String(code ?? '').trim().toUpperCase());

  /** JSTの「今」。以降 getUTC* で読むと日本時間の年月日時になる。 */
  const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
  const toYmd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const toIso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

  /** 日報が出ているはずの日を、新しい順に並べる。土日は飛ばすが祝日は分からないので、
   *  実際に取ってみて「NOT FOUND」なら前の日へ遡る。 */
  function reportDates() {
    const start = jstNow();
    // 日報は引け後（17時すぎ）に出るので、それより前なら前日から探す。
    if (start.getUTCHours() < 17) start.setUTCDate(start.getUTCDate() - 1);
    const list = [];
    for (let i = 0; i < 20 && list.length < NSE_MAX_DAYS; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() - i);
      const w = d.getUTCDay();
      if (w === 0 || w === 6) continue;
      list.push(toYmd(d));
    }
    return list;
  }

  /** 日報の見出し・ページ番号など、銘柄表ではないのに数字を含む部分。先に消しておく。 */
  const NSE_NOISE = [
    /コード\s*銘\s*柄\s*名\s*始\s*値\s*高\s*値\s*安\s*値\s*終\s*値\s*前日比\s*最終気配\s*売買高/g,
    /円(\s*円)+\s*千株/g,
    // ページ下の「株券1/5ページ 立会取引 株券 2026年10月7日 （水曜日） 名古屋証券取引所日報」を丸ごと
    /(株券|ＥＴＦ|指標|その他)?\s*\d+\/\d+ページ[^【]{0,60}?名古屋証券取引所日報/g,
    /(株券|ＥＴＦ|指標|その他)?\s*\d+\/\d+ページ/g,
    /立会取引/g,
    /\d{4}年\d{1,2}月\d{1,2}日/g,
    /（[日月火水木金土]曜日）/g,
    /名古屋証券取引所日報/g,
    /銘柄欄[^【]*?Ｃ＝1000株/g,
  ];

  /**
   * 日報のテキストから、銘柄ごとの値を取り出す。
   *
   * 表の列は「コード 銘柄名 始値 高値 安値 終値 前日比 最終気配 売買高」で、
   * コードは4桁＋チェック桁の5文字（7485→74850、546A→546A0）。
   * 売買があった銘柄は四本値が並び、無かった銘柄は半角の「ｹ」のあとに最終気配だけが載る。
   *   74850 ●岡谷鋼機 5210 5240 5130 5150 -50 11.3   … 約定あり
   *   17660 ●東建コーポ ｹ 12750                      … 気配のみ
   *   18920 ●徳倉建 8200                             … 参考値のみ
   * 値が1つしか無い行もあるので、数の並びを見て種類を決めます。
   * 銘柄名に全角の「ケ」が入ることがあるため、気配の印は半角の「ｹ」だけを見ます。
   */
  function parseNseReport(raw) {
    let t = String(raw ?? '');
    if (/Title:[^\n]*NOT FOUND/i.test(t)) return new Map();
    for (const re of NSE_NOISE) t = t.replace(re, ' ');
    t = t.replace(/\s+/g, ' ');

    // 行の先頭は「5文字のコード＋空白＋（記号か全角文字＝銘柄名）」。
    // この形に限ることで、株価の「12750」などをコードと読み違えないようにする。
    const re = /(?<![0-9A-Za-z])([0-9]{3}[0-9A-Z])0(?![0-9A-Za-z])\s+(?=[A-C]?[●○◎§]|[^\x00-\x7F])/g;
    const cand = [];
    let m;
    while ((m = re.exec(t))) cand.push({ code: m[1], from: m.index, bodyAt: re.lastIndex });

    // 株価のうしろに全角の語が続くと、株価が行頭のコードに見えてしまうことがある
    // （ページ下に残る「株券」など）。後ろから見ていき、次の行までに数字が1つも
    // 無い候補は行ではないので落とす。落とせば手前の行がその値を拾い直せる。
    const starts = [];
    let nextFrom = t.length;
    for (let i = cand.length - 1; i >= 0; i--) {
      if (!/[0-9]/.test(t.slice(cand[i].bodyAt, nextFrom))) continue;
      starts.push(cand[i]);
      nextFrom = cand[i].from;
    }
    starts.reverse();

    const num = (s) => Number(String(s).replace(/[,±+]/g, ''));
    const rows = new Map();
    for (let i = 0; i < starts.length; i++) {
      const body = t.slice(starts[i].bodyAt, starts[i + 1] ? starts[i + 1].from : undefined);
      const tailAt = body.search(/[0-9]|ｹ/);
      if (tailAt < 0) continue;
      const name = body.slice(0, tailAt).replace(/^[A-C]?[●○◎§\s]+/, '').trim();
      const tok = body.slice(tailAt).match(/ｹ|[+\-±]?[0-9][0-9,]*(?:\.[0-9]+)?/g) || [];
      let row = null;

      if (tok[0] === 'ｹ') {
        row = { name, price: num(tok[1]), kind: 'quote' };
      } else if (tok.length >= 4 && !/^[+\-±]/.test(tok[1] || '')) {
        const [o, h, l, c] = tok.slice(0, 4).map(num);
        // 四本値らしさの確認。高値が最大で安値が最小になっていなければ別の並び。
        if (h >= Math.max(o, c) && l <= Math.min(o, c) && l > 0) {
          row = { name, price: c, open: o, high: h, low: l, kind: 'trade' };
          const sign = tok.slice(4).find((x) => /^[+\-±]/.test(x));
          if (sign) row.diff = num(sign);
        }
      }
      if (!row) row = { name, price: num(tok[0]), kind: 'ref' };
      if (Number.isFinite(row.price) && row.price > 0) rows.set(starts[i].code, row);
    }
    return rows;
  }

  function readNseCache() {
    try {
      const o = JSON.parse(localStorage.getItem(NSE_CACHE_KEY) || 'null');
      return o && o.date && o.rows ? o : null;
    } catch {
      return null;
    }
  }

  /** 同時に何銘柄更新しても日報の取得は1回で済ませる。 */
  let nseInflight = null;

  async function loadNseReport() {
    const want = reportDates();
    const cache = readNseCache();
    // いちばん新しい日報を持っているならそれを使う。
    if (cache && cache.date === want[0]) return cache;
    // 祝日の判定はしていないので、少し古くても3時間は取り直さない。
    if (cache && want.includes(cache.date) && Date.now() - (cache.fetchedAt || 0) < 3 * 3600 * 1000) return cache;
    if (nseInflight) return nseInflight;

    nseInflight = (async () => {
      const errors = [];
      for (const date of want) {
        let rows;
        try {
          const text = await fetchText(`https://r.jina.ai/${nseReportUrl(date)}`, NSE_TIMEOUT_MS);
          rows = parseNseReport(text);
        } catch (err) {
          // 取得そのものが失敗したら中継側の問題。日付を遡っても直らないので止める。
          errors.push(`${date}: ${err.message}`);
          break;
        }
        // 休場日はPDFが無く「NOT FOUND」が返るので、空になる。前の営業日へ遡る。
        if (rows.size < 50) {
          errors.push(`${date}: 日報がありません`);
          continue;
        }
        const data = { date, fetchedAt: Date.now(), rows: Object.fromEntries(rows) };
        try {
          localStorage.setItem(NSE_CACHE_KEY, JSON.stringify(data));
        } catch {
          /* 容量が足りなければキャッシュは諦める */
        }
        return data;
      }
      if (cache) return cache; // 取れなければ前に取った日報でしのぐ
      throw new Error(`名証の日報が取れませんでした（${errors.slice(0, 3).join(' / ')}）`);
    })();

    try {
      return await nseInflight;
    } finally {
      nseInflight = null;
    }
  }

  /** 日報から読んだ終値を日付つきで貯めていく。使い続けるほどチャートが伸びる。 */
  function appendNseHistory(code, ymdStr, close) {
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(NSE_HISTORY_KEY) || '{}') || {};
    } catch {
      store = {};
    }
    const series = store[code] && typeof store[code] === 'object' ? store[code] : {};
    if (Number.isFinite(close)) series[toIso(ymdStr)] = close;
    let dates = Object.keys(series).sort();
    while (dates.length > 400) delete series[dates.shift()];
    dates = Object.keys(series).sort();
    store[code] = series;
    try {
      localStorage.setItem(NSE_HISTORY_KEY, JSON.stringify(store));
    } catch {
      /* 容量が足りなければ諦める */
    }
    return dates.map((d) => ({ date: d, c: series[d] }));
  }

  const NSE_KIND_LABEL = { trade: '終値', quote: '気配値', ref: '参考値' };

  /** 名証の日報から1銘柄ぶんを取り出して、fetchQuote と同じ形にそろえて返す。 */
  async function fetchNseQuote(code) {
    const key = String(code ?? '').trim().toUpperCase();
    if (!key) throw new Error('証券コードが空です');
    const report = await loadNseReport();
    const row = report.rows[key];
    if (!row) throw new Error(`名証の日報に ${key} が見つかりません`);

    const iso = toIso(report.date);
    const history = appendNseHistory(key, report.date, row.price);
    // 前日終値は、前日比が載っていればそこから。無ければ貯めた履歴の1つ前を使う。
    let prevClose = Number.isFinite(row.diff) ? Math.round((row.price - row.diff) * 100) / 100 : null;
    if (prevClose == null && history.length >= 2) prevClose = history[history.length - 2].c;

    return {
      symbol: key,
      nameEn: row.name || '',
      currency: 'JPY',
      price: row.price,
      prevClose,
      high52: null,
      low52: null,
      // 日報は引け後に出るので、その日の大引け（15:30）を取得時刻とみなす。
      marketTime: Math.floor(Date.parse(`${iso}T15:30:00+09:00`) / 1000),
      divTtm: null,
      divMonths: [],
      divEvents: [],
      source: 'nse',
      sourceLabel: `名証の日報 ${iso.slice(5).replace('-', '/')} の${NSE_KIND_LABEL[row.kind] ?? '値'}`,
      nseKind: row.kind,
      nseDate: iso,
      relay: 'jina',
      fetchedAt: Date.now(),
    };
  }

  /** 名証の銘柄の日足。日報を読むたびに1日ぶん増えていく。 */
  async function fetchNseDaily(code) {
    const key = String(code ?? '').trim().toUpperCase();
    await fetchNseQuote(key); // ついでに当日ぶんを履歴へ足す
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(NSE_HISTORY_KEY) || '{}') || {};
    } catch {
      store = {};
    }
    const series = store[key] || {};
    const points = Object.keys(series).sort().map((d) => ({ date: d, c: series[d] }));
    if (points.length < 2) {
      throw new Error(
        `名証の銘柄は日報から1日ずつ集めるので、使い続けるほどチャートが伸びます（いま${points.length}日ぶん）`,
      );
    }
    return { symbol: key, points, source: 'nse', fetchedAt: Date.now() };
  }

  // ---------- 当日のザラ場（5分足） ----------

  function intradayUrl(symbol) {
    const q = new URLSearchParams({ range: '1d', interval: '5m', includePrePost: 'false' });
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`;
  }

  /**
   * 5分足から、当日のセッションごとの値をまとめる。
   * 東証は 9:00-11:30 / 12:30-15:30 で、昼休みの足は close が null で返ってくる。
   * 夜間PTSはこのAPIには含まれない（日本株は hasPrePostMarketData が false）。
   */
  function extractIntraday(json) {
    const err = json?.chart?.error;
    if (err) throw new Error(err.description || err.code || 'APIエラー');
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error('データが空です');

    const meta = r.meta || {};
    const stamps = Array.isArray(r.timestamp) ? r.timestamp : [];
    const q = r.indicators?.quote?.[0] ?? {};

    /** JSTでの「その日の何分目か」（9:00 = 540） */
    const jstMinutes = (sec) => {
      const d = new Date((sec + 9 * 3600) * 1000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    };

    const points = [];
    for (let i = 0; i < stamps.length; i++) {
      const close = Number(q.close?.[i]);
      if (!Number.isFinite(close)) continue;
      points.push({ t: stamps[i], min: jstMinutes(stamps[i]), c: close });
    }
    if (!points.length) throw new Error('当日の値動きがまだありません');

    // 後場（12:30〜）の最初の足。昼休みを挟むので、これで前場と後場を切り分けられる。
    const afternoon = points.find((p) => p.min >= 750) ?? null;
    const morningEnd = [...points].reverse().find((p) => p.min <= 690) ?? null;

    return {
      symbol: String(meta.symbol || ''),
      prevClose: Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : null,
      open: points[0].c,
      last: Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : points[points.length - 1].c,
      lastTime: Number(meta.regularMarketTime) || points[points.length - 1].t,
      high: Number.isFinite(meta.regularMarketDayHigh) ? meta.regularMarketDayHigh : Math.max(...points.map((p) => p.c)),
      low: Number.isFinite(meta.regularMarketDayLow) ? meta.regularMarketDayLow : Math.min(...points.map((p) => p.c)),
      volume: Number.isFinite(meta.regularMarketVolume) ? meta.regularMarketVolume : null,
      morningClose: morningEnd ? morningEnd.c : null,
      afternoonOpen: afternoon ? afternoon.c : null,
      afternoonIndex: afternoon ? points.indexOf(afternoon) : -1,
      points,
      fetchedAt: Date.now(),
    };
  }

  // ---------- 過去1年の日足（グラフ用） ----------

  function dailyUrl(symbol) {
    const q = new URLSearchParams({ range: '1y', interval: '1d', includePrePost: 'false' });
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`;
  }

  /** 日足の終値だけを取り出す。資産推移のグラフに使う。 */
  function extractDaily(json) {
    const err = json?.chart?.error;
    if (err) throw new Error(err.description || err.code || 'APIエラー');
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error('データが空です');

    const stamps = Array.isArray(r.timestamp) ? r.timestamp : [];
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    const points = [];
    for (let i = 0; i < stamps.length; i++) {
      const c = Number(closes[i]);
      if (!Number.isFinite(c)) continue;
      // JSTのカレンダー日をキーにしておくと、銘柄どうしを日付で突き合わせやすい。
      points.push({ date: new Date((stamps[i] + 9 * 3600) * 1000).toISOString().slice(0, 10), c });
    }
    if (!points.length) throw new Error('日足がありません');

    return {
      symbol: String(r.meta?.symbol || ''),
      points,
      fetchedAt: Date.now(),
    };
  }

  /** 1銘柄ぶんの日足（1年）を取得する。 */
  async function fetchDaily(code) {
    const symbol = toSymbol(code);
    if (!symbol) throw new Error('証券コードが空です');
    if (isNseOnly(code)) return fetchNseDaily(code);

    try {
      return await fetchViaRelays(dailyUrl(symbol), extractDaily);
    } catch (err) {
      if (!isMissingSymbol(err)) throw err;
      try {
        return await fetchNseDaily(code);
      } catch {
        throw err;
      }
    }
  }

  /** 1銘柄ぶんの当日5分足を取得する。 */
  async function fetchIntraday(code) {
    const symbol = toSymbol(code);
    if (!symbol) throw new Error('証券コードが空です');
    if (isNseOnly(code)) {
      throw new Error('名証の銘柄は日報（引け後の終値）しか取れないため、当日の値動きは出せません');
    }
    return fetchViaRelays(intradayUrl(symbol), extractIntraday);
  }

  return {
    fetchQuote,
    fetchIntraday,
    fetchDaily,
    fetchNseQuote,
    toSymbol,
    setCustomRelay,
    setNseOnlyCodes,
    isNseOnly,
  };
})();
