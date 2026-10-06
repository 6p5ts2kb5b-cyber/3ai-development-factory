// Phase Sync-2-4：この端末への取り込み画面（クラウド → この端末の一方向）
// 「クラウドのデータに切り替える」を選んで「この端末に取り込む」を押すまで、この端末のデータは変えない。クラウドは読むだけ。
import { esc, toast, confirmDialog, downloadText } from '../ui.js';
import { initAuth, authState, deviceKind } from '../sync/auth.js';
import { checkCloudStatus } from '../sync/cloud.js';
import { loadInitialProjects } from '../seed.js';
import { analyzeForSync, fingerprint, STORE_LABELS_JA } from '../sync/dryrun.js';
import { readCloudData, localSummary, runImport, importErrorMessage, saveSnapshot, saveImportSnapshotFallback, getImportSnapshotFallback } from '../sync/pull.js';
import { getSnapshot } from '../sync/register.js';
import { loadMaster } from '../master.js';

const mb = n => `${(n / 1024 / 1024).toFixed(2)}MB`;
const WIZARD_KEY = 'factory-sync-import-wizard-v1';
const loadWizard = () => { try { return JSON.parse(localStorage.getItem(WIZARD_KEY) || '{}'); } catch { return {}; } };
const saveWizard = x => { try { localStorage.setItem(WIZARD_KEY, JSON.stringify(x)); } catch {} };
const clearWizard = () => { try { localStorage.removeItem(WIZARD_KEY); } catch {} };
const when = iso => { try { return iso ? new Date(iso).toLocaleString('ja-JP') : '不明'; } catch { return iso; } };
async function expectedNames() { try { const d = await loadInitialProjects(); return [d.factory?.name, ...d.projects.map(p => p.name)].filter(Boolean); } catch { return []; } }
export function preimportFileName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `factory-preimport-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

export async function syncImportView(ctx, view) {
  const saved = loadWizard();
  const st = { checks: null, cloud: null, cloudA: null, local: null, snapshot: null, fileSaved: !!saved.fileSaved, fileName: saved.fileName || '', fileConfirmed: !!saved.fileConfirmed, switchOk: false, busy: false, done: null, error: null, same: false, snapshotId: saved.snapshotId || null };
  const device = deviceKind();
  view.innerHTML = `<a class="back" href="#/account">← Googleログイン・同期</a>
    <h1>この端末へ取り込む</h1>
    <div class="notice slim" id="im-note">クラウドに登録されたFactoryのデータを、この端末に取り込みます（クラウド → この端末の一方向）。<strong>「クラウドのデータに切り替える」を選んで「この端末に取り込む」を押すまで、この端末のデータは変えません。</strong>クラウドのデータは変更しません。削除もしません。</div>
    <div id="im-body"></div>`;
  const body = view.querySelector('#im-body');

  const countsHtml = A => `<dl class="kv">
      <dt>プロジェクト</dt><dd><strong>${A.projects.count}件</strong></dd>
      <dt>仕様書</dt><dd>${A.main.specs}件</dd><dt>要望</dt><dd>${A.main.requests}件</dd><dt>変更履歴</dt><dd>${A.main.history}件</dd>
      <dt>その他</dt><dd>${A.otherTotal}件</dd><dt>合計</dt><dd><strong>${A.total}件</strong></dd></dl>`;

  const render = () => {
    if (!body.isConnected) return;
    if (st.done) { body.innerHTML = doneHtml(st.done, device); return; }
    const c = st.checks, C = st.cloudA, Lc = st.local;
    const checksOk = c && c.every(x => x.ok);
    const ready = checksOk && st.cloud?.ok && !st.same && st.snapshot?.ok && st.fileSaved && st.fileConfirmed && st.switchOk && !st.busy;
    body.innerHTML = `
      <section class="card" id="im-step1">
        <h2>1. 事前チェック</h2>
        <p class="muted">この端末：<strong>${esc(device)}</strong></p>
        ${c ? `<ul class="cond">${c.map(x => `<li class="${x.ok ? 'ok' : 'ng'}"><span class="mark">${x.ok ? '✅' : '⬜'}</span><div><strong>${esc(x.label)}</strong><div class="muted">${esc(x.detail)}</div></div></li>`).join('')}</ul>` : '<p>まず、クラウドの状態と取り込む内容を確認します（クラウドは読むだけです）。</p>'}
        <button class="btn${c ? '' : ' primary'}" id="im-check"${st.busy ? ' disabled' : ''}>${c ? 'もう一度確認する' : 'クラウドの内容を確認する'}</button>
        ${checksOk && st.cloud?.ok && !st.same ? '<button class="btn primary" id="im-next-backup">次へ：バックアップ</button>' : ''}
      </section>
      ${C ? `<section class="card" id="im-cloud">
        <h2>2. クラウドから取り込む内容</h2>
        <p class="muted">登録元：${esc(st.cloud.meta.sourceDevice || '不明')}・登録日時：${esc(when(st.cloud.meta.registeredAt))}・世代${esc(st.cloud.meta.generation ?? '不明')}</p>
        ${countsHtml(C)}
        <ol class="tight" id="im-names">${C.projects.names.map(n => `<li>${esc(n)}</li>`).join('')}</ol>
        <details><summary>「その他」の内訳</summary><dl class="kv">${Object.entries(C.others).map(([s, n]) => `<dt>${esc(STORE_LABELS_JA[s] || s)}</dt><dd>${n}件</dd>`).join('')}</dl></details>
        <p>${st.cloud.ok ? `<span class="badge ok">クラウドの全${st.cloud.total}件の内容を確認しました</span>` : `<span class="badge ng">クラウドの内容に問題があります（${st.cloud.problems.length}件）</span>`}</p>
        <p class="muted">データの指紋：<code class="uid">${esc(st.cloud.fingerprint.slice(0, 12))}</code></p>
      </section>` : ''}
      ${Lc ? `<section class="card" id="im-local">
        <h2>3. この端末の今のデータ</h2>
        ${Lc.isEmpty ? '<p><span class="badge">空です</span> この端末には同期の対象になるデータがありません。</p>' : `<p><span class="badge warn">データがあります（${Lc.total}件）</span> 取り込むと、この端末のデータはクラウドのデータに<strong>置き換わります</strong>。自動では置き換えません。</p>`}
        ${countsHtml(Lc.analysis)}
        ${Lc.projects.count ? `<ol class="tight">${Lc.projects.names.map(n => `<li>${esc(n)}</li>`).join('')}</ol>` : '<p class="muted">プロジェクトはありません。</p>'}
        ${st.same ? '<div class="notice slim">この端末のデータは、クラウドと同じです。取り込む必要はありません。</div>' : ''}
        <p class="muted">端末ごとの記録（設定値・自動テスト結果など）と、この端末だけの記録は、取り込んでもそのまま残ります。</p>
      </section>` : ''}
      ${Lc && !st.same ? `<section class="card" id="im-backup">
        <h2>4. この端末のデータのバックアップ（取り込みの前に必ず作ります）</h2>
        <ul class="cond">
          <li class="${st.snapshot?.ok ? 'ok' : 'ng'}"><span class="mark">${st.snapshot?.ok ? '✅' : '⬜'}</span><div><strong>端末内の控え</strong><div class="muted">${st.snapshot ? (st.snapshot.ok ? `作成して読み直しを確認しました（${esc(when(st.snapshot.at))}・${mb(st.snapshot.bytes)}）` : '作成できませんでした') : 'まだ作っていません'}</div></div></li>
          <li class="${st.fileSaved ? 'ok' : 'ng'}"><span class="mark">${st.fileSaved ? '✅' : '⬜'}</span><div><strong>バックアップファイル</strong><div class="muted">${st.fileSaved ? `「${esc(st.fileName)}」を保存しました（ダウンロードを確認してください）` : 'まだ保存していません'}</div></div></li>
        </ul>
        <button class="btn" id="im-backup-btn"${st.busy || !checksOk || !st.cloud?.ok ? ' disabled' : ''}>${st.snapshot?.ok ? '端末内の控えを作り直す' : '① 端末内の控えを作る'}</button>
        ${st.snapshot?.ok ? `<button class="btn" id="im-save-file"${st.busy ? ' disabled' : ''}>② バックアップファイルを保存する</button>` : ''}
        ${st.fileSaved ? `<label class="check big-check"><input type="checkbox" id="im-file-ok"${st.fileConfirmed ? ' checked' : ''}><span>現在のこの端末のデータをバックアップしました</span></label>` : ''}
        <p class="muted">iPhoneでは、①の端末内の控えを作ってから、②のファイル保存を行います。ファイル表示から戻っても①の状態は残ります。取り込んだ後に元に戻したいときは、このバックアップファイルを「バックアップ」画面の「バックアップから復元」で使えます。</p>
      </section>` : ''}
      ${Lc && !st.same ? `<section class="card" id="im-go-card">
        <h2>5. 取り込み</h2>
        <label class="check big-check"><input type="checkbox" id="im-switch"${st.switchOk ? ' checked' : ''}${checksOk && st.cloud?.ok ? '' : ' disabled'}><span>クラウドのデータに切り替える</span></label>
        <p class="muted">チェックすると、この端末のデータ（${Lc.total}件）が、クラウドのデータ（${st.cloud?.total ?? 0}件）に置き換わります。クラウドのデータは変わりません。Sync-3が完成するまでは、初回正本の端末だけで編集してください。</p>
        ${st.error ? `<div class="notice ng" role="alert"><strong>${esc(st.error.title)}</strong><p>${esc(st.error.how)}</p></div>` : ''}
        <button class="btn primary big" id="im-go"${ready ? '' : ' disabled'}>この端末に取り込む</button>
        ${ready ? '' : `<p class="muted" id="im-why">押せるようになる条件：${[!checksOk && '事前チェックがすべて ✅', checksOk && !st.cloud?.ok && 'クラウドの内容に問題がないこと', !st.snapshot?.ok && '端末内の控え', !st.fileSaved && 'バックアップファイルの保存', st.fileSaved && !st.fileConfirmed && '「バックアップしました」のチェック', !st.switchOk && '「クラウドのデータに切り替える」のチェック'].filter(Boolean).join('・')}</p>`}
      </section>` : ''}
      <div id="im-progress" class="rg-progress" hidden><div class="card"><h2 id="im-phase">取り込んでいます…</h2><div class="meter"><i id="im-bar" style="width:0%"></i></div><p class="muted">終わるまで、この画面を閉じないでください。途中で止まっても、この端末のデータは取り込み前のままか、自動で取り込み前に戻ります。</p></div></div>`;
    bind();
  };

  const runChecks = async () => {
    st.busy = true; st.error = null; render();
    const checks = [];
    await initAuth();
    const a = authState();
    checks.push({ label: 'Googleにログインしている', ok: a.status === 'signedIn', detail: a.status === 'signedIn' ? `${a.user?.name || ''}（${a.user?.email || ''}）` : '「Googleログイン」画面でログインしてください' });
    checks.push({ label: 'インターネットに接続している', ok: navigator.onLine, detail: navigator.onLine ? '接続しています' : '接続してから、もう一度確認してください' });
    let cloud = { state: 'signedOut' };
    if (a.status === 'signedIn' && navigator.onLine) cloud = await checkCloudStatus();
    const owner = ['empty', 'uploading', 'registered', 'unknown'].includes(cloud.state);
    checks.push({ label: 'クラウドを使う許可がある（owner）', ok: owner, detail: owner ? '許可されています' : cloud.error ? `${cloud.error.title}：${cloud.error.how}` : 'ログインしてから確認します' });
    checks.push({ label: 'クラウドが「登録済み」である', ok: cloud.state === 'registered', detail: cloud.state === 'registered' ? `登録元：${cloud.sourceDevice || '不明'}` : cloud.state === 'empty' ? 'まだ登録されていません。先に初回正本の端末で「初回正本登録」をしてください' : cloud.state === 'uploading' ? '初回登録が途中です。登録元の端末で完了させてください' : '登録済みを確認してから取り込みます' });
    st.cloud = null; st.cloudA = null;
    const expected = await expectedNames();
    if (checks.every(x => x.ok)) {
      try {
        st.cloud = await readCloudData();
        const data = Object.fromEntries(Object.entries(st.cloud.records).map(([s, l]) => [s, l.map(x => x.rec)]));
        st.cloudA = analyzeForSync({ data }, { expectedProjects: expected });
      } catch (e) { st.error = importErrorMessage(e); }
    }
    const exp = await ctx.db.exportAll();
    st.exp = exp;
    st.local = localSummary(exp, expected);
    const localFp = await fingerprint(st.local.analysis.targetsForFingerprint);
    st.same = !!(st.cloud && st.cloud.fingerprint && localFp === st.cloud.fingerprint);
    st.checks = checks;
    if (!st.snapshot && st.snapshotId) {
      try {
        let snap = await getSnapshot(st.snapshotId);
        if (!snap) snap = getImportSnapshotFallback(st.snapshotId);
        if (snap && snap.fingerprint === localFp) st.snapshot = snap;
        else { st.snapshotId = null; st.fileSaved = false; st.fileConfirmed = false; }
      } catch {}
    }
    if (st.snapshot && st.snapshot.fingerprint !== localFp) { st.snapshot = null; st.snapshotId = null; st.fileSaved = false; st.fileConfirmed = false; }
    saveWizard({ snapshotId: st.snapshot?.id || st.snapshotId || null, fileSaved: st.fileSaved, fileName: st.fileName || '', fileConfirmed: st.fileConfirmed });
    st.busy = false; render();
  };

  const makeBackup = async () => {
    st.busy = true; render();
    try {
      st.snapshot = await saveSnapshot(st.exp, { deviceKind: device });
      if (!st.snapshot?.ok) throw new Error('端末内の控えを読み直して確認できませんでした');
      st.snapshotId = st.snapshot.id;
      // iPhoneのファイル表示でIndexedDB側が失われても戻せるよう、取り込み専用の控えを別保存する。
      saveImportSnapshotFallback({ ...st.snapshot, json: JSON.stringify(st.exp) });
      st.fileSaved = false; st.fileConfirmed = false;
      st.fileName = preimportFileName();
      saveWizard({ snapshotId: st.snapshot.id, fileSaved: false, fileName: st.fileName, fileConfirmed: false });
      toast('端末内の控えを作成しました。次にバックアップファイルを保存してください');
    } catch (e) {
      st.snapshot = { ok: false }; st.snapshotId = null; st.fileSaved = false; st.fileConfirmed = false;
      saveWizard({ snapshotId: null, fileSaved: false, fileName: '', fileConfirmed: false });
      st.error = { title: '端末内の控えを作成できませんでした', how: `${e?.message || e}（この端末のデータは変えていません）` };
    }
    st.busy = false; render();
  };

  const saveBackupFile = () => {
    if (!st.snapshot?.ok || !st.exp) return;
    st.fileName = st.fileName || preimportFileName();
    // iPhoneではファイル表示へ移る前に状態を保存する。戻ってきても①の控えを失わない。
    st.fileSaved = true; st.fileConfirmed = false;
    saveWizard({ snapshotId: st.snapshot.id, fileSaved: true, fileName: st.fileName, fileConfirmed: false });
    downloadText(st.fileName, JSON.stringify(st.exp, null, 2), 'application/json');
  };

  const doImport = async () => {
    const ok = await confirmDialog({ title: 'クラウドのデータに切り替えますか？', body: `<p>この端末（${esc(device)}）のデータ<strong>${st.local.total}件</strong>を、クラウドのデータ<strong>${st.cloud.total}件</strong>（プロジェクト${st.cloudA.projects.count}件）に置き換えます。</p><p class="muted">クラウドのデータは変わりません。取り込み前のデータはバックアップから戻せます。</p>`, ok: '取り込む' });
    if (!ok) return;
    st.busy = true; st.error = null; render();
    body.querySelector('#im-progress').hidden = false;
    const label = { read: 'クラウドの内容をもう一度確認しています…', write: 'この端末に書き込んでいます…', verify: '全件を照合しています…', done: '完了しました' };
    const pct = { read: 20, write: 55, verify: 85, done: 100 };
    const guard = e => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', guard);
    try {
      const r = await runImport(ctx.db, { snapshotId: st.snapshot.id, expectedFingerprint: st.cloud.fingerprint, onProgress: ph => { const q = s => body.querySelector(s); if (q('#im-phase')) { q('#im-phase').textContent = label[ph]; q('#im-bar').style.width = `${pct[ph]}%`; } } });
      try { await loadMaster(ctx.db); } catch {}
      st.done = { ...r, names: st.cloudA.projects.names };
      clearWizard();
      toast('取り込みが完了しました');
    } catch (e) { st.error = importErrorMessage(e); }
    removeEventListener('beforeunload', guard);
    st.busy = false; render();
  };

  const bind = () => {
    const q = s => body.querySelector(s);
    q('#im-check') && (q('#im-check').onclick = runChecks);
    q('#im-next-backup') && (q('#im-next-backup').onclick = () => body.querySelector('#im-backup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    q('#im-backup-btn') && (q('#im-backup-btn').onclick = makeBackup);
    q('#im-save-file') && (q('#im-save-file').onclick = saveBackupFile);
    q('#im-file-ok') && (q('#im-file-ok').onchange = e => { st.fileConfirmed = e.target.checked; saveWizard({ snapshotId: st.snapshot?.id || st.snapshotId || null, fileSaved: st.fileSaved, fileName: st.fileName || '', fileConfirmed: st.fileConfirmed }); render(); });
    q('#im-switch') && (q('#im-switch').onchange = e => { st.switchOk = e.target.checked; render(); });
    q('#im-go') && (q('#im-go').onclick = doImport);
  };
  render();
  if (saved.snapshotId || saved.fileSaved) setTimeout(() => runChecks(), 0);
}

function doneHtml(d, device) {
  return `<section class="card" id="im-done">
    <h2>取り込みが完了しました</h2>
    <p><span class="badge ok">取り込み完了</span> この端末のデータと、クラウドのデータが一致することを確認しました（${d.checked}件）。</p>
    <dl class="kv"><dt>この端末</dt><dd>${esc(device)}</dd><dt>取り込んだ件数</dt><dd>${d.total}件</dd><dt>プロジェクト</dt><dd>${d.names.map(esc).join('、')}</dd><dt>そのまま残したもの</dt><dd>${d.kept}件（端末ごとの記録など）</dd></dl>
    <p>クラウドのデータは変更していません。Sync-3が完成するまでは、初回正本の端末だけで編集してください。</p>
    <div class="btns"><a class="btn primary" href="#/">ホームで確認する</a><a class="btn" href="#/account">Googleログイン・同期へ戻る</a></div>
  </section>`;
}
