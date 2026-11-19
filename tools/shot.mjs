// Drive Brave via puppeteer-core: screenshot a page, optionally run steps.
// Usage: node tools/shot.mjs <url> <out.png> [width] [height] [--headful]
import puppeteer from "puppeteer-core";

const [url = "http://127.0.0.1:8080", out = "shot.png", w = "1280", h = "900"] = process.argv.slice(2);
const headful = process.argv.includes("--headful");
const browser = await puppeteer.launch({
  executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  headless: !headful,
  userDataDir: process.env.SHOT_PROFILE || "/private/tmp/claude-502/brave-profile",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-first-run", "--no-default-browser-check"],
  defaultViewport: { width: +w, height: +h, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await (await page.createCDPSession()).send("Network.clearBrowserCache");
page.on("console", (m) => console.log("[console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url, { waitUntil: "networkidle0" });
const gpu = await page.evaluate(async () => {
  if (!navigator.gpu) return "navigator.gpu missing";
  const a = await navigator.gpu.requestAdapter();
  return a ? "adapter ok: " + (a.info?.vendor || "") + " " + (a.info?.architecture || "") : "no adapter";
});
console.log("WebGPU:", gpu);
await page.screenshot({ path: out, fullPage: true });
console.log("saved", out);
await browser.close();
