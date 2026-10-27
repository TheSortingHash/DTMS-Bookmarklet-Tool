# DTMS Batch Receive & Forward Tool — Plan

Status: **draft for review**. No code yet.

## 1. Problem

For every physical voucher that arrives at OMD-Finance today, the routine is:

1. **Receive** (`index.php?task=41&id=R`): find the PC No. in a list of 40+ rows, tick its `ACK` box, repeat, then click `YES!` (`name="iReceive"`).
2. **Forward** (`index.php?task=3`): type the PC No. into `ipcn`, click `Search`, pick a station in `ilocate`, click `Update Location` (`name="iUpdate"`). Do this once per PC No.
3. **Handle failures**: if the search shows *"Documents were not yet received by …"*, receive the document first and then forward it again.

Goal: capture a batch of PC Nos. once (by scan or typing) and let a tool do the ticking, receiving, forwarding and retrying. Every action is logged.

## 2. The constraint that shapes the design

DTMS lives at `http://192.168.1.220`, a **private LAN address over plain HTTP**. Google Apps Script runs on Google's servers, so it **cannot reach DTMS**. `UrlFetchApp` will never see that IP.

So the work is split:

| Piece | Runs where | Job |
|---|---|---|
| **Bookmarklet** | Your desktop browser, on the DTMS page (same origin, uses your existing login session) | Every DTMS interaction: reading lists, receiving, forwarding, detecting errors, retrying |
| **Apps Script web app** | Google | A small JSON API over the Sheet: add scans, list pending items, record results |
| **Google Sheet** | Google | Temporary database: the queue plus an append-only log |
| **Scanner page** (phone) | Phone browser | Captures PC Nos. and posts them to the queue |

Only the browser talks to DTMS. Google never needs network access to 192.168.1.220, and DTMS credentials never leave your browser.

## 3. Architecture

```
 Phone (scan / OCR / type)            Desktop browser on 192.168.1.220
 ┌───────────────────────┐            ┌──────────────────────────────────┐
 │ Scanner page           │            │ DTMS page + bookmarklet panel    │
 │  - camera → PC No.     │            │  1. pull PENDING from queue      │
 │  - validate format     │            │  2. RECEIVE  (task=41)           │
 │  - choose destination  │            │  3. FORWARD  (task=3) per PCN    │
 └──────────┬────────────┘            │  4. retry "not yet received"     │
            │ POST scans               │  5. push results + log           │
            ▼                          └──────────────┬───────────────────┘
 ┌──────────────────────────────────────────────────▼─┐
 │ Apps Script web app (doGet/doPost) ── Google Sheet │
 │   Queue tab   |   Log tab   |   Stations tab       │
 └────────────────────────────────────────────────────┘
```

The desktop panel also has its own input box, so you can type or paste PC Nos. directly when the phone isn't in use. **Phase 1 needs no Google pieces at all** (see §8).

## 4. How the bookmarklet drives DTMS

**Approach: replay the forms with `fetch()` instead of clicking through pages.**

A bookmarklet's script is lost whenever the page navigates. Clicking `Search` or `YES!` triggers a navigation and kills the loop. Instead, the bookmarklet stays on one page and:

- `GET`s the DTMS pages with `fetch` (same origin, so the PHP session cookie is sent automatically);
- parses the returned HTML with `DOMParser`;
- builds the POST body **from the page's own `<form>`** using `new FormData(form)`, then adds the button that was "clicked" (`iReceive=YES!`, `iSearch=Search`, `iUpdate=Update Location`).

Taking the real form as the starting point means the request matches what the browser itself would send, hidden fields included (`task`, `iSelecttype`, `act`, `ipart`, `code[]`, `refind`, `status`). That matters because the receive form has both a hidden `act` and `act[1]`, `act[2]`, …, and the safest choice is to send exactly what DTMS already receives today.

### 4.1 Receive (task=41)

1. `GET index.php?task=41&id=R` and parse the rows. In each `<tr>`, the 3rd cell (`td.mnu4`) holds the PC No. and the 2nd cell holds `input[type=checkbox][name^="act["]`. This gives a map `PCN → "act[17]"`.
   - The `act[n]` numbers are **row positions, not IDs**, so the map is rebuilt from a fresh GET every time.
2. Sort the batch:
   - **found**: tick it;
   - **not in list**: either already received, or not yet forwarded to us. Step 3 of forwarding tells the two apart.
3. Submit the form with only the found boxes ticked, plus `iReceive=YES!`.
4. **Verify**: GET the list again. Received PC Nos. should be gone. Anything still listed is marked `RECEIVE_FAILED`.

### 4.2 Forward (task=3), one PC No. at a time

1. POST the search: `task=3, ipcn=<PCN>, iSearch=Search`.
2. Parse the response:
   - **"Oops…"** block present → read the second `<p>`: *"Documents were not yet received by `<Station>`!"*
     - `<Station>` is **our station** (from the "Station: …" header) → put the PC No. on the **retry list**.
     - `<Station>` is **another station** → mark it `BLOCKED` with the message. We can't fix it; someone at that station has to receive it first.
   - Otherwise read `Last Location`, and confirm the `ilocate` select contains the destination code.
3. POST the update, built from the returned form: `ilocate=<code>`, `iUpdate=Update Location`, `reason` empty, `close` left unticked.
4. Parse the result for a success marker (**sample needed**, see §10). If it isn't there, mark it `FORWARD_FAILED` and save a snippet of the page text in the log.

### 4.3 Retry loop

```
for attempt in 1..2:
    retry = forward(all pending)              # collects "not yet received by ME"
    if retry is empty: break
    receive(retry)                            # §4.1 on just those PC Nos.
    pending = retry
anything still in retry → BLOCKED("not yet received after 2 attempts")
```

Requests run **one at a time** with a short delay of about 300 ms. This is an old PHP app, and we shouldn't load it harder than a fast human would.

### 4.4 Safety rails

- **Dry-run first.** The panel shows the plan (found / not found / destination per PC No.) and does nothing until you click **Run**.
- **Your own station only.** The "Station: …" header is read and saved with each log entry. The run stops if the page isn't logged in.
- **Never ticks "CLOSE Transaction"** and never fills `reason`. Forwarding back to the requestor stays manual in v1.
- **Validates the destination.** The destination code must exist in that page's `ilocate` options, or the item is skipped.
- **Stops on anything unexpected**, such as a login page, an unknown layout, or an HTTP error. A half-finished batch is never resubmitted blindly.
- **Idempotent queue.** Each item moves `PENDING → RECEIVED → FORWARDED`, and a rerun skips work already done.

## 5. Capturing PC Nos.: QR injection vs. phone camera

The PC No. is 11 digits in the form `YYYYMMDD` + 3-digit sequence (`20261021037`). That format allows real validation: a plausible date plus a sequence, regex `^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}$`.

**Recommendation: phone OCR of the printed PC No. as the main path, with QR as an optional upgrade.**

- **Why not lead with QR injection.** The DV (`/ifmis/jevadjust/budget/reports/dvoucher1.php?busno=…&jevno=…&ref=dv1`) is generated and printed by **Accounting**, not OMD-Finance. Your photo is of a voucher that's already printed. A QR only appears if whoever prints the DV runs a userscript or bookmarklet first. That adds a step to another unit's routine, and it doesn't help with vouchers already in circulation. It's worth proposing to Accounting later. Injecting it is easy: find the `PC No:` cell, render a QR next to it, then print.
- **Phone OCR.** It works on every voucher already printed, today. The scanner page frames the PC No. box, runs OCR with digits only, extracts `20\d{9}` and checks it with the regex above. A quick human check covers the rest. **You confirm each read with one tap**, so a misread digit never reaches DTMS.
- **Always available:** a numeric input on the phone and the desktop panel. A USB or Bluetooth barcode scanner also works, since it acts as a keyboard, if QR is adopted later.

The scanner page also asks for a **destination per batch** (for example, "OMD-Finance Signatory `JE05`"), with an optional per-item override.

**Hosting the scanner page.** Camera access inside Apps Script's sandboxed HtmlService iframe is unreliable, especially on iOS. The safer choice is to host the scanner page as a static file on GitHub Pages from this repo, posting to the Apps Script web app. A spike will check whether Apps Script hosting works on your phones (§9).

## 6. Google Sheet schema

**Queue**

| Column | Example | Notes |
|---|---|---|
| `id` | `q_1730000000_ab12` | unique |
| `batchId` | `2026-10-27-AM` | groups one stack of vouchers |
| `pcn` | `20261021037` | validated 11 digits |
| `action` | `RECEIVE_FORWARD` | `RECEIVE` / `FORWARD` / `RECEIVE_FORWARD` |
| `destCode` | `JE05` | `ilocate` option value |
| `status` | `PENDING` | `PENDING / RECEIVED / FORWARDED / BLOCKED / FAILED` |
| `attempts` | `1` | |
| `message` | `not yet received by OMD-Finance Signatory` | last error text |
| `source` | `phone-ocr` | `phone-ocr / phone-manual / desk / qr` |
| `scannedBy`, `scannedAt`, `updatedAt` | | |

**Log**: append-only, one row per DTMS action (`ts, batchId, pcn, step, result, station, detail`). This is the audit trail.

**Stations**: `code, label`, copied once from the `ilocate` options (`ACC`, `JE05`, `TR3`, …) to fill the scanner's destination picker.

**Data minimisation.** Store the PC No. and status only, never payee names, amounts or TINs. The Sheet doesn't need them, and keeping them out avoids Data Privacy Act exposure. The desktop panel can show payee and amount from DTMS itself, since that data never leaves the LAN.

## 7. Apps Script web app API

| Call | Purpose |
|---|---|
| `POST {op:"enqueue", items:[…], token}` | Phone adds scans (dedupes on `pcn` + open status) |
| `GET ?op=pending&batchId=…&token=…` | Bookmarklet pulls work |
| `POST {op:"report", results:[…], token}` | Bookmarklet writes statuses and log rows |
| `GET ?op=stations` | Destination list |

- POST bodies are sent as `Content-Type: text/plain` JSON. This avoids a CORS preflight, which Apps Script can't answer. GETs return JSON, with a JSONP `callback=` fallback in case `fetch` is blocked.
- Deployed as *Execute as: me*. Access is decided in §10. A shared `token` in Script Properties keeps random callers out.
- `LockService` around writes, so a phone and the desk can write at the same time safely.

## 8. Phases

| Phase | Deliverable | Needs Google? | Value |
|---|---|---|---|
| **0. Spike** | Console snippets that (a) map PCN→checkbox on task=41, (b) do one search+update POST on task=3 for a test item, (c) capture the success and error HTML | No | Proves the `fetch` replay approach on the real system |
| **1. Desk panel** | Bookmarklet: paste or type PC Nos. → dry-run table → Receive → Forward → retry → summary, plus a CSV log download | No | Removes most of the clicking right away |
| **2. Queue** | Sheet + Apps Script API; the panel pulls the queue and reports back | Yes | Audit log; groundwork for the phone |
| **3. Phone scanner** | GitHub Pages scanner: OCR + confirm + destination picker → enqueue | Yes | Scan at the desk while the PC runs the batch |
| **4. (optional) QR** | Userscript for the DV page that adds a QR beside the PC No. before printing | — | Only if Accounting adopts it |

**Bookmarklet delivery.** Use a short *loader* bookmarklet that adds `<script src="https://<user>.github.io/…/dtms-tool.js">`. Then updates don't need re-bookmarking. If IT prefers no remote code, ship one self-contained bookmarklet instead (bigger, updated by hand).

## 9. Risks / spikes

1. **Success page unknown**: we need the HTML DTMS returns after `YES!` and after `Update Location` to tell success apart.
2. **When the "not yet received" error appears**: on `Search` (as the screenshot suggests) or only on `Update Location`? The parser handles both, but we need to know where to look.
3. **OCR accuracy** on photocopied or crumpled vouchers: test Tesseract.js with a digit whitelist on about 20 real photos. If it falls short, the fallback is manual entry plus QR.
4. **Camera inside Apps Script HtmlService** on your phones: test it. If it fails, use GitHub Pages hosting.
5. **Session timeout** in the middle of a batch: detect the login page and stop cleanly. Resume skips completed items.
6. **Policy**: this automates an official records system. Get a quick OK from the DTMS system administrator. The tool only does what your account can already do, at human pace, with a full log, which makes that conversation easier.

## 10. Open questions for you

1. **Destination**: is it usually one station per batch (e.g. everything to `JE05` OMD-Finance Signatory), or does it vary per voucher?
2. **Sample pages**: can you save the HTML after a successful `YES!` receive, after a successful `Update Location`, and the DTMS login page?
3. **Error timing**: does the "not yet received" message appear right after `Search`, or after `Update Location`?
4. **The screenshot case** says *"not yet received by OMD-Finance **Signatory**"* while you are *OMD-Finance **Department***. Do you also operate the Signatory station, for example by switching login? Or is that the case where someone else must receive it, and the tool should just flag it?
5. **Google Workspace**: is DAP on Google Workspace (so the web app can be limited to your domain), or a personal Gmail account?
6. **Phones**: Android, iPhone, or both?
7. **Scope of v1**: receive + forward only, or also "close transaction" / forward-back-to-requestor with a reason?
