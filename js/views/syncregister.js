// Phase Sync-2-3：初回正本登録の画面
// 「この端末を初回正本にする」を選んで「クラウドへ初回登録する」を押すまで、クラウドへは書き込まない。
import { esc, toast, confirmDialog, downloadText } from '../ui.js';
import { FactoryDB } from '../db.js';
import { initAuth, authState, deviceKind } from '../sync/auth.js';
import { checkCloudStatus } from '../sync/cloud.js';
import { loadInitialProjects } from '../seed.js';
import { analyzeForSync, STORE_LABELS_JA } from '../sync/dryrun.js';
import { buildPlan, saveSnapshot, getSnapshot, getSyncState, runRegistration, registerErrorMessage, presyncFileName, cloudAllows, readMeta } from '../sync/register.js';

const mb = n => `${(n / 1024 / 1024).toFixed(2)}MB`;
const when = iso => { try { return iso ? new Date(iso).toLocaleString('ja-JP') : ''; } catch { return iso; } };
async function expectedNames() { try { const d = await loadInitialProjects(); return [d.factory?.name, ...d.projects.map(p => p.name)].filter(Boolean); } catch { return []; } }

export async function syncRegisterView(ctx, view, { appVersion = '' } = {}) {
  const st = { checks: null, exp: null, analysis: null, plan: null, snapshot: null, fileSaved: false, fileConfirmed: false, primary: false, busy: false, done: null, error: null, resume: null };
  view.innerHTML = `<a class="back" href="#/account">← Googleログイン・同期</a>
    <h1>初回正本登録</h1>
    <div class="notice slim" id="rg-note">この端末のFactoryデータを、クラウドへ初めて登録します。<strong>「この端末を初回正本にする」を選んで「クラウドへ初回登録する」を押すまで、クラウドへは何も書き込みません。</strong>この端末のデータは変更しません。削除もしません。</div>
    <div id="rg-body"></div>`;
  const body = view.querySelector('#rg-body');
  const device = deviceKind();

  const render = () => {
    if (!body.isConnected) return;
    if (st.done) { body.innerHTML = doneHtml(st.done); return; }
    const c = st.checks;
    const A = st.analysis, P = st.plan;
    const ready = c && c.every(x => x.ok) && st.snapshot?.ok && st.fileSaved && st.fileConfirmed && st.primary && !st.busy;
    body.innerHTML = `
      <section class="card" id="rg-step1">
        <h2>1. 事前チェック</h2>
        <p class="muted">この端末：<strong>${esc(device)}</strong></p>
        ${c ? `<ul class="cond">${c.map(x => `<li class="${x.ok ? 'ok' : 'ng'}"><span class="mark">${x.ok ? '✅' : '⬜'}</span><div><strong>${esc(x.label)}</strong><div class="muted">${esc(x.detail)}</div></div></li>`).join('')}</ul>` : '<p>まず、この端末とクラウドの状態を確認します（クラウドは読むだけです）。</p>'}
        <button class="btn${c ? '' : ' primary'}" id="rg-check"${st.busy ? ' disabled' : ''}>${c ? 'もう一度確認する' : '事前チェックを始める'}</button>
      </section>
      ${A ? `<section class="card" id="rg-step2">
        <h2>2. 登録する内容</h2>
        <dl class="kv">
          <dt>プロジェクト</dt><dd><strong>${A.projects.count}件</strong></dd>
          <dt>仕様書</dt><dd>${A.main.specs}件</dd><dt>要望</dt><dd>${A.main.requests}件</dd><dt>変更履歴</dt><dd>${A.main.history}件</dd>
          <dt>その他</dt><dd>${A.otherTotal}件</dd><dt>合計</dt><dd><strong>${A.total}件</strong></dd>
        </dl>
        <ol class="tight" id="rg-names">${A.projects.names.map(n => `<li>${esc(n)}</li>`).join('')}</ol>
        <details><summary>「その他」の内訳</summary><dl class="kv">${Object.entries(A.others).map(([s, n]) => `<dt>${esc(STORE_LABELS_JA[s] || s)}</dt><dd>${n}件</dd>`).join('')}</dl></details>
        ${P?.chunked ? `<p class="muted">大きい記録 ${P.chunked}件は分割して送ります。</p>` : ''}
        ${A.privacy.length ? `<p class="muted">個人情報らしき記述：${A.privacy.length}種類（<a href="#/sync-check">予行演習の画面</a>で確認できます。止めはしません）</p>` : ''}
      </section>` : ''}
      ${A ? `<section class="card" id="rg-step3">
        <h2>3. バックアップ（登録の直前に必ず作ります）</h2>
        <ul class="cond">
          <li class="${st.snapshot?.ok ? 'ok' : 'ng'}"><span class="mark">${st.snapshot?.ok ? '✅' : '⬜'}</span><div><strong>端末内の控え</strong><div class="muted">${st.snapshot ? (st.snapshot.ok ? `作成して読み直しを確認しました（${esc(when(st.snapshot.at))}・${mb(st.snapshot.bytes)}）` : '作成できませんでした') : 'まだ作っていません'}</div></div></li>
          <li class="${st.fileSaved ? 'ok' : 'ng'}"><span class="mark">${st.fileSaved ? '✅' : '⬜'}</span><div><strong>バックアップファイル</strong><div class="muted">${st.fileSaved ? `「${esc(st.fileName)}」を保存しました（ダウンロードを確認してください）` : 'まだ保存していません'}</div></div></li>
        </ul>
        <button class="btn" id="rg-backup"${st.busy || !(c && c.every(x => x.ok)) ? ' disabled' : ''}>${st.snapshot ? 'バックアップを作り直す' : 'バックアップを作成する'}</button>
        ${st.fileSaved ? `<label class="check big-check"><input type="checkbox" id="rg-file-ok"${st.fileConfirmed ? ' checked' : ''}><span>バックアップファイルが保存されたことを確認しました</span></label>` : ''}
      </section>` : ''}
      ${A ? `<section class="card" id="rg-step4">
        <h2>4. 初回正本の決定と登録</h2>
        <label class="check big-check"><input type="checkbox" id="rg-primary"${st.primary ? ' checked' : ''}${c && c.every(x => x.ok) ? '' : ' disabled'}><span>この端末（${esc(device)}）を初回正本にする</span></label>
        <p class="muted">チェックすると、この端末のデータ（上の${A.total}件）がクラウドの最初のデータになります。Sync-3が完成するまでは、この端末だけで編集してください。</p>
        ${st.error ? `<div class="notice ng" role="alert"><strong>${esc(st.error.title)}</strong><p>${esc(st.error.how)}</p></div>` : ''}
        <button class="btn primary big" id="rg-go"${ready ? '' : ' disabled'}>${st.resume ? 'もう一度送る（続きから）' : 'クラウドへ初回登録する'}</button>
        ${ready ? '' : `<p class="muted" id="rg-why">押せるようになる条件：${[!(c && c.every(x => x.ok)) && '事前チェックがすべて ✅', !st.snapshot?.ok && '端末内の控え', !st.fileSaved && 'バックアップファイルの保存', st.fileSaved && !st.fileConfirmed && '保存の確認のチェック', !st.primary && '「この端末を初回正本にする」のチェック'].filter(Boolean).join('・')}</p>`}
      </section>` : ''}
      <div id="rg-progress" class="rg-progress" hidden><div class="card"><h2 id="rg-phase">送信しています…</h2><div class="meter"><i id="rg-bar" style="width:0%"></i></div><p id="rg-count" class="muted"></p><p class="muted">終わるまで、この画面を閉じないでください。途中で止まっても、この端末のデータは変わりません。</p></div></div>`;
    bind();
  };

  const runChecks = async () => {
    st.busy = true; st.error = null; render();
    const checks = [];
    await initAuth();
    const a = authState();
    checks.push({ key: 'login', label: 'Googleにログインしている', ok: a.status === 'signedIn', detail: a.status === 'signedIn' ? `${a.user?.name || ''}（${a.user?.email || ''}）` : '「Googleログイン」画面でログインしてください' });
    checks.push({ key: 'online', label: 'インターネットに接続している', ok: navigator.onLine, detail: navigator.onLine ? '接続しています' : '接続してから、もう一度確認してください' });
    let cloud = { state: 'signedOut' };
    if (a.status === 'signedIn' && navigator.onLine) cloud = await checkCloudStatus();
    const owner = ['empty', 'uploading', 'registered', 'unknown'].includes(cloud.state);
    checks.push({ key: 'owner', label: 'クラウドを使う許可がある（owner）', ok: owner, detail: owner ? '許可されています' : cloud.error ? `${cloud.error.title}：${cloud.error.how}` : 'ログインしてから確認します' });
    let allow = { ok: false, reason: '' };
    if (owner) allow = cloudAllows(cloud.state === 'uploading' ? { ...cloud, raw: { sourceDeviceId: cloud.raw?.sourceDeviceId } } : cloud, ctx.db.device);
    if (owner && cloud.state === 'uploading') { try { const m = await readMeta(); allow = cloudAllows(m, ctx.db.device); } catch { allow = { ok: false, reason: '確認できませんでした' }; } }
    st.resume = allow.ok && allow.resume ? allow : null;
    checks.push({ key: 'cloud', label: 'クラウドがまだ空である', ok: owner && allow.ok, detail: !owner ? '許可を確認してから確かめます' : cloud.state === 'empty' ? 'まだ何も登録されていません' : st.resume ? 'この端末からの登録が途中です（続きから送れます）' : allow.reason });
    const exp = await ctx.db.exportAll();
    const expected = await expectedNames();
    const A = analyzeForSync(exp, { master: null, expectedProjects: expected, checkBackup: j => FactoryDB.checkBackup(j) });
    const eightOk = A.projects.count > 0 && expected.length > 0 && !A.projects.missing.length && !A.projects.dupNames.length;
    checks.push({ key: 'projects', label: 'この端末にPhase 7の8プロジェクトがそろっている', ok: eightOk, detail: eightOk ? `${A.projects.count}件（重複なし）` : A.projects.missing.length ? `見つからないもの：${A.projects.missing.join('、')}` : A.projects.dupNames.length ? `同じ名前があります：${A.projects.dupNames.join('、')}` : 'プロジェクトがありません' });
    checks.push({ key: 'backupable', label: 'バックアップを作成できる', ok: A.backup.ok, detail: A.backup.ok ? `作成できます（${mb(A.backup.bytes)}）` : A.backup.reason });
    st.checks = checks; st.exp = exp; st.analysis = A; st.expected = expected; st.plan = await buildPlan(exp, { expectedProjects: expected });
    if (st.snapshot && st.snapshot.fingerprint !== st.plan.fingerprint) { st.snapshot = null; st.fileSaved = false; st.fileConfirmed = false; }
    st.busy = false; render();
  };

  const makeBackup = async () => {
    st.busy = true; render();
    try {
      st.snapshot = await saveSnapshot(st.exp, { deviceKind: device });
      st.fileName = presyncFileName();
      downloadText(st.fileName, JSON.stringify(st.exp, null, 2), 'application/json');
      st.fileSaved = true; st.fileConfirmed = false;
      toast('バックアップを作成しました');
    } catch (e) { st.snapshot = { ok: false }; st.error = { title: 'バックアップを作成できませんでした', how: `${e?.message || e}（クラウドへは何も送っていません）` }; }
    st.busy = false; render();
  };

  const register = async () => {
    const A = st.analysis;
    const ok = await confirmDialog({ title: 'クラウドへ初回登録しますか？', body: `<p>この端末（${esc(device)}）を<strong>初回正本</strong>にして、プロジェクト${A.projects.count}件を含む<strong>${A.total}件</strong>をクラウドへ登録します。</p><p class="muted">この端末のデータは変更しません。途中で止まっても、続きから送れます。</p>`, ok: '登録する' });
    if (!ok) return;
    st.busy = true; st.error = null; render();
    const box = body.querySelector('#rg-progress'); box.hidden = false;
    const phaseName = { check: 'クラウドの状態を確認しています…', upload: '送信しています…', verify: '全件を照合しています…', done: '完了しました' };
    const guard = e => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', guard);
    try {
      const snap = await getSnapshot(st.snapshot.id);
      const exp = JSON.parse(snap.json);
      const plan = await buildPlan(exp, { expectedProjects: st.expected });
      if (plan.fingerprint !== st.plan.fingerprint) throw Object.assign(new Error('バックアップの後にデータが変わりました。事前チェックからやり直してください'), { code: 'not-allowed' });
      const r = await runRegistration({ plan, snapshotId: snap.id, deviceId: ctx.db.device, deviceLabel: device, appVersion, schemaVersion: exp.schemaVersion, onProgress: (ph, d, t) => {
        const q = s => body.querySelector(s); if (!q('#rg-phase')) return;
        q('#rg-phase').textContent = phaseName[ph] || ''; q('#rg-bar').style.width = `${t ? Math.round(d / t * 100) : 0}%`; q('#rg-count').textContent = ph === 'upload' ? `${d} / ${t}` : '';
      } });
      st.done = { ...r, total: plan.total, names: plan.projectNames, device };
      toast('初回登録が完了しました');
    } catch (e) {
      st.error = registerErrorMessage(e);
      try { const m = await readMeta(); const al = cloudAllows(m, ctx.db.device); st.resume = al.ok && al.resume ? al : null; } catch {}
    }
    removeEventListener('beforeunload', guard);
    st.busy = false; render();
  };

  const bind = () => {
    const q = s => body.querySelector(s);
    q('#rg-check') && (q('#rg-check').onclick = runChecks);
    q('#rg-backup') && (q('#rg-backup').onclick = makeBackup);
    q('#rg-file-ok') && (q('#rg-file-ok').onchange = e => { st.fileConfirmed = e.target.checked; render(); });
    q('#rg-primary') && (q('#rg-primary').onchange = e => { st.primary = e.target.checked; render(); });
    q('#rg-go') && (q('#rg-go').onclick = register);
  };
  render();
}

function doneHtml(d) {
  return `<section class="card" id="rg-done">
    <h2>初回登録が完了しました</h2>
    <p><span class="badge ok">登録済み</span> クラウドのデータと、この端末のデータが一致することを確認しました（${d.checked}件）。</p>
    <dl class="kv"><dt>初回正本</dt><dd>${esc(d.device)}</dd><dt>登録した件数</dt><dd>${d.total}件</dd><dt>プロジェクト</dt><dd>${d.names.map(esc).join('、')}</dd></dl>
    <p>この端末のデータは変更していません。Sync-3が完成するまでは、この端末だけで編集してください。</p>
    <div class="btns"><a class="btn" href="#/account">Googleログイン・同期へ戻る</a><a class="btn" href="#/">ホームへ</a></div>
  </section>`;
}