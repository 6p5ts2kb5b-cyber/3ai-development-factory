// 要望箱：思いついたことをすぐ保存。確定仕様には直接入れない（採用されたものだけ後で仕様へ反映）
import { esc, fmtShort, toast, openModal, errorHtml, options } from '../ui.js';
import { label } from '../master.js';

const LAST = 'factory.lastProject';
const getLast = () => { try { return localStorage.getItem(LAST) || ''; } catch { return ''; } };
const setLast = id => { try { localStorage.setItem(LAST, id); } catch {} };

export const RULE_NOTE = '確定仕様には直接入りません。「採用」しても仕様書は変わらず、「仕様へ反映」を押したときだけ変更案が作られます。';

// ＋要望 のクイック追加（どの画面からでも）
export async function quickRequest(ctx, { projectId } = {}) {
  const projects = (await ctx.db.all('projects')).sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1);
  if (!projects.length) {
    const m = openModal(`<h2>要望を追加</h2><p>要望を入れるプロジェクトがまだありません。先に「話すだけで相談」からプロジェクトを作ってください。</p>
      <div class="btns"><button class="btn" data-close>閉じる</button><a class="btn primary" href="#/talk" data-close>話すだけで相談する</a></div>`);
    return m;
  }
  const pid = projectId || (projects.some(p => p.id === getLast()) ? getLast() : projects[0].id);
  const m = openModal(`<h2>要望を追加</h2>
    <form id="qr-form">
      <label class="field"><span>思いついたこと</span><textarea name="title" rows="3" placeholder="例：地図に「行った店」を色分けしたい" required></textarea></label>
      <label class="field"><span>プロジェクト</span><select name="projectId">${projects.map(p => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <details><summary class="muted">理由やメモを書く（任意）</summary><label class="field" style="margin-top:8px"><span>理由・メモ</span><textarea name="memo" rows="2"></textarea></label></details>
      <p class="muted">${esc(RULE_NOTE)}</p>
      <div id="qr-err"></div>
      <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">要望箱に入れる</button></div>
    </form>`);
  const f = m.el.querySelector('#qr-form');
  setTimeout(() => f.title.focus(), 50);
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      await ctx.db.create('requests', { projectId: f.projectId.value, title: f.title.value.trim(), memo: f.memo.value.trim(), status: 'unreviewed' }, { reason: '要望を追加' });
      setLast(f.projectId.value);
      m.close();
      toast('要望箱に入れました（仕様にはまだ反映していません）');
      ctx.refresh();
    } catch (err) { m.el.querySelector('#qr-err').innerHTML = errorHtml(err); }
  };
  return m;
}

// 要望の1行（状態をその場で変更できる）。selectable=true なら「採用・未反映」に選択チェックを出す
export function requestRows(rows, master, projectsById = null, { selectable = false } = {}) {
  if (!rows.length) return '<p class="muted">要望はまだありません。</p>';
  return `<ul class="list reqs">${rows.map(r => {
    const canPick = selectable && r.status === 'adopted' && !r.specState;
    const spec = r.specState === 'fixed' ? `<span class="badge ok">${esc(r.specVersion)} に反映済み</span>` : r.specState === 'candidate' ? `<span class="badge warn">${esc(r.specVersion)} 候補</span>` : '';
    return `<li>
    ${canPick ? `<label class="pick"><input type="checkbox" data-pick="${esc(r.id)}" aria-label="「${esc(r.title)}」を選ぶ"></label>` : ''}
    <div class="grow"><strong>${esc(r.title)}</strong> ${spec}
      <div class="muted">${projectsById ? `${esc(projectsById[r.projectId]?.name || '（削除されたプロジェクト）')}・` : ''}${fmtShort(r.createdAt)}${r.memo ? `・${esc(r.memo)}` : ''}</div>
      ${r.source ? `<div class="src">出典：${r.source.type === 'compare' ? `3AI比較「${esc(r.source.topic || '')}」` : r.source.type === 'url' ? 'URL要約' : ''}</div>` : ''}
      ${r.decidedAt ? `<div class="decision">判断：${esc(label(master, 'requestStatuses', r.status))}（${esc((r.decidedAt || '').slice(0, 10))}）${r.decisionReason ? `／理由：${esc(r.decisionReason)}` : ''}</div>` : ''}
    </div>
    <label class="sr-only" for="rs-${esc(r.id)}">状態</label>
    <select id="rs-${esc(r.id)}" class="status-select" data-req="${esc(r.id)}" data-prev="${esc(r.status || 'unreviewed')}">${options(master.requestStatuses, r.status || 'unreviewed')}</select>
  </li>`; }).join('')}</ul>`;
}

// 状態を変えたら「判断の理由」を聞いて、判断・理由・判断日を残す（要望は削除しない）
export function bindRequestRows(root, ctx) {
  root.querySelectorAll('[data-req]').forEach(sel => sel.onchange = () => {
    const to = sel.value, lab = label(ctx.master, 'requestStatuses', to);
    const needWhy = ['on_hold', 'rejected'].includes(to);
    let saved = false;
    const md = openModal(`<h2>「${esc(lab)}」にします</h2>
      <form id="dc">
        <label class="field"><span>判断の理由${needWhy ? '（あとで「なぜ」を確認できるよう、書いておくのがおすすめです）' : '（任意）'}</span>
          <textarea name="why" rows="3" maxlength="1000" placeholder="${to === 'rejected' ? '例：無料では実現できないため' : to === 'on_hold' ? '例：Phase 7のあとに再検討' : '例：利用者の希望が多い'}"></textarea></label>
        ${to === 'adopted' ? '<p class="muted">採用しても仕様書は変わりません。仕様に入れるときは、要望箱で選んで「仕様へ反映」を押します。</p>' : ''}
        <div id="dc-err"></div>
        <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">「${esc(lab)}」で記録</button></div>
      </form>`, { onClose: () => { if (!saved) sel.value = sel.dataset.prev; } });
    setTimeout(() => md.el.querySelector('textarea').focus(), 50);
    md.el.querySelector('#dc').onsubmit = async e => {
      e.preventDefault();
      try {
        await ctx.db.decideRequest(sel.dataset.req, to, { reason: e.target.elements.why.value });
        saved = true; md.close(); toast(`「${lab}」にしました`); ctx.refresh();
      } catch (err) { md.el.querySelector('#dc-err').innerHTML = errorHtml(err); }
    };
  });
}

// 採用済み要望を選んで仕様の変更案へまとめて反映
export function bindReflect(root, ctx, projectId, draftVersion) {
  const bar = root.querySelector('#reflect-bar');
  if (!bar) return;
  const picks = () => [...root.querySelectorAll('[data-pick]:checked')].map(x => x.dataset.pick);
  const upd = () => { const n = picks().length; bar.hidden = !n; bar.querySelector('.n').textContent = n; };
  root.querySelectorAll('[data-pick]').forEach(c => c.onchange = upd);
  bar.querySelector('button').onclick = async () => {
    const ids = picks();
    try {
      const { draft, added } = await ctx.db.reflectRequests(projectId, ids);
      toast(`${added}件を変更案 ${draft.version} に反映しました（まだ確定していません）`);
      location.hash = `#/p/${encodeURIComponent(projectId)}/spec`;
    } catch (e) { root.insertAdjacentHTML('afterbegin', errorHtml(e)); window.scrollTo(0, 0); }
  };
  upd();
}

// 全プロジェクトの要望箱
export async function requestsView(ctx, view, params) {
  const filter = params.get('s') || 'open';
  const [reqs, projects] = await Promise.all([ctx.db.all('requests'), ctx.db.all('projects')]);
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  const openKeys = ctx.master.requestStatuses.filter(s => s.open).map(s => s.key);
  const rows = reqs.filter(r => filter === 'all' ? true : filter === 'open' ? openKeys.includes(r.status || 'unreviewed') : (r.status || 'unreviewed') === filter)
    .sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  const chips = [['open', '対応待ち'], ...ctx.master.requestStatuses.map(s => [s.key, s.label]), ['all', 'すべて']];
  view.innerHTML = `<div class="page-head"><h1>要望箱</h1><button class="btn small primary" id="add-req">＋ 要望を追加</button></div>
    <p class="muted">${esc(RULE_NOTE)}</p>
    <nav class="chips" aria-label="状態で絞込み">${chips.map(([k, l]) => `<a class="chip" href="#/requests?s=${k}"${k === filter ? ' aria-current="true"' : ''}>${esc(l)}</a>`).join('')}</nav>
    <section class="card">${requestRows(rows, ctx.master, byId)}</section>`;
  view.querySelector('#add-req').onclick = () => quickRequest(ctx);
  bindRequestRows(view, ctx);
}
