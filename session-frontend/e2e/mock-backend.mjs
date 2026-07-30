// E2E mock 后端（task 12.8）：模拟 session-service 的 REST + WS 协议。
// 仅供 Playwright E2E 使用；协议与 service/app/routers 对齐（简化版）。
//
// 行为约定：
// - 认证：X-API-Key 头必须等于 MOCK_API_KEY（默认 test-key）；
//   仅 artifact/workspace 文件 GET 与 WS 握手额外接受 ?api_key= 查询参数（对齐 A2）
// - POST /v1/sessions 创建 live 会话；GET 查询；DELETE 关闭
// - GET /v1/sessions 列表（limit/offset，created_at 倒序，summary 形状）
// - GET /v1/sessions/{sid}/turns 轮次历史（after_index 游标）
// - GET /v1/sessions/{sid}/workspace/files 列表（page_token/prefix）+ 单文件下载
// - GET /v1/sessions/{sid}/turns/{idx}/artifact 返回伪 mp4 字节
// - WS /v1/sessions/{sid}/ws：session_ready → submit 回显 "Echo: {text}"
// - submit 文本为 "make-video" 时 turn_complete 带 has_artifact: true
// - submit 文本为 "force-drop" 时直接掐断连接（测试断线重连）
// - POST /__mock/seed 预置会话（历史轮次/状态/ws_scenario 准入场景开关）
//   ws_scenario: 'quota_4430' → error 帧(code)+close 4430；'capacity_4503' → close 4503

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT ?? 8001);
const API_KEY = process.env.MOCK_API_KEY ?? 'test-key';

/** sid -> { session, turnIndex, turns, files, filesSource, filesStale, wsScenario, resumable, readOnly } */
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
  sessions.set(sid, {
    session,
    turnIndex: -1,
    turns: [],
    files: [],
    filesSource: null,
    filesStale: false,
    wsScenario: null,
    resumable: null,
    readOnly: null,
    titleOverride: null,
  });
  return session;
};

/** summary 形状（§2.6）：title 取首轮 prompt 截断；resumable/read_only 可被 seed 覆盖。 */
const toSummary = (entry) => {
  const s = entry.session;
  const defaultResumable = s.status === 'live' || s.status === 'cold';
  const defaultReadOnly = s.status === 'closed' || s.status === 'expired';
  return {
    session_id: s.session_id,
    status: s.status,
    title: entry.titleOverride ?? (entry.turns.length ? entry.turns[0].prompt.slice(0, 80) : null),
    turn_count: s.turn_count,
    resumable: entry.resumable ?? defaultResumable,
    read_only: entry.readOnly ?? defaultReadOnly,
    created_at: s.created_at,
    last_active_at: s.last_active_at,
  };
};

/** 记一轮完成的轮次（submit 与 seed 共用）。 */
const pushTurn = (entry, prompt, assistantText, hasArtifact) => {
  entry.turnIndex += 1;
  const turnIndex = entry.turnIndex;
  entry.turns.push({
    turn_id: `turn-${entry.session.session_id}-${turnIndex}`,
    turn_index: turnIndex,
    status: 'completed',
    prompt,
    assistant_text: assistantText,
    error_message: null,
    has_artifact: hasArtifact,
    started_at: nowIso(),
    finished_at: nowIso(),
  });
  entry.session.turn_count = turnIndex + 1;
  entry.session.last_active_at = nowIso();
  return turnIndex;
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

  // ---- 认证：仅 artifact / workspace 文件 GET 额外接受 ?api_key= 查询参数（对齐后端 A2） ----
  const isArtifactGet =
    req.method === 'GET' && /^\/v1\/sessions\/[^/]+\/turns\/\d+\/artifact$/.test(path);
  const isWorkspaceFileGet =
    req.method === 'GET' && /^\/v1\/sessions\/[^/]+\/workspace\/files\/.+/.test(path);
  const headerOk = req.headers['x-api-key'] === API_KEY;
  const queryOk =
    (isArtifactGet || isWorkspaceFileGet) && url.searchParams.get('api_key') === API_KEY;
  if (!headerOk && !queryOk) {
    sendJson(res, 401, { detail: 'invalid api key' });
    return;
  }

  // ---- 产物下载：返回伪 mp4 字节（足够驱动 <video>/<a download>） ----
  if (isArtifactGet) {
    const data = Buffer.concat([
      Buffer.from('\x00\x00\x00\x18ftypmp42', 'binary'),
      Buffer.alloc(1024),
    ]);
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': data.length,
      'accept-ranges': 'bytes',
    });
    res.end(data);
    return;
  }

  if (req.method === 'POST' && path === '/v1/sessions') {
    const body = await readBody(req);
    sendJson(res, 201, makeSession(body.permission_policy));
    return;
  }

  // ---- 会话列表（§2.6）：limit/offset，created_at 倒序 ----
  if (req.method === 'GET' && path === '/v1/sessions') {
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const all = [...sessions.values()].sort((a, b) =>
      b.session.created_at.localeCompare(a.session.created_at) ||
      b.session.session_id.localeCompare(a.session.session_id),
    );
    sendJson(res, 200, {
      items: all.slice(offset, offset + limit).map(toSummary),
      total: all.length,
      limit,
      offset,
    });
    return;
  }

  // ---- 轮次历史（§2.7）：after_index 游标，升序 ----
  const turnsMatch = path.match(/^\/v1\/sessions\/([^/]+)\/turns$/);
  if (turnsMatch && req.method === 'GET') {
    const entry = sessions.get(turnsMatch[1]);
    if (!entry) {
      sendJson(res, 404, { detail: 'session not found' });
      return;
    }
    const afterIndex = Number(url.searchParams.get('after_index') ?? -1);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const items = entry.turns.filter((t) => t.turn_index > afterIndex).slice(0, limit);
    sendJson(res, 200, { items, total: entry.turns.length });
    return;
  }

  // ---- 工作区文件列表（§2.8）：page_token 游标 + prefix 过滤 ----
  const filesListMatch = path.match(/^\/v1\/sessions\/([^/]+)\/workspace\/files$/);
  if (filesListMatch && req.method === 'GET') {
    const entry = sessions.get(filesListMatch[1]);
    if (!entry) {
      sendJson(res, 404, { detail: 'session not found' });
      return;
    }
    const rawToken = url.searchParams.get('page_token');
    let start = 0;
    if (rawToken) {
      start = Number(rawToken);
      if (!Number.isInteger(start) || start < 0) {
        sendJson(res, 400, { detail: 'invalid page_token' });
        return;
      }
    }
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const prefix = url.searchParams.get('prefix') ?? '';
    const filtered = entry.files.filter((f) => f.path.startsWith(prefix));
    const page = filtered.slice(start, start + limit);
    const nextStart = start + page.length;
    const source = entry.filesSource ?? (entry.files.length ? 'live' : 'none');
    sendJson(res, 200, {
      source,
      stale: entry.filesStale,
      sync_seq: source === 'none' ? null : entry.session.turn_count,
      last_synced_at: source === 'none' ? null : entry.session.last_active_at,
      total: filtered.length,
      files: page,
      next_page_token: nextStart < filtered.length ? String(nextStart) : null,
    });
    return;
  }

  // ---- 工作区单文件下载（F5.4，?api_key= 直链） ----
  const fileGetMatch = path.match(/^\/v1\/sessions\/([^/]+)\/workspace\/files\/(.+)$/);
  if (fileGetMatch && req.method === 'GET') {
    const entry = sessions.get(fileGetMatch[1]);
    const filePath = decodeURIComponent(fileGetMatch[2]);
    const file = entry?.files.find((f) => f.path === filePath);
    if (!file) {
      sendJson(res, 404, { detail: 'file not found' });
      return;
    }
    const data = Buffer.alloc(Math.min(file.size, 1024), 1);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': data.length,
      'content-disposition': `attachment; filename="${encodeURIComponent(filePath.split('/').pop())}"`,
    });
    res.end(data);
    return;
  }

  // ---- E2E 预置：注入历史会话（状态/轮次/文件/准入场景开关） ----
  if (req.method === 'POST' && path === '/__mock/seed') {
    const body = await readBody(req);
    const session = makeSession(body.permission_policy);
    const entry = sessions.get(session.session_id);
    session.status = body.status ?? 'live';
    if (body.title) entry.titleOverride = body.title;
    if (body.resumable !== undefined) entry.resumable = body.resumable;
    if (body.read_only !== undefined) entry.readOnly = body.read_only;
    entry.wsScenario = body.ws_scenario ?? null;
    const turnCount = Number(body.turn_count ?? 0);
    for (let i = 0; i < turnCount; i += 1) {
      pushTurn(entry, `历史消息 ${i + 1}`, `历史回答 ${i + 1}`, false);
    }
    if (Array.isArray(body.files)) {
      entry.files = body.files.map((f) => ({
        path: f.path,
        size: f.size ?? 1024,
        mtime: f.mtime ?? nowIso(),
        etag: f.etag ?? null,
      }));
    }
    if (body.files_source) entry.filesSource = body.files_source;
    entry.filesStale = Boolean(body.files_stale);
    sendJson(res, 201, toSummary(entry));
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

    // ---- 准入失败场景开关（F3）：error 帧(code) + 差异化 close 码 ----
    if (entry.wsScenario === 'quota_4430') {
      send({ type: 'error', code: 'TENANT_QUOTA_EXCEEDED', message: 'tenant quota exceeded' });
      ws.close(4430, 'TENANT_QUOTA_EXCEEDED');
      return;
    }
    if (entry.wsScenario === 'capacity_4503') {
      send({ type: 'error', code: 'CAPACITY_FULL', message: 'capacity full' });
      ws.close(4503, 'CAPACITY_FULL');
      return;
    }

    // 冷/失败会话唤醒：单容器模型下其他 live 会话让位变 cold（F3.5 让位可视化）
    if (entry.session.status !== 'live') {
      for (const other of sessions.values()) {
        if (other !== entry && other.session.status === 'live') {
          other.session.status = 'cold';
        }
      }
      entry.session.status = 'live';
    }

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
          // 产物场景触发器：turn_complete 带 has_artifact: true（A1）
          const hasArtifact = frame.text === 'make-video';
          const reply = `Echo: ${frame.text}`;
          const turnIndex = pushTurn(entry, frame.text, reply, hasArtifact);
          if (hasArtifact) {
            entry.files.push({
              path: `output/turn-${turnIndex}.mp4`,
              size: 2048,
              mtime: nowIso(),
              etag: null,
            });
          }
          // 两段 delta 模拟流式输出；final 帧按新契约发 envelope（text 空 + full_text 全文，P0-1）
          send({ type: 'delta', text: reply.slice(0, 5), turn_index: turnIndex });
          setTimeout(() => {
            send({ type: 'delta', text: reply.slice(5), turn_index: turnIndex });
            send({ type: 'delta', text: '', turn_index: turnIndex, final: true, full_text: reply });
            send({
              type: 'turn_complete',
              turn_index: turnIndex,
              interrupted: false,
              has_artifact: hasArtifact,
            });
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
