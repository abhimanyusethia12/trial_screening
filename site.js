import { describeRule } from "./engine.js";
import { getTrials, saveTrials, getReferrals, setReferralStatus, getLog, onChange, resetAll } from "./store.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const STATUS = { new: "New", contacted: "Contacted", booked: "Screening booked", not_fit: "Not a fit" };
const RESULT_LABEL = { met: "Met", not_met: "Not met", ask: "Unanswered", screening: "At screening", not_checked: "Not checked" };
const SOURCE_LABEL = { record: "health record", notes: "clinic notes, read on device", patient: "patient answer", site: "screening visit" };
const VERDICT = { likely: "May qualify", questions: "Needs info", not_eligible: "Not eligible" };

const view = { tab: "inbox", ref: null, nct: null, adding: false, session: null };
let trials = [];

// ---------- catalogs for the criteria builder ----------
const CONDITIONS = [
  ["44054006", "Type 2 diabetes"], ["46635009", "Type 1 diabetes"], ["420422005", "Diabetic ketoacidosis"],
  ["714628002", "Prediabetes"], ["414916001", "Obesity"], ["38341003", "Hypertension"], ["55822004", "Dyslipidemia"],
  ["78275009", "Obstructive sleep apnea"], ["53741008", "Coronary artery disease"], ["709044004", "Chronic kidney disease"],
  ["127013003", "Diabetic kidney disease"], ["46177005", "End-stage renal disease"], ["197456007", "Acute pancreatitis"],
  ["235494005", "Chronic pancreatitis"], ["197321007", "Fatty liver"],
];
const LABS = {
  hba1c: { label: "HbA1c", codes: ["4548-4"], unit: "%" },
  bmi: { label: "BMI", codes: ["39156-5"], unit: "kg/m2" },
  weight: { label: "Body weight", codes: ["29463-7"], unit: "kg" },
  egfr: { label: "eGFR", codes: ["98980-6", "98979-8", "62238-1", "33914-3"], unit: "mL/min/1.73m2" },
  uacr: { label: "UACR", codes: ["9318-7"], unit: "mg/g" },
};
const MED_CLASSES = [["biguanide", "Metformin"], ["sglt2", "SGLT2 inhibitor"], ["insulin", "Insulin"], ["glp1", "GLP-1 agonist"], ["dpp4", "DPP-4 inhibitor"], ["sulfonylurea", "Sulfonylurea"], ["tzd", "TZD"], ["acei", "ACE inhibitor"], ["statin", "Statin"]];
const CHECKS = [
  ["site", "At screening visit"], ["age", "Age (record)"], ["condition", "Diagnosis (record)"], ["lab", "Test result (record)"],
  ["med", "Medicine (record)"], ["notes", "Clinic notes (on-device model)"], ["ask", "Patient question"],
];

// How a criterion gets checked before the visit, for the trials view.
function howChecked(rule) {
  const kinds = new Set();
  const walk = (r) => {
    if (["age", "condition", "lab", "med", "medRegimen", "weightStable", "weightChange"].includes(r.type)) kinds.add("record");
    else if (r.type === "notes") kinds.add("notes");
    else if (r.type === "ask") kinds.add("patient");
    else if (r.type === "site") kinds.add("site");
    (r.rules || []).forEach(walk);
  };
  walk(rule);
  return [...kinds];
}
const HOW_LABEL = { record: "Health record", notes: "Clinic notes", patient: "Patient question", site: "At screening" };

// ---------- activity log analysis ----------
function sessions() {
  const by = new Map();
  for (const e of getLog()) { if (!by.has(e.session)) by.set(e.session, []); by.get(e.session).push(e); }
  const now = Date.now();
  return [...by.entries()].map(([id, events]) => {
    const has = (t) => events.some((e) => e.type === t);
    const last = events[events.length - 1];
    const firstCheck = events.find((e) => e.type === "checked");
    const final = [...events].reverse().find((e) => e.type === "result") || firstCheck;
    const referred = events.filter((e) => e.type === "referral_sent").map((e) => e.nct);
    const answered = Math.max(0, ...events.filter((e) => e.type === "answered").map((e) => e.answered));
    const likely = final ? final.outcomes.filter((o) => o.verdict === "likely").map((o) => o.nct) : [];
    let status, stage;
    if (referred.length) { status = "Referred"; stage = "done"; }
    else if (has("result")) {
      stage = "done";
      status = likely.length ? "May qualify, not sent" : final.outcomes.every((o) => o.verdict === "not_eligible") ? "Not eligible" : "Needs more info";
    } else if (has("questions_started")) stage = `at questions (${answered} answered)`;
    else if (firstCheck) stage = firstCheck.outcomes.every((o) => o.verdict === "not_eligible") ? "done" : "before questions";
    else stage = "while checking";
    if (!status) {
      if (stage === "done") status = "Not eligible";
      else status = (now - Date.parse(last.at) < 30 * 60e3 ? "In progress " : "Dropped off ") + stage;
    }
    return { id, events, started: events[0].at, last, firstCheck, final, referred, likely, answered, status };
  }).sort((a, b) => b.started.localeCompare(a.started));
}

function trialStats(nct, all) {
  const s = { checked: 0, byRecord: 0, byAnswers: 0, likely: 0, referred: 0, reasons: {} };
  for (const x of all) {
    const first = x.firstCheck?.outcomes.find((o) => o.nct === nct);
    if (!first) continue;
    s.checked++;
    const fin = x.final.outcomes.find((o) => o.nct === nct) || first;
    if (first.verdict === "not_eligible") s.byRecord++;
    else if (fin.verdict === "not_eligible") s.byAnswers++;
    if (fin.verdict === "likely") s.likely++;
    if (x.referred.includes(nct)) s.referred++;
    for (const c of fin.failed || []) s.reasons[c] = (s.reasons[c] || 0) + 1;
  }
  return s;
}

// ---------- referrals ----------
function renderInbox() {
  const list = getReferrals();
  const sel = list.find((r) => r.referral.patient.ref === view.ref) || list[0];
  const rows = list.map((x) => {
    const r = x.referral;
    const rec = r.criteria.filter((c) => c.status === "met" && (c.source === "record" || c.source === "notes")).length;
    const ans = r.criteria.filter((c) => c.status === "met" && c.source === "patient").length;
    const scr = r.criteria.filter((c) => c.status === "screening").length;
    return `<tr class="clickable${sel === x ? " selected" : ""}" data-ref="${esc(r.patient.ref)}">
      <td>${fmtTime(x.receivedAt)}</td>
      <td><strong>${esc(r.patient.name || "Not given")}</strong><span class="src">${r.patient.ageYears} ${esc(r.patient.sex)} · ${esc(r.patient.ref)}</span></td>
      <td>${esc(r.trial.sponsor)}<span class="src">${r.trial.nctId}</span></td>
      <td class="num">${rec}</td><td class="num">${ans}</td><td class="num">${scr}</td>
      <td><span class="st status-${x.status}">${STATUS[x.status]}</span></td></tr>`;
  }).join("");
  $("#view").innerHTML = `<div class="split">
    <div class="panel">
      <div class="toolbar"><h2>Patients to contact <span class="muted">${list.filter((x) => x.status === "new").length} new</span></h2></div>
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Received</th><th>Patient</th><th>Trial</th><th class="num" title="Criteria met from the health record or clinic notes">From record</th><th class="num" title="Criteria met by the patient's answers">From answers</th><th class="num">At screening</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : `<p class="empty">No referrals yet. They arrive when a patient who may qualify chooses to send their results.</p>`}
    </div>
    <div class="panel" id="ref-detail">${sel ? referralDetail(sel) : `<p class="empty">Select a referral to see its evaluation.</p>`}</div>
  </div>`;
  $("#view").querySelectorAll("tr[data-ref]").forEach((tr) => tr.addEventListener("click", () => { view.ref = tr.dataset.ref; renderInbox(); }));
  $("#view").querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => { setReferralStatus(b.dataset.ref, b.dataset.status); render(); }));
}

function referralDetail(x) {
  const r = x.referral;
  const scr = r.criteria.filter((c) => c.status === "screening");
  const contact = r.patient.contact || "";
  const href = /@/.test(contact) ? `mailto:${contact}` : `tel:${contact.replace(/[^+\d]/g, "")}`;
  return `
    <div class="detail-head">
      <div><h2>${esc(r.patient.name || "Patient")} · ${r.patient.ageYears} ${esc(r.patient.sex)}</h2>
      <span class="muted">${esc(r.trial.title)} · ${r.trial.nctId}</span></div>
      <span class="st status-${x.status}">${STATUS[x.status]}</span>
    </div>
    <dl class="facts">
      <dt>Contact</dt><dd>${contact ? `<a href="${esc(href)}">${esc(contact)}</a>` : "Not given"}</dd>
      <dt>Reference</dt><dd class="mono">${esc(r.patient.ref)}</dd>
      <dt>Received</dt><dd>${fmtTime(x.receivedAt)}</dd>
      <dt>Pre-screen result</dt><dd>${r.criteria.filter((c) => c.status === "met").length} of ${r.criteria.length} criteria met before the visit · ${r.criteria.filter((c) => c.status === "screening").length} to confirm at screening</dd>
      <dt>Not shared</dt><dd class="muted">${esc(r.notShared)}</dd>
    </dl>
    <div class="toolbar"><div class="actions">
      ${Object.entries(STATUS).filter(([k]) => k !== x.status && k !== "new").map(([k, l]) => `<button class="btn${k === "booked" ? " primary" : ""}" data-status="${k}" data-ref="${esc(r.patient.ref)}">Mark ${l.toLowerCase()}</button>`).join("")}
    </div></div>
    ${scr.length ? `<div class="callout"><strong>Confirm at the screening visit (${scr.length})</strong><ul>${scr.map((c) => `<li>${esc(c.criterion)}<span class="src">${esc(c.evidence)}</span></li>`).join("")}</ul></div>` : ""}
    <h3>Evaluation by criterion</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Criterion</th><th>Result</th><th>Evidence</th></tr></thead>
      <tbody>${r.criteria.map((c) => `<tr><td class="crit-text">${c.kind === "exclusion" ? '<span class="muted">Exclusion · </span>' : ""}${esc(c.criterion)}</td>
        <td><span class="st st-${c.status}">${RESULT_LABEL[c.status]}</span></td>
        <td class="evidence">${esc(c.evidence)}<span class="src">${SOURCE_LABEL[c.source] || ""}</span></td></tr>`).join("")}</tbody>
    </table></div>`;
}

// ---------- trials ----------
function renderTrials() {
  if (view.adding) return renderAddTrial();
  const all = sessions();
  const sel = trials.find((t) => t.nctId === view.nct) || null;
  const rows = trials.map((t) => {
    const s = trialStats(t.nctId, all);
    const auto = t.criteria.filter((c) => howChecked(c.rule).some((k) => k === "record" || k === "notes")).length;
    return `<tr class="clickable${sel === t ? " selected" : ""}" data-nct="${t.nctId}">
      <td><strong>${esc(t.title)}</strong><span class="src">${t.nctId} · ${esc(t.sponsor)} · ${esc(t.phase)}${t.addedBy === "site" ? " · added by site" : ""}</span></td>
      <td class="num">${t.criteria.length}</td>
      <td class="num">${auto}</td>
      <td class="num">${s.checked}</td><td class="num">${s.likely}</td><td class="num">${s.referred}</td>
      <td><span class="st ${t.active ? "rec-on" : "rec-off"}">${t.active ? "Recruiting" : "Paused"}</span></td>
      <td><button class="btn" data-toggle="${t.nctId}">${t.active ? "Pause" : "Resume"}</button></td></tr>`;
  }).join("");
  $("#view").innerHTML = `
    <div class="panel">
      <div class="toolbar"><h2>Trials at this site <span class="muted">${trials.filter((t) => t.active).length} recruiting · patients are only checked against recruiting trials</span></h2>
        <div class="actions"><button class="btn primary" id="add">Add trial</button></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Trial</th><th class="num">Criteria</th><th class="num" title="Criteria checked automatically from the record or clinic notes">Auto-checked</th><th class="num">Patients checked</th><th class="num">May qualify</th><th class="num">Referred</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>
    ${sel ? `<div class="panel" style="margin-top:20px">${trialDetail(sel, trialStats(sel.nctId, all))}</div>` : `<p class="hint" style="margin-top:12px">Select a trial to see its recruitment criteria and how each is checked.</p>`}`;
  $("#add").addEventListener("click", () => { view.adding = true; render(); });
  $("#view").querySelectorAll("tr[data-nct]").forEach((tr) => tr.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-toggle]")) return;
    view.nct = tr.dataset.nct; renderTrials();
  }));
  $("#view").querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const t = trials.find((x) => x.nctId === b.dataset.toggle);
    t.active = !t.active; saveTrials(trials); render();
  }));
}

function trialDetail(t, s) {
  const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([id, n]) => `${esc(t.criteria.find((c) => c.id === id)?.text || id)} <span class="muted">(${n})</span>`);
  return `
    <div class="detail-head"><div><h2>${esc(t.title)}</h2>
      <span class="muted">${t.nctId} · ${esc(t.sponsor)} · ${esc(t.phase)} · <a href="https://clinicaltrials.gov/study/${t.nctId}" target="_blank" rel="noopener">Registry listing</a></span></div>
      <span class="st ${t.active ? "rec-on" : "rec-off"}">${t.active ? "Recruiting" : "Paused"}</span></div>
    <dl class="facts">
      <dt>Funnel</dt><dd>${s.checked} checked · ${s.byRecord} ruled out by record · ${s.byAnswers} ruled out by answers · ${s.likely} may qualify · ${s.referred} referred</dd>
      <dt>Top reasons ruled out</dt><dd>${reasons.length ? reasons.join("<br>") : '<span class="muted">No data yet</span>'}</dd>
    </dl>
    <div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>Criterion (registry text)</th><th>Checked by</th><th>Compiled check</th><th>Question to patient</th></tr></thead>
      <tbody>${t.criteria.map((c) => `<tr>
        <td>${c.kind === "inclusion" ? "Inclusion" : "Exclusion"}</td>
        <td class="crit-text">${esc(c.text)}</td>
        <td>${howChecked(c.rule).map((k) => `<span class="how how-${k}">${HOW_LABEL[k]}</span>`).join("<br>")}</td>
        <td class="rule mono">${esc(describeRule(c.rule))}</td>
        <td class="evidence">${esc(c.ask || "")}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

// ---------- add trial ----------
let draft = null;
const blankDraft = () => ({ nctId: "", title: "", sponsor: "", phase: "", criteria: [], msg: "" });
const newRow = (kind = "inclusion", text = "") => ({ kind, text, check: "site", p: {} });

function parseAge(s) { const m = /([\d.]+)\s*Year/i.exec(s || ""); return m ? Number(m[1]) : null; }
function parseEligibility(txt) {
  const rows = [];
  let kind = "inclusion";
  for (const raw of (txt || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^inclusion criteria/i.test(line)) { kind = "inclusion"; continue; }
    if (/^exclusion criteria/i.test(line)) { kind = "exclusion"; continue; }
    const m = /^(?:[*\-•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) rows.push(newRow(kind, m[1].trim()));
    else if (rows.length && rows[rows.length - 1].kind === kind) rows[rows.length - 1].text += " " + line;
  }
  return rows;
}

async function importFromRegistry() {
  const id = draft.nctId.trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(id)) { draft.msg = "err:Enter an NCT ID like NCT01234567."; return renderAddTrial(); }
  draft.msg = "Importing from ClinicalTrials.gov…"; renderAddTrial();
  try {
    const res = await fetch(`https://clinicaltrials.gov/api/v2/studies/${id}?fields=protocolSection.identificationModule,protocolSection.sponsorCollaboratorsModule,protocolSection.designModule,protocolSection.eligibilityModule,protocolSection.statusModule`);
    if (!res.ok) throw new Error(res.status === 404 ? "No study with that ID" : `Registry returned ${res.status}`);
    const ps = (await res.json()).protocolSection;
    const el = ps.eligibilityModule || {};
    draft.nctId = id;
    draft.title = ps.identificationModule?.briefTitle || "";
    draft.sponsor = ps.sponsorCollaboratorsModule?.leadSponsor?.name || "";
    draft.phase = (ps.designModule?.phases || []).map((p) => p.replace("PHASE", "Phase ").replace("EARLY_Phase 1", "Early Phase 1")).join("/") || "Not applicable";
    draft.registryStatus = ps.statusModule?.overallStatus || "";
    draft.criteria = parseEligibility(el.eligibilityCriteria);
    const min = parseAge(el.minimumAge), max = parseAge(el.maximumAge);
    if (min != null || max != null) draft.criteria.unshift({ kind: "inclusion", text: `Age ${el.minimumAge || "any"} to ${el.maximumAge || "no upper limit"}`, check: "age", p: { min: min ?? "", max: max ?? "" } });
    draft.msg = `ok:Imported ${plural(draft.criteria.length, "criterion", "criteria")} (registry status: ${draft.registryStatus.toLowerCase().replace(/_/g, " ")}). Each starts as “At screening visit”; choose how each can be checked before the visit.`;
  } catch (e) { draft.msg = `err:Import failed: ${e.message}. You can enter the trial by hand.`; }
  renderAddTrial();
}

function paramsHtml(row, i) {
  const p = row.p, f = (k, label, type = "text", extra = "") => `<label class="field${extra}">${label}<input type="${type}" data-i="${i}" data-p="${k}" value="${esc(p[k] ?? "")}"></label>`;
  const sel = (k, label, opts) => `<label class="field">${label}<select data-i="${i}" data-p="${k}">${opts.map(([v, l]) => `<option value="${v}"${String(p[k]) === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  switch (row.check) {
    case "age": return f("min", "Min age", "number") + f("max", "Max age", "number");
    case "condition": return sel("code", "Diagnosis (SNOMED)", CONDITIONS.map(([c, l]) => [c, `${l} · ${c}`])) + f("minDays", "Diagnosed ≥ days ago", "number") + f("ask", "Question if record can't tell", "text", " wide");
    case "lab": return sel("lab", "Test (LOINC)", Object.entries(LABS).map(([k, v]) => [k, `${v.label} · ${v.codes[0]}`])) + f("min", "Min", "number") + f("max", "Max", "number") + f("maxAgeDays", "Result ≤ days old", "number");
    case "med": return sel("cls", "Medicine class", MED_CLASSES);
    case "notes": return f("statement", "Statement to look for in notes", "text", " wide") + f("terms", "Words to search (comma-separated)", "text", " wide") + f("ask", "Question if notes don't say", "text", " wide");
    case "ask": return f("ask", "Question to patient (yes means the criterion text is true)", "text", " wide");
    default: return f("reason", "What the site checks", "text", " wide");
  }
}

function renderAddTrial() {
  draft ||= blankDraft();
  const [kind, text] = draft.msg.includes(":") && /^(ok|err):/.test(draft.msg) ? draft.msg.split(/:(.*)/s) : ["", draft.msg];
  $("#view").innerHTML = `<div class="panel">
    <div class="toolbar"><h2>Add a trial</h2><div class="actions"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save and start recruiting</button></div></div>
    <div class="form-grid">
      <label class="field">NCT ID<input type="text" id="f-nct" value="${esc(draft.nctId)}" placeholder="NCT01234567"></label>
      <div><button class="btn" id="import">Import from ClinicalTrials.gov</button></div><div></div><div></div>
      <label class="field" style="grid-column: span 2">Title<input type="text" id="f-title" value="${esc(draft.title)}"></label>
      <label class="field">Sponsor<input type="text" id="f-sponsor" value="${esc(draft.sponsor)}"></label>
      <label class="field">Phase<input type="text" id="f-phase" value="${esc(draft.phase)}" placeholder="Phase 3"></label>
    </div>
    <p class="form-msg ${kind}">${esc(text)}</p>
    <h3>Criteria (${draft.criteria.length})</h3>
    <p class="hint">For each criterion, choose how it can be checked before the visit. Anything you can’t automate stays “At screening visit”. Prototype: compiling is manual; the product would draft these checks for review.</p>
    ${draft.criteria.map((r, i) => `<div class="crit-row">
      <label class="field">Type<select data-i="${i}" data-k="kind"><option value="inclusion"${r.kind === "inclusion" ? " selected" : ""}>Inclusion</option><option value="exclusion"${r.kind === "exclusion" ? " selected" : ""}>Exclusion</option></select></label>
      <label class="field">Registry text<textarea data-i="${i}" data-k="text" rows="2">${esc(r.text)}</textarea></label>
      <label class="field">Checked by<select data-i="${i}" data-k="check">${CHECKS.map(([v, l]) => `<option value="${v}"${r.check === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="params">${paramsHtml(r, i)}</div>
      <button class="x" data-del="${i}" title="Remove criterion" aria-label="Remove criterion">×</button>
    </div>`).join("")}
    <div style="margin-top:12px"><button class="btn" id="add-row">Add criterion</button></div>
  </div>`;
  const v = $("#view");
  const bind = (id, k) => v.querySelector(id).addEventListener("input", (e) => { draft[k] = e.target.value; });
  bind("#f-nct", "nctId"); bind("#f-title", "title"); bind("#f-sponsor", "sponsor"); bind("#f-phase", "phase");
  v.querySelector("#import").addEventListener("click", importFromRegistry);
  v.querySelector("#cancel").addEventListener("click", () => { draft = null; view.adding = false; render(); });
  v.querySelector("#add-row").addEventListener("click", () => { draft.criteria.push(newRow()); renderAddTrial(); });
  v.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { draft.criteria.splice(+b.dataset.del, 1); renderAddTrial(); }));
  v.querySelectorAll("[data-k]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    const row = draft.criteria[+el.dataset.i];
    row[el.dataset.k] = el.value;
    if (el.dataset.k === "check") { row.p = {}; renderAddTrial(); }
  }));
  v.querySelectorAll("[data-p]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => { draft.criteria[+el.dataset.i].p[el.dataset.p] = el.value; }));
  v.querySelector("#save").addEventListener("click", saveDraft);
}

function compileRow(r, i, nct) {
  const p = r.p, num = (x) => (x === "" || x == null ? undefined : Number(x));
  const c = { id: `${nct.toLowerCase()}-${r.kind[0]}${i + 1}`, kind: r.kind, text: r.text.trim() };
  switch (r.check) {
    case "age": c.rule = { type: "age", min: num(p.min), max: num(p.max) }; break;
    case "condition": {
      const [code, label] = CONDITIONS.find(([cd]) => cd === (p.code || CONDITIONS[0][0]));
      c.rule = { type: "condition", codes: [code], label, ...(num(p.minDays) ? { minDurationDays: num(p.minDays) } : {}) };
      if (p.ask) c.ask = p.ask;
      break;
    }
    case "lab": {
      const L = LABS[p.lab || "hba1c"];
      c.rule = { type: "lab", codes: L.codes, label: L.label, unit: L.unit, min: num(p.min), max: num(p.max), maxAgeDays: num(p.maxAgeDays) ?? 90 };
      if (c.rule.min == null && c.rule.max == null) throw new Error(`Criterion ${i + 1}: give a min or max for ${L.label}`);
      break;
    }
    case "med": { const [cls, label] = MED_CLASSES.find(([k]) => k === (p.cls || MED_CLASSES[0][0])); c.rule = { type: "med", classes: [cls], label }; break; }
    case "notes":
      if (!p.statement || !p.terms) throw new Error(`Criterion ${i + 1}: notes checks need a statement and search words`);
      c.rule = { type: "notes", statement: p.statement, terms: p.terms.split(",").map((s) => s.trim()).filter(Boolean) };
      if (p.ask) c.ask = p.ask;
      break;
    case "ask":
      if (!p.ask) throw new Error(`Criterion ${i + 1}: write the question for the patient`);
      c.rule = { type: "ask" }; c.ask = p.ask; break;
    default: c.rule = { type: "site", reason: p.reason || "Checked at the screening visit" };
  }
  return c;
}

function saveDraft() {
  const nct = draft.nctId.trim().toUpperCase();
  try {
    if (!/^NCT\d{8}$/.test(nct)) throw new Error("Enter a valid NCT ID");
    if (!draft.title.trim()) throw new Error("Enter a title");
    if (trials.some((t) => t.nctId === nct)) throw new Error(`${nct} is already in your list`);
    if (!draft.criteria.length) throw new Error("Add at least one criterion");
    const criteria = draft.criteria.map((r, i) => compileRow(r, i, nct));
    trials.push({ nctId: nct, title: draft.title.trim(), sponsor: draft.sponsor.trim(), phase: draft.phase.trim(), criteria, active: true, addedBy: "site", addedAt: new Date().toISOString().slice(0, 10) });
    saveTrials(trials);
    draft = null; view.adding = false; view.nct = nct; render();
  } catch (e) { draft.msg = "err:" + e.message; renderAddTrial(); }
}

// ---------- activity ----------
function renderActivity() {
  const all = sessions();
  const n = (f) => all.filter(f).length;
  const total = all.length;
  const checked = n((s) => s.firstCheck);
  const finished = n((s) => s.final && (s.events.some((e) => e.type === "result") || s.firstCheck.outcomes.every((o) => o.verdict === "not_eligible")));
  const likely = n((s) => s.likely.length);
  const referred = n((s) => s.referred.length);
  const dropped = n((s) => /^Dropped off/.test(s.status));
  const sel = all.find((s) => s.id === view.session);
  const tRows = trials.map((t) => {
    const s = trialStats(t.nctId, all);
    const top = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])[0];
    return `<tr><td><strong>${esc(t.sponsor)}</strong><span class="src">${t.nctId}</span></td>
      <td class="num">${s.checked}</td><td class="num">${s.byRecord}</td><td class="num">${s.byAnswers}</td><td class="num">${s.likely}</td><td class="num">${s.referred}</td>
      <td class="evidence">${top ? `${esc(t.criteria.find((c) => c.id === top[0])?.text || top[0])} <span class="muted">(${top[1]})</span>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
  $("#view").innerHTML = `
    <p class="hint" style="margin:0 0 12px">Anonymous events from the patient app: a random session ID, the step reached and each trial’s outcome. No names, record values or answers. A session is linked to a person only if they send a referral.</p>
    <div class="kpis">
      <div class="kpi"><b>${total}</b><span>Sessions started</span><span class="def">Patient added a record</span></div>
      <div class="kpi"><b>${checked}</b><span>Checks completed</span><span class="def">Record compared with all recruiting trials</span></div>
      <div class="kpi"><b>${finished}</b><span>Reached a result</span><span class="def">Answered all questions, or ruled out by record</span></div>
      <div class="kpi"><b>${likely}</b><span>May qualify</span><span class="def">For at least one trial</span></div>
      <div class="kpi"><b>${referred}</b><span>Referred</span><span class="def">Sent results to this site</span></div>
      <div class="kpi"><b>${dropped}</b><span>Dropped off</span><span class="def">No activity for 30 min before a result</span></div>
    </div>
    <div class="panel"><h2>By trial</h2><div class="table-wrap"><table>
      <thead><tr><th>Trial</th><th class="num">Checked</th><th class="num">Ruled out by record</th><th class="num">Ruled out by answers</th><th class="num">May qualify</th><th class="num">Referred</th><th>Most common reason ruled out</th></tr></thead>
      <tbody>${tRows}</tbody></table></div></div>
    <div class="split" style="margin-top:20px">
      <div class="panel"><h2>Sessions</h2>${all.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Session</th><th>Started</th><th>Status</th><th class="num">May qualify</th><th class="num">Questions answered</th></tr></thead>
        <tbody>${all.map((s) => `<tr class="clickable${sel === s ? " selected" : ""}" data-s="${s.id}"><td class="mono">${s.id}</td><td>${fmtTime(s.started)}</td><td>${esc(s.status)}</td><td class="num">${s.likely.length}</td><td class="num">${s.answered}</td></tr>`).join("")}</tbody>
        </table></div>` : `<p class="empty">No sessions yet. Each check in the patient app appears here.</p>`}</div>
      <div class="panel">${sel ? sessionDetail(sel) : `<p class="empty">Select a session to see its events.</p>`}</div>
    </div>`;
  $("#view").querySelectorAll("tr[data-s]").forEach((tr) => tr.addEventListener("click", () => { view.session = tr.dataset.s; renderActivity(); }));
}

const EVENT_LABEL = { record_loaded: "Record added", checked: "Checked against trials", questions_started: "Started questions", answered: "Answered a question", submitted: "Submitted answers", result: "Result shown", share_opened: "Opened sharing", referral_sent: "Sent referral" };
function sessionDetail(s) {
  const detail = (e) => {
    if (e.type === "record_loaded") return `${e.source === "sample" ? "Sample record" : "Uploaded file"} · ${e.trials} recruiting trials`;
    if (e.type === "checked" || e.type === "result") return e.outcomes.map((o) => `${o.nct}: ${VERDICT[o.verdict]}`).join(" · ") + (e.type === "checked" ? ` · ${e.questions} questions · notes ${e.notesRead ? "read on device" : "not read"}` : "") + (e.requests != null ? ` · ${e.requests} network requests` : "");
    if (e.type === "questions_started") return `${e.questions} questions`;
    if (e.type === "answered" || e.type === "submitted") return `${e.answered} answered`;
    if (e.type === "share_opened") return e.nct;
    if (e.type === "referral_sent") return `${e.nct} · ${e.ref}`;
    return "";
  };
  return `<div class="detail-head"><div><h2>Session <span class="mono">${s.id}</span></h2><span class="muted">${esc(s.status)}</span></div></div>
    <div class="table-wrap"><table class="events"><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
    <tbody>${s.events.map((e) => `<tr><td>${new Date(e.at).toLocaleTimeString()}</td><td>${EVENT_LABEL[e.type] || e.type}</td><td>${esc(detail(e))}</td></tr>`).join("")}</tbody></table></div>`;
}

// ---------- shell ----------
async function render() {
  trials = await getTrials();
  const refs = getReferrals();
  $("#n-inbox").textContent = refs.filter((x) => x.status === "new").length ? `(${refs.filter((x) => x.status === "new").length} new)` : "";
  $("#n-trials").textContent = `(${trials.filter((t) => t.active).length})`;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view.tab)));
  if (view.tab === "inbox") renderInbox();
  else if (view.tab === "trials") renderTrials();
  else renderActivity();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { view.tab = b.dataset.view; if (view.tab !== "trials") view.adding = false; location.hash = view.tab; render(); }));
$("#reset").addEventListener("click", () => { if (confirm("Clear all referrals, activity and trial changes in this prototype?")) { resetAll(); view.ref = view.nct = view.session = null; render(); } });
onChange(() => { if (!view.adding) render(); });
if (["inbox", "trials", "activity"].includes(location.hash.slice(1))) view.tab = location.hash.slice(1);
render();
