// Phase Sync-2-1 画面操作テスト（クラウドの状態を確認・読み取りのみ）
// 本物のFirebaseの代わりに、同じ形の「にせFirebase／にせFirestore」を gstatic のURLで返して確認する（Googleには接続しない）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const SDK = 'https://www.gstatic.com/firebasejs/12.8.0/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 15000 }).then(() => true).catch(() => false);

const FAKE_APP = `export const getApps = () => []; export const initializeApp = (c, n) => ({ name: n, options: c });`;
const FAKE_AUTH = `
const KEY = 'fakeFirebaseUser'; const ls = new Set();
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
let cur = read();
const set = u => { cur = u; if (u) localStorage.setItem(KEY, JSON.stringify(u)); else localStorage.removeItem(KEY); ls.forEach(f => f(u)); };
export const getAuth = () => ({ get currentUser() { return cur; } });
export const onAuthStateChanged = (a, f) => { ls.add(f); setTimeout(() => f(cur), 0); return () => ls.delete(f); };
export class GoogleAuthProvider { setCustomParameters(p) { this.p = p; } }
export const signInWithPopup = async () => { const u = { uid: 'uid-owner-0001', displayName: 'テスト先生', email: 'teacher@example.com', providerData: [{ providerId: 'google.com' }] }; set(u); return { user: u }; };
export const signOut = async () => set(null);`;
// にせFirestore：localStorage の fakeCloud で状態を切り替え、使われた命令を fakeCloudOps に記録（書き込み系の命令は「存在しない」ので、呼ばれたらエラーになる）
const FAKE_FS = `
const log = (...a) => { const o = JSON.parse(localStorage.getItem('fakeCloudOps') || '[]'); o.push(a); localStorage.setItem('fakeCloudOps', JSON.stringify(o)); };
export const getFirestore = app => { log('getFirestore'); return { app }; };
export const doc = (db, ...p) => { log('doc', p.join('/')); return { path: p.join('/') }; };
export const getDocFromServer = async ref => {
  log('getDocFromServer', ref.path);
  const m = localStorage.getItem('fakeCloud') || 'empty';
  if (m === 'denied' || m === 'unavailable') { const e = new Error(m); e.code = m === 'denied' ? 'permission-denied' : 'unavailable'; throw e; }
  if (m === 'registered') return { exists: () => true, data: () => ({ status: 'complete', sourceDevice: '学校PC（Edge）', generation: 1, registeredAt: '2026-10-06T01:00:00Z', counts: { projects: 8, specs: 8, requests: 3, history: 120 }, projectNames: ['3AI Development Factory', 'Vintage Hunt'] }) };
  return { exists: () => false, data: () => undefined };
};`;
const CFG = JSON.stringify({ config: { apiKey: 'AIza-test', authDomain: 'factory-test.firebaseapp.com', projectId: 'factory-test', appId: '1:1:web:1' } });

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' }); // にせFirebaseを差し込むため、オフライン用の仕組みだけ止める
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { const u = new URL(r.url()); if (u.hostname !== 'localhost') external.push(u.hostname + u.pathname); });
  const L = s => `[${label}] ${s}`;
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const snapshot = () => page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const db = await FactoryDB.open('factory'); const j = await db.exportAll(); db.close(); return JSON.stringify(j.data); });
  const ops = () => page.evaluate(() => JSON.parse(localStorage.getItem('fakeCloudOps') || '[]'));
  const js = body => ({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body });
  await ctx.route('**/config/firebase.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: CFG }));
  await ctx.route(SDK + 'firebase-app.js', r => r.fulfill(js(FAKE_APP)));
  await ctx.route(SDK + 'firebase-auth.js', r => r.fulfill(js(FAKE_AUTH)));
  await ctx.route(SDK + 'firebase-firestore.js', r => r.fulfill(js(FAKE_FS)));

  // 1. 準備：8プロジェクトがある端末
  await page.goto(BASE); await page.waitForSelector('.hero');
  await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(300);
  const before = await snapshot();
  check(L('起動時はFirebase・Firestoreを読み込まない'), external.length === 0, external.join(','));

  // 2. 未ログインでは確認できない
  await page.goto(BASE + '#/account'); await page.waitForSelector('#acc-in');
  check(L('「クラウドの状態（読み取りのみ）」の説明'), await waitText(page, '#cloud-card', 'クラウドの状態（読み取りのみ）', '1件読むだけ', '送りません・受け取りません', '端末には保存しません'));
  check(L('未ログインでは確認ボタンを押せない'), await page.isDisabled('#cloud-check') && await waitText(page, '#cloud-card', 'ログインすると確認できます'));
  check(L('ログイン前はFirestoreを読み込まない'), !external.some(h => h.includes('firestore')));

  // 3. ログイン → クラウドは空
  await page.click('#acc-in'); await waitText(page, '#acc-card', 'ログインできています');
  // ログイン中に開いた画面では、クラウドの状態を自動で1回確認する（終わると押せるようになる）
  check(L('ログインすると確認ボタンを押せる（自動確認のあと）'), await page.waitForFunction(() => { const b = document.querySelector('#cloud-check'); return b && !b.disabled && !b.dataset.busy; }, null, { timeout: 15000 }).then(() => true).catch(() => false));
  await page.click('#cloud-check');
  check(L('クラウドが空なら「まだ登録されていません」'), await waitText(page, '#cloud-result', '接続できました', 'クラウドは空です', 'まだ1件も登録されていません', '確認日時'));
  await ov('empty'); await page.screenshot({ path: `${OUT}/s21-${label}-empty.png`, fullPage: true });

  // 4. 登録済み（将来の状態）の表示
  await page.evaluate(() => localStorage.setItem('fakeCloud', 'registered'));
  await page.click('#cloud-check');
  check(L('登録済みなら登録元・日時・世代・件数・プロジェクト名'), await waitText(page, '#cloud-result', '登録済み', '学校PC（Edge）', '世代', 'プロジェクト', '8件', '変更履歴', '120件', 'Vintage Hunt'));

  // 5. 許可なし・接続不可
  await page.evaluate(() => localStorage.setItem('fakeCloud', 'denied'));
  await page.click('#cloud-check');
  check(L('許可がなければ日本語で理由と確認先（owners・ユーザーID）'), await waitText(page, '#cloud-result', '許可されていません', 'owners', 'uid-owner-0001'));
  await page.evaluate(() => localStorage.setItem('fakeCloud', 'unavailable'));
  await page.click('#cloud-check');
  check(L('接続できなければ「クラウドに接続できませんでした」'), await waitText(page, '#cloud-result', 'クラウドに接続できませんでした'));
  await ctx.setOffline(true);
  await page.click('#cloud-check');
  check(L('オフラインでは接続せずに案内'), await waitText(page, '#cloud-result', 'オフライン'));
  await ctx.setOffline(false);
  await page.evaluate(() => localStorage.setItem('fakeCloud', 'empty'));
  await ov('states');

  // 6. 読むだけ・自分の印だけ・Factoryのデータは変わらない
  const o = await ops();
  const names = [...new Set(o.map(x => x[0]))].sort().join(',');
  check(L('Firestoreで使った命令は「読む」だけ'), names === 'doc,getDocFromServer,getFirestore', names);
  check(L('読んだのは自分の「登録済みの印」1件だけ'), o.filter(x => x[0] === 'getDocFromServer').every(x => x[1] === 'users/uid-owner-0001/meta/factory'));
  check(L('Googleの配布元以外へ接続しない'), external.every(h => h.startsWith('www.gstatic.com/firebasejs/12.8.0/firebase-')), [...new Set(external)].join(','));
  check(L('確認してもFactoryのデータ（8プロジェクト等）は1件も変わらない'), (await snapshot()) === before);
  await page.goto(BASE); await page.waitForSelector('.pcard'); await page.waitForTimeout(200);
  check(L('ホームの8プロジェクトはそのまま'), (await page.locator('.pcard').count()) === 8);
  await page.goto(BASE + '#/settings'); await page.waitForSelector('#profile-form');
  const appVer = (fs.readFileSync(require('path').join(__dirname, '../../js/app.js'), 'utf8').match(/APP_VERSION = '([^']+)'/) || [])[1];
  check(L(`設定画面に「Sync-」と Factory v${appVer}`), await waitText(page, '#view', 'Googleログイン・同期', 'Sync-', `v${appVer}`));

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/sync21-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-2-1): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
