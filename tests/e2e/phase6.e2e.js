// Phase 6 画面操作テスト（テスト管理・完成度・完成条件・実機/公開確認・引継ぎ・v1完成判定）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 15000 }).then(() => true).catch(() => false);
const tab = async (page, name) => { await page.click(`.tabs a:has-text("${name}")`); await page.waitForSelector(`.tabs a[aria-current]:has-text("${name}")`); await page.waitForTimeout(200); };

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

  // 1. 新規作成（共通テスト付き）
  await page.goto(BASE); await page.waitForSelector('.hero');
  await page.click('#new-project');
  check(L('新規作成に「共通テストを登録」（初期ON）'), await page.isChecked('#pf input[name=withTests]'));
  await page.fill('#pf input[name=name]', 'Vintage Hunt');
  await page.fill('#pf textarea[name=purpose]', '古着探しを一元化');
  await page.click('#pf button.primary');
  await page.waitForSelector('.tabs');
  const pid = await page.evaluate(() => location.hash.split('/')[2]);
  await tab(page, 'テスト');
  check(L('共通テスト16項目が登録される'), (await page.innerText('.sum-chips')).includes('必須 16件'));

  // 2. 不合格→エラー→修正→再テスト→合格
  await page.click('a.url-row:has-text("保存")');
  await page.waitForSelector('[data-act=run]');
  await page.click('[data-act=run]');
  await page.check('#rd input[value=fail]');
  await page.click('#rd button.primary');
  check(L('不合格はエラー内容が必須'), await page.waitForSelector('#rd-err >> text=エラー内容を書いてください', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.fill('#rd textarea[name=error]', '保存ボタンで画面が固まる');
  await page.fill('#rd textarea[name=actual]', '固まった');
  await page.click('#rd button.primary');
  await page.waitForSelector('text=不合格を記録しました');
  await page.waitForTimeout(200);
  check(L('不合格を記録（状態・エラー表示）'), (await page.innerText('.spec-head')).includes('不合格') && (await page.innerText('#tab')).includes('保存ボタンで画面が固まる'));
  await page.click('[data-act=task]');
  await page.click('#tt button.primary');
  await page.waitForSelector('text=「次にやること」に追加しました');
  await page.waitForTimeout(200);
  await page.click('[data-act=fix]');
  await page.fill('#fd textarea[name=fix]', '保存処理の待ち時間を修正');
  await page.click('#fd button.primary');
  await page.waitForSelector('text=修正内容を記録しました');
  await page.waitForTimeout(200);
  check(L('修正記録→再テスト待ち'), (await page.innerText('.spec-head')).includes('再テスト待ち'));
  await page.click('[data-act=retest]');
  await page.check('#rd input[value=pass]');
  await page.click('#rd button.primary');
  await page.waitForSelector('text=合格を記録しました');
  await page.waitForTimeout(200);
  const hist = await page.innerText('.timeline');
  check(L('合格後も過去の不合格・エラー・修正の履歴が残る'), (await page.innerText('.spec-head')).includes('合格') && hist.includes('実施：不合格') && hist.includes('保存ボタンで画面が固まる') && hist.includes('修正内容：保存処理の待ち時間を修正') && hist.includes('再テスト：合格'), hist.replace(/\n/g, ' / ').slice(0, 200));
  await page.screenshot({ path: `${OUT}/p6-${label}-test.png`, fullPage: true });
  await tab(page, '次にやること');
  check(L('不合格から「次にやること」へ（確認して追加）'), (await page.innerText('ul.tasks')).includes('テスト不合格を修正：保存'));

  // 3. テスト項目の追加・削除
  await tab(page, 'テスト');
  await page.click('#add-test');
  await page.fill('#tf6 input[name=testName]', '古着の写真登録');
  await page.uncheck('#tf6 input[name=required]');
  await page.fill('#tf6 textarea[name=expected]', '写真が表示される');
  await page.click('#tf6 button.primary');
  await page.waitForSelector('text=追加しました');
  await page.waitForTimeout(200);
  await page.click('[data-act=del]'); await page.click('[data-a="1"]');
  await page.waitForSelector('text=ゴミ箱へ移しました');
  await page.waitForTimeout(200);
  check(L('テスト項目を追加・削除できる'), (await page.innerText('.sum-chips')).includes('必須 16件') && !(await page.innerText('#tab')).includes('古着の写真登録'));
  await ov('テスト');

  // 4. 完成度（自動/手入力）・完成の条件
  await tab(page, '完成度');
  const pg = await page.innerText('#tab');
  check(L('完成度8項目（自動・手入力を表示）'), ['1. 企画', '2. 仕様', '3. UI', '4. データ', '5. 実装', '6. テスト', '7. 解説/引継ぎ', '8. 公開/使用開始'].every(w => pg.includes(w)) && pg.includes('自動') && pg.includes('手入力') && pg.includes('必須テスト 1/16 合格'));
  check(L('手入力はUI・データ・実装（ファイル未登録）だけ'), (await page.locator('#pg select').count()) === 3);
  await page.selectOption('#ax-ui', '60');
  await page.click('#pg button.primary');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(200);
  const cond = await page.innerText('#cond-card');
  check(L('完成の条件と足りないものを日本語で表示'), cond.includes('あと') && cond.includes('確定した仕様書がありません') && cond.includes('合格していない必須テストが15件') && cond.includes('実機確認が登録されていません'));
  // 5. 完成にしようとすると止められる／使用可能にはできる
  await tab(page, '概要');
  await page.click('#edit-p');
  await page.selectOption('#pf select[name=status]', 'complete');
  await page.click('#pf button.primary');
  await page.waitForSelector('#pf-err .notice.ng');
  const ce = await page.innerText('#pf-err');
  check(L('条件不足で「完成」にできない（理由つき）'), ce.includes('「完成」にできません') && ce.includes('最新の確定仕様がある') && ce.includes('必要な実機確認が完了'));
  await page.selectOption('#pf select[name=status]', 'usable');
  await page.click('#pf button.primary');
  await page.waitForSelector('text=保存しました');
  check(L('「使用可能」にはできる'), await waitText(page, '.p-meta', '使用可能'));

  // 6. 条件を満たしていく
  await dbRun(`const d = await db.createSpecDraft(a, { body: '# 仕様' }); await db.fixSpec(d.id, {});
    for (const t of await db.byIndex('tests', 'projectId', a)) if (t.status !== 'pass') await db.recordTestRun(t.id, { result: 'pass' });
    await db.create('issues', { projectId: a, title: 'データが消える', severity: 'high', status: 'open', occurredAt: '2026-10-04' });`, pid);
  await tab(page, '引継ぎ');
  await page.fill('#phf textarea[name=implemented]', '店舗登録・検索');
  await page.fill('#phf textarea[name=nextSteps]', '地図の追加');
  await page.fill('#phf textarea[name=notes]', '個人情報は入れない');
  await page.click('#phf button.primary');
  await page.waitForSelector('text=引継ぎを保存しました');
  await page.waitForTimeout(200);
  await tab(page, '完成度');
  await page.click('[data-chk=add-default]');
  await page.waitForSelector('text=端末を登録しました');
  await page.waitForTimeout(200);
  await page.click('[data-dev] >> nth=0');
  await page.selectOption('#dvf select[name=status]', 'pass');
  await page.fill('#dvf textarea[name=result]', '全合格');
  await page.click('#dvf button.primary');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(200);
  check(L('実機確認を記録（状態・確認日・結果）'), (await page.innerText('#dev-card')).includes('合格') && /確認日 \d{4}-\d{2}-\d{2}/.test(await page.innerText('#dev-card')) && (await page.innerText('#dev-card')).includes('全合格'));
  { const okc = await waitText(page, '#cond-card', '重要度「重要」の未解決事項が1件', '自宅PC（未確認）'); check(L('重大問題・実機確認未完了が理由として残る'), okc, okc ? '' : (await page.innerText('#cond-card')).replace(/\n/g, ' / ').slice(0, 900)); }
  let cond2;
  await dbRun(`for (const c of await db.checksOf(a, 'device')) await db.update('checks', c.id, { status: 'pass', checkedAt: '2026-10-04' });`, pid);
  await tab(page, '概要');
  await page.click('#edit-p');
  await page.selectOption('#pf select[name=status]', 'complete');
  await page.click('#pf button.primary');
  await page.waitForSelector('#pf-err .notice.ng');
  check(L('重大問題ありでは「完成」にできない'), (await page.innerText('#pf-err')).includes('未解決の重大な問題が0件'));
  await page.click('#pf [data-close]');
  await dbRun(`for (const i of await db.byIndex('issues', 'projectId', a)) await db.update('issues', i.id, { status: 'resolved', resolution: '修正', resolvedAt: new Date().toISOString() });`, pid);
  await tab(page, '完成度');
  cond2 = await page.innerText('#cond-card');
  check(L('すべての条件を満たす表示'), cond2.includes('すべて満たしています') && !cond2.includes('⬜'));
  await page.screenshot({ path: `${OUT}/p6-${label}-progress.png`, fullPage: true });
  await tab(page, '概要');
  await page.click('#edit-p');
  await page.selectOption('#pf select[name=status]', 'complete');
  await page.click('#pf button.primary');
  await page.waitForSelector('text=保存しました');
  check(L('すべて満たすと「完成」にできる'), (await page.innerText('.p-meta')).includes('完成'));

  // 7. プロジェクト別引継ぎの出力
  await tab(page, '引継ぎ');
  await page.click('#ph-copy');
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(L('引継ぎをコピー（Version・状態・テスト・実機確認・次の作業）'), ['# 引継ぎ：Vintage Hunt', '現在Version：v1.0', '現在ステータス：完成', '店舗登録・検索', '必須テスト 16/16 合格', 'iPhone：合格', '地図の追加', '個人情報は入れない'].every(w => clip.includes(w)));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ph-md')]);
  check(L('引継ぎをMarkdownで保存'), dl.suggestedFilename() === 'Vintage_Hunt_handoff.md');
  await ov('引継ぎ');

  // 8. Factory全体の引継ぎ
  await page.goto(BASE + '#/handoff'); await page.waitForSelector('text=Factory全体の引継ぎ');
  const fh = await page.innerText('#view');
  check(L('Factory全体の引継ぎ（Phase・テスト結果・実機確認・ルール）'), fh.includes('各Phaseの状態とテスト結果') && fh.includes('Phase 5') && fh.includes('実機確認状況（Factory本体）') && fh.includes('学校Windows PC：未確認') && fh.includes('重要な設計ルール'));
  await page.click('#copy-md');
  await page.waitForTimeout(300);
  check(L('Factory全体の引継ぎをコピー'), (await page.evaluate(() => navigator.clipboard.readText())).includes('## 次Phase'));

  // 9. v1完成判定
  await page.goto(BASE); await page.waitForSelector('.v1-strip');
  await page.click('.v1-strip');
  await page.waitForSelector('.v1-head');
  const v1 = await page.innerText('#view');
  check(L('v1完成まで あとN項目・7案件・実機確認・公開を一覧'), /あと \d+ 項目/.test(v1) && v1.includes('7案件の登録') && v1.includes('1/7 件登録') && v1.includes('iPhone の実機確認') && v1.includes('公開（GitHub Pages）の確認') && v1.includes('👉'));
  const before = Number((v1.match(/あと (\d+) 項目/) || [])[1]);
  await page.click('[data-dev] >> nth=0');
  await page.selectOption('#dvf select[name=status]', 'pass');
  await page.click('#dvf button.primary');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(250);
  const after = Number(((await page.innerText('.v1-head')).match(/あと (\d+) 項目/) || [])[1]);
  check(L('Factory本体の実機確認を記録すると残り項目が減る'), after === before - 1, `${before}→${after}`);
  await page.click('[data-chk=add-pub]');
  await page.fill('#pbf input[name=target]', 'https://example.github.io/factory/');
  await page.selectOption('#pbf select[name=environment]', '学校のネットワーク');
  await page.selectOption('#pbf select[name=access]', 'school_blocked');
  await page.click('#pbf button.primary');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(250);
  const v1b = await page.innerText('#view');
  check(L('学校で開けない場合は「学校ネットワークで利用不可」と区別'), v1b.includes('学校ネットワークで利用不可（公開の失敗ではありません）'));
  await ov('v1');
  await page.screenshot({ path: `${OUT}/p6-${label}-v1.png`, fullPage: true });

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/e2e6-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase6): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
