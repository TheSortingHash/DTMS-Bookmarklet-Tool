// End-to-end for Phase 2: the built bookmarklet in Chromium, a fake DTMS on one
// origin, and the real apps-script/Code.gs behind a fake Apps Script endpoint
// on another origin. The endpoint mimics Google's: POST /exec answers 302 to a
// googleusercontent-style URL that serves the JSON, both with ACAO: *.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { createFakeDtms } = require('./fake-dtms');
const { loadGas } = require('./gas-fakes');

const fake = createFakeDtms([
  { pcn: '20261021001', loc: 'JE05', received: false },
  { pcn: '20261021002', loc: 'ACC' },
  { pcn: '20261021003', loc: 'JE04', received: false },
  { pcn: '20261021004', loc: 'ACC' }
]);

const g = loadGas();
g.gas.setup();
const phone = g.post({
  op: 'enqueue', token: g.token(), items: [
    { pcn: '20261021001', destCode: 'JD00', batchId: 'B1', source: 'phone-ocr' },
    { pcn: '20261021002', destCode: 'TR3', batchId: 'B1', source: 'phone-manual' },
    { pcn: '20261021003', destCode: 'JD00', batchId: 'B1', source: 'phone-ocr' }
  ]
});
assert.equal(phone.added.length, 3);

function listen(handler) {
  return new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
}
const body = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b)); });

(async () => {
  const dtms = await listen(async (req, res) => {
    const b = await body(req);
    if (!req.url.startsWith('/dtms/index.php')) { res.writeHead(404); return res.end(); }
    const params = req.method === 'POST' ? new URLSearchParams(b) : null;
    if (params) fake.posts.push({ url: req.url, body: b });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fake.handle(req.method, req.url, params));
  });

  const stash = new Map();
  const seen = { options: 0, posts: 0 };
  let failNextReport = true;
  const gasServer = await listen(async (req, res) => {
    const b = await body(req);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'OPTIONS') { seen.options++; res.writeHead(405); return res.end(); }
    if (req.method === 'POST' && req.url === '/macros/s/TEST/exec') {
      seen.posts++;
      let out;
      if (failNextReport && JSON.parse(b).op === 'report') {
        failNextReport = false;
        out = JSON.stringify({ ok: false, error: 'Service invoked too many times (simulated)' });
      } else {
        out = g.gas.doPost({ postData: { contents: b } }).getContent();
      }
      const id = String(stash.size + 1);
      stash.set(id, out);
      res.writeHead(302, { ...cors, Location: '/macros/echo?user_content_key=' + id });
      return res.end();
    }
    if (req.method === 'GET' && req.url.startsWith('/macros/echo')) {
      const id = new URL(req.url, 'http://x').searchParams.get('user_content_key');
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(stash.get(id));
    }
    res.writeHead(404); res.end();
  });

  const dtmsBase = `http://127.0.0.1:${dtms.address().port}`;
  const queueUrl = `http://127.0.0.1:${gasServer.address().port}/macros/s/TEST/exec`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', d => d.accept());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(dtmsBase + '/dtms/index.php?task=41&id=R');
  const bm = fs.readFileSync(path.join(__dirname, '..', 'dist', 'bookmarklet.txt'), 'utf8').trim();
  await page.evaluate(code => (0, eval)(code), decodeURIComponent(bm.slice('javascript:'.length)));
  const panel = page.locator('#dtms-batch-panel');
  const msg = () => panel.locator('#msg').textContent();

  assert.equal(await panel.locator('#loadq').isVisible(), false, 'Load queue hidden until configured');
  await panel.locator('summary', { hasText: 'Settings' }).click();
  await panel.locator('#qurl').fill(queueUrl);
  await panel.locator('#qtoken').fill('wrong-token');
  await panel.locator('#qtest').click();
  await page.waitForFunction(() => /Unauthorized/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));
  await panel.locator('#qtoken').fill(g.token());
  await panel.locator('#qtest').click();
  await page.waitForFunction(() => /Queue reachable/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));
  await panel.locator('#save').click();
  assert.equal(await panel.locator('#loadq').isVisible(), true);

  await panel.locator('#inp').fill('20261021004 JE04\n');
  await panel.locator('#loadq').click();
  await page.waitForFunction(() => /Loaded 3/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));
  assert.equal(await panel.locator('#inp').inputValue(), '20261021004 JE04\n20261021001 JD00\n20261021002 TR3\n20261021003 JD00\n');

  await panel.locator('#check').click();
  await page.waitForFunction(() => /Check done/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));
  await panel.locator('#run').click();

  // First report fails (simulated quota error) -> Sync button appears.
  await page.waitForFunction(() => /Could not save to the Sheet/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));
  assert.equal(await panel.locator('#sync').isVisible(), true);
  assert.equal(g.sheets.get('Queue').objects().filter(r => r.status === 'PENDING').length, 3, 'nothing written yet');
  await panel.locator('#sync').click();
  await page.waitForFunction(() => /Saved to the Sheet/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));
  console.log((await msg()).replace(/\n/g, ' | '));

  const rows = g.sheets.get('Queue').objects();
  console.table(rows.map(r => ({ pcn: r.pcn, dest: r.destCode, status: r.status, source: r.source, batch: r.batchId, message: r.message })));
  const by = Object.fromEntries(rows.map(r => [r.pcn, r]));
  assert.equal(by['20261021001'].status, 'FORWARDED');
  assert.equal(by['20261021001'].batchId, 'B1');
  assert.equal(by['20261021002'].status, 'FORWARDED');
  assert.equal(by['20261021003'].status, 'BLOCKED');
  assert.equal(by['20261021004'].status, 'FORWARDED');
  assert.equal(by['20261021004'].source, 'desk');
  assert.equal(by['20261021001'].processedBy, 'OMD-Finance Department');
  assert.equal(rows.length, 4);
  assert.equal(g.sheets.get('Stations').objects().length, 27, 'live station list uploaded');
  const log = g.sheets.get('Log').objects();
  assert.ok(log.length >= 8, 'log rows written');
  assert.ok(log.every(l => !/BAUTISTA|4,311/.test(JSON.stringify(l))), 'no payee or amount in the Sheet');
  assert.equal(seen.options, 0, 'no CORS preflight');
  assert.equal(fake.db.get('20261021001').loc, 'JD00');
  assert.deepEqual(errors, []);

  // Queue is drained: Load queue now finds nothing.
  await panel.locator('#loadq').click();
  await page.waitForFunction(() => /no pending items/.test(document.getElementById('dtms-batch-panel').shadowRoot.getElementById('msg').textContent));

  await page.screenshot({ path: process.env.SHOT || path.join(require('os').tmpdir(), 'dtms-queue-e2e.png') });
  await browser.close();
  dtms.close();
  gasServer.close();
  console.log('queue e2e OK');
})().catch(e => { console.error(e); process.exit(1); });
