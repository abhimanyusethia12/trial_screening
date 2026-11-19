// Shared state between the patient app and the site console.
// Prototype: both apps run on the same origin, so localStorage stands in for the site's server.
// In production, only referrals (on consent) and the anonymous activity events would travel to the site.

const KEYS = { trials: "prescreen.trials.v1", referrals: "prescreen.referrals.v1", log: "prescreen.log.v1" };

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ---------- trials (site-managed) ----------
export async function getTrials() {
  let trials = read(KEYS.trials, null);
  if (!trials) {
    const data = await (await fetch("data/trials.json", { cache: "no-cache" })).json();
    trials = data.trials.map((t) => ({ ...t, active: true, addedBy: "seed", addedAt: data.compiledAt }));
    write(KEYS.trials, trials);
  }
  return trials;
}
export function saveTrials(trials) { write(KEYS.trials, trials); }
export async function getActiveTrials() { return (await getTrials()).filter((t) => t.active); }

// ---------- referrals (sent by the patient on consent) ----------
export function getReferrals() { return read(KEYS.referrals, []); }
export function addReferral(referral) {
  const list = getReferrals();
  list.unshift({ receivedAt: new Date().toISOString(), status: "new", referral });
  write(KEYS.referrals, list);
}
export function setReferralStatus(ref, status) {
  const list = getReferrals();
  const r = list.find((x) => x.referral.patient.ref === ref);
  if (r) { r.status = status; r.updatedAt = new Date().toISOString(); write(KEYS.referrals, list); }
}

// ---------- anonymous activity log ----------
// Events carry a random session id, the step, and trial outcomes. Never names, values or notes.
export function getLog() { return read(KEYS.log, []); }
export function logEvent(session, type, detail = {}) {
  const log = getLog();
  log.push({ at: new Date().toISOString(), session, type, ...detail });
  write(KEYS.log, log);
}
export function newSessionId() { return "s-" + Math.random().toString(36).slice(2, 8); }

export function resetAll() { Object.values(KEYS).forEach((k) => { try { localStorage.removeItem(k); } catch {} }); }

// Re-render when the other app (another tab) changes shared state.
export function onChange(fn) { addEventListener("storage", (e) => { if (Object.values(KEYS).includes(e.key)) fn(e.key); }); }
