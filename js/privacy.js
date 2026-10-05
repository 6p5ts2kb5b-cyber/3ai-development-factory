// 個人情報チェックと匿名化（Phase 5）。
// 完全な自動判定はできません。「学校の個人情報を気付かずAIへ送る事故を減らす」ための注意喚起です。
// 判定は端末内だけで行い、どこにも送信しません。

const RULES = [
  // [種類, 正規表現, 置き換え文字(関数可)]
  ['メールアドレス', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[メールアドレス]'],
  ['電話番号', /(?:\+81[-\s]?)?0\d{1,4}[-(\s]?\d{1,4}[-)\s]?\d{3,4}(?!\d)/g, '[電話番号]'],
  ['郵便番号', /〒?\s?\d{3}-\d{4}(?!\d)/g, '[郵便番号]'],
  ['住所', /(?:東京都|北海道|(?:京都|大阪)府|[一-龥]{2,3}県)[一-龥ぁ-んァ-ヶ0-9０-９]{1,12}?[市区町村郡][一-龥ぁ-んァ-ヶ0-9０-９ー\-－丁目番地号]*/g, '[住所]'],
  ['学籍番号・出席番号らしき数字', /(?:学籍番号|出席番号|生徒番号)[:：\s]*\d+/g, '[番号]'],
];
// 「田中君」「さくらさん」「山田太郎くん」など、人名＋敬称らしき部分
// （「様」は「仕様」「様子」と区別できないため対象外）
const NAME = /([一-龥]{1,4}(?:[ 　][一-龥]{1,3})?|[ァ-ヶー]{2,8}|[ぁ-ん]{2,5})(君|くん|さん|ちゃん|先生)/g;
// 人名ではない語（誤検出を減らす）
const NOT_NAME = new Set(['皆さん', 'みなさん', '保護者様', 'お客様', '利用者さん', '生徒さん', '先生', '担任の先生', '皆様', '各位', 'お子さん', '子どもさん', 'お母さん', 'お父さん', 'おかあさん', 'おとうさん', 'おにいさん', 'おねえさん', 'みなさん', '皆さん', '先生', '校長先生', '担任の先生', '教頭先生']);

export function findPersonalInfo(text, master) {
  const t = String(text || '');
  const found = [];
  for (const [kind, re] of RULES) for (const mm of t.matchAll(re)) found.push({ kind, text: mm[0] });
  for (const mm of t.matchAll(NAME)) {
    if (NOT_NAME.has(mm[0]) || NOT_NAME.has(mm[1] + mm[2]) || mm[2] === '先生' && mm[1].length < 2) continue;
    found.push({ kind: '人名らしき言葉', text: mm[0] });
  }
  for (const w of master?.promptGuide?.privacyWarningWords || []) if (t.includes(w)) found.push({ kind: '注意する言葉', text: w });
  // 重複をまとめる
  const seen = new Set();
  return found.filter(f => { const k = f.kind + '|' + f.text; if (seen.has(k)) return false; seen.add(k); return true; });
}

// 匿名化：人名は A さん・B さん…（同じ名前は同じ記号）、連絡先・住所は記号に置き換え
export function anonymize(text) {
  let t = String(text || '');
  for (const [, re, rep] of RULES) t = t.replace(re, rep);
  const map = new Map();
  t = t.replace(NAME, (all, name, honor) => {
    if (NOT_NAME.has(all) || NOT_NAME.has(name + honor)) return all;
    if (!map.has(name)) map.set(name, String.fromCharCode(65 + (map.size % 26)) + (map.size >= 26 ? Math.floor(map.size / 26) : ''));
    return `${map.get(name)}さん`;
  });
  return t;
}
