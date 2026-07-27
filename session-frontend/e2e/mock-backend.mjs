// E2E mock 后端（task 12.8）：模拟 session-service 的 REST + WS 协议。
// 仅供 Playwright E2E 使用；协议与 service/app/routers 对齐（简化版）。
//
// 行为约定：
// - 认证：X-API-Key / api_key 查询参数必须等于 MOCK_API_KEY（默认 test-key）
// - POST /v1/sessions 创建 live 会话；GET 查询；DELETE 关闭
// - WS /v1/sessions/{sid}/ws：session_ready → submit 回显 "Echo: {text}"
// - submit 文本为 "force-drop" 时直接掐断连接（测试断线重连）

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT ?? 8001);
const API_KEY = process.env.MOCK_API_KEY ?? 'test-key';

/** sid -> { session, turnIndex } */
const sessions = new Map();
let seq = 0;

const nowIso = () => new Date().toISOString();

const makeSession = (policy) => {
  seq += 1;
  const sid = `mock-${seq.toString().padStart(4, '0')}`;
  const session = {
    session_id: sid,
    status: 'live',
    permission_policy: policy ?? 'full_auto',
    turn_count: 0,
    oh_session_id: null,
    created_at: nowIso(),
    last_active_at: nowIso(),
    ws_url: `/v1/sessions/${sid}/ws`,
  };
  sessions.set(sid, { session, turnIndex: -1 });
  return session;
};

const sendJson = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/healthz' || path === '/readyz') {
    sendJson(res, 200, { status: 'ok', db: 'ok', redis: 'ok', live_sessions: sessions.size, capacity: 10 });
    return;
  }

  // ---- 认证 ----
  if (req.headers['x-api-key'] !== API_KEY) {
    sendJson(res, 401, { detail: 'invalid api key' });
    return;
  }

  if (req.method === 'POST' && path === '/v1/sessions') {
    const body = await readBody(req);
    sendJson(res, 201, makeSession(body.permission_policy));
    return;
  }

  const match = path.match(/^\/v1\/sessions\/([^/]+)$/);
  if (match) {
    const entry = sessions.get(match[1]);
    if (!entry) {
      sendJson(res, 404, { detail: 'session not found' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, entry.session);
      return;
    }
    if (req.method === 'DELETE') {
      entry.session.status = 'closed';
      sendJson(res, 200, { session_id: entry.session.session_id, status: 'closed', message: 'closed' });
      return;
    }
  }

  sendJson(res, 404, { detail: 'not found' });
});

// ---- WebSocket ----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/ws$/);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const sid = match[1];
    if (url.searchParams.get('api_key') !== API_KEY) {
      ws.close(4401, 'auth failed');
      return;
    }
    const entry = sessions.get(sid);
    if (!entry) {
      ws.close(4404, 'session not found');
      return;
    }
    if (entry.session.status === 'closed') {
      ws.close(4403, 'session closed');
      return;
    }

    const send = (frame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame));
    send({ type: 'session_ready', session_id: sid });

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (frame.op) {
        case 'ping':
          send({ type: 'pong' });
          break;
        case 'submit': {
          // 断线重连测试触发器：先结束轮次再掐断 TCP（客户端收到 1006）
          if (frame.text === 'force-drop') {
            entry.turnIndex += 1;
            send({ type: 'turn_complete', turn_index: entry.turnIndex, interrupted: false });
            setTimeout(() => ws.terminate(), 100);
            return;
          }
          entry.turnIndex += 1;
          const turnIndex = entry.turnIndex;
          entry.session.turn_count = turnIndex + 1;
          entry.session.last_active_at = nowIso();
          const reply = `Echo: ${frame.text}`;
          // 两段 delta 模拟流式输出
          send({ type: 'delta', text: reply.slice(0, 5), turn_index: turnIndex });
          setTimeout(() => {
            send({ type: 'delta', text: reply.slice(5), turn_index: turnIndex, final: true });
            send({ type: 'turn_complete', turn_index: turnIndex, interrupted: false });
          }, 50);
          break;
        }
        case 'interrupt':
          send({ type: 'turn_complete', turn_index: Math.max(0, entry.turnIndex), interrupted: true });
          break;
        case 'approval':
          // E2E 简化：审批一律放行并结束轮次
          send({ type: 'turn_complete', turn_index: Math.max(0, entry.turnIndex), interrupted: false });
          break;
        default:
          break;
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`[mock-backend] listening on :${PORT} (api key: ${API_KEY})`);
});
