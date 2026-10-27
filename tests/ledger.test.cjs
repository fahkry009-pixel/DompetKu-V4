/* Unit test logika murni (tanpa browser):  node tests/ledger.test.cjs */
const assert = require('node:assert/strict');
require('../js/ledger.js');
const L = globalThis.DK.ledger;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const acc = (o) => L.makeAccount(Object.assign({ type: 'ewallet', provider: 'GoPay', name: 'GoPay', currency: 'IDR', openingMinor: 0 }, o));
const tx = (o) => L.makeTransaction(Object.assign({ date: '2026-10-10' }, o));

t('formatMoney IDR & USD', () => {
  assert.equal(L.formatMoney(75000, 'IDR'), 'Rp75.000');
  assert.equal(L.formatMoney(-1250000, 'IDR'), '-Rp1.250.000');
  assert.equal(L.formatMoney(2000, 'USD'), 'US$20,00');
});
t('parseMoney IDR menerima titik ribuan, menolak desimal/negatif/kosong/nol', () => {
  assert.equal(L.parseMoney('75.000', 'IDR').value, 75000);
  assert.equal(L.parseMoney('75000', 'IDR').value, 75000);
  assert.ok(L.parseMoney('', 'IDR').error);
  assert.ok(L.parseMoney('0', 'IDR').error);
  assert.ok(L.parseMoney('-5', 'IDR').error);
  assert.ok(L.parseMoney('12,5', 'IDR').error);
  assert.ok(L.parseMoney('abc', 'IDR').error);
  assert.equal(L.parseMoney('', 'IDR', { allowZero: true }).value, 0);
});
t('parseMoney USD (sen, tanpa float)', () => {
  assert.equal(L.parseMoney('20', 'USD').value, 2000);
  assert.equal(L.parseMoney('20.5', 'USD').value, 2050);
  assert.equal(L.parseMoney('20,55', 'USD').value, 2055);
  assert.equal(L.parseMoney('1,000.50', 'USD').value, 100050);
  assert.equal(L.parseMoney('1.000,50', 'USD').value, 100050);
  assert.equal(L.parseMoney('1,000', 'USD').value, 100000);
  assert.equal(L.parseMoney('0.10', 'USD').value, 10);
  assert.ok(L.parseMoney('99999999999999', 'USD').error);
});
t('saldo awal BUKAN pemasukan; pemasukan/pengeluaran mengubah saldo', () => {
  const g = acc({ id: 'g', openingMinor: 75000 });
  const txs = [tx({ id: '1', type: 'income', accountId: 'g', category: 'Gaji', amountMinor: 25000 }), tx({ id: '2', type: 'expense', accountId: 'g', category: 'Belanja', amountMinor: 10000 })];
  assert.equal(L.computeBalances([g], txs).get('g'), 90000);
  const s = L.summarize([g], txs, { currency: 'IDR', from: '', to: '', accountId: '' });
  assert.equal(s.income, 25000); assert.equal(s.expense, 10000); assert.equal(s.net, 15000);
});
t('transfer: kurangi asal, tambah tujuan, tidak masuk pemasukan/pengeluaran', () => {
  const g = acc({ id: 'g', openingMinor: 90000 }), d = acc({ id: 'd', provider: 'DANA', name: 'DANA', openingMinor: 50000 });
  const txs = [tx({ id: 't', type: 'transfer', fromId: 'g', toId: 'd', amountMinor: 20000, toAmountMinor: 20000, feeMinor: 0 })];
  const b = L.computeBalances([g, d], txs);
  assert.equal(b.get('g'), 70000); assert.equal(b.get('d'), 70000);
  const s = L.summarize([g, d], txs, { currency: 'IDR', from: '', to: '', accountId: '' });
  assert.equal(s.income, 0); assert.equal(s.expense, 0);
});
t('biaya admin: dikurangi dari asal & dihitung sebagai pengeluaran tepat satu kali', () => {
  const g = acc({ id: 'g', openingMinor: 70000 }), d = acc({ id: 'd', provider: 'DANA', name: 'DANA', openingMinor: 70000 });
  const txs = [tx({ id: 't', type: 'transfer', fromId: 'd', toId: 'g', amountMinor: 10000, toAmountMinor: 10000, feeMinor: 2500 })];
  const b = L.computeBalances([g, d], txs);
  assert.equal(b.get('d'), 70000 - 12500); assert.equal(b.get('g'), 80000);
  const s = L.summarize([g, d], txs, { currency: 'IDR', from: '', to: '', accountId: '' });
  assert.equal(s.expense, 2500);
  assert.deepEqual(s.categories.map((c) => c.name), ['Biaya admin']);
  // filter akun: hanya akun asal yang menanggung biaya
  assert.equal(L.summarize([g, d], txs, { currency: 'IDR', from: '', to: '', accountId: 'g' }).expense, 0);
  assert.equal(L.summarize([g, d], txs, { currency: 'IDR', from: '', to: '', accountId: 'd' }).expense, 2500);
});
t('mata uang berbeda tidak dijumlahkan; transfer lintas mata uang memakai nominal masuk sendiri', () => {
  const g = acc({ id: 'g', openingMinor: 1000000 }), p = acc({ id: 'p', provider: 'PayPal', name: 'PayPal USD', currency: 'USD', openingMinor: 2000 });
  const txs = [tx({ id: 't', type: 'transfer', fromId: 'g', toId: 'p', amountMinor: 160000, toAmountMinor: 1000, feeMinor: 0 })];
  const b = L.computeBalances([g, p], txs);
  assert.equal(b.get('g'), 840000); assert.equal(b.get('p'), 3000);
  assert.equal(L.summarize([g, p], txs, { currency: 'USD', from: '', to: '', accountId: '' }).expense, 0);
});
t('validasi transaksi: tolak nominal 0/negatif, akun tak valid, transfer ke akun sama, beda nominal sama mata uang', () => {
  const g = acc({ id: 'g' }), d = acc({ id: 'd' });
  const by = new Map([[g.id, g], [d.id, d]]);
  assert.ok(L.validateTransaction(tx({ id: 'a', type: 'income', accountId: 'g', category: 'Gaji', amountMinor: 0 }), by).length);
  assert.ok(L.validateTransaction(tx({ id: 'a', type: 'income', accountId: 'g', category: 'Gaji', amountMinor: -5 }), by).length);
  assert.ok(L.validateTransaction(tx({ id: 'a', type: 'income', accountId: 'zzz', category: 'Gaji', amountMinor: 5 }), by).length);
  assert.ok(L.validateTransaction(tx({ id: 'a', type: 'transfer', fromId: 'g', toId: 'g', amountMinor: 5, toAmountMinor: 5 }), by).length);
  assert.ok(L.validateTransaction(tx({ id: 'a', type: 'transfer', fromId: 'g', toId: 'd', amountMinor: 5, toAmountMinor: 6 }), by).length);
  assert.ok(L.validateTransaction(tx({ id: '', type: 'income', accountId: 'g', category: 'Gaji', amountMinor: 5 }), by).length);
  assert.equal(L.validateTransaction(tx({ id: 'ok', type: 'transfer', fromId: 'g', toId: 'd', amountMinor: 5, toAmountMinor: 5 }), by).length, 0);
});
t('validasi akun: id wajib, hanya satu Cash, saldo awal tidak negatif', () => {
  assert.ok(L.validateAccount(acc({ id: '' })).length);
  assert.ok(L.validateAccount(acc({ type: 'cash', id: 'lain' })).length);
  assert.ok(L.validateAccount(acc({ openingMinor: -1 })).length);
  assert.equal(L.validateAccount(L.defaultCash(0)).length, 0);
  assert.ok(L.makeAccount({ type: 'bank', provider: 'BCA', name: 'BCA', currency: 'IDR', openingMinor: 0 }).id.startsWith('acc_'));
});
t('rekap: kategori terurut dari terbesar, persen jumlahnya ~100, data kosong aman', () => {
  const g = acc({ id: 'g', openingMinor: 1000 });
  const txs = [tx({ id: '1', type: 'expense', accountId: 'g', category: 'Belanja', amountMinor: 100 }), tx({ id: '2', type: 'expense', accountId: 'g', category: 'Tagihan', amountMinor: 300 }), tx({ id: '3', type: 'expense', accountId: 'g', category: 'Hiburan', amountMinor: 200 })];
  const s = L.summarize([g], txs, { currency: 'IDR', from: '', to: '', accountId: '' });
  assert.deepEqual(s.categories.map((c) => c.name), ['Tagihan', 'Hiburan', 'Belanja']);
  assert.equal(s.top.name, 'Tagihan');
  assert.ok(Math.abs(s.categories.reduce((x, c) => x + c.pct, 0) - 100) < 1e-9);
  const empty = L.summarize([g], [], { currency: 'IDR', from: '', to: '', accountId: '' });
  assert.equal(empty.expense, 0); assert.equal(empty.top, null); assert.deepEqual(empty.categories, []);
});
t('rekap: filter periode', () => {
  const g = acc({ id: 'g' });
  const txs = [tx({ id: '1', date: '2026-09-30', type: 'expense', accountId: 'g', category: 'Belanja', amountMinor: 100 }), tx({ id: '2', date: '2026-10-01', type: 'expense', accountId: 'g', category: 'Belanja', amountMinor: 200 })];
  const r = L.periodRange('month', '2026-10-27');
  assert.equal(r.from, '2026-10-01'); assert.equal(r.to, '2026-10-31');
  assert.equal(L.summarize([g], txs, { currency: 'IDR', from: r.from, to: r.to, accountId: '' }).expense, 200);
  const lm = L.periodRange('lastmonth', '2026-10-27');
  assert.equal(lm.from, '2026-09-01'); assert.equal(lm.to, '2026-09-30');
  assert.equal(L.periodRange('lastmonth', '2026-01-15').from, '2025-12-01');
  assert.equal(L.periodRange('7d', '2026-10-27').from, '2026-10-21');
});
t('backup: valid lolos; app salah, ID ganda, relasi rusak ditolak', () => {
  const cash = L.defaultCash(5000), g = acc({ id: 'g', openingMinor: 100 });
  const good = L.buildBackup([cash, g], [tx({ id: '1', type: 'income', accountId: 'g', category: 'Gaji', amountMinor: 10 })]);
  assert.equal(L.validateBackup(JSON.parse(JSON.stringify(good))).ok, true);
  assert.equal(L.validateBackup({ app: 'Lain', format: 1, accounts: [], transactions: [] }).ok, false);
  assert.equal(L.validateBackup(null).ok, false);
  const dupTx = JSON.parse(JSON.stringify(good)); dupTx.transactions.push(dupTx.transactions[0]);
  assert.equal(L.validateBackup(dupTx).ok, false);
  const orphan = JSON.parse(JSON.stringify(good)); orphan.transactions[0].accountId = 'hilang';
  assert.equal(L.validateBackup(orphan).ok, false);
  const badAmt = JSON.parse(JSON.stringify(good)); badAmt.transactions[0].amountMinor = '10';
  assert.equal(L.validateBackup(badAmt).ok, false);
  const twoCash = JSON.parse(JSON.stringify(good)); twoCash.accounts.push(Object.assign({}, twoCash.accounts[0], { id: 'cash2' }));
  assert.equal(L.validateBackup(twoCash).ok, false);
});
t('planMerge: ID sama dilewati, transaksi yatim ditolak, data baru ditambahkan', () => {
  const cash = L.defaultCash(0), g = acc({ id: 'g' });
  const cur = [cash, g], curT = [tx({ id: 'x1', type: 'income', accountId: 'g', category: 'Gaji', amountMinor: 10 })];
  const d = acc({ id: 'd', name: 'DANA', provider: 'DANA' });
  const data = { accounts: [cash, g, d], transactions: [curT[0], tx({ id: 'x2', type: 'income', accountId: 'd', category: 'Gaji', amountMinor: 5 }), tx({ id: 'x3', type: 'income', accountId: 'tidak-ada', category: 'Gaji', amountMinor: 5 })] };
  const p = L.planMerge(cur, curT, data);
  assert.equal(p.newAccounts.length, 1); assert.equal(p.dupAccounts, 2);
  assert.equal(p.newTxs.length, 1); assert.equal(p.dupTxs, 1); assert.equal(p.rejectedTxs, 1);
});

console.log('\n' + pass + ' lulus, ' + fail + ' gagal');
process.exit(fail ? 1 : 0);
