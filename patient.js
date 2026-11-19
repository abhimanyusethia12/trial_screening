import { parseBundle, evalTrial, buildReferral } from "./engine.js";
import { loadModel, askModel, hasWebGPU, isReady, MODEL_LABEL } from "./model.js";
import { getActiveTrials, addReferral, logEvent, newSessionId, resetAll } from "./store.js";

const SAMPLES = [
  { id: "elena-marsh", name: "Elena Marsh", line: "54, type 2 diabetes" },
  { id: "rahul-venkat", name: "Rahul Venkat", line: "62, diabetes and kidney disease" },
  { id: "maya-okafor", name: "Maya Okafor", line: "38, obesity" },
];
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const today = new Date().toISOString().slice(0, 10);
try { performance.setResourceTimingBufferSize(100000); } catch {}

let S; // session state
function reset() {
  S = {
    session: newSessionId(), trials: [], patient: null, evals: {}, answers: {}, // answers: question text -> yes|no|unsure
    history: [], qIndex: 0, notesRead: false, model: { state: "idle", pct: 0 }, check: { done: 0 }, requests: null, sent: {},
  };
}

// ---------- evaluation ----------
const env = () => ({ askModel: isReady() ? (statement, notes, terms) => askModel(statement, notes, terms, S.patient.id) : null });
const answersFor = (t) => Object.fromEntries(t.criteria.filter((c) => c.ask && S.answers[c.ask]).map((c) => [c.id, S.answers[c.ask]]));

async function evaluateAll(onEach = () => {}) {
  const before = performance.getEntriesByType("resource").length;
  for (const t of S.trials) { S.evals[t.nctId] = await evalTrial(t, S.patient, env(), answersFor(t)); onEach(); }
  S.requests = performance.getEntriesByType("resource").length - before;
}
const outcomes = () => S.trials.map((t) => ({
  nct: t.nctId, verdict: S.evals[t.nctId].verdict,
  failed: t.criteria.filter((c, i) => S.evals[t.nctId].results[i].status === "not_met").map((c) => c.id),
}));

// Open questions across trials that are still possible, de-duplicated by wording.
function openQuestions() {
  const qs = new Map();
  for (const t of S.trials) {
    const e = S.evals[t.nctId];
    if (e.verdict === "not_eligible") continue;
    t.criteria.forEach((c, i) => {
      const r = e.results[i];
      if (r.status !== "ask" || !c.ask) return;
      const q = qs.get(c.ask) || { text: c.ask, trials: new Set(), quote: null };
      q.trials.add(t.nctId);
      if (r.confirm) q.quote = r.evidence.replace(/^Note: "?/, "").replace(/"$/, "");
      qs.set(c.ask, q);
    });
  }
  return [...qs.values()];
}

// ---------- screens ----------
function welcome() {
  reset();
  app.innerHTML = `
    <p class="step-label">Clinical trials for type 2 diabetes and weight</p>
    <h1>See if you may qualify for a trial, without sharing your records</h1>
    <p class="lead">We compare your health record with what each trial requires. The check runs on this device. Nothing is sent unless you choose to send it.</p>
    <ol class="points">
      <li><span class="n">1</span><span>Add your health record. You can export it from your patient portal as a FHIR file.</span></li>
      <li><span class="n">2</span><span>Answer a few questions your record can't answer.</span></li>
      <li><span class="n">3</span><span>See which trials you may qualify for, and decide whether to contact the study team.</span></li>
    </ol>
    <label class="btn primary file-btn">Upload my health record<input type="file" id="file" accept=".json,application/json"></label>
    <p class="error" id="file-error" hidden></p>
    <details><summary>No record to hand? Try a sample patient</summary>
      <div class="samples">${SAMPLES.map((s) => `<button class="sample" data-id="${s.id}"><strong>${esc(s.name)}</strong><span>${esc(s.line)} · synthetic record</span></button>`).join("")}</div>
    </details>
    <p class="note-box">Prototype. Sample records are fictional. Trials are real listings from ClinicalTrials.gov.</p>`;
  app.querySelector("#file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    try { await start(JSON.parse(await f.text()), "upload"); }
    catch (e) { const el = app.querySelector("#file-error"); if (el) { el.hidden = false; el.textContent = `We couldn't read that file: ${e.message}`; } }
  });
  app.querySelectorAll(".sample").forEach((b) => b.addEventListener("click", async () => {
    await start(await (await fetch(`data/patients/${b.dataset.id}.json`, { cache: "no-cache" })).json(), "sample");
  }));
}

async function start(bundle, source) {
  S.patient = parseBundle(bundle, today); // throws on a file without a Patient
  S.trials = await getActiveTrials();
  logEvent(S.session, "record_loaded", { source, trials: S.trials.length });
  preparing();
  if (hasWebGPU()) {
    S.model.state = "loading";
    try {
      await loadModel((pct) => { S.model.pct = pct; preparing(); });
      S.model.state = "ready";
    } catch (e) { console.warn(e); S.model.state = "failed"; }
  } else S.model.state = "unavailable";
  preparing();
  await evaluateAll(() => { S.check.done++; preparing(); });
  S.notesRead = isReady();
  S.check.finished = true;
  const qs = openQuestions();
  logEvent(S.session, "checked", { outcomes: outcomes(), questions: qs.length, notesRead: S.notesRead, requests: S.requests });
  setPrivacy();
  preparing();
}

function setPrivacy() {
  document.getElementById("privacy").textContent = S.requests === 0 ? "0 network requests" : "Runs on this device";
}

function preparing() {
  const p = S.patient;
  const labs = Object.keys(p.obs).length;
  const m = S.model;
  const modelDone = ["ready", "failed", "unavailable"].includes(m.state);
  const modelSub = m.state === "ready" ? `${MODEL_LABEL}, running on this device`
    : m.state === "loading" ? `Downloads once (about 2 GB), then works offline · ${Math.round(m.pct * 100)}%`
    : m.state === "failed" ? "Couldn't start here, so we'll ask you about your clinic notes instead"
    : m.state === "unavailable" ? "This browser can't run it, so we'll ask you about your clinic notes instead" : "";
  const n = S.trials.length;
  const finished = S.check.finished;
  const ruledOut = finished ? S.trials.filter((t) => S.evals[t.nctId].verdict === "not_eligible").length : 0;
  const qs = finished ? openQuestions() : [];
  app.innerHTML = `
    <p class="step-label">Step 1 of 3</p>
    <h1>${finished ? "Your record is checked" : "Checking your record"}</h1>
    <p class="lead">Hi ${esc(p.name.split(" ")[0])}. This happens on your device. Your record is not uploaded.</p>
    <ul class="steps">
      <li class="done"><span class="dot"></span><span>Opened your health record
        <span class="sub">${plural(p.conditions.length, "condition")} · ${plural(labs, "test result")} · ${plural(p.meds.length, "medicine")} · ${plural(p.notes.length, "clinic note")}</span></span></li>
      <li class="${modelDone ? "done" : "active"}"><span class="dot"></span><span>Private reader for your clinic notes
        <span class="sub">${modelSub}</span>${m.state === "loading" ? `<div class="meter"><i style="width:${Math.round(m.pct * 100)}%"></i></div>` : ""}</span></li>
      <li class="${finished ? "done" : modelDone ? "active" : ""}"><span class="dot"></span><span>Compared with ${plural(n, "recruiting trial")}
        <span class="sub">${finished ? `${n - ruledOut} still possible · ${ruledOut} ruled out by your record` : modelDone ? `${S.check.done} of ${n} checked` : "Waiting"}</span></span></li>
    </ul>
    ${finished ? (qs.length && n - ruledOut
      ? `<p>Your record can't answer ${plural(qs.length, "question")} these trials need. It takes about a minute.</p><button class="btn primary" id="go">Answer ${plural(qs.length, "question")}</button>`
      : `<button class="btn primary" id="go">See your results</button>`) : ""}`;
  const go = app.querySelector("#go");
  if (go) go.addEventListener("click", () => { if (qs.length && n - ruledOut) { logEvent(S.session, "questions_started", { questions: qs.length }); question(); } else results(); });
}

function question() {
  const open = openQuestions();
  const openUnanswered = open.filter((q) => !S.answers[q.text]);
  let q;
  if (S.qIndex < S.history.length) {
    const text = S.history[S.qIndex];
    q = open.find((x) => x.text === text) || { text, trials: new Set(), quote: null };
  } else q = openUnanswered[0];
  if (!q) return review();
  const total = S.history.length + openUnanswered.filter((x) => !S.history.includes(x.text)).length;
  const current = S.answers[q.text];
  app.innerHTML = `
    <p class="step-label">Step 2 of 3</p>
    <div class="q-progress"><span>Question ${S.qIndex + 1} of ${total}</span>${S.qIndex > 0 ? `<button class="btn link" id="back" style="margin:0;min-height:0;padding:0">Back</button>` : ""}</div>
    <div class="meter"><i style="width:${Math.round((S.qIndex / Math.max(total, 1)) * 100)}%"></i></div>
    <p class="q-text">${esc(q.text)}</p>
    ${q.quote ? `<div class="card"><p class="small muted" style="margin:0 0 4px">Your clinic notes say</p><p style="margin:0">“${esc(q.quote)}”</p></div><p class="q-why">Please confirm, so a misread note doesn't rule you out.</p>`
      : `<p class="q-why">Needed for ${plural(q.trials.size, "trial")}. Your answer stays on this device unless you choose to send your results.</p>`}
    <div class="choices">
      ${[["yes", "Yes"], ["no", "No"], ["unsure", "Not sure"]].map(([v, l]) => `<button class="choice" data-v="${v}" aria-pressed="${current === v}">${l}</button>`).join("")}
    </div>`;
  app.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", async () => {
    S.answers[q.text] = b.dataset.v;
    if (S.qIndex === S.history.length) S.history.push(q.text);
    S.qIndex++;
    await evaluateAll(); // re-check so questions for trials that are now ruled out are skipped
    logEvent(S.session, "answered", { answered: Object.keys(S.answers).length });
    question();
  }));
  const back = app.querySelector("#back");
  if (back) back.addEventListener("click", () => { S.qIndex--; question(); });
}

function review() {
  app.innerHTML = `
    <p class="step-label">Step 2 of 3</p>
    <h1>Check your answers</h1>
    <div class="card"><ul class="share-list">
      ${S.history.map((t, i) => `<li>${esc(t)}<span class="src">${{ yes: "Yes", no: "No", unsure: "Not sure" }[S.answers[t]]} · <button class="btn link" data-i="${i}" style="display:inline;min-height:0;padding:0;margin:0;font-size:13px">Change</button></span></li>`).join("")}
    </ul></div>
    <button class="btn primary" id="submit">Submit answers</button>
    <p class="small muted" style="margin-top:8px">Submitting re-runs the check on this device. Nothing is sent yet.</p>`;
  app.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { S.qIndex = Number(b.dataset.i); question(); }));
  app.querySelector("#submit").addEventListener("click", async () => {
    logEvent(S.session, "submitted", { answered: S.history.length });
    app.innerHTML = `<p class="step-label">Step 3 of 3</p><h1>Checking again with your answers</h1><p class="lead">On this device. Nothing is being sent.</p><div class="meter"><i style="width:60%"></i></div>`;
    await evaluateAll();
    setPrivacy();
    logEvent(S.session, "result", { outcomes: outcomes(), requests: S.requests });
    results();
  });
}

function evidenceLine(c, r) {
  if (r.source === "patient") return `Your answer: ${({ yes: "Yes", no: "No", unsure: "Not sure" })[S.answers[c.ask]] || ""}`;
  if (r.source === "notes") return `Your clinic notes: ${r.evidence.replace(/^Note: /, "")}`;
  return `Your record: ${r.evidence}`;
}

function results() {
  const likely = S.trials.filter((t) => S.evals[t.nctId].verdict === "likely");
  const pending = S.trials.filter((t) => S.evals[t.nctId].verdict === "questions");
  const no = S.trials.filter((t) => S.evals[t.nctId].verdict === "not_eligible");
  if (!S.logged) { S.logged = true; if (!S.history.length) logEvent(S.session, "result", { outcomes: outcomes(), requests: S.requests }); }
  const likelyCards = likely.map((t) => {
    const e = S.evals[t.nctId];
    const rec = e.results.filter((r) => r.status === "met" && (r.source === "record" || r.source === "notes")).length;
    const ans = e.results.filter((r) => r.status === "met" && r.source === "patient").length;
    const visit = e.counts.screening;
    const sent = S.sent[t.nctId];
    return `<div class="card good">
      <span class="verdict-line good-ink">You may qualify</span>
      <p class="trial-title">${esc(t.title)}</p>
      <p class="trial-meta">${esc(t.sponsor)} · ${esc(t.phase)} · ${t.nctId}</p>
      <div class="count-row">
        <div><b>${rec}</b><span>met from your record</span></div>
        <div><b>${ans}</b><span>met from your answers</span></div>
        <div><b>${visit}</b><span>to check at a first visit</span></div>
      </div>
      ${sent ? `<p class="small" style="margin:10px 0 0"><strong>Sent to the study team.</strong> Reference <span class="ref">${esc(sent.patient.ref)}</span></p>`
        : `<p class="small" style="margin:10px 0 0"><strong>Next step:</strong> send these results to the study team. A coordinator reviews them and contacts you about a screening visit.</p>
           <button class="btn primary" data-share="${t.nctId}">Review what will be shared</button>`}
    </div>`;
  }).join("");
  const noCards = no.map((t) => {
    const e = S.evals[t.nctId];
    const idx = e.results.map((r, i) => (r.status === "not_met" ? i : -1)).filter((i) => i >= 0);
    const c = t.criteria[idx[0]], r = e.results[idx[0]];
    return `<div class="card">
      <span class="verdict-line bad-ink">Not a match</span>
      <p class="trial-title">${esc(t.title)}</p>
      <p class="trial-meta">${esc(t.sponsor)} · ${esc(t.phase)}</p>
      <p class="reason"><strong>${c.kind === "inclusion" ? "The trial requires" : "The trial excludes"}:</strong> ${esc(c.text)}<span class="muted">${esc(evidenceLine(c, r))}</span></p>
      ${idx.length > 1 ? `<p class="small muted" style="margin:4px 0 0">and ${plural(idx.length - 1, "other requirement")}</p>` : ""}
    </div>`;
  }).join("");
  app.innerHTML = `
    <p class="step-label">Your results</p>
    <h1>${likely.length ? `You may qualify for ${plural(likely.length, "trial")}` : "No trial matches right now"}</h1>
    <p class="lead">${likely.length ? "“May qualify” means your record and answers meet the trial’s listed requirements. The study team makes the final decision at a screening visit."
      : "Based on your record and answers, you don’t meet the requirements of the trials recruiting now. New trials open regularly."}</p>
    ${likelyCards}
    ${pending.length ? `<div class="card"><span class="verdict-line" style="color:var(--ask)">Needs more information</span><p class="small" style="margin:6px 0 0">${pending.map((t) => esc(t.title)).join("; ")}</p></div>` : ""}
    ${no.length ? `<h2 style="margin-top:24px">Not a match (${no.length})</h2>${noCards}` : ""}
    <p class="note-box">Checked on this device${S.requests === 0 ? " with 0 network requests" : ""}. ${S.notesRead ? "Your clinic notes were read by a model running on this device." : "Your clinic notes were not read on this device."} Your record was not uploaded.</p>
    <button class="btn" id="restart">Start over</button>`;
  app.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => share(b.dataset.share)));
  app.querySelector("#restart").addEventListener("click", () => { history.replaceState(null, "", location.pathname); welcome(); });
  scrollTo(0, 0);
}

const STATUS_WORD = { met: "Meets", screening: "To check at visit", not_met: "Does not meet", ask: "Unanswered", not_checked: "Not checked" };
const SOURCE_WORD = { record: "from your health record", notes: "from your clinic notes", patient: "your answer", site: "checked by the study team" };

function share(nct) {
  const t = S.trials.find((x) => x.nctId === nct);
  const e = S.evals[nct];
  const quotes = e.results.some((r) => r.source === "notes" || /Note: /.test(r.evidence));
  logEvent(S.session, "share_opened", { nct });
  app.innerHTML = `
    <button class="btn link" id="back" style="margin:0">Back to results</button>
    <h1>Send your results to the study team</h1>
    <p class="lead">${esc(t.title)} · ${esc(t.sponsor)}</p>
    <div class="card">
      <h2>What they will receive</h2>
      <ul class="share-list">
        <li>Your name and how to contact you (below)</li>
        <li>Your age and sex: ${S.patient.age}, ${esc(S.patient.sex)}</li>
        <li>Your result for each of the trial’s ${t.criteria.length} requirements, and how it was checked
          <details><summary>See all ${t.criteria.length}</summary><ul class="share-list">
            ${t.criteria.map((c, i) => `<li>${esc(c.text)}<span class="src">${STATUS_WORD[e.results[i].status]} · ${esc(e.results[i].evidence)} · ${SOURCE_WORD[e.results[i].source] || ""}</span></li>`).join("")}
          </ul></details></li>
      </ul>
    </div>
    <div class="card">
      <h2>What stays on this device</h2>
      <ul class="share-list">
        <li>Your full health record</li>
        <li>Conditions, medicines and test results this trial doesn’t ask about</li>
        <li>Your clinic notes${quotes ? ", except the sentences quoted above" : ""}</li>
      </ul>
    </div>
    <label class="field">Your name<input id="name" autocomplete="name" value="${esc(S.patient.name)}"></label>
    <label class="field">Phone or email<input id="contact" autocomplete="tel" placeholder="e.g. +1 555 0137"></label>
    <label class="consent"><input type="checkbox" id="consent"><span>I agree to send this to the study team running ${t.nctId}, so they can contact me about the trial.</span></label>
    <button class="btn primary" id="send" disabled>Send to study team</button>`;
  const name = app.querySelector("#name"), contact = app.querySelector("#contact"), consent = app.querySelector("#consent"), send = app.querySelector("#send");
  const sync = () => { send.disabled = !(consent.checked && name.value.trim() && contact.value.trim()); };
  [name, contact, consent].forEach((el) => el.addEventListener("input", sync));
  consent.addEventListener("change", sync);
  app.querySelector("#back").addEventListener("click", results);
  send.addEventListener("click", () => {
    const ref = buildReferral(t, S.patient, e, contact.value.trim());
    ref.patient.name = name.value.trim();
    ref.answeredQuestions = S.history.length;
    addReferral(ref);
    S.sent[nct] = ref;
    logEvent(S.session, "referral_sent", { nct, ref: ref.patient.ref });
    sent(nct);
  });
  scrollTo(0, 0);
}

function sent(nct) {
  const t = S.trials.find((x) => x.nctId === nct);
  const e = S.evals[nct];
  const ref = S.sent[nct];
  const visit = t.criteria.filter((c, i) => e.results[i].status === "screening");
  app.innerHTML = `
    <span class="verdict-line good-ink">Sent</span>
    <h1>The study team has your results</h1>
    <p class="lead">${esc(t.title)}<br><span class="ref">Reference ${esc(ref.patient.ref)}</span></p>
    <h2>What happens next</h2>
    <ol class="points">
      <li><span class="n">1</span><span>A study coordinator reviews your results.</span></li>
      <li><span class="n">2</span><span>They contact you at ${esc(ref.patient.contact)} to talk about the trial and, if it still fits, book a screening visit.</span></li>
      <li><span class="n">3</span><span>${visit.length ? `At the visit they check ${plural(visit.length, "thing")} your record couldn’t confirm:<ul class="list">${visit.map((c) => `<li>${esc(c.text)}</li>`).join("")}</ul>` : "At the visit they confirm your results with tests of their own."}</span></li>
      <li><span class="n">4</span><span>Taking part is always your choice. You can say no at any point.</span></li>
    </ol>
    <button class="btn" id="back">Back to results</button>
    <button class="btn link" id="restart">Start over with another record</button>`;
  app.querySelector("#back").addEventListener("click", results);
  app.querySelector("#restart").addEventListener("click", () => { history.replaceState(null, "", location.pathname); welcome(); });
  scrollTo(0, 0);
}

// ---------- boot ----------
reset();
if (location.hash === "#reset") { resetAll(); history.replaceState(null, "", location.pathname); }
const sample = new URLSearchParams(location.hash.slice(1)).get("sample");
if (sample && SAMPLES.some((s) => s.id === sample)) {
  fetch(`data/patients/${sample}.json`, { cache: "no-cache" }).then((r) => r.json()).then((b) => start(b, "sample"));
} else welcome();
