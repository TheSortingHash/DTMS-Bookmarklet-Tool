// Minimal in-memory stand-ins for the Apps Script services used by
// apps-script/Code.gs, so the real file runs unmodified under Node (vm).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some(v => v.length !== this.nc)) {
      throw new Error(`setValues: data is ${values.length}x${values[0] && values[0].length}, range is ${this.nr}x${this.nc}`);
    }
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      line.forEach((v, c) => {
        // Sheets coerces numeric-looking strings unless the column is text-formatted.
        const col = this.col + c;
        this.sheet.data[idx][col - 1] = (typeof v === 'string' && /^\d+$/.test(v) && !this.sheet.textCols.has(col)) ? Number(v) : v;
      });
    });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.nr; r++) {
      const line = this.sheet.data[this.row - 1 + r];
      if (line) for (let c = 0; c < this.nc; c++) line[this.col - 1 + c] = '';
    }
    while (this.sheet.data.length && this.sheet.data[this.sheet.data.length - 1].every(v => v === '' || v === undefined)) this.sheet.data.pop();
    return this;
  }
  setNumberFormat(f) { if (f === '@') for (let c = 0; c < this.nc; c++) this.sheet.textCols.add(this.col + c); return this; }
  setFontWeight() { return this; }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getLastRow() { return this.row + this.nr - 1; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.textCols = new Set(); this.rules = []; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getRange(row, col, nr = 1, nc = 1) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`Bad range ${row},${col},${nr},${nc}`);
    return new FakeRange(this, row, col, nr, nc);
  }
  setFrozenRows() { return this; }
  setConditionalFormatRules(r) { this.rules = r; }
  // Test helper: rows as objects keyed by header.
  objects() {
    const [h, ...rows] = this.data;
    return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
  }
}

function loadGas({ activeUser = 'staff@example.com', owner = 'owner@example.com' } = {}) {
  const sheets = new Map();
  const ss = {
    getId: () => 'sheet-id',
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new FakeSheet(n); sheets.set(n, s); return s; }
  };
  const props = new Map();
  let activeRange = null;
  const builder = () => {
    const b = new Proxy({}, { get: (_, k) => (k === 'build' ? () => ({}) : () => b) });
    return b;
  };
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getActiveRange: () => activeRange,
      getUi: () => { throw new Error('No UI in tests'); },
      newConditionalFormatRule: builder
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
          .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s })
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => activeUser }),
      getEffectiveUser: () => ({ getEmail: () => owner })
    },
    HtmlService: {
      createHtmlOutputFromFile: name => {
        const out = { file: name, title: '', meta: {} };
        out.setTitle = t => { out.title = t; return out; };
        out.addMetaTag = (k, v) => { out.meta[k] = v; return out; };
        return out;
      }
    },
    Logger: { log() {} },
    Date, JSON, Math, String, Number, Array, Object, Error
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

  // Calls doPost the way the web app runtime does and returns parsed JSON.
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent());
  const token = () => props.get('API_TOKEN');
  const setActiveRange = r => { activeRange = r; };
  // Switches who is "signed in" for google.script.run-style calls.
  const signIn = email => { activeUser = email; };
  return { gas: ctx, ss, sheets, props, post, token, setActiveRange, signIn };
}

module.exports = { loadGas, FakeSheet };
