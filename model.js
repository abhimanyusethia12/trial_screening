// On-device language model (WebLLM on WebGPU). Reads clinical notes; nothing leaves the browser tab.
//
// How notes are read (two steps, so a small model cannot invent or misattribute evidence):
//   1. Retrieval, in plain code: split the notes into sentences and keep only those that contain one of the
//      criterion's compiled terms (e.g. "pancreatitis"). No candidate sentence -> "not mentioned", no model call.
//   2. The model sees only the numbered candidate sentences and says whether they make the statement true,
//      false, or don't address it, and which sentence. The quote is that sentence, so it is always real.
// A miss in either step becomes a question for the patient, never a silent pass.

export const MODEL_ID = "Qwen2.5-3B-Instruct-q4f16_1-MLC";
export const MODEL_LABEL = "Prescreen Intelligence";

let engine = null;
let loading = null;
const cache = new Map();

export const hasWebGPU = () => !!navigator.gpu;
export const isReady = () => !!engine;

export function loadModel(onProgress = () => {}) {
  if (engine) return Promise.resolve(engine);
  if (loading) return loading;
  if (!navigator.gpu) return Promise.reject(new Error("WebGPU is not available in this browser"));
  loading = (async () => {
    const webllm = await import("./vendor/web-llm.js");
    engine = await webllm.CreateMLCEngine(MODEL_ID, { initProgressCallback: (r) => onProgress(r.progress || 0, r.text || "") });
    return engine;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function splitSentences(text) {
  return text.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}
const FAMILY = /\b(father|mother|brother|sister|sibling|son|daughter|aunt|uncle|grand\w*|cousin|parent|family)\b/i;
export function candidateSentences(notes, terms, statement = "") {
  const t = (terms || []).map((x) => x.toLowerCase());
  const aboutFamily = FAMILY.test(statement);
  // A sentence about a relative is not evidence about the patient unless the statement asks about family.
  return splitSentences(notes).filter((s) => t.some((x) => s.toLowerCase().includes(x)) && (aboutFamily || !FAMILY.test(s)));
}

const SYSTEM = `You read sentences from a patient's clinical notes and decide whether they show that a statement is true or false for this patient.
- "yes": a sentence clearly shows the statement is true for this patient.
- "no": a sentence clearly shows the statement is false for this patient (for example "denies", "no history of", "not on", "none planned").
- "not_mentioned": no sentence settles it. Use this if a sentence is only loosely related, or is about a different condition.
Family history counts only if the statement mentions a family member.
Reply with one line of JSON and nothing else: {"answer": "yes" | "no" | "not_mentioned", "sentence": <number, or 0>}`;

// Returns { answer: "yes" | "no" | "not_mentioned", quote, candidates }.
export async function askModel(statement, notes, terms, cacheKey = "") {
  const key = cacheKey + "|" + statement;
  if (cache.has(key)) return cache.get(key);
  const cands = candidateSentences(notes, terms, statement);
  let out = { answer: "not_mentioned", quote: "", candidates: cands.length };
  if (cands.length && engine) {
    const list = cands.map((s, i) => `[${i + 1}] ${s}`).join("\n");
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Statement: ${statement}\n\nSentences:\n${list}` },
    ];
    try {
      // No response_format: WebLLM 0.2.87's JSON grammar fails to initialise for this model, so parse the JSON from text.
      const r = await engine.chat.completions.create({ messages, temperature: 0, max_tokens: 40 });
      const txt = r.choices[0].message.content;
      const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
      const n = Number(j.sentence);
      if (["yes", "no"].includes(j.answer) && n >= 1 && n <= cands.length) out = { answer: j.answer, quote: cands[n - 1], candidates: cands.length };
    } catch (e) { console.warn("model call failed:", e?.message || e); }
  } else if (cands.length && !engine) {
    out = null; // model not loaded: caller treats as not read
  }
  if (out) cache.set(key, out);
  return out;
}
