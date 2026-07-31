#!/usr/bin/env node
// mock_qwenasr_server.mjs — 契约形状 mock（仅验收客户端/回退语义用，非真实模型）。
// 按端口区分模式：8092=ok（2 词）、8093=ok 但 words:null、8094=500 错误。
// 真实契约见 Qwen3-ASR-Script/README.md（POST /transcribe multipart → {ok,language,text,words,duration_s}）。
import http from "node:http";

const MODES = {
  8092: () => ({
    status: 200,
    body: {
      ok: true,
      language: "English",
      text: "hello world",
      words: [
        { text: "hello", start: 0.12, end: 0.48 },
        { text: "world", start: 0.55, end: 1.02 },
      ],
      duration_s: 1.2,
    },
  }),
  8093: () => ({
    status: 200,
    body: { ok: true, language: "English", text: "hello world", words: null, duration_s: 1.2 },
  }),
  8094: () => ({ status: 500, body: { ok: false, error: "boom" } }),
};

for (const [port, make] of Object.entries(MODES)) {
  http
    .createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, mock: true }));
        return;
      }
      // 吞掉 multipart body 再应答（客户端用原生 fetch FormData 上传完整音频）
      req.on("data", () => {});
      req.on("end", () => {
        const { status, body } = make();
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
    })
    .listen(Number(port), "127.0.0.1", () => console.log(`mock qwenasr :${port} up`));
}
