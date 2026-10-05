const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // 1) 自動テストページ
  await page.goto(BASE + 'tests/');
  await page.waitForFunction(() => window.__TEST_RESULT__, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.__TEST_RESULT__);
  r.details.filter(d => !d.ok).forEach(d => console.log('   x', d.name, d.error));
  check(`[${label}] ブラウザ内自動テスト ${r.passed}/${r.total}`, r.failed === 0);
  await page.screenshot({ path: `${OUT}/${label}-tests.png`, fullPage: true });

  // 2) ホーム表示・横スクロールなし
  await page.goto(BASE + '#/system');
  await page.waitForSelector('text=基盤の状態');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`[${label}] ホーム表示（横はみ出しなし）`, !overflow);
  check(`[${label}] テスト結果がホームに反映`, await page.isVisible('text=合格'));
  await page.screenshot({ path: `${OUT}/${label}-home.png`, fullPage: true });

  // 3) 本番DBにデータを作ってUIでバックアップ→削除→ゴミ箱→復元→ファイル復元
  await page.evaluate(async () => {
    const { FactoryDB } = await import('./js/db.js');
    const db = await FactoryDB.open('factory');
    await db.create('projects', { name: 'E2E確認用', status: 'concept' });
    db.close();
  });
  await page.goto(BASE + '#/backup');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#do-backup')]);
  const file = `${OUT}/${label}-backup.json`;
  await dl.saveAs(file);
  const bj = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(`[${label}] バックアップファイル保存`, bj.app === '3ai-factory' && bj.data.projects.some(p => p.name === 'E2E確認用'), dl.suggestedFilename());

  await page.evaluate(async () => {
    const { FactoryDB } = await import('./js/db.js');
    const db = await FactoryDB.open('factory');
    const p = (await db.query('projects', { text: 'E2E確認用' }))[0];
    await db.remove('projects', p.id);
    db.close();
  });
  await page.goto(BASE + '#/trash');
  await page.waitForSelector('text=E2E確認用');
  // 完全削除→確認ダイアログでキャンセル→残っている
  await page.click('[data-purge]');
  check(`[${label}] 完全削除前に確認ダイアログ`, await page.isVisible('text=元に戻せません'));
  await page.click('.modal [data-close]');
  check(`[${label}] キャンセルで削除されない`, await page.isVisible('text=E2E確認用'));
  await page.click('[data-restore]');
  await page.waitForSelector('text=ゴミ箱は空です');
  check(`[${label}] ゴミ箱から元に戻す（画面操作）`, true);

  // ファイルから復元（不正ファイル→拒否、正しいファイル→確認→復元）
  await page.goto(BASE + '#/backup');
  fs.writeFileSync(`${OUT}/bad.json`, '{"app":"other"}');
  await page.setInputFiles('#restore-file', `${OUT}/bad.json`);
  await page.waitForSelector('text=このファイルは復元できません');
  check(`[${label}] 不正ファイルは画面で拒否`, await page.isVisible('text=今のデータは変更されていません'));
  await page.setInputFiles('#restore-file', file);
  await page.waitForSelector('#do-restore');
  await page.click('#do-restore');
  check(`[${label}] 復元前に確認ダイアログ`, await page.isVisible('text=本当に復元しますか'));
  await page.click('[data-a="1"]');
  await page.waitForSelector('.hero');
  check(`[${label}] ファイルから復元（画面操作）`, true);

  // 4) 再読込でデータ保持
  await page.reload();
  const kept = await page.evaluate(async () => {
    const { FactoryDB } = await import('./js/db.js');
    const db = await FactoryDB.open('factory');
    const n = (await db.query('projects', { text: 'E2E確認用' })).length;
    db.close(); return n;
  });
  check(`[${label}] 再読込後もデータ保持`, kept === 1);

  // 5) 設定：誤入力（空の名前）
  await page.goto(BASE + '#/settings');
  await page.fill('input[name=name]', '');
  await page.click('#profile-form button');
  check(`[${label}] 設定の誤入力を表示`, await page.isVisible('text=名前を入力してください'));
  await page.fill('input[name=name]', '先生');
  await page.click('#profile-form button');
  await page.waitForSelector('text=保存しました');
  check(`[${label}] 設定の保存`, true);
  await page.screenshot({ path: `${OUT}/${label}-settings.png`, fullPage: true });

  // 6) 引継ぎ画面
  await page.goto(BASE + '#/handoff');
  await page.waitForSelector('text=引継ぎ内容をコピー');
  check(`[${label}] 引継ぎ画面`, await page.isVisible('text=次に行う作業'));
  await page.screenshot({ path: `${OUT}/${label}-handoff.png`, fullPage: true });

  // 7) 印刷レイアウト（ナビ非表示）
  await page.emulateMedia({ media: 'print' });
  check(`[${label}] 印刷時はメニューを隠す`, !(await page.isVisible('.tabbar')));
  await page.emulateMedia({ media: 'screen' });

  // 8) オフライン起動
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // SWの管理下に
  await page.waitForSelector('.hero');
  await ctx.setOffline(true);
  await page.reload();
  const offOk = await page.waitForSelector('.pcard', { timeout: 10000 }).then(() => true).catch(() => false);
  check(`[${label}] オフラインで起動・データ表示`, offOk && await page.isVisible('text=オフライン中です'));
  await page.screenshot({ path: `${OUT}/${label}-offline.png`, fullPage: true });
  await ctx.setOffline(false);

  check(`[${label}] JavaScriptエラーなし`, errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  await scenario('iphone', { ...devices['iPhone 13'], defaultBrowserType: undefined });
  await scenario('pc', { viewport: { width: 1280, height: 800 } });
  fs.writeFileSync(`${OUT}/e2e-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase1回帰): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
