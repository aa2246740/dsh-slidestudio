import { t } from "./i18n.js";

/** Live snapshots originate only from DSH frames. This module adds no typing/reveal animation. */
export function createGenerationLiveBuffer(sessionId) {
  let epoch = "";
  let cursor = -1;
  const rows = new Map();
  function eventOf(row) {
    const kind = row.kind === "think" ? "thought" : row.kind;
    return {
      ...row,
      kind,
      type: `agent.${kind}`,
      label:
        row.label ||
        (kind === "reasoning" || kind === "thought" ? t("思考") : kind === "message" ? t("回复") : row.name || ""),
    };
  }
  return {
    accept(envelope) {
      if (envelope?.version !== 1 || envelope.sessionId !== sessionId || !Array.isArray(envelope.rows)) return false;
      if (typeof envelope.epoch !== "string" || !Number.isSafeInteger(envelope.cursor)) return false;
      if (epoch !== envelope.epoch) {
        rows.clear();
        epoch = envelope.epoch;
        cursor = -1;
      }
      if (envelope.cursor < cursor || (envelope.cursor === cursor && !envelope.snapshot)) return false;
      cursor = envelope.cursor;
      let changed = false;
      for (const row of envelope.rows) {
        if (!row?.id || !row.kind) continue;
        const next = eventOf(row);
        const prior = rows.get(row.id);
        if (row.detailMode === "append") next.detail = `${prior?.detail || ""}${row.detail || ""}`;
        // Current protocol emits replace snapshots; replaying a cursor never duplicates text.
        if (!prior || prior.detail !== next.detail || prior.status !== next.status || prior.kind !== next.kind)
          changed = true;
        rows.delete(row.id);
        rows.set(row.id, next);
      }
      while (rows.size > 256) rows.delete(rows.keys().next().value);
      return changed;
    },
    merge(activity = {}, { connected = true } = {}) {
      const base = Array.isArray(activity.events) ? activity.events : [];
      const events = base.slice();
      const positions = new Map(events.map((event, index) => [event.id, index]));
      for (const [id, live] of rows) {
        const index = positions.get(id);
        const persisted = index === undefined ? null : events[index];
        // A fallback read may settle a frame missed during disconnection. Never
        // guess ordering by string length, or replay completed text as a stream.
        if (!connected && persisted && persisted.status !== "running") {
          rows.set(id, persisted);
          continue;
        }
        if (index === undefined) {
          positions.set(id, events.length);
          events.push(live);
        } else events[index] = { ...persisted, ...live, at: persisted.at || live.at };
      }
      return { ...activity, sessionId: activity.sessionId || sessionId, events };
    },
    clear() {
      rows.clear();
      epoch = "";
      cursor = -1;
    },
  };
}
