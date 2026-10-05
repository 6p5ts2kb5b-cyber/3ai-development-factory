// Phase 6：プロジェクト別の引継ぎ（この内容だけ渡せば別セッションでも続きから再開できるように）
import { esc, fmtDate, toast, errorHtml, downloadText, safeFileName } from '../ui.js';
import { label } from '../master.js';
import { latestResult, isRequiredTest, isOpenTask, sortTasks, computeProgress } from '../logic.js';
import { specStatus, sortChecks } from '../db.js';
import { groupFiles } from '../ai.js';
import { devSummary } from './checks.js';
import { safeCopy } from './safecopy.js';

export const P_HANDOFF_FIELDS = [
  ['implemented', '実装済み'], ['notImplemented', '未実装'], ['knownIssues', '既知の問題'], ['nextSteps', '次に行うこと'], ['notes', '注意事項'],
];

// 引継ぎに必要な情報を集める（自動部分）
export async function collectHandoff(db, p) {
  const [specs, tests, issues, tasks, files, checks] = await Promise.all([db.specsOf(p.id), ...['tests', 'issues', 'tasks', 'files', 'checks'].map(s => db.byIndex(s, 'projectId', p.id))]);
  return { specs, tests, issues, tasks, files, checks, handoff: (await db.getProjectHandoff(p.id)) || {} };
}

export function projectHandoffMarkdown(p, d, m) {
  const fixed = d.specs.find(s => specStatus(s) === 'fixed');
  const draft = d.specs.find(s => specStatus(s) === 'draft');
  const req = d.tests.filter(isRequiredTest);
  const pass = req.filter(t => latestResult(t) === 'pass');
  const ng = req.filter(t => latestResult(t) !== 'pass');
  const devices = sortChecks(d.checks.filter(c => c.kind === 'device')), publish = sortChecks(d.checks.filter(c => c.kind === 'publish'));
  const prog = computeProgress(p, d.tests, m, { specs: d.specs, files: d.files, devices, publish, handoff: d.handoff });
  const recentFiles = groupFiles(d.files).map(g => g.latest).sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1).slice(0, 5);
  const openIssues = d.issues.filter(i => i.status !== 'resolved');
  const openTasks = sortTasks(d.tasks.filter(t => isOpenTask(t, m)), m);
  const h = d.handoff || {};
  const list = a => a.length ? a.map(x => `- ${x}`).join('\n') : '- なし';
  const txt = (v, auto) => [String(v || '').trim(), auto].filter(Boolean).join('\n') || '- なし';
  return [
    `<!-- 3AI Development Factory プロジェクト引継ぎ：${p.name} -->`,
    `# 引継ぎ：${p.name}`, '',
    `- 作成日時：${new Date().toISOString()}`,
    `- 現在Version：${fixed ? fixed.version : '確定仕様なし'}${draft ? `（変更案 ${draft.version} あり・未確定）` : ''}`,
    `- 現在ステータス：${label(m, 'statuses', p.status)}`,
    `- 完成度：${prog.total}%（${prog.axes.map(a => `${a.label}${a.value}%`).join('・')}）`,
    `- 目的：${p.purpose || '未記入'}`, '',
    '> このまま ChatGPT・Claude・Gemini に貼り付けると、続きから再開できます。確定仕様を勝手に変更せず、新しい案は提案として出してください。', '',
    '## 実装済み', txt(h.implemented), '',
    '## 未実装', txt(h.notImplemented, d.tasks.length ? '' : ''), '',
    '## 既知の問題', txt(h.knownIssues, openIssues.length ? list(openIssues.map(i => `[${label(m, 'issueSeverities', i.severity || 'medium')}] ${i.title}`)) : ''), '',
    '## 最新テスト結果',
    req.length ? `- 必須テスト ${pass.length}/${req.length} 合格` : '- 必須テストなし',
    ...ng.map(t => `- 未合格：${t.item}（${label(m, 'testStatuses', t.status || latestResult(t))}）${t.error ? `：${t.error}` : ''}`), '',
    '## 実機確認', list(devSummary(devices, m)),
    ...publish.map(x => `- 公開：${x.target || ''}（${label(m, 'accessResults', x.access || 'unchecked')}${x.environment ? `・${x.environment}` : ''}）`), '',
    '## 最後に変更したファイル', list(recentFiles.map(f => `${f.fileName} ${f.version || ''}（${(f.updatedAt || '').slice(0, 10)}・仕様 ${f.specVersion || '未指定'}）`)), '',
    '## 次に行うこと', txt(h.nextSteps, openTasks.length ? list(openTasks.slice(0, 8).map(t => `[${label(m, 'taskPriorities', t.priority || 'medium')}] ${t.title}（担当：${label(m, 'taskAssignees', t.ai || 'user')}）`)) : ''), '',
    '## 注意事項', txt(h.notes), '',
  ].join('\n');
}

export async function handoffTab({ ctx, el, p }) {
  const m = ctx.master;
  const d = await collectHandoff(ctx.db, p);
  const md = projectHandoffMarkdown(p, d, m);
  const h = d.handoff;
  el.innerHTML = `<section class="card">
      <h2>このプロジェクトの引継ぎ</h2>
      <p class="muted">Claudeの利用上限や別のセッションに移るときは、これをコピーして最初に貼り付けると続きから再開できます。現在Version・状態・テスト結果・実機確認・最後に変更したファイル・未解決事項・次の作業は自動で入ります。</p>
      <div class="btns"><button class="btn primary" id="ph-copy">引継ぎをコピー</button><button class="btn" id="ph-md">Markdownで保存</button></div>
      ${h.updatedAt ? `<p class="muted" style="margin-top:8px">手書き部分の最終更新：${fmtDate(h.updatedAt)}</p>` : '<p class="notice warn slim" style="margin-top:8px">「実装済み」と「次に行うこと」を書くと、「完成」の条件を1つ満たします。</p>'}
    </section>
    <section class="card">
      <h2>手で書く部分</h2>
      <form id="phf">${P_HANDOFF_FIELDS.map(([k, t]) => `<label class="field"><span>${esc(t)}</span><textarea name="${k}" rows="3">${esc(h[k] || '')}</textarea></label>`).join('')}
        <div id="phf-err"></div><button class="btn primary">引継ぎを保存</button></form>
    </section>
    <details class="card" open><summary><strong>プレビュー</strong></summary><pre class="md">${esc(md)}</pre></details>`;
  el.querySelector('#ph-copy').onclick = () => safeCopy(ctx, md, { what: '引継ぎ' });
  el.querySelector('#ph-md').onclick = () => { downloadText(`${safeFileName(p.name)}_handoff.md`, md); toast('Markdownファイルを保存しました'); };
  el.querySelector('#phf').onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(P_HANDOFF_FIELDS.map(([k]) => [k, e.target.elements[k].value.trim()]));
    try { await ctx.db.saveProjectHandoff(p.id, data); toast('引継ぎを保存しました'); ctx.refresh(); }
    catch (err) { el.querySelector('#phf-err').innerHTML = errorHtml(err); }
  };
}
