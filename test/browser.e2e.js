// End-to-end: runs the built bookmarklet in Chromium against the fake DTMS
// served over HTTP at /dtms/index.php. Run with `npm run e2e` after `npm run build`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { createFakeDtms } = require('./fake-dtms');
const { receiveListPage } = require('./fixtures');

const fake = createFakeDtms([
  { pcn: '20261021001', loc: 'JE05', received: false, client: 'DELA CRUZ, JUAN A.', amount: '300.00' },
  { pcn: '20261021002', loc: 'JE04' },
  { pcn: '20261021003', loc: 'JE04', received: false },
  { pcn: '20261021004', loc: 'ACC', client: 'PEÑA, ANA D.' }
]);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (!req.url.startsWith('/dtms/index.php')) { res.writeHead(404); return res.end(); }
    const params = req.method === 'POST' ? new URLSearchParams(body) : null;
    if (params) fake.posts.push({ url: req.url, body, contentType: req.headers['content-type'] });
    const html = req.method === 'GET' && req.url === '/dtms/index.php'
      ? receiveListPage([]) : fake.handle(req.method, req.url, params);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', d => d.accept());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(base + '/dtms/index.php?task=41&id=R');
  const bm = fs.readFileSync(path.join(__dirname, '..', 'dist', 'bookmarklet.txt'), 'utf8').trim();
  await page.evaluate(code => (0, eval)(code), decodeURIComponent(bm.slice('javascript:'.length)));

  const panel = page.locator('#dtms-batch-panel');
  await panel.locator('#dest').selectOption('JD00');
  await panel.locator('#inp').fill('20261021001\n20261021002 JE04\n20261021003\n20261021004 TR3\n20261021099');
  await panel.locator('#check').click();
  await panel.locator('#msg .msg').waitFor();
  console.log('after check:', await panel.locator('#sum').textContent());
  assert.equal(fake.posts.length, 0, 'check must not POST');
  assert.equal(await panel.locator('#run').isEnabled(), true);

  await panel.locator('#run').click();
  await page.waitForFunction(() => {
    const r = document.getElementById('dtms-batch-panel').shadowRoot;
    return /Done/.test(r.getElementById('msg').textContent);
  });
  const rows = await panel.locator('#tb tr').evaluateAll(trs => trs.map(tr => [tr.cells[1].textContent, tr.cells[2].textContent, tr.cells[6].textContent]));
  console.table(rows);
  console.log('summary:', await panel.locator('#sum').textContent());

  assert.match(rows[0][2], /Forwarded/);
  assert.match(rows[1][2], /Already at Pre-Audit/);
  assert.match(rows[2][2], /Blocked: Documents were not yet received by Pre-Audit/);
  assert.match(rows[3][2], /Forwarded to TREASURY \(CHK PREP\)/);
  assert.equal(rows[3][1], 'PEÑA, ANA D.');
  assert.match(rows[4][2], /Not found/);
  assert.equal(fake.db.get('20261021001').loc, 'JD00');
  assert.equal(fake.db.get('20261021004').loc, 'TR3');
  for (const p of fake.posts) assert.match(p.contentType, /application\/x-www-form-urlencoded/);
  assert.deepEqual(errors, []);

  await page.screenshot({ path: process.env.SHOT || path.join(require('os').tmpdir(), 'dtms-batch-e2e.png') });
  await browser.close();
  server.close();
  console.log('e2e OK');
})().catch(e => { console.error(e); process.exit(1); });
