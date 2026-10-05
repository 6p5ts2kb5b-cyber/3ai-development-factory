// Phase 5：3AI比較タブ
// 依頼作成 → コピー（個人情報チェック）→ 3AIの回答を貼り付け → 並べて比較 → 各案を採用/保留/不採用（理由・判断日）
// → 最終結論 → 採用案を要望箱へ（仕様書は変えない。要望→採用→仕様へ反映→変更案→差分確認→確定 の流れを通す）
import { esc, fmtDate, fmtShort, toast, errorHtml, openModal, options } from '../ui.js';
import { label } from '../master.js';
import { isOpenTask } from '../logic.js';
import { AIS, aiRoles, recommendAI, buildComparePrompt } from '../ai.js';
import { safeCopy } from './safecopy.js';

const AI_COLOR = { chatgpt: 'var(--ai-chatgpt)', claude: 'var(--ai-claude)', gemini: 'var(--ai-gemini)' };
const base = (p, q = '') => `#/p/${encodeURIComponent(p.id)}/compare${q}`;
const DEC_ICON = { adopt: '✅', hold: '△', reject: '✖' };

// おすすめAIと役割（概要タブでも使う）
export async function recommendHtml(ctx, p, { compact = false } = {}) {
  const [urls, tasks] = await Promise.all([ctx.db.byIndex('urls', 'projectId', p.id), ctx.db.byIndex('tasks', 'projectId', p.id)]);
  const r = recommendAI(p, { urls, tasks }, ctx.master);
  if (!r) return '';
  return `<div class="reco" style="--ai:${AI_COLOR[r.ai]}"><span class="ai-dot"></span><div><strong>次のおすすめAI：${esc(r.label)}</strong>
    <div class="muted">${esc(r.reason)}${compact ? '' : '。あくまでおすすめです。どのAIに頼むかはあなたが決めます。'}</div></div></div>`;
}

export async function compareTab({ ctx, el, p, params }) {
  const c = params.get('c');
  if (c) return setView(ctx, el, p, c);
  if (params.get('mode') === 'new') return newSet(ctx, el, p);
  const sets = (await ctx.db.byIndex('compares', 'projectId', p.id)).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  const roles = aiRoles(ctx.master, p);
  el.innerHTML = `${await recommendHtml(ctx, p)}
    <section class="card">
      <div class="spec-head"><h2>3AIへの相談</h2><a class="btn small primary" href="${base(p, '?mode=new')}">＋ 新しい相談</a></div>
      <p class="muted">同じテーマをChatGPT・Claude・Geminiに聞き、回答を並べて比べます。どの案を採用するかは<strong>あなたが決めます</strong>（Factoryは決めません）。</p>
      ${sets.length ? `<ul class="list">${sets.map(s => { const n = AIS.filter(a => s.answers?.[a]?.answer).length; return `<li>
        <a class="grow" href="${base(p, `?c=${s.id}`)}"><strong>${esc(s.topic)}</strong>
          <span class="muted"> ${fmtShort(s.createdAt)}・仕様 ${esc(s.specVersion || 'なし')}・回答 ${n}/3</span></a>
        <span class="badge ${s.status === 'decided' ? 'ok' : ''}">${esc(label(ctx.master, 'compareStatuses', s.status || 'open'))}</span></li>`; }).join('')}</ul>` : '<p class="muted">相談はまだありません。</p>'}
    </section>
    <section class="card">
      <h2>このプロジェクトでの3AIの役割</h2>
      <p class="muted">基本の役割です。案件に合わせて変えられます（依頼文に反映されます）。</p>
      <form id="roles">${AIS.map(a => `<label class="field"><span><span class="ai-dot inline" style="--ai:${AI_COLOR[a]}"></span>${esc(label(ctx.master, 'aiList', a))}</span>
        <input type="text" name="${a}" value="${esc(roles[a])}" maxlength="200"></label>`).join('')}
        <div class="btns"><button type="button" class="btn" id="roles-reset">基本の役割に戻す</button><button class="btn primary">役割を保存</button></div></form>
    </section>`;
  const f = el.querySelector('#roles');
  f.onsubmit = async e => {
    e.preventDefault();
    const def = aiRoles(ctx.master, {});
    const aiRolesVal = Object.fromEntries(AIS.map(a => [a, f.elements[a].value.trim() === def[a] ? '' : f.elements[a].value.trim()]));
    await ctx.db.update('projects', p.id, { aiRoles: aiRolesVal }, { reason: '3AIの役割を変更' }); toast('役割を保存しました'); ctx.refresh();
  };
  el.querySelector('#roles-reset').onclick = async () => { await ctx.db.update('projects', p.id, { aiRoles: {} }, { reason: '3AIの役割を基本に戻す' }); toast('基本の役割に戻しました'); ctx.refresh(); };
}

async function newSet(ctx, el, p) {
  const m = ctx.master;
  const [spec, issues] = await Promise.all([ctx.db.latestFixedSpec(p.id), ctx.db.byIndex('issues', 'projectId', p.id)]);
  const openIssues = issues.filter(i => i.status !== 'resolved').map(i => `- ${i.title}`).join('\n');
  const cond = ['- 確定仕様を勝手に削除・変更しない（変更は提案として出す）', '- 無料運用を最優先し、有料サービスは事前に明示する', '- 個人情報を扱う場合は匿名化を前提にする'].join('\n');
  el.innerHTML = `<a class="back" href="${base(p)}">← 3AI比較へ</a>
    <section class="card"><h2>新しい相談</h2>
    <form id="ns">
      <label class="field"><span>テーマ <em class="req">必須</em></span><input type="text" name="topic" maxlength="200" placeholder="例：店舗データの保存方法"></label>
      <label class="field"><span>今回相談したい内容</span><textarea name="question" rows="4" placeholder="例：店舗を100件ほど登録したい。スマホで速く検索できる保存方法を3案ほしい"></textarea></label>
      <label class="field"><span>絶対に守る条件</span><textarea name="conditions" rows="3">${esc(cond)}</textarea></label>
      <label class="field"><span>現在の問題</span><textarea name="problems" rows="2" placeholder="（未解決事項から自動で入ります）">${esc(openIssues)}</textarea></label>
      <label class="field"><span>必要な出力形式</span><select name="outputFormat">${(m.outputFormats || []).map(o => `<option>${esc(o)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="includeSpec" ${spec ? 'checked' : 'disabled'}><span>最新確定仕様（${esc(spec?.version || 'まだありません')}）を依頼文に含める</span></label>
      <div id="ns-err" style="margin-top:10px"></div>
      <div class="btns" style="margin-top:12px"><a class="btn" href="${base(p)}">やめる</a><button class="btn primary">相談を作る</button></div>
    </form></section>`;
  const f = el.querySelector('#ns'), E = f.elements;
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const s = await ctx.db.createCompare(p.id, { topic: E.topic.value, question: E.question.value.trim(), conditions: E.conditions.value.trim(), problems: E.problems.value.trim(), outputFormat: E.outputFormat.value, includeSpec: E.includeSpec.checked });
      toast('相談を作りました'); location.hash = base(p, `?c=${s.id}`);
    } catch (err) { el.querySelector('#ns-err').innerHTML = errorHtml(err); }
  };
}

async function setView(ctx, el, p, id) {
  const m = ctx.master;
  const s = await ctx.db.get('compares', id);
  if (!s) { el.innerHTML = errorHtml(new Error('相談が見つかりません')) + `<a class="btn" href="${base(p)}">戻る</a>`; return; }
  const spec = await ctx.db.latestFixedSpec(p.id);
  const specForPrompt = spec && s.specVersion === spec.version ? spec : (await ctx.db.specsOf(p.id)).find(x => x.version === s.specVersion) || spec;
  const prompts = Object.fromEntries(AIS.map(a => [a, buildComparePrompt(s, p, specForPrompt, a, m)]));
  const ans = s.answers || {};
  const decLabel = k => label(m, 'compareDecisions', k);
  const col = a => {
    const x = ans[a] || {};
    return `<article class="ai-col" data-col="${a}" style="--ai:${AI_COLOR[a]}">
      <header><span class="ai-dot"></span><strong>${esc(label(m, 'aiList', a))}</strong>
        ${x.decision ? `<span class="badge dec-${esc(x.decision)}">${DEC_ICON[x.decision]} ${esc(decLabel(x.decision))}</span>` : ''}</header>
      ${x.answer ? `<div class="ai-answer prewrap">${esc(x.answer)}</div>
        <p class="muted">${fmtDate(x.savedAt)} 保存${x.memo ? `・メモ：${esc(x.memo)}` : ''}</p>
        ${x.decision ? `<div class="decision">判断：${esc(decLabel(x.decision))}（${esc((x.decidedAt || '').slice(0, 10))}）${x.decisionReason ? `／理由：${esc(x.decisionReason)}` : ''}</div>` : ''}
        <div class="dec-btns">${m.compareDecisions.map(d => `<button class="btn small${x.decision === d.key ? ' on' : ''}" data-dec="${a}:${d.key}">${DEC_ICON[d.key]} ${esc(d.label)}</button>`).join('')}</div>
        ${x.decision === 'adopt' ? (x.requestId ? `<p class="ok-note">✔ 要望箱へ追加済み（「未検討」から判断してください）<a href="#/p/${esc(p.id)}/requests">要望箱を開く</a></p>` : `<button class="btn primary" data-toreq="${a}">要望箱へ追加</button>`) : ''}`
        : '<p class="muted">まだ回答がありません。下の「回答を貼り付け」から保存してください。</p>'}
    </article>`;
  };
  el.innerHTML = `<a class="back" href="${base(p)}">← 3AI比較へ</a>
    <section class="card">
      <h2>${esc(s.topic)}</h2>
      <p class="muted">${fmtDate(s.createdAt)} 作成・対象仕様 ${esc(s.specVersion || 'なし')}</p>
      ${s.question ? `<p class="prewrap">${esc(s.question)}</p>` : ''}
    </section>

    <section class="card">
      <h2>① 依頼文をコピー</h2>
      <p class="muted">コピーしてそれぞれのAIのアプリに貼り付け、送ってください。コピー前に個人情報のチェックをします。</p>
      <div class="btns">${AIS.map(a => `<button class="btn ai-btn" style="--ai:${AI_COLOR[a]}" data-copy="${a}">${esc(label(m, 'aiList', a))}用をコピー${ans[a]?.promptAt ? ' ✓' : ''}</button>`).join('')}</div>
      <details style="margin-top:10px"><summary class="muted">依頼文の中身を見る</summary>${AIS.map(a => `<h3>${esc(label(m, 'aiList', a))}用</h3><pre class="md">${esc(prompts[a])}</pre>`).join('')}</details>
    </section>

    <section class="card">
      <h2>② 回答を貼り付け</h2>
      <nav class="chips ai-chips" aria-label="AIを選ぶ">${AIS.map((a, i) => `<button class="chip" data-paste-tab="${a}"${i === 0 ? ' aria-current="true"' : ''}>${esc(label(m, 'aiList', a))}${ans[a]?.answer ? ' ✓' : ''}</button>`).join('')}</nav>
      ${AIS.map((a, i) => `<form class="paste" data-paste="${a}"${i === 0 ? '' : ' hidden'}>
        <label class="field"><span>${esc(label(m, 'aiList', a))}の回答</span><textarea name="answer" rows="7" placeholder="${esc(label(m, 'aiList', a))}の回答をここに貼り付け">${esc(ans[a]?.answer || '')}</textarea></label>
        <label class="field"><span>メモ（任意）</span><input type="text" name="memo" value="${esc(ans[a]?.memo || '')}"></label>
        <div class="paste-err"></div>
        <button class="btn primary">${esc(label(m, 'aiList', a))}の回答を保存</button></form>`).join('')}
    </section>

    <section class="card">
      <h2>③ 比べて判断する</h2>
      <p class="muted">各案を「採用・保留・不採用」から選んでください。<strong>Factoryは採用案を決めません。</strong></p>
      <nav class="chips ai-chips cmp-chips" aria-label="表示するAI">${AIS.map((a, i) => `<button class="chip" data-cmp-tab="${a}"${i === 0 ? ' aria-current="true"' : ''}>${esc(label(m, 'aiList', a))}${ans[a]?.decision ? ' ' + DEC_ICON[ans[a].decision] : ''}</button>`).join('')}</nav>
      <div class="ai-cols" data-show="chatgpt">${AIS.map(col).join('')}</div>
    </section>

    <section class="card">
      <h2>④ 最終的に何を採用したか</h2>
      <form id="final"><label class="sr-only" for="final-t">最終結論</label>
        <textarea id="final-t" name="t" rows="3" placeholder="例：保存方法はClaude案（IndexedDB）を採用。地図はChatGPT案を保留">${esc(s.finalDecision || '')}</textarea>
        ${s.finalDecidedAt ? `<p class="muted">${fmtDate(s.finalDecidedAt)} 記録</p>` : ''}
        <button class="btn primary">最終結論を保存</button></form>
      <p class="muted" style="margin-top:8px">採用した案を仕様に入れるときは「要望箱へ追加」→ 要望箱で「採用」→「仕様へ反映」→ 差分確認 → 確定、の順で進みます。仕様書が直接変わることはありません。</p>
    </section>`;

  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const a = b.dataset.copy;
    const copied = await safeCopy(ctx, prompts[a], { what: `${label(m, 'aiList', a)}用の依頼文` });
    if (copied) { await ctx.db.recordPrompt(id, a, copied); b.textContent = `${label(m, 'aiList', a)}用をコピー ✓`; }
  });
  const switcher = (attr, apply) => el.querySelectorAll(`[${attr}]`).forEach(b => b.onclick = () => {
    el.querySelectorAll(`[${attr}]`).forEach(x => x.removeAttribute('aria-current')); b.setAttribute('aria-current', 'true'); apply(b.getAttribute(attr));
  });
  switcher('data-paste-tab', a => el.querySelectorAll('[data-paste]').forEach(f => { f.hidden = f.dataset.paste !== a; }));
  switcher('data-cmp-tab', a => { el.querySelector('.ai-cols').dataset.show = a; });
  el.querySelectorAll('[data-paste]').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    try { await ctx.db.saveAnswer(id, f.dataset.paste, { text: f.elements.answer.value, memo: f.elements.memo.value.trim() }); toast(`${label(m, 'aiList', f.dataset.paste)}の回答を保存しました`); ctx.refresh(); }
    catch (err) { f.querySelector('.paste-err').innerHTML = errorHtml(err); }
  });
  el.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const [a, d] = b.dataset.dec.split(':');
    const md = openModal(`<h2>${esc(label(m, 'aiList', a))}案を「${esc(decLabel(d))}」にします</h2>
      <form id="dd"><label class="field"><span>判断の理由${d === 'adopt' ? '（任意）' : '（書いておくと後で見返せます）'}</span><textarea name="why" rows="3" maxlength="1000"></textarea></label>
      <div id="dd-err"></div><div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">「${esc(decLabel(d))}」で記録</button></div></form>`);
    setTimeout(() => md.el.querySelector('textarea').focus(), 50);
    md.el.querySelector('#dd').onsubmit = async e => {
      e.preventDefault();
      try { await ctx.db.decideAnswer(id, a, d, { reason: e.target.elements.why.value }); md.close(); toast(`「${decLabel(d)}」にしました`); ctx.refresh(); }
      catch (err) { md.el.querySelector('#dd-err').innerHTML = errorHtml(err); }
    };
  });
  el.querySelectorAll('[data-toreq]').forEach(b => b.onclick = () => {
    const a = b.dataset.toreq;
    const first = (ans[a].answer || '').split('\n').map(x => x.replace(/^[#\-*\s\d.、）)]+/, '').trim()).find(Boolean) || s.topic;
    const md = openModal(`<h2>要望箱へ追加</h2><form id="tr">
      <p class="muted">要望箱に「未検討」として入ります。仕様書はまだ変わりません。</p>
      <label class="field"><span>要望の内容</span><input type="text" name="title" maxlength="200" value="${esc(first.slice(0, 80))}"></label>
      <label class="field"><span>メモ</span><input type="text" name="memo" value="${esc(`3AI比較「${s.topic}」の${label(m, 'aiList', a)}案より`)}"></label>
      <div id="tr-err"></div><div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">要望箱へ追加</button></div></form>`);
    md.el.querySelector('#tr').onsubmit = async e => {
      e.preventDefault();
      try { await ctx.db.answerToRequest(id, a, { title: e.target.elements.title.value, memo: e.target.elements.memo.value }); md.close(); toast('要望箱へ追加しました（仕様書は変わっていません）'); ctx.refresh(); }
      catch (err) { md.el.querySelector('#tr-err').innerHTML = errorHtml(err); }
    };
  });
  el.querySelector('#final').onsubmit = async e => {
    e.preventDefault();
    await ctx.db.setFinalDecision(id, e.target.elements.t.value); toast('最終結論を保存しました'); ctx.refresh();
  };
}
