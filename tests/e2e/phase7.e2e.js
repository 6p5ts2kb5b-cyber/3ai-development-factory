// Phase 7 画面操作テスト（Factory本体＋7プロジェクトの正式初期登録・既存アプリ取込）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 15000 }).then(() => true).catch(() => false);
const tab = async (page, name) => { await page.click(`.tabs a:has-text("${name}")`); await page.waitForSelector(`.tabs a[aria-current]:has-text("${name}")`); await page.waitForTimeout(200); };
const cardOf = (page, name) => page.locator('.pcard', { has: page.locator('h2', { hasText: name }) });
const SEVEN = ['Vintage Hunt', 'STORM／連合チーム予定管理', '野球教材動画＋練習メニュー', '学校 出欠・行事・三者面談管理', '野球部会計', '家族スケジュール・タスク管理', '健康・減量管理'];

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };
  const dbRun = (fn, arg) => page.evaluate(async ([src, a]) => {
    const { FactoryDB } = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js');
    const db = await FactoryDB.open('factory'); await loadMaster(db);
    const r = await (new Function('db', 'a', `return (async () => { ${src} })()`))(db, a); db.close(); return r;
  }, [fn, arg]);

  // 1. ホームから一括登録
  await page.goto(BASE); await page.waitForSelector('.hero');
  check(L('ホームに「Factory本体＋7プロジェクトを登録」'), await page.isVisible('#seed-7'));
  await page.click('#seed-7');
  await page.waitForSelector('text=8件を登録しました');
  await page.waitForSelector('.pcard');
  await page.waitForTimeout(300);
  const names = await page.$$eval('.pcard h2', a => a.map(x => x.textContent));
  check(L('ホームに Factory＋7件＝合計8件'), names.length === 8 && names.includes('3AI Development Factory') && SEVEN.every(n => names.includes(n)), names.join('／'));
  check(L('上からFactory本体→開発順（Vintage Hunt…健康）で並ぶ'), JSON.stringify(names) === JSON.stringify(['3AI Development Factory', ...SEVEN]), names.join('／'));
  check(L('登録後は登録ボタンが消える'), !(await page.isVisible('#seed-7')));
  check(L('野球成績／オーダーが入っていない'), !names.some(n => /野球成績|オーダー/.test(n)));
  const vh = cardOf(page, 'Vintage Hunt');
  const vhText = await vh.innerText();
  check(L('カードに状態・完成度・次・未解決・要望・最終更新'), ['仕様確定', '完成度', '次', '未解決', '要望'].every(w => vhText.includes(w)) && /\d+\/\d+|\d+:\d+|今日|分前|時間前/.test(vhText), vhText.replace(/\n/g, ' '));
  const pcts = await page.$$eval('.pcard .pct strong', a => a.map(x => Number(x.textContent.replace('%', ''))));
  check(L('実装前なので完成度は低い（30%以下）'), pcts.every(v => v <= 30), pcts.join(','));
  check(L('カードに「既存アプリ未確認」表示'), (await page.$$eval('.pcard', a => a.filter(x => x.innerText.includes('既存アプリ未確認')).length)) === 7);
  await ov('home'); await page.screenshot({ path: `${OUT}/p7-${label}-home.png`, fullPage: true });

  // 2. もう一度押しても重複しない（v1画面にはもうボタンがない）
  await page.goto(BASE + '#/v1'); await page.waitForSelector('.v1-head');
  const v1 = await page.innerText('#view');
  check(L('v1完成まで：7案件 7/7・既存アプリ有無の確認が残る'), v1.includes('7/7 件登録') && v1.includes('7案件の既存アプリ有無の確認') && v1.includes('未確認 7件') && !(await page.isVisible('#seed-7')));

  // 3. 各カードから開ける・v1.0確定仕様・指示書17項目
  let opened = 0, specOk = 0, guideOk = 0;
  for (const n of SEVEN) {
    await page.goto(BASE); await page.waitForSelector('.pcard');
    await cardOf(page, n).locator('.pcard-link').click({ position: { x: 40, y: 22 } });
    await page.waitForSelector('.p-head h1');
    if ((await page.textContent('.p-head h1')) === n) opened++;
    const head = await page.innerText('.p-head');
    await tab(page, '仕様書');
    const sv = await page.innerText('#tab');
    if (head.includes('仕様 v1.0') && sv.includes('v1.0') && sv.includes('確定')) specOk++;
    await page.click('a:has-text("移行用指示書を開く")');
    await page.waitForSelector('#g-copy');
    const g = await page.innerText('#view');
    if (['1. 目的', '11. 既存URL', '12. ソースコード', '16. テスト', '17. 次に実装すること', '既存アプリの有無：未確認'].every(w => g.includes(w))) guideOk++;
  }
  check(L('ホームカードから7件すべてを開ける'), opened === 7, `${opened}/7`);
  check(L('7件すべてに v1.0 確定仕様'), specOk === 7, `${specOk}/7`);
  check(L('7件すべてで移行用指示書（17項目）を開ける'), guideOk === 7, `${guideOk}/7`);
  await ov('guide');

  // 4. 次にやること・テスト（共通＋個別必須）
  await page.goto(BASE); await page.waitForSelector('.pcard');
  await cardOf(page, 'STORM').locator('.pcard-link').click({ position: { x: 40, y: 22 } });
  await page.waitForSelector('.p-head h1');
  await tab(page, '次にやること');
  check(L('次にやること：既存アプリ確認→v1実装開始'), await waitText(page, '#tab', '既存Webアプリがあるか確認する', 'v1の実装開始'));
  await tab(page, 'テスト');
  check(L('テスト：共通テスト＋個別必須「選手集合時間と審判集合時間を混同しない」'), await waitText(page, '#tab', '選手集合時間と審判集合時間を混同しない', '新規登録'));

  // 5. 既存アプリタブ：未確認 → 取込待ち → 情報登録 → 取込完了 → 照合 → 要望箱
  await tab(page, '既存アプリ');
  check(L('既存アプリタブ：あり／なしを選べる'), await page.isVisible('#org-existing') && await page.isVisible('#org-new'));
  await page.click('#org-existing');
  await page.waitForSelector('#exf');
  check(L('「既存アプリあり／取込待ち」になる'), await waitText(page, '.p-head', '既存アプリあり／取込待ち'));
  await page.click('#ex-done');
  check(L('URLもコードもないと取込を完了できない（推測しない）'), await waitText(page, '#exf-err', 'まだ取込を完了できません'));
  await page.fill('#exf input[name=ex_webUrl]', 'storm.example');
  await page.click('#exf button.primary');
  check(L('URLの形式誤りを表示'), await waitText(page, '#exf-err', 'http:// または https://'));
  await page.fill('#exf input[name=ex_appName]', 'STORM予定');
  await page.fill('#exf input[name=ex_webUrl]', 'https://example.github.io/storm/');
  await page.fill('#exf input[name=ex_currentVersion]', 'v0.5');
  await page.selectOption('#exf select[name=ex_publishState]', '公開中');
  await page.fill('#exf textarea[name=ex_storage]', 'localStorage');
  await page.fill('#exf textarea[name=ex_knownIssues]', '印刷が崩れる');
  await page.click('#ex-done');
  await page.waitForSelector('text=基準Versionとして記録しました');
  check(L('取込を完了 → 基準Version v0.5'), await waitText(page, '#tab', '取込済み', '基準Version', 'v0.5') && await waitText(page, '.p-head', '既存アプリ取込済み'));
  const sel = page.locator('.cov-sel');
  check(L('確定仕様 v1.0 と照合する項目が並ぶ'), (await sel.count()) >= 10 && await waitText(page, '#cov-card', '確定仕様 v1.0 との照合'));
  await sel.nth(0).selectOption('done'); await page.waitForTimeout(400);
  await page.locator('.cov-sel').nth(1).selectOption('todo'); await page.waitForTimeout(400);
  await page.locator('.cov-sel').nth(2).selectOption('diff'); await page.waitForTimeout(400);
  check(L('照合の集計（実装済み1・未実装1・仕様と違う1）'), await waitText(page, '#cov-card', '実装済み 1', '未実装 1', '仕様と違う 1'));
  check(L('改良候補に選べるのは差分だけ'), (await page.locator('[data-cov-pick]').count()) === 2);
  await page.locator('[data-cov-pick]').nth(0).check();
  await page.locator('[data-cov-pick]').nth(1).check();
  await page.click('#cov-bar button');
  await page.waitForSelector('text=2件を改良候補として要望箱へ入れました');
  await page.waitForTimeout(300);
  check(L('送った項目は「要望箱へ送り済み」'), (await page.locator('.ok-note:has-text("要望箱へ送り済み")').count()) === 2);
  await tab(page, '要望箱');
  check(L('要望箱に【改良候補】が未検討で入る'), await waitText(page, '#tab', '【改良候補】', '未検討'));
  const st = await dbRun(`const p=(await db.all('projects')).find(x=>x.seedKey==='storm'); const s=await db.specsOf(p.id); return [s.length, s[0].version, s[0].status];`);
  check(L('照合しても確定仕様は変わらない'), JSON.stringify(st) === JSON.stringify([1, 'v1.0', 'fixed']), JSON.stringify(st));
  await tab(page, '仕様書');
  await page.click('a:has-text("移行用指示書を開く")'); await page.waitForSelector('#g-copy');
  check(L('指示書に既存アプリの情報（URL・基準Version・既知の問題）'), await waitText(page, '#view', 'https://example.github.io/storm/', '基準Version：v0.5', '印刷が崩れる'));
  await ov('existing'); await page.screenshot({ path: `${OUT}/p7-${label}-existing.png`, fullPage: true });

  // 6. 新規作成：「新しく作る」「既存アプリを取り込む」
  await page.goto(BASE); await page.waitForSelector('.hero');
  await page.click('#new-project');
  check(L('新規作成で「新しく作る」が初期選択'), await page.isChecked('#pf input[name=origin][value=new]') && !(await page.isVisible('#ex-box')));
  await page.check('#pf input[name=origin][value=existing]');
  check(L('「既存アプリを取り込む」で取込項目が出る'), await page.isVisible('#pf input[name=ex_githubUrl]'));
  await page.fill('#pf input[name=name]', '取込テスト');
  await page.fill('#pf input[name=ex_githubUrl]', 'github.com/x');
  await page.click('#pf button.primary');
  check(L('URLの誤りは作成前に止める（途中のプロジェクトを残さない）'), await waitText(page, '#pf-err', 'GitHub URL') && (await dbRun(`return (await db.all('projects')).filter(p=>p.name==='取込テスト').length;`)) === 0);
  await page.fill('#pf input[name=ex_githubUrl]', 'https://github.com/x/y');
  await page.click('#pf button.primary');
  await page.waitForSelector('#exf');
  check(L('既存アプリ取込プロジェクトを作成→既存アプリタブ'), await waitText(page, '.p-head', '既存アプリあり／取込待ち') && (await page.inputValue('#exf input[name=ex_githubUrl]')) === 'https://github.com/x/y');
  await ov('new-existing');

  // 7. バックアップ → 全消去 → 復元（画面操作）で7件と仕様Versionが残る
  await page.goto(BASE + '#/backup');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#do-backup')]);
  const file = `${OUT}/p7-${label}-backup.json`;
  await dl.saveAs(file);
  const bj = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(L('JSONバックアップに7案件が含まれる'), SEVEN.every(n => bj.data.projects.some(p => p.name === n)) && bj.data.specs.filter(s => s.version === 'v1.0').length >= 8);
  await dbRun(`for (const p of await db.all('projects')) await db.remove('projects', p.id); for (const t of await db.listTrash()) await db.purge(t.id, {}); return true;`);
  await page.goto(BASE); await page.waitForSelector('.hero');
  check(L('全消去で0件（登録ボタンが再表示）'), (await page.locator('.pcard').count()) === 0 && await page.isVisible('#seed-7'));
  await page.goto(BASE + '#/backup');
  await page.setInputFiles('#restore-file', file);
  await page.waitForSelector('#do-restore');
  await page.click('#do-restore');
  await page.click('[data-a="1"]');
  await page.waitForSelector('.pcard');
  await page.waitForTimeout(300);
  const after = await page.$$eval('.pcard h2', a => a.map(x => x.textContent));
  const vers = await dbRun(`const ps=(await db.all('projects')).filter(p=>p.seedKey&&p.seedKey!=='factory'); const out=[]; for (const p of ps) out.push((await db.specsOf(p.id)).map(s=>s.version+':'+s.status).join()); return out;`);
  check(L('復元後も7案件と仕様Version（v1.0確定）が保持される'), SEVEN.every(n => after.includes(n)) && vers.length === 7 && vers.every(v => v === 'v1.0:fixed'), vers.join('|'));
  const imp = await dbRun(`const p=(await db.all('projects')).find(x=>x.seedKey==='storm'); return [p.existing.importStatus, p.existing.baseline.currentVersion];`);
  check(L('復元後も既存アプリの取込状態が保持される'), JSON.stringify(imp) === JSON.stringify(['imported', 'v0.5']), JSON.stringify(imp));

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/e2e7-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase7): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
