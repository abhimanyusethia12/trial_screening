// Accuracy of the on-device notes model against hand-labelled expectations (data/notes-eval.json).
// Runs the real model in headless Brave (WebGPU). Usage: node tools/notes-eval.mjs
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  headless: true, userDataDir: process.env.SHOT_PROFILE || "/private/tmp/claude-502/brave-profile",
  args: ["--enable-unsafe-webgpu", "--no-first-run"], protocolTimeout: 0,
});
const page = await browser.newPage();
await (await page.createCDPSession()).send("Network.clearBrowserCache");
page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("[console]", m.text().slice(0, 300)); });
await page.goto("http://127.0.0.1:8080/patient.html", { waitUntil: "networkidle0" });
const rows = await page.evaluate(async () => {
  const { loadModel, askModel } = await import("./model.js");
  const { parseBundle } = await import("./engine.js");
  const gold = await (await fetch("data/notes-eval.json")).json();
  const trials = (await (await fetch("data/trials.json")).json()).trials;
  const termsFor = {};
  const walk = (r) => { if (r.type === "notes") termsFor[r.statement] = r.terms; (r.rules || []).forEach(walk); };
  trials.forEach((t) => t.criteria.forEach((c) => walk(c.rule)));
  await loadModel();
  const out = [];
  for (const [pid, exp] of Object.entries(gold.expected)) {
    const p = parseBundle(await (await fetch(`data/patients/${pid}.json`)).json(), "2026-11-19");
    const notes = p.notes.map((n) => n.text).join("\n");
    for (const [sid, ok] of Object.entries(exp)) {
      const t = performance.now();
      const r = await askModel(gold.statements[sid], notes, termsFor[gold.statements[sid]], pid);
      out.push({ pid, sid, ok, answer: r.answer, quote: r.quote, secs: (performance.now() - t) / 1000 });
    }
  }
  return out;
});
let right = 0, critical = 0, missed = 0;
for (const r of rows) {
  const good = r.ok.includes(r.answer);
  const crit = !good && r.answer !== "not_mentioned";
  right += good; critical += crit; missed += !good && !crit;
  console.log(`${good ? "ok  " : crit ? "CRIT" : "miss"} ${r.pid.padEnd(13)} ${r.sid.padEnd(7)} ${r.answer.padEnd(14)} ${r.secs.toFixed(1)}s ${r.quote ? `"${r.quote.slice(0, 80)}"` : ""}`);
}
const secs = rows.map((r) => r.secs);
console.log(`\n${right}/${rows.length} as expected · ${critical} wrong yes/no (critical) · ${missed} missed (became a patient question) · median ${secs.sort((a, b) => a - b)[secs.length >> 1].toFixed(1)}s per call`);
await browser.close();
