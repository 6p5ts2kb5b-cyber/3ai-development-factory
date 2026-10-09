// Phase 6：実機確認・公開確認（プロジェクトとFactory本体の両方で使う部品）
import { esc, fmtShort, toast, errorHtml, openModal, options, confirmDialog } from '../ui.js';
import { label } from '../master.js';

const today = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const DEV_CLASS = { pass: 'ok', fail: 'ng', recheck: 'warn', unchecked: '' };
const ACC_CLASS = { ok: 'ok', school_blocked: 'warn', not_published: 'ng', error: 'ng', unchecked: '' };

// ---- 実機確認の重複（v0.11.8） ----
// 起動時に「実機確認の欄（iPhone・自宅PC・学校Windows PC）」が無ければ端末ごとに作るため、
// 同期を始める前に2台それぞれで作られた欄が、同期でそろうと同じ端末名が2件になる。
// ・同じ端末か：名前の空白・全角半角・大文字小文字の違いは同じとみなす
// ・未記入の欄：状態が「未確認」で、確認日・結果が空（自動で作られたまま、だれも記録していない欄）
// ・「重複として整理」した欄（duplicateOf あり）は判定に入れない。削除はしない（元に戻せる・ほかの端末にも同期される）
export const deviceKey = name => String(name || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export const isBlankDeviceCheck = d => (d.status || 'unchecked') === 'unchecked' && !d.checkedAt && !String(d.result || '').trim();
const STATUS_RANK = { fail: 4, recheck: 3, unchecked: 1, pass: 0 };
/**
 * 端末ごとにまとめる（画面に依存しない・自動テストの対象）
 * @returns [{ key, device, records（整理していないもの）, marked（重複として整理したもの）, evidence（記入のある記録）, blanks（未記入の欄）, extraBlanks（整理できる重複）, ok, status, keeper }]
 *   ok：記入のある記録がすべて「合格」で、1件以上あるとき。未記入の欄は、記入のある記録があるときは判定に入れない（合格を作るものではない）
 */
export function groupDeviceChecks(devices = []) {
  const map = new Map();
  for (const d of devices) {
    const k = deviceKey(d.device);
    if (!map.has(k)) map.set(k, { key: k, device: String(d.device || '').trim(), records: [], marked: [] });
    (d.duplicateOf ? map.get(k).marked : map.get(k).records).push(d);
  }
  return [...map.values()].map(g => {
    const evidence = g.records.filter(d => !isBlankDeviceCheck(d));
    const blanks = g.records.filter(isBlankDeviceCheck);
    const ok = evidence.length > 0 && evidence.every(d => d.status === 'pass');
    const status = evidence.length ? evidence.map(d => d.status || 'unchecked').sort((a, b) => (STATUS_RANK[b] ?? 2) - (STATUS_RANK[a] ?? 2))[0] : 'unchecked';
    const keeper = evidence.find(d => d.status === 'pass') || evidence[0] || blanks[0] || g.marked[0] || null;
    // 整理できる重複：記入のある記録があれば未記入の欄すべて、なければ2件目以降の未記入の欄
    const extraBlanks = evidence.length ? blanks : blanks.slice(1);
    return { ...g, evidence, blanks, extraBlanks, ok, status, keeper };
  });
}

export function checksHtml(m, devices, publish) {
  const groups = groupDeviceChecks(devices);
  const extra = new Set(groups.flatMap(g => g.extraBlanks.map(d => d.id)));
  const keeperOf = new Map(groups.flatMap(g => g.extraBlanks.map(d => [d.id, g.keeper?.id])));
  const active = devices.filter(d => !d.duplicateOf), marked = devices.filter(d => d.duplicateOf);
  const dupNames = groups.filter(g => g.extraBlanks.length).map(g => g.device);
  return `<section class="card" id="dev-card">
      <div class="spec-head"><h2>実機確認</h2><button class="btn small primary" data-chk="add-dev">＋ 端末</button></div>
      <p class="muted">実際の端末で動くか確認した結果を記録します。すべて「合格」になると「完成」の条件を満たします。</p>
      ${dupNames.length ? `<div class="notice warn slim" id="dev-dup-note"><strong>同じ端末の欄が重複しています（${dupNames.map(esc).join('、')}）</strong><br>同期を始める前に、それぞれの端末で自動的に作られた未記入の欄です。未記入の欄は完成の判定に入れていません。「重複として整理」を押すと、この一覧と判定から外します（削除はしません・元に戻せます）。</div>` : ''}
      ${active.length ? `<ul class="list">${active.map(d => `<li${extra.has(d.id) ? ' class="dev-dup"' : ''}><button class="row-btn grow" data-dev="${esc(d.id)}">
        <span class="t-title">${esc(d.device)}</span>
        <span class="t-meta"><span class="badge ${DEV_CLASS[d.status || 'unchecked']}">${esc(label(m, 'deviceCheckStatuses', d.status || 'unchecked'))}</span>
          ${d.checkedAt ? `<span>確認日 ${esc(d.checkedAt)}</span>` : ''}${d.scope ? `<span>${esc(d.scope)}</span>` : ''}</span>
        ${d.result ? `<span class="t-res">結果：${esc(d.result)}</span>` : ''}${d.memo ? `<span class="muted">${esc(d.memo)}</span>` : ''}${extra.has(d.id) ? '<span class="badge warn">重複（未記入）</span>' : ''}</button>${extra.has(d.id) ? `<button class="btn small" data-dedupe="${esc(d.id)}" data-keeper="${esc(keeperOf.get(d.id) || '')}">重複として整理</button>` : ''}</li>`).join('')}</ul>`
        : marked.length ? '' : `<p class="muted">端末が登録されていません。</p><button class="btn" data-chk="add-default">iPhone・自宅PC・学校Windows PC を登録</button>`}
      ${marked.length ? `<details class="ex-box" id="dev-marked"><summary>重複として整理した欄（${marked.length}件・判定に入れていません）</summary><ul class="list">${marked.map(d => `<li><span class="grow">${esc(d.device)} <span class="badge">${esc(label(m, 'deviceCheckStatuses', d.status || 'unchecked'))}</span></span><button class="btn small" data-undupe="${esc(d.id)}">元に戻す</button></li>`).join('')}</ul></details>` : ''}
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
  // 記録を開く：画面を作ったときの一覧に無ければ（同期などで変わった）、データベースから読み直す。それでも無ければ理由を表示する（黙って何もしない、をなくす）
  root.querySelectorAll('[data-dev]').forEach(b => b.onclick = async () => {
    const id = b.dataset.dev;
    let d = devices.find(x => String(x.id) === id);
    if (!d) { try { d = await ctx.db.get('checks', id); } catch { d = null; } }
    if (!d) { toast('この記録が見つかりません（ほかの端末で整理・削除された可能性があります）。画面を開き直します'); ctx.refresh(); return; }
    try { deviceForm(ctx, projectId, d); } catch (err) { toast(`記録を開けませんでした：${err.message || err}`); }
  });
  // 重複として整理（削除しない：duplicateOf を付けて一覧と判定から外す。ほかの端末にも同期される）
  root.querySelectorAll('[data-dedupe]').forEach(b => b.onclick = async () => {
    const d = devices.find(x => String(x.id) === b.dataset.dedupe);
    if (!d) { ctx.refresh(); return; }
    if (!isBlankDeviceCheck(d)) { toast('記入のある記録は整理できません'); return; }
    if (!await confirmDialog({ title: `${d.device} の重複した欄を整理しますか？`, body: '<p>未記入の欄を、この一覧と完成の判定から外します。<strong>削除はしません</strong>。「重複として整理した欄」から元に戻せます。合格の記録はそのまま残ります。</p>', ok: '重複として整理' })) return;
    try { await ctx.db.update('checks', d.id, { duplicateOf: b.dataset.keeper || 'duplicate' }, { reason: `実機確認（${d.device}）：未記入の重複した欄を整理` }); toast('重複として整理しました（元に戻せます）'); ctx.refresh(); }
    catch (err) { toast(`整理できませんでした：${err.message || err}`); }
  });
  root.querySelectorAll('[data-undupe]').forEach(b => b.onclick = async () => {
    const d = devices.find(x => String(x.id) === b.dataset.undupe);
    if (!d) { ctx.refresh(); return; }
    try { await ctx.db.update('checks', d.id, { duplicateOf: null }, { reason: `実機確認（${d.device}）：重複の整理を元に戻す` }); toast('元に戻しました'); ctx.refresh(); }
    catch (err) { toast(`元に戻せませんでした：${err.message || err}`); }
  });
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
