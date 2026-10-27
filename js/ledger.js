/*
 * DompetKu v2 — ledger.js
 * Logika murni (tanpa DOM, tanpa IndexedDB): format uang, validasi, hitung saldo, rekap, backup.
 *
 * ===== SKEMA DATA (versi 1) =====
 * Semua nominal disimpan sebagai BILANGAN BULAT satuan terkecil ("minor"):
 *   IDR -> rupiah utuh (Rp75.000 = 75000)     USD -> sen (US$20,00 = 2000)
 *
 * Object store "accounts"      keyPath: "id" (string)
 *   { id, type: 'cash'|'ewallet'|'bank'|'other', provider, name, currency: 'IDR'|'USD',
 *     openingMinor (>=0, BUKAN pemasukan), archived (bool), createdAt (ms) }
 *   Akun Cash selalu punya id tetap "acc_cash" -> mustahil ada Cash ganda.
 *
 * Object store "transactions"  keyPath: "id" (string)
 *   { id, type: 'income'|'expense'|'transfer', date: 'YYYY-MM-DD', createdAt, updatedAt, note,
 *     category,                          // income/expense; null untuk transfer
 *     accountId,                         // income/expense; null untuk transfer
 *     fromId, toId,                      // transfer; null untuk income/expense
 *     amountMinor,                       // income/expense: nominal; transfer: nominal KELUAR dari fromId
 *     toAmountMinor,                     // transfer: nominal MASUK ke toId (null untuk income/expense)
 *     feeMinor }                         // biaya admin transfer, mata uang akun asal (0 jika tidak ada)
 *
 * Saldo TIDAK disimpan. Saldo = openingMinor + semua efek transaksi, dihitung ulang setiap kali.
 * Karena itu edit/hapus transaksi otomatis konsisten dan tidak mungkin ada saldo "setengah berubah".
 * Biaya admin disimpan di dalam record transfer (feeMinor) -> edit/hapus transfer ikut mengubah
 * biayanya, dan biaya dihitung sebagai pengeluaran tepat satu kali.
 */
(function (global) {
  'use strict';
  const DK = (global.DK = global.DK || {});

  const CASH_ID = 'acc_cash';
  const CURRENCIES = {
    IDR: { code: 'IDR', symbol: 'Rp', decimals: 0 },
    USD: { code: 'USD', symbol: 'US$', decimals: 2 },
  };
  const ACCOUNT_TYPES = { cash: 'Cash', ewallet: 'E-Wallet', bank: 'Bank', other: 'Lainnya' };
  const PROVIDERS = {
    ewallet: ['GoPay', 'DANA', 'OVO', 'ShopeePay', 'LinkAja', 'PayPal', 'Wise'],
    bank: ['BCA', 'BRI', 'BNI', 'Mandiri', 'BSI', 'SeaBank', 'Bank Jago'],
    other: [],
  };
  const INCOME_CATEGORIES = ['Gaji', 'Bonus', 'Usaha', 'Penjualan', 'Hadiah', 'Lainnya'];
  const EXPENSE_CATEGORIES = ['Makanan & Minuman', 'Transportasi', 'Belanja', 'Tagihan', 'Pulsa & Data', 'Hiburan', 'Kesehatan', 'Pendidikan', 'Lainnya'];
  const FEE_CATEGORY = 'Biaya admin';
  const CATEGORY_COLORS = {
    'Makanan & Minuman': '#E4572E', Transportasi: '#F29E4C', Belanja: '#B5428B', Tagihan: '#3E6FD8',
    'Pulsa & Data': '#1FA2A6', Hiburan: '#8A5CF6', Kesehatan: '#D6336C', Pendidikan: '#2F9E5B',
    'Biaya admin': '#7A8793', Lainnya: '#A8A29A',
  };
  const FALLBACK_COLORS = ['#C2410C', '#0E7490', '#7C3AED', '#15803D', '#B91C1C', '#4D7C0F'];
  const MAX_MINOR = 1e14;

  /* ---------- util ---------- */
  function newId(prefix) {
    const c = global.crypto;
    if (c && typeof c.randomUUID === 'function') return prefix + '_' + c.randomUUID();
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
  const pad2 = (n) => String(n).padStart(2, '0');
  function toDateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayLocal() { return toDateStr(new Date()); }
  function isValidDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); return toDateStr(new Date(y, m - 1, d + n)); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  function formatDate(s) { if (!isValidDate(s)) return s || ''; const [y, m, d] = s.split('-').map(Number); return d + ' ' + MONTHS[m - 1] + ' ' + y; }

  /* ---------- uang ---------- */
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function formatMoney(minor, cur) {
    const c = CURRENCIES[cur] || CURRENCIES.IDR;
    const neg = minor < 0, abs = Math.abs(minor), f = Math.pow(10, c.decimals);
    let s = group(Math.floor(abs / f));
    if (c.decimals) s += ',' + String(abs % f).padStart(c.decimals, '0');
    return (neg ? '-' : '') + c.symbol + s;
  }
  function formatCompact(minor, cur) {
    const c = CURRENCIES[cur] || CURRENCIES.IDR;
    const v = Math.abs(minor) / Math.pow(10, c.decimals);
    const sign = minor < 0 ? '-' : '';
    const fmt = (x, suf) => sign + c.symbol + (Math.round(x * 10) / 10).toString().replace('.', ',') + suf;
    if (cur === 'IDR') {
      if (v >= 1e9) return fmt(v / 1e9, ' M');
      if (v >= 1e6) return fmt(v / 1e6, ' jt');
      if (v >= 1e4) return fmt(v / 1e3, ' rb');
    } else if (v >= 1e6) return fmt(v / 1e6, ' jt');
    else if (v >= 1e4) return fmt(v / 1e3, ' rb');
    return formatMoney(minor, cur);
  }
  /** Ubah teks input jadi minor. opts.allowZero: boleh 0 / kosong (saldo awal, biaya admin). */
  function parseMoney(raw, cur, opts) {
    opts = opts || {};
    const c = CURRENCIES[cur];
    if (!c) return { error: 'Mata uang tidak dikenal.' };
    const s = String(raw == null ? '' : raw).replace(/\s/g, '');
    if (!s) return opts.allowZero ? { value: 0 } : { error: 'Nominal wajib diisi.' };
    if (s[0] === '-') return { error: 'Nominal tidak boleh negatif.' };
    if (!/^[0-9.,]+$/.test(s)) return { error: 'Nominal hanya boleh berisi angka.' };
    let whole = s, frac = '';
    if (c.decimals === 0) {
      if (s.indexOf(',') !== -1) return { error: 'Rupiah tidak memakai desimal. Tulis angka utuh, mis. 75000.' };
      whole = s.replace(/\./g, '');
    } else {
      const idx = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
      if (idx !== -1) {
        const ch = s[idx], after = s.slice(idx + 1);
        const count = s.split(ch).length - 1;
        if (after.length >= 1 && after.length <= c.decimals && count === 1) { whole = s.slice(0, idx); frac = after; }
      }
      whole = whole.replace(/[.,]/g, '');
    }
    if (whole === '') whole = '0';
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) return { error: 'Format nominal tidak valid.' };
    if (whole.length > 12) return { error: 'Nominal terlalu besar.' };
    const value = Number(whole) * Math.pow(10, c.decimals) + Number(frac.padEnd(c.decimals, '0') || 0);
    if (!isInt(value) || value > MAX_MINOR) return { error: 'Nominal terlalu besar.' };
    if (value === 0 && !opts.allowZero) return { error: 'Nominal harus lebih dari 0.' };
    return { value };
  }

  /* ---------- pembuat record (struktur selalu sama) ---------- */
  function makeAccount(i) {
    return {
      id: i.id !== undefined ? i.id : newId('acc'),
      type: i.type, provider: typeof i.provider === 'string' ? i.provider.trim() : i.provider,
      name: typeof i.name === 'string' ? i.name.trim() : i.name,
      currency: i.currency, openingMinor: i.openingMinor, archived: !!i.archived,
      createdAt: i.createdAt !== undefined ? i.createdAt : Date.now(),
    };
  }
  function makeTransaction(i) {
    const t = i.type, isT = t === 'transfer', now = Date.now();
    return {
      id: i.id !== undefined ? i.id : newId('trx'),
      type: t, date: i.date,
      createdAt: i.createdAt !== undefined ? i.createdAt : now,
      updatedAt: i.updatedAt !== undefined ? i.updatedAt : now,
      note: i.note == null ? '' : (typeof i.note === 'string' ? i.note.trim() : i.note),
      category: isT ? null : (i.category == null ? null : i.category),
      accountId: isT ? null : (i.accountId == null ? null : i.accountId),
      fromId: isT ? (i.fromId == null ? null : i.fromId) : null,
      toId: isT ? (i.toId == null ? null : i.toId) : null,
      amountMinor: i.amountMinor,
      toAmountMinor: isT ? (i.toAmountMinor == null ? null : i.toAmountMinor) : null,
      feeMinor: isT ? (i.feeMinor == null ? 0 : i.feeMinor) : 0,
    };
  }
  function defaultCash(openingMinor) {
    return makeAccount({ id: CASH_ID, type: 'cash', provider: 'Tunai', name: 'Cash', currency: 'IDR', openingMinor: openingMinor || 0, archived: false, createdAt: 0 });
  }

  /* ---------- validasi ---------- */
  function validateAccount(a) {
    const e = [];
    if (!a || typeof a !== 'object') return ['Data akun tidak valid.'];
    if (!isStr(a.id)) e.push('Akun tidak punya ID yang valid.');
    if (!ACCOUNT_TYPES[a.type]) e.push('Jenis akun tidak valid.');
    if (a.type === 'cash' && a.id !== CASH_ID) e.push('Hanya boleh ada satu akun Cash.');
    if (a.id === CASH_ID && a.type !== 'cash') e.push('ID akun Cash tidak boleh dipakai akun lain.');
    if (!isStr(a.name)) e.push('Nama akun wajib diisi.'); else if (a.name.length > 40) e.push('Nama akun maksimal 40 karakter.');
    if (!isStr(a.provider)) e.push('Nama penyedia wajib diisi.'); else if (a.provider.length > 40) e.push('Nama penyedia maksimal 40 karakter.');
    if (!CURRENCIES[a.currency]) e.push('Mata uang tidak valid.');
    if (a.type === 'cash' && a.currency !== 'IDR') e.push('Cash memakai Rupiah.');
    if (!isInt(a.openingMinor) || a.openingMinor < 0 || a.openingMinor > MAX_MINOR) e.push('Saldo awal harus angka 0 atau lebih.');
    if (typeof a.archived !== 'boolean') e.push('Status arsip tidak valid.');
    if (a.type === 'cash' && a.archived) e.push('Cash tidak bisa diarsipkan.');
    if (!isInt(a.createdAt)) e.push('Waktu pembuatan akun tidak valid.');
    return e;
  }
  /** byId: Map id -> akun. */
  function validateTransaction(t, byId) {
    const e = [];
    if (!t || typeof t !== 'object') return ['Data transaksi tidak valid.'];
    if (!isStr(t.id)) e.push('Transaksi tidak punya ID yang valid.');
    if (['income', 'expense', 'transfer'].indexOf(t.type) === -1) { e.push('Jenis transaksi tidak valid.'); return e; }
    if (!isValidDate(t.date)) e.push('Tanggal tidak valid.');
    if (!isInt(t.amountMinor) || t.amountMinor <= 0 || t.amountMinor > MAX_MINOR) e.push('Nominal harus lebih dari 0.');
    if (typeof t.note !== 'string' || t.note.length > 200) e.push('Catatan maksimal 200 karakter.');
    if (!isInt(t.createdAt) || !isInt(t.updatedAt)) e.push('Waktu transaksi tidak valid.');
    if (t.type === 'transfer') {
      const from = byId.get(t.fromId), to = byId.get(t.toId);
      if (!from) e.push('Akun asal tidak ditemukan.');
      if (!to) e.push('Akun tujuan tidak ditemukan.');
      if (t.fromId && t.fromId === t.toId) e.push('Akun asal dan tujuan tidak boleh sama.');
      if (!isInt(t.feeMinor) || t.feeMinor < 0 || t.feeMinor > MAX_MINOR) e.push('Biaya admin tidak valid.');
      if (!isInt(t.toAmountMinor) || t.toAmountMinor <= 0 || t.toAmountMinor > MAX_MINOR) e.push('Nominal diterima harus lebih dari 0.');
      if (from && to && from.currency === to.currency && isInt(t.toAmountMinor) && t.toAmountMinor !== t.amountMinor) e.push('Transfer dengan mata uang sama harus memiliki nominal keluar dan masuk yang sama.');
    } else {
      if (!byId.get(t.accountId)) e.push('Akun tidak ditemukan.');
      if (!isStr(t.category) || t.category.length > 40) e.push('Kategori wajib diisi.');
    }
    return e;
  }

  /* ---------- saldo ---------- */
  /** Efek transaksi terhadap saldo satu akun (minor, bertanda). */
  function deltaFor(t, accountId) {
    if (t.type === 'income') return t.accountId === accountId ? t.amountMinor : 0;
    if (t.type === 'expense') return t.accountId === accountId ? -t.amountMinor : 0;
    let d = 0;
    if (t.fromId === accountId) d -= t.amountMinor + (t.feeMinor || 0);
    if (t.toId === accountId) d += t.toAmountMinor;
    return d;
  }
  function computeBalances(accounts, txs) {
    const m = new Map();
    accounts.forEach((a) => m.set(a.id, a.openingMinor));
    txs.forEach((t) => {
      const ids = t.type === 'transfer' ? [t.fromId, t.toId] : [t.accountId];
      ids.forEach((id) => { if (m.has(id)) m.set(id, m.get(id) + deltaFor(t, id)); });
    });
    return m;
  }

  /* ---------- rekap ---------- */
  /** Aliran yang dihitung sebagai pemasukan/pengeluaran. Transfer hanya menyumbang biaya admin (1x). */
  function flowsOf(t, byId) {
    if (t.type === 'income' || t.type === 'expense') {
      const a = byId.get(t.accountId);
      return a ? [{ accountId: a.id, currency: a.currency, kind: t.type, category: t.category, amount: t.amountMinor }] : [];
    }
    const from = byId.get(t.fromId);
    return from && t.feeMinor > 0 ? [{ accountId: from.id, currency: from.currency, kind: 'expense', category: FEE_CATEGORY, amount: t.feeMinor }] : [];
  }
  function inRange(date, from, to) { return (!from || date >= from) && (!to || date <= to); }
  function colorFor(name, idx) { return CATEGORY_COLORS[name] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length]; }
  /** opts: { currency, from, to, accountId } -> total terpisah per satu mata uang. */
  function summarize(accounts, txs, opts) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    let income = 0, expense = 0;
    const cats = new Map();
    txs.forEach((t) => {
      if (!inRange(t.date, opts.from, opts.to)) return;
      flowsOf(t, byId).forEach((f) => {
        if (f.currency !== opts.currency) return;
        if (opts.accountId && f.accountId !== opts.accountId) return;
        if (f.kind === 'income') income += f.amount;
        else { expense += f.amount; cats.set(f.category, (cats.get(f.category) || 0) + f.amount); }
      });
    });
    const categories = [...cats.entries()].map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      .map((c, i) => ({ name: c.name, amount: c.amount, pct: expense > 0 ? (c.amount / expense) * 100 : 0, color: colorFor(c.name, i) }));
    return { income, expense, net: income - expense, categories, top: categories[0] || null };
  }
  function periodRange(key, today, custom) {
    const [y, m] = today.split('-').map(Number);
    if (key === 'month') return { from: y + '-' + pad2(m) + '-01', to: toDateStr(new Date(y, m, 0)) };
    if (key === 'lastmonth') return { from: toDateStr(new Date(y, m - 2, 1)), to: toDateStr(new Date(y, m - 1, 0)) };
    if (key === '7d') return { from: addDays(today, -6), to: today };
    if (key === '30d') return { from: addDays(today, -29), to: today };
    if (key === 'custom') {
      let f = custom && isValidDate(custom.from) ? custom.from : '', t = custom && isValidDate(custom.to) ? custom.to : '';
      if (f && t && f > t) { const x = f; f = t; t = x; }
      return { from: f, to: t };
    }
    return { from: '', to: '' };
  }

  /* ---------- urutan ---------- */
  function sortAccounts(list) {
    return list.slice().sort((a, b) => (a.id === CASH_ID ? -1 : b.id === CASH_ID ? 1 : a.createdAt - b.createdAt || a.name.localeCompare(b.name)));
  }
  function sortTransactions(list) {
    return list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
  }

  /* ---------- backup ---------- */
  function buildBackup(accounts, txs) {
    return { app: 'DompetKu', format: 1, exportedAt: new Date().toISOString(), accounts, transactions: txs };
  }
  /** Validasi ketat; tidak mengubah apa pun. Hasil: {ok, errors, accounts, transactions}. */
  function validateBackup(obj) {
    const errors = [];
    const fail = (m) => { if (errors.length < 12) errors.push(m); };
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['Isi file bukan data cadangan DompetKu.'] };
    if (obj.app !== 'DompetKu') return { ok: false, errors: ['File ini bukan cadangan DompetKu (penanda "app" tidak cocok).'] };
    if (obj.format !== 1) return { ok: false, errors: ['Versi format cadangan tidak dikenal: ' + String(obj.format) + '.'] };
    if (!Array.isArray(obj.accounts) || !Array.isArray(obj.transactions)) return { ok: false, errors: ['Daftar akun atau transaksi tidak ditemukan.'] };
    const accounts = obj.accounts.map((a) => makeAccount(a || {}));
    const seenA = new Set();
    accounts.forEach((a, i) => {
      validateAccount(a).forEach((m) => fail('Akun #' + (i + 1) + ': ' + m));
      if (seenA.has(a.id)) fail('Akun #' + (i + 1) + ': ID ganda di dalam file.');
      seenA.add(a.id);
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const txs = obj.transactions.map((t) => makeTransaction(t || {}));
    const seenT = new Set();
    txs.forEach((t, i) => {
      validateTransaction(t, byId).forEach((m) => fail('Transaksi #' + (i + 1) + ': ' + m));
      if (seenT.has(t.id)) fail('Transaksi #' + (i + 1) + ': ID ganda di dalam file.');
      seenT.add(t.id);
    });
    return { ok: errors.length === 0, errors, accounts, transactions: txs };
  }
  /** Rencana penggabungan: ID yang sudah ada tidak ditimpa. */
  function planMerge(curAccounts, curTxs, data) {
    const accIds = new Map(curAccounts.map((a) => [a.id, a]));
    const txIds = new Set(curTxs.map((t) => t.id));
    const plan = { newAccounts: [], newTxs: [], dupAccounts: 0, conflictAccounts: 0, dupTxs: 0, rejectedTxs: 0 };
    const merged = new Map(accIds);
    data.accounts.forEach((a) => {
      const ex = accIds.get(a.id);
      if (!ex) { plan.newAccounts.push(a); merged.set(a.id, a); return; }
      plan.dupAccounts++;
      if (ex.currency !== a.currency || ex.type !== a.type) plan.conflictAccounts++;
    });
    data.transactions.forEach((t) => {
      if (txIds.has(t.id)) { plan.dupTxs++; return; }
      if (validateTransaction(t, merged).length) { plan.rejectedTxs++; return; }
      plan.newTxs.push(t);
    });
    return plan;
  }

  DK.ledger = {
    CASH_ID, CURRENCIES, ACCOUNT_TYPES, PROVIDERS, INCOME_CATEGORIES, EXPENSE_CATEGORIES, FEE_CATEGORY,
    newId, todayLocal, isValidDate, addDays, formatDate, formatMoney, formatCompact, parseMoney,
    makeAccount, makeTransaction, defaultCash, validateAccount, validateTransaction,
    deltaFor, computeBalances, flowsOf, summarize, periodRange, sortAccounts, sortTransactions,
    buildBackup, validateBackup, planMerge, colorFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
