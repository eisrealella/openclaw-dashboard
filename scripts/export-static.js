#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const API_BASE = process.env.DASHBOARD_API_BASE || "http://127.0.0.1:8080";
const OUTPUT_PATH = path.join(ROOT, "public", "data", "dashboard.static.json");
const START_TIMEOUT_MS = Number(process.env.DASHBOARD_START_TIMEOUT_MS || 30000);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const detail = payload?.error || text || `HTTP ${res.status}`;
      throw new Error(`Request failed (${url}): ${detail}`);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error(`Invalid JSON payload from ${url}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function collectFilePaths(dashboard) {
  const paths = new Set();
  const catalog = dashboard?.catalog || {};
  for (const section of Object.values(catalog)) {
    for (const card of section || []) {
      if (card?.filePath) paths.add(String(card.filePath));
    }
  }
  for (const agent of dashboard?.agents || []) {
    if (agent?.detailPath) paths.add(String(agent.detailPath));
  }
  return Array.from(paths);
}

async function waitForPing(base, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetchJson(`${base}/api/ping`, 2000);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

function startLocalServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "8080" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (buf) => process.stdout.write(`[server] ${buf}`));
  child.stderr.on("data", (buf) => process.stderr.write(`[server] ${buf}`));
  return child;
}

async function main() {
  let server = null;
  let startedByScript = false;
  try {
    const reachable = await waitForPing(API_BASE, 2000);
    if (!reachable) {
      process.stdout.write(`Dashboard API not reachable at ${API_BASE}, starting local server...\n`);
      server = startLocalServer();
      startedByScript = true;
      const ready = await waitForPing(API_BASE, START_TIMEOUT_MS);
      if (!ready) throw new Error(`Timed out waiting for dashboard server (${API_BASE})`);
    }

    const dashboard = await fetchJson(`${API_BASE}/api/dashboard`, 15000);
    const filePaths = collectFilePaths(dashboard);
    const staticFiles = {};

    process.stdout.write(`Exporting ${filePaths.length} detail files...\n`);
    for (const filePath of filePaths) {
      try {
        const item = await fetchJson(
          `${API_BASE}/api/file?path=${encodeURIComponent(filePath)}`,
          12000
        );
        staticFiles[filePath] = {
          content: item.content || "",
          truncated: Boolean(item.truncated),
          size: Number(item.size || 0),
          filePath: item.filePath || filePath,
        };
      } catch (error) {
        staticFiles[filePath] = {
          error: String(error.message || error),
        };
      }
    }

    const output = {
      ...dashboard,
      meta: {
        ...(dashboard.meta || {}),
        staticExportedAt: new Date().toISOString(),
        staticSource: API_BASE,
      },
      staticFiles,
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    process.stdout.write(`Static snapshot written to ${OUTPUT_PATH}\n`);
  } finally {
    if (startedByScript && server && !server.killed) {
      server.kill("SIGTERM");
      await sleep(200);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`export:static failed: ${String(error.message || error)}\n`);
  process.exitCode = 1;
});
