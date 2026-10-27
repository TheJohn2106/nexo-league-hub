// Exploration de toutes les pages liées (anonyme, organisation, pilote, commissaire ; bureau et mobile 390 px) :
// signale les erreurs HTTP, erreurs JavaScript et débordements horizontaux.
const { chromium } = require("@playwright/test");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PW = process.env.SEED_PASSWORD ?? "DemoNexo2026";
async function login(page, who) {
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', `${who}@nexo-demo.test`);
  await page.fill('input[name="password"]', PW);
  await Promise.all([page.waitForLoadState("networkidle"), page.click('form button[type="submit"], form button:has-text("connexion"), form button')]);
}
async function crawl(who, viewport) {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror ${page.url()} ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console ${page.url()} ${m.text()}`));
  if (who) await login(page, who);
  const seen = new Set();
  const queue = ["/c/nexo-demo"];
  let n = 0;
  while (queue.length && n < 90) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    n++;
    const res = await page.goto(BASE + path);
    const status = res ? res.status() : 0;
    const text = await page.textContent("body");
    if (status >= 400 || /Application error|Internal Server Error/.test(text)) problems.push(`HTTP ${status} ${path}`);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (sw > 2) problems.push(`débordement horizontal ${sw}px ${path}`);
    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    for (const l of links) {
      if (!l || !l.startsWith("/") || l.startsWith("/api/") || l.includes("#")) continue;
      const p = l.split("#")[0];
      if (!seen.has(p) && (p.startsWith("/c/") || p.startsWith("/obs/") || p === "/profile")) queue.push(p);
    }
  }
  await browser.close();
  return { who: who ?? "anonyme", visited: n, problems };
}
(async () => {
  const desk = { width: 1280, height: 900 };
  const mob = { width: 390, height: 844 };
  for (const [who, vp] of [[null, desk], ["orga", desk], ["alex", mob], ["commissaire", desk], ["orga", mob]]) {
    const r = await crawl(who, vp);
    console.log(`${r.who} ${vp.width}px : ${r.visited} pages, ${r.problems.length} problèmes`);
    for (const p of [...new Set(r.problems)].slice(0, 25)) console.log("  - " + p);
    if (r.problems.length) process.exitCode = 1;
  }
})();
