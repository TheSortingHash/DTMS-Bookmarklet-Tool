# DTMS Batch

Batch **receive** and **forward** for DAP's Document Tracking and Monitoring System (`http://192.168.1.220/dtms/`).
Type, scan or paste a stack of PC Nos., each with its destination station. The tool ticks and receives them, forwards each one, and retries any that DTMS says are "not yet received".

It runs entirely in your browser, on the DTMS page and under your existing login. Nothing leaves the office network. See [PLAN.md](PLAN.md) for the design and the roadmap (Google Sheet queue, phone scanner).

## Install

1. Download [`dist/install.html`](dist/install.html) and open it in Chrome.
2. Drag the **DTMS Batch** button to the bookmarks bar.

## First time: run the read-only probe (Phase 0)

Before relying on the panel, confirm it reads your live pages correctly:

1. Log in to DTMS and open any DTMS page.
2. Open DevTools (`⌥⌘J` on Mac, `Ctrl+Shift+J` on Windows) and go to the **Console**.
3. Paste the contents of [`dist/probe-console.js`](dist/probe-console.js) and press Enter.
4. Enter 3–5 PC Nos. you have on hand, e.g. `20261021033 JD00, 20261021037 JE04`.

It prints a table: payee, last location, whether it's in your receive list, and the plan. **It cannot change anything**, because its transport refuses to POST. If a row looks wrong, send the table.

## Daily use (Phase 1)

1. Open any DTMS page while logged in and click **DTMS Batch**. A panel appears at the top right.
2. Pick a **Default destination**.
3. Enter PC Nos., one per line. Add a station code to override the default for that line:
   ```
   20261021033 JD00
   20261021037
   20261022025 JE04
   ```
   A USB or Bluetooth barcode scanner works too: it types into the box like a keyboard.
4. Click **Check (read-only)** (or press `Ctrl+Enter`). Nothing is changed yet. Each row shows payee, amount, current location and the plan:
   - *Will receive, then forward*: it's in your receive list.
   - *Will forward*: already received.
   - *⚠ Will try to forward*: it's sitting "not yet received" at another station, so DTMS will probably refuse.
   - *✓ Already there* / *❔ Not found* / *✖ Bad destination*.
5. Click **Run** and confirm. The tool:
   1. ticks every listed item on the receive page and submits **YES!** once, then re-reads the list to confirm;
   2. forwards each item via **Update Location**, and checks that the new location took;
   3. if DTMS answers *"not yet received by OMD-Finance Signatory/Department"*, receives it and tries again (up to 2 retries).
6. Red rows need you. **Download results CSV** / **Download log CSV** keep a record.

**Stop** halts after the current request. **Check** again at any time: items already forwarded show as *Already there*, so re-running a batch is safe.

If your DTMS session expires, the tool stops and says so. Log in, click the bookmarklet again, and **Check**.

### What it never does
- Tick **CLOSE Transaction** or fill the **reason** box. Close and return-to-requestor stay manual.
- Run while logged in as a different station than the one it checked with.
- Send more than one request at a time. There's a 300 ms gap between requests, adjustable under *Settings*.

### Settings
*Settings → station names that mean "us"* defaults to `OMD-Finance Department` and `OMD-Finance Signatory`. Settings are stored in this browser only.

## Development

```
npm install
npm test          # parser + batch-flow tests against fixtures of the real DTMS pages (jsdom)
npm run build     # writes dist/ (commit it: dist/install.html is what users install)
npm run e2e       # builds, then runs the bookmarklet in Chromium against a fake DTMS (needs playwright)
```

| Path | What |
|---|---|
| `src/core.js` | Page parsers, form serializer, check/receive/forward/run. No UI. |
| `src/panel.js` | The injected panel (shadow DOM, so DTMS's CSS can't touch it). |
| `src/probe.js` | Phase 0 read-only console probe. |
| `test/fixtures.js` | DTMS page templates, trimmed from pages captured 2026-10-27. |
| `test/fake-dtms.js` | Stateful fake DTMS used by tests. |
| `scripts/build.js` | Bundles `src/` into `dist/`. |
