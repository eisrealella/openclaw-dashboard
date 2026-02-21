# OpenClaw Dashboard (Local)

## Run

```bash
cd /Users/ella/Documents/Codex/openclaw-dashboard
node server.js
```

Default URL:

```text
http://127.0.0.1:8080
```

## Optional env vars

- `PORT`: default `8080`
- `HOST`: default `127.0.0.1`
- `OPENCLAW_HOME`: default `~/.openclaw`

## Export static snapshot (for GitHub Pages)

```bash
cd /Users/ella/Documents/Codex/openclaw-dashboard
npm run export:static
```

This writes:

```text
public/data/dashboard.static.json
```

The frontend will use:
- local runtime: `/api/dashboard` + `/api/file`
- GitHub Pages: `./data/dashboard.static.json` fallback

## GitHub Pages

Workflow file:

```text
.github/workflows/deploy-pages.yml
```

After pushing to `main`, GitHub Actions deploys `public/` to Pages.
