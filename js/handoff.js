// 引継ぎ情報：別セッション・別AIでも続きから再開できるよう、常に最新状態を保持します。
// ・config/handoff.json … 開発側（Claude等）が各Phase終了時に更新して配布する公式の引継ぎ
// ・端末内 settings 'lastTestRun' … テストページを実行した最新結果（自動保存）
export const HANDOFF_FIELDS = [
  ['implemented', '実装済み'],
  ['notImplemented', '未実装'],
  ['errors', '現在のエラー'],
  ['knownIssues', '既知の問題'],
  ['lastChangedFiles', '最後に変更したファイル'],
  ['nextSteps', '次に行う作業'],
];

export async function loadHandoff(url = new URL('../config/handoff.json', import.meta.url)) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('引継ぎファイルを読み込めませんでした');
  return r.json();
}

export function toMarkdown(h, testRun, extra = {}) {
  const L = [];
  L.push(`# 3AI Development Factory 引継ぎ情報`, '');
  L.push(`- 現在のPhase：${h.phase}（${h.phaseStatus}）`);
  L.push(`- Factory Version：${h.appVersion}`);
  L.push(`- 更新日時：${h.updatedAt}（${h.updatedBy}）`, '');
  if (h.phases?.length) {
    L.push('## 各Phaseの状態とテスト結果', '| Phase | 内容 | 状態 | テスト結果 |', '|---|---|---|---|', ...h.phases.map(p => `| ${p.no} | ${p.name} | ${p.status} | ${p.tests || '—'} |`), '');
  } else if (h.phaseLog?.length) { L.push('## Phaseの状況', ...h.phaseLog.map(x => `- ${x}`), ''); }
  if (extra.devices) {
    L.push('## 実機確認状況（Factory本体）', ...(extra.devices.length ? extra.devices.map(d => `- ${d.device}：${d.statusLabel}${d.checkedAt ? `（${d.checkedAt}）` : ''}${d.result ? `：${d.result}` : ''}`) : ['- 未登録']), '');
  }
  if (extra.publish?.length) L.push('## 公開確認', ...extra.publish.map(x => `- ${x.target || ''}：${x.accessLabel}${x.environment ? `（${x.environment}から）` : ''}`), '');
  if (h.nextPhase) L.push('## 次Phase', `- ${h.nextPhase}`, '');
  if (h.rules?.length) L.push('## 重要な設計ルール', ...h.rules.map(x => `- ${x}`), '');
  for (const [k, title] of HANDOFF_FIELDS) {
    L.push(`## ${title}`);
    const items = h[k] || [];
    L.push(...(items.length ? items.map(x => `- ${x}`) : ['- なし']), '');
  }
  L.push('## テスト結果');
  const t = testRun || h.testResults;
  if (t) {
    L.push(`- 実行日時：${t.runAt}`, `- 合格 ${t.passed} / ${t.total}（不合格 ${t.failed}）`);
    for (const d of t.details || []) L.push(`  - ${d.ok ? '✅' : '❌'} ${d.name}${d.error ? `：${d.error}` : ''}`);
  } else L.push('- 未実行');
  L.push('');
  return L.join('\n');
}
