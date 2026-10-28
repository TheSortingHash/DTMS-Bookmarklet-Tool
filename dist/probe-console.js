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
 * Phase 0 probe: paste into the browser console on any logged-in DTMS page.
 * Read-only by construction: the transport it uses refuses to POST.
 * Prints what DTMS Batch would do for the PC Nos. you enter.
 */
(async function () {
  'use strict';
  var core = window.DTMSCore;
  var input = prompt('DTMS probe (read-only)\nPC Nos., each optionally followed by a station code, e.g.\n20261021033 JD00, 20261021037 JE04\n(no code = JD00)', '');
  if (!input) return;
  var parsed = core.parseInput(input.replace(/,\s*(?=20\d{9})/g, '\n'), 'JD00');
  parsed.errors.forEach(function (e) { console.warn('[probe]', e); });

  var http = core.browserHttp();
  var readOnly = { get: http.get, post: function () { throw new Error('probe is read-only'); } };
  var ctx = core.createContext({ http: readOnly, onLog: function (r) { console.log('[probe]', r.pcn, r.step, r.result, r.detail); } });

  try {
    await core.check(ctx, parsed.items);
  } catch (e) {
    console.error('[probe] stopped:', e.message);
    return;
  }

  var rl = core.parseReceiveList(core.parseHtml((await http.get(core.URLS.receiveList)).text));
  console.log('[probe] station:', ctx.station, '| receive list rows:', rl.rows.size, '| live stations:', (ctx.stations || []).length);
  console.table(parsed.items.map(function (it) {
    return {
      pcn: it.pcn, payee: it.info.client, amount: it.info.amount,
      lastLocation: it.info.lastLocation, notYetReceived: it.info.notYetReceived, currentCode: it.info.currentCode,
      inReceiveList: it.inReceiveList, dest: it.dest, plan: it.plan, note: it.message
    };
  }));
  console.log('[probe] Nothing was changed in DTMS. Copy this table into the chat if anything looks wrong.');
})();
