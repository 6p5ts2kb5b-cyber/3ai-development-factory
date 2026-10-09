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
import { v1Items, v1LaterItems } from '../js/views/v1.js';
import { groupDeviceChecks, isBlankDeviceCheck, sameDeviceSuggestions } from '../js/views/checks.js';
import { PROJECT_CHILD_STORES } from '../js/db.js';
import { loadInitialProjects, seedInitialProjects, seedStatus, seededCount } from '../js/seed.js';
import { specItems, coverageSummary } from '../js/logic.js';
import * as SyncAuth from '../js/sync/auth.js';
import * as SyncCloud from '../js/sync/cloud.js';
import * as Dry from '../js/sync/dryrun.js';
import * as Reg from '../js/sync/register.js';
import * as Pull from '../js/sync/pull.js';
import * as S3 from '../js/sync/sync3.js';
import * as N from '../js/sync/notice.js';
import { noticeHtml } from '../js/views/noticebar.js';

const TEST_DB = 'factory-test';
// 同期の記録（登録・取り込み・Sync-3の状態・控え・お知らせの設定）もテスト専用のデータベースへ（本番の factory-sync を変えない）
const TEST_SYNC_DB = 'factory-test-sync';
Reg._useSyncDBForTest(TEST_SYNC_DB);
const T = [];
const test = (name, fn) => T.push({ name, fn });
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}（期待：${JSON.stringify(b)} / 実際：${JSON.stringify(a)}）`);
async function rejects(p, msg) {
  try { await p; } catch (e) { return e; }
  throw new Error(msg);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// テスト用データベースの削除（v0.11.7 で修正）
// ・削除の要求は1回だけ出し、本当に削除が終わった（success）ときに次へ進む
// ・blocked は「ほかの接続が閉じるのを待っている」という途中経過の知らせ。要求を出し直してはいけない
//   （v0.11.4〜0.11.6 は40ミリ秒ごとに出し直していたため、残った削除要求が後から実行され、
//     次のテストが開いたデータベースの接続を閉じていた →「The database connection is closing」）
// ・テスト専用（factory-test…）以外の名前は削除しない（本番の factory・factory-sync を守る）
const delDB = name => new Promise((res, rej) => {
  if (!/^factory-test/.test(name)) { rej(new Error(`テスト専用ではないデータベース「${name}」は削除しません`)); return; }
  const r = indexedDB.deleteDatabase(name);
  const timer = setTimeout(() => rej(new Error(`テスト用データベース「${name}」の削除が20秒たっても終わりません（ほかの画面でテストを開いたままの可能性があります。テストの画面を1つだけにしてやり直してください）`)), 20000);
  r.onsuccess = () => { clearTimeout(timer); res(); };
  r.onerror = () => { clearTimeout(timer); rej(r.error); };
  r.onblocked = () => { /* 待つ（出し直さない） */ };
});

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
  eq([get('iPhone の実機確認').ok, get('学校Windows PC の実機確認').ok], [true, false], '実機確認');
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


// ---------------- Phase Sync-1：Googleログインだけ（データは送受信しない） ----------------
// 本物のFirebaseの代わりに、同じ形の「にせFirebase」を差し込んで確認する（ネットに接続しない）
function fakeFirebase() {
  const ls = new Set(); let cur = null; const calls = [];
  const set = u => { cur = u; ls.forEach(f => f(u)); };
  return { calls, mod: {
    app: { getApps: () => [], initializeApp: (c, n) => { calls.push(['init', n]); return { name: n, options: c }; } },
    auth: {
      getAuth: app => { calls.push(['getAuth', app.name]); return { get currentUser() { return cur; } }; },
      onAuthStateChanged: (a, f) => { ls.add(f); setTimeout(() => f(cur), 0); return () => ls.delete(f); },
      GoogleAuthProvider: class { setCustomParameters(p) { this.p = p; } },
      signInWithPopup: async (a, prov) => { calls.push(['popup', prov.p?.prompt]); if (fakeFirebase.fail) { const e = new Error('x'); e.code = fakeFirebase.fail; throw e; } const u = { uid: 'uid-123', displayName: 'テスト先生', email: 'teacher@example.com', providerData: [{ providerId: 'google.com' }] }; set(u); return { user: u }; },
      signOut: async () => { calls.push(['signOut']); set(null); },
    } } };
}
const FAKE_CFG = { apiKey: 'AIza-test', authDomain: 'factory-test.firebaseapp.com', projectId: 'factory-test', appId: '1:1:web:1' };

test('【Sync-1】Firebaseの設定チェック（未設定は「設定待ち」・個人情報は入れない）', async () => {
  eq(SyncAuth.checkFirebaseConfig(null).ok, false, '未設定');
  assert(SyncAuth.checkFirebaseConfig({ apiKey: 'a' }).reason.includes('authDomain'), '足りない項目の表示');
  eq(SyncAuth.checkFirebaseConfig(FAKE_CFG).ok, true, '正しい設定');
  eq(SyncAuth.checkFirebaseConfig({ ...FAKE_CFG, owner: 'me@gmail.com' }).ok, false, 'メールアドレス入りを拒否');
  const shipped = await (await fetch('../config/firebase.json', { cache: 'no-cache' })).json();
  assert(!/@/.test(JSON.stringify(shipped.config || {})), '配布する設定ファイルにメールアドレスが入っている');
  eq(SyncAuth.SDK_URLS.auth, 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js', 'Firebase公式配布元・バージョン固定（12.8.0）');
  SyncAuth._setLoader(async () => { throw new Error('読み込ませない'); });
  eq((await SyncAuth.initAuth({ config: null })).status, 'unconfigured', '設定がなければ Firebase を読み込まず「設定待ち」');
  SyncAuth._setLoader(null);
});

test('【Sync-1】ログイン・ログアウトの流れとエラー表示（日本語・次にすること付き）', async () => {
  const f = fakeFirebase();
  SyncAuth._setLoader(async () => f.mod);
  const seen = [];
  const off = SyncAuth.onAuth(s => seen.push(s.status));
  eq((await SyncAuth.initAuth({ config: FAKE_CFG })).status, 'signedOut', '最初は未ログイン');
  const r = await SyncAuth.signIn();
  eq([r.status, r.user.uid, r.user.name, f.calls.some(c => c[0] === 'popup' && c[1] === 'select_account')], ['signedIn', 'uid-123', 'テスト先生', true], 'ポップアップでログイン');
  eq((await SyncAuth.signOut()).status, 'signedOut', 'ログアウト');
  fakeFirebase.fail = 'auth/popup-blocked';
  const r2 = await SyncAuth.signIn();
  fakeFirebase.fail = null;
  eq([r2.status, r2.error.title], ['signedOut', 'ログイン画面がブロックされました'], 'ポップアップが止められたとき');
  for (const code of ['auth/popup-closed-by-user', 'auth/unauthorized-domain', 'auth/network-request-failed', 'auth/operation-not-supported-in-this-environment', 'sdk-load-failed', 'auth/what']) {
    const m = SyncAuth.authErrorMessage({ code });
    assert(m.title && m.how && !/[a-z]{6,}/i.test(m.title.replace(/Firebase|Google/g, '')), `「${code}」の日本語表示`);
  }
  off();
  assert(seen.includes('signedIn') && seen.includes('signedOut'), '状態の通知');
  SyncAuth._setLoader(null);
});

test('【Sync-1】ログイン機能はFactoryのデータに一切触れない（db.js・Firestoreを使わない）', async () => {
  const src = await (await fetch('../js/sync/auth.js', { cache: 'no-cache' })).text();
  const view = await (await fetch('../js/views/account.js', { cache: 'no-cache' })).text();
  for (const [name, code] of [['auth.js', src], ['account.js', view]]) {
    assert(!/from ['"][^'"]*db\.js['"]/.test(code), `${name} が db.js を読み込んでいる`);
    assert(!/firebase-firestore|getFirestore|indexedDB\.open|FactoryDB/.test(code), `${name} がデータベースを使っている`);
  }
  const app = await (await fetch('../js/app.js', { cache: 'no-cache' })).text();
  assert(!/initAuth\(/.test(app.split('async function boot')[1].split('// 画面部品へ渡す共通情報')[0]), '起動時にFirebaseを読み込んでいる');
  // にせFirebaseでログイン→ログアウトしても、テスト用DBの中身は1件も変わらない
  const before = JSON.stringify((await db.exportAll()).data);
  const f = fakeFirebase(); SyncAuth._setLoader(async () => f.mod);
  await SyncAuth.initAuth({ config: FAKE_CFG }); await SyncAuth.signIn(); await SyncAuth.signOut();
  SyncAuth._setLoader(null);
  eq(JSON.stringify((await db.exportAll()).data), before, 'ログイン操作でFactoryのデータが変わった');
});


test('【Sync-1 v0.8.1】iPhone対応：どの端末でもポップアップ方式（リダイレクト方式は使わない）', async () => {
  const src = await (await fetch('../js/sync/auth.js', { cache: 'no-cache' })).text();
  assert(!/\bsignInWithRedirect\s*\(|\bgetRedirectResult\s*\(/.test(src), 'リダイレクト方式を使っている');
  const env = (ua, standalone = false, touch = 5) => SyncAuth.envInfo({ userAgent: ua, standalone, maxTouchPoints: touch }, null);
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0';
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  eq([env(IPHONE).ios, env(IPHONE).standalone, env(IPHONE, true).standalone, env(EDGE, false, 0).ios, env(IPAD, false, 5).ios], [true, false, true, false, true], '端末の判定');
  for (const e of [env(EDGE, false, 0), env(IPHONE), env(IPHONE, true), env(IPAD)]) eq(SyncAuth.signInPlan(e).method, 'popup', 'ポップアップ方式');
  eq([SyncAuth.signInPlan(env(EDGE, false, 0)).watchdogMs, SyncAuth.signInPlan(env(IPHONE, true)).watchdogMs > 0, SyncAuth.signInPlan(env(IPHONE)).watchdogMs > 0], [0, true, true], 'iPhoneだけ待ち時間の上限');
  const home = SyncAuth.authErrorMessage({ code: 'popup-timeout' }, { ios: true, standalone: true });
  assert(home.title.includes('ホーム画面版') && home.how.includes('Safari') && home.how.includes('missing initial state'), 'ホーム画面版の案内');
  const blocked = SyncAuth.authErrorMessage({ code: 'auth/popup-blocked' }, { ios: true });
  assert(blocked.how.includes('ポップアップブロック') && blocked.how.includes('オフ'), 'iPhoneのポップアップブロックの案内');
  assert(SyncAuth.authErrorMessage({ code: 'auth/popup-blocked' }, {}).how.includes('ポップアップを許可'), 'PCのポップアップブロックの案内');
});

test('【Sync-1 v0.8.1】ボタンを押した直後にポップアップを開く・結果が戻らないときは案内（あとで戻ればログイン済み）', async () => {
  // 1) 準備済みなら、待たずにすぐ signInWithPopup を呼ぶ（iPhone Safariのポップアップ制限への対策）
  const f = fakeFirebase();
  SyncAuth._setLoader(async () => f.mod);
  await SyncAuth.initAuth({ config: FAKE_CFG });
  const p = SyncAuth.signIn({ env: { ios: true, standalone: false }, watchdogMs: 0 });
  assert(f.calls.some(c => c[0] === 'popup'), 'ボタンを押した直後にポップアップを開いていない');
  eq((await p).status, 'signedIn', 'ログイン');
  await SyncAuth.signOut();
  // 2) ホーム画面版で結果が戻らない → 上限時間で案内、画面は固まらない
  let release;
  f.mod.auth.signInWithPopup = () => new Promise(r => { release = r; });
  const r = await SyncAuth.signIn({ env: { ios: true, standalone: true }, watchdogMs: 50 });
  eq([r.status, r.pending, r.error?.code], ['signedOut', false, 'popup-timeout'], '結果が戻らないときの案内');
  assert(r.error.title.includes('ホーム画面版'), 'ホーム画面版の案内文');
  // 3) あとから結果が戻れば、ログイン済みに切り替わる
  release({ user: { uid: 'late-1', displayName: '遅れて完了', email: 'x@example.com', providerData: [] } });
  await sleep(20);
  eq([SyncAuth.authState().status, SyncAuth.authState().user?.uid, SyncAuth.authState().error], ['signedIn', 'late-1', null], '遅れて完了');
  SyncAuth._setLoader(null);
});


// ---------------- Phase Sync-2-1：クラウドの状態を確認（読み取りのみ） ----------------
function fakeFirestore(mode) {
  const ops = [];
  const mod = {
    getFirestore: app => { ops.push(['getFirestore', app?.name]); return { app }; },
    doc: (db, ...path) => { ops.push(['doc', path.join('/')]); return { path: path.join('/') }; },
    getDocFromServer: async ref => {
      ops.push(['getDocFromServer', ref.path]);
      if (mode.value === 'denied') { const e = new Error('x'); e.code = 'permission-denied'; throw e; }
      if (mode.value === 'unavailable') { const e = new Error('x'); e.code = 'unavailable'; throw e; }
      if (mode.value === 'registered') return { exists: () => true, data: () => ({ status: 'complete', sourceDevice: 'PC（Edge）', generation: 1, registeredAt: { toDate: () => new Date('2026-10-06T01:00:00Z') }, counts: { projects: 8, specs: 8 }, projectNames: ['Vintage Hunt'] }) };
      if (mode.value === 'weird') return { exists: () => true, data: () => ({ status: 123 }) };
      return { exists: () => false, data: () => undefined };
    },
  };
  return { ops, mod };
}

test('【Sync-2-1】クラウドの確認は読むだけ（書き込みの命令を持たない・Factoryのデータに触れない）', async () => {
  const src = await (await fetch('../js/sync/cloud.js', { cache: 'no-cache' })).text();
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert(!/\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction|setDocs|deleteField)\b/.test(code), 'cloud.js に書き込みの命令がある');
  assert(!/from ['"][^'"]*db\.js['"]|indexedDB|FactoryDB|localStorage|sessionStorage/.test(code), 'cloud.js が端末のデータや保存領域を使っている');
  assert(/getDocFromServer/.test(code), 'クラウドの最新を読んでいない');
  eq(SyncCloud.META_PATH('u1').join('/'), 'users/u1/meta/factory', '読む場所');
  eq(SyncCloud.FIRESTORE_URL, 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js', 'Firestoreの部品（公式配布元・同じ版）');
  const app = await (await fetch('../js/app.js', { cache: 'no-cache' })).text();
  assert(!/cloud\.js|checkCloudStatus/.test(app.split('async function boot')[1].split('// 画面部品へ渡す共通情報')[0]), '起動時にクラウドを確認している');
  // 印の読み取り結果の整理・エラーの日本語
  eq(SyncCloud.describeMeta({ status: 'complete', sourceDevice: 'PC', generation: 2, counts: { projects: 8, bad: 'x' }, registeredAt: '2026-10-06T00:00:00Z' }), { state: 'registered', registeredAt: '2026-10-06T00:00:00Z', sourceDevice: 'PC', generation: 2, counts: { projects: 8 }, projectNames: [] }, '登録済み');
  eq(SyncCloud.describeMeta({ status: 'uploading' }).state, 'uploading', '登録途中');
  eq([SyncCloud.describeMeta(null).state, SyncCloud.describeMeta({ status: 'x' }).state], ['unknown', 'unknown'], '想定外の形');
  for (const c of ['permission-denied', 'unavailable', 'not-found', 'resource-exhausted', 'sdk-load-failed', 'firestore/permission-denied', 'zzz']) {
    const m = SyncCloud.cloudErrorMessage({ code: c }); assert(m.title && m.how, `「${c}」の日本語表示`);
  }
  assert(SyncCloud.cloudErrorMessage({ code: 'resource-exhausted' }).how.includes('料金は発生しません'), '無料枠の案内');
});

test('【Sync-2-1】クラウドの状態：未ログイン・オフライン・空・登録済み・許可なし・接続不可（読むのは1件だけ）', async () => {
  const mode = { value: 'empty' };
  const f = fakeFirebase(), fs = fakeFirestore(mode);
  let loads = 0;
  SyncAuth._setLoader(async () => f.mod);
  SyncCloud._setFirestoreLoader(async () => { loads++; return fs.mod; });
  await SyncAuth.initAuth({ config: FAKE_CFG });
  eq([(await SyncCloud.checkCloudStatus()).state, loads], ['signedOut', 0], '未ログインならFirestoreを読み込まない');
  await SyncAuth.signIn({ env: {}, watchdogMs: 0 });
  eq([(await SyncCloud.checkCloudStatus({ online: false })).state, loads], ['offline', 0], 'オフラインなら接続しない');
  const before = JSON.stringify((await db.exportAll()).data);
  const r1 = await SyncCloud.checkCloudStatus({ online: true });
  eq([r1.state, r1.uid], ['empty', 'uid-123'], 'クラウドは空');
  mode.value = 'registered';
  const r2 = await SyncCloud.checkCloudStatus({ online: true });
  eq([r2.state, r2.sourceDevice, r2.generation, r2.counts.projects, r2.registeredAt], ['registered', 'PC（Edge）', 1, 8, '2026-10-06T01:00:00.000Z'], '登録済み');
  mode.value = 'weird'; eq((await SyncCloud.checkCloudStatus({ online: true })).state, 'unknown', '想定外の形');
  mode.value = 'denied';
  const r3 = await SyncCloud.checkCloudStatus({ online: true });
  eq([r3.state, r3.error.title], ['denied', 'クラウドを使う許可がありません'], '許可なし（owners未登録など）');
  mode.value = 'unavailable'; eq((await SyncCloud.checkCloudStatus({ online: true })).state, 'offline', '接続できない');
  // 使った命令は「読む」だけ・読む場所は自分の印だけ
  const names = [...new Set(fs.ops.map(o => o[0]))].sort();
  eq(names, ['doc', 'getDocFromServer', 'getFirestore'], '使った命令');
  assert(fs.ops.filter(o => o[0] === 'getDocFromServer').every(o => o[1] === 'users/uid-123/meta/factory'), '自分の印以外を読んだ');
  eq(JSON.stringify((await db.exportAll()).data), before, 'Factoryのデータが変わった');
  SyncCloud._setFirestoreLoader(null); SyncAuth._setLoader(null);
});


// ---------------- Phase Sync-2-2：登録の予行演習（確認だけ） ----------------
test('【Sync-2-2】予行演習はクラウドへ送らず、端末のデータも変更しない（命令を持たない）', async () => {
  for (const f of ['../js/sync/dryrun.js', '../js/views/synccheck.js']) {
    const code = (await (await fetch(f, { cache: 'no-cache' })).text()).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert(!/firebase|gstatic|cloud\.js|checkCloudStatus|initAuth|signIn\(/.test(code), `${f} がクラウド・Firebaseを使っている`);
    assert(!/\.(create|update|upsert|remove|purge|restore|importAll|saveGuide|setOrigin|saveExisting)\(|downloadBackup|indexedDB\.|localStorage\.setItem/.test(code), `${f} に書き込みの命令がある`);
  }
  eq(Dry.SYNC_TARGET_STORES.includes('history') && Dry.SYNC_TARGET_STORES.includes('specs') && Dry.DEVICE_LOCAL_SETTINGS.join(), true && 'master,lastTestRun,lastBackup', '同期の対象・対象外');
});

test('【Sync-2-2】件数・プロジェクト名・同期しないもの・大きすぎるデータ・バックアップ可否・個人情報らしき記述', async () => {
  const big = 'x'.repeat(950000);
  const exp = { app: '3ai-factory', schemaVersion: 5, exportedAt: '2026-10-05T00:00:00Z', deviceId: 'd1', data: {
    projects: [{ id: 'p1', name: 'Vintage Hunt', createdAt: '1', updatedAt: '2026-10-05T01:00:00Z', createdBy: '田中先生' }, { id: 'p2', name: 'Vintage Hunt', createdAt: '2', updatedAt: '2026-10-04T00:00:00Z' }, { id: 'p3', name: '秘密メモ', localOnly: true }],
    specs: [{ id: 's1', projectId: 'p1', body: '連絡は tanaka@example.jp まで' }], requests: [{ id: 'r1', title: '田中君の練習を見る' }, { id: 'r2', title: '田中君と練習' }],
    files: [{ id: 'f1', fileName: 'big.html', code: big }], history: [{ id: 'h1', store: 'projects', after: { memo: '電話 090-1234-5678' } }],
    settings: [{ id: 'master', key: 'master', value: {} }, { id: 'lastTestRun', key: 'lastTestRun', value: {} }, { id: 'profile', key: 'profile', value: { name: '佐藤' } }],
    compares: [], tests: [], urls: [], issues: [], ideas: [], tasks: [], guides: [], handoff: [], checks: [], trash: [],
  } };
  const r = Dry.analyzeForSync(exp, { expectedProjects: ['3AI Development Factory', 'Vintage Hunt'], checkBackup: j => FactoryDB.checkBackup(j) });
  eq([r.main.projects, r.main.specs, r.main.requests, r.main.history, r.counts.settings, r.total], [2, 1, 2, 1, 1, 8], '件数（同期の対象だけ）');
  eq([r.excluded.localOnly, r.excluded.deviceSettings.sort().join()], [1, 'lastTestRun,master'], '同期しないもの');
  eq([r.projects.names.join(), r.projects.dupNames.join(), r.projects.missing.join()], ['Vintage Hunt,Vintage Hunt', 'Vintage Hunt', '3AI Development Factory'], 'プロジェクト名・重複・不足');
  eq([r.size.tooLarge.length, r.size.tooLarge[0].label], [1, 'big.html'], '大きすぎるデータ');
  eq([r.backup.ok, r.backup.bytes > 950000, r.blocking], [true, true, false], 'バックアップ可否');
  eq(r.lastUpdated, '2026-10-05T01:00:00Z', '最後の更新');
  const kinds = r.privacy.map(p => p.kind + ':' + p.text);
  for (const w of ['メールアドレス:tanaka@example.jp', '人名らしき言葉:田中君', '電話番号:090-1234-5678']) assert(kinds.includes(w), `個人情報らしき記述「${w}」`);
  eq(r.privacy.find(p => p.text === '田中君').count, 2, '同じ言葉はまとめて数える');
  assert(!kinds.some(k => k.includes('田中先生')), '作成者名（管理用の情報）まで指摘している');
  assert(r.issues.length >= 4, '確認が必要な点');
  // バックアップが作れない場合
  const bad = Dry.analyzeForSync({ ...exp, app: 'other' }, { checkBackup: j => FactoryDB.checkBackup(j) });
  eq([bad.backup.ok, bad.blocking, bad.issues[0]], [false, true, 'バックアップを作れません'], 'バックアップ不可は初回登録に進めない');
  // データの指紋：中身が同じなら同じ・違えば違う（並び順には左右されない）
  const f1 = await Dry.fingerprint(r.targetsForFingerprint);
  const f2 = await Dry.fingerprint(r.targetsForFingerprint.slice().reverse());
  const f3 = await Dry.fingerprint(r.targetsForFingerprint.map(([s, x]) => [s, s === 'specs' ? { ...x, body: '別' } : x]));
  eq([f1 === f2, f1 === f3, f1.length >= 11], [true, false, true], 'データの指紋');
  assert(Dry.summaryText(r, { device: 'PC', fp: f1, checkedAt: 'now' }).includes('プロジェクト：2件（Vintage Hunt、Vintage Hunt）'), 'コピー用の文章');
});

test('【Sync-2-2】Phase 7の8プロジェクトがある端末で予行演習しても、データは1件も変わらない', async () => {
  await delDB('factory-test22');
  const d = await FactoryDB.open('factory-test22'); d.actor = 'テスト担当'; await loadMaster(d);
  const seed = await loadInitialProjects(); await seedInitialProjects(d, seed);
  const before = JSON.stringify((await d.exportAll()).data);
  const exp = await d.exportAll();
  const r = Dry.analyzeForSync(exp, { master: d.master, expectedProjects: [seed.factory.name, ...seed.projects.map(p => p.name)], checkBackup: j => FactoryDB.checkBackup(j) });
  eq([r.projects.count, r.projects.missing.length, r.projects.dupNames.length, r.main.specs, r.backup.ok, r.size.tooLarge.length], [8, 0, 0, 8, true, 0], '8プロジェクトの端末');
  eq(r.projects.names, [seed.factory.name, ...seed.projects.map(p => p.name)], 'Phase 7の順（Factory本体 → 開発順）で並ぶ');
  eq(r.privacy.length, 0, '仕様の一般的な言葉（生徒・保護者など）を個人情報として数えない');
  assert(r.main.history > 0 && r.counts.tests >= 7 * 17 && r.counts.tasks >= 14, '変更履歴・テスト・次にやることを数えている');
  await Dry.fingerprint(r.targetsForFingerprint);
  eq(JSON.stringify((await d.exportAll()).data), before, '予行演習でデータが変わった');
  d.close(); await delDB('factory-test22');
});


test('【Sync-2-2】個人情報チェックは長いコード（30万文字）でも固まらない', async () => {
  for (const ch of ['x', '1', 'a.', 'ab1-']) {
    const t = performance.now(); findPersonalInfo(ch.repeat(Math.ceil(300000 / ch.length))); const ms = performance.now() - t;
    assert(ms < 3000, `「${ch}」の繰り返しで ${Math.round(ms)}ms かかった`);
  }
  const f = findPersonalInfo('連絡 tanaka@example.jp / a.b+c@mail.co.jp').map(x => x.text);
  eq(f, ['tanaka@example.jp', 'a.b+c@mail.co.jp'], 'メールアドレスの判定は今までどおり');
});


test('【v0.8.4】個人情報チェック：日付・日時の数字を電話番号・郵便番号と間違えない（本物は今までどおり見つける）', async () => {
  const neg = ['factory-backup-20261005-1023.json', '20261005-1023', '2026-10-05T01:23:45.678Z', '2026/10/05 10:23', '2026年10月5日 10:23', '確定 2026-10-05T10:23:00+09:00', 'id m8k2026100510231x', '12345-6789-0123'];
  for (const t of neg) eq(findPersonalInfo(t).map(f => f.kind + ':' + f.text), [], `「${t}」を誤検出`);
  const pos = [['090-1234-5678', '電話番号:090-1234-5678'], ['03-1234-5678', '電話番号:03-1234-5678'], ['0465-12-3456', '電話番号:0465-12-3456'], ['+81 90-1234-5678', '電話番号:+81 90-1234-5678'], ['TEL:03-1234-5678', '電話番号:03-1234-5678'],
    ['〒350-1305', '郵便番号:〒350-1305'], ['350-1305', '郵便番号:350-1305'], ['学籍番号：12345', '学籍番号・出席番号らしき数字:学籍番号：12345'], ['tanaka@example.jp', 'メールアドレス:tanaka@example.jp']];
  for (const [t, want] of pos) assert(findPersonalInfo(t).map(f => f.kind + ':' + f.text).includes(want), `「${t}」を見つけられない`);
  eq(findPersonalInfo('090-1234-5678').length, 1, '電話番号の一部を郵便番号として二重に数えない');
  // 日付の近くにあっても本物は見つける
  assert(findPersonalInfo('2026-10-05 電話 090-1234-5678').some(f => f.text === '090-1234-5678'), '日付の近くの電話番号');
  // 匿名化も日付は変えない
  eq(anonymize('電話090-1234-5678、〒350-1305、保存 factory-backup-20261005-1023.json 2026-10-05T10:23:00Z'), '電話[電話番号]、[郵便番号]、保存 factory-backup-20261005-1023.json 2026-10-05T10:23:00Z', '匿名化');
  // 予行演習：変更履歴の日時・バックアップのファイル名を数えない
  const exp = { app: '3ai-factory', schemaVersion: 5, data: { settings: [{ id: 'profile', key: 'profile', value: { name: '先生' } }],
    history: [{ id: 'h1', store: 'settings', action: 'create', at: '2026-10-05T10:23:00.000Z', changes: { value: { from: null, to: { at: '2026-10-05T10:23:00.000Z', fileName: 'factory-backup-20261005-1023.json' } } } }],
    projects: [{ id: 'p', name: 'X', memo: '連絡 090-1111-2222', fixedAt: '2026-10-05T10:23:00Z', note: '2026-10-05' }] } };
  const r = Dry.analyzeForSync(exp, {});
  eq(r.privacy.map(p => p.kind + ':' + p.text), ['電話番号:090-1111-2222'], '予行演習の個人情報らしき記述');
});


// ---------------- Phase Sync-2-3：初回正本登録 ----------------
// 端末の中だけで動く「にせFirestore」（本物と同じ命令の形。削除の命令は持たない）
function memFirestore() {
  const docs = new Map(); const ops = []; const ctl = { failCommitAt: 0, commits: 0, corrupt: null };
  const merge = (a, b) => ({ ...(a || {}), ...b });
  const mod = {
    getFirestore: () => ({}),
    doc: (db, ...p) => ({ path: p.join('/'), id: p[p.length - 1] }),
    collection: (db, ...p) => ({ path: p.join('/') }),
    serverTimestamp: () => ({ __ts: true }),
    getDocFromServer: async ref => { ops.push(['get', ref.path]); const d = docs.get(ref.path); return { exists: () => !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; },
    getDocsFromServer: async col => { ops.push(['list', col.path]); const list = [...docs.entries()].filter(([k]) => k.startsWith(col.path + '/') && !k.slice(col.path.length + 1).includes('/')); return { size: list.length, forEach: f => list.forEach(([k, v]) => f({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(v)) })) }; },
    setDoc: async (ref, data, opt) => { ops.push(['setDoc', ref.path]); docs.set(ref.path, opt?.merge ? merge(docs.get(ref.path), data) : { ...data }); },
    // トランザクション：読んでから書く。書き込みは最後にまとめて（途中で失敗すれば何も書かない）
    runTransaction: async (db, fn) => {
      ctl.tx = (ctl.tx || 0) + 1; const pend = [];
      const t = { get: async ref => { ops.push(['txGet', ref.path]); const d = docs.get(ref.path); return { exists: () => !!d, data: () => d && JSON.parse(JSON.stringify(d)) }; }, set: (ref, data, opt) => { pend.push([ref.path, data, opt]); } };
      const r = await fn(t);
      if (ctl.beforeCommit) { const f = ctl.beforeCommit; ctl.beforeCommit = null; f(); }
      if (ctl.failTxAt && ctl.tx === ctl.failTxAt) { const e = new Error('x'); e.code = 'unavailable'; throw e; }
      for (const [k, v, opt] of pend) { ops.push(['txSet', k]); docs.set(k, opt?.merge ? { ...(docs.get(k) || {}), ...v } : { ...v }); }
      return r;
    },
    writeBatch: () => { const pend = []; return { set: (ref, data) => pend.push([ref.path, data]), commit: async () => {
      ctl.commits++; if (ctl.failCommitAt && ctl.commits === ctl.failCommitAt) { const e = new Error('x'); e.code = 'unavailable'; throw e; }
      for (const [k, v] of pend) { ops.push(['batchSet', k]); docs.set(k, ctl.corrupt && k.endsWith(ctl.corrupt) ? { ...v, json: '{"broken":true}' } : { ...v }); }
    } }; },
  };
  return { docs, ops, ctl, mod };
}
async function regEnv() {
  const f = fakeFirebase(), cloud = memFirestore();
  SyncAuth._setLoader(async () => f.mod); SyncCloud._setFirestoreLoader(async () => cloud.mod);
  await SyncAuth.initAuth({ config: FAKE_CFG });
  await SyncAuth.signIn({ env: {}, watchdogMs: 0 });
  // 前のテスト環境の後始末が遅いSafariでも、現在のにせ認証が確実に有効になってから進む。
  if (!SyncAuth.currentUid?.() && !SyncAuth.authState?.().user?.uid) await SyncAuth.signIn({ env: {}, watchdogMs: 0 });
  await delDB('factory-test23');
  const d = await FactoryDB.open('factory-test23'); d.actor = 'テスト担当'; await loadMaster(d);
  const seed = await loadInitialProjects(); await seedInitialProjects(d, seed);
  // 大きいコードを書き換えて、1MBを超える変更履歴を作る（分割して送る記録）
  const vh = (await d.all('projects')).find(p => p.seedKey === 'vintage-hunt');
  const fl = await d.create('files', { projectId: vh.id, fileName: 'big.html', status: 'active', code: 'あ'.repeat(290000) });
  await d.update('files', fl.id, { code: 'い'.repeat(290000) }, { reason: '書き換え' });
  await d.upsert('settings', 'lastTestRun', { key: 'lastTestRun', value: { total: 1 } }, {});
  return { d, cloud, seed, done: async () => { d.close(); await delDB('factory-test23'); SyncCloud._setFirestoreLoader(null); SyncAuth._setLoader(null); } };
}

test('【Sync-2-3】初回登録の仕組み：削除の命令を持たない・Factoryのデータベースに書き込まない', async () => {
  const code = f => fetch(f, { cache: 'no-cache' }).then(r => r.text()).then(t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
  const reg = await code('../js/sync/register.js'), view = await code('../js/views/syncregister.js');
  for (const [n, c] of [['register.js', reg], ['syncregister.js', view]]) {
    assert(!/deleteDoc|\.delete\(|deleteField|clear\(\)/.test(c), `${n} に削除の命令がある`);
    assert(!/\.(create|update|upsert|remove|purge|restore|importAll)\(/.test(c), `${n} がFactoryのデータを書き換える`);
  }
  assert(!/from ['"][^'"]*db\.js['"]/.test(reg), 'register.js が db.js を読み込んでいる');
  eq([Reg.SYNC_DB !== 'factory', Reg.encodeId('__factory__'), Reg.encodeId('a/b c'), /^__.*__$/.test(Reg.encodeId('__x__'))], [true, 'r-__factory__', 'r-a~2f~b~20~c', false], 'ドキュメントIDの変換');
  const parts = Reg.splitChunks('x'.repeat(600001), 250000);
  eq([parts.length, parts.join('').length], [3, 600001], '分割と復元');
});

test('【Sync-2-3】初回登録：バックアップ → 送信 → 全件照合 → 登録済み（Factoryのデータは1件も変わらない）', async () => {
  const E = await regEnv();
  try {
    const before = JSON.stringify((await E.d.exportAll()).data);
    const exp = await E.d.exportAll();
    const snap = await Reg.saveSnapshot(exp, { deviceKind: 'PC' });
    eq(snap.ok, true, '端末内の控え（読み直しで確認）');
    eq(JSON.parse((await Reg.getSnapshot(snap.id)).json).data.projects.length, 8, '控えに8プロジェクト');
    const plan = await Reg.buildPlan(exp, { expectedProjects: [E.seed.factory.name, ...E.seed.projects.map(p => p.name)] });
    assert(plan.total > 300 && plan.chunked >= 1, `送る件数 ${plan.total}・分割 ${plan.chunked}`);
    assert(!plan.items.some(i => i.store === 'settings' && ['master', 'lastTestRun'].includes(i.id)), '端末ごとの設定を送ろうとしている');
    eq(plan.projectNames, [E.seed.factory.name, ...E.seed.projects.map(p => p.name)], 'プロジェクト名');
    const phases = [];
    const r = await Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC（Edge）', appVersion: '0.8.4', schemaVersion: exp.schemaVersion, onProgress: ph => phases.push(ph) });
    eq([r.checked, r.meta.state, r.meta.sourceDevice, r.meta.counts.projects], [plan.total, 'registered', 'PC（Edge）', 8], '登録済み');
    assert(['check', 'upload', 'verify', 'done'].every(p => phases.includes(p)), '進み具合の表示');
    // クラウドの中身：全件・内容の指紋・分割された記録の復元
    const docs = [...E.cloud.docs.entries()].filter(([k]) => !k.includes('/meta/') && !k.includes('/chunks/'));
    eq(docs.length, plan.total, 'クラウドの件数');
    const big = plan.items.find(i => i.parts);
    const joined = [...E.cloud.docs.entries()].filter(([k]) => k.includes('/chunks/') && k.includes(big.docId)).sort((a, b) => a[1].index - b[1].index).map(([, v]) => v.json).join('');
    eq(await Reg.sha256(joined), big.hash, '分割した記録をつなぐと元どおり');
    eq(E.cloud.ops.filter(o => /delete/i.test(o[0])).length, 0, '削除の命令');
    const st = await Reg.getSyncState();
    eq([st.status, Object.keys(st.hashes).length], ['complete', plan.total], '照合用の記録（別のデータベース）');
    eq(JSON.stringify((await E.d.exportAll()).data), before, 'Factoryのデータが変わった');
    // 登録済みのクラウドには、もう一度登録できない（どの端末からも）
    for (const dev of ['dev-pc', 'dev-iphone']) {
      const e = await rejects(Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: dev, deviceLabel: 'x' }), '登録済みなのに登録できた');
      eq(e.code, 'not-allowed', '登録済みは断る');
    }
  } finally { await E.done(); }
});

test('【Sync-2-3】途中で失敗しても続きから送れる・照合が合わなければ「登録済み」にしない・別の端末の途中は引き継がない', async () => {
  const E = await regEnv();
  try {
    const exp = await E.d.exportAll(); const snap = await Reg.saveSnapshot(exp); const plan = await Reg.buildPlan(exp);
    // 2回目の送信で接続が切れる
    E.cloud.ctl.failCommitAt = 2;
    const e1 = await rejects(Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC' }), '途中失敗なのに成功した');
    eq(e1.code, 'unavailable', '接続が切れた');
    const m1 = await Reg.readMeta();
    eq([m1.state, m1.raw.sourceDeviceId], ['uploading', 'dev-pc'], '「登録途中」のまま（ほかの端末は取り込まない）');
    // 別の端末からは登録できない
    eq(Reg.cloudAllows(m1, 'dev-iphone').ok, false, '別の端末は途中を引き継がない');
    eq([Reg.cloudAllows(m1, 'dev-pc').ok, Reg.cloudAllows(m1, 'dev-pc').resume], [true, true], '同じ端末は続きから送れる');
    // 照合が合わない（1件だけ壊れて保存される）→ 登録済みにしない
    E.cloud.ctl.failCommitAt = 0;
    const victim = plan.items.find(i => !i.parts && i.store === 'specs');
    E.cloud.ctl.corrupt = victim.docId;
    const e2 = await rejects(Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC' }), '壊れているのに登録済みになった');
    eq([e2.code, e2.mismatches.length, (await Reg.readMeta()).state], ['verify-failed', 1, 'uploading'], '照合が合わなければ登録途中のまま');
    // 直ったら、もう一度送って完了（同じ登録番号）
    E.cloud.ctl.corrupt = null;
    const r = await Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC' });
    eq([r.meta.state, r.uploadId, r.checked], ['registered', m1.raw.uploadId, plan.total], '続きから送って完了');
    // 未ログインでは送れない
    await SyncAuth.signOut();
    eq((await rejects(Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC' }), '未ログインで送れた')).code, 'unauthenticated', '未ログイン');
  } finally { await E.done(); }
});


// ---------------- Phase Sync-2-4：この端末への取り込み（クラウド → 端末の一方向） ----------------
// 「PC（初回正本）」から登録したクラウドを、少しだけデータのある「iPhone」へ取り込む
async function pullEnv() {
  const E = await regEnv();                       // PC役（8プロジェクト）＋にせクラウド
  const exp = await E.d.exportAll();
  const snap = await Reg.saveSnapshot(exp);
  const plan = await Reg.buildPlan(exp);
  await Reg.runRegistration({ plan, snapshotId: snap.id, deviceId: 'dev-pc', deviceLabel: 'PC（Edge）', schemaVersion: exp.schemaVersion });
  await delDB('factory-test24');
  const ip = await FactoryDB.open('factory-test24'); ip.actor = 'iPhone'; await loadMaster(ip);
  // iPhoneの今のデータ：プロジェクト0件だが、変更履歴などが少しある・端末ごとの記録・この端末だけの記録
  const tmp = await ip.create('ideas', { text: 'iPhoneで書いたメモ', status: 'new' }); await ip.remove('ideas', tmp.id);
  await ip.upsert('settings', 'lastTestRun', { key: 'lastTestRun', value: { total: 61, passed: 61 } }, {});
  await ip.create('ideas', { text: 'この端末だけの記録', status: 'new', localOnly: true });
  const cloudBefore = JSON.stringify([...E.cloud.docs.entries()]);
  const opsStart = E.cloud.ops.length;
  return { ...E, ip, plan, cloudBefore, opsStart, done2: async () => { ip.close(); await delDB('factory-test24'); await E.done(); } };
}

test('【Sync-2-4】取り込みの仕組み：クラウドへ書き込む・削除する命令を持たない', async () => {
  const code = f => fetch(f, { cache: 'no-cache' }).then(r => r.text()).then(t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
  for (const f of ['../js/sync/pull.js', '../js/views/syncimport.js']) {
    const c = await code(f);
    assert(!/setDoc|writeBatch|updateDoc|addDoc|deleteDoc|runTransaction|\.delete\(/.test(c), `${f} にクラウドへの書き込み・削除の命令がある`);
    assert(!/\.(create|update|upsert|remove|purge|restore)\(/.test(c), `${f} がFactoryのデータを1件ずつ書き換える`);
  }
  assert(/importAll/.test(await code('../js/sync/pull.js')), '置き換えは「全部成功するか、何も変わらないか」の仕組みで行う');
});

test('【Sync-2-4】取り込み：内容の事前表示 → バックアップ → 取り込み → 全件照合（クラウドは変わらない・端末ごとの記録は残る）', async () => {
  const E = await pullEnv();
  try {
    const cloud = await Pull.readCloudData();
    eq([cloud.ok, cloud.total, cloud.counts.projects, cloud.fingerprint === E.plan.fingerprint, cloud.meta.sourceDevice], [true, E.plan.total, 8, true, 'PC（Edge）'], 'クラウドの内容（全件の指紋を確認）');
    const before = await E.ip.exportAll();
    const local = Pull.localSummary(before);
    eq([local.isEmpty, local.projects.count, local.total > 0], [false, 0, true], 'iPhoneは空ではない（プロジェクト0件・変更履歴あり）');
    const snap = await Pull.saveSnapshot(before, { deviceKind: 'iPhone' });
    eq(snap.ok, true, '取り込み前の控え');
    const phases = [];
    const r = await Pull.runImport(E.ip, { snapshotId: snap.id, expectedFingerprint: cloud.fingerprint, onProgress: p => phases.push(p) });
    eq([r.checked, r.total], [E.plan.total, E.plan.total], '全件照合');
    assert(['read', 'write', 'verify', 'done'].every(p => phases.includes(p)), '進み具合');
    const after = await E.ip.exportAll();
    eq(after.data.projects.map(p => p.name).sort(), E.plan.projectNames.slice().sort(), '8プロジェクトがiPhoneに');
    assert(after.data.settings.some(x => x.id === 'lastTestRun' && x.value.total === 61), '端末ごとの記録（自動テスト結果）は残る');
    assert(after.data.ideas.some(x => x.localOnly && x.text === 'この端末だけの記録'), 'この端末だけの記録は残る');
    assert(after.data.history.some(h => h.action === 'import' && h.reason.includes('クラウドから取り込み')), '取り込みの記録');
    eq(JSON.stringify([...E.cloud.docs.entries()]), E.cloudBefore, 'クラウドのデータが変わった');
    eq([...new Set(E.cloud.ops.slice(E.opsStart).map(o => o[0]))].sort(), ['get', 'list'], '取り込みでクラウドに使った命令は「読む」だけ');
    const st = await Pull.getImportState();
    eq([st.status, Object.keys(st.hashes).length], ['complete', E.plan.total], '照合用の記録（別のデータベース）');
    // 取り込み後は、iPhoneのデータとクラウドが同じ（指紋が一致）
    const fpAfter = await Dry.fingerprint(Dry.analyzeForSync({ data: Object.fromEntries(Object.entries(after.data).map(([s, rows]) => [s, rows.filter(x => !(s === 'history' && x.action === 'import') && !x.localOnly)])) }).targetsForFingerprint);
    eq(fpAfter, cloud.fingerprint, '取り込み後の指紋');
  } finally { await E.done2(); }
});

test('【Sync-2-4】照合が合わなければ取り込み前へ自動で戻す・クラウドの問題や端末の変化があれば取り込まない', async () => {
  const E = await pullEnv();
  try {
    const cloud = await Pull.readCloudData();
    const before = await E.ip.exportAll();
    const beforeJson = JSON.stringify(before.data);
    const snap = await Pull.saveSnapshot(before);
    // 1) 書き込みで1件だけ欠ける → 照合が合わない → 取り込み前に戻る
    const real = E.ip.importAll.bind(E.ip);
    let calls = 0;
    E.ip.importAll = async (json, o) => { calls++; if (calls === 1) { json = JSON.parse(JSON.stringify(json)); json.data.specs.pop(); json.counts.specs--; } return real(json, o); };
    const e1 = await rejects(Pull.runImport(E.ip, { snapshotId: snap.id, expectedFingerprint: cloud.fingerprint }), '欠けているのに取り込み完了になった');
    eq([e1.code, calls], ['verify-failed', 2], '照合が合わない → 取り込み前へ戻す');
    const restored = await E.ip.exportAll();
    eq(JSON.stringify(Object.fromEntries(Object.entries(restored.data).map(([s, r]) => [s, r.filter(x => !(s === 'history' && x.action === 'import'))]))), JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(beforeJson)).map(([s, r]) => [s, r.filter(x => !(s === 'history' && x.action === 'import'))]))), '取り込み前のデータに戻った');
    E.ip.importAll = real;
    // 2) クラウドの1件が壊れている → 取り込まない（端末は変えない）
    const key = [...E.cloud.docs.keys()].find(k => k.includes('/specs/'));
    const orig = E.cloud.docs.get(key);
    E.cloud.docs.set(key, { ...orig, json: '{"x":1}' });
    const bad = await Pull.readCloudData();
    eq([bad.ok, bad.problems.length > 0], [false, true], 'クラウドの問題を見つける');
    const snap2 = await Pull.saveSnapshot(await E.ip.exportAll());
    const n0 = JSON.stringify((await E.ip.exportAll()).data);
    eq((await rejects(Pull.runImport(E.ip, { snapshotId: snap2.id, expectedFingerprint: cloud.fingerprint }), '壊れたクラウドから取り込んだ')).code, 'cloud-problem', 'クラウドに問題があれば取り込まない');
    eq(JSON.stringify((await E.ip.exportAll()).data), n0, '端末は変わらない');
    E.cloud.docs.set(key, orig);
    // 3) バックアップの後に端末のデータが変わった → 取り込まない
    await E.ip.create('ideas', { text: '後から書いた', status: 'new' });
    eq((await rejects(Pull.runImport(E.ip, { snapshotId: snap2.id, expectedFingerprint: cloud.fingerprint }), 'バックアップ後の変更があるのに取り込んだ')).code, 'local-changed', 'バックアップの後に変わったら取り込まない');
    // 4) 確認画面のあとにクラウドが変わった（指紋が違う）→ 取り込まない
    const snap3 = await Pull.saveSnapshot(await E.ip.exportAll());
    eq((await rejects(Pull.runImport(E.ip, { snapshotId: snap3.id, expectedFingerprint: 'different' }), '内容が変わったのに取り込んだ')).code, 'cloud-changed', 'クラウドが変わったら取り込まない');
    // 5) 登録前のクラウドからは取り込めない
    E.cloud.docs.delete([...E.cloud.docs.keys()].find(k => k.endsWith('/meta/factory')));
    eq((await rejects(Pull.readCloudData(), '未登録から取り込めた')).code, 'not-registered', '登録前は取り込めない');
  } finally { await E.done2(); }
});


// ---------------- Phase Sync-3：PC・iPhoneの双方向同期（ボタンを押したときだけ・記録ごとの差分） ----------------
test('【Sync-3】同期の仕組み：削除の命令を持たない・Factoryのデータは1件ずつ書き換えない', async () => {
  const code = f => fetch(f, { cache: 'no-cache' }).then(r => r.text()).then(t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
  for (const f of ['../js/sync/sync3.js', '../js/views/sync3view.js']) {
    const c = await code(f);
    assert(!/deleteDoc|deleteField|writeBatch|\bt\.delete\(|fs\.delete/.test(c), `${f} に削除・一括上書きの命令がある`);
    assert(!/\.(create|update|upsert|remove|purge|restore)\(/.test(c), `${f} がFactoryのデータを1件ずつ書き換える（rev・更新日時が変わってしまう）`);
  }
  eq([S3.SYNC3_STORES.includes('trash'), S3.SYNC3_STORES.includes('history'), S3.SYNC3_STORES.includes('specs')], [false, true, true], 'ゴミ箱は同期しない');
});

test('【Sync-3】差分の判定：未送信・受け取り待ち・競合・この端末で削除（3つを比べる）', async () => {
  const m = obj => new Map(Object.entries(obj).map(([k, h]) => [k, { store: k.split('/')[0], id: k.split('/')[1], rec: { id: k.split('/')[1], v: h }, hash: h }]));
  const base = { 'specs/a': 'A0', 'specs/b': 'B0', 'specs/c': 'C0', 'specs/d': 'D0', 'specs/e': 'E0', 'specs/f': 'F0', 'specs/g': 'G0' };
  const local = m({ 'specs/a': 'A0', 'specs/b': 'B1', 'specs/c': 'C0', 'specs/d': 'D1', 'specs/e': 'E1', 'specs/n': 'N1', 'trash/t': 'T1' });   // f・g はこの端末で削除
  const cloud = m({ 'specs/a': 'A0', 'specs/b': 'B0', 'specs/c': 'C2', 'specs/d': 'D2', 'specs/e': 'E1', 'specs/f': 'F0', 'specs/g': 'G2', 'specs/z': 'Z2' });
  const d = S3.computeDiff({ local, base, cloud });
  eq(d.push.map(x => `${x.id}:${x.kind}`), ['b:update', 'n:new'], '未送信（この端末だけ変わった・新しく作った）');
  eq(d.pull.map(x => `${x.id}:${x.kind}`), ['c:update', 'z:new'], '受け取り待ち（クラウドだけ変わった・ほかの端末で作った）');
  eq(d.conflicts.map(x => `${x.id}:${x.type}`), ['d:both', 'g:deletedLocal'], '競合（両方で違う内容・この端末で削除したがクラウドで変更）');
  eq(d.same.map(x => x.key), ['specs/e'], '両方で同じ内容に変わった → 競合にしない');
  eq(d.localDeleted.map(x => x.id), ['f'], 'この端末で削除（クラウドには反映しない）');
  assert(!d.push.some(x => x.store === 'trash'), 'ゴミ箱は送らない');
  // 基準のない端末：この端末だけの記録は「同期前からある記録」・送らないと決めたものは数えない
  const f = S3.computeDiff({ local: m({ 'ideas/x': 'X1', 'ideas/y': 'Y1', 'ideas/w': 'W1' }), base: {}, cloud: m({ 'specs/a': 'A0' }), preexisting: { 'ideas/x': 'X1', 'ideas/y': 'Y1' }, ignored: { 'ideas/y': 'Y1' } });
  eq([f.push.map(x => `${x.id}:${x.fresh}`), f.pull.map(x => x.id)], [['w:false', 'x:true'], ['a']], '基準のない端末（同期前からある記録・送らないと決めた記録・あとで作った記録）');
  // 項目ごとの違い（rev・更新日時などは除く）
  eq(S3.fieldDiff({ title: 'A', memo: 'm', rev: 2, updatedAt: '1' }, { title: 'B', memo: 'm', rev: 3, updatedAt: '2' }).map(x => x.field), ['title'], '変更内容');
});

// 2台（PC・iPhone）とにせクラウドで、送る → 受け取る → 競合 を確かめる
async function twoDevices() {
  const E = await pullEnv();                // PC（8プロジェクト・初回登録済み）・iPhone（プロジェクト0件・少しデータあり）
  const pc = E.d, ip = E.ip;
  return { E, pc, ip };
}
const edit = async (db, store, pick, patch, actor) => { const rows = await db.all(store); const r = rows.find(pick); db.actor = actor; return db.update(store, r.id, patch, { reason: 'テストの変更' }); };

test('【Sync-3】PCで変更 → 送る → iPhoneで受け取る → iPhoneで変更 → 送る → PCで受け取る（変更分だけ・照合）', async () => {
  const { E, pc, ip } = await twoDevices();
  try {
    // 同期を始める：PCは登録時の記録が基準、iPhoneは基準なし（クラウドの全件が受け取り待ち）
    const sp = await S3.startSync3(pc, { deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    eq([sp.from, sp.fresh], ['register', false], 'PCの基準＝登録時の記録');
    const metaAfterStart = (await Reg.readMeta()).raw;
    eq([metaAfterStart.syncFormat, metaAfterStart.changeSeq, metaAfterStart.status, metaAfterStart.total], [3, 0, 'complete', E.plan.total], 'クラウドの印をSync-3形式に（データ本体はそのまま）');
    const si = await S3.startSync3(ip, { deviceLabel: 'iPhone（ホーム画面版）', deviceId: 'dev-ip', baseSource: 'none' });
    eq(si.fresh, true, 'iPhoneは基準なし');
    let ci = await S3.checkSync3(ip);
    eq([ci.diff.counts.pull > 300, ci.diff.counts.conflicts], [true, 0], 'iPhone：クラウドの全件が受け取り待ち・競合なし');
    assert(ci.diff.push.length > 0 && ci.diff.push.every(p => p.fresh), 'iPhone：同期前からある記録は「同期前からある記録」');
    // iPhoneで受け取る（この端末の記録は消さない）
    const ipBeforeIdeas = (await ip.all('ideas')).length;
    await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    eq([(await ip.all('projects')).length, (await ip.all('ideas')).length >= ipBeforeIdeas], [8, true], 'iPhoneに8プロジェクト（この端末の記録は残る）');
    // 同期前からある記録は「この端末だけに残す」
    ci = await S3.checkSync3(ip);
    await S3.ignoreLocal(ip, ci.diff.push.filter(p => p.fresh));
    ci = await S3.checkSync3(ip);
    eq([ci.diff.counts.push, ci.diff.counts.pull, ci.diff.counts.conflicts], [0, 0, 0], 'iPhone：同期済み');
    // PCで1件変更 → 送る
    await edit(pc, 'projects', p => p.seedKey === 'vintage-hunt', { memo: 'PCで追記' }, 'PC先生');
    let cp = await S3.checkSync3(pc);
    eq(cp.diff.push.map(p => p.store).sort(), ['history', 'projects'], 'PC：未送信＝変更した記録と変更履歴の2件');
    const cloudBefore = new Map(E.cloud.docs);
    await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    const changed = [...E.cloud.docs.keys()].filter(k => JSON.stringify(E.cloud.docs.get(k)) !== JSON.stringify(cloudBefore.get(k)));
    eq(changed.filter(k => !k.endsWith('/meta/factory')).length, 2, 'クラウドで変わったのは送った2件だけ（全件の上書きはしない）');
    const meta1 = (await Reg.readMeta()).raw;
    eq([meta1.changeSeq, meta1.lastUpdatedBy, meta1.total], [1, 'PC（Edge）', E.plan.total + 1], '印：変更番号・最終更新者・件数');
    // 送った後も、取り込み（災害復旧用）でクラウド全体の照合が通る
    eq((await Pull.readCloudData()).ok, true, '送った後もクラウド全体の指紋・件数が一致');
    eq((await S3.checkSync3(pc)).diff.counts.push, 0, 'PC：送った後は未送信0件');
    // iPhoneで受け取る
    ci = await S3.checkSync3(ip);
    eq(ci.diff.pull.map(p => `${p.store}:${p.kind}`).sort(), ['history:new', 'projects:update'], 'iPhone：受け取り待ち＝PCの変更2件');
    await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    const vh = (await ip.all('projects')).find(p => p.seedKey === 'vintage-hunt');
    eq([vh.memo, vh.updatedBy], ['PCで追記', 'PC先生'], 'iPhoneに反映（更新者・内容はPCのまま）');
    // iPhoneで別の1件を変更 → 送る → PCで受け取る
    await edit(ip, 'projects', p => p.seedKey === 'storm', { memo: 'iPhoneで追記' }, 'iPhone先生');
    ci = await S3.checkSync3(ip);
    await S3.pushChanges({ db: ip, items: ci.diff.push, check: ci, deviceLabel: 'iPhone（ホーム画面版）', deviceId: 'dev-ip' });
    cp = await S3.checkSync3(pc);
    eq([cp.diff.counts.pull, cp.diff.counts.conflicts], [2, 0], 'PC：受け取り待ち2件');
    eq(cp.diff.pull.find(p => p.store === 'projects').deviceLabel, 'iPhone（ホーム画面版）', '送った端末の表示');
    await S3.pullChanges({ db: pc, items: cp.diff.pull, check: cp, deviceLabel: 'PC' });
    eq((await pc.all('projects')).find(p => p.seedKey === 'storm').memo, 'iPhoneで追記', 'PCに反映');
    // 両方そろった：同じデータ
    const fpOf = async db => (await S3.localMap(await db.exportAll()));
    const [a, b] = [await fpOf(pc), await fpOf(ip)];
    for (const k of ['projects', 'specs']) eq([...a].filter(([x]) => x.startsWith(k)).map(([x, v]) => x + v.hash).sort(), [...b].filter(([x]) => x.startsWith(k)).map(([x, v]) => x + v.hash).sort(), `${k} がPCとiPhoneで一致`);
    eq(E.cloud.ops.filter(o => /delete/i.test(o[0])).length, 0, 'クラウドで削除していない');
  } finally { await E.done2(); }
});

test('【Sync-3】競合：同じ記録を両方で変更 → 勝手に採用しない → この端末版／クラウド版／統合を選べる', async () => {
  const { E, pc, ip } = await twoDevices();
  try {
    await S3.startSync3(pc, { deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    await S3.startSync3(ip, { deviceLabel: 'iPhone', deviceId: 'dev-ip', baseSource: 'none' });
    let ci = await S3.checkSync3(ip); await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    const pick = p => p.seedKey === 'kaikei';
    // 1) 両方で同じ記録を変更
    await edit(pc, 'projects', pick, { memo: 'PC版のメモ', purpose: 'PC版の目的' }, 'PC先生');
    await edit(ip, 'projects', pick, { memo: 'iPhone版のメモ' }, 'iPhone先生');
    let cp = await S3.checkSync3(pc);
    await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    ci = await S3.checkSync3(ip);
    const conf = ci.diff.conflicts.find(c => c.store === 'projects');
    assert(conf && conf.type === 'both', 'iPhone：競合を見つける');
    assert(!ci.diff.push.some(p => p.key === conf.key) && !ci.diff.pull.some(p => p.key === conf.key), '競合の記録は自動で送ったり受け取ったりしない');
    eq(S3.fieldDiff(conf.local.rec, conf.cloud.rec).map(f => f.field).sort(), ['memo', 'purpose'], '変更内容（項目ごと）');
    eq(conf.cloud.deviceLabel, 'PC（Edge）', 'クラウド版を送った端末');
    // 2) この端末版をそのまま送ろうとしても、競合の記録は送れない（クラウドが変わっているため）
    const stale = { key: conf.key, store: conf.store, id: conf.id, rec: conf.local.rec, hash: conf.local.hash, cloudHash: conf.baseHash };
    eq((await rejects(S3.pushChanges({ db: ip, items: [stale], check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip' }), '他端末の新しい変更を上書きした')).code, 'cloud-changed', 'ほかの端末の新しい変更は上書きしない');
    // 3) 統合：memo は iPhone版、purpose は PC版
    ci = await S3.checkSync3(ip);
    const c2 = ci.diff.conflicts.find(c => c.key === conf.key);
    await S3.resolveConflict({ db: ip, conflict: c2, choice: 'merge', picks: { memo: 'local', purpose: 'cloud' }, check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip', actor: 'iPhone先生' });
    const merged = (await ip.all('projects')).find(pick);
    eq([merged.memo, merged.purpose, merged.updatedBy], ['iPhone版のメモ', 'PC版の目的', 'iPhone先生'], '統合した内容');
    cp = await S3.checkSync3(pc);
    const pp = cp.diff.pull.find(p => p.key === conf.key);
    assert(pp && cp.diff.conflicts.every(c => c.key !== conf.key), 'PC：統合した版が受け取り待ち（競合ではない）');
    await S3.pullChanges({ db: pc, items: cp.diff.pull, check: cp, deviceLabel: 'PC' });
    eq((await pc.all('projects')).find(pick).memo, 'iPhone版のメモ', 'PCにも統合した版');
    // 4) クラウド版を採用
    await edit(pc, 'projects', pick, { memo: 'PC2' }, 'PC先生');
    ci = await S3.checkSync3(ip); await S3.pullChanges({ db: ip, items: [], check: ci }); // 何もしない
    await edit(ip, 'projects', pick, { memo: 'iPhone2' }, 'iPhone先生');
    cp = await S3.checkSync3(pc); await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    ci = await S3.checkSync3(ip);
    let c3 = ci.diff.conflicts.find(c => c.key === conf.key);
    await S3.resolveConflict({ db: ip, conflict: c3, choice: 'cloud', check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip' });
    eq((await ip.all('projects')).find(pick).memo, 'PC2', 'クラウド版を採用');
    // 5) この端末版を採用
    await edit(pc, 'projects', pick, { memo: 'PC3' }, 'PC先生');
    await edit(ip, 'projects', pick, { memo: 'iPhone3' }, 'iPhone先生');
    cp = await S3.checkSync3(pc); await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    ci = await S3.checkSync3(ip);
    c3 = ci.diff.conflicts.find(c => c.key === conf.key);
    await S3.resolveConflict({ db: ip, conflict: c3, choice: 'local', check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip' });
    cp = await S3.checkSync3(pc);
    eq(cp.diff.pull.find(p => p.key === conf.key)?.rec.memo, 'iPhone3', 'この端末版を採用 → PCで受け取り待ち');
  } finally { await E.done2(); }
});

test('【Sync-3】削除はクラウドへ反映しない・送る途中の失敗や同時の更新でもデータを壊さない', async () => {
  const { E, pc, ip } = await twoDevices();
  try {
    await S3.startSync3(pc, { deviceLabel: 'PC', deviceId: 'dev-pc' });
    await S3.startSync3(ip, { deviceLabel: 'iPhone', deviceId: 'dev-ip', baseSource: 'none' });
    let ci = await S3.checkSync3(ip); await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    ci = await S3.checkSync3(ip); await S3.ignoreLocal(ip, ci.diff.push.filter(p => p.fresh));
    // 1) PCで要望を削除（ゴミ箱へ）→ クラウドには反映しない
    const req = await pc.create('requests', { projectId: (await pc.all('projects'))[0].id, title: '消す要望', status: 'unreviewed' });
    let cp = await S3.checkSync3(pc); await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC', deviceId: 'dev-pc' });
    await pc.remove('requests', req.id);
    cp = await S3.checkSync3(pc);
    eq([cp.diff.localDeleted.some(x => x.id === req.id), cp.diff.push.some(p => p.store === 'trash')], [true, false], 'この端末で削除 → 表示だけ（ゴミ箱も送らない）');
    await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC', deviceId: 'dev-pc' });
    assert([...E.cloud.docs.keys()].some(k => k.includes('/requests/') && E.cloud.docs.get(k).id === req.id), 'クラウドの要望は残っている');
    // 2) 送る途中で接続が切れる → クラウドも基準も変わらない → もう一度で送れる
    await edit(pc, 'projects', p => p.seedKey === 'health', { memo: 'PC：送信失敗のテスト' }, 'PC先生');
    cp = await S3.checkSync3(pc);
    const docsBefore = JSON.stringify([...E.cloud.docs.entries()]);
    const stBefore = JSON.stringify((await S3.getSync3State(pc)).base);
    E.cloud.ctl.failTxAt = (E.cloud.ctl.tx || 0) + 1;
    eq((await rejects(S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC', deviceId: 'dev-pc' }), '途中で失敗したのに成功した')).code, 'unavailable', '接続が切れた');
    eq([JSON.stringify([...E.cloud.docs.entries()]) === docsBefore, JSON.stringify((await S3.getSync3State(pc)).base) === stBefore], [true, true], 'クラウドも基準も変わらない');
    E.cloud.ctl.failTxAt = 0;
    cp = await S3.checkSync3(pc); await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC', deviceId: 'dev-pc' });
    eq((await S3.checkSync3(pc)).diff.counts.push, 0, 'もう一度で送れた');
    // 3) 確認と送信の間に、ほかの端末が送った → 送らない（上書きしない）
    await edit(ip, 'projects', p => p.seedKey === 'family', { memo: 'iPhone：同時のテスト' }, 'iPhone先生');
    ci = await S3.checkSync3(ip);
    await edit(pc, 'projects', p => p.seedKey === 'kyozai', { memo: 'PC：先に送る' }, 'PC先生');
    cp = await S3.checkSync3(pc); await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC', deviceId: 'dev-pc' });
    eq((await rejects(S3.pushChanges({ db: ip, items: ci.diff.push, check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip' }), '古い確認のまま送れた')).code, 'cloud-changed', '確認のあとにほかの端末が送ったら送らない');
    ci = await S3.checkSync3(ip);
    eq([ci.diff.pull.some(p => p.store === 'projects' && p.rec.memo === 'PC：先に送る'), ci.diff.push.map(p => p.store).sort().join(), ci.diff.counts.conflicts], [true, 'history,projects', 0], '確認し直すと：PCの変更が受け取り待ち・iPhoneの変更2件が未送信・競合なし');
    await S3.pushChanges({ db: ip, items: ci.diff.push, check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip' });
    // 4) 受け取りで照合が合わない → 受け取り前の控えへ戻す
    ci = await S3.checkSync3(ip);
    cp = await S3.checkSync3(pc);
    const realApply = pc.applySyncedRecords.bind(pc);
    pc.applySyncedRecords = async items => realApply(items.map(x => x.store === 'projects' ? { ...x, rec: { ...x.rec, memo: '壊れた' } } : x));
    const pcBefore = JSON.stringify((await pc.exportAll()).data.projects);
    eq((await rejects(S3.pullChanges({ db: pc, items: cp.diff.pull, check: cp, deviceLabel: 'PC' }), '壊れたまま受け取り完了になった')).code, 'verify-failed', '照合が合わない');
    eq(JSON.stringify((await pc.exportAll()).data.projects), pcBefore, '受け取り前のデータに戻った');
    pc.applySyncedRecords = realApply;
    // 5) 確認のあとにこの端末で同じ記録が変わった → 受け取らない
    cp = await S3.checkSync3(pc);
    const target = cp.diff.pull.find(p => p.store === 'projects');
    await pc.applySyncedRecords([{ store: 'projects', rec: { ...(await pc.get('projects', target.id)), memo: 'PC：確認の後に変更' } }]);
    eq((await rejects(S3.pullChanges({ db: pc, items: cp.diff.pull, check: cp, deviceLabel: 'PC' }), '確認後の変更を上書きした')).code, 'local-changed', 'この端末の新しい変更を上書きしない');
    // 端末ごとの記録は送らない
    assert(![...E.cloud.docs.keys()].some(k => /\/settings\/r-(lastTestRun|master|lastBackup)$/.test(k)), '端末ごとの記録をクラウドへ送っていない');
  } finally { await E.done2(); }
});


// ---------------- Phase Sync-4a：半自動のお知らせ（読むだけ・自動で送受信しない） ----------------
test('【Sync-4a】お知らせの仕組み：クラウドへ書き込まない・記録の中身を読まない・Factoryのデータを変えない', async () => {
  const code = f => fetch(f, { cache: 'no-cache' }).then(r => r.text()).then(t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
  for (const f of ['../js/sync/notice.js', '../js/views/noticebar.js']) {
    const c = await code(f);
    assert(!/setDoc|writeBatch|updateDoc|addDoc|deleteDoc|runTransaction|\bt\.set\(|\.delete\(/.test(c), `${f} にクラウドへの書き込み・削除の命令がある`);
    assert(!/getDocsFromServer|readCloudData|pushChanges|pullChanges|resolveConflict|applySyncedRecords|importAll/.test(c), `${f} がクラウドの記録を読む・送受信する`);
    assert(!/\.(create|update|upsert|remove|purge|restore)\(/.test(c), `${f} がFactoryのデータを書き換える`);
  }
  eq(N.NOTICE_GAP_MS, 600000, '画面に戻っただけなら10分に1回まで');
});

test('【Sync-4a】判定：印の変更番号と、この端末が前回そろえた状態だけで「受け取り待ち」「未送信」を決める', async () => {
  const st = { datasetId: 'u1', notice: { seq: 5, remote: 0 }, base: { 'specs/a': 'A0', 'specs/b': 'B0' }, ignored: { 'ideas/i': 'I0' }, preexisting: { 'ideas/p': 'P0' } };
  eq(N.decideRemote({ state: st, meta: { changeSeq: 5, uploadId: 'u1' } }), { remote: 'none' }, '同じ番号 → 受け取り待ちなし');
  eq(N.decideRemote({ state: st, meta: { changeSeq: 6, uploadId: 'u1' } }), { remote: 'pending', reason: 'newer' }, '番号が進んだ → ほかの端末の更新あり');
  eq(N.decideRemote({ state: { ...st, notice: { seq: 5, remote: 2 } }, meta: { changeSeq: 5, uploadId: 'u1' } }), { remote: 'pending', reason: 'known' }, '前回の確認で残っていた → まだ残っている');
  eq(N.decideRemote({ state: st, meta: { changeSeq: 5, uploadId: 'u2' } }), { remote: 'reset' }, 'データセットが違う → 入れ替わり');
  eq(N.decideRemote({ state: { datasetId: 'u1', lastSeenChangeSeq: 3 }, meta: { changeSeq: 3, uploadId: 'u1' } }), { remote: 'none' }, 'Sync-4aより前に同期した端末（最後に見た番号を使う）');
  eq(N.decideRemote({ state: st, meta: null }), { remote: 'unknown' }, '印が読めない → 分からない（何も言わない）');
  const m = o => new Map(Object.entries(o).map(([k, h]) => [k, { hash: h }]));
  eq(N.countUnsentFrom(m({ 'specs/a': 'A0', 'specs/b': 'B1', 'ideas/i': 'I0', 'ideas/p': 'P0', 'ideas/n': 'N1' }), st), 2, '未送信＝変わった記録＋新しい記録（この端末だけに残す・同期前からあるものは数えない）');
  eq(N.countUnsentFrom(m({ 'specs/a': 'A0' }), st), 0, 'この端末で削除した記録は数えない（削除は送らない）');
  const h = noticeHtml({ active: true, enabled: true, unsent: 3, remote: 'pending', reason: 'newer', meta: { lastUpdatedBy: 'PC（Edge）' }, checkedAt: new Date().toISOString() });
  assert(h.includes('受け取り待ちがあります') && h.includes('PC（Edge）') && h.includes('未送信 <span id="sn-unsent">3</span>件') && h.includes('href="#/account"') && h.includes('自動では送受信しません'), 'お知らせの表示');
  assert(noticeHtml({ active: true, enabled: true, unsent: 0, remote: 'none', checkedAt: new Date().toISOString() }).includes('そろっています'), 'そろっているとき');
  eq([noticeHtml({ active: false }), noticeHtml({ active: true, enabled: false })], ['', ''], '同期を始めていない・オフ → 何も表示しない');
  assert(noticeHtml({ active: true, enabled: true, unsent: 1, remote: 'offline' }).includes('オフラインのため'), 'オフライン');
});

test('【Sync-4a】2台で：送った端末にはお知らせなし → もう1台に「受け取り待ち」→ 受け取ると消える（読むのは印1件だけ）', async () => {
  const { E, pc, ip } = await twoDevices();
  const pref = await N.getNoticePref();
  const reads = () => E.cloud.ops.slice(mark);
  let mark = 0;
  const notice = async (db, o = {}) => { N._resetNoticeCache(); mark = E.cloud.ops.length; return N.getNotice(db, { force: true, online: true, ...o }); };
  try {
    await N.setNoticePref(true);
    await S3.updateSync3State(pc, { datasetId: null });
    eq((await notice(pc)).active, false, '同期を始めていない端末には何も表示しない');
    eq(reads().length, 0, '同期を始めていなければクラウドを読まない');
    await S3.startSync3(pc, { deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    await S3.startSync3(ip, { deviceLabel: 'iPhone（ホーム画面版）', deviceId: 'dev-ip', baseSource: 'none' });
    let ci = await S3.checkSync3(ip);
    await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    ci = await S3.checkSync3(ip); await S3.ignoreLocal(ip, ci.diff.push.filter(p => p.fresh)); await S3.checkSync3(ip); await S3.checkSync3(pc);
    let n = await notice(pc);
    eq([n.remote, n.unsent], ['none', 0], 'PC：そろっている');
    eq(reads().map(o => o[0] + ' ' + o[1]), ['get users/uid-123/meta/factory'], '読んだのは自分の「登録済みの印」1件だけ（記録の中身は読まない）');
    eq([(await notice(ip)).remote, (await notice(ip)).unsent], ['none', 0], 'iPhone：そろっている');
    await edit(pc, 'projects', p => p.seedKey === 'vintage-hunt', { memo: 'PCで追記（4a）' }, 'PC先生');
    n = await notice(pc, { online: false });
    eq([n.remote, n.unsent, reads().length], ['offline', 2, 0], 'オフライン：未送信2件・クラウドには接続しない');
    N._resetNoticeCache(); mark = E.cloud.ops.length;
    n = await N.getNotice(pc, { remote: false, online: true });
    eq([n.unsent, reads().length], [2, 0], '画面の切り替えでは読み直さない（remote:false）');
    let cp = await S3.checkSync3(pc);
    await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    n = await notice(pc);
    eq([n.remote, n.unsent], ['none', 0], 'PC：自分が送った変更は「受け取り待ち」にしない');
    const ipBefore = JSON.stringify((await ip.exportAll()).data), cloudBefore = JSON.stringify([...E.cloud.docs.entries()]);
    n = await notice(ip);
    eq([n.remote, n.reason, n.meta.lastUpdatedBy, n.unsent], ['pending', 'newer', 'PC（Edge）', 0], 'iPhone：受け取り待ちがあります（PCが更新）');
    eq([JSON.stringify((await ip.exportAll()).data) === ipBefore, JSON.stringify([...E.cloud.docs.entries()]) === cloudBefore], [true, true], 'お知らせを出してもiPhoneのデータ・クラウドは変わらない（自動で受け取らない）');
    ci = await S3.checkSync3(ip);
    n = await notice(ip);
    eq([n.remote, n.reason], ['pending', 'known'], '確認しただけでは消えない');
    await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    eq((await notice(ip)).remote, 'none', '受け取ると消える');
    await edit(pc, 'projects', p => p.seedKey === 'storm', { memo: '[PC]' }, 'PC先生');
    await edit(ip, 'projects', p => p.seedKey === 'storm', { memo: '[iPhone]' }, 'iPhone先生');
    cp = await S3.checkSync3(pc); await S3.pushChanges({ db: pc, items: cp.diff.push, check: cp, deviceLabel: 'PC（Edge）', deviceId: 'dev-pc' });
    n = await notice(ip);
    eq([n.remote, n.unsent], ['pending', 2], 'iPhone：受け取り待ちあり・未送信2件');
    ci = await S3.checkSync3(ip);
    const conf = ci.diff.conflicts.find(c => c.store === 'projects');
    await S3.resolveConflict({ db: ip, conflict: conf, choice: 'cloud', check: ci, deviceLabel: 'iPhone', deviceId: 'dev-ip', actor: 'iPhone先生' });
    ci = await S3.checkSync3(ip);
    if (ci.diff.pull.length) await S3.pullChanges({ db: ip, items: ci.diff.pull, check: ci, deviceLabel: 'iPhone' });
    ci = await S3.checkSync3(ip);
    n = await notice(ip);
    eq([n.remote, ci.diff.counts.conflicts], ['none', 0], '競合を解決すると受け取り待ちが消える');
    await N.setNoticePref(false);
    n = await notice(ip);
    eq([n.enabled, reads().length], [false, 0], 'お知らせをオフ → 表示しない・クラウドを読まない');
    await N.setNoticePref(true);
    await SyncAuth.signOut();
    n = await notice(ip);
    eq([n.remote, reads().filter(o => o[0] === 'get').length], ['signedOut', 0], '未ログイン → クラウドを読まない');
    eq(E.cloud.ops.filter(o => /delete/i.test(o[0])).length, 0, 'クラウドで削除していない');
  } finally { await N.setNoticePref(pref.enabled); N._resetNoticeCache(); await E.done2(); }
});

test('【v1範囲】自動同期（Sync-4b）・削除の同期（Sync-5）・競合の自動解決は v1完成の判定に入れない（2026-10-07 決定）', async () => {
  const h = await loadHandoff();
  const m = await loadMaster(db);
  const items = v1Items({ handoff: h, projects: [], devices: [], publish: [], lastTest: null, lastBackup: null }, m);
  const sync = items.filter(i => i.group === '複数端末同期');
  eq(sync.map(i => i.label.split(' ')[0]), ['Sync-1', 'Sync-2', 'Sync-3', 'Sync-4a'], 'v1の同期の条件＝Sync-1・2・3・4a');
  eq(sync.every(i => i.ok), true, 'v1の同期の条件はすべて完了');
  assert(!items.some(i => /Sync-4b|Sync-5|自動解決/.test(i.label)), 'v1.1以降の改善候補が判定に入っている');
  eq(v1LaterItems(h).map(x => x.key), ['Sync-4b', 'Sync-5', '競合の自動解決'], '改善候補として表示');
  eq([...new Set(items.map(i => i.group))], ['仕様・開発', '複数端末同期', '公開・運用'], '条件のまとまり（実機確認の記録がないときは実機確認の行は出ない）');
});

test('【安定性】テスト用データベースの削除：要求は1回だけ・次に開いた接続を閉じない・本番のデータベースは削除しない', async () => {
  const NAME = 'factory-test-del';
  // iPhone/Safari の再現：ほかの接続が「少し遅れて」閉じる（このあいだ削除は blocked になる）
  const slow = await new Promise((res, rej) => { const r = indexedDB.open(NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore('x', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  slow.onversionchange = () => setTimeout(() => slow.close(), 150);
  let deleteRequests = 0;
  const orig = indexedDB.deleteDatabase.bind(indexedDB);
  indexedDB.deleteDatabase = n => { if (n === NAME) deleteRequests++; return orig(n); };
  try { await delDB(NAME); } finally { indexedDB.deleteDatabase = orig; }
  eq(deleteRequests, 1, '削除の要求は1回だけ（blocked でも出し直さない）');
  // 削除のあとに開いた接続が、残った削除要求で閉じられないこと
  const d = await FactoryDB.open(NAME);
  await sleep(400);
  await d.create('ideas', { text: '削除後に開いた接続で保存できる', status: 'new' });
  eq((await d.all('ideas')).length, 1, '削除後に開いた接続が使える');
  d.close(); await delDB(NAME);
  // テスト専用以外は削除しない
  for (const n of ['factory', 'factory-sync']) await rejects(delDB(n), `本番の「${n}」を削除しようとした`);
});

test('【安定性】自動テストは本番の同期の記録（factory-sync）を使わない', async () => {
  eq(Reg.SYNC_DB, TEST_SYNC_DB, 'テスト中の同期の記録はテスト専用のデータベース');
  await rejects((async () => Reg._useSyncDBForTest('factory-sync'))(), '本番の名前に切り替えられた');
  const names = indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : null;
  if (names) assert(names.includes(TEST_SYNC_DB), 'テスト専用の同期データベースが使われていない');
});

test('【安定性】オフライン用の保存一覧（sw.js）が指すファイルがすべて存在する', async () => {
  const sw = await fetch('../sw.js', { cache: 'no-cache' }).then(r => r.text());
  const list = [...(sw.match(/const SHELL = \[([\s\S]*?)\];/) || [, ''])[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert(list.length > 20, 'sw.js の保存一覧を読めない');
  const missing = [];
  for (const f of list) { const r = await fetch('../' + f.replace(/^\.\//, ''), { cache: 'no-cache' }); if (!r.ok) missing.push(f); }
  eq(missing, [], '存在しないファイルがある（1つでもあると、オフライン用の更新全体が組み込めない）');
  const ver = ((await fetch('../js/app.js', { cache: 'no-cache' }).then(r => r.text())).match(/APP_VERSION = '([^']+)'/) || [])[1];   // 読み込むと起動処理が動くので、文字として読む
  if (ver) assert(list.includes(`VERSION-${ver}.txt`), `今の版の印（VERSION-${ver}.txt）が保存一覧にない`);
});

test('【実機確認の重複】同じ端末の記録をまとめる：未記入の欄は合格にも不合格にもしない・記入のある「合格」以外があれば完成にしない', async () => {
  const blank = (id, device, order) => ({ id, device, order, status: 'unchecked', checkedAt: null, result: '' });
  const g = groupDeviceChecks([
    { id: 'a', device: 'iPhone', status: 'pass', checkedAt: '2026-10-08', result: '91/91' }, blank('b', 'iPhone'),
    blank('c', '学校Windows PC'), blank('d', '学校Windows PC'),
    { id: 'e', device: 'ｉＰｈｏｎｅ ', status: 'unchecked', checkedAt: null, result: '', duplicateOf: 'a' },
  ]);
  const ip = g.find(x => x.device === 'iPhone'), sc = g.find(x => x.device === '学校Windows PC');
  eq([g.length, ip.ok, ip.keeper.id, ip.extraBlanks.map(x => x.id), ip.marked.map(x => x.id)], [2, true, 'a', ['b'], ['e']], 'iPhone：合格＋未記入の欄 → 合格（名前の全角・空白の違いも同じ端末）');
  eq([sc.ok, sc.extraBlanks.map(x => x.id)], [false, ['d']], '学校Windows PC：未記入だけ → 未確認のまま（2件目は整理できる重複）');
  eq(groupDeviceChecks([{ id: 'a', device: 'iPhone', status: 'pass', checkedAt: '2026-10-08' }, { id: 'f', device: 'iPhone', status: 'fail', checkedAt: '2026-10-09', result: '1件不合格' }])[0].ok, false, '合格と不合格がある → 完成にしない（偽って合格にしない）');
  eq(groupDeviceChecks([{ id: 'a', device: 'iPhone', status: 'unchecked', checkedAt: '2026-10-08' }])[0].ok, false, '確認日だけ記入した「未確認」は合格にしない');
  eq([isBlankDeviceCheck({ status: 'unchecked' }), isBlankDeviceCheck({ status: 'pass' }), isBlankDeviceCheck({ status: 'unchecked', result: 'メモ' })], [true, false, false], '未記入の欄の判定');
  // v1完成判定：端末ごとに1項目（自宅PCは対象外のまま）
  const m = await loadMaster(db), h = await loadHandoff();
  const items = v1Items({ handoff: h, projects: [], devices: [{ id: 'a', device: 'iPhone', status: 'pass', checkedAt: '2026-10-08', result: '91/91' }, blank('b', 'iPhone'), blank('c', '学校Windows PC'), blank('d', '学校Windows PC'), blank('h', '自宅PC')], publish: [], lastTest: null, lastBackup: null }, m).filter(i => i.group === '実機確認');
  eq(items.map(i => [i.label, i.ok]), [['iPhone の実機確認', true], ['学校Windows PC の実機確認', false]], '重複があっても端末ごとに1項目・合格は合格のまま');
  assert(items[0].detail.includes('91/91') && items[0].detail.includes('未記入の欄 1件は判定に入れていません'), '判定に入れていない欄を表示');
});

test('【実機確認の重複】「重複として整理」は削除しない：合格の記録は変わらず、元に戻せる', async () => {
  const { FACTORY_ID } = await import('../js/db.js');
  const pass = await db.create('checks', { projectId: FACTORY_ID, kind: 'device', device: 'テスト端末', order: 9, status: 'pass', checkedAt: '2026-10-08', result: '91/91' });
  const dup = await db.create('checks', { projectId: FACTORY_ID, kind: 'device', device: 'テスト端末', order: 9, status: 'unchecked', checkedAt: null, result: '' });
  const passBefore = JSON.stringify(await db.get('checks', pass.id));
  await db.update('checks', dup.id, { duplicateOf: pass.id }, { reason: '未記入の重複した欄を整理' });
  const list = (await db.checksOf(FACTORY_ID, 'device')).filter(d => d.device === 'テスト端末');
  eq([list.length, JSON.stringify(await db.get('checks', pass.id)) === passBefore, (await db.get('checks', dup.id)).duplicateOf], [2, true, pass.id], '記録は2件とも残る・合格の記録は変わらない');
  eq(groupDeviceChecks(list)[0].records.map(d => d.id), [pass.id], '整理した欄は判定から外れる');
  await db.update('checks', dup.id, { duplicateOf: null }, { reason: '元に戻す' });
  eq(groupDeviceChecks((await db.checksOf(FACTORY_ID, 'device')).filter(d => d.device === 'テスト端末'))[0].extraBlanks.map(d => d.id), [dup.id], '元に戻せる');
  // 判定・整理の部品にデータを削除する命令がない
  const code = await fetch('../js/views/checks.js', { cache: 'no-cache' }).then(r => r.text());
  const dedupePart = code.slice(code.indexOf('重複として整理（削除しない'), code.indexOf('function deviceForm'));
  assert(dedupePart.length > 100 && !/\.remove\(|\.purge\(|deleteDoc/.test(dedupePart), '重複の整理に削除の命令がある');
  await db.remove('checks', pass.id); await db.remove('checks', dup.id);
});

test('【同じ端末のまとめ】名前が違う記録は自動でまとめない・利用者が「同じ端末」と確認したときだけ合格の記録を参照する', async () => {
  const school = { id: 's', device: '学校Windows PC', order: 2, status: 'unchecked', checkedAt: null, result: '' };
  const surface = { id: 'f', device: '学校Windows PC（Surface・Edge）', status: 'pass', checkedAt: '2026-10-05', result: '自動テスト 全項目合格' };
  const m = await loadMaster(db), h = await loadHandoff();
  const v1dev = devs => v1Items({ handoff: h, projects: [], devices: devs, publish: [], lastTest: null, lastBackup: null }, m).filter(i => i.group === '実機確認');
  // まとめる前：別の端末として扱う（推測で合格にしない）
  eq(groupDeviceChecks([school, surface]).length, 2, '名前が違えば別の端末');
  eq(v1dev([school, surface]).map(i => [i.label, i.ok]), [['学校Windows PC の実機確認', false], ['学校Windows PC（Surface・Edge） の実機確認', true]], 'まとめる前は「学校Windows PC」は未確認のまま');
  eq(sameDeviceSuggestions([school, surface]).map(x => [x.from.id, x.to.id]), [['s', 'f']], 'まとめる候補として提案だけする（（ ）より前が同じ）');
  // 利用者が確認してまとめた後：1項目・合格の記録を参照
  const linked = { ...school, sameAs: 'f' };
  const g = groupDeviceChecks([linked, surface]);
  eq([g.length, g[0].ok, g[0].device, g[0].keeper.id, g[0].names.sort()], [1, true, '学校Windows PC（Surface・Edge）', 'f', ['学校Windows PC', '学校Windows PC（Surface・Edge）']], 'まとめた後は1つの端末・合格の記録を参照');
  const items = v1dev([linked, { ...school, id: 's2' }, surface]);
  eq(items.map(i => [i.label, i.ok]), [['学校Windows PC（Surface・Edge） の実機確認', true]], '同じ名前の未記入の欄（同期でそろった重複）もまとめて1項目');
  assert(items[0].detail.includes('2026-10-05') && items[0].detail.includes('同じ端末としてまとめた記録：学校Windows PC'), 'どの記録を参照したかを表示');
  assert(!sameDeviceSuggestions([linked, surface]).length, 'まとめた後は提案しない');
  // まとめても、相手が合格でなければ合格にしない
  eq(groupDeviceChecks([linked, { ...surface, status: 'fail' }])[0].ok, false, '相手が不合格なら完成にしない');
  eq(groupDeviceChecks([linked, { ...surface, status: 'unchecked', result: '' }])[0].ok, false, '相手が未確認（確認日だけ）なら完成にしない');
  eq(groupDeviceChecks([{ ...school, status: 'fail', result: 'エラー', checkedAt: '2026-10-09', sameAs: 'f' }, surface])[0].ok, false, 'まとめた記録に不合格があれば完成にしない');
  // つなぎ先が無い・自分自身・循環でも壊れない
  eq(groupDeviceChecks([{ ...school, sameAs: 'none' }, surface]).length, 2, 'つなぎ先が無ければまとめない');
  eq(groupDeviceChecks([{ ...school, sameAs: 's' }]).length, 1, '自分自身へのつなぎは無視');
  eq(groupDeviceChecks([{ ...school, sameAs: 'f' }, { ...surface, sameAs: 's' }]).length, 1, '互いにつないでも止まる');
});

test('【同じ端末のまとめ】まとめても記録は削除・変更しない（合格の記録は1文字も変わらない）・解除できる', async () => {
  const { FACTORY_ID } = await import('../js/db.js');
  const surface = await db.create('checks', { projectId: FACTORY_ID, kind: 'device', device: 'テスト学校PC（Surface・Edge）', status: 'pass', checkedAt: '2026-10-05', result: '合格' });
  const school = await db.create('checks', { projectId: FACTORY_ID, kind: 'device', device: 'テスト学校PC', status: 'unchecked', checkedAt: null, result: '' });
  const before = JSON.stringify(await db.get('checks', surface.id)), n = (await db.all('checks')).length;
  await db.update('checks', school.id, { sameAs: surface.id }, { reason: '利用者の確認により同じ端末としてまとめる' });
  eq([JSON.stringify(await db.get('checks', surface.id)) === before, (await db.all('checks')).length === n, (await db.get('checks', school.id)).status], [true, true, 'unchecked'], '合格の記録は変わらない・件数も同じ・まとめた側の状態も変えない（未確認のまま）');
  const mine = d => d.device.startsWith('テスト学校PC');
  eq(groupDeviceChecks((await db.checksOf(FACTORY_ID, 'device')).filter(mine)).length, 1, 'まとめて1つの端末');
  await db.update('checks', school.id, { sameAs: null }, { reason: '解除' });
  eq(groupDeviceChecks((await db.checksOf(FACTORY_ID, 'device')).filter(mine)).length, 2, '解除すると別の端末に戻る');
  await db.remove('checks', surface.id); await db.remove('checks', school.id);
});

// ---------------- 実行 ----------------
async function run() {
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  results.innerHTML = ''; summary.textContent = '実行中…';
  const details = [];
  try {
    await delDB(TEST_SYNC_DB);   // 前回のテストの同期の記録・控えを残さない（iPhoneの容量を使い続けない）
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
  try { db.close(); await delDB(TEST_DB); await delDB(TEST_SYNC_DB); } catch {}
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
