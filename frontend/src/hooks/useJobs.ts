import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, readableError, type WhisperApi } from '../api/client';
import type { CreateJobResponse, JobDetail, JobOrigin, JobSummary, SystemStatus } from '../api/types';

const ACTIVE_POLL_MS = 2_500;
const BACKGROUND_POLL_MS = 10_000;

export function pollDelayForFailure(failures: number): number {
  return Math.min(ACTIVE_POLL_MS * (2 ** Math.max(0, failures - 1)), 20_000);
}

function active(job: JobSummary): boolean {
  return job.status === 'queued' || job.status === 'processing' || job.status === 'pausing';
}

function mergeJobs(current: JobSummary[], incoming: JobSummary[]): JobSummary[] {
  const existing = new Set(current.map((job) => job.id));
  return [...current, ...incoming.filter((job) => !existing.has(job.id))];
}

export interface JobsController {
  jobs: JobSummary[];
  selectedId: string | null;
  selectedJob: JobDetail | null;
  systemStatus: SystemStatus | null;
  nextCursor: string | null;
  loading: boolean;
  detailLoading: boolean;
  stale: boolean;
  error: string | null;
  pendingActionIds: ReadonlySet<string>;
  selectJob(id: string): void;
  refresh(): void;
  loadMore(): Promise<void>;
  addCreated(job: CreateJobResponse, originalFilename: string): void;
  cancelJob(id: string): Promise<boolean>;
  pauseJob(id: string): Promise<boolean>;
  resumeJob(id: string): Promise<boolean>;
  retryJob(id: string): Promise<boolean>;
}

export function useJobs(api: WhisperApi | null, onUnauthorized: () => void, origin?: JobOrigin): JobsController {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pendingActionIds, setPendingActionIds] = useState<ReadonlySet<string>>(new Set());
  const hasJobs = useRef(false);

  useEffect(() => { hasJobs.current = jobs.length > 0; }, [jobs.length]);

  useEffect(() => {
    setJobs([]);
    setSelectedId(null);
    setSelectedJob(null);
    setNextCursor(null);
    hasJobs.current = false;
  }, [origin]);

  useEffect(() => {
    if (!api) {
      setJobs([]);
      setSelectedId(null);
      setSelectedJob(null);
      setSystemStatus(null);
      setNextCursor(null);
      setLoading(false);
      setStale(false);
      setError(null);
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    let running = false;

    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(() => { void poll(); }, delay);
    };

    const poll = async () => {
      if (disposed || running) return;
      running = true;
      controller = new AbortController();
      if (!hasJobs.current) setLoading(true);
      try {
        const [page, status] = await Promise.all([
          api.listJobs({ limit: 25, origin, signal: controller.signal }),
          api.getSystemStatus(controller.signal),
        ]);
        if (disposed) return;
        failures = 0;
        setJobs(page.items);
        setNextCursor(page.nextCursor);
        setSystemStatus(status);
        setStale(false);
        setError(null);
        if (page.items.some(active)) schedule(document.visibilityState === 'hidden' ? BACKGROUND_POLL_MS : ACTIVE_POLL_MS);
      } catch (caught) {
        if (disposed || (caught instanceof DOMException && caught.name === 'AbortError')) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        failures += 1;
        setStale(true);
        setError(readableError(caught));
        schedule(pollDelayForFailure(failures));
      } finally {
        if (!disposed) setLoading(false);
        running = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      if (timer) clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [api, onUnauthorized, origin, refreshVersion]);

  const selectedMarker = useMemo(
    () => jobs.find((job) => job.id === selectedId)?.updatedAt ?? '',
    [jobs, selectedId],
  );

  useEffect(() => {
    if (!api || !selectedId) {
      setSelectedJob(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    let activeRequest = true;
    setDetailLoading(true);
    void api.getJob(selectedId, controller.signal).then((job) => {
      if (activeRequest) setSelectedJob(job);
    }).catch((caught: unknown) => {
      if (!activeRequest || (caught instanceof DOMException && caught.name === 'AbortError')) return;
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(readableError(caught));
    }).finally(() => { if (activeRequest) setDetailLoading(false); });
    return () => {
      activeRequest = false;
      controller.abort();
    };
  }, [api, onUnauthorized, selectedId, selectedMarker]);

  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);

  const loadMore = useCallback(async () => {
    if (!api || !nextCursor) return;
    try {
      const page = await api.listJobs({ limit: 25, cursor: nextCursor, origin });
      setJobs((current) => mergeJobs(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(readableError(caught));
    }
  }, [api, nextCursor, onUnauthorized, origin]);

  const addCreated = useCallback((job: CreateJobResponse, originalFilename: string) => {
    const provisional: JobSummary = {
      id: job.id,
      origin: job.origin,
      status: job.status,
      phase: job.phase,
      progress: null,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      originalFilename,
      attempts: 0,
      queuePosition: job.queuePosition,
      error: null,
    };
    if (!origin || origin === job.origin) {
      setJobs((current) => [provisional, ...current.filter((item) => item.id !== job.id)]);
      setSelectedId(job.id);
    }
    setRefreshVersion((value) => value + 1);
  }, [origin]);

  const runAction = useCallback(async (id: string, action: 'cancel' | 'pause' | 'resume' | 'retry'): Promise<boolean> => {
    if (!api) return false;
    setPendingActionIds((current) => new Set([...current, id]));
    setError(null);
    try {
      const updated = action === 'cancel' ? await api.cancelJob(id)
        : action === 'pause' ? await api.pauseJob(id)
          : action === 'resume' ? await api.resumeJob(id)
            : await api.retryJob(id);
      setJobs((current) => current.map((job) => job.id === id ? updated : job));
      setRefreshVersion((value) => value + 1);
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(readableError(caught));
      return false;
    } finally {
      setPendingActionIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [api, onUnauthorized]);

  return {
    jobs,
    selectedId,
    selectedJob,
    systemStatus,
    nextCursor,
    loading,
    detailLoading,
    stale,
    error,
    pendingActionIds,
    selectJob: setSelectedId,
    refresh,
    loadMore,
    addCreated,
    cancelJob: (id) => runAction(id, 'cancel'),
    pauseJob: (id) => runAction(id, 'pause'),
    resumeJob: (id) => runAction(id, 'resume'),
    retryJob: (id) => runAction(id, 'retry'),
  };
}
