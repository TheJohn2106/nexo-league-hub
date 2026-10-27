# Nexo League Hub

Plateforme de gestion de ligues et championnats simracing (iRacing) aux couleurs d’une communauté : adhésions, inscriptions par championnat, présences et réservistes, résultats, points, classements, réclamations, vues OBS et rappels Discord.

Projet Nexotech Digital, dérivé du Rabbit Racing Team Hub (voir [docs/PROVENANCE.md](docs/PROVENANCE.md)). **Aucune affiliation officielle avec iRacing.**

> **Statut : première version testée en local, pas prête pour la production.** Voir [docs/BILAN.md](docs/BILAN.md) pour ce qui est vérifié, ce qui reste à tester et les blocages externes.

## Stack

Next.js 16 (App Router, actions serveur), React 19, TypeScript, PostgreSQL ≥ 16 (`pg`), zod. Aucun service payant requis. Node ≥ 22.18 (exécution directe des fichiers `.ts`).

## Démarrage local

```bash
# 1. Dépendances et base
npm ci
cp .env.example .env              # valeurs locales, aucune donnée réelle
docker compose up -d postgres     # ou un PostgreSQL ≥ 16 local avec les identifiants de .env
docker compose exec postgres createdb -U nexo nexo_test   # base des tests (une fois)
npm run db:migrate

# 2. Données de démonstration (fictives) — refusé si NODE_ENV=production
SEED_PASSWORD='DemoNexo2026' npm run db:seed          # ajouter « -- --reset » pour recréer

# 3. Application
npm run dev                       # http://localhost:3000  (ou : npm run build && npm run start)
npm run worker                    # tâches de fond (rappels, places expirées, file Discord)
```

Comptes de démo : `orga@nexo-demo.test` (propriétaire), `commissaire@…`, `alex@…`, `sam@…`, `lea@…`, `ines@…`, `noah@…` (capitaine), `jade@…`, `tom@…` (réserviste), `zoe@…` (inscription en attente), `visiteur@…` (adhésion en attente), tous en `@nexo-demo.test`, mot de passe = `SEED_PASSWORD` (sinon généré et affiché une fois).

Ligue réelle (sans données de démo, sans mot de passe par défaut) :

```bash
npm run owner:create -- --email orga@exemple.org --name "Orga" --slug ma-ligue --league "Ma Ligue"
# le mot de passe est demandé (saisie masquée) ou lu dans NEXO_OWNER_PASSWORD
npm run user:password -- --email orga@exemple.org   # redéfinir un mot de passe depuis le serveur
```

## Vérification

```bash
npm run typecheck                 # TypeScript
npm test                          # moteur de points, parseurs de résultats, permissions, fuseau horaire (32 tests)
npm run test:db                   # PostgreSQL réel : scénario complet, sécurité, concurrence, Discord et iRacing simulés, mot de passe oublié, changement d’heure (14 tests)
npm run build                     # build de production
curl -s localhost:3000/api/health # {"status":"ok"}
curl -s localhost:3000/api/ready  # {"status":"ready"} si la base répond et toutes les migrations sont appliquées

# Parcours navigateur (serveur lancé sur :3000, base seedée avec SEED_PASSWORD) :
npx playwright install chromium   # une fois (ou CHROMIUM_PATH=/chemin/vers/chrome)
SEED_PASSWORD='DemoNexo2026' npm run test:e2e     # 16 parcours, dont inscription, présence et mot de passe oublié sur mobile 390 px
SEED_PASSWORD='DemoNexo2026' npm run test:crawl   # explore toutes les pages : erreurs HTTP/JS, débordements mobiles
```

`test:e2e` crée un compte et une inscription : relancez `npm run db:seed -- --reset` pour repartir de l’état de démo.

`npm run test:db` **détruit et recrée** la base `TEST_DATABASE_URL` (son nom doit contenir « test »).

## Documentation

| Document | Contenu |
| --- | --- |
| [docs/GUIDE-ORGANISATEUR.md](docs/GUIDE-ORGANISATEUR.md) | Créer une saison, gérer inscriptions, présences, résultats, réclamations |
| [docs/GUIDE-PILOTE.md](docs/GUIDE-PILOTE.md) | S’inscrire, répondre aux présences, pointer, réclamer |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Variables, iRacing, Discord, hébergement, worker, OBS |
| [docs/SAUVEGARDE.md](docs/SAUVEGARDE.md) | Sauvegarde et restauration PostgreSQL |
| [docs/SECURITE.md](docs/SECURITE.md) | Rôles, permissions, protections en place |
| [docs/PROVENANCE.md](docs/PROVENANCE.md) | Ce qui vient du Rabbit Hub, ce qui a été retiré |
| [docs/BILAN.md](docs/BILAN.md) | Testé / à tester / blocages externes |

## Structure

```
db/migrations/        schéma PostgreSQL (UTC, contraintes, index de déduplication)
scripts/              migrate, seed, create-owner, set-password, worker
src/lib/scoring/      moteur de points pur et déterministe (sans base ni affichage)
src/lib/results/      parseurs : JSON Data API iRacing, modèle CSV Nexo, saisie manuelle
src/lib/services/     règles métier ; chaque service vérifie les droits côté serveur
src/app/              pages (public, espace pilote, administration, OBS) et routes API
tests/                tests unitaires ; tests/db : tests sur PostgreSQL réel
```
