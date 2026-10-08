// Phase 6：v1完成判定画面（Factory自身について「あと何が必要か」を1画面で）
import { esc, fmtDate } from '../ui.js';
import { label } from '../master.js';
import { FACTORY_ID } from '../db.js';
import { checksHtml, bindChecks } from './checks.js';
import { seedBannerHtml, bindSeed } from '../seed.js';

// v1完成の項目を計算（画面に依存しない部分）
export function v1Items({ handoff, projects, devices, publish, lastTest, lastBackup }, m) {
  const items = [];
  items.push({ group: '仕様・開発', label: '仕様（3AI Development Factory 指示書 v1.0）', ok: true, detail: '確定済み' });
  for (const ph of handoff?.phases || []) {
    const done = String(ph.status || '').startsWith('完了');
    items.push({ group: '仕様・開発', label: `Phase ${ph.no} ${ph.name}`, ok: done, detail: ph.status || '未着手', how: done ? '' : ph.no === 7 ? '7つの実案件をFactoryに登録します（Claudeが実装）' : '開発を進めます（Claudeが実装）' });
  }
  // 2026-10-05 方針変更：複数端末同期もv1完成の条件
  // 2026-10-07 方針決定：v1.0の同期はSync-3（明示ボタン式）＋Sync-4a（半自動お知らせ）まで。v1: false の段階（自動同期・削除の同期・競合の自動解決）は判定に入れない
  for (const st of (handoff?.sync?.stages || []).filter(x => x.v1 !== false)) {
    const done = String(st.status || '').startsWith('完了');
    items.push({ group: '複数端末同期', label: `${st.key} ${st.name}`, ok: done, detail: st.status || '未着手', how: done ? '' : st.key === 'Sync-1' ? 'Firebaseの設定（Claudeが1画面ずつ案内）の後、学校Surface → iPhoneホーム画面版の順にGoogleログインを確認します' : '前の段階の実機確認が合格してから、Claudeが実装します' });
  }
  const found = (m.initialProjects || []).map(ip => ({ ...ip, hit: projects.some(p => ip.match.some(k => p.name.includes(k))) }));
  const n = found.filter(x => x.hit).length;
  items.push({ group: '仕様・開発', label: '7案件の登録', ok: n === found.length, detail: `${n}/${found.length} 件登録${n < found.length ? `（未登録：${found.filter(x => !x.hit).map(x => x.name).join('、')}）` : ''}`, how: 'ホームまたはこの画面の「Factory本体＋7プロジェクトを登録」を押してください' });
  const seeded = projects.filter(p => p.seedKey && p.seedKey !== 'factory');
  const unknown = seeded.filter(p => !p.origin || p.origin === 'unknown');
  if (seeded.length) items.push({ group: '仕様・開発', label: '7案件の既存アプリ有無の確認', ok: !unknown.length, detail: unknown.length ? `未確認 ${unknown.length}件：${unknown.map(p => p.name).join('、')}` : 'すべて確認済み', how: '各プロジェクトの「既存アプリ」タブで「既存アプリあり（取込待ち）」か「既存アプリなし（新しく作る）」を選んでください。既存アプリのURL・コードは、あなたが渡したものだけ登録します' });
  // 2026-10-08 方針変更：v1.0の実機確認は iPhone と学校Windows PC を対象とし、自宅PCは完成条件に含めない。
  const v1Devices = devices.filter(d => !/^自宅PC(?:$|[（(])/.test(String(d.device || '').trim()));
  for (const d of v1Devices) items.push({ group: '実機確認', label: `${d.device} の実機確認`, ok: d.status === 'pass', detail: `${label(m, 'deviceCheckStatuses', d.status || 'unchecked')}${d.checkedAt ? `（${d.checkedAt}）` : ''}${d.result ? `：${d.result}` : ''}`, how: `${d.device}でFactoryを開き、「自動テストを実行する」で全項目合格を確認して、下の「実機確認」で「合格」にしてください` });
  const pubOk = publish.some(x => x.access === 'ok');
  const blocked = publish.some(x => x.access === 'school_blocked');
  items.push({ group: '公開・運用', label: '公開（GitHub Pages）の確認', ok: pubOk, detail: pubOk ? 'アクセスできることを確認済み' : publish.length ? '記録はありますが、まだ「アクセスできた」がありません' : '未記録', how: 'docs/公開手順.md の手順で公開し、下の「公開確認」に記録してください' });
  if (blocked) items.push({ group: '公開・運用', label: '学校ネットワークからの利用', ok: false, detail: '学校ネットワークで利用不可（公開の失敗ではありません）', how: '学校の情報担当に github.io の利用可否を確認するか、別の公開先を検討します（Claudeに相談）' });
  items.push({ group: '公開・運用', label: '自動テスト（この端末）', ok: !!lastTest && lastTest.total > 0 && !lastTest.failed, detail: lastTest ? `${fmtDate(lastTest.runAt)}：合格 ${lastTest.passed}/${lastTest.total}` : '未実行', how: '「設定 → 基盤の状態・自動テスト」から実行してください' });
  items.push({ group: '公開・運用', label: 'バックアップの作成', ok: !!lastBackup, detail: lastBackup ? `${fmtDate(lastBackup.at)} 作成` : 'まだありません', how: '「バックアップ」から保存してください' });
  return items;
}
// v1.0の完成条件ではない改善候補（表示だけ。判定には入れない）
export const v1LaterItems = handoff => (handoff?.sync?.stages || []).filter(x => x.v1 === false);

export async function v1View(ctx, view, { loadHandoff }) {
  const db = ctx.db, m = ctx.master;
  let handoff = null; try { handoff = await loadHandoff(); } catch {}
  const [projects, devices, publish] = await Promise.all([db.all('projects'), db.checksOf(FACTORY_ID, 'device'), db.checksOf(FACTORY_ID, 'publish')]);
  const lastTest = (await db.get('settings', 'lastTestRun'))?.value;
  const lastBackup = (await db.get('settings', 'lastBackup'))?.value;
  const items = v1Items({ handoff, projects, devices, publish, lastTest, lastBackup }, m);
  const left = items.filter(i => !i.ok);
  const groups = [...new Set(items.map(i => i.group))];
  view.innerHTML = `<h1>v1完成まで</h1>
    <section class="card v1-head">
      ${left.length ? `<p class="v1-left">あと <strong>${left.length}</strong> 項目</p><p class="muted">下の ⬜ の項目を上から順に進めれば、v1完成です。</p>` : '<p class="v1-left">🎉 v1完成の条件をすべて満たしています</p>'}
      <div class="meter"><i style="width:${Math.round((items.length - left.length) / items.length * 100)}%"></i></div>
    </section>
    ${seedBannerHtml(projects)}
    ${groups.map(g => `<section class="card"><h2>${esc(g)}</h2><ul class="cond">${items.filter(i => i.group === g).map(i => `<li class="${i.ok ? 'ok' : 'ng'}"><span class="mark">${i.ok ? '✅' : '⬜'}</span>
      <div><strong>${esc(i.label)}</strong><div class="muted">${esc(i.detail)}</div>${!i.ok && i.how ? `<div class="how">👉 ${esc(i.how)}</div>` : ''}</div></li>`).join('')}</ul></section>`).join('')}
    ${v1LaterItems(handoff).length ? `<section class="card v1-later"><h2>v1.1以降の改善候補</h2><p class="muted">v1.0の完成条件ではありません（2026-10-07 決定）。指示があるまで実装しません。</p><ul class="tight">${v1LaterItems(handoff).map(x => `<li>${esc(x.key === x.name ? x.name : `${x.key} ${x.name}`)}</li>`).join('')}</ul></section>` : ''}
    <h2 style="margin-top:20px">Factory本体の確認記録</h2>
    ${checksHtml(m, devices, publish)}`;
  bindChecks(view, ctx, FACTORY_ID, { devices, publish });
  bindSeed(view, ctx);
}
