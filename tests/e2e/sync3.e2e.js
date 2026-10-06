// Phase Sync-3 画面操作テスト（PC・iPhoneの双方向同期：ボタンを押したときだけ）
// PC役とiPhone役の2つのブラウザが、同じ1つの「にせクラウド」を使う（中身はこのテストのプログラム側に置き、両方の画面から読み書きする）。
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const SDK = 'https://www.gstatic.com/firebasejs/12.8.0/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 30000 }).then(() => true).catch(() => false);

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
// にせFirestore：中身はテストのプログラム側（window.__fs で呼ぶ）。削除の命令は持たない
const FAKE_FS = `
const call = (op, a) => window.__fs(op, JSON.stringify(a ?? null)).then(r => JSON.parse(r));
const snap = (path, d) => ({ id: path.split('/').pop(), exists: () => d != null, data: () => d });
export const getFirestore = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const collection = (db, ...p) => ({ path: p.join('/') });
export const serverTimestamp = () => new Date().toISOString();
export const getDocFromServer = async ref => snap(ref.path, await call('get', ref.path));
export const getDocsFromServer = async col => { const list = await call('list', col.path); return { size: list.length, forEach: f => list.forEach(([k, v]) => f(snap(k, v))) }; };
export const setDoc = async (ref, data, opt) => call('commit', [[ref.path, data, opt || null]]);
export const writeBatch = () => { const pend = []; return { set: (r, d) => pend.push([r.path, d, null]), commit: () => call('commit', pend) }; };
export const runTransaction = async (db, fn) => { const pend = []; const t = { get: async r => snap(r.path, await call('get', r.path)), set: (r, d, o) => pend.push([r.path, d, o || null]) }; const res = await fn(t); await call('commit', pend); return res; };`;
const CFG = JSON.stringify({ config: { apiKey: 'AIza-test', authDomain: 'factory-test.firebaseapp.com', projectId: 'factory-test', appId: '1:1:web:1' } });

function makeCloud() {
  const docs = new Map(); const ops = [];
  const handler = (op, arg) => {
    const a = JSON.parse(arg);
    ops.push(op);
    if (op === 'get') return JSON.stringify(docs.has(a) ? docs.get(a) : null);
    if (op === 'list') return JSON.stringify([...docs.entries()].filter(([k]) => k.startsWith(a + '/') && !k.slice(a.length + 1).includes('/')));
    if (op === 'commit') { for (const [k, v, o] of a) docs.set(k, o && o.merge ? { ...(docs.get(k) || {}), ...v } : v); return 'true'; }
    throw new Error('unknown op ' + op);
  };
  return { docs, ops, handler };
}

async function newDevice(browser, ctxOpts, cloud, label) {
  const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
  const js = body => ({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body });
  await ctx.route('**/config/firebase.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: CFG }));
  await ctx.route(SDK + 'firebase-app.js', r => r.fulfill(js(FAKE_APP)));
  await ctx.route(SDK + 'firebase-auth.js', r => r.fulfill(js(FAKE_AUTH)));
  await ctx.route(SDK + 'firebase-firestore.js', r => r.fulfill(js(FAKE_FS)));
  await ctx.exposeFunction('__fs', (op, arg) => cloud.handler(op, arg));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(`${label}: ${m.text()}`); });
  return { ctx, page };
}
const dbEval = (page, src, arg) => page.evaluate(async ([s, a]) => { const { FactoryDB } = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js'); const db = await FactoryDB.open('factory'); await loadMaster(db); const r = await (new Function('db', 'a', `return (async () => { ${s} })()`))(db, a); db.close(); return r; }, [src, arg]);
const login = async page => { await page.goto(BASE + '#/account'); await page.waitForSelector('#acc-in, #acc-out'); if (await page.isVisible('#acc-in')) { await page.click('#acc-in'); await waitText(page, '#acc-card', 'ログインできています'); } };
const openSync = async page => { await page.goto(BASE + '#/settings'); await page.waitForSelector('#profile-form'); await page.goto(BASE + '#/account'); await page.waitForSelector('#sync3-card h2'); };
const syncCheck = async page => { await page.click('#s3-check'); await page.waitForFunction(() => { const b = document.querySelector('#s3-check'); return b && !b.disabled && document.querySelector('#s3-n-pull'); }, null, { timeout: 30000 }); };
const num = (page, id) => page.evaluate(i => Number(document.querySelector(i)?.textContent ?? -1), id);
const editMemo = async (page, seedKey, memo) => {
  const id = await dbEval(page, `return (await db.all('projects')).find(p => p.seedKey === a).id;`, seedKey);
  await page.goto(BASE + `#/p/${id}`); await page.waitForSelector('#edit-p'); await page.click('#edit-p');
  await page.waitForSelector('#pf textarea[name=memo]'); await page.fill('#pf textarea[name=memo]', memo); await page.click('#pf button.primary');
  await page.waitForSelector('text=保存しました');
};
const confirmOk = async page => { await page.waitForSelector('.modal [data-a="1"]'); await page.click('.modal [data-a="1"]'); };

async function scenario(label, iphoneOpts) {
  const browser = await chromium.launch();
  const cloud = makeCloud();
  const L = s => `[${label}] ${s}`;
  const PC = await newDevice(browser, { viewport: { width: 1366, height: 860 } }, cloud, 'PC');
  const IP = await newDevice(browser, iphoneOpts, cloud, 'iPhone');
  const pc = PC.page, ip = IP.page;
  let overflowOk = true;
  const ov = async (page, w) => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };

  // 準備：PCに8プロジェクト・初回登録（Sync-2-3と同じ状態）
  await pc.goto(BASE); await pc.click('#seed-7'); await pc.waitForSelector('text=8件を登録しました'); await pc.waitForTimeout(300);
  await login(pc);
  const total = await pc.evaluate(async () => {
    const R = await import('./js/sync/register.js'); const { FactoryDB } = await import('./js/db.js');
    const db = await FactoryDB.open('factory'); const exp = await db.exportAll(); db.close();
    const snap = await R.saveSnapshot(exp); const plan = await R.buildPlan(exp);
    await R.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC（Edge）', schemaVersion: exp.schemaVersion }); return plan.total;
  });
  const dataKeysBefore = [...cloud.docs.keys()].filter(k => !k.includes('/meta/'));
  check(L('準備：PCからクラウドへ初回登録済み'), cloud.docs.get('users/uid-owner-0001/meta/factory')?.status === 'complete', `${total}件`);

  const pcLabel = await pc.evaluate(async () => (await import('./js/sync/auth.js')).deviceKind());
  // 1. PC：同期を始める
  await openSync(pc);
  check(L('PC：「PC・iPhoneの同期」の欄（まだ始めていない）'), await waitText(pc, '#sync3-card', 'PC・iPhoneの同期', 'まだ同期を始めていません', 'クラウドのデータもこの端末のデータも変わりません'));
  await pc.click('#s3-start');
  check(L('PC：同期を始める（全件照合・クラウドの控え）'), await waitText(pc, '#sync3-card', '同期を始めました', `クラウドの${total}件を照合`));
  check(L('PC：クラウド・最終同期・最終更新・未送信・受け取り待ち・競合を表示'), await waitText(pc, '#s3-status', 'クラウド', '登録済み', 'この端末の最終同期', 'クラウドの最終更新', '未送信の変更', '受け取り待ち', '競合'));
  check(L('PC：最初は 未送信0・受け取り待ち0・競合0'), (await num(pc, '#s3-n-push')) === 0 && (await num(pc, '#s3-n-pull')) === 0 && (await num(pc, '#s3-n-conf')) === 0);
  check(L('Sync-3を始めてもクラウドのデータ本体は書き換えない（印だけ）'), JSON.stringify(dataKeysBefore.map(k => cloud.docs.get(k))) === JSON.stringify([...cloud.docs.keys()].filter(k => !k.includes('/meta/')).map(k => cloud.docs.get(k))) && cloud.docs.get('users/uid-owner-0001/meta/factory').syncFormat === 3);

  // 2. iPhone：プロジェクト0件・少しデータあり → 同期を始める → 受け取る
  await ip.goto(BASE); await ip.waitForSelector('.hero');
  await dbEval(ip, `const t = await db.create('ideas', { text: 'iPhoneで書いたメモ', status: 'new' }); await db.remove('ideas', t.id); await db.upsert('settings', 'lastTestRun', { key: 'lastTestRun', value: { total: 61 } }, {}); return 1;`);
  await login(ip); await openSync(ip);
  await ip.click('#s3-start');
  await waitText(ip, '#sync3-card', '同期を始めました');
  const pullN = await num(ip, '#s3-n-pull');
  check(L('iPhone：クラウドの全件が受け取り待ち'), pullN === total, `${pullN}/${total}`);
  check(L('iPhone：同期前からこの端末だけにある記録を区別して表示'), await waitText(ip, '#s3-status', '同期を始める前からこの端末だけにある記録'));
  await ip.click('#s3-pull');
  check(L('iPhone：受け取る前に件数と内容（新規・更新・更新者）を表示'), await waitText(ip, '#s3-pull-panel', `この端末へ反映する変更（${total}件）`, '新規', '控えを自動で作ります'));
  await ov(ip, 'pull-panel'); await ip.screenshot({ path: `${OUT}/s3-${label}-pull.png` });
  await ip.click('#s3-pull-go');
  check(L('iPhone：最後に確認（件数）'), await waitText(ip, '.modal', `${total}件をこの端末へ反映しますか`));
  await confirmOk(ip);
  check(L('iPhone：反映して照合（同期完了）'), await waitText(ip, '#s3-msg', `${total}件をこの端末へ反映し、照合しました`));
  // 同期前からある記録は「この端末だけに残す」
  await ip.click('#s3-push');
  check(L('iPhone：同期前からある記録は最初チェックなし'), await waitText(ip, '#s3-push-panel', '同期前からある記録') && await ip.isDisabled('#s3-push-go'));
  await ip.click('#s3-ignore'); await confirmOk(ip);
  check(L('iPhone：この端末だけに残す → 未送信0'), await waitText(ip, '#s3-msg', 'この端末だけに残しました') && (await num(ip, '#s3-n-push')) === 0);
  await ip.goto(BASE); await ip.waitForSelector('.pcard'); await ip.waitForTimeout(200);
  check(L('iPhone：ホームに8プロジェクト'), (await ip.locator('.pcard').count()) === 8);
  check(L('iPhone：端末ごとの記録（自動テスト結果）は残る・クラウドへ送らない'), (await dbEval(ip, `return (await db.get('settings', 'lastTestRun'))?.value?.total;`)) === 61 && ![...cloud.docs.keys()].some(k => /\/settings\/r-lastTestRun$/.test(k)));

  // 3. PCで1件変更 → 送る
  await editMemo(pc, 'vintage-hunt', 'PCで追記したメモ');
  await openSync(pc); await syncCheck(pc);
  check(L('PC：変更を「未送信」として検出（変更した記録＋変更履歴）'), (await num(pc, '#s3-n-push')) === 2);
  await pc.click('#s3-push');
  check(L('PC：送る前に件数と内容（変更・新規）を表示'), await waitText(pc, '#s3-push-panel', 'クラウドへ送る変更（2件）', 'プロジェクト', 'Vintage Hunt', '変更', '削除はクラウドへ反映しません'));
  const seqBefore = cloud.docs.get('users/uid-owner-0001/meta/factory').changeSeq;
  await pc.click('#s3-push-go');
  check(L('PC：最後に確認（件数）'), await waitText(pc, '.modal', '2件をクラウドへ送りますか'));
  await confirmOk(pc);
  check(L('PC：送って照合（同期完了）'), await waitText(pc, '#s3-msg', '2件をクラウドへ送り、照合しました'));
  const meta = cloud.docs.get('users/uid-owner-0001/meta/factory');
  check(L('クラウド：変更番号が1つ進み、最終更新者はPC'), meta.changeSeq === seqBefore + 1 && meta.lastUpdatedBy === pcLabel, `${meta.changeSeq} ${meta.lastUpdatedBy}`);

  // 4. iPhoneで受け取る
  await openSync(ip); await syncCheck(ip);
  check(L('iPhone：受け取り待ち2件（PCの変更）'), (await num(ip, '#s3-n-pull')) === 2);
  await ip.click('#s3-pull');
  check(L('iPhone：受け取る内容に送った端末（PC）を表示'), await waitText(ip, '#s3-pull-panel', 'Vintage Hunt', '更新', pcLabel));
  await ip.click('#s3-pull-go'); await confirmOk(ip);
  await waitText(ip, '#s3-msg', 'この端末へ反映し、照合しました');
  check(L('iPhone：PCの変更が反映された'), (await dbEval(ip, `return (await db.all('projects')).find(p => p.seedKey === 'vintage-hunt').memo;`)) === 'PCで追記したメモ');

  // 5. iPhoneで別の1件を変更 → 送る → 6. PCで受け取る
  await editMemo(ip, 'storm', 'iPhoneで追記したメモ');
  await ov(ip, 'edit');
  await openSync(ip); await syncCheck(ip);
  await ip.click('#s3-push'); await ip.click('#s3-push-go'); await confirmOk(ip);
  check(L('iPhone：変更を送って照合'), await waitText(ip, '#s3-msg', 'クラウドへ送り、照合しました'));
  await openSync(pc); await syncCheck(pc);
  check(L('PC：iPhoneの変更が受け取り待ち2件'), (await num(pc, '#s3-n-pull')) === 2);
  await pc.click('#s3-pull'); await pc.click('#s3-pull-go'); await confirmOk(pc);
  await waitText(pc, '#s3-msg', 'この端末へ反映し、照合しました');
  check(L('PC：iPhoneの変更が反映された'), (await dbEval(pc, `return (await db.all('projects')).find(p => p.seedKey === 'storm').memo;`)) === 'iPhoneで追記したメモ');

  // 7. 同じ1件を両方で変更 → 競合
  await editMemo(pc, 'kaikei', 'PC版のメモ');
  await editMemo(ip, 'kaikei', 'iPhone版のメモ');
  await openSync(pc); await syncCheck(pc); await pc.click('#s3-push'); await pc.click('#s3-push-go'); await confirmOk(pc);
  await waitText(pc, '#s3-msg', 'クラウドへ送り、照合しました');
  await openSync(ip); await syncCheck(ip);
  check(L('iPhone：競合1件を検出（勝手に採用しない）'), (await num(ip, '#s3-n-conf')) === 1);
  await ip.click('#s3-conf');
  check(L('競合：この端末版・クラウド版・更新日時・更新者・変更内容を表示'), await waitText(ip, '#s3-conf-panel', 'この端末版', `クラウド版（${pcLabel}）`, 'メモ', 'PC版のメモ', 'iPhone版のメモ', 'この端末版を採用', 'クラウド版を採用', '選んだ内容で統合'));
  await ov(ip, 'conflict'); await ip.screenshot({ path: `${OUT}/s3-${label}-conflict.png`, fullPage: true });
  await ip.check('#s3-conf-panel input[data-field="memo"][value="local"]');
  await ip.click('#s3-conf-panel [data-choice="merge"]'); await confirmOk(ip);
  check(L('競合：選んだ内容で統合して解決'), await waitText(ip, '#s3-msg', '競合を解決しました') && (await num(ip, '#s3-n-conf')) === 0);
  await openSync(pc); await syncCheck(pc);
  await pc.click('#s3-pull'); await pc.click('#s3-pull-go'); await confirmOk(pc);
  await waitText(pc, '#s3-msg', 'この端末へ反映し、照合しました');
  check(L('PC：統合した版（iPhone版のメモ）を受け取った'), (await dbEval(pc, `return (await db.all('projects')).find(p => p.seedKey === 'kaikei').memo;`)) === 'iPhone版のメモ');

  // 画面を素早く続けて切り替えても、最後に開いた画面が表示される（ホーム画面版の安定化）
  await ip.evaluate(() => { location.hash = '#/settings'; location.hash = '#/account'; location.hash = '#/'; location.hash = '#/account'; });
  await ip.waitForTimeout(2500);
  check(L('画面を素早く切り替えても、最後に開いた画面が表示される'), await ip.evaluate(() => !!document.querySelector('#sync3-card') && !document.querySelector('#profile-form') && location.hash === '#/account'));
  // 安全性
  check(L('クラウドで削除の操作をしていない'), !cloud.ops.some(o => /delete/i.test(o)));
  const keysNow = [...cloud.docs.keys()];
  check(L('ゴミ箱・端末ごとの記録は送っていない'), !keysNow.some(k => /\/settings\/r-(lastTestRun|master|lastBackup)$/.test(k)));
  check(L('横はみ出しなし（iPhone）'), overflowOk);
  const errs = [...pc.errors, ...ip.errors];
  check(L('JavaScriptエラーなし'), errs.length === 0, errs.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  fs.writeFileSync(`${OUT}/sync3-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-3): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
