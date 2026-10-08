// Phase Sync-4a 画面操作テスト（半自動のお知らせ：表示するだけ・自動で送受信しない）
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
    ops.push([op, typeof a === 'string' ? a : '']);
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

const META = 'users/uid-owner-0001/meta/factory';
const reads = (cloud, from) => cloud.ops.slice(from);
const home = async page => { await page.goto(BASE + '#/settings'); await page.waitForSelector('#profile-form'); await page.goto(BASE + '#/'); await page.waitForSelector('.hero'); };
const reload = async page => { await page.goto(BASE + '#/'); await page.reload(); await page.waitForSelector('.hero'); };
const noticeText = page => page.evaluate(() => document.querySelector('[data-sync-notice="home"]')?.innerText || '');
const waitNotice = (page, slot, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(`[data-sync-notice="${s}"]`); return el && w.every(x => el.innerText.includes(x)); }, [slot, words], { timeout: 20000 }).then(() => true).catch(() => false);

async function scenario(label, iphoneOpts) {
  const browser = await chromium.launch();
  const cloud = makeCloud();
  const L = s => `[${label}] ${s}`;
  const PC = await newDevice(browser, { viewport: { width: 1366, height: 860 } }, cloud, 'PC');
  const IP = await newDevice(browser, iphoneOpts, cloud, 'iPhone');
  const pc = PC.page, ip = IP.page;
  let overflowOk = true;
  const ov = async (page, w) => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const external = [];
  ip.on('request', r => { const u = new URL(r.url()); if (u.hostname !== 'localhost') external.push(u.hostname + u.pathname); });

  await ip.goto(BASE); await ip.waitForSelector('.hero'); await ip.waitForTimeout(800);
  check(L('同期を始めていない端末にはお知らせを出さない'), (await noticeText(ip)) === '' && !(await ip.$('#sync-notice')));
  check(L('同期を始めていない端末は、起動時にFirebaseを読み込まない'), external.length === 0, external.join(','));

  await pc.goto(BASE); await pc.click('#seed-7'); await pc.waitForSelector('text=8件を登録しました'); await pc.waitForTimeout(300);
  await login(pc);
  await pc.evaluate(async () => {
    const R = await import('./js/sync/register.js'); const { FactoryDB } = await import('./js/db.js');
    const db = await FactoryDB.open('factory'); const exp = await db.exportAll(); db.close();
    const snap = await R.saveSnapshot(exp); const plan = await R.buildPlan(exp);
    await R.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC（Edge）', schemaVersion: exp.schemaVersion });
  });
  const pcLabel = await pc.evaluate(async () => (await import('./js/sync/auth.js')).deviceKind());
  await openSync(pc); await pc.click('#s3-start'); await waitText(pc, '#sync3-card', '同期を始めました');
  await login(ip); await openSync(ip); await ip.click('#s3-start'); await waitText(ip, '#sync3-card', '同期を始めました');
  await ip.click('#s3-pull'); await ip.click('#s3-pull-go'); await confirmOk(ip); await waitText(ip, '#s3-msg', 'この端末へ反映し、照合しました');
  if (await num(ip, '#s3-n-push')) { await ip.click('#s3-push'); await ip.click('#s3-ignore'); await confirmOk(ip); await waitText(ip, '#s3-msg', 'この端末だけに残しました'); }
  check(L('準備：PC・iPhoneとも 未送信0・受け取り待ち0・競合0'), (await num(ip, '#s3-n-push')) === 0 && (await num(ip, '#s3-n-pull')) === 0 && (await num(ip, '#s3-n-conf')) === 0);
  check(L('同期の画面に「同期のお知らせ」の欄（オン・この端末だけ・1件読むだけ）'), await waitText(ip, '#notice-card', '同期のお知らせ', '1件読むだけ', '自動で送る・受け取ることはしません', 'この端末だけ') && await ip.isChecked('#notice-on'));

  let mark = cloud.ops.length;
  await reload(pc);
  check(L('PC：開くと「同期：そろっています」'), await waitNotice(pc, 'home', '同期：そろっています', '自動では送受信しません'));
  const r1 = reads(cloud, mark);
  check(L('開いたときにクラウドから読んだのは「登録済みの印」1件だけ（記録の中身は読まない）'), r1.length === 1 && r1[0][0] === 'get' && r1[0][1] === META, JSON.stringify(r1));

  await editMemo(pc, 'vintage-hunt', 'PCで追記したメモ（4a）');
  mark = cloud.ops.length;
  await home(pc);
  check(L('PC：変更するとホームに「未送信 2件」'), await waitNotice(pc, 'home', '未送信 2件', 'まだクラウドへ送られていません', '同期の画面で確認'));
  check(L('画面を切り替えただけではクラウドを読み直さない（10分に1回まで）'), reads(cloud, mark).length === 0);
  await pc.screenshot({ path: `${OUT}/s4a-${label}-pc-unsent.png` });
  const seq0 = cloud.docs.get(META).changeSeq;
  await pc.click('#sync-notice');
  check(L('お知らせを押すと同期の画面へ'), await pc.waitForSelector('#sync3-card h2').then(() => true).catch(() => false));
  check(L('同期の画面にもお知らせ（未送信）'), await waitNotice(pc, 'account', '未送信 2件', 'クラウドの最新を確認'));
  check(L('お知らせが出ても自動では送らない（クラウドの変更番号は同じ）'), cloud.docs.get(META).changeSeq === seq0);
  await syncCheck(pc); await pc.click('#s3-push'); await pc.click('#s3-push-go'); await confirmOk(pc);
  await waitText(pc, '#s3-msg', '2件をクラウドへ送り、照合しました');
  check(L('PC：送ると同期の画面のお知らせが消える'), await pc.waitForFunction(() => !document.querySelector('[data-sync-notice="account"]')?.innerText.trim(), null, { timeout: 15000 }).then(() => true).catch(() => false));
  await home(pc);
  check(L('PC：自分が送った変更は「受け取り待ち」にしない（そろっています）'), await waitNotice(pc, 'home', '同期：そろっています'));

  const ipMemo = () => dbEval(ip, `return (await db.all('projects')).find(p => p.seedKey === 'vintage-hunt').memo;`);
  const memoBefore = await ipMemo();
  mark = cloud.ops.length;
  await reload(ip);
  check(L('iPhone：開くと「受け取り待ちがあります」（最終更新：PC）'), await waitNotice(ip, 'home', '受け取り待ちがあります', 'ほかの端末がクラウドを更新しました', pcLabel, '同期の画面で確認'));
  const r3 = reads(cloud, mark);
  check(L('iPhone：判定に読んだのは印1件だけ'), r3.length === 1 && r3[0][1] === META, JSON.stringify(r3));
  check(L('iPhone：お知らせが出ても自動では受け取らない（データはそのまま）'), (await ipMemo()) === memoBefore);
  await ov(ip, 'home-notice'); await ip.screenshot({ path: `${OUT}/s4a-${label}-ip-pending.png` });
  const box = await ip.$eval('#sync-notice', e => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width }; });
  check(L('iPhone：お知らせは押しやすい大きさ（高さ44px以上）'), box.h >= 44, JSON.stringify(box));
  await ip.click('#sync-notice'); await ip.waitForSelector('#sync3-card h2');
  check(L('iPhone：同期の画面にもお知らせ（受け取り待ち）'), await waitNotice(ip, 'account', '受け取り待ちがあります'));
  await ov(ip, 'account-notice'); await ip.screenshot({ path: `${OUT}/s4a-${label}-ip-account.png`, fullPage: true });
  await syncCheck(ip);
  check(L('iPhone：確認しただけでは消えない（受け取り待ち・競合が残っています）'), await waitNotice(ip, 'account', '受け取り待ち'));
  await ip.click('#s3-pull'); await ip.click('#s3-pull-go'); await confirmOk(ip);
  await waitText(ip, '#s3-msg', 'この端末へ反映し、照合しました');
  check(L('iPhone：受け取るとお知らせが消える'), await ip.waitForFunction(() => !document.querySelector('[data-sync-notice="account"]')?.innerText.trim(), null, { timeout: 15000 }).then(() => true).catch(() => false));
  await home(ip);
  check(L('iPhone：ホームも「そろっています」'), await waitNotice(ip, 'home', '同期：そろっています'));

  await editMemo(ip, 'storm', 'iPhoneでオフライン中に追記');
  await IP.ctx.setOffline(true);
  mark = cloud.ops.length;
  await ip.evaluate(() => dispatchEvent(new Event('offline')));
  await home(ip);
  check(L('オフライン：未送信の数と「クラウドは確認していません」'), await waitNotice(ip, 'home', '未送信 2件', 'オフラインのため'));
  check(L('オフライン中はクラウドを読まない'), reads(cloud, mark).length === 0);
  // 3秒以内に読んだばかりなら読み直さない仕組みのため、オンラインに戻す「前」に少し待つ
  // （戻した直後にブラウザの合図とテストの合図が続けて届く。2つ目は読み直さないので、読むのは1回だけ）
  await ip.waitForTimeout(3200);
  await IP.ctx.setOffline(false);
  await ip.evaluate(() => dispatchEvent(new Event('online')));
  check(L('オンラインに戻ると印を読み直す'), await ip.waitForFunction(() => document.querySelector('[data-sync-notice="home"]')?.innerText.includes('に確認'), null, { timeout: 15000 }).then(() => true).catch(() => false) && reads(cloud, mark).filter(o => o[1] === META).length === 1);

  await openSync(ip); await ip.uncheck('#notice-on'); await ip.waitForSelector('text=お知らせをオフにしました');
  mark = cloud.ops.length;
  await reload(ip); await ip.waitForTimeout(800);
  check(L('オフ：ホームに何も表示しない・クラウドを読まない'), (await noticeText(ip)) === '' && reads(cloud, mark).length === 0);
  await openSync(ip); await ip.check('#notice-on'); await ip.waitForSelector('text=お知らせをオンにしました');

  check(L('クラウドで削除・書き込みをしたのは送るボタンのときだけ（お知らせでは書き込まない）'), !cloud.ops.some(o => /delete/i.test(o[0])) && cloud.docs.get(META).changeSeq === seq0 + 1);
  check(L('横はみ出しなし'), overflowOk);
  const errs = [...pc.errors, ...ip.errors];
  check(L('JavaScriptエラーなし'), errs.length === 0, errs.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  fs.writeFileSync(`${OUT}/sync4a-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-4a): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
