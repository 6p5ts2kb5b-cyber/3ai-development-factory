// 3AI Development Factory — 起動と画面切替
// Phase 1：基盤（#/system, #/backup, #/trash, #/handoff, #/settings）
// Phase 2：ホーム（プロジェクトカード）・プロジェクト9画面・話すだけ・要望箱（js/views/）
import { FactoryDB, DATA_STORES } from './db.js';
import { loadMaster } from './master.js';
import { loadHandoff, toMarkdown, HANDOFF_FIELDS } from './handoff.js';
import { downloadBackup, readBackupFile } from './backup.js';
import { activeSync } from './sync/adapter.js';
import { esc, fmtDate, toast, confirmDialog, errorHtml, copyText } from './ui.js';
import { STORE_LABELS } from './labels.js';
import { homeView } from './views/home.js';
import { projectView } from './views/project.js';
import { talkView, ideaView } from './views/talk.js';
import { requestsView } from './views/requests.js';
import { confirmPurgeBundle } from './views/projectForm.js';
import { v1View } from './views/v1.js';
import { label as mlabel } from './master.js';
import { FACTORY_ID } from './db.js';
import { safeCopy } from './views/safecopy.js';

import { accountView, accountCardHtml } from './views/account.js';
import { syncCheckView } from './views/synccheck.js';
import { syncRegisterView } from './views/syncregister.js';
import { syncImportView } from './views/syncimport.js?v=0901';
import { fillNotice } from './views/noticebar.js';
export const APP_VERSION = '0.11.0';
const view = document.getElementById('view');

let db, master, handoff;

// ---------- 起動 ----------
async function boot() {
  try {
    db = await FactoryDB.open('factory');
    master = await loadMaster(db);
    await db.migrateNextActions(); // Phase 3：旧「次にやること」を作業データへ（何度実行しても安全）
    await db.ensureFactoryChecks(); // Phase 6：Factory本体の実機確認（Phase 1〜5の確認待ちを引継ぎ）
    const profile = await db.get('settings', 'profile');
    if (profile?.value?.name) db.actor = profile.value.name;
  } catch (e) {
    view.innerHTML = errorHtml(e) + `<p class="muted">ページを再読み込みしても直らない場合は、引継ぎ情報と一緒にこのメッセージをClaudeへ伝えてください。</p>`;
    return;
  }
  try { handoff = await loadHandoff(); } catch { handoff = null; }
  if (handoff) { const b = document.getElementById('phase-badge'); b.textContent = handoff.phase; b.title = `${handoff.phase}：${handoff.phaseStatus}`; }

  // 端末のデータが自動削除されにくくする（iPhoneはホーム画面に追加すると有効）
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const ob = document.getElementById('offline');
  const upd = () => { ob.hidden = navigator.onLine; };
  addEventListener('online', upd); addEventListener('offline', upd); upd();

  addEventListener('hashchange', () => route());
  await route();

  // Sync-4a：半自動のお知らせを起動する
  // クラウドは meta の印1件だけを読む。送受信は自動では行わない。
  noticeStarted = true;
  await fillNotice(ctx, { force: true });
  addEventListener('online', () => fillNotice(ctx, { force: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fillNotice(ctx);
  });
  addEventListener('factory:sync-changed', () => fillNotice(ctx, { remote: false }));
}

// 画面部品へ渡す共通情報
const ctx = {
  get db() { return db; },
  get master() { return master; },
  refresh: () => route({ keepScroll: true }),
};

// ---------- 画面切替 ----------
const routes = {
  '/': () => homeView(ctx, view, params()), '/system': home, '/backup': backup, '/trash': trash, '/handoff': handoffView, '/settings': settings,
  '/talk': () => talkView(ctx, view), '/requests': () => requestsView(ctx, view, params()),
  '/v1': () => v1View(ctx, view, { loadHandoff }),
  '/account': () => accountView(view, ctx), // Sync-1：Googleログインだけ（データは送受信しない）
  '/sync-check': () => syncCheckView(ctx, view), // Sync-2-2：登録の予行演習（確認だけ・送信しない）
  '/sync-register': () => syncRegisterView(ctx, view, { appVersion: APP_VERSION }), // Sync-2-3：初回正本登録
  '/sync-import': () => syncImportView(ctx, view), // Sync-2-4：この端末への取り込み（クラウド → 端末の一方向）
};
const params = () => new URLSearchParams((location.hash.split('?')[1]) || '');
// メニューのどこを選択中にするか
const NAV_OF = { '/sync-import': '/settings', '/sync-register': '/settings', '/sync-check': '/settings', '/account': '/settings', '/v1': '/settings', '/': '/', '/talk': '/talk', '/requests': '/requests', '/settings': '/settings', '/system': '/settings', '/backup': '/backup', '/trash': '/backup', '/handoff': '/handoff' };
async function route({ keepScroll = false } = {}) {
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const seg = path.split('/').filter(Boolean);
  let fn = routes[path];
  if (!fn && seg[0] === 'p' && seg[1]) fn = () => projectView(ctx, view, params(), decodeURIComponent(seg[1]), seg[2]);
  if (!fn && seg[0] === 'talk' && seg[1]) fn = () => ideaView(ctx, view, params(), decodeURIComponent(seg[1]));
  fn ||= notFound;
  const nav = NAV_OF[path] || (seg[0] === 'p' ? '/' : seg[0] === 'talk' ? '/talk' : '');
  document.querySelectorAll('.tabbar a').forEach(a => {
    const on = a.dataset.route === nav || (a.dataset.alt || '').split(' ').includes(nav);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const y = window.scrollY;
  const my = ++routeSeq;
  try { await fn(); } catch (e) { if (my === routeSeq) view.innerHTML = errorHtml(e); }
  // 画面を続けて切り替えたとき、前の画面の表示が後から上書きしてしまった場合は、今の画面を表示し直す（iPhoneホーム画面版での安定化）
  if (my !== routeSeq) { if (!rerouting) { rerouting = true; queueMicrotask(() => { rerouting = false; route({ keepScroll: true }); }); } return; }
  window.scrollTo(0, keepScroll ? y : 0);
  if (noticeStarted) fillNotice(ctx);   // Sync-4a：ホーム・同期の画面ならお知らせを表示（クラウドを読むのは10分に1回まで）
}
let routeSeq = 0, rerouting = false, noticeStarted = false;
function notFound() { view.innerHTML = `<div class="card"><h1>ページが見つかりません</h1><a class="btn" href="#/">ホームへ戻る</a></div>`; }

async function storageInfo() {
  let persisted = null, usage = null, quota = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch {}
  try { const e = await navigator.storage?.estimate?.(); usage = e?.usage; quota = e?.quota; } catch {}
  return { persisted, usage, quota };
}
const mb = n => n == null ? '不明' : (n / 1024 / 1024).toFixed(1) + ' MB';

// ---------- ホーム（Phase 1 基盤確認）----------
async function home() {
  const counts = {};
  for (const s of [...DATA_STORES, 'history', 'trash']) counts[s] = await db.count(s);
  const lastBackup = (await db.get('settings', 'lastBackup'))?.value;
  const lastTest = (await db.get('settings', 'lastTestRun'))?.value;
  const st = await storageInfo();
  const testBadge = !lastTest ? '<span class="badge warn">未実行</span>'
    : lastTest.failed ? `<span class="badge ng">不合格 ${lastTest.failed}件</span>` : `<span class="badge ok">全${lastTest.total}項目 合格</span>`;
  const backupAge = lastBackup ? Math.floor((Date.now() - new Date(lastBackup.at)) / 86400000) : null;

  view.innerHTML = `
    <div class="notice">
      <strong>基盤の状態</strong>（Phase 1 で作った土台）<br>
      データ保存・変更履歴・バックアップ/復元・引継ぎ・自動テストの状態を確認できます。
    </div>
    ${backupAge === null || backupAge >= 7 ? `<div class="notice warn">${backupAge === null ? 'まだバックアップがありません。' : `最後のバックアップから${backupAge}日経っています。`}「バックアップ」から保存しておくと安心です。</div>` : ''}
    <div class="grid two">
      <section class="card">
        <h2>基盤の状態</h2>
        <dl class="kv">
          <dt>端末内データベース</dt><dd><span class="badge ok">動作中</span></dd>
          <dt>設定値</dt><dd>v${esc(master.masterVersion)}（ステータス${master.statuses.length}種）</dd>
          <dt>自動テスト</dt><dd>${testBadge}</dd>
          <dt>自動同期</dt><dd><span class="badge">${esc(activeSync.label)}</span></dd>
          <dt>データ保護</dt><dd>${st.persisted === true ? '<span class="badge ok">自動削除されにくい状態</span>' : '<span class="badge warn">未保護</span>'}</dd>
          <dt>使用容量</dt><dd>${mb(st.usage)}</dd>
          <dt>最終バックアップ</dt><dd>${lastBackup ? fmtDate(lastBackup.at) : 'なし'}</dd>
        </dl>
      </section>
      <section class="card">
        <h2>保存データ件数</h2>
        <dl class="kv">${Object.entries(counts).map(([k, v]) => `<dt>${esc(STORE_LABELS[k])}</dt><dd>${v}件</dd>`).join('')}</dl>
      </section>
    </div>
    <section class="card">
      <h2>操作</h2>
      <div class="btns">
        <a class="btn primary" href="tests/">自動テストを実行する</a>
        <a class="btn" href="#/backup">バックアップ / 復元</a>
        <a class="btn" href="#/handoff">引継ぎ情報を見る</a>
      </div>
      <p class="muted" style="margin-top:10px">自動テストは、本番データとは別の「テスト専用の保存領域」で行います。あなたのデータは変わりません。</p>
    </section>`;
}

// ---------- バックアップ / 復元 ----------
async function backup() {
  const lastBackup = (await db.get('settings', 'lastBackup'))?.value;
  view.innerHTML = `
    <h1>バックアップ / 復元</h1>
    <section class="card">
      <h2>バックアップを保存</h2>
      <p>すべてのデータを1つのファイル（.json）に保存します。iPhoneでは「ファイル」アプリ、PCでは「ダウンロード」フォルダに入ります。</p>
      <p class="muted">最終バックアップ：${lastBackup ? `${fmtDate(lastBackup.at)}（${esc(lastBackup.fileName)}）` : 'なし'}</p>
      <button class="btn primary" id="do-backup">バックアップを保存する</button>
    </section>
    <section class="card">
      <h2>バックアップから復元</h2>
      <p>保存したファイルを選ぶと、中身を確認してから復元します。<strong>今のデータはファイルの内容に置き換わります。</strong></p>
      <label class="field"><span>バックアップファイルを選ぶ</span><input type="file" id="restore-file" accept=".json,application/json"></label>
      <div id="restore-area"></div>
    </section>
    <section class="card">
      <h2>ゴミ箱</h2>
      <p>削除したデータはゴミ箱に残り、元に戻せます。</p>
      <a class="btn" href="#/trash">ゴミ箱を開く</a>
    </section>`;

  document.getElementById('do-backup').onclick = async () => {
    try { const { name } = await downloadBackup(db); toast(`保存しました：${name}`); backup(); }
    catch (e) { document.getElementById('restore-area').innerHTML = errorHtml(e); }
  };
  document.getElementById('restore-file').onchange = async ev => {
    const area = document.getElementById('restore-area');
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const { json, counts } = await readBackupFile(file);
      area.innerHTML = `<div class="notice">
        <strong>ファイルを確認しました（まだ復元していません）</strong>
        <p class="muted">作成：${fmtDate(json.exportedAt)}</p>
        <dl class="kv">${Object.entries(counts).map(([k, v]) => `<dt>${esc(STORE_LABELS[k] || k)}</dt><dd>${v}件</dd>`).join('')}</dl>
      </div><button class="btn danger" id="do-restore">この内容で復元する</button>`;
      document.getElementById('do-restore').onclick = async () => {
        const ok = await confirmDialog({
          title: '本当に復元しますか？',
          body: '<p>今のデータは、選んだファイルの内容に<strong>置き換わります</strong>。</p><p class="muted">不安な場合は「キャンセル」を押し、先に今のデータをバックアップしてください。</p>',
          ok: '復元する', danger: true,
        });
        if (!ok) return;
        try { await db.importAll(json); master = await loadMaster(db); toast('復元しました'); location.hash = '#/'; }
        catch (e) { area.innerHTML = errorHtml(e) + '<p class="muted">復元は取り消され、元のデータのままです。</p>'; }
      };
    } catch (e) {
      area.innerHTML = errorHtml(e) + '<p class="muted">今のデータは変更されていません。</p>';
    }
  };
}

// ---------- ゴミ箱 ----------
// Phase 3：プロジェクトは関連データとまとめて1件で表示。完全削除は明確な確認つき
async function trash() {
  const items = await db.listTrash();
  const title = r => r.record?.name || r.record?.title || r.record?.topic || r.record?.fileName || r.record?.item || r.record?.url || r.recordId;
  view.innerHTML = `<h1>ゴミ箱</h1>
    <p class="muted">削除したデータはここに残り、元に戻せます。プロジェクトは関連データ（仕様書・要望・作業・未解決事項・履歴など）とまとめて戻ります。</p>
    <section class="card">${items.length ? `<ul class="list">${items.map(t => `
      <li><div class="grow"><strong>${esc(title(t))}</strong>
        <div class="muted">${esc(STORE_LABELS[t.store] || t.store)}${t.kind === 'project-bundle' ? `（関連データ${t.relatedCount}件・履歴${t.historyCount}件を含む）` : ''}・${fmtDate(t.deletedAt)} 削除（${esc(t.deletedBy)}）</div></div>
      <button class="btn small" data-restore="${esc(t.id)}">元に戻す</button>
      <button class="btn small danger" data-purge="${esc(t.id)}">完全に削除</button></li>`).join('')}</ul>`
      : '<p class="muted">ゴミ箱は空です。</p>'}</section>
    <a class="btn" href="#/settings">戻る</a>`;
  view.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    try { await db.restore(b.dataset.restore); toast('元に戻しました'); trash(); } catch (e) { view.insertAdjacentHTML('afterbegin', errorHtml(e)); window.scrollTo(0, 0); }
  });
  view.querySelectorAll('[data-purge]').forEach(b => b.onclick = async () => {
    const t = items.find(x => x.id === b.dataset.purge);
    if (t.kind === 'project-bundle') {
      if (await confirmPurgeBundle(ctx, t)) { toast('完全に削除しました'); trash(); }
      return;
    }
    if (!await confirmDialog({ title: '完全に削除しますか？', body: '<p>完全に削除すると<strong>元に戻せません</strong>。</p>', ok: '完全に削除', danger: true })) return;
    await db.purge(b.dataset.purge); toast('完全に削除しました'); trash();
  });
}

// ---------- 引継ぎ（Factory全体）----------
async function handoffView() {
  if (!handoff) { view.innerHTML = errorHtml(new Error('引継ぎファイル（config/handoff.json）を読み込めませんでした')); return; }
  const lastTest = (await db.get('settings', 'lastTestRun'))?.value;
  const devices = (await db.checksOf(FACTORY_ID, 'device')).map(d => ({ ...d, statusLabel: mlabel(master, 'deviceCheckStatuses', d.status || 'unchecked') }));
  const publish = (await db.checksOf(FACTORY_ID, 'publish')).map(x => ({ ...x, accessLabel: mlabel(master, 'accessResults', x.access || 'unchecked') }));
  const md = toMarkdown(handoff, lastTest, { devices, publish });
  view.innerHTML = `<h1>Factory全体の引継ぎ</h1>
    <p class="muted">Claude等の利用上限やセッション終了に備えた記録です。新しいセッションでは、「コピー」した内容を最初に貼り付けると続きから再開できます。プロジェクトごとの引継ぎは、各プロジェクトの「引継ぎ」タブにあります。</p>
    <div class="btns" style="margin-bottom:14px">
      <button class="btn primary" id="copy-md">引継ぎ内容をコピー</button>
      <button class="btn" id="dl-md">ファイルで保存（.md）</button>
      <a class="btn" href="#/v1">v1完成まで あと何が必要か</a>
    </div>
    <section class="card"><h2>概要</h2><dl class="kv wide"><dt>Factory</dt><dd>v${esc(handoff.appVersion)}</dd><dt>現在</dt><dd>${esc(handoff.phase)}（${esc(handoff.phaseStatus)}）</dd>${handoff.nextPhase ? `<dt>次Phase</dt><dd>${esc(handoff.nextPhase)}</dd>` : ''}</dl></section>
    ${handoff.phases?.length ? `<section class="card"><h2>各Phaseの状態とテスト結果</h2><ul class="list">${handoff.phases.map(p => `<li><div class="grow"><strong>Phase ${esc(p.no)} ${esc(p.name)}</strong><div class="muted">${esc(p.tests || '')}</div></div><span class="badge ${String(p.status).startsWith('完了') ? 'ok' : 'warn'}">${esc(p.status)}</span></li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>実機確認状況（Factory本体）</h2>${devices.length ? `<ul class="tight">${devices.map(d => `<li>${esc(d.device)}：${esc(d.statusLabel)}${d.checkedAt ? `（${esc(d.checkedAt)}）` : ''}</li>`).join('')}</ul>` : '<p class="muted">未登録</p>'}<a href="#/v1">記録する</a></section>
    ${HANDOFF_FIELDS.map(([k, t]) => `<section class="card"><h2>${esc(t)}</h2>${(handoff[k] || []).length ? `<ul>${handoff[k].map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">なし</p>'}</section>`).join('')}
    ${handoff.rules?.length ? `<section class="card"><h2>重要な設計ルール</h2><ul>${handoff.rules.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>テスト結果（この端末での最新）</h2>${lastTest ? `<p>${fmtDate(lastTest.runAt)}：合格 ${lastTest.passed} / ${lastTest.total}</p>` : '<p class="muted">まだこの端末で実行していません。</p>'}</section>
    <details class="card"><summary>Markdown全文</summary><pre class="md">${esc(md)}</pre></details>`;
  // Factory全体の引継ぎはFactoryが作る文章（利用者の個人データを含まない）ので、そのままコピー
  document.getElementById('copy-md').onclick = async () => toast(await copyText(md) ? 'コピーしました' : 'コピーできませんでした。下の全文を長押しして選択してください');
  document.getElementById('dl-md').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = 'HANDOFF.md'; a.click();
  };
}

// ---------- 設定 ----------
async function settings() {
  const st = await storageInfo();
  view.innerHTML = `<h1>設定</h1>
    <section class="card">
      <h2>あなたの名前</h2>
      <p class="muted">変更履歴の「誰が」に記録されます。</p>
      <form id="profile-form">
        <label class="field"><span>表示名</span><input type="text" name="name" maxlength="30" value="${esc(db.actor)}"></label>
        <div id="profile-err"></div>
        <button class="btn primary">保存</button>
      </form>
    </section>
    ${accountCardHtml()}
    <section class="card">
      <h2>この端末の保存状況</h2>
      <dl class="kv">
        <dt>データ保護</dt><dd>${st.persisted === true ? '有効' : '未保護（iPhoneはホーム画面に追加すると保護されます）'}</dd>
        <dt>使用容量</dt><dd>${mb(st.usage)} / 上限目安 ${mb(st.quota)}</dd>
        <dt>Factory</dt><dd>v${APP_VERSION}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>3AIの基本の役割</h2>
      <dl class="kv wide">${master.aiList.map(ai => `<dt>${esc(ai.label)}</dt><dd>${esc(master.aiRoleSummary?.[ai.key] || ai.roles.join('・'))}</dd>`).join('')}</dl>
      <p class="muted" style="margin-top:8px">役割は固定ではありません。各プロジェクトの「3AI比較」タブで、案件ごとに変えられます。AIへの送信は自動では行いません（依頼文をコピーして使います）。</p>
    </section>
    <section class="card">
      <h2>データと記録</h2>
      <div class="btns">
        <a class="btn" href="#/backup">バックアップ / 復元</a>
        <a class="btn" href="#/trash">ゴミ箱</a>
        <a class="btn" href="#/handoff">引継ぎ情報</a>
        <a class="btn" href="#/system">基盤の状態・自動テスト</a>
        <a class="btn primary" href="#/v1">v1完成まで あと何が必要か</a>
      </div>
    </section>`;
  document.getElementById('profile-form').onsubmit = async ev => {
    ev.preventDefault();
    const name = new FormData(ev.target).get('name').trim();
    const err = document.getElementById('profile-err');
    if (!name) { err.innerHTML = '<ul class="error-list"><li>名前を入力してください</li></ul>'; return; }
    await db.upsert('settings', 'profile', { key: 'profile', value: { name } }, { reason: '表示名を変更' });
    db.actor = name; err.innerHTML = ''; toast('保存しました');
  };
}

boot();
