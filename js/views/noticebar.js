// Phase Sync-4a：お知らせの帯（ホームとGoogleログイン・同期の画面）
// 表示するだけ。押すと同期の画面へ移る。送る・受け取るは今までどおり同期の画面のボタンで行う。
import { esc } from '../ui.js';
import { getNotice } from '../sync/notice.js';

const hm = iso => { try { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const whenShort = iso => { try { const d = new Date(iso); if (isNaN(d)) return ''; const today = new Date().toDateString() === d.toDateString(); return today ? `今日 ${hm(iso)}` : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export function noticeHtml(n, where = 'home') {
  if (!n || !n.active || n.enabled === false) return '';
  const lines = [];
  if (n.remote === 'pending' && n.reason === 'newer') {
    const by = [n.meta?.lastUpdatedBy, whenShort(n.meta?.lastUpdatedAt)].filter(Boolean).join('・');
    lines.push(`<span class="sn-line" data-kind="pull"><strong>受け取り待ちがあります</strong><span>ほかの端末がクラウドを更新しました${by ? `（${esc(by)}）` : ''}</span></span>`);
  } else if (n.remote === 'pending') {
    lines.push(`<span class="sn-line" data-kind="pull"><strong>受け取り待ち・競合が残っています</strong><span>前回の確認で、まだ反映していない変更がありました</span></span>`);
  } else if (n.remote === 'reset') {
    lines.push(`<span class="sn-line" data-kind="reset"><strong>クラウドのデータが入れ替わっています</strong><span>自動では何もしていません。同期の画面で確認してください</span></span>`);
  }
  if (n.unsent > 0) lines.push(`<span class="sn-line" data-kind="push"><strong>未送信 <span id="sn-unsent">${n.unsent}</span>件</strong><span>この端末の変更が、まだクラウドへ送られていません</span></span>`);
  const sub = n.remote === 'offline' ? 'オフラインのため、クラウドは確認していません'
    : n.remote === 'signedOut' ? 'ログインしていないため、クラウドは確認していません'
    : n.remote === 'error' ? `クラウドを確認できませんでした（${n.error?.title || '不明'}）`
    : n.checkedAt ? `${hm(n.checkedAt)} に確認・自動では送受信しません` : '';
  if (!lines.length) {
    if (where === 'home' && n.remote === 'none') return `<p class="sync-ok" id="sync-notice" data-state="ok" role="status"><span aria-hidden="true">☁</span> 同期：そろっています <span class="muted">${esc(sub)}</span></p>`;
    if (where === 'home' && sub && n.remote !== 'unknown') return `<p class="sync-ok" id="sync-notice" data-state="info" role="status"><span aria-hidden="true">☁</span> <span class="muted">${esc(sub)}</span></p>`;
    return '';
  }
  const body = `<span class="sn-lines">${lines.join('')}</span>${sub ? `<span class="sn-sub muted">${esc(sub)}</span>` : ''}`;
  if (where === 'account') return `<div class="notice warn sync-notice" id="sync-notice" data-state="attention" role="status">${body}<span class="sn-go">下の「クラウドの最新を確認」から、内容を確かめて送る・受け取る</span></div>`;
  return `<a class="notice warn sync-notice" id="sync-notice" data-state="attention" role="status" href="#/account">${body}<span class="sn-go">同期の画面で確認 <span aria-hidden="true">→</span></span></a>`;
}

export async function fillNotice(ctx, { force = false, remote = true } = {}) {
  if (!ctx?.db) return null;
  if (!force && !document.querySelector('[data-sync-notice]')) return null;
  let n = null;
  try { n = await getNotice(ctx.db, { force, remote }); } catch { n = null; }
  document.querySelectorAll('[data-sync-notice]').forEach(s => { s.innerHTML = noticeHtml(n, s.dataset.syncNotice); });
  return n;
}
