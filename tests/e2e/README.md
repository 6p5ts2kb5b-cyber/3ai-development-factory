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
node tests/e2e/sync1.e2e.js    # Sync-1 Googleログイン（にせFirebase・計66項目）
```

各スクリプトは新しいブラウザ（空のデータ）で実行されます。
