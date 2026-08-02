import express from "express";
import cors from "cors";
import { cfg, assertConfig } from "./config";
import { migrate } from "./db/migrate";
import { q } from "./db";
import { sweepCounts } from "./services/countSweep";
import { runFetch } from "./services/fetchStore";

const app = express();
app.use(cors());
app.use(express.json());

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
      `select table_name, tms_row_count, enabled
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

// Toggle a table as configuration (the checkbox).
app.put("/api/tables/:name", async (req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    await q(
      `update otm_config_table set enabled=$3 where connection_id=$1 and table_name=$2`,
      [cid, req.params.name, !!req.body.enabled],
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Run: delta-fetch enabled tables into the store.
app.post("/api/runs", async (_req, res, next) => {
  try {
    const cid = await getDefaultConnectionId();
    const r = await runFetch(cid);
    res.json({ ok: true, ...r });
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

// TODO: exporter -> standard config .xlsx from otm_config_record.
app.get("/api/export", (_req, res) => {
  res.status(501).json({ error: "exporter not implemented yet" });
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
