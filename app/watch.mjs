export const SWEEP_EVERY_MS = 60000;

export const RUN_CLAIM_STALE_MS = 300000;

export const STANDING_STALE_MS = 900000;

export const STOP_AGE_BANDS_MS = Object.freeze({
  "no-run": STANDING_STALE_MS,
  "no-read-boundary": STANDING_STALE_MS,
  "waiting-on-another-card": STANDING_STALE_MS,
  "waiting-on-owner": STANDING_STALE_MS,
  "failed": STANDING_STALE_MS,
});

export const REASONS = Object.freeze({
  "no-run": "no run",
  "no-read-boundary": "no read boundary",
  "waiting-on-another-card": "waiting on another card",
  "waiting-on-owner": "waiting on the owner",
  "failed": "failed",
});

export const RUN_CLAIM_BASIS =
  "stale after 5 minutes without a move — the runner kills a silent run at 3 minutes, so a card " +
  "still saying agent working a full 2 minutes after that kill is already wrong on the face";

export const STANDING_BASIS =
  "stale after 15 minutes without a move — the worker offers every ready card every 30 seconds, " +
  "so a card not picked up within 15 minutes is not waiting for a turn, something is holding it";

export const UNKNOWN_CLOCK = Symbol("unknown-clock");
export const UNKNOWN = "unknown";

function isoMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  return null;
}

export function progressAt(card) {
  if (!card || typeof card !== "object") return UNKNOWN;
  if (Array.isArray(card.activity) && card.activity.length) {
    for (let i = card.activity.length - 1; i >= 0; i--) {
      const a = card.activity[i];
      const text = String((a && a.text) || '');
      if (text.startsWith("the Queen's check:")) continue;
      const ms = isoMs(a && a.at);
      if (ms != null) return ms;
    }
  }
  if (Array.isArray(card.moves) && card.moves.length) {
    const ms = isoMs(card.moves[card.moves.length - 1]?.at);
    if (ms != null) return ms;
  }
  const lp = isoMs(card.lastProgressAt);
  if (lp != null) return lp;
  const ca = isoMs(card.calledAt);
  if (ca != null) return ca;
  const cr = isoMs(card.createdAt);
  if (cr != null) return cr;
  return UNKNOWN;
}

export function isRunClaiming(card) {
  if (!card || typeof card !== "object") return false;
  if (card.running === true) return true;
  if (card.hand) return true;
  const items = card.items || card.artefacts;
  if (Array.isArray(items)) {
    return items.some((it) => it && (it.running === true || it.hand || it.run === true || it.runMark === true));
  }
  return false;
}

export function isParked(card) {
  if (!card || typeof card !== "object") return false;
  return card.parkedAt != null || card.parked === true;
}

export function isTerminal(card) {
  if (!card || typeof card !== "object") return true;
  if (card.stage === "done" || card.stage === "archive") return true;
  return !!(card.archivedAt || card.binnedAt || card.completedAt);
}

function minuteOf(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "0m";
  if (ageMs < 3600000) return Math.floor(ageMs / 60000) + "m";
  if (ageMs < 86400000) return (ageMs / 3600000).toFixed(1) + "h";
  return (ageMs / 86400000).toFixed(1) + "d";
}

function ageBandMs(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const MIN = 15 * 60 * 1000;
  if (ageMs < MIN) return MIN;
  if (ageMs < 60 * 60 * 1000) return Math.floor(ageMs / (30 * 60 * 1000)) * (30 * 60 * 1000);
  if (ageMs < 24 * 60 * 60 * 1000) return Math.floor(ageMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
  return Math.floor(ageMs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
}

export function makeStopRecord(now, lastMoved, kind) {
  const ageMs = now - lastMoved;
  const isRunClaim = kind === "run-claim";
  return {
    observedAt: now,
    since: formatAge(ageMs),
    ageMs,
    lastMovedAt: lastMoved,
    lastMovedMinute: minuteOf(lastMoved),
    blocking: null,
    reasons: [],
    basis: isRunClaim ? RUN_CLAIM_BASIS : STANDING_BASIS,
    kind: isRunClaim ? "run-claim" : "standing",
    thresholdMs: isRunClaim ? RUN_CLAIM_STALE_MS : STANDING_STALE_MS,
  };
}

export function detectStop(card, now = Date.now()) {
  if (!card || typeof card !== "object") return null;
  if (isParked(card) || isTerminal(card)) return null;
  const lastMoved = progressAt(card);
  if (lastMoved === UNKNOWN) return UNKNOWN_CLOCK;
  const kind = isRunClaiming(card) ? "run-claim" : "standing";
  const thresholdMs = kind === "run-claim" ? RUN_CLAIM_STALE_MS : STANDING_STALE_MS;
  const ageMs = now - lastMoved;
  if (ageMs < thresholdMs) return null;
  return makeStopRecord(now, lastMoved, kind);
}

export function stopSignature(stop) {
  if (!stop || typeof stop !== "object") return null;
  const reasons = Array.isArray(stop.reasons) ? stop.reasons : [];
  return [
    stop.blocking ?? "",
    reasons.join(","),
    stop.kind ?? "",
    stop.lastMovedMinute ?? "",
    ageBandMs(stop.ageMs) ?? "",
  ].join("|");
}

export function buildPass(cards, now = Date.now(), ctx = {}) {
  const list = Array.isArray(cards) ? cards : Object.values(cards || {});
  const decisions = [];
  for (const card of list) {
    if (!card || typeof card !== "object") continue;
    const cardId = card.key || card.id || null;
    const r = detectStop(card, now);
    if (r === UNKNOWN_CLOCK) {
      decisions.push({
        cardId, card, stopped: false, unknownClock: true,
        stop: null, signature: null, prevSig: card.stopSig ?? null, wouldWrite: false,
      });
      continue;
    }
    if (!r) {
      decisions.push({
        cardId, card, stopped: false, unknownClock: false,
        stop: null, signature: null, prevSig: card.stopSig ?? null, wouldWrite: false,
      });
      continue;
    }
    const stop = r;
    if (typeof ctx.stopReasons === "function") {
      const filled = ctx.stopReasons(card, ctx, stop);
      if (filled && typeof filled === "object") {
        stop.blocking = filled.blocking ?? stop.blocking;
        stop.reasons = Array.isArray(filled.reasons) ? filled.reasons : stop.reasons;
        if (filled.basis != null) stop.basis = filled.basis;
      }
    }
    const signature = stopSignature(stop);
    const prevSig = card.stopSig ?? null;
    decisions.push({
      cardId, card, stopped: true, unknownClock: false,
      stop, signature, prevSig, wouldWrite: signature !== prevSig,
    });
  }
  return decisions;
}

function localReasons(card) {
  const reasons = [];
  if (card.failedAt) reasons.push("failed");
  if (!card.boundary) reasons.push("no-read-boundary");
  if (Array.isArray(card.waitsOn) && card.waitsOn.length) reasons.push("waiting-on-another-card");
  if (
    (card.stage === "approved" && !card.approvedAt) ||
    (card.stage === "done" && !card.archivedAt && !card.completedAt)
  ) {
    reasons.push("waiting-on-owner");
  }
  if (reasons.length === 0) reasons.push("no-run");
  return reasons;
}

function localStopReasons(card, _ctx, _stop) {
  const reasons = localReasons(card);
  return { blocking: reasons[0], reasons };
}

const DEFAULT_BOARD_URL = "http://127.0.0.1:3470";

async function dryRun() {
  const base = process.env.BOARD_URL || DEFAULT_BOARD_URL;
  const url = base.replace(/\/+$/, "") + "/api/board";
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(`dry-run: could not reach the board at ${url}: ${e.message}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`dry-run: board answered ${res.status} at ${url}`);
    process.exit(1);
  }
  const data = await res.json();
  const cards = Array.isArray(data) ? data : (data.cards || []);
  const now = Date.now();
  const decisions = buildPass(cards, now, { stopReasons: localStopReasons });
  const stopped = decisions.filter((d) => d.stopped);
  const unknown = decisions.filter((d) => d.unknownClock);
  console.log(`# sweep dry-run ${new Date(now).toISOString()} — ${cards.length} cards scanned, ${stopped.length} stopped, ${unknown.length} unreadable-clock, 0 written`);
  for (const d of stopped) {
    const s = d.stop;
    const labels = s.reasons.map((k) => REASONS[k] || k).join(", ");
    console.log(
      `${d.cardId}\t${s.kind}\tage=${s.since}\tlast-moved=${s.lastMovedMinute} UTC\t` +
      `threshold=${s.thresholdMs} ms\treasons≈[${labels}]\tbasis="${s.basis}"`
    );
  }
}

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes("--dry-run")) {
  dryRun().catch((e) => {
    console.error("dry-run failed:", e.message);
    process.exit(1);
  });
}
