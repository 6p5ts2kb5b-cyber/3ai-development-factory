// Phase 3：プロジェクトの新規作成・編集・複製・削除（話すだけからの作成も同じデータ構造）
import { esc, fmtDate, toast, errorHtml, openModal, options } from '../ui.js';
import { PROJECT_CHILD_STORES } from '../db.js';
import { STORE_LABELS } from '../labels.js';
import { existingFieldsHtml, readExistingFields } from './importer.js';

// 新規作成（全入口で共通）：プロジェクト本体＋最初の作業（任意）
export async function createProject(db, data, { firstTask = '', reason = 'プロジェクトを作成' } = {}) {
  const p = await db.create('projects', {
    name: (data.name || '').trim(), purpose: (data.purpose || '').trim(), targetUsers: (data.targetUsers || '').trim(),
    targetDevices: data.targetDevices || [], status: data.status || 'concept', deliverableType: data.deliverableType || null,
    memo: (data.memo || '').trim(), progress: data.progress || {}, ...(data.ideaId ? { ideaId: data.ideaId } : {}),
    ...(data.id ? { id: data.id } : {}), // 固定ID（Factory本体など）
    origin: data.origin || 'new', ...(data.origin === 'existing' ? { existing: { importStatus: 'waiting', ...(data.existing || {}) } } : {}),
  }, { reason });
  if (firstTask.trim()) await db.create('tasks', { projectId: p.id, title: firstTask.trim(), priority: 'high', status: 'todo', ai: 'user', memo: '' }, { reason: '最初の作業を登録' });
  return p;
}

const deviceChecks = (m, sel = []) => `<div class="checks">${m.targetDevices.map(d => `<label class="check"><input type="checkbox" name="dev" value="${esc(d.key)}"${sel.includes(d.key) ? ' checked' : ''}><span>${esc(d.label)}</span></label>`).join('')}</div>`;

// 作成・編集フォーム（モーダル）
export function openProjectForm(ctx, project = null) {
  const m = ctx.master, p = project || {};
  const isNew = !project;
  const md = openModal(`<h2>${isNew ? '新しいプロジェクト' : '基本情報を編集'}</h2>
    <form id="pf" novalidate>
      ${isNew ? `<fieldset class="field origin-pick"><legend>始め方 <em class="req">必須</em></legend><div class="checks">
        <label class="check"><input type="radio" name="origin" value="new" checked><span>新しく作る</span></label>
        <label class="check"><input type="radio" name="origin" value="existing"><span>既存アプリを取り込む</span></label></div>
        <p class="muted">すでにClaude等で作って使っているアプリがある場合は「既存アプリを取り込む」を選んでください。今のアプリをゼロから作り直さず、現在の状態から改良します。</p></fieldset>` : ''}
      <label class="field"><span>プロジェクト名 <em class="req">必須</em></span><input type="text" name="name" maxlength="100" value="${esc(p.name || '')}"></label>
      <label class="field"><span>目的</span><textarea name="purpose" rows="3" placeholder="何のために作るか">${esc(p.purpose || '')}</textarea></label>
      <label class="field"><span>対象ユーザー</span><input type="text" name="targetUsers" maxlength="500" value="${esc(p.targetUsers || '')}" placeholder="例：自分・家族・部員・保護者"></label>
      <fieldset class="field"><legend>対象端末</legend>${deviceChecks(m, p.targetDevices || [])}</fieldset>
      <div class="grid two">
        <label class="field"><span>状態</span><select name="status">${options(m.statuses, p.status || 'concept')}</select></label>
        <label class="field"><span>作る形</span><select name="deliverableType"><option value="">未決定</option>${options(m.deliverableTypes, p.deliverableType)}</select></label>
      </div>
      ${isNew ? `<details id="ex-box" class="ex-box" hidden><summary>既存アプリの情報（分かる項目だけ入力・推測では書かない）</summary>
        <p class="muted">ここで入れなくても、作成後の「既存アプリ」タブで入力できます。ソースコードは作成後に「ファイル」タブで登録します。</p>
        ${existingFieldsHtml(m, {})}</details>` : ''}
      ${isNew ? `<label class="field"><span>最初にやること（任意）</span><input type="text" name="firstTask" maxlength="200" placeholder="例：3AIに相談して仕様を整理する"></label>` : ''}
      ${isNew ? `<label class="check" style="margin-bottom:12px"><input type="checkbox" name="withTests" checked><span>共通テスト（${(m.commonTestTemplate || []).length}項目）を最初から登録する</span></label>` : ''}
      <label class="field"><span>メモ</span><textarea name="memo" rows="3">${esc(p.memo || '')}</textarea></label>
      ${isNew ? '' : `<label class="field"><span>変更の理由（任意・履歴に残ります）</span><input type="text" name="reason"></label>
        <p class="muted">作成：${fmtDate(p.createdAt)}（${esc(p.createdBy)}）／更新：${fmtDate(p.updatedAt)}（${esc(p.updatedBy)}）</p>`}
      <div id="pf-err"></div>
      <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">${isNew ? '作成する' : '保存'}</button></div>
      ${isNew ? '' : `<hr><div class="btns"><button type="button" class="btn" id="dup-p">このプロジェクトを複製</button><button type="button" class="btn danger" id="del-p">削除（関連データごとゴミ箱へ）</button></div>`}
    </form>`);
  const f = md.el.querySelector('#pf');
  setTimeout(() => isNew && f.elements.name.focus(), 50);
  if (isNew) f.querySelectorAll('input[name=origin]').forEach(r => r.onchange = () => { const box = f.querySelector('#ex-box'); box.hidden = f.elements.origin.value !== 'existing'; if (!box.hidden) box.open = true; });
  f.onsubmit = async e => {
    e.preventDefault();
    const E = f.elements;
    const data = {
      name: E.name.value.trim(), purpose: E.purpose.value.trim(), targetUsers: E.targetUsers.value.trim(),
      targetDevices: [...f.querySelectorAll('input[name=dev]:checked')].map(x => x.value),
      status: E.status.value, deliverableType: E.deliverableType.value || null, memo: E.memo.value.trim(),
    };
    try {
      if (isNew) {
        const origin = E.origin.value || 'new';
        const ex = origin === 'existing' ? readExistingFields(f) : null;
        if (ex) { // URLの形式は作成前に確認（途中までできたプロジェクトを残さない）
          const bad = ['webUrl', 'githubUrl'].filter(k => ex[k].trim() && !/^https?:\/\/\S+$/.test(ex[k].trim()));
          if (bad.length) throw Object.assign(new Error('入力内容を確認してください'), { details: bad.map(k => `${k === 'webUrl' ? 'Web URL' : 'GitHub URL'} は http:// または https:// で始めてください`) });
        }
        const np = await createProject(ctx.db, { ...data, origin }, { firstTask: E.firstTask.value });
        if (ex) await ctx.db.saveExisting(np.id, ex);
        if (E.withTests?.checked) await ctx.db.applyTestTemplate(np.id); // Phase 6：共通テストテンプレート
        md.close(); toast(ex ? '既存アプリ取込プロジェクトを作りました（取込待ち）' : 'プロジェクトを作りました'); location.hash = ex ? `#/p/${np.id}/existing` : `#/p/${np.id}`;
      } else {
        await ctx.db.update('projects', p.id, data, { reason: E.reason.value.trim() || '基本情報を編集' });
        md.close(); toast('保存しました'); ctx.refresh();
      }
    } catch (err) { md.el.querySelector('#pf-err').innerHTML = errorHtml(err); md.el.querySelector('#pf-err').scrollIntoView({ block: 'nearest' }); }
  };
  if (!isNew) {
    md.el.querySelector('#dup-p').onclick = () => { md.close(); openDuplicate(ctx, p); };
    md.el.querySelector('#del-p').onclick = () => { md.close(); confirmDeleteProject(ctx, p); };
  }
}

// 関連データの件数（削除確認で表示）
export async function relatedCounts(db, projectId) {
  const out = {};
  for (const s of PROJECT_CHILD_STORES) out[s] = (await db.byIndex(s, 'projectId', projectId)).length;
  out.history = (await db.byIndex('history', 'projectId', projectId)).length;
  return out;
}
const countsHtml = c => `<ul class="tight">${Object.entries(c).filter(([, n]) => n).map(([s, n]) => `<li>${esc(s === 'tasks' ? '次にやること' : STORE_LABELS[s] || s)}：${n}件</li>`).join('') || '<li>関連データなし</li>'}</ul>`;

export async function confirmDeleteProject(ctx, p) {
  const c = await relatedCounts(ctx.db, p.id);
  const md = openModal(`<h2>「${esc(p.name)}」を削除しますか？</h2>
    <p>このプロジェクトと、次の<strong>関連データをまとめてゴミ箱へ</strong>移します。</p>${countsHtml(c)}
    <p class="muted">すぐには消えません。「設定 → ゴミ箱」から、関連データごと元に戻せます。他のプロジェクトのデータは変わりません。</p>
    <div class="btns"><button class="btn" data-close>やめる</button><button class="btn danger" id="do-del">ゴミ箱へ移す</button></div>`);
  md.el.querySelector('#do-del').onclick = async () => {
    try { await ctx.db.remove('projects', p.id, { reason: '' }); md.close(); toast('関連データごとゴミ箱へ移しました'); location.hash = '#/'; }
    catch (err) { md.el.insertAdjacentHTML('beforeend', errorHtml(err)); }
  };
}

export function openDuplicate(ctx, p) {
  const md = openModal(`<h2>プロジェクトを複製</h2>
    <form id="dup">
      <label class="field"><span>新しいプロジェクト名</span><input type="text" name="name" maxlength="100" value="${esc(p.name)}（コピー）"></label>
      <p><strong>必ずコピー：</strong>目的・対象ユーザー・対象端末・作る形・メモ</p>
      <fieldset class="field"><legend>一緒にコピーするもの</legend><div class="checks">
        <label class="check"><input type="checkbox" name="specs" checked><span>仕様書</span></label>
        <label class="check"><input type="checkbox" name="tasks"><span>次にやること（未着手に戻します）</span></label>
        <label class="check"><input type="checkbox" name="requests"><span>要望箱</span></label>
        <label class="check"><input type="checkbox" name="files"><span>ファイル情報</span></label>
      </div></fieldset>
      <p class="muted">変更履歴・テスト結果・未解決事項（エラー履歴）・3AI比較は、混乱を防ぐためコピーしません。状態は「構想」、完成度は0%から始まります。</p>
      <div id="dup-err"></div>
      <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">複製する</button></div>
    </form>`);
  const f = md.el.querySelector('#dup');
  f.onsubmit = async e => {
    e.preventDefault();
    const E = f.elements;
    try {
      const { project, copied } = await ctx.db.duplicateProject(p.id, { name: E.name.value, include: { specs: E.specs.checked, tasks: E.tasks.checked, requests: E.requests.checked, files: E.files.checked } });
      md.close(); toast(`複製しました（関連データ${copied}件）`); location.hash = `#/p/${project.id}`;
    } catch (err) { md.el.querySelector('#dup-err').innerHTML = errorHtml(err); }
  };
}

// 完全削除の確認（プロジェクトのまとまり）：チェックを入れないと押せない
export function confirmPurgeBundle(ctx, t) {
  return new Promise(resolve => {
    const c = Object.fromEntries(Object.entries(t.related || {}).map(([s, rows]) => [s, rows.length]));
    const md = openModal(`<h2>完全に削除しますか？</h2>
      <div class="notice ng"><strong>このプロジェクトと関連データを完全に削除します。元に戻せません。</strong></div>
      <p>対象：「${esc(t.record?.name)}」</p>${countsHtml(c)}
      <label class="check big-check"><input type="checkbox" id="purge-ok"><span>元に戻せないことを理解しました</span></label>
      <div class="btns" style="margin-top:12px"><button class="btn" data-close>やめる</button><button class="btn danger" id="do-purge" disabled>完全に削除する</button></div>`, { onClose: () => resolve(false) });
    const ok = md.el.querySelector('#purge-ok'), btn = md.el.querySelector('#do-purge');
    ok.onchange = () => { btn.disabled = !ok.checked; };
    btn.onclick = async () => {
      try { await ctx.db.purge(t.id, { reason: `プロジェクト「${t.record?.name}」と関連データを完全削除` }); resolve(true); md.close(); }
      catch (err) { md.el.insertAdjacentHTML('beforeend', errorHtml(err)); }
    };
  });
}
