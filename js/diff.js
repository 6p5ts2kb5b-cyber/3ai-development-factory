// 仕様書の差分（行単位）。画面に依存しないので自動テストで直接確認できます。
// 結果の各行 type：
//   same   … 変わっていない
//   add    … 追加された
//   del    … 削除された
//   change … 変更された（変更前→変更後を対にする）
const lines = s => String(s ?? '').replace(/\r\n?/g, '\n').split('\n');

export function diffLines(beforeText, afterText) {
  const A = lines(beforeText), B = lines(afterText);
  if (beforeText == null || beforeText === '') A.length = 0;
  // 先頭・末尾の共通部分は先に取り除く（長い仕様書でも速く）
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a = A.slice(s, ea), b = B.slice(s, eb);
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: 'same', a: A[i], b: B[i] });
  if (a.length * b.length > 4e6) { // 極端に長い場合は単純比較
    a.forEach(x => ops.push({ t: 'del', a: x })); b.forEach(y => ops.push({ t: 'add', b: y }));
  } else {
    // 最長共通部分列（LCS）
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: 'same', a: a[i], b: b[j] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: 'del', a: a[i++] });
      else ops.push({ t: 'add', b: b[j++] });
    }
    while (i < n) ops.push({ t: 'del', a: a[i++] });
    while (j < m) ops.push({ t: 'add', b: b[j++] });
  }
  for (let i = ea; i < A.length; i++) ops.push({ t: 'same', a: A[i], b: B[eb + (i - ea)] });

  // 連続する「削除→追加」は「変更」として対にする（初心者に分かりやすく）
  const rows = [];
  let k = 0, la = 0, lb = 0;
  while (k < ops.length) {
    if (ops[k].t === 'same') { la++; lb++; rows.push({ type: 'same', before: ops[k].a, after: ops[k].b, aLine: la, bLine: lb }); k++; continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].t !== 'same') { (ops[k].t === 'del' ? dels : adds).push(ops[k]); k++; }
    const pairs = Math.min(dels.length, adds.length);
    for (let x = 0; x < pairs; x++) { la++; lb++; rows.push({ type: 'change', before: dels[x].a, after: adds[x].b, aLine: la, bLine: lb }); }
    for (let x = pairs; x < dels.length; x++) { la++; rows.push({ type: 'del', before: dels[x].a, after: null, aLine: la }); }
    for (let x = pairs; x < adds.length; x++) { lb++; rows.push({ type: 'add', before: null, after: adds[x].b, bLine: lb }); }
  }
  return rows;
}

// 件数（空行だけの変化は数えない）
export function diffSummary(rows) {
  const nb = s => s != null && s.trim() !== '';
  return {
    added: rows.filter(r => r.type === 'add' && nb(r.after)).length,
    removed: rows.filter(r => r.type === 'del' && nb(r.before)).length,
    changed: rows.filter(r => r.type === 'change' && (nb(r.before) || nb(r.after))).length,
  };
}

export const summaryText = s => `追加 ${s.added}行・削除 ${s.removed}行・変更 ${s.changed}行`;

// 変更点だけをテキストに（変更履歴・AIへの受け渡し用）
export function diffText(rows, { max = 40 } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.type === 'add' && r.after.trim()) out.push(`＋追加：${r.after}`);
    else if (r.type === 'del' && r.before.trim()) out.push(`－削除：${r.before}`);
    else if (r.type === 'change') out.push(`△変更：${r.before} → ${r.after}`);
  }
  return out.length > max ? [...out.slice(0, max), `…ほか${out.length - max}件`] : out;
}
