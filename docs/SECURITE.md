# Sécurité

## Contrôles d’accès

- **Côté serveur uniquement.** Chaque service reçoit `(communauté, acteur)` et appelle `requirePermission` avant toute lecture sensible ou écriture. Les pages d’administration vérifient aussi, mais seulement pour l’affichage. La matrice est dans `src/lib/permissions.ts`, testée dans `tests/permissions.test.ts`.
- **Isolation entre ligues.** Tout objet (championnat, manche, session, import, résultat, réclamation, pénalité) est chargé avec une condition `community_id`. Un identifiant d’une autre ligue répond « introuvable ». Testé dans `tests/db/security.test.ts`.
- **Adhésion et inscription distinctes.** Un compte n’a aucun droit dans une ligue tant que son adhésion n’est pas acceptée. Seuls les membres acceptés comptent pour les rôles.
- **Commissaires.** Un commissaire ne peut pas décider d’une réclamation qui le concerne. Un organisateur ne décide pas des réclamations.
- **Données privées.** Email, contact privé et identifiant iRacing ne sont visibles que de l’organisation et du pilote. Les informations serveur ne sont visibles que des pilotes confirmés sur la manche et de l’organisation. Les pages publiques et OBS n’affichent que pseudos, numéros, équipes et résultats.

## Comptes et sessions

- Mots de passe hachés avec scrypt, sel aléatoire (repris du Rabbit Hub) ; 10 caractères minimum, avec lettres et chiffres.
- Session : jeton aléatoire de 32 octets, stocké **haché** en base, expirant au bout de 30 jours. Cookie `httpOnly`, `SameSite=Lax` et `Secure` (sauf `COOKIE_SECURE=false` en local). Déconnexion = suppression en base.
- Limitation des tentatives (fenêtre de 15 min, clés hachées) :
  - connexion : 8 par email et 30 par client ;
  - création de compte : 10 par heure et par client ;
  - changement de mot de passe : 5.
- Aucun compte ni mot de passe par défaut : `owner:create` demande le mot de passe, et `db:seed` est refusé si `NODE_ENV=production`.
- Mot de passe oublié : lien à usage unique créé par l’organisation (jeton aléatoire de 256 bits stocké haché, 24 h, annulé par un nouveau lien, page sans référent). Il est transmis par l’organisateur, jamais placé dans une URL de l’administration ; son utilisation ferme toutes les sessions du compte. Un organisateur ne peut viser que pilotes et capitaines, et aucun compte ayant un rôle plus élevé dans une autre ligue. Chaque création et utilisation est journalisée.

## Mutations

- Les formulaires passent par des actions serveur Next.js, qui vérifient l’origine de la requête.
- Les routes POST OAuth vérifient l’en-tête `Origin` (`isSameOrigin`).
- États OAuth (Discord, iRacing) : aléatoires, à usage unique, valables 10 minutes, hachés en base et liés à un cookie. La liaison iRacing vérifie que la session qui reçoit le retour est celle qui a démarré le flux.
- Les entrées sont validées (zod ou contrôles explicites) dans les services : UUID, URL https, webhook Discord, nombres et longueurs.

## Concurrence

- **Places** : verrou `SELECT … FOR UPDATE` sur la manche pour chaque réponse, acceptation d’offre ou libération. Testé : 6 pilotes simultanés pour 2 places, et 2 réservistes simultanés pour 1 offre.
- **Capacité du championnat** : verrou sur le championnat lors des décisions d’inscription.
- **Imports** : index unique sur l’empreinte SHA-256 de la source et upsert par `entry_key`. Un double clic ou un réimport ne crée aucun doublon.

## Secrets

- Jetons iRacing chiffrés en AES-256-GCM avec `IRACING_TOKEN_KEY`. Les liens de téléchargement iRacing sont limités aux hôtes attendus et ne reçoivent jamais le jeton.
- Le webhook Discord est stocké en base et n’est jamais réaffiché dans l’interface. Les mentions sont limitées aux utilisateurs.
- Aucun secret dans le dépôt : `.env` est ignoré, `.env.example` est vide de valeurs réelles, les données de démo sont fictives (domaine `nexo-demo.test`, identifiants iRacing 900001 et suivants).

## En-têtes et exports

- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Les vues OBS sont chargées comme des pages, pas dans une iframe.
- Exports CSV réservés à l’organisation (`data.export`). Les cellules commençant par `= + - @` sont neutralisées contre l’injection de formules.

## Points d’attention

- `X-Forwarded-For` sert de clé de limitation : l’application doit être derrière un proxy qui le réécrit (Railway, Nginx). En exposition directe, la limite par client est contournable ; la limite par email reste active.
- Pas de Content-Security-Policy stricte pour l’instant.
- Pas de vérification d’email ni de réinitialisation de mot de passe par email : un organisateur doit aider le pilote, ou celui-ci utilise Discord.
- Pas d’audit de sécurité externe réalisé.
