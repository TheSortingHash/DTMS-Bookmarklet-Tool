// End-to-end for Phase 3: apps-script/Scanner.html on an emulated iPhone, with
// google.script.run bridged to the real Code.gs (under test/gas-fakes.js) and
// the Tesseract CDN files served from node_modules. Run after `npm run build`.
//   REAL_PHOTO=/path/to/photo.jpg REAL_PCN=20261027009  also reads a real photo.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { chromium, devices } = require('playwright');
const { loadGas } = require('./gas-fakes');

const root = path.join(__dirname, '..');
const nm = p => path.join(root, 'node_modules', p);
const CDN = [
  [/tesseract\.js@5\.1\.1\/dist\/(.+)$/, m => nm('tesseract.js/dist/' + m[1])],
  [/tesseract\.js-core@5\.1\.1\/(.+)$/, m => nm('tesseract.js-core/' + m[1])],
  [/@tesseract\.js-data\/eng\/4\.0\.0_best_int\/(.+)$/, m => nm('@tesseract.js-data/eng/4.0.0_best_int/' + m[1])]
];

const g = loadGas({ activeUser: 'staff@example.com', owner: 'owner@example.com' });
g.gas.setup();
g.post({ op: 'setStations', token: g.token(), desk: 'OMD-Finance Department', stations: [
  { code: 'JD00', label: 'OMD-Administrative Department' }, { code: 'JE04', label: 'Pre-Audit' }, { code: 'TR3', label: 'TREASURY (CHK PREP)' }
] });
g.props.set('API_URL', 'https://script.google.com/macros/s/API/exec');

let offline = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url === '/scanner') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(root, 'apps-script', 'Scanner.html')));
    }
    if (req.url === '/rpc') {
      const { fn, args } = JSON.parse(body);
      if (offline && fn === 'scannerEnqueue') { res.writeHead(503); return res.end(); }
      let out;
      try { out = { ok: true, value: JSON.parse(JSON.stringify(g.gas[fn](...args) ?? null)) }; }
      catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404); res.end();
  });
});

// Mimics google.script.run: chainable handlers, any other property is a server function.
const shim = () => {
  function runner(ok, fail) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'withSuccessHandler') return f => runner(f, fail);
        if (prop === 'withFailureHandler') return f => runner(ok, f);
        return (...args) => fetch('/rpc', { method: 'POST', body: JSON.stringify({ fn: prop, args }) })
          .then(r => { if (!r.ok) throw new Error('NetworkError: Connection failure due to HTTP ' + r.status); return r.json(); })
          .then(j => (j.ok ? ok && ok(j.value) : fail && fail(new Error(j.error))), e => fail && fail(e));
      }
    });
  }
  window.google = { script: { run: runner() } };
};

// A DV laid out like dvoucher1.php (made-up payee), photographed at a slight angle.
const DV = pcn => `<html><body style="margin:0;background:#ddd;padding:40px">
<div style="transform:rotate(-3deg);background:#fff;width:760px;padding:20px;font-family:Arial">
<div style="text-align:center;font-weight:bold">DISBURSEMENT VOUCHER</div>
<table cellspacing="0" cellpadding="3" border="1" width="740" style="font-size:12px;border-collapse:collapse">
<tr><td>Payment:</td><td>CHECK</td><td>Project Code:</td><td>BEGDJ</td><td>DTS No:</td><td>---</td>
<td><b>DV No.</b></td><td><b>26109998</b></td><td>Date:</td><td>October 27, 2026</td></tr>
<tr><td><b>Payee:</b></td><td colspan="5">DELA CRUZ, JUAN A.</td><td>BUS No.</td><td>PP26109998</td><td>PC No:</td><td>${pcn}</td></tr>
<tr><td><b>Address:</b></td><td colspan="7">1 SAMPLE STREET QUEZON CITY</td><td>TIN No:</td><td>203-012-150-000</td></tr>
<tr><td colspan="8">[Honoraria] [2026-09-11] to [2026-09-21]</td><td colspan="2" align="right">17,286.82</td></tr>
</table></div></body></html>`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // Make the "photo".
  const cam = await browser.newPage({ viewport: { width: 860, height: 330 }, deviceScaleFactor: 2 });
  await cam.setContent(DV('20261021037'));
  const shot = path.join(os.tmpdir(), 'dtms-dv-photo.jpg');
  await cam.screenshot({ path: shot, type: 'jpeg', quality: 70 });
  await cam.close();

  const context = await browser.newContext({ ...devices['iPhone 13'] });
  await context.route('https://cdn.jsdelivr.net/**', route => {
    const url = route.request().url();
    for (const [re, file] of CDN) {
      const m = url.match(re);
      if (m && fs.existsSync(file(m))) {
        const f = file(m);
        const type = f.endsWith('.js') ? 'application/javascript' : f.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
      }
    }
    return route.fulfill({ status: 404, body: 'not mapped: ' + url });
  });
  await context.addInitScript(shim);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const toast = async re => page.waitForFunction(r => new RegExp(r).test(document.getElementById('toast').textContent), re.source);

  await page.goto(base + '/scanner');
  await page.waitForFunction(() => document.getElementById('who').textContent.includes('@'));
  assert.equal(await page.locator('#who').textContent(), 'staff@example.com');
  assert.equal(await page.locator('#desk').inputValue(), 'OMD-Finance Department');
  assert.equal(await page.locator('#photoBtn').isVisible(), true, 'photo button on a phone');

  // Typing.
  await page.locator('#dest').selectOption('JD00');
  await page.locator('#pcn').fill('2026102103');
  await page.locator('#add').click();
  await toast(/11 digits/);
  await page.locator('#pcn').fill('2026 1021 033');
  await page.locator('#pcn').press('Enter');
  await toast(/Queued 2026 1021 033/);
  assert.equal(await page.locator('#pcn').inputValue(), '', 'input cleared for the next one');
  await page.locator('#pcn').fill('20261021033');
  await page.locator('#add').click();
  await toast(/already in the queue/);

  // Photo.
  await page.locator('#dest').selectOption('JE04');
  const t0 = Date.now();
  await page.locator('#photo').setInputFiles(shot);
  await page.locator('#cands button').first().waitFor({ timeout: 120000 });
  const cands = await page.locator('#cands button span').allTextContents();
  console.log('photo read in', Date.now() - t0, 'ms →', cands);
  assert.equal(cands[0], '2026 1021 037');
  await page.locator('#cands button').first().click();
  await toast(/Queued 2026 1021 037 → Pre-Audit/);

  if (process.env.REAL_PHOTO) {
    await page.locator('#photo').setInputFiles(process.env.REAL_PHOTO);
    await page.locator('#cands button, #photoStatus:has-text("No PC No.")').first().waitFor({ timeout: 120000 });
    const real = await page.locator('#cands button span').allTextContents();
    console.log('real photo →', real);
    if (process.env.REAL_PCN) assert.equal((real[0] || '').replace(/ /g, ''), process.env.REAL_PCN);
    await page.locator('#retake').waitFor();
    await page.evaluate(() => document.getElementById('photoBox').classList.add('hidden'));
  }

  // My scans + cancel.
  await page.locator('#mine .item').nth(1).waitFor();
  let rows = await page.locator('#mine .item').allTextContents();
  assert.equal(rows.length, 2);
  page.once('dialog', d => d.accept());
  await page.locator('#mine .item', { hasText: '2026 1021 033' }).locator('button.x').click();
  await toast(/Cancelled 2026 1021 033/);
  await page.waitForFunction(() => /Cancelled/.test(document.getElementById('mine').textContent));

  // Offline: kept on the phone, sent later.
  offline = true;
  await page.locator('#dest').selectOption('TR3');
  await page.locator('#pcn').fill('20261022025');
  await page.locator('#add').click();
  await toast(/saved on this phone/);
  assert.match(await page.locator('#outbox').textContent(), /1 scan\(s\) not sent yet/);
  offline = false;
  await page.locator('#outbox button').click();
  await toast(/Sent the saved scans/);
  assert.equal(await page.locator('#outbox').isVisible(), false);

  // Desk setup values for signed-in staff.
  await page.locator('#desksetup summary').click();
  await page.locator('#reveal').click();
  await page.locator('#apiUrl').waitFor();
  assert.equal(await page.locator('#apiUrl').textContent(), 'https://script.google.com/macros/s/API/exec');
  assert.equal(await page.locator('#apiToken').textContent(), g.token());

  // What the desk now loads.
  const pending = g.post({ op: 'pending', token: g.token(), desk: 'OMD-Finance Department' }).items;
  console.table(pending.map(i => ({ pcn: i.pcn, dest: i.destCode, source: i.source, by: i.scannedBy, desk: i.deskStation })));
  assert.deepEqual(pending.map(i => [i.pcn, i.destCode, i.source]), [
    ['20261021037', 'JE04', 'phone-ocr'], ['20261022025', 'TR3', 'phone-manual']
  ]);
  assert.deepEqual(errors, []);

  await page.screenshot({ path: process.env.SHOT || path.join(os.tmpdir(), 'dtms-scanner-e2e.png'), fullPage: true });

  // Signed-out / outside-domain visitors get a clear message and nothing else.
  g.signIn('');
  const p2 = await context.newPage();
  await p2.goto(base + '/scanner');
  await p2.waitForFunction(() => !document.getElementById('fatal').classList.contains('hidden'));
  assert.match(await p2.locator('#fatal').textContent(), /signed in to your DAP Google account/);

  await browser.close();
  server.close();
  console.log('scanner e2e OK');
})().catch(e => { console.error(e); process.exit(1); });
