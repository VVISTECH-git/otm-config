import express from "express";
import cors from "cors";
import { cfg, assertConfig } from "./config";
import { migrate } from "./db/migrate";
import { q } from "./db";
import { sweepCounts } from "./services/countSweep";
import { runFetch } from "./services/fetchStore";
import { classifyCategory } from "./services/classify";
import { buildWorkbook } from "./services/exporter";

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

/** Single default connection for now (multi-connection UI comes later). */
async function getDefaultConnectionId(): Promise<number> {
  const found = await q(`select id from otm_connection order by id limit 1`);
  if (found.rows[0]) return found.rows[0].id;
  const ins = await q(
    `insert into otm_connection (name, base_url, domain) values ('default',$1,$2) returning id`,
    [cfg.otm.baseUrl, cfg.otm.domain],
  );
  return ins.rows[0].id;
}

// Friendly index so the base URL isn't a bare 404.
app.get("/", (_req, res) => {
  res.json({
    service: "otm-config-api",
    status: "ok",
    docs: "https://github.com/VVISTECH-git/otm-config",
    endpoints: {
      health: "GET /health",
      tables: "GET /api/tables",
      countSweep: "POST /api/count-sweep",
      toggleTable: "PUT /api/tables/:name  { enabled: boolean }",
      run: "POST /api/runs",
      runs: "GET /api/runs",
      export: "GET /api/export (not implemented yet)",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, missingEnv: assertConfig() });
});

// List objects + TMS counts + enabled flag (feeds the picker).
app.get("/api/tables", async (_req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const r = await q(
      `select table_name, tms_row_count, enabled, category
       from otm_config_table where connection_id=$1
       order by tms_row_count desc nulls last, table_name`,
      [cid],
    );
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});

// Kick off the count sweep (long-running) in the background.
app.post("/api/count-sweep", async (_req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    sweepCounts(cid).catch((e) => console.error("count sweep failed:", e));
    res.status(202).json({ ok: true, message: "sweep started; poll GET /api/tables" });
  } catch (e) {
    next(e);
  }
});

// Update a table row: select it (enabled) and/or set its category. Either or both.
app.put("/api/tables/:name", async (req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const { enabled, category } = req.body ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [cid, req.params.name];
    if (typeof enabled === "boolean") { sets.push(`enabled=$${vals.length + 1}`); vals.push(enabled); }
    if (typeof category === "string") { sets.push(`category=$${vals.length + 1}`); vals.push(category); }
    if (sets.length === 0) return res.status(400).json({ error: "provide 'enabled' and/or 'category'" });
    await q(
      `update otm_config_table set ${sets.join(", ")} where connection_id=$1 and table_name=$2`,
      vals,
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Bulk-seed the manifest from a precomputed list [{table, tms_rows, category}].
app.post("/api/seed", async (req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const rows = Array.isArray(req.body?.tables) ? req.body.tables : [];
    let seeded = 0;
    for (const row of rows) {
      if (!row?.table) continue;
      await q(
        `insert into otm_config_table (connection_id, table_name, tms_row_count, category, last_swept_at)
         values ($1,$2,$3,$4, now())
         on conflict (connection_id, table_name)
         do update set tms_row_count = excluded.tms_row_count,
                       category = coalesce(otm_config_table.category, excluded.category),
                       last_swept_at = now()`,
        [cid, row.table, row.tms_rows ?? null, row.category ?? classifyCategory(row.table)],
      );
      seeded++;
    }
    res.json({ ok: true, seeded });
  } catch (e) {
    next(e);
  }
});

// Run: delta-fetch enabled tables into the store (background; poll GET /api/runs).
app.post("/api/runs", async (_req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const run = await q(`insert into fetch_run (connection_id) values ($1) returning id`, [cid]);
    const runId = run.rows[0].id as number;
    runFetch(cid, runId).catch((e) => console.error("run failed:", e));
    res.status(202).json({ ok: true, runId });
  } catch (e) {
    next(e);
  }
});

app.get("/api/runs", async (_req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const r = await q(
      `select * from fetch_run where connection_id=$1 order by id desc limit 50`,
      [cid],
    );
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});

// Standard config .xlsx built from the extracted records.
app.get("/api/export", async (req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const raw = req.query.raw === "true" || req.query.raw === "1";
    const buf = await buildWorkbook(cid, raw);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="otm_config_TMS_${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) {
    next(e);
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: String(err?.message ?? err) });
});

migrate()
  .then(() => {
    app.listen(cfg.port, () =>
      console.log(`otm-config-api listening on :${cfg.port}`),
    );
  })
  .catch((e) => {
    console.error("startup migrate failed:", e);
    process.exit(1);
  });
