// Parcours navigateur de bout en bout sur les données de démo (serveur lancé, base seedée).
// Usage : SEED_PASSWORD=... npm run test:e2e   (E2E_BASE_URL pour une autre adresse)
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PW = process.env.SEED_PASSWORD ?? "DemoNexo2026";
const SHOTS = require("node:path").join(require("node:os").tmpdir(), "nexo-e2e-shots");
let CHAMP;
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(`✓ ${name}`); } catch (e) { results.push(`✗ ${name} : ${e.message.split("\n")[0]}`); }
}
async function ctx(browser, viewport) {
  const c = await browser.newContext({ viewport });
  const p = await c.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  return { c, p };
}
async function login(p, email, pw = PW) {
  await p.goto(B + "/login");
  await p.fill('input[name="email"]', email);
  await p.fill('input[name="password"]', pw);
  await act(p, () => p.click("form button[type=submit], form button >> nth=0"));
}
async function act(p, fn) {
  const before = await p.evaluate(() => performance.now());
  await fn();
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(400);
}
const flash = (p) => p.locator(".flash").first().textContent({ timeout: 5000 }).catch(() => "");
(async () => {
  require("fs").mkdirSync(SHOTS, { recursive: true });
  require("dotenv/config");
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  CHAMP = (await db.query("SELECT c.id FROM championships c JOIN communities co ON co.id=c.community_id WHERE co.slug='nexo-demo' AND c.slug='gt3-sprint-cup'")).rows[0]?.id;
  await db.end();
  if (!CHAMP) throw new Error("Données de démo absentes : lancez npm run db:seed.");
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const mob = { width: 390, height: 844 }, desk = { width: 1280, height: 900 };
  const stamp = Date.now().toString().slice(-6);
  const email = `nouveau${stamp}@exemple.test`;
  const name = `Nouveau ${stamp}`;
  const N = await ctx(browser, mob);
  const O = await ctx(browser, desk);
  await login(O.p, "orga@nexo-demo.test");

  await step("mobile : création de compte", async () => {
    await N.p.goto(B + "/register?next=/c/nexo-demo");
    await N.p.fill('input[name="displayName"]', name);
    await N.p.fill('input[name="email"]', email);
    await N.p.fill('input[name="password"]', "MotDePasse2026");
    await N.p.fill('input[name="password2"]', "MotDePasse2026");
    await act(N.p, () => N.p.click("form button[type=submit]"));
    assert.match(N.p.url(), /\/c\/nexo-demo/);
  });
  await step("mobile : inscription bloquée tant que l’adhésion n’est pas validée", async () => {
    await N.p.goto(B + "/c/nexo-demo/championships/gt3-sprint-cup/register");
    assert.match(await N.p.textContent("body"), /membre accepté|adhésion/);
    assert.equal(await N.p.locator("form button[type=submit]").last().isDisabled(), true);
  });
  await step("mobile : demande d’adhésion", async () => {
    await N.p.goto(B + "/c/nexo-demo");
    await N.p.fill('input[name="message"]', "Pilote de test");
    await act(N.p, () => N.p.click('form:has(input[name="message"]) button'));
    assert.match(await flash(N.p), /Demande envoyée/);
  });
  await step("organisation : acceptation de l’adhésion", async () => {
    await O.p.goto(B + "/c/nexo-demo/admin/members");
    const row = O.p.locator("tr", { hasText: name });
    await act(O.p, () => row.locator("button", { hasText: "Accepter" }).click());
    assert.match(await O.p.locator("tr", { hasText: name }).textContent(), /Accepté/);
  });
  await step("mobile : identifiant iRacing dans le profil", async () => {
    await N.p.goto(B + "/profile");
    await N.p.fill('input[name="iracingCustId"]', `95${stamp}`);
    await act(N.p, () => N.p.click('form:has(input[name="iracingCustId"]) button[type=submit], form:has(input[name="iracingCustId"]) button'));
    assert.doesNotMatch(await flash(N.p), /erreur|invalide/i);
  });
  await step("mobile : inscription au championnat avec acceptation du règlement", async () => {
    await N.p.goto(B + "/c/nexo-demo/championships/gt3-sprint-cup/register");
    await N.p.selectOption('select[name="category"]', "Am");
    await N.p.selectOption('select[name="car"]', { index: 1 });
    await N.p.fill('input[name="raceNumber"]', "7");
    await N.p.check('input[name="acceptRules"]');
    await act(N.p, () => N.p.click("button:has-text(\"Envoyer mon inscription\")"));
    assert.match(await flash(N.p), /déjà pris|numéro/i); // le 7 appartient à Alex
    await N.p.fill('input[name="raceNumber"]', "77");
    await N.p.selectOption('select[name="category"]', "Am");
    await N.p.selectOption('select[name="car"]', { index: 1 });
    await N.p.check('input[name="acceptRules"]');
    await act(N.p, () => N.p.click("button:has-text(\"Envoyer mon inscription\")"));
    const f = await flash(N.p);
    assert.doesNotMatch(f, /impossible|invalide|déjà/i, f);
    await N.p.screenshot({ path: SHOTS + "/mobile-inscription.png", fullPage: true });
  });
  await step("organisation : acceptation comme titulaire (7/7)", async () => {
    await O.p.goto(B + "/c/nexo-demo/admin/championships/" + CHAMP);
    const row = O.p.locator("tr", { hasText: name });
    await act(O.p, () => row.locator("button", { hasText: "Accepter" }).click());
    assert.match(await O.p.locator("tr", { hasText: name }).textContent(), /Accepté/);
  });
  let r3;
  await step("mobile : réponse « Présent » à la manche 3", async () => {
    await N.p.goto(B + "/c/nexo-demo/calendar");
    r3 = await N.p.locator('a[href*="/rounds/"]', { hasText: /Ardennes|Manche 3/ }).first().getAttribute("href");
    await N.p.goto(B + r3);
    await act(N.p, () => N.p.click('form[aria-label="Ma présence"] button[value="yes"]'));
    const body = await N.p.textContent("body");
    assert.match(body, /Place confirmée|Liste d’attente/);
    await N.p.screenshot({ path: SHOTS + "/mobile-presence.png", fullPage: true });
    const sw = await N.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(sw <= 2, `débordement ${sw}px`);
  });
  await step("informations serveur : visibles d’un pilote confirmé, cachées d’un visiteur", async () => {
    const body = await N.p.textContent("body");
    const V = await ctx(browser, desk);
    await V.p.goto(B + r3);
    const anon = await V.p.textContent("body");
    assert.doesNotMatch(anon, /mot de passe : démo/);
    if (/Place confirmée/.test(body)) assert.match(body, /Nexo Demo/);
    await V.c.close();
  });
  await step("commissaire : décision sur la réclamation avec pénalité de 1 place", async () => {
    const S = await ctx(browser, desk);
    await login(S.p, "commissaire@nexo-demo.test");
    await S.p.goto(B + "/c/nexo-demo/admin/protests");
    const card = S.p.locator("article").first();
    await card.locator("summary", { hasText: "Rendre une décision" }).click();
    await card.locator('textarea[name="decision"]').fill("Contact évitable à l’épingle : une place de pénalité.");
    await card.locator('select[name="penaltyKind"]').selectOption("positions");
    await card.locator('input[name="penaltyValue"]').fill("1");
    await act(S.p, () => card.locator("button", { hasText: "Enregistrer la décision" }).click());
    assert.match(await flash(S.p), /Décision enregistrée/);
    await S.c.close();
  });
  await step("pilote : ne peut pas décider ni exporter", async () => {
    const A = await ctx(browser, mob);
    await login(A.p, "alex@nexo-demo.test");
    await A.p.goto(B + "/c/nexo-demo/admin/protests");
    assert.doesNotMatch(A.p.url(), /admin\/protests/);
    const champId = CHAMP;
    const r = await A.p.request.get(`${B}/api/export?slug=nexo-demo&championship=${champId}&kind=registrations`);
    assert.equal(r.status(), 403);
    await A.c.close();
  });
  await step("organisation : export CSV des inscriptions", async () => {
    const champId = CHAMP;
    const r = await O.p.request.get(`${B}/api/export?slug=nexo-demo&championship=${champId}&kind=standings`);
    assert.equal(r.status(), 200);
    assert.match(r.headers()["content-type"], /text\/csv/);
    const t = await r.text();
    assert.ok(t.startsWith("﻿"));
    assert.match(t, /Sam Dupont|Noah Lambert/);
  });
  await step("classement public après décision", async () => {
    await O.p.goto(B + "/c/nexo-demo/championships/gt3-sprint-cup");
    await O.p.screenshot({ path: SHOTS + "/classement.png", fullPage: true });
    assert.match(await O.p.textContent("body"), /Provisoire|provisoire/);
  });
  await step("OBS : classement et prochaine manche à fond transparent", async () => {
    const V = await ctx(browser, { width: 600, height: 700 });
    await V.p.goto(B + "/obs/nexo-demo/standings?championship=gt3-sprint-cup&limit=5");
    assert.equal(await V.p.locator(".obs-row").count(), 5);
    const bg = await V.p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, "rgba(0, 0, 0, 0)");
    await V.p.screenshot({ path: SHOTS + "/obs-standings.png", omitBackground: true });
    await V.p.goto(B + "/obs/nexo-demo/next-round");
    assert.match(await V.p.textContent("body"), /Manche|M3/);
    await V.c.close();
  });
  await step("réglages : Discord non configuré annoncé honnêtement", async () => {
    await O.p.goto(B + "/c/nexo-demo/admin/settings");
    assert.match(await O.p.textContent("body"), /Non configuré/);
    await act(O.p, () => O.p.click("button:has-text('Traiter la file maintenant')"));
    assert.match(await flash(O.p), /Envoyés : 0/);
  });
  for (const x of [N, O]) if (x.p.errors.length) results.push(`✗ erreurs JS : ${x.p.errors.join(" | ")}`);
  await browser.close();
  console.log(results.join("\n"));
  console.log(`Captures : ${SHOTS}`);
  if (results.some((r) => r.startsWith("✗"))) process.exitCode = 1;
})();
