/*
 * DompetKu v2 — app.js
 * UI. Semua data dibaca dari IndexedDB lewat refresh(); setiap perubahan (akun/transaksi/impor)
 * diakhiri refresh() sehingga daftar akun di semua form selalu dari database, tanpa muat ulang halaman.
 */
(function () {
  'use strict';
  const L = DK.ledger, DB = DK.db;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = L.formatMoney;

  const state = {
    accounts: [], txs: [], balances: new Map(), screen: 'home',
    editing: { income: null, expense: null, transfer: null },
    showArchived: false, swReady: false, pendingImport: null,
    recap: { period: 'month', from: '', to: '', account: '', currency: 'IDR' },
  };
  const accById = (id) => state.accounts.find((a) => a.id === id) || null;
  const activeAccounts = () => state.accounts.filter((a) => !a.archived);

  /* ---------- util UI ---------- */
  let toastTimer = 0;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg; el.className = isErr ? 'err' : ''; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 6000 : 3500);
  }
  function errMsg(e) { return e && e.message ? e.message : 'Terjadi kesalahan yang tidak dikenal.'; }
  function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }
  function colorOf(text) {
    let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return 'hsl(' + h + ' 42% 38%)';
  }
  function mono(a) { return '<span class="mono" style="background:' + (a.type === 'cash' ? '#2F7D5B' : colorOf(a.provider)) + '">' + esc(a.type === 'cash' ? 'Rp' : a.provider.replace(/[^A-Za-z0-9]/g, '').slice(0, 2)) + '</span>'; }
  const symOf = (cur) => L.CURRENCIES[cur].symbol;
  function accLabel(a) { return a.name + ' · ' + fmt(state.balances.get(a.id) || 0, a.currency) + (a.archived ? ' (arsip)' : ''); }
  function openDialog(d) { if (!d.open) d.showModal(); }
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  function confirmDialog(title, message, okLabel) {
    return new Promise((resolve) => {
      const d = $('#dlg-confirm');
      $('#confirm-title').textContent = title; $('#confirm-msg').textContent = message; $('#confirm-ok').textContent = okLabel || 'Lanjut';
      let result = false;
      const ok = () => { result = true; d.close(); };
      const cancel = () => d.close();
      const onClose = () => { $('#confirm-ok').removeEventListener('click', ok); $('#confirm-cancel').removeEventListener('click', cancel); d.removeEventListener('close', onClose); resolve(result); };
      $('#confirm-ok').addEventListener('click', ok); $('#confirm-cancel').addEventListener('click', cancel); d.addEventListener('close', onClose);
      openDialog(d);
    });
  }

  /* ---------- input nominal ---------- */
  function liveFormat(input, cur) {
    if (cur !== 'IDR') return;
    const digits = input.value.replace(/\D/g, '');
    input.value = digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';
  }
  function bindMoney(input, getCur, onChange) {
    input.addEventListener('input', () => { liveFormat(input, getCur()); if (onChange) onChange(); });
  }

  /* ---------- muat data ---------- */
  async function refresh() {
    const d = await DB.loadAll();
    state.accounts = L.sortAccounts(d.accounts);
    state.txs = L.sortTransactions(d.transactions);
    state.balances = L.computeBalances(state.accounts, state.txs);
    // jika transaksi yang sedang diedit sudah tidak ada, batalkan mode edit
    ['income', 'expense', 'transfer'].forEach((k) => { const e = state.editing[k]; if (e && !state.txs.some((t) => t.id === e.id)) state.editing[k] = null; });
    renderAll();
  }
  function renderAll() { renderHome(); renderFlowSelects(); renderTransferSelects(); renderLists(); renderRecap(); syncEditUI(); }

  /* ---------- navigasi ---------- */
  function showScreen(name) {
    state.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 'screen-' + name));
    $$('.tabbar button').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
    window.scrollTo(0, 0);
    if (name === 'recap') renderRecap();
  }
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.nav)));

  /* =====================================================================
   * BERANDA
   * ===================================================================== */
  function renderHome() {
    const act = activeAccounts();
    const currencies = Object.keys(L.CURRENCIES).filter((c) => act.some((a) => a.currency === c));
    const range = L.periodRange('month', L.todayLocal());
    let html = '';
    currencies.forEach((cur, i) => {
      const total = act.filter((a) => a.currency === cur).reduce((s, a) => s + (state.balances.get(a.id) || 0), 0);
      const sm = L.summarize(state.accounts, state.txs, { currency: cur, from: range.from, to: range.to, accountId: '' });
      html += '<div class="cur-block"><div class="lbl">Total saldo' + (currencies.length > 1 ? ' ' + cur : '') + '</div>'
        + '<div class="total' + (i > 0 ? ' secondary' : '') + '" data-total="' + cur + '">' + fmt(total, cur) + '</div>'
        + '<div class="month"><span class="in">Masuk bulan ini ' + fmt(sm.income, cur) + '</span><span class="out">Keluar ' + fmt(sm.expense, cur) + '</span></div></div>';
    });
    $('#purse').innerHTML = html;

    const groups = [['cash', 'Cash'], ['ewallet', 'E-Wallet'], ['bank', 'Bank'], ['other', 'Lainnya']];
    let list = '';
    groups.forEach(([type, title]) => {
      const items = act.filter((a) => a.type === type);
      if (!items.length) return;
      list += '<div class="group-title">' + title + '</div>' + items.map(acctRow).join('');
    });
    if (act.every((a) => a.type === 'cash')) {
      list += '<div class="empty"><p>Belum ada akun E-Wallet atau Bank. Tambahkan GoPay, DANA, rekening bank, dan lainnya satu per satu.</p>'
        + '<button class="btn btn-amber" type="button" data-open-add-account><svg class="ic"><use href="#i-plus"/></svg>Tambah akun</button></div>';
    }
    $('#account-list').innerHTML = list;

    const arch = state.accounts.filter((a) => a.archived);
    let aw = '';
    if (arch.length) {
      aw = '<button class="link-btn" type="button" id="toggle-archived">' + (state.showArchived ? 'Sembunyikan' : 'Tampilkan') + ' akun arsip (' + arch.length + ')</button>';
      if (state.showArchived) aw += arch.map(acctRow).join('');
    }
    $('#archived-wrap').innerHTML = aw;
  }
  function acctRow(a) {
    const bal = state.balances.get(a.id) || 0;
    const sub = a.type === 'cash' ? 'Uang tunai' : a.provider + (a.currency !== 'IDR' ? ' · ' + a.currency : '');
    return '<button class="acct' + (a.archived ? ' is-archived' : '') + '" type="button" data-acct="' + esc(a.id) + '">' + mono(a)
      + '<span class="meta"><span class="acct-name">' + esc(a.name) + '</span><span class="acct-sub">' + esc(sub) + '</span></span>'
      + '<span class="acct-balance' + (bal < 0 ? ' neg' : '') + '">' + fmt(bal, a.currency) + '</span></button>';
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-acct]');
    if (t) return openDetail(t.dataset.acct);
    if (e.target.closest('[data-open-add-account]')) return openAccountDialog(null);
    if (e.target.closest('#toggle-archived')) { state.showArchived = !state.showArchived; renderHome(); }
  });
  $('#btn-add-account').addEventListener('click', () => openAccountDialog(null));

  /* ---------- detail akun ---------- */
  function openDetail(id) {
    const a = accById(id); if (!a) return;
    const bal = state.balances.get(a.id) || 0;
    const related = state.txs.filter((t) => L.deltaFor(t, a.id) !== 0 || t.accountId === a.id || t.fromId === a.id || t.toId === a.id).slice(0, 30);
    const rows = related.map((t) => {
      const d = L.deltaFor(t, a.id);
      return '<div class="r"><div>' + esc(txTitle(t, a.id)) + '<small>' + L.formatDate(t.date) + (t.type === 'transfer' && t.fromId === a.id && t.feeMinor ? ' · termasuk biaya admin ' + fmt(t.feeMinor, a.currency) : '') + '</small></div>'
        + '<div class="' + (d >= 0 ? 'pos' : 'neg') + '">' + (d >= 0 ? '+' : '') + fmt(d, a.currency) + '</div></div>';
    }).join('');
    $('#detail-body').innerHTML = '<div class="detail-head">' + mono(a) + '<div><h2 id="det-title" style="margin:0">' + esc(a.name) + '</h2>'
      + '<div class="detail-meta" style="margin:0">' + esc(a.type === 'cash' ? 'Uang tunai' : L.ACCOUNT_TYPES[a.type] + ' · ' + a.provider) + ' · ' + a.currency + (a.archived ? ' · diarsipkan' : '') + '</div></div></div>'
      + '<div class="detail-bal" id="detail-balance">' + fmt(bal, a.currency) + '</div>'
      + '<div class="detail-meta">Saldo awal ' + fmt(a.openingMinor, a.currency) + ' (bukan pemasukan)</div>'
      + '<div class="btn-row"><button class="btn btn-line" type="button" id="det-edit"><svg class="ic"><use href="#i-edit"/></svg>Edit</button>'
      + (a.type === 'cash' ? '' : '<button class="btn btn-line" type="button" id="det-archive"><svg class="ic"><use href="#i-archive"/></svg>' + (a.archived ? 'Aktifkan' : 'Arsipkan') + '</button>')
      + '<button class="btn btn-ink" type="button" id="det-close">Tutup</button></div>'
      + '<div class="detail-list">' + (rows || '<p class="muted" style="padding-top:8px">Belum ada transaksi di akun ini.</p>') + '</div>';
    $('#det-close').onclick = () => $('#dlg-detail').close();
    $('#det-edit').onclick = () => { $('#dlg-detail').close(); openAccountDialog(a); };
    const ar = $('#det-archive');
    if (ar) ar.onclick = async () => {
      if (!a.archived) {
        const warn = bal !== 0 ? ' Saldo ' + fmt(bal, a.currency) + ' tidak akan dihitung ke total saldo selama akun diarsipkan.' : '';
        const ok = await confirmDialog('Arsipkan ' + a.name + '?', 'Akun tidak muncul lagi di form transaksi, tetapi riwayat tetap tersimpan dan bisa diaktifkan kembali.' + warn, 'Arsipkan');
        if (!ok) return;
      }
      try { await DB.saveAccount(L.makeAccount(Object.assign({}, a, { archived: !a.archived }))); $('#dlg-detail').close(); await refresh(); toast(a.archived ? 'Akun diaktifkan kembali.' : 'Akun diarsipkan.'); }
      catch (e) { toast(errMsg(e), true); }
    };
    openDialog($('#dlg-detail'));
  }
  function txTitle(t, forAcc) {
    if (t.type === 'transfer') {
      const f = accById(t.fromId), to = accById(t.toId);
      return forAcc ? (t.fromId === forAcc ? 'Transfer ke ' + (to ? to.name : '?') : 'Transfer dari ' + (f ? f.name : '?')) : (f ? f.name : '?') + ' → ' + (to ? to.name : '?');
    }
    return t.category + (t.note ? ' — ' + t.note : '');
  }

  /* =====================================================================
   * DIALOG AKUN (tambah / edit; saldo awal diisi di form yang sama)
   * ===================================================================== */
  const accForm = $('#form-account');
  let accEditing = null;
  let accNameTouched = false;
  const accType = () => (($$('input[name=acc-type]').find((r) => r.checked)) || {}).value || 'ewallet';

  function fillProviders() {
    const type = accType(), sel = $('#acc-provider');
    const keep = sel.value;
    sel.innerHTML = L.PROVIDERS[type].map((p) => '<option>' + esc(p) + '</option>').join('') + '<option value="__other">Lainnya (isi sendiri)</option>';
    if (L.PROVIDERS[type].length === 0) sel.value = '__other';
    else if (keep && Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
    syncProviderUI();
  }
  function providerValue() { return $('#acc-provider').value === '__other' ? $('#acc-provider-other').value.trim() : $('#acc-provider').value; }
  function syncProviderUI() {
    const other = $('#acc-provider').value === '__other';
    $('#acc-provider-other-wrap').hidden = !other;
    if (!accNameTouched && !accEditing) $('#acc-name').value = providerValue();
  }
  function syncAccCurrency() {
    const cur = $('#acc-currency').value;
    $('#acc-cur-sym').textContent = symOf(cur);
    liveFormat($('#acc-opening'), cur);
  }
  function openAccountDialog(acc) {
    accEditing = acc; accNameTouched = !!acc;
    showError($('#acc-error'), '');
    const isCash = acc && acc.type === 'cash';
    $('#acc-title').textContent = acc ? (isCash ? 'Atur saldo awal Cash' : 'Edit akun') : 'Tambah akun';
    $('#acc-type-wrap').hidden = !!acc;
    $('#acc-detail-fields').hidden = isCash;
    $('#acc-opening-label').textContent = 'Saldo awal';
    $('#acc-save').textContent = 'Simpan';
    if (acc && !isCash) {
      $('#acc-type-wrap').hidden = false;
      $$('input[name=acc-type]').forEach((r) => { r.checked = r.value === acc.type; });
    } else if (!acc) {
      $('#acc-type-ewallet').checked = true;
    }
    fillProviders();
    if (acc && !isCash) {
      const sel = $('#acc-provider');
      if (Array.from(sel.options).some((o) => o.value === acc.provider)) { sel.value = acc.provider; $('#acc-provider-other').value = ''; }
      else { sel.value = '__other'; $('#acc-provider-other').value = acc.provider; }
      syncProviderUI();
      $('#acc-name').value = acc.name;
      $('#acc-currency').value = acc.currency;
    } else if (!acc) {
      $('#acc-provider-other').value = ''; $('#acc-name').value = ''; $('#acc-currency').value = 'IDR';
      syncProviderUI();
    }
    // mata uang dikunci jika akun sudah punya transaksi
    const used = acc && state.txs.some((t) => t.accountId === acc.id || t.fromId === acc.id || t.toId === acc.id);
    $('#acc-currency').disabled = !!used;
    syncAccCurrency();
    const cur = acc ? acc.currency : 'IDR';
    const open = acc ? acc.openingMinor : 0;
    const dec = L.CURRENCIES[cur].decimals;
    $('#acc-opening').value = acc && open ? (dec ? (open / Math.pow(10, dec)).toFixed(dec).replace('.', ',') : String(open).replace(/\B(?=(\d{3})+(?!\d))/g, '.')) : '';
    openDialog($('#dlg-account'));
    setTimeout(() => { try { (isCash ? $('#acc-opening') : $('#acc-name')).focus(); } catch (_) { /* abaikan */ } }, 50);
  }
  $$('input[name=acc-type]').forEach((r) => r.addEventListener('change', () => { fillProviders(); }));
  $('#acc-provider').addEventListener('change', syncProviderUI);
  $('#acc-provider-other').addEventListener('input', () => { if (!accNameTouched && !accEditing) $('#acc-name').value = providerValue(); });
  $('#acc-name').addEventListener('input', () => { accNameTouched = true; });
  $('#acc-currency').addEventListener('change', syncAccCurrency);
  bindMoney($('#acc-opening'), () => $('#acc-currency').value);
  $('#acc-cancel').addEventListener('click', () => $('#dlg-account').close());

  accForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#acc-save'), errEl = $('#acc-error');
    if (btn.disabled) return;
    showError(errEl, '');
    const isCash = accEditing && accEditing.type === 'cash';
    const cur = isCash ? 'IDR' : $('#acc-currency').value;
    const op = L.parseMoney($('#acc-opening').value, cur, { allowZero: true });
    if (op.error) return showError(errEl, 'Saldo awal: ' + op.error);
    let acc;
    if (isCash) {
      acc = L.makeAccount(Object.assign({}, accEditing, { openingMinor: op.value }));
    } else {
      const provider = providerValue(), name = $('#acc-name').value.trim();
      if (!provider) return showError(errEl, 'Nama penyedia wajib diisi.');
      if (!name) return showError(errEl, 'Nama panggilan akun wajib diisi.');
      if (state.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase() && (!accEditing || a.id !== accEditing.id))) return showError(errEl, 'Sudah ada akun bernama "' + name + '". Gunakan nama panggilan lain agar mudah dibedakan.');
      const base = accEditing ? Object.assign({}, accEditing) : {};
      acc = L.makeAccount(Object.assign(base, { type: accType(), provider, name, currency: cur, openingMinor: op.value, archived: accEditing ? accEditing.archived : false }));
    }
    btn.disabled = true;
    try {
      await DB.saveAccount(acc);
      $('#dlg-account').close();
      await refresh();
      toast((accEditing ? 'Akun diperbarui: ' : 'Akun tersimpan: ') + acc.name + ' · ' + fmt(acc.openingMinor, acc.currency));
    } catch (err) { showError(errEl, errMsg(err)); }
    finally { btn.disabled = false; }
  });

  /* =====================================================================
   * FORM PEMASUKAN & PENGELUARAN
   * ===================================================================== */
  function flowFormHTML(kind) {
    const isIn = kind === 'income';
    const cats = isIn ? L.INCOME_CATEGORIES : L.EXPENSE_CATEGORIES;
    return '<div class="edit-banner" id="' + kind + '-banner" hidden></div>'
      + '<label class="field"><span>Nominal</span><div class="money"><b id="' + kind + '-sym">Rp</b><input id="' + kind + '-amount" inputmode="decimal" autocomplete="off" placeholder="0"></div></label>'
      + '<label class="field"><span>' + (isIn ? 'Kategori / sumber pemasukan' : 'Kategori pengeluaran') + '</span><select id="' + kind + '-category">' + cats.map((c) => '<option>' + esc(c) + '</option>').join('') + '</select></label>'
      + '<label class="field"><span>' + (isIn ? 'Akun tujuan' : 'Akun sumber') + '</span><select id="' + kind + '-account"></select></label>'
      + '<label class="field"><span>Tanggal</span><input type="date" id="' + kind + '-date"></label>'
      + '<label class="field"><span>Catatan (opsional)</span><input type="text" id="' + kind + '-note" maxlength="200" autocomplete="off" placeholder="mis. makan siang"></label>'
      + '<div class="preview" id="' + kind + '-preview" hidden></div>'
      + '<p class="form-error" id="' + kind + '-error" role="alert" hidden></p>'
      + '<div class="btn-row"><button type="button" class="btn btn-line" id="' + kind + '-cancel" hidden>Batal</button>'
      + '<button type="button" class="btn btn-danger" id="' + kind + '-delete" hidden><svg class="ic"><use href="#i-trash"/></svg>Hapus</button>'
      + '<button type="submit" class="btn btn-ink" id="' + kind + '-save">' + (isIn ? 'Simpan pemasukan' : 'Simpan pengeluaran') + '</button></div>';
  }

  function balancesWithout(excludeId) { return L.computeBalances(state.accounts, state.txs.filter((t) => t.id !== excludeId)); }

  function fillAccountSelect(sel, includeIds, keepValue) {
    const items = state.accounts.filter((a) => !a.archived || includeIds.indexOf(a.id) !== -1);
    const prev = keepValue !== undefined ? keepValue : sel.value;
    sel.innerHTML = items.map((a) => '<option value="' + esc(a.id) + '">' + esc(accLabel(a)) + '</option>').join('');
    if (prev && items.some((a) => a.id === prev)) sel.value = prev;
    else if (items.length) sel.value = items[0].id;
  }

  function renderFlowSelects() {
    ['income', 'expense'].forEach((kind) => {
      const ed = state.editing[kind];
      fillAccountSelect($('#' + kind + '-account'), ed ? [ed.accountId] : []);
      updateFlowCurrency(kind); updateFlowPreview(kind);
    });
  }
  function flowCur(kind) { const a = accById($('#' + kind + '-account').value); return a ? a.currency : 'IDR'; }
  function updateFlowCurrency(kind) {
    const cur = flowCur(kind);
    $('#' + kind + '-sym').textContent = symOf(cur);
    liveFormat($('#' + kind + '-amount'), cur);
  }
  function updateFlowPreview(kind) {
    const el = $('#' + kind + '-preview'), acc = accById($('#' + kind + '-account').value);
    if (!acc) { el.hidden = true; return; }
    const ed = state.editing[kind];
    const base = (ed ? balancesWithout(ed.id) : state.balances).get(acc.id) || 0;
    const p = L.parseMoney($('#' + kind + '-amount').value, acc.currency);
    el.hidden = false;
    if (p.error) { el.className = 'preview'; el.textContent = 'Saldo ' + acc.name + ': ' + fmt(base, acc.currency); return; }
    const after = base + (kind === 'income' ? p.value : -p.value);
    el.className = 'preview' + (after < 0 ? ' warn' : '');
    el.textContent = 'Saldo ' + acc.name + ': ' + fmt(base, acc.currency) + ' → ' + fmt(after, acc.currency) + (after < 0 ? ' (saldo akan negatif)' : '');
  }

  function setupFlowForm(kind) {
    const form = $('#form-' + kind);
    form.classList.add('is-' + kind);
    form.innerHTML = flowFormHTML(kind);
    $('#' + kind + '-date').value = L.todayLocal();
    bindMoney($('#' + kind + '-amount'), () => flowCur(kind), () => updateFlowPreview(kind));
    $('#' + kind + '-account').addEventListener('change', () => { updateFlowCurrency(kind); updateFlowPreview(kind); });
    $('#' + kind + '-cancel').addEventListener('click', () => { state.editing[kind] = null; resetFlowForm(kind); syncEditUI(); renderLists(); });
    $('#' + kind + '-delete').addEventListener('click', () => deleteEditing(kind));
    form.addEventListener('submit', (e) => { e.preventDefault(); submitFlow(kind); });
  }
  function resetFlowForm(kind) {
    $('#' + kind + '-amount').value = ''; $('#' + kind + '-note').value = ''; $('#' + kind + '-date').value = L.todayLocal();
    showError($('#' + kind + '-error'), '');
    renderFlowSelects();
  }

  async function submitFlow(kind) {
    const btn = $('#' + kind + '-save'), errEl = $('#' + kind + '-error');
    if (btn.disabled) return;
    showError(errEl, '');
    const acc = accById($('#' + kind + '-account').value);
    if (!acc) return showError(errEl, 'Pilih akun terlebih dahulu. Belum ada akun? Tambahkan di Beranda.');
    const p = L.parseMoney($('#' + kind + '-amount').value, acc.currency);
    if (p.error) return showError(errEl, p.error);
    const date = $('#' + kind + '-date').value;
    if (!L.isValidDate(date)) return showError(errEl, 'Tanggal tidak valid.');
    const ed = state.editing[kind];
    const tx = L.makeTransaction({
      id: ed ? ed.id : undefined, createdAt: ed ? ed.createdAt : undefined, updatedAt: Date.now(),
      type: kind, date, accountId: acc.id, category: $('#' + kind + '-category').value, note: $('#' + kind + '-note').value, amountMinor: p.value,
    });
    btn.disabled = true;
    try {
      await DB.saveTransaction(tx);
      const wasEdit = !!ed;
      state.editing[kind] = null;
      $('#' + kind + '-amount').value = ''; $('#' + kind + '-note').value = ''; $('#' + kind + '-date').value = L.todayLocal();
      await refresh();
      const nb = state.balances.get(acc.id) || 0;
      toast((wasEdit ? 'Perubahan disimpan. ' : (kind === 'income' ? 'Pemasukan ' : 'Pengeluaran ') + fmt(tx.amountMinor, acc.currency) + ' tersimpan. ') + acc.name + ' sekarang ' + fmt(nb, acc.currency));
    } catch (e) { showError(errEl, errMsg(e)); }
    finally { btn.disabled = false; }
  }

  /* =====================================================================
   * FORM TRANSFER
   * ===================================================================== */
  function setupTransferForm() {
    const form = $('#form-transfer');
    form.classList.add('is-transfer');
    form.innerHTML = '<div class="edit-banner" id="transfer-banner" hidden></div>'
      + '<label class="field"><span>Akun asal</span><select id="transfer-from"></select></label>'
      + '<label class="field"><span>Akun tujuan</span><select id="transfer-to"></select></label>'
      + '<label class="field"><span>Nominal transfer</span><div class="money"><b id="transfer-sym">Rp</b><input id="transfer-amount" inputmode="decimal" autocomplete="off" placeholder="0"></div></label>'
      + '<label class="field" id="transfer-receive-wrap" hidden><span>Nominal diterima di akun tujuan</span><div class="money"><b id="transfer-rsym">US$</b><input id="transfer-receive" inputmode="decimal" autocomplete="off" placeholder="0"></div></label>'
      + '<p class="preview" id="transfer-rate" hidden></p>'
      + '<label class="field"><span>Biaya admin (opsional)</span><div class="money"><b id="transfer-fsym">Rp</b><input id="transfer-fee" inputmode="decimal" autocomplete="off" placeholder="0"></div></label>'
      + '<label class="field"><span>Tanggal</span><input type="date" id="transfer-date"></label>'
      + '<label class="field"><span>Catatan (opsional)</span><input type="text" id="transfer-note" maxlength="200" autocomplete="off"></label>'
      + '<div class="preview" id="transfer-preview" hidden></div>'
      + '<p class="form-error" id="transfer-error" role="alert" hidden></p>'
      + '<div class="btn-row"><button type="button" class="btn btn-line" id="transfer-cancel" hidden>Batal</button>'
      + '<button type="button" class="btn btn-danger" id="transfer-delete" hidden><svg class="ic"><use href="#i-trash"/></svg>Hapus</button>'
      + '<button type="submit" class="btn btn-ink" id="transfer-save">Simpan transfer</button></div>';
    $('#transfer-date').value = L.todayLocal();
    const fromCur = () => (accById($('#transfer-from').value) || { currency: 'IDR' }).currency;
    const toCur = () => (accById($('#transfer-to').value) || { currency: 'IDR' }).currency;
    bindMoney($('#transfer-amount'), fromCur, updateTransferUI);
    bindMoney($('#transfer-fee'), fromCur, updateTransferUI);
    bindMoney($('#transfer-receive'), toCur, updateTransferUI);
    $('#transfer-from').addEventListener('change', () => { renderTransferSelects(true); });
    $('#transfer-to').addEventListener('change', updateTransferUI);
    $('#transfer-cancel').addEventListener('click', () => { state.editing.transfer = null; resetTransferForm(); syncEditUI(); renderLists(); });
    $('#transfer-delete').addEventListener('click', () => deleteEditing('transfer'));
    form.addEventListener('submit', (e) => { e.preventDefault(); submitTransfer(); });
  }
  function resetTransferForm() {
    ['amount', 'fee', 'receive', 'note'].forEach((f) => { $('#transfer-' + f).value = ''; });
    $('#transfer-date').value = L.todayLocal();
    showError($('#transfer-error'), '');
    renderTransferSelects();
  }
  /** Isi ulang dropdown dari data aktual. Akun tujuan tidak menampilkan akun asal. */
  function renderTransferSelects(fromChanged) {
    const ed = state.editing.transfer;
    const include = ed ? [ed.fromId, ed.toId] : [];
    const fromSel = $('#transfer-from'), toSel = $('#transfer-to');
    fillAccountSelect(fromSel, include);
    const prevTo = toSel.value;
    const items = state.accounts.filter((a) => (!a.archived || include.indexOf(a.id) !== -1) && a.id !== fromSel.value);
    toSel.innerHTML = items.map((a) => '<option value="' + esc(a.id) + '">' + esc(accLabel(a)) + '</option>').join('');
    if (prevTo && items.some((a) => a.id === prevTo)) toSel.value = prevTo;
    else if (items.length) {
      // untuk akun asal sama mata uang, pilih akun tujuan pertama yang berbeda
      toSel.value = items[0].id;
    }
    const enough = activeAccounts().length >= 2 || !!ed;
    $('#transfer-empty').hidden = enough; $('#form-transfer').hidden = !enough;
    updateTransferUI();
  }
  function updateTransferUI() {
    const from = accById($('#transfer-from').value), to = accById($('#transfer-to').value);
    if (!from || !to) { $('#transfer-preview').hidden = true; return; }
    $('#transfer-sym').textContent = symOf(from.currency);
    $('#transfer-fsym').textContent = symOf(from.currency);
    $('#transfer-rsym').textContent = symOf(to.currency);
    liveFormat($('#transfer-amount'), from.currency); liveFormat($('#transfer-fee'), from.currency); liveFormat($('#transfer-receive'), to.currency);
    const cross = from.currency !== to.currency;
    $('#transfer-receive-wrap').hidden = !cross;
    const amt = L.parseMoney($('#transfer-amount').value, from.currency);
    const fee = L.parseMoney($('#transfer-fee').value, from.currency, { allowZero: true });
    const rec = cross ? L.parseMoney($('#transfer-receive').value, to.currency) : amt;
    const rate = $('#transfer-rate');
    if (cross && !amt.error && !rec.error) {
      const fd = L.CURRENCIES[from.currency].decimals, td = L.CURRENCIES[to.currency].decimals;
      const r = (rec.value / Math.pow(10, td)) / (amt.value / Math.pow(10, fd));
      rate.hidden = false; rate.textContent = 'Kurs: 1 ' + from.currency + ' = ' + r.toLocaleString('id-ID', { maximumFractionDigits: 6 }) + ' ' + to.currency;
    } else rate.hidden = true;
    const ed = state.editing.transfer;
    const base = ed ? balancesWithout(ed.id) : state.balances;
    const pv = $('#transfer-preview');
    if (amt.error || (cross && rec.error)) { pv.hidden = false; pv.className = 'preview'; pv.textContent = from.name + ': ' + fmt(base.get(from.id) || 0, from.currency) + ' · ' + to.name + ': ' + fmt(base.get(to.id) || 0, to.currency); return; }
    const fv = fee.error ? 0 : fee.value;
    const afterFrom = (base.get(from.id) || 0) - amt.value - fv, afterTo = (base.get(to.id) || 0) + rec.value;
    pv.hidden = false; pv.className = 'preview' + (afterFrom < 0 ? ' warn' : '');
    pv.textContent = from.name + ': ' + fmt(base.get(from.id) || 0, from.currency) + ' → ' + fmt(afterFrom, from.currency) + ' · ' + to.name + ': ' + fmt(base.get(to.id) || 0, to.currency) + ' → ' + fmt(afterTo, to.currency) + (afterFrom < 0 ? ' (saldo asal akan negatif)' : '');
  }
  async function submitTransfer() {
    const btn = $('#transfer-save'), errEl = $('#transfer-error');
    if (btn.disabled) return;
    showError(errEl, '');
    const from = accById($('#transfer-from').value), to = accById($('#transfer-to').value);
    if (!from || !to) return showError(errEl, 'Pilih akun asal dan akun tujuan.');
    if (from.id === to.id) return showError(errEl, 'Akun asal dan tujuan tidak boleh sama.');
    const amt = L.parseMoney($('#transfer-amount').value, from.currency);
    if (amt.error) return showError(errEl, amt.error);
    const fee = L.parseMoney($('#transfer-fee').value, from.currency, { allowZero: true });
    if (fee.error) return showError(errEl, 'Biaya admin: ' + fee.error);
    let received = amt.value;
    if (from.currency !== to.currency) {
      const rec = L.parseMoney($('#transfer-receive').value, to.currency);
      if (rec.error) return showError(errEl, 'Nominal diterima: ' + rec.error);
      received = rec.value;
    }
    const date = $('#transfer-date').value;
    if (!L.isValidDate(date)) return showError(errEl, 'Tanggal tidak valid.');
    const ed = state.editing.transfer;
    const tx = L.makeTransaction({
      id: ed ? ed.id : undefined, createdAt: ed ? ed.createdAt : undefined, updatedAt: Date.now(),
      type: 'transfer', date, fromId: from.id, toId: to.id, amountMinor: amt.value, toAmountMinor: received, feeMinor: fee.value, note: $('#transfer-note').value,
    });
    btn.disabled = true;
    try {
      await DB.saveTransaction(tx);
      const wasEdit = !!ed;
      state.editing.transfer = null;
      ['amount', 'fee', 'receive', 'note'].forEach((f) => { $('#transfer-' + f).value = ''; });
      $('#transfer-date').value = L.todayLocal();
      await refresh();
      toast((wasEdit ? 'Perubahan transfer disimpan. ' : 'Transfer ' + fmt(tx.amountMinor, from.currency) + ' tersimpan. ') + from.name + ' ' + fmt(state.balances.get(from.id) || 0, from.currency) + ' · ' + to.name + ' ' + fmt(state.balances.get(to.id) || 0, to.currency));
    } catch (e) { showError(errEl, errMsg(e)); }
    finally { btn.disabled = false; }
  }

  /* ---------- edit & hapus ---------- */
  function startEdit(id) {
    const t = state.txs.find((x) => x.id === id); if (!t) return;
    const kind = t.type;
    state.editing[kind] = t;
    showScreen(kind);
    if (kind === 'transfer') {
      renderTransferSelects();
      $('#transfer-from').value = t.fromId;
      renderTransferSelects();
      $('#transfer-to').value = t.toId;
      const from = accById(t.fromId), to = accById(t.toId);
      const dec = (c) => L.CURRENCIES[c].decimals;
      const show = (v, c) => (dec(c) ? (v / Math.pow(10, dec(c))).toFixed(dec(c)).replace('.', ',') : String(v));
      $('#transfer-amount').value = show(t.amountMinor, from.currency);
      $('#transfer-fee').value = t.feeMinor ? show(t.feeMinor, from.currency) : '';
      $('#transfer-receive').value = from.currency !== to.currency ? show(t.toAmountMinor, to.currency) : '';
      $('#transfer-date').value = t.date; $('#transfer-note').value = t.note;
      showError($('#transfer-error'), '');
      updateTransferUI();
    } else {
      renderFlowSelects();
      $('#' + kind + '-account').value = t.accountId;
      const a = accById(t.accountId), dec = L.CURRENCIES[a.currency].decimals;
      $('#' + kind + '-amount').value = dec ? (t.amountMinor / Math.pow(10, dec)).toFixed(dec).replace('.', ',') : String(t.amountMinor);
      const catSel = $('#' + kind + '-category');
      if (!Array.from(catSel.options).some((o) => o.value === t.category)) catSel.insertAdjacentHTML('beforeend', '<option>' + esc(t.category) + '</option>');
      catSel.value = t.category;
      $('#' + kind + '-date').value = t.date; $('#' + kind + '-note').value = t.note;
      showError($('#' + kind + '-error'), '');
      updateFlowCurrency(kind);
      $('#' + kind + '-amount').value = (a.currency === 'IDR') ? String(t.amountMinor).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : $('#' + kind + '-amount').value;
      updateFlowPreview(kind);
    }
    syncEditUI(); renderLists();
  }
  function syncEditUI() {
    ['income', 'expense', 'transfer'].forEach((kind) => {
      const ed = state.editing[kind];
      const banner = $('#' + kind + '-banner');
      if (!banner) return;
      banner.hidden = !ed;
      if (ed) banner.textContent = 'Mengedit transaksi tanggal ' + L.formatDate(ed.date) + '. Simpan untuk memperbarui saldo.';
      $('#' + kind + '-cancel').hidden = !ed; $('#' + kind + '-delete').hidden = !ed;
      $('#' + kind + '-save').textContent = ed ? 'Simpan perubahan' : (kind === 'income' ? 'Simpan pemasukan' : kind === 'expense' ? 'Simpan pengeluaran' : 'Simpan transfer');
    });
  }
  async function deleteEditing(kind) {
    const ed = state.editing[kind]; if (!ed) return;
    const ok = await confirmDialog('Hapus transaksi ini?', kind === 'transfer' ? 'Transfer beserta biaya adminnya akan dihapus dan saldo kedua akun dikembalikan.' : 'Saldo akun akan dikembalikan seperti sebelum transaksi ini.', 'Hapus');
    if (!ok) return;
    try {
      await DB.deleteTransaction(ed.id);
      state.editing[kind] = null;
      if (kind === 'transfer') resetTransferForm(); else resetFlowForm(kind);
      await refresh();
      toast('Transaksi dihapus. Saldo sudah diperbarui.');
    } catch (e) { toast(errMsg(e), true); }
  }

  /* ---------- daftar transaksi ---------- */
  const ICON = { income: 'i-in', expense: 'i-out', transfer: 'i-swap' };
  function txRow(t, opts) {
    opts = opts || {};
    let title, sub, amt, small = '';
    if (t.type === 'transfer') {
      const f = accById(t.fromId), to = accById(t.toId), cur = f ? f.currency : 'IDR';
      title = (f ? f.name : '?') + ' → ' + (to ? to.name : '?');
      sub = L.formatDate(t.date) + (t.note ? ' · ' + t.note : '');
      amt = fmt(t.amountMinor, cur);
      if (t.feeMinor) small = '+ biaya ' + fmt(t.feeMinor, cur);
    } else {
      const a = accById(t.accountId);
      title = t.category; sub = (a ? a.name : '?') + ' · ' + L.formatDate(t.date) + (t.note ? ' · ' + t.note : '');
      amt = (t.type === 'income' ? '+' : '-') + fmt(t.amountMinor, a ? a.currency : 'IDR');
    }
    const editing = state.editing[t.type] && state.editing[t.type].id === t.id;
    return '<button type="button" class="row ' + t.type + (editing ? ' is-editing' : '') + '" data-tx="' + esc(t.id) + '"><span class="dot"><svg class="ic"><use href="#' + ICON[t.type] + '"/></svg></span>'
      + '<span class="meta"><span class="t">' + esc(title) + '</span><span class="s">' + esc(sub) + '</span></span><span class="amt">' + esc(amt) + (small ? '<small>' + esc(small) + '</small>' : '') + '</span></button>';
  }
  function renderLists() {
    ['income', 'expense', 'transfer'].forEach((kind) => {
      const items = state.txs.filter((t) => t.type === kind).slice(0, 20);
      $('#list-' + kind).innerHTML = items.length ? items.map(txRow).join('') : '<div class="empty"><p>Belum ada ' + (kind === 'income' ? 'pemasukan' : kind === 'expense' ? 'pengeluaran' : 'transfer') + ' yang dicatat.</p></div>';
    });
  }
  document.addEventListener('click', (e) => { const r = e.target.closest('[data-tx]'); if (r) startEdit(r.dataset.tx); });

  /* =====================================================================
   * REKAP
   * ===================================================================== */
  const rc = state.recap;
  function recapRange() { return L.periodRange(rc.period, L.todayLocal(), { from: rc.from, to: rc.to }); }
  function renderRecap() {
    // pilihan akun
    const accSel = $('#recap-account');
    accSel.innerHTML = '<option value="">Semua akun</option>' + state.accounts.map((a) => '<option value="' + esc(a.id) + '">' + esc(a.name + (a.archived ? ' (arsip)' : '')) + '</option>').join('');
    if (rc.account && !accById(rc.account)) rc.account = '';
    accSel.value = rc.account;
    // mata uang
    const curs = Object.keys(L.CURRENCIES).filter((c) => state.accounts.some((a) => a.currency === c));
    const pinned = rc.account ? accById(rc.account) : null;
    if (pinned) rc.currency = pinned.currency;
    if (curs.indexOf(rc.currency) === -1) rc.currency = curs[0] || 'IDR';
    const wrap = $('#recap-currency-wrap');
    wrap.hidden = !(curs.length > 1 && !pinned);
    $('#recap-currency').innerHTML = curs.map((c) => '<button type="button" data-cur="' + c + '" class="' + (c === rc.currency ? 'is-on' : '') + '">' + c + '</button>').join('');
    $('#recap-period').value = rc.period;
    $('#recap-custom').hidden = rc.period !== 'custom';
    $('#recap-from').value = rc.from; $('#recap-to').value = rc.to;

    const range = recapRange();
    const sm = L.summarize(state.accounts, state.txs, { currency: rc.currency, from: range.from, to: range.to, accountId: rc.account });
    $('#recap-income').textContent = fmt(sm.income, rc.currency);
    $('#recap-expense').textContent = fmt(sm.expense, rc.currency);
    $('#recap-net').textContent = (sm.net > 0 ? '+' : '') + fmt(sm.net, rc.currency);
    $('#recap-chart').innerHTML = DK.chart.doughnut(sm.categories, 'Pengeluaran', L.formatCompact(sm.expense, rc.currency));
    $('#recap-top').textContent = sm.top ? 'Terbesar: ' + sm.top.name + ' (' + sm.top.pct.toFixed(1).replace('.', ',') + '%)' : 'Belum ada pengeluaran pada periode ini.';
    $('#recap-legend').innerHTML = sm.categories.map((c) => '<li><span class="sw" style="background:' + c.color + '"></span><span class="nm">' + esc(c.name) + '</span><span class="pc">' + c.pct.toFixed(1).replace('.', ',') + '%</span><span class="am">' + fmt(c.amount, rc.currency) + '</span></li>').join('');

    // daftar transaksi mengikuti filter
    const list = state.txs.filter((t) => {
      if (range.from && t.date < range.from) return false;
      if (range.to && t.date > range.to) return false;
      const ids = t.type === 'transfer' ? [t.fromId, t.toId] : [t.accountId];
      if (rc.account && ids.indexOf(rc.account) === -1) return false;
      return ids.some((id) => { const a = accById(id); return a && a.currency === rc.currency; });
    });
    $('#recap-count').textContent = list.length + ' transaksi';
    $('#recap-list').innerHTML = list.length ? list.slice(0, 200).map(txRow).join('') : '<div class="empty"><p>Tidak ada transaksi pada periode ini.</p></div>';
    renderOfflineState();
  }
  $('#recap-period').addEventListener('change', (e) => {
    rc.period = e.target.value;
    if (rc.period === 'custom' && !rc.from) { const r = L.periodRange('month', L.todayLocal()); rc.from = r.from; rc.to = L.todayLocal(); }
    renderRecap();
  });
  $('#recap-from').addEventListener('change', (e) => { rc.from = e.target.value; renderRecap(); });
  $('#recap-to').addEventListener('change', (e) => { rc.to = e.target.value; renderRecap(); });
  $('#recap-account').addEventListener('change', (e) => { rc.account = e.target.value; renderRecap(); });
  $('#recap-currency').addEventListener('click', (e) => { const b = e.target.closest('[data-cur]'); if (b) { rc.currency = b.dataset.cur; renderRecap(); } });

  /* =====================================================================
   * BACKUP & PEMULIHAN
   * ===================================================================== */
  $('#btn-export').addEventListener('click', async () => {
    try {
      const data = await DB.exportAll();
      const json = JSON.stringify(data, null, 2);
      // pastikan hasilnya valid sebelum dinyatakan berhasil
      const check = L.validateBackup(JSON.parse(json));
      if (!check.ok) throw new Error('Cadangan gagal diverifikasi: ' + check.errors[0]);
      const blob = new Blob([json], { type: 'application/json' });
      if (!blob.size) throw new Error('File cadangan kosong.');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'dompetku-backup-' + L.todayLocal() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast('File cadangan dibuat (' + data.accounts.length + ' akun, ' + data.transactions.length + ' transaksi). Cek folder Unduhan.');
    } catch (e) { toast('Ekspor gagal: ' + errMsg(e), true); }
  });
  $('#btn-import').addEventListener('click', () => { $('#import-file').value = ''; $('#import-file').click(); });
  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    let parsed;
    try { parsed = JSON.parse(await f.text()); }
    catch (_) { return showImportProblem(['File bukan JSON yang valid.']); }
    const v = L.validateBackup(parsed);
    if (!v.ok) return showImportProblem(v.errors);
    state.pendingImport = v;
    const plan = L.planMerge(state.accounts, state.txs, v);
    $('#import-body').innerHTML = '<p>File berisi <b>' + v.accounts.length + ' akun</b> dan <b>' + v.transactions.length + ' transaksi</b>. Data di HP ini: ' + state.accounts.length + ' akun, ' + state.txs.length + ' transaksi.</p>'
      + '<div class="imp-mode"><label><input type="radio" name="imp-mode" id="import-mode-merge" value="merge" checked><span><b>Gabungkan</b><br><span class="muted small">Tambah ' + plan.newAccounts.length + ' akun dan ' + plan.newTxs.length + ' transaksi baru. Dilewati karena ID sudah ada: ' + plan.dupAccounts + ' akun, ' + plan.dupTxs + ' transaksi' + (plan.rejectedTxs ? '; ditolak karena tidak konsisten: ' + plan.rejectedTxs : '') + (plan.conflictAccounts ? '. Ada ' + plan.conflictAccounts + ' akun dengan ID sama tetapi data berbeda (data di HP dipertahankan)' : '') + '.</span></span></label>'
      + '<label><input type="radio" name="imp-mode" id="import-mode-replace" value="replace"><span><b>Ganti semua</b><br><span class="muted small">Semua data di HP ini dihapus lalu diganti isi file. Tidak bisa dibatalkan.</span></span></label></div>';
    $('#import-confirm').disabled = false; $('#import-confirm').hidden = false; $('#import-confirm').textContent = 'Impor';
    openDialog($('#dlg-import'));
  });
  function showImportProblem(errors) {
    state.pendingImport = null;
    $('#import-body').innerHTML = '<p class="form-error">File tidak diimpor dan data Anda tidak berubah. Masalah yang ditemukan:</p><ul class="imp-list">' + errors.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>';
    $('#import-confirm').hidden = true;
    openDialog($('#dlg-import'));
  }
  $('#import-cancel').addEventListener('click', () => { state.pendingImport = null; $('#dlg-import').close(); });
  $('#import-confirm').addEventListener('click', async () => {
    const v = state.pendingImport; if (!v) return;
    const mode = ($('#import-mode-replace') && $('#import-mode-replace').checked) ? 'replace' : 'merge';
    if (mode === 'replace') {
      const ok = await confirmDialog('Ganti semua data?', 'Semua ' + state.accounts.length + ' akun dan ' + state.txs.length + ' transaksi saat ini akan dihapus dan diganti isi file cadangan.', 'Ganti semua');
      if (!ok) return;
    }
    const btn = $('#import-confirm'); btn.disabled = true;
    try {
      const res = mode === 'replace' ? await DB.importReplace(v) : await DB.importMerge(v);
      state.pendingImport = null; $('#dlg-import').close();
      ['income', 'expense', 'transfer'].forEach((k) => { state.editing[k] = null; });
      await refresh();
      toast(mode === 'replace' ? 'Impor selesai: ' + res.accounts + ' akun dan ' + res.transactions + ' transaksi dipulihkan.' : 'Impor selesai: ' + res.newAccounts.length + ' akun dan ' + res.newTxs.length + ' transaksi ditambahkan.');
    } catch (e) { toast('Impor gagal, data tidak berubah: ' + errMsg(e), true); }
    finally { btn.disabled = false; }
  });

  /* =====================================================================
   * OFFLINE (service worker)
   * ===================================================================== */
  function renderOfflineState() {
    $('#offline-state').textContent = !('serviceWorker' in navigator) ? 'Mode offline tidak didukung browser ini.'
      : state.swReady ? 'Mode offline: siap. Aplikasi bisa dibuka tanpa internet.' : 'Mode offline: belum siap. Buka sekali saat online.';
  }
  function setupOffline() {
    const upd = () => { $('#net-state').hidden = navigator.onLine; };
    window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) { renderOfflineState(); return; }
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.ready.then(() => { state.swReady = true; renderOfflineState(); });
  }

  /* =====================================================================
   * START
   * ===================================================================== */
  window.addEventListener('unhandledrejection', (e) => { toast(errMsg(e.reason), true); });
  async function init() {
    setupFlowForm('income'); setupFlowForm('expense'); setupTransferForm();
    setupOffline();
    try {
      await refresh();
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* abaikan */ }
    } catch (e) {
      $('#purse').innerHTML = '<div class="lbl">Database tidak bisa dibuka</div><div class="month">' + esc(errMsg(e)) + '</div>';
    }
  }
  DK.app = { state, refresh, showScreen };
  init();
})();
