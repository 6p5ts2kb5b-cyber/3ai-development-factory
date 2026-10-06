// Phase Sync-2-4 画面操作テスト（この端末への取り込み：クラウド → 端末の一方向）
// 本物のFirebaseの代わりに「にせFirebase／にせFirestore」を gstatic のURLで返す（Googleには接続しない）。にせFirestoreの中身は localStorage に保存。
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const SDK = 'https://www.gstatic.com/firebasejs/12.8.0/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 30000 }).then(() => true).catch(() => false);
const SEVEN = ['3AI Development Factory', 'Vintage Hunt', 'STORM／連合チーム予定管理', '野球教材動画＋練習メニュー', '学校 出欠・行事・三者面談管理', '野球部会計', '家族スケジュール・タスク管理', '健康・減量管理'];

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
// にせFirestore（削除の命令は持たない）。fakeFsFailAt＝何回目の送信で接続を切るか
const FAKE_FS = `
const load = () => JSON.parse(localStorage.getItem('fakeFs') || '{}');
const save = m => localStorage.setItem('fakeFs', JSON.stringify(m));
const log = op => { const o = JSON.parse(localStorage.getItem('fakeFsOps') || '[]'); o.push(op); localStorage.setItem('fakeFsOps', JSON.stringify(o.slice(-50))); };
export const getFirestore = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const collection = (db, ...p) => ({ path: p.join('/') });
export const serverTimestamp = () => new Date().toISOString();
export const getDocFromServer = async ref => { const d = load()[ref.path]; return { exists: () => !!d, data: () => d }; };
export const getDocsFromServer = async col => { if (localStorage.getItem('fakeFsReadFail')) { const e = new Error('x'); e.code = 'unavailable'; throw e; } const m = load(); const list = Object.entries(m).filter(([k]) => k.startsWith(col.path + '/') && !k.slice(col.path.length + 1).includes('/')); return { size: list.length, forEach: f => list.forEach(([k, v]) => f({ id: k.split('/').pop(), data: () => v })) }; };
export const setDoc = async (ref, data, opt) => { log('setDoc'); const m = load(); m[ref.path] = opt && opt.merge ? { ...(m[ref.path] || {}), ...data } : data; save(m); };
export const writeBatch = () => { const pend = []; return { set: (r, d) => pend.push([r.path, d]), commit: async () => {
  const n = Number(localStorage.getItem('fakeFsCommits') || 0) + 1; localStorage.setItem('fakeFsCommits', String(n));
  const failAt = Number(localStorage.getItem('fakeFsFailAt') || 0);
  if (failAt && n === failAt) { const e = new Error('x'); e.code = 'unavailable'; throw e; }
  log('batch'); const m = load(); for (const [k, v] of pend) m[k] = v; save(m);
} }; };`;
const CFG = JSON.stringify({ config: { apiKey: 'AIza-test', authDomain: 'factory-test.firebaseapp.com', projectId: 'factory-test', appId: '1:1:web:1' } });


async function newCtx(browser, ctxOpts) {
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block', acceptDownloads: true });
  const js = body => ({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body });
  await ctx.route('**/config/firebase.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: CFG }));
  await ctx.route(SDK + 'firebase-app.js', r => r.fulfill(js(FAKE_APP)));
  await ctx.route(SDK + 'firebase-auth.js', r => r.fulfill(js(FAKE_AUTH)));
  await ctx.route(SDK + 'firebase-firestore.js', r => r.fulfill(js(FAKE_FS)));
  return ctx;
}

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const L = s => `[${label}] ${s}`;
  const errors = [];
  // ---- PC（初回正本）：8プロジェクトを登録してクラウドへ初回登録（部品を直接使って準備する） ----
  const pcCtx = await newCtx(browser, { viewport: { width: 1366, height: 860 } });
  const pc = await pcCtx.newPage();
  pc.on('pageerror', e => errors.push('PC:' + e.message));
  await pc.goto(BASE); await pc.click('#seed-7'); await pc.waitForSelector('text=8件を登録しました'); await pc.waitForTimeout(300);
  const reg = await pc.evaluate(async () => {
    const A = await import('./js/sync/auth.js'); const R = await import('./js/sync/register.js'); const { FactoryDB } = await import('./js/db.js');
    await A.initAuth(); await A.signIn({ env: {}, watchdogMs: 0 });
    const db = await FactoryDB.open('factory'); const exp = await db.exportAll(); db.close();
    const snap = await R.saveSnapshot(exp); const plan = await R.buildPlan(exp);
    const r = await R.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC（Edge）', schemaVersion: exp.schemaVersion });
    return { total: plan.total, state: r.meta.state, fs: localStorage.getItem('fakeFs'), user: localStorage.getItem('fakeFirebaseUser') };
  });
  check(L('準備：PCからクラウドへ初回登録済み'), reg.state === 'registered' && reg.total > 300, `${reg.total}件`);
  // PC自身で取り込みを開くと「クラウドと同じ」
  await pc.goto(BASE + '#/sync-import'); await pc.waitForSelector('#im-check'); await pc.click('#im-check');
  check(L('初回正本の端末では「クラウドと同じ（取り込み不要）」・取り込みボタンを出さない'), await waitText(pc, '#im-local', 'クラウドと同じです') && (await pc.locator('#im-go').count()) === 0);
  await pcCtx.close();

  // ---- iPhone：プロジェクト0件・変更履歴などが少しある端末 ----
  const ctx = await newCtx(browser, ctxOpts);
  await ctx.addInitScript(([fsJson, user]) => { if (!localStorage.getItem('fakeFsSeeded')) { localStorage.setItem('fakeFs', fsJson); localStorage.setItem('fakeFsSeeded', '1'); } }, [reg.fs, reg.user]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const snapshot = () => page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const db = await FactoryDB.open('factory'); const j = await db.exportAll(); db.close(); return JSON.stringify(j.data); });
  const fsNow = () => page.evaluate(() => localStorage.getItem('fakeFs'));
  await page.goto(BASE); await page.waitForSelector('.hero');
  await page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js'); const db = await FactoryDB.open('factory'); await loadMaster(db);
    const t = await db.create('ideas', { text: 'iPhoneで書いたメモ', status: 'new' }); await db.remove('ideas', t.id);
    await db.upsert('settings', 'lastTestRun', { key: 'lastTestRun', value: { total: 61, passed: 61, failed: 0 } }, {}); db.close(); });
  const iphoneBefore = await snapshot();
  const cloudBefore = await fsNow();
  check(L('iPhone：プロジェクト0件・変更履歴あり（空ではない）'), JSON.parse(iphoneBefore).projects.length === 0 && JSON.parse(iphoneBefore).history.length > 0);

  // Googleログイン画面：登録済みなら「この端末へ取り込む」
  await page.goto(BASE + '#/account'); await page.waitForSelector('#acc-in'); await page.click('#acc-in'); await waitText(page, '#acc-card', 'ログインできています');
  check(L('Googleログイン画面：自動でクラウドを確認し「登録済み」と「この端末へ取り込む」'), await waitText(page, '#reg-card', '登録済み', 'PC（Edge）', 'この端末へ取り込む') && (await page.locator('#go-register').count()) === 0);
  await page.click('#go-import'); await page.waitForSelector('#im-check');
  check(L('「切り替えるまで変えない・クラウドは変更しない」と明示'), await waitText(page, '#im-note', 'クラウドのデータに切り替える', 'この端末のデータは変えません', 'クラウドのデータは変更しません', '削除もしません'));
  await page.click('#im-check');
  await waitText(page, '#im-cloud', 'クラウドから取り込む内容');
  check(L('事前チェックがすべて ✅（ログイン・接続・owner・登録済み）'), await page.evaluate(() => [...document.querySelectorAll('#im-step1 .cond li')].every(li => li.classList.contains('ok'))));
  const names = await page.$$eval('#im-names li', a => a.map(x => x.textContent));
  check(L('取り込む内容：8プロジェクトの名前（Phase 7の順）'), JSON.stringify(names) === JSON.stringify(SEVEN), names.join('／'));
  check(L('取り込む内容：件数（仕様書・要望・変更履歴・その他・合計）と全件確認'), await waitText(page, '#im-cloud', 'プロジェクト', '8件', '仕様書', '要望', '変更履歴', 'その他', '合計', `${reg.total}件`, `全${reg.total}件の内容を確認しました`));
  check(L('この端末の今のデータ：空ではない・置き換わると表示'), await waitText(page, '#im-local', 'データがあります', '置き換わります', '自動では置き換えません'));
  check(L('バックアップと切り替えのチェックがそろうまで取り込めない'), await page.isDisabled('#im-go') && await waitText(page, '#im-why', '端末内の控え', 'クラウドのデータに切り替える'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#im-backup-btn')]);
  check(L('取り込み前にこの端末のバックアップファイルを保存'), /^factory-preimport-\d{8}-\d{4}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await waitText(page, '#im-backup', '読み直しを確認しました');
  await page.check('#im-file-ok');
  check(L('「バックアップしました」だけでは取り込めない（切り替えのチェックが必要）'), await page.isDisabled('#im-go'));
  await page.check('#im-switch');
  check(L('チェックがそろうと取り込める'), await page.isEnabled('#im-go'));
  check(L('取り込みボタンを押す前は、この端末のデータは変わらない'), (await snapshot()) === iphoneBefore);
  await ov('ready'); await page.screenshot({ path: `${OUT}/s24-${label}-ready.png`, fullPage: true });

  // 途中で接続が切れる → 端末は変わらず、もう一度で完了
  await page.evaluate(() => localStorage.setItem('fakeFsReadFail', '1'));
  await page.click('#im-go'); await page.click('[data-a="1"]');
  check(L('途中で接続が切れたら日本語で案内（端末は変わらない）'), await waitText(page, '#im-go-card', 'クラウドに接続できませんでした') && (await snapshot()) === iphoneBefore);
  await page.evaluate(() => localStorage.removeItem('fakeFsReadFail'));
  await page.click('#im-go');
  check(L('最後に確認ダイアログ（置き換える件数）'), await waitText(page, '.modal', 'クラウドのデータに切り替えますか', `${reg.total}件`));
  await page.click('[data-a="1"]');
  check(L('取り込み完了（全件照合）'), await waitText(page, '#im-done', '取り込みが完了しました', '一致することを確認しました', `${reg.total}件`));
  await ov('done'); await page.screenshot({ path: `${OUT}/s24-${label}-done.png`, fullPage: true });
  const after = JSON.parse(await snapshot());
  check(L('取り込み後：8プロジェクトがこの端末に'), after.projects.length === 8);
  check(L('端末ごとの記録（自動テスト結果）はそのまま'), after.settings.some(x => x.id === 'lastTestRun' && x.value.total === 61));
  check(L('クラウドのデータは変わらない（書き込み・削除なし）'), (await fsNow()) === cloudBefore);
  const fpOk = await page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const D = await import('./js/sync/dryrun.js'); const db = await FactoryDB.open('factory'); const j = await db.exportAll(); db.close();
    const data = Object.fromEntries(Object.entries(j.data).map(([s, rows]) => [s, rows.filter(x => !(s === 'history' && x.action === 'import'))]));
    const meta = JSON.parse(localStorage.getItem('fakeFs'))['users/uid-owner-0001/meta/factory'];
    return (await D.fingerprint(D.analyzeForSync({ data }).targetsForFingerprint)) === meta.fingerprint; });
  check(L('取り込み後のこの端末のデータの指紋 ＝ クラウドの指紋'), fpOk);
  await page.goto(BASE); await page.waitForSelector('.pcard'); await page.waitForTimeout(200);
  check(L('ホームに8プロジェクト'), (await page.locator('.pcard').count()) === 8);

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/sync24-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-2-4): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
