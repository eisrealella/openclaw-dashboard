#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, "openclaw.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "dashboard.db");
const SESSION_RETENTION_DAYS = Number(process.env.SESSION_RETENTION_DAYS || 90);
const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const SENSITIVE_KEY_RE =
  /(api[-_]?key|token|secret|password|authorization|auth|cookie|client[_-]?id|client[_-]?secret)/i;
const SENSITIVE_INLINE_RE = [
  /(sk-[A-Za-z0-9_-]{10,})/g,
  /([A-Za-z0-9_]{20,}\.[A-Za-z0-9_]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{10,}\b/g,
  /\b\d{12,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com\b/gi,
];

let dashboardCache = null;
let dashboardCacheAt = 0;
const CACHE_TTL_MS = 5000;
let dbConn = null;

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function maskSecret(value) {
  if (typeof value !== "string") return "[REDACTED]";
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function redactObject(input) {
  if (Array.isArray(input)) return input.map(redactObject);
  if (!input || typeof input !== "object") return input;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = maskSecret(String(value));
      continue;
    }
    out[key] = redactObject(value);
  }
  return out;
}

function redactInline(text) {
  let output = String(text || "");
  output = output.replace(
    /\b(client[_-]?id|client[_-]?secret|oauth[_-]?client[_-]?(?:id|secret))\b\s*[:=]\s*["']?([^\s,"';]+)["']?/gi,
    (_match, key) => `${key}: [REDACTED]`
  );
  for (const pattern of SENSITIVE_INLINE_RE) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

function normalizeLine(line) {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^>\s+/, "")
    .trim();
}

function cleanMdEmphasis(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function firstMeaningfulLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return "";
  const candidate = normalizeLine(lines[0]);
  return candidate || lines[0];
}

function lastMeaningfulLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return "";
  const candidate = normalizeLine(lines[lines.length - 1]);
  return candidate || lines[lines.length - 1];
}

function shouldSkipInsightLine(line) {
  const text = String(line || "").trim();
  if (!text) return true;
  if (/^原理[:：]/.test(text)) return true;
  if (/^路径[:：]/.test(text)) return true;
  if (/^测试[:：]/.test(text)) return true;
  if (/^https?:\/\//i.test(text)) return true;
  return false;
}

function extractInsightFromMemory(content) {
  const lines = String(content || "").split(/\r?\n/);
  const candidates = [];
  let heading = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      heading = line.replace(/^#+\s*/, "").trim();
      continue;
    }
    const normalized = cleanMdEmphasis(normalizeLine(line));
    if (!normalized || shouldSkipInsightLine(normalized)) continue;
    candidates.push({ text: normalized, heading });
  }
  if (candidates.length === 0) return "";

  const headingInsightRe = /(感悟|经验|心得|反思|复盘|lesson|insight)/i;
  const taskOutcomeRe = /(完成|修复|解决|新增|优化|更新|上线|部署|回滚|迁移|完成后|已|success|fixed|resolved)/i;
  const textInsightRe = /(感悟|经验|心得|反思|复盘|学到|教训|insight|lesson)/i;

  const priority1 = candidates.filter((item) => headingInsightRe.test(item.heading) || textInsightRe.test(item.text));
  if (priority1.length > 0) return priority1[priority1.length - 1].text;
  const priority2 = candidates.filter((item) => taskOutcomeRe.test(item.text));
  if (priority2.length > 0) return priority2[priority2.length - 1].text;
  return candidates[candidates.length - 1].text;
}

function getAgentStyle(workspace) {
  const soulPath = path.join(workspace, "SOUL.md");
  if (!fileExists(soulPath)) return null;
  let content = "";
  try {
    content = fs.readFileSync(soulPath, "utf8");
  } catch {
    return null;
  }
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const styleLines = [];
  const styleRe = /^(气质|表达|语气|风格|具身风格|vibe)\s*[：:]\s*(.+)$/i;
  const stylePlainRe = /^(气质|表达|语气|风格|具身风格|vibe)\s*(.+)$/i;
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const match = line.match(styleRe);
    const plainMatch = match ? null : line.match(stylePlainRe);
    if (!match && !plainMatch) continue;
    const label = match ? match[1] : plainMatch[1];
    const value = cleanMdEmphasis(match ? match[2] : plainMatch[2]);
    if (!value) continue;
    styleLines.push(`${label}: ${value}`);
  }
  if (styleLines.length > 0) return redactInline(styleLines.join(" · "));
  return null;
}

function listFiles(dir, filterFn = () => true) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name))
      .filter(filterFn);
  } catch {
    return [];
  }
}

function relativeDateLabel(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function toLocalDateKey(ts) {
  const date = new Date(Number(ts || Date.now()));
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function summarizeSessionQuery(query) {
  let text = String(query || "")
    .replace(/<image>[\s\S]*?<\/image>/gi, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/^System:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const splitByTask = text.split(/(?:\b任务[:：]|return your summary|current time[:：])/i).map((x) => x.trim());
  if (splitByTask.length > 1 && splitByTask[0].length < 20) text = splitByTask[1];
  if (!text) return "";

  const endIdx = text.search(/[。！？!?；;\n]/);
  let brief = endIdx >= 18 ? text.slice(0, endIdx + 1) : text;
  if (brief.length > 110) brief = `${brief.slice(0, 109)}…`;
  return brief;
}

function pickInsightEmoji(text) {
  const probe = String(text || "").toLowerCase();
  if (!probe) return "✨";
  if (/(修复|优化|完成|成功|done|fixed|finish|交付|落地)/i.test(probe)) return "✅";
  if (/(计划|待办|排查|问题|风险|错误|bug|todo|调研|research)/i.test(probe)) return "🛠️";
  if (/(总结|感悟|反思|学习|learn|insight|思考|复盘)/i.test(probe)) return "💡";
  if (/(发布|增长|机会|想法|创意|探索|experiment)/i.test(probe)) return "🚀";
  return "✨";
}

function getRecentSessionInsight(agentId) {
  if (!agentId) return null;
  try {
    const db = getDb();
    const row = db
      .prepare(`
        SELECT
          session_id AS sessionId,
          input_query AS inputQuery,
          updated_at AS updatedAt,
          source_path AS sourcePath
        FROM session_fact
        WHERE source = 'openclaw'
          AND agent_id = ?
          AND (
            COALESCE(total_tokens, 0) > 0 OR
            COALESCE(input_tokens, 0) > 0 OR
            COALESCE(output_tokens, 0) > 0
          )
          AND input_query IS NOT NULL
          AND TRIM(input_query) <> ''
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(String(agentId));
    if (!row) return null;
    const brief = summarizeSessionQuery(normalizeQueryText(row.inputQuery, 1200));
    if (!brief) return null;
    return {
      text: brief,
      updatedAt: Number(row.updatedAt || 0),
      sourcePath: row.sourcePath || null,
      sessionId: row.sessionId || null,
    };
  } catch {
    return null;
  }
}

function getLatestInsight(workspace, agentId = null) {
  const memoryDir = path.join(workspace, "memory");
  const memoryFiles = listFiles(memoryDir, (file) => file.endsWith(".md")).sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b))
  );
  if (memoryFiles.length > 0) {
    const latestFile = memoryFiles[memoryFiles.length - 1];
    const content = fs.readFileSync(latestFile, "utf8");
    const line = extractInsightFromMemory(content) || lastMeaningfulLine(content);
    if (line) {
      return {
        text: redactInline(line),
        date: path.basename(latestFile, ".md"),
        sourcePath: latestFile,
      };
    }
  }

  const sessionInsight = getRecentSessionInsight(agentId);
  if (sessionInsight) {
    return {
      text: redactInline(`最近任务：${sessionInsight.text}`),
      date: toLocalDateKey(sessionInsight.updatedAt || Date.now()),
      sourcePath: sessionInsight.sourcePath || (sessionInsight.sessionId ? `session:${sessionInsight.sessionId}` : null),
    };
  }

  const fallbackFiles = ["SOUL.md", "MEMORY.md"].map((name) => path.join(workspace, name));
  for (const filePath of fallbackFiles) {
    if (!fileExists(filePath)) continue;
    const line = firstMeaningfulLine(fs.readFileSync(filePath, "utf8"));
    const stat = safeStat(filePath);
    if (line) {
      return {
        text: redactInline(line),
        date: toLocalDateKey(stat?.mtimeMs || Date.now()),
        sourcePath: filePath,
      };
    }
  }
  return {
    text: "No recent reflection found yet.",
    date: null,
    sourcePath: null,
  };
}

function readSessionRegistry(agentId) {
  const registryPath = path.join(OPENCLAW_HOME, "agents", agentId, "sessions", "sessions.json");
  const raw = readJson(registryPath, {});
  const records = [];
  for (const [key, value] of Object.entries(raw || {})) {
    if (!value || typeof value !== "object") continue;
    const updatedAt = Number(value.updatedAt || 0);
    records.push({
      key,
      agentId,
      sessionId: value.sessionId || null,
      label: value.label || null,
      model: value.model || value.modelProvider || "Unknown",
      modelProvider: value.modelProvider || "unknown",
      updatedAt,
      inputTokens: Number(value.inputTokens || 0),
      outputTokens: Number(value.outputTokens || 0),
      totalTokens: Number(value.totalTokens || 0),
      contextTokens: Number(value.contextTokens || 0),
      skillsSnapshot: value.skillsSnapshot || null,
      sourcePath: registryPath,
    });
  }
  const deduped = new Map();
  for (const item of records) {
    const key = `${item.agentId}:${item.sessionId || item.key}`;
    const existing = deduped.get(key);
    if (!existing || item.updatedAt >= existing.updatedAt) deduped.set(key, item);
  }
  return Array.from(deduped.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function hasTokenActivity(record) {
  const total = toNumber(record?.totalTokens);
  const input = toNumber(record?.inputTokens);
  const output = toNumber(record?.outputTokens);
  return total > 0 || input > 0 || output > 0;
}

function toTimestamp(value, fallback = Date.now()) {
  const n = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function normalizeModelName(model) {
  const value = String(model || "").trim();
  return value || "Unknown";
}

function stripMetadataCodeFence(text) {
  return String(text || "").replace(/```(?:json|yaml|yml|txt|text)?\s*([\s\S]*?)```/gi, (block, body) => {
    const probe = String(body || "").toLowerCase();
    if (
      /conversation[_\s-]*label|conversation info|untrusted metadata|channel|session[_\s-]*id|timestamp|gmt[+-]?\d+/i.test(
        probe
      )
    ) {
      return " ";
    }
    return block;
  });
}

function normalizeQueryText(text, maxChars = 1200) {
  let compact = redactInline(String(text || ""))
    .replace(/<image>[\s\S]*?<\/image>/gi, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ");

  compact = stripMetadataCodeFence(compact)
    .replace(/conversation info\s*\(untrusted metadata\)\s*:?\s*/gi, " ")
    .replace(/(?:^|\s)untrusted metadata\s*:?\s*/gi, " ")
    .replace(/^\[[^\]]*(?:cron|schedule|metadata|session|channel|日报|定时任务)[^\]]*\]\s*/i, " ")
    .replace(/\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\]]*GMT[+-]?\d+[^\]]*\]/g, " ")
    .replace(/\bCurrent time:\s*[^。.!?]+(?:[。.!?]|$)/gi, " ")
    .replace(/\bReturn your summary as plain text[\s\S]*$/i, " ")
    .replace(/\bIf the task explicitly calls for messaging[\s\S]*$/i, " ")
    .replace(/^[\s\]\)]*\d{1,2}:\d{2}\s*定时任务\s*[-:：]\s*/i, " ")
    .replace(/["'`]?conversation[_\s-]*label["'`]?[\s:=-]+[A-Za-z0-9._/-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) return null;

  const leadingNoiseRe =
    /^(?:[\s,;|:]+|(?:conversation[_\s-]*label|conversation info|untrusted metadata|channel|source|date|time|timestamp|session(?:_id| id)?|openclaw-tui)\s*[:=\-]\s*)+/i;
  while (leadingNoiseRe.test(compact)) {
    compact = compact.replace(leadingNoiseRe, "").trim();
  }

  const agreeIdx = compact.indexOf("没错");
  if (agreeIdx > 0) {
    const prefix = compact.slice(0, agreeIdx);
    if (/conversation|metadata|openclaw-tui|gmt|session|\[[^\]]*$/i.test(prefix)) {
      compact = compact.slice(agreeIdx).trim();
    }
  }

  const firstHan = compact.search(/[\p{Script=Han}]/u);
  if (firstHan > 0 && firstHan < 260) {
    const prefix = compact.slice(0, firstHan);
    if (/conversation|metadata|openclaw-tui|gmt|session|[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}/i.test(prefix)) {
      compact = compact.slice(firstHan).trim();
    }
  }

  if (!compact) return null;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function isUnknownZeroNoiseRecord(record) {
  const model = normalizeModelName(record?.model);
  return model === "Unknown" && !hasTokenActivity(record);
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.input_text === "string") return part.input_text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content.text === "string") return content.text;
  if (typeof content.input_text === "string") return content.input_text;
  return "";
}

function shouldSkipAutoInjectedQuery(text) {
  const probe = String(text || "");
  return (
    probe.includes("AGENTS.md instructions") ||
    probe.includes("<permissions instructions>") ||
    probe.includes("You are Codex, a coding agent based on GPT-5")
  );
}

function getDb() {
  if (dbConn) return dbConn;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS session_rollup (
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, session_id)
    );
    CREATE TABLE IF NOT EXISTS session_fact (
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      label TEXT,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      input_query TEXT,
      source_path TEXT,
      PRIMARY KEY (source, session_id)
    );
    CREATE TABLE IF NOT EXISTS token_daily (
      day TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, source, model)
    );
    CREATE TABLE IF NOT EXISTS ingest_file (
      source TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      PRIMARY KEY (source, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_session_fact_updated_at ON session_fact(updated_at);
    CREATE INDEX IF NOT EXISTS idx_session_rollup_updated_at ON session_rollup(updated_at);
    CREATE INDEX IF NOT EXISTS idx_token_daily_day ON token_daily(day);
  `);
  dbConn = db;
  return db;
}

function listOpenClawSessionFiles(agentId) {
  const dir = path.join(OPENCLAW_HOME, "agents", agentId, "sessions");
  return listFiles(dir, (file) => /\.jsonl(\.deleted\..+)?$/i.test(path.basename(file)));
}

function parseOpenClawSessionFile(filePath, agentId, stat) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  const base = path.basename(filePath);
  const sessionMatch = base.match(/^([0-9a-f-]{36})\.jsonl(?:\.deleted\..+)?$/i);
  let sessionId = sessionMatch ? sessionMatch[1] : null;
  let label = null;
  let model = "Unknown";
  let updatedAt = Number(stat?.mtimeMs || Date.now());
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let inputQuery = null;

  for (const line of lines) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.timestamp) updatedAt = Math.max(updatedAt, toTimestamp(row.timestamp, updatedAt));
    if (row?.type === "session") {
      if (row?.id) sessionId = String(row.id);
      if (row?.timestamp) updatedAt = Math.max(updatedAt, toTimestamp(row.timestamp, updatedAt));
      continue;
    }
    if (row?.type === "model_change" && row?.modelId) {
      model = normalizeModelName(row.modelId);
      continue;
    }
    if (row?.type !== "message") continue;
    const message = row.message || {};
    if (message?.timestamp) updatedAt = Math.max(updatedAt, toTimestamp(message.timestamp, updatedAt));
    if (message?.role === "user") {
      const query = normalizeQueryText(extractTextFromContent(message.content), 1200);
      if (query) inputQuery = query;
      continue;
    }
    if (message?.role !== "assistant") continue;
    if (message?.model) model = normalizeModelName(message.model);
    const usage = message?.usage || {};
    const input = toNumber(usage.input) + toNumber(usage.cacheRead) + toNumber(usage.cacheWrite);
    const output = toNumber(usage.output);
    const total = toNumber(usage.totalTokens) || input + output;
    inputTokens += input;
    outputTokens += output;
    totalTokens += total;
    if (!label && message?.stopReason) label = String(message.stopReason);
  }

  if (!sessionId) return null;
  return {
    source: "openclaw",
    sessionId,
    agentId,
    label,
    model: normalizeModelName(model),
    updatedAt,
    inputTokens,
    outputTokens,
    totalTokens,
    inputQuery,
    sourcePath: filePath,
  };
}

function mergeOpenClawParsedWithRegistry(parsed, registryRecord) {
  if (!registryRecord) return parsed;
  const modelFromRegistry = normalizeModelName(registryRecord.model);
  const parsedModel = normalizeModelName(parsed.model);
  const model = modelFromRegistry !== "Unknown" ? modelFromRegistry : parsedModel;
  const registryInput = toNumber(registryRecord.inputTokens);
  const registryOutput = toNumber(registryRecord.outputTokens);
  const registryTotal = toNumber(registryRecord.totalTokens);

  return {
    ...parsed,
    label: registryRecord.label || parsed.label || null,
    model,
    updatedAt: Math.max(toTimestamp(registryRecord.updatedAt, 0), toTimestamp(parsed.updatedAt, 0)),
    inputTokens: registryInput > 0 ? registryInput : parsed.inputTokens,
    outputTokens: registryOutput > 0 ? registryOutput : parsed.outputTokens,
    totalTokens: registryTotal > 0 ? registryTotal : parsed.totalTokens,
    sourcePath: parsed.sourcePath || registryRecord.sourcePath || null,
  };
}

function parseCodexSessionFile(filePath, stat) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  let sessionId = null;
  let model = "Codex Local";
  let updatedAt = Number(stat?.mtimeMs || Date.now());
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let inputQuery = null;

  for (const line of lines) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.timestamp) updatedAt = Math.max(updatedAt, toTimestamp(row.timestamp, updatedAt));
    if (row?.type === "session_meta") {
      sessionId = row?.payload?.id || sessionId;
      if (row?.payload?.timestamp) updatedAt = Math.max(updatedAt, toTimestamp(row.payload.timestamp, updatedAt));
      continue;
    }
    if (row?.type === "turn_context" && row?.payload?.model) {
      model = normalizeModelName(row.payload.model);
      continue;
    }
    if (row?.type === "response_item") {
      const payload = row.payload || {};
      if (payload.type === "message" && payload.role === "user") {
        const query = normalizeQueryText(extractTextFromContent(payload.content), 1200);
        if (query && !shouldSkipAutoInjectedQuery(query)) {
          inputQuery = query;
        } else if (query && !inputQuery) {
          inputQuery = query;
        }
      }
      continue;
    }
    if (row?.type !== "event_msg" || row?.payload?.type !== "token_count") continue;
    const info = row.payload.info || {};
    const total = info.total_token_usage || {};
    inputTokens = toNumber(total.input_tokens);
    outputTokens = toNumber(total.output_tokens);
    totalTokens = toNumber(total.total_tokens) || inputTokens + outputTokens;
  }

  if (!sessionId) sessionId = path.basename(filePath, ".jsonl");
  return {
    source: "codex",
    sessionId,
    agentId: "codex",
    label: "Codex local session",
    model: normalizeModelName(model),
    updatedAt,
    inputTokens,
    outputTokens,
    totalTokens,
    inputQuery,
    sourcePath: filePath,
  };
}

function rebuildTokenDaily(db) {
  db.exec("DELETE FROM token_daily");
  db.exec(`
    INSERT INTO token_daily (
      day, source, model, input_tokens, output_tokens, total_tokens, sessions
    )
    SELECT
      strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch') AS day,
      source,
      COALESCE(NULLIF(TRIM(model), ''), 'Unknown') AS model,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(total_tokens) AS total_tokens,
      COUNT(*) AS sessions
    FROM session_rollup
    WHERE total_tokens > 0
    GROUP BY 1, 2, 3
  `);
}

function ingestDashboardData(agents, allSessionRecords) {
  const db = getDb();
  const now = Date.now();
  const registryBySession = new Map();
  for (const record of allSessionRecords) {
    if (!record.sessionId) continue;
    const key = `${record.agentId}:${record.sessionId}`;
    const existing = registryBySession.get(key);
    if (!existing || toTimestamp(record.updatedAt, 0) >= toTimestamp(existing.updatedAt, 0)) {
      registryBySession.set(key, record);
    }
  }

  const getIngestedFileState = db.prepare(`
    SELECT mtime_ms, size_bytes
    FROM ingest_file
    WHERE source = ? AND file_path = ?
  `);
  const upsertIngestedFileState = db.prepare(`
    INSERT INTO ingest_file (source, file_path, mtime_ms, size_bytes, ingested_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, file_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      ingested_at = excluded.ingested_at
  `);
  const upsertRollup = db.prepare(`
    INSERT INTO session_rollup (
      source, session_id, agent_id, model, updated_at,
      input_tokens, output_tokens, total_tokens
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, session_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      model = excluded.model,
      updated_at = excluded.updated_at,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens
  `);
  const upsertFact = db.prepare(`
    INSERT INTO session_fact (
      source, session_id, agent_id, label, model, updated_at,
      input_tokens, output_tokens, total_tokens, input_query, source_path
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, session_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      label = COALESCE(excluded.label, session_fact.label),
      model = excluded.model,
      updated_at = excluded.updated_at,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      input_query = CASE
        WHEN excluded.input_query IS NOT NULL AND LENGTH(excluded.input_query) > 0
          THEN excluded.input_query
        ELSE session_fact.input_query
      END,
      source_path = COALESCE(excluded.source_path, session_fact.source_path)
  `);

  function upsertSession(row) {
    if (!row?.sessionId) return;
    if (!hasTokenActivity(row)) return;
    if (isUnknownZeroNoiseRecord(row)) return;
    const source = row.source === "codex" ? "codex" : "openclaw";
    const sessionId = String(row.sessionId);
    const agentId = row.agentId ? String(row.agentId) : null;
    const label = row.label ? String(row.label) : null;
    const model = normalizeModelName(row.model);
    const updatedAt = toTimestamp(row.updatedAt, now);
    const inputTokens = toNumber(row.inputTokens);
    const outputTokens = toNumber(row.outputTokens);
    const totalTokens = toNumber(row.totalTokens) || inputTokens + outputTokens;
    const inputQuery = normalizeQueryText(row.inputQuery, 1200);
    const sourcePath = row.sourcePath ? String(row.sourcePath) : null;
    upsertRollup.run(source, sessionId, agentId, model, updatedAt, inputTokens, outputTokens, totalTokens);
    upsertFact.run(
      source,
      sessionId,
      agentId,
      label,
      model,
      updatedAt,
      inputTokens,
      outputTokens,
      totalTokens,
      inputQuery,
      sourcePath
    );
  }

  for (const agent of agents) {
    const files = listOpenClawSessionFiles(agent.id)
      .map((filePath) => ({ filePath, stat: safeStat(filePath) }))
      .filter((item) => item.stat && item.stat.isFile())
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    for (const { filePath, stat } of files) {
      const mtimeMs = Math.round(stat.mtimeMs);
      const prev = getIngestedFileState.get("openclaw", filePath);
      if (prev && Number(prev.mtime_ms) === mtimeMs && Number(prev.size_bytes) === stat.size) continue;
      const parsed = parseOpenClawSessionFile(filePath, agent.id, stat);
      if (parsed) {
        const registry = registryBySession.get(`${agent.id}:${parsed.sessionId}`) || null;
        upsertSession(mergeOpenClawParsedWithRegistry(parsed, registry));
      }
      upsertIngestedFileState.run("openclaw", filePath, mtimeMs, stat.size, now);
    }
  }

  // Session registry can advance token counters even when jsonl mtime is unchanged.
  for (const record of allSessionRecords) {
    upsertSession({
      source: "openclaw",
      sessionId: record.sessionId,
      agentId: record.agentId,
      label: record.label,
      model: record.model,
      updatedAt: record.updatedAt,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      inputQuery: null,
      sourcePath: record.sourcePath,
    });
  }

  const codexFiles = listFilesRecursive(CODEX_SESSIONS_DIR, 4)
    .filter((file) => file.endsWith(".jsonl"))
    .map((filePath) => ({ filePath, stat: safeStat(filePath) }))
    .filter((item) => item.stat && item.stat.isFile())
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  for (const { filePath, stat } of codexFiles) {
    const mtimeMs = Math.round(stat.mtimeMs);
    const prev = getIngestedFileState.get("codex", filePath);
    if (prev && Number(prev.mtime_ms) === mtimeMs && Number(prev.size_bytes) === stat.size) continue;
    const parsed = parseCodexSessionFile(filePath, stat);
    if (parsed) upsertSession(parsed);
    upsertIngestedFileState.run("codex", filePath, mtimeMs, stat.size, now);
  }

  const cutoff = now - SESSION_RETENTION_MS;
  db.prepare(
    "DELETE FROM session_fact WHERE COALESCE(total_tokens, 0) <= 0 AND COALESCE(input_tokens, 0) <= 0 AND COALESCE(output_tokens, 0) <= 0"
  ).run();
  db.prepare(
    "DELETE FROM session_rollup WHERE COALESCE(total_tokens, 0) <= 0 AND COALESCE(input_tokens, 0) <= 0 AND COALESCE(output_tokens, 0) <= 0"
  ).run();
  db.prepare("DELETE FROM session_fact WHERE updated_at < ?").run(cutoff);
  db.prepare("DELETE FROM session_rollup WHERE updated_at < ?").run(cutoff);
  rebuildTokenDaily(db);
}

function readSessionPointsFromDb() {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        source,
        session_id AS sessionId,
        agent_id AS agentId,
        label,
        model,
        updated_at AS updatedAt,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        total_tokens AS totalTokens,
        input_query AS inputQuery,
        source_path AS sourcePath
      FROM session_fact
      WHERE
        COALESCE(total_tokens, 0) > 0 OR
        COALESCE(input_tokens, 0) > 0 OR
        COALESCE(output_tokens, 0) > 0
      ORDER BY updated_at ASC
    `)
    .all();
  return rows.map((row) => ({
    source: row.source,
    sessionId: row.sessionId,
    agentId: row.agentId,
    label: row.label,
    model: normalizeModelName(row.model),
    updatedAt: toNumber(row.updatedAt),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    totalTokens: toNumber(row.totalTokens),
    inputQuery: normalizeQueryText(row.inputQuery, 1200),
    sourcePath: row.sourcePath || null,
  }));
}

function readTokenCoverageFromDb() {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT
        MIN(day) AS oldestDay,
        MAX(day) AS latestDay,
        COUNT(*) AS bucketCount
      FROM token_daily
    `)
    .get();
  return {
    oldestDay: row?.oldestDay || null,
    latestDay: row?.latestDay || null,
    bucketCount: toNumber(row?.bucketCount),
  };
}

function buildModelCards(config, sessionRecords) {
  const cards = [];
  const seen = new Set();
  const defaults = config?.agents?.defaults || {};
  const aliases = defaults.models || {};
  const providerModels = config?.models?.providers || {};
  const primary = defaults?.model?.primary || null;
  const fallbacks = defaults?.model?.fallbacks || [];

  function pushModel(id, extra = {}) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const alias = aliases[id]?.alias || id.split("/").pop();
    cards.push({
      id: `model:${id}`,
      kind: "model",
      title: alias,
      subtitle: id,
      badge: "MODEL",
      source: "openclaw config",
      filePath: OPENCLAW_CONFIG,
      details: {
        id,
        alias,
        role:
          id === primary ? "Primary" : fallbacks.includes(id) ? "Fallback" : "Additional",
        ...extra,
      },
    });
  }

  pushModel(primary);
  for (const fallback of fallbacks) pushModel(fallback);
  for (const id of Object.keys(aliases)) pushModel(id, { alias: aliases[id]?.alias || null });

  for (const [providerName, provider] of Object.entries(providerModels)) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      const id = `${providerName}/${model.id || model.name || "unknown"}`;
      pushModel(id, {
        contextWindow: model.contextWindow || null,
        maxTokens: model.maxTokens || null,
      });
    }
  }

  const modelTokens = {};
  for (const record of sessionRecords) {
    const key = record.model || "Unknown";
    modelTokens[key] = (modelTokens[key] || 0) + record.totalTokens;
  }
  cards.forEach((card) => {
    const modelId = card.details.id || "";
    const alias = card.details.alias || "";
    const shortId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
    card.details.lastSeenTokens =
      modelTokens[modelId] || modelTokens[shortId] || modelTokens[alias] || 0;
  });

  return cards.sort((a, b) => (b.details.lastSeenTokens || 0) - (a.details.lastSeenTokens || 0));
}

function buildSkillCards(sessionRecords, workspacePaths) {
  const cards = [];
  const seen = new Set();
  for (const record of sessionRecords) {
    const resolved = record.skillsSnapshot?.resolvedSkills || [];
    for (const skill of resolved) {
      const key = `${skill.name}|${skill.filePath || ""}`;
      if (!skill?.name || seen.has(key)) continue;
      seen.add(key);
      cards.push({
        id: `skill:${skill.name}:${cards.length + 1}`,
        kind: "skill",
        title: skill.name,
        subtitle: skill.description || "No description",
        badge: "SKILL",
        source: skill.source || "unknown",
        filePath: skill.filePath || null,
        details: {
          name: skill.name,
          source: skill.source || "unknown",
          baseDir: skill.baseDir || null,
          disableModelInvocation: Boolean(skill.disableModelInvocation),
        },
      });
    }
  }

  for (const workspacePath of workspacePaths) {
    const skillsDir = path.join(workspacePath, "skills");
    if (!fileExists(skillsDir)) continue;
    for (const file of listFilesRecursive(skillsDir, 3)) {
      if (!file.endsWith("SKILL.md")) continue;
      const dirName = path.basename(path.dirname(file));
      const key = `${dirName}|${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({
        id: `skill:${dirName}:${cards.length + 1}`,
        kind: "skill",
        title: dirName,
        subtitle: "Workspace skill",
        badge: "SKILL",
        source: "workspace",
        filePath: file,
        details: { name: dirName, source: "workspace", baseDir: path.dirname(file) },
      });
    }
  }

  return cards.sort((a, b) => a.title.localeCompare(b.title));
}

function listFilesRecursive(dir, maxDepth = 2, depth = 0) {
  if (depth > maxDepth) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(target, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      out.push(target);
    }
  }
  return out;
}

function buildPluginCards(config) {
  const entries = config?.plugins?.entries || {};
  return Object.keys(entries)
    .sort((a, b) => a.localeCompare(b))
    .map((name, idx) => {
      const value = entries[name] || {};
      return {
        id: `plugin:${name}:${idx + 1}`,
        kind: "plugin",
        title: name,
        subtitle: value.enabled ? "Enabled" : "Disabled",
        badge: "PLUGIN",
        source: "openclaw config",
        filePath: OPENCLAW_CONFIG,
        details: {
          name,
          enabled: Boolean(value.enabled),
          config: redactObject(value),
        },
      };
    });
}

function buildAgents(config) {
  const agents = config?.agents?.list || [];
  return agents.map((agent) => {
    const workspace = agent.workspace || "";
    const insight = getLatestInsight(workspace, agent.id);
    const style = getAgentStyle(workspace);
    const soulPath = path.join(workspace, "SOUL.md");
    const summary = fileExists(soulPath)
      ? firstMeaningfulLine(fs.readFileSync(soulPath, "utf8"))
      : "No agent summary found.";
    return {
      id: agent.id,
      name: agent?.identity?.name || agent.id,
      emoji: agent?.identity?.emoji || "•",
      model: agent.model || "Unknown",
      workspace,
      summary: redactInline(summary),
      style,
      latestInsight: insight.text,
      insightEmoji: pickInsightEmoji(insight.text || style || summary),
      insightDate: insight.date,
      insightSourcePath: insight.sourcePath,
      detailPath: path.join(workspace, "AGENTS.md"),
    };
  });
}

function aggregateUsage(records) {
  const totals = { totalTokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0 };
  const daily = {};
  const modelDistribution = {};
  const recent = [];
  const points = [];

  for (const record of records) {
    if (!hasTokenActivity(record)) continue;
    if (isUnknownZeroNoiseRecord(record)) continue;
    totals.totalTokens += toNumber(record.totalTokens);
    totals.inputTokens += toNumber(record.inputTokens);
    totals.outputTokens += toNumber(record.outputTokens);
    totals.sessions += 1;
    const dateKey = new Date(toTimestamp(record.updatedAt, Date.now())).toISOString().slice(0, 10);
    daily[dateKey] = (daily[dateKey] || 0) + toNumber(record.totalTokens);
    const model = normalizeModelName(record.model);
    modelDistribution[model] = (modelDistribution[model] || 0) + toNumber(record.totalTokens);
    recent.push({
      source: record.source || "openclaw",
      sessionId: record.sessionId,
      agentId: record.agentId,
      label: record.label,
      model,
      updatedAt: toTimestamp(record.updatedAt, Date.now()),
      totalTokens: toNumber(record.totalTokens),
      inputTokens: toNumber(record.inputTokens),
      outputTokens: toNumber(record.outputTokens),
      inputQuery: record.inputQuery || null,
      sourcePath: record.sourcePath,
    });
    points.push({
      source: record.source || "openclaw",
      sessionId: record.sessionId,
      agentId: record.agentId,
      model,
      updatedAt: toTimestamp(record.updatedAt, Date.now()),
      totalTokens: toNumber(record.totalTokens),
      inputTokens: toNumber(record.inputTokens),
      outputTokens: toNumber(record.outputTokens),
      inputQuery: record.inputQuery || null,
    });
  }

  const trend = Object.keys(daily)
    .sort((a, b) => a.localeCompare(b))
    .slice(-14)
    .map((date) => ({ date, label: relativeDateLabel(date), tokens: daily[date] }));

  const models = Object.entries(modelDistribution)
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);

  return {
    totals,
    trend,
    models,
    recent: recent.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12),
    points: points.sort((a, b) => a.updatedAt - b.updatedAt),
  };
}

function buildDashboard() {
  const configRaw = readJson(OPENCLAW_CONFIG, {}) || {};
  const agentConfigs = configRaw?.agents?.list || [];
  const allSessionRecords = [];
  for (const agent of agentConfigs) {
    allSessionRecords.push(...readSessionRegistry(agent.id));
  }
  ingestDashboardData(agentConfigs, allSessionRecords);
  const agents = buildAgents(configRaw);
  const usage = aggregateUsage(readSessionPointsFromDb());
  const workspacePaths = agents.map((agent) => agent.workspace).filter(Boolean);
  const models = buildModelCards(configRaw, allSessionRecords);
  const skills = buildSkillCards(allSessionRecords, workspacePaths);
  const plugins = buildPluginCards(configRaw);
  const coverage = readTokenCoverageFromDb();

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      openclawHome: OPENCLAW_HOME,
      configPath: OPENCLAW_CONFIG,
      dbPath: DB_PATH,
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      tokenHistory: coverage,
    },
    overview: usage.totals,
    trend: usage.trend,
    modelDistribution: usage.models,
    agents,
    catalog: {
      models,
      skills,
      plugins,
    },
    recentSessions: usage.recent,
    sessionPoints: usage.points,
  };
}

function getDashboardCached() {
  const now = Date.now();
  if (dashboardCache && now - dashboardCacheAt < CACHE_TTL_MS) return dashboardCache;
  dashboardCache = buildDashboard();
  dashboardCacheAt = now;
  return dashboardCache;
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function insideAllowedRoots(target, roots) {
  const resolvedTarget = path.resolve(target);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
  });
}

function readDetailFile(filePath, dashboard) {
  const roots = new Set([
    OPENCLAW_HOME,
    path.join(os.homedir(), ".codex"),
    "/opt/homebrew/lib/node_modules/openclaw",
    ROOT,
  ]);
  for (const agent of dashboard.agents) {
    if (agent.workspace) roots.add(agent.workspace);
  }
  if (!insideAllowedRoots(filePath, Array.from(roots))) {
    return { ok: false, error: "Path is outside allowed roots." };
  }
  if (!fileExists(filePath)) {
    return { ok: false, error: "File does not exist." };
  }
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) {
    return { ok: false, error: "Target is not a regular file." };
  }
  const maxBytes = 200_000;
  const truncated = stat.size > maxBytes;
  const content = fs.readFileSync(filePath, "utf8");
  const partial = truncated ? content.slice(0, maxBytes) : content;
  let output = partial;
  if (filePath.endsWith(".json")) {
    const parsed = readJson(filePath, null);
    if (parsed && typeof parsed === "object") {
      output = JSON.stringify(redactObject(parsed), null, 2);
    } else {
      output = redactInline(partial);
    }
  } else {
    output = redactInline(partial);
  }
  return {
    ok: true,
    filePath,
    size: stat.size,
    truncated,
    content: output,
  };
}

function serveStatic(reqPath, res) {
  const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
  const safePath = path.normalize(cleanPath).replace(/^\/+/, "");
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!insideAllowedRoots(fullPath, [PUBLIC_DIR]) || !fileExists(fullPath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mimeType });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (pathname === "/api/ping") {
    return jsonResponse(res, 200, { ok: true, now: new Date().toISOString() });
  }

  if (pathname === "/api/dashboard") {
    try {
      return jsonResponse(res, 200, getDashboardCached());
    } catch (error) {
      return jsonResponse(res, 500, { error: "Failed to build dashboard", detail: String(error.message || error) });
    }
  }

  if (pathname === "/api/file") {
    try {
      const filePath = requestUrl.searchParams.get("path");
      if (!filePath) return jsonResponse(res, 400, { error: "Missing path parameter." });
      const result = readDetailFile(filePath, getDashboardCached());
      if (!result.ok) return jsonResponse(res, 400, result);
      return jsonResponse(res, 200, result);
    } catch (error) {
      return jsonResponse(res, 500, { error: "Failed to read file", detail: String(error.message || error) });
    }
  }

  return serveStatic(pathname, res);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`OpenClaw Dashboard running at http://${HOST}:${PORT}\n`);
});
