// Données de démonstration ENTIÈREMENT FICTIVES (pseudos, identifiants iRacing 900001+, emails @nexo-demo.test).
//   npm run db:seed            (refuse si la ligue de démo existe déjà)
//   npm run db:seed -- --reset (supprime d'abord la ligue et les comptes de démo)
// Mot de passe des comptes : SEED_PASSWORD, sinon généré aléatoirement et affiché une seule fois.
// Refusé si NODE_ENV=production : aucune donnée ni mot de passe de démonstration en production.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPool, tx } from "../src/lib/db.ts";
import { registerUser } from "../src/lib/services/accounts.ts";
import { createCommunity, decideMembership, requestJoin, setRole, updateBranding } from "../src/lib/services/community.ts";
import { createChampionship, createRound, linkIracingSession, setChampionshipStatus, type ChampionshipInput } from "../src/lib/services/championships.ts";
import { decideRegistration, registerForChampionship } from "../src/lib/services/registrations.ts";
import { respond } from "../src/lib/services/attendance.ts";
import { applyImport, getImport, importFile, setResultsStatus } from "../src/lib/services/results.ts";
import { fileProtest } from "../src/lib/services/stewarding.ts";
import { defaultScoring } from "../src/lib/scoring/types.ts";
import { csvTemplateHeader } from "../src/lib/results/parse.ts";

if (process.env.NODE_ENV === "production") {
  console.error("Seed de démonstration refusé en production.");
  process.exit(1);
}
const SLUG = "nexo-demo";
const DOMAIN = "nexo-demo.test";
const pool = getPool();
const password = process.env.SEED_PASSWORD ?? `Demo-${randomBytes(6).toString("hex")}1`;
const H = 3600000;
const D = 24 * H;

async function main() {
  if (process.argv.includes("--reset")) {
    await pool.query("DELETE FROM communities WHERE slug=$1", [SLUG]);
    await pool.query("DELETE FROM users WHERE email LIKE $1", [`%@${DOMAIN}`]);
  }
  if ((await pool.query("SELECT 1 FROM communities WHERE slug=$1", [SLUG])).rowCount) {
    console.log(`La ligue de démo existe déjà (/c/${SLUG}). Relancez avec -- --reset pour la recréer.`);
    return;
  }
  const user = async (key: string, name: string, custId?: number) => {
    const id = (await tx((db) => registerUser(db, { email: `${key}@${DOMAIN}`, password, displayName: name })))!;
    if (custId) await pool.query("UPDATE driver_profiles SET iracing_cust_id=$2, country='BE' WHERE user_id=$1", [id, custId]);
    return id;
  };
  const owner = await user("orga", "Orga Démo");
  const steward = await user("commissaire", "Commissaire Démo", 900100);
  const drivers = [
    ["alex", "Alex Martin", 900001, "Pro", "7"],
    ["sam", "Sam Dupont", 900002, "Pro", "8"],
    ["lea", "Léa Moreau", 900003, "Am", "9"],
    ["ines", "Inès Petit", 900005, "Am", "10"],
    ["noah", "Noah Lambert", 900006, "Pro", "11"],
    ["jade", "Jade Renard", 900007, "Am", "12"],
    ["tom", "Tom Girard", 900008, "Pro", "14"],
    ["zoe", "Zoé Leroy", 900009, "Am", "15"],
  ] as const;
  const ids: Record<string, string> = {};
  for (const [k, n, cust] of drivers) ids[k] = await user(k, n, cust);
  const visitor = await user("visiteur", "Visiteur Démo");

  const cid = (await tx((db) =>
    createCommunity(db, { slug: SLUG, name: "Nexo Endurance Club", tagline: "Ligue fictive de démonstration", timezone: "Europe/Brussels" }, owner),
  ))!;
  await tx((db) =>
    updateBranding(db, cid, owner, {
      name: "Nexo Endurance Club",
      tagline: "Ligue fictive de démonstration",
      logoUrl: "",
      primaryColor: "#0055a4",
      accentColor: "#ef4135",
      twitchUrl: "",
      discordUrl: "",
      websiteUrl: "",
      partners: [{ name: "Partenaire fictif", url: "", logoUrl: "" }],
      timezone: "Europe/Brussels",
      joinPolicy: "approval",
    }),
  );
  for (const u of [steward, ...Object.values(ids)]) {
    await tx((db) => requestJoin(db, cid, u, "Demande de démonstration"));
    await tx((db) => decideMembership(db, cid, owner, u, "accepted"));
  }
  await tx((db) => setRole(db, cid, owner, steward, "steward"));
  await tx((db) => setRole(db, cid, owner, ids.noah, "captain"));
  await tx((db) => requestJoin(db, cid, visitor, "Je voudrais rejoindre la ligue."));

  const base: ChampionshipInput = {
    name: "GT3 Sprint Cup",
    slug: "gt3-sprint-cup",
    description: "Championnat sprint fictif : 4 manches, 1 joker.",
    rulesMd: "## Règlement (démo)\n\n1. Respect des autres pilotes.\n2. Réclamations dans les 48 h après la course.\n3. Un joker : la plus mauvaise manche est retirée.",
    capacity: 7,
    registrationDeadline: null,
    categories: "Pro, Am",
    cars: "BMW M4 GT3, Porsche 911 GT3 R, Ferrari 296 GT3",
    requireCategory: true,
    requireCar: true,
    requireTeam: false,
    numberPolicy: "unique",
    presenceDeadlineHours: 24,
    checkinOpensMinutes: 60,
    checkinClosesMinutes: 10,
    offerTtlHours: 12,
    protestWindowHours: 48,
    serverInfo: "Serveur : Nexo Demo · mot de passe : démo (fictif)",
    scoring: { ...defaultScoring, dropWorst: 1 },
  };
  const champ = (await tx((db) => createChampionship(db, cid, owner, base)))!;
  await tx((db) => setChampionshipStatus(db, cid, owner, champ, "open"));
  const now = Date.now();
  const mkRound = (name: string, track: string, cfg: string, startsAt: Date) =>
    tx((db) => createRound(db, cid, owner, champ, { name, track, trackConfig: cfg, startsAt, capacity: "", serverInfo: "", notes: "", jokerEligible: true }));
  const r1 = (await mkRound("Manche 1", "Circuit fictif de démonstration", "Grand Prix", new Date(now + 30 * D)))!;
  const r2 = (await mkRound("Manche 2", "Anneau imaginaire", "Complet", new Date(now + 31 * D)))!;
  const r3 = (await mkRound("Manche 3", "Piste des Ardennes (fictive)", "GP", new Date(now + 2 * D + 19 * H)))!;
  await mkRound("Manche 4", "Circuit du Littoral (fictif)", "Court", new Date(now + 9 * D + 19 * H));

  const cars = ["BMW M4 GT3", "Porsche 911 GT3 R", "Ferrari 296 GT3"];
  let i = 0;
  for (const [k, , , cat, num] of drivers) {
    await tx((db) =>
      registerForChampionship(db, cid, ids[k], champ, {
        category: cat,
        car: cars[i++ % 3],
        teamId: "",
        newTeamName: k === "noah" ? "Équipe Fictive Racing" : "",
        raceNumber: num,
        acceptedRulesVersion: 1,
        note: "",
      }),
    );
  }
  const regs = (await pool.query("SELECT id, user_id FROM registrations WHERE championship_id=$1", [champ])).rows;
  const regOf = (k: string) => regs.find((r) => r.user_id === ids[k])!.id;
  for (const k of ["alex", "sam", "lea", "ines", "noah", "jade"]) await tx((db) => decideRegistration(db, cid, owner, regOf(k), "accepted"));
  await tx((db) => decideRegistration(db, cid, owner, regOf("tom"), "reserve"));
  // Zoé reste « en attente » : visible dans le tableau de bord de l'organisation.

  // Manches 1 et 2 déjà courues : on les replace dans le passé.
  const past = async (roundId: string, at: number) => {
    for (const k of ["alex", "sam", "lea", "ines", "noah", "jade"]) await tx((db) => respond(db, cid, ids[k], roundId, "yes"));
    await pool.query("UPDATE round_sessions SET starts_at = starts_at - (SELECT starts_at FROM rounds WHERE id=$1) + $2::timestamptz WHERE round_id=$1", [roundId, new Date(at)]);
    await pool.query("UPDATE rounds SET starts_at=$2, original_starts_at=$2, status='completed' WHERE id=$1", [roundId, new Date(at)]);
  };
  await past(r1, now - 13 * D);
  await past(r2, now - 1 * D);
  const raceOf = async (roundId: string) => (await pool.query("SELECT id FROM round_sessions WHERE round_id=$1 AND kind='race'", [roundId])).rows[0].id as string;

  // M1 : fichier JSON synthétique au format Data API (résultats définitifs).
  const race1 = await raceOf(r1);
  await tx((db) => linkIracingSession(db, cid, owner, race1, "81234567", ""));
  const fixture = readFileSync(new URL("../tests/fixtures/iracing-results-get.synthetic.json", import.meta.url), "utf8");
  const imp1 = (await tx((db) => importFile(db, cid, owner, race1, "demo-m1.json", fixture)))!;
  const pre1 = await getImport(pool, cid, imp1.importId);
  const matches1 = Object.fromEntries(pre1.suggestions.filter((s) => s.how !== "iracing_id").map((s) => [s.entryKey, "none"]));
  await tx((db) => applyImport(db, cid, owner, imp1.importId, { final: true, matches: matches1, saveIracingIds: false }));

  // M2 : modèle CSV Nexo (format interne), résultats provisoires + une réclamation ouverte.
  const race2 = await raceOf(r2);
  const csv = [
    csvTemplateHeader,
    "1;900006;Noah Lambert;GT3;BMW M4 GT3;2;22;1:41.802;38:12.400;2;classé",
    "2;900001;Alex Martin;GT3;Porsche 911 GT3 R;1;22;1:41.655;38:14.950;0;classé",
    "3;900003;Léa Moreau;GT3;Ferrari 296 GT3;4;22;1:42.310;38:30.120;4;classé",
    "4;900002;Sam Dupont;GT3;BMW M4 GT3;3;22;1:42.004;38:41.700;6;classé",
    "5;900007;Jade Renard;GT3;Porsche 911 GT3 R;6;21;1:43.900;;2;classé",
    "6;900005;Inès Petit;GT3;Ferrari 296 GT3;5;12;1:43.120;;8;abandon",
  ].join("\n");
  const imp2 = (await tx((db) => importFile(db, cid, owner, race2, "demo-m2.csv", csv)))!;
  await tx((db) => applyImport(db, cid, owner, imp2.importId, { final: false, matches: {}, saveIracingIds: false }));
  await tx((db) =>
    fileProtest(db, cid, ids.sam, race2, {
      againstUserId: ids.lea,
      lap: "5",
      description: "Contact à l’épingle, je perds deux places (exemple fictif).",
      videoUrl: "",
    }),
  );
  await tx((db) => setResultsStatus(db, cid, owner, race2, false));

  // M3 (dans 2 jours) : quelques réponses de présence.
  for (const [k, r] of [["alex", "yes"], ["sam", "yes"], ["lea", "no"], ["noah", "maybe"], ["tom", "yes"]] as const)
    await tx((db) => respond(db, cid, ids[k], r3, r));

  // Second championnat en brouillon (non public).
  await tx((db) => createChampionship(db, cid, owner, { ...base, name: "Endurance d’hiver", slug: "endurance-hiver", capacity: 20, description: "Brouillon non publié." }));

  console.log(`Ligue de démonstration créée : /c/${SLUG}`);
  console.log(`Comptes (tous fictifs, @${DOMAIN}) : orga (propriétaire), commissaire, alex, sam, lea, ines, noah (capitaine), jade, tom (réserviste), zoe (en attente), visiteur (adhésion en attente).`);
  console.log(`Mot de passe commun : ${process.env.SEED_PASSWORD ? "(valeur de SEED_PASSWORD)" : password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
