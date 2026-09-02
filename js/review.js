/* AIレビュー。
 *
 * 自分のポートフォリオを要約したテキストを Gemini API に投げて、
 * 分散・配当・NISAの使い方などの「気づき」を整理してもらうページです。
 *
 * ・APIキーはこの端末のブラウザ内（localStorage）にだけ置き、通信先は Google の API だけ。
 *   中継サービスは通しません（キーを第三者に渡さないため）。
 * ・送信するテキストは画面にそのまま出しています。何が送られるか隠さないためです。
 * ・生成AIの出力なので、投資助言ではないことを画面にも明記しています。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'jp-stock-portfolio.holdings.v1';
  const SETTINGS_KEY = 'jp-stock-portfolio.settings.v1';
  const CASH_KEY = 'jp-stock-portfolio.cash.v1';
  const SALES_KEY = 'jp-stock-portfolio.sales.v1';
  const PLANS_KEY = 'jp-stock-portfolio.plans.v1';
  const THEME_KEY = 'jp-stock-portfolio.theme';
  const GEMINI_KEY = 'jp-stock-portfolio.gemini.v1';

  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const DEFAULT_MODEL = 'gemini-2.5-flash';

  const ACCOUNTS = [
    { value: 'tokutei', label: '特定口座', taxable: true },
    { value: 'nisa-growth', label: 'NISA成長投資枠', taxable: false },
    { value: 'nisa-tsumitate', label: 'NISAつみたて投資枠', taxable: false },
    { value: 'ippan', label: '一般口座', taxable: true },
  ];

  const $ = (sel) => document.querySelector(sel);

  const el = {
    apiKey: $('#apiKey'),
    model: $('#model'),
    modelOptions: $('#modelOptions'),
    saveKeyBtn: $('#saveKeyBtn'),
    listModelsBtn: $('#listModelsBtn'),
    clearKeyBtn: $('#clearKeyBtn'),
    reviewBtn: $('#reviewBtn'),
    optNames: $('#optNames'),
    optAmounts: $('#optAmounts'),
    optPlans: $('#optPlans'),
    promptPreview: $('#promptPreview'),
    resultPanel: $('#resultPanel'),
    result: $('#result'),
    resultMeta: $('#resultMeta'),
    themeToggle: $('#themeToggle'),
    toast: $('#toast'),
  };

  let holdings = [];
  let cash = {};
  let sales = [];
  let plans = [];
  let settings = {};
  let gemini = { key: '', model: DEFAULT_MODEL };

  // ---------- 読み込み ----------

  function read(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v ?? fallback;
    } catch { return fallback; }
  }

  function load() {
    holdings = read(STORAGE_KEY, []).filter((h) => h && Number(h.shares) > 0);
    cash = read(CASH_KEY, {});
    sales = read(SALES_KEY, []);
    plans = read(PLANS_KEY, []);
    settings = read(SETTINGS_KEY, {});
    gemini = Object.assign({ key: '', model: DEFAULT_MODEL }, read(GEMINI_KEY, {}));
  }

  const yen = (n) => (Number.isFinite(n) ? `${Math.round(n).toLocaleString('ja-JP')}円` : '—');
  const pct = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(2)}%` : '—');

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 送信するテキストを組み立てる ----------

  function buildPrompt() {
    const useNames = el.optNames.checked;
    const useAmounts = el.optAmounts.checked;
    const usePlans = el.optPlans.checked;
    const taxRate = Number(settings.taxRate) || 20.315;

    const rows = holdings.map((h) => {
      const price = Number(h.quote?.price);
      const cost = h.avgPrice * h.shares;
      const value = Number.isFinite(price) ? price * h.shares : cost;
      const dps = h.divPerShare ?? Number(h.quote?.divTtm) ?? null;
      const account = ACCOUNTS.find((a) => a.value === h.account) ?? ACCOUNTS[0];
      const tier = (h.yutai?.tiers ?? [])
        .filter((t) => h.shares >= t.shares)
        .sort((a, b) => a.shares - b.shares)
        .pop();
      return {
        label: useNames ? `${h.name || h.code}（${h.code}）` : `銘柄${h.code}`,
        account: account.label,
        shares: h.shares,
        avgPrice: h.avgPrice,
        price: Number.isFinite(price) ? price : null,
        cost, value,
        pl: value - cost,
        plRate: cost > 0 ? (value - cost) / cost : null,
        divYield: dps != null && price ? dps / price : null,
        divYear: dps != null ? dps * h.shares : null,
        yutai: tier?.text ?? '',
        yutaiValue: tier?.value ?? 0,
        since: h.since ?? '',
      };
    });

    const totalValue = rows.reduce((n, r) => n + r.value, 0);
    const totalCost = rows.reduce((n, r) => n + r.cost, 0);
    const totalDiv = rows.reduce((n, r) => n + (r.divYear ?? 0), 0);
    const totalYutai = rows.reduce((n, r) => n + r.yutaiValue, 0);
    const totalCash = ACCOUNTS.reduce((n, a) => n + (Number(cash[a.value]) || 0), 0);
    const realized = sales.reduce((n, s) => n + (Number(s.realized) || 0), 0);
    const assets = totalValue + totalCash;

    const money = (n) => (useAmounts ? yen(n) : '（非表示）');
    const share = (v) => (totalValue > 0 ? `${((v / totalValue) * 100).toFixed(1)}%` : '—');

    const lines = [];
    lines.push('# 全体');
    lines.push(`- 評価額: ${money(totalValue)} / 取得金額: ${money(totalCost)}`);
    lines.push(`- 評価損益: ${money(totalValue - totalCost)}（${pct(totalCost > 0 ? (totalValue - totalCost) / totalCost : null)}）`);
    lines.push(`- 現金（投資余力）: ${money(totalCash)} / 資産合計: ${money(assets)}`);
    lines.push(`- 現金比率: ${assets > 0 ? ((totalCash / assets) * 100).toFixed(1) : '—'}%`);
    lines.push(`- 年間配当（税引前）: ${money(totalDiv)} / 配当利回り（評価額ベース）: ${pct(totalValue > 0 ? totalDiv / totalValue : null)}`);
    lines.push(`- 株主優待の年間価値（自己申告の目安）: ${money(totalYutai)}`);
    if (sales.length) lines.push(`- 実現損益（累計・税引前）: ${money(realized)}／売却の記録 ${sales.length}件`);
    lines.push(`- 銘柄数: ${rows.length}／配当の税率設定: ${taxRate}%`);

    lines.push('');
    lines.push('# 保有銘柄');
    for (const r of rows.sort((a, b) => b.value - a.value)) {
      const parts = [
        r.label,
        r.account,
        `${r.shares.toLocaleString('ja-JP')}株`,
        `構成比 ${share(r.value)}`,
        `損益率 ${pct(r.plRate)}`,
        `配当利回り ${pct(r.divYield)}`,
      ];
      if (useAmounts) parts.splice(3, 0, `評価額 ${yen(r.value)}`, `取得単価 ${yen(r.avgPrice)}`);
      if (r.since) parts.push(`取得日 ${r.since}`);
      if (r.yutai) parts.push(`優待 ${r.yutai}`);
      lines.push(`- ${parts.join(' / ')}`);
    }

    // 口座ごとの内訳（NISAの使い方を見てもらうため）
    lines.push('');
    lines.push('# 口座別');
    for (const a of ACCOUNTS) {
      const list = rows.filter((r) => r.account === a.label);
      const v = list.reduce((n, r) => n + r.value, 0);
      const c = Number(cash[a.value]) || 0;
      if (!list.length && !c) continue;
      lines.push(`- ${a.label}: ${list.length}銘柄 / 評価額 ${money(v)}（全体の ${share(v)}） / 現金 ${money(c)}${a.taxable ? '' : '（配当・売却益は非課税）'}`);
    }
    const nisaCost = holdings
      .filter((h) => (ACCOUNTS.find((a) => a.value === h.account) ?? ACCOUNTS[0]).taxable === false)
      .reduce((n, h) => n + h.avgPrice * h.shares, 0);
    if (nisaCost > 0) {
      lines.push(`- NISAの簿価（取得金額ベース）: ${money(nisaCost)}／生涯の非課税保有限度額は簿価1,800万円（うち成長投資枠1,200万円）`);
    }

    if (usePlans && plans.length) {
      lines.push('');
      lines.push('# 毎月の積み立て');
      for (const p of plans) {
        const a = ACCOUNTS.find((x) => x.value === p.account) ?? ACCOUNTS[0];
        lines.push(`- ${useNames ? (p.name || p.code) : `銘柄${p.code}`}（${p.code}） / ${a.label} / 毎月 ${money(p.amount)}（年間 ${money(p.amount * 12)}） / ${p.active ? '継続中' : '停止中'} / 実績 ${(p.history ?? []).length}回`);
      }
    }

    const instruction = [
      'あなたは日本株の個人投資家向けに、ポートフォリオの状況を整理して「気づき」を渡す役割です。',
      '次のデータについて、日本語で簡潔にまとめてください。',
      '',
      '守ってほしいこと:',
      '- 特定の銘柄について「買うべき」「売るべき」といった売買の推奨はしないでください。',
      '- 将来の株価や利回りの予測はしないでください。',
      '- データから読み取れないことは推測せず、「このデータでは分からない」と書いてください。',
      '- 制度（NISAの枠、配当課税など）に触れるときは、一般的な仕組みの範囲にとどめ、断定しすぎないでください。',
      '- 最後に「これは投資助言ではありません」と1行添えてください。',
      '',
      '書いてほしい内容:',
      '1. 全体の状況（規模・損益・現金比率）を3行程度で',
      '2. 分散と集中（1銘柄・1口座への偏りがないか）',
      '3. 配当と優待の状況（利回りの水準、偏り）',
      '4. 口座の使い方（課税口座とNISAの配分で気づく点）',
      '5. 積み立ての状況（設定があれば）',
      '6. 見落としがちな確認ポイントを3〜5個（箇条書き）',
      '',
      '出力は見出し（##）と箇条書きを使った読みやすい形式で、全体で600〜900字程度にしてください。',
      '',
      '---- ポートフォリオのデータ ----',
    ].join('\n');

    return `${instruction}\n${lines.join('\n')}\n`;
  }

  function renderPrompt() {
    if (!holdings.length) {
      el.promptPreview.textContent = '保有銘柄がありません。ポートフォリオに銘柄を登録してからお試しください。';
      el.reviewBtn.disabled = true;
      return;
    }
    el.reviewBtn.disabled = false;
    el.promptPreview.textContent = buildPrompt();
  }

  // ---------- 生成AIの出力を軽く整形して表示 ----------

  function renderMarkdown(text) {
    const lines = String(text).split('\n');
    const out = [];
    let inList = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*・]\s+(.*)$/);
      const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
      const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);

      const inline = (s) => esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>');

      if (bullet) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (inList) { out.push('</ul>'); inList = false; }

      if (heading) out.push(`<h3>${inline(heading[2])}</h3>`);
      else if (numbered) out.push(`<p class="md-num"><strong>${esc(numbered[1])}.</strong> ${inline(numbered[2])}</p>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (inList) out.push('</ul>');
    return out.join('\n');
  }

  // ---------- Gemini API ----------

  async function callGemini(prompt) {
    const key = el.apiKey.value.trim();
    const model = (el.model.value.trim() || DEFAULT_MODEL).replace(/^models\//, '');
    if (!key) throw new Error('APIキーを入力してください。');

    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || `HTTP ${res.status}`;
      throw new Error(message);
    }

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) {
      const reason = candidate?.finishReason || data.promptFeedback?.blockReason || '不明';
      throw new Error(`返答が空でした（理由: ${reason}）。モデルを変えるか、送信内容を減らしてお試しください。`);
    }
    return { text, model, usage: data.usageMetadata ?? null };
  }

  async function runReview() {
    const prompt = buildPrompt();
    el.reviewBtn.disabled = true;
    el.reviewBtn.textContent = 'レビュー中…';
    el.resultPanel.hidden = false;
    el.result.innerHTML = '<p class="chart-empty">Gemini に問い合わせています…</p>';
    el.resultMeta.textContent = '';

    const startedAt = Date.now();
    try {
      const { text, model, usage } = await callGemini(prompt);
      el.result.innerHTML = renderMarkdown(text);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      el.resultMeta.textContent =
        `${model} / ${seconds}秒`
        + (usage ? ` / 入力 ${usage.promptTokenCount ?? '—'}トークン・出力 ${usage.candidatesTokenCount ?? '—'}トークン` : '')
        + '　※生成AIの出力です。投資助言ではありません。';
    } catch (err) {
      el.result.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
      el.resultMeta.textContent = 'APIキー・モデル名・通信状況を確認してください。';
    } finally {
      el.reviewBtn.disabled = false;
      el.reviewBtn.textContent = 'この内容でレビューしてもらう';
    }
  }

  async function listModels() {
    const key = el.apiKey.value.trim();
    if (!key) return toast('先にAPIキーを入力してください');
    el.listModelsBtn.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/models`, { headers: { 'x-goog-api-key': key } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const names = (data.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''))
        .sort();
      el.modelOptions.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
      toast(`使えるモデルを${names.length}件取得しました（入力欄の候補から選べます）`);
    } catch (err) {
      toast(`モデル一覧の取得に失敗しました：${err.message}`);
    } finally {
      el.listModelsBtn.disabled = false;
    }
  }

  // ---------- 小物 ----------

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4600);
  }

  function applyTheme(theme) {
    const t = theme === 'dark' || theme === 'light'
      ? theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
    el.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  function bind() {
    el.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });

    el.saveKeyBtn.addEventListener('click', () => {
      gemini = { key: el.apiKey.value.trim(), model: el.model.value.trim() || DEFAULT_MODEL };
      localStorage.setItem(GEMINI_KEY, JSON.stringify(gemini));
      toast('この端末に保存しました');
    });

    el.clearKeyBtn.addEventListener('click', () => {
      if (!confirm('保存したAPIキーを削除しますか？')) return;
      localStorage.removeItem(GEMINI_KEY);
      el.apiKey.value = '';
      gemini = { key: '', model: DEFAULT_MODEL };
      toast('削除しました（Google AI Studio 側のキーも忘れずに）');
    });

    el.listModelsBtn.addEventListener('click', listModels);
    el.reviewBtn.addEventListener('click', runReview);

    for (const node of [el.optNames, el.optAmounts, el.optPlans]) {
      node.addEventListener('change', renderPrompt);
    }
  }

  function init() {
    load();
    applyTheme(localStorage.getItem(THEME_KEY));
    el.apiKey.value = gemini.key ?? '';
    el.model.value = gemini.model || DEFAULT_MODEL;
    bind();
    renderPrompt();
  }

  init();
})();
