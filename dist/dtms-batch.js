/* DTMS Batch v0.3.0 (built 2026-10-28) */
/*
 * DTMS core: reads DTMS pages and runs receive/forward batches.
 * No UI here. Runs in the browser (same origin as DTMS) and under Node for tests.
 *
 * Every write to DTMS is a replay of DTMS's own <form>: the page is fetched,
 * parsed, its fields serialized exactly as a browser would, and only the
 * clicked button (and the destination) is added.
 */
(function (root) {
  'use strict';

  var PCN_RE = /^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}$/;

  var URLS = {
    receiveList: '/dtms/index.php?task=41&id=R',
    update: '/dtms/index.php?task=3',
    search: function (pcn) {
      return '/dtms/index.php?task=3&iSearch=Search&ipcn=' + encodeURIComponent(pcn);
    }
  };

  var DEFAULT_ALIASES = ['OMD-Finance Department', 'OMD-Finance Signatory'];

  // ilocate options as of 2026-10-27; replaced by the live list after the first check.
  var DEFAULT_STATIONS = [
    ['ACC', 'ACCOUNTING (DVProcess)'], ['JD05', 'Bids and Awards Committee Secretariat'],
    ['JE02', 'Budget Division, Finance'], ['CB00', 'Center for Institutional Marketing'],
    ['JD03', 'Central Documentation and Records Division'], ['BC01', 'Corporate Operations and Strategic Mgt'],
    ['GSD', 'GSD, Admin'], ['JF01', 'Human Resource Mgt & Devt Dept'], ['JD06', 'ICTD, Admin'],
    ['JF02', 'Office of the Director - HRMD'], ['BA00', 'Office of the President & CEO'],
    ['JD00', 'OMD-Administrative Department'], ['JB00', 'OMD-DAP Conference Center'],
    ['JF00', 'OMD-Human Resource Mgt & Devt Dept'], ['SPR', 'OSVP - PROGRAMS'], ['SSO', 'OSVP - SERVICES'],
    ['SSO2', 'OSVPS-Signatory'], ['JE04', 'Pre-Audit'], ['JD01', 'Procurement Unit, Admin'],
    ['RE2', 'REQUESTING OFFICE/UNIT [P]'], ['JD04', 'Services Front Desk'], ['TR3', 'TREASURY (CHK PREP)'],
    ['TRD', 'TREASURY (E-PAID)'], ['TR2', 'TREASURY (SIGNED CHK)'], ['JE03', 'Treasury Division'],
    ['JB01', 'Venue & Accommodation Services'], ['CC00', 'VP-Center for Organizational Devt and Innovation']
  ].map(function (s) { return { code: s[0], label: s[1] }; });

  // Item statuses. Terminal ones are never touched again in a run.
  var S = {
    PENDING: 'PENDING', RECEIVED: 'RECEIVED', FORWARDED: 'FORWARDED', BLOCKED: 'BLOCKED',
    NOT_FOUND: 'NOT_FOUND', FAILED: 'FAILED', RECEIVE_FAILED: 'RECEIVE_FAILED', SKIPPED: 'SKIPPED'
  };
  var TERMINAL = { FORWARDED: 1, BLOCKED: 1, NOT_FOUND: 1, FAILED: 1, RECEIVE_FAILED: 1, SKIPPED: 1 };

  // Plans decided by check().
  var P = {
    RECEIVE_FORWARD: 'RECEIVE_FORWARD', FORWARD: 'FORWARD', FORWARD_WARN: 'FORWARD_WARN',
    ALREADY_THERE: 'ALREADY_THERE', NOT_FOUND: 'NOT_FOUND', BAD_DEST: 'BAD_DEST'
  };
  var RUNNABLE = { RECEIVE_FORWARD: 1, FORWARD: 1, FORWARD_WARN: 1 };

  var NEEDS_RECEIVE = 'NEEDS_RECEIVE';

  function SessionExpiredError() { this.name = 'SessionExpiredError'; this.message = 'DTMS session expired. Log in again, then re-run Check.'; }
  SessionExpiredError.prototype = Object.create(Error.prototype);
  function StoppedError() { this.name = 'StoppedError'; this.message = 'Stopped by user.'; }
  StoppedError.prototype = Object.create(Error.prototype);

  // ---------- parsing ----------

  function norm(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }
  function key(s) { return norm(s).toLowerCase(); }

  function parseHtml(text) { return new DOMParser().parseFromString(text, 'text/html'); }

  function isLoginPage(doc) {
    return !!doc.querySelector('input[type="password"][name="password"]') || /User Registry/i.test(doc.title || '');
  }

  function parseStation(doc) {
    var cell = doc.querySelector('td.reportHeader21');
    var m = cell && norm(cell.textContent).match(/Station:\s*(.+)$/);
    return m ? m[1] : null;
  }

  function parseReceiveList(doc) {
    var rows = new Map();
    var boxes = doc.querySelectorAll('input[type="checkbox"][name^="act["]');
    Array.prototype.forEach.call(boxes, function (cb) {
      var tr = cb.closest('tr');
      if (!tr || tr.cells.length < 12) return;
      var pcn = norm(tr.cells[2].textContent);
      rows.set(pcn, {
        checkbox: cb, name: cb.name, pcn: pcn,
        from: norm(tr.cells[4].textContent), payee: norm(tr.cells[8].textContent), amount: norm(tr.cells[11].textContent)
      });
    });
    return { form: boxes.length ? boxes[0].form : doc.querySelector('form'), rows: rows };
  }

  function fieldAfterLabel(doc, label) {
    var cells = doc.querySelectorAll('td');
    for (var i = 0; i < cells.length; i++) {
      if (norm(cells[i].textContent) === label && cells[i].nextElementSibling) {
        return norm(cells[i].nextElementSibling.textContent);
      }
    }
    return null;
  }

  function parseUpdatePage(doc) {
    var info = {
      found: false, pcn: null, client: null, amount: null, particulars: null,
      lastLocation: null, notYetReceived: false, currentCode: null, currentLabel: null,
      options: [], oops: null, notReceivedBy: null, form: doc.querySelector('form')
    };

    var hdr = doc.querySelector('td.reportHeader1');
    var m = hdr && norm(hdr.textContent).match(/Processing Control Number:\s*(\d+)/);
    if (m) { info.found = true; info.pcn = m[1]; }

    info.client = fieldAfterLabel(doc, 'Client Name:');
    info.amount = fieldAfterLabel(doc, 'Amount:');
    info.particulars = fieldAfterLabel(doc, 'Particulars:');
    var loc = fieldAfterLabel(doc, 'Last Location:');
    if (loc != null) {
      var lm = loc.match(/^(.*?)\s*\(Not yet Received\)\s*$/i);
      info.lastLocation = lm ? lm[1] : loc;
      info.notYetReceived = !!lm;
    }

    // The select lists every station, then a "-----" separator, then the
    // record's current location as a second selected option.
    var sel = doc.querySelector('select[name="ilocate"]');
    if (sel) {
      var afterSep = false;
      Array.prototype.forEach.call(sel.options, function (o) {
        if (!o.value) { afterSep = true; return; }
        if (afterSep) { info.currentCode = o.value; info.currentLabel = norm(o.textContent); }
        else info.options.push({ code: o.value, label: norm(o.textContent) });
      });
    }

    var ps = doc.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      if (/^Oops/i.test(norm(ps[i].textContent))) {
        var next = ps[i].nextElementSibling;
        info.oops = next ? norm(next.textContent) : 'Oops (no details)';
        var nm = info.oops.match(/not yet received by\s+(.+?)\s*!?$/i);
        if (nm) info.notReceivedBy = nm[1];
        break;
      }
    }
    return info;
  }

  // Serialize a form the way a browser does on submit (minus the submit button).
  function serializeForm(form) {
    var p = new URLSearchParams();
    if (!form) return p;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      var tag = el.tagName.toLowerCase(), type = (el.type || '').toLowerCase();
      if (tag === 'input') {
        if (/^(submit|button|reset|image|file)$/.test(type)) return;
        if (type === 'checkbox' || type === 'radio') {
          if (!el.checked) return;
          p.append(el.name, el.hasAttribute('value') ? el.value : 'on');
          return;
        }
        p.append(el.name, el.value);
      } else if (tag === 'select') {
        Array.prototype.forEach.call(el.options, function (o) {
          if (o.selected && !o.disabled) p.append(el.name, o.value);
        });
      } else if (tag === 'textarea') {
        p.append(el.name, el.value);
      }
    });
    return p;
  }

  // ---------- input ----------

  // Lines like "20261021033 JD00", "20261021037", or "2026..., 2026... JE04".
  // A destination code on a line applies to every PC No. on that line.
  function parseInput(text, defaultDest, stations) {
    var codes = {};
    (stations || DEFAULT_STATIONS).forEach(function (s) { codes[s.code.toUpperCase()] = s.code; });
    var items = [], errors = [], seen = {};
    String(text || '').split(/\r?\n/).forEach(function (line, idx) {
      var tokens = line.split(/[\s,;]+/).filter(Boolean);
      if (!tokens.length) return;
      var pcns = [], dest = null;
      tokens.forEach(function (t) {
        if (/^\d+$/.test(t)) {
          if (PCN_RE.test(t)) pcns.push(t);
          else errors.push('Line ' + (idx + 1) + ': "' + t + '" is not a valid PC No.');
        } else if (codes[t.toUpperCase()]) {
          dest = codes[t.toUpperCase()];
        } else {
          errors.push('Line ' + (idx + 1) + ': unknown station code "' + t + '"');
        }
      });
      pcns.forEach(function (pcn) {
        if (seen[pcn]) { errors.push('Line ' + (idx + 1) + ': ' + pcn + ' is a duplicate, ignored'); return; }
        seen[pcn] = true;
        var d = dest || defaultDest;
        if (!d) errors.push('Line ' + (idx + 1) + ': ' + pcn + ' has no destination');
        else items.push(newItem(pcn, d));
      });
    });
    return { items: items, errors: errors };
  }

  function newItem(pcn, dest) {
    return { pcn: pcn, dest: dest, plan: null, status: S.PENDING, message: '', info: {}, inReceiveList: false, attempts: 0 };
  }

  // ---------- running ----------

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /*
   * ctx = {
   *   http: { get(url) -> {url,text}, post(url, URLSearchParams) -> {url,text} },
   *   aliases: [station names that mean "us"], delayMs, maxRetries,
   *   onItem(item), onLog(row), shouldStop() -> bool
   * }
   */
  function createContext(opts) {
    var ctx = {
      http: opts.http,
      aliases: (opts.aliases || DEFAULT_ALIASES).slice(),
      delayMs: opts.delayMs == null ? 300 : opts.delayMs,
      maxRetries: opts.maxRetries == null ? 2 : opts.maxRetries,
      onItem: opts.onItem || function () {},
      onLog: opts.onLog || function () {},
      shouldStop: opts.shouldStop || function () { return false; },
      station: null, stations: null, logRows: [], requests: 0
    };
    return ctx;
  }

  function isMine(ctx, name) {
    if (!name) return false;
    var k = key(name);
    return ctx.aliases.some(function (a) { return key(a) === k; }) || (!!ctx.station && key(ctx.station) === k);
  }

  function log(ctx, pcn, step, result, detail) {
    var row = { ts: new Date().toISOString(), station: ctx.station || '', pcn: pcn || '', step: step, result: result, detail: detail || '' };
    ctx.logRows.push(row);
    ctx.onLog(row);
  }

  function setStatus(ctx, item, status, message) {
    item.status = status;
    if (message != null) item.message = message;
    ctx.onItem(item);
  }

  async function fetchDoc(ctx, method, url, params) {
    if (ctx.shouldStop()) throw new StoppedError();
    if (ctx.requests++ > 0 && ctx.delayMs) await delay(ctx.delayMs);
    var res = method === 'POST' ? await ctx.http.post(url, params) : await ctx.http.get(url);
    var doc = parseHtml(res.text);
    if (isLoginPage(doc)) throw new SessionExpiredError();
    var st = parseStation(doc);
    if (st && ctx.station && key(st) !== key(ctx.station)) {
      throw new Error('Logged-in station changed from "' + ctx.station + '" to "' + st + '". Stopping.');
    }
    return doc;
  }

  function applyInfo(item, info) {
    item.info = {
      client: info.client, amount: info.amount, lastLocation: info.lastLocation,
      notYetReceived: info.notYetReceived, currentCode: info.currentCode, currentLabel: info.currentLabel
    };
  }

  function hasStation(stations, code) {
    return stations.some(function (s) { return s.code === code; });
  }

  function labelOf(ctx, code) {
    var list = ctx.stations || DEFAULT_STATIONS;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i].label;
    return code;
  }

  // Read-only: one GET of the receive list, one GET per PC No.
  async function check(ctx, items) {
    var listDoc = await fetchDoc(ctx, 'GET', URLS.receiveList);
    ctx.station = parseStation(listDoc);
    if (!ctx.station) throw new Error('Could not read "Station:" from the DTMS header. Is this the DTMS page?');
    var rl = parseReceiveList(listDoc);
    log(ctx, '', 'check', 'OK', 'Receive list has ' + rl.rows.size + ' item(s); station ' + ctx.station);

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var info = parseUpdatePage(await fetchDoc(ctx, 'GET', URLS.search(item.pcn)));
      if (info.options.length) ctx.stations = info.options;
      applyInfo(item, info);
      var row = rl.rows.get(item.pcn);
      item.inReceiveList = !!row;
      if (row) { item.info.client = item.info.client || row.payee; item.info.amount = item.info.amount || row.amount; }
      planItem(ctx, item, info);
      item.status = S.PENDING;
      log(ctx, item.pcn, 'check', item.plan, item.message);
      ctx.onItem(item);
    }
    return items;
  }

  function planItem(ctx, item, info) {
    var stations = ctx.stations || DEFAULT_STATIONS;
    item.message = '';
    if (!info.found && !item.inReceiveList) { item.plan = P.NOT_FOUND; item.message = 'No DTMS record for this PC No.'; return; }
    if (!hasStation(stations, item.dest)) { item.plan = P.BAD_DEST; item.message = 'Unknown destination ' + item.dest; return; }
    if (item.inReceiveList) { item.plan = P.RECEIVE_FORWARD; return; }
    if (info.currentCode === item.dest) { item.plan = P.ALREADY_THERE; item.message = 'Already at ' + labelOf(ctx, item.dest); return; }
    if (info.notYetReceived && isMine(ctx, info.lastLocation)) {
      item.plan = P.RECEIVE_FORWARD;
      item.message = 'Forwarded to us but not in the receive list';
      return;
    }
    if (info.notYetReceived) {
      item.plan = P.FORWARD_WARN;
      item.message = 'Not yet received by ' + info.lastLocation + '; DTMS will likely refuse';
      return;
    }
    item.plan = P.FORWARD;
  }

  // Tick the items present in the receive list, POST once, then verify by re-reading the list.
  async function receive(ctx, items) {
    if (!items.length) return;
    var rl = parseReceiveList(await fetchDoc(ctx, 'GET', URLS.receiveList));
    var present = items.filter(function (it) { return rl.rows.has(it.pcn); });
    items.forEach(function (it) {
      if (!rl.rows.has(it.pcn)) log(ctx, it.pcn, 'receive', 'SKIP', 'Not in receive list');
    });
    if (!present.length) return;

    present.forEach(function (it) { rl.rows.get(it.pcn).checkbox.checked = true; });
    var params = serializeForm(rl.form);
    params.append('iReceive', 'YES!');
    await fetchDoc(ctx, 'POST', URLS.receiveList, params);
    log(ctx, '', 'receive', 'POSTED', present.map(function (it) { return it.pcn; }).join(' '));

    var after = parseReceiveList(await fetchDoc(ctx, 'GET', URLS.receiveList));
    present.forEach(function (it) {
      if (after.rows.has(it.pcn)) {
        setStatus(ctx, it, S.RECEIVE_FAILED, 'Still in the receive list after YES!');
        log(ctx, it.pcn, 'receive', 'FAILED', 'Still listed after submit');
      } else {
        it.inReceiveList = false;
        setStatus(ctx, it, S.RECEIVED, 'Received');
        log(ctx, it.pcn, 'receive', 'OK', '');
      }
    });
  }

  // Pre-check, then Update Location. Returns NEEDS_RECEIVE when our station must receive first.
  async function forward(ctx, item) {
    item.attempts++;
    var pre = parseUpdatePage(await fetchDoc(ctx, 'GET', URLS.search(item.pcn)));
    applyInfo(item, pre);
    if (pre.options.length) ctx.stations = pre.options;

    if (!pre.found) return done(S.NOT_FOUND, 'No DTMS record for this PC No.');
    if (!hasStation(pre.options, item.dest)) return done(S.FAILED, 'Destination ' + item.dest + ' is not in the Forwarded-to list');
    if (pre.currentCode === item.dest) return done(S.FORWARDED, 'Already at ' + labelOf(ctx, item.dest));
    if (pre.notYetReceived && isMine(ctx, pre.lastLocation)) {
      log(ctx, item.pcn, 'forward', NEEDS_RECEIVE, 'Last location: ' + pre.lastLocation + ' (Not yet Received)');
      return NEEDS_RECEIVE;
    }

    var params = serializeForm(pre.form);
    params.set('ipcn', item.pcn);
    params.set('ilocate', item.dest);
    params.append('iUpdate', 'Update Location');
    var res = parseUpdatePage(await fetchDoc(ctx, 'POST', URLS.update, params));
    applyInfo(item, res);

    if (res.oops) {
      if (res.notReceivedBy && isMine(ctx, res.notReceivedBy)) {
        log(ctx, item.pcn, 'forward', NEEDS_RECEIVE, res.oops);
        return NEEDS_RECEIVE;
      }
      return done(res.notReceivedBy ? S.BLOCKED : S.FAILED, res.oops);
    }
    if (res.found && res.pcn === item.pcn && res.currentCode === item.dest && res.notYetReceived) {
      return done(S.FORWARDED, 'Forwarded to ' + labelOf(ctx, item.dest));
    }
    return done(S.FAILED, 'Could not confirm forward. DTMS shows last location: ' +
      (res.lastLocation || '?') + (res.notYetReceived ? ' (Not yet Received)' : ''));

    function done(status, msg) {
      setStatus(ctx, item, status, msg);
      log(ctx, item.pcn, 'forward', status, msg);
      return status;
    }
  }

  async function run(ctx, items) {
    var work = items.filter(function (it) { return RUNNABLE[it.plan] && !TERMINAL[it.status]; });
    items.forEach(function (it) {
      if (!RUNNABLE[it.plan] && !TERMINAL[it.status]) {
        if (it.plan === P.ALREADY_THERE) setStatus(ctx, it, S.FORWARDED, it.message);
        else if (it.plan === P.NOT_FOUND) setStatus(ctx, it, S.NOT_FOUND, it.message);
        else setStatus(ctx, it, S.SKIPPED, it.message);
      }
    });

    await receive(ctx, work.filter(function (it) { return it.plan === P.RECEIVE_FORWARD; }));

    var pending = work.filter(function (it) { return !TERMINAL[it.status]; });
    for (var attempt = 0; pending.length; attempt++) {
      var again = [];
      for (var i = 0; i < pending.length; i++) {
        if (await forward(ctx, pending[i]) === NEEDS_RECEIVE) again.push(pending[i]);
      }
      if (!again.length) break;
      if (attempt >= ctx.maxRetries) {
        again.forEach(function (it) {
          setStatus(ctx, it, S.BLOCKED, 'Still not received by ' + ctx.station + ' after ' + (attempt + 1) + ' attempt(s); not in the receive list?');
          log(ctx, it.pcn, 'forward', S.BLOCKED, it.message);
        });
        break;
      }
      await receive(ctx, again);
      pending = again.filter(function (it) { return !TERMINAL[it.status]; });
    }
    return items;
  }

  // ---------- browser transport ----------

  function browserHttp() {
    async function req(url, init) {
      var res = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init));
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      var buf = await res.arrayBuffer();
      var text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
      return { url: res.url, text: text };
    }
    return {
      get: function (url) { return req(url); },
      post: function (url, params) { return req(url, { method: 'POST', body: params }); }
    };
  }

  function toCsv(rows, columns) {
    function cell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    return [columns.join(',')].concat(rows.map(function (r) {
      return columns.map(function (c) { return cell(r[c]); }).join(',');
    })).join('\n');
  }

  var api = {
    PCN_RE: PCN_RE, URLS: URLS, DEFAULT_ALIASES: DEFAULT_ALIASES, DEFAULT_STATIONS: DEFAULT_STATIONS,
    STATUS: S, PLAN: P, TERMINAL: TERMINAL, RUNNABLE: RUNNABLE,
    SessionExpiredError: SessionExpiredError, StoppedError: StoppedError,
    parseHtml: parseHtml, isLoginPage: isLoginPage, parseStation: parseStation,
    parseReceiveList: parseReceiveList, parseUpdatePage: parseUpdatePage, serializeForm: serializeForm,
    parseInput: parseInput, newItem: newItem, createContext: createContext,
    check: check, run: run, receive: receive, forward: forward,
    browserHttp: browserHttp, toCsv: toCsv
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DTMSCore = api;
})(typeof window !== 'undefined' ? window : this);

/*
 * DTMS queue client: talks to the Apps Script web app (apps-script/Code.gs).
 * Every call is a POST with a text/plain JSON body (a "simple" request, so no
 * CORS preflight). Apps Script answers with a redirect to googleusercontent.com,
 * which fetch follows and which allows any origin.
 */
(function (root) {
  'use strict';

  function createQueueClient(url, token, fetchImpl) {
    var doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(root) : null);

    async function call(op, payload) {
      var res;
      try {
        res = await doFetch(url, {
          method: 'POST', redirect: 'follow', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ op: op, token: token }, payload || {}))
        });
      } catch (e) {
        throw new Error('Could not reach the queue web app (' + (e && e.message || e) + '). Check the URL in Settings.');
      }
      if (!res.ok) throw new Error('Queue web app answered HTTP ' + res.status);
      var text = await res.text(), data;
      try { data = JSON.parse(text); } catch (e) {
        throw new Error('Queue web app did not return JSON. Is it deployed with "Who has access: Anyone"?');
      }
      if (!data.ok) throw new Error('Queue: ' + data.error);
      return data;
    }

    return {
      ping: function () { return call('ping'); },
      // desk: the DTMS station this panel runs as; the Sheet returns that desk's rows and unassigned ones.
      pending: function (batchId, desk) { return call('pending', { batchId: batchId || '', desk: desk || '' }); },
      enqueue: function (items) { return call('enqueue', { items: items }); },
      report: function (report) { return call('report', report); },
      setStations: function (stations, desk) { return call('setStations', { stations: stations, desk: desk || '' }); }
    };
  }

  // What the Sheet gets after a run: statuses and the action log, never payee or amount.
  function buildReport(station, items, logRows) {
    return {
      station: station || '',
      // Desk-typed items that never started stay out of the Sheet.
      results: items.filter(function (it) { return it.queueId || it.status !== 'PENDING'; }).map(function (it) {
        return {
          id: it.queueId || '', batchId: it.batchId || '', pcn: it.pcn, destCode: it.dest,
          status: it.status, message: it.message || '', attempts: it.attempts || 0
        };
      }),
      log: (logRows || []).map(function (r) {
        return { ts: r.ts, station: r.station, pcn: r.pcn, step: r.step, result: r.result, detail: r.detail };
      })
    };
  }

  var api = { createQueueClient: createQueueClient, buildReport: buildReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DTMSQueue = api;
})(typeof window !== 'undefined' ? window : this);

/*
 * DTMS Batch panel: injected into a DTMS page by the bookmarklet.
 * Paste or type PC Nos. -> Check (read-only) -> Run (receive, forward, retry).
 * Uses DTMSCore (src/core.js), bundled ahead of this file.
 */
(function () {
  'use strict';

  var core = window.DTMSCore;
  var queueApi = window.DTMSQueue;
  var HOST_ID = 'dtms-batch-panel';
  var VERSION = '0.3.0'; // replaced by scripts/build.js
  var SETTINGS_KEY = 'dtmsBatch.settings';

  var existing = document.getElementById(HOST_ID);
  if (existing && existing.getAttribute('data-version') === VERSION) {
    existing.style.display = existing.style.display === 'none' ? '' : 'none';
    return;
  }
  if (existing) existing.remove(); // an older version is open on this page: replace it

  if (!/\/dtms\//i.test(location.pathname)) {
    alert('DTMS Batch: open a DTMS page (http://192.168.1.220/dtms/...) first, then click the bookmarklet.');
    return;
  }
  if (core.isLoginPage(document)) {
    alert('DTMS Batch: log in to DTMS first, then click the bookmarklet.');
    return;
  }

  // ---------- settings (per browser, convenience only) ----------

  function loadSettings() {
    var s = { aliases: core.DEFAULT_ALIASES.slice(), delayMs: 300, defaultDest: '', queueUrl: '', queueToken: '' };
    try { Object.assign(s, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* private mode */ }
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }
  var settings = loadSettings();

  // ---------- DOM ----------

  var host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-version', VERSION);
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '.p{width:640px;max-height:92vh;display:flex;flex-direction:column;background:#fff;color:#1f2937;',
    '  font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;border:1px solid #2C2C87;',
    '  border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.25);overflow:hidden}',
    '.hd{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#2C2C87;color:#fff}',
    '.hd .ver{font-size:11px;opacity:.7}.hd b{font-size:14px}.hd .st{opacity:.85;font-size:12px;flex:1}',
    '.hd button{background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;padding:0 4px}',
    '.bd{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px}',
    'textarea{width:100%;box-sizing:border-box;min-height:96px;font:13px/1.4 ui-monospace,Consolas,monospace;',
    '  border:1px solid #9ca3af;border-radius:4px;padding:6px}',
    'select,input{font:inherit;border:1px solid #9ca3af;border-radius:4px;padding:3px 4px}',
    '.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    'button.b{font:inherit;padding:5px 12px;border-radius:4px;border:1px solid #2C2C87;background:#fff;color:#2C2C87;cursor:pointer}',
    'button.b.pri{background:#2C2C87;color:#fff}button.b.warn{border-color:#b91c1c;color:#b91c1c}',
    'button.b:disabled{opacity:.45;cursor:default}',
    '.hint{color:#6b7280;font-size:12px}',
    '.msg{padding:6px 8px;border-radius:4px;font-size:12px;white-space:pre-wrap}',
    '.msg.err{background:#fee2e2;color:#7f1d1d}.msg.ok{background:#dcfce7;color:#14532d}.msg.info{background:#e0e7ff;color:#1e1b4b}',
    'table{width:100%;border-collapse:collapse;font-size:12px}',
    'th,td{border-bottom:1px solid #e5e7eb;padding:4px;text-align:left;vertical-align:top}',
    'th{background:#f3f4f6;position:sticky;top:0}',
    'td.n{white-space:nowrap;font-family:ui-monospace,Consolas,monospace}',
    'tr.FORWARDED td{background:#f0fdf4}tr.BLOCKED td,tr.FAILED td,tr.RECEIVE_FAILED td,tr.NOT_FOUND td{background:#fef2f2}',
    'tr.busy td{background:#fefce8}',
    'details summary{cursor:pointer;color:#374151}',
    'pre{max-height:140px;overflow:auto;background:#f9fafb;border:1px solid #e5e7eb;padding:6px;font-size:11px;margin:4px 0 0}',
    '</style>',
    '<div class="p">',
    ' <div class="hd"><b>DTMS Batch</b><span class="ver">v' + VERSION + '</span><span class="st" id="st"></span>',
    '  <button id="min" title="Hide (click the bookmarklet again to show)">–</button></div>',
    ' <div class="bd">',
    '  <div class="row"><label>Default destination <select id="dest"></select></label>',
    '   <button class="b" id="loadq" hidden title="Add pending items from the Google Sheet queue">Load queue</button>',
    '   <button class="b" id="connect" hidden title="Enter the web app URL and token">Connect Google Sheet</button></div>',
    '  <textarea id="inp" spellcheck="false" placeholder="One PC No. per line, optionally followed by a station code:\n20261021033 JD00\n20261021037          (uses the default destination)\n\nCtrl+Enter = Check"></textarea>',
    '  <div class="row">',
    '   <button class="b" id="check">Check (read-only)</button>',
    '   <button class="b pri" id="run" disabled>Run</button>',
    '   <button class="b warn" id="stop" disabled>Stop</button>',
    '   <span class="hint" id="sum"></span>',
    '  </div>',
    '  <div id="msg"></div>',
    '  <div id="tblwrap" hidden><table><thead><tr><th>#</th><th>PC No.</th><th>Payee</th><th>Amount</th>',
    '   <th>Now at</th><th>To</th><th>Status</th></tr></thead><tbody id="tb"></tbody></table></div>',
    '  <div class="row" id="after" hidden>',
    '   <button class="b" id="csv">Download results CSV</button>',
    '   <button class="b" id="logcsv">Download log CSV</button>',
    '   <button class="b" id="reload">Reload DTMS page</button>',
    '   <button class="b pri" id="sync" hidden>Sync to Sheet</button>',
    '  </div>',
    '  <details><summary>Log</summary><pre id="log"></pre></details>',
    '  <details id="settings"><summary>Settings</summary>',
    '   <div class="hint">Station names that mean <i>us</i> (one per line). "Not yet received by" any of these is fixed by receiving.</div>',
    '   <textarea id="aliases" style="min-height:48px"></textarea>',
    '   <div class="row"><label>Delay between requests (ms) <input id="delay" type="number" min="0" step="50" style="width:80px"></label></div>',
    '   <div class="hint">Google Sheet queue (optional): the web app URL and API token from the Sheet\'s <i>DTMS Batch → Set up</i> menu.</div>',
    '   <div class="row"><input id="qurl" placeholder="https://script.google.com/macros/s/…/exec" style="flex:1"></div>',
    '   <div class="row"><input id="qtoken" type="password" placeholder="API token" style="flex:1" autocomplete="off"></div>',
    '   <div class="row"><button class="b" id="save">Save settings</button><button class="b" id="qtest">Test queue connection</button></div>',
    '  </details>',
    ' </div>',
    '</div>'
  ].join('\n');

  function $(id) { return root.getElementById(id); }
  var el = {
    st: $('st'), dest: $('dest'), inp: $('inp'), check: $('check'), run: $('run'), stop: $('stop'),
    sum: $('sum'), msg: $('msg'), tblwrap: $('tblwrap'), tb: $('tb'), after: $('after'), csv: $('csv'),
    logcsv: $('logcsv'), reload: $('reload'), log: $('log'), aliases: $('aliases'), delay: $('delay'), save: $('save'),
    loadq: $('loadq'), connect: $('connect'), settings: $('settings'), sync: $('sync'), qurl: $('qurl'), qtoken: $('qtoken'), qtest: $('qtest')
  };

  var station = core.parseStation(document) || '?';
  el.st.textContent = 'Station: ' + station;
  el.aliases.value = settings.aliases.join('\n');
  el.delay.value = settings.delayMs;
  el.qurl.value = settings.queueUrl;
  el.qtoken.value = settings.queueToken;

  var stations = core.DEFAULT_STATIONS;
  function fillStations(list) {
    stations = list;
    var cur = el.dest.value || settings.defaultDest;
    el.dest.textContent = '';
    var blank = document.createElement('option');
    blank.value = ''; blank.textContent = '— choose —';
    el.dest.appendChild(blank);
    list.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.code; o.textContent = s.label + ' (' + s.code + ')';
      el.dest.appendChild(o);
    });
    el.dest.value = cur && list.some(function (s) { return s.code === cur; }) ? cur : '';
  }
  fillStations(stations);

  // ---------- state ----------

  var items = [], ctx = null, checkedKey = null, running = false, stopRequested = false;
  var queued = {};            // pcn -> { id, batchId } for items loaded from the Sheet
  var pendingReport = null;   // a report the Sheet hasn't accepted yet
  var stationsSynced = false;
  var syncErrorMsg = null;

  function queue() {
    return settings.queueUrl && settings.queueToken
      ? queueApi.createQueueClient(settings.queueUrl, settings.queueToken) : null;
  }
  function showQueueUi() { el.loadq.hidden = !queue(); el.connect.hidden = !!queue(); }
  showQueueUi();

  function inputKey() { return el.dest.value + '\u0000' + el.inp.value; }

  function setMsg(kind, text) {
    el.msg.textContent = '';
    if (!text) return;
    var d = document.createElement('div');
    d.className = 'msg ' + kind;
    d.textContent = text;
    el.msg.appendChild(d);
  }

  function addMsg(kind, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + kind;
    d.textContent = text;
    el.msg.appendChild(d);
    return d;
  }

  function labelOf(code) {
    for (var i = 0; i < stations.length; i++) if (stations[i].code === code) return stations[i].label;
    return code;
  }

  var PLAN_TEXT = {
    RECEIVE_FORWARD: 'Will receive, then forward', FORWARD: 'Will forward',
    FORWARD_WARN: '⚠ Will try to forward', ALREADY_THERE: '✓ Already there',
    NOT_FOUND: '❔ Not found', BAD_DEST: '✖ Bad destination'
  };
  var STATUS_TEXT = {
    RECEIVED: '⏳ Received, forwarding…', FORWARDED: '✅ Forwarded', BLOCKED: '⛔ Blocked',
    FAILED: '❌ Failed', RECEIVE_FAILED: '❌ Receive failed', NOT_FOUND: '❔ Not found', SKIPPED: '– Skipped'
  };

  function statusText(it) {
    if (it.status === 'FORWARDED' && it.message) return '✅ ' + it.message;
    var t = it.status === 'PENDING' ? (PLAN_TEXT[it.plan] || '…') : (STATUS_TEXT[it.status] || it.status);
    return it.message ? t + ': ' + it.message : t;
  }

  function td(text, cls) {
    var c = document.createElement('td');
    if (cls) c.className = cls;
    c.textContent = text == null ? '' : text;
    return c;
  }

  function render() {
    el.tb.textContent = '';
    items.forEach(function (it, i) {
      var tr = document.createElement('tr');
      tr.className = it.status + (it._busy ? ' busy' : '');
      var nowAt = it.info.lastLocation ? it.info.lastLocation + (it.info.notYetReceived ? ' (not yet received)' : '') : '';
      [td(i + 1), td(it.pcn, 'n'), td(it.info.client), td(it.info.amount, 'n'), td(nowAt),
        td(labelOf(it.dest) + ' (' + it.dest + ')'), td(statusText(it))].forEach(function (c) { tr.appendChild(c); });
      el.tb.appendChild(tr);
    });
    el.tblwrap.hidden = !items.length;
    var counts = {};
    items.forEach(function (it) {
      var k = it.status === 'PENDING' ? it.plan : it.status;
      counts[k] = (counts[k] || 0) + 1;
    });
    el.sum.textContent = Object.keys(counts).map(function (k) { return counts[k] + ' ' + k.toLowerCase().replace(/_/g, ' '); }).join(' · ');
  }

  function appendLog(row) {
    el.log.textContent += row.ts.slice(11, 19) + '  ' + (row.pcn || '-----------') + '  ' + row.step + ' ' + row.result +
      (row.detail ? '  ' + row.detail : '') + '\n';
    el.log.scrollTop = el.log.scrollHeight;
  }

  function setBusy(on) {
    running = on;
    el.check.disabled = on;
    el.run.disabled = on || !canRun();
    el.stop.disabled = !on;
    el.inp.disabled = on;
    el.dest.disabled = on;
    el.loadq.disabled = on;
    el.sync.disabled = on;
  }

  function canRun() {
    return checkedKey === inputKey() && items.some(function (it) { return core.RUNNABLE[it.plan] && !core.TERMINAL[it.status]; });
  }

  function newCtx() {
    return core.createContext({
      http: core.browserHttp(),
      aliases: settings.aliases,
      delayMs: Number(settings.delayMs) || 0,
      onItem: function () { render(); },
      onLog: appendLog,
      shouldStop: function () { return stopRequested; }
    });
  }

  function handleError(e) {
    if (e instanceof core.SessionExpiredError) {
      setMsg('err', e.message + '\nLogging in reloads this page and closes the panel; click the bookmarklet again afterwards. Items already done are detected on the next Check.');
    } else if (e instanceof core.StoppedError) {
      setMsg('info', 'Stopped. Nothing further was sent. Run Check again to see where things stand.');
    } else {
      setMsg('err', 'Stopped on an unexpected problem: ' + (e && e.message || e));
    }
    if (ctx) ctx.logRows.push({ ts: new Date().toISOString(), station: ctx.station || '', pcn: '', step: 'error', result: e && e.name || 'Error', detail: e && e.message || String(e) });
  }

  // ---------- actions ----------

  async function doCheck() {
    if (running) return;
    var parsed = core.parseInput(el.inp.value, el.dest.value, stations);
    if (parsed.errors.length) { setMsg('err', parsed.errors.join('\n')); }
    else setMsg('', '');
    if (!parsed.items.length) {
      if (!parsed.errors.length) setMsg('err', 'Enter at least one PC No.');
      items = []; render(); return;
    }
    items = parsed.items;
    items.forEach(function (it) {
      var q = queued[it.pcn];
      if (q) { it.queueId = q.id; it.batchId = q.batchId; }
    });
    stopRequested = false;
    ctx = newCtx();
    el.log.textContent = '';
    render();
    setBusy(true);
    try {
      await core.check(ctx, items);
      if (ctx.stations) fillStations(ctx.stations);
      checkedKey = inputKey();
      var n = items.filter(function (it) { return core.RUNNABLE[it.plan]; }).length;
      if (!parsed.errors.length) {
        setMsg(n ? 'info' : 'ok', n ? 'Check done. Nothing was changed in DTMS. Review the plan, then click Run.' : 'Nothing to do.');
      }
      el.after.hidden = false;
      uploadStations();
    } catch (e) {
      handleError(e);
      checkedKey = null;
    } finally {
      setBusy(false);
      render();
    }
  }

  async function doRun() {
    if (running || !canRun()) return;
    var runnable = items.filter(function (it) { return core.RUNNABLE[it.plan] && !core.TERMINAL[it.status]; });
    var rec = runnable.filter(function (it) { return it.plan === 'RECEIVE_FORWARD'; }).length;
    if (!confirm('DTMS Batch will now:\n\n• receive ' + rec + ' document(s)\n• forward ' + runnable.length +
      ' document(s)\n\nas ' + station + '. Continue?')) return;
    stopRequested = false;
    ctx.requests = 0;
    setBusy(true);
    try {
      await core.run(ctx, items);
      var bad = items.filter(function (it) { return /BLOCKED|FAILED|NOT_FOUND/.test(it.status); }).length;
      setMsg(bad ? 'err' : 'ok', bad ? 'Done, but ' + bad + ' item(s) need attention (red rows).' : 'Done. All items forwarded.');
    } catch (e) {
      handleError(e);
    } finally {
      checkedKey = null; // require a fresh Check before running again
      if (queue()) pendingReport = queueApi.buildReport(ctx.station || station, items, ctx.logRows);
      setBusy(false);
      render();
    }
    if (pendingReport) await syncReport();
  }

  async function syncReport() {
    var q = queue();
    if (!q || !pendingReport) return;
    el.sync.disabled = true;
    try {
      var r = await q.report(pendingReport);
      pendingReport.results.forEach(function (res) {
        if (core.TERMINAL[res.status]) delete queued[res.pcn];
      });
      pendingReport = null;
      el.sync.hidden = true;
      if (syncErrorMsg) { syncErrorMsg.remove(); syncErrorMsg = null; }
      addMsg('ok', 'Saved to the Sheet: ' + r.updated + ' updated, ' + r.added + ' added, ' + r.logged + ' log rows.' +
        (r.errors && r.errors.length ? ' Rejected: ' + r.errors.map(function (x) { return x.pcn + ' (' + x.error + ')'; }).join(', ') : ''));
    } catch (e) {
      el.sync.hidden = false;
      el.sync.disabled = false;
      if (syncErrorMsg) syncErrorMsg.remove();
      syncErrorMsg = addMsg('err', 'Could not save to the Sheet: ' + e.message + '\nDTMS is already updated. Click "Sync to Sheet" to try again (keep this panel open).');
    }
  }

  async function loadQueue() {
    var q = queue();
    if (!q || running) return;
    el.loadq.disabled = true;
    try {
      var data = await q.pending('', station);
      var present = {};
      core.parseInput(el.inp.value, el.dest.value || 'X', stations).items.forEach(function (it) { present[it.pcn] = true; });
      var lines = [], skipped = 0;
      data.items.forEach(function (it) {
        queued[it.pcn] = { id: it.id, batchId: it.batchId };
        if (present[it.pcn]) { skipped++; return; }
        present[it.pcn] = true;
        lines.push(it.pcn + ' ' + it.destCode);
      });
      if (lines.length) el.inp.value = el.inp.value.replace(/\s*$/, '') + (el.inp.value.trim() ? '\n' : '') + lines.join('\n') + '\n';
      setMsg('info', data.items.length
        ? 'Loaded ' + lines.length + ' item(s) from the queue' + (skipped ? ' (' + skipped + ' already listed)' : '') + '. Click Check.'
        : 'The queue has no pending items for ' + station + '.');
      el.run.disabled = running || !canRun();
    } catch (e) {
      setMsg('err', e.message);
    } finally {
      el.loadq.disabled = false;
    }
  }

  function uploadStations() {
    var q = queue();
    if (!q || stationsSynced || !ctx || !ctx.stations) return;
    q.setStations(ctx.stations, ctx.station).then(function () { stationsSynced = true; }, function (e) {
      appendLog({ ts: new Date().toISOString(), pcn: '', step: 'queue', result: 'WARN', detail: 'Station list not uploaded: ' + e.message });
    });
  }

  function download(name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }

  el.check.addEventListener('click', doCheck);
  el.loadq.addEventListener('click', loadQueue);
  el.connect.addEventListener('click', function () {
    el.settings.open = true;
    el.qurl.scrollIntoView({ block: 'center' });
    el.qurl.focus();
  });
  el.sync.addEventListener('click', syncReport);
  el.qtest.addEventListener('click', function () {
    var url = el.qurl.value.trim(), token = el.qtoken.value.trim();
    if (!url || !token) { setMsg('err', 'Enter both the web app URL and the token.'); return; }
    queueApi.createQueueClient(url, token).ping().then(function (r) {
      setMsg('ok', 'Queue reachable (web app v' + r.version + '). Click Save settings to keep it.');
    }, function (e) { setMsg('err', e.message); });
  });
  el.run.addEventListener('click', doRun);
  el.stop.addEventListener('click', function () { stopRequested = true; el.stop.disabled = true; });
  el.inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCheck(); } });
  el.inp.addEventListener('input', function () { el.run.disabled = running || !canRun(); });
  el.dest.addEventListener('change', function () {
    settings.defaultDest = el.dest.value; saveSettings();
    el.run.disabled = running || !canRun();
  });
  el.csv.addEventListener('click', function () {
    download('dtms-batch-results-' + stamp() + '.csv', core.toCsv(items.map(function (it) {
      return {
        pcn: it.pcn, destination: labelOf(it.dest), destCode: it.dest, plan: it.plan, status: it.status,
        message: it.message, payee: it.info.client, amount: it.info.amount, lastLocation: it.info.lastLocation, attempts: it.attempts
      };
    }), ['pcn', 'destination', 'destCode', 'plan', 'status', 'message', 'payee', 'amount', 'lastLocation', 'attempts']));
  });
  el.logcsv.addEventListener('click', function () {
    download('dtms-batch-log-' + stamp() + '.csv', core.toCsv(ctx ? ctx.logRows : [], ['ts', 'station', 'pcn', 'step', 'result', 'detail']));
  });
  el.reload.addEventListener('click', function () {
    if (!running) location.reload();
  });
  $('min').addEventListener('click', function () { host.style.display = 'none'; });
  el.save.addEventListener('click', function () {
    settings.aliases = el.aliases.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    settings.delayMs = Math.max(0, Number(el.delay.value) || 0);
    settings.queueUrl = el.qurl.value.trim();
    settings.queueToken = el.qtoken.value.trim();
    if (settings.queueUrl && !/^(https:\/\/script\.google(usercontent)?\.com\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(settings.queueUrl)) {
      setMsg('err', 'The queue URL should start with https://script.google.com/');
      return;
    }
    saveSettings();
    showQueueUi();
    setMsg('ok', 'Settings saved for this browser.');
  });

  window.addEventListener('beforeunload', function (e) {
    if (running || pendingReport) { e.preventDefault(); e.returnValue = ''; }
  });

  el.inp.focus();
})();
