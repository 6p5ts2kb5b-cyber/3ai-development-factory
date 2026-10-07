// Phase Sync-4a：半自動のお知らせ（読むだけ。自動で送らない・受け取らない）
//
// 「受け取り待ちがあります」の判定
//   ・クラウドの記録の本文は読まない。読むのは「登録済みの印」（users/{uid}/meta/factory）の1件だけ
//   ・印の変更番号（changeSeq）と、この端末が前回そろえたときの状態（端末内の同期の記録 sync3.notice）を比べる
//       印の変更番号 ＞ この端末が最後に確認した変更番号 → ほかの端末がクラウドを更新した（受け取り待ちあり）
//       前回の確認で受け取り待ち・競合が残っていた                → まだ残っている
//       印のデータセットID が この端末の同期の記録と違う             → クラウドのデータが入れ替わった（同期画面で確認）
// 「未送信○件」の判定
//   ・この端末の中だけで計算する（クラウドには接続しない）。前回そろえたときの指紋（基準）と今の記録の指紋を比べる
// 安全
//   ・このファイルはFirestoreへ書き込まない（setDoc・runTransaction・writeBatch・削除を使わない）。Factoryのデータも変えない
//   ・クラウドを読むのは、同期を始めた端末で・お知らせがオンで・オンラインで・ログイン中のときだけ。同じ画面に戻っただけなら10分に1回まで
import { getSync3State, localMap } from './sync3.js';
import { initAuth, currentUid } from './auth.js';
import { firestoreHandle, META_PATH, cloudErrorMessage } from './cloud.js';
import { SYNC_DB } from './register.js';

export const NOTICE_GAP_MS = 10 * 60 * 1000;
const PREF_ID = 'notice-pref';

function openSyncDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SYNC_DB, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' }); if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const q = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export async function getNoticePref() { const d = await openSyncDB(); try { const r = await q(d.transaction('state').objectStore('state').get(PREF_ID)); return { enabled: r ? r.enabled !== false : true }; } finally { d.close(); } }
export async function setNoticePref(enabled) { const d = await openSyncDB(); try { await q(d.transaction('state', 'readwrite').objectStore('state').put({ id: PREF_ID, enabled: !!enabled, at: new Date().toISOString() })); } finally { d.close(); } cache.meta = null; cache.at = 0; }

export function knownOf(state) {
  const n = state?.notice;
  if (n && Number.isFinite(n.seq)) return { seq: n.seq, remote: Math.max(0, n.remote || 0) };
  return { seq: state?.lastSeenChangeSeq || 0, remote: 0 };
}
export function decideRemote({ state, meta }) {
  if (!state || !meta) return { remote: 'unknown' };
  if (meta.uploadId && state.datasetId && meta.uploadId !== state.datasetId) return { remote: 'reset' };
  const k = knownOf(state);
  if ((meta.changeSeq || 0) > k.seq) return { remote: 'pending', reason: 'newer' };
  if (k.remote > 0) return { remote: 'pending', reason: 'known' };
  return { remote: 'none' };
}
export function countUnsentFrom(local, state) {
  const base = state?.base || {}, ignored = state?.ignored || {}, pre = state?.preexisting || {};
  let n = 0;
  for (const [key, L] of local) {
    const B = base[key];
    if (B) { if (L.hash !== B) n++; continue; }
    if (ignored[key] === L.hash) continue;
    if (pre[key] === L.hash) continue;
    n++;
  }
  return n;
}
export async function countUnsent(db, state) {
  const st = state === undefined ? await getSync3State(db) : state;
  if (!st) return 0;
  return countUnsentFrom(await localMap(await db.exportAll()), st);
}

export async function readNoticeMeta() {
  const uid = currentUid();
  if (!uid) throw Object.assign(new Error('not signed in'), { code: 'unauthenticated' });
  const { fs, db } = await firestoreHandle();
  const snap = await fs.getDocFromServer(fs.doc(db, ...META_PATH(uid)));
  if (!snap.exists()) return null;
  const d = snap.data() || {};
  const at = v => (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : (typeof v === 'string' ? v : null);
  return { changeSeq: Number.isFinite(d.changeSeq) ? d.changeSeq : 0, uploadId: d.uploadId || null, status: d.status || null, lastUpdatedBy: typeof d.lastUpdatedBy === 'string' ? d.lastUpdatedBy : '', lastUpdatedAt: at(d.lastUpdatedAt) };
}

const cache = { meta: null, at: 0, error: null, inflight: null };
export function _resetNoticeCache() { cache.meta = null; cache.at = 0; cache.error = null; cache.inflight = null; }

export async function getNotice(db, { force = false, online = (typeof navigator === 'undefined' ? true : navigator.onLine), remote = true } = {}) {
  const state = await getSync3State(db);
  if (!state || !state.datasetId) return { active: false };
  const { enabled } = await getNoticePref();
  if (!enabled) return { active: true, enabled: false };
  const unsent = countUnsentFrom(await localMap(await db.exportAll()), state);
  const out = { active: true, enabled: true, unsent };
  if (!online) return { ...out, remote: 'offline' };
  const fresh = cache.meta && Date.now() - cache.at < NOTICE_GAP_MS;
  if (remote && (force || !fresh)) {
    cache.inflight = cache.inflight || (async () => {
      try {
        await initAuth();
        if (!currentUid()) { cache.error = { code: 'unauthenticated' }; return; }
        cache.meta = await readNoticeMeta(); cache.at = Date.now(); cache.error = null;
      } catch (e) { cache.error = cloudErrorMessage(e); }
    })().finally(() => { cache.inflight = null; });
    await cache.inflight;
  }
  if (cache.error?.code === 'unauthenticated') return { ...out, remote: 'signedOut' };
  if (cache.error && !cache.meta) return { ...out, remote: 'error', error: cache.error };
  if (!cache.meta) return { ...out, remote: 'unknown' };
  const d = decideRemote({ state, meta: cache.meta });
  return { ...out, ...d, meta: cache.meta, checkedAt: new Date(cache.at).toISOString() };
}
