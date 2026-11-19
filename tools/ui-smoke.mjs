// UI smoke test in jsdom (no WebGPU, so the model stays off). Run: node tools/ui-smoke.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const html = readFileSync(root + "index.html", "utf8").replace('<script type="module" src="app.js"></script>', "");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8080/#patient=elena-marsh", pretendToBeVisual: true });
const w = dom.window;
for (const [k, v] of Object.entries({ window: w, document: w.document, localStorage: w.localStorage, navigator: w.navigator, location: w.location, addEventListener: w.addEventListener.bind(w), alert: console.log })) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
globalThis.performance.setResourceTimingBufferSize = () => {};
globalThis.performance.getEntriesByType = () => [];
globalThis.fetch = async (u) => ({ json: async () => JSON.parse(readFileSync(root + u, "utf8")) });
await import(root + "app.js");
const tick = () => new Promise((r) => setTimeout(r, 50));
for (let i = 0; i < 10; i++) await tick();
const $ = (s) => w.document.querySelector(s);
console.log("record:", $("#record").textContent.replace(/\s+/g, " ").slice(0, 120));
$("#run").click(); for (let i = 0; i < 20; i++) await tick();
console.log("requests:", $("#req-count").textContent, "| progress:", $("#progress").textContent);
console.log("trials:", [...w.document.querySelectorAll("#trials tbody tr")].map((r) => r.children[1].textContent).join(" / "));
console.log("detail:", $("#detail h2").textContent, "|", $("#detail .verdict").textContent);
// select AstraZeneca trial, answer all questions yes/no
w.document.querySelector('#trials tr[data-nct="NCT07662044"]').click(); await tick();
console.log("AZ questions:", w.document.querySelectorAll("#detail .question").length);
let guard = 0;
while (w.document.querySelector('#detail .question button[data-v][aria-pressed="false"]') && guard++ < 20) {
  const q = [...w.document.querySelectorAll("#detail .question")].find((d) => !d.querySelector('[aria-pressed="true"]'));
  if (!q) break;
  const isInclusion = /same|stayed/.test(q.textContent);
  q.querySelector(`button[data-v="${isInclusion ? "yes" : "no"}"]`).click();
  for (let i = 0; i < 4; i++) await tick();
}
console.log("AZ verdict after answers:", $("#detail .verdict").textContent);
$("#contact").value = "+1 555 0137"; $("#consent").click(); $("#consent").dispatchEvent(new w.Event("change"));
$("#send").click(); await tick();
console.log("notice:", $("#detail .notice")?.textContent);
w.document.querySelector('.tabs button[data-view="site"]').click(); await tick();
console.log("inbox:", $("#inbox-count").textContent, $("#inbox .verdict")?.textContent, $("#inbox .hint")?.textContent);
