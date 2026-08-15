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

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
    const target = chartUrl(symbol);

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
        const data = extract(json);
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

  return { fetchQuote, toSymbol, setCustomRelay };
})();
