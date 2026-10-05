// 「やりたいことを話すだけ」：種類を選ばず自然な日本語で入力 → 保存 → 3AI用の依頼文を作る（API不要）
import { esc, fmtShort, toast, errorHtml, copyText, options } from '../ui.js';
import { label } from '../master.js';
import { suggestDeliverable, privacyCheck, buildPrompts } from '../logic.js';
import { createProject } from './projectForm.js';
import { safeCopy } from './safecopy.js';

export async function talkView(ctx, view) {
  const ideas = (await ctx.db.all('ideas')).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  view.innerHTML = `<h1>話すだけで相談</h1>
    <p class="muted">作りたいもの・欲しいものを、普段の言葉で書いてください。アプリかExcelか等は選ばなくて大丈夫です。</p>
    <form id="talk-form" class="card">
      <label class="field"><span>やりたいこと</span>
        <textarea name="text" rows="7" placeholder="例：古着屋とフリマの情報をまとめて、週末にどこを回るか決められるアプリが欲しい。スマホで使いたい。"></textarea></label>
      <div id="talk-err"></div>
      <button class="btn primary">保存して整理する</button>
      <p class="muted" style="margin-top:8px">保存するだけで、どこにも送信されません。</p>
    </form>
    ${ideas.length ? `<h2>これまでの相談</h2><section class="card"><ul class="list">${ideas.map(i => `<li>
      <div class="grow"><a href="#/talk/${esc(i.id)}"><strong>${esc(firstLine(i.text))}</strong></a>
      <div class="muted">${fmtShort(i.createdAt)}</div></div>
      <span class="badge${i.status === 'project_created' ? ' ok' : ''}">${esc(label(ctx.master, 'ideaStatuses', i.status))}</span></li>`).join('')}</ul></section>` : ''}`;
  const f = view.querySelector('#talk-form');
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const text = f.text.value.trim();
      const sug = suggestDeliverable(text, ctx.master);
      const idea = await ctx.db.create('ideas', { text, status: 'new', suggestedTypes: sug.map(s => s.type) }, { reason: '話すだけモードで相談を保存' });
      location.hash = `#/talk/${idea.id}`;
    } catch (err) { view.querySelector('#talk-err').innerHTML = errorHtml(err); }
  };
}

const firstLine = t => { const s = String(t || '').trim().split('\n')[0]; return s.length > 40 ? s.slice(0, 40) + '…' : s; };

export async function ideaView(ctx, view, params, id) {
  const idea = await ctx.db.get('ideas', id);
  if (!idea) { view.innerHTML = errorHtml(new Error('相談メモが見つかりません')) + '<a class="btn" href="#/talk">戻る</a>'; return; }
  const m = ctx.master;
  const sug = suggestDeliverable(idea.text, m);
  const chosen = idea.chosenType || '';
  const warn = privacyCheck(idea.text, m);
  const project = idea.projectId ? await ctx.db.get('projects', idea.projectId) : null;
  const projectGone = idea.projectId && !project; // ゴミ箱にある等
  const prompts = buildPrompts(idea.text, m, { projectName: project?.name || '' });
  const aiColor = { chatgpt: 'var(--ai-chatgpt)', claude: 'var(--ai-claude)', gemini: 'var(--ai-gemini)' };

  view.innerHTML = `<a class="back" href="#/talk">← 相談一覧</a>
    <h1>相談内容</h1>
    <section class="card"><p class="prewrap">${esc(idea.text)}</p><p class="muted">${fmtShort(idea.createdAt)} 保存</p></section>

    <section class="card">
      <h2>作る形の提案</h2>
      <p class="muted">Factoryからの提案です。最終的に決めるのはあなたです。</p>
      <ul class="sugg">${sug.map((s, i) => `<li><strong>${i === 0 ? 'おすすめ：' : ''}${esc(s.label)}</strong> — ${esc(s.reason)}${s.hits.length ? `<span class="muted">（「${s.hits.map(esc).join('」「')}」から判断）</span>` : ''}</li>`).join('')}</ul>
      <label class="field"><span>作る形を決める</span>
        <select id="chosen-type"><option value="">まだ決めない</option>${options(m.deliverableTypes, chosen)}</select></label>
    </section>

    <section class="card">
      <h2>3AIへの依頼文</h2>
      ${warn.length ? `<div class="notice warn"><strong>送る前に確認してください</strong><br>「${warn.map(esc).join('」「')}」が含まれています。生徒などの個人情報は、名前をAさん・Bさん等に置き換えてから貼り付けてください。</div>` : ''}
      <p class="muted">「コピー」を押し、それぞれのAIのアプリに貼り付けて送ってください。回答の保存・比較は Phase 5 で追加します。</p>
      ${m.aiList.map(a => `<details class="prompt" style="--ai:${aiColor[a.key] || 'var(--accent)'}">
        <summary><span class="ai-dot"></span><strong>${esc(a.label)}用</strong><span class="muted">${esc(a.roles.slice(0, 3).join('・'))}</span></summary>
        <pre class="md">${esc(prompts[a.key])}</pre>
      </details>`).join('')}
      <div class="btns" style="margin-top:10px">${m.aiList.map(a => `<button class="btn" data-copy="${esc(a.key)}">${esc(a.label)}用をコピー</button>`).join('')}</div>
    </section>

    <section class="card">
      ${project ? `<h2>プロジェクト化済み</h2><a class="btn primary" href="#/p/${esc(project.id)}">「${esc(project.name)}」を開く</a>` : projectGone ? `<h2>プロジェクト化済み</h2><p class="muted">作成したプロジェクトは削除されています（ゴミ箱から元に戻せる場合があります）。</p><a class="btn" href="#/trash">ゴミ箱を開く</a>` : `
      <h2>プロジェクトにする</h2>
      <p class="muted">状態「構想」で登録します。まだ迷っている場合は、このまま保存しておいても大丈夫です。</p>
      <form id="mk-project">
        <label class="field"><span>プロジェクト名</span><input type="text" name="name" maxlength="100" value="${esc(firstLine(idea.text).replace(/…$/, '').slice(0, 30))}"></label>
        <div id="mk-err"></div>
        <button class="btn primary">プロジェクトを作る</button>
      </form>`}
    </section>`;

  view.querySelector('#chosen-type').onchange = async e => {
    await ctx.db.update('ideas', id, { chosenType: e.target.value || null }, { reason: '作る形を選択' });
    if (project) await ctx.db.update('projects', project.id, { deliverableType: e.target.value || null }, { reason: '作る形を選択' });
    toast(e.target.value ? `「${label(m, 'deliverableTypes', e.target.value)}」に決めました` : '未決定に戻しました');
  };
  view.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => safeCopy(ctx, prompts[b.dataset.copy], { what: '依頼文' })); // Phase 5：個人情報チェック付き
  const mk = view.querySelector('#mk-project');
  if (mk) mk.onsubmit = async e => {
    e.preventDefault();
    try {
      const type = view.querySelector('#chosen-type').value || null;
      // 新規作成と同じデータ構造（Phase 3）。対象ユーザー・端末・メモは後から概要で入力
      const p = await createProject(ctx.db, { name: mk.name.value, status: 'concept', purpose: idea.text, deliverableType: type, ideaId: id }, { firstTask: '3AIに依頼文を送り、回答を集めて仕様を整理する', reason: '話すだけモードの相談からプロジェクトを作成' });
      await ctx.db.update('ideas', id, { status: 'project_created', projectId: p.id }, { reason: 'プロジェクト化' });
      toast('プロジェクトを作りました');
      location.hash = `#/p/${p.id}`;
    } catch (err) { view.querySelector('#mk-err').innerHTML = errorHtml(err); }
  };
}
