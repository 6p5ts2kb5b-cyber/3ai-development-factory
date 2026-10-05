// Phase 6：テストタブ（項目管理・結果記録・不合格→エラー→修正→再テスト→合格の履歴）
import { esc, fmtDate, fmtShort, toast, errorHtml, openModal, options, confirmDialog } from '../ui.js';
import { label } from '../master.js';
import { latestResult, isRequiredTest } from '../logic.js';
import { specStatus } from '../db.js';
import { groupFiles } from '../ai.js';

const base = (p, q = '') => `#/p/${encodeURIComponent(p.id)}/tests${q}`;
const ST_CLASS = { pass: 'ok', fail: 'ng', fixing: 'warn', retest: 'warn', untested: '' };
const stOf = t => t.status || (latestResult(t) === 'pass' ? 'pass' : latestResult(t) === 'fail' ? 'fail' : 'untested');

export async function testsTab({ ctx, el, p, params }) {
  const id = params.get('t');
  if (id) return testView(ctx, el, p, id);
  const m = ctx.master;
  const tests = (await ctx.db.byIndex('tests', 'projectId', p.id)).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const req = tests.filter(isRequiredTest);
  const cnt = k => req.filter(t => stOf(t) === k).length;
  const cats = [...new Set(tests.map(t => t.category || 'その他'))];
  el.innerHTML = `<section class="card">
      <div class="spec-head"><h2>テスト</h2><button class="btn small primary" id="add-test">＋ テスト項目</button></div>
      <div class="sum-chips">
        <span class="chip">必須 ${req.length}件</span><span class="chip add">合格 ${cnt('pass')}</span><span class="chip del">不合格 ${cnt('fail')}</span>
        <span class="chip chg">修正中・再テスト待ち ${cnt('fixing') + cnt('retest')}</span><span class="chip">未実施 ${cnt('untested')}</span>
      </div>
      <p class="muted">必須テストがすべて合格しないと「完成」にできません。不合格の記録・修正内容は、合格した後も履歴として残ります。</p>
      <button class="btn" id="add-template">共通テストを追加（${(m.commonTestTemplate || []).length}項目から選ぶ）</button>
    </section>
    ${tests.length ? cats.map(c => `<section class="card"><h3>${esc(c)}</h3><ul class="list">${tests.filter(t => (t.category || 'その他') === c).map(t => {
      const st = stOf(t);
      return `<li><a class="grow url-row" href="${base(p, `?t=${t.id}`)}"><strong>${esc(t.item)}</strong>
        <span class="t-meta"><span class="badge ${ST_CLASS[st]}">${esc(label(m, 'testStatuses', st))}</span>${isRequiredTest(t) ? '<span>必須</span>' : '<span>任意</span>'}
          ${t.executedAt ? `<span>${fmtShort(t.executedAt)} 実施</span>` : ''}${(t.runs || []).some(r => r.result === 'fail') && st === 'pass' ? '<span>不合格→修正→合格の履歴あり</span>' : ''}</span></a>
        ${['fail', 'fixing', 'retest'].includes(st) ? `<button class="btn small" data-totask="${esc(t.id)}">次にやることへ</button>` : ''}</li>`; }).join('')}</ul></section>`).join('')
      : '<section class="card"><p class="muted">テスト項目はまだありません。「共通テストを追加」から始めると便利です。</p></section>'}`;
  el.querySelector('#add-test').onclick = () => testForm(ctx, p);
  el.querySelector('#add-template').onclick = () => templatePicker(ctx, p, tests);
  el.querySelectorAll('[data-totask]').forEach(b => b.onclick = () => toTask(ctx, p, tests.find(t => t.id === b.dataset.totask)));
}

// テストから「次にやること」へ（確認してから追加）
export function toTask(ctx, p, t, { title, source } = {}) {
  const md = openModal(`<h2>「次にやること」へ追加</h2><form id="tt">
    <p class="muted">自動では追加しません。内容を確認して追加してください。</p>
    <label class="field"><span>作業内容</span><input type="text" name="title" maxlength="200" value="${esc(title || `テスト不合格を修正：${t.item}`)}"></label>
    <div class="grid two"><label class="field"><span>優先度</span><select name="priority">${options(ctx.master.taskPriorities, 'high')}</select></label>
    <label class="field"><span>担当AI</span><select name="ai">${options(ctx.master.taskAssignees, 'claude')}</select></label></div>
    <label class="field"><span>メモ</span><input type="text" name="memo" value="${esc(t.error ? `エラー：${t.error}` : '')}"></label>
    <div id="tt-err"></div><div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">追加する</button></div></form>`);
  md.el.querySelector('#tt').onsubmit = async e => {
    e.preventDefault(); const E = e.target.elements;
    try { await ctx.db.addTaskFrom(p.id, { title: E.title.value, priority: E.priority.value, ai: E.ai.value, memo: E.memo.value, source: source || { type: 'test', id: t.id } }); md.close(); toast('「次にやること」に追加しました'); ctx.refresh(); }
    catch (err) { md.el.querySelector('#tt-err').innerHTML = errorHtml(err); }
  };
}

function templatePicker(ctx, p, tests) {
  const have = new Set(tests.map(t => t.item));
  const list = ctx.master.commonTestTemplate || [];
  const md = openModal(`<h2>共通テストを追加</h2><form id="tp">
    <p class="muted">使う項目にチェックを入れてください。追加後もプロジェクトごとに追加・削除できます。</p>
    <div class="checks col">${list.map(t => `<label class="check"><input type="checkbox" name="n" value="${esc(t.name)}" ${have.has(t.name) ? 'disabled' : 'checked'}><span>${esc(t.name)}${have.has(t.name) ? '（追加済み）' : ''}<small class="muted"> ${esc(t.check)}</small></span></label>`).join('')}</div>
    <div class="btns" style="margin-top:12px"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">追加する</button></div></form>`);
  md.el.querySelector('#tp').onsubmit = async e => {
    e.preventDefault();
    const names = [...md.el.querySelectorAll('input[name=n]:checked')].map(x => x.value);
    const added = await ctx.db.applyTestTemplate(p.id, names);
    md.close(); toast(`共通テストを${added.length}件追加しました`); ctx.refresh();
  };
}

async function versionChoices(ctx, p) {
  const [specs, files] = await Promise.all([ctx.db.specsOf(p.id), ctx.db.byIndex('files', 'projectId', p.id)]);
  return {
    specs: specs.filter(s => specStatus(s) === 'fixed').map(s => s.version),
    files: groupFiles(files).flatMap(g => [g.latest, ...g.others]).map(f => `${f.fileName} ${f.version || ''}`.trim()),
    latestSpec: specs.find(s => specStatus(s) === 'fixed')?.version || '',
  };
}

// テスト項目の作成・編集（結果はここでは変えない＝履歴を守る）
async function testForm(ctx, p, t = null) {
  const m = ctx.master, x = t || {};
  const v = await versionChoices(ctx, p);
  const md = openModal(`<h2>${t ? 'テスト項目を編集' : 'テスト項目を追加'}</h2><form id="tf6">
    <label class="field"><span>テスト名 <em class="req">必須</em></span><input type="text" name="testName" maxlength="200" value="${esc(x.item || '')}"></label>
    <div class="grid two">
      <label class="field"><span>カテゴリー</span><select name="category">${m.testCategories.map(c => `<option${c === (x.category || 'その他') ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label class="check" style="align-self:end;margin-bottom:12px"><input type="checkbox" name="required" ${x.required === false ? '' : 'checked'}><span>必須テスト（完成の条件）</span></label>
    </div>
    <label class="field"><span>確認内容</span><textarea name="check" rows="2">${esc(x.check || '')}</textarea></label>
    <label class="field"><span>期待する結果</span><textarea name="expected" rows="2">${esc(x.expected || '')}</textarea></label>
    <div class="grid two">
      <label class="field"><span>関連仕様Version</span><select name="specVersion"><option value="">未指定</option>${v.specs.map(s => `<option${s === (x.specVersion ?? v.latestSpec) ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label class="field"><span>関連ファイルVersion</span><select name="fileVersion"><option value="">未指定</option>${v.files.map(f => `<option${f === x.fileVersion ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>メモ</span><textarea name="memo" rows="2">${esc(x.memo || '')}</textarea></label>
    <div id="tf6-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">保存</button></div></form>`);
  const f = md.el.querySelector('#tf6'), E = f.elements;
  f.onsubmit = async e => {
    e.preventDefault();
    const data = { item: E.testName.value.trim(), // ※ elements.item はブラウザ組み込みの関数名と重なるため testName を使う
      category: E.category.value, required: E.required.checked, check: E.check.value.trim(), expected: E.expected.value.trim(), specVersion: E.specVersion.value || null, fileVersion: E.fileVersion.value || null, memo: E.memo.value.trim() };
    try {
      if (t) { await ctx.db.update('tests', t.id, data, { reason: 'テスト項目を編集' }); md.close(); toast('保存しました'); ctx.refresh(); }
      else { const n = await ctx.db.create('tests', { ...data, projectId: p.id, status: 'untested', runs: [] }, { reason: 'テスト項目を追加' }); md.close(); toast('追加しました'); location.hash = base(p, `?t=${n.id}`); }
    } catch (err) { md.el.querySelector('#tf6-err').innerHTML = errorHtml(err); }
  };
}

const KIND = { run: '実施', fix: '修正', retest: '再テスト' };
async function testView(ctx, el, p, id) {
  const m = ctx.master;
  const t = await ctx.db.get('tests', id);
  if (!t) { el.innerHTML = errorHtml(new Error('テストが見つかりません')) + `<a class="btn" href="${base(p)}">戻る</a>`; return; }
  const st = stOf(t);
  const runs = t.runs || [];
  el.innerHTML = `<a class="back" href="${base(p)}">← テスト一覧へ</a>
    <section class="card">
      <div class="spec-head"><h2>${esc(t.item)}</h2><span class="badge ${ST_CLASS[st]}">${esc(label(m, 'testStatuses', st))}</span></div>
      <dl class="kv wide">
        <dt>カテゴリー</dt><dd>${esc(t.category || 'その他')}・${isRequiredTest(t) ? '必須' : '任意'}</dd>
        <dt>確認内容</dt><dd class="prewrap">${esc(t.check || '—')}</dd>
        <dt>期待する結果</dt><dd class="prewrap">${esc(t.expected || '—')}</dd>
        <dt>実際の結果</dt><dd class="prewrap">${esc(t.actual || '—')}</dd>
        <dt>実施</dt><dd>${t.executedAt ? `${fmtDate(t.executedAt)}（${esc(t.executedBy || '')}）` : '未実施'}</dd>
        <dt>エラー内容</dt><dd class="prewrap">${esc(t.error || '—')}</dd>
        <dt>修正内容</dt><dd class="prewrap">${esc(t.fix || '—')}</dd>
        <dt>再テスト結果</dt><dd>${t.retestResult ? esc(label(m, 'testResults', t.retestResult)) : '—'}</dd>
        <dt>関連仕様</dt><dd>${esc(t.specVersion || '未指定')}</dd>
        <dt>関連ファイル</dt><dd>${esc(t.fileVersion || '未指定')}</dd>
        <dt>メモ</dt><dd class="prewrap">${esc(t.memo || '—')}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>次の操作</h2>
      <div class="btns">
        ${st === 'untested' || st === 'pass' ? `<button class="btn primary" data-act="run">${st === 'pass' ? 'もう一度実施して記録' : '実施して結果を記録'}</button>` : ''}
        ${['fail', 'fixing', 'retest'].includes(st) ? `<button class="btn${st === 'fail' || st === 'fixing' ? ' primary' : ''}" data-act="fix">修正内容を記録</button>` : ''}
        ${['retest', 'fixing', 'fail'].includes(st) ? `<button class="btn${st === 'retest' ? ' primary' : ''}" data-act="retest">再テストの結果を記録</button>` : ''}
        ${['fail', 'fixing', 'retest'].includes(st) ? '<button class="btn" data-act="task">次にやることへ追加</button>' : ''}
        <button class="btn" data-act="edit">項目を編集</button>
        <button class="btn danger" data-act="del">削除（ゴミ箱へ）</button>
      </div>
    </section>
    <section class="card">
      <h2>履歴 <span class="muted">${runs.length}件</span></h2>
      <p class="muted">不合格・エラー・修正の記録は、合格した後も消えません。</p>
      ${runs.length ? `<ol class="timeline">${runs.slice().reverse().map(r => `<li class="${r.result === 'fail' ? 'ng-item' : r.result === 'pass' ? 'fix' : ''}">
        <div class="muted">${fmtDate(r.at)}・${esc(r.by || '')}</div>
        <div><strong>${esc(KIND[r.kind] || r.kind)}${r.result ? `：${esc(label(m, 'testResults', r.result))}` : r.kind === 'fix' ? `（${r.done ? '修正済み→再テスト待ち' : '修正中'}）` : ''}</strong></div>
        ${r.actual ? `<div class="muted">実際の結果：${esc(r.actual)}</div>` : ''}${r.error ? `<div class="err-text">エラー：${esc(r.error)}</div>` : ''}${r.fix ? `<div>修正内容：${esc(r.fix)}</div>` : ''}</li>`).join('')}</ol>` : '<p class="muted">まだ実施していません。</p>'}
    </section>`;
  const act = k => el.querySelector(`[data-act=${k}]`);
  act('run')?.addEventListener('click', () => resultDialog(ctx, t, 'run'));
  act('retest')?.addEventListener('click', () => resultDialog(ctx, t, 'retest'));
  act('fix')?.addEventListener('click', () => fixDialog(ctx, t));
  act('task')?.addEventListener('click', () => toTask(ctx, p, t));
  act('edit').onclick = () => testForm(ctx, p, t);
  act('del').onclick = async () => {
    if (!await confirmDialog({ title: `「${t.item}」を削除しますか？`, body: '<p>ゴミ箱へ移します（履歴ごと元に戻せます）。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('tests', t.id, { reason: 'テスト項目を削除' }); toast('ゴミ箱へ移しました'); location.hash = base(p);
  };
}

function resultDialog(ctx, t, kind) {
  const md = openModal(`<h2>${kind === 'retest' ? '再テストの結果' : '実施した結果'}：${esc(t.item)}</h2><form id="rd">
    ${t.expected ? `<p class="muted">期待する結果：${esc(t.expected)}</p>` : ''}
    <fieldset class="field"><legend>結果</legend><div class="checks">
      <label class="check"><input type="radio" name="result" value="pass"><span>✅ 合格</span></label>
      <label class="check"><input type="radio" name="result" value="fail"><span>❌ 不合格</span></label></div></fieldset>
    <label class="field"><span>実際の結果</span><textarea name="actual" rows="2"></textarea></label>
    <label class="field err-field"><span>エラー内容（不合格のときは必須）</span><textarea name="error" rows="3" placeholder="例：保存ボタンを押すと画面が固まる"></textarea></label>
    <div id="rd-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">記録する</button></div></form>`);
  md.el.querySelector('#rd').onsubmit = async e => {
    e.preventDefault(); const E = e.target.elements;
    const data = { result: E.result.value, actual: E.actual.value.trim(), error: E.error.value.trim() };
    try {
      if (kind === 'retest') await ctx.db.recordRetest(t.id, data); else await ctx.db.recordTestRun(t.id, data);
      md.close(); toast(data.result === 'pass' ? '合格を記録しました' : '不合格を記録しました（履歴に残ります）'); ctx.refresh();
    } catch (err) { md.el.querySelector('#rd-err').innerHTML = errorHtml(err); }
  };
}

function fixDialog(ctx, t) {
  const md = openModal(`<h2>修正内容を記録：${esc(t.item)}</h2><form id="fd">
    ${t.error ? `<p class="err-text">エラー：${esc(t.error)}</p>` : ''}
    <label class="field"><span>修正内容</span><textarea name="fix" rows="3" placeholder="例：保存処理の待ち時間を修正（Claude）">${esc(t.status === 'fixing' ? t.fix || '' : '')}</textarea></label>
    <fieldset class="field"><legend>修正の状態</legend><div class="checks">
      <label class="check"><input type="radio" name="done" value="1" checked><span>修正済み → 再テスト待ちにする</span></label>
      <label class="check"><input type="radio" name="done" value="0"><span>まだ修正中</span></label></div></fieldset>
    <div id="fd-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">記録する</button></div></form>`);
  md.el.querySelector('#fd').onsubmit = async e => {
    e.preventDefault(); const E = e.target.elements;
    try { await ctx.db.recordFix(t.id, { fix: E.fix.value.trim(), done: E.done.value === '1' }); md.close(); toast('修正内容を記録しました'); ctx.refresh(); }
    catch (err) { md.el.querySelector('#fd-err').innerHTML = errorHtml(err); }
  };
}
