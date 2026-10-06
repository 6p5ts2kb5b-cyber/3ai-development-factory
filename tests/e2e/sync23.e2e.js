// Phase Sync-2-3 画面操作テスト（初回正本登録）
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
export const getDocsFromServer = async col => { const m = load(); const list = Object.entries(m).filter(([k]) => k.startsWith(col.path + '/') && !k.slice(col.path.length + 1).includes('/')); return { size: list.length, forEach: f => list.forEach(([k, v]) => f({ id: k.split('/').pop(), data: () => v })) }; };
export const setDoc = async (ref, data, opt) => { log('setDoc'); const m = load(); m[ref.path] = opt && opt.merge ? { ...(m[ref.path] || {}), ...data } : data; save(m); };
export const writeBatch = () => { const pend = []; return { set: (r, d) => pend.push([r.path, d]), commit: async () => {
  const n = Number(localStorage.getItem('fakeFsCommits') || 0) + 1; localStorage.setItem('fakeFsCommits', String(n));
  const failAt = Number(localStorage.getItem('fakeFsFailAt') || 0);
  if (failAt && n === failAt) { const e = new Error('x'); e.code = 'unavailable'; throw e; }
  log('batch'); const m = load(); for (const [k, v] of pend) m[k] = v; save(m);
} }; };`;
const CFG = JSON.stringify({ config: { apiKey: 'AIza-test', authDomain: 'factory-test.firebaseapp.com', projectId: 'factory-test', appId: '1:1:web:1' } });

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const snapshot = () => page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const db = await FactoryDB.open('factory'); const j = await db.exportAll(); db.close(); return JSON.stringify(j.data); });
  const cloud = () => page.evaluate(() => { const m = JSON.parse(localStorage.getItem('fakeFs') || '{}'); const keys = Object.keys(m); return { total: keys.length, meta: m['users/uid-owner-0001/meta/factory'] || null, data: keys.filter(k => !k.includes('/meta/') && !k.includes('/chunks/')).length, ops: JSON.parse(localStorage.getItem('fakeFsOps') || '[]') }; });
  const js = body => ({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body });
  await ctx.route('**/config/firebase.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: CFG }));
  await ctx.route(SDK + 'firebase-app.js', r => r.fulfill(js(FAKE_APP)));
  await ctx.route(SDK + 'firebase-auth.js', r => r.fulfill(js(FAKE_AUTH)));
  await ctx.route(SDK + 'firebase-firestore.js', r => r.fulfill(js(FAKE_FS)));
  const fullFlow = async (tag) => {
    await page.goto(BASE); await page.reload(); await page.waitForSelector('.hero'); // 画面を作り直してから開く
    await page.goto(BASE + '#/sync-register'); await page.waitForSelector('#rg-check');
    await page.click('#rg-check'); await waitText(page, '#rg-step1', 'クラウドがまだ空である');
    const okAll = await page.evaluate(() => [...document.querySelectorAll('#rg-step1 .cond li')].every(li => li.classList.contains('ok')));
    check(L(`${tag}事前チェックがすべて ✅`), okAll, (await page.innerText('#rg-step1')).replace(/\n/g, ' ').slice(0, 300));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rg-backup')]);
    check(L(`${tag}バックアップファイル（英数字の名前）を保存`), /^factory-presync-\d{8}-\d{4}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    await waitText(page, '#rg-step3', '読み直しを確認しました');
    await page.check('#rg-file-ok'); await page.check('#rg-primary');
  };

  // 1. 8プロジェクトがない端末・未ログイン → 登録ボタンは押せない
  await page.goto(BASE + '#/sync-register'); await page.waitForSelector('#rg-check');
  check(L('「登録ボタンを押すまで書き込まない」と明示'), await waitText(page, '#rg-note', 'クラウドへは何も書き込みません', '変更しません', '削除もしません'));
  await page.click('#rg-check'); await waitText(page, '#rg-step1', 'Phase 7の8プロジェクト');
  const s1 = await page.innerText('#rg-step1');
  check(L('未ログイン・8プロジェクトなしは ⬜ で理由を表示'), s1.includes('「Googleログイン」画面でログインしてください') && s1.includes('見つからないもの'));
  check(L('条件がそろうまで登録ボタンは押せない'), await page.isDisabled('#rg-go') && await waitText(page, '#rg-why', '事前チェックがすべて ✅'));

  // 2. 8プロジェクトの端末でログイン
  await page.goto(BASE); await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(300);
  await page.goto(BASE + '#/account'); await page.waitForSelector('#acc-in'); await page.click('#acc-in'); await waitText(page, '#acc-card', 'ログインできています');
  check(L('Googleログイン画面：クラウドが空なら「初回正本登録」の入口'), await waitText(page, '#reg-card', 'まだ登録されていません') && await page.isVisible('#reg-card a[href="#/sync-register"]'));
  const before = await snapshot();
  await fullFlow('');
  // 登録する内容の表示
  const names = await page.$$eval('#rg-names li', a => a.map(x => x.textContent));
  check(L('送る前に8プロジェクトの名前を表示（Phase 7の順）'), JSON.stringify(names) === JSON.stringify(SEVEN), names.join('／'));
  check(L('送る前に件数（仕様書・要望・変更履歴・その他・合計）を表示'), await waitText(page, '#rg-step2', 'プロジェクト', '8件', '仕様書', '要望', '変更履歴', 'その他', '合計'));
  check(L('チェックがそろうと登録ボタンを押せる'), await page.isEnabled('#rg-go'));
  check(L('登録ボタンを押す前は、クラウドへ何も書き込んでいない'), (await cloud()).total === 0);
  await ov('ready'); await page.screenshot({ path: `${OUT}/s23-${label}-ready.png`, fullPage: true });
  // 3. 登録
  await page.click('#rg-go');
  check(L('最後に確認ダイアログ（初回正本・件数）'), await waitText(page, '.modal', '初回正本', '件'));
  await page.click('[data-a="1"]');
  check(L('初回登録が完了（全件照合）'), await waitText(page, '#rg-done', '初回登録が完了しました', '一致することを確認しました'));
  const c1 = await cloud();
  const plan = await page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const { buildPlan } = await import('./js/sync/register.js'); const db = await FactoryDB.open('factory'); const p = await buildPlan(await db.exportAll()); db.close(); return p.total; });
  check(L('クラウドに全件（端末ごとの設定は除く）・「登録済み」の印'), c1.data === plan && c1.meta?.status === 'complete' && c1.meta?.counts?.projects === 8 && c1.meta?.sourceDevice, `${c1.data}/${plan} ${c1.meta?.status}`);
  check(L('登録してもFactoryのデータは1件も変わらない'), (await snapshot()) === before);
  await ov('done'); await page.screenshot({ path: `${OUT}/s23-${label}-done.png`, fullPage: true });
  // 4. クラウドの状態は「登録済み」・もう一度は登録できない
  await page.goto(BASE + '#/account'); await page.waitForSelector('#cloud-check'); await page.waitForTimeout(300);
  await page.click('#cloud-check');
  check(L('クラウドの状態：登録済み（登録元・8プロジェクト）'), await waitText(page, '#cloud-result', '登録済み', 'Vintage Hunt', '健康・減量管理'));
  await page.goto(BASE + '#/sync-register'); await page.waitForSelector('#rg-check'); await page.click('#rg-check');
  check(L('登録済みのクラウドには、もう一度登録できない（登録ボタンを出さない）'), await waitText(page, '#rg-step1', 'すでに登録済み') && (await page.locator('#rg-go').count()) === 0);
  check(L('登録済みなら「登録済み」と「この端末へ取り込む」を表示'), await waitText(page, '#rg-registered', '登録済み', 'この端末へ取り込む') && await page.isVisible('#rg-registered a[href="#/sync-import"]'));
  await page.goto(BASE + '#/settings'); await page.waitForSelector('#profile-form'); await page.goto(BASE + '#/account'); await page.waitForSelector('#reg-card');
  check(L('Googleログイン画面：登録済みなら再登録ボタンを出さず「この端末へ取り込む」'), await waitText(page, '#reg-card', '登録済み', 'この端末へ取り込む') && (await page.locator('#go-register').count()) === 0);

  // 5. 途中で失敗 → 続きから送って完了（クラウドを空に戻して確認）
  await page.evaluate(() => { localStorage.removeItem('fakeFs'); localStorage.setItem('fakeFsCommits', '0'); localStorage.setItem('fakeFsFailAt', '2'); });
  await fullFlow('途中失敗：');
  await page.click('#rg-go'); await page.click('[data-a="1"]');
  check(L('途中で失敗したら日本語で理由と「続きから送れる」'), await waitText(page, '#rg-step4', 'クラウドに接続できませんでした', '続きから送れます'));
  const c2 = await cloud();
  check(L('失敗したときは「登録途中」のまま（登録済みにしない）'), c2.meta?.status === 'uploading');
  check(L('「もう一度送る（続きから）」ボタン'), await waitText(page, '#rg-go', 'もう一度送る（続きから）'));
  await page.evaluate(() => localStorage.removeItem('fakeFsFailAt'));
  await page.click('#rg-go'); await page.click('[data-a="1"]');
  check(L('続きから送って完了'), await waitText(page, '#rg-done', '初回登録が完了しました'));
  const c3 = await cloud();
  check(L('続きから送っても二重にならない'), c3.data === plan && c3.meta?.status === 'complete' && c3.meta?.uploadId === c2.meta?.uploadId, `${c3.data}/${plan}`);
  check(L('クラウドで削除の操作をしていない'), !c3.ops.some(o => /delete/i.test(o)));
  check(L('最後までFactoryのデータは変わらない'), (await snapshot()) === before);
  await page.goto(BASE); await page.waitForSelector('.pcard'); await page.waitForTimeout(200);
  check(L('ホームの8プロジェクトはそのまま'), (await page.locator('.pcard').count()) === 8);

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/sync23-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-2-3): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
