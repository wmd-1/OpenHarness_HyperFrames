// Drawio 设计后端 API 占位（spec design-agent-demo-modules §后端接口预留）。
// TODO(后端就绪时)：
//   1. 按 session-service 同款契约实现以下函数（参考 src/api/sessions.ts）；
//   2. 在 platform/registry.tsx 将 drawio-diagram 的 providers 从 DemoAdapter
//      替换为真实 adapter（页面组件零改动）；
//   3. maturity 由 'demo' 调整为 'ga'，「演示数据」角标自动消失。

const NOT_IMPLEMENTED = 'drawio-diagram 后端未接入（当前为演示数据，见 platform/demoAdapter.ts）';

export function listSessions(): Promise<never> {
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

export function createSession(_prompt: string): Promise<never> {
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

export function sendMessage(_sessionId: string, _text: string): Promise<never> {
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

/** 图表产物获取（真实实现应返回 SVG/drawio XML 产物地址）。 */
export function getDiagram(_sessionId: string): Promise<never> {
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}
