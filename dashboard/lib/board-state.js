// bot-relay-mcp Kanban board (Vercel) — freshness/health state machine.
// SPDX-License-Identifier: MIT
//
// The board always renders the LAST GOOD snapshot (never an empty grid), but the
// BANNER above it must distinguish four situations that otherwise look identical:
//   waiting  — no valid snapshot has ever arrived (pipe not wired yet)
//   ok       — a fresh snapshot (within the stale window)
//   stale    — no snapshot recently, and no rejection → the push pipe is down / relay idle
//   rejected — the most recent push was REJECTED (bad/missing signature) → active misconfig
// "rejected" outranks "stale" because a rejection silently FREEZES the board at the
// last good snapshot — the exact failure the last-good design exists to make visible.

export const STALE_MS_DEFAULT = 90_000; // 3 missed ~30s push ticks

export function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * @param {object} args
 * @param {{received_at: string, snapshot: object}|null} args.latest  last VALID push
 * @param {{at: string, reason: string}|null} args.lastRejection  last rejected push (if any)
 * @param {number} args.nowMs
 * @param {number} [args.staleMs]
 * @returns {{level: "waiting"|"ok"|"stale"|"rejected", title: string, detail: string, ageMs?: number}}
 */
export function computeBanner({ latest, lastRejection, nowMs, staleMs = STALE_MS_DEFAULT }) {
  if (!latest || !latest.received_at) {
    return {
      level: "waiting",
      title: "Waiting for the first snapshot from the relay",
      detail:
        "No valid push has arrived yet. This means 'not wired', not 'nothing happening' — " +
        "confirm the relay has dashboard_push_url + dashboard_push_secret set and is running.",
    };
  }
  const receivedMs = Date.parse(latest.received_at);
  const ageMs = Math.max(0, nowMs - receivedMs);
  const rejectedAtMs = lastRejection && lastRejection.at ? Date.parse(lastRejection.at) : NaN;

  // Misconfig: a rejection NEWER than the last good push. Loudest — the board is frozen and lying by omission.
  if (Number.isFinite(rejectedAtMs) && rejectedAtMs > receivedMs) {
    return {
      level: "rejected",
      title: "A push was REJECTED — the board below is frozen/stale",
      detail:
        `The most recent push was rejected (${lastRejection.reason}) at ${lastRejection.at}. ` +
        `The board shows the last VALID snapshot from ${latest.received_at}. ` +
        "A rejected push is NOT an idle fleet — check that the relay's dashboard_push_secret " +
        "matches this receiver's DASHBOARD_PUSH_SECRET.",
      ageMs,
    };
  }

  // Pipe down / relay idle: no recent push, but nothing was rejected either.
  if (ageMs > staleMs) {
    return {
      level: "stale",
      title: `Last update ${fmtAge(ageMs)} ago — the push pipe may be down`,
      detail:
        `Snapshots are expected every ~30s; the last valid one arrived ${fmtAge(ageMs)} ago ` +
        `(${latest.received_at}). Showing the last good snapshot. If the relay is up, check the ` +
        "URL/network/SSRF-validation on its side.",
      ageMs,
    };
  }

  return { level: "ok", title: `Updated ${fmtAge(ageMs)} ago`, detail: "", ageMs };
}
