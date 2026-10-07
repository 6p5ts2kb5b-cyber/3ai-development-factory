// Phase Sync-3：同期の欄（Googleログイン・同期の画面の中）
// 送る／受け取る前に必ず件数と内容を表示し、利用者が押したときだけ実行する。
import { esc, toast, confirmDialog } from '../ui.js';
import { authState, deviceKind } from '../sync/auth.js';
import { checkSync3, startSync3, pushChanges, pullChanges, resolveConflict, ignoreLocal, getSync3State, localMap, fieldDiff, describeRecord, sync3ErrorMessage, SYNC3_STORES } from '../sync/sync3.js';
import { loadMaster } from '../master.js';

const when = v => { try { const d = v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : null; return d && !isNaN(d) ? d.toLocaleString('ja-JP') : '—'; } catch { return '—'; } };
const short = v => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > 140 ? s.slice(0, 140) + '…' : s; };
const FIELD_JA = { name: '名前', title: '内容', purpose: '目的', memo: 'メモ', status: '状態', body: '本文', priority: '優先度', ai: '担当AI', text: '内容', item: 'テスト名', result: '結果', version: 'Version', targetUsers: '対象ユーザー', targetDevices: '対象端末', progress: '完成度', severity: '重要度', resolution: '解決内容', code: 'コード', fileName: 'ファイル名', value: '値', changes: '変更内容', reason: '理由' };

export function mountSync3(box, ctx) {
  const S = { busy: false, check: null, error: null, panel: null, picks: {}, sel: null, msg: '' };
  const device = deviceKind();

  // この端末の未送信（ネットにつながずに数える）
  const localPending = async () => {
    const st = await getSync3State(ctx.db);
    if (!st) return null;
    const exp = await ctx.db.exportAll();
    const L = await localMap(exp);
    let n = 0, fresh = 0;
    for (const [k, x] of L) { const b = st.base?.[k]; if (b === x.hash) continue; if (!b && st.ignored?.[k] === x.hash) continue; n++; if (!b && st.preexisting?.[k]) fresh++; }
    return { n, fresh, st };
  };

  const render = async () => {
    if (!box.isConnected) return;
    const a = authState();
    if (a.status !== 'signedIn') { box.innerHTML = `<h2>PC・iPhoneの同期</h2><p class="muted">Googleにログインすると、ほかの端末と同じFactoryデータを使えます（送る・受け取るはボタンを押したときだけ）。</p>`; return; }
    const lp = await localPending();
    const st = lp?.st;
    const c = S.check;
    const started = st && (!c || c.started);
    if (!started) {
      box.innerHTML = `<h2>PC・iPhoneの同期</h2>
        <p><span class="badge">この端末はまだ同期を始めていません</span></p>
        <p class="muted">クラウドに登録済みのFactoryデータと、この端末のデータを、記録ごとに比べて同期できるようにします。始めるときは、クラウドの全件を照合し、クラウドの控えをこの端末に保存します。クラウドのデータもこの端末のデータも変わりません。</p>
        ${S.error ? errHtml(S.error) : ''}
        <button class="btn primary" id="s3-start"${S.busy ? ' disabled' : ''}>${S.busy ? '確認しています…' : '同期を始める'}</button>`;
      box.querySelector('#s3-start').onclick = start;
      return;
    }
    const d = c?.diff;
    const meta = c?.meta;
    box.innerHTML = `<h2>PC・iPhoneの同期</h2>
      <dl class="kv wide" id="s3-status">
        <dt>クラウド</dt><dd>${meta ? `<span class="badge ok">登録済み</span> 世代${esc(meta.generation ?? 1)}・${esc(c.cloud.total)}件` : '<span class="muted">「クラウドの最新を確認」で表示</span>'}</dd>
        <dt>この端末の最終同期</dt><dd>${esc(when(st.lastSyncAt || st.startedAt))}</dd>
        <dt>クラウドの最終更新</dt><dd>${meta ? `${esc(when(meta.lastUpdatedAt || meta.registeredAt))}${meta.lastUpdatedBy ? `（${esc(meta.lastUpdatedBy)}）` : meta.sourceDevice ? `（${esc(meta.sourceDevice)}）` : ''}` : '—'}</dd>
        <dt>未送信の変更</dt><dd><strong id="s3-n-push">${d ? d.counts.push : lp.n}</strong>件${(d ? d.counts.pushFresh : lp.fresh) ? `（うち同期を始める前からこの端末だけにある記録 ${d ? d.counts.pushFresh : lp.fresh}件）` : ''}</dd>
        <dt>受け取り待ち</dt><dd>${d ? `<strong id="s3-n-pull">${d.counts.pull}</strong>件` : '<span class="muted">未確認</span>'}</dd>
        <dt>競合</dt><dd>${d ? `<strong id="s3-n-conf"${d.counts.conflicts ? ' class="ng-text"' : ''}>${d.counts.conflicts}</strong>件` : '<span class="muted">未確認</span>'}</dd>
        ${d && d.counts.localDeleted ? `<dt>この端末で削除</dt><dd>${d.counts.localDeleted}件（クラウドには反映しません）</dd>` : ''}
      </dl>
      ${c ? `<p class="muted">確認日時：${esc(when(c.checkedAt))}</p>` : ''}
      ${S.msg ? `<div class="notice slim ok-notice" id="s3-msg">${esc(S.msg)}</div>` : ''}
      ${S.error ? errHtml(S.error) : ''}
      <div class="s3-actions">
        <button class="btn" id="s3-check"${S.busy ? ' disabled' : ''}>クラウドの最新を確認</button>
        <button class="btn primary" id="s3-push"${S.busy || !d || !d.counts.push ? ' disabled' : ''}>変更をクラウドへ送る${d ? `（${d.counts.push}件）` : ''}</button>
        <button class="btn primary" id="s3-pull"${S.busy || !d || !d.counts.pull ? ' disabled' : ''}>最新をこの端末へ反映${d ? `（${d.counts.pull}件）` : ''}</button>
        <button class="btn${d && d.counts.conflicts ? ' danger' : ''}" id="s3-conf"${S.busy || !d || !d.counts.conflicts ? ' disabled' : ''}>競合を確認${d ? `（${d.counts.conflicts}件）` : ''}</button>
      </div>
      ${!d ? '<p class="muted">送る・受け取る・競合の確認は、まず「クラウドの最新を確認」を押してから行います（クラウドは読むだけです）。</p>' : ''}
      <div id="s3-panel">${S.panel === 'push' ? pushHtml(d) : S.panel === 'pull' ? pullHtml(d) : S.panel === 'conf' ? confHtml(d) : ''}</div>`;
    const qs = s => box.querySelector(s);
    qs('#s3-check').onclick = () => runCheck();
    qs('#s3-push').onclick = () => { S.panel = 'push'; S.sel = new Set(d.push.filter(p => !p.fresh).map(p => p.key)); S.msg = ''; render(); };
    qs('#s3-pull').onclick = () => { S.panel = 'pull'; S.msg = ''; render(); };
    qs('#s3-conf').onclick = () => { S.panel = 'conf'; S.msg = ''; render(); };
    bindPanel();
  };

  const errHtml = e => `<div class="notice ng" role="alert" id="s3-err"><strong>${esc(e.title)}</strong><p>${esc(e.how)}</p></div>`;

  // ---- 送る ----
  const pushHtml = d => {
    if (!d || !d.push.length) return '';
    return `<section class="s3-sub" id="s3-push-panel">
      <h3>クラウドへ送る変更（${d.push.length}件）</h3>
      <p class="muted">チェックした記録だけを送ります。送る直前に、クラウドで同じ記録がほかの端末から変更されていないかを確かめます。削除はクラウドへ反映しません。</p>
      ${d.counts.pushFresh ? '<p class="muted">「同期前からある記録」は、この端末が同期を始める前からこの端末だけにあった記録です。最初はチェックを外してあります。送らない場合は「この端末だけに残す」を押すと、今後は数えません。</p>' : ''}
      <ul class="list s3-list">${d.push.map(p => { const r = describeRecord(p.store, p.rec); return `<li><label class="check"><input type="checkbox" data-push="${esc(p.key)}"${S.sel?.has(p.key) ? ' checked' : ''}><span><strong>${esc(r.storeLabel)}</strong>「${esc(r.label)}」 <span class="badge${p.kind === 'new' ? '' : ' warn'}">${p.kind === 'new' ? '新規' : '変更'}</span>${p.fresh ? ' <span class="badge">同期前からある記録</span>' : ''}<br><span class="muted">${esc(when(p.rec.updatedAt))}・${esc(p.rec.updatedBy || '')}</span></span></label></li>`; }).join('')}</ul>
      <div class="btns sticky-actions">
        <button class="btn primary" id="s3-push-go"${S.sel?.size ? '' : ' disabled'}>選んだ${S.sel?.size || 0}件をクラウドへ送る</button>
        ${d.counts.pushFresh ? '<button class="btn" id="s3-ignore">チェックしていない「同期前からある記録」をこの端末だけに残す</button>' : ''}
        <button class="btn" id="s3-close">閉じる</button>
      </div></section>`;
  };
  // ---- 受け取る ----
  const pullHtml = d => {
    if (!d || !d.pull.length) return '';
    return `<section class="s3-sub" id="s3-pull-panel">
      <h3>この端末へ反映する変更（${d.pull.length}件）</h3>
      <p class="muted">ほかの端末で変更され、クラウドにある記録です。反映の前に、この端末の控えを自動で作ります（ファイルの保存は不要）。反映後に照合し、一致しなければ控えへ戻します。</p>
      <ul class="list s3-list">${d.pull.map(p => { const r = describeRecord(p.store, p.rec); return `<li><div><strong>${esc(r.storeLabel)}</strong>「${esc(r.label)}」 <span class="badge${p.kind === 'new' ? '' : ' warn'}">${p.kind === 'new' ? '新規' : '更新'}</span><br><span class="muted">${esc(when(p.updatedAt))}・${esc(p.updatedBy || '')}${p.deviceLabel ? `（${esc(p.deviceLabel)}）` : ''}</span></div></li>`; }).join('')}</ul>
      <div class="btns sticky-actions"><button class="btn primary" id="s3-pull-go">${d.pull.length}件をこの端末へ反映</button><button class="btn" id="s3-close">閉じる</button></div></section>`;
  };
  // ---- 競合 ----
  const confHtml = d => {
    if (!d || !d.conflicts.length) return '';
    return `<section class="s3-sub" id="s3-conf-panel">
      <h3>競合（${d.conflicts.length}件）</h3>
      <p class="muted">同じ記録が、この端末とほかの端末の両方で変更されています。どちらも勝手には採用しません。1件ずつ選んでください。</p>
      ${d.conflicts.map((c, i) => {
        const r = describeRecord(c.store, c.cloud?.rec || c.local?.rec);
        const diffs = c.local ? fieldDiff(c.local.rec, c.cloud.rec) : [];
        const picks = S.picks[c.key] || {};
        return `<article class="s3-conf" data-conf="${i}">
          <h4>${esc(r.storeLabel)}「${esc(r.label)}」</h4>
          <div class="s3-versions">
            <div class="s3-ver"><h5>この端末版（${esc(device)}）</h5>${c.local ? `<p class="muted">${esc(when(c.local.rec.updatedAt))}・${esc(c.local.rec.updatedBy || '')}</p>` : '<p><span class="badge warn">この端末では削除済み</span></p>'}</div>
            <div class="s3-ver"><h5>クラウド版（${esc(c.cloud.deviceLabel || 'ほかの端末')}）</h5><p class="muted">${esc(when(c.cloud.rec.updatedAt))}・${esc(c.cloud.rec.updatedBy || '')}</p></div>
          </div>
          ${diffs.length ? `<div class="s3-fields"><p class="muted">項目ごとに、残す方を選べます（「選んだ内容で統合」で使います）。</p>${diffs.map(f => `<fieldset class="s3-field"><legend>${esc(FIELD_JA[f.field] || f.field)}</legend><div class="s3-opts">
            <label class="s3-opt"><input type="radio" name="pick-${i}-${esc(f.field)}" data-pick="${i}" data-field="${esc(f.field)}" value="local"${picks[f.field] === 'local' ? ' checked' : ''}><span class="s3-opt-h">この端末版</span><span class="s3-opt-v">${esc(short(f.local))}</span></label>
            <label class="s3-opt"><input type="radio" name="pick-${i}-${esc(f.field)}" data-pick="${i}" data-field="${esc(f.field)}" value="cloud"${picks[f.field] !== 'local' ? ' checked' : ''}><span class="s3-opt-h">クラウド版</span><span class="s3-opt-v">${esc(short(f.cloud))}</span></label>
          </div></fieldset>`).join('')}</div>` : ''}
          <div class="btns">
            ${c.local ? `<button class="btn" data-resolve="${i}" data-choice="local">この端末版を採用</button>` : `<button class="btn" data-resolve="${i}" data-choice="keepDeleted">この端末の削除を保つ</button>`}
            <button class="btn" data-resolve="${i}" data-choice="cloud">クラウド版を採用</button>
            ${diffs.length ? `<button class="btn primary" data-resolve="${i}" data-choice="merge">選んだ内容で統合</button>` : ''}
          </div></article>`;
      }).join('')}
      <div class="btns"><button class="btn" id="s3-close">閉じる</button></div></section>`;
  };

  const bindPanel = () => {
    const qs = s => box.querySelector(s);
    box.querySelectorAll('#s3-close').forEach(b => b.onclick = () => { S.panel = null; render(); });
    box.querySelectorAll('[data-push]').forEach(cb => cb.onchange = () => { if (cb.checked) S.sel.add(cb.dataset.push); else S.sel.delete(cb.dataset.push); const g = qs('#s3-push-go'); g.disabled = !S.sel.size; g.textContent = `選んだ${S.sel.size}件をクラウドへ送る`; });
    qs('#s3-push-go') && (qs('#s3-push-go').onclick = doPush);
    qs('#s3-ignore') && (qs('#s3-ignore').onclick = doIgnore);
    qs('#s3-pull-go') && (qs('#s3-pull-go').onclick = doPull);
    box.querySelectorAll('[data-pick]').forEach(r => r.onchange = () => { const c = S.check.diff.conflicts[+r.dataset.pick]; (S.picks[c.key] ||= {})[r.dataset.field] = r.value; });
    box.querySelectorAll('[data-resolve]').forEach(b => b.onclick = () => doResolve(+b.dataset.resolve, b.dataset.choice));
  };

  const busy = async (fn, label) => {
    S.busy = true; S.error = null; render();
    try { await fn(); } catch (e) { S.error = sync3ErrorMessage(e); }
    S.busy = false; await render();
    dispatchEvent(new Event('factory:sync-changed'));   // Sync-4a：お知らせの表示を更新（クラウドは読み直さない）
  };
  const runCheck = (msg = '') => busy(async () => { const r = await checkSync3(ctx.db); r.checkedAt = new Date().toISOString(); S.check = r; S.msg = msg; if (S.panel && !(r.diff && ((S.panel === 'push' && r.diff.push.length) || (S.panel === 'pull' && r.diff.pull.length) || (S.panel === 'conf' && r.diff.conflicts.length)))) S.panel = null; });
  const start = () => busy(async () => {
    const r = await startSync3(ctx.db, { deviceLabel: device, deviceId: ctx.db.device });
    toast(r.fresh ? '同期を始めました（この端末はまだクラウドのデータを受け取っていません）' : '同期を始めました');
    const c = await checkSync3(ctx.db); c.checkedAt = new Date().toISOString(); S.check = c;
    S.msg = `同期を始めました。クラウドの${r.total}件を照合し、クラウドの控えをこの端末に保存しました。`;
  });
  const doPush = async () => {
    const items = S.check.diff.push.filter(p => S.sel.has(p.key));
    const ok = await confirmDialog({ title: `${items.length}件をクラウドへ送りますか？`, body: `<p>この端末（${esc(device)}）で変更した<strong>${items.length}件</strong>をクラウドへ送ります。</p><p class="muted">ほかの端末で同じ記録が変更されていた場合は送りません。削除はクラウドへ反映しません。</p>`, ok: '送る' });
    if (!ok) return;
    await busy(async () => {
      const r = await pushChanges({ db: ctx.db, items, check: S.check, deviceLabel: device, deviceId: ctx.db.device });
      S.panel = null;
      const c = await checkSync3(ctx.db); c.checkedAt = new Date().toISOString(); S.check = c;
      S.msg = `${r.pushed}件をクラウドへ送り、照合しました（同期完了）。`;
      toast('クラウドへ送りました');
    });
  };
  const doIgnore = async () => {
    const items = S.check.diff.push.filter(p => p.fresh && !S.sel.has(p.key));
    if (!items.length) return;
    const ok = await confirmDialog({ title: `${items.length}件をこの端末だけに残しますか？`, body: '<p>クラウドへは送りません。この端末のデータは変わりません。今後は「未送信」に数えません。</p>', ok: 'この端末だけに残す' });
    if (!ok) return;
    await busy(async () => { await ignoreLocal(ctx.db, items); const c = await checkSync3(ctx.db); c.checkedAt = new Date().toISOString(); S.check = c; S.msg = `${items.length}件をこの端末だけに残しました。`; });
  };
  const doPull = async () => {
    const items = S.check.diff.pull;
    const ok = await confirmDialog({ title: `${items.length}件をこの端末へ反映しますか？`, body: `<p>クラウドにある<strong>${items.length}件</strong>（ほかの端末の変更）を、この端末へ反映します。</p><p class="muted">反映の前に、この端末の控えを自動で作ります。クラウドのデータは変わりません。</p>`, ok: '反映する' });
    if (!ok) return;
    await busy(async () => {
      const r = await pullChanges({ db: ctx.db, items, check: S.check, deviceLabel: device });
      try { await loadMaster(ctx.db); } catch {}
      S.panel = null;
      const c = await checkSync3(ctx.db); c.checkedAt = new Date().toISOString(); S.check = c;
      S.msg = `${r.applied}件をこの端末へ反映し、照合しました（同期完了）。`;
      toast('この端末へ反映しました');
    });
  };
  const doResolve = async (i, choice) => {
    const c = S.check.diff.conflicts[i];
    const r = describeRecord(c.store, c.cloud?.rec || c.local?.rec);
    const label = { local: 'この端末版を採用', cloud: 'クラウド版を採用', merge: '選んだ内容で統合', keepDeleted: 'この端末の削除を保つ' }[choice];
    const body = { local: 'この端末版をクラウドへ送ります。クラウド版は上書きされます（クラウドの変更履歴には残ります）。', cloud: 'クラウド版をこの端末へ反映します（反映前に控えを作ります）。', merge: '選んだ内容で新しい版を作り、この端末に保存してからクラウドへ送ります。', keepDeleted: 'クラウドは変えません。この端末では削除したままにします。' }[choice];
    const ok = await confirmDialog({ title: `「${r.label}」：${label}`, body: `<p>${esc(body)}</p>`, ok: label });
    if (!ok) return;
    await busy(async () => {
      await resolveConflict({ db: ctx.db, conflict: c, choice, picks: S.picks[c.key] || {}, check: S.check, deviceLabel: device, deviceId: ctx.db.device, actor: ctx.db.actor });
      delete S.picks[c.key];
      const nc = await checkSync3(ctx.db); nc.checkedAt = new Date().toISOString(); S.check = nc;
      S.msg = `「${r.label}」の競合を解決しました（${label}）。`;
      if (!nc.diff.conflicts.length) S.panel = null;
    });
  };
  render();
  return { refresh: render };
}
