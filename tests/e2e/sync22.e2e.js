// Phase Sync-2-2 画面操作テスト（同期の予行演習：確認だけ。クラウドへは送らない・端末のデータも変更しない）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 20000 }).then(() => true).catch(() => false);
const SEVEN = ['3AI Development Factory', 'Vintage Hunt', 'STORM／連合チーム予定管理', '野球教材動画＋練習メニュー', '学校 出欠・行事・三者面談管理', '野球部会計', '家族スケジュール・タスク管理', '健康・減量管理'];

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { const u = new URL(r.url()); if (u.hostname !== 'localhost') external.push(u.hostname + u.pathname); });
  // Googleログイン画面（Sync-1）はFirebaseを読み込むため、にせFirebaseを返す（予行演習の画面では外部へ接続しないことを別に確認する）
  const js = body => ({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body });
  await ctx.route('https://www.gstatic.com/firebasejs/**/firebase-app.js', r => r.fulfill(js('export const getApps = () => []; export const initializeApp = (c, n) => ({ name: n });')));
  await ctx.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js', r => r.fulfill(js('export const getAuth = () => ({ currentUser: null }); export const onAuthStateChanged = (a, f) => { setTimeout(() => f(null), 0); }; export class GoogleAuthProvider { setCustomParameters() {} }; export const signInWithPopup = async () => ({}); export const signOut = async () => {};')));
  const L = s => `[${label}] ${s}`;
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const snapshot = () => page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const db = await FactoryDB.open('factory'); const j = await db.exportAll(); db.close(); return JSON.stringify(j.data); });
  const dbRun = src => page.evaluate(async s => { const { FactoryDB } = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js'); const db = await FactoryDB.open('factory'); await loadMaster(db); const r = await (new Function('db', `return (async () => { ${s} })()`))(db); db.close(); return r; }, src);

  // A. 別のデータだけがある端末（例：iPhoneで独自に作ったデータ）
  await page.goto(BASE); await page.waitForSelector('.hero');
  await dbRun(`await db.create('projects', { name: 'iPhoneで作ったメモ', status: 'concept' }); return true;`);
  const beforeA = await snapshot();
  await page.goto(BASE + '#/settings'); await page.waitForSelector('a[href="#/sync-check"]');
  check(L('設定画面から「同期の予行演習」を開ける'), true);
  await page.click('a[href="#/sync-check"]'); await page.waitForSelector('#sc-run');
  check(L('「確認だけ・送らない・変更しない」と明示'), await waitText(page, '#sc-note', '確認だけ', 'クラウドへは何も送りません', 'データも変更しません'));
  await page.click('#sc-run');
  check(L('別のデータの端末：プロジェクト1件と名前を表示'), await waitText(page, '#sc-projects', 'プロジェクト 1件', 'iPhoneで作ったメモ'));
  check(L('別のデータの端末：Phase 7の8件がそろっていないことを表示'), await waitText(page, '#sc-projects', 'Phase 7の8件のうち 0件', 'Vintage Hunt'));
  check(L('予行演習してもデータは変わらない（別のデータの端末）'), (await snapshot()) === beforeA);

  // B. 8プロジェクトが入っている端末（初回正本の候補）
  await dbRun(`for (const p of await db.all('projects')) await db.remove('projects', p.id); for (const t of await db.listTrash()) await db.purge(t.id, {}); return true;`);
  await page.goto(BASE); await page.waitForSelector('#seed-7'); await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(300);
  // 大きいコードと、個人情報らしき記述を含む要望を用意（確認の表示を見るため）
  await dbRun(`const p = (await db.all('projects')).find(x => x.seedKey === 'vintage-hunt');
    const f = await db.create('files', { projectId: p.id, fileName: 'big-app.html', version: 'v1', status: 'active', code: 'あ'.repeat(290000) });
    await db.update('files', f.id, { code: 'い'.repeat(290000) }, { reason: '大きいコードを書き換え' }); // 変更履歴に変更前・変更後が両方残る（約1.7MB）
    await db.create('requests', { projectId: p.id, title: '田中君の練習メニュー（連絡 tanaka@example.jp）', status: 'unreviewed' }); return true;`);
  const before = await snapshot();
  await page.goto(BASE + '#/account'); await page.waitForSelector('#dry-card');
  check(L('Googleログイン画面から「同期の予行演習」を開ける（ログイン不要）'), await page.isVisible('#dry-card a[href="#/sync-check"]'));
  await page.click('#dry-card a[href="#/sync-check"]'); await page.waitForSelector('#sc-run');
  external.length = 0; // ここから先（予行演習の画面）で外部へ接続しないことを確認する
  await page.click('#sc-run');
  check(L('8プロジェクト：件数とPhase 7の8件がそろっていること'), await waitText(page, '#sc-projects', 'プロジェクト 8件', 'Phase 7の8件がそろっています'));
  const names = await page.$$eval('#sc-projects ol li', a => a.map(x => x.textContent));
  check(L('8プロジェクトの名前をPhase 7の順ですべて表示'), JSON.stringify(names) === JSON.stringify(SEVEN), names.join('／'));
  const counts = await page.innerText('#sc-counts');
  const real = JSON.parse(await dbRun(`const j = await db.exportAll(); return JSON.stringify({ specs: j.data.specs.length, requests: j.data.requests.length, history: j.data.history.length });`));
  check(L('仕様書・要望・変更履歴の件数が実際の件数と一致'), counts.includes(`仕様書\n${real.specs}件`) && counts.includes(`要望\n${real.requests}件`) && counts.includes(`変更履歴\n${real.history}件`), JSON.stringify(real));
  check(L('その他の件数と内訳・同期しないもの'), await waitText(page, '#sc-counts', 'その他', '「その他」の内訳', '同期しないもの', 'master'));
  check(L('バックアップを作成できることを表示'), await waitText(page, '#sc-backup', '作成できます', 'MB'));
  check(L('大きすぎるデータ（大きいコードを書き換えた変更履歴）を表示し、分割して送ると説明'), await waitText(page, '#sc-size', '件あります', '変更履歴', 'ファイル・コードの変更', '分割して送ります'));
  check(L('個人情報らしき記述を種類・言葉・場所つきで表示'), await waitText(page, '#sc-privacy', 'メールアドレス', 'tanaka@example.jp', '人名らしき言葉', '田中君', '要望'));
  check(L('データの指紋・最後の更新・同期の対象件数'), await waitText(page, '#sc-summary', 'データの指紋', '最後の更新', '同期の対象', '確認が必要な点があります'));
  await page.click('#sc-copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(L('結果をコピー（端末どうしで見比べる文章）'), copied.includes('プロジェクト：8件') && copied.includes('データの指紋：') && copied.includes(`仕様書：${real.specs}件`));
  await ov('result'); await page.screenshot({ path: `${OUT}/s22-${label}-result.png`, fullPage: true });

  // 同じデータなら指紋は同じ（もう一度確認）
  const fp1 = await page.textContent('#sc-summary code');
  await page.click('#sc-run'); await page.waitForTimeout(500); await waitText(page, '#sc-summary', 'データの指紋');
  check(L('同じデータでもう一度確認すると同じ指紋'), (await page.textContent('#sc-summary code')) === fp1);

  // 安全性
  check(L('予行演習してもデータは1件も変わらない（8プロジェクトの端末）'), (await snapshot()) === before);
  check(L('予行演習の画面ではクラウド・外部へ一切接続しない'), external.length === 0, [...new Set(external)].join(','));
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
  fs.writeFileSync(`${OUT}/sync22-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Sync-2-2): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
