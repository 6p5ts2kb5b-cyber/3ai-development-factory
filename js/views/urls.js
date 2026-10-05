// Phase 5：URL要約
// 無理なスクレイピングはしない。ブラウザから普通に読めないURLは「取得できません」と表示し、
// AIで要約した内容を貼り付けて保存できるようにする（YouTube・X等の制限を回避する処理はしない）。
import { esc, fmtShort, toast, errorHtml, openModal, options, confirmDialog } from '../ui.js';
import { label } from '../master.js';
import { buildUrlPrompt, recommendForUrl, detectUrlKind } from '../ai.js';
import { safeCopy } from './safecopy.js';

const base = (p, q = '') => `#/p/${encodeURIComponent(p.id)}/urls${q}`;

export async function urlsTab({ ctx, el, p, params }) {
  const m = ctx.master;
  const id = params.get('u');
  if (id) return urlView(ctx, el, p, id);
  const urls = (await ctx.db.byIndex('urls', 'projectId', p.id)).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  el.innerHTML = `<section class="card">
      <h2>URL要約 <span class="muted">${urls.length}件</span></h2>
      <p class="muted">参考になるWebページ・YouTube・Xなどを保存し、要約・重要ポイント・活用案を残します。良いアイデアは要望箱へ送れます。</p>
      <form id="ua" class="inline-add"><label class="sr-only" for="ua-u">URL</label>
        <input id="ua-u" type="url" name="u" inputmode="url" placeholder="https://…"><button class="btn small primary">登録</button></form>
      <div id="ua-err"></div>
      ${urls.length ? `<ul class="list">${urls.map(u => `<li><a class="grow url-row" href="${base(p, `?u=${u.id}`)}">
        <strong>${esc(u.title || u.url)}</strong>
        <span class="t-meta"><span class="badge">${esc(label(m, 'urlKinds', u.kind || 'web'))}</span><span>${esc(u.registeredAt || (u.createdAt || '').slice(0, 10))}</span>
          ${(u.summary || '').trim() ? '<span class="badge ok">要約あり</span>' : '<span class="badge warn">要約なし</span>'}${u.requestIds?.length ? `<span>要望へ ${u.requestIds.length}件</span>` : ''}</span></a></li>`).join('')}</ul>` : '<p class="muted">まだありません。</p>'}
    </section>`;
  el.querySelector('#ua').onsubmit = async e => {
    e.preventDefault();
    try { const u = await ctx.db.addUrl(p.id, { url: e.target.elements.u.value }); toast('登録しました'); location.hash = base(p, `?u=${u.id}`); }
    catch (err) { el.querySelector('#ua-err').innerHTML = errorHtml(err); }
  };
}

// 普通に読めるページだけタイトルを取得（読めなければ「取得できません」）
async function tryFetchTitle(url) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 200000);
    const mm = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    return mm ? mm[1].trim() : null;
  } catch { return null; }
}

async function urlView(ctx, el, p, id) {
  const m = ctx.master;
  const u = await ctx.db.get('urls', id);
  if (!u) { el.innerHTML = errorHtml(new Error('URLが見つかりません')) + `<a class="btn" href="${base(p)}">戻る</a>`; return; }
  const rec = recommendForUrl(u.kind);
  const reqs = (await Promise.all((u.requestIds || []).map(r => ctx.db.get('requests', r)))).filter(Boolean);
  el.innerHTML = `<a class="back" href="${base(p)}">← URL一覧へ</a>
    <section class="card">
      <h2>${esc(u.title || 'タイトル未設定')}</h2>
      <p class="url-line"><a href="${esc(u.url)}" target="_blank" rel="noopener noreferrer">${esc(u.url)}</a></p>
      <p class="muted">${esc(label(m, 'urlKinds', u.kind || 'web'))}・${esc(u.registeredAt || '')} 登録</p>
      <div class="btns">
        <button class="btn" id="u-fetch">タイトルの取得を試す</button>
        <button class="btn primary" id="u-prompt">AIに要約を頼む（依頼文をコピー）</button>
      </div>
      <p id="u-fetch-msg" class="muted">${u.fetchStatus === 'failed' ? '前回：取得できませんでした。' : ''}</p>
      <p class="muted">おすすめ：<strong>${esc(label(m, 'aiList', rec))}</strong>${u.kind === 'youtube' ? '（動画の内容理解が得意）' : ''}。AIの回答を下に貼り付けて保存してください。</p>
    </section>
    <section class="card">
      <form id="uf">
        <div class="grid two">
          <label class="field"><span>タイトル</span><input type="text" name="title" maxlength="300" value="${esc(u.title || '')}"></label>
          <label class="field"><span>種類</span><select name="kind">${options(m.urlKinds, u.kind || 'web')}</select></label>
        </div>
        <label class="field"><span>要約</span><textarea name="summary" rows="4">${esc(u.summary || '')}</textarea></label>
        <label class="field"><span>重要ポイント</span><textarea name="points" rows="4">${esc(u.points || '')}</textarea></label>
        <label class="field"><span>Factory（このプロジェクト）への活用案</span><textarea name="ideas" rows="3">${esc(u.ideas || '')}</textarea></label>
        <label class="field"><span>メモ</span><input type="text" name="memo" value="${esc(u.memo || '')}"></label>
        <div id="uf-err"></div>
        <div class="btns"><button class="btn primary">保存</button><button type="button" class="btn" id="u-req">活用案を要望箱へ追加</button></div>
      </form>
      ${reqs.length ? `<p class="ok-note">要望箱へ追加済み：${reqs.map(r => esc(r.title)).join('、')}（<a href="#/p/${esc(p.id)}/requests">要望箱</a>）</p>` : ''}
    </section>
    <button class="btn danger" id="u-del">このURLを削除（ゴミ箱へ）</button>`;
  const f = el.querySelector('#uf'), E = f.elements;
  const save = async () => ctx.db.update('urls', id, { title: E.title.value.trim(), kind: E.kind.value, summary: E.summary.value.trim(), points: E.points.value.trim(), ideas: E.ideas.value.trim(), memo: E.memo.value.trim() }, { reason: 'URL要約を保存' });
  f.onsubmit = async e => { e.preventDefault(); try { await save(); toast('保存しました'); ctx.refresh(); } catch (err) { el.querySelector('#uf-err').innerHTML = errorHtml(err); } };
  el.querySelector('#u-fetch').onclick = async () => {
    const msg = el.querySelector('#u-fetch-msg');
    msg.textContent = '確認しています…';
    const t = await tryFetchTitle(u.url);
    if (t) { E.title.value = t; await ctx.db.update('urls', id, { title: t, fetchStatus: 'ok' }, { reason: 'タイトルを取得' }); msg.textContent = '取得しました：' + t; }
    else { await ctx.db.update('urls', id, { fetchStatus: 'failed' }, { reason: 'タイトル取得できず' }); msg.innerHTML = '<strong>取得できません。</strong>このページは外部から読み取れない設定です。「AIに要約を頼む」で要約を作り、貼り付けて保存してください。'; }
  };
  el.querySelector('#u-prompt').onclick = () => safeCopy(ctx, buildUrlPrompt(u, p, m), { what: 'URL要約の依頼文' });
  el.querySelector('#u-req').onclick = async () => {
    try { await save(); } catch (err) { el.querySelector('#uf-err').innerHTML = errorHtml(err); return; }
    const first = (E.ideas.value || E.points.value || E.summary.value || E.title.value || '').split('\n').map(x => x.replace(/^[#\-*・\s\d.、）)]+/, '').trim()).find(Boolean) || '';
    const md = openModal(`<h2>要望箱へ追加</h2><form id="ur">
      <p class="muted">要望箱に「未検討」として入ります。仕様書はまだ変わりません。</p>
      <label class="field"><span>要望の内容</span><input type="text" name="title" maxlength="200" value="${esc(first.slice(0, 80))}"></label>
      <div id="ur-err"></div><div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">要望箱へ追加</button></div></form>`);
    md.el.querySelector('#ur').onsubmit = async e => {
      e.preventDefault();
      try { await ctx.db.urlToRequest(id, { title: e.target.elements.title.value }); md.close(); toast('要望箱へ追加しました（仕様書は変わっていません）'); ctx.refresh(); }
      catch (err) { md.el.querySelector('#ur-err').innerHTML = errorHtml(err); }
    };
  };
  el.querySelector('#u-del').onclick = async () => {
    if (!await confirmDialog({ title: 'このURLを削除しますか？', body: '<p>ゴミ箱へ移します。元に戻せます。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('urls', id, { reason: 'URLを削除' }); toast('ゴミ箱へ移しました'); location.hash = base(p);
  };
}
