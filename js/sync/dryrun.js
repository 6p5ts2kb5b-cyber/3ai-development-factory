// Phase Sync-2-2：登録の予行演習（確認だけ）
// ・この端末のデータを「読むだけ」で、初回登録で何を何件送ることになるかを数える。
// ・クラウドへは送らない（このファイルは Firebase を読み込まない）。端末のデータも変更しない（書き込みの命令を持たない）。
// ・画面に依存しない純粋な計算（自動テストの対象）。
import { findPersonalInfo } from '../privacy.js';

// 同期の対象（初回登録で送るもの）
export const SYNC_TARGET_STORES = ['projects', 'specs', 'requests', 'compares', 'files', 'tests', 'urls', 'issues', 'ideas', 'tasks', 'guides', 'handoff', 'checks', 'history', 'trash', 'settings'];
// 端末ごとの記録（同期しない設定）
export const DEVICE_LOCAL_SETTINGS = ['master', 'lastTestRun', 'lastBackup'];
// Firestoreの1件の上限は 1MiB。余裕を見て 900KB を超えるものは「大きすぎる（分割が必要）」とする
export const FIRESTORE_DOC_LIMIT = 1048576;
export const SIZE_WARN = 900000;

export const STORE_LABELS_JA = { projects: 'プロジェクト', specs: '仕様書', requests: '要望', compares: '3AI比較', files: 'ファイル・コード', tests: 'テスト', urls: 'URL', issues: '未解決事項', ideas: '相談メモ', tasks: '次にやること', guides: '指示書の保存版', handoff: '引継ぎ', checks: '実機・公開確認', history: '変更履歴', trash: 'ゴミ箱', settings: '設定' };

// 個人情報チェックで見ない項目（記録の管理用の情報。作成者名などで同じ指摘が大量に出るのを防ぐ）
const SKIP_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'rev', 'deviceId', 'localOnly', 'actor', 'by', 'decidedBy', 'fixedBy', 'checkedBy', 'at', 'projectId', 'recordId', 'store', 'seedKey', 'key', 'master']);

const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export const byteSize = obj => { const s = JSON.stringify(obj) ?? ''; return enc ? enc.encode(s).length : s.length * 3; };

// 記録の見出し（画面表示用）
export function recordLabel(store, r) {
  if (store === 'history') return `${STORE_LABELS_JA[r?.store] || r?.store || ''}の${({ create: '作成', update: '変更', delete: '削除', restore: '復元', purge: '完全削除', fix: '確定', import: '復元' })[r?.action] || r?.action || '記録'}（${String(r?.at || '').slice(0, 10)}）`;
  if (store === 'trash') return `ゴミ箱：${r?.record?.name || r?.record?.title || r?.record?.fileName || r?.recordId || r?.id || ''}`.slice(0, 60);
  const v = r?.name || r?.title || r?.item || r?.topic || r?.fileName || r?.url || r?.device || r?.key || (typeof r?.text === 'string' ? r.text.slice(0, 30) : '') || (r?.record?.name) || r?.id || '';
  return String(v).slice(0, 60);
}

// 同期の対象かどうか
export function isSyncTarget(store, r) {
  if (!SYNC_TARGET_STORES.includes(store) || !r) return false;
  if (r.localOnly === true) return false;
  if (store === 'settings' && DEVICE_LOCAL_SETTINGS.includes(r.key || r.id)) return false;
  return true;
}

// 並び順をそろえたJSON（データの指紋用）
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// 日時だけの値（例：2026-10-05T01:23:45.678Z、2026-10-05）は個人情報の判定に使わない
const DATETIME_ONLY = /^\s*(?:19|20)\d{2}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\s*$/;
function walkStrings(obj, path, out, depth = 0) {
  if (depth > 6 || obj == null) return;
  if (typeof obj === 'string') { if (obj.length >= 2 && !DATETIME_ONLY.test(obj)) out.push([path, obj]); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => walkStrings(v, path, out, depth + 1)); return; }
  // 「〜At」（作成日時・更新日時・確定日時など）の項目は日時なので見ない
  if (typeof obj === 'object') for (const [k, v] of Object.entries(obj)) if (!SKIP_KEYS.has(k) && !/At$/.test(k)) walkStrings(v, path ? `${path}.${k}` : k, out, depth + 1);
}

/**
 * 予行演習の本体
 * @param {object} exp  db.exportAll() の結果（読むだけ）
 * @param {object} opt  { master, expectedProjects: string[], checkBackup: fn(json)=>void（不正なら例外） }
 */
export function analyzeForSync(exp, { master = null, expectedProjects = [], checkBackup = null } = {}) {
  const data = exp?.data || {};
  const counts = {}, excluded = { localOnly: 0, deviceSettings: [] };
  const targets = [];
  for (const store of Object.keys(data)) {
    for (const r of data[store] || []) {
      if (isSyncTarget(store, r)) { targets.push([store, r]); counts[store] = (counts[store] || 0) + 1; }
      else if (r?.localOnly === true) excluded.localOnly++;
      else if (store === 'settings') excluded.deviceSettings.push(r.key || r.id);
    }
  }
  for (const s of SYNC_TARGET_STORES) counts[s] ||= 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // プロジェクト
  const projects = (data.projects || []).filter(p => isSyncTarget('projects', p));
  // 並び：Phase 7の正式登録の順（Factory本体 → 開発順の7件）→ それ以外は作成日順
  const ord = n => { const i = expectedProjects.indexOf(n); return i < 0 ? 1e6 : i; };
  const names = projects.slice().sort((a, b) => ord(a.name) - ord(b.name) || String(a.createdAt).localeCompare(String(b.createdAt))).map(p => p.name);
  const dupNames = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const missing = expectedProjects.filter(n => !names.includes(n));
  const extra = names.filter(n => !expectedProjects.includes(n));

  // 大きさ
  const sized = targets.map(([store, r]) => ({ store, id: r.id, label: recordLabel(store, r), bytes: byteSize(r) }));
  const totalBytes = sized.reduce((a, b) => a + b.bytes, 0);
  const tooLarge = sized.filter(x => x.bytes > SIZE_WARN).sort((a, b) => b.bytes - a.bytes);
  const largest = sized.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3);

  // 最後に更新された日時
  const lastUpdated = targets.reduce((m, [, r]) => (r.updatedAt && r.updatedAt > m ? r.updatedAt : m), '');

  // バックアップを作れるか（ファイルにはしない。中身の検査だけ）
  let backup = { ok: true, bytes: 0, reason: '' };
  try {
    const text = JSON.stringify(exp);
    backup.bytes = enc ? enc.encode(text).length : text.length;
    if (checkBackup) checkBackup(JSON.parse(text));
  } catch (e) { backup = { ok: false, bytes: backup.bytes, reason: (e?.details?.join(' / ') || e?.message || String(e)) }; }

  // 個人情報らしき記述（同じ言葉はまとめる）
  const found = new Map();
  for (const [store, r] of targets) {
    const strs = [];
    walkStrings(r, '', strs);
    for (const [field, text] of strs) {
      // 「注意する言葉」（生徒・保護者など、AIへの依頼文で気をつける一般的な言葉）は仕様の文章にも普通に出るため数えない。
      // ここでは、メールアドレス・電話番号・住所・郵便番号・人名＋敬称・学籍番号など、具体的な個人情報らしきものだけを見る
      for (const f of findPersonalInfo(text, null)) {
        const k = `${f.kind}|${f.text}`;
        if (!found.has(k)) found.set(k, { kind: f.kind, text: f.text, count: 0, places: [] });
        const e = found.get(k);
        e.count++;
        if (e.places.length < 3) e.places.push({ store, label: recordLabel(store, r), field });
      }
    }
  }
  const privacy = [...found.values()].sort((a, b) => b.count - a.count);
  const privacyByKind = privacy.reduce((m, p) => (m[p.kind] = (m[p.kind] || 0) + 1, m), {});

  const main = { projects: counts.projects, specs: counts.specs, requests: counts.requests, history: counts.history };
  const others = Object.fromEntries(SYNC_TARGET_STORES.filter(s => !['projects', 'specs', 'requests', 'history'].includes(s)).map(s => [s, counts[s]]));
  const otherTotal = Object.values(others).reduce((a, b) => a + b, 0);
  const issues = [];
  if (!backup.ok) issues.push('バックアップを作れません');
  if (tooLarge.length) issues.push(`大きすぎるデータが${tooLarge.length}件あります（初回登録では分割して送ります）`);
  if (missing.length) issues.push(`Phase 7の8プロジェクトのうち、${missing.length}件が見つかりません`);
  if (dupNames.length) issues.push(`同じ名前のプロジェクトがあります（${dupNames.join('、')}）`);
  if (privacy.length) issues.push(`個人情報らしき記述が${privacy.length}種類あります（止めはしません。見直してください）`);

  return {
    total, counts, main, others, otherTotal, excluded,
    projects: { count: projects.length, names, dupNames, missing, extra, expected: expectedProjects.length },
    size: { totalBytes, tooLarge, largest, limit: FIRESTORE_DOC_LIMIT, warn: SIZE_WARN },
    backup, privacy, privacyByKind, lastUpdated,
    exportedAt: exp?.exportedAt || null, deviceId: exp?.deviceId || null, schemaVersion: exp?.schemaVersion ?? null,
    issues,
    // 初回登録の前に必ず直す必要があるもの（バックアップ不可だけ。ほかは確認・判断事項）
    blocking: !backup.ok,
    targetsForFingerprint: targets,
  };
}

// データの指紋（同期対象の中身から計算。2台の端末が同じデータかを見比べる用）
export async function fingerprint(targets) {
  const text = targets.map(([s, r]) => `${s}\u0000${r.id}\u0000${canonical(r)}`).sort().join('\n');
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { // 安全な接続でない等で使えない場合の簡易版
    let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'fnv' + (h >>> 0).toString(16).padStart(8, '0');
  }
}

// 端末どうしで見比べるための文章（コピー用）
export function summaryText(r, { device = '', fp = '', checkedAt = '' } = {}) {
  const L = [];
  L.push(`【Factory 同期の予行演習】${device}`);
  L.push(`確認日時：${checkedAt}`);
  L.push(`データの指紋：${fp.slice(0, 12)}`);
  L.push(`最後の更新：${r.lastUpdated || 'なし'}`);
  L.push(`プロジェクト：${r.projects.count}件（${r.projects.names.join('、') || 'なし'}）`);
  L.push(`仕様書：${r.main.specs}件／要望：${r.main.requests}件／変更履歴：${r.main.history}件／その他：${r.otherTotal}件／合計：${r.total}件`);
  L.push(`バックアップ：${r.backup.ok ? `作成できます（${(r.backup.bytes / 1024 / 1024).toFixed(2)}MB）` : `作成できません（${r.backup.reason}）`}`);
  L.push(`大きすぎるデータ：${r.size.tooLarge.length}件`);
  L.push(`個人情報らしき記述：${r.privacy.length}種類`);
  if (r.issues.length) L.push(`確認が必要：${r.issues.join('／')}`);
  return L.join('\n');
}
