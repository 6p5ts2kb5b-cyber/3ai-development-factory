// v1.1.0 確定仕様との照合：判定候補JSONの一括反映（STORM 36項目）
// 確認画面 → 要手動対応の確認 → 既存判定の保持 → 取り消し → 確定 → 結果表示。データを消さない・既存判定を上書きしない
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const OUT = process.env.SHOTS || path.join(__dirname, 'shots');
const BASE = 'http://localhost:8765/';
const FIX = path.join(__dirname, '..', 'fixtures', 'storm-36-proposal.json');
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, info); };
const waitText = (page, sel, ...words) => page.waitForFunction(([s, w]) => { const el = document.querySelector(s); return el && w.every(x => el.innerText.includes(x)); }, [sel, words], { timeout: 15000 }).then(() => true).catch(() => false);
const dbEval = (page, src, arg) => page.evaluate(async ([s, a]) => { const M = await import('./js/db.js'); const { loadMaster } = await import('./js/master.js'); const L = await import('./js/logic.js'); const db = await M.FactoryDB.open('factory'); await loadMaster(db); const r = await (new Function('db', 'M', 'L', 'a', `return (async () => { ${s} })()`))(db, M, L, a); db.close(); return r; }, [src, arg]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
const variant = (name, fn) => { const j = JSON.parse(fs.readFileSync(FIX, 'utf8')); const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(fn(j))); return f; };

async function scenario(label, opts) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const requests = []; page.on('request', r => { const u = new URL(r.url()); if (u.hostname !== 'localhost') requests.push(u.hostname); });
  const L = s => `[${label}] ${s}`;
  await page.goto(BASE); await page.waitForSelector('.hero'); await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(400);
  // 既存の判定：3番＝未実装（メモあり）
  const info = await dbEval(page, `
    const p = (await db.all('projects')).find(x => x.name === 'STORM／連合チーム予定管理');
    await db.setOrigin(p.id, 'existing');
    const spec = await db.latestFixedSpec(p.id); const items = L.specItems(spec.body);
    await db.setCoverage(p.id, items[2].key, 'todo', { memo: '自分で確認：スマホ表示が崩れる' });
    return { id: p.id, keys: items.map(i => i.key), all: JSON.stringify((await db.all('projects')).map(x => [x.id, x.name])), specs: (await db.all('specs')).length, hist: (await db.all('history')).length };`);
  const projBefore = info.all;
  await page.goto(BASE + `#/p/${info.id}/existing`); await page.waitForSelector('#ci-open');
  check(L('照合画面に「JSONから判定候補を読み込み」'), await page.isVisible('#ci-open'));
  // 別プロジェクトのJSON → 拒否
  await page.setInputFiles('#ci-file', variant('wrong.json', j => ({ ...j, project_name: 'Vintage Hunt' })));
  check(L('別プロジェクトのJSONは読み込まない（何も変更しない）'), await waitText(page, '#ci-errors', '読み込めません', '別のプロジェクト'));
  await page.setInputFiles('#ci-file', variant('ver.json', j => ({ ...j, spec_version: 'v2.0' })));
  check(L('別の版のJSONは読み込まない'), await waitText(page, '#ci-errors', '確定仕様の版が違います'));
  // 本物のJSON
  await page.setInputFiles('#ci-file', FIX);
  await page.waitForSelector('#ci-review');
  check(L('確認画面：対応済み34・要手動対応2・既存判定あり1・上書き対象0/1'), await waitText(page, '#ci-counts', '対応済み 34', '要手動対応 2', '対応できない 0', '既存判定あり 1', '上書き対象 0／1'));
  check(L('暫定判定であることを表示'), await waitText(page, '#ci-review', '暫定', '実機で動作を確認したという意味ではありません'));
  check(L('JSONの判定：実装済み17・一部7・未判定12 を表示'), await waitText(page, '#ci-expected', '実装済み17', '一部実装済み7', '未判定12'));
  check(L('要手動対応が残っている間は確定できない'), await page.isDisabled('#ci-apply') && await waitText(page, '#ci-stop', '要手動対応の行が 2件'));
  check(L('9番：似ている別の項目（29番）と所属セクションを表示'), await waitText(page, '[data-ci-row="9"]', '［画面構成］', '［保存データ］3校の学校予定', '29番'));
  check(L('3番：既存の判定（未実装・メモあり）は保持が既定'), await waitText(page, '[data-ci-row="3"]', '既存の判定：未実装', 'メモあり', '既存の判定を保持'));
  // 取り消し → 何も保存しない
  const rev0 = await dbEval(page, `return (await db.get('projects', a)).rev;`, info.id);
  await page.click('#ci-cancel');
  check(L('取り消すと確認画面を閉じ、何も保存しない'), !(await page.$('#ci-review')) && (await dbEval(page, `return (await db.get('projects', a)).rev;`, info.id)) === rev0);
  // もう一度読み込み → 確認 → 確定
  await page.setInputFiles('#ci-file', FIX); await page.waitForSelector('#ci-review');
  await page.check('[data-ci-confirm="9"]'); await page.waitForTimeout(100); await page.check('[data-ci-confirm="17"]'); await page.waitForTimeout(100);
  check(L('確認すると確定できる・反映後（予定）＝実装済み16・一部7・未実装1・未判定12（既存の3番は保持）'), await page.isEnabled('#ci-apply') && await waitText(page, '#ci-expected', '反映後のFactory（予定）：実装済み16', '一部実装済み7', '未実装1', '未判定12'));
  await page.screenshot({ path: `${OUT}/ci-${label}-review.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ci-backup')]);
  check(L('「先にバックアップを保存」でバックアップファイル'), /\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await page.click('#ci-apply');
  check(L('確定の前に最後の確認（件数・既存は保持・失敗時は何も変えない）'), await waitText(page, '.modal', '36項目の反映を確定しますか', '23件', '既存の判定 1件はそのまま', '何も変更しません'));
  await page.click('.modal-back [data-a="0"]'); await page.waitForTimeout(200);
  check(L('最後の確認でキャンセルしても保存しない'), (await dbEval(page, `return (await db.get('projects', a)).rev;`, info.id)) === rev0);
  await page.click('#ci-apply'); await page.click('.modal-back [data-a="1"]');
  check(L('反映後に結果を表示（JSONの判定・反映後のFactory）'), await waitText(page, '#ci-result', '判定候補JSONを反映しました', '未判定へ反映 23件', '上書き 0件', '既存の判定を保持 1件', 'JSONの判定：実装済み17', '反映後のFactory：実装済み16'));
  const after = await dbEval(page, `const p = await db.get('projects', a.id); const c = p.existing.coverage; return { s3: c[a.keys[2]].status, m3: c[a.keys[2]].memo, s9: c[a.keys[8]]?.status || 'unjudged', s17: c[a.keys[16]].status, s5memo: c[a.keys[4]].memo, all: JSON.stringify((await db.all('projects')).map(x => [x.id, x.name])), specs: (await db.all('specs')).length };`, info);
  check(L('既存の判定とメモ（3番）は上書きしない'), after.s3 === 'todo' && after.m3 === '自分で確認：スマホ表示が崩れる');
  check(L('確認した17番は実装済み・9番はJSONも未判定のまま'), after.s17 === 'done' && after.s9 === 'unjudged');
  check(L('根拠と「実機動作確認済みではありません」をメモに記録'), after.s5memo.includes('実機動作確認済みではありません') && after.s5memo.includes('activities'));
  check(L('8プロジェクト・仕様書は消えない'), after.all === projBefore && after.specs === info.specs);
  check(L('照合の一覧に件数が反映（実装済み16・一部7・未実装1・未判定12）'), await waitText(page, '#cov-card', '実装済み 16', '一部 7', '未実装 1', '未判定 12'));
  check(L('照合の一覧に「判定候補JSON・暫定」とメモ'), await waitText(page, '#cov-card', '判定候補JSON・暫定'));
  await page.screenshot({ path: `${OUT}/ci-${label}-done.png` });
  // スクリプト入りのJSON → 文字として表示するだけ（実行しない）
  await page.setInputFiles('#ci-file', variant('xss.json', j => ({ ...j, records: j.records.map(r => r.number === 1 ? { ...r, spec_label: '桜・浅羽野・住吉 連合チーム<img src=x onerror="window.__pwned=1">' } : r) })));
  await page.waitForSelector('#ci-review, #ci-errors'); await page.waitForTimeout(300);
  check(L('スクリプト入りのJSONは実行しない（文字として表示）'), (await page.evaluate(() => typeof window.__pwned)) === 'undefined' && !(await page.$('#ci-review img')));
  await page.click('#ci-cancel').catch(() => {});
  check(L('Factoryの外（STORM本番・Supabase等）へ接続しない'), requests.length === 0, [...new Set(requests)].join(','));
  // お知らせ（トースト）が縦に引き伸ばされない
  await page.evaluate(async () => { const { toast } = await import('./js/ui.js'); toast('テストのお知らせ'); });
  const th = await page.$eval('.toast', e => e.getBoundingClientRect().height).catch(() => 0);
  check(L('お知らせは1〜2行の高さ（縦に引き伸ばされない）'), th > 0 && th < 120, `${Math.round(th)}px`);
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
  console.log(`\nE2E(判定候補JSONの一括反映): ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
