# OpenClaw Dashboard

## Links

- Repository: `https://github.com/eisrealella/openclaw-dashboard`
- Website: `https://eisrealella.github.io/openclaw-dashboard/`

## Run Local

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

## GitHub Pages Deployment

Workflow file:

```text
.github/workflows/deploy-pages.yml
```

After pushing to `main`, GitHub Actions deploys `public/` to Pages.

## Auto Update Every 5 Minutes (macOS launchd)

The snapshot is auto-updated and pushed by this job:

```text
~/Library/LaunchAgents/ai.openclaw.dashboard.snapshot-sync.plist
```

It runs:

```text
scripts/auto-sync-snapshot.sh
```

Behavior:
- every 5 minutes (`StartInterval=300`)
- exports latest dashboard snapshot
- commits only when `public/data/dashboard.static.json` changes
- pushes to `origin/main`

Useful commands:

```bash
# Check job
launchctl list | grep ai.openclaw.dashboard.snapshot-sync

# Restart job
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.dashboard.snapshot-sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.dashboard.snapshot-sync.plist
launchctl kickstart -k gui/$(id -u)/ai.openclaw.dashboard.snapshot-sync

# Logs
tail -n 80 /tmp/openclaw-dashboard-sync.out.log
tail -n 80 /tmp/openclaw-dashboard-sync.err.log
```
