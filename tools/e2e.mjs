// End-to-end test in headless Brave with the real on-device model.
// Patient app (phone viewport) for each sample patient, then the site console. Screenshots to $OUT.
// Usage: OUT=/path node tools/e2e.mjs
import puppeteer from "puppeteer-core";

const OUT = process.env.OUT || ".";
const BASE = process.env.BASE || "http://127.0.0.1:8080";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  headless: true, userDataDir: process.env.SHOT_PROFILE || "/private/tmp/claude-502/brave-profile",
  args: ["--enable-unsafe-webgpu", "--no-first-run"], protocolTimeout: 0,
});
const page = await browser.newPage();
await (await page.createCDPSession()).send("Network.clearBrowserCache");
page.on("console", (m) => { if (["error", "warn"].includes(m.type()) && !/404/.test(m.text())) console.log("  [console]", m.type(), m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
page.on("dialog", (d) => d.accept());

const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\n+/g, " | "));
const shot = (name, full = true) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const click = async (sel) => { await page.waitForSelector(sel); await page.click(sel); };
const clickText = async (sel, t) => {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((b) => b.textContent.trim().startsWith(t)), {}, sel, t);
  await page.evaluate((s, t) => [...document.querySelectorAll(s)].find((b) => b.textContent.trim().startsWith(t)).click(), sel, t);
};

// fresh state
await page.goto(`${BASE}/site.html`, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());

async function patientRun(id, answerFn, sendFor) {
  console.log(`\n== ${id}`);
  // Load the page once; later patients use "Start over" so the model stays loaded (as for a real user).
  if (id === "elena-marsh") {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/patient.html`, { waitUntil: "networkidle0" });
    await shot("p0-welcome", false);
  } else {
    if (await page.$("#back")) await click("#back");
    await click("#restart");
  }
  await page.waitForSelector(".sample");
  await page.evaluate(() => document.querySelector("details").open = true);
  const t0 = Date.now();
  await click(`.sample[data-id="${id}"]`);
  await page.waitForSelector("#go", { timeout: 0 });
  console.log(`  checked in ${((Date.now() - t0) / 1000).toFixed(1)}s (includes model start)`);
  console.log("  " + (await text("#app")).slice(0, 400));
  await shot(`${id}-1-checked`);
  let n = 0;
  if ((await text("#go")).startsWith("Answer")) {
    await click("#go");
    while (await page.$(".q-text")) {
      const q = await text(".q-text");
      const quote = await page.$(".card") ? await text(".card") : "";
      const a = answerFn(q, quote);
      console.log(`  Q${++n}: ${q}${quote ? `  [${quote}]` : ""} -> ${a}`);
      if (n === 1) await shot(`${id}-2-question`, false);
      if (quote && !(await page.$(`#__shot_${id}`))) { await shot(`${id}-2-confirm`, false); await page.evaluate((id) => { const i = document.createElement("i"); i.id = `__shot_${id}`; i.hidden = true; document.body.append(i); }, id); }
      await clickText(".choice", a);
      await page.waitForFunction((k) => !document.querySelector(".q-text") || document.querySelector(".q-progress").textContent.includes(`Question ${k + 1} `), {}, n);
    }
    await page.waitForSelector("#submit");
    await shot(`${id}-3-review`);
    await click("#submit");
  } else await click("#go");
  await page.waitForFunction(() => document.querySelector(".step-label")?.textContent === "Your results", { timeout: 0 });
  console.log("  RESULT: " + (await text("#app")).slice(0, 900));
  await shot(`${id}-4-results`);
  if (sendFor) {
    await click(`[data-share="${sendFor}"]`);
    await shot(`${id}-5-share`);
    await page.type("#contact", "+1 555 0137");
    await page.click("#consent");
    await click("#send");
    await page.waitForSelector(".ref");
    await shot(`${id}-6-sent`);
    console.log("  SENT: " + (await text("#app")).slice(0, 200));
  }
}

const yesTo = (patterns) => (q) => (patterns.some((p) => p.test(q)) ? "Yes" : "No");
// Elena: stable meds and weight; everything else no.
await patientRun("elena-marsh", yesTo([/stayed (roughly )?the same/i, /contraception/i]), "NCT07662044");
// Rahul: confirms the family history the notes show.
await patientRun("rahul-venkat", (q, quote) => (/medullary/i.test(q) && quote ? "Yes" : /stayed (roughly )?the same/i.test(q) ? "Yes" : "No"), "NCT07271186");
// Maya: tried diet; willing to use contraception; drops a question as "Not sure".
await patientRun("maya-okafor", (q) => (/tried to lose weight|contraception/i.test(q) ? "Yes" : /hormone/i.test(q) ? "Not sure" : "No"), null);

// a dropped-off session: record checked, one answer, then leave
await click("#restart");
await page.waitForSelector(".sample");
await page.evaluate(() => document.querySelector("details").open = true);
await click('.sample[data-id="maya-okafor"]');
await page.waitForSelector("#go", { timeout: 0 });
await click("#go"); await clickText(".choice", "No");

// ---- site console
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await page.goto(`${BASE}/site.html`, { waitUntil: "networkidle0" });
console.log("\n== site inbox: " + (await text("#view")).slice(0, 700));
await shot("s1-inbox");
await clickText(".tabs button", "Trials");
await clickText("#view tr[data-nct] strong", "ALN-ANG3");
await shot("s2-trials");
console.log("\n== site trials: " + (await text("#view")).slice(0, 900));
await clickText("[data-toggle]", "Pause");
console.log("  after pause: " + (await text("#n-trials")));
await clickText(".tabs button", "Activity");
await page.evaluate(() => document.querySelector("tr[data-s]")?.click());
await shot("s3-activity");
console.log("\n== activity: " + (await text("#view")).slice(0, 1200));
// add trial via registry import
await clickText(".tabs button", "Trials");
await click("#add");
await page.type("#f-nct", "NCT07668388");
await click("#import");
await page.waitForFunction(() => /Imported|failed/.test(document.querySelector(".form-msg").textContent), { timeout: 20000 });
console.log("\n== import: " + (await text(".form-msg")) + ` · rows ${await page.$$eval(".crit-row", (r) => r.length)}`);
await shot("s4-add-trial");
// It is already in the list (the seeded Novo trial), so saving must refuse; then use an ID that isn't.
await click("#save");
console.log("  save duplicate: " + (await text(".form-msg")));
await page.evaluate(() => { const i = document.querySelector("#f-nct"); i.value = "NCT99999999"; i.dispatchEvent(new Event("input")); });
await click("#save");
await page.waitForSelector("#add");
console.log("  after save: trials " + (await text("#n-trials")) + " · selected: " + (await text("#view .panel + .panel h2")));
await shot("s5-trial-added");
// The patient app now checks against the new trial and not the paused one
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.goto(`${BASE}/patient.html#sample=elena-marsh`, { waitUntil: "networkidle0" });
await page.waitForSelector("#go", { timeout: 0 });
console.log("  patient app sees: " + (await text(".steps li:last-child")));
await shot("p-header-check", false);
await browser.close();
