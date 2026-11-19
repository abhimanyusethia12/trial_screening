// Real-model test in headless Brave (WebGPU): load the model, run a patient, print the results table.
// Usage: node tools/model-test.mjs [patient-id] [out.png]
import puppeteer from "puppeteer-core";

const [patient = "rahul-venkat", out = "model-test.png"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  headless: true,
  userDataDir: process.env.SHOT_PROFILE || "/private/tmp/claude-502/brave-profile",
  args: ["--enable-unsafe-webgpu", "--no-first-run", "--no-default-browser-check"],
  defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
  protocolTimeout: 0,
});
const page = await browser.newPage();
await (await page.createCDPSession()).send("Network.clearBrowserCache");
page.on("console", (m) => { if (["error", "warn"].includes(m.type())) console.log("[console]", m.type(), m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:8080/legacy.html#patient=${patient}`, { waitUntil: "networkidle0" });
const t0 = Date.now();
await page.click("#load-model");
let last = "";
for (;;) {
  const s = await page.$eval("#model-status", (e) => e.textContent);
  if (s !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] model: ${s}`); last = s; }
  if (/running|failed|not available/i.test(s)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const t1 = Date.now();
await page.click("#run");
await page.waitForFunction(() => /^Checked/.test(document.querySelector("#progress").textContent), { timeout: 0 });
console.log(`check took ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log("requests during check:", await page.$eval("#req-count", (e) => e.textContent));
const rows = await page.$$eval("#trials tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.replace(/\s+/g, " ").trim()).join(" | ")));
rows.forEach((r) => console.log(r));
// Evidence from notes for every trial
for (const nct of await page.$$eval("#trials tbody tr", (trs) => trs.map((t) => t.dataset.nct))) {
  await page.click(`#trials tr[data-nct="${nct}"]`);
  const ev = await page.$$eval("#detail tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((c) => c.innerText.replace(/\s+/g, " ").trim())).filter((c) => /clinical notes/.test(c[4] || "")).map((c) => `${c[3]} :: ${c[1].slice(0, 70)} :: ${c[4]}`));
  console.log(`-- ${nct} notes-based:`); ev.forEach((e) => console.log("   ", e));
}
await page.screenshot({ path: out, fullPage: true });
await browser.close();
