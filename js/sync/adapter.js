// 自動同期の差し替え口（Phase 1 では同期なし）。
// 方針（ユーザー確定事項）
//  ・同期は任意機能。OFF / 停止中でも Factory は IndexedDB だけで全機能が動く
//  ・無料枠を最優先。超える可能性がある場合は事前に警告し、勝手に有料化しない
//  ・JSONバックアップ / 復元は同期導入後も残す
//  ・学校の生徒等の実データは同期対象外（localOnly=true のレコードは送らない）
//  ・同期サービス採用前に「選定理由・無料枠・移行可能性」をユーザーへ提示して確認を取る
//
// 後のPhaseで、この形のクラスを実装して差し替えます（例：FirebaseSync, DriveSync）。
export class SyncAdapter {
  get name() { return 'none'; }
  get label() { return '同期なし（この端末だけに保存）'; }
  async isAvailable() { return false; }
  /** @param {{store:string, record:object}[]} changes */
  async push(changes) { return { pushed: 0 }; }
  /** @param {string} since ISO日時 */
  async pull(since) { return []; }
  /** 無料枠の使用量（不明なら null）。超過見込み時の警告に使う */
  async usage() { return null; }
}

export const SYNC_STORES = ['projects', 'specs', 'requests', 'compares', 'files', 'tests', 'urls', 'issues', 'tasks', 'handoff'];

export function isSyncable(store, rec) {
  return SYNC_STORES.includes(store) && rec && rec.localOnly !== true;
}

export const activeSync = new SyncAdapter();
