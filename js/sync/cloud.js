// Phase Sync-2-1：クラウドの状態を確認（読み取りのみ）
// ・読むのは「登録済みの印」 users/{uid}/meta/factory の1件だけ。Firestoreへは一切書き込まない。
//   （このファイルでは setDoc / addDoc / updateDoc / deleteDoc / writeBatch / runTransaction を使わない。自動テストで確認）
// ・Factoryのデータ（IndexedDB「factory」）は読まない・書かない。このファイルは db.js を import しない。
// ・確認結果は画面に出すだけで、端末には保存しない。
// ・Firestore の部品は「クラウドの状態を確認」を押したときだけ、公式配布元から読み込む（起動時は読み込まない）。
import { FIREBASE_SDK_VERSION, firebaseApp, currentUid, initAuth } from './auth.js';

export const FIRESTORE_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`;
export const META_PATH = uid => ['users', uid, 'meta', 'factory'];

const defaultLoader = () => import(FIRESTORE_URL);
let loader = defaultLoader;
export function _setFirestoreLoader(fn) { loader = fn || defaultLoader; fsMod = null; db = null; }
let fsMod = null, db = null;
// Firestore の部品と接続（Sync-2-3 の初回登録 register.js も同じものを使う。このファイル自身は読むだけ）
export async function firestoreHandle() {
  const app = firebaseApp();
  if (!app) throw Object.assign(new Error('not signed in'), { code: 'unauthenticated' });
  try { fsMod = fsMod || await loader(); } catch { throw Object.assign(new Error('sdk'), { code: 'sdk-load-failed' }); }
  db = db || fsMod.getFirestore(app);
  return { fs: fsMod, db };
}

// 状態：'signedOut' | 'empty'（まだ登録されていない）| 'uploading'（登録途中）| 'registered'（登録済み）| 'unknown'（印の形が想定外）| 'denied' | 'offline' | 'error'
const MESSAGES = {
  'permission-denied': ['クラウドを使う許可がありません', 'Firebaseの「Firestore Database」の owners に、このアカウントのユーザーIDが登録されているか、Security Rules が公開されているかを確認してください。'],
  'unavailable': ['クラウドに接続できませんでした', 'インターネット接続を確認して、もう一度押してください。学校のネットワークで止められている可能性もあります。'],
  'not-found': ['クラウドのデータベースが見つかりません', 'Firebaseで Firestore Database が作成されているか確認してください（データベースIDは「(default)」）。'],
  'failed-precondition': ['クラウドのデータベースが使える状態ではありません', 'Firebaseで Firestore Database の作成が終わっているか確認してください。'],
  'unauthenticated': ['ログインが切れています', 'いったんログアウトして、もう一度Googleでログインしてください。'],
  'resource-exhausted': ['今日の無料枠の上限に達した可能性があります', '料金は発生しません。しばらく時間をおいてから確認してください（Factoryはこの端末で今までどおり使えます）。'],
  'sdk-load-failed': ['クラウド用の部品（Firestore）を読み込めませんでした', 'インターネット接続を確認してください。学校のネットワークで www.gstatic.com が止められている可能性があります。'],
};
export function cloudErrorMessage(e) {
  const code = String(e?.code || '').replace(/^firestore\//, '');
  const [title, how] = MESSAGES[code] || ['クラウドの状態を確認できませんでした', `もう一度押してください。続く場合は、この表示（${code || e?.message || '不明なエラー'}）をClaudeに伝えてください。`];
  return { code, title, how };
}

// 「登録済みの印」の中身を画面用に整える（想定外の形でも落ちない）
export function describeMeta(data) {
  if (!data || typeof data !== 'object') return { state: 'unknown' };
  const counts = data.counts && typeof data.counts === 'object' ? Object.fromEntries(Object.entries(data.counts).filter(([, v]) => Number.isFinite(v))) : {};
  const at = v => (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : (typeof v === 'string' ? v : null);
  const base = { sourceDevice: typeof data.sourceDevice === 'string' ? data.sourceDevice : '', generation: Number.isFinite(data.generation) ? data.generation : null, counts, projectNames: Array.isArray(data.projectNames) ? data.projectNames.filter(x => typeof x === 'string') : [] };
  if (data.status === 'complete') return { state: 'registered', registeredAt: at(data.registeredAt), ...base };
  if (data.status === 'uploading') return { state: 'uploading', startedAt: at(data.startedAt), ...base };
  return { state: 'unknown', ...base };
}

// クラウドの状態を確認する（読むのは1件だけ）
export async function checkCloudStatus({ online = (typeof navigator === 'undefined' ? true : navigator.onLine) } = {}) {
  const checkedAt = new Date().toISOString();
  await initAuth();
  const uid = currentUid(), app = firebaseApp();
  if (!uid || !app) return { state: 'signedOut', checkedAt };
  if (!online) return { state: 'offline', checkedAt, error: cloudErrorMessage({ code: 'unavailable' }) };
  try { fsMod = fsMod || await loader(); }
  catch { return { state: 'error', checkedAt, error: cloudErrorMessage({ code: 'sdk-load-failed' }) }; }
  try {
    db = db || fsMod.getFirestore(app);
    // 端末の一時保存（キャッシュ）ではなく、必ずクラウドの最新を読む
    const snap = await fsMod.getDocFromServer(fsMod.doc(db, ...META_PATH(uid)));
    if (!snap.exists()) return { state: 'empty', checkedAt, uid };
    return { ...describeMeta(snap.data()), checkedAt, uid };
  } catch (e) {
    const err = cloudErrorMessage(e);
    return { state: err.code === 'permission-denied' ? 'denied' : err.code === 'unavailable' ? 'offline' : 'error', checkedAt, uid, error: err };
  }
}
