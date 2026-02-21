const state = {
  data: null,
  staticMode: false,
  activeTab: "models",
  activeRange: "day",
  activeView: "overview",
  search: "",
  filters: {
    model: null,
    bucket: null,
    bucketIndex: null,
  },
};

const charts = {
  trend: null,
  donut: null,
  wordCloud: null,
};

const colors = ["#007f8f", "#0d638f", "#ff8a3d", "#4f7d2f", "#ad4f8f", "#1e9b63", "#6e5ef0", "#0e2f44"];
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let refreshInFlight = false;
let cloudResizeTimer = null;
let autoRefreshTimer = null;

const els = {
  appShell: document.querySelector(".app-shell"),
  overviewView: document.getElementById("overview-view"),
  sessionsView: document.getElementById("sessions-view"),
  navItems: [...document.querySelectorAll(".nav-item")],
  metrics: document.getElementById("metrics"),
  agents: document.getElementById("agents"),
  cards: document.getElementById("catalog-cards"),
  sessionsTable: document.getElementById("sessions-table"),
  sessions90dTable: document.getElementById("sessions-90d-table"),
  sessions90dSummary: document.getElementById("sessions-90d-summary"),
  wordCloudCanvas: document.getElementById("word-cloud-canvas"),
  wordCloudEmpty: document.getElementById("word-cloud-empty"),
  rangeContext: document.getElementById("range-context"),
  refreshBtn: document.getElementById("refresh-btn"),
  generatedAt: document.getElementById("generated-at"),
  donutLegend: document.getElementById("donut-legend"),
  detail: document.getElementById("detail"),
  detailTitle: document.getElementById("detail-title"),
  detailSubtitle: document.getElementById("detail-subtitle"),
  detailMeta: document.getElementById("detail-meta"),
  detailContent: document.getElementById("detail-content"),
  search: document.getElementById("search"),
  closeDetail: document.getElementById("close-detail"),
  trendCanvas: document.getElementById("trend-chart"),
  trendHours: document.getElementById("trend-hours"),
  donutCanvas: document.getElementById("donut-chart"),
  sessionsFilterSummary: document.getElementById("sessions-filter-summary"),
  clearSessionsFilter: document.getElementById("clear-sessions-filter"),
};

function compactNum(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function formatToken(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value || 0));
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function previewQuery(value, maxChars = 140) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "-";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function toDayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatBucketRange(bucket) {
  if (!bucket) return "";
  if (state.activeRange === "day") {
    return new Date(bucket.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }
  return new Date(bucket.start).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function rangeWindowMs(range) {
  if (range === "day") return 24 * 60 * 60 * 1000;
  if (range === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function rangeLabel(range) {
  if (range === "day") return "Last 24 hours";
  if (range === "week") return "Last 7 days";
  return "Last 30 days";
}

function renderRangeContext() {
  if (!els.rangeContext) return;
  els.rangeContext.textContent = rangeLabel(state.activeRange);
}

function setActiveView(view, activeButton = null) {
  state.activeView = view === "sessions" ? "sessions" : "overview";
  const isSessions = state.activeView === "sessions";
  els.overviewView?.classList.toggle("view-hidden", isSessions);
  els.sessionsView?.classList.toggle("view-hidden", !isSessions);
  els.navItems.forEach((item) => item.classList.remove("active"));
  if (activeButton) {
    activeButton.classList.add("active");
  } else {
    const fallback = els.navItems.find((item) => item.dataset.view === state.activeView);
    fallback?.classList.add("active");
  }
  if (isSessions) {
    const rows = renderSessions90Days();
    requestAnimationFrame(() => renderWordCloud(rows));
  } else if (charts.wordCloud) {
    charts.wordCloud.destroy();
    charts.wordCloud = null;
    els.wordCloudEmpty.classList.remove("show");
  }
}

function setRefreshBusy(isBusy) {
  if (!els.refreshBtn) return;
  els.refreshBtn.classList.toggle("spinning", Boolean(isBusy));
  els.refreshBtn.disabled = Boolean(isBusy);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const detail = payload?.error || text || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid JSON payload");
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function rangeEndTs() {
  const ts = Date.parse(state.data?.meta?.generatedAt || "");
  return Number.isNaN(ts) ? Date.now() : ts;
}

function filteredSessionPoints() {
  const points = state.data?.sessionPoints || [];
  const end = rangeEndTs();
  const start = end - rangeWindowMs(state.activeRange);
  return points.filter((point) => point.updatedAt >= start && point.updatedAt <= end);
}

function sessionsFor90Days() {
  const now = rangeEndTs();
  const cutoff = toDayStart(now - 89 * 24 * 60 * 60 * 1000);
  const query = state.search.trim().toLowerCase();
  const rows = (state.data?.sessionPoints || []).filter((row) => row.updatedAt >= cutoff && row.updatedAt <= now);
  if (!query) return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows
    .filter((row) => {
      return `${row.source || ""} ${row.agentId || ""} ${row.model || ""} ${row.inputQuery || ""}`
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function isSessionsViewVisible() {
  if (state.activeView !== "sessions") return false;
  if (!els.sessionsView || els.sessionsView.classList.contains("view-hidden")) return false;
  const w = els.wordCloudCanvas?.clientWidth || 0;
  const h = els.wordCloudCanvas?.clientHeight || 0;
  return w > 40 && h > 40;
}

function totalsForRange() {
  const points = filteredSessionPoints();
  return points.reduce(
    (acc, point) => {
      acc.totalTokens += point.totalTokens || 0;
      acc.inputTokens += point.inputTokens || 0;
      acc.outputTokens += point.outputTokens || 0;
      acc.sessions += 1;
      return acc;
    },
    { totalTokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0 }
  );
}

function renderMetrics() {
  const o = totalsForRange();
  const items = [
    ["Total Tokens", compactNum(o.totalTokens)],
    ["Input Tokens", compactNum(o.inputTokens)],
    ["Output Tokens", compactNum(o.outputTokens)],
    ["Total Sessions", compactNum(o.sessions)],
  ];
  els.metrics.innerHTML = items
    .map(
      ([label, value]) => `
      <article class="metric-card">
        <h3>${label}</h3>
        <div class="metric-value">${value}</div>
      </article>
    `
    )
    .join("");
}

function renderAgents() {
  const query = state.search.trim().toLowerCase();
  const agents = (state.data?.agents || []).filter((agent) => {
    if (!query) return true;
    return (
      `${agent.name} ${agent.model} ${agent.summary} ${agent.style || ""} ${agent.latestInsight}`
        .toLowerCase()
        .includes(query)
    );
  });
  els.agents.innerHTML = agents
    .map((agent) => {
      const summary = (agent.summary || "No summary.").trim();
      const style = (agent.style || "").trim();
      const mainLine = style || summary;
      const mainLabel = style ? "🎨 Style" : "🧾 简介";
      const insight = (agent.latestInsight || "").trim();
      const insightEmoji = (agent.insightEmoji || "✨").trim();
      const normalizedSummary = mainLine.replace(/\s+/g, " ");
      const normalizedInsight = insight.replace(/\s+/g, " ");
      const showInsight = Boolean(insight) && normalizedInsight !== normalizedSummary;
      return `
      <article class="agent-card" data-agent-id="${agent.id}">
        <div class="agent-head">
          <h3 class="agent-name">${agent.emoji || ""} ${agent.name}</h3>
          <span class="tag">${agent.id}</span>
        </div>
        <div class="agent-core">
          <p class="agent-core-line">
            <span class="agent-core-label">${mainLabel}</span>
            <span class="agent-core-text">${escapeHtml(mainLine)}</span>
          </p>
          ${
            showInsight
              ? `<p class="agent-core-line">
            <span class="agent-core-label">${escapeHtml(insightEmoji)} 感悟</span>
            <span class="agent-core-text">${escapeHtml(insight)}</span>
          </p>`
              : ""
          }
        </div>
        <p class="agent-summary">Model: ${agent.model}</p>
        <p class="agent-summary">Insight date: ${agent.insightDate || "N/A"}</p>
      </article>
    `
    })
    .join("");

  [...els.agents.querySelectorAll(".agent-card[data-agent-id]")].forEach((el) => {
    el.addEventListener("click", () => openAgentDetails(el.getAttribute("data-agent-id")));
  });
}

function activeCards() {
  const all = state.data?.catalog?.[state.activeTab] || [];
  const query = state.search.trim().toLowerCase();
  if (!query) return all;
  return all.filter((card) => {
    return `${card.title} ${card.subtitle} ${card.source}`.toLowerCase().includes(query);
  });
}

function renderCatalog() {
  const cards = activeCards();
  els.cards.innerHTML = cards
    .map(
      (card) => `
      <article class="catalog-card" data-card-id="${card.id}">
        <div class="card-head">
          <h3 class="card-title">${card.title}</h3>
          <span class="badge">${card.badge}</span>
        </div>
        <p class="card-subtitle">${card.subtitle || ""}</p>
        <p class="card-subtitle">Source: ${card.source}</p>
      </article>
    `
    )
    .join("");

  [...els.cards.querySelectorAll(".catalog-card")].forEach((el) => {
    el.addEventListener("click", () => openCardDetails(el.getAttribute("data-card-id")));
  });
}

function hasActiveSessionFilter() {
  return Boolean(state.filters.model || state.filters.bucket);
}

function sessionsForView() {
  let rows = filteredSessionPoints();
  if (state.filters.model) {
    rows = rows.filter((row) => (row.model || "Unknown") === state.filters.model);
  }
  if (state.filters.bucket) {
    rows = rows.filter(
      (row) => row.updatedAt >= state.filters.bucket.start && row.updatedAt < state.filters.bucket.end
    );
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderSessionFilterState() {
  const parts = [];
  if (state.filters.model) parts.push(`Model: ${state.filters.model}`);
  if (state.filters.bucket) parts.push(`Bucket: ${formatBucketRange(state.filters.bucket)}`);
  els.sessionsFilterSummary.textContent = parts.length > 0 ? parts.join(" | ") : "No active filter";
  els.clearSessionsFilter.disabled = !hasActiveSessionFilter();
}

function renderSessions() {
  const rows = sessionsForView();
  if (rows.length === 0) {
    els.sessionsTable.innerHTML = `
      <tr>
        <td colspan="7" style="color:#5f6f7f">No sessions for current filters.</td>
      </tr>
    `;
    renderSessionFilterState();
    return;
  }
  els.sessionsTable.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${formatDate(row.updatedAt)}</td>
        <td>${escapeHtml(row.agentId || "-")}</td>
        <td>${escapeHtml(row.model || "Unknown")}</td>
        <td>${compactNum(row.inputTokens || 0)}</td>
        <td>${compactNum(row.outputTokens || 0)}</td>
        <td>${compactNum(row.totalTokens)}</td>
        <td class="session-query" title="${escapeHtml(row.inputQuery || "")}">${escapeHtml(previewQuery(row.inputQuery))}</td>
      </tr>
    `
    )
    .join("");
  renderSessionFilterState();
}

function renderSessions90Days() {
  const rows = sessionsFor90Days();
  const queryMark = state.search.trim() ? " (filtered by search)" : "";
  els.sessions90dSummary.textContent = `${rows.length} sessions in last 90 days${queryMark}`;
  if (rows.length === 0) {
    els.sessions90dTable.innerHTML = `
      <tr>
        <td colspan="8" style="color:#5f6f7f">No sessions found in last 90 days.</td>
      </tr>
    `;
    return rows;
  }
  els.sessions90dTable.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${formatDate(row.updatedAt)}</td>
        <td>${escapeHtml(row.source || "-")}</td>
        <td>${escapeHtml(row.agentId || "-")}</td>
        <td>${escapeHtml(row.model || "Unknown")}</td>
        <td>${compactNum(row.inputTokens || 0)}</td>
        <td>${compactNum(row.outputTokens || 0)}</td>
        <td>${compactNum(row.totalTokens || 0)}</td>
        <td class="session-query" title="${escapeHtml(row.inputQuery || "")}">${escapeHtml(previewQuery(row.inputQuery, 200))}</td>
      </tr>
    `
    )
    .join("");
  return rows;
}

function tokenizeSessionInput(text) {
  const source = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[{}\[\]":,`]/g, " ")
    .replace(/\\n|\\t|\\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) return [];
  const tokens = [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    for (const piece of segmenter.segment(source)) {
      const word = String(piece?.segment || "").trim();
      if (!piece?.isWordLike || !word) continue;
      if (!/[\p{Script=Han}]/u.test(word)) continue;
      if (word.length < 2) continue;
      tokens.push(word);
    }
  } else {
    const matchedHan = source.match(/[\p{Script=Han}]{2,}/gu) || [];
    tokens.push(...matchedHan);
  }
  const latin = source.match(/[A-Za-z][A-Za-z0-9_./-]{2,}/g) || [];
  tokens.push(...latin.map((item) => item.toLowerCase()));
  return tokens;
}

function buildWordCloudTerms(rows, limit = 70) {
  const stopwords = new Set([
    "json",
    "true",
    "false",
    "null",
    "http",
    "https",
    "www",
    "com",
    "image",
    "input",
    "output",
    "token",
    "tokens",
    "role",
    "type",
    "text",
    "message",
    "from",
    "with",
    "this",
    "that",
    "your",
    "you",
    "the",
    "and",
    "for",
    "are",
    "was",
    "have",
    "has",
    "我",
    "你",
    "我们",
    "然后",
    "可以",
    "一下",
    "这个",
    "那个",
    "就是",
    "需要",
    "一个",
    "进行",
    "帮我",
  ]);
  const counts = new Map();
  for (const row of rows) {
    const tokens = tokenizeSessionInput(row.inputQuery || "");
    for (const token of tokens) {
      const normalized = /[A-Za-z]/.test(token) ? token.toLowerCase() : token;
      if (stopwords.has(normalized)) continue;
      if (/^\d+$/.test(normalized)) continue;
      if (normalized.length < 2) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function renderWordCloud(rows) {
  if (!window.Chart || !els.wordCloudCanvas) return;
  if (!isSessionsViewVisible()) return;
  const terms = buildWordCloudTerms(rows, 90);
  if (terms.length === 0) {
    if (charts.wordCloud) {
      charts.wordCloud.destroy();
      charts.wordCloud = null;
    }
    els.wordCloudEmpty.textContent = "No input text available for word cloud.";
    els.wordCloudEmpty.classList.add("show");
    return;
  }
  els.wordCloudEmpty.classList.remove("show");
  const max = terms[0].count;
  const min = terms[terms.length - 1].count;
  const span = Math.max(1, max - min);
  const mappedSizes = terms.map((term) => {
    const ratio = (term.count - min) / span;
    return Math.round(14 + ratio * 58);
  });
  const textColors = terms.map((_, idx) => {
    const hue = 188 + (idx % 7) * 11;
    const light = 24 + (idx % 3) * 6;
    return `hsl(${hue} 72% ${light}%)`;
  });
  const chartData = {
    labels: terms.map((term) => term.word),
    datasets: [
      {
        label: "Input Terms",
        data: mappedSizes,
        color: textColors,
        family: '"Sora", "IBM Plex Sans", sans-serif',
        weight: terms.map((term) => (term.count >= max * 0.5 ? "700" : "600")),
        padding: 2,
      },
    ],
  };
  if (!charts.wordCloud) {
    try {
      charts.wordCloud = new window.Chart(els.wordCloudCanvas, {
        type: "wordCloud",
        data: chartData,
        options: {
          maintainAspectRatio: false,
          layout: { padding: 8 },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label(context) {
                  const count = context.chart?.$counts?.[context.dataIndex] || 0;
                  return `${context.label}: ${count}`;
                },
              },
            },
          },
        },
      });
    } catch (error) {
      els.wordCloudEmpty.textContent = `Word cloud plugin failed: ${error?.message || error}`;
      els.wordCloudEmpty.classList.add("show");
      charts.wordCloud = null;
      return;
    }
  } else {
    charts.wordCloud.data = chartData;
    charts.wordCloud.update();
  }
  charts.wordCloud.$counts = terms.map((term) => term.count);
}

function hourlyBuckets(points, hours = 24) {
  const end = rangeEndTs();
  const hourMs = 60 * 60 * 1000;
  const anchor = new Date(end);
  anchor.setMinutes(0, 0, 0);
  const anchorMs = anchor.getTime();
  const start = anchorMs - (hours - 1) * hourMs;
  const buckets = Array.from({ length: hours }, (_, idx) => ({
    start: start + idx * hourMs,
    end: start + (idx + 1) * hourMs,
    tokens: 0,
  }));
  for (const point of points) {
    if (point.updatedAt < start || point.updatedAt > end) continue;
    const index = Math.min(hours - 1, Math.max(0, Math.floor((point.updatedAt - start) / hourMs)));
    buckets[index].tokens += point.totalTokens || 0;
  }
  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    tokens: bucket.tokens,
    label: new Date(bucket.start).toLocaleTimeString("en-US", { hour: "2-digit" }),
  }));
}

function dailyBuckets(points, days = 7, useWeekdayLabel = false) {
  const dayMs = 24 * 60 * 60 * 1000;
  const endDate = new Date(rangeEndTs());
  endDate.setHours(0, 0, 0, 0);
  const start = endDate.getTime() - (days - 1) * dayMs;
  const buckets = Array.from({ length: days }, (_, idx) => ({
    start: start + idx * dayMs,
    end: start + (idx + 1) * dayMs,
    tokens: 0,
  }));
  for (const point of points) {
    const d = new Date(point.updatedAt);
    d.setHours(0, 0, 0, 0);
    const dayStart = d.getTime();
    if (dayStart < start || dayStart > endDate.getTime()) continue;
    const index = Math.floor((dayStart - start) / dayMs);
    if (index >= 0 && index < days) buckets[index].tokens += point.totalTokens || 0;
  }
  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    tokens: bucket.tokens,
    label: useWeekdayLabel
      ? new Date(bucket.start).toLocaleDateString("en-US", { weekday: "short" })
      : new Date(bucket.start).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));
}

function scaledTrendData() {
  const points = filteredSessionPoints();
  if (state.activeRange === "day") return hourlyBuckets(points, 24);
  if (state.activeRange === "week") return dailyBuckets(points, 7, true);
  return dailyBuckets(points, 30, false);
}

function renderTrendHours() {
  if (!els.trendHours) return;
  if (state.activeRange !== "day") {
    els.trendHours.innerHTML = "";
    return;
  }
  const data = scaledTrendData();
  els.trendHours.innerHTML = data
    .map(
      (item) => `
      <div class="trend-hour-chip">
        <div class="time">${new Date(item.start).toLocaleTimeString("en-US", { hour: "2-digit", hour12: true })}</div>
        <div class="value">${compactNum(item.tokens || 0)}</div>
      </div>
    `
    )
    .join("");
}

const trendCrosshairPlugin = {
  id: "trendCrosshairPlugin",
  afterDatasetsDraw(chart) {
    const active = chart?.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(13, 99, 143, 0.24)";
    ctx.stroke();
    ctx.restore();
  },
};

function drawTrend() {
  const data = scaledTrendData();
  if (!window.Chart) return;
  if (state.filters.bucketIndex != null && state.filters.bucketIndex >= data.length) {
    state.filters.bucket = null;
    state.filters.bucketIndex = null;
  }

  const labels = data.map((item) => item.label);
  const values = data.map((item) => item.tokens || 0);
  const maxTicksLimit = state.activeRange === "day" ? 8 : state.activeRange === "week" ? 7 : 8;

  if (!charts.trend) {
    charts.trend = new window.Chart(els.trendCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Tokens",
            data: values,
            borderColor: "#007f8f",
            backgroundColor: "rgba(0, 127, 143, 0.12)",
            borderWidth: 2,
            pointRadius(context) {
              return context.dataIndex === state.filters.bucketIndex ? 5.2 : 2.5;
            },
            pointHoverRadius: 5,
            pointBackgroundColor(context) {
              return context.dataIndex === state.filters.bucketIndex ? "#ff8a3d" : "#0d638f";
            },
            tension: 0.25,
            fill: true,
          },
        ],
      },
      plugins: [trendCrosshairPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        animation: { duration: 220 },
        onClick(_evt, elements, chart) {
          if (!elements || elements.length === 0) {
            state.filters.bucket = null;
            state.filters.bucketIndex = null;
            drawTrend();
            renderSessions();
            return;
          }
          const index = elements[0].index;
          const selected = chart.$buckets?.[index] || null;
          if (state.filters.bucketIndex === index) {
            state.filters.bucket = null;
            state.filters.bucketIndex = null;
          } else {
            state.filters.bucket = selected;
            state.filters.bucketIndex = index;
          }
          drawTrend();
          renderSessions();
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(9, 23, 36, 0.92)",
            titleFont: { family: "IBM Plex Sans", size: 12, weight: "600" },
            bodyFont: { family: "IBM Plex Sans", size: 12 },
            callbacks: {
              label(context) {
                return `Tokens: ${formatToken(context.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: "#5f6f7f",
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit,
              font: { family: "IBM Plex Sans", size: 11 },
            },
          },
          y: {
            beginAtZero: true,
            grace: "10%",
            grid: { color: "#d9e6ee" },
            ticks: {
              color: "#5f6f7f",
              callback: (value) => compactNum(value),
              font: { family: "IBM Plex Sans", size: 11 },
            },
          },
        },
      },
    });
    charts.trend.$buckets = data;
    return;
  }

  charts.trend.data.labels = labels;
  charts.trend.data.datasets[0].data = values;
  charts.trend.options.scales.x.ticks.maxTicksLimit = maxTicksLimit;
  charts.trend.$buckets = data;
  charts.trend.update();
}

const donutCenterTextPlugin = {
  id: "donutCenterTextPlugin",
  afterDraw(chart) {
    const text = chart?.$centerText || "0";
    const ctx = chart.ctx;
    const x = chart.width / 2;
    const y = chart.height / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#0d1b2a";
    ctx.font = "700 24px Sora";
    ctx.fillText(text, x, y + 8);
    ctx.fillStyle = "#5f6f7f";
    ctx.font = "11px IBM Plex Sans";
    ctx.fillText("tokens", x, y + 24);
    ctx.restore();
  },
};

function drawDonut() {
  if (!window.Chart) return;
  const dist = modelDistributionForRange();
  const total = dist.reduce((sum, item) => sum + item.tokens, 0) || 1;
  const labels = dist.map((item) => item.model);
  const values = dist.map((item) => item.tokens || 0);
  const palette = dist.map((_, idx) => colors[idx % colors.length]);

  if (!charts.donut) {
    charts.donut = new window.Chart(els.donutCanvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: palette,
            borderWidth: 0,
            hoverOffset: 8,
          },
        ],
      },
      plugins: [donutCenterTextPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "74%",
        onClick(_evt, elements, chart) {
          if (!elements || elements.length === 0) return;
          const index = elements[0].index;
          const model = chart.data.labels?.[index] || null;
          state.filters.model = state.filters.model === model ? null : model;
          drawDonut();
          renderSessions();
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(9, 23, 36, 0.92)",
            titleFont: { family: "IBM Plex Sans", size: 12, weight: "600" },
            bodyFont: { family: "IBM Plex Sans", size: 12 },
            callbacks: {
              label(context) {
                return `${context.label}: ${formatToken(context.parsed)} tokens`;
              },
            },
          },
        },
      },
    });
  } else {
    charts.donut.data.labels = labels;
    charts.donut.data.datasets[0].data = values;
    charts.donut.data.datasets[0].backgroundColor = palette;
  }
  charts.donut.$centerText = compactNum(total);
  charts.donut.update();

  els.donutLegend.innerHTML = dist
    .map(
      (item, idx) => `
      <li data-model="${item.model}" class="${state.filters.model === item.model ? "active" : ""}">
        <span class="swatch" style="background:${colors[idx % colors.length]}"></span>
        <span>${item.model}</span>
        <strong style="margin-left:auto">${compactNum(item.tokens)}</strong>
      </li>
    `
    )
    .join("");

  [...els.donutLegend.querySelectorAll("li[data-model]")].forEach((el) => {
    el.addEventListener("click", () => {
      const model = el.getAttribute("data-model");
      state.filters.model = state.filters.model === model ? null : model;
      drawDonut();
      renderSessions();
    });
  });
}

function modelDistributionForRange() {
  const points = filteredSessionPoints();
  const map = {};
  for (const point of points) {
    const model = point.model || "Unknown";
    map[model] = (map[model] || 0) + (point.totalTokens || 0);
  }
  const dist = Object.entries(map)
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);
  if (dist.length > 0) return dist;
  return state.data?.modelDistribution || [];
}

function findCard(cardId) {
  const sections = state.data?.catalog || {};
  for (const key of Object.keys(sections)) {
    const match = (sections[key] || []).find((item) => item.id === cardId);
    if (match) return match;
  }
  return null;
}

function findAgent(agentId) {
  return (state.data?.agents || []).find((agent) => agent.id === agentId) || null;
}

function renderMeta(details) {
  const entries = Object.entries(details || {});
  if (entries.length === 0) return "No metadata.";
  return entries
    .map(([k, v]) => {
      const value = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `<div><strong>${k}</strong>: ${value}</div>`;
    })
    .join("");
}

function setDetailOpen(isOpen) {
  if (isOpen) {
    els.appShell?.classList.remove("detail-collapsed");
    els.detail.classList.add("open");
    return;
  }
  els.detail.classList.remove("open");
  els.appShell?.classList.add("detail-collapsed");
}

async function openFileInDetail({ title, subtitle, meta, filePath, emptyMessage }) {
  setDetailOpen(true);
  els.detailTitle.textContent = title;
  els.detailSubtitle.textContent = subtitle;
  els.detailMeta.innerHTML = renderMeta(meta);
  els.detailContent.textContent = "Loading file content...";

  if (!filePath) {
    els.detailContent.textContent = emptyMessage || "This item has no source file path.";
    return;
  }

  const staticFile = state.data?.staticFiles?.[filePath];
  if (staticFile && typeof staticFile.content === "string") {
    const suffix = staticFile.truncated ? "\n\n[File truncated for preview]" : "";
    els.detailContent.textContent = staticFile.content + suffix;
    return;
  }
  if (state.staticMode) {
    if (staticFile?.error) {
      els.detailContent.textContent = `Error: ${staticFile.error}`;
      return;
    }
    els.detailContent.textContent = "No exported file content for this card in static mode.";
    return;
  }

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "Failed to load file");
    const suffix = payload.truncated ? "\n\n[File truncated for preview]" : "";
    els.detailContent.textContent = payload.content + suffix;
  } catch (error) {
    els.detailContent.textContent = `Error: ${error.message}`;
  }
}

async function openCardDetails(cardId) {
  const card = findCard(cardId);
  if (!card) return;
  await openFileInDetail({
    title: card.title,
    subtitle: card.subtitle || "No description",
    meta: {
      source: card.source,
      filePath: card.filePath || "N/A",
      ...card.details,
    },
    filePath: card.filePath || null,
    emptyMessage: "This card has no source file path.",
  });
}

async function openAgentDetails(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return;
  await openFileInDetail({
    title: `${agent.emoji || "•"} ${agent.name}`,
    subtitle: "Agent profile and runtime context",
    meta: {
      agentId: agent.id,
      model: agent.model,
      workspace: agent.workspace,
      insightDate: agent.insightDate || "N/A",
      insightSourcePath: agent.insightSourcePath || "N/A",
      filePath: agent.detailPath || "N/A",
    },
    filePath: agent.detailPath || null,
    emptyMessage: "This agent has no detail file.",
  });
}

function bindInteractions() {
  els.navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view || "overview";
      setActiveView(view, btn);
      const scrollTarget = btn.dataset.scroll;
      if (view === "overview" && scrollTarget) {
        document.getElementById(scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  [...document.querySelectorAll(".tab-btn")].forEach((btn) => {
    btn.addEventListener("click", () => {
      [...document.querySelectorAll(".tab-btn")].forEach((it) => it.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      renderCatalog();
    });
  });

  [...document.querySelectorAll(".range-btn")].forEach((btn) => {
    btn.addEventListener("click", () => {
      [...document.querySelectorAll(".range-btn")].forEach((it) => it.classList.remove("active"));
      btn.classList.add("active");
      state.activeRange = btn.dataset.range;
      state.filters.bucket = null;
      state.filters.bucketIndex = null;
      renderRangeContext();
      renderMetrics();
      drawTrend();
      renderTrendHours();
      drawDonut();
      renderSessions();
    });
  });

  els.search.addEventListener("input", () => {
    state.search = els.search.value;
    renderAgents();
    renderCatalog();
    const rows = renderSessions90Days();
    if (isSessionsViewVisible()) renderWordCloud(rows);
  });

  els.clearSessionsFilter.addEventListener("click", () => {
    state.filters.model = null;
    state.filters.bucket = null;
    state.filters.bucketIndex = null;
    drawTrend();
    drawDonut();
    renderSessions();
  });

  els.closeDetail.addEventListener("click", () => setDetailOpen(false));
  els.refreshBtn?.addEventListener("click", () => {
    refreshDashboard({ manual: true });
  });
}

function renderAll() {
  renderRangeContext();
  renderMetrics();
  renderAgents();
  renderCatalog();
  renderSessions();
  renderSessions90Days();
  drawTrend();
  renderTrendHours();
  drawDonut();
  setActiveView(state.activeView);
  const generatedTs = Date.parse(state.data?.meta?.generatedAt || "");
  const exportedTs = Date.parse(state.data?.meta?.staticExportedAt || "");
  if (state.staticMode) {
    const generatedLabel = Number.isFinite(generatedTs) ? formatDate(generatedTs) : "N/A";
    const exportedLabel = Number.isFinite(exportedTs) ? formatDate(exportedTs) : "N/A";
    els.generatedAt.textContent = `Snapshot generated: ${generatedLabel} | exported: ${exportedLabel}`;
  } else {
    els.generatedAt.textContent = `Last refresh: ${formatDate(generatedTs)}`;
  }
}

async function refreshDashboard(options = {}) {
  const { manual = false } = options;
  if (refreshInFlight) return;
  refreshInFlight = true;
  setRefreshBusy(true);
  try {
    let data = null;
    let staticMode = false;
    try {
      data = await fetchJsonWithTimeout("/api/dashboard", { cache: "no-store" }, 5000);
    } catch {
      data = await fetchJsonWithTimeout("./data/dashboard.static.json", { cache: "no-store" }, 7000);
      staticMode = true;
    }
    state.data = data;
    state.staticMode = staticMode;
    renderAll();
  } catch (error) {
    if (manual) {
      els.generatedAt.textContent = `Refresh failed: ${error.message}`;
    } else {
      console.error("Auto refresh failed:", error);
    }
  } finally {
    refreshInFlight = false;
    setRefreshBusy(false);
  }
}

async function init() {
  bindInteractions();
  await refreshDashboard();
  if (!state.data) {
    document.body.innerHTML = `<pre style="padding:16px;color:#b00020">Failed to load dashboard.</pre>`;
    return;
  }
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (!state.staticMode) {
    autoRefreshTimer = setInterval(() => {
      refreshDashboard();
    }, AUTO_REFRESH_MS);
  }
}

window.addEventListener("resize", () => {
  if (!state.data) return;
  if (!isSessionsViewVisible()) return;
  clearTimeout(cloudResizeTimer);
  cloudResizeTimer = setTimeout(() => {
    const rows90 = renderSessions90Days();
    renderWordCloud(rows90);
  }, 180);
});

init();
