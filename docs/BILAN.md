# Bilan de vérification

Date : 27 octobre 2026 (mise à jour : fiabilisation avant une première manche). Environnement : local (Node 22, PostgreSQL 16.15, Chromium via Playwright), build de production `next build`.

**Verdict : première version fonctionnelle et testée en local sur données fictives. Pas prête pour la production** tant que les points « À tester » ci-dessous, en particulier un import iRacing réel et une manche réelle, n’ont pas été vérifiés.

## Testé et validé

### Automatisé

`npm test` : **32 tests**, tous passent.

- **Moteur de points** :
  - points par position, général ou classe ;
  - pole et meilleur tour avec conditions ;
  - coefficient ;
  - DNF selon la distance ;
  - DNS, DSQ ;
  - pénalités en temps (appliquées seulement si les temps le permettent, sinon signalées), en places et en points (course ou championnat) ;
  - bonus pole et meilleur tour **par classe** en multi-classes ;
  - jokers, y compris « meilleurs résultats sur N » en cours de saison, et points de pénalité jamais retirés ;
  - départages (victoires, comparaison des places, dernière manche) et ex aequo ;
  - équipes (meilleurs résultats) et catégories ;
  - corrections sans modification de l’original ;
  - déterminisme.
- **Parseurs** :
  - JSON `results/get` sur fixture synthétique : multi-sessions, positions à partir de 0, unités de temps, abandons, champs absents « non fourni » ;
  - JSON `results/get` d’une course **en équipage et multi-classes** (fixture synthétique) : une ligne par voiture, équipage, meilleur tour et incidents repris de l’équipage ;
  - modèle CSV Nexo ;
  - saisie manuelle ;
  - rejet d’une sous-session inattendue.
- **Matrice des permissions**.
- **Fuseau Europe/Brussels** : saisie locale → UTC le jour des changements d’heure, heure sautée refusée, heure doublée déterministe, fenêtres de présence et de pointage de part et d’autre du changement.

`npm run test:db` : **15 tests sur PostgreSQL réel**, tous passent.

1. **Scénario complet demandé** : création de saison → adhésion → inscription (version du règlement, catégorie, numéro unique, doublon refusé) → acceptation et capacité → réserviste → présences → désistement et place proposée puis acceptée → rappels sans doublon et jamais « envoyés » sans Discord → pointage et absent au départ ≠ absent annoncé → association iRacing explicite → import du fichier, réimport sans doublon, participant inconnu à rapprocher obligatoirement → résultats provisoires → réclamation → décision du commissaire avec pénalité de 2 places (un commissaire ne peut pas décider de sa propre réclamation) → correction traçable → résultats définitifs → classement final vérifié au point près, résultat original intact → exports CSV.
2. Isolation entre deux ligues : lecture et écriture.
3. Permissions par rôle ; un rôle retiré perd ses droits ; une adhésion en attente ne donne aucun droit.
4. Concurrence : 6 pilotes visent 2 places en même temps → exactement 2 places.
5. Concurrence : 2 réservistes sur 1 place proposée.
6. Limitation des tentatives de connexion.
7. File Discord avec **transport simulé** : envoi, déduplication, 429 et `retry-after`, abandon après 5 échecs, mentions restreintes, suppression du webhook → « non envoyé ».
8. Profil : identifiant iRacing unique, changement tracé.
9. Import d’une course en équipage multi-classes : voiture rapprochée par l’équipage, choix obligatoire si deux inscrits partagent une voiture, points par classe vérifiés.
10. Récupération iRacing avec **iRacing simulé** : compte non connecté, 429 → nouvel essai à 15 min, 503 → nouvel essai, succès → aperçu, lien de téléchargement sans en-tête d’autorisation, pas de doublon, 401 → pas de reprise, abandon après 5 essais.
11. Lien de réinitialisation de mot de passe : droits (organisateur → pilotes et capitaines ; propriétaire → tout sauf propriétaire ; compte privilégié d’une autre ligue refusé ; compte Discord seul refusé), jeton stocké haché, usage unique, expiration, ancien lien annulé, mot de passe refusé sans consommer le lien, sessions fermées, commande serveur `user:password`.
12. Rappel de présence autour du passage à l’heure d’hiver : déclenché à la seconde près, une seule fois, jamais après la limite, quel que soit le fuseau de la session SQL.
13. Championnat multiclasse à voitures différentes selon la manche : voitures par manche (conservées ou retirées à la modification), saisie manuelle avec classe, places en classe, points par classe, classe déduite des résultats pour un pilote inscrit sans catégorie.

### Navigateur

Serveur de production local, données de démo.

- `npm run test:e2e` : **16 parcours réels**, tous passent.
  - **Mobile 390 px** : création de compte → inscription bloquée sans adhésion → demande d’adhésion → acceptation par l’organisation → identifiant iRacing → inscription au championnat (numéro déjà pris refusé, puis accepté) → acceptation → réponse « Présent » et place confirmée, sans débordement horizontal.
  - Informations serveur visibles du pilote confirmé et cachées d’un visiteur.
  - Décision de commissaire avec pénalité.
  - Pilote refusé sur l’administration et sur l’export (403).
  - Export CSV (BOM UTF-8).
  - Vues OBS à fond transparent.
  - Discord non configuré annoncé honnêtement.
  - Mot de passe oublié sur mobile : lien créé par l’organisation (jamais dans l’URL de la page Membres), nouveau mot de passe, lien inutilisable une seconde fois, ancienne session fermée.
- `npm run test:crawl` : exploration de **152 pages liées** (anonyme, organisateur, commissaire, pilote ; bureau et mobile). Aucune erreur serveur ni JavaScript, aucun débordement horizontal après corrections.

### Manuel

- `npm run db:migrate`, `db:seed` (et `--reset`), `worker:once`, `user:password`, `/api/health`, `/api/ready`.
- Sauvegarde `pg_dump` puis restauration `pg_restore` dans une base neuve : nombre de résultats, d’inscriptions et d’entrées d’audit identiques.

### Bugs trouvés et corrigés pendant la vérification

1. La suppression du webhook Discord (« - ») était refusée.
2. L’enregistrement du profil échouait dès que l’identifiant iRacing changeait (type de paramètre SQL).
3. Le joker retirait un vrai résultat en cours de saison au lieu d’une manche non courue.
4. Débordements horizontaux sur mobile : formulaire d’import, libellés accessibles dans les tableaux.
5. `db:seed --reset` bloqué par une référence du journal d’audit.
6. Le lien OBS s’affichait pour un championnat en brouillon (404).
7. Une heure inexistante (02:30 le jour du passage à l’heure d’été) était décalée en silence à 03:30 : elle est maintenant refusée.

## À tester avant une vraie manche

- [ ] **Import API iRacing réel** : OAuth avec un vrai client, puis `results/get` sur une vraie sous-session de ligue. Vérifier la correspondance des champs, les multi-classes, les équipes et les épreuves à plusieurs courses (couverts par des fixtures synthétiques et un iRacing simulé, pas par une vraie réponse).
- [ ] **Fichier JSON réel** de `results/get`.
- [ ] Connexion Discord OAuth réelle et webhook réel sur un salon de test. Code écrit, non exécuté contre Discord : aucun message réel n’a été envoyé.
- [ ] Déploiement sur l’hébergement choisi, en HTTPS, derrière proxy : cookies `Secure`, limitation par IP, `APP_ORIGIN`.
- [ ] Worker en continu sur plusieurs jours sur l’hébergement réel. Le calcul des rappels autour du changement d’heure est testé ; la tenue du processus dans la durée ne l’est pas.
- [ ] Une manche complète avec de vrais pilotes, puis une saison : charge réelle, ergonomie, retours de l’organisateur.
- [ ] Navigateurs Safari iOS et Firefox (seul Chromium a été testé), lecteur d’écran.
- [ ] Revue de sécurité indépendante.

## Blocages externes

1. **Client OAuth iRacing** : nécessaire pour l’import automatique. La documentation iRacing consultée pour le Rabbit Hub annonçait la **suspension de la création de nouveaux clients OAuth**. Il faut un client existant ou une réouverture. En attendant, il reste l’import de fichier et la saisie manuelle.
2. **Format d’export du site iRacing** : non pris en charge, car aucun export réel n’a pu être examiné. Le modèle CSV proposé est un **format interne Nexo**, présenté comme tel.
3. **Application Discord et webhook** : à créer par le propriétaire de la ligue.
4. **Dépôt GitHub dédié** : à créer (cette session ne peut pas créer de dépôt).
5. **Hébergement et base de production** : à choisir et à provisionner. Aucun déploiement ni service payant n’a été créé.

## Limites connues de cette version

- Pas de découverte automatique des sessions de ligue iRacing ; l’association est manuelle.
- Pas de boutons interactifs Discord.
- Capitaine : crée son équipe, mais pas encore de gestion des présences d’équipe.
- Pas de vérification d’email. Mot de passe oublié : lien créé par l’organisation et transmis à la main (pas d’envoi d’email).
- Classements recalculés à chaque affichage : suffisant pour une ligue, à mettre en cache si l’audience OBS devient importante.
