// Phase Sync-1：Googleログイン画面（ログインの確認だけ。Factoryのデータは送受信しない）
// Phase Sync-2-1：クラウドの状態を確認（「登録済みの印」を1件読むだけ。書き込みなし）
import { esc, toast, copyText } from '../ui.js';
import { initAuth, onAuth, signIn, signOut, deviceKind, envInfo, FIREBASE_SDK_VERSION } from '../sync/auth.js';
import { checkCloudStatus } from '../sync/cloud.js';
import { mountSync3 } from './sync3view.js';
import { getNoticePref, setNoticePref } from '../sync/notice.js';
import { fillNotice } from './noticebar.js';

const NOTE = 'PCとiPhoneで同じFactoryデータを使えます（Sync-3：ボタンを押したときだけ同期）。クラウドへ送る・この端末へ反映するのは、件数と内容を確認してボタンを押したときだけです。削除はクラウドへ反映しません。';

export async function accountView(view, ctx) {
  view.innerHTML = `<h1>Googleログイン</h1>
    <div class="notice slim" id="acc-note">${esc(NOTE)}</div>
    <section class="card" id="acc-card"><p class="muted">確認しています…</p></section>
    <div data-sync-notice="account" class="sn-slot"></div>
    <section class="card" id="sync3-card"></section>
    <section class="card" id="notice-card">
      <h2>同期のお知らせ</h2>
      <label class="check"><input type="checkbox" id="notice-on"><span>Factoryを開いたときに「受け取り待ち」「未送信」を知らせる</span></label>
      <p class="muted">クラウドの「登録済みの印」を1件読むだけです（記録の中身は読みません）。自動で送る・受け取ることはしません。オフライン・未ログインのときは、この端末の未送信の数だけを表示します。この設定はこの端末だけのものです。</p>
    </section>
    <h2 class="section-title">初回セットアップ・災害復旧用</h2>
    <p class="muted">ふだんの同期は上の「PC・iPhoneの同期」を使います。下は、新しい端末の最初の準備や、もしものときの復旧に使います。</p>
    <section class="card" id="cloud-card">
      <h2>クラウドの状態（読み取りのみ）</h2>
      <p class="muted">クラウドにある「登録済みの印」を1件読むだけです。Factoryのデータは送りません・受け取りません。結果はこの画面に表示するだけで、端末には保存しません。</p>
      <div id="cloud-result"><p><span class="badge">まだ確認していません</span></p></div>
      <button class="btn" id="cloud-check" disabled>クラウドの状態を確認</button>
      <p class="muted" id="cloud-hint">Googleにログインすると確認できます。</p>
      <p class="muted">複数の端末で同じデータを使う同期（初回登録・取り込み）は、段階ごとに追加します。</p>
    </section>
    <section class="card" id="dry-card">
      <h2>同期の予行演習（確認だけ）</h2>
      <p class="muted">初回登録で何を何件送ることになるかを、この端末について調べます。クラウドへは送りません。ログインしていなくても確認できます。</p>
      <a class="btn" href="#/sync-check">同期の予行演習を開く</a>
    </section>
    <section class="card" id="reg-card">${regCardHtml({ state: 'unchecked' })}</section>`;
  // Sync-4a：お知らせのオン・オフ（この端末だけ）
  const nOn = view.querySelector('#notice-on');
  getNoticePref().then(p => { nOn.checked = p.enabled; }).catch(() => {});
  nOn.onchange = async () => { await setNoticePref(nOn.checked); toast(nOn.checked ? 'お知らせをオンにしました' : 'お知らせをオフにしました（同期はボタンでいつでもできます）'); fillNotice(ctx, { force: nOn.checked }); };
  const card = view.querySelector('#acc-card');
  let busy = false;
  const render = s => {
    if (!view.isConnected || !card.isConnected) return;
    const err = s.error ? `<div class="notice ng" role="alert"><strong>${esc(s.error.title)}</strong><p>${esc(s.error.how)}</p></div>` : '';
    const dev = `<p class="muted">この端末：${esc(deviceKind())}</p>`;
    if (s.status === 'loading') { card.innerHTML = '<p class="muted">確認しています…</p>'; return; }
    if (s.status === 'unconfigured') {
      card.innerHTML = `<h2>ログインの準備中</h2><p><span class="badge warn">Firebaseの設定待ち</span></p>
        <p>${esc(s.reason || 'Firebaseの設定がまだです')}。Firebaseの設定が終わると、ここから「Googleでログイン」できるようになります。</p>${dev}`;
      return;
    }
    if (s.status === 'error' && !s.user) {
      card.innerHTML = `<h2>ログイン</h2>${err}<button class="btn" id="acc-retry">もう一度読み込む</button>${dev}`;
      card.querySelector('#acc-retry').onclick = () => location.reload();
      return;
    }
    if (s.status === 'signedIn' && s.user) {
      card.innerHTML = `<h2>ログイン中</h2><p><span class="badge ok">ログインできています</span></p>
        <dl class="kv wide"><dt>名前</dt><dd>${esc(s.user.name || '（なし）')}</dd><dt>Googleアカウント</dt><dd>${esc(s.user.email || '（表示なし）')}</dd>
        <dt>ユーザーID</dt><dd><code class="uid">${esc(s.user.uid)}</code> <button class="btn small" id="acc-copy-uid">コピー</button></dd></dl>
        <p class="muted">ユーザーIDは、後で「自分のアカウントだけが使える」設定をするときに使います（メールアドレスはアプリにもGitHubにも保存しません）。</p>
        ${err}${dev}
        <div class="btns"><button class="btn" id="acc-out">ログアウト</button></div>`;
      card.querySelector('#acc-out').onclick = async () => { if (busy) return; busy = true; await signOut(); busy = false; toast('ログアウトしました（この端末のデータはそのままです）'); };
      card.querySelector('#acc-copy-uid').onclick = async () => { await copyText(s.user.uid); toast('ユーザーIDをコピーしました'); };
      return;
    }
    const env = envInfo();
    const iosNote = env.ios ? `<p class="muted">iPhoneでは、Googleの画面が別に開きます。アカウントを選んだら、Factoryの画面に戻ってください。${env.standalone ? 'ホーム画面版でうまくいかない場合は、SafariでFactoryを開いて試してください。' : ''}</p>` : '';
    card.innerHTML = `<h2>ログイン</h2><p><span class="badge">未ログイン</span></p>
      <p>同じGoogleアカウントで各端末にログインできるか確認します。</p>
      ${navigator.onLine ? '' : '<div class="notice warn slim">インターネットに接続していません。接続するとログインできます。</div>'}
      ${err}
      ${s.pending ? '<div class="notice slim" id="acc-pending">Googleの画面でアカウントを選んでください…（終わるとここが「ログイン中」に変わります）</div>' : ''}
      <button class="btn primary big" id="acc-in"${s.pending ? ' disabled' : ''}>${s.pending ? 'Googleの画面を開いています…' : 'Googleでログイン'}</button>${iosNote}${dev}`;
    card.querySelector('#acc-in').onclick = () => {
      if (busy) return; busy = true;
      // ポップアップはボタンを押した直後に開く必要があるため、ここでは待たずにすぐ呼ぶ
      signIn().then(r => { busy = false; if (r.status === 'signedIn') toast('ログインしました（データの同期はまだ行いません）'); });
    };
  };
  // クラウドの状態（Sync-2-1）
  const cBtn = view.querySelector('#cloud-check'), cRes = view.querySelector('#cloud-result'), cHint = view.querySelector('#cloud-hint');
  const cloudAuth = s => { if (!cBtn.isConnected) return; const ok = s.status === 'signedIn'; if (!cBtn.dataset.busy) cBtn.disabled = !ok; cHint.hidden = ok; };
  cBtn.onclick = async () => {
    cBtn.dataset.busy = '1'; cBtn.disabled = true; cBtn.textContent = '確認しています…';
    const r = await checkCloudStatus();
    delete cBtn.dataset.busy; cBtn.disabled = false; cBtn.textContent = 'もう一度確認';
    if (cRes.isConnected) cRes.innerHTML = cloudResultHtml(r);
    const rc = view.querySelector('#reg-card'); if (rc) rc.innerHTML = regCardHtml(r);
  };
  // ログイン中なら、開いたときに一度だけクラウドの状態を読む（読むのは「登録済みの印」1件だけ）
  let autoChecked = false;
  const autoCheck = s => { if (autoChecked || s.status !== 'signedIn' || !navigator.onLine || !cBtn.isConnected) return; autoChecked = true; setTimeout(() => { if (cBtn.isConnected && !cBtn.dataset.busy) cBtn.click(); }, 0); };
  const offAuto = onAuth(autoCheck);
  const offCloud0 = onAuth(cloudAuth);
  const offCloud = () => { offCloud0(); offAuto(); };
  const off0 = onAuth(render);
  // Sync-3：PC・iPhoneの同期の欄（ログイン状態が変わったら表示を更新）
  let s3 = null, lastStatus = null;
  const s3box = view.querySelector('#sync3-card');
  const offS3 = ctx ? onAuth(a => { if (a.status === lastStatus) return; lastStatus = a.status; if (!s3) s3 = mountSync3(s3box, ctx); else s3.refresh(); }) : () => {};
  const off = () => { off0(); offCloud(); offS3(); };
  // 画面を離れたら購読をやめる
  const stop = () => { off(); removeEventListener('hashchange', stop); };
  addEventListener('hashchange', stop);
  await initAuth();
}

// 設定画面の小さな表示
export function accountCardHtml() {
  return `<section class="card">
      <h2>Googleログイン・同期</h2>
      <p><span class="badge">Sync-3</span> PC・iPhoneの同期（ボタンを押したときだけ）ができます。<span class="badge">Sync-4a</span> 受け取り待ち・未送信をホームでお知らせします。自動の同期はまだです（送る・受け取るはボタンで行います）。</p>
      <p class="muted">同期がなくても、この端末だけで全機能が使えます。端末間の移動は「バックアップ」のファイルでも行えます。（Firebase ${esc(FIREBASE_SDK_VERSION)}・無料のSparkプラン）</p>
      <div class="btns"><a class="btn" href="#/account">Googleログインを開く</a><a class="btn" href="#/sync-check">同期の予行演習</a></div>
    </section>`;
}

// クラウドの状態の表示
const STORE_JA = { projects: 'プロジェクト', specs: '仕様書', requests: '要望', compares: '3AI比較', files: 'ファイル', tests: 'テスト', urls: 'URL', issues: '未解決事項', ideas: '相談メモ', tasks: '次にやること', guides: '指示書', handoff: '引継ぎ', checks: '実機・公開確認', history: '変更履歴', trash: 'ゴミ箱', settings: '設定' };
const when = iso => { try { return new Date(iso).toLocaleString('ja-JP'); } catch { return iso || ''; } };
export function cloudResultHtml(r) {
  const t = `<p class="muted">確認日時：${esc(when(r.checkedAt))}</p>`;
  const err = r.error ? `<div class="notice ng" role="alert"><strong>${esc(r.error.title)}</strong><p>${esc(r.error.how)}</p>${r.uid ? `<p class="muted">このアカウントのユーザーID：<code class="uid">${esc(r.uid)}</code></p>` : ''}</div>` : '';
  const counts = c => Object.keys(c || {}).length ? `<dl class="kv">${Object.entries(c).map(([k, v]) => `<dt>${esc(STORE_JA[k] || k)}</dt><dd>${esc(v)}件</dd>`).join('')}</dl>` : '';
  switch (r.state) {
    case 'signedOut': return `<p><span class="badge">未ログイン</span> Googleにログインしてから確認してください。</p>${t}`;
    case 'empty': return `<p><span class="badge ok">接続できました</span> <span class="badge">クラウドは空です</span></p>
      <p>まだ登録されていません。クラウドへのアクセスは許可されています。Factoryのデータはまだ1件も登録されていません。</p>${t}`;
    case 'uploading': return `<p><span class="badge warn">登録途中</span> 初回登録が最後まで終わっていません。</p>
      <p class="muted">登録元：${esc(r.sourceDevice || '不明')}${r.startedAt ? `・開始：${esc(when(r.startedAt))}` : ''}</p>${counts(r.counts)}${t}`;
    case 'registered': return `<p><span class="badge ok">登録済み</span> クラウドにFactoryのデータが登録されています。</p>
      <dl class="kv"><dt>登録元の端末</dt><dd>${esc(r.sourceDevice || '不明')}</dd><dt>登録日時</dt><dd>${esc(r.registeredAt ? when(r.registeredAt) : '不明')}</dd><dt>世代</dt><dd>${esc(r.generation ?? '不明')}</dd></dl>
      ${r.projectNames?.length ? `<p>プロジェクト：${r.projectNames.map(esc).join('、')}</p>` : ''}${counts(r.counts)}${t}`;
    case 'unknown': return `<p><span class="badge warn">確認が必要</span> クラウドに想定外の形の印があります。何も変更していません。この画面をClaudeに送ってください。</p>${t}`;
    case 'denied': return `<p><span class="badge ng">許可されていません</span></p>${err}${t}`;
    case 'offline': return `<p><span class="badge warn">オフライン</span></p>${err}${t}`;
    default: return `<p><span class="badge ng">確認できませんでした</span></p>${err}${t}`;
  }
}

// 「初回正本登録／取り込み」の欄（クラウドの状態で切り替える）
export function regCardHtml(r) {
  switch (r.state) {
    case 'registered': return `<h2>初回正本登録</h2>
      <p><span class="badge ok">登録済み</span> 登録元：${esc(r.sourceDevice || '不明')}${r.generation != null ? `・世代${esc(r.generation)}` : ''}</p>
      <p class="muted">クラウドにはすでにFactoryのデータが登録されています。初回登録はもう一度はできません。ほかの端末では、クラウドのデータを取り込みます。</p>
      <a class="btn primary" href="#/sync-import" id="go-import">この端末へ取り込む</a>`;
    case 'empty': return `<h2>初回正本登録</h2>
      <p><span class="badge">まだ登録されていません</span></p>
      <p class="muted">8プロジェクトが正しく入っている端末で、事前チェックとバックアップをしてから、この端末のデータをクラウドへ初めて登録します。「この端末を初回正本にする」を選んで登録ボタンを押すまで、クラウドへは書き込みません。</p>
      <a class="btn" href="#/sync-register" id="go-register">初回正本登録を開く</a>`;
    case 'uploading': return `<h2>初回正本登録</h2>
      <p><span class="badge warn">登録途中</span> 登録元：${esc(r.sourceDevice || '不明')}</p>
      <p class="muted">初回登録が最後まで終わっていません。登録元の端末で「初回正本登録」を開き、「もう一度送る（続きから）」を押してください。</p>
      <a class="btn" href="#/sync-register" id="go-register">初回正本登録を開く</a>`;
    default: return `<h2>初回正本登録・取り込み</h2>
      <p class="muted">クラウドの状態を確かめてから、「初回正本登録」か「この端末へ取り込む」のどちらかを表示します。Googleにログインし、「クラウドの状態を確認」を押してください。</p>`;
  }
}
