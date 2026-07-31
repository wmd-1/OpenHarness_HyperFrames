// 产物下载按钮（task 8.9）：<a download> 直链交由浏览器流式落盘
//（认证走 ?api_key= 查询参数，S3 302 重定向由浏览器跟随；A2/C1）。

import { Download } from 'lucide-react';
import { downloadArtifact } from '../../api/sessions';

export function DownloadButton({
  sid,
  turnIndex,
  filename,
}: {
  sid: string;
  turnIndex: number;
  filename?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => downloadArtifact(sid, turnIndex, filename)}
      className="text-muted hover:text-fg hover:bg-surface flex items-center gap-1.5 rounded px-2 py-1 text-xs"
    >
      <Download size={12} />
      下载产物
    </button>
  );
}
