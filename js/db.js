// 3AI Development Factory — データ層
// ・端末内データベース（IndexedDB）だけで全機能が動きます（外部サービス不要）
// ・全レコードに ID / 作成日時 / 更新日時 / 作成者 / 更新者 / rev を自動付与
// ・作成・更新・削除・復元・取込は変更履歴（history）に自動記録
// ・削除はゴミ箱（trash）へ移動するだけなので復元できます
// ・JSONバックアップ / 復元（復元は1トランザクションで行い、失敗時は元データのまま）
import { validate, FactoryError } from './schema.js';
import { compareVersion, nextVersion, completionItems, specItems } from './logic.js';
import { diffLines, diffSummary, diffText } from './diff.js';
import { detectUrlKind as detectKind } from './ai.js';

export const APP_ID = '3ai-factory';
export const SCHEMA_VERSION = 5; // v2（Phase 2）：issues・ideas 追加、history に projectId 索引 / v3（Phase 3）：tasks 追加 / v4（Phase 4）：guides 追加 / v5（Phase 6）：checks 追加・handoff に projectId 索引

// 保存先と検索用インデックス
export const STORES = {
  projects: ['status', 'updatedAt'],
  specs:    ['projectId'],
  requests: ['projectId', 'status'],
  compares: ['projectId'],
  files:    ['projectId'],
  tests:    ['projectId'],
  urls:     ['projectId'],
  issues:   ['projectId', 'status'],   // 未解決事項（Phase 2）
  ideas:    ['status'],                // 「話すだけ」相談メモ（Phase 2）
  tasks:    ['projectId', 'status'],   // 次にやること（作業）（Phase 3）
  guides:   ['projectId'],             // Factory移行用指示書の保存版（Phase 4）
  settings: [],
  handoff:  ['projectId'],             // プロジェクト別の引継ぎ（Phase 6）
  checks:   ['projectId', 'kind'],     // 実機確認・公開確認（Phase 6）
  history:  ['recordId', 'at', 'store', 'projectId'],
  trash:    ['store', 'deletedAt'],
};
// プロジェクトに紐づく関連データ（プロジェクト削除時にまとめてゴミ箱へ）— Phase 3
export const PROJECT_CHILD_STORES = ['specs', 'requests', 'compares', 'files', 'tests', 'urls', 'issues', 'tasks', 'guides', 'checks', 'handoff'];
// 確認記録の並び：登録時の順番（order）→ 登録日時
export const sortChecks = list => list.slice().sort((a, b) => (Number.isFinite(a.order) && Number.isFinite(b.order) && a.order !== b.order) ? a.order - b.order : (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
// Factory本体の実機確認・公開確認を記録するための固定ID（プロジェクトではない）
export const FACTORY_ID = '__factory__';
// 複製してよいもの（履歴・テスト結果・エラー履歴・3AI比較は複製しない）
export const DUPLICABLE_STORES = ['specs', 'tasks', 'requests', 'files'];
const PROJECT_BASE_FIELDS = ['purpose', 'targetUsers', 'targetDevices', 'memo', 'deliverableType'];

// 利用者データ（history / trash 以外）
export const DATA_STORES = Object.keys(STORES).filter(s => s !== 'history' && s !== 'trash');
const META = ['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'rev', 'deviceId'];

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
export const now = () => new Date().toISOString();

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new FactoryError('保存処理が中断されました'));
});

function deviceId() {
  try {
    let d = localStorage.getItem('factory.deviceId');
    if (!d) { d = uid(); localStorage.setItem('factory.deviceId', d); }
    return d;
  } catch { return 'unknown-device'; }
}

// 履歴をプロジェクト単位で見られるよう、どのプロジェクトのデータかを記録
export const projectOf = (store, rec) => (store === 'projects' ? rec?.id : rec?.projectId) || '';

// 仕様書の状態（Phase 4）：draft＝変更案（編集可）／fixed＝確定（変更・削除不可）。
// 状態の無い古いデータは安全側に倒して「確定」扱い。
export const specStatus = sp => sp?.status || 'fixed';
export const FIXED_SPEC_ERROR = v => new FactoryError(`${v} は確定済みの仕様です。直接編集はできません`, [
  '確定した内容を守るため、確定Versionは上書きできません。',
  '変更したいときは「この仕様をもとに変更案を作る」から新しいVersionを作り、差分を確認して確定してください。',
]);

// 変更前後の差分（履歴用）
export function diff(before = {}, after = {}) {
  const out = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (META.includes(k)) continue;
    const a = JSON.stringify(before[k]), b = JSON.stringify(after[k]);
    if (a !== b) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

export class FactoryDB {
  static async open(name = 'factory') {
    if (!globalThis.indexedDB) throw new FactoryError('このブラウザは端末内保存（IndexedDB）に対応していません。Safari / Chrome / Edge の最新版でお試しください。');
    const r = indexedDB.open(name, SCHEMA_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [store, idx] of Object.entries(STORES)) {
        const os = db.objectStoreNames.contains(store) ? r.transaction.objectStore(store) : db.createObjectStore(store, { keyPath: 'id' });
        for (const i of idx) if (!os.indexNames.contains(i)) os.createIndex(i, i);
      }
    };
    const idb = await req(r);
    return new FactoryDB(idb, name);
  }

  constructor(idb, name) {
    this.idb = idb;
    this.name = name;
    this.master = null;
    this.actor = 'ユーザー';
    this.device = deviceId();
    // 別タブで新しい版が開かれたら接続を閉じる（更新を妨げない）
    idb.onversionchange = () => idb.close();
  }

  setMaster(m) { this.master = m; }
  close() { this.idb.close(); }

  _tx(stores, mode = 'readonly') { return this.idb.transaction(stores, mode); }

  _history(tx, entry) {
    tx.objectStore('history').put({ id: uid(), at: now(), actor: entry.actor || this.actor, deviceId: this.device, ...entry });
  }

  // ---- 読み取り ----
  async get(store, id) { return req(this._tx(store).objectStore(store).get(id)); }
  async all(store) { return req(this._tx(store).objectStore(store).getAll()); }
  async byIndex(store, index, value) { return req(this._tx(store).objectStore(store).index(index).getAll(value)); }
  async count(store) { return req(this._tx(store).objectStore(store).count()); }

  // 検索・絞込み：where は完全一致、text は指定フィールドの部分一致（大文字小文字無視）
  async query(store, { where = {}, text = '', fields = [], sort = 'updatedAt', desc = true } = {}) {
    let rows = await this.all(store);
    rows = rows.filter(r => Object.entries(where).every(([k, v]) => r[k] === v));
    const t = text.trim().toLowerCase();
    if (t) {
      rows = rows.filter(r => (fields.length ? fields : Object.keys(r))
        .some(f => r[f] != null && String(typeof r[f] === 'object' ? JSON.stringify(r[f]) : r[f]).toLowerCase().includes(t)));
    }
    if (sort) rows.sort((a, b) => (a[sort] > b[sort] ? 1 : a[sort] < b[sort] ? -1 : 0) * (desc ? -1 : 1));
    return rows;
  }

  // ---- 「完成」ガード（Phase 6で厳格化）：条件を1つでも満たさなければ「完成」にできない ----
  async _guardComplete(store, rec) {
    if (store !== 'projects' || rec.status !== 'complete') return;
    const items = await this.completionCheck(rec.id);
    const ng = items.filter(i => !i.ok);
    if (ng.length) throw new FactoryError('「完成」にできません', ng.map(i => `${i.label}：${i.detail}`));
  }

  // 「完成」の条件を1つずつ確認（画面の表示にも使う）
  async completionCheck(projectId) {
    const [specs, tests, issues, checks] = await Promise.all(['specs', 'tests', 'issues', 'checks'].map(s => this.byIndex(s, 'projectId', projectId)));
    const handoff = await this.get('handoff', `handoff-${projectId}`);
    let backup = { ok: true };
    try { FactoryDB.checkBackup(await this.exportAll()); } catch (e) { backup = { ok: false, error: e.message }; }
    return completionItems({ specs, tests, issues, handoff, devices: checks.filter(c => c.kind === 'device'), backup }, this.master);
  }

  // ---- 作成 ----
  async create(store, data, { actor, reason = '', internal = false } = {}) {
    if (!DATA_STORES.includes(store)) throw new FactoryError(`保存先「${store}」には直接登録できません`);
    const t = now();
    const who = actor || this.actor;
    const rec = { ...data, id: data.id || uid(), createdAt: t, updatedAt: t, createdBy: who, updatedBy: who, rev: 1, deviceId: this.device };
    if (rec.localOnly === undefined) rec.localOnly = false;
    if (store === 'specs' && !rec.status) rec.status = 'draft';
    validate(store, rec, this.master);
    await this._guardComplete(store, rec);
    await this._guardSpec(store, rec, null, internal);
    const tx = this._tx([store, 'history'], 'readwrite');
    const os = tx.objectStore(store);
    const exists = await req(os.get(rec.id));
    if (exists) { tx.abort(); throw new FactoryError('同じIDのデータが既にあります'); }
    os.put(rec);
    this._history(tx, { action: 'create', store, recordId: rec.id, projectId: projectOf(store, rec), actor: who, reason, changes: diff({}, rec) });
    await done(tx);
    return rec;
  }

  // ---- 更新 ----
  async update(store, id, patch, { actor, reason = '', internal = false } = {}) {
    if (!DATA_STORES.includes(store)) throw new FactoryError(`保存先「${store}」は編集できません`);
    const before = await this.get(store, id);
    if (!before) throw new FactoryError('編集するデータが見つかりません（削除された可能性があります）');
    const who = actor || this.actor;
    const clean = { ...patch };
    for (const k of META.concat('createdAt', 'createdBy')) delete clean[k];
    const after = { ...before, ...clean, id, updatedAt: now(), updatedBy: who, rev: (before.rev || 0) + 1, deviceId: this.device };
    validate(store, after, this.master);
    await this._guardComplete(store, after);
    await this._guardSpec(store, after, before, internal);
    if (store === 'tests' && !internal && before.status !== undefined && after.status !== before.status) {
      throw new FactoryError('テストの結果は「結果を記録」から入力してください', ['不合格→修正→再テストの履歴を残すためです。']);
    }
    const changes = diff(before, after);
    if (!Object.keys(changes).length) return before; // 変更なし
    const tx = this._tx([store, 'history'], 'readwrite');
    tx.objectStore(store).put(after);
    this._history(tx, { action: 'update', store, recordId: id, projectId: projectOf(store, after), actor: who, reason, changes });
    await done(tx);
    return after;
  }

  // 設定など、無ければ作成・あれば更新
  async upsert(store, id, data, opts = {}) {
    return (await this.get(store, id)) ? this.update(store, id, data, opts) : this.create(store, { ...data, id }, opts);
  }

  // ---- 削除（ゴミ箱へ移動）----
  async remove(store, id, { actor, reason = '' } = {}) {
    if (store === 'projects') return this._removeProjectBundle(id, { actor, reason }); // Phase 3：関連データもまとめて
    if (store === 'specs') { // Phase 4：確定Versionは削除できない（過去の確定内容を失わないため）
      const sp = await this.get('specs', id);
      if (sp && specStatus(sp) === 'fixed') throw new FactoryError(`${sp.version} は確定済みのため削除できません`, ['確定した仕様は履歴として必ず残します。内容を変えたい場合は、新しいVersionの変更案を作ってください。']);
    }
    const who = actor || this.actor;
    const tx = this._tx([store, 'trash', 'history'], 'readwrite');
    const rec = await req(tx.objectStore(store).get(id));
    if (!rec) { tx.abort(); throw new FactoryError('削除するデータが見つかりません'); }
    const trashId = uid();
    tx.objectStore(store).delete(id);
    tx.objectStore('trash').put({ id: trashId, store, recordId: id, record: rec, deletedAt: now(), deletedBy: who, reason });
    this._history(tx, { action: 'delete', store, recordId: id, projectId: projectOf(store, rec), actor: who, reason, changes: {} });
    await done(tx);
    return trashId;
  }


  // ================= Phase 3：プロジェクト単位の削除・復元・複製 =================

  // プロジェクトと関連データ（仕様書・要望・3AI比較・ファイル・テスト・URL・未解決事項・作業・変更履歴）を
  // 1つの「まとまり」としてゴミ箱へ移す。1トランザクションなので、途中で失敗したら何も変わらない。
  // 他のプロジェクトのデータには触れない（projectId 索引で対象を限定）。
  async _removeProjectBundle(id, { actor, reason = '' } = {}) {
    const who = actor || this.actor;
    const tx = this._tx(['projects', ...PROJECT_CHILD_STORES, 'trash', 'history'], 'readwrite');
    const p = await req(tx.objectStore('projects').get(id));
    if (!p) { tx.abort(); throw new FactoryError('削除するプロジェクトが見つかりません'); }
    const related = {};
    let count = 0;
    for (const s of PROJECT_CHILD_STORES) {
      const rows = (await req(tx.objectStore(s).index('projectId').getAll(id))).filter(r => r.projectId === id);
      related[s] = rows; count += rows.length;
      for (const r of rows) tx.objectStore(s).delete(r.id);
    }
    const hist = (await req(tx.objectStore('history').index('projectId').getAll(id))).filter(h => h.projectId === id);
    related.history = hist;
    for (const h of hist) tx.objectStore('history').delete(h.id);
    tx.objectStore('projects').delete(id);
    const trashId = uid();
    tx.objectStore('trash').put({ id: trashId, kind: 'project-bundle', store: 'projects', recordId: id, record: p, related, relatedCount: count, historyCount: hist.length, deletedAt: now(), deletedBy: who, reason });
    this._history(tx, { action: 'delete', store: 'projects', recordId: id, projectId: '', bundleOf: id, actor: who, reason: reason || `プロジェクト「${p.name}」と関連データ${count}件をゴミ箱へ`, changes: {} });
    await done(tx);
    return trashId;
  }

  async _restoreProjectBundle(t, { actor, reason = '' } = {}) {
    const who = actor || this.actor;
    const stores = ['projects', ...PROJECT_CHILD_STORES, 'history', 'trash'];
    const tx = this._tx(stores, 'readwrite');
    const bump = r => ({ ...r, updatedAt: now(), updatedBy: who, rev: (r.rev || 0) + 1 });
    // 同じIDが既にあれば、何も変えずに中止（上書き事故を防ぐ）
    if (await req(tx.objectStore('projects').get(t.recordId))) { tx.abort(); throw new FactoryError('同じプロジェクトが既にあるため復元できません'); }
    for (const s of PROJECT_CHILD_STORES) {
      for (const r of t.related?.[s] || []) {
        if (await req(tx.objectStore(s).get(r.id))) { tx.abort(); throw new FactoryError('関連データと同じIDのデータが既にあるため復元できません（何も変更していません）'); }
      }
    }
    tx.objectStore('projects').put(bump(t.record));
    for (const s of PROJECT_CHILD_STORES) for (const r of t.related?.[s] || []) tx.objectStore(s).put(bump(r));
    for (const h of t.related?.history || []) tx.objectStore('history').put(h);
    tx.objectStore('trash').delete(t.id);
    this._history(tx, { action: 'restore', store: 'projects', recordId: t.recordId, projectId: t.recordId, actor: who, reason: reason || `関連データ${t.relatedCount || 0}件とともに復元`, changes: {} });
    await done(tx);
    return t.record;
  }

  // 複製：基本設定と、選んだ関連データ（仕様書・作業・要望・ファイル情報）だけをコピー。
  // 変更履歴・テスト結果・未解決事項（エラー履歴）・3AI比較はコピーしない。状態は「構想」、完成度は0%から。
  async duplicateProject(id, { name, include = { specs: true }, actor } = {}) {
    const who = actor || this.actor;
    const src = await this.get('projects', id);
    if (!src) throw new FactoryError('複製元のプロジェクトが見つかりません');
    const t = now();
    const meta = { createdAt: t, updatedAt: t, createdBy: who, updatedBy: who, rev: 1, deviceId: this.device, localOnly: !!src.localOnly };
    const np = { id: uid(), name: (name ?? `${src.name}（コピー）`).trim(), status: 'concept', copiedFrom: id, ...meta };
    for (const f of PROJECT_BASE_FIELDS) if (src[f] !== undefined) np[f] = Array.isArray(src[f]) ? [...src[f]] : src[f];
    validate('projects', np, this.master);
    const copies = [];
    for (const s of DUPLICABLE_STORES.filter(s => include[s])) {
      for (const r of await this.byIndex(s, 'projectId', id)) {
        const c = { ...r, ...meta, id: uid(), projectId: np.id, copiedFrom: r.id };
        if (s === 'tasks') { c.status = 'todo'; delete c.doneAt; }
        if (s === 'specs') c.requestIds = []; // 要望との紐付けは複製先では持たない
        if (s === 'requests') { c.specId = null; c.specVersion = null; c.specState = null; }
        validate(s, c, this.master);
        copies.push([s, c]);
      }
    }
    // 仕様書の「変更元」を複製先のIDに付け替える
    const specMap = Object.fromEntries(copies.filter(c => c[0] === 'specs').map(([, c]) => [c.copiedFrom, c.id]));
    for (const [st, c] of copies) if (st === 'specs' && c.baseSpecId) c.baseSpecId = specMap[c.baseSpecId] || null;
    const stores = ['projects', 'history', ...new Set(copies.map(c => c[0]))];
    const tx = this._tx(stores, 'readwrite');
    tx.objectStore('projects').put(np);
    this._history(tx, { action: 'create', store: 'projects', recordId: np.id, projectId: np.id, actor: who, reason: `「${src.name}」から複製`, changes: diff({}, np) });
    for (const [s, c] of copies) {
      tx.objectStore(s).put(c);
      this._history(tx, { action: 'create', store: s, recordId: c.id, projectId: np.id, actor: who, reason: `「${src.name}」から複製`, changes: {} });
    }
    await done(tx);
    return { project: np, copied: copies.length };
  }

  // Phase 2までの「次にやること」（1行の文字）を、作業データ（tasks）へ移す。1回だけ・何度実行しても安全。
  async migrateNextActions() {
    let n = 0;
    for (const p of await this.all('projects')) {
      const text = (p.nextAction || '').trim();
      if (!text) continue;
      const tasks = await this.byIndex('tasks', 'projectId', p.id);
      if (!tasks.some(t => t.title === text)) {
        await this.create('tasks', { projectId: p.id, title: text, priority: 'high', status: 'todo', ai: 'user', memo: '' }, { actor: 'Factory', reason: 'Phase 3：次にやることを作業データへ移行' });
      }
      await this.update('projects', p.id, { nextAction: '' }, { actor: 'Factory', reason: 'Phase 3：次にやることを作業データへ移行' });
      n++;
    }
    return n;
  }


  // ================= Phase 4：仕様書Version管理 =================
  async _guardSpec(store, rec, before, internal) {
    if (store !== 'specs') return;
    if (before && specStatus(before) === 'fixed') throw FIXED_SPEC_ERROR(before.version);
    if (rec.status === 'fixed' && !internal) throw new FactoryError('仕様の確定は「確定」の操作で行ってください', ['差分を確認してから確定する流れにしています。']);
    if (rec.status === 'draft' && !internal) {
      const others = (await this.byIndex('specs', 'projectId', rec.projectId)).filter(x => x.id !== rec.id);
      if (others.some(x => x.version === rec.version)) throw new FactoryError(`${rec.version} は既にあります`, ['別のVersion番号にしてください。']);
      if (!before && others.some(x => specStatus(x) === 'draft')) throw new FactoryError('未確定の変更案が既にあります', ['今ある変更案を確定するか破棄してから、新しい変更案を作ってください。']);
      const maxFixed = others.filter(x => specStatus(x) === 'fixed').map(x => x.version).sort((a, b) => compareVersion(b, a))[0];
      if (maxFixed && compareVersion(rec.version, maxFixed) <= 0) throw new FactoryError(`Versionは確定済みの ${maxFixed} より大きくしてください`, [`例：${nextVersion(maxFixed)} または ${nextVersion(maxFixed, true)}`]);
    }
  }

  async specsOf(projectId) { return (await this.byIndex('specs', 'projectId', projectId)).sort((a, b) => compareVersion(b.version, a.version)); }
  async latestFixedSpec(projectId) { return (await this.specsOf(projectId)).find(x => specStatus(x) === 'fixed') || null; }
  async currentDraft(projectId) { return (await this.specsOf(projectId)).find(x => specStatus(x) === 'draft') || null; }

  // 変更案を作る（確定済みの最新版、または指定の版をもとにする。最初は v1.0）
  async createSpecDraft(projectId, { title, body, version, reason = '', baseSpecId } = {}, { actor } = {}) {
    const p = await this.get('projects', projectId);
    if (!p) throw new FactoryError('プロジェクトが見つかりません');
    if (await this.currentDraft(projectId)) throw new FactoryError('未確定の変更案が既にあります', ['今ある変更案を確定するか破棄してから、新しい変更案を作ってください。']);
    const base = baseSpecId ? await this.get('specs', baseSpecId) : await this.latestFixedSpec(projectId);
    if (baseSpecId && (!base || base.projectId !== projectId)) throw new FactoryError('もとにする仕様が見つかりません');
    if (base && specStatus(base) !== 'fixed') throw new FactoryError('変更案は確定済みの仕様をもとに作ります');
    const latest = await this.latestFixedSpec(projectId);
    return this.create('specs', {
      projectId, status: 'draft',
      version: version || (latest ? nextVersion(latest.version) : 'v1.0'),
      title: title ?? base?.title ?? `${p.name} 仕様書`,
      body: body ?? base?.body ?? specTemplate(p),
      reason, baseSpecId: base?.id || null, baseVersion: base?.version || null, requestIds: [],
    }, { actor, reason: base ? `${base.version} をもとに変更案を作成` : '仕様書の初版（変更案）を作成' });
  }

  // 採用済みの要望を変更案へ反映（複数まとめて可）。要望を採用しただけでは仕様は変わらない。
  async reflectRequests(projectId, requestIds, { version, actor } = {}) {
    if (!requestIds?.length) throw new FactoryError('反映する要望を選んでください');
    const reqs = [];
    const errs = [];
    for (const id of requestIds) {
      const r = await this.get('requests', id);
      if (!r || r.projectId !== projectId) { errs.push('このプロジェクトの要望ではないものが含まれています'); continue; }
      if ((r.status || 'unreviewed') !== 'adopted') errs.push(`「${r.title}」は「採用」になっていません`);
      else if (r.specState === 'fixed') errs.push(`「${r.title}」は既に ${r.specVersion} に反映・確定済みです`);
      else reqs.push(r);
    }
    if (errs.length) throw new FactoryError('仕様へ反映できない要望があります', [...new Set(errs)]);
    let draft = await this.currentDraft(projectId);
    if (!draft) draft = await this.createSpecDraft(projectId, { version }, { actor });
    const fresh = reqs.filter(r => !(draft.requestIds || []).includes(r.id));
    if (fresh.length) {
      const add = `\n\n## 要望からの変更（${draft.version}候補）\n` + fresh.map(r => `- ${r.title}${r.memo ? `（${r.memo}）` : ''}`).join('\n');
      draft = await this.update('specs', draft.id, {
        body: (draft.body || '').replace(/\s+$/, '') + add,
        requestIds: [...(draft.requestIds || []), ...fresh.map(r => r.id)],
        reason: draft.reason || `要望${fresh.length}件を反映`,
      }, { actor, reason: `要望${fresh.length}件を変更案 ${draft.version} に反映` });
      for (const r of fresh) await this.update('requests', r.id, { specId: draft.id, specVersion: draft.version, specState: 'candidate' }, { actor, reason: `変更案 ${draft.version} の候補にした` });
    }
    return { draft, added: fresh.length };
  }

  // 変更案から要望を外す（本文は利用者が編集）
  async removeRequestFromDraft(specId, requestId, { actor } = {}) {
    const d = await this.get('specs', specId);
    if (!d || specStatus(d) !== 'draft') throw new FactoryError('変更案が見つかりません');
    await this.update('specs', specId, { requestIds: (d.requestIds || []).filter(x => x !== requestId) }, { actor, reason: '要望を変更案から外した' });
    await this.update('requests', requestId, { specId: null, specVersion: null, specState: null }, { actor, reason: `変更案 ${d.version} から外した` });
  }

  // 変更案を確定。確定後は変更・削除できない。変更履歴へ旧/新Version・変更内容・理由・元の要望・確定者を自動記録。
  async fixSpec(specId, { reason, actor } = {}) {
    const who = actor || this.actor;
    const d = await this.get('specs', specId);
    if (!d) throw new FactoryError('仕様が見つかりません');
    if (specStatus(d) === 'fixed') throw new FactoryError(`${d.version} は既に確定済みです`);
    const base = d.baseSpecId ? await this.get('specs', d.baseSpecId) : null;
    const why = (reason ?? d.reason ?? '').trim() || (base ? '' : '初版');
    if (!why) throw new FactoryError('変更理由を入力してください', ['あとで「なぜ変えたか」を確認できるようにするためです。']);
    if (!(d.body || '').trim()) throw new FactoryError('本文が空のため確定できません');
    const rows = diffLines(base?.body || '', d.body || '');
    const summary = diffSummary(rows);
    const reqs = [];
    for (const id of d.requestIds || []) { const r = await this.get('requests', id); if (r) reqs.push(r); }
    const t = now();
    const fixed = { ...d, status: 'fixed', reason: why, fixedAt: t, fixedBy: who, diffSummary: summary, updatedAt: t, updatedBy: who, rev: (d.rev || 0) + 1, deviceId: this.device };
    validate('specs', fixed, this.master);
    const tx = this._tx(['specs', 'requests', 'history'], 'readwrite');
    tx.objectStore('specs').put(fixed);
    for (const r of reqs) {
      const nr = { ...r, specId: d.id, specVersion: d.version, specState: 'fixed', reflectedAt: t, updatedAt: t, updatedBy: who, rev: (r.rev || 0) + 1 };
      tx.objectStore('requests').put(nr);
      this._history(tx, { action: 'update', store: 'requests', recordId: r.id, projectId: d.projectId, actor: who, reason: `仕様 ${d.version} に反映（確定）`, changes: diff(r, nr) });
    }
    this._history(tx, {
      action: 'fix', store: 'specs', recordId: d.id, projectId: d.projectId, actor: who, reason: why,
      changes: { version: { from: base?.version || null, to: d.version } },
      details: { oldVersion: base?.version || null, newVersion: d.version, title: d.title, summary, diff: diffText(rows), requestIds: reqs.map(r => r.id), requestTitles: reqs.map(r => r.title) },
    });
    await done(tx);
    return fixed;
  }

  // 変更案を破棄（ゴミ箱へ）。候補にしていた要望の紐付けは外す
  async discardDraft(specId, { actor } = {}) {
    const d = await this.get('specs', specId);
    if (!d || specStatus(d) !== 'draft') throw new FactoryError('破棄できるのは未確定の変更案だけです');
    for (const id of d.requestIds || []) {
      const r = await this.get('requests', id);
      if (r && r.specId === d.id) await this.update('requests', id, { specId: null, specVersion: null, specState: null }, { actor, reason: `変更案 ${d.version} を破棄` });
    }
    return this.remove('specs', specId, { actor, reason: `変更案 ${d.version} を破棄` });
  }

  // 要望の判断（採用・保留・不採用など）を、理由・判断日とともに残す。要望は削除しない。
  async decideRequest(id, status, { reason = '', actor } = {}) {
    const r = await this.get('requests', id);
    if (!r) throw new FactoryError('要望が見つかりません');
    if (r.specState === 'candidate' && status !== 'adopted') {
      throw new FactoryError(`この要望は変更案 ${r.specVersion} に入っています`, ['先に仕様書タブの変更案から外してから、判断を変えてください。']);
    }
    const who = actor || this.actor, at = now();
    return this.update('requests', id, {
      status, decisionReason: reason.trim(), decidedAt: at, decidedBy: who,
      decisions: [...(r.decisions || []), { status, reason: reason.trim(), at, by: who }],
    }, { actor, reason: reason.trim() ? `判断：${reason.trim()}` : '判断を記録' });
  }

  // Factory移行用指示書の「版」を保存（過去の版は残る）
  async saveGuide(projectId, markdown, { specVersion = null, actor } = {}) {
    const n = (await this.byIndex('guides', 'projectId', projectId)).length + 1;
    return this.create('guides', { projectId, gversion: n, title: `移行用指示書 第${n}版`, markdown, specVersion }, { actor, reason: `移行用指示書 第${n}版を保存` });
  }


  // ================= Phase 5：3AI比較・ファイル・URL =================
  // 相談セット（同じテーマの3AI回答を1セットで管理）
  async createCompare(projectId, { topic, question = '', conditions = '', problems = '', outputFormat = '', includeSpec = true, memo = '' } = {}, { actor } = {}) {
    if (!(await this.get('projects', projectId))) throw new FactoryError('プロジェクトが見つかりません');
    const spec = await this.latestFixedSpec(projectId);
    return this.create('compares', {
      projectId, topic: (topic || '').trim(), question, conditions, problems, outputFormat, includeSpec, memo,
      specVersion: spec?.version || null, status: 'open', answers: {}, finalDecision: '', finalDecidedAt: null,
    }, { actor, reason: '3AI相談を作成' });
  }

  async _compare(id) {
    const c = await this.get('compares', id);
    if (!c) throw new FactoryError('相談が見つかりません');
    return c;
  }
  _aiCheck(ai) { if (!['chatgpt', 'claude', 'gemini'].includes(ai)) throw new FactoryError('AIの指定が正しくありません'); }

  // 依頼文（質問）を記録（コピーしたときに、そのAIへ何を聞いたかを残す）
  async recordPrompt(id, ai, prompt, { actor } = {}) {
    this._aiCheck(ai);
    const c = await this._compare(id);
    const a = { ...(c.answers?.[ai] || {}), ai, question: prompt, promptAt: now() };
    return this.update('compares', id, { answers: { ...(c.answers || {}), [ai]: a } }, { actor, reason: `${ai} 用の依頼文をコピー` });
  }

  // 回答を貼り付けて保存（AI名・質問・回答・日時・プロジェクト・仕様Version・テーマ・メモ）
  async saveAnswer(id, ai, { text, memo = '' } = {}, { actor } = {}) {
    this._aiCheck(ai);
    const c = await this._compare(id);
    if (!(text || '').trim()) throw new FactoryError('回答を貼り付けてください');
    const prev = c.answers?.[ai] || {};
    const a = { ...prev, ai, answer: text, memo, savedAt: now(), savedBy: actor || this.actor, specVersion: c.specVersion, topic: c.topic };
    if (prev.answer && prev.answer !== text) a.previous = [...(prev.previous || []), { answer: prev.answer, savedAt: prev.savedAt }];
    return this.update('compares', id, { answers: { ...(c.answers || {}), [ai]: a } }, { actor, reason: `${ai} の回答を保存` });
  }

  // 各AI案の判断（採用・保留・不採用）。Factoryは決めない。判断・理由・判断日を残す
  async decideAnswer(id, ai, decision, { reason = '', actor } = {}) {
    this._aiCheck(ai);
    if (!(this.master?.compareDecisions || []).some(d => d.key === decision)) throw new FactoryError('判断は「採用・保留・不採用」から選んでください');
    const c = await this._compare(id);
    const a = c.answers?.[ai];
    if (!a?.answer) throw new FactoryError('回答が保存されていないため判断できません', ['先に回答を貼り付けて保存してください。']);
    if (a.requestId && decision !== 'adopt') throw new FactoryError('この案は既に要望箱へ追加しています', ['判断を変える場合は、要望箱でその要望を「保留」や「不採用」にしてください。']);
    const who = actor || this.actor, at = now();
    const na = { ...a, decision, decisionReason: reason.trim(), decidedAt: at, decidedBy: who, decisions: [...(a.decisions || []), { decision, reason: reason.trim(), at, by: who }] };
    return this.update('compares', id, { answers: { ...c.answers, [ai]: na } }, { actor, reason: `${ai} 案を「${decision}」と判断${reason.trim() ? '：' + reason.trim() : ''}` });
  }

  // 相談全体の最終結論（ユーザーが記録）
  async setFinalDecision(id, text, { actor } = {}) {
    await this._compare(id);
    const t = (text || '').trim();
    return this.update('compares', id, { finalDecision: t, finalDecidedAt: t ? now() : null, status: t ? 'decided' : 'open' }, { actor, reason: t ? '最終結論を記録' : '最終結論を取り消し' });
  }

  // 採用した案 → 要望箱（「未検討」で入る。仕様書は変えない）
  async answerToRequest(id, ai, { title, memo } = {}, { actor } = {}) {
    this._aiCheck(ai);
    const c = await this._compare(id);
    const a = c.answers?.[ai];
    if (!a || a.decision !== 'adopt') throw new FactoryError('「採用」にした案だけ要望箱へ追加できます');
    if (a.requestId && await this.get('requests', a.requestId)) throw new FactoryError('この案は既に要望箱へ追加しています');
    const r = await this.create('requests', {
      projectId: c.projectId, title: (title || '').trim(), status: 'unreviewed',
      memo: memo ?? `3AI比較「${c.topic}」の${label3(ai)}案より`, source: { type: 'compare', id, ai, topic: c.topic },
    }, { actor, reason: `3AI比較「${c.topic}」の${label3(ai)}案を要望箱へ` });
    await this.update('compares', id, { answers: { ...c.answers, [ai]: { ...a, requestId: r.id } } }, { actor, reason: '採用案を要望箱へ追加' });
    return r;
  }

  // URL：登録（種類は自動判定、変更可）
  async addUrl(projectId, { url, title = '', kind, memo = '' } = {}, { actor } = {}) {
    const u = (url || '').trim();
    return this.create('urls', { projectId, url: u, title, kind: kind || detectKind(u), memo, summary: '', points: '', ideas: '', fetchStatus: 'none', registeredAt: now().slice(0, 10) }, { actor, reason: 'URLを登録' });
  }
  async urlToRequest(id, { title, memo } = {}, { actor } = {}) {
    const u = await this.get('urls', id);
    if (!u) throw new FactoryError('URLが見つかりません');
    if (!u.projectId) throw new FactoryError('プロジェクトに紐づいていないURLです');
    const r = await this.create('requests', {
      projectId: u.projectId, title: (title || '').trim(), status: 'unreviewed',
      memo: memo ?? `URL「${u.title || u.url}」より`, source: { type: 'url', id, url: u.url },
    }, { actor, reason: 'URLのアイデアを要望箱へ' });
    await this.update('urls', id, { requestIds: [...(u.requestIds || []), r.id] }, { actor, reason: '要望箱へ追加' });
    return r;
  }

  // ファイル：新しいVersionを登録し、それまでの「使用中」は「旧版」にする（旧版は残す）
  async newFileVersion(fileId, data = {}, { actor } = {}) {
    const f = await this.get('files', fileId);
    if (!f) throw new FactoryError('ファイルが見つかりません');
    const v = (data.version || '').trim();
    if (!v) throw new FactoryError('新しいVersionを入力してください');
    const same = (await this.byIndex('files', 'projectId', f.projectId)).filter(x => x.fileName === f.fileName);
    if (same.some(x => (x.version || '') === v)) throw new FactoryError(`${f.fileName} の ${v} は既にあります`);
    const keep = ['fileName', 'type', 'language', 'ai', 'description', 'specVersion', 'location', 'memo', 'code', 'relatedFile'];
    const rec = Object.fromEntries(keep.map(k => [k, data[k] !== undefined ? data[k] : f[k]]).filter(([, x]) => x !== undefined));
    const nf = await this.create('files', { ...rec, projectId: f.projectId, version: v, status: data.status || 'active', prevId: f.id }, { actor, reason: `${f.fileName} の新しいVersion ${v} を登録` });
    if (nf.status === 'active') for (const x of same) if ((x.status || 'active') === 'active') await this.update('files', x.id, { status: 'old' }, { actor, reason: `${v} の登録により旧版へ` });
    return nf;
  }


  // ================= Phase 6：テスト管理・実機確認・引継ぎ =================
  // 共通テストテンプレートを追加（同じ名前のテストは追加しない）
  async applyTestTemplate(projectId, names = null, { actor } = {}) {
    const have = new Set((await this.byIndex('tests', 'projectId', projectId)).map(t => t.item));
    const list = (this.master?.commonTestTemplate || []).filter(t => (!names || names.includes(t.name)) && !have.has(t.name));
    const out = [];
    for (const t of list) out.push(await this.create('tests', { projectId, item: t.name, category: t.category, check: t.check, expected: t.expected, status: 'untested', required: true, fromTemplate: true, runs: [] }, { actor, reason: '共通テストを追加' }));
    return out;
  }

  async _test(id) { const t = await this.get('tests', id); if (!t) throw new FactoryError('テストが見つかりません'); return t; }
  _run(t, entry, who) { return [...(t.runs || []), { ...entry, at: now(), by: who }]; }

  // 実施して結果を記録（不合格ならエラー内容が必須）
  async recordTestRun(id, { result, actual = '', error = '', specVersion, fileVersion } = {}, { actor } = {}) {
    const t = await this._test(id), who = actor || this.actor;
    if (!['pass', 'fail'].includes(result)) throw new FactoryError('結果は「合格」か「不合格」を選んでください');
    if (result === 'fail' && !error.trim()) throw new FactoryError('不合格のときは、エラー内容を書いてください', ['あとで修正・再テストするときの記録になります。']);
    return this.update('tests', id, {
      status: result, result, actual, ...(result === 'fail' ? { error } : {}), executedAt: now(), executedBy: who,
      ...(specVersion !== undefined ? { specVersion } : {}), ...(fileVersion !== undefined ? { fileVersion } : {}),
      runs: this._run(t, { kind: 'run', result, actual, error: result === 'fail' ? error : '' }, who),
    }, { actor, internal: true, reason: result === 'pass' ? 'テスト合格' : `テスト不合格：${error}` });
  }

  // 修正内容を記録（修正中／修正済み→再テスト待ち）
  async recordFix(id, { fix = '', done = true } = {}, { actor } = {}) {
    const t = await this._test(id), who = actor || this.actor;
    if (!['fail', 'fixing', 'retest'].includes(t.status)) throw new FactoryError('修正を記録できるのは、不合格・修正中のテストだけです');
    if (!fix.trim()) throw new FactoryError('修正内容を書いてください');
    return this.update('tests', id, { status: done ? 'retest' : 'fixing', fix, fixStatus: done ? 'fixed' : 'doing', runs: this._run(t, { kind: 'fix', fix, done }, who) },
      { actor, internal: true, reason: `修正を記録：${fix}` });
  }

  // 再テスト（合格で完了。不合格なら再びエラーを記録）。過去の不合格・エラー・修正は消さない
  async recordRetest(id, { result, actual = '', error = '' } = {}, { actor } = {}) {
    const t = await this._test(id), who = actor || this.actor;
    if (!['retest', 'fixing', 'fail'].includes(t.status)) throw new FactoryError('再テストできるのは、不合格・修正中・再テスト待ちのテストだけです');
    if (!['pass', 'fail'].includes(result)) throw new FactoryError('結果は「合格」か「不合格」を選んでください');
    if (result === 'fail' && !error.trim()) throw new FactoryError('不合格のときは、エラー内容を書いてください');
    return this.update('tests', id, {
      status: result, retestResult: result, actual, ...(result === 'fail' ? { error } : {}), executedAt: now(), executedBy: who,
      runs: this._run(t, { kind: 'retest', result, actual, error: result === 'fail' ? error : '' }, who),
    }, { actor, internal: true, reason: result === 'pass' ? '再テスト合格' : `再テスト不合格：${error}` });
  }

  // テスト不合格・重大な未解決事項から「次にやること」へ（ユーザーが確認して追加。二重追加はしない）
  async addTaskFrom(projectId, { title, priority = 'high', ai = 'claude', memo = '', source } = {}, { actor } = {}) {
    if (source?.id) {
      const dup = (await this.byIndex('tasks', 'projectId', projectId)).find(t => t.source?.id === source.id && t.status !== 'done');
      if (dup) throw new FactoryError('既に「次にやること」に追加済みです', [`「${dup.title}」`]);
    }
    return this.create('tasks', { projectId, title: (title || '').trim(), priority, status: 'todo', ai, memo, source }, { actor, reason: '次にやることへ追加' });
  }

  // プロジェクト別の引継ぎ（手で書く部分）
  async getProjectHandoff(projectId) { return (await this.get('handoff', `handoff-${projectId}`)) || null; }
  async saveProjectHandoff(projectId, fields, { actor } = {}) {
    return this.upsert('handoff', `handoff-${projectId}`, { projectId, ...fields }, { actor, reason: '引継ぎ情報を保存' });
  }

  // 実機確認・公開確認
  async checksOf(projectId, kind) { return sortChecks((await this.byIndex('checks', 'projectId', projectId)).filter(c => !kind || c.kind === kind)); }

  // Factory本体の実機確認（Phase 1〜5の「実機確認待ち」を引き継ぐ）。無ければ作る。何度実行しても重複しない
  async ensureFactoryChecks() {
    const have = await this.checksOf(FACTORY_ID, 'device');
    if (have.length) return have;
    for (const [i, d] of (this.master?.defaultDevices || []).entries()) {
      await this.create('checks', { projectId: FACTORY_ID, kind: 'device', device: d, order: i, status: 'unchecked', scope: 'Factory本体 Phase 1〜6', result: '', memo: 'Phase 1〜5の「実機確認待ち」を引継ぎ', checkedAt: null }, { actor: 'Factory', reason: '実機確認待ちを引継ぎ' });
    }
    return this.checksOf(FACTORY_ID, 'device');
  }


  // ================= Phase 7：既存アプリ取込 =================
  // 既存アプリはゼロから作り直さない：現在の状態を取り込み → 基準Versionとして保存 → 確定仕様との差分 → 必要な改良だけ要望箱へ
  async setOrigin(projectId, origin, { actor } = {}) {
    const p = await this.get('projects', projectId);
    if (!p) throw new FactoryError('プロジェクトが見つかりません');
    if (p.existing?.importStatus === 'imported' && origin !== 'existing') throw new FactoryError('取込済みの既存アプリです', ['取込済みのプロジェクトを「新しく作る」に戻すことはできません。']);
    const patch = { origin };
    if (origin === 'existing') patch.existing = { ...(p.existing || {}), importStatus: p.existing?.importStatus || 'waiting' };
    return this.update('projects', projectId, patch, { actor, reason: origin === 'existing' ? '既存アプリあり（取込待ち）に設定' : origin === 'new' ? '新しく作るプロジェクトに設定' : '既存アプリの有無を未確認に戻す' });
  }

  // 取込情報を保存（推測で埋めない：入力されたものだけ保存）
  async saveExisting(projectId, fields = {}, { actor } = {}) {
    const p = await this.get('projects', projectId);
    if (!p) throw new FactoryError('プロジェクトが見つかりません');
    const errs = [];
    for (const k of ['webUrl', 'githubUrl']) if (fields[k] && !/^https?:\/\/\S+$/.test(fields[k])) errs.push(`${k === 'webUrl' ? 'Web URL' : 'GitHub URL'} は http:// または https:// で始めてください`);
    if (errs.length) throw new FactoryError('入力内容を確認してください', errs);
    const keep = ['appName', 'webUrl', 'githubUrl', 'currentVersion', 'publishState', 'implemented', 'notImplemented', 'knownIssues', 'storage', 'externalServices', 'testStatus', 'nextImprovements'];
    const clean = Object.fromEntries(keep.filter(k => fields[k] !== undefined).map(k => [k, String(fields[k] ?? '').trim()]));
    return this.update('projects', projectId, { origin: 'existing', existing: { ...(p.existing || {}), importStatus: p.existing?.importStatus || 'waiting', ...clean } }, { actor, reason: '既存アプリの情報を保存' });
  }

  // 取込を完了：URL かコード/ファイルが登録されていることが条件。現在の状態を「基準Version」として記録（コードは変更しない）
  async completeImport(projectId, { actor } = {}) {
    const p = await this.get('projects', projectId);
    if (!p) throw new FactoryError('プロジェクトが見つかりません');
    const ex = p.existing || {};
    const files = await this.byIndex('files', 'projectId', projectId);
    const errs = [];
    if (!ex.webUrl && !ex.githubUrl && !files.length) errs.push('現在のWeb URL・GitHub URL・ソースコード/ファイルのどれかを登録してください（推測では登録しません）');
    if (!ex.currentVersion) errs.push('現在のVersion（分からなければ「不明」）を入力してください');
    if (errs.length) throw new FactoryError('まだ取込を完了できません', errs);
    const baseline = { at: now(), by: actor || this.actor, currentVersion: ex.currentVersion, webUrl: ex.webUrl || '', githubUrl: ex.githubUrl || '',
      files: files.filter(f => (f.status || 'active') === 'active').map(f => `${f.fileName} ${f.version || ''}`.trim()), specVersion: (await this.latestFixedSpec(projectId))?.version || null };
    return this.update('projects', projectId, { origin: 'existing', existing: { ...ex, importStatus: 'imported', importedAt: baseline.at, baseline } }, { actor, reason: `既存アプリを取込（基準Version ${ex.currentVersion}）` });
  }

  // 確定仕様との照合（実装済み／一部／未実装／仕様と違う）。コードは変更しない
  async setCoverage(projectId, key, status, { memo = '', actor } = {}) {
    if (!(this.master?.coverageStatuses || []).some(s => s.key === status)) throw new FactoryError('判定は「実装済み・一部実装済み・未実装・仕様と実装が違う・未判定」から選んでください');
    const p = await this.get('projects', projectId);
    if (!p) throw new FactoryError('プロジェクトが見つかりません');
    const cov = { ...(p.existing?.coverage || {}) };
    cov[key] = { ...(cov[key] || {}), status, memo, at: now() };
    return this.update('projects', projectId, { existing: { ...(p.existing || {}), coverage: cov } }, { actor, reason: `仕様との照合：${key}` });
  }

  // v1.1.0：判定候補JSONの一括反映。画面で確認した内容（新しい coverage 全体）を、1回の保存で書く（全部成功するか、何も変わらないか）
  //   確認画面を開いたあとにプロジェクトが変わっていたら（ほかの操作・同期の受け取りなど）保存しない。確定仕様の版が変わっていても保存しない
  async applyCoverageImport(projectId, { expectedRev, specVersion, coverage, applied = 0, overwritten = 0, source = '' }, { actor } = {}) {
    const p = await this.get('projects', projectId);
    if (!p) throw new FactoryError('プロジェクトが見つかりません');
    if ((p.rev || 0) !== expectedRev) throw new FactoryError('確認画面を開いたあとに、このプロジェクトが変更されました。反映していません', ['もう一度「JSONから判定候補を読み込み」からやり直してください。']);
    const spec = await this.latestFixedSpec(projectId);
    if (!spec || spec.version !== specVersion) throw new FactoryError('確定仕様の版が変わりました。反映していません');
    for (const v of Object.values(coverage || {})) if (!(this.master?.coverageStatuses || []).some(s => s.key === v?.status)) throw new FactoryError('判定の値が正しくありません。反映していません');
    return this.update('projects', projectId, { existing: { ...(p.existing || {}), coverage } }, { actor, reason: `確定仕様 ${specVersion} との照合：判定候補JSONから一括反映（未判定へ反映 ${applied}件・上書き ${overwritten}件${source ? `・${source}` : ''}）` });
  }

  // 照合で見つかった差分のうち、ユーザーが選んだものだけ改良候補として要望箱へ（未検討で入る）
  async coverageToRequests(projectId, keys = [], { actor } = {}) {
    const p = await this.get('projects', projectId);
    const spec = await this.latestFixedSpec(projectId);
    const items = Object.fromEntries(specItems(spec?.body || '').map(i => [i.key, i]));
    const cov = { ...(p?.existing?.coverage || {}) };
    const out = [];
    for (const k of keys) {
      const it = items[k], c = cov[k];
      if (!it || !c || !['partial', 'todo', 'diff'].includes(c.status)) throw new FactoryError('要望箱へ送れるのは「一部実装済み・未実装・仕様と実装が違う」の項目だけです');
      if (c.requestId && await this.get('requests', c.requestId)) continue;
      const lab = (this.master.coverageStatuses.find(s => s.key === c.status) || {}).label;
      const r = await this.create('requests', { projectId, title: `【改良候補】${it.text}`, memo: `確定仕様 ${spec.version}「${it.head}」：${lab}${c.memo ? `（${c.memo}）` : ''}`, status: 'unreviewed', source: { type: 'coverage', key: k, specVersion: spec.version } }, { actor, reason: '仕様との差分を改良候補として要望箱へ' });
      cov[k] = { ...c, requestId: r.id };
      out.push(r);
    }
    if (out.length) await this.update('projects', projectId, { existing: { ...(p.existing || {}), coverage: cov } }, { actor, reason: '改良候補を要望箱へ送った記録' });
    return out;
  }

  async listTrash() { return this.query('trash', { sort: 'deletedAt' }); }

  // ---- ゴミ箱から復元 ----
  async restore(trashId, { actor, reason = '' } = {}) {
    const who = actor || this.actor;
    const t = await this.get('trash', trashId);
    if (!t) throw new FactoryError('ゴミ箱に該当データがありません');
    if (t.kind === 'project-bundle') return this._restoreProjectBundle(t, { actor, reason });
    // 仕様書の変更案は1プロジェクトに1つまで（Phase 4）
    if (t.store === 'specs' && specStatus(t.record) === 'draft' && await this.currentDraft(t.record.projectId)) {
      throw new FactoryError('未確定の変更案が既にあるため、この変更案は戻せません', ['今ある変更案を確定するか破棄してから、元に戻してください。']);
    }
    // プロジェクトの関連データだけを戻す場合、親プロジェクトが無ければ先にプロジェクトを戻してもらう
    if (t.store !== 'projects' && t.record?.projectId && STORES[t.store].includes('projectId') && !(await this.get('projects', t.record.projectId))) {
      throw new FactoryError('先にプロジェクトをゴミ箱から元に戻してください', ['このデータが属するプロジェクトがゴミ箱にあるか、完全に削除されています。']);
    }
    const tx = this._tx([t.store, 'trash', 'history'], 'readwrite');
    const os = tx.objectStore(t.store);
    if (await req(os.get(t.recordId))) { tx.abort(); throw new FactoryError('同じIDのデータが既にあるため復元できません'); }
    const rec = { ...t.record, updatedAt: now(), updatedBy: who, rev: (t.record.rev || 0) + 1 };
    os.put(rec);
    tx.objectStore('trash').delete(trashId);
    this._history(tx, { action: 'restore', store: t.store, recordId: t.recordId, projectId: projectOf(t.store, t.record), actor: who, reason, changes: {} });
    await done(tx);
    return rec;
  }

  // ゴミ箱から完全削除（元に戻せない）
  async purge(trashId, { actor, reason = '' } = {}) {
    const t = await this.get('trash', trashId);
    if (!t) throw new FactoryError('ゴミ箱に該当データがありません');
    const tx = this._tx(['trash', 'history'], 'readwrite');
    tx.objectStore('trash').delete(trashId);
    this._history(tx, { action: 'purge', store: t.store, recordId: t.recordId, projectId: t.kind === 'project-bundle' ? '' : projectOf(t.store, t.record), bundleOf: t.kind === 'project-bundle' ? t.recordId : undefined, actor: actor || this.actor, reason, changes: {} });
    await done(tx);
  }

  async historyOfProject(projectId) { return (await this.byIndex('history', 'projectId', projectId)).sort((a, b) => a.at < b.at ? 1 : -1); }

  async historyOf(recordId) { return (await this.byIndex('history', 'recordId', recordId)).sort((a, b) => a.at < b.at ? 1 : -1); }

  // ---- 同期準備：指定日時より後に更新されたレコード（localOnly は除外）----
  async changesSince(since = '') {
    const out = [];
    for (const s of DATA_STORES) {
      for (const r of await this.all(s)) if (!r.localOnly && (r.updatedAt || '') > since) out.push({ store: s, record: r });
    }
    return out;
  }

  // ---- JSONバックアップ ----
  async exportAll() {
    const stores = Object.keys(STORES);
    const tx = this._tx(stores);
    const data = {};
    for (const s of stores) data[s] = await req(tx.objectStore(s).getAll());
    const counts = Object.fromEntries(stores.map(s => [s, data[s].length]));
    return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: now(), exportedBy: this.actor, deviceId: this.device, counts, data };
  }

  // 取込前チェック（データには一切触れない）
  static checkBackup(json) {
    const errs = [];
    if (!json || typeof json !== 'object') errs.push('JSONの形式ではありません');
    else {
      if (json.app !== APP_ID) errs.push('3AI Development Factory のバックアップファイルではありません');
      if (typeof json.schemaVersion !== 'number' || json.schemaVersion > SCHEMA_VERSION) errs.push('このFactoryより新しい版のバックアップです。Factoryを更新してから復元してください');
      if (!json.data || typeof json.data !== 'object') errs.push('データ部分がありません');
      else for (const [s, rows] of Object.entries(json.data)) {
        if (!STORES[s]) { errs.push(`不明な保存先「${s}」が含まれています`); continue; }
        if (!Array.isArray(rows)) { errs.push(`「${s}」の形式が不正です`); continue; }
        if (rows.some(r => !r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id)) errs.push(`「${s}」にIDのないデータがあります`);
        if (json.counts && json.counts[s] !== undefined && json.counts[s] !== rows.length) errs.push(`「${s}」の件数が記録と一致しません（ファイル破損の可能性）`);
      }
    }
    if (errs.length) throw new FactoryError('このファイルは復元できません', errs);
    return Object.fromEntries(Object.entries(json.data).map(([s, r]) => [s, r.length]));
  }

  // 復元：現在のデータを全て置き換え。1つでも失敗したら全体を取り消し（元データのまま）
  // Sync-3：クラウドから受け取った記録を、そのままの形（rev・更新日時・更新者・端末IDを変えずに）書き込む。
  // 1回の処理で全部成功するか、何も変わらないか。変更履歴は作らない（記録の変更履歴は送った端末のものが一緒に届くため）。
  async applySyncedRecords(items) {
    if (!items.length) return 0;
    const stores = [...new Set(items.map(x => x.store))];
    for (const s of stores) if (!STORES[s]) throw new FactoryError(`保存先「${s}」は存在しません`);
    for (const x of items) if (!x.rec || typeof x.rec.id !== 'string' || !x.rec.id) throw new FactoryError('IDのない記録は書き込めません');
    const tx = this._tx(stores, 'readwrite');
    for (const x of items) tx.objectStore(x.store).put(x.rec);
    await done(tx);
    return items.length;
  }

  async importAll(json, { actor, reason } = {}) {
    const counts = FactoryDB.checkBackup(json);
    const stores = Object.keys(STORES);
    const tx = this._tx(stores, 'readwrite');
    for (const s of stores) {
      tx.objectStore(s).clear();
      for (const r of json.data[s] || []) tx.objectStore(s).put(r);
    }
    this._history(tx, { action: 'import', store: '*', recordId: '*', actor: actor || this.actor, reason: reason || `バックアップ（${json.exportedAt || '日時不明'}）から復元`, changes: {} });
    await done(tx);
    return counts;
  }
}

// 仕様書の初版テンプレート（Factory移行用指示書の見出しと対応）
export function specTemplate(p = {}) {
  return [`# ${p.name || ''} 仕様書`, '', '## 目的', p.purpose || '', '', '## 対象ユーザー・端末', p.targetUsers || '', '',
    '## 画面構成', '', '## 機能', '', '## 保存データ', '', '## 外部サービス・API', '', '## 印刷・PDF・共有', '', '## 絶対条件', ''].join('\n');
}

const label3 = ai => ({ chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[ai] || ai);
