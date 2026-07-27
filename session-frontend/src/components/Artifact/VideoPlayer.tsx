// 视频预览播放器（task 8.8）：走 ?mode=stream 服务端流式（支持 Range），
// 避免 S3 302 重定向的 CORS 问题。

import { artifactStreamUrl } from '../../api/sessions';
import { DownloadButton } from './DownloadButton';

export function VideoPlayer({ sid, turnIndex }: { sid: string; turnIndex: number }) {
  return (
    <div className="border-line bg-raised mt-2 overflow-hidden rounded-lg border">
      {/* 认证走 nginx/vite 同源代理注入的 cookie 不可用，视频 src 无法带自定义头；
          后端 stream 模式支持 api_key 查询参数时可拼接，这里依赖同源代理转发 */}
      <video
        controls
        preload="metadata"
        className="max-h-80 w-full bg-black"
        src={artifactStreamUrl(sid, turnIndex)}
      >
        <track kind="captions" />
      </video>
      <div className="flex items-center justify-end px-2 py-1.5">
        <DownloadButton sid={sid} turnIndex={turnIndex} />
      </div>
    </div>
  );
}
