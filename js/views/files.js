// Phase 5：コード／ファイル管理
// 「どれが現在の最新版か」「どの仕様Versionに対応しているか」を迷わないことを優先。
// コードの中身は、テキストで保存できる大きさ（30万文字まで）のときだけ任意で保存。大きいファイルは場所だけ登録。
import { esc, fmtDate, fmtShort, toast, errorHtml, openModal, options, confirmDialog } from '../ui.js';
import { label } from '../master.js';
import { nextVersion } from '../logic.js';
import { groupFiles } from '../ai.js';
import { specStatus } from '../db.js';
import { safeCopy } from './safecopy.js';

export async function filesTab({ ctx, el, p }) {
  const m = ctx.master;
  const [files, specs] = await Promise.all([ctx.db.byIndex('files', 'projectId', p.id), ctx.db.specsOf(p.id)]);
  const latestSpec = specs.find(s => specStatus(s) === 'fixed');
  const groups = groupFiles(files);
  const st = f => label(m, 'fileStatuses', f.status || 'active');
  const meta = f => `<span class="t-meta"><span class="badge file-${esc(f.status || 'active')}">${esc(st(f))}</span><span>${esc(f.type || '種類未設定')}</span>
    <span>仕様 ${esc(f.specVersion || '未指定')}</span><span>担当：${esc(label(m, 'taskAssignees', f.ai || 'user'))}</span>${f.code ? `<span>コード ${f.code.length.toLocaleString()}文字</span>` : ''}<span>更新 ${fmtShort(f.updatedAt)}</span></span>`;
  el.innerHTML = `<section class="card">
      <div class="spec-head"><h2>コード／ファイル <span class="muted">${groups.length}種類</span></h2><button class="btn small primary" id="add-file">＋ ファイルを登録</button></div>
      <p class="muted">同じファイル名の中で「使用中」の一番新しいVersionを<strong>最新版</strong>として表示します。古いVersionは「旧版」として残ります。</p>
      ${groups.length ? `<ul class="list files">${groups.map(g => {
        const f = g.latest;
        const mismatch = latestSpec && f.specVersion && f.specVersion !== latestSpec.version;
        return `<li class="file-item">
          <div class="grow">
            <div><strong>${esc(g.fileName)}</strong> <span class="ver">${esc(f.version || '')}</span> <span class="badge ok">最新版</span></div>
            ${meta(f)}
            ${f.description ? `<div class="muted">${esc(f.description)}</div>` : ''}
            ${mismatch ? `<div class="warn-note">最新の確定仕様は ${esc(latestSpec.version)} です。このファイルは ${esc(f.specVersion)} 対応のままです。</div>` : ''}
            ${g.activeCount > 1 ? `<div class="warn-note">「使用中」が${g.activeCount}つあります。使わない方を「旧版」にしてください。</div>` : ''}
            <div class="btns row"><button class="btn small" data-view="${esc(f.id)}">詳しく</button><button class="btn small primary" data-newver="${esc(f.id)}">新しいVersionを登録</button></div>
            ${g.others.length ? `<details><summary class="muted">ほかのVersion ${g.others.length}件</summary><ul class="list">${g.others.map(o => `<li><button class="row-btn grow" data-view="${esc(o.id)}"><span class="t-title">${esc(o.version || '')}</span>${meta(o)}</button></li>`).join('')}</ul></details>` : ''}
          </div></li>`; }).join('')}</ul>` : '<p class="muted">まだ登録されていません。</p>'}
    </section>`;
  el.querySelector('#add-file').onclick = () => fileForm(ctx, p, specs);
  el.querySelectorAll('[data-newver]').forEach(b => b.onclick = () => fileForm(ctx, p, specs, files.find(f => f.id === b.dataset.newver), 'newver'));
  el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewFile(ctx, p, specs, files.find(f => f.id === b.dataset.view)));
}

function specOptions(specs, sel) {
  const fixed = specs.filter(s => specStatus(s) === 'fixed');
  return `<option value="">未指定</option>${fixed.map(s => `<option${s.version === sel ? ' selected' : ''}>${esc(s.version)}</option>`).join('')}`;
}

// 登録・編集・新Version 共通フォーム
function fileForm(ctx, p, specs, f = null, mode = f ? 'edit' : 'new') {
  const m = ctx.master;
  const latestSpec = specs.find(s => specStatus(s) === 'fixed');
  const v = mode === 'newver' ? nextVersion(f.version && /^v\d+\.\d+$/.test(f.version) ? f.version : 'v1.0') : (f?.version || 'v1.0');
  const x = f || {};
  const md = openModal(`<h2>${mode === 'new' ? 'ファイルを登録' : mode === 'newver' ? `${esc(x.fileName)} の新しいVersion` : 'ファイル情報を編集'}</h2>
    <form id="ff2">
      ${mode === 'newver' ? `<p class="muted">今の ${esc(x.version)} は「旧版」として残ります。</p>` : ''}
      <div class="grid two">
        <label class="field"><span>ファイル名 <em class="req">必須</em></span><input type="text" name="fileName" maxlength="200" value="${esc(x.fileName || '')}" ${mode === 'newver' ? 'readonly' : ''} placeholder="例：index.html"></label>
        <label class="field"><span>Version</span><input type="text" name="version" maxlength="20" value="${esc(v)}"></label>
        <label class="field"><span>種類</span><select name="type">${m.fileTypes.map(t => `<option${t === x.type ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="field"><span>状態</span><select name="status">${options(m.fileStatuses, mode === 'newver' ? 'active' : (x.status || 'active'))}</select></label>
        <label class="field"><span>担当AI</span><select name="ai">${options(m.taskAssignees, x.ai || 'claude')}</select></label>
        <label class="field"><span>関連仕様Version</span><select name="specVersion">${specOptions(specs, mode === 'new' ? latestSpec?.version : mode === 'newver' ? (latestSpec?.version || x.specVersion) : x.specVersion)}</select></label>
      </div>
      <label class="field"><span>説明</span><input type="text" name="description" maxlength="300" value="${esc(x.description || '')}" placeholder="例：トップ画面"></label>
      <label class="field"><span>保存場所（GitHubのURLなど）</span><input type="text" name="location" maxlength="500" value="${esc(x.location || '')}"></label>
      <details${x.code ? ' open' : ''}><summary><strong>コードの中身を保存する（任意）</strong></summary>
        <div class="grid two" style="margin-top:8px">
          <label class="field"><span>言語</span><input type="text" name="language" maxlength="40" value="${esc(x.language || '')}" placeholder="例：JavaScript"></label>
          <label class="field"><span>関連ファイル</span><input type="text" name="relatedFile" maxlength="200" value="${esc(x.relatedFile || '')}" placeholder="例：style.css"></label>
        </div>
        <label class="field"><span>コード（30万文字まで）</span><textarea name="code" rows="8" class="mono">${esc(x.code || '')}</textarea></label>
        <p class="muted" id="code-size"></p>
      </details>
      <label class="field"><span>メモ</span><textarea name="memo" rows="2">${esc(x.memo || '')}</textarea></label>
      <div id="ff2-err"></div>
      <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">${mode === 'newver' ? '新しいVersionを登録' : '保存'}</button></div>
    </form>`);
  const form = md.el.querySelector('#ff2'), E = form.elements;
  const size = () => { const n = E.code.value.length; md.el.querySelector('#code-size').textContent = n ? `${n.toLocaleString()}文字${n > 300000 ? '（大きすぎます：保存場所だけ登録してください）' : ''}` : ''; };
  E.code.oninput = size; size();
  form.onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(['fileName', 'version', 'type', 'status', 'ai', 'specVersion', 'description', 'location', 'language', 'relatedFile', 'code', 'memo'].map(k => [k, E[k].value]));
    data.fileName = data.fileName.trim(); data.version = data.version.trim(); data.specVersion = data.specVersion || null;
    if (!data.code) data.code = '';
    try {
      if (mode === 'new') await ctx.db.create('files', { ...data, projectId: p.id }, { reason: 'ファイルを登録' });
      else if (mode === 'newver') await ctx.db.newFileVersion(f.id, data);
      else await ctx.db.update('files', f.id, data, { reason: 'ファイル情報を編集' });
      md.close(); toast(mode === 'newver' ? `${data.version} を最新版として登録しました` : '保存しました'); ctx.refresh();
    } catch (err) { md.el.querySelector('#ff2-err').innerHTML = errorHtml(err); md.el.querySelector('#ff2-err').scrollIntoView({ block: 'nearest' }); }
  };
}

function viewFile(ctx, p, specs, f) {
  const m = ctx.master;
  const md = openModal(`<h2>${esc(f.fileName)} ${esc(f.version || '')}</h2>
    <dl class="kv wide">
      <dt>種類</dt><dd>${esc(f.type || '—')}</dd><dt>状態</dt><dd>${esc(label(m, 'fileStatuses', f.status || 'active'))}</dd>
      <dt>担当AI</dt><dd>${esc(label(m, 'taskAssignees', f.ai || 'user'))}</dd><dt>関連仕様</dt><dd>${esc(f.specVersion || '未指定')}</dd>
      <dt>説明</dt><dd>${esc(f.description || '—')}</dd><dt>保存場所</dt><dd>${f.location ? (/^https?:\/\//.test(f.location) ? `<a href="${esc(f.location)}" target="_blank" rel="noopener">${esc(f.location)}</a>` : esc(f.location)) : '—'}</dd>
      <dt>言語</dt><dd>${esc(f.language || '—')}</dd><dt>関連ファイル</dt><dd>${esc(f.relatedFile || '—')}</dd>
      <dt>作成</dt><dd>${fmtDate(f.createdAt)}</dd><dt>更新</dt><dd>${fmtDate(f.updatedAt)}</dd>
      <dt>メモ</dt><dd class="prewrap">${esc(f.memo || '—')}</dd>
    </dl>
    ${f.code ? `<h3>コード</h3><pre class="md code">${esc(f.code)}</pre>` : ''}
    <div class="btns" style="margin-top:12px">
      ${f.code ? '<button class="btn" id="vf-copy">コードをコピー</button>' : ''}
      <button class="btn" id="vf-edit">編集</button>
      <button class="btn danger" id="vf-del">削除（ゴミ箱へ）</button>
      <button class="btn" data-close>閉じる</button>
    </div>`);
  md.el.querySelector('#vf-copy')?.addEventListener('click', () => safeCopy(ctx, f.code, { what: 'このコード' }));
  md.el.querySelector('#vf-edit').onclick = () => { md.close(); fileForm(ctx, p, specs, f, 'edit'); };
  md.el.querySelector('#vf-del').onclick = async () => {
    md.close();
    if (!await confirmDialog({ title: `${f.fileName} ${f.version || ''} を削除しますか？`, body: '<p>ゴミ箱へ移します。元に戻せます。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('files', f.id, { reason: 'ファイルを削除' }); toast('ゴミ箱へ移しました'); ctx.refresh();
  };
}
