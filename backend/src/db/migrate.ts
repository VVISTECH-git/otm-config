import { pool } from "../db";
import { SCHEMA_SQL } from "./schema";

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log("migrated");
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("migrate failed:", e);
      process.exit(1);
    });
}
