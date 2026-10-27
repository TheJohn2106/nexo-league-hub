import "dotenv/config";
import { getPool } from "../src/lib/db.ts";
import { migrate } from "../src/lib/migrate.ts";

const pool = getPool();
migrate(pool)
  .then(() => console.log("Base à jour."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
