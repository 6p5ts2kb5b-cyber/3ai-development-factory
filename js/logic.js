// 画面に依存しない計算処理（自動テストで直接確認できるよう分離）
import { label } from './master.js';

// テストの最新結果（再テストがあればそちらを優先）— db.js の完成ガードと同じ規則
// テストの現在の結果（Phase 6：状態 status を優先。修正中・再テスト待ちは「まだ合格していない」）
export const latestResult = t => {
  if (t.status) return t.status === 'pass' ? 'pass' : ['fail', 'fixing', 'retest'].includes(t.status) ? 'fail' : 'untested';
  return (t.retestResult && t.retestResult !== 'untested') ? t.retestResult : (t.result || 'untested');
};
export const isRequiredTest = t => t.required !== false;

// 次のVersion（v1.2 → v1.3、major なら v2.0）
export function nextVersion(v = 'v1.0', major = false) {
  const [a, b] = String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  return major ? `v${a + 1}.0` : `v${a}.${b + 1}`;
}

// Version比較（v1.10 > v1.9）
export function compareVersion(a = '', b = '') {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// 完成度：8項目の平均。
// extra を渡すと（Phase 6）、実データと自動連動：企画・仕様・実装・テスト・解説/引継ぎ・公開/使用開始。
// 自動判定できない「UI」「データ」（と、ファイル未登録時の「実装」）だけ手動（10%刻み）。
export const HANDOFF_KEYS = ['implemented', 'notImplemented', 'knownIssues', 'nextSteps', 'notes'];
export function computeProgress(project, tests, master, extra) {
  const manual = project.progress || {};
  const man = k => Math.max(0, Math.min(100, Number(manual[k]) || 0));
  const auto = (value, note) => ({ value: Math.round(Math.max(0, Math.min(100, value))), auto: true, note });
  const req = extra ? tests.filter(isRequiredTest) : tests;
  const calc = {
    test: () => {
      if (!req.length) return extra ? auto(0, '必須テスト未登録') : null;
      const pass = req.filter(t => latestResult(t) === 'pass').length;
      return auto(pass / req.length * 100, `${extra ? '必須' : ''}テスト ${pass}/${req.length} 合格`);
    },
  };
  if (extra) {
    const specs = extra.specs || [], files = extra.files || [], devices = extra.devices || [], publish = extra.publish || [], ho = extra.handoff || {};
    const fixed = specs.filter(x => (x.status || 'fixed') === 'fixed').sort((a, b) => compareVersion(b.version, a.version))[0];
    calc.planning = () => {
      const parts = [[project.purpose, 40, '目的'], [project.targetUsers, 20, '対象ユーザー'], [(project.targetDevices || []).length, 20, '対象端末'], [project.deliverableType, 20, '作る形']];
      const miss = parts.filter(x => !x[0]).map(x => x[2]);
      return auto(parts.reduce((n, x) => n + (x[0] ? x[1] : 0), 0), miss.length ? `未入力：${miss.join('・')}` : '目的・対象・作る形が決定');
    };
    calc.spec = () => fixed ? auto(100, `確定仕様 ${fixed.version}`) : specs.length ? auto(50, '変更案のみ（未確定）') : auto(0, '仕様書なし');
    calc.impl = () => {
      const act = files.filter(f => (f.status || 'active') === 'active');
      if (!act.length) return null; // ファイル未登録なら手動
      const ok = fixed ? act.filter(f => f.specVersion === fixed.version).length : 0;
      return auto(fixed ? ok / act.length * 100 : 50, fixed ? `使用中ファイル ${ok}/${act.length} が最新仕様 ${fixed.version} に対応` : '確定仕様がないため50%');
    };
    calc.handoff = () => { const n = HANDOFF_KEYS.filter(k => String(ho[k] || '').trim()).length; return auto(n / HANDOFF_KEYS.length * 100, `引継ぎ ${n}/${HANDOFF_KEYS.length} 項目記入`); };
    calc.release = () => {
      if (!devices.length && !publish.length) return auto(0, '実機確認・公開確認が未登録');
      const dp = devices.length ? devices.filter(d => d.status === 'pass').length / devices.length : 0;
      const pub = publish.some(x => x.access === 'ok') ? 1 : 0;
      return auto(dp * 60 + pub * 40, `実機確認 ${devices.filter(d => d.status === 'pass').length}/${devices.length} 合格・公開確認${pub ? 'あり' : 'なし'}`);
    };
  }
  const axes = master.progressAxes.map(a => {
    const r = calc[a.key]?.();
    if (r) return { ...a, ...r };
    return { ...a, value: man(a.key), auto: false, note: a.key === 'test' ? 'テスト未登録' : '' };
  });
  const total = Math.round(axes.reduce((s, a) => s + a.value, 0) / axes.length);
  return { axes, total };
}

// 「完成」にできる条件（Phase 6）。何が足りないかを日本語で返す
export function completionItems({ specs = [], tests = [], issues = [], handoff = null, devices = [], backup = { ok: true } }, master) {
  const fixed = specs.find(x => (x.status || 'fixed') === 'fixed');
  const req = tests.filter(isRequiredTest);
  const notPass = req.filter(t => latestResult(t) !== 'pass');
  const serious = issues.filter(i => i.status !== 'resolved' && (i.severity || 'medium') === 'high');
  const ho = handoff || {};
  const hoOk = String(ho.implemented || '').trim() && String(ho.nextSteps || '').trim();
  const devNg = devices.filter(d => d.status !== 'pass');
  return [
    { key: 'spec', label: '最新の確定仕様がある', ok: !!fixed, detail: fixed ? `確定仕様 ${[...specs].filter(x => (x.status || 'fixed') === 'fixed').sort((a, b) => compareVersion(b.version, a.version))[0].version}` : '確定した仕様書がありません（仕様書タブで確定してください）' },
    { key: 'tests', label: '必須テストがすべて合格', ok: req.length > 0 && !notPass.length, detail: !req.length ? '必須テストが登録されていません（テストタブで共通テストを追加できます）' : notPass.length ? `合格していない必須テストが${notPass.length}件あります：${notPass.slice(0, 3).map(t => t.item).join('、')}${notPass.length > 3 ? ' ほか' : ''}` : `必須テスト ${req.length}件すべて合格` },
    { key: 'issues', label: '未解決の重大な問題が0件', ok: !serious.length, detail: serious.length ? `重要度「重要」の未解決事項が${serious.length}件あります：${serious.slice(0, 3).map(i => i.title).join('、')}` : '重大な問題はありません' },
    { key: 'handoff', label: '引継ぎ情報がある', ok: !!hoOk, detail: hoOk ? '引継ぎ情報あり' : '引継ぎタブの「実装済み」と「次に行うこと」が未記入です' },
    { key: 'backup', label: 'バックアップを作成できる', ok: !!backup.ok, detail: backup.ok ? 'バックアップの作成を確認しました' : `バックアップを作成できません：${backup.error || ''}` },
    { key: 'devices', label: '必要な実機確認が完了', ok: devices.length > 0 && !devNg.length, detail: !devices.length ? '実機確認が登録されていません（完成度タブで端末を登録してください）' : devNg.length ? `実機確認が終わっていない端末があります：${devNg.map(d => `${d.device}（${label(master, 'deviceCheckStatuses', d.status || 'unchecked')}）`).join('、')}` : `実機確認 ${devices.length}台すべて合格` },
  ];
}

const groupBy = (rows, key) => rows.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {});

// ホームのカード用まとめ
export function summarizeProjects(projects, { issues = [], requests = [], tests = [], specs = [], tasks = [], files, checks, handoffs }, master) {
  const extended = checks !== undefined; // Phase 6：実データと連動した完成度
  const gf = groupBy(files || [], 'projectId'), gc = groupBy(checks || [], 'projectId'), gh = Object.fromEntries((handoffs || []).map(h => [h.projectId, h]));
  const gi = groupBy(issues, 'projectId'), gr = groupBy(requests, 'projectId'), gt = groupBy(tests, 'projectId'), gs = groupBy(specs, 'projectId'), gk = groupBy(tasks, 'projectId');
  const openReq = new Set(master.requestStatuses.filter(s => s.open).map(s => s.key));
  return projects.map(p => {
    const pi = gi[p.id] || [], pr = gr[p.id] || [], pt = gt[p.id] || [], ps = gs[p.id] || [];
    const pk = gk[p.id] || [];
    const all = [p, ...pi, ...pr, ...pt, ...ps, ...pk];
    const nextTask = topTask(pk, master);
    const lastUpdated = all.reduce((m, r) => r.updatedAt > m ? r.updatedAt : m, '');
    const latestSpec = ps.filter(x => (x.status || 'fixed') === 'fixed').sort((a, b) => compareVersion(b.version, a.version))[0] || null; // 確定版のみ
    return {
      project: p,
      statusLabel: label(master, 'statuses', p.status) || '未設定',
      progress: extended ? computeProgress(p, pt, master, { specs: ps, files: gf[p.id] || [], devices: (gc[p.id] || []).filter(c => c.kind === 'device'), publish: (gc[p.id] || []).filter(c => c.kind === 'publish'), handoff: gh[p.id] || {} }) : computeProgress(p, pt, master),
      nextTask,
      next: nextTask ? nextTask.title : (p.nextAction || '').trim(),
      openTasks: pk.filter(t => isOpenTask(t, master)).length,
      openIssues: pi.filter(i => i.status !== 'resolved').length,
      openRequests: pr.filter(r => openReq.has(r.status || 'unreviewed')).length,
      unreviewed: pr.filter(r => (r.status || 'unreviewed') === 'unreviewed').length,
      latestSpec,
      lastUpdated,
    };
  }).sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : -1));
}

// 「話すだけ」：成果物の種類を提案（最終決定はユーザー）
export function suggestDeliverable(text, master) {
  const t = String(text || '');
  const ranked = (master.deliverableHints || []).map(h => ({ ...h, hits: h.words.filter(w => t.toLowerCase().includes(w.toLowerCase())) }))
    .filter(h => h.hits.length).sort((a, b) => b.hits.length - a.hits.length);
  if (!ranked.length) return [{ type: 'webapp', label: 'Webアプリ', hits: [], reason: '迷ったら、スマホとPCの両方で使えるWebアプリがおすすめです' }];
  return ranked;
}

// 個人情報の注意チェック（AIへ渡す前に表示）
export function privacyCheck(text, master) {
  const t = String(text || '');
  const found = (master.promptGuide?.privacyWarningWords || []).filter(w => t.includes(w));
  if (/\d{2,4}-\d{2,4}-\d{3,4}/.test(t)) found.push('電話番号らしき数字');
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) found.push('メールアドレス');
  return found;
}

// 3AIへ渡す依頼文（APIは使わず、コピーして各AIに貼り付ける）
export function buildPrompts(text, master, { projectName = '' } = {}) {
  const ai = Object.fromEntries(master.aiList.map(a => [a.key, a]));
  const footer = master.promptGuide?.commonFooter || '';
  const head = (k) => `あなたは「3AI Development Factory」で${ai[k].label}として、${ai[k].roles.join('・')}を担当しています。\n利用者はプログラミング初心者です。専門用語には短い説明を付けてください。\n${projectName ? `\n【プロジェクト】${projectName}\n` : ''}\n【利用者のやりたいこと】\n${String(text).trim()}\n`;
  const fmt = '\n回答は見出し付きの日本語で、箇条書き中心にまとめてください。\n' + footer;
  return {
    chatgpt: head('chatgpt') + `
【お願い】
1. やりたいことを整理してください（目的／使う人／使う端末）
2. 必要な機能と画面の案を挙げてください
3. 保存が必要なデータを挙げてください
4. 作る形の候補（Webアプリ・Excel/VBA・文書・PDF・その他）と、それぞれの向き不向き
5. 仕様を決めるために、利用者へ確認すべき質問（5つ以内）
` + fmt,
    claude: head('claude') + `
【お願い】（まだコードは書かないでください）
1. 無料で作れる実現方法の案（月額料金がかからない構成）
2. 技術的に難しい点・注意点
3. 実装を小さな段階（Phase）に分けた案
4. 外部サービスが止まっても使い続けられるための工夫
` + fmt,
    gemini: head('gemini') + `
【お願い】
1. Googleのサービス（フォーム・スプレッドシート・カレンダー等）と連携できそうな点
2. ChatGPT・Claudeとは別の視点から、見落としやすい点・リスク
3. 参考になりそうな既存アプリや資料の探し方
` + fmt,
  };
}

// ================= Phase 3 =================
export const isOpenTask = (t, master) => !!master.taskStatuses.find(s => s.key === (t.status || 'todo'))?.open;
const orderOf = (list, key, dflt = 99) => list.find(o => o.key === key)?.order ?? dflt;

// 作業の並び：未完了を先に → 優先度（高→低）→ 進行中を先に → 古い順
export function sortTasks(tasks, master) {
  return tasks.slice().sort((a, b) =>
    (isOpenTask(b, master) - isOpenTask(a, master)) ||
    (orderOf(master.taskPriorities, a.priority || 'medium') - orderOf(master.taskPriorities, b.priority || 'medium')) ||
    ((b.status === 'doing') - (a.status === 'doing')) ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
// ホームに出す「最優先の未完了作業」（未着手・進行中のみ。保留・完了は出さない）
export function topTask(tasks, master) {
  const open = tasks.filter(t => isOpenTask(t, master));
  return open.length ? sortTasks(open, master)[0] : null;
}

// 未解決事項の並び：未解決を先に → 重要度 → 発生日の古い順
export function sortIssues(issues, master) {
  return issues.slice().sort((a, b) =>
    ((a.status === 'resolved') - (b.status === 'resolved')) ||
    (orderOf(master.issueSeverities, a.severity || 'medium') - orderOf(master.issueSeverities, b.severity || 'medium')) ||
    ((a.occurredAt || a.createdAt || '') < (b.occurredAt || b.createdAt || '') ? -1 : 1));
}

// ホームの検索・絞り込み・並べ替え
// f = { q, group, status, progress, updated, sort }
export function filterProjects(cards, f, master, nowDate = new Date()) {
  const q = (f.q || '').trim().toLowerCase();
  const group = (master.projectGroups || []).find(g => g.key === f.group);
  const pr = (master.progressRanges || []).find(r => r.key === f.progress);
  const up = (master.updatedRanges || []).find(r => r.key === f.updated);
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const out = cards.filter(c => {
    const p = c.project;
    if (q && ![p.name, p.purpose, p.memo, p.targetUsers, c.next].some(v => String(v || '').toLowerCase().includes(q))) return false;
    if (group && !group.statuses.includes(p.status)) return false;
    if (f.status && p.status !== f.status) return false;
    if (pr && !(c.progress.total >= pr.min && c.progress.total <= pr.max)) return false;
    if (up) {
      const t = new Date(c.lastUpdated).getTime();
      if (up.days === 0 && !(t >= startOfToday)) return false;
      if (up.days > 0 && !(t >= startOfToday - up.days * 86400000)) return false;
      if (up.days < 0 && !(t < startOfToday + up.days * 86400000)) return false;
    }
    return true;
  });
  const by = {
    updated: (a, b) => (a.lastUpdated < b.lastUpdated ? 1 : -1),
    progress: (a, b) => b.progress.total - a.progress.total || (a.lastUpdated < b.lastUpdated ? 1 : -1),
    name: (a, b) => a.project.name.localeCompare(b.project.name, 'ja'),
    status: (a, b) => orderOf(master.statuses, a.project.status) - orderOf(master.statuses, b.project.status) || (a.lastUpdated < b.lastUpdated ? 1 : -1),
  };
  return out.sort(by[f.sort] || by.updated);
}

// ================= Phase 7：既存アプリ取込 =================
// 確定仕様の箇条書きを「照合する項目」に分解（見出しごと）。照合結果は本文のキーで保存するので、Versionが上がっても引き継がれる
export function specItems(body = '') {
  const out = []; let head = '';
  for (const raw of String(body).replace(/\r\n?/g, '\n').split('\n')) {
    const h = raw.match(/^#{2,3}\s+(.+)/);
    if (h) { head = h[1].trim(); continue; }
    const b = raw.match(/^\s*(?:[-*・]|\d+[.)．])\s+(.+)/);
    if (b && head && !/^(絶対条件|技術上の注意|AIの役割|未実装／将来機能)/.test(head)) out.push({ key: `${head}｜${b[1].trim()}`, head, text: b[1].trim() });
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.key) && seen.add(x.key));
}
export function coverageSummary(items, coverage = {}) {
  const c = { unjudged: 0, done: 0, partial: 0, todo: 0, diff: 0 };
  for (const it of items) c[coverage[it.key]?.status || 'unjudged']++;
  return c;
}
