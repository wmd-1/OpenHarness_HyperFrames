import { useTasks } from "../store";
import { StatusBadge } from "./StatusBadge";

export function TaskList() {
  const { order, tasks, activeId, select } = useTasks();

  if (order.length === 0) {
    return <div className="card empty">暂无任务，提交一个 prompt 开始。</div>;
  }

  return (
    <ul className="tasklist">
      {order.map((id) => {
        const t = tasks[id];
        if (!t) return null;
        const active = id === activeId;
        return (
          <li
            key={id}
            className={"taskitem" + (active ? " active" : "")}
            onClick={() => select(id)}
            data-testid={"task-item-" + id}
          >
            <div className="taskitem-id">{id.slice(0, 8)}</div>
            <StatusBadge status={t.status} />
            {t.created_at && (
              <div className="taskitem-time">
                {new Date(t.created_at).toLocaleString()}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
