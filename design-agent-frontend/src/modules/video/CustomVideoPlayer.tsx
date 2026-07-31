// 自定义视频播放器（spec design-agent-video：demo 全套控制条）。
// 进度（含缓冲）/seek/播放暂停/音量/0.5x–2x 倍速/时间显示/3s 自动隐藏/全屏；
// 播放 src 走 ?mode=stream 网关流式（Range/206），下载由上层直链触发。

import {
  Download,
  Maximize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTROLS_HIDE_DELAY_MS, SPEED_OPTIONS, formatPlayerTime } from './playerFormat';

export interface CustomVideoPlayerProps {
  src: string;
  /** 下载按钮（直链跟随 S3 302）；不传则不显示。 */
  onDownload?: () => void;
}

export function CustomVideoPlayer({ src, onDownload }: CustomVideoPlayerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimerRef = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);

  /** 显示控制条并重置 3s 自动隐藏计时（仅播放中才隐藏）。 */
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    const video = videoRef.current;
    if (video && !video.paused) {
      hideTimerRef.current = window.setTimeout(
        () => setControlsVisible(false),
        CONTROLS_HIDE_DELAY_MS,
      );
    }
  }, []);

  useEffect(() => {
    pokeControls();
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [playing, pokeControls]);

  // 切换 src 时重置播放状态
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setControlsVisible(true);
  }, [src]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (video) setCurrentTime(video.currentTime);
  };

  const handleProgress = () => {
    const video = videoRef.current;
    if (!video || video.buffered.length === 0) return;
    setBuffered(video.buffered.end(video.buffered.length - 1));
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
    pokeControls();
  };

  const handleVolume = (value: number) => {
    const video = videoRef.current;
    setVolume(value);
    setMuted(value === 0);
    if (video) {
      video.volume = value;
      video.muted = value === 0;
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    const next = !muted;
    setMuted(next);
    if (video) video.muted = next;
  };

  const handleSpeed = (value: number) => {
    const video = videoRef.current;
    setSpeed(value);
    if (video) video.playbackRate = value;
  };

  const toggleFullscreen = () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapper.requestFullscreen();
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div
      ref={wrapperRef}
      className="video-player-wrapper"
      onMouseMove={pokeControls}
      onMouseLeave={() => playing && setControlsVisible(false)}
    >
      {/* 直链 URL 自带 ?api_key= 认证 + &mode=stream 网关流式（Range/206） */}
      <video
        ref={videoRef}
        className="video-player-el visible"
        src={src}
        preload="metadata"
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
        onProgress={handleProgress}
      >
        <track kind="captions" />
      </video>

      <div
        className={`video-controls-bar${controlsVisible ? '' : ' auto-hide'}`}
        data-testid="video-controls"
      >
        <div
          className="video-progress-wrap"
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(currentTime)}
          tabIndex={0}
          onClick={handleSeek}
        >
          <div className="video-progress-buffer" style={{ width: `${bufferPct}%` }} />
          <div className="video-progress-bar" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="video-controls-row">
          <div className="video-controls-left">
            <button
              type="button"
              className="btn-vc"
              onClick={togglePlay}
              aria-label={playing ? '暂停' : '播放'}
            >
              {playing ? <Pause /> : <Play />}
            </button>
            <div className="video-volume-wrap">
              <button
                type="button"
                className="btn-vc"
                onClick={toggleMute}
                aria-label={muted ? '取消静音' : '静音'}
              >
                {muted ? <VolumeX /> : <Volume2 />}
              </button>
              <input
                type="range"
                className="video-volume-slider"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="音量"
                onChange={(e) => handleVolume(Number(e.target.value))}
              />
            </div>
            <span className="video-time-display">
              {formatPlayerTime(currentTime)} / {formatPlayerTime(duration)}
            </span>
          </div>
          <div className="video-controls-right">
            <select
              className="video-speed-selector"
              value={speed}
              aria-label="播放倍速"
              onChange={(e) => handleSpeed(Number(e.target.value))}
            >
              {SPEED_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}x
                </option>
              ))}
            </select>
            {onDownload && (
              <button type="button" className="btn-vc" onClick={onDownload} aria-label="下载视频">
                <Download />
              </button>
            )}
            <button
              type="button"
              className="btn-vc"
              onClick={toggleFullscreen}
              aria-label="全屏"
            >
              <Maximize />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
