# Provenance : ce qui vient du Rabbit Racing Team Hub

Le projet est une **copie de travail indépendante** du Rabbit Hub (`TheJohn2106/rabbit-racing-hub`, sources lues dans l’archive `rabbit-source.tar.gz`).

Aucune modification n’a été poussée vers ce dépôt. Sa base de données et son déploiement n’ont pas été touchés. Aucune donnée, aucun secret ni aucun fichier `.env` n’a été copié.

## Repris (vérifié puis adapté)

| Élément | Origine Rabbit | Adaptation |
| --- | --- | --- |
| Stack Next.js / React / TypeScript / PostgreSQL (`pg`), zod | `package.json` | Dépendances réduites au besoin de la gestion de ligue |
| Hachage des mots de passe (scrypt) et des jetons | `src/lib/password.ts` | Tel quel |
| Contrôle d’origine des requêtes | `src/lib/http.ts` | Tel quel |
| Client OAuth / Data API iRacing : PKCE, masquage du secret, chiffrement AES-256-GCM des jetons, liste blanche des liens de données | `src/lib/integrations/iracing-client.ts` | Réduit à `member/info` et `results/get` |
| Principe de rafraîchissement des jetons sous verrou | `src/lib/integrations/iracing-sync.ts` | Réécrit dans `services/iracing.ts` pour une récupération **à la demande** d’une sous-session complète, et non plus la synchronisation des résultats d’un seul pilote |
| Correspondance des champs `results/get` (positions à partir de 0, temps en 1/10 000 s, `reason_out`) | `src/lib/integrations/iracing-mapping.ts` | Réécrit dans `src/lib/results/parse.ts` pour toute la grille, multi-sessions et multi-classes |
| Connexion Discord (état OAuth, échange de code) | `src/app/api/auth/discord/*` | Scope `identify` seul, création de compte sans email, table `oauth_states` commune |
| En-têtes de sécurité | `next.config.ts` | Tel quel |
| Dockerfile, `railway.json` (migration avant déploiement, contrôle de santé) | racine | Adaptés (`/api/ready` vérifie les migrations du dépôt) |
| Consignes `AGENTS.md` / `CLAUDE.md` | racine | Tel quel |

## Étudié mais remplacé

Ces modules ont été lus. Leurs idées ont été conservées, mais ils étaient trop liés à une équipe unique pour être réutilisés tels quels.

- `src/lib/domain.ts`, `src/lib/management/*` (modèle de données en JSON par entité, avec révisions) : remplacés par un schéma relationnel avec contraintes. Ces contraintes servent les règles d’unicité, les verrous et la déduplication.
- `src/lib/team-registration.ts` (inscription à l’équipe par code) : remplacé par une demande d’adhésion validée par l’organisation, puis une inscription distincte par championnat.
- `src/components/management/race-participation.tsx` (disponibilités par événement) : remplacé par le modèle présence → place → pointage → participation constatée, avec liste d’attente.
- Overlays OBS du Rabbit Hub (flux temps réel de l’agent) : remplacés par deux pages publiques statiques à fond transparent (classement et prochaine manche).

## Retiré de cette version

Ces éléments ne servent pas la gestion de ligue. Ils ne sont **pas** présents dans le code, la navigation ni les dépendances :

- Agent Windows de capture (Rabbit Agent) et collecte SDK ;
- télémétrie détaillée, tours théoriques, analyse de tours ;
- coaching, exercices, plans d’entraînement, objectifs ;
- setups ;
- stratégie d’endurance, pit-wall, replanification ;
- classement en direct ;
- connexion Google ;
- invitations d’équipe et codes d’équipe ;
- catalogue de contenus iRacing.

Les données de télémétrie ou de classement en direct ne sont jamais utilisées comme résultat définitif.
