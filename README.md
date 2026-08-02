# OTM Config Table Picker (TMS)

Static single-page portal: lists 2,293 OTM objects with their `count(*) where domain_name='TMS'`,
lets you tick the configuration tables, and exports the selection as `tms_config_tables.json`.

This is the **picker front-end only** (counts are a static snapshot). The fetch/store/export
backend is a separate build.

## Deploy
- **Netlify (no repo, instant):** drag this folder onto https://app.netlify.com/drop
- **Vercel:** `npx vercel` here, or import the Git repo at https://vercel.com/new (framework: Other)
- **Render:** New > Static Site, connect the repo, Publish Directory = `.`
