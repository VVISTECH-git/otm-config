import { runQuery } from "../otm/dbxml";

/**
 * All GLOGOWNER objects that carry a DOMAIN_NAME column — i.e. the domain-scoped
 * universe we can count/extract. (Probe confirmed the integration user reads
 * ALL_TAB_COLUMNS via synonyms; USER_TAB_COLUMNS is empty for it.)
 */
export async function listDomainTables(): Promise<string[]> {
  const rows = await runQuery(
    `select table_name from all_tab_columns ` +
      `where owner='GLOGOWNER' and column_name='DOMAIN_NAME' order by table_name`,
    "T",
  );
  return rows.map((r) => r.TABLE_NAME).filter(Boolean);
}

/** GLOGOWNER view names, so we can flag views (they lack a real UPDATE_DATE). */
export async function listViews(): Promise<Set<string>> {
  const rows = await runQuery(
    `select view_name from all_views where owner='GLOGOWNER'`,
    "V",
  );
  return new Set(rows.map((r) => r.VIEW_NAME).filter(Boolean));
}
