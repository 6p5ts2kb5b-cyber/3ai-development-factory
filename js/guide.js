// 仕様書のMarkdown出力と「Factory移行用指示書」（17項目）の生成。画面に依存しない（自動テスト対象）。
// 指示書は、確定仕様・作業・未解決事項・要望・ファイル・テスト等から自動で組み立て、
// 自動で埋められない項目は「指示書の追記」（project.guide）で補います。後のPhaseでファイル・テスト情報と連携します。
import { label } from './master.js';
import { latestResult, isOpenTask } from './logic.js';

export const GUIDE_SECTIONS = [
  ['purpose', '目的'], ['target', '対象ユーザー／端末'], ['spec', '確定仕様'], ['screens', '画面構成'], ['features', '機能'],
  ['data', '保存データ'], ['ai', 'AIの役割'], ['external', '外部サービス／API'], ['output', '印刷・PDF・共有'], ['absolute', '絶対条件'],
  ['urls', '既存URL'], ['source', 'ソースコード'], ['future', '未実装／将来機能'], ['history', '変更履歴'], ['issues', '既知の問題'],
  ['tests', 'テスト'], ['next', '次に実装すること'],
];
// 仕様書の見出し → 指示書の項目
const FROM_SPEC = { screens: ['画面構成', '画面'], features: ['機能'], data: ['保存データ', 'データ'], external: ['外部サービス・API', '外部サービス／API', '外部サービス'], output: ['印刷・PDF・共有', '出力'], absolute: ['絶対条件'] };
// 利用者が追記できる項目（project.guide に保存）
export const GUIDE_EDITABLE = ['screens', 'features', 'data', 'ai', 'external', 'output', 'absolute', 'urls', 'source', 'future', 'tests'];
const FACTORY_RULES = ['確定仕様をAIが勝手に削除・変更しない（変更は新しいVersionで）', '新しい案はまず要望箱へ入れ、採用されたものだけ仕様へ反映する', '無料運用を最優先し、有料APIや有料サービスは事前に明示して利用者が判断する', '外部サービスが止まってもアプリ全体が使えなくならない構成にする', '生徒等の個人情報をAIへ自動送信しない', '動いていない機能を「完成」と表示しない'];

// 「## 見出し」の中身を取り出す
export function extractSection(body = '', names = []) {
  const L = String(body).replace(/\r\n?/g, '\n').split('\n');
  for (const name of names) {
    const i = L.findIndex(l => /^#{2,3}\s+/.test(l) && l.replace(/^#{2,3}\s+/, '').trim() === name);
    if (i < 0) continue;
    const out = [];
    for (let k = i + 1; k < L.length && !/^#{1,2}\s+/.test(L[k]); k++) out.push(L[k]);
    const text = out.join('\n').trim();
    if (text) return text;
  }
  return '';
}

export function specToMarkdown(project, spec, master) {
  return [
    `<!-- 3AI Development Factory 仕様書：${project.name} ${spec.version} -->`,
    `# ${spec.title || project.name + ' 仕様書'}（${spec.version}）`, '',
    `- プロジェクト：${project.name}`,
    `- Version：${spec.version}（${label(master, 'specStatuses', spec.status || 'fixed')}）`,
    spec.fixedAt ? `- 確定日時：${spec.fixedAt}（${spec.fixedBy || ''}）` : `- 作成日時：${spec.createdAt}`,
    `- 変更元Version：${spec.baseVersion || 'なし（初版）'}`,
    `- 変更理由：${spec.reason || '—'}`, '',
    '---', '', String(spec.body || '').trim(), '',
  ].join('\n');
}

export function buildGuide(project, d, master) {
  const g = project.guide || {};
  const spec = d.spec; // 最新の確定仕様
  const sec = {};
  const list = (arr, empty = '- なし') => arr.length ? arr.map(x => `- ${x}`).join('\n') : empty;
  const join = (...parts) => parts.filter(x => x && String(x).trim()).join('\n\n');
  const fromSpec = k => spec ? extractSection(spec.body, FROM_SPEC[k]) : '';
  const blank = '（未記入：仕様書の該当見出し、または「指示書の追記」に書いてください）';

  sec.purpose = project.purpose || blank;
  const devs = (project.targetDevices || []).map(k => label(master, 'targetDevices', k));
  sec.target = `- 対象ユーザー：${project.targetUsers || '未記入'}\n- 対象端末：${devs.length ? devs.join('・') : '未記入'}`;
  sec.spec = spec ? `確定Version：${spec.version}（${spec.fixedAt || ''} 確定）\n\n${String(spec.body || '').trim()}` : '確定した仕様書はまだありません。';
  for (const k of ['screens', 'features', 'data', 'external', 'output']) sec[k] = join(fromSpec(k), g[k]) || blank;
  sec.ai = join(master.aiList.map(a => `- ${a.label}：${a.roles.join('・')}`).join('\n'), g.ai);
  sec.absolute = join(fromSpec('absolute'), g.absolute, '【Factory共通】\n' + list(FACTORY_RULES));
  // Phase 7：既存アプリ取込の情報（登録されたものだけ。推測で埋めない）
  const ex = project.existing || {};
  const isEx = project.origin === 'existing';
  const exHead = project.origin === 'unknown' ? '- 既存アプリの有無：未確認（ある場合はゼロから作り直さず、現在のアプリを取り込んでから改良する）'
    : isEx ? [`- 既存アプリ：${label(master, 'importStatuses', ex.importStatus || 'waiting')}（ゼロから作り直さない。現在のコードを基準Versionとして改良する）`,
      ex.appName && `- アプリ名：${ex.appName}`, ex.webUrl && `- 現在のWeb URL：${ex.webUrl}`, ex.githubUrl && `- GitHub：${ex.githubUrl}`,
      ex.currentVersion && `- 現在のVersion：${ex.currentVersion}`, ex.publishState && `- 公開状態：${ex.publishState}`,
      ex.baseline && `- 基準Version：${ex.baseline.currentVersion}（${(ex.baseline.at || '').slice(0, 10)} 取込）`,
      ex.storage && `- データ保存方式：${ex.storage}`, ex.externalServices && `- 外部サービス：${ex.externalServices}`,
      ex.implemented && `- 実装済み：${ex.implemented}`, ex.testStatus && `- テスト状況：${ex.testStatus}`, ex.nextImprovements && `- 次に改良すること：${ex.nextImprovements}`].filter(Boolean).join('\n') : '';
  sec.urls = join(exHead, g.urls) || '（なし）';
  sec.source = join(isEx && ex.githubUrl ? `- 既存アプリのソース：${ex.githubUrl}` : '', list((d.files || []).map(f => `${f.fileName}${f.version ? ` ${f.version}` : ''}${f.type ? `（${f.type}）` : ''}${f.memo ? `：${f.memo}` : ''}`), ''), g.source) || '（ソースコード・ファイルはまだ登録されていません）';
  const future = (d.requests || []).filter(r => ['adopted', 'on_hold'].includes(r.status) && r.specState !== 'fixed')
    .map(r => `${r.title}（${label(master, 'requestStatuses', r.status)}${r.specState === 'candidate' ? `・${r.specVersion}候補` : ''}）`);
  sec.future = join(list(future, ''), isEx && ex.notImplemented ? `【既存アプリの未実装】\n${ex.notImplemented}` : '', g.future) || '- なし';
  sec.history = list((d.fixes || []).map(h => `${(h.at || '').slice(0, 10)} ${h.details?.oldVersion || '（新規）'} → ${h.details?.newVersion}：${h.reason}${h.details?.requestTitles?.length ? `（元の要望：${h.details.requestTitles.join('、')}）` : ''}`), '- 確定の履歴はまだありません');
  sec.issues = join(list((d.issues || []).filter(i => i.status !== 'resolved').map(i => `[${label(master, 'issueSeverities', i.severity || 'medium')}] ${i.title}`)), isEx && ex.knownIssues ? `【既存アプリの既知の問題】\n${ex.knownIssues}` : '');
  sec.tests = join(list((d.tests || []).map(t => `${t.item}：${label(master, 'testResults', latestResult(t))}`), ''), g.tests) || '（テストはまだ登録されていません）';
  sec.next = list((d.tasks || []).filter(t => isOpenTask(t, master)).map(t => `[${label(master, 'taskPriorities', t.priority || 'medium')}] ${t.title}（担当：${label(master, 'taskAssignees', t.ai || 'user')}）`));

  const head = [
    `<!-- 3AI Development Factory 移行用指示書：${project.name} -->`,
    `# Factory移行用指示書：${project.name}`, '',
    `- 作成日時：${d.generatedAt || new Date().toISOString()}`,
    `- 確定仕様：${spec ? spec.version : 'なし'}`,
    `- 状態：${label(master, 'statuses', project.status)}`, '',
    '> この指示書は ChatGPT・Claude・Gemini にそのまま貼り付けて使えます。確定仕様を勝手に削除・変更せず、新しい案は「提案」として出してください。', '',
  ];
  return head.concat(GUIDE_SECTIONS.flatMap(([k, t], i) => [`## ${i + 1}. ${t}`, '', sec[k], ''])).join('\n');
}
