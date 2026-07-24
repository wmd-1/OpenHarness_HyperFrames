import { type Task } from "../store";
import { StatusBadge } from "./StatusBadge";
import { EscapeHtml } from "./EscapeHtml";

interface TaskListProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, selectedId, onSelect }: TaskListProps) {
  if (!tasks.length) {
    return <p className="empty">还没有任务。提交一个 prompt 开始吧。</p>;
  }
  return (
    <ul className="tasklist">
      {tasks.map((task) => (
        <li
          key={task.id}
          className={`taskitem ${task.id === selectedId ? "active" : ""}`}
          onClick={() => onSelect(task.id)}
        >
          <StatusBadge status={task.status} />
          <EscapeHtml as="code" className="taskitem-id" text={task.id} />
          {task.createdAt && (
            <EscapeHtml as="span" className="taskitem-time" text={task.createdAt} />
          )}
        </li>
      ))}
    </ul>
  );
}
