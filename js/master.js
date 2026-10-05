// 設定値（ステータス・カテゴリー等）の読み込み。
// config/master.json を初回に端末内へ保存し、以後は端末内の値を使います（後から画面で変更可能にするため）。
// 配布側の masterVersion が上がった場合のみ、新しい既定値で更新します。
export async function loadMaster(db, url = new URL('../config/master.json', import.meta.url)) {
  let shipped = null;
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (r.ok) shipped = await r.json();
  } catch { /* オフライン時は端末内の値を使う */ }

  const stored = await db.get('settings', 'master');
  if (shipped && (!stored || (stored.value?.masterVersion || 0) < shipped.masterVersion)) {
    await db.upsert('settings', 'master', { key: 'master', value: shipped }, { actor: 'Factory', reason: `設定値 v${shipped.masterVersion} を適用` });
    db.setMaster(shipped);
    return shipped;
  }
  if (stored) { db.setMaster(stored.value); return stored.value; }
  throw new Error('設定ファイル（config/master.json）を読み込めませんでした。初回はインターネットに接続して開いてください。');
}

export const label = (master, list, key) => (master?.[list] || []).find(o => o.key === key)?.label ?? key;
