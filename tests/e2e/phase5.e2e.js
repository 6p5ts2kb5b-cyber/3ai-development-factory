// Phase 5 画面操作テスト（3AI比較・個人情報チェック・コード/ファイル・URL要約・おすすめAI）
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const tab = async (page, name) => { await page.click(`.tabs a:has-text("${name}")`); await page.waitForSelector(`.tabs a[aria-current]:has-text("${name}")`); await page.waitForTimeout(150); };

async function scenario(label, ctxOpts, isMobile) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...ctxOpts, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to fetch|ERR_|net::|CORS|Access-Control/i.test(m.text())) errors.push(m.text()); });
  const L = s => `[${label}] ${s}`;
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  let overflowOk = true;
  const ov = async w => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { overflowOk = false; console.log('   overflow', w); } };

  await page.goto(BASE); await page.waitForSelector('.hero');
  // 準備：確定仕様v1.0のあるプロジェクト（仕様の操作はPhase 4で画面テスト済み）
  const pid = await page.evaluate(async () => {
    const { FactoryDB } = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js');
    const db = await FactoryDB.open('factory'); await loadMaster(db);
    const p = await db.create('projects', { name: 'Vintage Hunt', status: 'implementing', purpose: '古着探しを一元化' });
    const d = await db.createSpecDraft(p.id, { body: '# 仕様\n## 機能\n- 店舗登録' }); await db.fixSpec(d.id, {});
    await db.create('issues', { projectId: p.id, title: '検索が遅い', status: 'open', severity: 'high', occurredAt: '2026-10-04' });
    db.close(); return p.id;
  });
  const specBody = async () => page.evaluate(async id => { const { FactoryDB } = await import('./js/db.js'); const db = await FactoryDB.open('factory'); const s = await db.specsOf(id); db.close(); return JSON.stringify(s.map(x => [x.version, x.status, x.body, x.rev])); }, pid);
  const specBefore = await specBody();
  await page.goto(BASE + `#/p/${pid}/compare`); await page.waitForSelector('.reco');

  // 1. おすすめAI・役割
  check(L('次のおすすめAI（実装中→Claude、おすすめのみ）'), (await page.innerText('.reco')).includes('次のおすすめAI：Claude') && (await page.innerText('.reco')).includes('あなたが決めます'));
  await page.fill('#roles input[name=gemini]', 'Googleフォーム連携の担当');
  await page.click('#roles button.primary');
  await page.waitForSelector('text=役割を保存しました');
  check(L('役割を案件ごとに変更'), (await page.inputValue('#roles input[name=gemini]')) === 'Googleフォーム連携の担当');

  // 2. 相談作成（個人情報を含む内容）
  await page.click('a:has-text("＋ 新しい相談")');
  await page.waitForSelector('#ns');
  check(L('相談フォーム：現在の問題が未解決事項から入る'), (await page.inputValue('#ns textarea[name=problems]')).includes('検索が遅い'));
  await page.click('#ns button.primary');
  check(L('相談：テーマなしはエラー'), await page.waitForSelector('#ns-err >> text=「相談のテーマ」は必須です', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.fill('#ns input[name=topic]', '店舗データの保存方法');
  await page.fill('#ns textarea[name=question]', '田中君の保護者から依頼。店舗100件を速く検索したい。連絡先 090-1234-5678');
  await page.click('#ns button.primary');
  await page.waitForSelector('text=① 依頼文をコピー');
  await ov('相談');

  // 3. コピー（個人情報チェック：匿名化／確認／キャンセル）
  await page.click('[data-copy=chatgpt]');
  await page.waitForSelector('text=個人情報が含まれているかもしれません');
  const pm = await page.innerText('.modal');
  check(L('コピー前に警告（人名・電話番号）'), pm.includes('田中君') && pm.includes('090-1234-5678') && pm.includes('匿名化してコピー') && pm.includes('内容を確認する') && pm.includes('キャンセル'));
  await page.click('[data-sc=anon]');
  await page.waitForTimeout(300);
  const c1 = await clip();
  check(L('匿名化してコピー'), c1.includes('Aさん') && !c1.includes('田中') && !c1.includes('090-1234-5678') && c1.includes('店舗データの保存方法') && c1.includes('v1.0'));
  await page.click('[data-copy=claude]');
  await page.waitForSelector('[data-sc=review]');
  await page.click('[data-sc=review]');
  const ta = await page.inputValue('#sc-text');
  await page.fill('#sc-text', ta.replace('田中君の保護者から依頼。', '').replace('連絡先 090-1234-5678', ''));
  await page.waitForTimeout(100);
  check(L('内容を確認して直す（再チェックで問題なし表示）'), (await page.innerText('#sc-check')).includes('見つかりません'));
  await page.click('#sc-copy');
  await page.waitForTimeout(300);
  const c2 = await clip();
  check(L('確認した内容でコピー（Claude用の役割入り）'), !c2.includes('田中') && c2.includes('主実装') && c2.includes('Claude'));
  await page.evaluate(() => navigator.clipboard.writeText('（変更なし）'));
  await page.click('[data-copy=gemini]');
  await page.waitForSelector('[data-sc=anon]');
  await page.click('.modal [data-close]');
  await page.waitForTimeout(200);
  check(L('キャンセルするとコピーしない'), (await clip()) === '（変更なし）' && !(await page.innerText('[data-copy=gemini]')).includes('✓'));
  check(L('コピーした依頼文を記録（✓）'), (await page.innerText('[data-copy=chatgpt]')).includes('✓'));

  // 4. 回答を貼り付け
  for (const [ai, name, text] of [['chatgpt', 'ChatGPT', 'A案：IndexedDBに保存\n- 速い'], ['claude', 'Claude', 'B案：索引を作る\n- もっと速い'], ['gemini', 'Gemini', 'C案：スプレッドシート\n- 共有しやすい']]) {
    await page.click(`[data-paste-tab=${ai}]`);
    await page.fill(`[data-paste=${ai}] textarea[name=answer]`, text);
    await page.click(`[data-paste=${ai}] button`);
    await page.waitForSelector(`text=${name}の回答を保存しました`);
    await page.waitForTimeout(200);
  }
  check(L('3AIの回答を保存'), (await page.locator('.ai-col .ai-answer').count()) === 3);

  // 5. 比較表示
  const visibleCols = await page.locator('.ai-col:visible').count();
  if (isMobile) {
    check(L('スマホ：1つずつ表示（タブ切替）'), visibleCols === 1);
    await page.click('[data-cmp-tab=claude]');
    check(L('スマホ：Claudeに切替'), (await page.locator('.ai-col:visible').count()) === 1 && await page.isVisible('[data-col=claude]'));
  } else {
    check(L('PC：3列で並べて比較'), visibleCols === 3);
  }
  await page.screenshot({ path: `${OUT}/p5-${label}-compare.png`, fullPage: true });
  check(L('Factoryが勝手に判断していない'), !(await page.isVisible('.ai-col .badge.dec-adopt')));
  // 6. 判断（理由つき）
  const decide = async (ai, dec, why) => {
    if (isMobile) await page.click(`[data-cmp-tab=${ai}]`);
    await page.click(`[data-dec="${ai}:${dec}"]`);
    await page.fill('#dd textarea', why);
    await page.click('#dd button.primary');
    await page.waitForSelector('text=にしました'); await page.waitForTimeout(250);
  };
  await decide('claude', 'adopt', '一番速い');
  await decide('chatgpt', 'hold', 'あとで検討');
  await decide('gemini', 'reject', '個人情報の扱いが不安');
  if (isMobile) await page.click('[data-cmp-tab=claude]');
  const cc = await page.innerText('[data-col=claude]');
  check(L('判断・理由・判断日を表示'), cc.includes('判断：採用') && cc.includes('理由：一番速い') && /\d{4}-\d{2}-\d{2}/.test(cc));
  // 7. 採用案→要望箱
  await page.click('[data-toreq=claude]');
  await page.fill('#tr input[name=title]', '店舗データに索引を作る');
  await page.click('#tr button.primary');
  await page.waitForSelector('text=要望箱へ追加しました');
  await page.waitForTimeout(200);
  if (isMobile) await page.click('[data-cmp-tab=claude]');
  check(L('採用案を要望箱へ追加済み表示'), (await page.innerText('[data-col=claude]')).includes('要望箱へ追加済み'));
  if (isMobile) await page.click('[data-cmp-tab=gemini]');
  check(L('不採用の案には「要望箱へ追加」が出ない'), !(await page.isVisible('[data-toreq=gemini]')));
  // 8. 最終結論
  await page.fill('#final-t', 'Claude案（索引）を採用。ChatGPT案は保留');
  await page.click('#final button');
  await page.waitForSelector('text=最終結論を保存しました');
  await page.waitForTimeout(200);
  check(L('最終結論を記録'), (await page.inputValue('#final-t')).includes('Claude案') && (await page.innerText('#final')).includes('記録'));
  // 9. 要望箱・仕様書
  await tab(page, '要望箱');
  const rq = await page.innerText('ul.reqs');
  check(L('要望箱に「未検討」・出典つきで入る'), rq.includes('店舗データに索引を作る') && rq.includes('出典：3AI比較「店舗データの保存方法」') && (await page.inputValue('li:has-text("店舗データに索引を作る") .status-select')) === 'unreviewed');
  check(L('仕様書は直接変わらない（3AI比較）'), (await specBody()) === specBefore);

  // 10. コード／ファイル
  await tab(page, 'ファイル');
  await page.click('#add-file');
  await page.fill('#ff2 input[name=fileName]', 'index.html');
  await page.fill('#ff2 input[name=description]', 'トップ画面');
  await page.click('#ff2 summary');
  await page.fill('#ff2 input[name=language]', 'HTML');
  await page.fill('#ff2 textarea[name=code]', '<h1>v1</h1>');
  await page.click('#ff2 button.primary');
  await page.waitForSelector('text=保存しました');
  check(L('ファイル登録（関連仕様v1.0・最新版）'), (await page.innerText('.file-item')).includes('v1.0') && (await page.innerText('.file-item')).includes('仕様 v1.0') && (await page.innerText('.file-item')).includes('最新版'));
  await page.click('[data-newver]');
  check(L('新しいVersionの初期値 v1.1'), (await page.inputValue('#ff2 input[name=version]')) === 'v1.1');
  await page.fill('#ff2 textarea[name=code]', '<h1>v2</h1>');
  await page.click('#ff2 button.primary');
  await page.waitForSelector('text=最新版として登録しました');
  await page.waitForTimeout(200);
  const fi = await page.innerText('.file-item');
  check(L('Version変更→最新版はv1.1・旧版は残る'), fi.includes('v1.1') && fi.includes('最新版') && fi.includes('ほかのVersion 1件'));
  await page.click('.file-item summary');
  await page.click('.file-item details [data-view]');
  const vf = await page.innerText('.modal');
  check(L('旧版の中身を確認できる'), vf.includes('旧版') && vf.includes('<h1>v1</h1>') && vf.includes('v1.0'));
  await page.click('.modal [data-close]');
  await ov('ファイル');
  await page.screenshot({ path: `${OUT}/p5-${label}-files.png`, fullPage: true });

  // 11. URL要約
  await tab(page, 'URL');
  await page.fill('#ua-u', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.click('#ua button');
  await page.waitForSelector('#uf');
  check(L('URL登録（YouTubeと判定）'), (await page.innerText('#tab')).includes('YouTube') && (await page.innerText('#tab')).includes('おすすめ：Gemini'));
  await page.click('#u-fetch');
  await page.waitForFunction(() => !document.querySelector('#u-fetch-msg').textContent.includes('確認しています'), null, { timeout: 15000 });
  const fm = await page.innerText('#u-fetch-msg');
  check(L('取得できないURLは「取得できません」と表示'), fm.includes('取得できません') || fm.includes('取得しました'), fm);
  await page.click('#u-prompt');
  await page.waitForTimeout(300);
  check(L('AIへの要約依頼文をコピー'), (await clip()).includes('dQw4w9WgXcQ') && (await clip()).includes('活用案'));
  await page.fill('#uf input[name=title]', '古着の見分け方');
  await page.fill('#uf textarea[name=summary]', 'タグや縫製で年代を見分ける動画');
  await page.fill('#uf textarea[name=points]', '- タグを見る\n- 縫製を見る');
  await page.fill('#uf textarea[name=ideas]', 'タグから年代をメモできる機能');
  await page.click('#uf button.primary');
  await page.waitForSelector('text=保存しました');
  await page.waitForTimeout(200);
  check(L('要約・重要ポイント・活用案を保存'), (await page.inputValue('#uf textarea[name=points]')).includes('縫製を見る') && (await page.inputValue('#uf textarea[name=ideas]')).includes('タグから年代'));
  await page.click('#u-req');
  await page.waitForSelector('#ur');
  check(L('活用案が要望の初期値に入る'), (await page.inputValue('#ur input[name=title]')).includes('タグから年代をメモできる機能'));
  await page.click('#ur button.primary');
  await page.waitForSelector('text=要望箱へ追加しました');
  await page.waitForTimeout(200);
  check(L('URLのアイデアを要望箱へ'), (await page.innerText('#tab')).includes('要望箱へ追加済み'));
  check(L('仕様書は直接変わらない（URL）'), (await specBody()) === specBefore);
  await ov('URL');
  await page.screenshot({ path: `${OUT}/p5-${label}-url.png`, fullPage: true });

  // 12. 概要のおすすめAI・設定の役割
  await tab(page, '概要');
  check(L('概要に次のおすすめAI'), await page.isVisible('.reco'));
  await page.goto(BASE + '#/settings'); await page.waitForSelector('text=3AIの基本の役割');
  const st = await page.innerText('#view');
  check(L('設定で3AIの基本の役割を確認'), st.includes('要望整理・仕様統合・設計・最終チェック') && st.includes('主実装・コード・修正・技術設計') && st.includes('YouTube/動画理解'));

  check(L('横はみ出しなし'), overflowOk);
  check(L('JavaScriptエラーなし'), errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  await scenario('iphone', devices['iPhone 13'], true);
  await scenario('iphoneSE', devices['iPhone SE'], true);
  await scenario('pc', { viewport: { width: 1366, height: 860 } }, false);
  fs.writeFileSync(`${OUT}/e2e5-results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nE2E(Phase5): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
