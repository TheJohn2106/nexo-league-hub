# Guide organisateur

Toutes les pages d’administration sont sous `/c/<ligue>/admin` (lien « Administration » dans le menu). Les droits sont vérifiés côté serveur pour chaque action, pas seulement dans l’interface.

## Rôles

| Rôle | Peut |
| --- | --- |
| Propriétaire | Tout, y compris identité visuelle, Discord, rôles, décisions de commissaire |
| Organisateur | Adhésions, championnats, manches, inscriptions, présences, résultats, exports, journal. **Ne décide pas** des réclamations |
| Commissaire | Consulter les réclamations, décider, appliquer et annuler des pénalités |
| Capitaine | Comme un pilote ; crée son équipe à l’inscription (pas encore de gestion d’équipe dédiée) |
| Pilote | S’inscrire, répondre aux présences, pointer, réclamer |

Un compte créé n’est **jamais** membre ni participant automatiquement : l’adhésion puis chaque inscription sont validées par l’organisation. Un commissaire ne peut pas décider d’une réclamation qui le concerne.

## 1. Préparer la ligue (propriétaire)

**Réglages** (`/admin/settings`) :

- **Identité** : nom, accroche, logo (URL https), couleurs, liens Twitch, Discord et site, partenaires (une ligne `nom|url|logo`).
- **Fuseau horaire** : Europe/Brussels par défaut. Toutes les dates sont stockées en UTC.
- **Adhésions** : sur demande, ou fermées.
- **Discord** : URL de webhook du salon et délai des rappels. Voir [CONFIGURATION.md](CONFIGURATION.md). Sans webhook, rien n’est envoyé et la file l’indique (« Non envoyé »).

**Membres** (`/admin/members`) : accepter ou refuser les demandes, attribuer les rôles, retirer un membre (avec motif). Les coordonnées privées (email, contact) ne sont visibles que de l’organisation.

**Mot de passe oublié** : l’application n’envoie pas d’email. Sur la page Membres, « Lien mot de passe » crée un lien **à usage unique, valable 24 heures**, affiché pendant 2 minutes : copiez-le et transmettez-le au membre par un canal **privé** (message direct Discord, par exemple), jamais dans un salon public. Le membre choisit un nouveau mot de passe ; toutes ses sessions ouvertes sont fermées. Créer un nouveau lien annule le précédent, et chaque lien créé est inscrit au journal.

- Un organisateur peut le faire pour un pilote ou un capitaine ; le propriétaire, pour tout membre sauf un propriétaire.
- Un compte qui a un rôle plus élevé dans une **autre** ligue hébergée est refusé (le compte est commun aux ligues).
- Un compte propriétaire se réinitialise sur le serveur : `npm run user:password -- --email <adresse>` (accès à la base requis).
- Un compte créé avec Discord n’a pas de mot de passe : il se connecte avec Discord.

## 2. Créer une saison

**Nouveau championnat** :

- Nom, description, règlement (Markdown).
- Capacité (titulaires) et date limite d’inscription.
- Catégories et voitures autorisées (séparées par des virgules), et si leur choix est obligatoire. Équipe obligatoire ou non.
- Politique des numéros : uniques, libres ou sans numéro.
- Délai de réponse de présence (heures avant le départ).
- Fenêtre de pointage (ouverture et fermeture en minutes avant le départ).
- Durée de validité d’une place proposée à un réserviste.
- Délai de réclamation (heures après la fin de la course).
- Informations serveur, visibles seulement des pilotes confirmés et de l’organisation.
- **Barème** :
  - points par position et base (général ou classe) ;
  - points de participation ;
  - bonus pole et meilleur tour, avec leurs conditions ;
  - règle d’abandon : points de la place si X % des tours ont été couverts, sinon 0 ;
  - nombre de jokers ;
  - pénalité d’absence au départ, **désactivée par défaut** ;
  - départage ;
  - nombre de résultats comptant par équipe.

### Championnat multiclasse ou à voitures tournantes

- **Multiclasse** (GTP + GT3, GT3 + GT4…) : choisissez la base de points « classe » dans le barème, et listez les classes dans « Catégories ». Pole et meilleur tour sont attribués par classe. Le classement public montre d’abord un classement par classe, puis le général toutes classes confondues.
- La classe d’un pilote vient de sa catégorie d’inscription. S’il n’en a pas, elle est déduite de ses résultats : la classe où il a le plus couru.
- **Voitures différentes selon la manche** : laissez « Voitures autorisées » vide au niveau du championnat (ou listez-les toutes) et ne rendez pas le choix de voiture obligatoire. Indiquez les voitures de chaque manche dans le formulaire de la manche : elles s’affichent au calendrier, sur la page de la manche, dans l’annonce Discord et dans la vue OBS.

Statuts : brouillon (invisible du public), inscriptions ouvertes, fermées, terminé, annulé. Pour publier, cliquez sur « Ouvrir les inscriptions ».

Modifier le règlement en cochant « nouvelle version » incrémente la version. Les pilotes doivent alors ré-accepter le règlement : la date et la version acceptées sont conservées.

## 3. Manches et sessions

Depuis la page du championnat, ajoutez une manche : nom, circuit, configuration et départ de la course (heure locale). Indiquez les voitures de la manche si elles diffèrent de celles du championnat. Choisissez aussi les essais et qualifications éventuels, le nombre de courses, une capacité spécifique et si la manche peut être retirée comme joker.

Sur la page de la manche (`/admin/rounds/<id>`) :

- **Modifier, reporter** : l’horaire d’origine est conservé et les sessions sont décalées. **Annuler** : la manche est exclue des classements, l’historique est gardé.
- **Sessions** : coefficient (par exemple ×2 pour une finale), attribution de points, pole.
- **Association iRacing** : saisissez l’identifiant de sous-session (subsession_id) et, si besoin, le numéro de simsession. L’association est **explicite** : la découverte automatique des manches de ligue n’est pas implémentée.
- **Annonce Discord** : met l’annonce dans la file d’envoi (une seule fois par horaire).

## 4. Inscriptions

Dans le tableau « Inscriptions » du championnat :

- **Accepter** : refusé si la capacité est atteinte (vérifié sous verrou, même en cas de clics simultanés).
- **Réserviste** : rang modifiable. L’ordre des rangs décide de qui reçoit une place libérée.
- **Refuser** : libère les places futures du pilote.

Les doublons d’identifiant iRacing et de numéro sont refusés à l’inscription. Un pilote doit avoir renseigné son identifiant iRacing pour s’inscrire.

## 5. Présences, réservistes et pointage

Sur la page de la manche :

- Totaux : présents, incertains, absents, sans réponse, places confirmées, liste d’attente.
- Les titulaires qui répondent « présent » ou « incertain » occupent une place. Un désistement propose la place au premier réserviste, avec un délai d’acceptation. Sans réponse dans ce délai, le worker passe la place au suivant.
- **Corriger une réponse** : un motif est obligatoire et la correction est tracée dans l’historique.
- **Retirer un participant** : corrigez sa réponse en « Absent » avec un motif. Sa place est aussitôt proposée au réserviste suivant.
- **Pointage** : les pilotes confirmés pointent dans la fenêtre. Après sa fermeture, « Libérer les places non pointées » marque les intéressés « absent au départ » et propose leurs places. Un « absent annoncé » n’est jamais confondu avec un « absent au départ ».
- Aucune sanction automatique, sauf si vous avez activé la pénalité d’absence dans le barème.

## 6. Résultats

Pour chaque session, trois voies mènent à un **aperçu** avant validation :

1. **API iRacing** : récupère `/data/results/get` pour la sous-session associée, avec **votre** compte iRacing connecté (Profil → Connecter mon compte iRacing). Il faut que l’API soit configurée sur le serveur. Sinon le bouton est désactivé et un message explique comment l’activer. Les erreurs (limite de requêtes, autorisation expirée) sont enregistrées et visibles sur le tableau de bord. Les erreurs passagères sont relancées automatiquement par le worker (5 essais au plus) ; une autorisation expirée demande de reconnecter votre compte iRacing.
2. **Fichier** (courses en équipage et multi-classes comprises) :
   - JSON de la Data API iRacing (réponse de `results/get`) ;
   - ou **modèle CSV Nexo**, un format interne, **pas** un export officiel iRacing.
   
   En-tête du modèle : `position;cust_id;pseudo;classe;voiture;depart;tours;meilleur_tour;temps_total;incidents;statut`
3. **Saisie manuelle** de secours, ligne par ligne, validée. En multiclasse, la colonne « Classe » est pré-remplie depuis l’inscription ; la place en classe est calculée.

Dans l’aperçu :

- Les pilotes reconnus par leur identifiant iRacing sont rapprochés automatiquement. En équipage, la voiture est rapprochée si un seul inscrit figure dans l’équipage ; sinon, choisissez lequel marque les points.
- Un nom identique est seulement **suggéré** : il faut confirmer.
- Un participant inconnu exige une décision : choisir un pilote, ou « hors classement ».
- Cochez « définitifs » ou laissez « provisoires », par exemple en attendant les réclamations.

Garanties :

- Réimporter la même source réutilise l’import existant, sans doublon.
- Valider un nouvel import remplace le précédent sans dupliquer de résultats ni de points.
- La source brute est toujours conservée.
- Les champs absents s’affichent « non fourni ».

**Corrections** (`/admin/sessions/<id>`) : position, statut, tours, temps, incidents ou pilote rattaché, avec un motif. Le résultat importé n’est jamais modifié. Le classement est recalculé et chaque correction est annulable.

## 7. Réclamations et pénalités

`/admin/protests` : les réclamations sont listées avec leur date limite et leurs statuts (déposée, en examen, décidée, rejetée).

Le commissaire passe la réclamation en examen, puis rend une décision **motivée**. Il peut y joindre une pénalité :

- **Temps** : appliquée seulement si les temps nécessaires sont connus. Sinon, elle est signalée « non appliquée » et il faut décider d’une pénalité en places.
- **Places**.
- **Points** : portée course ou championnat ; jamais retirée par un joker.
- **Disqualification**.
- **Avertissement**.

Une pénalité peut aussi être appliquée directement depuis la page de la session. Toute pénalité est annulable avec un motif.

## 8. Classements, OBS, exports

- Les classements pilotes, équipes et catégories se recalculent à chaque consultation. Le détail des points (position, bonus, coefficient, pénalités) est affiché par course.
- Les jokers suivent la logique « meilleurs résultats sur N manches » : tant qu’il reste des manches à courir, aucun résultat réel n’est retiré.
- **OBS** : `/obs/<ligue>/standings?championship=<slug>&limit=10[&category=Pro]` et `/obs/<ligue>/next-round`. Fond transparent, rafraîchissement toutes les 60 s, aucune donnée privée. Dans OBS : Source navigateur, largeur 600, hauteur selon le nombre de lignes.
- **Exports CSV**, sur la page du championnat : inscriptions, présences, résultats et classement. Séparateur `;`, UTF-8 avec BOM, compatibles Excel.

## 9. Tableau de bord et journal

Le tableau de bord regroupe :

- les adhésions et inscriptions à traiter ;
- la prochaine manche et les réponses manquantes ;
- les imports à valider et les sessions passées sans résultats ;
- les réclamations ouvertes ;
- les échecs de synchronisation iRacing et les messages Discord en échec.

Le **journal d’audit** liste les 200 dernières actions sensibles.
