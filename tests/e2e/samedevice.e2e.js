// v0.11.9 同じ端末のまとめ：「学校Windows PC」と「学校Windows PC（Surface・Edge）」
// 自動ではまとめない → 利用者が確認して押したときだけ、合格の記録を参照する。記録は削除・変更しない。解除できる
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 15000 }).then(() => true).catch(() => false);
const dbEval = (page, src, arg) => page.evaluate(async ([s, a]) => { const M = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js'); const db = await M.FactoryDB.open('factory'); await loadMaster(db); const r = await (new Function('db', 'M', 'a', `return (async () => { ${s} })()`))(db, M, a); db.close(); return r; }, [src, arg]);
const v1State = page => page.evaluate(() => ({ left: document.querySelector('.v1-left')?.innerText || '', items: [...document.querySelectorAll('.cond li')].map(li => [li.querySelector('strong').innerText, li.classList.contains('ok'), li.innerText]).filter(([t]) => t.includes('の実機確認')) }));

async function scenario(label, opts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  await page.goto(BASE); await page.waitForSelector('.hero'); await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(400);
  // 実際の状態：iPhone合格・「学校Windows PC」未記入（同期でそろった重複つき）・「学校Windows PC（Surface・Edge）」合格（2026-10-05）
  const ids = await dbEval(page, `
    const have = await db.checksOf(M.FACTORY_ID, 'device');
    const ip = have.find(d => d.device === 'iPhone'), school = have.find(d => d.device === '学校Windows PC');
    await db.update('checks', ip.id, { status: 'pass', checkedAt: '2026-10-08', result: '自動テスト 91/91 合格' }, {});
    const dup = await db.create('checks', { projectId: M.FACTORY_ID, kind: 'device', device: '学校Windows PC', order: 2, status: 'unchecked', result: '', checkedAt: null }, { actor: 'Factory' });
    const surface = await db.create('checks', { projectId: M.FACTORY_ID, kind: 'device', device: '学校Windows PC（Surface・Edge）', status: 'pass', checkedAt: '2026-10-05', result: '自動テスト 全項目合格' }, {});
    return { school: school.id, dup: dup.id, surface: surface.id, surfaceJson: JSON.stringify(await db.get('checks', surface.id)), schoolJson: JSON.stringify(await db.get('checks', school.id)), total: (await db.all('checks')).length };`);
  await page.goto(BASE + '#/v1'); await page.waitForSelector('#dev-card');
  let st = await v1State(page);
  const leftBefore = Number((st.left.match(/(\d+)/) || [])[1]);
  check(L('まとめる前：「学校Windows PC」は未確認のまま（名前が似ているだけでは合格にしない）'), st.items.some(([t, ok]) => t === '学校Windows PC の実機確認' && !ok), JSON.stringify(st.items.map(x => [x[0], x[1]])));
  check(L('「同じ端末としてまとめる」の提案（押すまでまとめない）'), await page.locator(`[data-same="${ids.school}"]`).isVisible() && await waitText(page, `[data-same="${ids.school}"]`, '学校Windows PC（Surface・Edge）', '同じ端末としてまとめる'));
  check(L('合格の記録には提案を出さない'), !(await page.$(`[data-same="${ids.surface}"]`)));
  await page.click(`[data-same="${ids.school}"]`);
  check(L('まとめる前に確認（同じ端末のときだけ・どちらも削除・変更しない・解除できる）'), await waitText(page, '.modal', '同じ端末', 'ときだけ', '2026-10-05', '削除・変更しません', '解除'));
  // いったん「やめる」→ 何も変わらない
  await page.click('.modal-back [data-a="0"]');
  await page.waitForSelector('.modal-back', { state: 'detached' });
  check(L('「やめる」なら何も変わらない'), (await dbEval(page, `return (await db.get('checks', a.school)).sameAs || null;`, ids)) === null);
  await page.click(`[data-same="${ids.school}"]`); await page.click('.modal [data-a="1"]');
  await page.waitForSelector('text=同じ端末としてまとめました');
  await page.waitForFunction(() => document.querySelector('.cond'));
  st = await v1State(page);
  const school = st.items.find(([t]) => t.includes('学校Windows PC'));
  check(L('まとめた後：学校の端末は1項目で合格（Surface・Edgeの合格記録を参照）'), st.items.filter(([t]) => t.includes('学校Windows PC')).length === 1 && school?.[1] === true && school[2].includes('2026-10-05') && school[2].includes('同じ端末としてまとめた記録：学校Windows PC'), JSON.stringify(st.items.map(x => [x[0], x[1]])));
  check(L('v1完成まで：残りが1項目減る'), Number((st.left.match(/(\d+)/) || [])[1]) === leftBefore - 1 || /すべて満たしています/.test(st.left), `${leftBefore} → ${st.left}`);
  check(L('iPhoneの合格はそのまま'), st.items.some(([t, ok]) => t === 'iPhone の実機確認' && ok));
  const after = await dbEval(page, `return { surface: JSON.stringify(await db.get('checks', a.surface)), school: await db.get('checks', a.school), total: (await db.all('checks')).length, trash: (await db.all('trash')).filter(t => t.store === 'checks').length, projects: (await db.all('projects')).length };`, ids);
  check(L('合格の記録（Surface・Edge）は1文字も変わらない'), after.surface === ids.surfaceJson);
  check(L('まとめた側も「未確認」のまま（合格に書き換えない）・つなぎ先だけ記録'), after.school.status === 'unchecked' && !after.school.result && after.school.sameAs === ids.surface);
  check(L('削除していない（件数同じ・ゴミ箱にも入れない）・8プロジェクトはそのまま'), after.total === ids.total && after.trash === 0 && after.projects === 8);
  // 編集画面にも「同じ端末の記録」
  await page.click(`[data-dev="${ids.school}"]`);
  check(L('編集画面に「同じ端末の記録」（選んだ相手が表示される）'), await page.waitForSelector('.modal select[name=sameAs]').then(() => true).catch(() => false) && (await page.inputValue('.modal select[name=sameAs]')) === ids.surface);
  await page.screenshot({ path: `${OUT}/same-${label}-form.png` });
  await page.click('.modal [data-close]');
  await page.screenshot({ path: `${OUT}/same-${label}-linked.png`, fullPage: true });
  // 解除
  await page.click(`[data-unsame="${ids.school}"]`); await page.waitForSelector('text=まとめを解除しました'); await page.waitForTimeout(300);
  st = await v1State(page);
  check(L('解除すると元どおり（「学校Windows PC」は未確認に戻る）'), st.items.some(([t, ok]) => t === '学校Windows PC の実機確認' && !ok));
  const renders = await page.evaluate(() => new Promise(res => { let k = 0; const mo = new MutationObserver(ms => { k += ms.filter(m => m.target.id === 'view').length; }); mo.observe(document.getElementById('view'), { childList: true }); setTimeout(() => { mo.disconnect(); res(k); }, 2000); }));
  check(L('描き直しが続かない'), renders <= 1, `${renders}回`);
  // v0.11.10：編集画面で保存して確認日が入った「未確認」の記録でも、提案ボタンが出て、まとめると合格になる
  await dbEval(page, `await db.update('checks', a.school, { checkedAt: '2026-10-09', sameAs: null }, {}); await db.update('checks', a.dup, { checkedAt: '2026-10-09' }, {});`, ids);
  await page.goto(BASE + '#/settings'); await page.goto(BASE + '#/v1'); await page.waitForSelector('#dev-card'); await page.waitForTimeout(300);
  st = await v1State(page);
  check(L('確認日が入った未確認：まとめる前は未確認のまま・まとめ方を表示'), st.items.some(([t, ok, txt]) => t === '学校Windows PC の実機確認' && !ok && txt.includes('同じ端末としてまとめる')));
  check(L('確認日が入った未確認にも「同じ端末としてまとめる」が出る'), !!(await page.$(`[data-same="${ids.school}"]`)));
  // 編集画面の「同じ端末の記録」で選んで保存
  await page.click(`[data-dev="${ids.school}"]`); await page.waitForSelector('.modal select[name=sameAs]');
  await page.selectOption('.modal select[name=sameAs]', ids.surface); await page.click('.modal button.primary');
  await page.waitForSelector('text=保存しました'); await page.waitForTimeout(400);
  st = await v1State(page);
  check(L('編集画面で同じ端末を選んで保存すると、学校の端末は合格（確認日が入っていても）'), st.items.filter(([t]) => t.includes('学校Windows PC')).length === 1 && st.items.some(([t, ok]) => t.includes('学校Windows PC') && ok), JSON.stringify(st.items.map(x => [x[0], x[1]])));
  const after2 = await dbEval(page, `return { surface: JSON.stringify(await db.get('checks', a.surface)), school: await db.get('checks', a.school), total: (await db.all('checks')).length };`, ids);
  check(L('合格の記録は変わらない・学校の記録は未確認のまま・削除しない'), after2.surface === ids.surfaceJson && after2.school.status === 'unchecked' && after2.total === ids.total);
  check(L('横はみ出しなし'), !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  // 実機確認の欄の中の文字・ボタンが欄の外にはみ出さない（まとめた状態でも確認）
  // （直前の確認で、すでに同じ端末としてまとめた状態）
  await page.waitForSelector(`[data-unsame="${ids.school}"]`);
  check(L('まとめた状態でも、実機確認の欄の中身がはみ出さない'), await page.evaluate(() => { const card = document.querySelector('#dev-card').getBoundingClientRect(); return [...document.querySelectorAll('#dev-card *')].every(e => { const r = e.getBoundingClientRect(); return !r.width || r.right <= card.right + 1; }) && document.documentElement.scrollWidth <= innerWidth + 1; }));
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(同じ端末のまとめ): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
