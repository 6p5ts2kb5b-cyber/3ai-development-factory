// Phase 7：既存アプリ取込タブ
// 既存アプリはゼロから作り直さない。現在の状態を取り込み → 基準Versionとして記録 → 確定仕様と照合 → 必要な改良だけ要望箱へ → 次Versionで改良。
// Factoryは既存のコードを変更しない。URL・コードは利用者が登録したものだけを保存する（推測しない）。
import { esc, fmtDate, toast, errorHtml, options } from '../ui.js';
import { label } from '../master.js';
import { specItems, coverageSummary } from '../logic.js';

export const EXISTING_FIELDS = [
  ['appName', 'アプリ名', 'text'], ['webUrl', '現在のWeb URL', 'url'], ['githubUrl', 'GitHub URL（ある場合）', 'url'], ['currentVersion', '現在のVersion（分からなければ「不明」）', 'text'],
  ['publishState', '現在の公開状態', 'select'], ['implemented', '実装済み機能', 'area'], ['notImplemented', '未実装機能', 'area'], ['knownIssues', '既知の問題', 'area'],
  ['storage', '現在使っているデータ保存方式', 'area'], ['externalServices', '使っている外部サービス', 'area'], ['testStatus', '現在のテスト状況', 'area'], ['nextImprovements', '次に改良すること', 'area'],
];

// 取込項目の入力欄（新規作成フォームと既存アプリタブで共通）。name は ex_ を付けて form.elements の既存プロパティと衝突させない
export const existingFieldsHtml = (m, ex = {}) => EXISTING_FIELDS.map(([k, t, type]) => {
  const n = `ex_${k}`;
  if (type === 'area') return `<label class="field"><span>${esc(t)}</span><textarea name="${n}" rows="3">${esc(ex[k] || '')}</textarea></label>`;
  if (type === 'select') return `<label class="field"><span>${esc(t)}</span><select name="${n}"><option value="">未入力</option>${(m.publishStates || []).map(o => { const v = o.key ?? o; return `<option value="${esc(v)}"${v === ex[k] ? ' selected' : ''}>${esc(o.label ?? o)}</option>`; }).join('')}</select></label>`;
  return `<label class="field"><span>${esc(t)}</span><input type="${type === 'url' ? 'url' : 'text'}" name="${n}" maxlength="500" value="${esc(ex[k] || '')}"${type === 'url' ? ' inputmode="url" placeholder="https://"' : ''}></label>`;
}).join('');
export const readExistingFields = form => Object.fromEntries(EXISTING_FIELDS.map(([k]) => [k, form.elements[`ex_${k}`]?.value ?? '']));

export const originBadge = (p, m) => {
  if (p.origin === 'unknown') return '<span class="badge warn">既存アプリ未確認</span>';
  if (p.origin === 'existing') return p.existing?.importStatus === 'imported' ? '<span class="badge ok">既存アプリ取込済み</span>' : '<span class="badge warn">既存アプリあり／取込待ち</span>';
  return '';
};

export async function importTab({ ctx, el, p }) {
  const m = ctx.master, db = ctx.db;
  if (p.origin === 'unknown' || !p.origin) {
    el.innerHTML = `<section class="card">
      <h2>既存アプリの確認</h2>
      <p>このプロジェクトには、<strong>すでにClaude等で作ってWebで使っているアプリ</strong>がありますか？</p>
      <p class="muted">ある場合は「既存アプリ取込プロジェクト」として、今のアプリを捨てずに現在の状態から始めます（ゼロから作り直しません）。URLやコードは、あなたが登録したものだけを保存します。</p>
      <div class="btns"><button class="btn primary" id="org-existing">既存アプリあり（取込待ちにする）</button><button class="btn" id="org-new">既存アプリなし（新しく作る）</button></div>
    </section>`;
    el.querySelector('#org-existing').onclick = async () => { await db.setOrigin(p.id, 'existing'); toast('「既存アプリあり／取込待ち」にしました'); ctx.refresh(); };
    el.querySelector('#org-new').onclick = async () => { await db.setOrigin(p.id, 'new'); toast('「新しく作る」プロジェクトにしました'); location.hash = `#/p/${encodeURIComponent(p.id)}`; };
    return;
  }
  if (p.origin !== 'existing') { el.innerHTML = '<section class="card"><p class="muted">このプロジェクトは「新しく作る」プロジェクトです。</p></section>'; return; }
  const ex = p.existing || {};
  const [spec, files] = await Promise.all([db.latestFixedSpec(p.id), db.byIndex('files', 'projectId', p.id)]);
  const items = spec ? specItems(spec.body) : [];
  const cov = ex.coverage || {};
  const sum = coverageSummary(items, cov);
  const imported = ex.importStatus === 'imported';
  const heads = [...new Set(items.map(i => i.head))];
  el.innerHTML = `<section class="card">
      <div class="spec-head"><h2>既存アプリの取込</h2>${originBadge(p, m)}</div>
      <ol class="flow"><li class="${ex.webUrl || ex.githubUrl || files.length ? 'done' : ''}">現在の状態を登録</li><li class="${imported ? 'done' : ''}">基準Versionとして保存</li><li class="${sum.unjudged < items.length ? 'done' : ''}">確定仕様と照合</li><li>必要な改良だけ要望箱へ</li><li>次Versionとして改良</li></ol>
      <p class="muted">今のアプリのコードは捨てずに使います。Factoryは既存のコードを変更しません。分からない項目は空欄のままで大丈夫です（推測では登録しません）。</p>
      ${imported ? `<div class="notice slim">取込済み：${fmtDate(ex.importedAt)}・基準Version <strong>${esc(ex.baseline?.currentVersion || '')}</strong>${ex.baseline?.files?.length ? `・ファイル ${ex.baseline.files.length}件` : ''}</div>` : ''}
    </section>
    <section class="card">
      <h2>現在の状態</h2>
      <form id="exf" novalidate>${existingFieldsHtml(m, ex)}
        <p class="muted">現在のソースコード／ファイルは「ファイル」タブで登録します（登録済み ${files.length}件）。<a href="#/p/${esc(p.id)}/files">ファイルタブを開く</a></p>
        <div id="exf-err"></div>
        <div class="btns"><button class="btn primary">保存</button><button type="button" class="btn" id="ex-done">${imported ? '基準Versionを記録し直す' : '取込を完了（基準Versionとして記録）'}</button></div>
      </form>
    </section>
    <section class="card" id="cov-card">
      <h2>確定仕様 ${esc(spec?.version || '')} との照合</h2>
      ${!spec ? '<p class="muted">確定仕様がありません。仕様書タブで確定すると照合できます。</p>' : `
      <p class="muted">仕様の各項目が今のアプリでどうなっているかを選んでください。仕様と違っていても<strong>コードは変更しません</strong>。差分は改良候補として管理します。</p>
      <div class="sum-chips"><span class="chip add">実装済み ${sum.done}</span><span class="chip chg">一部 ${sum.partial}</span><span class="chip del">未実装 ${sum.todo}</span><span class="chip del">仕様と違う ${sum.diff}</span><span class="chip">未判定 ${sum.unjudged}</span></div>
      ${heads.map(h => `<h3>${esc(h)}</h3><ul class="list cov">${items.filter(i => i.head === h).map(i => { const c = cov[i.key] || {}; const pick = ['partial', 'todo', 'diff'].includes(c.status) && !c.requestId; return `<li>
        ${pick ? `<label class="pick"><input type="checkbox" data-cov-pick="${esc(i.key)}" aria-label="改良候補に選ぶ"></label>` : '<span class="pick"></span>'}
        <div class="grow"><span>${esc(i.text)}</span>${c.requestId ? '<div class="ok-note">要望箱へ送り済み</div>' : ''}</div>
        <select class="status-select cov-sel" data-cov="${esc(i.key)}">${options(m.coverageStatuses, c.status || 'unjudged')}</select></li>`; }).join('')}</ul>`).join('')}
      <div id="cov-bar" class="reflect-bar" hidden><span><b class="n">0</b>件を選択中</span><button class="btn primary">改良候補として要望箱へ</button></div>`}
    </section>`;
  const f = el.querySelector('#exf');
  const data = () => readExistingFields(f);
  f.onsubmit = async e => {
    e.preventDefault();
    try { await db.saveExisting(p.id, data()); toast('保存しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#exf-err').innerHTML = errorHtml(err); }
  };
  el.querySelector('#ex-done').onclick = async () => {
    try { await db.saveExisting(p.id, data()); await db.completeImport(p.id); toast('取込を完了し、現在の状態を基準Versionとして記録しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#exf-err').innerHTML = errorHtml(err); el.querySelector('#exf-err').scrollIntoView({ block: 'nearest' }); }
  };
  el.querySelectorAll('[data-cov]').forEach(s => s.onchange = async () => { await db.setCoverage(p.id, s.dataset.cov, s.value); toast(`「${label(m, 'coverageStatuses', s.value)}」にしました`); ctx.refresh(); });
  const bar = el.querySelector('#cov-bar');
  if (bar) {
    const picks = () => [...el.querySelectorAll('[data-cov-pick]:checked')].map(x => x.dataset.covPick);
    el.querySelectorAll('[data-cov-pick]').forEach(c => c.onchange = () => { const n = picks().length; bar.hidden = !n; bar.querySelector('.n').textContent = n; });
    bar.querySelector('button').onclick = async () => {
      try { const r = await db.coverageToRequests(p.id, picks()); toast(`${r.length}件を改良候補として要望箱へ入れました（仕様書・コードは変わっていません）`); ctx.refresh(); }
      catch (err) { el.querySelector('#cov-card').insertAdjacentHTML('afterbegin', errorHtml(err)); }
    };
  }
}
