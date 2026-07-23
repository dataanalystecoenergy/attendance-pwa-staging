# EcoEnergy Attendance — installable PWA (STAGING COPY)

**This is the staging copy**, deployed separately from the production app so new
changes can be tested without affecting the live app real employees use. Live at
https://dataanalystecoenergy.github.io/attendance-pwa-staging/ (repo
`attendance-pwa-staging`) — the production copy lives in the sibling
`Attendance PWA` folder / `attendance-pwa` repo.

**Shares the same Apps Script backend and the same production Google Sheet as the
live app** — there is no data isolation. Test submissions land in the real
`Form Responses 1` sheet alongside genuine attendance. Tag test entries clearly
(e.g. "TEST" in Remarks) and clean them up afterward. If a change needs a backend
(`Api.gs.txt`) update, that change is live for BOTH staging and production the
moment it's redeployed in Apps Script — there's no way to test backend changes in
isolation with the current setup.

Workflow: make changes here first, verify on the staging URL, then copy the same
changes into the `Attendance PWA` (production) folder and push there once confirmed.

---

Free, installable (iOS + Android "Add to Home Screen") frontend for the existing
Attendance WebApp. Talks to a new JSON API added to the same Apps Script project —
the original `index.html`/`Code.gs` deployment is untouched and keeps working exactly
as it does today.

Companion backend file: `../Attendance WebApp/Api.gs.txt`

## What's new vs. the old form

- **Real accounts.** Employees log in with their Employee ID + a PIN (from the
  employee masterlist), instead of typing any email they want.
- **Location is mandatory.** The old form silently skipped location if denied;
  this one blocks submission until it's granted.
- **Verified submitter identity.** The old free-text email field is gone — the
  server derives who submitted from the login session and records it in two new
  columns at the end of `Form Responses 1`: `Submitted By (Employee ID)` /
  `Submitted By (Verified Name)`. The "Names" checkbox list (who the entry is
  *for*) is unchanged — one logged-in person can still check in a group, same as
  today. **GPS is only verified for the logged-in submitter, not for every name
  checked** — the app says this explicitly so it isn't misread as per-person proof.
- Timestamps were already tamper-evident (server sets them, never trusts the
  client) — nothing changed there.

Not in this phase: GPS geofence distance-checking against a site's actual
coordinates (no site coordinates exist yet — see the plan doc), offline queueing,
push notifications, folding into the `Admin/` viewers.

## Setup — do this once, in order

### 1. Apps Script side

1. Open the existing Attendance WebApp project in the Apps Script editor
   (script.google.com — the one behind your current attendance form).
2. Add a new script file named `Api` and paste in the contents of
   `../Attendance WebApp/Api.gs.txt`.
3. In `API_CONFIG` at the top of that file, confirm
   `EMPLOYEE_MASTERLIST_SHEET_NAME` matches the actual tab name in your
   [employee masterlist spreadsheet](https://docs.google.com/spreadsheets/d/1QNhAitiElYVMPIEta5HFydpNB-FxUHjc9xSe4RlqR3c)
   (defaulted to `'Sheet1'` — change if different).
4. Run `setupCredentialsSheet` once (select it in the function dropdown, click
   Run). Check the execution log for the new spreadsheet URL/ID.
5. Paste that ID into `API_CONFIG.CREDENTIALS_SHEET_ID`, save.
6. Run `assignInitialPins` once. The execution log will list every Active
   employee's freshly-issued 6-digit PIN (Employee ID, Name, PIN) — **this is
   the only time PINs appear in plaintext**, copy the list out to distribute to
   employees (e.g. individually via Discord/SMS — don't post the whole list
   somewhere shared). Re-running this function later is safe — it only issues
   PINs to employees who don't have one yet.
7. **Deploy → Manage deployments → Edit (pencil) → New version → Deploy** on
   your existing deployment, so the new `doPost` becomes live at the same
   `/exec` URL you already have. Copy that URL.

### 2. PWA side

1. Open `app.js`, replace `API_BASE_URL`'s placeholder with the `/exec` URL
   from step 1.7 above.
2. Test locally first: `python -m http.server 8000` from this folder, open
   `http://localhost:8000`, try logging in with one of the issued PINs.
3. Once it works locally, deploy to GitHub Pages (see below) or any static
   host — nothing here is Apps-Script-specific except the API URL.

## Local testing

```
cd "Attendance PWA"
python -m http.server 8000
```

Then open `http://localhost:8000` in a browser. Installable-PWA checks (manifest,
service worker, icons) work fine over `localhost`; actual "Add to Home Screen"
install prompts need a real deployed HTTPS URL (GitHub Pages gives you that for
free) — `localhost` alone won't trigger the install banner on a phone.

## Resetting a forgotten PIN

In the Apps Script editor, run `resetEmployeePin` with an Employee ID argument
(via the function's "Run" dialog, or temporarily call it from another test
function) — logs a fresh PIN the same one-time way.
