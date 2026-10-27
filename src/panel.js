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
  var SETTINGS_KEY = 'dtmsBatch.settings';

  var existing = document.getElementById(HOST_ID);
  if (existing) { existing.style.display = existing.style.display === 'none' ? '' : 'none'; return; }

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
    '.hd b{font-size:14px}.hd .st{opacity:.85;font-size:12px;flex:1}',
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
    ' <div class="hd"><b>DTMS Batch</b><span class="st" id="st"></span>',
    '  <button id="min" title="Hide (click the bookmarklet again to show)">–</button></div>',
    ' <div class="bd">',
    '  <div class="row"><label>Default destination <select id="dest"></select></label>',
    '   <button class="b" id="loadq" hidden title="Add pending items from the Google Sheet queue">Load queue</button></div>',
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
    '  <details><summary>Settings</summary>',
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
    loadq: $('loadq'), sync: $('sync'), qurl: $('qurl'), qtoken: $('qtoken'), qtest: $('qtest')
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
  function showQueueUi() { el.loadq.hidden = !queue(); }
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
      var data = await q.pending();
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
        : 'The queue has no pending items.');
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
    q.setStations(ctx.stations).then(function () { stationsSynced = true; }, function (e) {
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
