import type { TaskStatus } from "../types";

const LABEL: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={"status " + status} data-testid={"status-" + status}>
      {LABEL[status] ?? status}
    </span>
  );
}
