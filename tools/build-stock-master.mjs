/**
 * 上場銘柄一覧（js/stocks.js）を作り直す。
 *
 *   npm install xlsx
 *   node tools/build-stock-master.mjs
 *
 * データ元は2つ。
 *   ・東証 … JPXが公開している「東証上場銘柄一覧」(data_j.xls)
 *   ・名証 … 名古屋証券取引所の銘柄検索API (https://www.nse.or.jp/api/stock/search.json)
 *
 * 名証にしか上場していない銘柄（岡谷鋼機・名工建設など）はJPXの一覧に入らないため、
 * 名証のAPIから足しています。両方に上場している銘柄は東証の行に名証の区分を添えるだけ。
 *
 * 新規上場・上場廃止・社名変更に追随したいときは、ときどき流し直してください。
 * .xls（古いExcel形式）の解析だけは自前で書けないので xlsx パッケージを使います。
 * xlsx が入っていない環境では、東証ぶんを今の js/stocks.js から引き継いで
 * 名証ぶんだけを更新します（`--nse-only` を付けても同じ動きになります）。
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const JPX_SOURCE = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';
const NSE_SOURCE = 'https://www.nse.or.jp/api/stock/search.json?dispCount=2000&dispPage=1';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'js', 'stocks.js');

/** 銘柄名は全角英数字で届くので、読みやすいように半角へ直す。 */
function toHalf(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 生成するファイルはテンプレートリテラルなので、壊す文字（バッククォートと円記号）は落とす。 */
const CLEAN = new RegExp('[' + String.fromCharCode(96, 92, 92) + ']', 'g');

const MARKET = {
  'プライム（内国株式）': 'P',
  'プライム（外国株式）': 'P',
  'スタンダード（内国株式）': 'S',
  'スタンダード（外国株式）': 'S',
  'グロース（内国株式）': 'G',
  'グロース（外国株式）': 'G',
  'ETF・ETN': 'E',
  'REIT・ベンチャーファンド・カントリーファンド・インフラファンド': 'R',
  '出資証券': 'O',
  'PRO Market': 'X',
};

// ---------- 東証 ----------

/** 既存の js/stocks.js から東証ぶんを読み戻す（xlsx が無いときの退避路）。 */
function readExistingTse() {
  if (!existsSync(out)) throw new Error('js/stocks.js が無いので、xlsx を入れて東証ぶんから作り直してください。');
  const src = readFileSync(out, 'utf8');
  const asOf = src.match(/STOCK_MASTER_AS_OF = '([\d-]+)'/)?.[1] ?? '';
  const raw = src.match(/STOCK_MASTER_RAW = `([\s\S]*?)`;/)?.[1] ?? '';
  const rows = [];
  for (const line of raw.split('\n')) {
    const [code, name, mk] = line.split('\t');
    if (code && name && mk && mk !== '-') rows.push({ code, name, mk });
  }
  if (!rows.length) throw new Error('js/stocks.js から東証ぶんを読めませんでした。');
  return { rows, asOf };
}

async function fetchTse() {
  let xlsx;
  try {
    xlsx = await import('xlsx');
  } catch {
    return null;
  }
  console.log('ダウンロード中:', JPX_SOURCE);
  const res = await fetch(JPX_SOURCE);
  if (!res.ok) throw new Error(`JPXのダウンロードに失敗しました: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = join(mkdtempSync(join(tmpdir(), 'jpx-')), 'data_j.xls');
  writeFileSync(tmp, buf);
  console.log(`東証の一覧を取得しました（${(buf.length / 1024).toFixed(0)}KB）`);

  const wb = xlsx.read(readFileSync(tmp), { type: 'buffer' });
  const sheet = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const date = String(sheet[0]['日付']);
  const rows = [];
  const seen = new Set();
  for (const r of sheet) {
    const code = String(r['コード']).trim().toUpperCase();
    const name = toHalf(r['銘柄名']).replace(CLEAN, '');
    if (!code || !name || seen.has(code)) continue;
    seen.add(code);
    rows.push({ code, name, mk: MARKET[r['市場・商品区分']] ?? 'X' });
  }
  return { rows, asOf: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` };
}

// ---------- 名証 ----------

/** 名証の区分（listedDivision）→ 1文字 */
const NSE_DIV = { 1: 'P', 2: 'M', 3: 'N', 4: 'E' };

async function fetchNse() {
  console.log('ダウンロード中:', NSE_SOURCE);
  const res = await fetch(NSE_SOURCE, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`名証のダウンロードに失敗しました: HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json?.stock) ? json.stock : [];
  if (!list.length) throw new Error('名証のAPIから銘柄が取れませんでした（仕様が変わった可能性あり）。');

  const rows = [];
  const seen = new Set();
  for (const s of list) {
    // stockCode は「4桁コード＋チェック桁」の5文字で届く
    const code = String(s.stockCode ?? '').trim().toUpperCase().slice(0, 4);
    const name = toHalf(s.stockName_j).replace(CLEAN, '');
    const div = NSE_DIV[Number(s.listedDivision)] ?? 'M';
    if (!/^[0-9]{3}[0-9A-Z]$/.test(code) || !name || seen.has(code)) continue;
    seen.add(code);
    rows.push({ code, name, div });
  }
  console.log(`名証の一覧を取得しました（${rows.length}銘柄）`);
  return rows;
}

// ---------- 合成 ----------

const nseOnly = process.argv.includes('--nse-only');
let tse = nseOnly ? null : await fetchTse();
if (!tse) {
  if (!nseOnly) console.log('xlsx が無いので、東証ぶんは今の js/stocks.js から引き継ぎます。');
  tse = readExistingTse();
}
const nse = await fetchNse();
const nseByCode = new Map(nse.map((r) => [r.code, r]));

const lines = [];
const tseCodes = new Set();
for (const r of tse.rows) {
  tseCodes.add(r.code);
  const div = nseByCode.get(r.code)?.div ?? '';
  lines.push(div ? `${r.code}\t${r.name}\t${r.mk}\t${div}` : `${r.code}\t${r.name}\t${r.mk}`);
}
// 名証にしか上場していない銘柄。市場は '-'（東証に無い）として足す。
let soloCount = 0;
for (const r of nse) {
  if (tseCodes.has(r.code)) continue;
  soloCount++;
  lines.push(`${r.code}\t${r.name}\t-\t${r.div}`);
}
lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const asOf = tse.asOf;
const nseAsOf = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const js = `/* 上場銘柄一覧。tools/build-stock-master.mjs で生成しています。
 * 東証ぶんはJPXの「東証上場銘柄一覧」(data_j.xls, ${asOf} 時点)、
 * 名証ぶんは名古屋証券取引所の銘柄検索API (${nseAsOf} 時点, ${nse.length}銘柄) から。
 * 合計 ${lines.length} 銘柄。うち名証にしか上場していないものが ${soloCount} 銘柄。
 *
 * 1行が「コード＼t銘柄名＼t東証の市場＼t名証の区分」。4つめは名証に上場していなければ省略。
 * 東証の市場は P=プライム / S=スタンダード / G=グロース / E=ETF・ETN / R=REIT等 /
 * O=出資証券 / X=PRO Market、'-'=東証には上場していない（名証単独）。
 * 名証の区分は P=プレミア / M=メイン / N=ネクスト / E=ETF。
 * 銘柄名の全角英数字は半角に直してあります（原本は「ｉｓｐａｃｅ」のような全角）。
 *
 * 更新するには次を実行します（ネットワーク接続が必要）。
 *   node tools/build-stock-master.mjs            … 東証＋名証を作り直す（要 npm install xlsx）
 *   node tools/build-stock-master.mjs --nse-only … 名証ぶんだけ入れ替える
 */
window.STOCK_MASTER_AS_OF = '${asOf}';
window.STOCK_MASTER_NSE_AS_OF = '${nseAsOf}';
window.STOCK_MASTER_RAW = \`${lines.join('\n')}\`;
`;

writeFileSync(out, js);
console.log(`js/stocks.js を更新しました：${lines.length}銘柄（名証単独 ${soloCount}）/ ${(Buffer.byteLength(js) / 1024).toFixed(1)}KB`);
