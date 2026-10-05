// Phase 4 画面操作テスト（仕様書Version管理・要望箱→仕様反映・変更履歴・出力）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const tab = async (page, name) => { await page.click(`.tabs a:has-text("${name}")`); await page.waitForSelector(`.tabs a[aria-current]:has-text("${name}")`); await page.waitForTimeout(150); };

async function scenario(label, ctxOpts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  const noOverflow = async () => !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));
  let overflowOk = true;
  const ov = async where => { if (!(await noOverflow())) { overflowOk = false; console.log('   overflow', where); } };

  await page.goto(BASE); await page.waitForSelector('.hero');
  await page.click('#new-project');
  await page.fill('#pf input[name=name]', 'Vintage Hunt');
  await page.fill('#pf textarea[name=purpose]', '古着探しを一元化する');
  await page.click('#pf button.primary');
  await page.waitForSelector('.tabs');
  const pid = await page.evaluate(() => location.hash.split('/')[2]);

  // 1. 仕様書作成 → 編集 → 差分 → v1.0確定
  await tab(page, '仕様書');
  check(L('仕様書なしの案内'), await page.isVisible('text=仕様書はまだありません'));
  await page.click('#new-spec');
  await page.waitForSelector('#ed');
  const body = await page.inputValue('#ed textarea[name=body]');
  check(L('v1.0の変更案（ひな形入り）'), (await page.inputValue('#ed input[name=version]')) === 'v1.0' && body.includes('## 画面構成') && body.includes('古着探しを一元化する'));
  await page.fill('#ed textarea[name=body]', body.replace('## 機能\n', '## 機能\n- 店舗を登録できる\n- フリマを探せる\n'));
  await ov('編集');
  await page.click('#ed-diff');
  await page.waitForSelector('.diff');
  check(L('差分確認（初版はすべて追加）'), (await page.innerText('.sum-chips')).includes('＋追加'));
  await ov('差分');
  await page.screenshot({ path: `${OUT}/p4-${label}-diff-v10.png`, fullPage: true });
  await page.click('#go-fix');
  check(L('確定：確認チェック前は押せない'), await page.isDisabled('#fx-btn'));
  check(L('確定：「変更・削除できなくなります」と警告'), (await page.innerText('.modal')).includes('変更・削除できなくなります'));
  await page.check('#fx-ok');
  await page.click('#fx-btn');
  await page.waitForSelector('text=最新の確定仕様 v1.0');
  check(L('v1.0確定'), await page.isVisible('.viewing >> text=🔒 確定'));

  // 2. 確定版の編集・削除は警告
  await page.click('.viewing [data-act=edit]');
  const w1 = await page.innerText('.modal');
  check(L('確定版を編集しようとすると明確な警告'), w1.includes('確定したVersionは直接編集できません') && w1.includes('v1.0 で確定した内容が失われ'));
  await page.click('.modal [data-close]');
  await page.click('.viewing [data-act=delete]');
  check(L('確定版を削除しようとすると明確な警告'), (await page.innerText('.modal')).includes('確定したVersionは削除できません'));
  await page.click('.modal [data-close]');
  check(L('警告後も内容は残る'), (await page.innerText('.spec-body')).includes('店舗を登録できる'));

  // 3. 要望登録 → 判断（採用・不採用・保留・取りやめ）
  await tab(page, '要望箱');
  for (const t of ['地図で店を表示', '周遊ルートを提案', '有料APIで在庫取得', '来年の機能']) {
    await page.fill('#rq-t', t); await page.click('#rq button'); await page.waitForSelector(`li:has-text("${t}")`);
  }
  const decide = async (title, status, why) => {
    await page.selectOption(`li:has-text("${title}") .status-select`, status);
    await page.waitForSelector('#dc');
    if (why) await page.fill('#dc textarea', why);
    await page.click('#dc button.primary');
    await page.waitForSelector(`text=にしました`);
    await page.waitForTimeout(150);
  };
  await page.selectOption('li:has-text("地図で店を表示") .status-select', 'rejected');
  await page.waitForSelector('#dc');
  await page.click('#dc [data-close]');
  check(L('判断をやめると状態が元に戻る'), (await page.inputValue('li:has-text("地図で店を表示") .status-select')) === 'unreviewed');
  await decide('地図で店を表示', 'adopted', '一番使う機能');
  await decide('周遊ルートを提案', 'adopted', '');
  await decide('有料APIで在庫取得', 'rejected', '無料で実現できないため');
  await decide('来年の機能', 'on_hold', 'Phase 7のあとに再検討');
  const rl = await page.innerText('ul.reqs');
  check(L('不採用・保留も消えず、判断・理由・判断日が残る'), rl.includes('有料APIで在庫取得') && rl.includes('理由：無料で実現できないため') && rl.includes('理由：Phase 7のあとに再検討') && /判断：保留（\d{4}-\d{2}-\d{2}）/.test(rl), rl.replace(/\n/g, ' / '));
  // 4. 採用しただけでは仕様は変わらない
  await tab(page, '仕様書');
  check(L('採用しただけでは仕様書は変わらない（変更案なし）'), !(await page.isVisible('.draft-card')) && !(await page.innerText('.spec-body')).includes('地図で店を表示'));
  // 5. まとめ反映
  await tab(page, '要望箱');
  check(L('採用済みだけ選択できる'), (await page.locator('[data-pick]').count()) === 2);
  await page.check('li:has-text("地図で店を表示") [data-pick]');
  await page.check('li:has-text("周遊ルートを提案") [data-pick]');
  check(L('選択数と反映先Versionを表示'), (await page.innerText('#reflect-bar')).includes('2件を選択中') && (await page.innerText('#reflect-bar')).includes('v1.1候補へ反映'));
  await page.screenshot({ path: `${OUT}/p4-${label}-reflect.png` });
  await page.click('#reflect-bar button');
  await page.waitForSelector('.draft-card');
  const dc = await page.innerText('.draft-card');
  check(L('2件まとめて変更案 v1.1 へ'), dc.includes('変更案 v1.1') && dc.includes('地図で店を表示') && dc.includes('周遊ルートを提案') && dc.includes('（2件）'));
  check(L('確定版v1.0はそのまま'), !(await page.innerText('.viewing .spec-body')).includes('地図で店を表示'));
  // 6. 差分 → 確定
  await page.click('.draft-card a:has-text("差分を確認")');
  await page.waitForSelector('.diff');
  const dt = await page.innerText('.diff');
  check(L('差分：追加された要望を「変更後」に表示'), dt.includes('地図で店を表示') && dt.includes('＋追加'));
  await page.uncheck('#only');
  check(L('差分：全体表示に切り替え'), (await page.innerText('.diff')).includes('店舗を登録できる'));
  await page.screenshot({ path: `${OUT}/p4-${label}-diff-v11.png`, fullPage: true });
  await page.click('#go-fix');
  check(L('確定：理由が変更案から引き継がれる'), (await page.inputValue('#fx textarea[name=reason]')).includes('要望2件を反映'));
  await page.check('#fx-ok');
  await page.click('#fx-btn');
  await page.waitForSelector('text=最新の確定仕様 v1.1');
  const vl = await page.innerText('.versions');
  check(L('v1.1確定・v1.0も一覧に残る'), vl.includes('v1.1') && vl.includes('v1.0') && !(await page.isVisible('.draft-card')));
  await page.click('.versions a:has-text("v1.0")');
  await page.waitForSelector('text=過去の確定仕様 v1.0');
  check(L('v1.0の内容をいつでも確認できる'), !(await page.innerText('.spec-body')).includes('地図で店を表示') && (await page.innerText('.spec-body')).includes('店舗を登録できる'));
  // 7. 要望とVersionの関連
  await tab(page, '要望箱');
  const rl2 = await page.innerText('ul.reqs');
  check(L('要望に「v1.1 に反映済み」'), (rl2.match(/v1\.1 に反映済み/g) || []).length === 2);
  // 8. 変更履歴
  await tab(page, '変更履歴');
  const ht = await page.innerText('.timeline');
  check(L('変更履歴：旧/新Version・理由・変更内容・元の要望・確定者'), ht.includes('仕様 v1.0 → v1.1 を確定') && ht.includes('変更理由：要望2件を反映') && ht.includes('変更内容：追加') && ht.includes('元になった要望：') && ht.includes('が確定'), ht.slice(0, 300).replace(/\n/g, ' / '));
  // 9. 出力
  await tab(page, '仕様書');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.viewing [data-act=md]')]);
  const f = `${OUT}/p4-${label}-spec.md`; await dl.saveAs(f);
  const mdText = fs.readFileSync(f, 'utf8');
  check(L('仕様書をMarkdownで保存'), dl.suggestedFilename() === 'Vintage_Hunt_spec_v1.1.md' && mdText.includes('Version：v1.1') && mdText.includes('地図で店を表示'), dl.suggestedFilename());
  await page.click('.viewing [data-act=copy]');
  check(L('仕様書をコピー'), (await page.evaluate(() => navigator.clipboard.readText())).includes('v1.1'));
  // 10. 移行用指示書
  await page.click('a:has-text("移行用指示書を開く")');
  await page.waitForSelector('#gf');
  const gp = await page.innerText('pre.md');
  check(L('指示書：17項目と確定仕様'), gp.includes('## 1. 目的') && gp.includes('## 17. 次に実装すること') && gp.includes('確定Version：v1.1') && gp.includes('v1.0 → v1.1'));
  await page.fill('#gf textarea[name=urls]', 'https://example.github.io/vintage/');
  await page.click('#gf button.primary');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(200);
  check(L('指示書：追記が反映'), (await page.innerText('pre.md')).includes('https://example.github.io/vintage/'));
  await page.click('#g-save');
  await page.waitForSelector('text=移行用指示書 第1版');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#g-md')]);
  const f2 = `${OUT}/p4-${label}-guide.md`; await dl2.saveAs(f2);
  check(L('指示書：版の保存とMarkdown保存'), fs.readFileSync(f2, 'utf8').includes('# Factory移行用指示書：Vintage Hunt'));
  await ov('指示書');
  await page.screenshot({ path: `${OUT}/p4-${label}-guide.png` });
  // 11. ホームのカードは確定版
  await page.goto(BASE); await page.waitForSelector('.pcard');
  check(L('ホームのカードに確定Version'), (await page.innerText('.pcard')).includes('仕様 v1.1'));
  await page.goto(BASE + `#/p/${pid}/spec`); await page.waitForSelector('.viewing');
  await ov('仕様書');
  await page.screenshot({ path: `${OUT}/p4-${label}-spec.png`, fullPage: true });

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  await scenario('iphone', devices['iPhone 13']);
  await scenario('iphoneSE', devices['iPhone SE']);
  await scenario('pc', { viewport: { width: 1366, height: 860 } });
  fs.writeFileSync(`${OUT}/e2e4-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase4): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
