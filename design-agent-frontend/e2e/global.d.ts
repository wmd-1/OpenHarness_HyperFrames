// 测试可观测性钩子：前端在运行时写入这些 window 字段（见 uiStore.showToast /
// useWebSocket / 各 e2e 探针），供 Playwright 断言时读取，避免与时序竞争。

export {};

declare global {
  interface Window {
    __toastLog?: Array<{ id: string; level: string; message: string }>;
    __wsCloseCodes?: number[];
    __pageshowEvents?: Array<{ persisted: boolean; url: string; t: number }>;
  }
}
