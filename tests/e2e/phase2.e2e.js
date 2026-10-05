// Phase 2 画面操作テスト
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const cardOf = (page, name) => page.locator('.pcard', { has: page.locator('h2', { hasText: name }) });

async function scenario(label, ctxOpts, isMobile) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  const noOverflow = async () => !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));

  // 空の状態
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  check(L('空のホームに案内と「話すだけ」入口'), await page.isVisible('text=まだプロジェクトがありません') && await page.isVisible('.hero >> text=話すだけで相談'));
  // 要望：プロジェクトが無いときは案内
  await page.click('#home-add-req');
  check(L('プロジェクト無しで要望追加→案内表示'), await page.waitForSelector('text=要望を入れるプロジェクトがまだありません', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.click('.modal [data-close] >> nth=0');

  // Factory自身を登録
  await page.click('#seed-factory');
  await page.waitForSelector('.tabs');
  check(L('Factory自身を登録→プロジェクト画面'), await page.isVisible('h1:has-text("3AI Development Factory")'));

  // 話すだけ → 保存 → 依頼文 → プロジェクト化
  await page.click('.tabbar a[href="#/talk"]');
  await page.waitForSelector('#talk-form');
  await page.click('#talk-form button');
  check(L('話すだけ：空入力はエラー'), await page.isVisible('text=「やりたいこと」は必須です'));
  await page.fill('textarea[name=text]', '古着屋とフリマを週末に回れるように、スマホで店とイベントを管理したい');
  await page.click('#talk-form button');
  await page.waitForSelector('text=作る形の提案');
  check(L('話すだけ：作る形を提案'), await page.isVisible('text=おすすめ：Webアプリ'));
  check(L('話すだけ：個人情報の注意なし（不要な警告を出さない）'), !(await page.isVisible('text=送る前に確認してください')));
  await page.click('button[data-copy="claude"] >> nth=-1');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(L('話すだけ：Claude用依頼文をコピー'), clip.includes('古着屋とフリマ') && clip.includes('まだコードは書かないでください'));
  await page.selectOption('#chosen-type', 'webapp');
  await page.fill('#mk-project input[name=name]', 'Vintage Hunt');
  await page.click('#mk-project button');
  await page.waitForSelector('.tabs');
  check(L('相談→プロジェクト化（状態：構想）'), await page.isVisible('.p-head >> text=構想'));
  await page.screenshot({ path: `${OUT}/p2e-${label}-overview.png` });

  // 9タブ全部が開ける
  const tabs = ['概要', '仕様書', '完成度', '次にやること', '要望箱', '3AI比較', 'ファイル', 'テスト', '変更履歴'];
  let allTabs = true;
  for (const t of tabs) {
    await page.click(`.tabs a:has-text("${t}")`);
    await page.waitForTimeout(150);
    const cur = await page.textContent('.tabs a[aria-current]');
    if (!cur.startsWith(t) || await page.isVisible('.notice.ng')) { allTabs = false; console.log('   tab ng', t, cur); }
    if (!(await noOverflow())) { allTabs = false; console.log('   overflow', t); }
  }
  check(L('カードから9画面すべてに移動できる'), allTabs);

  // 次にやること・未解決事項
  await page.click('.tabs a:has-text("次にやること")');
  // Phase 3で「次にやること」は作業データになったため、作業を追加し、最初の作業を完了にする
  await page.fill('#tk-t', '店舗データの項目を決める');
  await page.click('#tk button');
  await page.waitForSelector('li.task:has-text("店舗データの項目を決める")');
  await page.click('li.task:has-text("3AIに依頼文") [data-done]');
  await page.waitForSelector('text=完了にしました');
  await page.fill('#is-t', 'メルカリの検索方法が未定');
  await page.click('#is button');
  await page.waitForSelector('li:has-text("メルカリの検索方法が未定")');

  // ホームのカード表示（7項目）
  await page.click('.tabbar a[href="#/"]');
  await page.waitForSelector('.pcard');
  const card = cardOf(page, 'Vintage Hunt');
  const ct = await card.innerText();
  const has = ['Vintage Hunt', '構想', '完成度', '店舗データの項目を決める', '未解決', '要望', '今日'].every(w => ct.includes(w));
  check(L('カードに名前・状態・完成度・次・未解決・要望・最終更新'), has, has ? '' : ct.replace(/\n/g, ' / '));
  check(L('カードの未解決数＝1'), (await card.locator('.stat.alert b').innerText()) === '1');
  check(L('「次にやること」がホームで0タップで見える'), await card.locator('.next').isVisible());
  check(L('ホーム横はみ出しなし'), await noOverflow());

  // 要望追加：カードの＋要望 → 入力 → 保存（2タップ＋入力）
  await card.locator('[data-add-req]').click();
  await page.fill('#qr-form textarea[name=title]', '地図で行った店を色分けしたい');
  await page.click('#qr-form button.primary');
  await page.waitForSelector('text=要望箱に入れました');
  check(L('要望追加：2タップ＋入力で完了、カードの要望数が1に'), (await cardOf(page, 'Vintage Hunt').locator('.stat >> nth=1').innerText()).includes('1'));
  // 空の要望はエラー
  await page.click('#home-add-req');
  await page.waitForSelector('#qr-form');
  await page.screenshot({ path: `${OUT}/p2e-${label}-modal.png` });
  await page.click('#qr-form button.primary');
  const blocked = await page.evaluate(() => !document.querySelector('#qr-form textarea').checkValidity());
  check(L('要望追加：空のままでは保存できない'), blocked && await page.isVisible('#qr-form'));
  await page.click('#qr-form [data-close]');

  // カードをタップ→概要（1タップ）
  await cardOf(page, 'Vintage Hunt').locator('.pcard-link').click({ position: { x: 40, y: 22 } });
  await page.waitForSelector('.tabs a[aria-current]:has-text("概要")');
  check(L('カード1タップでプロジェクト概要'), true);
  // カードの「次」→次にやること（1タップ）
  await page.click('.tabbar a[href="#/"]');
  await page.waitForSelector('.pcard');
  await cardOf(page, 'Vintage Hunt').locator('.next').click();
  await page.waitForSelector('.tabs a[aria-current]:has-text("次にやること")');
  check(L('カードの「次」1タップで次にやること画面'), true);
  // 未解決→解決
  await page.click('[data-resolve]');
  await page.fill('#if textarea[name=resolution]', '公式の検索URLを使う');
  await page.click('#if button.primary');
  await page.waitForSelector('text=未解決事項はありません');
  check(L('未解決事項を解決済みにできる'), true);

  // 要望の状態変更（採用）→仕様は変わらない
  await page.click('.tabs a:has-text("要望箱")');
  await page.selectOption('.status-select', 'adopted');
  await page.waitForSelector('#dc'); // Phase 4：判断の理由を記録するダイアログ
  await page.click('#dc button.primary');
  await page.waitForSelector('text=「採用」にしました');
  const specCount = await page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const d = await FactoryDB.open('factory'); const n = await d.count('specs'); d.close(); return n; });
  check(L('要望を「採用」しても仕様書は変わらない'), specCount === 0);

  // 完成ガード（画面）
  await page.click('.tabs a:has-text("概要")');
  await page.click('#edit-p');
  await page.selectOption('#pf select[name=status]', 'complete');
  await page.click('#pf button.primary');
  await page.waitForSelector('#pf-err .notice.ng');
  check(L('テスト未合格では画面から「完成」にできない'), await page.isVisible('text=「完成」にできません'));
  await page.selectOption('#pf select[name=status]', 'spec_draft');
  await page.fill('#pf input[name=reason]', '要望を整理し始めた');
  await page.click('#pf button.primary');
  await page.waitForSelector('text=保存しました');

  // 完成度の手動入力
  await page.click('.tabs a:has-text("完成度")');
  // Phase 6 で「企画」「仕様」は実データから自動計算になったため、手入力の「UI」「データ」で確認する
  await page.selectOption('#ax-ui', '100');
  await page.selectOption('#ax-data', '60');
  await page.click('#pg button');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(300);
  const meta = await page.textContent('.p-meta');
  const pct = Number((meta.match(/完成度\s*(\d+)%/) || [])[1]);
  check(L('完成度を保存→表示に反映'), pct > 0 && (await page.inputValue('#ax-ui')) === '100' && (await page.inputValue('#ax-data')) === '60', meta);

  // 変更履歴
  await page.click('.tabs a:has-text("変更履歴")');
  const ht = await page.innerText('.timeline');
  check(L('変更履歴にいつ・誰・何・なぜ'), ht.includes('要望を整理し始めた') && ht.includes('状態：構想 → 仕様整理') && ht.includes('要望を変更'));
  await page.screenshot({ path: `${OUT}/p2e-${label}-history.png`, fullPage: true });

  // 全体の要望箱
  await page.click('.tabbar a[href="#/requests"]');
  await page.waitForSelector('text=地図で行った店を色分けしたい');
  await page.click('.chip:has-text("不採用")');
  await page.waitForSelector('text=要望はまだありません');
  check(L('全体の要望箱：状態で絞込み'), true);

  // 削除→ゴミ箱→復元
  await page.click('.tabbar a[href="#/"]');
  await cardOf(page, 'Vintage Hunt').locator('.pcard-link').click({ position: { x: 40, y: 22 } });
  await page.click('#del-p2');
  await page.click('#do-del');
  await page.waitForSelector('.hero');
  check(L('プロジェクト削除（確認あり）→ホームから消える'), (await cardOf(page, 'Vintage Hunt').count()) === 0);
  await page.goto(BASE + '#/trash');
  await page.click('li:has-text("Vintage Hunt") [data-restore]');
  await page.waitForSelector('text=元に戻しました');
  await page.goto(BASE);
  await page.waitForSelector('.pcard');
  check(L('ゴミ箱から復元→カードと要望数が戻る'), (await cardOf(page, 'Vintage Hunt').count()) === 1 && (await cardOf(page, 'Vintage Hunt').innerText()).includes('要望 1'));

  // 再読込でも保持
  await page.reload(); await page.waitForSelector('.pcard');
  check(L('再読込後もカードが残る'), (await page.locator('.pcard').count()) === 2);
  await page.screenshot({ path: `${OUT}/p2e-${label}-home.png`, fullPage: true });

  // レイアウト
  if (isMobile) {
    check(L('スマホ：下部メニュー4つ（PC専用項目は非表示）'), (await page.locator('.tabbar a:visible').count()) === 4);
  } else {
    const box = await page.locator('.tabbar').boundingBox();
    check(L('PC：左メニュー表示'), box && box.x === 0 && box.width >= 200 && box.height > 400 && (await page.locator('.tabbar a:visible').count()) === 6);
  }
  // 各画面で横はみ出しなし
  let ok = true;
  for (const h of ['#/', '#/talk', '#/requests', '#/settings', '#/backup', '#/handoff', '#/system', '#/trash']) {
    await page.goto(BASE + h); await page.waitForTimeout(250);
    if (!(await noOverflow())) { ok = false; console.log('   overflow', h); }
  }
  check(L('全画面で横はみ出しなし'), ok);
  // 印刷
  await page.goto(BASE); await page.waitForSelector('.pcard');
  await page.emulateMedia({ media: 'print' });
  check(L('印刷時はメニュー・ボタン類を隠す'), !(await page.isVisible('.tabbar')) && !(await page.isVisible('.hero')));
  await page.emulateMedia({ media: 'screen' });

  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  await scenario('iphone', devices['iPhone 13'], true);
  await scenario('iphoneSE', devices['iPhone SE'], true);
  await scenario('pc', { viewport: { width: 1366, height: 860 } }, false);
  fs.writeFileSync(`${OUT}/e2e2-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase2): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
