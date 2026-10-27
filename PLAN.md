# DTMS Batch Receive & Forward Tool — Plan

Status: **v2 draft**. Revised with the answers from 2026-10-27. No code yet.
The DTMS system administrator has approved front-end automation.

## 1. Problem

For every physical voucher that arrives at OMD-Finance today, the routine is:

1. **Receive** (`index.php?task=41&id=R`): find the PC No. in a list of 40+ rows, tick its `ACK` box, repeat, then click `YES!` (`name="iReceive"`).
2. **Forward** (`index.php?task=3`): type the PC No. into `ipcn`, choose the destination in `ilocate`, click `Update Location` (`name="iUpdate"`). Do this once per PC No., and the **destination differs per voucher**.
3. **Handle failures**: if `Update Location` returns *"Oops…. Documents were not yet received by …"*, receive the document first and forward it again.

Goal: capture a batch of `PC No. → destination` pairs once (by scan or typing) and let a tool do the ticking, receiving, forwarding and retrying, with every action logged.

## 2. The constraint that shapes the design

DTMS lives at `http://192.168.1.220`, a **private LAN address over plain HTTP**. Google Apps Script runs on Google's servers, so it **cannot reach DTMS**.

| Piece | Runs where | Job |
|---|---|---|
| **Bookmarklet** | Desktop browser, on the DTMS page (same origin, existing login session) | Every DTMS interaction |
| **Apps Script web app** | Google (DAP Workspace) | Queue API over the Sheet |
| **Google Sheet** | Google (DAP Workspace) | Temporary database: queue + append-only log |
| **Scanner page** | Android / iPhone browser | Captures `PC No. + destination` into the queue |

Only the browser talks to DTMS. DTMS credentials never leave it.

## 3. Architecture

```
 Phone (scan / type)                   Desktop browser on 192.168.1.220
 ┌────────────────────────┐            ┌──────────────────────────────────┐
 │ Scanner page            │            │ DTMS page + bookmarklet panel    │
 │  - sticky destination   │            │  1. pull PENDING from queue      │
 │  - camera/OCR → PC No.  │            │  2. RECEIVE  (task=41, 1 POST)   │
 │  - confirm → enqueue    │            │  3. FORWARD  (task=3, per PCN)   │
 └──────────┬─────────────┘            │  4. retry "not yet received"     │
            │                          │  5. push results + log           │
            ▼                          └──────────────┬───────────────────┘
 ┌───────────────────────────────────────────────────▼┐
 │ Apps Script web app ── Google Sheet                 │
 │   Queue   |   Log   |   Stations                    │
 └─────────────────────────────────────────────────────┘
```

The desktop panel has its own input box, so **Phase 1 runs with no Google pieces at all** (§8).

## 4. How the bookmarklet drives DTMS

**Approach: replay the forms with `fetch()` instead of clicking through pages.**

A bookmarklet's script is lost when the page navigates. So the tool stays on one DTMS page and:

- sends requests with `fetch` (same origin, so the PHP session cookie goes along automatically);
- parses responses with `DOMParser`;
- builds each POST **from the page's own `<form>`** with `new FormData(form)`, then adds the button that was "clicked". The request then matches what the browser itself sends, including every hidden field (`task`, `iSelecttype`, `act`, `ipart`, `code[]`, `refind`, `status`).

### 4.1 Your station and its alias

`OMD-Finance Department` (the header's "Station: …") and `OMD-Finance Signatory` (`ilocate` code `JE05`) are **the same station**. "Signatory" only indicates status. The tool keeps a configurable alias list:

```js
MY_STATION_ALIASES = ["OMD-Finance Department", "OMD-Finance Signatory"]
```

Anything *"not yet received by"* one of these names is ours to fix by receiving. Any other station name means someone else has to receive it, so the item is marked `BLOCKED`.

### 4.2 Receive (task=41)

1. `GET index.php?task=41&id=R` and parse the rows. In each row, the 3rd cell (`td.mnu4`) holds the PC No. and the 2nd cell holds `input[type=checkbox][name^="act["]`. This gives a map `PCN → "act[n]"`. The `act[n]` numbers are **row positions, not IDs**, so the map is rebuilt from a fresh GET every time.
2. Tick only the batch's PC Nos. that appear in the list, then POST the form once with `iReceive=YES!`.
3. **Verify**: GET the list again. Received PC Nos. should be gone. Anything still listed is marked `RECEIVE_FAILED`.

PC Nos. that are not in the list aren't errors at this point. Most will already be received and are simply forwarded in §4.3.

### 4.3 Forward (task=3), one PC No. at a time

Each PC No. is handled in two requests: a read-only pre-check, then the update.

**a) Pre-check (read-only).** `GET index.php?task=3&iSearch=Search&ipcn=<PCN>`. This is the URL route you gave, and it opens the update page with the PC No. already loaded. Parse:
- `Client Name`, `Amount` (shown in the panel only, never stored in Google)
- `Last Location`, e.g. `OMD-Administrative Department (Not yet Received)`
- the **current location code**: the `selected` option placed *after* the `--------------------` separator in `ilocate` (e.g. `JD00`)
- whether the destination code exists in `ilocate`

Then decide:

| Pre-check shows | Action |
|---|---|
| Current location == destination | Already forwarded. Mark `FORWARDED` and skip (makes reruns safe). |
| Last Location is one of our aliases **and** `(Not yet Received)` | Needs receiving. Add to the receive set and skip the update for now. |
| No record / empty page | `NOT_FOUND` |
| Destination code not in `ilocate` | `FAILED: bad destination` |
| Otherwise | Go to (b) |

**b) Update.** POST the form from the pre-check page with `ilocate=<destCode>` and `iUpdate=Update Location`. `close` stays unticked and `reason` stays empty. This matches your manual shortcut (PC No. + dropdown + Update Location), and also sends the `refind` and `status` hidden fields DTMS put on the page.

**c) Verify** from the response. This uses the success page you shared:
- **Success** = no "Oops", **and** `Last Location` starts with the destination's label followed by `(Not yet Received)`, **and** the selected option after the separator equals `destCode`.
- **"Documents were not yet received by `<X>`!"**:
  - `<X>` is in our aliases → add to the retry set.
  - otherwise → `BLOCKED`.
- Any other "Oops" text or unexpected page → `FAILED`, with a snippet of the page text saved in the log.

### 4.4 Batch flow and retry loop

```
receive(batch ∩ receive-list)                     # §4.2, one POST
for pcn in batch: forward(pcn)                    # §4.3, pre-check + update
for attempt in 1..2:                              # safety net
    retry = items flagged "needs receiving" or "not yet received by ME"
    if retry is empty: break
    receive(retry); forward(retry)
anything still in retry → BLOCKED("not yet received after 2 attempts")
```

Requests run **one at a time**, about 300 ms apart.

### 4.5 Safety rails

- **Dry-run first.** The panel lists every PC No. with its payee, amount, current location → destination, and planned action. Nothing is sent until you click **Run**.
- **Session check.** It reads the "Station: …" header before starting and before each step. A login page or a different station stops the run.
- **Never ticks "CLOSE Transaction"** and never fills `reason`. Close and return-to-requestor stay manual in v1.
- **Stops on anything unexpected**, and never resubmits a half-finished batch blindly. The pre-check makes reruns safe.
- **Visible progress** per row (⏳ / ✅ / ⚠️ / ⛔), plus a log you can download as CSV.

## 5. Capturing `PC No. + destination`

**PC No. format**: 11 digits, `YYYYMMDD` + a 3-digit sequence. Validated with `^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}$`.

**Destination UX** (it varies per voucher): a **sticky destination picker**. You choose "OMD-Administrative Department", scan or type several vouchers, switch to "Pre-Audit", and scan more. Each item stores its own `destCode`. Desk input accepts lines like:

```
20261021033 JD00
20261021037            ← uses the currently selected default destination
```

The destination list comes from DTMS's own `ilocate` options: read live by the bookmarklet, and copied to the Sheet's **Stations** tab for the phone.

**Capture methods**, in rollout order:

1. **Typing or pasting at the desk** (Phase 1). No setup.
2. **Phone, with your own camera app** (zero-dev fallback). iPhone Live Text and Google Lens on Android can both copy the number off the printed DV. Paste it into the scanner page's input.
3. **Phone, scanning inside the page** (Phase 3). Tesseract.js OCR with a digit whitelist reads the `PC No:` box, extracts `20\d{9}`, validates it, and **you confirm with one tap**. Works on Android Chrome and iPhone Safari.
4. **QR on the DV** (optional Phase 4). Only if Accounting, who generate and print the DVs, agree to run a small script on `dvoucher1.php` before printing. It would add a QR next to the `PC No:` cell. Then any phone camera, or a cheap USB scanner, reads it instantly.

## 6. Google Sheet schema

**Queue**

| Column | Example | Notes |
|---|---|---|
| `id` | `q_1730000000_ab12` | unique |
| `batchId` | `2026-10-27-PM` | |
| `pcn` | `20261021033` | validated |
| `destCode` | `JD00` | per item |
| `status` | `PENDING` | `PENDING / RECEIVED / FORWARDED / BLOCKED / NOT_FOUND / FAILED` |
| `attempts` | `1` | |
| `message` | `not yet received by Pre-Audit` | last error |
| `source` | `phone-ocr` | `desk / phone-manual / phone-ocr / qr` |
| `scannedBy`, `scannedAt`, `updatedAt` | | `scannedBy` = Workspace email |

**Log**: append-only (`ts, batchId, pcn, step, result, station, detail`).
**Stations**: `code, label`.

**Data minimisation**: PC No., destination and status only. No payee names, amounts or TINs go to Google. The desk panel shows those from DTMS, on the LAN.

## 7. Apps Script web app and access (DAP Workspace)

**API**

| Call | Purpose |
|---|---|
| `enqueue(items)` | Phone or desk adds items (dedupes on `pcn` + open status) |
| `pending(batchId?)` | Bookmarklet pulls work |
| `report(results)` | Bookmarklet writes statuses + log rows |
| `stations()` / `setStations(list)` | Destination list (the bookmarklet uploads it from DTMS) |

`LockService` wraps writes so the phone and the desk can write at the same time.

**Access, and the catch.** Deploy as *Execute as: me · Who has access: anyone within DAP*. That works well for the **phone scanner page**: it opens on `script.google.com` while signed in to Workspace, and `google.script.run` handles authentication.

The **bookmarklet** is different. It runs on `192.168.1.220`, and browsers increasingly refuse to send Google login cookies on cross-site `fetch` calls, so a domain-restricted web app would redirect it to a login page. Options, in order of preference:

1. **Popup bridge.** The bookmarklet opens a small web-app window (first-party, so you're signed in) and exchanges data with it via `postMessage`. Keeps "DAP only" access. *Needs a spike* to confirm `postMessage` works through Apps Script's sandbox iframe.
2. **Separate "Anyone" deployment** with a secret token for the bookmarklet's endpoints only. Simple and reliable, but your Workspace admin may have disabled "Anyone" access. The Sheet holds only PC Nos. and statuses.
3. **No live link.** The bookmarklet imports and exports via the clipboard (copy pending as text, paste results). Always works and is clunkier.

## 8. Phases

| Phase | Deliverable | Needs Google? |
|---|---|---|
| **0. Probe** | Read-only console snippet: parses the task=41 list and the pre-check page for 1–2 PC Nos., and prints what the tool *would* do. Confirms the parsers against live pages. | No |
| **1. Desk panel** | Bookmarklet: paste `PCN [DEST]` lines → dry-run table → Run (receive → forward → retry) → summary + CSV log | No |
| **2. Queue** | Sheet + Apps Script; the panel pulls and reports (bridge per §7) | Yes |
| **3. Phone scanner** | Web app page: sticky destination, manual entry, OCR + confirm | Yes |
| **4. (optional) QR** | DV-page script that adds a QR beside the PC No. | Accounting buy-in |

**Bookmarklet delivery**: a short *loader* bookmarklet that adds the hosted `dtms-tool.js`, so updates need no re-bookmarking. A fully self-contained bookmarklet is the fallback.

## 9. Remaining risks / spikes

1. **Receive success page.** Phase 1 verifies receipts by re-reading the list, so the exact HTML after `YES!` isn't required. A saved copy would still help.
2. **Is an item at "OMD-Finance Signatory (Not yet Received)" in *our* task=41 list?** The design assumes yes, since it's the same station. The probe confirms it.
3. **Popup bridge** (§7 option 1). Spike in Phase 2.
4. **OCR accuracy** on worn or photocopied DVs. Test on about 20 real vouchers in Phase 3. Manual entry and Live Text/Lens are the fallback.
5. **Session timeout** mid-batch. Detect the login page and stop. A rerun skips items already done (pre-check).

## 10. Resolved decisions (2026-10-27)

| Question | Answer |
|---|---|
| Destination per batch or per voucher? | **Per voucher.** Sticky picker + per-line override. |
| Success page | Shared. Verify via `Last Location` + trailing selected option. |
| When the "not yet received" error appears | **After `Update Location`.** Search is optional; the pre-check GET catches the case early. |
| OMD-Finance Signatory vs Department | **Same station.** Alias list. |
| Google account | **DAP Workspace** |
| Phones | **Android and iPhone** |
| Admin approval | **Yes**, front-end automation only |

## 11. Still open

- Phase 2 access route (§7): is "Anyone" access allowed for web apps in DAP's Workspace? If you don't know, we spike the popup bridge first.
- Sample HTML of the DTMS **login / session-expired** page, so the tool can recognise it.
