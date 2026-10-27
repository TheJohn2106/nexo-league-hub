# Configuration : variables, iRacing, Discord, hébergement

Toutes les intégrations sont **facultatives**. Sans elles, l’application fonctionne avec :

- email et mot de passe ;
- import de fichier et saisie manuelle des résultats ;
- une file Discord marquée « non envoyé ».

Aucun secret ne doit être commité. `.env` est ignoré par git et `.env.example` ne contient aucune valeur réelle.

## Variables d’environnement

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | oui | PostgreSQL ≥ 16 |
| `APP_ORIGIN` | oui en production | URL publique exacte (`https://ligue.exemple.org`). Sert au contrôle d’origine des requêtes, aux retours OAuth et aux liens Discord |
| `COOKIE_SECURE` | — | `true` par défaut (cookie HTTPS seulement). `false` **uniquement** en local http |
| `DEFAULT_COMMUNITY` | — | Ligue affichée sur `/` quand plusieurs ligues existent |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | — | Connexion avec Discord |
| `IRACING_CLIENT_ID` | — | Client OAuth iRacing |
| `IRACING_CLIENT_SECRET` | — | Seulement si iRacing a délivré un secret |
| `IRACING_TOKEN_KEY` | avec iRacing | 64 caractères hexadécimaux (`openssl rand -hex 32`) chiffrant les jetons iRacing en base (AES-256-GCM). À conserver : la changer rend les jetons existants illisibles, et chaque organisateur doit alors reconnecter son compte |
| `TEST_DATABASE_URL` | tests | Base détruite par `npm run test:db`. Son nom doit contenir « test » |
| `SEED_PASSWORD` | démo | Mot de passe des comptes de démonstration |
| `NEXO_OWNER_PASSWORD` | — | Pour `owner:create` non interactif |

## iRacing

### Ce qui est utilisé

L’application utilise l’**OAuth officiel** d’iRacing (`https://oauth.iracing.com/oauth2`) :

- flux *authorization code* avec PKCE ;
- scope `iracing.auth` ;
- endpoints Data API `/data/member/info` et `/data/results/get?subsession_id=…`, dont la réponse est un lien signé vers le JSON. Seuls les hôtes iRacing et S3 attendus sont acceptés.

Ce client provient du Rabbit Hub. Les résultats sont récupérés **par un organisateur** qui a connecté son compte iRacing. Les pilotes n’ont rien à installer ni à connecter.

### Activation

1. Obtenir un client OAuth iRacing de type *authorization code*, avec l’audience data-server et l’URI de retour `${APP_ORIGIN}/api/auth/iracing/callback`. Voir <https://oauth.iracing.com/oauth2/book/client_registration.html>.
2. Renseigner `IRACING_CLIENT_ID`, éventuellement `IRACING_CLIENT_SECRET` (valeur brute, le masquage exigé par iRacing est fait côté serveur), `IRACING_TOKEN_KEY` et `APP_ORIGIN`.
3. L’organisateur ouvre **Profil**, puis **Connecter mon compte iRacing**.
4. Pour chaque session, il saisit le `subsession_id` sur la page de la manche (association explicite), puis **Récupérer les résultats**. Un aperçu s’ouvre, à valider.

### Limites connues

- **Blocage externe** : la documentation consultée pour le Rabbit Hub (septembre 2026) annonçait une **suspension de la création de nouveaux clients OAuth**. Sans client existant, l’import API reste inactif. L’interface le dit et propose l’import de fichier ou la saisie manuelle.
- Le parseur suit les champs documentés de `results/get` : `session_results[].results[]`, positions à partir de 0, temps en 1/10 000 s, `reason_out`. Il a été validé sur un **fichier synthétique**, pas encore sur une réponse réelle. À vérifier lors de la première manche.
- La découverte automatique des sessions de ligue n’est pas implémentée. L’association se fait à la main.
- Les erreurs sont enregistrées et visibles sur le tableau de bord : limite de requêtes, autorisation expirée, lien inattendu. La reprise est **manuelle**, en relançant la récupération : la déduplication garantit qu’il n’y a pas de doublon.

## Discord

Deux usages indépendants.

### Connexion avec Discord (facultatif)

1. Sur <https://discord.com/developers/applications>, créer une application et ouvrir OAuth2.
2. Ajouter le redirect `${APP_ORIGIN}/api/auth/discord/callback`.
3. Renseigner `DISCORD_CLIENT_ID` et `DISCORD_CLIENT_SECRET`.

Le scope est `identify` seulement (aucun email demandé). Un nouveau compte créé par Discord reçoit le pseudo Discord et n’a pas de mot de passe. Un compte existant peut lier Discord depuis son profil : les rappels mentionnent alors le pilote (`<@id>`).

### Notifications (facultatif)

Le propriétaire colle l’URL d’un **webhook** de salon dans Réglages → Discord. Pour la créer : Paramètres du salon → Intégrations → Webhooks. Elle n’est jamais réaffichée. Saisir `-` la supprime.

| Message | Déclencheur |
| --- | --- |
| Annonce de manche | Bouton sur la page de la manche (une fois par horaire) |
| Rappel de présence | Worker : pilotes sans réponse, N heures avant la date limite (réglage « rappel ») |
| Place proposée | Désistement ou place non pointée → réserviste suivant |
| Résultats publiés | Validation d’un import |

Tout passe par une **file** (`notification_outbox`) :

- une clé unique empêche les doublons ;
- en cas d’erreur, nouvel essai avec délai croissant, abandon après 5 échecs ;
- le délai `retry-after` de Discord est respecté en cas de limite (429) ;
- les mentions sont limitées aux utilisateurs (`allowed_mentions`), jamais `@everyone` ;
- sans webhook, le message est marqué « non envoyé » et n’est jamais présenté comme envoyé.

Les boutons interactifs Discord ne sont **pas** implémentés.

## Worker

```bash
npm run worker        # boucle, un passage par minute
npm run worker:once   # un passage (à appeler par un cron externe, par exemple toutes les 5 min)
```

Chaque passage :

1. planifie les rappels ;
2. expire les places proposées non acceptées et passe la place au suivant ;
3. envoie la file Discord ;
4. compte les échecs de synchronisation non résolus.

Sans worker, le site fonctionne, mais les rappels ne partent pas et les places proposées expirées ne sont réattribuées qu’à la prochaine action sur la manche.

## Hébergement

Besoins : un service Node ≥ 22.18 et un PostgreSQL ≥ 16, sur un petit plan suffisant pour une ligue communautaire. Aucun service payant spécifique.

### Docker

```bash
docker build -t nexo-league-hub .
docker run --env-file .env.production -p 3000:3000 nexo-league-hub
docker run --env-file .env.production nexo-league-hub npm run db:migrate   # avant chaque mise à jour
docker run --env-file .env.production nexo-league-hub npm run worker       # second conteneur
```

### Railway (fichier `railway.json` fourni)

- Build Dockerfile, migration avant déploiement (`npm run db:migrate`), contrôle de santé sur `/api/ready`.
- Ajouter un second service avec la commande `npm run worker`, ou un cron qui lance `npm run worker:once`.

Aucun déploiement n’a été effectué.

### Checklist de mise en production

- [ ] `APP_ORIGIN` en https et `COOKIE_SECURE=true` ; le proxy transmet `X-Forwarded-For` (limitation des tentatives).
- [ ] `npm run db:migrate`, puis `npm run owner:create` (aucun compte par défaut, **pas** de `db:seed`).
- [ ] Sauvegardes automatiques et restauration testée ([SAUVEGARDE.md](SAUVEGARDE.md)).
- [ ] Worker lancé.
- [ ] Test d’une manche complète sur l’environnement réel (voir [BILAN.md](BILAN.md)).

## OBS

Ajouter une « Source navigateur » :

- Classement : `https://<hôte>/obs/<ligue>/standings?championship=<slug>&limit=10`, avec `&category=Pro` en option. Largeur 600.
- Prochaine manche : `https://<hôte>/obs/<ligue>/next-round`, avec `?championship=<slug>` en option.

Le fond est transparent et la page se rafraîchit toutes les 60 s. Seules des données publiques sont affichées (pseudos, points). Un championnat en brouillon renvoie 404.
