import { type TaskStatus } from "../api";
import { EscapeHtml } from "./EscapeHtml";

// Only these values drive the badge styling; anything else renders as "unknown"
// with neutral styling (never an attacker-controlled string).
const KNOWN: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export function StatusBadge({ status }: { status: TaskStatus }) {
  const safe = KNOWN.has(status) ? status : "unknown";
  return (
    <span className={`status ${safe}`}>
      <EscapeHtml text={safe} />
    </span>
  );
}
