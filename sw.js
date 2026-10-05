// オフライン動作用。アプリ本体のファイルを端末に保存し、電波がなくても起動できるようにします。
// ファイルを更新したら CACHE の版数を上げてください（例：factory-v2）。
const CACHE = 'factory-v9';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/db.js', 'js/schema.js', 'js/master.js', 'js/handoff.js', 'js/backup.js', 'js/ui.js', 'js/sync/adapter.js',
  'js/logic.js', 'js/labels.js', 'js/views/home.js', 'js/views/project.js', 'js/views/talk.js', 'js/views/requests.js', 'js/views/projectForm.js', 'js/views/spec.js', 'js/diff.js', 'js/guide.js', 'js/ai.js', 'js/privacy.js', 'js/views/compare.js', 'js/views/files.js', 'js/views/urls.js', 'js/views/safecopy.js', 'js/views/tests.js', 'js/views/checks.js', 'js/views/phandoff.js', 'js/views/v1.js', 'js/views/importer.js', 'js/seed.js', 'js/sync/auth.js', 'js/views/account.js',
  'config/master.json', 'config/handoff.json', 'config/initial-projects.json', 'config/firebase.json',
  'VERSION-0.8.1.txt', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'tests/', 'tests/index.html', 'tests/tests.js',
];

self.addEventListener('install', e => {
  // ブラウザに残っている古いファイルを使わず、必ず最新を取り込む（GitHub Pagesは最大10分ファイルを保持させるため）
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// ネット優先・失敗したら保存版（更新がすぐ反映され、オフラインでも動く）
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // 毎回サーバーに更新を確認（変わっていなければ通信量はわずか）。ページ本体の読み込みは作り直せないのでURLで取得
    (req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' })).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
