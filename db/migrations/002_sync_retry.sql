-- Reprise automatique des récupérations iRacing : auteur (dont le compte iRacing sert à la reprise) et nombre d'essais.
ALTER TABLE sync_failures ADD COLUMN actor_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sync_failures ADD COLUMN attempts integer NOT NULL DEFAULT 1;
CREATE INDEX sync_failures_due_idx ON sync_failures(retry_after) WHERE resolved_at IS NULL AND retry_after IS NOT NULL;
