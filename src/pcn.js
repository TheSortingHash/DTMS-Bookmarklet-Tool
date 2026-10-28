/*
 * PC No. helpers shared by the scanner page and tests.
 * A PC No. is 11 digits: YYYYMMDD + a 3-digit sequence, e.g. 20261021037.
 */
(function (root) {
  'use strict';

  var PCN_RE = /^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}$/;

  // Letters OCR commonly returns in place of digits.
  var CONFUSABLE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9' };

  function isPcn(s) { return PCN_RE.test(s); }

  // Strips spaces/dashes a person might type ("2026 1021 037").
  function cleanTyped(s) { return String(s || '').replace(/[\s\-_.]/g, ''); }

  function dateOf(pcn) {
    return new Date(Number(pcn.slice(0, 4)), Number(pcn.slice(4, 6)) - 1, Number(pcn.slice(6, 8)));
  }

  /*
   * Finds PC No. candidates in OCR text, best first.
   * Runs of digits (allowing OCR letter confusions and stray spaces) are scanned
   * with an 11-character window; each hit must be a valid date + sequence.
   * Ranking: next to a "PC No" label, then a recent date, then frequency.
   * Candidates dated more than a week ahead are dropped.
   */
  function extractPcns(text, today) {
    today = today || new Date();
    var lines = String(text || '').split(/\r?\n/);
    var found = {};
    lines.forEach(function (line, li) {
      var labelled = /P\s*C\s*N\s*[o0]/i.test(line) || (li > 0 && /P\s*C\s*N\s*[o0]/i.test(lines[li - 1]));
      var runs = line.match(/[0-9OoDQIli|!ZzSsBGbgq][0-9OoDQIli|!ZzSsBGbgq \-]{8,20}[0-9OoDQIli|!ZzSsBGbgq]/g) || [];
      runs.forEach(function (run) {
        var digits = run.replace(/[ \-]/g, '');
        if ((digits.match(/\d/g) || []).length < 8) return; // mostly letters: a word, not a number
        digits = digits.replace(/[^0-9]/g, function (c) { return CONFUSABLE[c] || 'x'; });
        for (var i = 0; i + 11 <= digits.length; i++) {
          var c = digits.slice(i, i + 11);
          if (!isPcn(c)) continue;
          var f = found[c] || (found[c] = { pcn: c, score: 0, count: 0 });
          f.count++;
          if (labelled) f.score += 4;
          // Exact 11-digit run (no extra digits around it) is more likely the real thing.
          if (digits.length === 11) f.score += 1;
        }
      });
    });
    var horizon = today.getTime();
    return Object.keys(found).map(function (k) {
      var f = found[k];
      f.days = (horizon - dateOf(k).getTime()) / 864e5;
      if (f.days <= 400) f.score += 2;
      f.score += Math.min(f.count, 3) * 0.5;
      return f;
    }).filter(function (f) {
      // PC Nos. are never dated in the future; drops TIN fragments like 203-012-150-000 -> 20301215000.
      return f.days >= -7;
    }).sort(function (a, b) { return b.score - a.score; }).map(function (f) { return f.pcn; });
  }

  var api = { PCN_RE: PCN_RE, isPcn: isPcn, cleanTyped: cleanTyped, extractPcns: extractPcns };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DTMSPcn = api;
})(typeof window !== 'undefined' ? window : this);
