import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refreshing: boolean;
  reload(): void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const hasDataRef = useRef(false);
  const backgroundRequestedRef = useRef(false);

  const reload = useCallback(() => {
    backgroundRequestedRef.current = true;
    setVersion((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: callers own deps; version drives reload.
  useEffect(() => {
    let active = true;
    const background = backgroundRequestedRef.current && hasDataRef.current;
    backgroundRequestedRef.current = false;
    setLoading(!background);
    setRefreshing(background);
    setError(null);
    loader()
      .then((value) => {
        if (!active) return;
        hasDataRef.current = true;
        setData(value);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        if (!background) {
          hasDataRef.current = false;
          setData(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [...deps, version]);

  return { data, error, loading, refreshing, reload };
}
