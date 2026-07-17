import { useTasks } from "../store";

export function HealthBadge() {
  const { health } = useTasks();
  const ok = health === "ok";
  return (
    <span className={"health " + (ok ? "ok" : "bad")}>API: {health}</span>
  );
}
