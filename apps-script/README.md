# DTMS Batch: Google Sheet queue (Phase 2)

The Sheet is the queue and the audit log. The desk panel loads pending vouchers from it and writes back what happened after every Run. The phone scanner (Phase 3) will add to the same queue.

| Tab | What's in it |
|---|---|
| **Queue** | One row per voucher: `pcn`, `destCode`, `status`, `attempts`, `message`, `source`, who scanned it, when, and which station processed it |
| **Log** | Append-only: every receive/forward step the panel took, with timestamps |
| **Stations** | DTMS's "Forwarded to" list, uploaded by the panel after each Check |

Only PC Nos., station codes and statuses are stored. Payee names and amounts never leave DTMS.

## One-time setup (≈10 minutes)

1. **Create the Sheet.** In Google Drive (your DAP account): *New → Google Sheets*, name it `DTMS Batch`.
2. **Add the script.** *Extensions → Apps Script*. In the editor:
   - Replace the contents of `Code.gs` with [`Code.gs`](Code.gs).
   - *Project Settings (⚙) → Show "appsscript.json" manifest file in editor*, then replace `appsscript.json` with [`appsscript.json`](appsscript.json).
   - Save (💾).
3. **Run setup.** Back in the Sheet, reload the page. A **DTMS Batch** menu appears. Choose *DTMS Batch → Set up / show API token*. Approve the permission prompt: the script asks only for access to *this* spreadsheet. A dialog shows the **API token**; copy it.
   The `Queue`, `Log` and `Stations` tabs are created. You can delete the empty `Sheet1`.
4. **Deploy the web app.** In the Apps Script editor: *Deploy → New deployment → ⚙ Select type → Web app*.
   - Description: `DTMS Batch API`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - *Deploy*, then copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
5. **Connect the panel.** On DTMS, open the DTMS Batch panel → *Settings*: paste the web app URL and the token → **Test queue connection** → **Save settings**. A **Load queue** button appears next to the destination picker.

Settings are saved in that browser only; repeat step 5 on each PC that runs the panel.

### Why "Anyone"?
The panel runs on `http://192.168.1.220`. Browsers won't reliably send your Google login along with requests from that page to Google, so a DAP-only web app would answer with a login page. The token takes the place of the login. Every request must carry it, and requests without it are refused. If the token leaks, use *DTMS Batch → Rotate API token* and paste the new one into each panel.

## Daily use

- **Queue items** come from the phone scanner (Phase 3), or from `enqueue` calls.
- At the desk: **Load queue** → the pending PC Nos. are added to the panel's box with their destinations → **Check** → **Run**. Results are saved to the Sheet automatically. If saving fails (network, quota), DTMS is already updated; click **Sync to Sheet** to retry before closing the panel.
- PC Nos. typed straight into the panel are recorded too, as `source = desk`.
- **Retry a blocked voucher:** select its row(s) on the Queue tab → *DTMS Batch → Re-queue selected rows*. They go back to `PENDING` and show up at the next Load queue.
- Status colours on the Queue tab: green = forwarded, yellow = pending/received, red = needs attention.

## Updating the script later

Paste the new `Code.gs`, then *Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy*. This keeps the same URL, so no panel changes are needed. Creating a *new* deployment instead would give a new URL.

## API (for reference)

All calls are `POST <web app URL>` with a `text/plain` JSON body that includes `"token"`.

| `op` | Body | Returns |
|---|---|---|
| `ping` | – | `{ok, version}` |
| `pending` | `batchId?` | `{ok, items:[{id, batchId, pcn, destCode, destLabel, status, attempts, source, scannedBy, scannedAt}]}` |
| `enqueue` | `items:[{pcn, destCode, batchId?, source?}]`, `user?` | `{ok, added, updated, duplicates, errors}` |
| `report` | `station`, `results:[{id?, pcn, destCode, status, message, attempts, batchId?}]`, `log:[…]` | `{ok, updated, added, logged, errors}` |
| `setStations` | `stations:[{code, label}]` | `{ok, count}` |

`enqueue` treats a PC No. that already has an open row (`PENDING`/`RECEIVED`) as a duplicate, or updates its destination if that changed. A PC No. whose earlier row is finished gets a fresh row.
