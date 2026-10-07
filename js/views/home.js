// ホーム：毎日使う画面。「今どこまで進んでいて、次に何をするか」が一目で分かるカード一覧
import { esc, fmtShort, toast, openModal, options } from '../ui.js';
import { summarizeProjects, filterProjects } from '../logic.js';
import { label } from '../master.js';
import { quickRequest } from './requests.js';
import { createProject, openProjectForm } from './projectForm.js';
import { originBadge } from './importer.js';
import { seedBannerHtml, bindSeed } from '../seed.js';

// 絞り込み条件（URLの ?q=&g=&st=&pr=&up=&sort= に保存するので、戻る操作でも条件が残る）
const FKEYS = { q: 'q', group: 'g', status: 'st', progress: 'pr', updated: 'up', sort: 'sort' };
const readFilter = params => Object.fromEntries(Object.entries(FKEYS).map(([k, u]) => [k, params.get(u) || '']));
const toHash = f => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v) u.set(FKEYS[k], v); const s = u.toString(); return '#/' + (s ? '?' + s : ''); };
const SORTS = [{ key: 'updated', label: '最終更新順' }, { key: 'progress', label: '完成度順' }, { key: 'status', label: 'ステータス順' }, { key: 'name', label: '名前順' }];

export async function homeView(ctx, view, params) {
  const db = ctx.db, m = ctx.master;
  const [projects, issues, requests, tests, specs, tasks, files, checks, handoffs] = await Promise.all(['projects', 'issues', 'requests', 'tests', 'specs', 'tasks', 'files', 'checks', 'handoff'].map(s => db.all(s)));
  const f = readFilter(params);
  const all = summarizeProjects(projects, { issues, requests, tests, specs, tasks, files, checks, handoffs: handoffs.filter(x => x.projectId) }, m);
  const cards = filterProjects(all, f, m);
  const groupCount = g => all.filter(c => g.statuses.includes(c.project.status)).length;
  const detailOn = [f.status && label(m, 'statuses', f.status), f.progress && label(m, 'progressRanges', f.progress), f.updated && label(m, 'updatedRanges', f.updated), f.sort && f.sort !== 'updated' && label({ s: SORTS }, 's', f.sort)].filter(Boolean);
  const filtered = f.q || f.group || detailOn.length;
  const lastTest = (await db.get('settings', 'lastTestRun'))?.value;
  const lastBackup = (await db.get('settings', 'lastBackup'))?.value;
  const backupDays = lastBackup ? Math.floor((Date.now() - new Date(lastBackup.at)) / 86400000) : null;

  view.innerHTML = `
    <section class="hero">
      <a class="btn primary big" href="#/talk"><span aria-hidden="true">💬</span> 話すだけで相談</a>
      <button class="btn big" id="home-add-req"><span aria-hidden="true">＋</span> 要望を追加</button>
    </section>
    <div data-sync-notice="home" class="sn-slot"></div>
    ${backupDays === null || backupDays >= 7 ? `<a class="notice warn slim" href="#/backup">${backupDays === null ? 'まだバックアップがありません' : `最後のバックアップから${backupDays}日`} → 保存する</a>` : ''}
    ${seedBannerHtml(projects)}
    <div class="page-head">
      <h1>プロジェクト <span class="muted count">${filtered ? `${cards.length} / ` : ''}${projects.length}</span></h1>
      <button class="btn small" id="new-project">＋ 新規</button>
    </div>
    ${projects.length ? `
    <form id="home-search" role="search" class="searchbar">
      <input type="search" name="q" value="${esc(f.q)}" placeholder="検索（名前・目的・メモ）" aria-label="プロジェクトを検索" enterkeyhint="search">
      <button class="btn small" type="button" id="open-filter" aria-haspopup="dialog">絞り込み${detailOn.length ? `<small class="dot">${detailOn.length}</small>` : ''}</button>
    </form>
    <nav class="chips scroll" aria-label="よく使う絞り込み">
      <a class="chip" href="${toHash({ ...f, group: '' })}"${!f.group ? ' aria-current="true"' : ''}>すべて <small>${all.length}</small></a>
      ${(m.projectGroups || []).map(g => `<a class="chip" href="${toHash({ ...f, group: g.key })}"${f.group === g.key ? ' aria-current="true"' : ''}>${esc(g.label)} <small>${groupCount(g)}</small></a>`).join('')}
    </nav>
    ${detailOn.length || f.q ? `<p class="filter-note muted">${f.q ? `「${esc(f.q)}」 ` : ''}${detailOn.map(esc).join('・')} <a href="${toHash({})}">条件を解除</a></p>` : ''}` : ''}
    ${projects.length ? (cards.length ? `<div class="cards">${cards.map(c => cardHtml(c, m)).join('')}</div>` : `<section class="card"><p class="muted">条件に一致するプロジェクトはありません。</p><a class="btn" href="${toHash({})}">条件を解除</a></section>`) : emptyHtml()}
    <a class="sys-strip v1-strip" href="#/v1"><span><strong>v1完成まで</strong>：あと何が必要かを見る</span><span>→</span></a>
    <a class="sys-strip" href="#/system">
      <span>自動テスト：${!lastTest ? '未実行' : lastTest.failed ? `❌ 不合格 ${lastTest.failed}件` : `✅ ${lastTest.total}項目合格`}</span>
      <span>保存：この端末</span>
    </a>`;

  view.querySelector('#home-add-req').onclick = () => quickRequest(ctx);
  bindSeed(view, ctx);
  view.querySelector('#new-project').onclick = () => openProjectForm(ctx);
  view.querySelectorAll('[data-add-req]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); quickRequest(ctx, { projectId: b.dataset.addReq }); });
  const sf = view.querySelector('#home-search');
  if (sf) {
    sf.onsubmit = e => { e.preventDefault(); location.hash = toHash({ ...f, q: sf.elements.q.value.trim() }); };
    sf.elements.q.addEventListener('search', () => { if (!sf.elements.q.value && f.q) location.hash = toHash({ ...f, q: '' }); }); // ×で消したとき
    view.querySelector('#open-filter').onclick = () => openFilter(ctx, f);
  }
  const seed = view.querySelector('#seed-factory');
  if (seed) seed.onclick = async () => {
    const p = await createProject(db, { name: '3AI Development Factory', status: 'implementing', deliverableType: 'webapp', purpose: 'やりたいことを話すだけで、3AIを活用しながらアプリを設計・実装・テスト・改良し、その経緯を失わず管理する', targetUsers: '自分（プログラミング初心者）', targetDevices: ['iphone', 'pc', 'schoolpc'] }, { firstTask: '実機（iPhone・PC・学校PC）で自動テストを確認する', reason: 'Factory自身をプロジェクトとして登録' });
    toast('Factory自身を登録しました');
    location.hash = `#/p/${p.id}`;
  };
}

// 詳しい絞り込み（スマホでは下から出るシート）
function openFilter(ctx, f) {
  const m = ctx.master;
  const md = openModal(`<h2>絞り込み・並べ替え</h2><form id="ff">
    <label class="field"><span>ステータス</span><select name="status"><option value="">すべて</option>${options(m.statuses, f.status)}</select></label>
    <label class="field"><span>完成度</span><select name="progress"><option value="">すべて</option>${options(m.progressRanges, f.progress)}</select></label>
    <label class="field"><span>最終更新</span><select name="updated"><option value="">すべて</option>${options(m.updatedRanges, f.updated)}</select></label>
    <label class="field"><span>並べ替え</span><select name="sort">${options(SORTS, f.sort || 'updated')}</select></label>
    <div class="btns"><button type="button" class="btn" id="ff-clear">条件をクリア</button><button class="btn primary">この条件で表示</button></div>
  </form>`);
  const form = md.el.querySelector('#ff'), E = form.elements;
  form.onsubmit = e => { e.preventDefault(); md.close(); location.hash = toHash({ ...f, status: E.status.value, progress: E.progress.value, updated: E.updated.value, sort: E.sort.value === 'updated' ? '' : E.sort.value }); };
  md.el.querySelector('#ff-clear').onclick = () => { md.close(); location.hash = toHash({ q: f.q, group: f.group }); };
}

function cardHtml(c, m) {
  const p = c.project;
  const pct = c.progress.total;
  return `<article class="pcard">
    <a class="pcard-link" href="#/p/${esc(p.id)}" aria-label="${esc(p.name)}を開く"></a>
    <header><h2>${esc(p.name)}</h2><span class="badge status-${esc(p.status || 'none')}">${esc(c.statusLabel)}</span></header>
    ${originBadge(p, m) ? `<div class="pcard-origin">${originBadge(p, m)}</div>` : ''}
    <div class="meter" role="meter" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="完成度"><i style="width:${pct}%"></i></div>
    <div class="pct">完成度 <strong>${pct}%</strong>${c.latestSpec ? `<span class="muted"> ・仕様 ${esc(c.latestSpec.version)}</span>` : ''}</div>
    <a class="next${c.next ? '' : ' unset'}" href="#/p/${esc(p.id)}/next"><span class="next-label">次</span><span class="next-text">${c.next ? esc(c.next) : '次にやることを決める'}</span>${c.nextTask ? `<span class="badge pri-${esc(c.nextTask.priority || 'medium')}">${esc(label(m, 'taskPriorities', c.nextTask.priority || 'medium'))}</span>` : ''}</a>
    <footer>
      <a href="#/p/${esc(p.id)}/next" class="stat${c.openIssues ? ' alert' : ''}">未解決 <b>${c.openIssues}</b></a>
      <a href="#/p/${esc(p.id)}/requests" class="stat">要望 <b>${c.openRequests}</b>${c.unreviewed ? `<small>（未検討${c.unreviewed}）</small>` : ''}</a>
      <span class="stat muted">${fmtShort(c.lastUpdated)}</span>
      <button class="btn small add" data-add-req="${esc(p.id)}" aria-label="${esc(p.name)}に要望を追加">＋要望</button>
    </footer>
  </article>`;
}

function emptyHtml() {
  return `<section class="card empty">
    <h2>まだプロジェクトがありません</h2>
    <p>「話すだけで相談する」に、作りたいものを普段の言葉で書いてください。Factoryが整理して、ChatGPT・Claude・Geminiに渡す依頼文を作ります。</p>
    <div class="btns">
      <a class="btn primary" href="#/talk">話すだけで相談する</a>
      <button class="btn" id="seed-factory">Factory自身をプロジェクトとして登録</button>
    </div>
  </section>`;
}
