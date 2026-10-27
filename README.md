# DompetKu v2

Pencatat keuangan pribadi untuk browser HP Android. HTML + CSS + JavaScript biasa, data disimpan lokal di IndexedDB.
Tanpa login, tanpa server, tanpa library eksternal (grafik juga digambar sendiri), jadi aman dipakai offline dan di-host di GitHub Pages.

Proyek ini **berdiri sendiri**. Isi repo lama (`DompetKuV2`) tidak diubah. Folder ini hanya perlu di-upload ke repo baru.

## Struktur

```
dompetku-v2/
├── index.html              kerangka, navigasi, dialog
├── css/style.css           tampilan mobile-first
├── js/
│   ├── ledger.js           logika murni: uang, validasi, saldo, rekap, backup  (skema data didokumentasikan di sini)
│   ├── db.js               IndexedDB: semua tulis = 1 transaksi atomik
│   ├── chart.js            grafik doughnut SVG
│   └── app.js              UI
├── sw.js                   service worker (offline)
├── manifest.webmanifest    agar bisa "Tambahkan ke layar utama"
├── icons/                  ikon aplikasi
├── tests/
│   ├── ledger.test.cjs     unit test logika (Node saja)
│   ├── e2e.cjs             tes end-to-end di Chromium (Playwright)
│   └── last-e2e-result.txt hasil run terakhir
└── package.json
```

## Cara menjalankan

Service worker dan IndexedDB butuh `http://localhost` atau `https://`; membuka `index.html` langsung dengan klik dua kali (`file://`) tetap menjalankan aplikasi, tetapi mode offline tidak aktif.

```bash
cd dompetku-v2
python3 -m http.server 8080      # atau: npx serve .
# buka http://localhost:8080
```

Untuk mencoba di HP: buka alamat komputer Anda di jaringan WiFi yang sama (mis. `http://192.168.1.10:8080`). Mode offline baru aktif di HTTPS/GitHub Pages.

## Cara menguji

```bash
npm install
npx playwright install chromium
npm test                # unit test + tes end-to-end
npm run test:unit       # hanya logika, tanpa browser
```

## Deploy ke GitHub Pages

1. Buat repository baru di GitHub, mis. `dompetku-v2` (Public). **Jangan** menimpa repo lama sebelum Anda puas dengan hasilnya.
2. Upload **isi** folder ini (bukan folder pembungkusnya) ke root repo. Lewat web: *Add file → Upload files*, tarik semua file dan folder, lalu *Commit*.
3. *Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save*.
4. Tunggu 1–3 menit, buka `https://USERNAME.github.io/dompetku-v2/` di Chrome HP, **sekali saat online** supaya file tersimpan untuk mode offline.
5. Opsional: menu ⋮ → *Tambahkan ke layar utama*.

Karena alamatnya berbeda dari website lama, data lama **tidak ikut**. Jika ingin memindahkan data, lihat bagian Backup di bawah. Format backup v2 berbeda dari versi lama.

### Memperbarui aplikasi
Setelah mengubah file, naikkan nomor `CACHE` di `sw.js` (`dompetku-v2-1` → `dompetku-v2-2`). Pembaruan aktif setelah aplikasi dibuka dua kali. Data tidak terhapus karena service worker tidak menyentuh IndexedDB.

## Fitur

**Beranda**: total saldo per mata uang (IDR dan USD tidak dijumlahkan), ringkasan masuk/keluar bulan ini, akun Cash, lalu akun E-Wallet / Bank / Lainnya. Tombol **+ Tambah akun** selalu terlihat. Ketuk akun untuk melihat saldo, saldo awal, dan riwayat transaksinya; dari sana bisa **Edit** atau **Arsipkan**.

**Akun**: satu Cash bawaan (id tetap, tidak bisa ganda). Tambah akun = satu form: jenis, penyedia (daftar atau isi sendiri), nama panggilan, mata uang, **saldo awal**, Simpan. Akun langsung tersedia di semua form. Boleh punya beberapa akun dari penyedia yang sama. Nama panggilan tidak boleh kembar agar mudah dibedakan. Akun tidak bisa dihapus, hanya diarsipkan (riwayat tetap utuh).

**Pemasukan / Pengeluaran**: nominal, kategori, akun, tanggal, catatan. Ada pratinjau saldo sebelum → sesudah. Ketuk transaksi di daftar untuk mengedit atau menghapus.

**Transfer**: akun asal, akun tujuan, nominal, biaya admin opsional, tanggal, catatan. Transfer beda mata uang meminta *nominal diterima*, dan kurs dihitung otomatis dan ditampilkan.

**Rekap**: filter periode (bulan ini, bulan lalu, 7/30 hari, semua, rentang tanggal), akun, dan mata uang. Total pemasukan, pengeluaran, selisih, doughnut per kategori (terurut dari terbesar, nominal dan persen, kategori terbesar), serta daftar transaksi.

**Backup**: ekspor JSON, impor dengan validasi ketat, pilihan *Gabungkan* atau *Ganti semua* (dengan konfirmasi).

## Aturan perhitungan

- Saldo **tidak disimpan**; dihitung ulang = saldo awal + efek semua transaksi. Karena itu edit/hapus selalu konsisten dan saldo tidak mungkin "setengah berubah".
- Saldo awal bukan pemasukan. Transfer bukan pemasukan/pengeluaran.
- Biaya admin disimpan **di dalam** record transfer, dikurangkan dari akun asal, dan dihitung sebagai pengeluaran (kategori "Biaya admin") tepat sekali. Edit/hapus transfer ikut mengubah/menghapus biayanya.
- Nominal disimpan sebagai bilangan bulat (rupiah; sen untuk USD), jadi tidak ada galat desimal.
- Saldo boleh menjadi negatif (mis. lupa mengisi saldo awal); form hanya memberi peringatan, tidak memblokir.

## Skema database (`dompetku-v2`, versi 1)

```
accounts      keyPath "id"   { id, type, provider, name, currency, openingMinor, archived, createdAt }
transactions  keyPath "id"   { id, type, date, createdAt, updatedAt, note, category, accountId,
                               fromId, toId, amountMinor, toAmountMinor, feeMinor }
```

Penjelasan tiap field ada di komentar atas `js/ledger.js`. Pencegahan error *"Evaluating the object store's key path did not yield a value"*:

- `id` selalu dibuat oleh `makeAccount` / `makeTransaction` dan dicek ulang (`assertKey`) tepat sebelum `put()`. Record tanpa ID ditolak dengan pesan yang jelas.
- Semua tulis (tambah, edit, hapus, impor) lewat satu fungsi di `db.js` dengan satu skema; validasi akun terkait dilakukan di transaksi IndexedDB yang sama, dan transaksi di-`abort` jika gagal.
- Database tidak pernah di-reset atau dihapus otomatis.

## Batasan yang diketahui

- Data hanya ada di browser HP itu. Membersihkan data situs, atau mode samaran, dapat menghapusnya. **Ekspor backup secara rutin.** Aplikasi meminta penyimpanan persisten, tetapi Chrome yang menentukan.
- Unduhan backup tidak bisa dipastikan sampai ke folder tujuan oleh aplikasi; yang bisa diverifikasi adalah file sudah dibuat dan valid. Pesan sukses mengatakan hal itu.
- Tidak ada sinkronisasi antar perangkat, tidak ada kurs otomatis, tidak ada ekspor Excel (butuh library eksternal; sengaja dihilangkan agar fitur inti tidak bergantung internet).
- Mata uang hanya IDR dan USD. Menambah mata uang: tambahkan di `CURRENCIES` pada `ledger.js` dan opsi di `index.html`.
- Cash selalu Rupiah dan tidak bisa diarsipkan.
- Cadangan dari website lama tidak kompatibel (format berbeda).

## Hasil pengujian

Lihat `tests/last-e2e-result.txt` untuk hasil run terakhir. Tes end-to-end memakai Chromium sungguhan (emulasi Pixel 7), IndexedDB asli, tanpa mock. Hal yang **belum** diuji: perangkat Android fisik, Firefox/Safari, dan service worker di HTTPS GitHub Pages sungguhan (diuji hanya di `localhost`).
