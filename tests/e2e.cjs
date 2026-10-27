/*
 * Tes end-to-end di Chromium sungguhan (emulasi Pixel 7), IndexedDB asli, tanpa mock.
 * Jalankan:  npm install && npx playwright install chromium && npm test
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

const results = [];
async function step(name, fn) {
  if (process.env.TRACE) console.log('...  ' + name);
  try { await fn(); results.push({ name, ok: true }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').slice(0, 4).join('\n      ')); }
}

/* ---------- helper UI ---------- */
const pickImport = async (page, f) => { await page.evaluate(() => { document.querySelector('#import-file').value = ''; }); await page.setInputFiles('#import-file', f); };
const nav = (page, n) => page.click('[data-nav="' + n + '"]');
async function selectByName(page, sel, name) {
  const value = await page.$eval(sel, (el, n) => { const o = Array.from(el.options).find((x) => x.text.startsWith(n + ' ·') || x.text === n); return o ? o.value : null; }, name);
  if (!value) throw new Error('Opsi "' + name + '" tidak ada di ' + sel);
  await page.selectOption(sel, value);
}
async function addAccount(page, { type, provider, name, currency = 'IDR', opening }) {
  await nav(page, 'home');
  await page.click('#btn-add-account');
  await page.waitForSelector('#dlg-account[open]');
  await page.click('label[for="acc-type-' + type + '"]');
  if (provider) await page.selectOption('#acc-provider', provider);
  await page.fill('#acc-name', name);
  await page.selectOption('#acc-currency', currency);
  await page.fill('#acc-opening', String(opening));
  await page.click('#acc-save');
  await page.waitForSelector('#dlg-account:not([open])', { state: 'attached' });
}
const balance = async (page, name) => { await nav(page, 'home'); return (await page.locator('.acct', { hasText: name }).first().locator('.acct-balance').innerText()).trim(); };
async function addFlow(page, kind, { account, amount, category, note }) {
  await nav(page, kind);
  await selectByName(page, '#' + kind + '-account', account);
  if (category) await page.selectOption('#' + kind + '-category', category);
  await page.fill('#' + kind + '-amount', String(amount));
  if (note) await page.fill('#' + kind + '-note', note);
  await page.click('#' + kind + '-save');
  await page.waitForFunction((k) => document.querySelector('#' + k + '-amount').value === '', kind);
}
async function doTransfer(page, { from, to, amount, fee }) {
  await nav(page, 'transfer');
  await selectByName(page, '#transfer-from', from);
  await selectByName(page, '#transfer-to', to);
  await page.fill('#transfer-amount', String(amount));
  if (fee) await page.fill('#transfer-fee', String(fee));
  await page.click('#transfer-save');
  await page.waitForFunction(() => document.querySelector('#transfer-amount').value === '');
}
async function recap(page) {
  await nav(page, 'recap');
  const t = (s) => page.locator(s).innerText().then((x) => x.trim());
  return { income: await t('#recap-income'), expense: await t('#recap-expense'), net: await t('#recap-net'), legend: await page.locator('#recap-legend li').allInnerTexts() };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port + '/';
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dompetku-pw-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dompetku-dl-'));
  const launch = () => chromium.launchPersistentContext(userDir, Object.assign({}, devices['Pixel 7'], { acceptDownloads: true, serviceWorkers: 'allow' }));
  const problems = [];
  const watch = (page) => {
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  };

  let ctx = await launch(); ctx.setDefaultTimeout(8000); let page = await ctx.newPage(); watch(page);
  await page.goto(url);
  await page.waitForSelector('#purse .total');

  await step('0. Awal: hanya satu akun Cash, tanpa akun lain otomatis', async () => {
    assert.equal(await page.locator('.acct').count(), 1);
    assert.match(await page.locator('.acct').first().innerText(), /Cash/);
    assert.equal(await page.locator('[data-total="IDR"]').innerText(), 'Rp0');
  });
  await step('0b. Akun Cash: saldo awal bisa diisi (tanpa membuat Cash ganda)', async () => {
    await page.click('.acct >> nth=0'); await page.click('#det-edit');
    await page.fill('#acc-opening', '10000'); await page.click('#acc-save');
    await page.waitForSelector('#dlg-account:not([open])', { state: 'attached' });
    assert.equal(await balance(page, 'Cash'), 'Rp10.000');
    assert.equal(await page.locator('.acct').count(), 1);
  });

  await step('1. Buat akun GoPay saldo awal Rp75.000 (satu form, langsung muncul)', async () => {
    await addAccount(page, { type: 'ewallet', provider: 'GoPay', name: 'GoPay Pribadi', opening: 75000 });
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp75.000');
  });
  await step('2. Buat akun DANA saldo awal Rp50.000', async () => {
    await addAccount(page, { type: 'ewallet', provider: 'DANA', name: 'DANA Utama', opening: 50000 });
    assert.equal(await balance(page, 'DANA Utama'), 'Rp50.000');
  });
  await step('3. Kedua akun langsung ada di form pemasukan, pengeluaran, dan transfer (tanpa refresh)', async () => {
    for (const sel of ['#income-account', '#expense-account', '#transfer-from', '#transfer-to']) {
      await nav(page, sel.startsWith('#transfer') ? 'transfer' : sel.slice(1).split('-')[0]);
      const txt = (await page.locator(sel + ' option').allInnerTexts()).join('|');
      if (sel === '#transfer-to') assert.ok(txt.includes('DANA Utama') || txt.includes('GoPay Pribadi'), sel + ': ' + txt);
      else assert.ok(txt.includes('GoPay Pribadi') && txt.includes('DANA Utama'), sel + ': ' + txt);
    }
  });
  await step('4-5. Pemasukan Rp25.000 ke GoPay -> saldo Rp100.000', async () => {
    await addFlow(page, 'income', { account: 'GoPay Pribadi', amount: 25000, category: 'Gaji' });
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp100.000');
  });
  await step('6-7. Pengeluaran Rp10.000 dari GoPay -> saldo Rp90.000', async () => {
    await addFlow(page, 'expense', { account: 'GoPay Pribadi', amount: 10000, category: 'Makanan & Minuman', note: 'makan siang' });
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp90.000');
  });
  await step('8-9. Transfer Rp20.000 GoPay -> DANA: GoPay Rp70.000, DANA Rp70.000', async () => {
    await doTransfer(page, { from: 'GoPay Pribadi', to: 'DANA Utama', amount: 20000 });
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp70.000');
    assert.equal(await balance(page, 'DANA Utama'), 'Rp70.000');
  });
  await step('9b. Transfer tanpa biaya tidak masuk pemasukan/pengeluaran; saldo awal bukan pemasukan', async () => {
    const r = await recap(page);
    assert.equal(r.income, 'Rp25.000'); assert.equal(r.expense, 'Rp10.000');
  });
  await step('10. Transfer DANA -> GoPay Rp10.000 + biaya admin Rp2.500: biaya dihitung tepat sekali', async () => {
    await doTransfer(page, { from: 'DANA Utama', to: 'GoPay Pribadi', amount: 10000, fee: 2500 });
    assert.equal(await balance(page, 'DANA Utama'), 'Rp57.500');
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp80.000');
    const r = await recap(page);
    assert.equal(r.income, 'Rp25.000'); assert.equal(r.expense, 'Rp12.500');
    assert.ok(r.legend.some((l) => l.includes('Biaya admin') && l.includes('Rp2.500')), r.legend.join(' / '));
  });
  await step('11. Edit transfer (nominal 15.000, biaya 1.000): saldo & biaya ikut benar', async () => {
    await nav(page, 'transfer');
    await page.locator('#list-transfer .row', { hasText: 'DANA Utama → GoPay Pribadi' }).click();
    assert.equal(await page.inputValue('#transfer-amount'), '10.000');
    assert.equal(await page.inputValue('#transfer-fee'), '2.500');
    await page.fill('#transfer-amount', '15000'); await page.fill('#transfer-fee', '1000');
    await page.click('#transfer-save');
    await page.waitForFunction(() => document.querySelector('#transfer-amount').value === '');
    assert.equal(await balance(page, 'DANA Utama'), 'Rp54.000');
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp85.000');
    const r = await recap(page);
    assert.equal(r.expense, 'Rp11.000');
    await nav(page, 'transfer');
    assert.equal(await page.locator('#list-transfer .row').count(), 2);
  });
  await step('12. Hapus transfer: saldo kembali konsisten, biaya admin ikut hilang', async () => {
    await nav(page, 'transfer');
    await page.locator('#list-transfer .row', { hasText: 'DANA Utama → GoPay Pribadi' }).click();
    await page.click('#transfer-delete'); await page.click('#confirm-ok');
    await page.waitForFunction(() => !document.querySelector('#transfer-delete') || document.querySelector('#transfer-delete').hidden);
    assert.equal(await balance(page, 'DANA Utama'), 'Rp70.000');
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp70.000');
    const r = await recap(page);
    assert.equal(r.expense, 'Rp10.000');
    assert.ok(!r.legend.some((l) => l.includes('Biaya admin')));
  });
  await step('13. Grafik & rekap dibaca dari transaksi: urut terbesar, persen, perubahan periode', async () => {
    await addFlow(page, 'expense', { account: 'DANA Utama', amount: 30000, category: 'Transportasi' });
    const r = await recap(page);
    assert.equal(r.expense, 'Rp40.000'); assert.equal(r.income, 'Rp25.000'); assert.equal(r.net, '-Rp15.000');
    assert.match(r.legend[0], /Transportasi.*75,0%.*Rp30\.000/s);
    assert.match(r.legend[1], /Makanan & Minuman.*25,0%.*Rp10\.000/s);
    assert.match(await page.locator('#recap-top').innerText(), /Terbesar: Transportasi \(75,0%\)/);
    assert.equal(await page.locator('#recap-chart circle:not(.ring-empty)').count(), 2);
    assert.match(await page.locator('#recap-chart svg').textContent(), /Rp40 rb/);
    // ganti periode -> semua angka & grafik ikut berubah, data kosong tidak error
    await page.selectOption('#recap-period', 'lastmonth');
    assert.equal(await page.locator('#recap-expense').innerText(), 'Rp0');
    assert.equal(await page.locator('#recap-chart circle.ring-empty').count(), 1);
    assert.match(await page.locator('#recap-top').innerText(), /Belum ada pengeluaran/);
    // filter akun
    await page.selectOption('#recap-period', 'all');
    await selectByName(page, '#recap-account', 'DANA Utama').catch(async () => { const v = await page.$eval('#recap-account', (el) => Array.from(el.options).find((o) => o.text.startsWith('DANA Utama')).value); await page.selectOption('#recap-account', v); });
    assert.equal(await page.locator('#recap-expense').innerText(), 'Rp30.000');
    await page.selectOption('#recap-account', '');
  });
  await step('Validasi UI: nominal kosong, 0, negatif ditolak dengan pesan jelas; saldo tidak berubah', async () => {
    const before = await balance(page, 'GoPay Pribadi');
    await nav(page, 'expense');
    for (const v of ['', '0']) {
      await page.fill('#expense-amount', v); await page.click('#expense-save');
      assert.ok((await page.locator('#expense-error').innerText()).length > 5, 'tidak ada pesan untuk "' + v + '"');
    }
    // tanda minus tidak bisa diketik di kolom Rupiah (dibuang), jadi nominal negatif mustahil masuk
    await page.fill('#expense-amount', '-500');
    assert.equal(await page.inputValue('#expense-amount'), '500');
    await page.fill('#expense-amount', '');
    assert.equal(await balance(page, 'GoPay Pribadi'), before);
  });
  await step('Validasi DB: akun tak valid / ID kosong / transfer ke akun sama ditolak & tidak mengubah apa pun', async () => {
    const before = await page.evaluate(() => DK.db.loadAll().then((d) => d.transactions.length));
    const out = await page.evaluate(async () => {
      const L = DK.ledger, res = {};
      const attempt = async (k, rec) => { try { await DK.db.saveTransaction(rec); res[k] = 'DITERIMA'; } catch (e) { res[k] = e.name + ': ' + e.message; } };
      const accs = (await DK.db.loadAll()).accounts; const a = accs.find((x) => x.name === 'GoPay Pribadi');
      await attempt('akunHilang', L.makeTransaction({ type: 'income', date: '2026-10-10', accountId: 'acc_tidakada', category: 'Gaji', amountMinor: 100 }));
      await attempt('idKosong', Object.assign(L.makeTransaction({ type: 'income', date: '2026-10-10', accountId: a.id, category: 'Gaji', amountMinor: 100 }), { id: undefined }));
      await attempt('transferSama', L.makeTransaction({ type: 'transfer', date: '2026-10-10', fromId: a.id, toId: a.id, amountMinor: 100, toAmountMinor: 100 }));
      await attempt('negatif', L.makeTransaction({ type: 'expense', date: '2026-10-10', accountId: a.id, category: 'Belanja', amountMinor: -100 }));
      try { await DK.db.saveAccount(Object.assign({}, a, { id: undefined })); res.akunIdKosong = 'DITERIMA'; } catch (e) { res.akunIdKosong = e.name + ': ' + e.message; }
      return res;
    });
    for (const [k, v] of Object.entries(out)) assert.ok(v.startsWith('DKError'), k + ' -> ' + v);
    const after = await page.evaluate(() => DK.db.loadAll().then((d) => d.transactions.length));
    assert.equal(after, before);
  });
  await step('Klik ganda tombol Simpan tidak membuat transaksi ganda', async () => {
    const before = await page.evaluate(() => DK.db.loadAll().then((d) => d.transactions.length));
    await nav(page, 'income');
    await selectByName(page, '#income-account', 'Cash');
    await page.fill('#income-amount', '1000');
    await page.evaluate(() => { const b = document.querySelector('#income-save'); b.click(); b.click(); b.click(); });
    await page.waitForFunction(() => document.querySelector('#income-amount').value === '');
    const after = await page.evaluate(() => DK.db.loadAll().then((d) => d.transactions.length));
    assert.equal(after, before + 1);
    assert.equal(await balance(page, 'Cash'), 'Rp11.000');
  });

  /* snapshot untuk backup */
  const snapshot = async (p) => {
    await nav(p, 'home');
    return JSON.stringify({ gopay: await balance(p, 'GoPay Pribadi'), dana: await balance(p, 'DANA Utama'), cash: await balance(p, 'Cash') });
  };
  const snapA = await snapshot(page);

  await step('14. Saldo & transaksi tetap ada setelah halaman di-refresh', async () => {
    await page.reload(); await page.waitForSelector('#purse .total');
    assert.equal(await snapshot(page), snapA);
    assert.equal(await page.locator('#list-income .row').count(), 2);
  });

  let backupFile = '';
  await step('15a. Ekspor backup JSON benar-benar menghasilkan file valid', async () => {
    await nav(page, 'recap');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
    backupFile = path.join(dlDir, dl.suggestedFilename()); await dl.saveAs(backupFile);
    const j = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.equal(j.app, 'DompetKu'); assert.equal(j.accounts.length, 3); assert.equal(j.transactions.length, 5);
    assert.match(await page.locator('#toast').innerText(), /File cadangan dibuat \(3 akun, 5 transaksi\)/);
  });
  await step('15b. Impor file tidak valid ditolak dengan pesan; data tidak berubah', async () => {
    const bad = path.join(dlDir, 'rusak.json'); fs.writeFileSync(bad, '{ bukan json');
    const bad2 = path.join(dlDir, 'rusak2.json');
    const j = JSON.parse(fs.readFileSync(backupFile, 'utf8')); j.transactions[0].accountId = 'hilang'; fs.writeFileSync(bad2, JSON.stringify(j));
    for (const f of [bad, bad2]) {
      await pickImport(page, f);
      await page.waitForSelector('#dlg-import[open]');
      assert.match(await page.locator('#import-body').innerText(), /tidak diimpor/);
      assert.ok(await page.locator('#import-confirm').isHidden());
      await page.click('#import-cancel');
    }
    assert.equal(await snapshot(page), snapA);
  });
  await step('15c. Impor "Gabungkan" file yang sama: ID duplikat dilewati, tidak ada data ganda', async () => {
    await nav(page, 'recap');
    await pickImport(page, backupFile);
    await page.waitForSelector('#import-mode-merge');
    assert.match(await page.locator('#import-body').innerText(), /Tambah 0 akun dan 0 transaksi baru/);
    await page.click('#import-confirm');
    await page.waitForSelector('#dlg-import:not([open])', { state: 'attached' });
    assert.equal(await snapshot(page), snapA);
    assert.equal(await page.evaluate(() => DK.db.loadAll().then((d) => d.transactions.length)), 5);
  });
  await step('15d. Impor "Ganti semua" (dengan konfirmasi) memulihkan keadaan backup', async () => {
    await addFlow(page, 'expense', { account: 'GoPay Pribadi', amount: 5000, category: 'Belanja' });
    assert.notEqual(await snapshot(page), snapA);
    await nav(page, 'recap');
    await pickImport(page, backupFile);
    await page.waitForSelector('#import-mode-replace');
    await page.click('label:has(#import-mode-replace)');
    await page.click('#import-confirm');
    await page.waitForSelector('#dlg-confirm[open]'); await page.click('#confirm-ok');
    await page.waitForSelector('#dlg-import:not([open])', { state: 'attached' });
    assert.equal(await snapshot(page), snapA);
    assert.equal(await page.evaluate(() => DK.db.loadAll().then((d) => d.accounts.filter((a) => a.type === 'cash').length)), 1);
  });
  await step('15e. Impor "Gabungkan" ke data yang lebih kecil menambah akun & transaksi yang belum ada', async () => {
    // hapus satu pengeluaran, lalu gabungkan lagi: transaksi itu kembali, sisanya dilewati
    await nav(page, 'expense');
    await page.locator('#list-expense .row', { hasText: 'Makanan & Minuman' }).click();
    await page.click('#expense-delete'); await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#expense-delete').hidden);
    assert.notEqual(await snapshot(page), snapA);
    await nav(page, 'recap');
    await pickImport(page, backupFile);
    await page.waitForSelector('#import-mode-merge');
    assert.match(await page.locator('#import-body').innerText(), /Tambah 0 akun dan 1 transaksi baru/);
    await page.click('#import-confirm'); await page.waitForSelector('#dlg-import:not([open])', { state: 'attached' });
    assert.equal(await snapshot(page), snapA);
  });

  await step('16. Tutup browser lalu buka lagi: data ada, tambah akun & transfer tetap jalan', async () => {
    await ctx.close();
    ctx = await launch(); ctx.setDefaultTimeout(8000); page = await ctx.newPage(); watch(page);
    await page.goto(url); await page.waitForSelector('#purse .total');
    const after = JSON.parse(await snapshot(page));
    assert.equal(after.gopay, JSON.parse(snapA).gopay); assert.equal(after.dana, JSON.parse(snapA).dana);
    await addAccount(page, { type: 'bank', provider: 'BCA', name: 'Tabungan BCA', opening: 500000 });
    assert.equal(await balance(page, 'Tabungan BCA'), 'Rp500.000');
    await doTransfer(page, { from: 'Tabungan BCA', to: 'GoPay Pribadi', amount: 100000 });
    assert.equal(await balance(page, 'Tabungan BCA'), 'Rp400.000');
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp170.000');
  });

  await step('Akun USD: saldo terpisah dari IDR, tidak dijumlahkan; transfer lintas mata uang butuh nominal diterima', async () => {
    await addAccount(page, { type: 'ewallet', provider: 'PayPal', name: 'PayPal USD', currency: 'USD', opening: 20 });
    assert.equal(await balance(page, 'PayPal USD'), 'US$20,00');
    assert.equal(await page.locator('[data-total="USD"]').innerText(), 'US$20,00');
    const idr = await page.locator('[data-total="IDR"]').innerText();
    assert.ok(idr.startsWith('Rp'));
    await nav(page, 'transfer');
    await selectByName(page, '#transfer-from', 'GoPay Pribadi'); await selectByName(page, '#transfer-to', 'PayPal USD');
    assert.ok(await page.locator('#transfer-receive-wrap').isVisible());
    await page.fill('#transfer-amount', '160000');
    await page.click('#transfer-save');
    assert.match(await page.locator('#transfer-error').innerText(), /Nominal diterima/);
    await page.fill('#transfer-receive', '10');
    await page.click('#transfer-save');
    await page.waitForFunction(() => document.querySelector('#transfer-amount').value === '');
    assert.equal(await balance(page, 'PayPal USD'), 'US$30,00');
    assert.equal(await balance(page, 'GoPay Pribadi'), 'Rp10.000');
    await nav(page, 'recap');
    assert.ok(await page.locator('#recap-currency-wrap').isVisible());
    await page.click('#recap-currency [data-cur="USD"]');
    assert.equal(await page.locator('#recap-income').innerText(), 'US$0,00');
    await page.click('#recap-currency [data-cur="IDR"]');
  });

  await step('Arsipkan akun: hilang dari form, riwayat tetap, bisa diaktifkan lagi', async () => {
    await nav(page, 'home');
    await page.locator('.acct', { hasText: 'Tabungan BCA' }).click();
    await page.click('#det-archive'); await page.click('#confirm-ok');
    await page.waitForSelector('#dlg-detail:not([open])', { state: 'attached' });
    assert.equal(await page.locator('.acct', { hasText: 'Tabungan BCA' }).count(), 0);
    await nav(page, 'income');
    assert.ok(!(await page.locator('#income-account option').allInnerTexts()).join('|').includes('Tabungan BCA'));
    await nav(page, 'home'); await page.click('#toggle-archived');
    await page.locator('.acct', { hasText: 'Tabungan BCA' }).click();
    assert.match(await page.locator('#detail-body').innerText(), /Transfer ke GoPay Pribadi/);
    await page.click('#det-archive');
    await page.waitForSelector('#dlg-detail:not([open])', { state: 'attached' });
    assert.equal(await balance(page, 'Tabungan BCA'), 'Rp400.000');
  });

  await step('17. Offline: aplikasi tetap terbuka dan bisa mencatat transaksi', async () => {
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }); });
    const cached = await page.evaluate(async () => (await (await caches.open((await caches.keys())[0])).keys()).length);
    assert.ok(cached >= 11, 'cache hanya berisi ' + cached + ' file');
    await ctx.setOffline(true);
    await page.reload(); await page.waitForSelector('#purse .total');
    assert.ok(await page.locator('#net-state').isVisible());
    assert.equal(await balance(page, 'Tabungan BCA'), 'Rp400.000');
    await addFlow(page, 'income', { account: 'Cash', amount: 2000, category: 'Hadiah' });
    assert.equal(await balance(page, 'Cash'), 'Rp13.000');
    await ctx.setOffline(false);
  });

  await step('18. Tidak ada error IndexedDB/keyPath/JS selama seluruh pengujian', async () => {
    const bad = problems.filter((p) => !/Failed to load resource/.test(p));
    assert.deepEqual(bad, []);
  });

  await ctx.close(); server.close();
  const failed = results.filter((r) => !r.ok);
  const report = results.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.err ? '\n      ' + r.err.split('\n')[0] : '')).join('\n') + '\n\n' + (results.length - failed.length) + ' lulus, ' + failed.length + ' gagal dari ' + results.length + ' langkah\n';
  fs.writeFileSync(path.join(__dirname, 'last-e2e-result.txt'), report);
  console.log('\n' + (results.length - failed.length) + ' lulus, ' + failed.length + ' gagal dari ' + results.length + ' langkah');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
