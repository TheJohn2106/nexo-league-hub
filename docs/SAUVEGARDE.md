# Sauvegarde et restauration

Toutes les données sont dans PostgreSQL : comptes, inscriptions, présences, sources brutes des imports, résultats, corrections, pénalités et journal. Aucun fichier n’est stocké sur disque par l’application.

## Sauvegarde

```bash
# Format personnalisé (compressé, restauration sélective possible)
pg_dump --format=custom --no-owner --file="nexo-$(date +%Y%m%d-%H%M).dump" "$DATABASE_URL"
```

Recommandations :

- **Fréquence** : une sauvegarde quotidienne, plus une juste après chaque validation de résultats importante (fin de manche).
- **Conservation** : 7 quotidiennes, 4 hebdomadaires, 1 par fin de saison.
- **Stockage** : hors de l’hébergeur de la base, chiffré. La sauvegarde contient des emails, des contacts privés et des jetons iRacing chiffrés.
- **Clé `IRACING_TOKEN_KEY`** : conservez-la à part, dans un gestionnaire de secrets. Sans elle, les jetons sauvegardés sont inutilisables (il suffit alors que les organisateurs reconnectent iRacing).
- Sur un hébergeur qui propose des sauvegardes automatiques de PostgreSQL (Railway, etc.), activez-les **et** gardez un `pg_dump` externe.

## Restauration

```bash
# 1. Arrêter l'application et le worker (aucune écriture pendant la restauration).
# 2. Restaurer dans une base VIDE :
createdb nexo_restore
pg_restore --no-owner --dbname=nexo_restore nexo-20261027-2100.dump
# 3. Vérifier :
DATABASE_URL=postgresql://…/nexo_restore npm run db:migrate   # « Base à jour. » (applique les migrations plus récentes que la sauvegarde)
psql postgresql://…/nexo_restore -c "SELECT count(*) FROM results; SELECT max(created_at) FROM audit_log;"
# 4. Pointer DATABASE_URL vers la base restaurée, redémarrer, contrôler /api/ready puis un classement.
```

Pour revenir sur une erreur métier (mauvais import, mauvaise pénalité), une restauration est rarement nécessaire :

- un import se remplace par un nouvel import ;
- une correction ou une pénalité s’annule depuis la page de la session ;
- l’historique est conservé dans le journal d’audit.

## Test de restauration

À faire au moins une fois avant la mise en production, puis à chaque saison :

1. Sauvegarder la production.
2. La restaurer dans une base temporaire.
3. Lancer l’application dessus en local (`DATABASE_URL=… npm run start`).
4. Comparer un classement avec la production.

La procédure ci-dessus a été exécutée en local sur la base de démonstration (voir [BILAN.md](BILAN.md)).
