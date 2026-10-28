const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./gas-fakes');

function ready() {
  const g = loadGas();
  g.gas.setup();
  return g;
}

const STATIONS = [{ code: 'JD00', label: 'OMD-Administrative Department' }, { code: 'JE04', label: 'Pre-Audit' }, { code: 'TR3', label: 'TREASURY (CHK PREP)' }];

test('setup creates the tabs, a token, and text-formatted id columns', () => {
  const g = ready();
  assert.deepEqual([...g.sheets.keys()], ['Queue', 'Log', 'Stations']);
  assert.equal(g.sheets.get('Queue').data[0][2], 'pcn');
  assert.match(g.token(), /^[0-9a-f]{64}$/);
  const t = g.token();
  g.gas.setup();
  assert.equal(g.token(), t, 'setup is idempotent and keeps the token');
  assert.equal(g.sheets.get('Queue').data.length, 1);
});

test('rejects bad tokens and bad bodies', () => {
  const g = ready();
  assert.match(g.post({ op: 'ping', token: 'nope' }).error, /Unauthorized/);
  assert.match(g.post({ op: 'ping' }).error, /Unauthorized/);
  assert.match(g.post('not json').error, /JSON/);
  assert.equal(g.post({ op: 'ping', token: g.token() }).ok, true);
  assert.match(g.post({ op: 'drop', token: g.token() }).error, /Unknown op/);
});

test('enqueue validates, dedupes open rows, and keeps PC Nos. as text', () => {
  const g = ready();
  g.post({ op: 'setStations', token: g.token(), stations: STATIONS });
  const r = g.post({
    op: 'enqueue', token: g.token(), items: [
      { pcn: '20261021033', destCode: 'jd00', batchId: '2026-10-27', source: 'phone-ocr' },
      { pcn: '20261021037', destCode: 'JE04' },
      { pcn: '20261021033', destCode: 'JD00' },
      { pcn: '2026102103', destCode: 'JD00' },
      { pcn: '20261021040', destCode: 'XX99' }
    ]
  });
  assert.equal(r.added.length, 2);
  assert.equal(r.duplicates.length, 1);
  assert.deepEqual(r.errors.map(e => e.error), ['Not a valid PC No.', 'Unknown station code XX99']);

  const rows = g.sheets.get('Queue').objects();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pcn, '20261021033', 'stored as text, not a number');
  assert.equal(rows[0].batchId, '2026-10-27');
  assert.equal(rows[0].destLabel, 'OMD-Administrative Department');
  assert.equal(rows[0].source, 'phone-ocr');
  assert.equal(rows[0].status, 'PENDING');
  assert.match(rows[1].batchId, /^\d{8}-\d{4}$/);

  const again = g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261021037', destCode: 'TR3' }] });
  assert.equal(again.updated.length, 1, 'new destination for an open row updates it');
  assert.equal(g.sheets.get('Queue').objects()[1].destCode, 'TR3');
});

test('pending lists open rows in scan order', () => {
  const g = ready();
  g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261021033', destCode: 'JD00' }, { pcn: '20261021037', destCode: 'JE04', batchId: 'B2' }] });
  const all = g.post({ op: 'pending', token: g.token() });
  assert.deepEqual(all.items.map(i => i.pcn), ['20261021033', '20261021037']);
  assert.equal(typeof all.items[0].scannedAt, 'string');
  assert.deepEqual(g.post({ op: 'pending', token: g.token(), batchId: 'B2' }).items.map(i => i.pcn), ['20261021037']);
});

test('report updates queued rows, adds desk rows, appends the log', () => {
  const g = ready();
  const added = g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261021033', destCode: 'JD00' }, { pcn: '20261021037', destCode: 'JE04' }] }).added;
  const r = g.post({
    op: 'report', token: g.token(), station: 'OMD-Finance Department',
    results: [
      { id: added[0].id, pcn: '20261021033', destCode: 'JD00', status: 'FORWARDED', message: 'Forwarded to OMD-Administrative Department', attempts: 1 },
      { pcn: '20261021037', destCode: 'JE04', status: 'BLOCKED', message: 'not yet received by Pre-Audit', attempts: 1 },
      { pcn: '20261026012', destCode: 'TR3', status: 'FORWARDED', message: 'typed at desk', attempts: 1 },
      { pcn: '20261026013', destCode: 'TR3', status: 'BOGUS' }
    ],
    log: [{ ts: '2026-10-27T08:00:00Z', pcn: '20261021033', step: 'forward', result: 'FORWARDED', detail: 'ok' }]
  });
  assert.deepEqual([r.updated, r.added, r.logged, r.errors.length], [2, 1, 1, 1]);

  const rows = g.sheets.get('Queue').objects();
  assert.deepEqual(rows.map(x => [x.pcn, x.status, x.source]), [
    ['20261021033', 'FORWARDED', 'desk'], ['20261021037', 'BLOCKED', 'desk'], ['20261026012', 'FORWARDED', 'desk']
  ]);
  assert.equal(rows[0].processedBy, 'OMD-Finance Department');
  assert.equal(g.post({ op: 'pending', token: g.token() }).items.length, 0);

  const log = g.sheets.get('Log').objects();
  assert.equal(log.length, 1);
  assert.equal(log[0].pcn, '20261021033');
  assert.equal(log[0].station, 'OMD-Finance Department');
  assert.ok(log[0].ts instanceof Date);

  // A finished PC No. scanned again gets a fresh row.
  const re = g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261021037', destCode: 'JE04' }] });
  assert.equal(re.added.length, 1);
});

test('setStations replaces the list and enables code validation', () => {
  const g = ready();
  g.post({ op: 'setStations', token: g.token(), stations: STATIONS });
  g.post({ op: 'setStations', token: g.token(), stations: STATIONS.slice(0, 2) });
  assert.deepEqual(g.sheets.get('Stations').objects().map(s => s.code), ['JD00', 'JE04']);
  assert.match(g.post({ op: 'setStations', token: g.token(), stations: [{ code: '<x>' }] }).error, /Bad station code/);
  const r = g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261021033', destCode: 'TR3' }] });
  assert.match(r.errors[0].error, /Unknown station code TR3/);
});

test('requeueSelected puts finished rows back to PENDING', () => {
  const g = ready();
  g.post({ op: 'report', token: g.token(), station: 'S', results: [
    { pcn: '20261021033', destCode: 'JD00', status: 'BLOCKED' }, { pcn: '20261021037', destCode: 'JD00', status: 'FORWARDED' }
  ] });
  g.setActiveRange(g.sheets.get('Queue').getRange(2, 1, 1, 3));
  g.gas.requeueSelected();
  assert.deepEqual(g.sheets.get('Queue').objects().map(r => r.status), ['PENDING', 'FORWARDED']);
  assert.deepEqual(g.post({ op: 'pending', token: g.token() }).items.map(i => i.pcn), ['20261021033']);
});

test('reads columns by header name, so reordered columns still work', () => {
  const g = ready();
  const q = g.sheets.get('Queue');
  const h = q.data[0];
  [h[0], h[2]] = [h[2], h[0]]; // swap id and pcn headers
  q.textCols.add(1);
  g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261021033', destCode: 'JD00' }] });
  assert.equal(q.data[1][0], '20261021033');
  assert.deepEqual(g.post({ op: 'pending', token: g.token() }).items.map(i => i.pcn), ['20261021033']);
});

// ---------- Phase 3: scanner functions ----------

// Values built inside the vm sandbox have that realm's prototypes; compare as plain JSON.
const plain = v => JSON.parse(JSON.stringify(v));

function withDesk() {
  const g = ready();
  g.post({ op: 'setStations', token: g.token(), desk: 'OMD-Finance Department', stations: STATIONS });
  return g;
}

test('scanner functions require a signed-in account from the deployer\'s domain', () => {
  const g = withDesk();
  g.signIn('');
  assert.throws(() => g.gas.scannerInit(), /signed in to your DAP Google account/);
  g.signIn('someone@gmail.com');
  assert.throws(() => g.gas.scannerEnqueue([{ pcn: '20261021033', destCode: 'JD00' }], 'OMD-Finance Department'), /Only example.com accounts/);
  g.signIn('Staff@Example.com');
  const init = g.gas.scannerInit();
  assert.equal(init.user, 'staff@example.com');
  assert.deepEqual(plain(init.desks), ['OMD-Finance Department']);
  assert.equal(init.stations.length, 3);
});

test('scans are routed to their desk; Load queue at a desk only sees its own work', () => {
  const g = withDesk();
  g.post({ op: 'setStations', token: g.token(), desk: 'OMD-Administrative Department', stations: STATIONS });
  const r = g.gas.scannerEnqueue([
    { pcn: '20261021033', destCode: 'JD00', source: 'phone-ocr' },
    { pcn: '20261021037', destCode: 'JE04', source: 'phone-manual' }
  ], 'OMD-Finance Department', '20261028-0930-staff');
  assert.equal(r.added.length, 2);
  g.gas.scannerEnqueue([{ pcn: '20261022025', destCode: 'TR3' }], 'OMD-Administrative Department', 'b2');
  g.post({ op: 'enqueue', token: g.token(), items: [{ pcn: '20261026012', destCode: 'TR3' }] }); // no desk

  const rows = g.sheets.get('Queue').objects();
  assert.equal(rows[0].scannedBy, 'staff@example.com');
  assert.equal(rows[0].source, 'phone-ocr');
  assert.equal(rows[0].deskStation, 'OMD-Finance Department');
  assert.equal(rows[0].batchId, '20261028-0930-staff');

  const fin = g.post({ op: 'pending', token: g.token(), desk: 'omd-finance department' }).items.map(i => i.pcn);
  assert.deepEqual(fin, ['20261021033', '20261021037', '20261026012']);
  const admin = g.post({ op: 'pending', token: g.token(), desk: 'OMD-Administrative Department' }).items.map(i => i.pcn);
  assert.deepEqual(admin, ['20261022025', '20261026012']);

  // Re-scanning an open PC No. for another desk moves it there.
  const moved = g.gas.scannerEnqueue([{ pcn: '20261021033', destCode: 'JD00' }], 'OMD-Administrative Department');
  assert.equal(moved.updated.length, 1);
  assert.equal(g.sheets.get('Queue').objects()[0].deskStation, 'OMD-Administrative Department');
});

test('scanner shows your own recent scans and lets you cancel pending ones', () => {
  const g = withDesk();
  const [a, b] = g.gas.scannerEnqueue([
    { pcn: '20261021033', destCode: 'JD00' }, { pcn: '20261021037', destCode: 'JE04' }
  ], 'OMD-Finance Department').added;
  g.signIn('other@example.com');
  g.gas.scannerEnqueue([{ pcn: '20261022025', destCode: 'TR3' }], 'OMD-Finance Department');
  assert.throws(() => g.gas.scannerCancel(a.id), /Not found among your scans/);

  g.signIn('staff@example.com');
  assert.deepEqual(plain(g.gas.scannerMine().map(m => m.pcn).sort()), ['20261021033', '20261021037']);
  g.post({ op: 'report', token: g.token(), station: 'OMD-Finance Department', results: [
    { id: b.id, pcn: '20261021037', destCode: 'JE04', status: 'FORWARDED', message: 'Forwarded to Pre-Audit', attempts: 1 }
  ] });
  assert.throws(() => g.gas.scannerCancel(b.id), /Already forwarded/);
  assert.equal(g.gas.scannerCancel(a.id).ok, true);
  const mine = Object.fromEntries(g.gas.scannerMine().map(m => [m.pcn, m.status]));
  assert.deepEqual(mine, { '20261021033': 'SKIPPED', '20261021037': 'FORWARDED' });
  assert.deepEqual(g.post({ op: 'pending', token: g.token(), desk: 'OMD-Finance Department' }).items.map(i => i.pcn), ['20261022025']);
});

test('desk setup info is only for signed-in staff', () => {
  const g = withDesk();
  g.props.set('API_URL', 'https://script.google.com/macros/s/X/exec');
  assert.deepEqual(plain(g.gas.scannerDeskSetup()), { apiUrl: 'https://script.google.com/macros/s/X/exec', token: g.token() });
  g.signIn('');
  assert.throws(() => g.gas.scannerDeskSetup(), /signed in/);
});

test('doGet serves the scanner page; ?ping answers JSON', () => {
  const g = ready();
  const page = g.gas.doGet({ parameter: {} });
  assert.equal(page.file, 'Scanner');
  assert.match(page.meta.viewport, /width=device-width/);
  assert.equal(JSON.parse(g.gas.doGet({ parameter: { ping: '1' } }).getContent()).version, '0.3.0');
});

test('a Phase 2 Sheet without the deskStation column is migrated in place', () => {
  const g = ready();
  const q = g.sheets.get('Queue');
  q.data[0] = q.data[0].filter(h => h !== 'deskStation');
  q.data.push(['q_old', 'B0', '20261020001', 'JD00', '', 'PENDING', 0, '', 'desk', 'x', new Date(), new Date(), '']);
  q.textCols.add(3);
  assert.deepEqual(g.post({ op: 'pending', token: g.token(), desk: 'OMD-Finance Department' }).items.map(i => i.pcn), ['20261020001']);
  assert.equal(q.data[0].at(-1), 'deskStation');
  g.gas.scannerEnqueue([{ pcn: '20261021033', destCode: 'JD00' }], 'OMD-Finance Department');
  assert.equal(q.objects()[1].deskStation, 'OMD-Finance Department');
});
