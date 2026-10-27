/*
 * DompetKu v2 — chart.js
 * Doughnut SVG buatan sendiri (tanpa library eksternal, jadi tetap jalan offline).
 * Data dibaca dari hasil ledger.summarize(); tidak ada angka contoh statis.
 */
(function (global) {
  'use strict';
  const DK = (global.DK = global.DK || {});
  const R = 15.9155; // keliling lingkaran = 100 -> panjang busur == persen

  /**
   * @param {Array<{name,amount,pct,color}>} categories sudah terurut dari terbesar
   * @param {string} centerLabel teks kecil di tengah (mis. "Pengeluaran")
   * @param {string} centerValue teks besar di tengah (total, format ringkas)
   */
  function doughnut(categories, centerLabel, centerValue) {
    const total = categories.reduce((s, c) => s + c.amount, 0);
    let rings = '';
    if (total <= 0) {
      rings = '<circle class="ring-empty" cx="21" cy="21" r="' + R + '" fill="none" stroke-width="5.5"/>';
    } else {
      let offset = 0;
      categories.forEach((c) => {
        const len = (c.amount / total) * 100;
        const gap = categories.length > 1 && len > 1.2 ? 0.5 : 0; // celah tipis antar irisan
        rings += '<circle cx="21" cy="21" r="' + R + '" fill="none" stroke="' + c.color + '" stroke-width="5.5"'
          + ' stroke-dasharray="' + Math.max(len - gap, 0).toFixed(3) + ' ' + (100 - Math.max(len - gap, 0)).toFixed(3) + '"'
          + ' stroke-dashoffset="' + (-offset).toFixed(3) + '"/>';
        offset += len;
      });
    }
    return '<svg viewBox="0 0 42 42" role="img" aria-label="Grafik pengeluaran per kategori">'
      + '<g transform="rotate(-90 21 21)">' + rings + '</g>'
      + '<text x="21" y="19.6" text-anchor="middle" class="c-label">' + centerLabel + '</text>'
      + '<text x="21" y="25.2" text-anchor="middle" class="c-value">' + centerValue + '</text></svg>';
  }

  DK.chart = { doughnut };
})(window);
