// Design-1 画面の確認：iPhone実機に近い条件（ホームバー34px）で、全画面の下端・横はみ出し・区切りボタンの文字切れを確かめる
const { chromium, devices } = require('playwright');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots'); const BASE = 'http://localhost:8765/';
const SAFE = `:root{--safe-b:34px !important}`;
const devs = [['se', devices['iPhone SE']], ['i13', devices['iPhone 13']], ['pm', devices['iPhone 15 Pro Max'] || devices['iPhone 14 Pro Max']], ['pc', { viewport: { width: 1366, height: 860 } }]];
const routes = ['#/', '#/talk', '#/requests', '#/settings', '#/backup', '#/handoff', '#/system', '#/v1', '#/account', '#/trash'];
const ptabs = ['overview', 'existing', 'spec', 'progress', 'next', 'requests', 'compare', 'files', 'urls', 'tests', 'handoff', 'history'];
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch(); const problems = [];
  for (const [dn, opts] of devs) {
    const ctx = await b.newContext({ ...opts, serviceWorkers: 'block' });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(BASE); await page.waitForSelector('.hero'); await page.click('#seed-7'); await page.waitForSelector('text=8件を登録しました'); await page.waitForTimeout(3200);
    const pid = await page.evaluate(async () => { const { FactoryDB } = await import('./js/db.js'); const db = await FactoryDB.open('factory'); const p = (await db.all('projects')).find(x => x.seedKey === 'vintage-hunt'); db.close(); return p.id; });
    const list = [...routes.map(r => [r.replace(/[#/]/g, '') || 'home', r]), ...ptabs.map(t => ['p-' + t, `#/p/${pid}/${t}`])];
    for (const [n, h] of list) {
      await page.goto(BASE + h); await page.addStyleTag({ content: SAFE }); await page.waitForTimeout(500);
      const r = await page.evaluate(async () => {
        const over = document.documentElement.scrollWidth > innerWidth + 1;
        window.scrollTo(0, document.documentElement.scrollHeight); await new Promise(r => setTimeout(r, 120));
        const tb = document.querySelector('.tabbar').getBoundingClientRect();
        const vis = [...document.querySelectorAll('#view *')].filter(e => e.offsetParent && e.children.length === 0 && !(e.closest('details:not([open])') && !e.closest('summary')) && e.getBoundingClientRect().height > 0);
        const lastBottom = Math.max(...vis.map(e => e.getBoundingClientRect().bottom));
        const chips = [...document.querySelectorAll('.chips.scroll .chip')].filter(c => c.scrollWidth > c.clientWidth + 1).map(c => c.textContent.trim());
        const sideMenu = tb.top < 100;
        return { over, gap: sideMenu ? 999 : Math.round(tb.top - lastBottom), chips };
      });
      if (r.over) problems.push(`${dn} ${n}: 横はみ出し`);
      if (r.gap < 12) problems.push(`${dn} ${n}: 最後の項目と下メニューの間 ${r.gap}px`);
      if (r.chips.length) problems.push(`${dn} ${n}: 区切りボタンの文字が切れる ${r.chips}`);
      if (dn !== 'pc' || ['home', 'p-overview', 'p-next', 'account'].includes(n)) await page.screenshot({ path: `${OUT}/d1-${dn}-${n}-bottom.png` });
      if (n === 'home') { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${OUT}/d1-${dn}-home-top.png` }); }
    }
    if (errs.length) problems.push(`${dn}: JSエラー ${errs.join('|')}`);
    await ctx.close();
  }
  await b.close();
  problems.forEach(p => console.log('FAIL', p));
  console.log(`\nE2E(Design-1): ${problems.length ? 'FAIL ' + problems.length + '件' : 'all passed'}（4端末 × 22画面：横はみ出し・下メニューとの余白・区切りボタン・JSエラー）`);
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
