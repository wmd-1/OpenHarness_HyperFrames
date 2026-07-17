import { useEffect, useState, type FormEvent } from "react";
import { API_KEY_STORAGE } from "../api";

export function ApiKeyInput() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      setValue(localStorage.getItem(API_KEY_STORAGE) ?? "");
    } catch {
      setValue("");
    }
  }, []);

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    const k = value.trim();
    try {
      if (k) localStorage.setItem(API_KEY_STORAGE, k);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch {
      /* storage unavailable */
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const onClear = () => {
    try {
      localStorage.removeItem(API_KEY_STORAGE);
    } catch {
      /* storage unavailable */
    }
    setValue("");
    setSaved(false);
  };

  return (
    <form className="card apikey" onSubmit={onSave}>
      <label>API Key（X-API-Key）</label>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="留空则不使用鉴权"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="row">
        <button type="submit">保存</button>
        <button type="button" onClick={onClear}>清除</button>
        {saved && <span className="hint">已保存</span>}
      </div>
      <p className="muted">
        {value.trim()
          ? "已设置：请求将携带 X-API-Key（SSE / 文件通过 api_key 参数）"
          : "未设置：部署端开启 API_KEY 后需在此填写"}
      </p>
    </form>
  );
}
