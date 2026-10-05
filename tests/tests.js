// Phase 1 自動テスト（テスト専用DB「factory-test」で実行）
import { FactoryDB, DATA_STORES, STORES, SCHEMA_VERSION } from '../js/db.js';
import { FactoryError } from '../js/schema.js';
import { loadMaster } from '../js/master.js';
import { toMarkdown, HANDOFF_FIELDS, loadHandoff } from '../js/handoff.js';
import { isSyncable } from '../js/sync/adapter.js';
import { summarizeProjects, computeProgress, suggestDeliverable, privacyCheck, buildPrompts, compareVersion, filterProjects, topTask, sortTasks, sortIssues } from '../js/logic.js';
import { createProject } from '../js/views/projectForm.js';
import { diffLines, diffSummary } from '../js/diff.js';
import { specToMarkdown, buildGuide, GUIDE_SECTIONS } from '../js/guide.js';
import { nextVersion } from '../js/logic.js';
import { findPersonalInfo, anonymize } from '../js/privacy.js';
import { buildComparePrompt, recommendAI, aiRoles, detectUrlKind, groupFiles, buildUrlPrompt } from '../js/ai.js';
import { completionItems } from '../js/logic.js';
import { FACTORY_ID } from '../js/db.js';
import { projectHandoffMarkdown, collectHandoff } from '../js/views/phandoff.js';
import { v1Items } from '../js/views/v1.js';
import { PROJECT_CHILD_STORES } from '../js/db.js';
import { loadInitialProjects, seedInitialProjects, seedStatus, seededCount } from '../js/seed.js';
import { specItems, coverageSummary } from '../js/logic.js';

const TEST_DB = 'factory-test';
const T = [];
const test = (name, fn) => T.push({ name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}（期待：${JSON.stringify(b)} / 実際：${JSON.stringify(a)}）`);
async function rejects(p, msg) {
  try { await p; } catch (e) { return e; }
  throw new Error(msg);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const delDB = name => new Promise((res, rej) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res; });

let db, ctx = {};

// ---------------- テスト項目 ----------------
test('設定値：config/master.json を読み込み、正式ステータス8種が順番通り', async () => {
  const m = await loadMaster(db);
  eq(m.statuses.map(s => s.label), ['構想', '仕様整理', '仕様確定', '実装中', 'テスト中', '使用可能', '完成', '改良中'], 'ステータス');
  eq(m.requestStatuses.map(s => s.label), ['未検討', '採用', '保留', '不採用', '実装済み'], '要望の状態');
  eq(m.progressAxes.length, 8, '完成度メーターの軸');
  assert((await db.get('settings', 'master'))?.value?.masterVersion === m.masterVersion, '設定値が端末内に保存されていない');
});

test('新規登録：共通項目（ID・作成/更新日時・作成者/更新者）が自動で付く', async () => {
  const p = await db.create('projects', { name: 'テスト案件A', status: 'concept', purpose: '古着探し' }, { reason: 'テスト登録' });
  ctx.p = p;
  for (const k of ['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']) assert(p[k], `${k} がありません`);
  eq(p.createdBy, 'テスト担当', '作成者');
  eq(p.rev, 1, 'rev');
  eq(p.localOnly, false, 'localOnly 既定値');
});

test('保存：全ての保存先（プロジェクト関連12種類＋設定・引継ぎ）に登録できる', async () => {
  const pid = ctx.p.id;
  await db.create('specs', { projectId: pid, version: 'v1.0', body: '初版' });
  await db.create('requests', { projectId: pid, title: '地図表示を追加', status: 'unreviewed' });
  await db.create('compares', { projectId: pid, topic: '保存方式', answers: { chatgpt: 'A案', claude: 'B案', gemini: 'C案' } });
  await db.create('files', { projectId: pid, fileName: 'index.html', type: 'HTML', version: 'v1.0', ai: 'claude' });
  await db.create('tests', { projectId: pid, item: '新規登録', result: 'untested' });
  await db.create('urls', { url: 'https://example.com/', summary: '例' });
  await db.create('handoff', { id: 'h1', note: 'x' });
  await db.create('issues', { projectId: pid, title: '未解決のテスト', status: 'open' });
  await db.create('ideas', { text: 'こんなアプリが欲しい', status: 'new' });
  await db.create('tasks', { projectId: pid, title: '最初の作業', priority: 'high', status: 'todo', ai: 'user' });
  await db.create('guides', { projectId: pid, gversion: 1, markdown: '# 指示書' });
  await db.create('checks', { projectId: pid, kind: 'device', device: 'iPhone', status: 'unchecked' });
  for (const s of DATA_STORES) assert(await db.count(s) >= 1, `${s} に保存されていない`);
});

test('再読込：データベースを閉じて開き直してもデータが残る', async () => {
  db.close();
  db = await FactoryDB.open(TEST_DB);
  db.actor = 'テスト担当';
  await loadMaster(db);
  const p = await db.get('projects', ctx.p.id);
  eq(p?.name, 'テスト案件A', '再読込後のプロジェクト名');
});

test('編集：更新日時・更新者・rev が変わり、作成日時は変わらない', async () => {
  await sleep(5);
  const u = await db.update('projects', ctx.p.id, { name: 'テスト案件A改', status: 'spec_draft', createdAt: '改ざん' }, { actor: 'Claude', reason: '名称変更のテスト' });
  eq(u.name, 'テスト案件A改', '名前');
  eq(u.createdAt, ctx.p.createdAt, '作成日時は不変');
  eq(u.createdBy, 'テスト担当', '作成者は不変');
  eq(u.updatedBy, 'Claude', '更新者');
  eq(u.rev, 2, 'rev');
  assert(u.updatedAt > ctx.p.updatedAt, '更新日時が新しくなっていない');
});

test('変更履歴：いつ・誰が・何を・なぜ が記録される', async () => {
  const h = await db.historyOf(ctx.p.id);
  const upd = h.find(x => x.action === 'update');
  assert(upd, '更新の履歴がない');
  assert(upd.at && upd.actor === 'Claude' && upd.reason === '名称変更のテスト', 'いつ/誰/なぜ が不足');
  eq(upd.changes.name, { from: 'テスト案件A', to: 'テスト案件A改' }, '何を（変更前後）');
  assert(!upd.changes.createdAt, '共通項目が差分に混ざっている');
  assert(h.some(x => x.action === 'create'), '作成の履歴がない');
});

test('検索/絞込み：文字検索と条件絞込みができる', async () => {
  await db.create('projects', { name: 'STORM予定', status: 'concept' });
  await db.create('projects', { name: '野球部会計', status: 'concept' });
  eq((await db.query('projects', { text: 'storm', fields: ['name'] })).map(r => r.name), ['STORM予定'], '文字検索（大文字小文字無視）');
  eq((await db.query('projects', { where: { status: 'concept' } })).length, 2, '状態で絞込み');
  eq((await db.query('projects', { text: '存在しない名前' })).length, 0, '該当なし');
  eq((await db.byIndex('requests', 'projectId', ctx.p.id)).length, 1, 'プロジェクト別');
});

test('削除確認：削除するとゴミ箱へ移り、一覧から消える', async () => {
  const r = (await db.query('projects', { text: '野球部会計' }))[0];
  ctx.trashId = await db.remove('projects', r.id, { reason: 'テスト削除' });
  ctx.removedId = r.id;
  assert(!(await db.get('projects', r.id)), '削除後も残っている');
  const t = await db.get('trash', ctx.trashId);
  eq(t?.record?.name, '野球部会計', 'ゴミ箱の中身');
  assert((await db.historyOf(r.id)).some(x => x.action === 'delete'), '削除の履歴がない');
});

test('復元：ゴミ箱から元に戻せる（内容・作成日時も元通り）', async () => {
  const before = (await db.get('trash', ctx.trashId)).record;
  const r = await db.restore(ctx.trashId);
  eq(r.name, '野球部会計', '名前');
  eq(r.createdAt, before.createdAt, '作成日時');
  assert(await db.get('projects', ctx.removedId), '戻っていない');
  assert(!(await db.get('trash', ctx.trashId)), 'ゴミ箱に残っている');
});

test('誤入力：必須未入力・選択肢外・形式違いは保存されない', async () => {
  const n = await db.count('projects');
  let e = await rejects(db.create('projects', { name: '   ', status: 'concept' }), '空の名前が保存された');
  assert(e instanceof FactoryError && e.details.some(d => d.includes('プロジェクト名')), '分かりやすいエラー文がない');
  await rejects(db.create('projects', { name: 'X', status: 'できた' }), '存在しないステータスが保存された');
  await rejects(db.create('specs', { projectId: ctx.p.id, version: '1' }), 'Version形式違いが保存された');
  await rejects(db.create('urls', { url: 'javascript:alert(1)' }), '不正なURLが保存された');
  await rejects(db.update('projects', ctx.p.id, { name: '' }), '編集で名前を空にできてしまう');
  eq(await db.count('projects'), n, '件数が変わった');
  eq((await db.get('projects', ctx.p.id)).name, 'テスト案件A改', '誤入力の編集で中身が変わった');
});

test('「完成」ガード：テスト全合格（＋Phase 6の条件）でなければ「完成」にできない', async () => {
  const p = await db.create('projects', { name: 'ガード確認', status: 'testing' });
  await rejects(db.update('projects', p.id, { status: 'complete' }), 'テスト0件で完成にできた');
  const t = await db.create('tests', { projectId: p.id, item: '保存', result: 'fail' });
  await rejects(db.update('projects', p.id, { status: 'complete' }), '不合格ありで完成にできた');
  await db.update('tests', t.id, { result: 'fail', retestResult: 'pass' });
  await rejects(db.update('projects', p.id, { status: 'complete' }), 'テスト合格だけで完成にできた（Phase 6の条件不足）');
  // Phase 6 で厳格化：確定仕様・引継ぎ・実機確認も揃えると完成にできる
  const d = await db.createSpecDraft(p.id, { body: '# 仕様' }); await db.fixSpec(d.id, {});
  await db.saveProjectHandoff(p.id, { implemented: '保存', nextSteps: '運用' });
  await db.create('checks', { projectId: p.id, kind: 'device', device: 'iPhone', status: 'pass' });
  const done = await db.update('projects', p.id, { status: 'complete' });
  eq(done.status, 'complete', '全合格後に完成にできない');
  await rejects(db.create('projects', { name: 'いきなり完成', status: 'complete' }), '新規でいきなり完成にできた');
});

test('エラー時：存在しないデータの編集・削除・復元は分かりやすく失敗し、他に影響しない', async () => {
  const n = await db.count('projects');
  const e1 = await rejects(db.update('projects', 'no-such-id', { name: 'x' }), '存在しないデータを編集できた');
  assert(/見つかりません/.test(e1.message), 'エラー文が分かりにくい');
  await rejects(db.remove('projects', 'no-such-id'), '存在しないデータを削除できた');
  await rejects(db.restore('no-such-trash'), '存在しないゴミ箱を復元できた');
  await rejects(db.create('history', { x: 1 }), '履歴を直接書き換えできた');
  eq(await db.count('projects'), n, '件数が変わった');
});

test('バックアップ：書き出し→全消去→復元で、全データが完全に一致する', async () => {
  const json = await db.exportAll();
  assert(json.app === '3ai-factory' && json.schemaVersion === SCHEMA_VERSION, 'ファイルの識別情報');
  const snap = JSON.stringify(json.data);
  const roundtrip = JSON.parse(JSON.stringify(json)); // ファイル保存・読込を再現
  db.close();
  await delDB(TEST_DB);
  db = await FactoryDB.open(TEST_DB);
  db.actor = 'テスト担当';
  eq(await db.count('projects'), 0, '消去できていない');
  await db.importAll(roundtrip);
  const after = await db.exportAll();
  const strip = d => JSON.stringify({ ...d, history: d.history.filter(h => h.action !== 'import') });
  eq(strip(after.data), strip(JSON.parse(snap)), '復元後のデータが一致しない');
  assert(after.data.history.some(h => h.action === 'import'), '復元の履歴が残っていない');
  await loadMaster(db);
});

test('復元の安全確認：不正・破損・他アプリのファイルは拒否し、今のデータを変えない', async () => {
  const before = JSON.stringify((await db.exportAll()).data.projects);
  const good = await db.exportAll();
  const bad = [
    null, 'text', { app: 'other-app', schemaVersion: 1, data: {} },
    { ...good, schemaVersion: 99 },
    { ...good, counts: { ...good.counts, projects: 999 } },
    { ...good, data: { ...good.data, projects: [{ name: 'IDなし' }] } },
    { ...good, data: { ...good.data, unknownStore: [] } },
  ];
  for (const b of bad) {
    const e = await rejects(db.importAll(b), `不正ファイルを受け付けた：${JSON.stringify(b)?.slice(0, 40)}`);
    assert(e instanceof FactoryError, '分かりやすいエラーではない');
  }
  eq(JSON.stringify((await db.exportAll()).data.projects), before, 'データが変わった');
});

test('データ保持：バックアップに全保存先が含まれる', async () => {
  const json = await db.exportAll();
  eq(Object.keys(json.data).sort(), Object.keys(STORES).sort(), '保存先の一覧');
});

test('同期準備：学校実データ等（localOnly）は同期対象から除外される', async () => {
  const since = new Date(Date.now() - 1000).toISOString();
  await sleep(5);
  const a = await db.create('projects', { name: '同期してよい', status: 'concept' });
  const b = await db.create('projects', { name: '生徒データ（端末内のみ）', status: 'concept', localOnly: true });
  const ch = await db.changesSince(since);
  assert(ch.some(c => c.record.id === a.id), '通常データが対象になっていない');
  assert(!ch.some(c => c.record.id === b.id), 'localOnlyデータが同期対象に入っている');
  assert(isSyncable('projects', a) && !isSyncable('projects', b) && !isSyncable('settings', a), 'isSyncable の判定');
});

test('引継ぎ：7項目（実装済み〜テスト結果）を含むMarkdownを作れる', async () => {
  const h = await loadHandoff();
  const md = toMarkdown(h, { runAt: 'x', passed: 1, failed: 0, total: 1, details: [{ name: 'a', ok: true }] });
  for (const [, title] of HANDOFF_FIELDS) assert(md.includes(`## ${title}`), `「${title}」がない`);
  assert(md.includes('## テスト結果'), '「テスト結果」がない');
});

test('オフライン準備：アプリ本体の読込とオフライン用の登録ができる', async () => {
  const r = await fetch('../manifest.webmanifest');
  assert(r.ok, 'manifest が読めない');
  const m = await r.json();
  assert(m.display === 'standalone' && m.icons.length >= 2, 'ホーム画面登録の設定が不足');
  if (location.protocol === 'file:') throw new Error('file:// では動きません。Webサーバー（GitHub Pages等）で開いてください');
  assert('serviceWorker' in navigator, 'このブラウザはオフライン機能に未対応');
  const reg = await navigator.serviceWorker.register('../sw.js', { scope: '../' });
  assert(reg, 'オフライン機能を登録できない');
});


// ================= Phase 2 =================
test('【P2】移行：Phase 1形式のデータベースを開いても、データが残り新しい保存先が追加される', async () => {
  const NAME = 'factory-test-mig';
  await delDB(NAME);
  await new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => { for (const s of ['projects','specs','requests','compares','files','tests','urls','settings','handoff','history','trash']) r.result.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => { const tx = r.result.transaction('projects', 'readwrite'); tx.objectStore('projects').put({ id: 'old1', name: '旧データ', status: 'concept' }); tx.oncomplete = () => { r.result.close(); res(); }; };
    r.onerror = () => rej(r.error);
  });
  const d = await FactoryDB.open(NAME);
  eq((await d.get('projects', 'old1'))?.name, '旧データ', '旧データ');
  assert(d.idb.objectStoreNames.contains('issues') && d.idb.objectStoreNames.contains('ideas'), '新しい保存先がない');
  assert(d._tx('history').objectStore('history').indexNames.contains('projectId'), '履歴のプロジェクト索引がない');
  d.close(); await delDB(NAME);
});

test('【P2】Phase 1で保存したバックアップファイルも復元できる', async () => {
  const cur = await db.exportAll();
  const old = { app: '3ai-factory', schemaVersion: 1, exportedAt: '2026-10-04T10:00:00Z', data: { projects: [{ id: 'v1p', name: 'v1の案件', status: 'concept' }], settings: cur.data.settings } };
  await db.importAll(old);
  eq((await db.get('projects', 'v1p'))?.name, 'v1の案件', 'v1データ');
  eq(await db.count('issues'), 0, '新しい保存先は空');
  await db.importAll(cur); // 元に戻す
  await loadMaster(db);
});

test('【P2】変更履歴：プロジェクトごとにまとめて見られる（要望・未解決事項も含む）', async () => {
  const p = await db.create('projects', { name: '履歴確認', status: 'concept' });
  const r = await db.create('requests', { projectId: p.id, title: '要望A', status: 'unreviewed' });
  await db.update('requests', r.id, { status: 'adopted' }, { reason: '採用した' });
  await db.create('issues', { projectId: p.id, title: '課題A', status: 'open' });
  const h = await db.historyOfProject(p.id);
  eq(h.length, 4, '履歴件数');
  assert(h.some(x => x.store === 'requests' && x.action === 'update' && x.reason === '採用した'), '要望の変更理由がない');
  ctx.histProject = p;
});

test('【P2】カード集計：未解決数・要望数・最新Version・最終更新日時・並び順が正しい', async () => {
  const m = db.master;
  const P = [{ id: 'a', name: 'A', status: 'concept', updatedAt: '2026-10-01' }, { id: 'b', name: 'B', status: 'spec_fixed', updatedAt: '2026-10-02', nextAction: ' 実装開始 ' }];
  const data = {
    issues: [{ projectId: 'a', status: 'open', updatedAt: '2026-10-01' }, { projectId: 'a', status: 'resolved', updatedAt: '2026-10-01' }],
    requests: [
      { projectId: 'a', status: 'unreviewed', updatedAt: '2026-10-05' }, { projectId: 'a', status: 'adopted', updatedAt: '2026-10-01' },
      { projectId: 'a', status: 'on_hold', updatedAt: '2026-10-01' }, { projectId: 'a', status: 'rejected', updatedAt: '2026-10-01' }, { projectId: 'a', status: 'implemented', updatedAt: '2026-10-01' }],
    specs: [{ projectId: 'b', version: 'v1.9', updatedAt: '2026-10-01' }, { projectId: 'b', version: 'v1.10', updatedAt: '2026-10-01' }],
    tests: [],
  };
  const c = summarizeProjects(P, data, m);
  eq(c.map(x => x.project.id), ['a', 'b'], '並び順（関連データの更新も反映）');
  eq([c[0].openIssues, c[0].openRequests, c[0].unreviewed], [1, 3, 1], 'Aの件数');
  eq(c[0].lastUpdated, '2026-10-05', '最終更新');
  eq(c[1].latestSpec.version, 'v1.10', '最新Version（v1.10 > v1.9）');
  eq(c[1].next, '実装開始', '次にやること');
  eq(c[1].statusLabel, '仕様確定', 'ステータス名');
  assert(compareVersion('v2.0', 'v1.99') > 0, 'Version比較');
});

test('【P2】完成度：テストは結果から自動計算、他は手動。8項目の平均', async () => {
  const m = db.master;
  const p = { progress: { planning: 100, spec: 100, ui: 50, data: 150, impl: -20 } };
  const tests = [{ result: 'pass' }, { result: 'fail', retestResult: 'pass' }, { result: 'fail' }, { result: 'untested' }];
  const r = computeProgress(p, tests, m);
  const t = r.axes.find(a => a.key === 'test');
  assert(t.auto && t.value === 50, 'テスト自動計算（2/4=50%）');
  eq(r.axes.find(a => a.key === 'data').value, 100, '上限100');
  eq(r.axes.find(a => a.key === 'impl').value, 0, '下限0');
  eq(r.total, Math.round((100 + 100 + 50 + 100 + 0 + 50 + 0 + 0) / 8), '平均');
  eq(computeProgress({}, [], m).total, 0, '未入力は0%');
});

test('【P2】要望箱ルール：要望の追加・採用では確定仕様は変わらない', async () => {
  const p = ctx.histProject;
  await db.create('specs', { projectId: p.id, version: 'v1.0', body: '確定仕様' });
  const before = JSON.stringify(await db.byIndex('specs', 'projectId', p.id));
  const r = await db.create('requests', { projectId: p.id, title: '新機能', status: 'unreviewed' });
  await db.update('requests', r.id, { status: 'adopted' });
  eq(JSON.stringify(await db.byIndex('specs', 'projectId', p.id)), before, '仕様が変わった');
  await rejects(db.create('requests', { projectId: p.id, title: ' ' }), '空の要望が保存された');
  await rejects(db.create('requests', { projectId: '', title: 'x' }), 'プロジェクトなしの要望が保存された');
  await rejects(db.create('requests', { projectId: p.id, title: 'x', status: '勝手な状態' }), '選択肢外の状態が保存された');
});

test('【P2】話すだけ：作る形の提案（最終決定はユーザー）', async () => {
  const m = db.master;
  eq(suggestDeliverable('部費をエクセルで集計したい', m)[0].type, 'excel', 'Excel提案');
  eq(suggestDeliverable('スマホで予定を管理するアプリ', m)[0].type, 'webapp', 'Webアプリ提案');
  const none = suggestDeliverable('なにか便利なもの', m);
  eq(none.length, 1, '該当なしは1案'); eq(none[0].type, 'webapp', '既定はWebアプリ');
  assert(suggestDeliverable('スマホで管理して印刷もしたい', m).length >= 2, '複数案を並べる');
});

test('【P2】話すだけ：個人情報の注意表示と、3AI用の依頼文（API不要）', async () => {
  const m = db.master;
  const w = privacyCheck('生徒の面談 連絡先 090-1234-5678 a@b.jp', m);
  assert(w.includes('生徒') && w.includes('電話番号らしき数字') && w.includes('メールアドレス'), '注意が出ない');
  eq(privacyCheck('古着屋を巡るアプリ', m).length, 0, '不要な注意');
  const pr = buildPrompts('古着屋を巡るアプリが欲しい', m, { projectName: 'Vintage Hunt' });
  eq(Object.keys(pr).sort(), ['chatgpt', 'claude', 'gemini'], '3AI分');
  for (const k of Object.keys(pr)) {
    assert(pr[k].includes('古着屋を巡るアプリが欲しい') && pr[k].includes('Vintage Hunt'), `${k}に相談内容がない`);
    assert(pr[k].includes('無料運用'), `${k}に無料運用の注意がない`);
  }
  assert(pr.claude.includes('まだコードは書かないでください'), 'Claude用の指示');
});

test('【P2】相談→プロジェクト化：元の相談とつながったまま「構想」で登録される', async () => {
  const idea = await db.create('ideas', { text: '家族の予定をまとめたい', status: 'new' });
  await rejects(db.create('ideas', { text: '  ' }), '空の相談が保存された');
  const p = await db.create('projects', { name: '家族予定', status: 'concept', purpose: idea.text, ideaId: idea.id });
  const i2 = await db.update('ideas', idea.id, { status: 'project_created', projectId: p.id });
  eq([p.status, p.ideaId, i2.projectId, i2.status], ['concept', idea.id, p.id, 'project_created'], 'つながり');
});


// ================= Phase 3 =================
const SKIP = new Set(['updatedAt', 'updatedBy', 'rev']);
const norm = r => JSON.stringify(Object.keys(r).sort().filter(k => !SKIP.has(k)).map(k => [k, r[k]]));
// プロジェクト1件分の全データ（本体＋関連データ＋履歴）のスナップショット
async function snapshot(pid) {
  const out = { project: await db.get('projects', pid) };
  for (const s of PROJECT_CHILD_STORES) out[s] = (await db.byIndex(s, 'projectId', pid)).sort((a, b) => a.id < b.id ? -1 : 1);
  out.history = (await db.byIndex('history', 'projectId', pid)).sort((a, b) => a.id < b.id ? -1 : 1);
  return out;
}
const sameSnap = (a, b, msg, { loose = false } = {}) => {
  const f = x => loose ? (x ? norm(x) : 'null') : JSON.stringify(x);
  eq(f(a.project), f(b.project), msg + '：本体');
  for (const s of [...PROJECT_CHILD_STORES]) eq(a[s].map(f), b[s].map(f), `${msg}：${s}`);
};
// 全関連ストアにデータを持つプロジェクトを作る
async function fullProject(name) {
  const p = await createProject(db, { name, purpose: name + 'の目的', targetUsers: '自分', targetDevices: ['iphone', 'pc'], memo: 'メモ', status: 'implementing' }, { firstTask: name + 'の最初の作業' });
  await db.create('specs', { projectId: p.id, version: 'v1.0', body: name + '仕様' });
  await db.create('requests', { projectId: p.id, title: name + '要望', status: 'unreviewed' });
  await db.create('compares', { projectId: p.id, topic: name + '比較' });
  await db.create('files', { projectId: p.id, fileName: name + '.html' });
  await db.create('tests', { projectId: p.id, item: name + 'テスト', result: 'pass' });
  await db.create('urls', { projectId: p.id, url: 'https://example.com/' + encodeURIComponent(name) });
  await db.create('issues', { projectId: p.id, title: name + '課題', severity: 'high', status: 'open', occurredAt: '2026-10-01' });
  await db.update('projects', p.id, { memo: 'メモ更新' }, { reason: '履歴を増やす' });
  return p;
}

test('【P3】一連の流れ：新規作成→保存→再読込→編集→検索→絞り込み→複製→削除→関連データもゴミ箱→復元→関連データも復元→完全削除', async () => {
  const m = db.master;
  // 新規作成・保存
  const p = await fullProject('流れ確認');
  for (const k of ['name', 'purpose', 'targetUsers', 'targetDevices', 'status', 'memo', 'createdAt', 'updatedAt', 'progress']) assert(p[k] !== undefined, `${k} がない`);
  // 再読込
  db.close(); db = await FactoryDB.open(TEST_DB); db.actor = 'テスト担当'; await loadMaster(db);
  eq((await db.get('projects', p.id)).targetDevices, ['iphone', 'pc'], '再読込後の対象端末');
  // 編集
  const e = await db.update('projects', p.id, { targetUsers: '自分と家族', status: 'testing' }, { reason: '編集テスト' });
  eq([e.targetUsers, e.status], ['自分と家族', 'testing'], '編集');
  // 検索・絞り込み
  const all = summarizeProjects(await db.all('projects'), { tasks: await db.all('tasks'), issues: await db.all('issues'), requests: [], tests: await db.all('tests'), specs: [] }, m);
  assert(filterProjects(all, { q: '流れ確認' }, m).some(c => c.project.id === p.id), '名前検索');
  assert(filterProjects(all, { q: '家族' }, m).some(c => c.project.id === p.id), '対象ユーザーで検索');
  assert(filterProjects(all, { group: 'active' }, m).some(c => c.project.id === p.id), '進行中で絞込み');
  assert(!filterProjects(all, { group: 'inuse' }, m).some(c => c.project.id === p.id), '使用中に混ざった');
  assert(filterProjects(all, { status: 'testing' }, m).every(c => c.project.status === 'testing'), 'ステータス絞込み');
  assert(filterProjects(all, { updated: 'today' }, m).some(c => c.project.id === p.id), '今日更新で絞込み');
  assert(!filterProjects(all, { updated: 'older' }, m).some(c => c.project.id === p.id), '30日より前に混ざった');
  // 複製
  const { project: dup } = await db.duplicateProject(p.id, { include: { specs: true, tasks: true } });
  eq([dup.name, dup.status, dup.purpose, dup.copiedFrom], ['流れ確認（コピー）', 'concept', '流れ確認の目的', p.id], '複製の基本情報');
  eq((await db.byIndex('specs', 'projectId', dup.id)).length, 1, '仕様書は複製');
  eq((await db.byIndex('tasks', 'projectId', dup.id)).map(t => t.status), ['todo'], '作業は未着手で複製');
  for (const s of ['tests', 'issues', 'compares', 'requests', 'files', 'urls']) eq((await db.byIndex(s, 'projectId', dup.id)).length, 0, `${s} は複製しない`);
  eq((await db.historyOfProject(dup.id)).every(h => h.reason.includes('から複製')), true, '元の履歴は複製しない');
  eq(computeProgress(dup, [], m).total, 0, '完成度は0%から');
  // 削除→関連データもゴミ箱
  const before = await snapshot(p.id);
  const trashId = await db.remove('projects', p.id);
  assert(!(await db.get('projects', p.id)), '本体が残っている');
  for (const s of PROJECT_CHILD_STORES) eq((await db.byIndex(s, 'projectId', p.id)).length, 0, `${s} が残っている`);
  eq((await db.historyOfProject(p.id)).length, 0, '履歴が残っている');
  const t = await db.get('trash', trashId);
  eq(t.kind, 'project-bundle', 'まとまりで保存');
  eq(t.relatedCount, PROJECT_CHILD_STORES.reduce((n, s) => n + before[s].length, 0), '関連データ件数');
  eq(t.historyCount, before.history.length, '履歴件数');
  // 複製先は無事
  assert(await db.get('projects', dup.id), '複製先まで消えた');
  // 復元→関連データも復元（内容は元通り）
  await db.restore(trashId);
  const after = await snapshot(p.id);
  sameSnap(after, before, '復元後', { loose: true });
  eq(after.history.filter(h => before.history.some(b => b.id === h.id)).length, before.history.length, '履歴も復元');
  assert((await db.historyOfProject(p.id)).some(h => h.action === 'restore'), '復元の記録がない');
  // 完全削除
  const t2 = await db.remove('projects', p.id);
  await db.purge(t2);
  assert(!(await db.get('trash', t2)), 'ゴミ箱に残っている');
  for (const s of PROJECT_CHILD_STORES) eq((await db.byIndex(s, 'projectId', p.id)).length, 0, `完全削除後に${s}が残っている`);
  await rejects(db.restore(t2), '完全削除後に復元できてしまう');
});

test('【P3】事故防止：プロジェクトAを削除・復元・完全削除しても、プロジェクトBのデータは1件も変わらない', async () => {
  const A = await fullProject('事故A'), B = await fullProject('事故B');
  // B の履歴にAと紛らわしい内容を足しておく
  await db.create('tasks', { projectId: B.id, title: '事故Aと同じ名前の作業', priority: 'low', status: 'todo', ai: 'claude' });
  const snapB = await snapshot(B.id);
  const checkB = async when => { const now = await snapshot(B.id); sameSnap(now, snapB, `${when}のB`); eq(JSON.stringify(now.history), JSON.stringify(snapB.history), `${when}のB履歴`); };
  const tA = await db.remove('projects', A.id);
  await checkB('A削除後');
  await db.restore(tA);
  await checkB('A復元後');
  const tA2 = await db.remove('projects', A.id);
  await db.purge(tA2);
  await checkB('A完全削除後');
  // Bを消してもAは既に無い・Bはまとめて戻る
  const tB = await db.remove('projects', B.id);
  await db.restore(tB);
  sameSnap(await snapshot(B.id), snapB, 'B自身の削除→復元', { loose: true });
});

test('【P3】復元の安全確認：同じIDがあると何も変えずに中止／親が無い関連データは単独で戻せない', async () => {
  const A = await fullProject('安全確認');
  const task = (await db.byIndex('tasks', 'projectId', A.id))[0];
  const taskTrash = await db.remove('tasks', task.id);
  const tA = await db.remove('projects', A.id);
  const e = await rejects(db.restore(taskTrash), '親が無いのに作業だけ復元できた');
  assert(e.message.includes('先にプロジェクト'), '案内が分かりにくい');
  // 同じIDのデータが別途作られていた場合 → 中止して何も変えない
  const bundle = await db.get('trash', tA);
  const spec = bundle.related.specs[0];
  await db.create('projects', { id: 'tmp-holder', name: '仮', status: 'concept' });
  await db.create('specs', { ...spec, id: spec.id, projectId: 'tmp-holder', version: 'v9.9' });
  const nProjects = await db.count('projects');
  await rejects(db.restore(tA), '同じIDがあるのに上書き復元した');
  eq(await db.count('projects'), nProjects, '途中まで復元された');
  eq((await db.get('specs', spec.id)).version, 'v9.9', '既存データが上書きされた');
  assert(await db.get('trash', tA), 'ゴミ箱から消えた');
  // 片付けて正常復元
  await db.remove('projects', 'tmp-holder');
  await db.restore(tA);
  await db.restore(taskTrash);
  assert(await db.get('tasks', task.id), '親を戻した後に作業を戻せない');
});

test('【P3】次にやること：作業内容・優先度・状態・担当AI・メモを保存し、最優先の未完了作業をホームに出す', async () => {
  const m = db.master;
  const p = await createProject(db, { name: '作業確認' });
  const mk = (title, priority, status, ai = 'user') => db.create('tasks', { projectId: p.id, title, priority, status, ai, memo: title + 'のメモ' });
  await mk('低い作業', 'low', 'todo');
  await mk('完了した高い作業', 'high', 'done');
  await mk('保留の高い作業', 'high', 'hold');
  await mk('中の作業', 'medium', 'todo', 'claude');
  await mk('中で進行中', 'medium', 'doing', 'gemini');
  const tasks = await db.byIndex('tasks', 'projectId', p.id);
  eq(topTask(tasks, m).title, '中で進行中', '最優先（完了・保留は除外、同じ優先度なら進行中）');
  eq(sortTasks(tasks, m).map(t => t.title).slice(0, 3), ['中で進行中', '中の作業', '低い作業'], '並び順');
  const t = tasks.find(x => x.title === '中の作業');
  eq([t.ai, t.memo], ['claude', '中の作業のメモ'], '担当AI・メモ');
  const c = summarizeProjects([p], { tasks }, m)[0];
  eq([c.next, c.nextTask.priority, c.openTasks], ['中で進行中', 'medium', 3], 'カード表示');
  eq(topTask(tasks.filter(x => ['done', 'hold'].includes(x.status)), m), null, '未完了が無ければ表示なし');
  await rejects(db.create('tasks', { projectId: p.id, title: '' }), '空の作業が保存された');
  await rejects(db.create('tasks', { projectId: p.id, title: 'x', priority: '最優先' }), '選択肢外の優先度');
  await rejects(db.create('tasks', { projectId: p.id, title: 'x', status: '途中' }), '選択肢外の状態');
  await rejects(db.create('tasks', { projectId: p.id, title: 'x', ai: 'copilot' }), '選択肢外の担当AI');
});

test('【P3】未解決事項：内容・重要度・状態・発生日・解決内容・解決日を個別に管理し、解決済みも履歴として残る', async () => {
  const m = db.master;
  const p = await createProject(db, { name: '課題確認' });
  const a = await db.create('issues', { projectId: p.id, title: '軽微な課題', severity: 'low', status: 'open', occurredAt: '2026-10-01' });
  const b = await db.create('issues', { projectId: p.id, title: '重要な課題', severity: 'high', status: 'open', occurredAt: '2026-10-03' });
  const r = await db.update('issues', a.id, { status: 'resolved', resolution: '設定を見直して解決', resolvedAt: '2026-10-04T10:00:00Z' }, { reason: '解決' });
  eq([r.title, r.severity, r.occurredAt, r.resolution, r.resolvedAt], ['軽微な課題', 'low', '2026-10-01', '設定を見直して解決', '2026-10-04T10:00:00Z'], '項目');
  const all = await db.byIndex('issues', 'projectId', p.id);
  eq(sortIssues(all, m).map(i => i.title), ['重要な課題', '軽微な課題'], '未解決が先');
  eq(summarizeProjects([p], { issues: all }, m)[0].openIssues, 1, '未解決数は解決済みを数えない');
  assert(await db.get('issues', a.id), '解決済みが消えた');
  assert((await db.historyOf(a.id)).some(h => h.changes?.resolution), '解決内容の履歴がない');
  await rejects(db.create('issues', { projectId: p.id, title: 'x', occurredAt: '10月1日' }), '日付以外の発生日');
  await rejects(db.create('issues', { projectId: p.id, title: 'x', severity: '最重要' }), '選択肢外の重要度');
});

test('【P3】移行：Phase 2までの「次にやること」（1行）が作業データに移る（何度実行しても重複しない）', async () => {
  const p = await db.create('projects', { name: '旧形式', status: 'concept', nextAction: '古い次作業' });
  eq(await db.migrateNextActions() >= 1, true, '移行件数');
  await db.migrateNextActions();
  const t = await db.byIndex('tasks', 'projectId', p.id);
  eq(t.map(x => [x.title, x.priority, x.status]), [['古い次作業', 'high', 'todo']], '作業1件');
  eq((await db.get('projects', p.id)).nextAction, '', '旧項目は空に');
});

test('【P3】初期7プロジェクト：問題なく登録・検索・絞り込み・バックアップできるデータ構造（野球成績・オーダーアプリは対象外）', async () => {
  const m = db.master;
  const seven = [
    ['Vintage Hunt', '古着探し・店舗巡り・フリマ・オンライン検索・購入コレクションを一元化', '自分', ['iphone', 'pc']],
    ['STORM／連合チーム予定管理', '桜・浅羽野・住吉 連合チームとSTORMクラブの予定・審判・グラウンド管理', '指導者・選手・保護者', ['iphone', 'smartphone', 'pc']],
    ['野球教材動画＋練習メニュー', '教材動画と練習メニューを紐付けて「今日の練習」を作る', '指導者・選手', ['iphone', 'pc']],
    ['学校 出欠・行事・三者面談管理', '出欠集約と三者面談の重複なし割当', '教員・保護者', ['schoolpc', 'pc']],
    ['野球部会計', '予算・入出金・繰越・会計報告を1円単位で管理', '会計担当・保護者', ['pc', 'iphone']],
    ['家族スケジュール・タスク管理', '家族全体＋子ども3人の予定・タスク・MLB情報', '家族', ['iphone', 'smartphone']],
    ['健康・減量管理', '体重・活動・食事・筋トレを日単位で確認', '自分', ['iphone']],
  ];
  const ids = [];
  for (const [name, purpose, users, devs] of seven) {
    const p = await createProject(db, { name, purpose, targetUsers: users, targetDevices: devs, status: 'concept', deliverableType: 'webapp', memo: '' }, { firstTask: '仕様の確認' });
    await db.create('issues', { projectId: p.id, title: name + 'の未決事項', severity: 'medium', status: 'open', occurredAt: '2026-10-04' });
    await db.create('requests', { projectId: p.id, title: name + 'への要望', status: 'unreviewed' });
    ids.push(p.id);
  }
  const projects = (await db.all('projects')).filter(p => ids.includes(p.id));
  eq(projects.length, 7, '7件登録');
  eq(new Set(projects.map(p => p.name)).size, 7, '名前が重複しない');
  const cards = summarizeProjects(projects, { tasks: await db.all('tasks'), issues: await db.all('issues'), requests: await db.all('requests') }, m);
  assert(cards.every(c => c.next === '仕様の確認' && c.openIssues === 1 && c.openRequests === 1), 'カード集計');
  eq(filterProjects(cards, { q: 'STORM' }, m).map(c => c.project.name), ['STORM／連合チーム予定管理'], '検索');
  eq(filterProjects(cards, { q: '野球' }, m).length, 2, '「野球」で2件（教材・会計）');
  assert(!(await db.all('projects')).some(p => p.name.includes('野球成績') || p.name.includes('オーダー')), '対象外アプリが登録されている');
  // 学校案件も「開発情報」だけで、生徒の実データ項目は持たない
  const school = projects.find(p => p.name.startsWith('学校'));
  assert(!JSON.stringify(school).match(/生徒名|出席番号/), '学校案件に個人情報項目がある');
  // バックアップに含まれる
  const json = await db.exportAll();
  assert(ids.every(id => json.data.projects.some(p => p.id === id)), 'バックアップに含まれない');
  // 1件削除しても他の6件は無事
  const t = await db.remove('projects', ids[0]);
  for (const id of ids.slice(1)) eq((await db.byIndex('tasks', 'projectId', id)).length, 1, '他案件の作業が消えた');
  await db.restore(t);
});


// ================= Phase 4 =================
test('【P4】通し：仕様書作成→v1.0確定→要望登録→採用→仕様は勝手に変わらない→仕様へ反映→変更案→差分確認→v1.1確定→v1.0が残る→要望との関連→変更履歴→Markdown出力', async () => {
  const m = db.master;
  const p = await createProject(db, { name: '仕様通し', purpose: '仕様管理の確認', targetUsers: '自分', targetDevices: ['iphone'] });
  // 仕様書作成（v1.0 変更案）
  const d0 = await db.createSpecDraft(p.id);
  eq([d0.version, d0.status, d0.baseVersion], ['v1.0', 'draft', null], '初版の変更案');
  assert(d0.body.includes('## 画面構成') && d0.title.includes('仕様通し'), 'ひな形');
  const body10 = d0.body.replace('## 機能\n', '## 機能\n- 店舗を登録できる\n');
  await db.update('specs', d0.id, { body: body10 });
  // v1.0 確定
  const v10 = await db.fixSpec(d0.id, {});
  eq([v10.status, v10.reason, !!v10.fixedAt, v10.fixedBy], ['fixed', '初版', true, 'テスト担当'], 'v1.0確定');
  // 要望登録→採用
  const r = await db.create('requests', { projectId: p.id, title: '地図で店を表示したい', status: 'unreviewed' });
  const snap = JSON.stringify(await db.specsOf(p.id));
  await db.decideRequest(r.id, 'adopted', { reason: '利用頻度が高い' });
  eq(JSON.stringify(await db.specsOf(p.id)), snap, '採用しただけで仕様書が変わった');
  eq(await db.currentDraft(p.id), null, '採用しただけで変更案ができた');
  // 仕様へ反映→変更案
  const { draft, added } = await db.reflectRequests(p.id, [r.id]);
  eq([draft.version, draft.baseVersion, added], ['v1.1', 'v1.0', 1], '変更案 v1.1');
  assert(draft.body.includes('地図で店を表示したい'), '要望が変更案に入っていない');
  eq((await db.get('requests', r.id)).specState, 'candidate', '要望が候補になっていない');
  // 差分確認
  const sum = diffSummary(diffLines(v10.body, draft.body));
  assert(sum.added >= 2 && sum.removed === 0, '差分（追加）');
  // 変更理由なしでは確定できない（v1.1）
  await db.update('specs', draft.id, { reason: '' });
  const e = await rejects(db.fixSpec(draft.id, {}), '理由なしで確定できた');
  assert(e.message.includes('変更理由'), 'エラー文');
  const v11 = await db.fixSpec(draft.id, { reason: '地図表示の要望を反映' });
  // v1.0 が残っている（内容も同じ）
  const all = await db.specsOf(p.id);
  eq(all.map(x => [x.version, x.status]), [['v1.1', 'fixed'], ['v1.0', 'fixed']], 'Version一覧');
  eq((await db.get('specs', v10.id)).body, body10, 'v1.0の内容が変わった');
  // 要望との関連
  const r2 = await db.get('requests', r.id);
  eq([r2.specVersion, r2.specState, r2.specId], ['v1.1', 'fixed', v11.id], '要望→Version');
  eq(v11.requestIds, [r.id], 'Version→要望');
  // 変更履歴へ自動記録
  const h = (await db.historyOfProject(p.id)).find(x => x.action === 'fix' && x.details.newVersion === 'v1.1');
  assert(h, '確定の履歴がない');
  eq([h.details.oldVersion, h.details.newVersion, h.reason, h.actor, h.details.requestTitles], ['v1.0', 'v1.1', '地図表示の要望を反映', 'テスト担当', ['地図で店を表示したい']], '履歴の中身');
  assert(h.at && h.projectId === p.id && h.details.summary.added >= 2 && h.details.diff.length, '日時・プロジェクト・変更内容');
  // Markdown出力
  const md = specToMarkdown(p, v11, m);
  assert(md.includes('v1.1') && md.includes('地図で店を表示したい') && md.includes('変更元Version：v1.0') && md.includes('変更理由：地図表示の要望を反映'), '仕様書Markdown');
  const fixes = (await db.historyOfProject(p.id)).filter(x => x.action === 'fix').sort((a, b) => a.at < b.at ? -1 : 1);
  const guide = buildGuide(p, { spec: v11, fixes, issues: [], tasks: await db.byIndex('tasks', 'projectId', p.id), requests: await db.byIndex('requests', 'projectId', p.id), files: [], tests: [] }, m);
  GUIDE_SECTIONS.forEach(([, t], i) => assert(guide.includes(`## ${i + 1}. ${t}`), `指示書に「${i + 1}. ${t}」がない`));
  assert(guide.includes('確定Version：v1.1') && guide.includes('店舗を登録できる') && guide.includes('v1.0 → v1.1'), '指示書の中身');
  const g = await db.saveGuide(p.id, guide, { specVersion: 'v1.1' });
  const g2 = await db.saveGuide(p.id, guide + '\n追記', { specVersion: 'v1.1' });
  eq([g.gversion, g2.gversion], [1, 2], '指示書の版');
  ctx.p4 = { p, v10, v11 };
});

test('【P4】誤操作防止：確定Versionは上書き・削除できず、内容も変わらない', async () => {
  const { p, v10 } = ctx.p4;
  const before = JSON.stringify(await db.get('specs', v10.id));
  const e1 = await rejects(db.update('specs', v10.id, { body: '書き換え' }), '確定版を上書きできた');
  assert(e1.message.includes('確定済み') && e1.details.some(x => x.includes('新しいVersion')), '分かりやすい警告');
  await rejects(db.update('specs', v10.id, { status: 'draft' }), '確定版を下書きに戻せた');
  await rejects(db.remove('specs', v10.id), '確定版を削除できた');
  eq(JSON.stringify(await db.get('specs', v10.id)), before, '確定版が変わった');
  await rejects(db.create('specs', { projectId: p.id, version: 'v9.0', status: 'fixed', body: 'x' }), '確定版を直接作れた');
  const d = await db.createSpecDraft(p.id);
  eq(d.version, 'v1.2', '次のVersion');
  await rejects(db.update('specs', d.id, { status: 'fixed' }), '変更案を確定操作なしで確定にできた');
  await rejects(db.createSpecDraft(p.id), '変更案が2つ作れた');
  await rejects(db.update('specs', d.id, { version: 'v1.0' }), '確定済みと同じVersionにできた');
  await rejects(db.update('specs', d.id, { version: 'v0.9' }), '確定済みより古いVersionにできた');
  await db.update('specs', d.id, { version: 'v2.0' });
  eq((await db.get('specs', d.id)).version, 'v2.0', '大きな変更 v2.0');
  await db.discardDraft(d.id);
  eq(await db.currentDraft(p.id), null, '破棄');
  // ゴミ箱の変更案は、別の変更案があると戻せない
  const t = (await db.listTrash()).find(x => x.recordId === d.id);
  const d2 = await db.createSpecDraft(p.id);
  await rejects(db.restore(t.id), '変更案が2つになる復元ができた');
  await db.discardDraft(d2.id);
});

test('【P4】保留・不採用：要望は消えず、判断・理由・判断日が残り、仕様へは反映できない', async () => {
  const p = await createProject(db, { name: '判断確認' });
  const a = await db.create('requests', { projectId: p.id, title: '有料APIで自動取得', status: 'unreviewed' });
  const b = await db.create('requests', { projectId: p.id, title: '来年検討する機能', status: 'unreviewed' });
  const ra = await db.decideRequest(a.id, 'rejected', { reason: '無料で実現できないため' });
  const rb = await db.decideRequest(b.id, 'on_hold', { reason: 'Phase 7のあとに再検討' });
  eq([ra.status, ra.decisionReason, !!ra.decidedAt, ra.decidedBy], ['rejected', '無料で実現できないため', true, 'テスト担当'], '不採用の記録');
  eq([rb.status, rb.decisionReason], ['on_hold', 'Phase 7のあとに再検討'], '保留の記録');
  await db.decideRequest(b.id, 'adopted', { reason: '再検討で採用' });
  await db.decideRequest(b.id, 'on_hold', { reason: 'やはり保留' });
  eq((await db.get('requests', b.id)).decisions.map(x => x.status), ['on_hold', 'adopted', 'on_hold'], '判断の経緯');
  const e = await rejects(db.reflectRequests(p.id, [a.id, b.id]), '保留・不採用を反映できた');
  assert(e.details.some(x => x.includes('有料APIで自動取得')) && e.details.some(x => x.includes('来年検討する機能')), 'どの要望か分かる');
  eq((await db.specsOf(p.id)).length, 0, '仕様書ができた');
  eq((await db.byIndex('requests', 'projectId', p.id)).length, 2, '要望が消えた');
  assert((await db.historyOf(a.id)).some(h => h.reason.includes('無料で実現できないため')), '変更履歴に理由がない');
});

test('【P4】まとめ反映：採用済み3件を1つの変更案（v1.1候補）へ、追跡・重複なし・外す・確定', async () => {
  const p = await createProject(db, { name: 'まとめ反映' });
  const d0 = await db.createSpecDraft(p.id); await db.fixSpec(d0.id, {});
  const rs = [];
  for (const t of ['要望A', '要望B', '要望C']) { const r = await db.create('requests', { projectId: p.id, title: t, status: 'unreviewed' }); await db.decideRequest(r.id, 'adopted'); rs.push(r); }
  const { draft, added } = await db.reflectRequests(p.id, rs.map(r => r.id));
  eq([draft.version, added, draft.requestIds.length], ['v1.1', 3, 3], '3件まとめて');
  const again = await db.reflectRequests(p.id, rs.map(r => r.id));
  eq(again.added, 0, '同じ要望を二重に入れない');
  eq((await db.get('specs', draft.id)).body.split('要望A').length - 1, 1, '本文の重複');
  await rejects(db.decideRequest(rs[2].id, 'rejected'), '変更案に入っている要望を不採用にできた');
  await db.removeRequestFromDraft(draft.id, rs[2].id);
  eq((await db.get('requests', rs[2].id)).specState, null, '外した要望の紐付け');
  const v11 = await db.fixSpec(draft.id, { reason: '要望2件を反映' });
  const after = await Promise.all(rs.map(r => db.get('requests', r.id)));
  eq(after.map(r => r.specVersion || null), ['v1.1', 'v1.1', null], 'どの要望がどのVersionへ');
  eq(v11.requestIds.length, 2, 'Version側の記録');
  const h = (await db.historyOfProject(p.id)).find(x => x.action === 'fix' && x.details.newVersion === 'v1.1');
  eq(h.details.requestTitles, ['要望A', '要望B'], '履歴の元要望');
  await rejects(db.reflectRequests(p.id, [rs[0].id]), '確定済みの要望を再反映できた');
});

test('【P4】差分：追加・削除・変更を区別し、変更前/変更後を対にする', async () => {
  const rows = diffLines('目的\n店舗\n地図\n古い行', '目的\n店舗（改）\n地図\n新しい行\n追加行');
  eq(rows.map(r => r.type), ['same', 'change', 'same', 'change', 'add'], '種類');
  eq([rows[1].before, rows[1].after], ['店舗', '店舗（改）'], '変更前/変更後');
  eq(diffSummary(rows), { added: 1, removed: 0, changed: 2 }, '件数');
  eq(diffSummary(diffLines('a\nb\nc', 'a\nc')), { added: 0, removed: 1, changed: 0 }, '削除');
  eq(diffSummary(diffLines('', 'x\ny')), { added: 2, removed: 0, changed: 0 }, '初版は全部追加');
  eq(diffLines('同じ', '同じ').every(r => r.type === 'same'), true, '変更なし');
  eq([nextVersion('v1.9'), nextVersion('v1.9', true), nextVersion('v2.10')], ['v1.10', 'v2.0', 'v2.11'], '次のVersion');
});

test('【P4】プロジェクト単位の操作：仕様書・指示書も関連データとして削除/復元、複製後も確定は保護', async () => {
  const { p } = ctx.p4;
  const before = await db.specsOf(p.id);
  const t = await db.remove('projects', p.id);
  eq((await db.specsOf(p.id)).length, 0, '仕様書がゴミ箱へ行かない');
  eq((await db.byIndex('guides', 'projectId', p.id)).length, 0, '指示書がゴミ箱へ行かない');
  await db.restore(t);
  eq((await db.specsOf(p.id)).map(x => [x.version, x.status, x.body]), before.map(x => [x.version, x.status, x.body]), '仕様書の復元');
  eq((await db.byIndex('guides', 'projectId', p.id)).length, 2, '指示書の復元');
  await rejects(db.update('specs', before[0].id, { body: 'x' }), '復元後に確定版を上書きできた');
  const { project: dup } = await db.duplicateProject(p.id, { include: { specs: true } });
  const ds = await db.specsOf(dup.id);
  eq(ds.map(x => x.version), ['v1.1', 'v1.0'], '複製の仕様');
  assert(ds.every(x => !x.requestIds?.length), '複製先が元の要望とつながっている');
  eq(ds[0].baseSpecId, ds[1].id, '変更元を複製先のIDに付け替え');
  await rejects(db.update('specs', ds[0].id, { body: 'x' }), '複製先の確定版を上書きできた');
});


// ================= Phase 5 =================
async function projectWithSpec(name) {
  const p = await createProject(db, { name, purpose: name + 'の目的', status: 'implementing' });
  const d = await db.createSpecDraft(p.id, { body: '# 仕様\n## 機能\n- 店舗登録' });
  await db.fixSpec(d.id, {});
  return p;
}
const specSnap = async pid => JSON.stringify((await db.specsOf(pid)).map(x => [x.id, x.version, x.status, x.body, x.rev]));

test('【P5】通し：相談作成→3AI用依頼文→コピー記録→ChatGPT/Claude/Gemini回答保存→比較→1案採用→要望箱へ→仕様書は変わらない', async () => {
  const m = db.master;
  const p = await projectWithSpec('3AI通し');
  await db.create('issues', { projectId: p.id, title: '検索が遅い', status: 'open', severity: 'high' });
  const before = await specSnap(p.id);
  const s = await db.createCompare(p.id, { topic: '保存方法', question: '店舗100件を速く検索したい', conditions: '- 無料運用', problems: '- 検索が遅い', outputFormat: '比較表（案ごとの長所・短所）' });
  eq([s.specVersion, s.status], ['v1.0', 'open'], '相談の作成');
  const spec = await db.latestFixedSpec(p.id);
  const prompts = {};
  for (const ai of ['chatgpt', 'claude', 'gemini']) {
    prompts[ai] = buildComparePrompt(s, p, spec, ai, m);
    for (const w of ['3AI通し', '3AI通しの目的', 'v1.0', '店舗登録', '店舗100件を速く検索したい', '無料運用', '検索が遅い', '比較表']) assert(prompts[ai].includes(w), `${ai}の依頼文に「${w}」がない`);
    eq(findPersonalInfo(prompts[ai], m).length, 0, '個人情報の誤検出');
    await db.recordPrompt(s.id, ai, prompts[ai]);
  }
  assert(prompts.claude.includes('主実装') && prompts.gemini.includes('YouTube'), '役割が依頼文に入っていない');
  await rejects(db.decideAnswer(s.id, 'chatgpt', 'adopt'), '回答なしで判断できた');
  await db.saveAnswer(s.id, 'chatgpt', { text: 'A案：IndexedDBに保存する', memo: '分かりやすい' });
  await db.saveAnswer(s.id, 'claude', { text: 'B案：索引を作る' });
  await db.saveAnswer(s.id, 'gemini', { text: 'C案：スプレッドシート' });
  await rejects(db.saveAnswer(s.id, 'chatgpt', { text: '  ' }), '空の回答を保存できた');
  await rejects(db.saveAnswer(s.id, 'copilot', { text: 'x' }), '対象外のAIを保存できた');
  let c = await db.get('compares', s.id);
  const a = c.answers.chatgpt;
  eq([a.ai, a.answer, a.memo, a.specVersion, a.topic, !!a.savedAt, a.question === prompts.chatgpt], ['chatgpt', 'A案：IndexedDBに保存する', '分かりやすい', 'v1.0', '保存方法', true, true], 'AI名・質問・回答・日時・仕様Version・テーマ・メモ');
  // 比較 → 判断（Factoryは決めない）
  eq(['chatgpt', 'claude', 'gemini'].map(x => c.answers[x].decision || null), [null, null, null], 'Factoryが勝手に判断した');
  await db.decideAnswer(s.id, 'claude', 'adopt', { reason: '速い' });
  await db.decideAnswer(s.id, 'chatgpt', 'hold', { reason: '後で検討' });
  await db.decideAnswer(s.id, 'gemini', 'reject', { reason: '無料枠が不安' });
  await rejects(db.decideAnswer(s.id, 'gemini', 'best'), '選択肢外の判断');
  c = await db.get('compares', s.id);
  eq([c.answers.claude.decision, c.answers.claude.decisionReason, !!c.answers.claude.decidedAt], ['adopt', '速い', true], '判断・理由・判断日');
  // 要望箱へ（採用した案だけ）
  await rejects(db.answerToRequest(s.id, 'gemini', { title: 'x' }), '不採用の案を要望箱へ入れられた');
  const r = await db.answerToRequest(s.id, 'claude', { title: '店舗データに索引を作る' });
  eq([r.status, r.source.type, r.source.ai, r.projectId], ['unreviewed', 'compare', 'claude', p.id], '要望は「未検討」で入る');
  await rejects(db.answerToRequest(s.id, 'claude', { title: 'x' }), '二重に追加できた');
  await rejects(db.decideAnswer(s.id, 'claude', 'reject'), '要望箱へ入れた後に判断を覆せた');
  // 最終結論
  const f = await db.setFinalDecision(s.id, 'Claude案（索引）を採用');
  eq([f.status, f.finalDecision, !!f.finalDecidedAt], ['decided', 'Claude案（索引）を採用', true], '最終結論');
  // 仕様書は直接変わらない
  eq(await specSnap(p.id), before, '仕様書が変わった');
  eq(await db.currentDraft(p.id), null, '変更案ができた');
});

test('【P5】個人情報チェック：氏名らしき語・電話・メール・住所を警告し、匿名化できる', async () => {
  const m = db.master;
  const t = '2年1組の田中君と佐藤さんの保護者へ連絡。電話090-1234-5678、メール tanaka@example.jp、住所 埼玉県狭山市入間川1-2-3 〒350-1305';
  const f = findPersonalInfo(t, m);
  const kinds = new Set(f.map(x => x.kind));
  for (const k of ['人名らしき言葉', '電話番号', 'メールアドレス', '住所', '郵便番号', '注意する言葉']) assert(kinds.has(k), `「${k}」を検出しない`);
  const a = anonymize(t);
  for (const w of ['田中', '佐藤', '090-1234-5678', 'tanaka@example.jp', '狭山市', '350-1305']) assert(!a.includes(w), `匿名化後に「${w}」が残る`);
  assert(a.includes('Aさん') && a.includes('Bさん'), '名前の置き換え');
  eq(anonymize('田中君と田中君').match(/Aさん/g).length, 2, '同じ名前は同じ記号');
  eq(findPersonalInfo('古着屋とフリマを週末に回りたい。v1.1で地図を追加。2026-10-04', m).length, 0, '個人情報のない文で警告が出た');
  eq(findPersonalInfo('皆さんへのお知らせ', m).length, 0, '「皆さん」を人名と誤判定');
});

test('【P5】URL：登録→種類判定→要約・重要ポイント・活用案を保存→要望箱へ→仕様書は変わらない', async () => {
  const p = await projectWithSpec('URL確認');
  const before = await specSnap(p.id);
  eq(['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://x.com/a/status/1', 'https://twitter.com/a', 'https://www.instagram.com/p/1', 'https://example.com/a', 'not a url'].map(detectUrlKind),
    ['youtube', 'youtube', 'x', 'x', 'instagram', 'web', 'other'], '種類の判定');
  await rejects(db.addUrl(p.id, { url: 'javascript:alert(1)' }), '不正なURLを登録できた');
  const u = await db.addUrl(p.id, { url: 'https://www.youtube.com/watch?v=abc' });
  eq([u.kind, u.projectId, !!u.registeredAt], ['youtube', p.id, true], '登録');
  assert(buildUrlPrompt(u, p, db.master).includes('https://www.youtube.com/watch?v=abc') && buildUrlPrompt(u, p, db.master).includes('活用案'), '要約依頼文');
  const s = await db.update('urls', u.id, { title: '古着の選び方', summary: '古着の見分け方の動画', points: '- タグを見る\n- 縫製を見る', ideas: 'タグ年代メモ機能', memo: '参考' });
  eq([s.summary, s.points, s.ideas], ['古着の見分け方の動画', '- タグを見る\n- 縫製を見る', 'タグ年代メモ機能'], '要約・重要ポイント・活用案');
  const r = await db.urlToRequest(u.id, { title: 'タグから年代をメモできる' });
  eq([r.status, r.source.type, r.source.url], ['unreviewed', 'url', u.url], '要望は「未検討」で入る');
  eq((await db.get('urls', u.id)).requestIds, [r.id], 'URL→要望の記録');
  eq(await specSnap(p.id), before, '仕様書が変わった');
});

test('【P5】コード／ファイル：登録→Version変更→旧版保持→最新版判定→関連仕様Version', async () => {
  const p = await projectWithSpec('ファイル確認');
  const f1 = await db.create('files', { projectId: p.id, fileName: 'index.html', type: 'HTML', version: 'v1.0', status: 'active', ai: 'claude', description: 'トップ', specVersion: 'v1.0', code: '<h1>v1</h1>', language: 'HTML' });
  await db.create('files', { projectId: p.id, fileName: 'style.css', type: 'CSS', version: 'v1.0', status: 'active', ai: 'claude', specVersion: 'v1.0' });
  const f2 = await db.newFileVersion(f1.id, { version: 'v1.1', code: '<h1>v2</h1>', specVersion: 'v1.0' });
  await rejects(db.newFileVersion(f1.id, { version: 'v1.1' }), '同じVersionを二重登録できた');
  const old = await db.get('files', f1.id);
  eq([old.status, old.code], ['old', '<h1>v1</h1>'], '旧版として中身ごと残る');
  eq([f2.status, f2.prevId, f2.description, f2.language], ['active', f1.id, 'トップ', 'HTML'], '新しいVersionは使用中・前の版とつながる');
  const g = groupFiles(await db.byIndex('files', 'projectId', p.id));
  const idx = g.find(x => x.fileName === 'index.html');
  eq([g.length, idx.latest.version, idx.others.map(o => o.version), idx.activeCount], [2, 'v1.1', ['v1.0'], 1], '最新版の判定');
  eq(idx.latest.specVersion, 'v1.0', '関連仕様Version');
  // 試作のVersionを足しても、最新版は「使用中」のまま
  await db.newFileVersion(f2.id, { version: 'v1.2', status: 'draft' });
  eq(groupFiles(await db.byIndex('files', 'projectId', p.id)).find(x => x.fileName === 'index.html').latest.version, 'v1.1', '試作は最新版にしない');
  await rejects(db.create('files', { projectId: p.id, fileName: 'big.js', code: 'x'.repeat(300001) }), '大きすぎるコードを保存できた');
  await rejects(db.create('files', { projectId: p.id, fileName: 'a.js', status: '本番' }), '選択肢外の状態');
});

test('【P5】役割とおすすめAI：状態に応じたおすすめ（おすすめのみ）・役割は案件ごとに変更可', async () => {
  const m = db.master;
  eq(['concept', 'spec_draft', 'implementing', 'testing', 'usable'].map(st => recommendAI({ status: st }, {}, m).ai), ['chatgpt', 'chatgpt', 'claude', 'claude', 'chatgpt'], '状態ごと');
  eq(recommendAI({ status: 'implementing' }, { urls: [{ kind: 'youtube', summary: '' }] }, m).ai, 'gemini', 'YouTube未要約はGemini');
  eq(recommendAI({ status: 'implementing' }, { urls: [{ kind: 'youtube', summary: '済' }] }, m).ai, 'claude', '要約済みならいつも通り');
  const r = aiRoles(m, { aiRoles: { gemini: 'Googleフォーム連携の担当' } });
  eq([r.gemini, r.chatgpt.includes('要望整理')], ['Googleフォーム連携の担当', true], '役割の変更');
  const p = await createProject(db, { name: '役割確認' });
  const s = await db.createCompare(p.id, { topic: 'フォーム' });
  assert(buildComparePrompt(s, { ...p, aiRoles: { gemini: 'Googleフォーム連携の担当' } }, null, 'gemini', m).includes('Googleフォーム連携の担当'), '依頼文に案件ごとの役割');
  await rejects(db.createCompare(p.id, { topic: '' }), 'テーマなしで相談を作れた');
});


// ================= Phase 6 =================
test('【P6】テスト：作成→不合格（エラー記録）→修正記録→再テスト→合格。過去の不合格・エラー・修正は残る', async () => {
  const p = await createProject(db, { name: 'テスト履歴' });
  const t = await db.create('tests', { projectId: p.id, item: '保存', category: '基本操作', check: '保存ボタン', expected: '保存される', status: 'untested', required: true, specVersion: 'v1.0', fileVersion: 'index.html v1.1', memo: 'm', runs: [] });
  for (const k of ['item', 'category', 'check', 'expected', 'status', 'specVersion', 'fileVersion', 'memo']) assert(t[k] !== undefined, `${k} がない`);
  await rejects(db.recordTestRun(t.id, { result: 'fail' }), 'エラー内容なしで不合格にできた');
  const r1 = await db.recordTestRun(t.id, { result: 'fail', actual: '固まる', error: '保存で画面が固まる' });
  eq([r1.status, r1.error, r1.actual, !!r1.executedAt, r1.executedBy], ['fail', '保存で画面が固まる', '固まる', true, 'テスト担当'], '不合格の記録');
  await rejects(db.update('tests', t.id, { status: 'pass' }), '編集で勝手に合格にできた');
  const r2 = await db.recordFix(t.id, { fix: '待ち時間を修正', done: false });
  eq(r2.status, 'fixing', '修正中');
  const r3 = await db.recordFix(t.id, { fix: '待ち時間を修正（完了）', done: true });
  eq(r3.status, 'retest', '再テスト待ち');
  const r4 = await db.recordRetest(t.id, { result: 'fail', error: 'まだ遅い' });
  eq(r4.status, 'fail', '再テスト不合格');
  await db.recordFix(t.id, { fix: '索引を追加' });
  const r5 = await db.recordRetest(t.id, { result: 'pass', actual: 'すぐ保存' });
  eq([r5.status, r5.retestResult], ['pass', 'pass'], '最終的に合格');
  eq(r5.runs.map(r => `${r.kind}:${r.result || (r.done ? 'done' : 'doing')}`), ['run:fail', 'fix:doing', 'fix:done', 'retest:fail', 'fix:done', 'retest:pass'], '履歴の順番');
  eq(r5.runs.filter(r => r.error).map(r => r.error), ['保存で画面が固まる', 'まだ遅い'], '最初の不具合記録が残る');
  assert((await db.historyOf(t.id)).some(h => h.reason.includes('保存で画面が固まる')), '変更履歴にも残る');
  await rejects(db.recordFix(t.id, { fix: 'x' }), '合格したテストに修正を記録できた');
});

test('【P6】共通テストテンプレート：16項目を追加・重複なし・個別に追加/削除できる', async () => {
  const m = db.master;
  const names = m.commonTestTemplate.map(t => t.name);
  for (const w of ['新規登録', '保存', '再読込', '編集', '検索', '絞り込み', '削除確認', '復元（ゴミ箱）', '印刷／共有', 'スマホ表示', 'PC表示', '誤入力', 'エラー処理', 'データ保持', 'バックアップ', '復元（バックアップ）']) assert(names.includes(w), `テンプレートに「${w}」がない`);
  const p = await createProject(db, { name: 'テンプレ' });
  const a = await db.applyTestTemplate(p.id, ['保存', '検索']);
  eq(a.map(t => t.item), ['保存', '検索'], '選んだものだけ');
  const b = await db.applyTestTemplate(p.id);
  eq(b.length, names.length - 2, '残りを追加（重複しない）');
  eq((await db.applyTestTemplate(p.id)).length, 0, '2回目は追加なし');
  const extra = await db.create('tests', { projectId: p.id, item: '独自テスト', status: 'untested', required: false });
  await db.remove('tests', a[0].id);
  const now = await db.byIndex('tests', 'projectId', p.id);
  eq([now.length, now.every(t => t.status === 'untested')], [names.length, true], '追加・削除');
  assert(now.find(t => t.id === extra.id).required === false, '任意テスト');
});

test('【P6】完成度：仕様・テスト・引継ぎ・実装・公開は実データと自動連動、UI・データは手入力', async () => {
  const m = db.master;
  const p = { purpose: '目的', targetUsers: '自分', targetDevices: ['iphone'], deliverableType: 'webapp', progress: { ui: 50, data: 30, spec: 0, test: 0 } };
  const specs = [{ version: 'v1.0', status: 'fixed' }, { version: 'v1.1', status: 'draft' }];
  const tests = [{ status: 'pass', required: true }, { status: 'fail', required: true }, { status: 'untested', required: false }];
  const files = [{ fileName: 'a', status: 'active', specVersion: 'v1.0' }, { fileName: 'b', status: 'active', specVersion: 'v0.9' }, { fileName: 'c', status: 'old', specVersion: 'v0.9' }];
  const devices = [{ status: 'pass' }, { status: 'unchecked' }];
  const publish = [{ access: 'ok' }];
  const handoff = { implemented: 'x', nextSteps: 'y' };
  const r = computeProgress(p, tests, m, { specs, files, devices, publish, handoff });
  const v = Object.fromEntries(r.axes.map(a => [a.key, [a.value, a.auto]]));
  eq(v.planning, [100, true], '企画（目的・対象・端末・作る形）');
  eq(v.spec, [100, true], '仕様（確定版あり）');
  eq(v.ui, [50, false], 'UIは手入力');
  eq(v.data, [30, false], 'データは手入力');
  eq(v.impl, [50, true], '実装（使用中ファイルの最新仕様対応 1/2）');
  eq(v.test, [50, true], 'テスト（必須の合格率 1/2、任意は数えない）');
  eq(v.handoff, [40, true], '引継ぎ（5項目中2）');
  eq(v.release, [70, true], '公開/使用開始（実機1/2×60＋公開40）');
  eq(computeProgress({}, [], m, { specs: [{ version: 'v1.0', status: 'draft' }] }).axes.find(a => a.key === 'spec').value, 50, '変更案のみは50%');
  eq(computeProgress({ progress: { impl: 70 } }, [], m, {}).axes.find(a => a.key === 'impl'), { ...m.progressAxes.find(a => a.key === 'impl'), value: 70, auto: false, note: '' }, 'ファイル未登録なら実装は手入力');
});

test('【P6】「完成」の厳格化：不足があれば理由を日本語で示し、すべて満たせば完成にできる。「使用可能」とは区別', async () => {
  const p = await createProject(db, { name: '完成判定', status: 'testing' });
  const msg = async () => { const e = await rejects(db.update('projects', p.id, { status: 'complete' }), '条件不足で完成にできた'); return e.details.join('\n'); };
  let m1 = await msg();
  for (const w of ['最新の確定仕様がある', '必須テストがすべて合格', '引継ぎ情報がある', '必要な実機確認が完了']) assert(m1.includes(w), `不足理由に「${w}」がない`);
  // 「使用可能」にはできる
  eq((await db.update('projects', p.id, { status: 'usable' })).status, 'usable', '使用可能にできない');
  // 仕様・テスト（不合格あり）
  const d = await db.createSpecDraft(p.id, { body: '# 仕様' }); await db.fixSpec(d.id, {});
  const [t1, t2] = await db.applyTestTemplate(p.id, ['保存', '検索']);
  await db.recordTestRun(t1.id, { result: 'pass' });
  await db.recordTestRun(t2.id, { result: 'fail', error: '検索できない' });
  m1 = await msg(); assert(m1.includes('合格していない必須テストが1件') && m1.includes('検索'), '必須テスト不合格の理由');
  await db.recordFix(t2.id, { fix: '修正' }); await db.recordRetest(t2.id, { result: 'pass' });
  // 重大問題
  const iss = await db.create('issues', { projectId: p.id, title: 'データが消える', severity: 'high', status: 'open', occurredAt: '2026-10-04' });
  await db.create('issues', { projectId: p.id, title: '色が薄い', severity: 'low', status: 'open', occurredAt: '2026-10-04' });
  m1 = await msg(); assert(m1.includes('重要度「重要」の未解決事項が1件') && m1.includes('データが消える'), '重大問題の理由');
  await db.update('issues', iss.id, { status: 'resolved', resolution: '修正', resolvedAt: '2026-10-04T10:00:00Z' });
  // 引継ぎ
  await db.saveProjectHandoff(p.id, { implemented: '主要機能', nextSteps: '' });
  m1 = await msg(); assert(m1.includes('引継ぎ'), '引継ぎ（次に行うこと未記入）の理由');
  await db.saveProjectHandoff(p.id, { implemented: '主要機能', nextSteps: '改良' });
  // 実機確認
  const dv1 = await db.create('checks', { projectId: p.id, kind: 'device', device: 'iPhone', status: 'pass' });
  const dv2 = await db.create('checks', { projectId: p.id, kind: 'device', device: '学校Windows PC', status: 'unchecked' });
  m1 = await msg(); assert(m1.includes('学校Windows PC（未確認）'), '実機確認未完了の理由');
  await db.update('checks', dv2.id, { status: 'recheck' });
  await msg();
  await db.update('checks', dv2.id, { status: 'pass', checkedAt: '2026-10-04', result: '全合格' });
  // すべて満たす → 完成
  const items = await db.completionCheck(p.id);
  eq(items.map(i => i.ok), [true, true, true, true, true, true], '6条件');
  eq((await db.update('projects', p.id, { status: 'complete' })).status, 'complete', '条件を満たしても完成にできない');
  // バックアップ不可なら完成にできない（純粋関数で確認）
  assert(!completionItems({ specs: [{ status: 'fixed', version: 'v1.0' }], tests: [{ status: 'pass' }], handoff: { implemented: 'a', nextSteps: 'b' }, devices: [{ status: 'pass' }], backup: { ok: false, error: '容量不足' } }, db.master).find(i => i.key === 'backup').ok, 'バックアップ不可を見逃した');
  assert(dv1, '');
});

test('【P6】次にやること連携：テスト不合格・重大問題から確認して追加（二重追加なし・自動では作らない）', async () => {
  const p = await createProject(db, { name: '連携' });
  const t = await db.create('tests', { projectId: p.id, item: '印刷', status: 'untested', runs: [] });
  await db.recordTestRun(t.id, { result: 'fail', error: '印刷が崩れる' });
  eq((await db.byIndex('tasks', 'projectId', p.id)).length, 0, '不合格で自動的にタスクができた');
  const k = await db.addTaskFrom(p.id, { title: 'テスト不合格を修正：印刷', source: { type: 'test', id: t.id } });
  eq([k.priority, k.status, k.source.type], ['high', 'todo', 'test'], '追加された作業');
  await rejects(db.addTaskFrom(p.id, { title: 'x', source: { type: 'test', id: t.id } }), '二重に追加できた');
  const i = await db.create('issues', { projectId: p.id, title: '保存できない', severity: 'high', status: 'open' });
  await db.addTaskFrom(p.id, { title: '重大な問題を解決：保存できない', source: { type: 'issue', id: i.id } });
  eq((await db.byIndex('tasks', 'projectId', p.id)).length, 2, '作業数');
});

test('【P6】実機確認・公開確認：端末ごとの状態・確認日・結果、学校ネットワークで利用不可を区別', async () => {
  const m = db.master;
  eq(m.deviceCheckStatuses.map(s => s.label), ['未確認', '合格', '不合格', '再確認待ち'], '状態');
  const p = await createProject(db, { name: '公開確認' });
  const c = await db.create('checks', { projectId: p.id, kind: 'device', device: 'iPhone', status: 'pass', checkedAt: '2026-10-04', result: '45/45合格', memo: 'Safari' });
  eq([c.status, c.checkedAt, c.result, c.memo], ['pass', '2026-10-04', '45/45合格', 'Safari'], '実機確認');
  const pub = await db.create('checks', { projectId: p.id, kind: 'publish', target: 'https://example.github.io/factory/', publishedAt: '2026-10-04', lastCheckedAt: '2026-10-05', environment: '学校のネットワーク', access: 'school_blocked', offline: 'ok', homescreen: 'ok' });
  eq(m.accessResults.find(a => a.key === pub.access).label, '学校ネットワークで利用不可', '公開失敗と区別');
  await rejects(db.create('checks', { projectId: p.id, kind: 'device', status: '済' }), '選択肢外の状態');
  await rejects(db.create('checks', { projectId: p.id, kind: 'other' }), '種類の誤り');
  // プロジェクト削除で一緒にゴミ箱へ、復元で戻る
  const tr = await db.remove('projects', p.id);
  eq((await db.checksOf(p.id)).length, 0, '確認記録がゴミ箱へ行かない');
  await db.restore(tr);
  eq((await db.checksOf(p.id)).length, 2, '確認記録が戻らない');
  // Factory本体の実機確認待ちを引継ぎ（重複しない）
  const f1 = await db.ensureFactoryChecks(); const f2 = await db.ensureFactoryChecks();
  eq([f1.map(d => d.device), f2.length, f1.every(d => d.status === 'unchecked' && d.memo.includes('Phase 1〜5'))], [['iPhone', '自宅PC', '学校Windows PC'], 3, true], 'Factory本体の実機確認');
});

test('【P6】プロジェクト別引継ぎ・Factory全体引継ぎ・v1完成判定', async () => {
  const m = db.master;
  const p = await createProject(db, { name: '引継ぎ確認', status: 'implementing', purpose: '目的' });
  const d = await db.createSpecDraft(p.id, { body: '# 仕様' }); await db.fixSpec(d.id, {});
  await db.create('files', { projectId: p.id, fileName: 'index.html', version: 'v1.2', status: 'active', specVersion: 'v1.0' });
  const t = await db.create('tests', { projectId: p.id, item: '保存', status: 'untested', runs: [] });
  await db.recordTestRun(t.id, { result: 'fail', error: '保存できない' });
  await db.create('issues', { projectId: p.id, title: '遅い', severity: 'medium', status: 'open' });
  await db.create('tasks', { projectId: p.id, title: '保存を直す', priority: 'high', status: 'todo', ai: 'claude' });
  await db.create('checks', { projectId: p.id, kind: 'device', device: 'iPhone', status: 'unchecked' });
  await db.saveProjectHandoff(p.id, { implemented: '登録画面', notImplemented: '地図', knownIssues: '', nextSteps: '保存の修正', notes: '個人情報を入れない' });
  const md = projectHandoffMarkdown(p, await collectHandoff(db, p), m);
  for (const w of ['現在Version：v1.0', '現在ステータス：実装中', '## 実装済み', '登録画面', '## 未実装', '地図', '## 既知の問題', '遅い', '## 最新テスト結果', '必須テスト 0/1 合格', '保存できない', '## 実機確認', 'iPhone：未確認', '## 最後に変更したファイル', 'index.html v1.2', '## 次に行うこと', '保存の修正', '保存を直す', '## 注意事項', '個人情報を入れない']) assert(md.includes(w), `引継ぎに「${w}」がない`);
  // Factory全体
  const h = await loadHandoff();
  const fmd = toMarkdown(h, null, { devices: [{ device: 'iPhone', statusLabel: '未確認' }], publish: [] });
  for (const w of ['Factory Version', '各Phaseの状態とテスト結果', '| 6 |', '実機確認状況', 'iPhone：未確認', '## 既知の問題', '## 未実装', '## 次Phase', '## 重要な設計ルール']) assert(fmd.includes(w), `Factory引継ぎに「${w}」がない`);
  // v1完成判定
  const items = v1Items({ handoff: h, projects: [{ name: 'Vintage Hunt' }, { name: 'STORM予定' }], devices: [{ device: 'iPhone', status: 'pass' }, { device: '学校Windows PC', status: 'unchecked' }], publish: [{ access: 'school_blocked' }], lastTest: { total: 3, passed: 3, failed: 0, runAt: 'x' }, lastBackup: null }, m);
  const get = l => items.find(i => i.label.includes(l));
  eq(get('Phase 1').ok, true, 'Phase 1');
  eq(get('Phase 7').ok, String(h.phases.find(x => x.no === 7).status).startsWith('完了'), 'Phase 7（引継ぎの状態どおり）');
  const undone = v1Items({ handoff: { phases: [{ no: 8, name: '未着手の例', status: '未着手' }] }, projects: [], devices: [], publish: [], lastTest: null, lastBackup: null }, m).find(i => i.label.includes('Phase 8'));
  eq([undone.ok, !!undone.how], [false, true], '未完了のPhaseは⬜で何をすればいいかを表示');
  eq([get('7案件').ok, get('7案件').detail.startsWith('2/7')], [false, true], '7案件');
  eq([get('iPhone').ok, get('学校Windows PC').ok], [true, false], '実機確認');
  eq(get('学校ネットワーク').ok, false, '学校ネットワークで利用不可を表示');
  eq([get('自動テスト').ok, get('バックアップ').ok], [true, false], 'テスト・バックアップ');
  assert(items.filter(i => !i.ok).every(i => i.how), '未完了の項目に「何をすればいいか」がない');
});


// ---------------- Phase 7：7プロジェクトの正式初期登録・既存アプリ取込 ----------------
// 本番と同じ手順で、空のテスト専用DB（factory-test7）に登録して確認する
const TEST_DB7 = 'factory-test7';
let db7, seedData;
const P7_ORDER = ['Vintage Hunt', 'STORM／連合チーム予定管理', '野球教材動画＋練習メニュー', '学校 出欠・行事・三者面談管理', '野球部会計', '家族スケジュール・タスク管理', '健康・減量管理'];
const P7_SPECIAL = { 'vintage-hunt': /古着屋.*フリマ.*オンライン.*混同しない/, storm: /選手集合時間.*審判集合時間.*混同しない/, kyozai: /先生指定.*選手別教材.*AIが勝手に変更しない/, school: /同じ教員.*同じ時間.*重複しない/, kaikei: /収入.*支出.*残高.*繰越.*1円単位/, family: /MLB.*失敗.*家族予定/, health: /歩数.*距離.*連携失敗.*他の健康記録/ };
const seven = async () => (await db7.all('projects')).filter(p => p.seedKey && p.seedKey !== 'factory');

test('【P7】初期登録：Factory本体＋7プロジェクト＝合計8件（開発順・野球成績／オーダーなし）', async () => {
  await delDB(TEST_DB7);
  db7 = await FactoryDB.open(TEST_DB7); db7.actor = 'テスト担当';
  await loadMaster(db7);
  seedData = await loadInitialProjects();
  eq(seedData.projects.map(d => d.name), P7_ORDER, '初期登録データの7件と開発順');
  eq(seedStatus([], seedData).done, false, '登録前は未登録');
  const r = await seedInitialProjects(db7, seedData);
  eq(r.created.length, 8, '作成件数');
  const all = await db7.all('projects');
  eq(all.length, 8, '合計件数');
  const f = await db7.get('projects', FACTORY_ID);
  assert(f && f.name === '3AI Development Factory' && f.origin === 'factory', 'Factory本体が固定IDで登録されていない');
  const s7 = await seven();
  eq(s7.map(p => p.name).sort(), [...P7_ORDER].sort(), '7件の名前');
  assert(!JSON.stringify(await db7.exportAll()).match(/野球成績|オーダーアプリ/), '野球成績・オーダーアプリが含まれている');
  eq([seedStatus(all, seedData).done, seededCount(all)], [true, 7], '登録済み判定');
});

test('【P7】7件すべてに15項目の情報とv1.0確定仕様（確定仕様は直接変更できない）', async () => {
  const heads = ['目的', '対象ユーザー・端末', '画面構成', '機能', '保存データ', '外部サービス・API', '印刷・PDF・共有', 'AIの役割', '絶対条件', '未実装／将来機能', '技術上の注意'];
  for (const p of await seven()) {
    assert(p.purpose && p.targetUsers && p.targetDevices.length, `${p.name}：目的・対象ユーザー・対象端末`);
    eq(p.status, 'spec_fixed', `${p.name}：状態は仕様確定`);
    const specs = await db7.specsOf(p.id);
    eq(specs.map(x => [x.version, x.status]), [['v1.0', 'fixed']], `${p.name}：仕様Version`);
    for (const h of heads) assert(specs[0].body.includes(`## ${h}`), `${p.name}：仕様に「${h}」がない`);
    await rejects(db7.update('specs', specs[0].id, { body: '書き換え' }), `${p.name}：確定仕様を直接書き換えできた`);
    const open = (await db7.byIndex('tasks', 'projectId', p.id)).filter(t => t.status !== 'done');
    assert(open.length >= 2, `${p.name}：次にやることがない`);
  }
  // 主な確定事項が仕様に入っている（勝手に削除しない）
  const body = async key => (await db7.specsOf((await seven()).find(p => p.seedKey === key).id))[0].body;
  for (const w of ['商品を探す', '古着屋を探す', 'フリマを探す', '購入コレクション', '情報リサーチ', 'セカンドストリート', 'メルカリ', 'Yahoo!オークション', 'どんどんタウン', 'トレジャーファクトリー', 'AAA狭山', '鴻巣', '白岡', 'サンデーマーケット', '桐生']) assert((await body('vintage-hunt')).includes(w), `Vintage Hunt：「${w}」`);
  for (const w of ['桜', '浅羽野', '住吉', 'トップ', 'アカデミー', '選手集合時間', '審判集合時間', '雨天判定時間', '球審', 'LINE']) assert((await body('storm')).includes(w), `STORM：「${w}」`);
  for (const w of ['YouTube', 'バント', '今日の練習', '先生', '順位']) assert((await body('kyozai')).includes(w), `教材：「${w}」`);
  for (const w of ['Googleフォーム', '三者面談', '面談間隔', '重複', '保護者配布用', '教員確認用', '匿名化']) assert((await body('school')).includes(w), `学校：「${w}」`);
  for (const w of ['800', '50', '2,000', '6,000', '3,000', 'JJBF', 'STORM杯', '県大会補助金', '繰越', '証憑', '1円単位']) assert((await body('kaikei')).includes(w), `会計：「${w}」`);
  for (const w of ['今日のドジャース', '日本時間', '日本人選手', '子ども3人']) assert((await body('family')).includes(w), `家族：「${w}」`);
  for (const w of ['Apple Health', '見せかけない', '有料API', '筋トレ', '食事写真']) assert((await body('health')).includes(w), `健康：「${w}」`);
});

test('【P7】7件すべてにFactory移行用指示書（17項目・既存URLは推測しない）', async () => {
  const m = db7.master;
  for (const p of await seven()) {
    const [spec, issues, tasks, requests, files, tests, hist] = await Promise.all([db7.latestFixedSpec(p.id), db7.byIndex('issues', 'projectId', p.id), db7.byIndex('tasks', 'projectId', p.id), db7.byIndex('requests', 'projectId', p.id), db7.byIndex('files', 'projectId', p.id), db7.byIndex('tests', 'projectId', p.id), db7.historyOfProject(p.id)]);
    const g = buildGuide(p, { spec, issues, tasks, requests, files, tests, fixes: hist.filter(h => h.action === 'fix') }, m);
    GUIDE_SECTIONS.forEach(([, t], i) => assert(g.includes(`## ${i + 1}. ${t}`), `${p.name}：指示書に「${i + 1}. ${t}」がない`));
    assert(g.includes('確定Version：v1.0') && g.includes('（新規） → v1.0'), `${p.name}：確定仕様・変更履歴`);
    const urlSec = g.split('## 11. 既存URL')[1].split('## 12.')[0];
    assert(urlSec.includes('既存アプリの有無：未確認') && !/https?:\/\//.test(urlSec), `${p.name}：既存URLを推測している`);
    assert(!/https?:\/\//.test(g.split('## 12. ソースコード')[1].split('## 13.')[0]), `${p.name}：ソースコードを推測している`);
    eq([p.origin, p.existing], ['unknown', undefined], `${p.name}：既存アプリは未確認のまま`);
  }
});

test('【P7】7件すべてに共通テスト16項目＋正しい個別必須テスト', async () => {
  const m = db7.master;
  for (const p of await seven()) {
    const tests = await db7.byIndex('tests', 'projectId', p.id);
    const common = tests.filter(t => !t.special);
    eq(common.map(t => t.item).sort(), m.commonTestTemplate.map(t => t.item || t.name || t).sort(), `${p.name}：共通テスト`);
    const sp = tests.filter(t => t.special);
    eq(sp.length, 1, `${p.name}：個別必須テストの件数`);
    assert(P7_SPECIAL[p.seedKey].test(sp[0].item), `${p.name}：個別必須テスト「${sp[0].item}」`);
    assert(sp[0].required && sp[0].status === 'untested', `${p.name}：個別必須テストは必須・未テスト`);
  }
});

test('【P7】実装前なので完成度は低い（仕様部分だけ反映）・完成にできない', async () => {
  const m = db7.master;
  for (const p of await seven()) {
    const [tests, specs, files, checks] = await Promise.all(['tests', 'specs', 'files', 'checks'].map(s => db7.byIndex(s, 'projectId', p.id)));
    const pr = computeProgress(p, tests, m, { specs, files, devices: checks.filter(c => c.kind === 'device'), publish: checks.filter(c => c.kind === 'publish'), handoff: {} });
    assert(pr.total > 0 && pr.total <= 30, `${p.name}：完成度 ${pr.total}% が実態と合わない`);
    for (const k of ['ui', 'data', 'impl', 'test', 'release']) { const a = pr.axes.find(x => x.key === k); if (a) eq(a.value, 0, `${p.name}：${a.label}`); }
    await rejects(db7.update('projects', p.id, { status: 'complete' }), `${p.name}：実装前に完成にできた`);
  }
});

test('【P7】もう一度登録しても重複しない（ホームのボタンを何度押しても8件）', async () => {
  const r = await seedInitialProjects(db7, seedData);
  eq([r.created.length, r.skipped.length, await db7.count('projects')], [0, 8, 8], '再登録');
});

test('【P7】JSONバックアップに7案件が含まれ、復元後も7案件と仕様Versionが保持される', async () => {
  const json = JSON.parse(JSON.stringify(await db7.exportAll()));
  const names = json.data.projects.map(p => p.name);
  for (const n of P7_ORDER) assert(names.includes(n), `バックアップに「${n}」がない`);
  db7.close(); await delDB(TEST_DB7);
  db7 = await FactoryDB.open(TEST_DB7); db7.actor = 'テスト担当';
  eq(await db7.count('projects'), 0, '消去できていない');
  await db7.importAll(json);
  await loadMaster(db7);
  const s7 = await seven();
  eq(s7.length, 7, '復元後の件数');
  for (const p of s7) {
    eq((await db7.specsOf(p.id)).map(x => `${x.version}:${x.status}`), ['v1.0:fixed'], `${p.name}：復元後の仕様Version`);
    eq([p.status, (await db7.byIndex('tests', 'projectId', p.id)).length], ['spec_fixed', 17], `${p.name}：復元後の状態・テスト`);
  }
  eq(await db7.count('projects'), 8, '復元後の合計');
});

test('【P7】既存アプリ取込：取込待ち→情報登録→基準Version→仕様と照合→改良候補だけ要望箱へ（コード・仕様は変えない）', async () => {
  const p = (await seven()).find(x => x.seedKey === 'vintage-hunt');
  const specBefore = JSON.stringify(await db7.specsOf(p.id));
  await db7.setOrigin(p.id, 'existing');
  eq((await db7.get('projects', p.id)).existing.importStatus, 'waiting', '取込待ち');
  // 推測で登録しない：URLもコードもないと取込を完了できない
  const e1 = await rejects(db7.completeImport(p.id), 'URLもコードもないのに取込できた');
  assert(e1.message.includes('まだ取込を完了できません'), '取込不可の説明');
  await rejects(db7.saveExisting(p.id, { webUrl: 'example.com' }), 'URL形式の誤りを保存できた');
  await db7.saveExisting(p.id, { appName: 'VH', webUrl: 'https://user.github.io/vh/', currentVersion: 'v0.3', publishState: '公開中', implemented: '店舗一覧', notImplemented: '地図', knownIssues: '遅い', storage: 'localStorage', externalServices: 'なし', testStatus: '手動のみ', nextImprovements: '地図' });
  const f = await db7.create('files', { projectId: p.id, fileName: 'index.html', version: 'v0.3', status: 'active', code: '<html>既存</html>' });
  await db7.completeImport(p.id);
  const q = await db7.get('projects', p.id);
  eq([q.existing.importStatus, q.existing.baseline.currentVersion, q.existing.baseline.webUrl, q.existing.baseline.files, q.existing.baseline.specVersion], ['imported', 'v0.3', 'https://user.github.io/vh/', ['index.html v0.3'], 'v1.0'], '基準Version');
  eq([q.existing.storage, q.existing.testStatus, q.existing.nextImprovements, q.existing.githubUrl], ['localStorage', '手動のみ', '地図', undefined], '取込項目（入力したものだけ）');
  await rejects(db7.setOrigin(p.id, 'new'), '取込済みを「新しく作る」に戻せた');
  // 照合
  const items = specItems((await db7.latestFixedSpec(p.id)).body);
  assert(items.length >= 10 && !items.some(i => ['絶対条件', '技術上の注意'].includes(i.head)), '照合項目');
  await db7.setCoverage(p.id, items[0].key, 'done');
  await db7.setCoverage(p.id, items[1].key, 'partial', { memo: '一部だけ' });
  await db7.setCoverage(p.id, items[2].key, 'todo');
  await db7.setCoverage(p.id, items[3].key, 'diff');
  await rejects(db7.setCoverage(p.id, items[4].key, 'maybe'), '判定以外の値を保存できた');
  const sum = coverageSummary(items, (await db7.get('projects', p.id)).existing.coverage);
  eq([sum.done, sum.partial, sum.todo, sum.diff, sum.unjudged], [1, 1, 1, 1, items.length - 4], '照合の集計');
  await rejects(db7.coverageToRequests(p.id, [items[0].key]), '実装済みの項目を要望箱へ送れた');
  const reqs = await db7.coverageToRequests(p.id, [items[1].key, items[2].key, items[3].key]);
  eq(reqs.map(r => [r.status, r.title.startsWith('【改良候補】'), r.source.type]), [['unreviewed', true, 'coverage'], ['unreviewed', true, 'coverage'], ['unreviewed', true, 'coverage']], '改良候補は未検討で要望箱へ');
  eq((await db7.coverageToRequests(p.id, [items[1].key])).length, 0, '同じ差分が重複して要望箱へ入った');
  // 仕様もコードも変わらない
  eq(JSON.stringify(await db7.specsOf(p.id)), specBefore, '確定仕様が変わった');
  eq((await db7.get('files', f.id)).code, '<html>既存</html>', '既存コードが変わった');
  // 指示書に既存アプリの情報が出る
  const g = buildGuide(await db7.get('projects', p.id), { spec: await db7.latestFixedSpec(p.id), files: await db7.byIndex('files', 'projectId', p.id), issues: [], tasks: [], requests: [], tests: [], fixes: [] }, db7.master);
  for (const w of ['既存アプリ：取込済み', 'https://user.github.io/vh/', '基準Version：v0.3', 'index.html v0.3', '【既存アプリの既知の問題】', '遅い']) assert(g.includes(w), `指示書に「${w}」がない`);
});

test('【P7】新規作成で「新しく作る」「既存アプリを取り込む」を選べる（データ構造）・照合ロジック', async () => {
  const a = await createProject(db7, { name: '新規の案件' });
  const b = await createProject(db7, { name: '既存の案件', origin: 'existing' });
  eq([a.origin, a.existing, b.origin, b.existing.importStatus], ['new', undefined, 'existing', 'waiting'], '始め方');
  await rejects(db7.create('projects', { name: 'x', origin: 'other' }), '始め方の誤り');
  const it = specItems('# T\n## 機能\n- 店舗登録\n- 地図\n## 絶対条件\n- 削除しない\n## 保存データ\n- 店舗');
  eq(it.map(i => i.key), ['機能｜店舗登録', '機能｜地図', '保存データ｜店舗'], '仕様の照合項目');
  eq(coverageSummary(it, { '機能｜地図': { status: 'todo' } }), { unjudged: 2, done: 0, partial: 0, todo: 1, diff: 0 }, '集計');
  db7.close(); await delDB(TEST_DB7);
});

// ---------------- 実行 ----------------
async function run() {
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  results.innerHTML = ''; summary.textContent = '実行中…';
  const details = [];
  try {
    await delDB(TEST_DB);
    db = await FactoryDB.open(TEST_DB);
    db.actor = 'テスト担当';
  } catch (e) {
    summary.textContent = '❌ テスト用データベースを開けませんでした：' + e.message;
    return;
  }
  for (const t of T) {
    let ok = true, error = '';
    try { await t.fn(); } catch (e) { ok = false; error = (e.message || String(e)) + (e.details ? '：' + e.details.join(' / ') : ''); }
    details.push({ name: t.name, ok, error });
    results.insertAdjacentHTML('beforeend', `<div class="row"><span class="mark">${ok ? '✅' : '❌'}</span><div><div class="name"></div><div class="err"></div></div></div>`);
    const row = results.lastElementChild;
    row.querySelector('.name').textContent = t.name;
    row.querySelector('.err').textContent = error;
  }
  try { db.close(); await delDB(TEST_DB); } catch {}
  const passed = details.filter(d => d.ok).length;
  const run = { runAt: new Date().toISOString(), total: details.length, passed, failed: details.length - passed, details, userAgent: navigator.userAgent };
  summary.textContent = run.failed ? `❌ ${run.failed}件 不合格（合格 ${passed} / ${run.total}）` : `✅ 全${run.total}項目 合格`;
  document.getElementById('when').textContent = '実行日時：' + new Date().toLocaleString('ja-JP');
  window.__TEST_RESULT__ = run;

  // 結果を本番Factoryの引継ぎ情報へ保存（本番データは他に変更しない）
  try {
    const real = await FactoryDB.open('factory');
    await real.upsert('settings', 'lastTestRun', { key: 'lastTestRun', value: run }, { actor: '自動テスト', reason: 'テスト結果を記録' });
    real.close();
  } catch (e) { document.getElementById('when').textContent += '（引継ぎへの記録に失敗：' + e.message + '）'; }
}

document.getElementById('rerun').onclick = run;
run();
