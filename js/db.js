/*
 * DompetKu v2 — db.js
 * Lapisan IndexedDB. Skema ada di komentar atas js/ledger.js.
 *
 * Prinsip:
 *  - Setiap record yang disimpan WAJIB punya `id` string yang valid (keyPath "id"); id dibuat oleh
 *    ledger.makeAccount / makeTransaction dan dicek ulang sebelum put() -> error keyPath mustahil lolos.
 *  - Setiap operasi tulis = SATU transaksi IndexedDB. Validasi (mis. akun ada) dilakukan di dalam
 *    transaksi yang sama; kalau gagal, transaksi dibatalkan (abort) dan tidak ada data yang berubah.
 *  - Database tidak pernah dihapus/di-reset otomatis. Tidak ada deleteDatabase di kode ini.
 *  - Semua error dibungkus DKError dengan pesan bahasa Indonesia.
 */
(function (global) {
  'use strict';
  const DK = (global.DK = global.DK || {});
  const L = DK.ledger;
  const DB_NAME = 'dompetku-v2';
  const DB_VERSION = 1;

  class DKError extends Error {
    constructor(message, cause) { super(message); this.name = 'DKError'; this.cause = cause; }
  }
  const wrap = (e, fallback) => (e instanceof DKError ? e : new DKError(fallback + (e && e.message ? ' (' + e.message + ')' : ''), e));

  let dbPromise = null;

  function openRaw() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new DKError('Browser ini tidak mendukung penyimpanan lokal (IndexedDB). Coba Chrome terbaru, dan jangan pakai mode samaran.'));
      let req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(wrap(e, 'Gagal membuka database')); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('accounts')) db.createObjectStore('accounts', { keyPath: 'id' }).createIndex('byType', 'type');
        if (!db.objectStoreNames.contains('transactions')) db.createObjectStore('transactions', { keyPath: 'id' }).createIndex('byDate', 'date');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(wrap(req.error, 'Gagal membuka database'));
      req.onblocked = () => reject(new DKError('Database sedang dipakai tab lain. Tutup tab DompetKu yang lain lalu muat ulang.'));
    });
  }

  /** Pastikan tepat satu akun Cash (id tetap) — dicek & ditulis dalam satu transaksi. */
  function ensureCash(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['accounts'], 'readwrite');
      const st = tx.objectStore('accounts');
      st.get(L.CASH_ID).onsuccess = (e) => { if (!e.target.result) st.put(L.defaultCash(0)); };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(wrap(tx.error, 'Gagal menyiapkan akun Cash'));
    });
  }

  function open() {
    if (!dbPromise) {
      dbPromise = openRaw().then((db) => ensureCash(db).then(() => db)).catch((e) => { dbPromise = null; throw e; });
    }
    return dbPromise;
  }

  /**
   * Jalankan satu transaksi. work(tx, done, fail): lakukan operasi dengan callback request,
   * panggil done(hasil) untuk mengembalikan nilai, atau fail(error) untuk membatalkan semuanya.
   * Jangan `await` hal lain di dalam work() — transaksi IndexedDB akan tertutup otomatis.
   */
  function runTx(stores, mode, work, failMsg) {
    return open().then((db) => new Promise((resolve, reject) => {
      let tx, result, failure = null;
      try { tx = db.transaction(stores, mode); } catch (e) { return reject(wrap(e, 'Gagal memulai transaksi database')); }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || wrap(tx.error, failMsg));
      tx.onerror = () => { /* onabort menyusul */ };
      const done = (v) => { result = v; };
      const fail = (e) => { failure = wrap(e, failMsg); try { tx.abort(); } catch (_) { /* sudah selesai */ } };
      try { work(tx, done, fail); } catch (e) { fail(e); }
    }));
  }

  function assertKey(rec, what) {
    if (!rec || typeof rec.id !== 'string' || rec.id.length === 0) throw new DKError('Data ' + what + ' tidak punya ID yang valid, penyimpanan dibatalkan.');
  }

  /* ===== baca ===== */
  /** Snapshot konsisten akun + transaksi dalam satu transaksi baca. */
  function loadAll() {
    return runTx(['accounts', 'transactions'], 'readonly', (tx, done) => {
      let accounts = null, txs = null;
      const finish = () => { if (accounts && txs) done({ accounts, transactions: txs }); };
      tx.objectStore('accounts').getAll().onsuccess = (e) => { accounts = e.target.result; finish(); };
      tx.objectStore('transactions').getAll().onsuccess = (e) => { txs = e.target.result; finish(); };
    }, 'Gagal membaca data');
  }

  /* ===== akun ===== */
  function saveAccount(acc) {
    return runTx(['accounts', 'transactions'], 'readwrite', (tx, done, fail) => {
      assertKey(acc, 'akun');
      const errs = L.validateAccount(acc);
      if (errs.length) return fail(new DKError(errs[0]));
      const accounts = tx.objectStore('accounts'), txs = tx.objectStore('transactions');
      accounts.get(acc.id).onsuccess = (e) => {
        const existing = e.target.result;
        const write = () => { accounts.put(acc); done(acc); };
        if (existing && existing.currency !== acc.currency) {
          txs.getAll().onsuccess = (ev) => {
            const used = ev.target.result.some((t) => t.accountId === acc.id || t.fromId === acc.id || t.toId === acc.id);
            if (used) fail(new DKError('Mata uang akun tidak bisa diubah karena sudah punya transaksi.'));
            else write();
          };
        } else write();
      };
    }, 'Gagal menyimpan akun');
  }

  /* ===== transaksi ===== */
  /** Simpan (tambah/edit) transaksi: akun terkait dibaca & divalidasi di transaksi yang sama. */
  function saveTransaction(t) {
    return runTx(['accounts', 'transactions'], 'readwrite', (tx, done, fail) => {
      assertKey(t, 'transaksi');
      const ids = t.type === 'transfer' ? [t.fromId, t.toId] : [t.accountId];
      const byId = new Map();
      let pending = ids.length;
      const accounts = tx.objectStore('accounts');
      ids.forEach((id) => {
        const req = typeof id === 'string' ? accounts.get(id) : null;
        const got = (rec) => {
          if (rec) byId.set(rec.id, rec);
          if (--pending > 0) return;
          const errs = L.validateTransaction(t, byId);
          if (errs.length) return fail(new DKError(errs[0]));
          tx.objectStore('transactions').put(t);
          done(t);
        };
        if (req) req.onsuccess = () => got(req.result); else got(null);
      });
    }, 'Gagal menyimpan transaksi');
  }

  function deleteTransaction(id) {
    return runTx(['transactions'], 'readwrite', (tx, done, fail) => {
      if (typeof id !== 'string' || !id) return fail(new DKError('ID transaksi tidak valid.'));
      tx.objectStore('transactions').delete(id);
      done(true);
    }, 'Gagal menghapus transaksi');
  }

  /* ===== backup ===== */
  function exportAll() {
    return loadAll().then((d) => L.buildBackup(L.sortAccounts(d.accounts), L.sortTransactions(d.transactions)));
  }

  /** Ganti SEMUA data dengan isi backup yang sudah divalidasi. Atomik: gagal = data lama utuh. */
  function importReplace(data) {
    return runTx(['accounts', 'transactions'], 'readwrite', (tx, done) => {
      const accounts = tx.objectStore('accounts'), txs = tx.objectStore('transactions');
      accounts.clear(); txs.clear();
      const list = data.accounts.slice();
      if (!list.some((a) => a.id === L.CASH_ID)) list.push(L.defaultCash(0));
      list.forEach((a) => { assertKey(a, 'akun'); accounts.put(a); });
      data.transactions.forEach((t) => { assertKey(t, 'transaksi'); txs.put(t); });
      done({ accounts: list.length, transactions: data.transactions.length });
    }, 'Gagal mengganti data dari cadangan');
  }

  /** Gabungkan backup ke data sekarang; ID yang sudah ada tidak ditimpa. */
  function importMerge(data) {
    return runTx(['accounts', 'transactions'], 'readwrite', (tx, done) => {
      const accounts = tx.objectStore('accounts'), txs = tx.objectStore('transactions');
      let cur = null, curT = null;
      const go = () => {
        if (!cur || !curT) return;
        const plan = L.planMerge(cur, curT, data);
        plan.newAccounts.forEach((a) => { assertKey(a, 'akun'); accounts.put(a); });
        plan.newTxs.forEach((t) => { assertKey(t, 'transaksi'); txs.put(t); });
        done(plan);
      };
      accounts.getAll().onsuccess = (e) => { cur = e.target.result; go(); };
      txs.getAll().onsuccess = (e) => { curT = e.target.result; go(); };
    }, 'Gagal menggabungkan data dari cadangan');
  }

  DK.db = { DKError, open, loadAll, saveAccount, saveTransaction, deleteTransaction, exportAll, importReplace, importMerge, DB_NAME };
})(window);
