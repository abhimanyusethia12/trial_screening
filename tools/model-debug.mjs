// Call the on-device model directly in headless Brave and print raw output or errors.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  headless: true, userDataDir: process.env.SHOT_PROFILE || "/private/tmp/claude-502/brave-profile",
  args: ["--enable-unsafe-webgpu", "--no-first-run"], protocolTimeout: 0,
});
const page = await browser.newPage();
await (await page.createCDPSession()).send("Network.clearBrowserCache");
page.on("console", (m) => console.log("[console]", m.text().slice(0, 400)));
await page.goto("http://127.0.0.1:8080/legacy.html", { waitUntil: "networkidle0" });
const out = await page.evaluate(async () => {
  const webllm = await import("./vendor/web-llm.js");
  const t0 = performance.now();
  const eng = await webllm.CreateMLCEngine("Qwen2.5-3B-Instruct-q4f16_1-MLC");
  const log = [`load ${(performance.now() - t0) / 1000 | 0}s`];
  const notes = "Annual review. Father was diagnosed with medullary thyroid carcinoma at age 58. One severe hypoglycemia episode in August requiring assistance. No dialysis.";
  const messages = [
    { role: "system", content: "You check a patient's clinical notes. Reply with JSON." },
    { role: "user", content: `Notes: ${notes}\nStatement: The patient or a family member has had medullary thyroid cancer.\nReply with JSON only: {"answer": "yes"|"no"|"not_mentioned", "quote": "..."}` },
  ];
  for (const opts of [{ response_format: { type: "json_object" } }, {}]) {
    try {
      const t = performance.now();
      const r = await eng.chat.completions.create({ messages, temperature: 0, max_tokens: 160, ...opts });
      log.push(`${JSON.stringify(opts)} -> ${r.choices[0].message.content} (${((performance.now() - t) / 1000).toFixed(1)}s)`);
    } catch (e) { log.push(`${JSON.stringify(opts)} ERROR: ${e?.name}: ${e?.message}`); }
  }
  return log;
});
out.forEach((l) => console.log(l));
await browser.close();
