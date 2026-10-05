// AIへ渡す文章のコピー前チェック（Phase 5）
// 個人情報らしきものが見つかったら「匿名化してコピー／内容を確認／キャンセル」を選んでもらう。
import { esc, toast, openModal, copyText } from '../ui.js';
import { findPersonalInfo, anonymize } from '../privacy.js';

const listHtml = found => `<ul class="tight pi-list">${found.slice(0, 12).map(f => `<li><span class="badge ng">${esc(f.kind)}</span> ${esc(f.text)}</li>`).join('')}${found.length > 12 ? `<li>…ほか${found.length - 12}件</li>` : ''}</ul>`;

// 戻り値：実際にコピーした文章（キャンセル・失敗は null）
export function safeCopy(ctx, text, { what = 'この文章' } = {}) {
  return new Promise(resolve => {
    const found = findPersonalInfo(text, ctx.master);
    const doCopy = async (t, msg) => {
      const ok = await copyText(t);
      toast(ok ? msg : 'コピーできませんでした。内容を長押しして選択してください');
      resolve(ok ? t : null);
    };
    if (!found.length) { doCopy(text, 'コピーしました。AIのアプリに貼り付けてください'); return; }
    let done = false;
    const md = openModal(`<h2>⚠️ 個人情報が含まれているかもしれません</h2>
      <p>${esc(what)}に、次のような内容が見つかりました。<strong>学校の生徒などの個人情報は、AIへ送らないでください。</strong></p>
      ${listHtml(found)}
      <p class="muted">自動の判定なので、見落としや思い違いもあります。最後は目で確認してください。</p>
      <div id="sc-body"></div>
      <div class="btns sc-btns">
        <button class="btn primary" data-sc="anon">匿名化してコピー</button>
        <button class="btn" data-sc="review">内容を確認する</button>
        <button class="btn" data-close>キャンセル</button>
      </div>`, { onClose: () => { if (!done) resolve(null); } });
    const finish = async (t, msg) => { done = true; md.close(); await doCopy(t, msg); };
    md.el.querySelector('[data-sc=anon]').onclick = () => {
      const a = anonymize(text);
      const rest = findPersonalInfo(a, ctx.master).filter(f => f.kind !== '注意する言葉');
      finish(a, rest.length ? '匿名化してコピーしました（念のため貼り付け前に確認してください）' : '匿名化してコピーしました');
    };
    md.el.querySelector('[data-sc=review]').onclick = () => {
      const box = md.el.querySelector('#sc-body');
      box.innerHTML = `<label class="field"><span>送る内容（直接書き換えられます）</span><textarea id="sc-text" rows="10" class="mono">${esc(text)}</textarea></label>
        <div id="sc-check" class="muted"></div>
        <div class="btns"><button class="btn" id="sc-anon2">この内容を匿名化</button><button class="btn primary" id="sc-copy">この内容でコピー</button></div>`;
      md.el.querySelector('.sc-btns').hidden = true;
      const ta = md.el.querySelector('#sc-text');
      const recheck = () => { const f = findPersonalInfo(ta.value, ctx.master); md.el.querySelector('#sc-check').innerHTML = f.length ? `まだ ${f.length}件 見つかります：${f.slice(0, 5).map(x => esc(x.text)).join('、')}` : '✅ 個人情報らしきものは見つかりません'; };
      ta.oninput = recheck; recheck();
      md.el.querySelector('#sc-anon2').onclick = () => { ta.value = anonymize(ta.value); recheck(); };
      md.el.querySelector('#sc-copy').onclick = () => finish(ta.value, '確認した内容をコピーしました');
      ta.focus();
    };
  });
}
