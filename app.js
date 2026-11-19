import { parseBundle, evalTrial, describeRule, buildReferral } from "./engine.js";
import { loadModel as loadSharedModel, askModel as askSharedModel, hasWebGPU, MODEL_LABEL } from "./model.js";

const PATIENTS = [
  { file: "elena-marsh.json", label: "Elena Marsh, 54 F: type 2 diabetes (synthetic)" },
  { file: "rahul-venkat.json", label: "Rahul Venkat, 62 M: diabetes + kidney disease (synthetic)" },
  { file: "maya-okafor.json", label: "Maya Okafor, 38 F: obesity (synthetic)" },
];
const STATUS_LABEL = { met: "Met", not_met: "Not met", ask: "Question", screening: "At screening", not_checked: "Not needed" };
const SOURCE_LABEL = { record: "from health record", notes: "from clinical notes, read on device", patient: "patient answer", site: "checked by site" };
const VERDICT_LABEL = { likely: "Likely eligible", questions: "Questions to answer", not_eligible: "Not eligible" };
const INBOX_KEY = "prescreen-inbox";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = new Date().toISOString().slice(0, 10);

const state = {
  trials: [],
  patient: null,
  evals: {},          // nctId -> evaluation
  answers: {},        // nctId -> { criterionId: "yes" | "no" | "unsure" }
  selected: null,
  engine: null,
  sent: {},           // nctId -> referral
};

// ---------- network indicator ----------
try { performance.setResourceTimingBufferSize(100000); } catch {}
function renderNet() {
  $("#net-status").innerHTML = navigator.onLine ? `<span>Online</span>` : `<span class="ok">Offline</span>`;
}
addEventListener("online", renderNet);
addEventListener("offline", renderNet);
renderNet();

// ---------- on-device model (shared with the patient app: see model.js) ----------
async function loadModel() {
  const btn = $("#load-model");
  if (!hasWebGPU()) { $("#model-status").innerHTML = `<span class="warn">WebGPU not available in this browser</span>`; return; }
  btn.disabled = true;
  $("#model-status").textContent = "Loading…";
  try {
    await loadSharedModel((pct) => { $("#model-status").textContent = `Loading ${Math.round(pct * 100)}%`; });
    state.engine = true;
    $("#model-status").innerHTML = `<span class="ok">${MODEL_LABEL}, running in this tab</span>`;
    btn.hidden = true;
    if (state.patient && Object.keys(state.evals).length) runAll();
  } catch (e) {
    console.error(e);
    $("#model-status").innerHTML = `<span class="warn">Model failed to load</span>`;
    btn.disabled = false;
  }
}
$("#load-model").addEventListener("click", loadModel);
const askModel = (statement, notes, terms) => askSharedModel(statement, notes, terms, state.patient.id);

// ---------- patient ----------
async function loadPatientFile(file) {
  const res = await fetch("data/patients/" + file);
  setPatient(await res.json());
}
function setPatient(bundle) {
  state.patient = parseBundle(bundle, today);
  state.evals = {}; state.answers = {}; state.selected = null; state.sent = {};
  $("#req-count").textContent = "—";
  renderRecord(); renderTrials(); renderDetail();
}

function renderRecord() {
  const p = state.patient;
  const labs = Object.values(p.obs).map((list) => list[0]);
  $("#record").innerHTML = `
    <dl class="kv">
      <dt>Name</dt><dd>${esc(p.name)}</dd>
      <dt>Age, sex</dt><dd>${p.age}, ${esc(p.sex)}</dd>
    </dl>
    <div class="record-section"><h3>Conditions (${p.conditions.length})</h3><ul>${p.conditions.map((c) => `<li>${esc(c.display)}${c.onset ? ` <span class="muted">since ${c.onset.slice(0, 4)}</span>` : ""}</li>`).join("")}</ul></div>
    <div class="record-section"><h3>Latest results</h3>
      <table><tbody>${labs.map((l) => `<tr><td>${esc(l.display)}</td><td class="num">${l.value} ${esc(l.unit)}</td><td class="muted">${l.date}</td></tr>`).join("")}</tbody></table></div>
    <div class="record-section"><h3>Medications (${p.meds.length})</h3><ul>${p.meds.map((m) => `<li>${esc(m.display)}</li>`).join("") || "<li class='muted'>None</li>"}</ul></div>
    <div class="record-section"><h3>Clinical notes (${p.notes.length})</h3>
      ${p.notes.map((n) => `<details><summary>${esc(n.title)}, ${esc(n.date)}</summary><div class="note">${esc(n.text)}</div></details>`).join("")}</div>`;
}

// ---------- evaluation ----------
async function runAll() {
  const btn = $("#run");
  btn.disabled = true;
  const before = performance.getEntriesByType("resource").length;
  const env = { askModel: state.engine ? askModel : null };
  for (const t of state.trials) {
    $("#progress").textContent = `Checking ${t.nctId}${state.engine ? " (reading notes on device)" : ""}…`;
    state.evals[t.nctId] = await evalTrial(t, state.patient, env, state.answers[t.nctId] || {});
    renderTrials();
  }
  const reqs = performance.getEntriesByType("resource").length - before;
  $("#req-count").innerHTML = reqs === 0 ? `<span class="big-zero">0</span>` : `<span class="warn">${reqs}</span>`;
  $("#progress").textContent = `Checked ${state.trials.length} trials on this device. ${state.engine ? "Clinical notes were read by the local model." : "Load the model to also read clinical notes."}`;
  btn.disabled = false;
  if (!state.selected) {
    const best = state.trials.find((t) => state.evals[t.nctId].verdict === "likely") || state.trials.find((t) => state.evals[t.nctId].verdict !== "not_eligible");
    state.selected = (best || state.trials[0]).nctId;
  }
  renderTrials(); renderDetail();
}
$("#run").addEventListener("click", runAll);

async function reevaluate(nctId) {
  const t = state.trials.find((x) => x.nctId === nctId);
  state.evals[nctId] = await evalTrial(t, state.patient, { askModel: state.engine ? askModel : null }, state.answers[nctId] || {});
  renderTrials(); renderDetail();
}

// ---------- trials table ----------
function renderTrials() {
  const rows = state.trials.map((t) => {
    const e = state.evals[t.nctId];
    const sel = state.selected === t.nctId ? " selected" : "";
    return `<tr class="clickable${sel}" data-nct="${t.nctId}">
      <td><strong>${esc(t.title)}</strong><span class="src">${t.nctId} · ${esc(t.sponsor)} · ${t.phase} · ${t.criteria.length} criteria</span></td>
      <td>${e ? `<span class="verdict v-${e.verdict}">${VERDICT_LABEL[e.verdict]}</span>` : `<span class="muted">Not checked</span>`}</td>
      <td class="num">${e ? e.counts.met : ""}</td>
      <td class="num">${e ? e.counts.ask : ""}</td>
      <td class="num">${e ? e.counts.screening : ""}</td>
      <td class="num">${e ? e.counts.not_met : ""}</td></tr>`;
  }).join("");
  $("#trials").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Trial</th><th>Result</th><th class="num">Met</th><th class="num">Questions</th><th class="num">At screening</th><th class="num">Not met</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  document.querySelectorAll("#trials tr[data-nct]").forEach((tr) => tr.addEventListener("click", () => {
    state.selected = tr.dataset.nct; renderTrials(); renderDetail();
  }));
}

// ---------- trial detail ----------
function renderDetail() {
  const box = $("#detail");
  const t = state.trials.find((x) => x.nctId === state.selected);
  const e = t && state.evals[t.nctId];
  if (!t || !e) { box.hidden = true; return; }
  box.hidden = false;
  const answers = state.answers[t.nctId] ||= {};
  const crit = t.criteria.map((c, i) => {
    const r = e.results[i];
    return `<tr>
      <td>${c.kind === "inclusion" ? "Inclusion" : "Exclusion"}</td>
      <td class="crit-text">${esc(c.text)}</td>
      <td class="rule mono">${esc(describeRule(c.rule))}${c.rule.assumption ? `<span class="src">Assumption: ${esc(c.rule.assumption)}</span>` : ""}</td>
      <td><span class="st st-${r.status}">${STATUS_LABEL[r.status]}</span></td>
      <td class="evidence">${esc(r.evidence)}<span class="src">${SOURCE_LABEL[r.source] || ""}</span></td></tr>`;
  }).join("");

  const qs = t.criteria.filter((c, i) => e.results[i].status === "ask" || answers[c.id]);
  const questions = qs.length ? `<h3>Questions your records can't answer (${qs.length})</h3>${qs.map((c) => `
    <div class="question"><div>${esc(c.ask)}</div><div class="choices">
      ${["yes", "no", "unsure"].map((v) => `<button class="choice" data-c="${c.id}" data-v="${v}" aria-pressed="${answers[c.id] === v}">${v === "unsure" ? "Not sure" : v[0].toUpperCase() + v.slice(1)}</button>`).join("")}
    </div></div>`).join("")}` : "";

  let share = "";
  if (e.verdict === "likely") {
    const sent = state.sent[t.nctId];
    const ref = sent || buildReferral(t, state.patient, e, $("#contact")?.value || "");
    share = `<div class="share"><h3>Share a verified summary with the trial site</h3>
      <p class="hint">Only the summary below leaves this device, and only when you send it. Your full record and notes stay here.</p>
      <details><summary>Preview exactly what will be sent</summary><pre class="payload">${esc(JSON.stringify(ref, null, 2))}</pre></details>
      ${sent ? `<div class="notice">Sent to the site inbox (prototype: delivered locally, no server). Reference ${esc(sent.patient.ref)}.</div>` : `
      <label class="field">Contact for the site (email or phone)<input type="text" id="contact" placeholder="e.g. +1 555 0137"></label>
      <label class="check"><input type="checkbox" id="consent"> I agree to share this summary with the site running ${t.nctId}.</label>
      <div class="share-actions"><button class="primary" id="send" disabled>Send to site</button></div>`}</div>`;
  }

  box.innerHTML = `
    <div class="detail-head">
      <div><h2>${esc(t.title)}</h2><span class="muted">${t.nctId} · ${esc(t.sponsor)} · ${t.phase}</span></div>
      <span class="verdict v-${e.verdict}">${VERDICT_LABEL[e.verdict]}</span>
    </div>
    <div class="legend">${Object.keys(STATUS_LABEL).map((s) => `<span class="st st-${s}">${STATUS_LABEL[s]}</span>`).join("")}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>Criterion (registry text)</th><th>Compiled check</th><th>Result</th><th>Evidence</th></tr></thead>
      <tbody>${crit}</tbody></table></div>
    ${questions}${share}`;

  box.querySelectorAll("button.choice").forEach((b) => b.addEventListener("click", () => {
    answers[b.dataset.c] = b.dataset.v; reevaluate(t.nctId);
  }));
  const consent = box.querySelector("#consent"), send = box.querySelector("#send");
  if (consent) consent.addEventListener("change", () => { send.disabled = !consent.checked; });
  if (send) send.addEventListener("click", () => {
    const ref = buildReferral(t, state.patient, e, box.querySelector("#contact").value.trim());
    const inbox = readInbox(); inbox.unshift({ receivedAt: new Date().toISOString(), referral: ref }); writeInbox(inbox);
    state.sent[t.nctId] = ref; renderDetail(); renderInbox();
  });
}

// ---------- site inbox ----------
function readInbox() { try { return JSON.parse(localStorage.getItem(INBOX_KEY) || "[]"); } catch { return []; } }
function writeInbox(v) { try { localStorage.setItem(INBOX_KEY, JSON.stringify(v)); } catch {} }
function renderInbox() {
  const inbox = readInbox();
  $("#inbox-count").textContent = inbox.length ? `(${inbox.length})` : "";
  if (!inbox.length) { $("#inbox").innerHTML = `<p class="muted">No referrals yet. Send one from the patient app.</p>`; return; }
  $("#inbox").innerHTML = inbox.map(({ receivedAt, referral: r }) => {
    const n = (s) => r.criteria.filter((c) => c.status === s).length;
    return `<div class="panel" style="margin-top:12px">
      <div class="detail-head"><div><h2>${esc(r.trial.title)}</h2><span class="muted">${r.trial.nctId} · received ${new Date(receivedAt).toLocaleString()} · ${esc(r.patient.ref)} · ${r.patient.ageYears} ${esc(r.patient.sex)} · contact ${esc(r.patient.contact || "not given")}</span></div>
      <span class="verdict v-${r.result}">${VERDICT_LABEL[r.result]}</span></div>
      <p class="hint">${r.criteria.filter((c) => c.status === "met" && (c.source === "record" || c.source === "notes")).length} met from health records · ${r.criteria.filter((c) => c.status === "met" && c.source === "patient").length} met by patient answer · ${n("screening")} to confirm at screening · full record not shared</p>
      <div class="table-wrap"><table><thead><tr><th>Criterion</th><th>Result</th><th>Evidence</th></tr></thead><tbody>
      ${r.criteria.map((c) => `<tr><td class="crit-text">${esc(c.criterion)}</td><td><span class="st st-${c.status}">${STATUS_LABEL[c.status]}</span></td><td class="evidence">${esc(c.evidence)}<span class="src">${SOURCE_LABEL[c.source] || ""}</span></td></tr>`).join("")}
      </tbody></table></div></div>`;
  }).join("");
}
$("#clear-inbox").addEventListener("click", () => { writeInbox([]); renderInbox(); });

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  $("#view-patient").hidden = b.dataset.view !== "patient";
  $("#view-site").hidden = b.dataset.view !== "site";
  if (b.dataset.view === "site") renderInbox();
}));

// ---------- boot ----------
async function boot() {
  const data = await (await fetch("data/trials.json", { cache: "no-cache" })).json();
  state.trials = data.trials;
  $("#trial-source").textContent = `· ${data.trials.length} type 2 diabetes and obesity trials, criteria compiled from ClinicalTrials.gov on ${data.compiledAt}`;
  $("#patient-select").innerHTML = PATIENTS.map((p) => `<option value="${p.file}">${esc(p.label)}</option>`).join("");
  $("#patient-select").addEventListener("change", (ev) => loadPatientFile(ev.target.value));
  $("#file-input").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    try { setPatient(JSON.parse(await f.text())); } catch (e) { alert("Could not read that file: " + e.message); }
  });
  // Optional deep link for demos: #patient=rahul-venkat&run
  const params = new URLSearchParams(location.hash.slice(1));
  const start = PATIENTS.find((p) => p.file === `${params.get("patient")}.json`) || PATIENTS[0];
  $("#patient-select").value = start.file;
  await loadPatientFile(start.file);
  renderInbox();
  if (params.has("run")) runAll();
}
boot();
