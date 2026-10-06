# 画面操作テスト（開発者用）

ユーザーが実行する必要はありません。Claude等が改修後に回帰確認するためのスクリプトです。

```
cd factory && python3 -m http.server 8765 &
npm i playwright && npx playwright install chromium
node tests/e2e/phase1.e2e.js   # Phase 1 回帰（34項目）
node tests/e2e/phase2.e2e.js   # Phase 2（iPhone 13 / iPhone SE / PC で計90項目）
node tests/e2e/phase3.e2e.js   # Phase 3（iPhone 13 / iPhone SE / PC で計93項目）
node tests/e2e/phase4.e2e.js   # Phase 4（iPhone 13 / iPhone SE / PC で計93項目）
node tests/e2e/phase5.e2e.js   # Phase 5（iPhone 13 / iPhone SE / PC で計104項目）
node tests/e2e/phase6.e2e.js   # Phase 6（iPhone 13 / iPhone SE / PC で計81項目）
node tests/e2e/phase7.e2e.js   # Phase 7（iPhone 13 / iPhone SE / PC で計108項目）
node tests/e2e/sync1.e2e.js    # Sync-1 Googleログイン（にせFirebase・計78項目）
node tests/e2e/sync21.e2e.js   # Sync-2-1 クラウドの状態（読み取りのみ・計54項目）
node tests/e2e/sync22.e2e.js   # Sync-2-2 同期の予行演習（確認だけ・計63項目）
node tests/e2e/sync23.e2e.js   # Sync-2-3 初回正本登録（にせFirestore・計90項目）
node tests/e2e/sync24.e2e.js   # Sync-2-4 この端末への取り込み（にせFirestore・計72項目）
node tests/e2e/sync3.e2e.js    # Sync-3 PC・iPhoneの双方向同期（2ブラウザ・計70項目）
```

各スクリプトは新しいブラウザ（空のデータ）で実行されます。
