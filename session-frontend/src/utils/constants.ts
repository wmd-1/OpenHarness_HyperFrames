// 全局常量：白名单参数、WS 关闭码映射、心跳/重连/渲染节流参数等。

/** 允许的 extra_oh_args 白名单（与后端 app/security.py::ALLOWED_OH_FLAGS 一致）。
 *  value 表示该 flag 是否消费后续一个值。 */
export const ALLOWED_OH_FLAGS: Record<string, boolean> = {
  '--temperature': true,
  '--max-turns': true,
  '--model': true,
  '--no-cache': false,
  '--verbose': false,
  '--effort': true,
};

/** flag -> [类型, 最大长度]（与后端 TYPED_FLAGS 一致）。 */
export const TYPED_FLAGS: Record<string, ['float' | 'int' | 'str', number]> = {
  '--temperature': ['float', 50],
  '--max-turns': ['int', 10],
  '--model': ['str', 256],
  '--effort': ['str', 16],
};

/** 禁止出现在参数值中的 shell 元字符（与后端 _SHELL_METACHARS 一致）。 */
export const SHELL_METACHARS = ';&|`$(){}[]<>#!~\n\r\t\\"\'';

/** WebSocket 关闭码 → 语义（与 app/routers/ws.py 一致）。 */
export const WS_CLOSE_CODES = {
  NORMAL: 1000,
  ABNORMAL: 1006,
  BAD_REQUEST: 4400,
  AUTH_FAILED: 4401,
  SESSION_CLOSED: 4403,
  SESSION_NOT_FOUND: 4404,
  RATE_LIMITED: 4429,
  /** 租户并发配额已满且无可让位会话（准入失败，不自动重连）。 */
  QUOTA_EXCEEDED: 4430,
  SERVER_ERROR: 4500,
  /** 节点容量已满（队满/排队超时，对应 REST 503）。 */
  CAPACITY_FULL: 4503,
} as const;

export const WS_CLOSE_MESSAGES: Record<number, string> = {
  [WS_CLOSE_CODES.BAD_REQUEST]: '无效的会话 ID',
  [WS_CLOSE_CODES.AUTH_FAILED]: 'API Key 无效，请重新认证',
  [WS_CLOSE_CODES.SESSION_CLOSED]: '会话已关闭',
  [WS_CLOSE_CODES.SESSION_NOT_FOUND]: '会话不存在',
  [WS_CLOSE_CODES.RATE_LIMITED]: '连接过于频繁，已被限流，稍后将自动重试',
  [WS_CLOSE_CODES.SERVER_ERROR]: '会话暂不可用（服务端错误）',
};

/** 准入失败 reason 常量 → 中文文案（error 帧 code / close reason，F3.0 契约优先）。 */
export const WS_ADMISSION_MESSAGES: Record<string, string> = {
  TENANT_QUOTA_EXCEEDED:
    '并发配额已满：另一会话正在执行任务或仍被其他窗口连接，请先等待或中断该会话',
  CAPACITY_FULL: '服务容量已满，将自动重试，请稍候',
  SESSION_UNAVAILABLE: '会话复活失败，可稍后重试或新建会话',
};

// ---- 心跳 / 重连 ----
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 连续 N 次 ping 无 pong 判定死连接。 */
export const HEARTBEAT_MAX_MISSED = 3;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_MAX_ATTEMPTS = 10;
/** 4429 限流后每次重试等待。 */
export const RATE_LIMIT_RETRY_DELAY_MS = 60_000;
/** 4429 限流最大有界重试次数，超限转 failed。 */
export const RATE_LIMIT_MAX_RETRIES = 2;
/** 4503 容量满重试间隔（对齐后端 OH_POOL_QUEUE_TIMEOUT，固定非指数）。 */
export const CAPACITY_RETRY_DELAY_MS = 15_000;
/** 4503 容量满最大有界重试次数，超限转 failed。 */
export const CAPACITY_MAX_RETRIES = 4;
/** 4500 会话不可用最大有界重试次数（覆盖 rehydrate 瞬态竞争），超限转 failed。 */
export const UNAVAILABLE_MAX_RETRIES = 2;
/** 唤醒等待超过该时长追加「仍在排队/冷启动中」提示（F3.4，纯前端计时）。 */
export const WAKEUP_SLOW_HINT_MS = 30_000;

// ---- 流式渲染批量 flush（design D6）----
export const STREAM_FLUSH_INTERVAL_MS = 50;
export const STREAM_FLUSH_CHAR_THRESHOLD = 384;

// ---- 健康轮询 ----
export const HEALTH_POLL_INTERVAL_MS = 30_000;
/** 连续失败 N 次视为服务异常。 */
export const HEALTH_FAIL_THRESHOLD = 3;

// ---- 审批超时（后端 300s 视为拒绝）----
export const APPROVAL_TIMEOUT_S = 300;
/** 剩余 50s 时开始倒计时警告。 */
export const APPROVAL_WARN_AT_S = 250;

// ---- 输入 ----
export const MAX_INPUT_LENGTH = 32_000;

// `/` 命令表已统一到 utils/slashCommands.ts（D3）

// ---- localStorage keys ----
export const STORAGE_KEYS = {
  apiKey: 'sf.apiKey',
  theme: 'sf.theme',
  /** 选中会话 ID 持久化（启动恢复选中，F1.7）。 */
  currentSessionId: 'sf.currentSessionId',
  mode: 'sf.mode',
} as const;

/** 已废弃的 localStorage 会话 ID 缓存 key（列表已服务端权威化），启动时清除。 */
export const LEGACY_SESSION_IDS_KEY = 'sf.sessionIds';
