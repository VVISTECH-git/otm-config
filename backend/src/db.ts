import { Pool } from "pg";
import { cfg } from "./config";

const isLocal = /localhost|127\.0\.0\.1/.test(cfg.databaseUrl);

export const pool = new Pool({
  connectionString: cfg.databaseUrl,
  // Render (and most hosted PG) require SSL; local usually doesn't.
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

export function q(text: string, params?: unknown[]) {
  return pool.query(text, params);
}
