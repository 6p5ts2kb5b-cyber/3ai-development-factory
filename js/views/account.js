// Phase Sync-1：Googleログイン画面（ログインの確認だけ。Factoryのデータは送受信しない）
import { esc, toast, copyText } from '../ui.js';
import { initAuth, onAuth, signIn, signOut, deviceKind, envInfo, FIREBASE_SDK_VERSION } from '../sync/auth.js';

const NOTE = 'この段階（Sync-1）では、Googleログインができるかだけを確認します。Factoryのデータ（プロジェクト・仕様書など）は、クラウドへ送ったり、受け取ったりしません。この端末のデータはそのままです。';

export async function accountView(view) {
  view.innerHTML = `<h1>Googleログイン</h1>
    <div class="notice slim" id="acc-note">${esc(NOTE)}</div>
    <section class="card" id="acc-card"><p class="muted">確認しています…</p></section>
    <section class="card">
      <h2>同期の状態</h2>
      <p><span class="badge">まだ同期していません</span> この端末のデータだけを使っています。</p>
      <p class="muted">複数の端末で同じデータを使う同期は、Googleログインの実機確認（学校Surface → iPhoneホーム画面版）がすべて合格してから追加します。</p>
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
      // ポップアップはボタンを押した直後に開く必要があるため、ここでは待たずにすぐ呼ぶ
      signIn().then(r => { busy = false; if (r.status === 'signedIn') toast('ログインしました（データの同期はまだ行いません）'); });
    };
  };
  const off = onAuth(render);
  // 画面を離れたら購読をやめる
  const stop = () => { off(); removeEventListener('hashchange', stop); };
  addEventListener('hashchange', stop);
  await initAuth();
}

// 設定画面の小さな表示
export function accountCardHtml() {
  return `<section class="card">
      <h2>Googleログイン・同期</h2>
      <p><span class="badge">準備中（Sync-1）</span> まずGoogleログインができるかを確認します。データの同期はまだ行いません。</p>
      <p class="muted">同期がなくても、この端末だけで全機能が使えます。端末間の移動は「バックアップ」のファイルでも行えます。（Firebase ${esc(FIREBASE_SDK_VERSION)}・無料のSparkプラン）</p>
      <a class="btn" href="#/account">Googleログインを開く</a>
    </section>`;
}
