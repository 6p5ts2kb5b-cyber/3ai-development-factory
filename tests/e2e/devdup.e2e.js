// v0.11.8 実機確認の重複：同期でそろった未記入の欄が完成判定を妨げない・削除せずに整理できる・合格の記録は変わらない
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 15000 }).then(() => true).catch(() => false);
const dbEval = (page, src, arg) => page.evaluate(async ([s, a]) => { const M = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js'); const db = await M.FactoryDB.open('factory'); await loadMaster(db); const r = await (new Function('db', 'M', 'a', `return (async () => { ${s} })()`))(db, M, a); db.close(); return r; }, [src, arg]);

async function scenario(label, opts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  await page.goto(BASE); await page.waitForSelector('.hero'); await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(400);
  // 実際に起きた状態を再現：この端末の欄（iPhoneを合格に記録済み）＋同期で届いたもう1台の欄（未記入）
  const ids = await dbEval(page, `
    const have = await db.checksOf(M.FACTORY_ID, 'device');
    const ip = have.find(d => d.device === 'iPhone');
    await db.update('checks', ip.id, { status: 'pass', checkedAt: '2026-10-08', result: '自動テスト 91/91 合格' }, { reason: '実機確認（iPhone）：合格' });
    const dups = [];
    for (const [i, d] of db.master.defaultDevices.entries()) dups.push((await db.create('checks', { projectId: M.FACTORY_ID, kind: 'device', device: d, order: i, status: 'unchecked', scope: 'Factory本体 Phase 1〜6', result: '', memo: 'Phase 1〜5の「実機確認待ち」を引継ぎ', checkedAt: null }, { actor: 'Factory' })).id);
    return { pass: ip.id, dups, passJson: JSON.stringify(await db.get('checks', ip.id)), total: (await db.all('checks')).length, projects: (await db.all('projects')).length };`);
  await page.goto(BASE + '#/v1'); await page.waitForSelector('#dev-card');
  const v1 = await page.evaluate(() => [...document.querySelectorAll('.cond li')].map(li => [li.querySelector('strong').innerText, li.classList.contains('ok')]).filter(([t]) => t.includes('の実機確認')));
  check(L('完成判定：端末ごとに1項目（重複していても2項目にならない）'), JSON.stringify(v1.map(x => x[0])) === JSON.stringify(['iPhone の実機確認', '学校Windows PC の実機確認']), JSON.stringify(v1));
  check(L('完成判定：iPhoneは合格のまま（未記入の重複に妨げられない）'), v1[0]?.[1] === true);
  check(L('完成判定：学校Windows PCは未確認のまま（偽って合格にしない）'), v1[1]?.[1] === false);
  check(L('判定に入れていない欄があることを表示'), await waitText(page, '#view', '未記入の欄 1件は判定に入れていません'));
  check(L('実機確認の欄に重複のお知らせ（削除しない・元に戻せる）'), await waitText(page, '#dev-dup-note', '重複しています', 'iPhone', '学校Windows PC', '削除はしません'));
  check(L('「重複として整理」は未記入の欄だけ（合格の記録には出ない）'), (await page.$$('[data-dedupe]')).length === 3 && !(await page.$(`[data-dedupe="${ids.pass}"]`)));
  // 2件目（未記入の欄）を押すと編集画面が開く
  await page.click(`[data-dev="${ids.dups[0]}"]`);
  check(L('2件目のiPhoneを押すと編集画面が開く'), await page.waitForSelector('.modal #dvf', { timeout: 5000 }).then(() => true).catch(() => false) && await waitText(page, '.modal', '実機確認：iPhone'));
  await page.click('.modal [data-close]');
  await page.click(`[data-dev="${ids.pass}"]`);
  check(L('合格の記録も開ける（内容がそのまま表示）'), await page.waitForSelector('.modal #dvf').then(() => true).catch(() => false) && (await page.inputValue('.modal textarea[name=result]')) === '自動テスト 91/91 合格');
  await page.click('.modal [data-close]');
  // 見つからない記録を押したとき：黙らずに理由を表示
  await page.evaluate(() => { const b = document.querySelector('[data-dev]'); b.dataset.dev = 'missing-id'; });
  await page.click('[data-dev="missing-id"]');
  check(L('記録が見つからないときは理由を表示（黙って何もしない、をなくす）'), await page.waitForSelector('text=この記録が見つかりません', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.goto(BASE + '#/settings'); await page.goto(BASE + '#/v1'); await page.waitForSelector('#dev-card [data-dedupe]');
  // 画面の切り替えが重なっても、描き直しが続かない（v0.11.8：続くと押したボタンがすぐ消えて編集画面が開かなかった）
  const renders = await page.evaluate(() => new Promise(res => { let k = 0; const mo = new MutationObserver(ms => { k += ms.filter(m => m.target.id === 'view').length; }); mo.observe(document.getElementById('view'), { childList: true }); setTimeout(() => { mo.disconnect(); res(k); }, 3000); }));
  check(L('画面の切り替えが重なっても描き直しが続かない（3秒間で描き直し2回以下）'), renders <= 2, `${renders}回`);
  await page.screenshot({ path: `${OUT}/devdup-${label}-before.png`, fullPage: true });
  // iPhoneの重複を整理
  await page.click(`[data-dedupe="${ids.dups[0]}"]`);
  check(L('整理の前に確認（削除しない・元に戻せる・合格はそのまま）'), await waitText(page, '.modal', '削除はしません', '元に戻せます', '合格の記録はそのまま'));
  await page.click('.modal [data-a="1"]');
  check(L('整理すると一覧から外れ「重複として整理した欄」に移る'), await waitText(page, '#dev-marked', '重複として整理した欄（1件'));
  const after = await dbEval(page, `return { passJson: JSON.stringify(await db.get('checks', a.pass)), dup: (await db.get('checks', a.dups[0])) || null, total: (await db.all('checks')).length, trash: (await db.all('trash')).filter(t => t.store === 'checks').length, projects: (await db.all('projects')).length };`, ids);
  check(L('合格の記録は1文字も変わらない'), after.passJson === ids.passJson);
  check(L('整理した欄は削除されていない（件数同じ・ゴミ箱にも入れない）'), after.total === ids.total && after.trash === 0 && after.dup?.duplicateOf === ids.pass);
  check(L('8プロジェクトはそのまま'), after.projects === 8);
  // 元に戻す
  await page.click('#dev-marked summary'); await page.click(`[data-undupe="${ids.dups[0]}"]`);
  check(L('元に戻せる'), await page.waitForSelector(`[data-dedupe="${ids.dups[0]}"]`, { timeout: 5000 }).then(() => true).catch(() => false));
  check(L('横はみ出しなし'), !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(実機確認の重複): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });