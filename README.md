# Prescreen: on-device clinical trial pre-screening (prototype)

A patient's health record is checked against real trial eligibility criteria **inside the browser tab**.
Nothing is uploaded. Only a consented, per-criterion summary is sent to the trial site.

## Run

```
cd ~/Desktop/trial-prescreen
npm start            # local server with caching off, http://127.0.0.1:8080
```

Open in **Brave or Chrome** (the notes model needs WebGPU):

| Page | For | What it does |
|---|---|---|
| `/patient.html` | Patient (mobile) | Add a record → check on device → questions one at a time → submit → results and next steps → consent and send |
| `/site.html` | Site coordinator | Referrals to contact (with full evaluation), trials (pause/resume, criteria, add from ClinicalTrials.gov), anonymous activity log |
| `/legacy.html` | Demo detail | Every criterion, compiled check and evidence for one patient |

First run downloads the model (Qwen2.5 3B, about 2 GB) once; after that it starts in a few seconds and works offline.
Open the two apps in two windows of the **same browser**: they share its storage in place of a server.
If a page looks out of date after an update, hard-reload with Cmd+Shift+R.

## What is real and what is not

| Part | Status |
|---|---|
| Trial criteria | Real text from 5 recruiting trials on ClinicalTrials.gov (pulled 19 Nov 2026), compiled into checks by hand |
| Add trial | Live import of title, sponsor, phase, age and eligibility text from the ClinicalTrials.gov API; checks set by hand in a builder |
| Patients | 3 synthetic FHIR R4 bundles (`tools/make_patients.py`); no real data |
| Record checks | Deterministic: age, SNOMED conditions, LOINC labs with recency, RxNorm medication classes, weight change |
| Clinical notes | Plain-code retrieval finds sentences with the criterion's terms; the on-device model judges only those sentences |
| Safety rule | The model can confirm a criterion but never excludes on its own: an exclusion found in notes becomes a question showing the quote |
| Referrals, activity log | Stored in the browser's localStorage; there is no server |
| Accuracy | 41/42 on a hand-labelled set of 3 synthetic patients × 14 statements (`npm run test:notes`). Far too small to claim accuracy; it is a regression check |

## Tests

These drive Brave headless with the real model (WebGPU). From Claude Code they must run outside the command sandbox.

```
npm run test:engine   # engine on 3 patients × 5 trials (Node, no model)
npm run test:notes    # notes model accuracy against data/notes-eval.json
OUT=/tmp/shots npm run test:e2e   # full patient flow ×3 and the site console, with screenshots
```

## Files

- `engine.js`: FHIR parsing, rule evaluation, referral payload (no network calls)
- `model.js`: on-device model, retrieval and guardrails
- `store.js`: shared trials, referrals and anonymous activity events
- `patient.*`, `site.*`: the two apps; `app.js` + `legacy.html`: detailed view
- `data/trials.json`: compiled criteria; `data/notes-eval.json`: labelled notes test set
- `vendor/web-llm.js`: WebLLM 0.2.87, served locally so the page works offline

## Known limits

- WebLLM 0.2.87's JSON mode fails for this model, so JSON is parsed from text.
- Reloading the page reloads the 2 GB model onto the GPU; repeated reloads crashed headless Brave once. Use "Start over" in the app.
- Retrieval only finds what its terms cover; a missed synonym becomes a patient question.
