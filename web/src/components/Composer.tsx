import { useState, type FormEvent } from "react";
import { useTasks } from "../store";

export function Composer() {
  const { create, busy, error, clearError } = useTasks();
  const [prompt, setPrompt] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [idempotencyKey, setIdempotencyKey] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void create({ prompt, timeoutSeconds, idempotencyKey });
  };

  return (
    <form className="card composer" onSubmit={onSubmit}>
      <label>Prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="描述你想生成的视频…"
      />
      <div className="row">
        <div className="field">
          <label>超时(秒)</label>
          <input
            type="number"
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>幂等键(可选)</label>
          <input
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
            placeholder="idempotency_key"
          />
        </div>
      </div>
      {error && (
        <div className="error" onClick={clearError} role="alert">
          ⚠ {error}
        </div>
      )}
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? "提交中…" : "生成视频"}
        </button>
      </div>
    </form>
  );
}
