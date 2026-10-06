// 個人情報チェックと匿名化（Phase 5）。
// 完全な自動判定はできません。「学校の個人情報を気付かずAIへ送る事故を減らす」ための注意喚起です。
// 判定は端末内だけで行い、どこにも送信しません。

const RULES = [
  ['メールアドレス', /[\w.+-]{1,64}@[\w-]{1,253}(?:\.[\w-]{1,63})+/g, '[メールアドレス]'],
  ['電話番号', /(?:\+81[-\s]?0?|0)\d{1,4}[-(\s]?\d{1,4}[-)\s]?\d{3,4}(?!\d)/g, '[電話番号]'],
  ['郵便番号', /〒?\s?\d{3}-\d{4}(?!\d)/g, '[郵便番号]'],
  ['住所', /(?:東京都|北海道|(?:京都|大阪)府|[一-龥]{2,3}県)[一-龥ぁ-んァ-ヶ0-9０-９]{1,12}?[市区町村郡][一-龥ぁ-んァ-ヶ0-9０-９ー\-－丁目番地号]*/g, '[住所]'],
  ['学籍番号・出席番号らしき数字', /(?:学籍番号|出席番号|生徒番号)[:：\s]*\d+/g, '[番号]'],
];
const NAME = /([一-龥]{1,4}(?:[ 　][一-龥]{1,3})?|[ァ-ヶー]{2,8}|[ぁ-ん]{2,5})(君|くん|さん|ちゃん|先生)/g;
const NOT_NAME = new Set(['皆さん', 'みなさん', '保護者様', 'お客様', '利用者さん', '生徒さん', '先生', '担任の先生', '皆様', '各位', 'お子さん', '子どもさん', 'お母さん', 'お父さん', 'おかあさん', 'おとうさん', 'おにいさん', 'おねえさん', 'みなさん', '皆さん', '先生', '校長先生', '担任の先生', '教頭先生']);

const DATE_LIKE = [
  /(?:19|20)\d{2}[-/.年](?:0?[1-9]|1[0-2])[-/.月](?:0?[1-9]|[12]\d|3[01])日?(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)/g,
  /(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:[-_T]?\d{4}(?:\d{2})?)?(?!\d)/g,
];
const NUMERIC_KINDS = new Set(['電話番号', '郵便番号', '学籍番号・出席番号らしき数字']);
function dateSpans(t) {
  const spans = [];
  for (const re of DATE_LIKE) for (const mm of t.matchAll(re)) spans.push([mm.index, mm.index + mm[0].length]);
  return spans;
}
function numericOk(t, start, len, spans) {
  const end = start + len;
  const lead = t[start] === '〒' || t[start] === '+' ? '' : (t[start - 1] || '');
  if (/[0-9０-９]/.test(lead) || /[0-9０-９]/.test(t[end] || '')) return false;
  return !spans.some(([a, b]) => start < b && end > a);
}

export function findPersonalInfo(text, master) {
  const t = String(text || '');
  const found = [];
  const spans = dateSpans(t);
  const phoneSpans = [];
  for (const [kind, re] of RULES) for (const mm of t.matchAll(re)) {
    if (NUMERIC_KINDS.has(kind)) {
      const lead = mm[0].length - mm[0].replace(/^[\s]+/, '').length;
      if (!numericOk(t, mm.index + lead, mm[0].length - lead, spans)) continue;
      if (kind === '郵便番号' && phoneSpans.some(([a, b]) => mm.index < b && mm.index + mm[0].length > a)) continue;
      if (kind === '電話番号') phoneSpans.push([mm.index, mm.index + mm[0].length]);
    }
    found.push({ kind, text: mm[0] });
  }
  for (const mm of t.matchAll(NAME)) {
    if (NOT_NAME.has(mm[0]) || NOT_NAME.has(mm[1] + mm[2]) || mm[2] === '先生' && mm[1].length < 2) continue;
    found.push({ kind: '人名らしき言葉', text: mm[0] });
  }
  for (const w of master?.promptGuide?.privacyWarningWords || []) if (t.includes(w)) found.push({ kind: '注意する言葉', text: w });
  const seen = new Set();
  return found.filter(f => { const k = f.kind + '|' + f.text; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function anonymize(text) {
  let t = String(text || '');
  for (const [kind, re, rep] of RULES) {
    if (!NUMERIC_KINDS.has(kind)) { t = t.replace(re, rep); continue; }
    const spans = dateSpans(t), src = t;
    t = t.replace(re, (m, ...args) => {
      const off = args[args.length - 2];
      const lead = m.length - m.replace(/^[\s]+/, '').length;
      return numericOk(src, off + lead, m.length - lead, spans) ? (lead ? m.slice(0, lead) : '') + (typeof rep === 'function' ? rep(m) : rep) : m;
    });
  }
  const map = new Map();
  t = t.replace(NAME, (all, name, honor) => {
    if (NOT_NAME.has(all) || NOT_NAME.has(name + honor)) return all;
    if (!map.has(name)) map.set(name, String.fromCharCode(65 + (map.size % 26)) + (map.size >= 26 ? Math.floor(map.size / 26) : ''));
    return `${map.get(name)}さん`;
  });
  return t;
}