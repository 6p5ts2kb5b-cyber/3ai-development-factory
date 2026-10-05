// Phase Sync-1 画面操作テスト（Googleログインだけ。Factoryのデータは送受信しない）
// 本物のFirebaseの代わりに、同じ形の「にせFirebase」を gstatic のURLで返して確認する（Googleには接続しない）
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
export const signInWithPopup = async () => {
  await new Promise(r => setTimeout(r, 150));
  const fail = localStorage.getItem('fakeFirebaseFail'); if (fail) { const e = new Error(fail); e.code = fail; throw e; }
  if (localStorage.getItem('fakeFirebaseHang')) await new Promise(() => {}); // 結果が戻らない（iPhoneホーム画面版で起きる状況）
  const u = { uid: 'uid-surface-0001', displayName: 'テスト先生', email: 'teacher@example.com', providerData: [{ providerId: 'google.com' }] }; set(u); return { user: u };
};
export const signOut = async () => set(null);`;
const CFG = JSON.stringify({ config: { apiKey: 'AIza-test', authDomain: 'factory-test.firebaseapp.com', projectId: 'factory-test', appId: '1:1:web:1' } });

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }); // にせFirebaseを差し込むため、オフライン用の仕組み（Service Worker）だけ止める
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { const u = new URL(r.url()); if (u.hostname !== 'localhost') external.push(u.hostname + u.pathname); });
  const L = s => `[${label}] ${s}`;
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const snapshot = () => page.evaluate(async () => {
    const { FactoryDB } = await import('./js/db.js');
    const db = await FactoryDB.open('factory'); const j = await db.exportAll(); db.close();
    return JSON.stringify(j.data);
  });
  let sdkRouted = false;
  const routeSdk = async () => {
    if (sdkRouted) return; sdkRouted = true;
    const js = body => ({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body });
    await ctx.route(SDK + 'firebase-app.js', r => r.fulfill(js(FAKE_APP)));
    await ctx.route(SDK + 'firebase-auth.js', r => r.fulfill(js(FAKE_AUTH)));
  };

  // 1. 学校Surfaceと同じ状態（Factory＋7件）を作る
  await page.goto(BASE); await page.waitForSelector('.hero');
  await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(300);
  const before = await snapshot();
  check(L('準備：8プロジェクトが登録された状態'), (await page.locator('.pcard').count()) === 8);
  check(L('起動時にFirebaseを読み込まない（Googleへ接続しない）'), external.length === 0, external.join(','));

  // 2. Firebase未設定の場合（設定ファイルが空のとき）
  await ctx.route('**/config/firebase.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ config: null }) }));
  await page.goto(BASE + '#/settings'); await page.waitForSelector('a[href="#/account"]');
  check(L('設定画面に「Googleログイン・同期」'), await waitText(page, '#view', 'Googleログイン・同期', 'データの同期はまだ行いません'));
  await page.click('a[href="#/account"]');
  check(L('未設定なら「Firebaseの設定待ち」と表示（読み込みもしない）'), await waitText(page, '#acc-card', 'Firebaseの設定待ち') && external.length === 0);
  check(L('「データは送受信しない」と明示'), await waitText(page, '#acc-note', 'クラウドへ送ったり、受け取ったりしません'));

  // 3. 配布する設定ファイル（本物の接続情報）を確認
  const real = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../../config/firebase.json'), 'utf8')).config;
  check(L('配布する設定：Factory用Firebase（factory-5b335）・メールアドレスなし'), real && real.projectId === 'factory-5b335' && real.authDomain === 'factory-5b335.firebaseapp.com' && !/@/.test(JSON.stringify(real)));
  // 4. Firebase設定後（にせFirebase）→ ログイン
  await ctx.route('**/config/firebase.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: CFG }));
  await routeSdk();
  await page.reload(); await page.waitForSelector('#acc-in');
  check(L('未ログインで「Googleでログイン」ボタン'), await waitText(page, '#acc-card', '未ログイン', 'この端末：'));
  await page.click('#acc-in');
  check(L('ログインすると名前・アカウント・ユーザーIDを表示'), await waitText(page, '#acc-card', 'ログインできています', 'テスト先生', 'teacher@example.com', 'uid-surface-0001'));
  await page.click('#acc-copy-uid');
  check(L('ユーザーIDをコピーできる'), (await page.evaluate(() => navigator.clipboard.readText())) === 'uid-surface-0001');
  await ov('signed-in'); await page.screenshot({ path: `${OUT}/s1-${label}-signedin.png`, fullPage: true });

  // 4. 再読み込みしてもログインが続く
  await page.reload();
  check(L('再読み込み後もログイン中'), await waitText(page, '#acc-card', 'ログインできています', 'テスト先生'));

  // 5. Factoryのデータは1件も変わらない・Firestoreへ接続しない
  check(L('ログインしてもFactoryのデータ（8プロジェクト等）は1件も変わらない'), (await snapshot()) === before);
  check(L('Firestore・Googleの他のサーバーへ接続しない'), external.every(h => h.startsWith('www.gstatic.com/firebasejs/12.8.0/firebase-')), [...new Set(external)].join(','));

  // 6. ログアウト
  await page.click('#acc-out');
  check(L('ログアウトで未ログインに戻る'), await waitText(page, '#acc-card', '未ログイン'));
  check(L('ログアウトしてもFactoryのデータは変わらない'), (await snapshot()) === before);
  await page.goto(BASE); await page.waitForSelector('.pcard'); await page.waitForTimeout(200);
  check(L('ホームの8プロジェクトはそのまま'), (await page.locator('.pcard').count()) === 8);

  // 7. エラー表示（日本語＋次にすること）
  await page.evaluate(() => localStorage.setItem('fakeFirebaseFail', 'auth/popup-blocked'));
  await page.goto(BASE + '#/account'); await page.waitForSelector('#acc-in');
  await page.click('#acc-in');
  check(L('ポップアップが止められたら日本語で理由と対処を表示'), await waitText(page, '#acc-card', 'ログイン画面がブロックされました', 'もう一度') && await page.isEnabled('#acc-in'));
  await page.evaluate(() => localStorage.setItem('fakeFirebaseFail', 'auth/unauthorized-domain'));
  await page.click('#acc-in');
  check(L('承認済みドメイン未設定のエラーを日本語で表示'), await waitText(page, '#acc-card', 'このURLからのログインが許可されていません', '承認済みドメイン'));
  await page.evaluate(() => localStorage.removeItem('fakeFirebaseFail'));
  await ov('error');

  // 8. オフライン
  await ctx.setOffline(true);
  await page.evaluate(() => { location.hash = '#/settings'; }); await page.waitForSelector('a[href="#/account"]');
  await page.evaluate(() => { location.hash = '#/account'; }); await page.waitForSelector('#acc-in');
  check(L('オフラインでは「接続するとログインできます」'), await waitText(page, '#acc-card', 'インターネットに接続していません'));
  await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.pcard');
  check(L('オフラインでもFactoryは今までどおり使える'), (await page.locator('.pcard').count()) === 8);
  await ctx.setOffline(false);
  check(L('最後までFactoryのデータは変わらない'), (await snapshot()) === before);

  // 9. iPhoneホーム画面版（ポップアップの結果が戻らない場合）
  if (label.startsWith('iphone')) {
    const hp = await ctx.newPage();
    await hp.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); window.__FACTORY_TEST_WATCHDOG_MS = 800; localStorage.setItem('fakeFirebaseHang', '1'); });
    hp.on('pageerror', e => errors.push(e.message));
    await hp.goto(BASE + '#/account'); await hp.waitForSelector('#acc-in');
    check(L('ホーム画面版：端末の種類とiPhone向けの説明'), await waitText(hp, '#acc-card', 'iPhone（ホーム画面版）', 'Googleの画面が別に開きます', 'Safariで'));
    await hp.click('#acc-in');
    check(L('ホーム画面版：待っている間は「アカウントを選んでください」'), await waitText(hp, '#acc-card', 'アカウントを選んでください'));
    check(L('ホーム画面版：結果が戻らなければ日本語で案内し、もう一度押せる'), await waitText(hp, '#acc-card', 'ホーム画面版ではログインが完了しませんでした', 'Safari', 'missing initial state') && await hp.isEnabled('#acc-in'));
    await hp.evaluate(() => localStorage.removeItem('fakeFirebaseHang'));
    await hp.click('#acc-in');
    check(L('ホーム画面版：もう一度押してログインできる'), await waitText(hp, '#acc-card', 'ログインできています'));
    await hp.click('#acc-out'); await waitText(hp, '#acc-card', '未ログイン');
    await ov('home-screen'); await hp.screenshot({ path: `${OUT}/s1-${label}-homescreen.png`, fullPage: true });
    await hp.close();
    check(L('ホーム画面版の操作後もFactoryのデータは変わらない'), (await snapshot()) === before);
    // iPhone Safari：ポップアップブロックの案内
    await page.evaluate(() => localStorage.setItem('fakeFirebaseFail', 'auth/popup-blocked'));
    await page.goto(BASE + '#/settings'); await page.goto(BASE + '#/account'); await page.reload(); await page.waitForSelector('#acc-in');
    await page.click('#acc-in');
    check(L('iPhone：ポップアップブロック時は設定の場所まで案内'), await waitText(page, '#acc-card', 'ログイン画面がブロックされました', 'ポップアップブロック', 'オフ'));
    await page.evaluate(() => localStorage.removeItem('fakeFirebaseFail'));
  }
  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/sync1-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-1): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
