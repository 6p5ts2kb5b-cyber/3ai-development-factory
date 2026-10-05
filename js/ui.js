// 画面部品（確認ダイアログ・トースト・エスケープ）
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach(x => x.remove()); // 重ならないよう前の通知は消す
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// 確認ダイアログ。OKで true、キャンセルで false
export function confirmDialog({ title, body = '', ok = 'OK', cancel = 'キャンセル', danger = false }) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <h2 id="dlg-title">${esc(title)}</h2><div>${body}</div>
      <div class="btns" style="margin-top:16px">
        <button class="btn" data-a="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-a="1">${esc(ok)}</button>
      </div></div>`;
    const close = v => { back.remove(); resolve(v); };
    back.addEventListener('click', e => {
      if (e.target === back) close(false);
      const a = e.target.closest('[data-a]');
      if (a) close(a.dataset.a === '1');
    });
    document.body.appendChild(back);
    back.querySelector('[data-a="0"]').focus();
  });
}

export function errorHtml(e) {
  const details = e?.details?.length ? `<ul class="error-list">${e.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
  return `<div class="notice ng" role="alert"><strong>${esc(e?.message || 'エラーが発生しました')}</strong>${details}</div>`;
}

// ---- Phase 2 追加 ----
// 汎用モーダル。{ el, close } を返す
export function openModal(html, { onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  return { el: back.querySelector('.modal'), close };
}

// クリップボードへコピー（使えない環境では選択方式で代替）
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

export function fmtShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `今日 ${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const options = (list, selected) => list.map(o => `<option value="${esc(o.key)}"${o.key === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

// ---- Phase 4 追加 ----
// テキストをファイルとして保存（iPhoneは「ファイル」アプリ、PCはダウンロードフォルダ）
export function downloadText(fileName, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = fileName;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
// ファイル名は英数字だけにする（日本語名だと端末やブラウザによって「download」等に化けるため。中身は日本語のまま）
export const safeFileName = s => (String(s || '').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)) || 'project';
