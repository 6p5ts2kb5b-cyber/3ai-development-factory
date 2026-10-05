// Phase Sync-1：Googleログインだけ（Firebase Authentication）
// ・この段階では Factory のデータ（IndexedDB「factory」）を一切読まない・書かない・送らない。
//   このファイルは db.js を import しない（自動テストで確認）。
// ・Firebase は、ログイン画面を開いたときだけ公式配布元（gstatic）から読み込む。起動時には読み込まないので、
//   Firebase が使えなくても・オフラインでも Factory の動作は今までと同じ。
// ・ログイン状態は Firebase 自身が別のデータベース（firebaseLocalStorageDb）に保存する。
// ・Firestore（クラウドのデータベース）はまだ読み込まない。
export const FIREBASE_SDK_VERSION = '12.19.0';
export const SDK_URLS = {
  app: `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`,
  auth: `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`,
};
const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId'];

const defaultLoader = async () => ({ app: await import(SDK_URLS.app), auth: await import(SDK_URLS.auth) });
let loader = defaultLoader;
// 自動テスト用：Firebase の代わりを差し込む／元に戻す
export function _setLoader(fn) { loader = fn || defaultLoader; reset(); }

// config/firebase.json の確認（公開されても問題ない接続情報。メールアドレス等の個人情報は入れない）
export function checkFirebaseConfig(c) {
  if (!c || typeof c !== 'object') return { ok: false, reason: 'Firebaseの設定がまだです' };
  const missing = REQUIRED.filter(k => typeof c[k] !== 'string' || !c[k].trim());
  if (missing.length) return { ok: false, reason: `Firebaseの設定が足りません（${missing.join('・')}）` };
  if (/@/.test(JSON.stringify(c))) return { ok: false, reason: 'Firebaseの設定にメールアドレスが入っています（入れないでください）' };
  return { ok: true };
}

export async function loadFirebaseConfig(url = new URL('../../config/firebase.json', import.meta.url)) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.config || null;
  } catch { return null; }
}

// 画面に出すエラー文（何が起きたか＋どうすればいいか）
const MESSAGES = {
  'auth/popup-blocked': ['ログイン画面がブロックされました', 'ブラウザがポップアップを止めています。もう一度「Googleでログイン」を押してください。続く場合は、ブラウザの設定でこのサイトのポップアップを許可してください。'],
  'auth/popup-closed-by-user': ['ログインが完了する前に画面が閉じられました', 'もう一度「Googleでログイン」を押し、アカウントを選んでください。'],
  'auth/cancelled-popup-request': ['ログイン画面が重なって開かれました', '少し待ってから、もう一度押してください。'],
  'auth/unauthorized-domain': ['このURLからのログインが許可されていません', 'Firebaseの「承認済みドメイン」に、このサイトのドメインを追加する必要があります（Claudeが案内します）。'],
  'auth/network-request-failed': ['インターネットに接続できませんでした', '電波・Wi-Fiを確認して、もう一度押してください。学校のネットワークで止められている可能性もあります。'],
  'auth/operation-not-supported-in-this-environment': ['この画面ではログインできませんでした', 'この端末の種類と画面をClaudeに伝えてください（iPhoneホーム画面版の場合は別の方式に切り替えます）。'],
  'auth/web-storage-unsupported': ['このブラウザの設定ではログインできません', 'プライベートブラウズを終了するか、Cookieとサイトデータを許可してください。'],
  'auth/operation-not-allowed': ['Googleログインが有効になっていません', 'Firebaseの「Authentication」でGoogleを有効にする必要があります（Claudeが案内します）。'],
  'auth/invalid-api-key': ['Firebaseの設定（apiKey）が正しくありません', 'Claudeに伝えてください。'],
  'auth/too-many-requests': ['短時間に何度もログインが試されました', 'しばらく待ってから、もう一度押してください。'],
  'auth/user-disabled': ['このアカウントは無効にされています', 'Firebaseの「Authentication」の「ユーザー」で状態を確認してください。'],
  'sdk-load-failed': ['ログインの部品（Firebase）を読み込めませんでした', 'インターネット接続を確認してください。学校のネットワークで www.gstatic.com が止められている可能性があります。'],
};
export function authErrorMessage(e) {
  const code = e?.code || '';
  const [title, how] = MESSAGES[code] || ['ログインできませんでした', `もう一度お試しください。続く場合は、この表示（${code || e?.message || '不明なエラー'}）をClaudeに伝えてください。`];
  return { code, title, how };
}

// ---- 状態 ----
// status: 'unconfigured'（設定待ち）| 'loading' | 'signedOut' | 'signedIn' | 'error'
let state = { status: 'loading', user: null, error: null };
let fb = null, auth = null, initPromise = null;
const listeners = new Set();
const emit = patch => { state = { ...state, ...patch }; listeners.forEach(f => { try { f(state); } catch {} }); };
function reset() { fb = null; auth = null; initPromise = null; state = { status: 'loading', user: null, error: null }; }
export const authState = () => state;
export function onAuth(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }

const summary = u => u ? { uid: u.uid, name: u.displayName || '', email: u.email || '', provider: (u.providerData?.[0]?.providerId) || 'google.com' } : null;

export function initAuth({ config } = {}) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = config === undefined ? await loadFirebaseConfig() : config;
    const chk = checkFirebaseConfig(cfg);
    if (!chk.ok) { emit({ status: 'unconfigured', user: null, error: null, reason: chk.reason }); return state; }
    try { fb = await loader(); }
    catch (e) { emit({ status: 'error', error: authErrorMessage({ code: 'sdk-load-failed' }) }); initPromise = null; return state; }
    const app = fb.app.getApps().find(a => a.name === 'factory-auth') || fb.app.initializeApp(cfg, 'factory-auth');
    auth = fb.auth.getAuth(app);
    try { auth.languageCode = 'ja'; } catch {}
    await new Promise(resolve => {
      let first = true;
      fb.auth.onAuthStateChanged(auth, u => {
        emit({ status: u ? 'signedIn' : 'signedOut', user: summary(u), error: null });
        if (first) { first = false; resolve(); }
      }, e => { emit({ status: 'error', error: authErrorMessage(e) }); if (first) { first = false; resolve(); } });
    });
    return state;
  })();
  return initPromise;
}

export async function signIn() {
  await initAuth();
  if (!auth) return state;
  try {
    const provider = new fb.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const r = await fb.auth.signInWithPopup(auth, provider);
    emit({ status: 'signedIn', user: summary(r.user), error: null });
  } catch (e) {
    emit({ status: auth.currentUser ? 'signedIn' : 'signedOut', error: authErrorMessage(e) });
  }
  return state;
}

export async function signOut() {
  await initAuth();
  if (!auth) return state;
  try { await fb.auth.signOut(auth); emit({ status: 'signedOut', user: null, error: null }); }
  catch (e) { emit({ error: authErrorMessage(e) }); }
  return state;
}

// この端末の種類（実機確認の記録用）
export function deviceKind() {
  const ua = navigator.userAgent || '';
  const standalone = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return standalone ? 'iPhone（ホーム画面版）' : 'iPhone（Safari）';
  if (/Edg\//.test(ua)) return standalone ? 'PC（Edge・アプリ版）' : 'PC（Edge）';
  if (/Android/.test(ua)) return standalone ? 'Android（ホーム画面版）' : 'Android';
  return standalone ? 'PC（アプリ版）' : 'PC（ブラウザ）';
}
