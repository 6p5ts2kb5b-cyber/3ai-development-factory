// Phase 6：実機確認・公開確認（プロジェクトとFactory本体の両方で使う部品）
import { esc, fmtShort, toast, errorHtml, openModal, options, confirmDialog } from '../ui.js';
import { label } from '../master.js';

const today = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const DEV_CLASS = { pass: 'ok', fail: 'ng', recheck: 'warn', unchecked: '' };
const ACC_CLASS = { ok: 'ok', school_blocked: 'warn', not_published: 'ng', error: 'ng', unchecked: '' };

export function checksHtml(m, devices, publish) {
  return `<section class="card" id="dev-card">
      <div class="spec-head"><h2>実機確認</h2><button class="btn small primary" data-chk="add-dev">＋ 端末</button></div>
      <p class="muted">実際の端末で動くか確認した結果を記録します。すべて「合格」になると「完成」の条件を満たします。</p>
      ${devices.length ? `<ul class="list">${devices.map(d => `<li><button class="row-btn grow" data-dev="${esc(d.id)}">
        <span class="t-title">${esc(d.device)}</span>
        <span class="t-meta"><span class="badge ${DEV_CLASS[d.status || 'unchecked']}">${esc(label(m, 'deviceCheckStatuses', d.status || 'unchecked'))}</span>
          ${d.checkedAt ? `<span>確認日 ${esc(d.checkedAt)}</span>` : ''}${d.scope ? `<span>${esc(d.scope)}</span>` : ''}</span>
        ${d.result ? `<span class="t-res">結果：${esc(d.result)}</span>` : ''}${d.memo ? `<span class="muted">${esc(d.memo)}</span>` : ''}</button></li>`).join('')}</ul>`
        : `<p class="muted">端末が登録されていません。</p><button class="btn" data-chk="add-default">iPhone・自宅PC・学校Windows PC を登録</button>`}
    </section>
    <section class="card" id="pub-card">
      <div class="spec-head"><h2>公開確認</h2><button class="btn small primary" data-chk="add-pub">＋ 確認を記録</button></div>
      <p class="muted">GitHub Pages等で公開したときの確認結果です。学校で開けない場合は「学校ネットワークで利用不可」として、公開の失敗と分けて記録します。</p>
      ${publish.length ? `<ul class="list">${publish.map(x => `<li><button class="row-btn grow" data-pub="${esc(x.id)}">
        <span class="t-title url-line">${esc(x.target || '公開先未記入')}</span>
        <span class="t-meta"><span class="badge ${ACC_CLASS[x.access || 'unchecked']}">${esc(label(m, 'accessResults', x.access || 'unchecked'))}</span>
          ${x.environment ? `<span>${esc(x.environment)}から</span>` : ''}${x.publishedAt ? `<span>公開 ${esc(x.publishedAt)}</span>` : ''}${x.lastCheckedAt ? `<span>最終確認 ${esc(x.lastCheckedAt)}</span>` : ''}
          <span>オフライン起動：${esc(label(m, 'checkYesNo', x.offline || 'unchecked'))}</span><span>ホーム画面追加：${esc(label(m, 'checkYesNo', x.homescreen || 'unchecked'))}</span></span>
        ${x.memo ? `<span class="muted">${esc(x.memo)}</span>` : ''}</button></li>`).join('')}</ul>` : '<p class="muted">まだ記録がありません。</p>'}
    </section>`;
}

export function bindChecks(root, ctx, projectId, { devices, publish }) {
  const m = ctx.master;
  root.querySelector('[data-chk=add-dev]').onclick = () => deviceForm(ctx, projectId);
  root.querySelector('[data-chk=add-default]')?.addEventListener('click', async () => {
    for (const [i, d] of m.defaultDevices.entries()) await ctx.db.create('checks', { projectId, kind: 'device', device: d, order: i, status: 'unchecked', result: '', memo: '', checkedAt: null }, { reason: '実機確認の端末を登録' });
    toast('端末を登録しました'); ctx.refresh();
  });
  root.querySelector('[data-chk=add-pub]').onclick = () => publishForm(ctx, projectId);
  root.querySelectorAll('[data-dev]').forEach(b => b.onclick = () => deviceForm(ctx, projectId, devices.find(d => d.id === b.dataset.dev)));
  root.querySelectorAll('[data-pub]').forEach(b => b.onclick = () => publishForm(ctx, projectId, publish.find(x => x.id === b.dataset.pub)));
}

function deviceForm(ctx, projectId, d = null) {
  const m = ctx.master, x = d || {};
  const md = openModal(`<h2>${d ? `実機確認：${esc(x.device)}` : '端末を追加'}</h2><form id="dvf">
    <label class="field"><span>端末</span><input type="text" name="device" maxlength="60" value="${esc(x.device || '')}" placeholder="例：iPhone 13（Safari）"></label>
    <div class="grid two">
      <label class="field"><span>状態</span><select name="status">${options(m.deviceCheckStatuses, x.status || 'unchecked')}</select></label>
      <label class="field"><span>確認日</span><input type="date" name="checkedAt" value="${esc(x.checkedAt || (d ? today() : ''))}"></label>
    </div>
    <label class="field"><span>結果</span><textarea name="result" rows="2" placeholder="例：自動テスト 全45項目合格">${esc(x.result || '')}</textarea></label>
    <label class="field"><span>メモ</span><input type="text" name="memo" value="${esc(x.memo || '')}"></label>
    <div id="dvf-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">保存</button></div>
    ${d ? '<hr><button type="button" class="btn danger" id="dvf-del">この端末を削除（ゴミ箱へ）</button>' : ''}</form>`);
  const f = md.el.querySelector('#dvf'), E = f.elements;
  f.onsubmit = async e => {
    e.preventDefault();
    const data = { device: E.device.value.trim(), status: E.status.value, checkedAt: E.checkedAt.value || null, result: E.result.value.trim(), memo: E.memo.value.trim() };
    if (!data.device) { md.el.querySelector('#dvf-err').innerHTML = errorHtml(new Error('端末名を入力してください')); return; }
    try {
      if (d) await ctx.db.update('checks', d.id, data, { reason: `実機確認（${data.device}）：${label(m, 'deviceCheckStatuses', data.status)}` });
      else await ctx.db.create('checks', { ...data, projectId, kind: 'device' }, { reason: '実機確認の端末を追加' });
      md.close(); toast('保存しました'); ctx.refresh();
    } catch (err) { md.el.querySelector('#dvf-err').innerHTML = errorHtml(err); }
  };
  md.el.querySelector('#dvf-del')?.addEventListener('click', async () => {
    md.close();
    if (!await confirmDialog({ title: `${d.device} を削除しますか？`, body: '<p>ゴミ箱へ移します。元に戻せます。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('checks', d.id, { reason: '実機確認の端末を削除' }); toast('ゴミ箱へ移しました'); ctx.refresh();
  });
}

function publishForm(ctx, projectId, x0 = null) {
  const m = ctx.master, x = x0 || {};
  const md = openModal(`<h2>公開確認</h2><form id="pbf">
    <label class="field"><span>公開先（URL）</span><input type="url" name="target" maxlength="500" value="${esc(x.target || '')}" placeholder="https://（ユーザー名）.github.io/factory/"></label>
    <div class="grid two">
      <label class="field"><span>公開日</span><input type="date" name="publishedAt" value="${esc(x.publishedAt || '')}"></label>
      <label class="field"><span>最終確認日</span><input type="date" name="lastCheckedAt" value="${esc(x.lastCheckedAt || today())}"></label>
      <label class="field"><span>どこから確認したか</span><select name="environment">${m.accessEnvironments.map(v => `<option${v === x.environment ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>アクセス結果</span><select name="access">${options(m.accessResults, x.access || 'unchecked')}</select></label>
      <label class="field"><span>オフライン起動</span><select name="offline">${options(m.checkYesNo, x.offline || 'unchecked')}</select></label>
      <label class="field"><span>ホーム画面追加</span><select name="homescreen">${options(m.checkYesNo, x.homescreen || 'unchecked')}</select></label>
    </div>
    <label class="field"><span>メモ</span><input type="text" name="memo" value="${esc(x.memo || '')}" placeholder="例：学校ではフィルタで github.io がブロックされた"></label>
    <div id="pbf-err"></div>
    <div class="btns"><button type="button" class="btn" data-close>やめる</button><button class="btn primary">保存</button></div>
    ${x0 ? '<hr><button type="button" class="btn danger" id="pbf-del">この記録を削除（ゴミ箱へ）</button>' : ''}</form>`);
  const f = md.el.querySelector('#pbf'), E = f.elements;
  f.onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(['target', 'publishedAt', 'lastCheckedAt', 'environment', 'access', 'offline', 'homescreen', 'memo'].map(k => [k, E[k].value.trim() || null]));
    try {
      if (x0) await ctx.db.update('checks', x0.id, data, { reason: '公開確認を更新' });
      else await ctx.db.create('checks', { ...data, projectId, kind: 'publish' }, { reason: '公開確認を記録' });
      md.close(); toast('保存しました'); ctx.refresh();
    } catch (err) { md.el.querySelector('#pbf-err').innerHTML = errorHtml(err); }
  };
  md.el.querySelector('#pbf-del')?.addEventListener('click', async () => {
    md.close();
    if (!await confirmDialog({ title: 'この公開確認を削除しますか？', body: '<p>ゴミ箱へ移します。</p>', ok: '削除する', danger: true })) return;
    await ctx.db.remove('checks', x0.id, { reason: '公開確認を削除' }); toast('ゴミ箱へ移しました'); ctx.refresh();
  });
}

export const devSummary = (devices, m) => devices.map(d => `${d.device}：${label(m, 'deviceCheckStatuses', d.status || 'unchecked')}${d.checkedAt ? `（${d.checkedAt}）` : ''}`);
