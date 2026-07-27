// 健康状态轮询 Hook：30s 间隔轮询 /healthz，连续 3 次失败判定异常。

import { useEffect, useRef, useState } from 'react';
import { fetchHealth } from '../api/health';
import { HEALTH_FAIL_THRESHOLD, HEALTH_POLL_INTERVAL_MS } from '../utils/constants';

export type HealthState = 'unknown' | 'healthy' | 'unhealthy';

export interface UseHealthResult {
  health: HealthState;
  /** 最近一次探测时间戳（0 = 未探测）。 */
  checkedAt: number;
}

export function useHealth(enabled = true): UseHealthResult {
  const [health, setHealth] = useState<HealthState>('unknown');
  const [checkedAt, setCheckedAt] = useState(0);
  const failCountRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const probe = async () => {
      try {
        await fetchHealth();
        if (cancelled) return;
        failCountRef.current = 0;
        setHealth('healthy');
      } catch {
        if (cancelled) return;
        failCountRef.current += 1;
        if (failCountRef.current >= HEALTH_FAIL_THRESHOLD) {
          setHealth('unhealthy');
        }
      }
      setCheckedAt(Date.now());
    };

    void probe();
    const timer = window.setInterval(() => void probe(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return { health, checkedAt };
}
