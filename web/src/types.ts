export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface TaskLinks {
  self: string;
  file: string;
  events: string;
}

export interface VideoCreateResponse {
  task_id: string;
  status: TaskStatus;
  links: TaskLinks;
}

export interface VideoTaskResponse {
  task_id: string;
  status: TaskStatus;
  prompt?: string;
  created_at?: string;
  updated_at?: string;
  error?: string;
  links: TaskLinks;
}

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}
