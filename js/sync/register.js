// Phase Sync-2-3：初回正本登録（この端末のデータをクラウドへ初めて登録する）
// ・Factoryの中で、クラウドへ書き込むのはこのファイルだけ。
// ・削除の命令は使わない（クラウドからの削除は Security Rules でも禁止）。
// ・端末のFactoryデータ（IndexedDB「factory」）は変更しない。このファイルは db.js を import しない。
//   送る内容は、登録直前に作ったバックアップ（端末内の控え）そのもの。
// ・端末内の控えと照合用の記録は、Factoryとは別のデータベース「factory-sync」に保存する。
// ・登録の流れ：クラウドが空か再確認 → 「登録途中」の印 → 少しずつ送信 → 全件を読み直して照合 → 一致したときだけ「登録済み」の印。
//   途中で失敗しても、同じ端末から「もう一度送る」で続けられる（同じ記録は同じ名前で上書きされ、二重にならない）。
import { currentUid } from './auth.js';
import { firestoreHandle, META_PATH, describeMeta, cloudErrorMessage } from './cloud.js';
import { isSyncTarget, analyzeForSync, fingerprint, SYNC_TARGET_STORES } from './dryrun.js';

export const CHUNK_UNITS = 250000;     // 1つの部分の最大文字数（UTF-8で最大約750KB）
export const CHUNK_OVER = 700000;      // これを超える記録（バイト数）は分割して送る
export const BATCH_MAX_OPS = 200;      // 1回にまとめて送る件数の上限
export const BATCH_MAX_BYTES = 4000000; // 1回にまとめて送る大きさの上限（約4MB）
export let SYNC_DB = 'factory-sync'; // 端末内の控え・照合用の記録（Factoryのデータベースとは別）
// 自動テストだけが使う：同期の記録をテスト専用のデータベースへ切り替える（本番の factory-sync に書き込まないため。v0.11.7）
export function _useSyncDBForTest(name) {
  if (!/^factory-test/.test(name)) throw new Error('テスト専用（factory-test…）の名前だけ指定できます');
  SYNC_DB = name;
}

const enc = new TextEncoder();
const bytesOf = s => enc.encode(s).length;

// FirestoreのドキュメントIDに使えない文字や「__〜__」の形を避ける（元のIDは中身に保存）
export function encodeId(id) {
  return 'r-' + String(id).replace(/[^A-Za-z0-9_-]/g, c => '~' + c.codePointAt(0).toString(16) + '~');
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function splitChunks(json, size = CHUNK_UNITS) {
  const parts = [];
  for (let i = 0; i < json.length; i += size) parts.push(json.slice(i, i + size));
  return parts.length ? parts : [''];
}

// 送る内容の一覧を作る（バックアップの中身から。端末のデータには触れない）
export async function buildPlan(exp, { expectedProjects = [] } = {}) {
  const items = [];
  for (const store of Object.keys(exp?.data || {})) {
    for (const r of exp.data[store] || []) {
      if (!isSyncTarget(store, r)) continue;
      const json = JSON.stringify(r);
      const bytes = bytesOf(json);
      const parts = bytes > CHUNK_OVER ? splitChunks(json) : null;
      items.push({ store, id: r.id, docId: encodeId(r.id), json, bytes, hash: await sha256(json), parts, rev: r.rev ?? null, updatedAt: r.updatedAt ?? null, projectId: r.projectId ?? null });
    }
  }
  const counts = {};
  for (const s of SYNC_TARGET_STORES) counts[s] = 0;
  for (const it of items) counts[it.store] = (counts[it.store] || 0) + 1;
  const a = analyzeForSync(exp, { expectedProjects });
  return { items, counts, total: items.length, projectNames: a.projects.names, fingerprint: await fingerprint(a.targetsForFingerprint), chunked: items.filter(i => i.parts).length };
}

// ---- 端末内の控え（Factoryとは別のデータベース） ----
function openSyncDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SYNC_DB, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' }); if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const idbReq = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
async function syncPut(store, rec) { const d = await openSyncDB(); try { await idbReq(d.transaction(store, 'readwrite').objectStore(store).put(rec)); } finally { d.close(); } }
async function syncGet(store, id) { const d = await openSyncDB(); try { return await idbReq(d.transaction(store).objectStore(store).get(id)); } finally { d.close(); } }
export async function listSnapshots() { const d = await openSyncDB(); try { return (await idbReq(d.transaction('snapshots').objectStore('snapshots').getAll())).sort((a, b) => (a.at < b.at ? 1 : -1)); } finally { d.close(); } }
const SNAP_FALLBACK_PREFIX = 'factory-sync-snapshot:';
function fallbackSnapshotGet(id) {
  try { const s = localStorage.getItem(SNAP_FALLBACK_PREFIX + id); return s ? JSON.parse(s) : undefined; } catch { return undefined; }
}
function fallbackSnapshotPut(rec) {
  localStorage.setItem(SNAP_FALLBACK_PREFIX + rec.id, JSON.stringify(rec));
}
export async function getSnapshot(id) {
  try {
    const v = await syncGet('snapshots', id);
    if (v) return v;
  } catch {}
  return fallbackSnapshotGet(id);
}
export const getSyncState = () => syncGet('state', 'register');
const setSyncState = rec => syncPut('state', { id: 'register', ...rec });

// 登録直前のバックアップ（端末内の控え）を保存し、読み直して中身が同じか確かめる
export async function saveSnapshot(exp, { deviceKind = '' } = {}) {
  const json = JSON.stringify(exp);
  const fp = await fingerprint(analyzeForSync(exp).targetsForFingerprint);
  const id = 'presync-' + new Date().toISOString().replace(/[:.]/g, '-');
  const rec = { id, at: new Date().toISOString(), deviceKind, fingerprint: fp, counts: exp.counts || {}, bytes: bytesOf(json), json };
  let storage = 'indexeddb';
  try {
    await syncPut('snapshots', rec);
  } catch {
    storage = 'localstorage';
    fallbackSnapshotPut(rec);
  }
  let back = await getSnapshot(id);
  if (!back || back.json !== json) {
    storage = 'localstorage';
    fallbackSnapshotPut(rec);
    back = await getSnapshot(id);
  }
  const ok = !!back && back.json === json;
  return { ok, id, fingerprint: fp, bytes: rec.bytes, at: rec.at, storage };
}

// バックアップファイル名（英数字だけ）
export function presyncFileName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `factory-presync-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

// ---- クラウド ----
const uidOrThrow = () => { const u = currentUid(); if (!u) throw Object.assign(new Error('not signed in'), { code: 'unauthenticated' }); return u; };

export async function readMeta() {
  const uid = uidOrThrow();
  const { fs, db } = await firestoreHandle();
  const snap = await fs.getDocFromServer(fs.doc(db, ...META_PATH(uid)));
  return snap.exists() ? { raw: snap.data(), ...describeMeta(snap.data()) } : { state: 'empty' };
}

// 登録してよい状態か（クラウド側）
export function cloudAllows(meta, deviceId) {
  if (meta.state === 'empty') return { ok: true, resume: false };
  if (meta.state === 'uploading' && meta.raw?.sourceDeviceId === deviceId) return { ok: true, resume: true, uploadId: meta.raw.uploadId };
  if (meta.state === 'uploading') return { ok: false, reason: '別の端末からの初回登録が途中で止まっています。その端末で「もう一度送る」を押して完了させてください（この端末からは登録できません）' };
  if (meta.state === 'registered') return { ok: false, reason: 'クラウドはすでに登録済みです。初回登録はもう一度はできません（2台目以降は「取り込み」を使います）' };
  return { ok: false, reason: 'クラウドに想定外の印があります。何も変更していません。この画面をClaudeに送ってください' };
}

/**
 * 初回登録の本体
 * @param {object} p { plan, snapshotId, deviceId, deviceLabel, appVersion, schemaVersion, onProgress(phase, done, total) }
 * 端末のデータには触れない。クラウドの削除はしない。
 */
export async function runRegistration({ plan, snapshotId, deviceId, deviceLabel, appVersion = '', schemaVersion = null, onProgress = () => {} }) {
  const uid = uidOrThrow();
  const { fs, db } = await firestoreHandle();
  // 1) 直前にもう一度、クラウドの状態を確かめる
  onProgress('check', 0, plan.total);
  const meta = await readMeta();
  const allow = cloudAllows(meta, deviceId);
  if (!allow.ok) throw Object.assign(new Error(allow.reason), { code: 'not-allowed' });
  // 同じ端末・同じ中身の続きなら同じ登録番号を使う（中身が変わっていれば新しい番号。古い途中の記録は使われない）
  const uploadId = allow.resume && meta.raw?.fingerprint === plan.fingerprint ? allow.uploadId : 'up-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const metaRef = fs.doc(db, ...META_PATH(uid));
  const common = { uploadId, generation: 1, sourceDevice: deviceLabel, sourceDeviceId: deviceId, counts: plan.counts, total: plan.total, projectNames: plan.projectNames, fingerprint: plan.fingerprint, appVersion, schemaVersion, chunked: plan.chunked };
  // 2) 「登録途中」の印（この時点ではほかの端末は取り込まない）
  await fs.setDoc(metaRef, { ...common, status: 'uploading', startedAt: fs.serverTimestamp() });
  await setSyncState({ uploadId, uid, snapshotId, fingerprint: plan.fingerprint, status: 'uploading', at: new Date().toISOString() });
  // 3) 少しずつ送る（同じ記録は同じ名前で上書き＝二重にならない）
  const ops = [];
  for (const it of plan.items) {
    const head = { id: it.id, store: it.store, hash: it.hash, bytes: it.bytes, uploadId, rev: it.rev, updatedAt: it.updatedAt, projectId: it.projectId };
    if (it.parts) {
      ops.push({ ref: fs.doc(db, 'users', uid, it.store, it.docId), data: { ...head, json: null, parts: it.parts.length }, size: 500 });
      it.parts.forEach((part, i) => ops.push({ ref: fs.doc(db, 'users', uid, 'chunks', `${it.store}~${it.docId}~${i}`), data: { store: it.store, docId: it.docId, id: it.id, index: i, json: part, uploadId }, size: bytesOf(part) + 300 }));
    } else ops.push({ ref: fs.doc(db, 'users', uid, it.store, it.docId), data: { ...head, json: it.json, parts: 0 }, size: it.bytes + 300 });
  }
  let done = 0, i = 0;
  while (i < ops.length) {
    const batch = fs.writeBatch(db);
    let n = 0, size = 0;
    while (i < ops.length && n < BATCH_MAX_OPS && (n === 0 || size + ops[i].size <= BATCH_MAX_BYTES)) { batch.set(ops[i].ref, ops[i].data); size += ops[i].size; n++; i++; }
    await batch.commit();
    done += n;
    onProgress('upload', done, ops.length);
  }
  // 4) 全件を読み直して照合
  onProgress('verify', 0, plan.total);
  const result = await verifyCloud({ plan, uploadId });
  if (!result.ok) {
    await setSyncState({ uploadId, uid, snapshotId, fingerprint: plan.fingerprint, status: 'verify-failed', at: new Date().toISOString(), mismatches: result.mismatches.slice(0, 20) });
    throw Object.assign(new Error(`照合で一致しない記録が ${result.mismatches.length} 件ありました。「登録済み」にはしていません`), { code: 'verify-failed', mismatches: result.mismatches });
  }
  // 5) 一致したときだけ「登録済み」の印
  await fs.setDoc(metaRef, { ...common, status: 'complete', verified: result.checked, registeredAt: fs.serverTimestamp() }, { merge: true });
  const after = await readMeta();
  if (after.state !== 'registered') throw Object.assign(new Error('「登録済み」の印を確認できませんでした。もう一度送ってください'), { code: 'meta-not-complete' });
  // 6) 照合用の記録（Sync-3で、どちらで変更されたかを見分けるのに使う）。Factoryとは別のデータベース
  await setSyncState({ uploadId, uid, snapshotId, fingerprint: plan.fingerprint, status: 'complete', at: new Date().toISOString(), hashes: Object.fromEntries(plan.items.map(it => [`${it.store}/${it.id}`, it.hash])) });
  onProgress('done', plan.total, plan.total);
  return { uploadId, checked: result.checked, extras: result.extras, meta: after };
}

// クラウドの中身を読み直して、送った内容と1件ずつ照合する（読むだけ）
export async function verifyCloud({ plan, uploadId }) {
  const uid = uidOrThrow();
  const { fs, db } = await firestoreHandle();
  const mismatches = [];
  let checked = 0, extras = 0;
  const byStore = {};
  for (const it of plan.items) (byStore[it.store] ||= []).push(it);
  let chunkMap = null;
  if (plan.items.some(it => it.parts)) {
    chunkMap = {};
    const cs = await fs.getDocsFromServer(fs.collection(db, 'users', uid, 'chunks'));
    cs.forEach(d => { const x = d.data(); if (x.uploadId !== uploadId) return; (chunkMap[`${x.store}~${x.docId}`] ||= [])[x.index] = x.json; });
  }
  for (const [store, list] of Object.entries(byStore)) {
    const snap = await fs.getDocsFromServer(fs.collection(db, 'users', uid, store));
    const got = {};
    snap.forEach(d => { const x = d.data(); if (x.uploadId === uploadId) got[d.id] = x; else extras++; });
    for (const it of list) {
      const x = got[it.docId];
      if (!x) { mismatches.push({ store, id: it.id, reason: 'クラウドにありません' }); continue; }
      const json = it.parts ? (chunkMap[`${store}~${it.docId}`] || []).slice(0, x.parts || it.parts.length).join('') : x.json;
      if (typeof json !== 'string' || x.hash !== it.hash || (await sha256(json)) !== it.hash) { mismatches.push({ store, id: it.id, reason: '内容が一致しません' }); continue; }
      checked++;
    }
  }
  return { ok: !mismatches.length && checked === plan.total, checked, mismatches, extras };
}

export function registerErrorMessage(e) {
  if (e?.code === 'not-allowed') return { title: '初回登録はできません', how: e.message };
  if (e?.code === 'verify-failed') return { title: '照合が一致しませんでした', how: `${e.message}。もう一度「送る」を押してください。続く場合は、この画面をClaudeに送ってください。この端末のデータは変更していません。` };
  if (e?.code === 'meta-not-complete') return { title: '登録の完了を確認できませんでした', how: e.message };
  const m = cloudErrorMessage(e);
  return { title: m.title, how: `${m.how}（この端末のデータは変更していません。「もう一度送る」で続きから送れます）` };
}
