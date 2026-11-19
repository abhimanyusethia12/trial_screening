// Eligibility engine. Runs entirely on the device: no network calls.
// Deterministic checks over FHIR data, plus an optional local language model for clinical notes.

const DAY = 864e5;

// RxNorm ingredient code -> drug class used by the compiled rules.
export const MED_CLASSES = {
  "6809": "biguanide",
  "1545653": "sglt2",
  "1488564": "sglt2",
  "274783": "insulin",
  "1991302": "glp1",
  "29046": "acei",
  "83367": "statin",
  "17767": "ccb",
};
const CLASS_LABEL = {
  biguanide: "metformin", sglt2: "SGLT2 inhibitor", insulin: "insulin", glp1: "GLP-1 agonist",
  dpp4: "DPP-4 inhibitor", sulfonylurea: "sulfonylurea", tzd: "TZD",
};
const DIABETES_CLASSES = ["biguanide", "sglt2", "insulin", "glp1", "dpp4", "sulfonylurea", "tzd"];

const fmtDate = (d) => d.slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

// ---------- FHIR parsing ----------
function decodeBase64(s) {
  if (typeof atob === "function") return decodeURIComponent(escape(atob(s)));
  return Buffer.from(s, "base64").toString("utf8");
}

export function parseBundle(bundle, asOf) {
  const res = (bundle.entry || []).map((e) => e.resource).filter(Boolean);
  const pt = res.find((r) => r.resourceType === "Patient");
  if (!pt) throw new Error("No Patient resource in this file");
  const birth = pt.birthDate;
  let age = new Date(asOf).getUTCFullYear() - Number(birth.slice(0, 4));
  if (asOf.slice(5, 10) < birth.slice(5, 10)) age -= 1;

  const conditions = res.filter((r) => r.resourceType === "Condition").map((c) => {
    const cd = c.code?.coding?.[0] || {};
    return { code: cd.code, display: c.code?.text || cd.display, onset: c.onsetDateTime || null };
  });
  const obs = {};
  for (const o of res.filter((r) => r.resourceType === "Observation" && r.valueQuantity)) {
    const cd = o.code?.coding?.[0] || {};
    (obs[cd.code] ||= []).push({ code: cd.code, display: o.code?.text || cd.display, value: o.valueQuantity.value, unit: o.valueQuantity.unit, date: o.effectiveDateTime });
  }
  for (const k in obs) obs[k].sort((a, b) => b.date.localeCompare(a.date)); // newest first
  const meds = res.filter((r) => ["MedicationStatement", "MedicationRequest"].includes(r.resourceType) && r.status === "active").map((m) => {
    const cd = m.medicationCodeableConcept?.coding?.[0] || {};
    return { code: cd.code, display: m.medicationCodeableConcept?.text || cd.display, cls: MED_CLASSES[cd.code] || null, start: m.effectivePeriod?.start || m.authoredOn || null };
  });
  const notes = res.filter((r) => r.resourceType === "DocumentReference").map((d) => ({
    title: d.description || "Clinical note",
    date: d.date,
    text: (d.content || []).map((c) => (c.attachment?.data ? decodeBase64(c.attachment.data) : "")).join("\n"),
  }));
  const name = pt.name?.[0]?.text || [pt.name?.[0]?.given?.join(" "), pt.name?.[0]?.family].filter(Boolean).join(" ");
  return { id: pt.id, name, sex: pt.gender, birth, age, conditions, obs, meds, notes, asOf };
}

// ---------- rule descriptions (the "compiled" form shown to users) ----------
export function describeRule(r) {
  switch (r.type) {
    case "age": return `age ${r.min ?? 0}${r.max ? `–${r.max}` : "+"} years`;
    case "condition": return `condition: ${r.label} [SNOMED ${r.codes.join(", ")}]${r.minDurationDays ? `, onset ≥ ${r.minDurationDays} days ago` : ""}`;
    case "lab": {
      const range = r.maxExclusive != null ? `${r.min} to <${r.maxExclusive}` : r.max != null && r.min != null ? `${r.min}–${r.max}` : r.min != null ? `≥ ${r.min}` : `≤ ${r.max}`;
      return `${r.label} [LOINC ${r.codes[0]}] ${range} ${r.unit}, result ≤ ${r.maxAgeDays} days old`;
    }
    case "med": return `active medication in class: ${r.label}`;
    case "medRegimen": return `diabetes medicines = ${r.required.map((c) => CLASS_LABEL[c]).join(" + ")}${r.allowed.length > r.required.length ? ` ± ${r.allowed.filter((c) => !r.required.includes(c)).map((c) => CLASS_LABEL[c]).join(", ")}` : ""}, started ≥ ${r.minDays} days ago`;
    case "weightStable": return `body weight change ≤ ${r.maxPct}% over ${r.days} days`;
    case "weightChange": return `body weight change > ${r.maxPct ? r.maxPct + "%" : r.maxKg + " kg"} over ${r.days} days`;
    case "notes": return `on-device model reads notes: "${r.statement}"`;
    case "ask": return r.appliesTo ? `patient question (${r.appliesTo} only)` : "patient question";
    case "site": return `confirmed at screening visit: ${r.reason}`;
    case "anyOf": return r.rules.map(describeRule).join("  OR  ");
    case "allOf": return "(" + r.rules.map(describeRule).join("  AND  ") + ")";
    default: return r.type;
  }
}

// ---------- rule evaluation: returns { value: true|false|null, evidence, source } ----------
// value = whether the statement in the criterion is true for this patient.
async function evalRule(r, p, env) {
  switch (r.type) {
    case "age": {
      const ok = p.age >= (r.min ?? 0) && p.age <= (r.max ?? 200);
      return { value: ok, evidence: `Age ${p.age} (born ${p.birth})`, source: "record" };
    }
    case "condition": {
      const hits = p.conditions.filter((c) => r.codes.includes(c.code));
      if (!hits.length) return { value: false, evidence: `No ${r.label.toLowerCase()} in records`, source: "record" };
      const c = hits[0];
      if (r.minDurationDays && c.onset) {
        const d = daysBetween(c.onset, p.asOf);
        return { value: d >= r.minDurationDays, evidence: `${c.display}, onset ${fmtDate(c.onset)} (${d} days)`, source: "record" };
      }
      return { value: true, evidence: `${c.display}${c.onset ? `, onset ${fmtDate(c.onset)}` : ""}`, source: "record" };
    }
    case "lab": {
      const vals = r.codes.flatMap((c) => p.obs[c] || []).sort((a, b) => b.date.localeCompare(a.date));
      if (!vals.length) return { value: null, evidence: `No ${r.label} result in records`, source: "record" };
      const v = vals[0];
      const age = daysBetween(v.date, p.asOf);
      const txt = `${r.label} ${v.value} ${v.unit} on ${fmtDate(v.date)}`;
      if (age > r.maxAgeDays) return { value: null, evidence: `${txt}: older than ${r.maxAgeDays} days`, source: "record" };
      let ok = true;
      if (r.min != null && v.value < r.min) ok = false;
      if (r.max != null && v.value > r.max) ok = false;
      if (r.maxExclusive != null && v.value >= r.maxExclusive) ok = false;
      return { value: ok, evidence: txt, source: "record" };
    }
    case "med": {
      const hits = p.meds.filter((m) => r.classes.includes(m.cls));
      return hits.length
        ? { value: true, evidence: hits.map((m) => m.display).join("; "), source: "record" }
        : { value: false, evidence: `No ${r.label} in active medications`, source: "record" };
    }
    case "medRegimen": {
      const dm = p.meds.filter((m) => DIABETES_CLASSES.includes(m.cls));
      const classes = new Set(dm.map((m) => m.cls));
      const list = dm.map((m) => m.display).join("; ") || "no diabetes medicines";
      if (!r.required.every((c) => classes.has(c))) return { value: false, evidence: `Diabetes medicines: ${list}`, source: "record" };
      const extra = dm.filter((m) => !r.allowed.includes(m.cls));
      if (extra.length) return { value: false, evidence: `Also on ${extra.map((m) => m.display).join("; ")}`, source: "record" };
      const recent = dm.filter((m) => m.start && daysBetween(m.start, p.asOf) < r.minDays);
      if (recent.length) return { value: false, evidence: `${recent.map((m) => m.display).join("; ")} started < ${r.minDays} days ago`, source: "record" };
      return { value: true, evidence: `Diabetes medicines: ${list}`, source: "record" };
    }
    case "weightStable":
    case "weightChange": {
      const w = (p.obs["29463-7"] || []).filter((o) => daysBetween(o.date, p.asOf) <= r.days + 30);
      if (w.length < 2) return { value: null, evidence: "Fewer than two recent weights in records", source: "record" };
      const newest = w[0], oldest = w[w.length - 1];
      const kg = Math.abs(newest.value - oldest.value);
      const pct = (kg / oldest.value) * 100;
      const txt = `${oldest.value} kg (${fmtDate(oldest.date)}) → ${newest.value} kg (${fmtDate(newest.date)}): ${kg.toFixed(1)} kg, ${pct.toFixed(1)}%`;
      const over = r.maxPct != null ? pct > r.maxPct : kg > r.maxKg;
      return { value: r.type === "weightStable" ? !over : over, evidence: txt, source: "record" };
    }
    case "notes": {
      if (!env.askModel) return { value: null, evidence: "Clinical notes not read (model off)", source: "notes" };
      const text = p.notes.map((n) => n.text).join("\n");
      if (!text.trim()) return { value: null, evidence: "No clinical notes in records", source: "notes" };
      const out = await env.askModel(r.statement, text, r.terms || []);
      if (!out) return { value: null, evidence: "Clinical notes not read (model off)", source: "notes" };
      if (out.answer === "not_mentioned") return { value: null, evidence: "Not mentioned in notes", source: "notes" };
      return { value: out.answer === "yes", evidence: `Note: "${out.quote}"`, source: "notes" };
    }
    case "anyOf": {
      const outs = [];
      for (const sub of r.rules) {
        const o = await evalRule(sub, p, env);
        if (o.value === true) return o;
        outs.push(o);
      }
      if (outs.every((o) => o.value === false)) return { value: false, evidence: outs.map((o) => o.evidence).join("; "), source: outs[0].source };
      return { value: null, evidence: outs.map((o) => o.evidence).join("; "), source: "record" };
    }
    case "allOf": {
      const outs = [];
      for (const sub of r.rules) {
        const o = await evalRule(sub, p, env);
        if (o.value === false) return o;
        outs.push(o);
      }
      if (outs.every((o) => o.value === true)) return { value: true, evidence: outs.map((o) => o.evidence).join("; "), source: "record" };
      return { value: null, evidence: outs.map((o) => o.evidence).join("; "), source: "record" };
    }
    default:
      return { value: null, evidence: "", source: "record" };
  }
}

// ---------- criterion + trial evaluation ----------
// status: met | not_met | ask | screening | not_checked
export async function evalCriterion(c, p, env, answers) {
  const r = c.rule;
  const fromStatement = (v) => (c.kind === "inclusion" ? (v ? "met" : "not_met") : v ? "not_met" : "met");
  if (r.type === "site") return { status: "screening", evidence: r.reason, source: "site" };
  if (r.type === "ask") {
    if (r.appliesTo && r.appliesTo !== p.sex) return { status: "met", evidence: `Not applicable (${p.sex})`, source: "record" };
    const a = answers[c.id];
    if (a == null) return { status: "ask", evidence: "Needs the patient's answer", source: "patient" };
    if (a === "unsure") return { status: "screening", evidence: "Patient unsure: confirm at screening", source: "patient" };
    return { status: fromStatement(a === "yes"), evidence: `Patient answered "${a}"`, source: "patient" };
  }
  const o = await evalRule(r, p, env);
  const a = answers[c.id];
  if (o.value !== null) {
    const status = fromStatement(o.value);
    // Safety rule: the notes model may confirm a criterion but never exclude on its own.
    // An exclusion read from notes becomes a question that shows the quote for the patient to confirm.
    if (status === "not_met" && o.source === "notes" && c.ask) {
      if (a == null) return { status: "ask", evidence: o.evidence, source: "notes", confirm: true };
      if (a === "unsure") return { status: "screening", evidence: `${o.evidence}. Patient unsure: confirm at screening`, source: "patient" };
      return { status: fromStatement(a === "yes"), evidence: `${o.evidence}. Patient answered "${a}"`, source: "patient" };
    }
    return { status, evidence: o.evidence, source: o.source };
  }
  if (c.ask && a != null) {
    if (a === "unsure") return { status: "screening", evidence: `${o.evidence}. Patient unsure: confirm at screening`, source: "patient" };
    return { status: fromStatement(a === "yes"), evidence: `${o.evidence}. Patient answered "${a}"`, source: "patient" };
  }
  if (c.ask) return { status: "ask", evidence: o.evidence, source: o.source };
  return { status: "screening", evidence: `${o.evidence}. Measured at screening`, source: "site" };
}

export function summarise(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const counts = { met: n("met"), not_met: n("not_met"), ask: n("ask"), screening: n("screening"), not_checked: n("not_checked") };
  const verdict = counts.not_met ? "not_eligible" : counts.ask ? "questions" : "likely";
  return { counts, verdict };
}

// Two passes: record rules first; the model only reads notes for trials not already excluded.
export async function evalTrial(trial, p, env, answers = {}) {
  const first = [];
  for (const c of trial.criteria) first.push(await evalCriterion(c, p, { askModel: null }, answers));
  if (first.some((r) => r.status === "not_met")) {
    const results = first.map((r) =>
      r.status === "ask" ? { status: "not_checked", evidence: "Not needed: trial already excluded by records", source: "record" } : r
    );
    return { results, ...summarise(results) };
  }
  const results = [];
  for (const c of trial.criteria) results.push(await evalCriterion(c, p, env, answers));
  return { results, ...summarise(results) };
}

// ---------- the only thing that leaves the device, and only on consent ----------
export function buildReferral(trial, p, evaluation, contact) {
  return {
    type: "verified-prescreen-referral",
    version: 1,
    trial: { nctId: trial.nctId, title: trial.title, sponsor: trial.sponsor },
    generatedAt: new Date().toISOString(),
    patient: { ref: "ref-" + Math.random().toString(36).slice(2, 10), ageYears: p.age, sex: p.sex, contact },
    result: evaluation.verdict,
    criteria: trial.criteria.map((c, i) => ({
      id: c.id,
      kind: c.kind,
      criterion: c.text,
      status: evaluation.results[i].status,
      source: evaluation.results[i].source,
      evidence: evaluation.results[i].evidence,
    })),
    notShared: "Full health record, clinical notes, other conditions and medications stay on the patient's device.",
  };
}
