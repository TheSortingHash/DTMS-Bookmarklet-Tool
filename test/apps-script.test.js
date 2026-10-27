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
