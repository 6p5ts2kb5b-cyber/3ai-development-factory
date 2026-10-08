// Phase Sync-2-4：この端末への取り込み（クラウド → この端末の一方向）
// ・クラウドは読むだけ。書き込み・削除の命令は持たない（自動テストで確認）。
// ・取り込みは、利用者が「クラウドのデータに切り替える」を選んで取り込みボタンを押したときだけ。
// ・この端末のデータの置き換えは、復元と同じ「全部成功するか、何も変わらないか」の仕組み（importAll）で行う。
// ・取り込んだ後、クラウドの全件と1件ずつ照合する。一致しなければ、取り込み前の控えへ自動で戻す。
// ・端末ごとの記録（設定値・自動テスト結果・バックアップ日時）と、この端末だけの記録（localOnly）はそのまま残す。
import { currentUid } from './auth.js';
import { firestoreHandle, META_PATH, describeMeta } from './cloud.js';
import { isSyncTarget, analyzeForSync, fingerprint, SYNC_TARGET_STORES } from './dryrun.js';
import { sha256, saveSnapshot, getSnapshot, SYNC_DB } from './register.js';

const IMPORT_SNAPSHOT_PREFIX = 'factory-import-snapshot:';
export function getImportSnapshotFallback(id) {
  try { const s = localStorage.getItem(IMPORT_SNAPSHOT_PREFIX + id); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function saveImportSnapshotFallback(rec) {
  localStorage.setItem(IMPORT_SNAPSHOT_PREFIX + rec.id, JSON.stringify(rec));
}
export function clearImportSnapshotFallback(id) {
  try { localStorage.removeItem(IMPORT_SNAPSHOT_PREFIX + id); } catch {}
}
const uidOrThrow = () => { const u = currentUid(); if (!u) throw Object.assign(new Error('not signed in'), { code: 'unauthenticated' }); return u; };

// クラウドの全件を読む（読むだけ）。登録済みのものだけ。内容の指紋で1件ずつ確かめる
export async function readCloudData() {
  const uid = uidOrThrow();
  const { fs, db } = await firestoreHandle();
  const ms = await fs.getDocFromServer(fs.doc(db, ...META_PATH(uid)));
  if (!ms.exists()) throw Object.assign(new Error('クラウドにはまだ何も登録されていません。先に初回正本の端末で「初回正本登録」をしてください'), { code: 'not-registered' });
  const raw = ms.data(), meta = { raw, ...describeMeta(raw) };
  if (meta.state !== 'registered') throw Object.assign(new Error(meta.state === 'uploading' ? '初回登録が途中です。初回正本の端末で「もう一度送る」を押して完了させてから取り込んでください' : 'クラウドの印を確認できません。この画面をClaudeに送ってください'), { code: 'not-registered' });
  const uploadId = raw.uploadId;
  let chunkMap = {};
  if (raw.chunked > 0) {
    const cs = await fs.getDocsFromServer(fs.collection(db, 'users', uid, 'chunks'));
    cs.forEach(d => { const x = d.data(); if (x.uploadId !== uploadId) return; (chunkMap[`${x.store}~${x.docId}`] ||= [])[x.index] = x.json; });
  }
  const records = {}, problems = [];
  let ignored = 0;
  for (const store of SYNC_TARGET_STORES) {
    if (!(raw.counts?.[store] > 0)) { records[store] = []; continue; }
    const snap = await fs.getDocsFromServer(fs.collection(db, 'users', uid, store));
    const list = [];
    const docs = [];
    snap.forEach(d => docs.push([d.id, d.data()]));
    for (const [docId, x] of docs) {
      if (x.uploadId !== uploadId) { ignored++; continue; } // 前回の途中の記録などは使わない
      // 分割された記録は、記録の部分数（parts）までをつなぐ（Sync-3で小さく書き換えた後の古い部分は使わない）
      const json = x.parts ? (chunkMap[`${store}~${docId}`] || []).slice(0, x.parts).join('') : x.json;
      if (typeof json !== 'string' || (await sha256(json)) !== x.hash) { problems.push({ store, id: x.id, reason: '内容の指紋が一致しません' }); continue; }
      try { list.push({ rec: JSON.parse(json), hash: x.hash, docId, cloudRev: x.cloudRev || 0, deviceLabel: x.deviceLabel || '', deviceId: x.deviceId || '', pushedAt: x.pushedAt || null }); } catch { problems.push({ store, id: x.id, reason: '読み取れません' }); }
    }
    records[store] = list;
  }
  const counts = Object.fromEntries(SYNC_TARGET_STORES.map(s => [s, records[s].length]));
  for (const s of SYNC_TARGET_STORES) if ((raw.counts?.[s] || 0) !== counts[s]) problems.push({ store: s, reason: `件数が登録時と違います（登録時 ${raw.counts?.[s] || 0}件・クラウド ${counts[s]}件）` });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const targets = SYNC_TARGET_STORES.flatMap(s => records[s].map(x => [s, x.rec]));
  const fp = await fingerprint(targets);
  if (raw.fingerprint && fp !== raw.fingerprint) problems.push({ reason: 'データ全体の指紋が登録時と一致しません' });
  if (raw.total != null && raw.total !== total) problems.push({ reason: `合計件数が登録時と違います（登録時 ${raw.total}件・クラウド ${total}件）` });
  return { meta, uploadId, records, counts, total, fingerprint: fp, problems, ignored, ok: !problems.length };
}

// この端末の今のデータ（読むだけ）
export function localSummary(exp, expectedProjects = []) {
  const a = analyzeForSync(exp, { expectedProjects });
  return { analysis: a, total: a.total, isEmpty: a.total === 0, projects: a.projects };
}

// 取り込み後のこの端末の全データ（クラウドの記録＋この端末に残すもの）を組み立てる
export function buildImportJson(cloud, localExp) {
  const data = {};
  for (const s of Object.keys(localExp.data)) data[s] = [];
  for (const s of SYNC_TARGET_STORES) data[s] = (cloud.records[s] || []).map(x => x.rec);
  // この端末に残すもの：端末ごとの設定（同期の対象外）と、この端末だけの記録（localOnly）
  const kept = [];
  for (const [s, rows] of Object.entries(localExp.data)) for (const r of rows || []) {
    if (isSyncTarget(s, r)) continue;
    if (data[s].some(x => x.id === r.id)) continue;
    data[s].push(r); kept.push([s, r.id]);
  }
  const counts = Object.fromEntries(Object.entries(data).map(([s, rows]) => [s, rows.length]));
  return { json: { app: localExp.app, schemaVersion: localExp.schemaVersion, exportedAt: new Date().toISOString(), exportedBy: 'クラウドから取り込み', deviceId: localExp.deviceId, counts, data }, kept };
}

// 取り込んだ後の照合：クラウドの全件が、この端末に同じ内容であるか（取り込みの記録1件と、残したものは除く）
export async function verifyLocal(cloud, afterExp, { kept = [], importHistoryId = null } = {}) {
  const mismatches = [];
  const keptSet = new Set(kept.map(([s, id]) => `${s}/${id}`));
  let checked = 0;
  for (const s of SYNC_TARGET_STORES) {
    const local = new Map((afterExp.data[s] || []).map(r => [r.id, r]));
    for (const x of cloud.records[s] || []) {
      const r = local.get(x.rec.id);
      if (!r) { mismatches.push({ store: s, id: x.rec.id, reason: 'この端末にありません' }); continue; }
      if ((await sha256(JSON.stringify(r))) !== x.hash) { mismatches.push({ store: s, id: x.rec.id, reason: '内容が一致しません' }); continue; }
      checked++;
    }
    const cloudIds = new Set((cloud.records[s] || []).map(x => x.rec.id));
    for (const r of afterExp.data[s] || []) {
      if (cloudIds.has(r.id) || keptSet.has(`${s}/${r.id}`) || !isSyncTarget(s, r)) continue;
      if (s === 'history' && (r.id === importHistoryId || (!importHistoryId && r.action === 'import'))) continue;
      mismatches.push({ store: s, id: r.id, reason: 'クラウドにない記録が残っています' });
    }
  }
  const targets = SYNC_TARGET_STORES.flatMap(s => (afterExp.data[s] || []).filter(r => (cloud.records[s] || []).some(x => x.rec.id === r.id)).map(r => [s, r]));
  const fp = await fingerprint(targets);
  if (fp !== cloud.fingerprint) mismatches.push({ reason: 'データ全体の指紋が一致しません' });
  return { ok: !mismatches.length && checked === cloud.total, checked, mismatches, fingerprint: fp };
}

// 照合用の記録（Sync-3で使う）。Factoryとは別のデータベース
async function saveImportState(rec) {
  const d = await new Promise((res, rej) => { const r = indexedDB.open(SYNC_DB, 1); r.onupgradeneeded = () => { const x = r.result; if (!x.objectStoreNames.contains('snapshots')) x.createObjectStore('snapshots', { keyPath: 'id' }); if (!x.objectStoreNames.contains('state')) x.createObjectStore('state', { keyPath: 'id' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try { await new Promise((res, rej) => { const q = d.transaction('state', 'readwrite').objectStore('state').put({ id: 'import', ...rec }); q.onsuccess = res; q.onerror = () => rej(q.error); }); } finally { d.close(); }
}
export async function getImportState() {
  const d = await new Promise((res, rej) => { const r = indexedDB.open(SYNC_DB, 1); r.onupgradeneeded = () => { const x = r.result; if (!x.objectStoreNames.contains('snapshots')) x.createObjectStore('snapshots', { keyPath: 'id' }); if (!x.objectStoreNames.contains('state')) x.createObjectStore('state', { keyPath: 'id' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try { return await new Promise((res, rej) => { const q = d.transaction('state').objectStore('state').get('import'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } finally { d.close(); }
}

/**
 * 取り込みの本体
 * @param {FactoryDB} db この端末のデータベース
 * @param {object} p { snapshotId（取り込み前の控え）, expectedFingerprint（確認画面で見たクラウドの指紋）, onProgress }
 */
export async function runImport(db, { snapshotId, expectedFingerprint, onProgress = () => {} }) {
  uidOrThrow();
  let snap = await getSnapshot(snapshotId);
  if (!snap) snap = getImportSnapshotFallback(snapshotId);
  if (!snap) throw Object.assign(new Error('取り込み前のバックアップ（端末内の控え）が見つかりません。バックアップからやり直してください'), { code: 'no-backup' });
  // 1) 直前にもう一度クラウドを読み、確認画面と同じ内容か確かめる
  onProgress('read');
  const cloud = await readCloudData();
  if (!cloud.ok) throw Object.assign(new Error(`クラウドの内容に問題があります（${cloud.problems.length}件）。取り込みは行っていません`), { code: 'cloud-problem', problems: cloud.problems });
  if (expectedFingerprint && cloud.fingerprint !== expectedFingerprint) throw Object.assign(new Error('確認画面のあとにクラウドの内容が変わりました。「クラウドの内容を確認する」からやり直してください'), { code: 'cloud-changed' });
  // 2) 控えを作った後にこの端末のデータが変わっていないか
  const before = await db.exportAll();
  const beforeSnapJson = JSON.parse(snap.json);
  if ((await fingerprint(analyzeForSync(before).targetsForFingerprint)) !== snap.fingerprint) throw Object.assign(new Error('バックアップの後にこの端末のデータが変わりました。バックアップからやり直してください'), { code: 'local-changed' });
  // 3) 置き換え（全部成功するか、何も変わらないか）
  onProgress('write');
  const { json, kept } = buildImportJson(cloud, before);
  const startedAt = new Date().toISOString();
  await db.importAll(json, { reason: `クラウドから取り込み（登録元：${cloud.meta.sourceDevice || '不明'}・${cloud.total}件）` });
  // 4) 照合。一致しなければ、取り込み前の控えへ戻す
  onProgress('verify');
  const after = await db.exportAll();
  const imp = (after.data.history || []).filter(h => h.action === 'import' && h.at >= startedAt).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const v = await verifyLocal(cloud, after, { kept, importHistoryId: imp?.id });
  if (!v.ok) {
    await db.importAll(beforeSnapJson, { reason: '取り込みの照合が一致しなかったため、取り込み前の控えへ戻しました' });
    throw Object.assign(new Error(`照合で一致しない記録が ${v.mismatches.length} 件ありました。取り込み前のデータに戻しました`), { code: 'verify-failed', mismatches: v.mismatches });
  }
  await saveImportState({ uploadId: cloud.uploadId, fingerprint: cloud.fingerprint, snapshotId, status: 'complete', at: new Date().toISOString(), hashes: Object.fromEntries(SYNC_TARGET_STORES.flatMap(s => cloud.records[s].map(x => [`${s}/${x.rec.id}`, x.hash]))) });
  onProgress('done');
  return { checked: v.checked, total: cloud.total, kept: kept.length, cloud };
}

export function importErrorMessage(e) {
  const keep = '（この端末のデータは、取り込み前のまま、またはバックアップから戻せる状態です）';
  if (['not-registered', 'cloud-problem', 'cloud-changed', 'local-changed', 'no-backup'].includes(e?.code)) return { title: '取り込みできません', how: `${e.message}${keep}` };
  if (e?.code === 'verify-failed') return { title: '照合が一致しませんでした', how: `${e.message}。もう一度取り込むか、この画面をClaudeに送ってください。` };
  if (e?.code === 'permission-denied') return { title: 'クラウドを使う許可がありません', how: `Firebaseの owners に、このアカウントのユーザーIDが登録されているか確認してください。${keep}` };
  if (e?.code === 'unavailable') return { title: 'クラウドに接続できませんでした', how: `インターネット接続を確認して、もう一度押してください。${keep}` };
  if (e?.code === 'unauthenticated') return { title: 'ログインしていません', how: `「Googleログイン」画面でログインしてください。${keep}` };
  return { title: '取り込みできませんでした', how: `${e?.message || e}${keep}` };
}
export { saveSnapshot };
