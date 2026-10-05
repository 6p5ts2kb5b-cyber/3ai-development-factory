// 3AI関連の計算（Phase 5）：役割・依頼文・おすすめAI・URL種類・ファイルの最新版判定。画面に依存しない。
import { label } from './master.js';
import { compareVersion } from './logic.js';

export const AIS = ['chatgpt', 'claude', 'gemini'];

// 役割：基本はmaster（設定値）、プロジェクトごとに変更可能（project.aiRoles）
export function aiRoles(master, project = {}) {
  return Object.fromEntries(AIS.map(k => [k, (project.aiRoles?.[k] || '').trim() || master.aiRoleSummary?.[k] || (master.aiList.find(a => a.key === k)?.roles || []).join('・')]));
}

// 次のおすすめAI（おすすめに留める。Factoryが選んで実行することはない）
export function recommendAI(project, { urls = [], tasks = [] } = {}, master) {
  const yt = urls.some(u => u.kind === 'youtube' && !(u.summary || '').trim());
  if (yt && master.aiRecommendYoutube) return { ...master.aiRecommendYoutube, label: label(master, 'aiList', master.aiRecommendYoutube.ai) };
  const rule = (master.aiRecommend || []).find(r => r.statuses.includes(project.status));
  if (!rule) return null;
  return { ai: rule.ai, reason: rule.reason, label: label(master, 'aiList', rule.ai) };
}

// 3AI比較用の依頼文
export function buildComparePrompt(set, project, spec, ai, master) {
  const roles = aiRoles(master, project);
  const name = label(master, 'aiList', ai);
  const parts = [
    `あなたは「3AI Development Factory」で${name}として、${roles[ai]}を担当しています。`,
    '利用者はプログラミング初心者です。専門用語には短い説明を付けてください。', '',
    `【プロジェクト名】${project.name}`,
    `【目的】${project.purpose || '（未記入）'}`,
    `【相談テーマ】${set.topic}`, '',
    `【最新確定仕様】${spec ? spec.version : 'まだありません'}`,
  ];
  if (spec && set.includeSpec !== false) parts.push('```', String(spec.body || '').trim(), '```');
  parts.push('', '【今回相談したい内容】', (set.question || '').trim() || '（未記入）');
  if ((set.conditions || '').trim()) parts.push('', '【絶対に守る条件】', set.conditions.trim());
  if ((set.problems || '').trim()) parts.push('', '【現在の問題】', set.problems.trim());
  parts.push('', '【必要な出力形式】', (set.outputFormat || '').trim() || '見出し付きの箇条書き');
  parts.push('', master.promptGuide?.commonFooter || '');
  return parts.join('\n');
}

// URL要約をAIに頼む依頼文（取得できないURLでもAI側で開いて要約してもらう）
export function buildUrlPrompt(u, project, master) {
  return [
    '次のURLの内容を日本語で要約してください。',
    `URL：${u.url}`, u.title ? `タイトル：${u.title}` : '', '',
    '出力は次の3つの見出しで書いてください。',
    '1. 要約（3〜5行）', '2. 重要ポイント（箇条書き）', `3. 「${project?.name || 'このプロジェクト'}」への活用案（箇条書き）`,
    project?.purpose ? `\n参考：このプロジェクトの目的は「${project.purpose}」です。` : '',
    '\nURLを開けない場合は、推測で書かずに「開けませんでした」と答えてください。',
  ].filter(x => x !== '').join('\n');
}
export const recommendForUrl = kind => (kind === 'youtube' ? 'gemini' : kind === 'x' ? 'gemini' : 'chatgpt');

export function detectUrlKind(url) {
  let h = '';
  try { h = new URL(url).hostname.replace(/^www\.|^m\./, ''); } catch { return 'other'; }
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return 'youtube';
  if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'x';
  if (/(^|\.)instagram\.com$/.test(h)) return 'instagram';
  return 'web';
}

// ファイルの最新版：同じファイル名の中で「使用中」かつ最も新しいVersion（使用中が無ければ最も新しいVersion）
export function groupFiles(files) {
  const by = {};
  for (const f of files) (by[f.fileName] ||= []).push(f);
  return Object.entries(by).map(([fileName, list]) => {
    const sorted = list.slice().sort((a, b) => compareVersion(b.version || 'v0', a.version || 'v0') || (a.createdAt < b.createdAt ? 1 : -1));
    const actives = sorted.filter(f => (f.status || 'active') === 'active');
    const latest = actives[0] || sorted[0];
    return { fileName, latest, others: sorted.filter(f => f !== latest), activeCount: actives.length };
  }).sort((a, b) => a.latest.updatedAt < b.latest.updatedAt ? 1 : -1);
}
