"use strict";

const DEFAULT_REQUIRED_FRESH_WRITERS = ["capture:codexlink", "capture:agent-runtime"];
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DEAD_MS = 24 * 60 * 60 * 1000;

const HEALTHY_STATUSES = new Set([
  "alive",
  "alive_no_new",
  "ok",
  "healthy",
  "success",
  "idle",
]);

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function parseList(value, fallback) {
  const raw = value == null || value === "" ? fallback : value;
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

function requiredFreshWriterSet(options = {}) {
  return new Set(parseList(
    options.requiredFreshWriters ||
      process.env.MNEMO_WRITER_HEALTH_REQUIRED ||
      process.env.MNEMO_HOOK_WATCHDOG_CRITICAL_WRITERS,
    DEFAULT_REQUIRED_FRESH_WRITERS
  ));
}

function writerStatusClass(status) {
  const s = normalizeStatus(status);
  if (!s) return "unknown";
  if (s === "stale") return "stale";
  if (s === "dead") return "dead";
  if (s.startsWith("disabled")) return "disabled";
  if (s.startsWith("error") || s.includes("database is locked") || s.includes("sqlite_corrupt")) return "error";
  if (s.startsWith("blocked")) return "blocked";
  if (s.startsWith("partial")) return "degraded";
  if (HEALTHY_STATUSES.has(s)) return "healthy";
  return "unknown";
}

function ageMs(iso, nowMs) {
  const t = iso ? Date.parse(iso) : 0;
  if (!t) return null;
  return Math.max(0, nowMs - t);
}

function freshnessFromAge(age, staleMs, deadMs, required) {
  if (age == null) return required ? "missing" : "not_required";
  if (age > deadMs) return required ? "critical" : "idle";
  if (age > staleMs) return required ? "stale" : "idle";
  return "fresh";
}

function assessWriterHealth(row = {}, options = {}) {
  const writer = String(row.writer || "");
  const status = normalizeStatus(row.status);
  const statusClass = writerStatusClass(status);
  const nowMs = options.nowMs || Date.now();
  const staleMs = Number(options.staleMs || DEFAULT_STALE_MS);
  const deadMs = Number(options.deadMs || DEFAULT_DEAD_MS);
  const lastWriteAgeMs = ageMs(row.last_write_at, nowMs);
  const lastCheckAgeMs = ageMs(row.last_check_at, nowMs);
  const freshnessRequired = requiredFreshWriterSet(options).has(writer);
  const freshness = freshnessFromAge(lastWriteAgeMs, staleMs, deadMs, freshnessRequired);

  let healthy = true;
  let reason = "writer is informational or event-driven";
  let nextStatus = status || "idle";
  let drift = false;
  let driftSeverity = "M";

  if (statusClass === "disabled") {
    reason = `writer disabled (${status})`;
    nextStatus = status;
  } else if (["error", "blocked", "degraded"].includes(statusClass)) {
    healthy = false;
    drift = true;
    driftSeverity = statusClass === "degraded" ? "M" : "H";
    reason = `writer status is ${status}`;
    nextStatus = status;
  } else if (freshnessRequired) {
    if (lastWriteAgeMs == null) {
      healthy = false;
      drift = true;
      driftSeverity = "H";
      reason = "required writer has never written";
      nextStatus = "missing";
    } else if (lastWriteAgeMs > deadMs) {
      healthy = false;
      drift = true;
      driftSeverity = "H";
      reason = "required writer has not written within dead threshold";
      nextStatus = "dead";
    } else if (lastWriteAgeMs > staleMs) {
      healthy = false;
      drift = true;
      driftSeverity = "M";
      reason = "required writer has not written within stale threshold";
      nextStatus = "stale";
    } else {
      reason = "required writer is fresh";
      nextStatus = "alive";
    }
  } else if (lastWriteAgeMs != null && lastWriteAgeMs <= staleMs && statusClass !== "unknown") {
    reason = "writer wrote recently";
    nextStatus = HEALTHY_STATUSES.has(status) ? status : "alive";
  } else {
    reason = "writer is not freshness-gated";
    nextStatus = statusClass === "stale" || statusClass === "dead" || !status ? "idle" : status;
  }

  return {
    writer,
    status,
    status_class: statusClass,
    freshness_required: freshnessRequired,
    freshness,
    healthy,
    drift,
    drift_severity: driftSeverity,
    health_reason: reason,
    next_status: nextStatus,
    last_write_age_ms: lastWriteAgeMs,
    last_write_age_min: lastWriteAgeMs == null ? null : Math.round(lastWriteAgeMs / 60000),
    last_check_age_ms: lastCheckAgeMs,
    last_check_age_min: lastCheckAgeMs == null ? null : Math.round(lastCheckAgeMs / 60000),
  };
}

function enrichWriterHealth(row, options = {}) {
  return Object.assign({}, row, assessWriterHealth(row, options));
}

function enrichWriterHealthRows(rows, options = {}) {
  return (rows || []).map((row) => enrichWriterHealth(row, options));
}

module.exports = {
  DEFAULT_REQUIRED_FRESH_WRITERS,
  assessWriterHealth,
  enrichWriterHealth,
  enrichWriterHealthRows,
  requiredFreshWriterSet,
  writerStatusClass,
};
