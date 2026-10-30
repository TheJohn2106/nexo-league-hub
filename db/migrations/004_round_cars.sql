-- Voitures propres à une manche (championnats où la voiture change d'une manche à l'autre). Vide = voitures du championnat.
ALTER TABLE rounds ADD COLUMN cars jsonb NOT NULL DEFAULT '[]'::jsonb;
