// プロジェクト画面：カードから9つの画面へ
import { esc, fmtDate, fmtShort, toast, errorHtml, openModal, confirmDialog, options } from '../ui.js';
import { label } from '../master.js';
import { computeProgress, compareVersion, latestResult, sortTasks, sortIssues, isOpenTask, topTask, nextVersion } from '../logic.js';
import { openProjectForm, openDuplicate, confirmDeleteProject } from './projectForm.js';
import { specTab } from './spec.js';
import { compareTab, recommendHtml } from './compare.js';
import { filesTab } from './files.js';
import { urlsTab } from './urls.js';
import { testsTab as testsTab6, toTask } from './tests.js';
import { handoffTab } from './phandoff.js';
import { checksHtml, bindChecks } from './checks.js';
import { sortChecks } from '../db.js';
import { summaryText } from '../diff.js';
import { STORE_LABELS, ACTION_LABELS, FIELD_LABELS } from '../labels.js';
import { importTab, originBadge } from './importer.js';
import { quickRequest, requestRows, bindRequestRows, bindReflect, RULE_NOTE } from './requests.js';

export const TABS = [
  ['overview', '概要'], ['spec', '仕様書'], ['progress', '完成度'], ['next', '次にやること'], ['requests', '要望箱'],
  ['compare', '3AI比較'], ['files', 'ファイル'], ['urls', 'URL'], ['tests', 'テスト'], ['handoff', '引継ぎ'], ['history', '変更履歴'],
];
const later = (phase, what) => `<div class="notice slim">${esc(what)}は <strong>${esc(phase)}</strong> で追加します。今は登録済みの内容を表示します。</div>`;

export async function projectView(ctx, view, params, id, tab = 'overview') {
  const db = ctx.db, m = ctx.master;
  const p = await db.get('projects', id);
  if (!p) { view.innerHTML = errorHtml(new Error('プロジェクトが見つかりません（削除された可能性があります。ゴミ箱を確認してください）')) + '<a class="btn" href="#/">ホームへ</a>'; return; }
  // Phase 7：既存アプリ取込タブ（「新しく作る」「Factory本体」以外で表示）
  const tabs = ['new', 'factory'].includes(p.origin) || !p.origin ? TABS : [...TABS.slice(0, 1), ['existing', '既存アプリ'], ...TABS.slice(1)];
  if (!tabs.some(t => t[0] === tab)) tab = 'overview';
  const [specs, requests, tests, issues, tasks, files, checks] = await Promise.all(['specs', 'requests', 'tests', 'issues', 'tasks', 'files', 'checks'].map(s => db.byIndex(s, 'projectId', id)));
  const handoff = (await db.getProjectHandoff(id)) || {};
  // 完成度は実データと連動（Phase 6）
  const prog = computeProgress(p, tests, m, { specs, files, devices: checks.filter(c => c.kind === 'device'), publish: checks.filter(c => c.kind === 'publish'), handoff });
  const latestSpec = specs.filter(x => (x.status || 'fixed') === 'fixed').sort((a, b) => compareVersion(b.version, a.version))[0]; // 現在Version＝最新の確定版
  const hasDraft = specs.some(x => x.status === 'draft');
  const openIssues = issues.filter(i => i.status !== 'resolved');
  const openReqKeys = m.requestStatuses.filter(s => s.open).map(s => s.key);
  const counts = { requests: requests.filter(r => openReqKeys.includes(r.status || 'unreviewed')).length, next: tasks.filter(t => isOpenTask(t, m)).length + openIssues.length, tests: tests.length };

  view.innerHTML = `<a class="back" href="#/">← ホーム</a>
    <header class="p-head">
      <h1>${esc(p.name)}</h1>
      <div class="p-meta"><span class="badge status-${esc(p.status || 'none')}">${esc(label(m, 'statuses', p.status) || '未設定')}</span>
        <span>完成度 <b>${prog.total}%</b></span>${latestSpec ? `<span>仕様 ${esc(latestSpec.version)}</span>` : ''}${hasDraft ? '<span class="badge warn">変更案あり</span>' : ''}${originBadge(p, m)}
        <button class="btn small" id="p-add-req">＋要望</button></div>
    </header>
    <nav class="tabs" aria-label="プロジェクトのメニュー">${tabs.map(([k, l]) => `<a href="#/p/${esc(id)}/${k}"${k === tab ? ' aria-current="page"' : ''}>${esc(l)}${counts[k] ? `<small>${counts[k]}</small>` : ''}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  view.querySelector('#p-add-req').onclick = () => quickRequest(ctx, { projectId: id });
  const el = view.querySelector('#tab');
  const T = { overview, existing: importTab, spec: specTab, progress, next, requests: reqs, compare: compareTab, files: filesTab, urls: urlsTab, tests: testsTab6, handoff: handoffTab, history };
  await T[tab]({ ctx, el, p, params, specs, requests, tests, issues, tasks, openIssues, prog, latestSpec, checks });
  // 選択中のタブが見えるよう横スクロール
  view.querySelector('.tabs [aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// 1. 概要
async function overview({ ctx, el, p, prog, latestSpec, openIssues, tasks }) {
  const m = ctx.master;
  const nt = topTask(tasks, m);
  const devs = (p.targetDevices || []).map(k => label(m, 'targetDevices', k));
  const none = '<span class="muted">未入力</span>';
  el.innerHTML = `${await recommendHtml(ctx, p, { compact: true })}<section class="card">
      <dl class="kv wide">
        <dt>目的</dt><dd class="prewrap">${p.purpose ? esc(p.purpose) : none}</dd>
        <dt>対象ユーザー</dt><dd>${p.targetUsers ? esc(p.targetUsers) : none}</dd>
        <dt>対象端末</dt><dd>${devs.length ? devs.map(esc).join('・') : none}</dd>
        <dt>現在Version</dt><dd>${latestSpec ? esc(latestSpec.version) : '<span class="muted">仕様書なし</span>'}</dd>
        <dt>状態</dt><dd>${esc(label(m, 'statuses', p.status) || '未設定')}</dd>
        <dt>作る形</dt><dd>${p.deliverableType ? esc(label(m, 'deliverableTypes', p.deliverableType)) : '<span class="muted">未決定</span>'}</dd>
        <dt>開発の始め方</dt><dd>${esc(label(m, 'projectOrigins', p.origin || 'new'))}${p.origin === 'existing' ? `（${esc(label(m, 'importStatuses', p.existing?.importStatus || 'waiting'))}）` : ''}${['unknown', 'existing'].includes(p.origin) ? ` <a href="#/p/${esc(p.id)}/existing">既存アプリタブ</a>` : ''}</dd>
        <dt>完成度</dt><dd>${prog.total}%</dd>
        <dt>次作業</dt><dd>${nt ? `${esc(nt.title)} <span class="badge pri-${esc(nt.priority)}">${esc(label(m, 'taskPriorities', nt.priority))}</span>` : '<span class="muted">未設定</span>'}</dd>
        <dt>問題</dt><dd>${openIssues.length ? `<ul class="tight">${sortIssues(openIssues, m).slice(0, 3).map(i => `<li>${esc(i.title)}</li>`).join('')}</ul>${openIssues.length > 3 ? `<a href="#/p/${esc(p.id)}/next">ほか${openIssues.length - 3}件</a>` : ''}` : 'なし'}</dd>
        <dt>メモ</dt><dd class="prewrap">${p.memo ? esc(p.memo) : none}</dd>
        <dt>作成</dt><dd>${fmtDate(p.createdAt)}（${esc(p.createdBy)}）</dd>
        <dt>更新</dt><dd>${fmtDate(p.updatedAt)}（${esc(p.updatedBy)}）</dd>
        ${p.copiedFrom ? `<dt>複製元</dt><dd><a href="#/p/${esc(p.copiedFrom)}">複製元を開く</a></dd>` : ''}
      </dl>
    </section>
    ${p.ideaId ? `<a class="btn" href="#/talk/${esc(p.ideaId)}">元の相談と3AI依頼文を見る</a>` : ''}
    <div class="btns" style="margin-top:10px">
      <button class="btn primary" id="edit-p">基本情報を編集</button>
      <button class="btn" id="dup-p2">複製</button>
      <button class="btn danger" id="del-p2">削除</button>
    </div>`;
  el.querySelector('#edit-p').onclick = () => openProjectForm(ctx, p);
  el.querySelector('#dup-p2').onclick = () => openDuplicate(ctx, p);
  el.querySelector('#del-p2').onclick = () => confirmDeleteProject(ctx, p);
}

// 2. 仕様書 → js/views/spec.js（Phase 4）

// 3. 完成度（Phase 6：8項目を実データと連動。自動で決められない項目だけ10%刻みで手入力）＋完成の条件＋実機確認・公開確認
async function progress({ ctx, el, p, prog, checks }) {
  const m = ctx.master;
  const manualAxes = prog.axes.filter(a => !a.auto);
  const items = await ctx.db.completionCheck(p.id);
  const ngCount = items.filter(i => !i.ok).length;
  const devices = sortChecks(checks.filter(c => c.kind === 'device')), publish = sortChecks(checks.filter(c => c.kind === 'publish'));
  el.innerHTML = `<section class="card">
    <h2>完成度 ${prog.total}%</h2>
    <p class="muted">「自動」の項目は、仕様書・ファイル・テスト・引継ぎ・実機確認などの実データから計算します。自動で決められない項目だけ手で選んでください。</p>
    ${prog.axes.map((a, i) => `<div class="axis">
      <div class="axis-head"><span>${i + 1}. ${esc(a.label)} ${a.auto ? '<span class="badge ok">自動</span>' : '<span class="badge">手入力</span>'}</span><b>${a.value}%</b></div>
      <div class="meter"><i style="width:${a.value}%"></i></div>
      ${a.note ? `<p class="muted">${esc(a.note)}</p>` : ''}
    </div>`).join('')}
    ${manualAxes.length ? `<form id="pg"><h3 style="margin-top:12px">手入力の項目</h3><div class="grid two">${manualAxes.map(a => `<label class="field"><span>${esc(a.label)}</span>
      <select id="ax-${a.key}" name="${a.key}">${Array.from({ length: 11 }, (_, i) => i * 10).map(v => `<option value="${v}"${v === a.value ? ' selected' : ''}>${v}%</option>`).join('')}</select></label>`).join('')}</div>
      <div id="pg-err"></div><button class="btn primary">完成度を保存</button></form>` : ''}
  </section>
  <section class="card" id="cond-card">
    <h2>「完成」にできる条件 ${ngCount ? `<span class="badge ng">あと${ngCount}つ</span>` : '<span class="badge ok">すべて満たしています</span>'}</h2>
    <p class="muted">「使用可能」は主要機能が動き運用を始められる状態、「完成」は下の条件をすべて満たした状態です。使用可能になっても自動で完成にはなりません。</p>
    <ul class="cond">${items.map(i => `<li class="${i.ok ? 'ok' : 'ng'}"><span class="mark">${i.ok ? '✅' : '⬜'}</span><div><strong>${esc(i.label)}</strong><div class="muted">${esc(i.detail)}</div></div></li>`).join('')}</ul>
  </section>
  ${checksHtml(m, devices, publish)}`;
  const f = el.querySelector('#pg');
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    const progressVal = { ...(p.progress || {}), ...Object.fromEntries(manualAxes.map(a => [a.key, Number(f.elements[a.key].value)])) };
    try { await ctx.db.update('projects', p.id, { progress: progressVal }, { reason: '完成度（手入力の項目）を更新' }); toast('保存しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#pg-err').innerHTML = errorHtml(err); }
  };
  bindChecks(el, ctx, p.id, { devices, publish });
}

// 4. 次にやること（作業）＋未解決事項 — Phase 3 で正式データ化
async function next({ ctx, el, p, tasks, issues }) {
  const m = ctx.master;
  const st = sortTasks(tasks, m);
  const openT = st.filter(t => isOpenTask(t, m)), hold = st.filter(t => t.status === 'hold'), doneT = st.filter(t => t.status === 'done');
  const si = sortIssues(issues, m);
  const openI = si.filter(i => i.status !== 'resolved'), resolvedI = si.filter(i => i.status === 'resolved');
  const taskLi = t => `<li class="task st-${esc(t.status)}">
      <button class="tick" data-done="${esc(t.id)}" aria-label="「${esc(t.title)}」を${t.status === 'done' ? '未着手に戻す' : '完了にする'}">${t.status === 'done' ? '✓' : ''}</button>
      <button class="row-btn grow" data-task="${esc(t.id)}">
        <span class="t-title">${esc(t.title)}</span>
        <span class="t-meta"><span class="badge pri-${esc(t.priority || 'medium')}">${esc(label(m, 'taskPriorities', t.priority || 'medium'))}</span>
          <span>${esc(label(m, 'taskStatuses', t.status || 'todo'))}</span><span>担当：${esc(label(m, 'taskAssignees', t.ai || 'user'))}</span>${t.memo ? '<span>メモあり</span>' : ''}</span>
      </button></li>`;
  const issueLi = i => `<li><button class="row-btn grow" data-issue="${esc(i.id)}">
      <span class="t-title">${esc(i.title)}</span>
      <span class="t-meta"><span class="badge sev-${esc(i.severity || 'medium')}">${esc(label(m, 'issueSeverities', i.severity || 'medium'))}</span>
        <span>発生 ${esc(i.occurredAt || (i.createdAt || '').slice(0, 10))}</span>${i.status === 'resolved' ? `<span>解決 ${esc((i.resolvedAt || '').slice(0, 10))}</span>` : ''}</span>
      ${i.status === 'resolved' && i.resolution ? `<span class="t-res">解決内容：${esc(i.resolution)}</span>` : ''}
    </button>${i.status === 'resolved' ? '' : `${(i.severity || 'medium') === 'high' && !tasks.some(t => t.source?.id === i.id && t.status !== 'done') ? `<button class="btn small" data-issue-task="${esc(i.id)}">次にやることへ</button>` : ''}<button class="btn small" data-resolve="${esc(i.id)}">解決</button>`}</li>`;

  el.innerHTML = `<section class="card">
      <h2>次にやること <span class="muted">${openT.length}件</span></h2>
      <form id="tk" class="inline-add"><label class="sr-only" for="tk-t">作業を追加</label>
        <input id="tk-t" type="text" name="t" maxlength="200" placeholder="作業を追加（例：店舗データの項目を決める）">
        <label class="sr-only" for="tk-p">優先度</label><select id="tk-p" name="p" class="pri-select">${options(m.taskPriorities, 'medium')}</select>
        <button class="btn small primary">追加</button></form>
      <div id="tk-err"></div>
      ${openT.length ? `<ul class="list tasks">${openT.map(taskLi).join('')}</ul>` : '<p class="muted">未完了の作業はありません。</p>'}
      ${hold.length ? `<details><summary class="muted">保留 ${hold.length}件</summary><ul class="list tasks">${hold.map(taskLi).join('')}</ul></details>` : ''}
      ${doneT.length ? `<details><summary class="muted">完了 ${doneT.length}件</summary><ul class="list tasks">${doneT.map(taskLi).join('')}</ul></details>` : ''}
    </section>
    <section class="card">
      <h2>未解決事項 <span class="muted">${openI.length}件</span></h2>
      <form id="is" class="inline-add"><label class="sr-only" for="is-t">未解決事項を追加</label>
        <input id="is-t" type="text" name="t" maxlength="300" placeholder="困っていること・決まっていないこと">
        <label class="sr-only" for="is-s">重要度</label><select id="is-s" name="s" class="pri-select">${options(m.issueSeverities, 'medium')}</select>
        <button class="btn small primary">追加</button></form>
      <div id="is-err"></div>
      ${openI.length ? `<ul class="list issues">${openI.map(issueLi).join('')}</ul>` : '<p class="muted">未解決事項はありません。</p>'}
      ${resolvedI.length ? `<details><summary class="muted">解決済み ${resolvedI.length}件（履歴）</summary><ul class="list issues">${resolvedI.map(issueLi).join('')}</ul></details>` : ''}
    </section>`;

  el.querySelector('#tk').onsubmit = async e => {
    e.preventDefault();
    try { await ctx.db.create('tasks', { projectId: p.id, title: e.target.t.value.trim(), priority: e.target.p.value, status: 'todo', ai: 'user', memo: '' }, { reason: '作業を追加' }); toast('追加しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#tk-err').innerHTML = errorHtml(err); }
  };
  el.querySelector('#is').onsubmit = async e => {
    e.preventDefault();
    try { await ctx.db.create('issues', { projectId: p.id, title: e.target.t.value.trim(), severity: e.target.s.value, status: 'open', occurredAt: today(), resolution: '', resolvedAt: null }, { reason: '未解決事項を追加' }); toast('追加しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#is-err').innerHTML = errorHtml(err); }
  };
  el.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
    const t = tasks.find(x => x.id === b.dataset.done);
    const to = t.status === 'done' ? 'todo' : 'done';
    await ctx.db.update('tasks', t.id, { status: to, doneAt: to === 'done' ? new Date().toISOString() : null }, { reason: to === 'done' ? '作業を完了' : '作業を未着手に戻す' });
    toast(to === 'done' ? '完了にしました' : '未着手に戻しました'); ctx.refresh();
  });
  el.querySelectorAll('[data-task]').forEach(b => b.onclick = () => taskModal(ctx, tasks.find(x => x.id === b.dataset.task)));
  el.querySelectorAll('[data-issue]').forEach(b => b.onclick = () => issueModal(ctx, issues.find(x => x.id === b.dataset.issue)));
  el.querySelectorAll('[data-resolve]').forEach(b => b.onclick = () => issueModal(ctx, issues.find(x => x.id === b.dataset.resolve), { resolve: true }));
  // 重大な未解決事項 → 次にやること（確認してから追加）
  el.querySelectorAll('[data-issue-task]').forEach(b => b.onclick = () => {
    const i = issues.find(x => x.id === b.dataset.issueTask);
    toTask(ctx, p, { id: i.id, item: i.title, error: '' }, { title: `重大な問題を解決：${i.title}`, source: { type: 'issue', id: i.id } });
  });
}

const today = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };

function taskModal(ctx, t) {
  const m = ctx.master;
  const md = openModal(`<h2>作業を編集</h2><form id="tf">
    <label class="field"><span>作業内容</span><input type="text" name="title" maxlength="200" value="${esc(t.title)}"></label>
    <div class="grid two">
      <label class="field"><span>優先度</span><select name="priority">${options(m.taskPriorities, t.priority || 'medium')}</select></label>
      <label class="field"><span>状態</span><select name="status">${options(m.taskStatuses, t.status || 'todo')}</select></label>
    </div>
    <label class="field"><span>担当AI</span><select name="ai">${options(m.taskAssignees, t.ai || 'user')}</select></label>
    <label class="field"><span>メモ</span><textarea name="memo" rows="3">${esc(t.memo || '')}</textarea></label>
    <p class="muted">作成：${fmtDate(t.createdAt)}　更新：${fmtDate(t.updatedAt)}</p>
    <div id="tf-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">保存</button></div>
    <hr><button type="button" class="btn danger" id="tf-del">この作業を削除（ゴミ箱へ）</button>
  </form>`);
  const f = md.el.querySelector('#tf'), E = f.elements;
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      await ctx.db.update('tasks', t.id, { title: E.title.value.trim(), priority: E.priority.value, status: E.status.value, ai: E.ai.value, memo: E.memo.value.trim(), doneAt: E.status.value === 'done' ? (t.doneAt || new Date().toISOString()) : null }, { reason: '作業を編集' });
      md.close(); toast('保存しました'); ctx.refresh();
    } catch (err) { md.el.querySelector('#tf-err').innerHTML = errorHtml(err); }
  };
  md.el.querySelector('#tf-del').onclick = async () => {
    md.close();
    if (!await confirmDialog({ title: '作業を削除しますか？', body: '<p>ゴミ箱へ移します。元に戻せます。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('tasks', t.id, { reason: '作業を削除' }); toast('ゴミ箱へ移しました'); ctx.refresh();
  };
}

function issueModal(ctx, i, { resolve = false } = {}) {
  const m = ctx.master;
  const status = resolve ? 'resolved' : (i.status || 'open');
  const md = openModal(`<h2>${resolve ? '解決を記録' : '未解決事項'}</h2><form id="if">
    <label class="field"><span>内容</span><input type="text" name="title" maxlength="300" value="${esc(i.title)}"></label>
    <div class="grid two">
      <label class="field"><span>重要度</span><select name="severity">${options(m.issueSeverities, i.severity || 'medium')}</select></label>
      <label class="field"><span>状態</span><select name="status">${options(m.issueStatuses, status)}</select></label>
    </div>
    <label class="field"><span>発生日</span><input type="date" name="occurredAt" value="${esc(i.occurredAt || (i.createdAt || '').slice(0, 10))}"></label>
    <label class="field"><span>解決内容</span><textarea name="resolution" rows="3" placeholder="どう解決したか（あとで見返せます）">${esc(i.resolution || '')}</textarea></label>
    ${i.resolvedAt ? `<p class="muted">解決日：${fmtDate(i.resolvedAt)}</p>` : ''}
    <div id="if-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">保存</button></div>
    <hr><button type="button" class="btn danger" id="if-del">削除（ゴミ箱へ）</button>
  </form>`);
  const f = md.el.querySelector('#if'), E = f.elements;
  if (resolve) setTimeout(() => E.resolution.focus(), 50);
  f.onsubmit = async e => {
    e.preventDefault();
    const st = E.status.value;
    try {
      await ctx.db.update('issues', i.id, { title: E.title.value.trim(), severity: E.severity.value, status: st, occurredAt: E.occurredAt.value || null, resolution: E.resolution.value.trim(), resolvedAt: st === 'resolved' ? (i.resolvedAt || new Date().toISOString()) : null }, { reason: st === 'resolved' && i.status !== 'resolved' ? '解決' : '未解決事項を編集' });
      md.close(); toast(st === 'resolved' ? '解決済みにしました（履歴に残ります）' : '保存しました'); ctx.refresh();
    } catch (err) { md.el.querySelector('#if-err').innerHTML = errorHtml(err); }
  };
  md.el.querySelector('#if-del').onclick = async () => {
    md.close();
    if (!await confirmDialog({ title: '未解決事項を削除しますか？', body: '<p>ゴミ箱へ移します。元に戻せます。解決したものは削除せず「解決済み」にすると履歴に残ります。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('issues', i.id, { reason: '未解決事項を削除' }); toast('ゴミ箱へ移しました'); ctx.refresh();
  };
}

// 5. 要望箱（Phase 4：採用済みを選んで「仕様へ反映」→変更案）
async function reqs({ ctx, el, p, requests, specs }) {
  const sorted = requests.slice().sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  const draft = specs.find(x => x.status === 'draft');
  const latest = specs.filter(x => (x.status || 'fixed') === 'fixed').sort((a, b) => compareVersion(b.version, a.version))[0];
  const target = draft ? draft.version : latest ? nextVersion(latest.version) : 'v1.0';
  const waiting = sorted.filter(r => r.status === 'adopted' && !r.specState).length;
  el.innerHTML = `<section class="card">
    <form id="rq" class="inline-add"><label class="sr-only" for="rq-t">要望を追加</label>
      <input id="rq-t" type="text" name="t" placeholder="思いついたことを入力"><button class="btn small primary">要望箱へ</button></form>
    <div id="rq-err"></div><p class="muted">${esc(RULE_NOTE)}</p>
    ${waiting ? `<p class="hint">☑ 採用済みで未反映の要望が <strong>${waiting}件</strong> あります。チェックを入れて「仕様へ反映」を押すと、<strong>${esc(target)}</strong> の変更案にまとめて入ります。</p>` : ''}
    ${requestRows(sorted, ctx.master, null, { selectable: true })}</section>
    <div id="reflect-bar" class="reflect-bar" hidden><span><b class="n">0</b>件を選択中</span><button class="btn primary">${esc(target)}候補へ反映</button></div>`;
  el.querySelector('#rq').onsubmit = async e => {
    e.preventDefault();
    try { await ctx.db.create('requests', { projectId: p.id, title: e.target.t.value.trim(), status: 'unreviewed' }, { reason: '要望を追加' }); toast('要望箱に入れました'); ctx.refresh(); }
    catch (err) { el.querySelector('#rq-err').innerHTML = errorHtml(err); }
  };
  bindRequestRows(el, ctx);
  bindReflect(el, ctx, p.id, target);
}

// 6. 3AI比較 → js/views/compare.js、7. ファイル → js/views/files.js、URL → js/views/urls.js（Phase 5）

// 8. テスト → js/views/tests.js（Phase 6）、引継ぎ → js/views/phandoff.js

// 9. 変更履歴（いつ・誰が・何を・なぜ）
async function history({ ctx, el, p }) {
  const rows = await ctx.db.historyOfProject(p.id);
  // 選択肢の値（concept 等）を日本語名に
  const ENUMS = { status: { tests: 'testStatuses', checks: 'deviceCheckStatuses', specs: 'specStatuses', projects: 'statuses', requests: 'requestStatuses', issues: 'issueStatuses', ideas: 'ideaStatuses', tasks: 'taskStatuses' }, deliverableType: { projects: 'deliverableTypes' }, result: { tests: 'testResults' }, retestResult: { tests: 'testResults' }, priority: { tasks: 'taskPriorities' }, ai: { tasks: 'taskAssignees' }, severity: { issues: 'issueSeverities' } };
  const enumLabel = (store, k, v) => { const list = ENUMS[k]?.[store]; return list && v ? label(ctx.master, list, v) : v; };
  const fmtVal = v => v == null || v === '' ? '（空）' : typeof v === 'object' ? '…' : /^\d{4}-\d\d-\d\dT/.test(v) ? fmtDate(v) : String(v).length > 40 ? String(v).slice(0, 40) + '…' : String(v);
  el.innerHTML = `<section class="card">${rows.length ? `<ol class="timeline">${rows.slice(0, 200).map(h => {
    const ch = Object.entries(h.changes || {}).filter(([k]) => h.action === 'update' && !['projectId', 'ideaId', 'copiedFrom', 'specId', 'decisions', 'body', 'requestIds', 'guide', 'baseSpecId', 'runs', 'answers', 'code'].includes(k)); // 内部IDは表示しない
    if (h.action === 'fix') { const d = h.details || {}; return `<li class="fix"><div class="muted">${fmtDate(h.at)}・${esc(h.actor)} が確定</div>
      <div><strong>仕様 ${esc(d.oldVersion || '（新規）')} → ${esc(d.newVersion)} を確定</strong></div>
      <ul class="tight muted"><li>変更理由：${esc(h.reason || '—')}</li>${d.summary ? `<li>変更内容：${esc(summaryText(d.summary))}</li>` : ''}
      ${(d.diff || []).slice(0, 5).map(x => `<li>${esc(x)}</li>`).join('')}${(d.diff || []).length > 5 ? `<li>…ほか${d.diff.length - 5}件</li>` : ''}
      ${d.requestTitles?.length ? `<li>元になった要望：${d.requestTitles.map(esc).join('、')}</li>` : ''}</ul></li>`; }
    return `<li><div class="muted">${fmtDate(h.at)}・${esc(h.actor)}</div>
      <div><strong>${esc(STORE_LABELS[h.store] || h.store)}を${esc(ACTION_LABELS[h.action] || h.action)}</strong>${h.reason ? `<span class="muted">（${esc(h.reason)}）</span>` : ''}</div>
      ${ch.length ? `<ul class="tight muted">${ch.map(([k, v]) => `<li>${esc(FIELD_LABELS[k] || k)}：${esc(fmtVal(enumLabel(h.store, k, v.from)))} → ${esc(fmtVal(enumLabel(h.store, k, v.to)))}</li>`).join('')}</ul>` : ''}</li>`;
  }).join('')}</ol>` : '<p class="muted">履歴はまだありません。</p>'}</section>`;
}
