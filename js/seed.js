// Phase 7：Factory本体＋7プロジェクトの正式初期登録
// ・何度実行しても重複しない（seedKey で判定）
// ・7件は「仕様確定」から開始。v1.0は確定仕様として保存（以後の変更は要望箱→…→新Versionの正式ルートのみ）
// ・既存アプリの有無は推測しない（origin: 'unknown'＝既存アプリ未確認。URL・コードは登録しない）
// ・野球成績・オーダーアプリは対象外（データにも含めない）
import { FACTORY_ID } from './db.js';
import { createProject } from './views/projectForm.js';

export async function loadInitialProjects(url = new URL('../config/initial-projects.json', import.meta.url)) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('初期登録データ（config/initial-projects.json）を読み込めませんでした');
  return r.json();
}

const REASON = 'Phase 7 正式初期登録（指示書 v1.0・Phase 7 指示の確定仕様）';

async function registerOne(db, d, { id, origin, status }) {
  const p = await createProject(db, { id, name: d.name, purpose: d.purpose, targetUsers: d.targetUsers, targetDevices: d.targetDevices, status, deliverableType: d.deliverableType, origin, memo: '' }, { reason: REASON });
  const pid = p.id;
  await db.update('projects', pid, {
    seedKey: d.key,
    guide: { future: d.notImplemented || '' }, // 既存URL・ソースコードは空のまま（推測で入れない。指示書には「既存アプリの有無：未確認」と出る）
  }, { reason: REASON });
  const draft = await db.createSpecDraft(pid, { title: `${d.name} 仕様書`, body: d.specBody, reason: REASON });
  await db.fixSpec(draft.id, { reason: REASON });
  for (const t of d.tasks || []) await db.create('tasks', { projectId: pid, title: t.title, priority: t.priority, status: 'todo', ai: t.ai, memo: t.memo || '' }, { reason: REASON });
  await db.applyTestTemplate(pid);
  for (const t of d.tests || []) await db.create('tests', { projectId: pid, item: t.name, category: t.category, check: t.check, expected: t.expected, status: 'untested', required: true, special: true, runs: [] }, { reason: '個別必須テストを登録' });
  const today = new Date().toISOString().slice(0, 10);
  for (const i of d.issues || []) await db.create('issues', { projectId: pid, title: i.title, severity: i.severity, status: 'open', occurredAt: today, resolution: '', resolvedAt: null }, { reason: REASON });
  return pid;
}

export async function seedInitialProjects(db, data) {
  const order = n => n === data.factory?.name ? -1 : data.projects.findIndex(d => d.name === n);
  const all = await db.all('projects');
  const has = key => all.some(p => p.seedKey === key);
  const created = [], skipped = [];
  // ホームは最終更新順なので、開発順の逆（健康→…→Vintage Hunt）→Factory本体の順に登録し、上からFactory・Vintage Hunt…と並ぶようにする
  for (const d of [...data.projects].reverse()) {
    if (/野球成績|オーダー/.test(d.name)) continue; // 対象外（念のため）
    if (has(d.key)) { skipped.push(d.name); continue; }
    await registerOne(db, d, { origin: 'unknown', status: 'spec_fixed' });
    created.push(d.name);
  }
  // Factory本体（既に「Factory自身を登録」で作ってあれば作らない）
  if (data.factory) {
    if (has('factory') || all.some(p => p.id === FACTORY_ID || p.name === data.factory.name)) skipped.push(data.factory.name);
    else { await registerOne(db, data.factory, { id: FACTORY_ID, origin: 'factory', status: data.factory.status || 'testing' }); created.push(data.factory.name); }
  }
  created.sort((a, b) => order(a) - order(b));
  await db.upsert('settings', 'seed7', { key: 'seed7', value: { at: new Date().toISOString(), version: data.version, created } }, { reason: 'Phase 7 初期登録' });
  return { created, skipped };
}

// 7件（＋Factory本体）が登録済みか
export function seedStatus(projects, data) {
  const keys = new Set(projects.map(p => p.seedKey).filter(Boolean));
  const missing = data.projects.filter(d => !keys.has(d.key)).map(d => d.name);
  return { done: !missing.length, missing };
}

// 画面用：登録ボタン（ホーム・v1完成画面）。何度押しても重複しない
export const SEED_KEYS = ['vintage-hunt', 'storm', 'kyozai', 'school', 'kaikei', 'family', 'health'];
export const seededCount = projects => SEED_KEYS.filter(k => projects.some(p => p.seedKey === k)).length;
export const seedBannerHtml = projects => seededCount(projects) >= SEED_KEYS.length ? '' : `<section class="card seed-card">
    <h2>7つの実案件をFactoryへ登録</h2>
    <p>Factory本体と、確定仕様（v1.0）つきの7プロジェクト（Vintage Hunt・STORM／連合チーム予定管理・野球教材動画＋練習メニュー・学校 出欠・行事・三者面談管理・野球部会計・家族スケジュール・タスク管理・健康・減量管理）をまとめて登録します。</p>
    <p class="muted">登録済みのものは重複しません。7件は「仕様確定」から始まり、実装前なので完成度は低く表示されます。既存アプリの有無は「未確認」で登録します（URLやコードは推測で入れません）。</p>
    <button class="btn primary" id="seed-7">Factory本体＋7プロジェクトを登録</button>
  </section>`;
export function bindSeed(view, ctx) {
  const b = view.querySelector('#seed-7');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true; b.textContent = '登録しています…';
    try {
      const r = await seedInitialProjects(ctx.db, await loadInitialProjects());
      const { toast } = await import('./ui.js');
      toast(r.created.length ? `${r.created.length}件を登録しました${r.skipped.length ? `（登録済み${r.skipped.length}件はそのまま）` : ''}` : 'すべて登録済みです');
      ctx.refresh();
    } catch (err) {
      const { errorHtml } = await import('./ui.js');
      b.disabled = false; b.textContent = 'Factory本体＋7プロジェクトを登録';
      b.insertAdjacentHTML('afterend', errorHtml(err));
    }
  };
}
