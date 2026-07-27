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
  SERVER_ERROR: 4500,
} as const;

export const WS_CLOSE_MESSAGES: Record<number, string> = {
  [WS_CLOSE_CODES.BAD_REQUEST]: '无效的会话 ID',
  [WS_CLOSE_CODES.AUTH_FAILED]: 'API Key 无效，请重新认证',
  [WS_CLOSE_CODES.SESSION_CLOSED]: '会话已关闭',
  [WS_CLOSE_CODES.SESSION_NOT_FOUND]: '会话不存在',
  [WS_CLOSE_CODES.RATE_LIMITED]: '连接过于频繁，已被限流',
  [WS_CLOSE_CODES.SERVER_ERROR]: '会话暂不可用（服务端错误）',
};

// ---- 心跳 / 重连 ----
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 连续 N 次 ping 无 pong 判定死连接。 */
export const HEARTBEAT_MAX_MISSED = 3;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_MAX_ATTEMPTS = 10;
/** 4429 限流后单次重试等待。 */
export const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

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

/** `/` 命令补全候选。 */
export const SLASH_COMMANDS: readonly { command: string; description: string }[] = [
  { command: '/interrupt', description: '中断当前轮次' },
  { command: '/clear', description: '清空当前对话视图（仅本地）' },
  { command: '/theme', description: '打开主题选择器' },
  { command: '/terminal', description: '切换到 Terminal Mode' },
  { command: '/chat', description: '切换到 Chat Mode' },
  { command: '/close', description: '关闭当前会话' },
  { command: '/help', description: '显示可用命令' },
];

// ---- localStorage keys ----
export const STORAGE_KEYS = {
  apiKey: 'sf.apiKey',
  theme: 'sf.theme',
  sessionIds: 'sf.sessionIds',
  mode: 'sf.mode',
} as const;
