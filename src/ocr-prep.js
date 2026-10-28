/*
 * Image preprocessing for reading a PC No. from a photo, shared by the
 * scanner page (canvas ImageData) and tests (raw RGBA from sharp).
 * Input/output: { data: Uint8ClampedArray RGBA, width, height }.
 */
(function (root) {
  'use strict';

  function gray(img) {
    var d = img.data, n = img.width * img.height, g = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
    return g;
  }

  function histogram(g) {
    var h = new Uint32Array(256);
    for (var i = 0; i < g.length; i++) h[g[i]]++;
    return h;
  }

  // Stretches the 1st..99th percentile to 0..255 (dim or washed-out photos).
  function stretch(g) {
    var h = histogram(g), n = g.length, lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += h[lo]; if (acc > n * 0.01) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += h[hi]; if (acc > n * 0.01) break; }
    if (hi <= lo) return g;
    var out = new Uint8ClampedArray(n), k = 255 / (hi - lo);
    for (var i = 0; i < n; i++) out[i] = (g[i] - lo) * k;
    return out;
  }

  function otsu(g) {
    var h = histogram(g), n = g.length, sum = 0, sumB = 0, wB = 0, best = 0, t = 127;
    for (var i = 0; i < 256; i++) sum += i * h[i];
    for (var v = 0; v < 256; v++) {
      wB += h[v]; if (!wB) continue;
      var wF = n - wB; if (!wF) break;
      sumB += v * h[v];
      var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = v; }
    }
    return t;
  }

  /*
   * Local (Bradley) threshold: a pixel is ink if it is darker than the mean of
   * its neighbourhood by `pct`%. Copes with shadows and uneven light across a
   * phone photo, where one global threshold fails.
   */
  function adaptive(g, w, h, pct) {
    var s = Math.max(8, Math.round(Math.max(w, h) / 16)), half = s >> 1;
    var ii = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var row = 0;
      for (var x = 0; x < w; x++) {
        row += g[y * w + x];
        ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
      }
    }
    var out = new Uint8ClampedArray(w * h), f = (100 - pct) / 100;
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        var area = (y1 - y0) * (x1 - x0);
        var sum = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
        out[y * w + x] = g[y * w + x] * area <= sum * f ? 0 : 255;
      }
    }
    return out;
  }

  function toRgba(g, w, h) {
    var d = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, j = 0; i < g.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = g[i]; d[j + 3] = 255; }
    return { data: d, width: w, height: h };
  }

  /*
   * The passes the scanner tries, in order, until one yields a PC No.
   * Each: { name, scale (longest side in px), psm (Tesseract page-seg mode), prep(img) }.
   * Order chosen from tests on real DV photos and PDFs: cheapest/most likely first.
   */
  var PASSES = [
    { name: 'gray', scale: 1600, psm: '3', prep: function (img) { return toRgba(stretch(gray(img)), img.width, img.height); } },
    { name: 'adaptive', scale: 1600, psm: '3', prep: function (img) { return toRgba(adaptive(stretch(gray(img)), img.width, img.height, 12), img.width, img.height); } },
    { name: 'otsu', scale: 2200, psm: '3', prep: function (img) {
      var g = stretch(gray(img)), t = otsu(g), out = new Uint8ClampedArray(g.length);
      for (var i = 0; i < g.length; i++) out[i] = g[i] > t ? 255 : 0;
      return toRgba(out, img.width, img.height);
    } },
    { name: 'adaptive-sparse', scale: 2200, psm: '11', prep: function (img) { return toRgba(adaptive(stretch(gray(img)), img.width, img.height, 15), img.width, img.height); } }
  ];

  var api = { gray: gray, stretch: stretch, otsu: otsu, adaptive: adaptive, toRgba: toRgba, PASSES: PASSES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DTMSOcrPrep = api;
})(typeof window !== 'undefined' ? window : this);
