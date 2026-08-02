# OTM Config Portal

Documents an OTM environment's **configuration**: pick the config tables, delta-fetch
them from OTM via the DBXMLServlet, store them, and (later) generate a standard config workbook.

## Layout
```
.                     static picker front-end (index.html) — TMS counts snapshot
backend/              Node/TypeScript API + config store (Express + Postgres)
  src/
    otm/dbxml.ts      DBXMLServlet client (xmlExport -> rows)
    services/         count sweep + delta fetch/store
    db/               schema + migrate
render.yaml           Render: Postgres db + API web service + static site
```

## Backend (local)
```bash
cd backend
cp .env.example .env       # fill in DATABASE_URL + OTM creds
npm install
npm run migrate            # create tables
npm run dev                # http://localhost:3001/health
```

### API
| Method | Path                | Purpose                                         |
|--------|---------------------|-------------------------------------------------|
| GET    | `/health`           | liveness + missing-env check                    |
| POST   | `/api/count-sweep`  | count(*) per TMS table -> manifest (background) |
| GET    | `/api/tables`       | objects + TMS counts + enabled flag             |
| PUT    | `/api/tables/:name` | `{ "enabled": true }` — mark as config          |
| POST   | `/api/runs`         | delta-fetch enabled tables into the store       |
| GET    | `/api/runs`         | run history                                     |
| GET    | `/api/export`       | (todo) standard config .xlsx                    |

## Deploy (Render)
1. Push to GitHub (done: `VVISTECH-git/otm-config`).
2. Render dashboard -> **New -> Blueprint** -> pick this repo (`render.yaml` provisions
   Postgres + the API + the static site).
3. Set `OTM_BASE_URL`, `OTM_USER`, `OTM_PASS` on the `otm-config-api` service.
4. `DATABASE_URL` is wired automatically from the managed Postgres.

Front-end can also deploy to Vercel (static, root dir).

## Status
- [x] Static picker (counts are a snapshot)
- [x] Backend scaffold: DBXMLServlet client, schema, count-sweep, delta fetch/store, run history
- [ ] Object-level re-pull, delete reconcile, xlsx exporter, React front-end wired to the API
