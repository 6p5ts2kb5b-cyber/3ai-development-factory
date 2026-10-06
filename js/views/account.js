// Phase Sync-1：Googleログイン画面（ログインの確認だけ。Factoryのデータは送受信しない）
// Phase Sync-2-1：クラウドの状態を確認（「登録済みの印」を1件読むだけ。書き込みなし）
import { esc, toast, copyText } from '../ui.js';
import { initAuth, onAuth, signIn, signOut, deviceKind, envInfo, FIREBASE_SDK_VERSION } from '../sync/auth.js';
import { checkCloudStatus } from '../sync/cloud.js';

const NOTE = 'この段階（Sync-2-3）では、Googleログイン・クラウドの状態の確認・同期の予行演習・初回正本登録ができます。クラウドへ書き込むのは「初回正本登録」で登録ボタンを押したときだけです。この端末のデータは変更しません。';

export async function accountView(view) {
  view.innerHTML = `<h1>Googleログイン</h1>
    <div class="notice slim" id="acc-note">${esc(NOTE)}</div>
    <section class="card" id="acc-card"><p class="muted">確認しています…</p></section>
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
    <section class="card" id="register-card">
      <h2>初回正本登録</h2>
      <p class="muted">8プロジェクトが正しく入っている端末で、事前チェックとバックアップをしてから、この端末のデータをクラウドへ初めて登録します。「この端末を初回正本にする」を選んで登録ボタンを押すまで、クラウドへは書き込みません。</p>
      <a class="btn" href="#/sync-register">初回正本登録を開く</a>
    </section>`;
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
      signIn().then(r => { busy = false; if (r.status === 'signedIn') toast('ログインしました（データの同期はまだ行いません）'); });
    };
  };
  const cBtn = view.querySelector('#cloud-check'), cRes = view.querySelector('#cloud-result'), cHint = view.querySelector('#cloud-hint');
  const cloudAuth = s => { if (!cBtn.isConnected) return; const ok = s.status === 'signedIn'; if (!cBtn.dataset.busy) cBtn.disabled = !ok; cHint.hidden = ok; };
  cBtn.onclick = async () => {
    cBtn.dataset.busy = '1'; cBtn.disabled = true; cBtn.textContent = '確認しています…';
    const r = await checkCloudStatus();
    delete cBtn.dataset.busy; cBtn.disabled = false; cBtn.textContent = 'もう一度確認';
    if (cRes.isConnected) cRes.innerHTML = cloudResultHtml(r);
  };
  const offCloud = onAuth(cloudAuth);
  const off0 = onAuth(render);
  const off = () => { off0(); offCloud(); };
  const stop = () => { off(); removeEventListener('hashchange', stop); };
  addEventListener('hashchange', stop);
  await initAuth();
}

export function accountCardHtml() {
  return `<section class="card">
      <h2>Googleログイン・同期</h2>
      <p><span class="badge">準備中（Sync-2-3）</span> Googleログイン、クラウドの状態の確認、同期の予行演習、初回正本登録ができます。2台目以降の取り込みと自動の同期はまだです。</p>
      <p class="muted">同期がなくても、この端末だけで全機能が使えます。端末間の移動は「バックアップ」のファイルでも行えます。（Firebase ${esc(FIREBASE_SDK_VERSION)}・無料のSparkプラン）</p>
      <div class="btns"><a class="btn" href="#/account">Googleログインを開く</a><a class="btn" href="#/sync-check">同期の予行演習</a><a class="btn" href="#/sync-register">初回正本登録</a></div>
    </section>`;
}

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