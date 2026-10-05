// Phase 4：仕様書タブ（Version管理・確定保護・差分確認・確定・Markdown出力・Factory移行用指示書）
import { esc, fmtDate, fmtShort, toast, errorHtml, openModal, copyText, downloadText, safeFileName, options } from '../ui.js';
import { label } from '../master.js';
import { specStatus } from '../db.js';
import { nextVersion } from '../logic.js';
import { diffLines, diffSummary, summaryText } from '../diff.js';
import { specToMarkdown, buildGuide, GUIDE_SECTIONS, GUIDE_EDITABLE } from '../guide.js';
import { safeCopy } from './safecopy.js';

const base = (p, q = '') => `#/p/${encodeURIComponent(p.id)}/spec${q}`;

export async function specTab({ ctx, el, p, params }) {
  const db = ctx.db, m = ctx.master;
  const specs = await db.specsOf(p.id);
  const mode = params.get('mode') || '';
  const pick = params.get('v');
  if (mode === 'guide') return guideView(ctx, el, p);
  const draft = specs.find(s => specStatus(s) === 'draft');
  const fixedList = specs.filter(s => specStatus(s) === 'fixed');
  const latest = fixedList[0] || null;
  const viewing = (pick && specs.find(s => s.id === pick)) || latest || draft || null;
  if (mode === 'diff' && viewing) return diffView(ctx, el, p, viewing, specs);
  if (mode === 'edit' && viewing && specStatus(viewing) === 'draft') return editDraft(ctx, el, p, viewing);

  if (!specs.length) {
    el.innerHTML = `<section class="card empty">
      <h2>仕様書はまだありません</h2>
      <p>まず <strong>v1.0 の変更案</strong>（下書き）を作り、内容を書いてから「確定」します。確定した仕様は、その後勝手に書き換わりません。</p>
      <button class="btn primary" id="new-spec">仕様書を作る（v1.0）</button>
      <p class="muted" style="margin-top:10px">見出し（目的・画面構成・機能・保存データ など）入りのひな形から始まります。</p>
    </section>${guideLink(p)}`;
    el.querySelector('#new-spec').onclick = async () => {
      try { const d = await db.createSpecDraft(p.id); toast('v1.0 の変更案を作りました'); location.hash = base(p, `?mode=edit&v=${d.id}`); }
      catch (e) { el.insertAdjacentHTML('afterbegin', errorHtml(e)); }
    };
    return;
  }

  const reqsInDraft = draft ? (await Promise.all((draft.requestIds || []).map(id => db.get('requests', id)))).filter(Boolean) : [];
  const adoptedWaiting = (await db.byIndex('requests', 'projectId', p.id)).filter(r => r.status === 'adopted' && !r.specState);
  el.innerHTML = `
    ${draft ? `<section class="card draft-card">
      <div class="spec-head"><h2>変更案 ${esc(draft.version)} <span class="badge warn">未確定</span></h2></div>
      <p class="muted">${draft.baseVersion ? `${esc(draft.baseVersion)} をもとに作成` : '初版'}・${fmtShort(draft.updatedAt)} 更新${draft.reason ? `・理由：${esc(draft.reason)}` : ''}</p>
      ${reqsInDraft.length ? `<p><strong>この変更案に入っている要望（${reqsInDraft.length}件）</strong></p><ul class="list">${reqsInDraft.map(r => `<li><span class="grow">${esc(r.title)}</span><button class="btn small" data-unlink="${esc(r.id)}">外す</button></li>`).join('')}</ul>` : ''}
      ${adoptedWaiting.length ? `<p class="muted">採用済みでまだ反映していない要望が ${adoptedWaiting.length}件あります。<a href="#/p/${esc(p.id)}/requests">要望箱で選んで反映</a></p>` : ''}
      <div class="btns">
        <a class="btn" href="${base(p, `?mode=edit&v=${draft.id}`)}">変更案を編集</a>
        <a class="btn" href="${base(p, `?mode=diff&v=${draft.id}`)}">差分を確認</a>
        <button class="btn primary" id="fix-draft">${esc(draft.version)} として確定</button>
        <button class="btn danger" id="discard-draft">変更案を破棄</button>
      </div>
    </section>` : ''}

    ${viewing ? viewingCard(viewing, latest, draft, m) : ''}

    <section class="card">
      <h2>Version一覧 <span class="muted">${specs.length}件</span></h2>
      <p class="muted">過去のVersionは消えません。タップすると内容を確認できます。</p>
      <ul class="list versions">${specs.map(s => `<li${viewing && s.id === viewing.id ? ' class="current"' : ''}>
        <a class="grow" href="${base(p, `?v=${s.id}`)}"><strong>${esc(s.version)}</strong> ${esc(s.title || '')}
          <span class="muted">${specStatus(s) === 'fixed' ? `${fmtShort(s.fixedAt)} 確定` : '未確定'}${s.reason ? `・${esc(s.reason)}` : ''}</span></a>
        <span class="badge ${specStatus(s) === 'fixed' ? 'ok' : 'warn'}">${esc(label(m, 'specStatuses', specStatus(s)))}</span></li>`).join('')}</ul>
    </section>
    ${guideLink(p)}`;

  // 確定版の操作
  const vc = el.querySelector('.viewing');
  if (vc && viewing) {
    vc.querySelector('[data-act=copy]').onclick = () => safeCopy(ctx, specToMarkdown(p, viewing, m), { what: '仕様書' });
    vc.querySelector('[data-act=md]').onclick = () => { downloadText(`${safeFileName(p.name)}_spec_${viewing.version}.md`, specToMarkdown(p, viewing, m)); toast('Markdownファイルを保存しました'); };
    vc.querySelector('[data-act=edit]')?.addEventListener('click', () => fixedWarning(ctx, p, viewing, draft, 'edit'));
    vc.querySelector('[data-act=delete]')?.addEventListener('click', () => fixedWarning(ctx, p, viewing, draft, 'delete'));
    vc.querySelector('[data-act=newdraft]')?.addEventListener('click', () => makeDraftFrom(ctx, p, viewing));
  }
  if (draft) {
    el.querySelector('#fix-draft').onclick = () => fixDialog(ctx, p, draft, specs);
    el.querySelector('#discard-draft').onclick = async () => {
      const md = openModal(`<h2>変更案 ${esc(draft.version)} を破棄しますか？</h2>
        <p>確定済みのVersionには影響しません。変更案はゴミ箱へ移り、元に戻せます。入っていた要望は「採用」のまま残ります。</p>
        <div class="btns"><button class="btn" data-close>やめる</button><button class="btn danger" id="do-discard">破棄する</button></div>`);
      md.el.querySelector('#do-discard').onclick = async () => {
        try { await db.discardDraft(draft.id); md.close(); toast('変更案を破棄しました'); location.hash = base(p); }
        catch (e) { md.el.insertAdjacentHTML('beforeend', errorHtml(e)); }
      };
    };
    el.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { await db.removeRequestFromDraft(draft.id, b.dataset.unlink); toast('変更案から外しました（本文は必要に応じて編集してください）'); ctx.refresh(); });
  }
}

const guideLink = p => `<section class="card"><h2>Factory移行用指示書</h2><p class="muted">このプロジェクトの目的・確定仕様・作業・課題などを17項目にまとめ、ChatGPT・Claude・Geminiへそのまま渡せる形で出力します。</p>
  <a class="btn" href="${base(p, '?mode=guide')}">移行用指示書を開く</a></section>`;

function viewingCard(s, latest, draft, m) {
  const fixed = specStatus(s) === 'fixed';
  const isLatest = latest && s.id === latest.id;
  return `<section class="card viewing">
    <div class="spec-head"><h2>${fixed ? (isLatest ? '最新の確定仕様' : '過去の確定仕様') : '変更案（未確定）'} ${esc(s.version)}</h2>
      <span class="badge ${fixed ? 'ok' : 'warn'}">${fixed ? '🔒 確定' : '未確定'}</span></div>
    <dl class="kv wide">
      <dt>タイトル</dt><dd>${esc(s.title || '—')}</dd>
      <dt>状態</dt><dd>${esc(label(m, 'specStatuses', specStatus(s)))}</dd>
      <dt>変更元</dt><dd>${esc(s.baseVersion || 'なし（初版）')}</dd>
      <dt>変更理由</dt><dd>${esc(s.reason || '—')}</dd>
      <dt>作成</dt><dd>${fmtDate(s.createdAt)}</dd>
      <dt>更新</dt><dd>${fmtDate(s.updatedAt)}</dd>
      <dt>確定</dt><dd>${s.fixedAt ? `${fmtDate(s.fixedAt)}（${esc(s.fixedBy || '')}）` : '—'}</dd>
      ${s.diffSummary ? `<dt>変更量</dt><dd>${esc(summaryText(s.diffSummary))}</dd>` : ''}
    </dl>
    <div class="spec-body prewrap">${esc(s.body || '')}</div>
    <div class="btns" style="margin-top:12px">
      <button class="btn" data-act="copy">コピー</button>
      <button class="btn" data-act="md">Markdownで保存</button>
      ${s.baseSpecId || fixed ? `<a class="btn" href="#/p/${esc(s.projectId)}/spec?mode=diff&v=${esc(s.id)}">${s.baseVersion ? `${esc(s.baseVersion)} との差分` : '初版の内容'}</a>` : ''}
      ${fixed ? (draft ? `<a class="btn primary" href="#/p/${esc(s.projectId)}/spec?mode=edit&v=${esc(draft.id)}">変更案 ${esc(draft.version)} を開く</a>` : `<button class="btn primary" data-act="newdraft">この仕様をもとに変更案を作る</button>`) : ''}
      ${fixed ? `<button class="btn" data-act="edit">このVersionを編集</button><button class="btn danger" data-act="delete">このVersionを削除</button>` : ''}
    </div>
  </section>`;
}

// 確定Versionを編集・削除しようとしたときの明確な警告
function fixedWarning(ctx, p, s, draft, kind) {
  const md = openModal(`<h2>⚠️ ${esc(s.version)} は確定済みです</h2>
    <div class="notice ng"><strong>確定したVersionは${kind === 'edit' ? '直接編集' : '削除'}できません。</strong></div>
    <p>${kind === 'edit' ? `直接書き換えると、${esc(s.version)} で確定した内容が失われてしまうためです。` : '確定した仕様は、あとで経緯を確認できるよう履歴として必ず残します。'}</p>
    <p>内容を変えたいときは、<strong>新しいVersionの変更案</strong>を作り、差分を確認してから確定します。${esc(s.version)} はそのまま残ります。</p>
    <div class="btns"><button class="btn" data-close>閉じる</button>
      ${draft ? `<a class="btn primary" href="#/p/${esc(p.id)}/spec?mode=edit&v=${esc(draft.id)}" data-close>変更案 ${esc(draft.version)} を開く</a>` : `<button class="btn primary" id="w-new">変更案（${esc(nextVersion(s.version))}）を作る</button>`}</div>`);
  md.el.querySelector('#w-new')?.addEventListener('click', () => { md.close(); makeDraftFrom(ctx, p, s); });
}

function makeDraftFrom(ctx, p, s) {
  const latestNext = nextVersion(s.version);
  const md = openModal(`<h2>${esc(s.version)} をもとに変更案を作る</h2>
    <form id="nd">
      <p class="muted">${esc(s.version)} の内容をコピーした変更案を作ります。${esc(s.version)} 自体は変わりません。</p>
      <fieldset class="field"><legend>新しいVersion</legend><div class="checks">
        <label class="check"><input type="radio" name="kind" value="minor" checked><span>${esc(latestNext)}（小さな変更）</span></label>
        <label class="check"><input type="radio" name="kind" value="major"><span>${esc(nextVersion(s.version, true))}（大きな変更）</span></label>
      </div></fieldset>
      <label class="field"><span>変更理由（あとで確定時にも書けます）</span><input type="text" name="reason" maxlength="1000"></label>
      <div id="nd-err"></div>
      <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">変更案を作る</button></div>
    </form>`);
  const f = md.el.querySelector('#nd');
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const latest = await ctx.db.latestFixedSpec(p.id);
      const v = f.elements.kind.value === 'major' ? nextVersion(latest.version, true) : nextVersion(latest.version);
      const d = await ctx.db.createSpecDraft(p.id, { baseSpecId: s.id, version: v, reason: f.elements.reason.value.trim() });
      md.close(); toast(`変更案 ${d.version} を作りました`); location.hash = base(p, `?mode=edit&v=${d.id}`);
    } catch (err) { md.el.querySelector('#nd-err').innerHTML = errorHtml(err); }
  };
}

// 変更案の編集（変更案だけ編集できる）
function editDraft(ctx, el, p, d) {
  el.innerHTML = `<a class="back" href="${base(p)}">← 仕様書へ</a>
    <section class="card">
      <h2>変更案 ${esc(d.version)} を編集 <span class="badge warn">未確定</span></h2>
      <p class="muted">${d.baseVersion ? `もとにした ${esc(d.baseVersion)} は変わりません。` : '初版の下書きです。'}保存しても確定はされません。</p>
      <form id="ed">
        <div class="grid two">
          <label class="field"><span>Version</span><input type="text" name="version" value="${esc(d.version)}" maxlength="12"></label>
          <label class="field"><span>タイトル</span><input type="text" name="title" value="${esc(d.title || '')}" maxlength="200"></label>
        </div>
        <label class="field"><span>変更理由</span><input type="text" name="reason" value="${esc(d.reason || '')}" maxlength="1000" placeholder="例：要望3件を反映"></label>
        <label class="field"><span>本文（Markdown）</span><textarea name="body" rows="18" class="mono">${esc(d.body || '')}</textarea></label>
        <div id="ed-err"></div>
        <div class="btns"><a class="btn" href="${base(p)}">やめる</a><button class="btn primary">変更案を保存</button>
          <button type="button" class="btn" id="ed-diff">保存して差分を確認</button></div>
      </form>
    </section>`;
  const f = el.querySelector('#ed'), E = f.elements;
  const save = async () => ctx.db.update('specs', d.id, { version: E.version.value.trim(), title: E.title.value.trim(), reason: E.reason.value.trim(), body: E.body.value }, { reason: `変更案 ${d.version} を編集` });
  f.onsubmit = async e => {
    e.preventDefault();
    try { await save(); toast('変更案を保存しました（まだ確定していません）'); location.hash = base(p); }
    catch (err) { el.querySelector('#ed-err').innerHTML = errorHtml(err); }
  };
  el.querySelector('#ed-diff').onclick = async () => {
    try { await save(); location.hash = base(p, `?mode=diff&v=${d.id}`); }
    catch (err) { el.querySelector('#ed-err').innerHTML = errorHtml(err); }
  };
}

// 差分表示：追加・削除・変更を色と記号で。PCは「変更前｜変更後」を左右に、スマホは上下に並べる
export function diffHtml(rows, { onlyChanges = true } = {}) {
  const shown = onlyChanges ? withContext(rows) : rows;
  if (!rows.some(r => r.type !== 'same')) return '<p class="muted">変更はありません。</p>';
  const cell = (t, side) => t == null ? '<div class="d-cell empty"></div>' : `<div class="d-cell ${side}"><span class="d-tx">${esc(t) || '&nbsp;'}</span></div>`;
  const tag = { add: '＋追加', del: '－削除', change: '△変更', same: '' };
  return `<div class="diff">
    <div class="d-row d-head"><div>変更前</div><div>変更後</div></div>
    ${shown.map(r => r.gap ? `<div class="d-gap">… 変更のない ${r.gap} 行 …</div>` : `<div class="d-row d-${r.type}">
      ${r.type !== 'same' ? `<div class="d-tag">${tag[r.type]}</div>` : ''}
      ${cell(r.before, 'before')}${cell(r.after, 'after')}
    </div>`).join('')}
  </div>`;
}
function withContext(rows, n = 1) {
  const keep = rows.map((r, i) => r.type !== 'same' || rows.slice(Math.max(0, i - n), i + n + 1).some(x => x.type !== 'same'));
  const out = []; let gap = 0;
  rows.forEach((r, i) => { if (keep[i]) { if (gap) out.push({ gap }); gap = 0; out.push(r); } else gap++; });
  if (gap) out.push({ gap });
  return out;
}

async function diffView(ctx, el, p, s, specs) {
  const b = s.baseSpecId ? specs.find(x => x.id === s.baseSpecId) || await ctx.db.get('specs', s.baseSpecId) : null;
  const rows = diffLines(b?.body || '', s.body || '');
  const sum = diffSummary(rows);
  const titleChanged = b && (b.title || '') !== (s.title || '');
  el.innerHTML = `<a class="back" href="${base(p, `?v=${s.id}`)}">← 仕様書へ</a>
    <section class="card">
      <h2>差分の確認：${esc(b?.version || '（なし）')} → ${esc(s.version)}</h2>
      <div class="sum-chips"><span class="chip add">＋追加 ${sum.added}行</span><span class="chip del">－削除 ${sum.removed}行</span><span class="chip chg">△変更 ${sum.changed}行</span></div>
      ${titleChanged ? `<p>タイトル：<s>${esc(b.title)}</s> → <strong>${esc(s.title)}</strong></p>` : ''}
      <p class="muted">緑＝追加、赤＝削除、黄＝変更です。「変更前」と「変更後」を並べて表示しています。</p>
      <label class="check"><input type="checkbox" id="only" checked><span>変更のあった所だけ表示</span></label>
      <div id="diffbox" style="margin-top:10px">${diffHtml(rows)}</div>
      ${specStatus(s) === 'draft' ? `<div class="btns" style="margin-top:12px"><a class="btn" href="${base(p, `?mode=edit&v=${s.id}`)}">変更案を直す</a><button class="btn primary" id="go-fix">この内容で ${esc(s.version)} を確定</button></div>` : ''}
    </section>`;
  el.querySelector('#only').onchange = e => { el.querySelector('#diffbox').innerHTML = diffHtml(rows, { onlyChanges: e.target.checked }); };
  el.querySelector('#go-fix')?.addEventListener('click', () => fixDialog(ctx, p, s, specs));
}

// 確定の最終確認（差分の要約・理由・チェック）
function fixDialog(ctx, p, d, specs) {
  const b = d.baseSpecId ? specs.find(x => x.id === d.baseSpecId) : null;
  const sum = diffSummary(diffLines(b?.body || '', d.body || ''));
  const md = openModal(`<h2>${esc(d.version)} として確定しますか？</h2>
    <div class="sum-chips"><span class="chip add">＋追加 ${sum.added}行</span><span class="chip del">－削除 ${sum.removed}行</span><span class="chip chg">△変更 ${sum.changed}行</span></div>
    <p>${b ? `${esc(b.version)} からの変更です。` : '初版です。'}<a href="${base(p, `?mode=diff&v=${d.id}`)}" data-close>差分を見る</a></p>
    <div class="notice warn">確定すると、${esc(d.version)} は<strong>変更・削除できなくなります</strong>。今後の変更は新しいVersionで行います。${b ? `${esc(b.version)} も履歴として残ります。` : ''}</div>
    <form id="fx">
      <label class="field"><span>変更理由${b ? ' <em class="req">必須</em>' : ''}</span><textarea name="reason" rows="2" maxlength="1000">${esc(d.reason || (b ? '' : '初版'))}</textarea></label>
      <label class="check big-check"><input type="checkbox" id="fx-ok"><span>差分を確認しました</span></label>
      <div id="fx-err"></div>
      <div class="btns" style="margin-top:12px"><button type="button" class="btn" data-close>やめる</button><button class="btn primary" id="fx-btn" disabled>${esc(d.version)} を確定する</button></div>
    </form>`);
  const ok = md.el.querySelector('#fx-ok'), btn = md.el.querySelector('#fx-btn');
  ok.onchange = () => { btn.disabled = !ok.checked; };
  md.el.querySelector('#fx').onsubmit = async e => {
    e.preventDefault();
    try {
      await ctx.db.fixSpec(d.id, { reason: e.target.elements.reason.value });
      md.close(); toast(`${d.version} を確定しました（変更履歴に記録しました）`); location.hash = base(p);
    } catch (err) { md.el.querySelector('#fx-err').innerHTML = errorHtml(err); }
  };
}

// Factory移行用指示書
async function guideView(ctx, el, p) {
  const db = ctx.db, m = ctx.master;
  const [spec, issues, tasks, requests, files, tests, hist, saved] = await Promise.all([
    db.latestFixedSpec(p.id), db.byIndex('issues', 'projectId', p.id), db.byIndex('tasks', 'projectId', p.id), db.byIndex('requests', 'projectId', p.id),
    db.byIndex('files', 'projectId', p.id), db.byIndex('tests', 'projectId', p.id), db.historyOfProject(p.id), db.byIndex('guides', 'projectId', p.id),
  ]);
  const fixes = hist.filter(h => h.action === 'fix').sort((a, b) => a.at < b.at ? -1 : 1);
  const md = buildGuide(p, { spec, issues, tasks, requests, files, tests, fixes, generatedAt: new Date().toISOString() }, m);
  const g = p.guide || {};
  const titles = Object.fromEntries(GUIDE_SECTIONS.map(([k, t], i) => [k, `${i + 1}. ${t}`]));
  el.innerHTML = `<a class="back" href="${base(p)}">← 仕様書へ</a>
    <section class="card">
      <h2>Factory移行用指示書</h2>
      <p class="muted">目的・確定仕様（${esc(spec?.version || 'なし')}）・作業・未解決事項・要望・変更履歴から自動で作ります。足りない項目は下の「指示書の追記」に書いてください。</p>
      <div class="btns">
        <button class="btn primary" id="g-copy">コピー（AIに貼り付け）</button>
        <button class="btn" id="g-md">Markdownで保存</button>
        <button class="btn" id="g-save">この内容を版として残す</button>
      </div>
      <details style="margin-top:12px" open><summary><strong>プレビュー</strong></summary><pre class="md">${esc(md)}</pre></details>
    </section>
    <section class="card">
      <h2>指示書の追記</h2>
      <p class="muted">仕様書に書いていない内容を補います（変更履歴に残ります）。</p>
      <form id="gf">${GUIDE_EDITABLE.map(k => `<label class="field"><span>${esc(titles[k])}</span><textarea name="${k}" rows="2">${esc(g[k] || '')}</textarea></label>`).join('')}
        <div id="gf-err"></div><button class="btn primary">追記を保存</button></form>
    </section>
    <section class="card">
      <h2>保存した版 <span class="muted">${saved.length}件</span></h2>
      ${saved.length ? `<ul class="list">${saved.sort((a, b) => b.gversion - a.gversion).map(s => `<li><span class="grow"><strong>${esc(s.title)}</strong><span class="muted"> ${fmtShort(s.createdAt)}・仕様 ${esc(s.specVersion || 'なし')}</span></span>
        <button class="btn small" data-gcopy="${esc(s.id)}">コピー</button><button class="btn small" data-gmd="${esc(s.id)}">保存</button></li>`).join('')}</ul>` : '<p class="muted">まだありません。</p>'}
    </section>`;
  el.querySelector('#g-copy').onclick = () => safeCopy(ctx, md, { what: '移行用指示書' });
  el.querySelector('#g-md').onclick = () => { downloadText(`${safeFileName(p.name)}_factory_guide.md`, md); toast('Markdownファイルを保存しました'); };
  el.querySelector('#g-save').onclick = async () => { const s = await db.saveGuide(p.id, md, { specVersion: spec?.version || null }); toast(`${s.title}を保存しました`); ctx.refresh(); };
  el.querySelector('#gf').onsubmit = async e => {
    e.preventDefault();
    const guide = Object.fromEntries(GUIDE_EDITABLE.map(k => [k, e.target.elements[k].value.trim()]));
    try { await db.update('projects', p.id, { guide }, { reason: '移行用指示書の追記を更新' }); toast('保存しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#gf-err').innerHTML = errorHtml(err); }
  };
  el.querySelectorAll('[data-gcopy]').forEach(b => b.onclick = () => safeCopy(ctx, saved.find(s => s.id === b.dataset.gcopy).markdown, { what: '移行用指示書' }));
  el.querySelectorAll('[data-gmd]').forEach(b => b.onclick = () => { const s = saved.find(x => x.id === b.dataset.gmd); downloadText(`${safeFileName(p.name)}_factory_guide_v${s.gversion}.md`, s.markdown); });
}
