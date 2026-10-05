// Phase 3 画面操作テスト（プロジェクト管理）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const cardOf = (page, name) => page.locator('.pcard', { has: page.locator('h2', { hasText: new RegExp('^' + name.replace(/[()（）]/g, '.') + '$') }) });
const tab = async (page, name) => { await page.click(`.tabs a:has-text("${name}")`); await page.waitForSelector(`.tabs a[aria-current]:has-text("${name}")`); await page.waitForTimeout(150); };
const openCard = async (page, name) => { await cardOf(page, name).locator('.pcard-link').click({ position: { x: 40, y: 22 } }); await page.waitForSelector('.tabs'); };

async function scenario(label, ctxOpts, isMobile) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  const noOverflow = async () => !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));
  const home = async () => { await page.goto(BASE); await page.waitForSelector('.hero'); };

  // 1. 新規作成（全項目）
  await home();
  await page.click('#new-project');
  await page.click('#pf button.primary');
  check(L('新規作成：名前が空だとエラー'), await page.isVisible('#pf-err >> text=「プロジェクト名」は必須です'));
  await page.fill('#pf input[name=name]', 'Vintage Hunt');
  await page.fill('#pf textarea[name=purpose]', '古着探しを一元化する');
  await page.fill('#pf input[name=targetUsers]', '自分');
  await page.check('#pf input[name=dev][value=iphone]');
  await page.check('#pf input[name=dev][value=pc]');
  await page.selectOption('#pf select[name=status]', 'spec_fixed');
  await page.selectOption('#pf select[name=deliverableType]', 'webapp');
  await page.fill('#pf input[name=firstTask]', '店舗データの項目を決める');
  await page.fill('#pf textarea[name=memo]', '最初の実案件');
  await page.click('#pf button.primary');
  await page.waitForSelector('.tabs a[aria-current]:has-text("概要")');
  const ov = await page.innerText('#tab');
  check(L('新規作成：目的・対象ユーザー・対象端末・状態・作る形・次作業・メモ・作成日時を表示'),
    ['古着探しを一元化する', '自分', 'iPhone・PC', '仕様確定', 'Webアプリ', '店舗データの項目を決める', '最初の実案件', '作成'].every(w => ov.includes(w)), ov.replace(/\n/g, ' / ').slice(0, 300));
  await page.screenshot({ path: `${OUT}/p3-${label}-overview.png`, fullPage: true });

  // 2. 次にやること（作業）
  await tab(page, '次にやること');
  await page.fill('#tk-t', 'フリマ情報の集め方を決める');
  await page.selectOption('#tk-p', 'low');
  await page.click('#tk button');
  await page.waitForSelector('li.task:has-text("フリマ情報の集め方")');
  await page.click('#tk button');
  check(L('作業：空では追加できない'), await page.isVisible('#tk-err >> text=「作業内容」は必須です'));
  await page.click('li.task:has-text("フリマ情報の集め方") [data-task]');
  await page.selectOption('#tf select[name=priority]', 'high');
  await page.selectOption('#tf select[name=status]', 'doing');
  await page.selectOption('#tf select[name=ai]', 'claude');
  await page.fill('#tf textarea[name=memo]', 'Instagramも確認');
  await page.click('#tf button.primary');
  await page.waitForSelector('text=保存しました');
  const tl = await page.innerText('ul.tasks');
  check(L('作業：優先度・状態・担当AI・メモを保存し優先順に並ぶ'), tl.indexOf('フリマ情報') < tl.indexOf('店舗データ') && tl.includes('進行中') && tl.includes('担当：Claude') && tl.includes('メモあり'), tl.replace(/\n/g, ' / '));
  await page.click('li.task:has-text("店舗データ") [data-done]');
  await page.waitForSelector('text=完了にしました');
  check(L('作業：完了は「完了」欄へ'), await page.isVisible('summary:has-text("完了 1件")'));

  // 3. 未解決事項
  await page.fill('#is-t', 'メルカリ検索の方法が未定');
  await page.selectOption('#is-s', 'high');
  await page.click('#is button');
  await page.waitForSelector('li:has-text("メルカリ検索の方法が未定")');
  await page.fill('#is-t', '地図の表示方法');
  await page.selectOption('#is-s', 'low');
  await page.click('#is button');
  await page.waitForSelector('li:has-text("地図の表示方法")');
  await page.click('li:has-text("地図の表示方法") [data-resolve]');
  await page.fill('#if textarea[name=resolution]', '無料の地図を使う');
  await page.click('#if button.primary');
  await page.waitForSelector('text=解決済みにしました');
  await page.click('summary:has-text("解決済み 1件")');
  const res = await page.innerText('ul.issues >> nth=1');
  check(L('未解決事項：重要度・発生日・解決内容・解決日が残る'), res.includes('軽微') && res.includes('発生 ') && res.includes('解決 ') && res.includes('無料の地図を使う'), res.replace(/\n/g, ' / '));
  await page.screenshot({ path: `${OUT}/p3-${label}-next.png`, fullPage: true });

  // ホームのカード：最優先の未完了作業
  await home();
  const ct = await cardOf(page, 'Vintage Hunt').innerText();
  check(L('ホーム：最優先の未完了作業（優先度付き）と未解決数'), ct.includes('フリマ情報の集め方を決める') && ct.includes('高') && /未解決\s*1/.test(ct), ct.replace(/\n/g, ' / '));

  // 4. プロジェクトB
  await page.click('#new-project');
  await page.fill('#pf input[name=name]', 'STORM予定管理');
  await page.fill('#pf input[name=firstTask]', '審判集合時間の扱いを決める');
  await page.click('#pf button.primary');
  await page.waitForSelector('.tabs');
  await tab(page, '次にやること');
  await page.fill('#is-t', 'グラウンド候補の整理');
  await page.click('#is button');
  await page.waitForSelector('li:has-text("グラウンド候補の整理")');
  await page.click('#p-add-req');
  await page.fill('#qr-form textarea[name=title]', '不足事項を最優先表示');
  await page.click('#qr-form button.primary');
  await page.waitForSelector('text=要望箱に入れました');
  await home();
  const bBefore = await cardOf(page, 'STORM予定管理').innerText();

  // 5. 編集（理由つき）
  await openCard(page, 'Vintage Hunt');
  await page.click('#edit-p');
  await page.fill('#pf input[name=targetUsers]', '自分と古着仲間');
  await page.fill('#pf input[name=reason]', '友人にも使ってもらう');
  await page.click('#pf button.primary');
  await page.waitForSelector('text=保存しました');
  check(L('編集：対象ユーザーの変更が反映'), (await page.innerText('#tab')).includes('自分と古着仲間'));

  // 6. 検索・絞り込み
  await home();
  await page.fill('#home-search input[name=q]', 'storm');
  await page.press('#home-search input[name=q]', 'Enter');
  await page.waitForFunction(() => location.hash.includes('q=storm'));
  await page.waitForTimeout(200);
  check(L('名前検索'), (await page.locator('.pcard').count()) === 1 && (await cardOf(page, 'STORM予定管理').count()) === 1);
  await page.click('text=条件を解除');
  await page.waitForTimeout(200);
  await page.click('.chips .chip:has-text("使用中")');
  await page.waitForTimeout(200);
  check(L('「使用中」で絞り込み（該当なし表示）'), await page.isVisible('text=条件に一致するプロジェクトはありません'));
  await page.click('.chips .chip:has-text("進行中")');
  await page.waitForTimeout(200);
  check(L('「進行中」で絞り込み'), (await page.locator('.pcard').count()) === 2);
  await page.click('#open-filter');
  await page.selectOption('#ff select[name=status]', 'spec_fixed');
  await page.selectOption('#ff select[name=updated]', 'today');
  await page.click('#ff button.primary');
  await page.waitForTimeout(200);
  check(L('詳しい絞り込み（ステータス＋最終更新）'), (await page.locator('.pcard').count()) === 1 && (await cardOf(page, 'Vintage Hunt').count()) === 1 && (await page.innerText('.filter-note')).includes('仕様確定'));
  await page.click('#open-filter');
  await page.click('#ff-clear');
  await page.waitForTimeout(200);
  await page.click('#open-filter');
  await page.selectOption('#ff select[name=sort]', 'name');
  await page.selectOption('#ff select[name=progress]', 'p0');
  await page.click('#ff button.primary');
  await page.waitForTimeout(200);
  const names = await page.locator('.pcard h2').allInnerTexts();
  check(L('完成度で絞り込み＋名前順'), names.length === 2 && names[0] === 'STORM予定管理', names.join(','));
  check(L('検索・絞り込み画面で横はみ出しなし'), await noOverflow());
  await page.screenshot({ path: `${OUT}/p3-${label}-filter.png` });
  await page.goto(BASE + '#/'); await page.waitForSelector('.pcard');

  // 7. 複製
  await openCard(page, 'Vintage Hunt');
  await page.click('#dup-p2');
  await page.check('#dup input[name=tasks]');
  await page.click('#dup button.primary');
  await page.waitForSelector('h1:has-text("Vintage Hunt（コピー）")');
  const dupOv = await page.innerText('#tab');
  check(L('複製：基本設定をコピーし状態は構想'), dupOv.includes('古着探しを一元化する') && dupOv.includes('自分と古着仲間') && dupOv.includes('構想') && dupOv.includes('複製元'));
  await tab(page, '次にやること');
  const dupNext = await page.innerText('#tab');
  check(L('複製：作業は未着手で複製、未解決事項（エラー履歴）は複製しない'), dupNext.includes('フリマ情報の集め方') && !dupNext.includes('進行中') && dupNext.includes('未解決事項はありません'), dupNext.replace(/\n/g, ' / '));
  await tab(page, '変更履歴');
  check(L('複製：元の変更履歴は持ち込まない'), !(await page.innerText('#tab')).includes('友人にも使ってもらう'));

  // 8. 削除（関連データごと）
  await home();
  await openCard(page, 'Vintage Hunt');
  await page.click('#del-p2');
  const delTxt = await page.innerText('.modal');
  check(L('削除確認：関連データの件数を表示'), delTxt.includes('関連データをまとめてゴミ箱へ') && delTxt.includes('次にやること：2件') && delTxt.includes('未解決事項：2件') && delTxt.includes('変更履歴'), delTxt.replace(/\n/g, ' / '));
  await page.click('#do-del');
  await page.waitForSelector('.hero');
  check(L('削除：ホームから消える'), (await cardOf(page, 'Vintage Hunt').count()) === 0);
  check(L('削除：他のプロジェクト（B）のカードは変わらない'), (await cardOf(page, 'STORM予定管理').innerText()) === bBefore);
  check(L('削除：複製したプロジェクトは残る'), (await cardOf(page, 'Vintage Hunt（コピー）').count()) === 1);

  // 9. ゴミ箱→復元
  await page.goto(BASE + '#/trash');
  const tr = await page.innerText('li:has-text("Vintage Hunt")');
  check(L('ゴミ箱：関連データ件数つきで1件にまとまる'), /関連データ\d+件・履歴\d+件/.test(tr) && (await page.locator('.list li').count()) === 1, tr.replace(/\n/g, ' / '));
  await page.click('li:has-text("Vintage Hunt") [data-restore]');
  await page.waitForSelector('text=元に戻しました');
  await home();
  const restored = await cardOf(page, 'Vintage Hunt').innerText();
  check(L('復元：関連データ（最優先作業・未解決数）も戻る'), restored.includes('フリマ情報の集め方を決める') && /未解決\s*1/.test(restored), restored.replace(/\n/g, ' / '));
  await openCard(page, 'Vintage Hunt');
  await tab(page, '変更履歴');
  const hist = await page.innerText('#tab');
  check(L('復元：変更履歴も戻り、復元の記録が残る'), hist.includes('友人にも使ってもらう') && hist.includes('元に戻す'), hist.replace(/\n/g, ' / ').slice(0, 400));

  // 10. 完全削除（明確な確認）
  await tab(page, '概要');
  await page.click('#del-p2');
  await page.click('#do-del');
  await page.waitForSelector('.hero');
  await page.goto(BASE + '#/trash');
  await page.click('li:has-text("Vintage Hunt") [data-purge]');
  const pm = await page.innerText('.modal');
  check(L('完全削除：「このプロジェクトと関連データを完全に削除します。元に戻せません」と表示'), pm.includes('このプロジェクトと関連データを完全に削除します。元に戻せません'));
  check(L('完全削除：確認チェック前はボタンを押せない'), await page.isDisabled('#do-purge'));
  await page.click('.modal [data-close]');
  check(L('完全削除：やめるとゴミ箱に残る'), (await page.locator('li:has-text("Vintage Hunt")').count()) === 1);
  await page.click('li:has-text("Vintage Hunt") [data-purge]');
  await page.check('#purge-ok');
  await page.click('#do-purge');
  await page.waitForSelector('text=ゴミ箱は空です');
  check(L('完全削除：ゴミ箱から消える'), true);
  await home();
  check(L('完全削除後もBと複製は無事'), (await cardOf(page, 'STORM予定管理').innerText()) === bBefore && (await cardOf(page, 'Vintage Hunt（コピー）').count()) === 1);

  // 11. 再読込でも保持
  await page.reload(); await page.waitForSelector('.pcard');
  check(L('再読込後も保持'), (await page.locator('.pcard').count()) === 2);

  // 12. 表示
  for (const h of ['#/', '#/trash', '#/settings']) { await page.goto(BASE + h); await page.waitForTimeout(200); if (!(await noOverflow())) check(L('はみ出し ' + h), false); }
  await page.goto(BASE); await page.waitForSelector('.pcard');
  await page.screenshot({ path: `${OUT}/p3-${label}-home.png`, fullPage: true });
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  await scenario('iphone', devices['iPhone 13'], true);
  await scenario('iphoneSE', devices['iPhone SE'], true);
  await scenario('pc', { viewport: { width: 1366, height: 860 } }, false);
  fs.writeFileSync(`${OUT}/e2e3-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase3): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
