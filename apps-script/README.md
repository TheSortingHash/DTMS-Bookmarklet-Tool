# DTMS Batch: Google Sheet queue and scanner (Phases 2–3)

The Sheet is the queue and the audit log. Staff add PC Nos. with the **DTMS Scan** page (phone or PC). Each desk's panel loads *its own* pending vouchers, runs them in DTMS, and writes back what happened.

| Tab | What's in it |
|---|---|
| **Queue** | One row per voucher: `pcn`, `destCode`, `status`, `attempts`, `message`, `source`, who scanned it, when, which desk should process it (`deskStation`) and which did (`processedBy`) |
| **Log** | Append-only: every receive/forward step the panel took, with timestamps |
| **Stations** | DTMS's "Forwarded to" list, uploaded by the panel after each Check |

Only PC Nos., station codes and statuses are stored. Payee names and amounts never leave DTMS.

## Updating from Phase 2 (you already have the Sheet and the API deployment)

1. In the Apps Script editor, replace `Code.gs` and `appsscript.json` with the new versions. Add a new HTML file: *＋ → HTML*, name it exactly `Scanner`, and replace its contents with [`Scanner.html`](Scanner.html). Save.
2. In the Sheet, reload, then run *DTMS Batch → Set up / show API token* once. It asks you to approve one new permission (your email address, used to record who scanned what). The token stays the same.
3. **Update the API deployment:** *Deploy → Manage deployments → ✏️ (the "Anyone" one) → Version: New version → Deploy*. The URL doesn't change.
4. **Create the scanner deployment:** *Deploy → New deployment → Web app*:
   - Description: `DTMS Scan`
   - Execute as: **Me**
   - Who has access: **Anyone within Development Academy of the Philippines** (your DAP domain)
   - *Deploy*, then copy this second URL. This is the link staff open on their phones.
5. In the Sheet: *DTMS Batch → Set desk API web app URL…* and paste the **API** URL (the "Anyone" one, not the scanner one). Staff setting up a PC can then copy it, with the token, from the scanner page.
6. On each desk PC, re-install the bookmark from `dist/install.html` (v0.3.0), open DTMS, and click **Check** once. That registers the desk so it appears in the scanner's *For desk* list. Existing queue rows get the new `deskStation` column automatically.

## One-time setup from scratch (≈15 minutes)

1. **Create the Sheet.** In Google Drive (your DAP account): *New → Google Sheets*, name it `DTMS Batch`.
2. **Add the script.** *Extensions → Apps Script*. In the editor:
   - Replace the contents of `Code.gs` with [`Code.gs`](Code.gs).
   - *＋ → HTML*, name it `Scanner`, and replace its contents with [`Scanner.html`](Scanner.html).
   - *Project Settings (⚙) → Show "appsscript.json" manifest file in editor*, then replace `appsscript.json` with [`appsscript.json`](appsscript.json).
   - Save (💾).
3. **Run setup.** Back in the Sheet, reload the page. A **DTMS Batch** menu appears. Choose *DTMS Batch → Set up / show API token*. Approve the permission prompt: the script asks only for access to *this* spreadsheet. A dialog shows the **API token**; copy it.
   The `Queue`, `Log` and `Stations` tabs are created. You can delete the empty `Sheet1`.
4. **Deploy the web app.** In the Apps Script editor: *Deploy → New deployment → ⚙ Select type → Web app*.
   - Description: `DTMS Batch API`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - *Deploy*, then copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
5. **Connect the panel.** On DTMS, open the DTMS Batch panel → **Connect Google Sheet**: paste the web app URL and the token → **Test queue connection** → **Save settings**. A **Load queue** button appears next to the destination picker. Click **Check** once to register the desk.
6. **Deploy the scanner** and store the API URL: steps 4–5 of *Updating from Phase 2* above.

Settings are saved in that browser only; repeat step 5 on each PC that runs the panel.

### Why "Anyone"?
The panel runs on `http://192.168.1.220`. Browsers won't reliably send your Google login along with requests from that page to Google, so a DAP-only web app would answer with a login page. The token takes the place of the login. Every request must carry it, and requests without it are refused. If the token leaks, use *DTMS Batch → Rotate API token* and paste the new one into each panel.

## DTMS Scan (the scanner page)

Share the **scanner deployment URL** with staff. They open it in the phone's browser (or on a PC) while signed in to their DAP Google account. Bookmark it, or use *Add to Home Screen*.

1. **For desk:** the DTMS station whose PC will receive and forward these. It's remembered on that device.
2. **Send to:** the destination station. It stays selected, so set it once for a run of vouchers going to the same place.
3. **Add PC Nos.:**
   - **Type** it and press *Add* or Enter. Use this for handwritten PC Nos. that don't have a DV yet. Spaces are ignored, and invalid numbers (wrong length, impossible date) are rejected on the spot.
   - **📷 Read PC No. from photo** (phones): fill the frame with the DV's *PC No.* box. The page shows the number(s) it read; **tap the one that matches the paper** to add it. Nothing is added without that tap. The first use downloads the reader (≈5 MB); after that it's cached.
4. **My scans** shows your last 24 hours with live status: *Waiting at desk → Forwarded* (or *Blocked* with the reason). **Cancel** withdraws a scan the desk hasn't processed yet.
5. **No signal?** Scans are kept on the phone and sent automatically when the connection returns, or with *Send now*.

Only signed-in accounts in the DAP domain can use it. On the "Anyone" API deployment the page loads but refuses to do anything.

## Daily use at the desk

- At the desk: **Load queue** → the PC Nos. scanned *for this desk* (plus any not assigned to a desk) are added to the panel's box with their destinations → **Check** → **Run**. Results are saved to the Sheet automatically. If saving fails (network, quota), DTMS is already updated; click **Sync to Sheet** to retry before closing the panel.
- PC Nos. typed straight into the panel are recorded too, as `source = desk`.
- **Retry a blocked voucher:** select its row(s) on the Queue tab → *DTMS Batch → Re-queue selected rows*. They go back to `PENDING` and show up at the next Load queue.
- Status colours on the Queue tab: green = forwarded, yellow = pending/received, red = needs attention.

## Updating the script later

Paste the new `Code.gs` / `Scanner.html`, then for **each** deployment (API and scanner): *Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy*. This keeps both URLs. Creating a *new* deployment instead would give a new URL.

`Scanner.html` is generated by `npm run build` from `src/scanner.html`; edit the source, not the generated file.

## API (for reference)

All calls are `POST <web app URL>` with a `text/plain` JSON body that includes `"token"`.

| `op` | Body | Returns |
|---|---|---|
| `ping` | – | `{ok, version}` |
| `pending` | `batchId?`, `desk?` (that desk's rows plus unassigned ones) | `{ok, items:[{id, batchId, pcn, destCode, destLabel, status, attempts, source, scannedBy, scannedAt}]}` |
| `enqueue` | `items:[{pcn, destCode, batchId?, source?}]`, `user?` | `{ok, added, updated, duplicates, errors}` |
| `report` | `station`, `results:[{id?, pcn, destCode, status, message, attempts, batchId?}]`, `log:[…]` | `{ok, updated, added, logged, errors}` |
| `setStations` | `stations:[{code, label}]`, `desk?` (registers the desk for the scanner) | `{ok, count}` |

The scanner page calls `scannerInit`, `scannerEnqueue`, `scannerMine`, `scannerCancel` and `scannerDeskSetup` through `google.script.run`. Each one checks that the user is signed in with an account in the deployer's domain.

`enqueue` treats a PC No. that already has an open row (`PENDING`/`RECEIVED`) as a duplicate, or updates its destination if that changed. A PC No. whose earlier row is finished gets a fresh row.
