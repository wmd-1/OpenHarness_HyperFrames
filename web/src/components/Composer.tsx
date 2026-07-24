import { useState, type FormEvent } from "react";
import { useTasks } from "../store";
import {
  MAX_PROMPT_CHARS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
} from "../constants";
import { sanitizePrompt, validateFilename, validatePromptShape } from "../utils/sanitize";
import { ErrorBanner } from "./ErrorBanner";

/** Parse a raw "oh args" textarea into a clean array (newline/comma separated). */
function parseOhArgs(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function Composer() {
  const { createTask } = useTasks();
  const [prompt, setPrompt] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [filename, setFilename] = useState("");
  const [ohArgsRaw, setOhArgsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const onPromptChange = (value: string) => {
    setPrompt(sanitizePrompt(value));
    if (localError) setLocalError(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const shapeError = validatePromptShape(prompt);
    if (shapeError) {
      setLocalError(shapeError);
      return;
    }
    if (filename.trim()) {
      const v = validateFilename(filename);
      if (!v.ok) {
        setLocalError(v.error ?? "文件名不合法");
        return;
      }
    }

    const ohArgs = parseOhArgs(ohArgsRaw);
    const timeout =
      Number.isFinite(Number(timeoutSeconds)) && timeoutSeconds > 0
        ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(timeoutSeconds)))
        : 600;

    setSubmitting(true);
    try {
      await createTask(prompt, ohArgs, filename.trim() || undefined, timeout);
    } finally {
      setSubmitting(false);
    }
  };

  const promptLen = prompt.length;

  return (
    <form className="card composer" onSubmit={onSubmit}>
      {localError && <ErrorBanner error={localError} onDismiss={() => setLocalError(null)} />}

      <label htmlFor="prompt">提示词（prompt）</label>
      <textarea
        id="prompt"
        value={prompt}
        maxLength={MAX_PROMPT_CHARS}
        placeholder="描述你想生成的视频……"
        onChange={(e) => onPromptChange(e.target.value)}
      />
      <div className="char-count">
        {promptLen} / {MAX_PROMPT_CHARS}
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="timeout">超时（秒）</label>
          <input
            id="timeout"
            type="number"
            min={MIN_TIMEOUT_SECONDS}
            max={MAX_TIMEOUT_SECONDS}
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="filename">下载文件名（可选）</label>
          <input
            id="filename"
            type="text"
            placeholder="hyperframes.mp4"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="ohargs">附加参数（可选，换行或逗号分隔）</label>
        <textarea
          id="ohargs"
          rows={2}
          placeholder="--cfg schedule=uniform"
          value={ohArgsRaw}
          onChange={(e) => setOhArgsRaw(e.target.value)}
        />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" disabled={submitting}>
          {submitting ? "生成中…" : "生成视频"}
        </button>
      </div>
    </form>
  );
}
