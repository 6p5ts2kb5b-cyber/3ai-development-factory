// Phase Sync-2-2：登録の予行演習の画面（確認だけ。クラウドへは送らない・端末のデータも変更しない）
import { esc, toast, copyText } from '../ui.js';
import { FactoryDB } from '../db.js';
import { deviceKind } from '../sync/auth.js';
import { loadInitialProjects } from '../seed.js';
import { analyzeForSync, fingerprint, summaryText, STORE_LABELS_JA } from '../sync/dryrun.js';

const mb = n => `${(n / 1024 / 1024).toFixed(2)}MB`;
const kb = n => `${Math.round(n / 1024)}KB`;
const when = iso => { try { return iso ? new Date(iso).toLocaleString('ja-JP') : 'なし'; } catch { return iso; } };

// Phase 7 の正式登録（Factory本体＋7件）の名前。読み込めなければ照合を省く
async function expectedNames() {
  try { const d = await loadInitialProjects(); return [d.factory?.name, ...d.projects.map(p => p.name)].filter(Boolean); } catch { return []; }
}

export async function syncCheckView(ctx, view) {
  view.innerHTML = `<a class="back" href="#/account">← Googleログイン・同期</a>
    <h1>同期の予行演習</h1>
    <div class="notice slim" id="sc-note">この画面は<strong>確認だけ</strong>です。クラウドへは何も送りません。この端末のデータも変更しません。初回登録（次の段階）で何を何件送ることになるかを、この端末について調べます。</div>
    <section class="card">
      <p>この端末：<strong>${esc(deviceKind())}</strong></p>
      <p class="muted">8プロジェクトが正しく入っている端末を、次の段階で「初回正本」にします。各端末でこの確認をして、結果を見比べてください（「結果をコピー」で文章にできます）。</p>
      <button class="btn primary" id="sc-run">この端末のデータを確認する</button>
    </section>
    <div id="sc-result"></div>`;
  const out = view.querySelector('#sc-result');
  view.querySelector('#sc-run').onclick = async () => {
    const btn = view.querySelector('#sc-run');
    btn.disabled = true; btn.textContent = '確認しています…';
    try {
      const exp = await ctx.db.exportAll(); // 読むだけ
      const expected = await expectedNames();
      const r = analyzeForSync(exp, { master: ctx.master, expectedProjects: expected, checkBackup: json => FactoryDB.checkBackup(json) });
      const fp = await fingerprint(r.targetsForFingerprint);
      const checkedAt = new Date().toLocaleString('ja-JP');
      out.innerHTML = resultHtml(r, { fp, checkedAt });
      out.querySelector('#sc-copy').onclick = async () => { await copyText(summaryText(r, { device: deviceKind(), fp, checkedAt })); toast('結果をコピーしました'); };
    } catch (e) {
      out.innerHTML = `<div class="notice ng" role="alert"><strong>確認できませんでした</strong><p>${esc(e?.message || e)}</p><p class="muted">この端末のデータは変更していません。この表示をClaudeに伝えてください。</p></div>`;
    }
    btn.disabled = false; btn.textContent = 'もう一度確認する';
  };
}

export function resultHtml(r, { fp, checkedAt }) {
  const P = r.projects;
  const ok = (cond, yes, no) => cond ? `<span class="badge ok">${esc(yes)}</span>` : `<span class="badge warn">${esc(no)}</span>`;
  const seedLine = P.expected ? (P.missing.length ? `<span class="badge warn">Phase 7の8件のうち ${P.expected - P.missing.length}件</span> 見つからないもの：${P.missing.map(esc).join('、')}` : '<span class="badge ok">Phase 7の8件がそろっています</span>') : '';
  return `
    <section class="card" id="sc-summary">
      <h2>確認結果</h2>
      <p>${r.issues.length ? `<span class="badge warn">確認が必要な点があります</span>` : '<span class="badge ok">問題は見つかりませんでした</span>'}</p>
      ${r.issues.length ? `<ul class="tight">${r.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      <dl class="kv wide">
        <dt>確認日時</dt><dd>${esc(checkedAt)}</dd>
        <dt>データの指紋</dt><dd><code class="uid">${esc(fp.slice(0, 12))}</code> <span class="muted">（2台で同じなら同じデータ）</span></dd>
        <dt>最後の更新</dt><dd>${esc(when(r.lastUpdated))}</dd>
        <dt>同期の対象</dt><dd><strong>${r.total}</strong>件</dd>
      </dl>
      <button class="btn" id="sc-copy">結果をコピー（端末どうしで見比べる用）</button>
    </section>
    <section class="card" id="sc-projects">
      <h2>プロジェクト ${P.count}件</h2>
      <p>${seedLine}</p>
      ${P.dupNames.length ? `<p><span class="badge warn">同じ名前があります</span> ${P.dupNames.map(esc).join('、')}</p>` : ''}
      ${P.count ? `<ol class="tight">${P.names.map(n => `<li>${esc(n)}</li>`).join('')}</ol>` : '<p class="muted">この端末にはプロジェクトがありません。</p>'}
      ${P.extra.length && P.expected ? `<p class="muted">Phase 7以外のプロジェクト：${P.extra.map(esc).join('、')}</p>` : ''}
    </section>
    <section class="card" id="sc-counts">
      <h2>同期の対象の件数</h2>
      <dl class="kv">
        <dt>プロジェクト</dt><dd>${r.main.projects}件</dd>
        <dt>仕様書</dt><dd>${r.main.specs}件</dd>
        <dt>要望</dt><dd>${r.main.requests}件</dd>
        <dt>変更履歴</dt><dd>${r.main.history}件</dd>
        <dt>その他</dt><dd>${r.otherTotal}件</dd>
      </dl>
      <details><summary>「その他」の内訳</summary><dl class="kv">${Object.entries(r.others).map(([s, n]) => `<dt>${esc(STORE_LABELS_JA[s] || s)}</dt><dd>${n}件</dd>`).join('')}</dl></details>
      <p class="muted">同期しないもの：端末ごとの記録（${r.excluded.deviceSettings.map(esc).join('・') || 'なし'}）${r.excluded.localOnly ? `・この端末だけの記録 ${r.excluded.localOnly}件` : ''}</p>
    </section>
    <section class="card" id="sc-backup">
      <h2>バックアップ</h2>
      <p>${ok(r.backup.ok, `作成できます（${mb(r.backup.bytes)}）`, '作成できません')}</p>
      ${r.backup.ok ? '<p class="muted">初回登録の直前に、自動でバックアップファイルと端末内の控えを作ります。今すぐ保存したい場合は「バックアップ」画面から保存できます。</p>' : `<p>${esc(r.backup.reason)}</p><p class="muted">この状態では初回登録に進めません。この画面をClaudeに送ってください。</p>`}
      <a class="btn small" href="#/backup">バックアップ画面を開く</a>
    </section>
    <section class="card" id="sc-size">
      <h2>大きすぎるデータ</h2>
      <p>${ok(!r.size.tooLarge.length, 'ありません', `${r.size.tooLarge.length}件あります`)}</p>
      ${r.size.tooLarge.length ? `<ul class="tight">${r.size.tooLarge.map(x => `<li>${esc(STORE_LABELS_JA[x.store] || x.store)}「${esc(x.label)}」：${kb(x.bytes)}</li>`).join('')}</ul><p class="muted">クラウドの1件の上限（1MB）を超える、または近いため、初回登録では分割して送ります。削除する必要はありません。</p>` : ''}
      <p class="muted">全体の大きさ：${mb(r.size.totalBytes)}${r.size.largest[0] ? `／いちばん大きい記録：${esc(STORE_LABELS_JA[r.size.largest[0].store] || r.size.largest[0].store)}「${esc(r.size.largest[0].label)}」${kb(r.size.largest[0].bytes)}` : ''}</p>
    </section>
    <section class="card" id="sc-privacy">
      <h2>個人情報らしき記述</h2>
      <p>${ok(!r.privacy.length, '見つかりませんでした', `${r.privacy.length}種類見つかりました`)}</p>
      ${r.privacy.length ? `<p class="muted">メールアドレス・電話番号・住所・人名＋敬称などを自動で探しています。間違いもあります。止めはしません。学校の生徒・保護者などの実データであれば、初回登録の前に、その画面で書き直してください。</p>
        <ul class="list privacy-list">${r.privacy.slice(0, 30).map(p => `<li><div><strong>${esc(p.kind)}</strong>：「${esc(p.text)}」 <span class="muted">${p.count}か所</span></div><div class="muted">${p.places.map(pl => `${esc(STORE_LABELS_JA[pl.store] || pl.store)}「${esc(pl.label)}」`).join('、')}</div></li>`).join('')}</ul>
        ${r.privacy.length > 30 ? `<p class="muted">ほか${r.privacy.length - 30}種類</p>` : ''}` : ''}
    </section>
    <p class="muted">この確認では、クラウドへの送信も、この端末のデータの変更もしていません。</p>
    ${!r.blocking && P.expected && !P.missing.length && !P.dupNames.length ? '<section class="card"><p>この端末にはPhase 7の8プロジェクトがそろっています。この端末を初回正本にする場合は、次へ進んでください。</p><a class="btn primary" href="#/sync-register">初回正本登録へ進む</a></section>' : ''}`;
}
