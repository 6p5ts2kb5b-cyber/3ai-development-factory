// バックアップファイルの保存・読み込み（画面側から使う補助）
import { FactoryDB } from './db.js';

export function backupFileName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `factory-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

// 端末へダウンロード保存（iPhoneは「ファイル」アプリに保存されます）
export async function downloadBackup(db) {
  const json = await db.exportAll();
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const name = backupFileName();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  await db.upsert('settings', 'lastBackup', { key: 'lastBackup', value: { at: json.exportedAt, fileName: name, counts: json.counts } }, { reason: 'バックアップ保存' });
  return { name, json };
}

// ファイルを読んで中身をチェック（この時点ではデータに触れない）
export async function readBackupFile(file) {
  const text = await file.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('ファイルが壊れているか、JSON形式ではありません'); }
  const counts = FactoryDB.checkBackup(json);
  return { json, counts };
}
