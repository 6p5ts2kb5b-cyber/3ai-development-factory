// Phase Sync-3：PC・iPhoneの双方向同期（明示ボタン式・記録ごとの差分）
//
// 考え方（3つを比べる）
//   この端末の記録（L）・前回そろえたときの記録（B：基準）・クラウドの記録（C）を、記録ごとの「内容の指紋（SHA-256）」で比べる。
//   ・この端末だけ変わった → 「未送信」     ・クラウドだけ変わった → 「受け取り待ち」
//   ・両方で違う内容に変わった → 「競合」（どちらも勝手に採用しない。利用者が選ぶ）
// 安全装置
//   ・送る／受け取るのは利用者がボタンを押したときだけ。送る前・受け取る前に件数と内容を表示する
//   ・送る直前に、クラウドの該当記録と「登録済みの印」の変更番号（changeSeq）を確かめ、他の端末の新しい変更があれば送らない（Firestoreのトランザクション）
//   ・送った後は読み直して照合。受け取った後は端末の記録を読み直して照合。一致したときだけ「同期完了」
//   ・受け取りは、端末内の控えを自動で作ってから、1回の処理で全部成功するか何も変わらない形で書き込む。照合が合わなければ控えへ戻す
//   ・削除はクラウドへ反映しない（この端末で削除した記録は「この端末で削除（クラウドには反映しません）」と表示するだけ）
//   ・端末ごとの記録（設定値・自動テスト結果・バックアップ日時）、この端末だけの記録（localOnly）、ゴミ箱は同期しない
//   ・このファイルに削除の命令はない
import { currentUid } from './auth.js';
import { firestoreHandle, META_PATH } from './cloud.js';
import { isSyncTarget, fingerprint, SYNC_TARGET_STORES, recordLabel, STORE_LABELS_JA } from './dryrun.js';
import { sha256, encodeId, splitChunks, CHUNK_OVER, SYNC_DB, getSyncState, saveSnapshot, getSnapshot } from './register.js';
import { readCloudData, getImportState } from './pull.js';

// Sync-3で同期する保存先（ゴミ箱は同期しない：削除をほかの端末へ反映しないため）
export const SYNC3_STORES = SYNC_TARGET_STORES.filter(s => s !== 'trash');
export const SYNC3_FORMAT = 3;
export const PUSH_CHUNK = 150; // 1回の送信（トランザクション）でまとめる記録の数
const enc = new TextEncoder();
const bytesOf = s => enc.encode(s).length;
const keyOf = (store, id) => `${store}/${id}`;
const isSync3 = (store, r) => SYNC3_STORES.includes(store) && isSyncTarget(store, r);
const uidOrThrow = () => { const u = currentUid(); if (!u) throw Object.assign(new Error('not signed in'), { code: 'unauthenticated' }); return u; };

// ---- この端末の同期の記録（Factoryとは別のデータベース factory-sync） ----
function openSyncDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SYNC_DB, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' }); if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const q = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
// 本番は端末ごとにFactoryのデータベースは1つ（名前 factory）なので記録名は 'sync3'。自動テストで2台分を試すときだけ、データベース名ごとに分ける
const stateId = db => (db?.idb?.name && db.idb.name !== 'factory') ? `sync3:${db.idb.name}` : 'sync3';
export async function getSync3State(db) { const d = await openSyncDB(); try { return (await q(d.transaction('state').objectStore('state').get(stateId(db)))) || null; } finally { d.close(); } }
async function putSync3State(db, rec) { const d = await openSyncDB(); try { await q(d.transaction('state', 'readwrite').objectStore('state').put({ ...rec, id: stateId(db) })); } finally { d.close(); } }
export async function updateSync3State(db, patch) { const cur = (await getSync3State(db)) || {}; const next = { ...cur, ...patch }; await putSync3State(db, next); return next; }

// この端末の同期対象（記録ごとの指紋）
export async function localMap(exp) {
  const m = new Map();
  for (const store of SYNC3_STORES) for (const r of exp.data?.[store] || []) {
    if (!isSync3(store, r)) continue;
    m.set(keyOf(store, r.id), { store, id: r.id, rec: r, hash: await sha256(JSON.stringify(r)) });
  }
  return m;
}
// クラウドの同期対象
export function cloudMap(cloud) {
  const m = new Map();
  for (const store of SYNC3_STORES) for (const x of cloud.records?.[store] || []) m.set(keyOf(store, x.rec.id), { store, id: x.rec.id, ...x });
  return m;
}

/**
 * 差分の計算（画面に依存しない・自動テストの対象）
 * @returns {{ push, pull, conflicts, localDeleted, same, counts }}
 *   push: { key, store, id, kind: 'new'|'update', fresh(この端末がまだ同期を始める前からある記録), rec, hash, baseHash, cloudHash }
 *   pull: { key, store, id, kind: 'new'|'update', rec, hash, deviceLabel, updatedAt, updatedBy }
 *   conflicts: { key, store, id, type: 'both'|'deletedLocal', local, cloud, baseHash }
 */
export function computeDiff({ local, base = {}, cloud, preexisting = {}, ignored = {} }) {
  const push = [], pull = [], conflicts = [], localDeleted = [], same = [];
  const keys = new Set([...local.keys(), ...Object.keys(base), ...cloud.keys()]);
  for (const key of keys) {
    const L = local.get(key), B = base[key], C = cloud.get(key);
    const [store, ...rest] = key.split('/'); const id = rest.join('/');
    if (!SYNC3_STORES.includes(store)) continue;
    if (L && !B) {
      // fresh：同期を始める前からこの端末だけにあった記録（最初はチェックを外して表示）
      if (!C) { if (ignored[key] && ignored[key] === L.hash) continue; push.push({ key, store, id, kind: 'new', fresh: !!preexisting[key], rec: L.rec, hash: L.hash, baseHash: null, cloudHash: null }); }
      else if (L.hash === C.hash) same.push({ key, hash: L.hash });
      else conflicts.push({ key, store, id, type: 'both', local: L, cloud: C, baseHash: null });
      continue;
    }
    if (L && B) {
      const lc = L.hash !== B, cc = C ? C.hash !== B : false;
      if (!lc && !cc) continue;
      if (lc && !cc) { push.push({ key, store, id, kind: C ? 'update' : 'new', fresh: false, rec: L.rec, hash: L.hash, baseHash: B, cloudHash: C?.hash || null }); continue; }
      if (!lc && cc) { pull.push({ key, store, id, kind: 'update', rec: C.rec, hash: C.hash, deviceLabel: C.deviceLabel, updatedAt: C.rec.updatedAt, updatedBy: C.rec.updatedBy }); continue; }
      if (L.hash === C.hash) { same.push({ key, hash: L.hash }); continue; }
      conflicts.push({ key, store, id, type: 'both', local: L, cloud: C, baseHash: B });
      continue;
    }
    if (!L && B) {
      if (!C || C.hash === B) localDeleted.push({ key, store, id });
      else conflicts.push({ key, store, id, type: 'deletedLocal', local: null, cloud: C, baseHash: B });
      continue;
    }
    if (!L && !B && C) pull.push({ key, store, id, kind: 'new', rec: C.rec, hash: C.hash, deviceLabel: C.deviceLabel, updatedAt: C.rec.updatedAt, updatedBy: C.rec.updatedBy });
  }
  const sortBy = (a, b) => SYNC3_STORES.indexOf(a.store) - SYNC3_STORES.indexOf(b.store) || String(a.id).localeCompare(String(b.id));
  push.sort(sortBy); pull.sort(sortBy); conflicts.sort(sortBy);
  return { push, pull, conflicts, localDeleted, same, counts: { push: push.length, pushFresh: push.filter(p => p.fresh).length, pull: pull.length, conflicts: conflicts.length, localDeleted: localDeleted.length } };
}

// 2つの記録の違い（項目ごと）。画面の「変更内容」に使う
const SKIP_FIELDS = new Set(['rev', 'updatedAt', 'updatedBy', 'deviceId']);
export function fieldDiff(a = {}, b = {}) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (SKIP_FIELDS.has(k)) continue;
    const x = JSON.stringify(a?.[k] ?? null), y = JSON.stringify(b?.[k] ?? null);
    if (x !== y) out.push({ field: k, local: a?.[k], cloud: b?.[k] });
  }
  return out;
}
export const describeRecord = (store, rec) => ({ storeLabel: STORE_LABELS_JA[store] || store, label: recordLabel(store, rec || {}) });

// ---- 状態の確認（読むだけ） ----
// 同期を始めているか・基準・クラウドの全件・差分をまとめて返す
export async function checkSync3(db) {
  uidOrThrow();
  const cloud = await readCloudData();                // クラウドの全件（内容の指紋で1件ずつ確認済み）
  if (!cloud.ok) throw Object.assign(new Error(`クラウドの内容に問題があります（${cloud.problems.length}件）。同期は行いません`), { code: 'cloud-problem', problems: cloud.problems });
  const st = await getSync3State(db);
  const exp = await db.exportAll();                   // この端末の全件（読むだけ）
  const local = await localMap(exp);
  const cmap = cloudMap(cloud);
  const started = !!(st && st.datasetId === cloud.uploadId);
  const diff = started ? computeDiff({ local, base: st.base || {}, cloud: cmap, preexisting: st.preexisting || {}, ignored: st.ignored || {} }) : null;
  return { cloud, cmap, local, exp, state: st, started, diff, meta: cloud.meta.raw, changeSeq: cloud.meta.raw.changeSeq || 0 };
}

// ---- Sync-3-0：同期を始める（この端末の基準を作る・クラウドの「登録済みの印」をSync-3形式にする） ----
// クラウドのデータ本体は書き換えない。印への書き込み（syncFormat・changeSeq）は、全件の照合と、クラウドの控えを端末内に保存した後だけ。
export async function startSync3(db, { deviceLabel, deviceId, baseSource = 'auto' }) {
  const uid = uidOrThrow();
  const cloud = await readCloudData();
  if (!cloud.ok) throw Object.assign(new Error(`クラウドの内容に問題があります（${cloud.problems.length}件）。同期は始めません`), { code: 'cloud-problem', problems: cloud.problems });
  // 移行前のバックアップ：クラウドの全件の控え（この端末内・Factoryとは別のデータベース）
  const cloudCopy = { app: '3ai-factory', schemaVersion: cloud.meta.raw.schemaVersion || 5, exportedAt: new Date().toISOString(), exportedBy: 'クラウドの控え（Sync-3開始前）', counts: cloud.counts, data: Object.fromEntries(Object.entries(cloud.records).map(([s, l]) => [s, l.map(x => x.rec)])) };
  const cloudSnap = await saveSnapshot(cloudCopy, { deviceKind: 'クラウドの控え' });
  if (!cloudSnap.ok) throw Object.assign(new Error('クラウドの控えを保存できませんでした。同期は始めません'), { code: 'no-backup' });
  // この端末の基準：初回正本の端末なら登録時の記録、取り込んだ端末なら取り込み時の記録。どちらでもなければ基準なし（この端末だけの記録は「送るか」を選ぶ）
  const reg = await getSyncState(), imp = await getImportState();
  let base = {}, fresh = true, from = 'none';
  // baseSource: 'auto'（登録・取り込みの記録があれば使う）| 'none'（使わない）
  const src = baseSource === 'none' ? null : [reg, imp].find(s => s && s.status === 'complete' && s.uploadId === cloud.uploadId && s.hashes);
  if (src) { base = Object.fromEntries(Object.entries(src.hashes).filter(([k]) => SYNC3_STORES.includes(k.split('/')[0]))); fresh = false; from = src === reg ? 'register' : 'import'; }
  // クラウドの印をSync-3形式に（まだなら。データ本体は変えない）
  const { fs, db: fdb } = await firestoreHandle();
  const metaRef = fs.doc(fdb, ...META_PATH(uid));
  if (cloud.meta.raw.syncFormat !== SYNC3_FORMAT) {
    await fs.runTransaction(fdb, async t => {
      const m = await t.get(metaRef);
      if (!m.exists() || m.data().status !== 'complete' || m.data().uploadId !== cloud.uploadId) throw Object.assign(new Error('クラウドの印が変わりました。もう一度確認してください'), { code: 'cloud-changed' });
      if (m.data().syncFormat === SYNC3_FORMAT) return;
      t.set(metaRef, { syncFormat: SYNC3_FORMAT, changeSeq: m.data().changeSeq || 0, syncStartedAt: fs.serverTimestamp(), syncStartedBy: deviceLabel }, { merge: true });
    });
  }
  // 基準なしの端末では、クラウドと同じ内容の記録を基準に入れる（同じものは「同期済み」）
  const exp = await db.exportAll();
  const local = await localMap(exp);
  const cmap = cloudMap(cloud);
  const preexisting = {};
  for (const [k, L] of local) {
    const C = cmap.get(k);
    if (fresh && C && C.hash === L.hash) base[k] = L.hash;   // 同じ内容は同期済み
    if (!C && !base[k]) preexisting[k] = L.hash;             // 同期を始める前からこの端末だけにある記録
  }
  const st = await putAndGet(db, { datasetId: cloud.uploadId, base, fresh, from, preexisting, ignored: {}, startedAt: new Date().toISOString(), deviceLabel, deviceId, cloudBackupId: cloudSnap.id, lastSeenChangeSeq: cloud.meta.raw.changeSeq || 0 });
  return { state: st, from, fresh, cloudBackupId: cloudSnap.id, total: cloud.total };
}
async function putAndGet(db, rec) { await putSync3State(db, rec); return getSync3State(db); }

// 「この端末だけに残す」（基準のない端末で、送らないと決めた記録）
export async function ignoreLocal(db, items) {
  const st = await getSync3State(db);
  const ignored = { ...(st?.ignored || {}) };
  for (const it of items) ignored[it.key] = it.hash;
  return updateSync3State(db, { ignored });
}

// ---- Sync-3-2：この端末 → クラウド（選んだ記録だけ） ----
/**
 * @param {object} p { items: computeDiff の push（選んだもの）, check: checkSync3 の結果, deviceLabel, deviceId, onProgress }
 */
export async function pushChanges({ db: localDb, items, check, deviceLabel, deviceId, onProgress = () => {} }) {
  const uid = uidOrThrow();
  if (!items.length) return { pushed: 0 };
  const { fs, db } = await firestoreHandle();
  const metaRef = fs.doc(db, ...META_PATH(uid));
  const datasetId = check.cloud.uploadId;
  // 送った後のクラウド全体（指紋・件数の計算用）
  const working = new Map(check.cmap);
  let seq = check.changeSeq, pushed = 0;
  for (let i = 0; i < items.length; i += PUSH_CHUNK) {
    const part = items.slice(i, i + PUSH_CHUNK);
    for (const it of part) working.set(it.key, { store: it.store, id: it.id, rec: it.rec, hash: it.hash });
    const counts = Object.fromEntries(SYNC_TARGET_STORES.map(s => [s, 0]));
    for (const [, x] of working) counts[x.store] = (counts[x.store] || 0) + 1;
    // ゴミ箱は同期しないが、登録時の記録はクラウドに残っているので件数に含める
    counts.trash = (check.cloud.records.trash || []).length;
    const allTargets = [...[...working.values()].map(x => [x.store, x.rec]), ...(check.cloud.records.trash || []).map(x => ['trash', x.rec])];
    const fp = await fingerprint(allTargets);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await fs.runTransaction(db, async t => {
      // 読む（すべての書き込みの前）：印の変更番号と、送る記録のクラウド側の今の指紋
      const m = await t.get(metaRef);
      if (!m.exists() || m.data().status !== 'complete' || m.data().uploadId !== datasetId) throw Object.assign(new Error('クラウドの印が変わりました'), { code: 'cloud-changed' });
      if ((m.data().changeSeq || 0) !== seq) throw Object.assign(new Error('ほかの端末がクラウドを更新しました'), { code: 'cloud-changed' });
      const refs = part.map(it => fs.doc(db, 'users', uid, it.store, encodeId(it.id)));
      const snaps = [];
      for (const r of refs) snaps.push(await t.get(r));
      part.forEach((it, j) => {
        const cur = snaps[j].exists() ? snaps[j].data() : null;
        const curHash = cur && cur.uploadId === datasetId ? cur.hash : null;
        if (curHash !== (it.cloudHash || null)) throw Object.assign(new Error(`「${recordLabel(it.store, it.rec)}」はほかの端末で更新されています`), { code: 'cloud-changed', key: it.key });
      });
      // 書く
      part.forEach((it, j) => {
        const json = JSON.stringify(it.rec);
        const big = bytesOf(json) > CHUNK_OVER;
        const prev = snaps[j].exists() ? snaps[j].data() : null;
        const head = { id: it.id, store: it.store, hash: it.hash, bytes: bytesOf(json), uploadId: datasetId, rev: it.rec.rev ?? null, updatedAt: it.rec.updatedAt ?? null, projectId: it.rec.projectId ?? null,
          deviceId, deviceLabel, updatedBy: it.rec.updatedBy || '', cloudRev: (prev?.cloudRev || 0) + 1, pushedAt: fs.serverTimestamp() };
        if (big) {
          const parts = splitChunks(json);
          t.set(refs[j], { ...head, json: null, parts: parts.length });
          parts.forEach((p, k) => t.set(fs.doc(db, 'users', uid, 'chunks', `${it.store}~${encodeId(it.id)}~${k}`), { store: it.store, docId: encodeId(it.id), id: it.id, index: k, json: p, uploadId: datasetId }));
        } else t.set(refs[j], { ...head, json, parts: 0 });
      });
      t.set(metaRef, { counts, total, fingerprint: fp, changeSeq: seq + 1, lastUpdatedAt: fs.serverTimestamp(), lastUpdatedBy: deviceLabel, lastUpdatedDeviceId: deviceId }, { merge: true });
    });
    seq += 1; pushed += part.length;
    onProgress('push', pushed, items.length);
  }
  // 照合：送った記録を読み直す（指紋）・印の指紋
  onProgress('verify', 0, items.length);
  const after = await readCloudData();
  if (!after.ok) throw Object.assign(new Error('送った後の照合で、クラウドの内容に問題が見つかりました'), { code: 'verify-failed', problems: after.problems });
  const amap = cloudMap(after);
  const bad = items.filter(it => amap.get(it.key)?.hash !== it.hash);
  if (bad.length) throw Object.assign(new Error(`送った後の照合で一致しない記録が ${bad.length} 件ありました`), { code: 'verify-failed' });
  // 基準を更新（送った記録だけ）
  const st = await getSync3State(localDb);
  const base = { ...(st?.base || {}) };
  for (const it of items) base[it.key] = it.hash;
  await updateSync3State(localDb, { base, lastPushAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), lastSeenChangeSeq: seq });
  onProgress('done', items.length, items.length);
  return { pushed, changeSeq: seq };
}

// ---- Sync-3-3：クラウド → この端末（選んだ記録だけ） ----
/**
 * @param {object} p { db, items: computeDiff の pull（＋競合で「クラウド版を採用」したもの）, check, deviceLabel, onProgress }
 */
export async function pullChanges({ db, items, check, onProgress = () => {}, deviceLabel = '' }) {
  uidOrThrow();
  if (!items.length) return { applied: 0 };
  // 確認画面のあとにクラウドが変わっていないか
  onProgress('read');
  const fresh = await readCloudData();
  if (!fresh.ok) throw Object.assign(new Error('クラウドの内容に問題があります。受け取りは行いません'), { code: 'cloud-problem', problems: fresh.problems });
  const fmap = cloudMap(fresh);
  for (const it of items) if (fmap.get(it.key)?.hash !== it.hash) throw Object.assign(new Error('確認のあとにクラウドの内容が変わりました。「クラウドの最新を確認」からやり直してください'), { code: 'cloud-changed' });
  // この端末で、確認のあとに同じ記録が変わっていないか
  const exp = await db.exportAll();
  const local = await localMap(exp);
  for (const it of items) {
    const before = check.local.get(it.key)?.hash || null, now = local.get(it.key)?.hash || null;
    if (before !== now) throw Object.assign(new Error('確認のあとに、この端末で同じ記録が変わりました。「クラウドの最新を確認」からやり直してください'), { code: 'local-changed' });
  }
  // 端末内の控え（自動。ファイルの保存は不要）
  onProgress('backup');
  const snap = await saveSnapshot(exp, { deviceKind: `${deviceLabel}（受け取り前）` });
  if (!snap.ok) throw Object.assign(new Error('受け取り前の控えを保存できませんでした。受け取りは行いません'), { code: 'no-backup' });
  // 書き込み（全部成功するか、何も変わらないか）
  onProgress('write');
  await db.applySyncedRecords(items.map(it => ({ store: it.store, rec: it.rec })));
  // 照合。一致しなければ控えへ戻す
  onProgress('verify');
  const after = await localMap(await db.exportAll());
  const bad = items.filter(it => after.get(it.key)?.hash !== it.hash);
  if (bad.length) {
    await db.importAll(JSON.parse((await getSnapshot(snap.id)).json), { reason: '受け取りの照合が一致しなかったため、受け取り前の控えへ戻しました' });
    throw Object.assign(new Error(`受け取った後の照合で一致しない記録が ${bad.length} 件ありました。受け取り前に戻しました`), { code: 'verify-failed' });
  }
  const st = await getSync3State(db);
  const base = { ...(st?.base || {}) };
  for (const it of items) base[it.key] = it.hash;
  await updateSync3State(db, { base, lastPullAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), lastSeenChangeSeq: fresh.meta.raw.changeSeq || 0 });
  onProgress('done');
  return { applied: items.length, snapshotId: snap.id };
}

// ---- Sync-3-4：競合の解決 ----
// choice: 'local'（この端末版を採用）| 'cloud'（クラウド版を採用）| 'merge'（項目ごとに選んで統合）| 'keepDeleted'（この端末の削除を保つ）
export function mergeRecord(conflict, picks, { actor, deviceId }) {
  const L = conflict.local?.rec || {}, C = conflict.cloud?.rec || {};
  const out = { ...C };
  for (const d of fieldDiff(L, C)) out[d.field] = picks[d.field] === 'local' ? L[d.field] : C[d.field];
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  out.rev = Math.max(L.rev || 0, C.rev || 0) + 1;
  out.updatedAt = new Date().toISOString();
  out.updatedBy = actor;
  out.deviceId = deviceId;
  return out;
}

export async function resolveConflict({ db, conflict, choice, picks = {}, check, deviceLabel, deviceId, actor }) {
  if (choice === 'cloud') return pullChanges({ db, items: [{ key: conflict.key, store: conflict.store, id: conflict.id, rec: conflict.cloud.rec, hash: conflict.cloud.hash }], check, deviceLabel });
  if (choice === 'keepDeleted') {
    // この端末の削除を保つ：クラウドは変えない。基準をクラウドの今の指紋にして、受け取り待ちに出さない
    const st = await getSync3State(db);
    return updateSync3State(db, { base: { ...(st?.base || {}), [conflict.key]: conflict.cloud.hash } });
  }
  let rec;
  if (choice === 'local') rec = conflict.local.rec;
  else if (choice === 'merge') {
    rec = mergeRecord(conflict, picks, { actor, deviceId });
    // 統合した記録を、まずこの端末に保存（控えを作ってから）
    const exp = await db.exportAll();
    const snap = await saveSnapshot(exp, { deviceKind: `${deviceLabel}（統合前）` });
    if (!snap.ok) throw Object.assign(new Error('統合前の控えを保存できませんでした'), { code: 'no-backup' });
    await db.applySyncedRecords([{ store: conflict.store, rec }]);
  } else throw new Error('選び方が正しくありません');
  const hash = await sha256(JSON.stringify(rec));
  // クラウドへ送る（クラウド側が確認したときのままであることを確かめてから）
  return pushChanges({ db, items: [{ key: conflict.key, store: conflict.store, id: conflict.id, kind: 'update', rec, hash, cloudHash: conflict.cloud.hash }], check, deviceLabel, deviceId });
}

export function sync3ErrorMessage(e) {
  const keep = '（この端末のデータは変わっていないか、受け取り前の控えへ戻してあります。クラウドのデータは削除していません）';
  switch (e?.code) {
    case 'cloud-changed': return { title: 'ほかの端末の新しい変更があります', how: `${e.message}。上書きはしていません。「クラウドの最新を確認」を押して、受け取り待ち・競合を確認してから、もう一度送ってください。${keep}` };
    case 'local-changed': return { title: 'この端末のデータが変わりました', how: `${e.message}${keep}` };
    case 'cloud-problem': return { title: 'クラウドの内容に問題があります', how: `${e.message}。この画面をClaudeに送ってください。${keep}` };
    case 'verify-failed': return { title: '照合が一致しませんでした', how: `${e.message}。もう一度「クラウドの最新を確認」からやり直してください。${keep}` };
    case 'no-backup': return { title: '控えを作れませんでした', how: `${e.message}${keep}` };
    case 'not-registered': return { title: 'クラウドがまだ登録されていません', how: `${e.message}` };
    case 'unavailable': return { title: 'クラウドに接続できませんでした', how: `インターネット接続を確認して、もう一度押してください。${keep}` };
    case 'permission-denied': return { title: 'クラウドを使う許可がありません', how: `Firebaseの owners に、このアカウントのユーザーIDが登録されているか確認してください。${keep}` };
    case 'unauthenticated': return { title: 'ログインしていません', how: `「Googleでログイン」を押してください。${keep}` };
    default: return { title: '同期できませんでした', how: `${e?.message || e}${keep}` };
  }
}
