// 入力チェック（誤入力対策）。必須項目・選択肢・形式をここで一元管理します。
export class FactoryError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'FactoryError';
    this.details = details;
  }
}

// enums の値は master.json のどのリストを参照するか
export const SCHEMAS = {
  projects: { required: { name: 'プロジェクト名' }, maxLen: { name: 100, nextAction: 200, memo: 5000, targetUsers: 500 }, enums: { status: 'statuses', deliverableType: 'deliverableTypes', origin: 'projectOrigins', importStatus: 'importStatuses' } },
  specs:    { required: { projectId: 'プロジェクト', version: 'Version' }, maxLen: { title: 200, reason: 1000 }, enums: { status: 'specStatuses' }, patterns: { version: [/^v\d+\.\d+$/, 'Versionは v1.0 の形式で入力してください'] } },
  guides:   { required: { projectId: 'プロジェクト', markdown: '指示書の本文' } },
  requests: { required: { projectId: 'プロジェクト', title: '要望の内容' }, enums: { status: 'requestStatuses' } },
  compares: { required: { projectId: 'プロジェクト', topic: '相談のテーマ' }, maxLen: { topic: 200 }, enums: { status: 'compareStatuses' } },
  files:    { required: { projectId: 'プロジェクト', fileName: 'ファイル名' }, maxLen: { fileName: 200, code: [300000, 'コードが大きすぎます（30万文字まで）。大きいファイルはFactoryに保存せず、ファイル名と保存場所だけ登録してください'] }, enums: { status: 'fileStatuses', ai: 'taskAssignees' } },
  tests:    { required: { projectId: 'プロジェクト', item: 'テスト名' }, maxLen: { item: 200 }, enums: { result: 'testResults', retestResult: 'testResults', fixStatus: 'fixStatuses', status: 'testStatuses' } },
  checks:   { required: { projectId: 'プロジェクト', kind: '種類' }, enums: { status: 'deviceCheckStatuses', access: 'accessResults', offline: 'checkYesNo', homescreen: 'checkYesNo' }, patterns: { kind: [/^(device|publish)$/, '種類が正しくありません'] } },
  urls:     { required: { url: 'URL' }, maxLen: { url: 2000 }, enums: { kind: 'urlKinds' }, patterns: { url: [/^https?:\/\/\S+$/, 'URLは http:// または https:// で始めてください'] } },
  issues:   { required: { projectId: 'プロジェクト', title: '未解決事項の内容' }, maxLen: { title: 300 }, enums: { status: 'issueStatuses', severity: 'issueSeverities' }, patterns: { occurredAt: [/^\d{4}-\d{2}-\d{2}$/, '発生日は日付で入力してください'] } },
  tasks:    { required: { projectId: 'プロジェクト', title: '作業内容' }, maxLen: { title: 200 }, enums: { status: 'taskStatuses', priority: 'taskPriorities', ai: 'taskAssignees' } },
  ideas:    { required: { text: 'やりたいこと' }, maxLen: { text: 5000 }, enums: { status: 'ideaStatuses', chosenType: 'deliverableTypes' } },
  settings: {},
  handoff:  {},
};

export function validate(store, rec, master) {
  const s = SCHEMAS[store];
  if (!s) throw new FactoryError(`保存先「${store}」は存在しません`);
  const errs = [];
  for (const [k, label] of Object.entries(s.required || {})) {
    const v = rec[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) errs.push(`「${label}」は必須です`);
  }
  for (const [k, v] of Object.entries(s.maxLen || {})) {
    const [n, msg] = Array.isArray(v) ? v : [v, `「${k}」は${v}文字以内にしてください`];
    if (typeof rec[k] === 'string' && rec[k].length > n) errs.push(msg);
  }
  for (const [k, [re, msg]] of Object.entries(s.patterns || {})) {
    if (rec[k] != null && rec[k] !== '' && !re.test(String(rec[k]))) errs.push(msg);
  }
  if (master) {
    for (const [k, listName] of Object.entries(s.enums || {})) {
      if (rec[k] == null || rec[k] === '') continue;
      const list = master[listName] || [];
      if (!list.some(o => o.key === rec[k])) errs.push(`「${k}」の値「${rec[k]}」は選択肢にありません`);
    }
  }
  if (errs.length) throw new FactoryError('入力内容を確認してください', errs);
}
