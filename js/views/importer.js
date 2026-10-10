// Phase 7：既存アプリ取込タブ
// 既存アプリはゼロから作り直さない。現在の状態を取り込み → 基準Versionとして記録 → 確定仕様と照合 → 必要な改良だけ要望箱へ → 次Versionで改良。
// Factoryは既存のコードを変更しない。URL・コードは利用者が登録したものだけを保存する（推測しない）。
import { esc, fmtDate, toast, errorHtml, options, confirmDialog } from '../ui.js';
import { label } from '../master.js';
import { specItems, coverageSummary } from '../logic.js';
import { parseProposal, matchProposal, planImport, proposalSummary, buildCoverage, IMPORT_LIMITS } from '../covimport.js';
import { downloadBackup } from '../backup.js';

// 判定候補JSONの反映結果（画面を描き直しても表示するため。端末には保存しない）
const lastImportResult = new Map();
const sumText = (m, s) => (m.coverageStatuses || []).filter(x => x.key !== 'unjudged').map(x => `${x.label}${s[x.key] || 0}`).concat(`未判定${s.unjudged || 0}`).join('・');

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
        <div class="btns"><button class="btn primary">保存</button><button type="button" class="btn" id="ex-done">${imported ? '基準Versionを記録し直す' : '取込を完了（基準Versionとして記録）'}</button>${!imported ? '<button type="button" class="btn" id="ex-origin-new">既存アプリなし（新しく作る）に戻す</button>' : ''}</div>
      </form>
    </section>
    <section class="card" id="cov-card">
      <h2>確定仕様 ${esc(spec?.version || '')} との照合</h2>
      ${!spec ? '<p class="muted">確定仕様がありません。仕様書タブで確定すると照合できます。</p>' : `
      <p class="muted">仕様の各項目が今のアプリでどうなっているかを選んでください。仕様と違っていても<strong>コードは変更しません</strong>。差分は改良候補として管理します。</p>
      ${lastImportResult.has(p.id) ? (r => `<div class="notice ${r.ok ? 'ok-notice' : 'ng'}" id="ci-result" role="status"><strong>${r.ok ? '判定候補JSONを反映しました' : '反映後の確認で問題が見つかりました'}</strong><p>未判定へ反映 ${r.applied}件・上書き ${r.overwritten}件・既存の判定を保持 ${r.kept}件</p><p>JSONの判定：${esc(r.expectedText)}<br>反映後のFactory：${esc(r.actualText)}${r.equal ? '（JSONの判定と一致）' : '（既存の判定を保持した項目があるため、JSONと違う項目があります）'}</p>${r.bad.length ? `<p class="err-text">反映した判定と違う項目：${r.bad.map(esc).join('、')}</p>` : ''}<p class="muted">JSONの判定は暫定（実機動作確認済みではありません）。各項目のメモに根拠を記録しました。</p></div>`)(lastImportResult.get(p.id)) : ''}
      <div class="btns row" id="ci-open-row"><button type="button" class="btn" id="ci-open">JSONから判定候補を読み込み</button><input type="file" id="ci-file" accept=".json,application/json" hidden></div>
      <div id="ci-panel"></div>
      <div class="sum-chips"><span class="chip add">実装済み ${sum.done}</span><span class="chip chg">一部 ${sum.partial}</span><span class="chip del">未実装 ${sum.todo}</span><span class="chip del">仕様と違う ${sum.diff}</span><span class="chip">未判定 ${sum.unjudged}</span></div>
      ${heads.map(h => `<h3>${esc(h)}</h3><ul class="list cov">${items.filter(i => i.head === h).map(i => { const c = cov[i.key] || {}; const pick = ['partial', 'todo', 'diff'].includes(c.status) && !c.requestId; return `<li>
        ${pick ? `<label class="pick"><input type="checkbox" data-cov-pick="${esc(i.key)}" aria-label="改良候補に選ぶ"></label>` : '<span class="pick"></span>'}
        <div class="grow"><span>${esc(i.text)}</span>${c.imported ? ' <span class="badge">判定候補JSON・暫定</span>' : ''}${c.memo ? `<div class="muted cov-memo">${esc(c.memo.length > 160 ? c.memo.slice(0, 160) + '…' : c.memo)}</div>` : ''}${c.requestId ? '<div class="ok-note">要望箱へ送り済み</div>' : ''}</div>
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
  const backToNew = el.querySelector('#ex-origin-new');
  if (backToNew) backToNew.onclick = async () => {
    await db.setOrigin(p.id, 'new');
    toast('「既存アプリなし（新しく作る）」に戻しました');
    location.hash = `#/p/${encodeURIComponent(p.id)}`;
  };
  if (spec) bindCoverageImport({ ctx, el, p, spec, items, cov });
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

// ---- 判定候補JSONの一括反映（v1.1.0） ----
const ACTION_LABEL = { apply: '反映（未判定へ）', overwrite: '上書きする', keep: '既存の判定を保持', same: '同じ判定（変更なし）', none: '変更なし（JSONも未判定）', blocked: '要手動対応・未反映', mismatch: '対応できない・未反映' };
const ACTION_CLASS = { apply: 'ok', overwrite: 'warn', keep: '', same: '', none: '', blocked: 'warn', mismatch: 'ng' };
function bindCoverageImport({ ctx, el, p, spec, items, cov }) {
  const m = ctx.master, db = ctx.db;
  const box = el.querySelector('#ci-panel'), fileIn = el.querySelector('#ci-file');
  let st = null;   // { data, rows, confirmed, overwrite, rev }
  const close = () => { st = null; box.innerHTML = ''; fileIn.value = ''; el.querySelector('#ci-open').disabled = false; };
  el.querySelector('#ci-open').onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0]; if (!f) return;
    lastImportResult.delete(p.id); el.querySelector('#ci-result')?.remove();
    if (f.size > IMPORT_LIMITS.maxBytes) { showErrors([`ファイルが大きすぎます（${Math.round(f.size / 1024)}KB。上限 ${IMPORT_LIMITS.maxBytes / 1024}KB）`]); return; }
    let text = ''; try { text = await f.text(); } catch { showErrors(['ファイルを読めませんでした']); return; }
    const parsed = parseProposal(text, { bytes: f.size });
    if (!parsed.ok) { showErrors(parsed.errors); return; }
    const match = matchProposal(parsed.data, { projectName: p.name, specVersion: spec.version, items });
    if (!match.ok) { showErrors(match.errors); return; }
    const fresh = await db.get('projects', p.id);
    st = { data: parsed.data, rows: match.rows, confirmed: new Set(), overwrite: new Set(), rev: fresh?.rev || 0, coverage: fresh?.existing?.coverage || {}, fileName: f.name };
    render();
  };
  const showErrors = errs => {
    box.innerHTML = `<div class="notice ng" id="ci-errors" role="alert"><strong>このJSONは読み込めません（何も変更していません）</strong><ul class="error-list">${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
    fileIn.value = '';
  };
  const render = () => {
    const plan = planImport(st.rows, st.coverage, { confirmed: st.confirmed, overwrite: st.overwrite });
    const expected = proposalSummary(st.data);
    const after = coverageSummary(items, buildCoverage(st.coverage, plan, { source: st.fileName, generatedOn: st.data.generatedOn }));
    const c = plan.counts;
    const n = c.apply + c.overwrite;
    el.querySelector('#ci-open').disabled = true;
    box.innerHTML = `<section class="ci-review" id="ci-review">
      <h3>判定候補の確認（まだ保存していません）</h3>
      <dl class="kv wide"><dt>ファイル</dt><dd>${esc(st.fileName)}</dd><dt>プロジェクト</dt><dd>${esc(st.data.projectName)}</dd><dt>確定仕様</dt><dd>${esc(st.data.specVersion)}（Factoryの確定仕様と一致）</dd><dt>作成日</dt><dd>${esc(st.data.generatedOn || '不明')}</dd></dl>
      <p class="hint">JSONの判定は<strong>暫定</strong>です（${esc(st.rows[0]?.rec.verification || '判定の方法の記載なし')}）。実機で動作を確認したという意味ではありません。</p>
      <div class="sum-chips" id="ci-counts"><span class="chip add">対応済み ${c.matched}</span><span class="chip${c.blocked ? ' chg' : ''}">要手動対応 ${c.blocked}</span><span class="chip${c.mismatch ? ' del' : ''}">対応できない ${c.mismatch}</span><span class="chip">既存判定あり ${c.existing}</span><span class="chip${c.overwrite ? ' chg' : ''}">上書き対象 ${c.overwrite}／${c.overwritable}</span><span class="chip add">反映する ${n}</span></div>
      <p id="ci-expected">JSONの判定：<strong>${esc(sumText(m, expected))}</strong><br>反映後のFactory（予定）：<strong>${esc(sumText(m, after))}</strong></p>
      <ol class="list ci-rows">${plan.rows.map(r => `<li class="ci-row ci-${r.action}" data-ci-row="${r.rec.number}"><div class="grow">
        <div><b>${r.rec.number}.</b> JSON：${esc(r.rec.label)} <span class="badge">${esc(r.rec.assessment)}</span></div>
        <div class="muted">→ Factory［${esc(r.item.head)}］${esc(r.item.text)} <span class="badge">名前の一致 ${Math.round(r.score * 100)}%</span></div>
        ${r.state === 'ambiguous' ? `<div class="warn-note">「［${esc(r.alt.item.head)}］${esc(r.alt.item.text)}」（${r.alt.number}番）の方が名前が似ています（${Math.round(r.alt.score * 100)}%）。${r.rec.number}番の項目で正しいか確認してください。</div><label class="check"><input type="checkbox" data-ci-confirm="${r.rec.number}"${st.confirmed.has(r.rec.number) ? ' checked' : ''}><span>${r.rec.number}番の項目への対応で正しい（確認しました）</span></label>` : ''}
        ${r.state === 'mismatch' ? '<div class="err-text">項目名が合いません。番号だけでは対応させません（未反映）</div>' : ''}
        ${r.judged ? `<div>既存の判定：<strong>${esc(label(m, 'coverageStatuses', r.exStatus))}</strong>${r.existing?.memo ? '・メモあり' : ''}</div>` : ''}
        ${r.judged && r.rec.status !== 'unjudged' && r.exStatus !== r.rec.status && r.state !== 'mismatch' ? `<label class="check"><input type="checkbox" data-ci-over="${r.rec.number}"${st.overwrite.has(r.rec.number) ? ' checked' : ''}><span>「${esc(label(m, 'coverageStatuses', r.rec.status))}」で上書きする（メモは残す）</span></label>` : ''}
        ${r.rec.pii ? '<div class="warn-note">根拠の文章に個人情報らしき内容があるため、根拠は保存しません</div>' : ''}
        </div><span class="badge ${ACTION_CLASS[r.action]}">${esc(ACTION_LABEL[r.action])}</span></li>`).join('')}</ol>
      ${c.blocked || c.mismatch ? `<div class="notice warn slim" id="ci-stop">${c.mismatch ? `対応できない行が ${c.mismatch}件あるため、反映できません（件数を無理に合わせません）。JSONの内容を確認してください。` : `要手動対応の行が ${c.blocked}件あります。内容を確認して「対応で正しい」にチェックするまで、反映できません。`}</div>` : ''}
      <div class="btns">
        <button type="button" class="btn" id="ci-backup">先にバックアップを保存（おすすめ）</button>
        <button type="button" class="btn primary" id="ci-apply"${plan.canApply ? '' : ' disabled'}>${st.rows.length}項目の反映を確定（${n}件を保存）</button>
        <button type="button" class="btn" id="ci-cancel">取り消す（保存しない）</button>
      </div>
    </section>`;
    box.querySelectorAll('[data-ci-confirm]').forEach(x => x.onchange = () => { const k = Number(x.dataset.ciConfirm); x.checked ? st.confirmed.add(k) : st.confirmed.delete(k); render(); });
    box.querySelectorAll('[data-ci-over]').forEach(x => x.onchange = () => { const k = Number(x.dataset.ciOver); x.checked ? st.overwrite.add(k) : st.overwrite.delete(k); render(); });
    box.querySelector('#ci-cancel').onclick = () => { close(); toast('取り消しました（何も保存していません）'); };
    box.querySelector('#ci-backup').onclick = async () => { try { await downloadBackup(db); st.backedUp = true; toast('バックアップを保存しました'); } catch (e) { toast(`バックアップを保存できませんでした：${e.message || e}`); } };
    box.querySelector('#ci-apply').onclick = async () => {
      const plan2 = planImport(st.rows, st.coverage, { confirmed: st.confirmed, overwrite: st.overwrite });
      if (!plan2.canApply) return;
      const k = plan2.counts;
      const ok = await confirmDialog({ title: `${st.rows.length}項目の反映を確定しますか？`, body: `<p>未判定の項目へ <strong>${k.apply}件</strong> 反映します。${k.overwrite ? `選んだ <strong>${k.overwrite}件</strong> を上書きします（メモは残します）。` : ''}既存の判定 ${k.keep}件はそのまま残します。</p>${st.backedUp ? '' : '<p class="warn-note">まだバックアップを保存していません。「キャンセル」で戻って保存できます。</p>'}<p class="muted">判定は暫定として記録します。保存に失敗した場合は、何も変更しません。</p>`, ok: '反映を確定' });
      if (!ok) return;
      const next = buildCoverage(st.coverage, plan2, { source: st.fileName, generatedOn: st.data.generatedOn });
      try {
        await db.applyCoverageImport(p.id, { expectedRev: st.rev, specVersion: spec.version, coverage: next, applied: k.apply, overwritten: k.overwrite, source: st.fileName });
      } catch (e) { box.insertAdjacentHTML('afterbegin', errorHtml(e)); return; }
      // 反映後の確認：保存されたデータを読み直し、反映した行がJSONの判定どおりか確かめる
      const saved = (await db.get('projects', p.id))?.existing?.coverage || {};
      const bad = plan2.rows.filter(r => (r.action === 'apply' || r.action === 'overwrite') && saved[r.item.key]?.status !== r.rec.status).map(r => `${r.rec.number}.${r.rec.label}`);
      const expected = proposalSummary(st.data), actual = coverageSummary(items, saved);
      lastImportResult.set(p.id, { ok: !bad.length, bad, applied: k.apply, overwritten: k.overwrite, kept: k.keep, expectedText: sumText(m, expected), actualText: sumText(m, actual), equal: ['done', 'partial', 'todo', 'diff', 'unjudged'].every(x => (expected[x] || 0) === (actual[x] || 0)) });
      toast(bad.length ? '反映後の確認で問題が見つかりました' : `${k.apply + k.overwrite}件を反映しました`);
      st = null; ctx.refresh();
    };
  };
}
