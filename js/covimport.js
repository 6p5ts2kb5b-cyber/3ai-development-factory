// 確定仕様との照合：JSONの判定候補を読み込んで一括反映する（v1.1.0）
//
// 安全の考え方
//   ・JSONは JSON.parse で読むだけ（実行しない）。決まった項目だけを取り出し、文字数・件数・ファイルサイズを制限する
//   ・秘密鍵・APIキーらしきものが入っていたら読み込まない。個人情報らしきものが入った根拠は保存しない
//   ・プロジェクト名・確定仕様の版・項目数が合わないJSONは読み込まない
//   ・番号だけで対応させない：番号の位置にある仕様項目と、項目名の重なりも確かめる。
//     名前が合わない行・ほかの項目の方が似ている行は「要手動対応」にして、利用者が確認するまで反映しない
//   ・既定では、Factoryで「未判定」の項目だけに反映する。すでに判定済みの項目・メモは上書きしない（利用者が行ごとに選んだときだけ上書き）
//   ・反映は1回の保存（プロジェクトの記録1件）で行うので、全部成功するか、何も変わらないか
//   ・この部品はネットワークに接続しない（STORM本番アプリ・Supabaseにはアクセスしない）
import { findPersonalInfo } from './privacy.js';

export const IMPORT_LIMITS = { maxBytes: 200 * 1024, maxRecords: 200, label: 300, evidence: 1000, verification: 100, text: 200 };
export const PROPOSAL_FORMAT = /^[a-z0-9-]+-assessment-proposal\/v1$/;
// JSONの判定 → Factoryの判定（master.coverageStatuses の key）
export const ASSESSMENT_MAP = { '実装済み': 'done', '一部': 'partial', '一部実装済み': 'partial', '未実装': 'todo', '仕様と違う': 'diff', '仕様と実装が違う': 'diff', '未判定': 'unjudged' };
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{20,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, /service_role/i, /SUPABASE_(SERVICE|SECRET)/i, /\bAIza[0-9A-Za-z_-]{30,}/,
];
export const MATCH_MIN = 0.5;      // 項目名の重なり（JSONの項目名の2文字の組のうち、仕様項目に含まれる割合）
export const MATCH_MARGIN = 0.15;  // ほかの項目の方がこれ以上似ていたら「要手動対応」

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const err = (errors, msg) => { errors.push(msg); };

/** JSONの文字列を読み、決まった項目だけを取り出す（実行しない） */
export function parseProposal(text, { bytes } = {}) {
  const errors = [];
  const size = bytes ?? new TextEncoder().encode(String(text ?? '')).length;
  if (size > IMPORT_LIMITS.maxBytes) return { ok: false, errors: [`ファイルが大きすぎます（${Math.round(size / 1024)}KB。上限 ${IMPORT_LIMITS.maxBytes / 1024}KB）`] };
  const raw = String(text ?? '');
  const secret = SECRET_PATTERNS.find(re => re.test(raw));
  if (secret) return { ok: false, errors: ['秘密鍵・APIキーらしき文字が含まれているため、読み込みません（ファイルの中身を確認してください）'] };
  let j;
  try { j = JSON.parse(raw); } catch { return { ok: false, errors: ['JSONとして読めません（ファイルが壊れているか、別の形式です）'] }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, errors: ['判定候補のJSONではありません'] };
  const format = clean(j.format, IMPORT_LIMITS.text);
  if (!PROPOSAL_FORMAT.test(format)) err(errors, `形式が違います（format：${format || 'なし'}）`);
  const records = Array.isArray(j.records) ? j.records : null;
  if (!records) err(errors, '判定の行（records）がありません');
  else if (records.length > IMPORT_LIMITS.maxRecords) err(errors, `行が多すぎます（${records.length}行。上限 ${IMPORT_LIMITS.maxRecords}行）`);
  const data = {
    format, projectName: clean(j.project_name, IMPORT_LIMITS.text), specVersion: clean(j.spec_version, 20), generatedOn: clean(j.generated_on, 40),
    source: clean(j.source, IMPORT_LIMITS.text), overwrite: j.overwrite_existing_assessments === true, records: [],
  };
  if (records && records.length <= IMPORT_LIMITS.maxRecords) {
    const seen = new Set();
    records.forEach((r, i) => {
      if (!r || typeof r !== 'object') { err(errors, `${i + 1}行目：形式が違います`); return; }
      const number = Number(r.number);
      if (!Number.isInteger(number) || number < 1) { err(errors, `${i + 1}行目：番号（number）が正しくありません`); return; }
      if (seen.has(number)) err(errors, `番号 ${number} が重複しています`);
      seen.add(number);
      const assessmentRaw = clean(r.assessment, 20);
      const status = ASSESSMENT_MAP[assessmentRaw];
      if (!status) err(errors, `番号 ${number}：判定「${assessmentRaw}」は使えません（実装済み・一部・未実装・仕様と違う・未判定）`);
      const label = clean(r.spec_label, IMPORT_LIMITS.label);
      if (!label) err(errors, `番号 ${number}：項目名（spec_label）がありません`);
      let evidence = clean(r.evidence, IMPORT_LIMITS.evidence), pii = false;
      if (evidence && findPersonalInfo(evidence).length) { evidence = ''; pii = true; }
      data.records.push({ number, label, assessment: assessmentRaw, status, verification: clean(r.verification, IMPORT_LIMITS.verification), evidence, pii });
    });
    data.records.sort((a, b) => a.number - b.number);
  }
  return { ok: !errors.length, errors, data };
}

// ---- 照合 ----
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s、。，．・／/：:（）()「」『』〜~\-—,.!?！？…｜|]/g, '');
const bigrams = s => { const t = norm(s); if (t.length < 2) return new Set(t ? [t] : []); const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
/** JSONの項目名が、仕様項目（見出し＋本文）にどれだけ含まれるか（0〜1） */
export function labelScore(label, item) {
  const a = bigrams(label), b = bigrams(`${item.head}${item.text}`);
  if (!a.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n / a.size;
}

/**
 * プロジェクト・版・項目数を確かめ、行ごとに仕様項目と対応させる
 * @returns {{ ok, errors, rows: [{ rec, item, score, alt, state: 'matched'|'ambiguous'|'mismatch' }] }}
 */
export function matchProposal(data, { projectName, specVersion, items }) {
  const errors = [];
  if (data.projectName !== projectName) errors.push(`別のプロジェクトのJSONです（JSON：${data.projectName || 'なし'}／このプロジェクト：${projectName}）`);
  if (data.specVersion !== specVersion) errors.push(`確定仕様の版が違います（JSON：${data.specVersion || 'なし'}／Factory：${specVersion || 'なし'}）`);
  if (data.records.length !== items.length) errors.push(`項目の数が合いません（JSON：${data.records.length}行／Factoryの確定仕様：${items.length}項目）。件数を無理に合わせず、反映しません`);
  const nums = data.records.map(r => r.number);
  const missing = items.map((_, i) => i + 1).filter(n => !nums.includes(n));
  if (missing.length && data.records.length === items.length) errors.push(`番号が抜けています：${missing.join('・')}`);
  if (errors.length) return { ok: false, errors, rows: [] };
  const rows = data.records.map(rec => {
    const item = items[rec.number - 1];
    const score = labelScore(rec.label, item);
    let alt = null;
    items.forEach((it, i) => { if (i !== rec.number - 1) { const s = labelScore(rec.label, it); if (!alt || s > alt.score) alt = { item: it, score: s, number: i + 1 }; } });
    const state = score < MATCH_MIN ? 'mismatch' : (alt && alt.score > score + MATCH_MARGIN) ? 'ambiguous' : 'matched';
    return { rec, item, score, alt, state };
  });
  return { ok: true, errors: [], rows };
}

/**
 * 反映する内容を決める（保存はしない）
 * @param rows matchProposal の rows
 * @param coverage 今のFactoryの照合（{ key: { status, memo, ... } }）
 * @param confirmed 「この対応で正しい」と確認した番号の集合（要手動対応の行だけに効く）
 * @param overwrite 「上書きする」を選んだ番号の集合（既存の判定がある行だけに効く）
 * @returns { rows: [...{ action, existing }], counts, canApply, entries }
 *   action：'apply'（未判定へ反映）| 'overwrite'（選んで上書き）| 'keep'（既存の判定を保持）| 'same'（同じ判定で変更なし）| 'none'（JSONも未判定）| 'blocked'（要手動対応・未反映）| 'mismatch'（対応できない・未反映）
 */
export function planImport(rows, coverage = {}, { confirmed = new Set(), overwrite = new Set() } = {}) {
  const out = rows.map(r => {
    const existing = coverage[r.item.key] || null;
    const exStatus = existing?.status || 'unjudged';
    const judged = exStatus !== 'unjudged';
    let action;
    if (r.state === 'mismatch') action = 'mismatch';
    else if (r.state === 'ambiguous' && !confirmed.has(r.rec.number)) action = 'blocked';
    else if (r.rec.status === 'unjudged') action = judged ? 'keep' : 'none';
    else if (!judged) action = 'apply';
    else if (exStatus === r.rec.status) action = 'same';
    else action = overwrite.has(r.rec.number) ? 'overwrite' : 'keep';
    return { ...r, existing, exStatus, judged, action };
  });
  const count = a => out.filter(r => r.action === a).length;
  const counts = {
    total: out.length, matched: out.filter(r => r.state === 'matched' || (r.state === 'ambiguous' && confirmed.has(r.rec.number))).length,
    blocked: count('blocked'), mismatch: count('mismatch'), apply: count('apply'), overwrite: count('overwrite'), keep: count('keep'), same: count('same'), none: count('none'),
    existing: out.filter(r => r.judged).length, overwritable: out.filter(r => r.judged && r.rec.status !== 'unjudged' && r.exStatus !== r.rec.status && r.state !== 'mismatch').length,
  };
  const canApply = !counts.blocked && !counts.mismatch && (counts.apply + counts.overwrite) > 0;
  return { rows: out, counts, canApply };
}

/** JSONの判定の内訳（実装済み・一部…の件数） */
export function proposalSummary(data) {
  const c = { done: 0, partial: 0, todo: 0, diff: 0, unjudged: 0 };
  for (const r of data.records) c[r.status]++;
  return c;
}

/** 反映後の照合（新しい coverage）を作る。既存のメモは消さない */
export function buildCoverage(coverage = {}, plan, { source = '', generatedOn = '', at = new Date().toISOString() } = {}) {
  const next = { ...coverage };
  for (const r of plan.rows) {
    if (r.action !== 'apply' && r.action !== 'overwrite') continue;
    const prev = coverage[r.item.key] || {};
    const note = `【判定候補JSON ${generatedOn}】${r.rec.verification || '暫定判定'}（実機動作確認済みではありません）${r.rec.evidence ? `：${r.rec.evidence}` : ''}${r.rec.pii ? '（根拠の文章は個人情報らしき内容を含むため保存していません）' : ''}`;
    next[r.item.key] = {
      ...prev, status: r.rec.status, memo: prev.memo || note, at,
      imported: { source, generatedOn, number: r.rec.number, label: r.rec.label, assessment: r.rec.assessment, verification: r.rec.verification, note, previous: r.action === 'overwrite' ? { status: prev.status || 'unjudged', memo: prev.memo || '' } : null },
    };
  }
  return next;
}
