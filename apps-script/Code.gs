/**
 * DTMS Batch: queue API (Phase 2).
 *
 * Bound to the "DTMS Batch" Google Sheet. The Sheet is the queue and the audit log:
 *   Queue     one row per voucher to process (PC No. + destination + status)
 *   Log       append-only record of every DTMS action the desk panel took
 *   Stations  DTMS "Forwarded to" options, uploaded by the panel
 *
 * The desk panel (bookmarklet on http://192.168.1.220) calls doPost with a
 * shared token. This deployment must be "Execute as: Me" and "Who has access:
 * Anyone". Only PC Nos., station codes and statuses are stored; no payee
 * names or amounts.
 */

const VERSION = '0.2.0';

const TABLES = {
  queue: {
    name: 'Queue',
    headers: ['id', 'batchId', 'pcn', 'destCode', 'destLabel', 'status', 'attempts', 'message',
      'source', 'scannedBy', 'scannedAt', 'updatedAt', 'processedBy'],
    // Kept as text so Sheets never turns a PC No. into 2.03E+10 or a batch id into a date.
    textColumns: ['id', 'batchId', 'pcn', 'destCode', 'destLabel']
  },
  log: {
    name: 'Log',
    headers: ['ts', 'station', 'batchId', 'pcn', 'step', 'result', 'detail'],
    textColumns: ['batchId', 'pcn']
  },
  stations: {
    name: 'Stations',
    headers: ['code', 'label', 'updatedAt'],
    textColumns: ['code', 'label']
  }
};

const PCN_RE = /^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}$/;
const OPEN = { PENDING: true, RECEIVED: true };
const STATUSES = ['PENDING', 'RECEIVED', 'FORWARDED', 'BLOCKED', 'NOT_FOUND', 'FAILED', 'RECEIVE_FAILED', 'SKIPPED'];
const SOURCES = ['desk', 'phone-manual', 'phone-ocr', 'qr'];
const MAX_ITEMS = 500;

// ---------- Sheet menu & setup ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('DTMS Batch')
    .addItem('Set up / show API token', 'setup')
    .addItem('Re-queue selected rows', 'requeueSelected')
    .addSeparator()
    .addItem('Rotate API token', 'rotateToken')
    .addToUi();
}

/** Creates the tabs (idempotent) and makes sure a token exists. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();

  Object.keys(TABLES).forEach(function (key) {
    const t = TABLES[key];
    let sh = ss.getSheetByName(t.name);
    if (!sh) sh = ss.insertSheet(t.name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, t.headers.length).setValues([t.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    t.textColumns.forEach(function (h) {
      sh.getRange(1, t.headers.indexOf(h) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });
  addStatusColours_(ss.getSheetByName(TABLES.queue.name));

  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', newToken_());
  showToken_('DTMS Batch is set up.');
}

function rotateToken() {
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', newToken_());
  showToken_('New token created. Paste it into the DTMS Batch panel settings; the old one no longer works.');
}

/** Sets the selected Queue rows back to PENDING so the desk panel picks them up again. */
function requeueSelected() {
  const range = SpreadsheetApp.getActiveRange();
  const sh = range.getSheet();
  if (sh.getName() !== TABLES.queue.name) {
    SpreadsheetApp.getUi().alert('Select rows on the "' + TABLES.queue.name + '" tab first.');
    return;
  }
  withLock_(function () {
    const table = readTable_('queue');
    const first = Math.max(range.getRow(), 2), last = range.getLastRow();
    table.rows.forEach(function (r) {
      if (r.row >= first && r.row <= last && r.obj.pcn) {
        r.obj.status = 'PENDING';
        r.obj.message = 'Re-queued';
        r.obj.updatedAt = new Date();
        writeRow_(table, r);
      }
    });
  });
}

// ---------- HTTP ----------

function doGet() {
  return json_({ ok: true, service: 'dtms-batch', version: VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'Request body must be JSON' });
  }
  if (!tokenOk_(req.token)) return json_({ ok: false, error: 'Unauthorized: wrong or missing token' });
  try {
    return json_(handle_(req));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function handle_(req) {
  switch (req.op) {
    case 'ping': return { ok: true, version: VERSION };
    case 'pending': return pending_(req.batchId);
    case 'enqueue': return withLock_(function () { return enqueue_(req.items, req.user || '', 'desk'); });
    case 'report': return withLock_(function () { return report_(req); });
    case 'setStations': return withLock_(function () { return setStations_(req.stations); });
    default: throw new Error('Unknown op: ' + req.op);
  }
}

// ---------- operations ----------

function pending_(batchId) {
  const items = readTable_('queue').rows
    .filter(function (r) { return OPEN[r.obj.status] && r.obj.pcn && (!batchId || r.obj.batchId === batchId); })
    .sort(function (a, b) { return time_(a.obj.scannedAt) - time_(b.obj.scannedAt) || a.row - b.row; })
    .map(function (r) {
      const o = r.obj;
      return {
        id: o.id, batchId: o.batchId, pcn: o.pcn, destCode: o.destCode, destLabel: o.destLabel,
        status: o.status, attempts: Number(o.attempts) || 0, source: o.source,
        scannedBy: o.scannedBy, scannedAt: iso_(o.scannedAt)
      };
    });
  return { ok: true, items: items };
}

/**
 * Adds items [{pcn, destCode, batchId?, source?}]. An open row for the same
 * PC No. is updated (new destination) instead of duplicated; a PC No. whose
 * earlier row is finished gets a fresh row.
 */
function enqueue_(items, user, defaultSource) {
  if (!Array.isArray(items) || !items.length) throw new Error('No items');
  if (items.length > MAX_ITEMS) throw new Error('Too many items (max ' + MAX_ITEMS + ')');
  const table = readTable_('queue');
  const labels = stationLabels_();
  const now = new Date();
  const result = { ok: true, added: [], updated: [], duplicates: [], errors: [] };
  const fresh = [];

  items.forEach(function (it) {
    const pcn = String(it && it.pcn || '').trim();
    const dest = String(it && it.destCode || '').trim().toUpperCase();
    if (!PCN_RE.test(pcn)) { result.errors.push({ pcn: pcn, error: 'Not a valid PC No.' }); return; }
    if (!validDest_(dest, labels)) { result.errors.push({ pcn: pcn, error: 'Unknown station code ' + dest }); return; }

    const open = findOpen_(table, pcn) || fresh.find(function (o) { return o.pcn === pcn; });
    if (open) {
      const o = open.obj || open;
      if (o.destCode === dest) { result.duplicates.push({ pcn: pcn, id: o.id }); return; }
      o.destCode = dest;
      o.destLabel = labels[dest] || '';
      o.updatedAt = now;
      if (open.obj) writeRow_(table, open);
      result.updated.push({ pcn: pcn, id: o.id });
      return;
    }
    const row = {
      id: newId_(), batchId: String(it.batchId || defaultBatch_(now)), pcn: pcn, destCode: dest,
      destLabel: labels[dest] || '', status: 'PENDING', attempts: 0, message: '',
      source: SOURCES.indexOf(it.source) >= 0 ? it.source : defaultSource,
      scannedBy: user, scannedAt: now, updatedAt: now, processedBy: ''
    };
    fresh.push(row);
    result.added.push({ pcn: pcn, id: row.id });
  });

  appendRows_(table, fresh);
  return result;
}

/**
 * Records a desk run: {station, results:[{id?, pcn, destCode, status, message, attempts, batchId?}], log:[...]}.
 * Rows are matched by id, then by an open row for the PC No.; anything else
 * (typed at the desk) is added with source "desk".
 */
function report_(req) {
  const station = String(req.station || '');
  const results = Array.isArray(req.results) ? req.results : [];
  const logRows = Array.isArray(req.log) ? req.log : [];
  if (results.length > MAX_ITEMS || logRows.length > MAX_ITEMS * 20) throw new Error('Report too large');

  const table = readTable_('queue');
  const labels = stationLabels_();
  const now = new Date();
  const out = { ok: true, updated: 0, added: 0, logged: 0, errors: [] };
  const fresh = [];

  results.forEach(function (r) {
    const pcn = String(r && r.pcn || '');
    if (!PCN_RE.test(pcn)) { out.errors.push({ pcn: pcn, error: 'Not a valid PC No.' }); return; }
    if (STATUSES.indexOf(r.status) < 0) { out.errors.push({ pcn: pcn, error: 'Unknown status ' + r.status }); return; }
    const dest = String(r.destCode || '').toUpperCase();
    const fields = {
      status: r.status, message: String(r.message || '').slice(0, 500),
      attempts: Number(r.attempts) || 0, updatedAt: now, processedBy: station
    };
    const hit = (r.id && table.rows.find(function (x) { return x.obj.id === r.id; })) || findOpen_(table, pcn);
    if (hit) {
      Object.assign(hit.obj, fields);
      if (dest && dest !== hit.obj.destCode) { hit.obj.destCode = dest; hit.obj.destLabel = labels[dest] || ''; }
      writeRow_(table, hit);
      out.updated++;
      return;
    }
    fresh.push(Object.assign({
      id: newId_(), batchId: String(r.batchId || defaultBatch_(now)), pcn: pcn, destCode: dest,
      destLabel: labels[dest] || '', source: 'desk', scannedBy: station, scannedAt: now
    }, fields));
    out.added++;
  });
  appendRows_(table, fresh);

  const log = readTable_('log', true);
  appendRows_(log, logRows.map(function (l) {
    return {
      ts: l.ts ? new Date(l.ts) : now, station: String(l.station || station), batchId: String(l.batchId || ''),
      pcn: String(l.pcn || ''), step: String(l.step || ''), result: String(l.result || ''),
      detail: String(l.detail || '').slice(0, 500)
    };
  }));
  out.logged = logRows.length;
  return out;
}

function setStations_(stations) {
  if (!Array.isArray(stations) || !stations.length || stations.length > 200) throw new Error('Bad station list');
  const clean = stations.map(function (s) {
    const code = String(s && s.code || '').trim();
    if (!/^[A-Za-z0-9]{1,8}$/.test(code)) throw new Error('Bad station code ' + code);
    return { code: code, label: String(s.label || '').slice(0, 120) };
  });
  const sh = sheet_('stations');
  const n = TABLES.stations.headers.length;
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, n).clearContent();
  const now = new Date();
  sh.getRange(2, 1, clean.length, n).setValues(clean.map(function (s) { return [s.code, s.label, now]; }));
  return { ok: true, count: clean.length };
}

// ---------- table helpers ----------

function sheet_(key) {
  // Bound script: the web app also sees its own spreadsheet as "active".
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABLES[key].name);
  if (!sh) throw new Error('Missing "' + TABLES[key].name + '" tab. Run DTMS Batch → Set up in the Sheet.');
  return sh;
}

/** Reads a tab into {sheet, headers, rows:[{row, obj}]}. Columns are matched by header name. */
function readTable_(key, headersOnly) {
  const sh = sheet_(key);
  const want = TABLES[key].headers;
  const lastRow = sh.getLastRow();
  const headers = lastRow ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
  want.forEach(function (h) {
    if (headers.indexOf(h) < 0) throw new Error('Column "' + h + '" missing on tab ' + TABLES[key].name);
  });
  const rows = [];
  if (!headersOnly && lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function (vals, i) {
      const obj = {};
      headers.forEach(function (h, c) { obj[h] = vals[c]; });
      ['id', 'pcn', 'destCode', 'batchId', 'status'].forEach(function (k) { if (k in obj) obj[k] = String(obj[k]); });
      rows.push({ row: i + 2, obj: obj });
    });
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function rowValues_(table, obj) {
  return table.headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; });
}

function writeRow_(table, r) {
  table.sheet.getRange(r.row, 1, 1, table.headers.length).setValues([rowValues_(table, r.obj)]);
}

function appendRows_(table, objs) {
  if (!objs.length) return;
  const start = table.sheet.getLastRow() + 1;
  table.sheet.getRange(start, 1, objs.length, table.headers.length)
    .setValues(objs.map(function (o) { return rowValues_(table, o); }));
  objs.forEach(function (o, i) { table.rows.push({ row: start + i, obj: o }); });
}

function findOpen_(table, pcn) {
  for (let i = table.rows.length - 1; i >= 0; i--) {
    const o = table.rows[i].obj;
    if (o.pcn === pcn && OPEN[o.status]) return table.rows[i];
  }
  return null;
}

function stationLabels_() {
  const labels = {};
  readTable_('stations').rows.forEach(function (r) { if (r.obj.code) labels[String(r.obj.code).toUpperCase()] = String(r.obj.label); });
  return labels;
}

function validDest_(code, labels) {
  return Object.keys(labels).length ? !!labels[code] : /^[A-Z0-9]{2,8}$/.test(code);
}

function addStatusColours_(sh) {
  const col = TABLES.queue.headers.indexOf('status') + 1;
  const range = sh.getRange(2, col, sh.getMaxRows() - 1, 1);
  const rule = function (text, colour) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(colour).setRanges([range]).build();
  };
  sh.setConditionalFormatRules([
    rule('FORWARDED', '#d9f2e3'), rule('PENDING', '#fff4cc'), rule('RECEIVED', '#fff4cc'),
    rule('BLOCKED', '#f9d6d5'), rule('FAILED', '#f9d6d5'), rule('RECEIVE_FAILED', '#f9d6d5'), rule('NOT_FOUND', '#f9d6d5')
  ]);
}

// ---------- small helpers ----------

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function tokenOk_(token) {
  const want = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!want || typeof token !== 'string' || token.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function newId_() { return 'q_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function defaultBatch_(d) { return Utilities.formatDate(d, 'Asia/Manila', 'yyyyMMdd-HHmm'); }
function time_(v) { return v instanceof Date ? v.getTime() : (Date.parse(v) || 0); }
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function showToken_(title) {
  const token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const msg = title + '\n\nAPI token (paste into DTMS Batch → Settings):\n' + token +
    '\n\nThen: Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone. Copy the web app URL into the same Settings.';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}
