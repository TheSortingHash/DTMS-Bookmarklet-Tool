const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

global.DOMParser = new JSDOM('').window.DOMParser;

const core = require('../src/core');
const { receiveListPage, updatePage, loginPage } = require('./fixtures');
const { createFakeDtms } = require('./fake-dtms');

const doc = html => core.parseHtml(html);

const SIGNATORY_ERROR = updatePage({
  ipcn: '20261021037',
  rec: {
    pcn: '20261021037', client: 'SANTOS, MARIA B.', amount: '17,286.82',
    lastLocation: 'OMD-Finance Signatory', notYetReceived: true, currentCode: 'JE05'
  },
  oops: 'Documents were not yet received by OMD-Finance Signatory!'
});

const ADMIN_SUCCESS = updatePage({
  ipcn: '20261021033',
  rec: {
    pcn: '20261021033', client: 'BAUTISTA, JOSE C.', amount: '4,311.85',
    lastLocation: 'OMD-Administrative Department', notYetReceived: true, currentCode: 'JD00'
  }
});

test('reads station and detects the login page', () => {
  assert.equal(core.parseStation(doc(ADMIN_SUCCESS)), 'OMD-Finance Department');
  assert.equal(core.isLoginPage(doc(ADMIN_SUCCESS)), false);
  assert.equal(core.isLoginPage(doc(loginPage())), true);
  assert.equal(core.parseStation(doc(loginPage())), null);
});

test('maps PC No. to its ACK checkbox on the receive list', () => {
  const rl = core.parseReceiveList(doc(receiveListPage([
    { pcn: '20260907021', payee: 'DELA CRUZ, JUAN A.', amount: '300.00' },
    { pcn: '20261021037', payee: 'SANTOS, MARIA B.', amount: '17,286.82' }
  ])));
  assert.equal(rl.rows.size, 2);
  assert.equal(rl.rows.get('20261021037').name, 'act[2]');
  assert.equal(rl.rows.get('20261021037').payee, 'SANTOS, MARIA B.');
  assert.equal(rl.rows.has(''), false, 'Select ALL box is not a row');
});

test('parses the "not yet received" error page', () => {
  const info = core.parseUpdatePage(doc(SIGNATORY_ERROR));
  assert.equal(info.found, true);
  assert.equal(info.pcn, '20261021037');
  assert.equal(info.lastLocation, 'OMD-Finance Signatory');
  assert.equal(info.notYetReceived, true);
  assert.equal(info.currentCode, 'JE05');
  assert.equal(info.notReceivedBy, 'OMD-Finance Signatory');
  assert.equal(info.options.length, 27);
});

test('parses the successful forward page', () => {
  const info = core.parseUpdatePage(doc(ADMIN_SUCCESS));
  assert.equal(info.oops, null);
  assert.equal(info.currentCode, 'JD00');
  assert.equal(info.lastLocation, 'OMD-Administrative Department');
  assert.equal(info.client, 'BAUTISTA, JOSE C.');
});

test('serializes the update form like a browser, including stray hidden fields', () => {
  const p = core.serializeForm(core.parseUpdatePage(doc(ADMIN_SUCCESS)).form);
  assert.equal(p.get('task'), '3');
  assert.equal(p.get('status'), 'B');
  assert.equal(p.get('refind'), '');
  assert.equal(p.get('ipcn'), '20261021033');
  assert.equal(p.get('ilocate'), 'JD00');
  assert.equal(p.get('reason'), '');
  assert.equal(p.has('close'), false);
  assert.equal(p.has('iUpdate'), false);
  assert.equal(p.has('iSearch'), false);
});

test('parses desk input lines', () => {
  const { items, errors } = core.parseInput([
    '20261021033 JD00',
    '20261021037',
    '20261022025, 20261026012 je04',
    '20261021033',
    '2026102103',
    '20261021034 XX99'
  ].join('\n'), 'JE04');
  assert.deepEqual(items.map(i => [i.pcn, i.dest]), [
    ['20261021033', 'JD00'], ['20261021037', 'JE04'], ['20261022025', 'JE04'], ['20261026012', 'JE04'],
    ['20261021034', 'JE04']
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /duplicate/);
  assert.match(errors[1], /not a valid PC No/);
  assert.match(errors[2], /unknown station code "XX99"/);
});

function setup(records, opts) {
  const fake = createFakeDtms(records, opts);
  const ctx = core.createContext({ http: fake.http, delayMs: 0 });
  return { fake, ctx };
}

test('check plans each item without writing anything', async () => {
  const { fake, ctx } = setup([
    { pcn: '20261021001', loc: 'JE05', received: false },
    { pcn: '20261021002', loc: 'JE04' },
    { pcn: '20261021003', loc: 'JE04', received: false },
    { pcn: '20261021004', loc: 'ACC' }
  ]);
  const { items } = core.parseInput([
    '20261021001 JD00', '20261021002 JE04', '20261021003 JD00', '20261021004 TR3', '20261021099 JD00'
  ].join('\n'));
  await core.check(ctx, items);
  assert.deepEqual(items.map(i => i.plan), ['RECEIVE_FORWARD', 'ALREADY_THERE', 'FORWARD_WARN', 'FORWARD', 'NOT_FOUND']);
  assert.equal(ctx.station, 'OMD-Finance Department');
  assert.equal(fake.posts.length, 0);
});

test('run receives, forwards, retries and reports per item', async () => {
  const { fake, ctx } = setup([
    { pcn: '20261021001', loc: 'JE05', received: false },   // in receive list
    { pcn: '20261021002', loc: 'JE04' },                    // already at destination
    { pcn: '20261021003', loc: 'JE04', received: false },   // stuck at another station
    { pcn: '20261021004', loc: 'ACC' },                     // plain forward
    { pcn: '20261021005', loc: 'ACC' }                      // will be sent back to us mid-run
  ]);
  const { items } = core.parseInput([
    '20261021001 JD00', '20261021002 JE04', '20261021003 JD00', '20261021004 TR3', '20261021005 JE04', '20261021099 JD00'
  ].join('\n'));
  await core.check(ctx, items);

  // Someone forwards 005 to our station after the check: it now needs receiving first.
  Object.assign(fake.db.get('20261021005'), { loc: 'JE05', received: false });

  await core.run(ctx, items);
  const byPcn = Object.fromEntries(items.map(i => [i.pcn, i]));
  assert.equal(byPcn['20261021001'].status, 'FORWARDED');
  assert.equal(byPcn['20261021002'].status, 'FORWARDED');
  assert.match(byPcn['20261021002'].message, /Already at Pre-Audit/);
  assert.equal(byPcn['20261021003'].status, 'BLOCKED');
  assert.match(byPcn['20261021003'].message, /not yet received by Pre-Audit/);
  assert.equal(byPcn['20261021004'].status, 'FORWARDED');
  assert.equal(byPcn['20261021005'].status, 'FORWARDED');
  assert.equal(byPcn['20261021005'].attempts, 2);
  assert.equal(byPcn['20261021099'].status, 'NOT_FOUND');

  assert.equal(fake.db.get('20261021001').loc, 'JD00');
  assert.equal(fake.db.get('20261021004').loc, 'TR3');
  assert.equal(fake.db.get('20261021005').loc, 'JE04');

  const receives = fake.posts.filter(p => p.url.includes('task=41'));
  assert.equal(receives.length, 2);
  const first = new URLSearchParams(receives[0].body);
  assert.deepEqual([...first.keys()].filter(k => k.startsWith('act[')), ['act[1]']);
  assert.equal(first.get('iReceive'), 'YES!');
  assert.equal(first.get('task'), '41');
  assert.equal(first.has('chk[]'), false);

  for (const p of fake.posts.filter(p => p.url.includes('task=3'))) {
    const b = new URLSearchParams(p.body);
    assert.equal(b.get('iUpdate'), 'Update Location');
    assert.equal(b.get('status'), 'B');
    assert.equal(b.has('close'), false);
    assert.equal(b.getAll('ilocate').length, 1);
  }

  const again = core.parseInput('20261021001 JD00').items;
  await core.check(ctx, again);
  assert.equal(again[0].plan, 'ALREADY_THERE', 'a re-run is a no-op');
});

test('a document at our station that never shows up in the receive list ends BLOCKED', async () => {
  const { fake, ctx } = setup([{ pcn: '20261021006', loc: 'ACC' }]);
  const { items } = core.parseInput('20261021006 JD00');
  await core.check(ctx, items);
  // Forwarded to us, but hidden from the list (e.g. listed under another view).
  const rec = fake.db.get('20261021006');
  Object.assign(rec, { loc: 'JE05', received: false });
  const origGet = fake.http.get;
  fake.http.get = async url => url.includes('task=41')
    ? { url, text: receiveListPage([]) } : origGet(url);

  await core.run(ctx, items);
  assert.equal(items[0].status, 'BLOCKED');
  assert.equal(items[0].attempts, 3);
  assert.equal(fake.posts.length, 0, 'never posts an update DTMS would refuse');
});

test('stops on session expiry', async () => {
  const { ctx } = setup([{ pcn: '20261021004', loc: 'ACC' }], { expireAfter: 2 });
  const { items } = core.parseInput('20261021004 TR3');
  await core.check(ctx, items);
  await assert.rejects(core.run(ctx, items), core.SessionExpiredError);
  assert.equal(items[0].status, 'PENDING');
});

test('stops when the user asks', async () => {
  let stop = false;
  const fake = createFakeDtms([{ pcn: '20261021004', loc: 'ACC' }]);
  const ctx = core.createContext({ http: fake.http, delayMs: 0, shouldStop: () => stop });
  const { items } = core.parseInput('20261021004 TR3');
  await core.check(ctx, items);
  stop = true;
  await assert.rejects(core.run(ctx, items), core.StoppedError);
  assert.equal(fake.posts.length, 0);
});
