// 产物下载按钮（task 8.9）：带认证头 fetch → blob 落地
//（downloadArtifact 内部处理 S3 302 重定向：fetch 自动跟随）。

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadArtifact } from '../../api/sessions';
import { extractErrorDetail } from '../../api/client';
import { useUiStore } from '../../store/uiStore';

export function DownloadButton({
  sid,
  turnIndex,
  filename,
}: {
  sid: string;
  turnIndex: number;
  filename?: string;
}) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadArtifact(sid, turnIndex, filename);
    } catch (err) {
      useUiStore
        .getState()
        .showBanner('error', (await extractErrorDetail(err)) ?? '产物下载失败');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleDownload()}
      disabled={downloading}
      className="text-muted hover:text-fg hover:bg-surface flex items-center gap-1.5 rounded px-2 py-1 text-xs disabled:opacity-50"
    >
      {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
      下载产物
    </button>
  );
}
