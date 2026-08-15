/**
 * 東証の上場銘柄一覧（js/stocks.js）を作り直す。
 *
 *   npm install xlsx
 *   node tools/build-stock-master.mjs
 *
 * JPXが公開している「東証上場銘柄一覧」(data_j.xls) をダウンロードして変換します。
 * 新規上場・上場廃止・社名変更に追随したいときは、ときどき流し直してください。
 * .xls（古いExcel形式）の解析だけは自前で書けないので xlsx パッケージを使います。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const SOURCE = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let xlsx;
try {
  xlsx = await import('xlsx');
} catch {
  console.error('xlsx パッケージが必要です。`npm install xlsx` を実行してから再度お試しください。');
  process.exit(1);
}

console.log('ダウンロード中:', SOURCE);
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`ダウンロードに失敗しました: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const tmp = join(mkdtempSync(join(tmpdir(), 'jpx-')), 'data_j.xls');
writeFileSync(tmp, buf);
console.log(`取得しました（${(buf.length / 1024).toFixed(0)}KB）`);

const wb = xlsx.read(readFileSync(tmp), { type: 'buffer' });
const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

/** JPXの銘柄名は全角英数字なので、読みやすいように半角へ直す。 */
function toHalf(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

const date = String(rows[0]['日付']);
const asOf = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

const lines = [];
const seen = new Set();
for (const r of rows) {
  const code = String(r['コード']).trim().toUpperCase();
  const name = toHalf(r['銘柄名']).replace(/[`\\]/g, '');
  const mk = MARKET[r['市場・商品区分']] ?? 'X';
  if (!code || !name || seen.has(code)) continue;
  seen.add(code);
  lines.push(`${code}\t${name}\t${mk}`);
}

const js = `/* 東証の上場銘柄一覧。JPXが公開している「東証上場銘柄一覧」(data_j.xls) から
 * tools/build-stock-master.mjs で生成しています。${asOf} 時点で ${lines.length} 銘柄。
 *
 * 1行が「コード＼t銘柄名＼t市場」。市場は P=プライム / S=スタンダード / G=グロース /
 * E=ETF・ETN / R=REIT等 / O=出資証券 / X=PRO Market。
 * 銘柄名の全角英数字は半角に直してあります（JPXの原本は「ｉｓｐａｃｅ」のような全角）。
 *
 * 更新するには次を実行します（ネットワーク接続が必要）。
 *   node tools/build-stock-master.mjs
 */
window.STOCK_MASTER_AS_OF = '${asOf}';
window.STOCK_MASTER_RAW = \`${lines.join('\n')}\`;
`;

const out = join(root, 'js', 'stocks.js');
writeFileSync(out, js);
console.log(`js/stocks.js を更新しました：${lines.length}銘柄 / ${(Buffer.byteLength(js) / 1024).toFixed(1)}KB / 基準日 ${asOf}`);
