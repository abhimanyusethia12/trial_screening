// Node check of the deterministic engine (model off), plus a fake model that reads notes by keyword.
// Run: node tools/check.mjs
import { readFileSync, readdirSync } from "node:fs";
import { parseBundle, evalTrial } from "../engine.js";

const root = new URL("..", import.meta.url).pathname;
const { trials } = JSON.parse(readFileSync(root + "data/trials.json", "utf8"));
const asOf = "2026-11-19";

// Keyword stand-in for the on-device model, only to exercise the second pass in Node.
const fakeModel = async (statement, text) => {
  const s = statement.toLowerCase(), t = text.toLowerCase();
  if (s.includes("medullary")) return t.includes("father was diagnosed with medullary") ? { answer: "yes", quote: "Father was diagnosed with medullary thyroid carcinoma at age 58." } : { answer: "not_mentioned", quote: "" };
  if (s.includes("pancreatitis")) return t.includes("no history of pancreatitis") || t.includes("denies history of pancreatitis") ? { answer: "no", quote: "No history of pancreatitis." } : { answer: "not_mentioned", quote: "" };
  if (s.includes("lose weight")) return t.includes("diet and walking") ? { answer: "yes", quote: "Completed a 6-month structured diet and walking programme in 2025 with less than 2 kg weight loss." } : { answer: "not_mentioned", quote: "" };
  return { answer: "not_mentioned", quote: "" };
};

for (const f of readdirSync(root + "data/patients")) {
  const p = parseBundle(JSON.parse(readFileSync(root + "data/patients/" + f, "utf8")), asOf);
  console.log(`\n## ${p.name} (${p.age}${p.sex[0]})`);
  for (const t of trials) {
    for (const [label, env] of [["model off", { askModel: null }], ["fake model", { askModel: fakeModel }]]) {
      const e = await evalTrial(t, p, env);
      console.log(`${t.nctId} [${label}] ${e.verdict.padEnd(12)} ${JSON.stringify(e.counts)}`);
      if (label === "fake model") e.results.forEach((r, i) => r.status === "not_met" && console.log(`    not met: ${t.criteria[i].id} — ${r.evidence}`));
    }
  }
}
