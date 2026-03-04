export type Scan401ConcurrencyConfig = {
  scanConcurrency: number;
  deleteConcurrency: number;
};

export const MIN_SCAN_401_CONCURRENCY = 1;
export const MAX_SCAN_401_CONCURRENCY = 32;

export const DEFAULT_SCAN_401_SCAN_CONCURRENCY = 8;
export const DEFAULT_SCAN_401_DELETE_CONCURRENCY = 8;

export const SCAN_401_SCAN_CONCURRENCY_STORAGE_KEY = 'auth-files:scan401:scan-concurrency';
export const SCAN_401_DELETE_CONCURRENCY_STORAGE_KEY = 'auth-files:scan401:delete-concurrency';

const clamp = (value: number): number =>
  Math.max(MIN_SCAN_401_CONCURRENCY, Math.min(MAX_SCAN_401_CONCURRENCY, value));

const parseInteger = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  if (rounded < 1) return null;
  return rounded;
};

export const normalizeScan401Concurrency = (value: unknown, fallback: number): number => {
  const parsed = parseInteger(value);
  const normalizedFallback = clamp(Math.max(1, Math.trunc(fallback)));
  if (parsed === null) return normalizedFallback;
  return clamp(parsed);
};

export const readStoredScan401Concurrency = (): Scan401ConcurrencyConfig => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return {
      scanConcurrency: DEFAULT_SCAN_401_SCAN_CONCURRENCY,
      deleteConcurrency: DEFAULT_SCAN_401_DELETE_CONCURRENCY
    };
  }

  const scanRaw = window.localStorage.getItem(SCAN_401_SCAN_CONCURRENCY_STORAGE_KEY);
  const deleteRaw = window.localStorage.getItem(SCAN_401_DELETE_CONCURRENCY_STORAGE_KEY);

  return {
    scanConcurrency: normalizeScan401Concurrency(
      scanRaw,
      DEFAULT_SCAN_401_SCAN_CONCURRENCY
    ),
    deleteConcurrency: normalizeScan401Concurrency(
      deleteRaw,
      DEFAULT_SCAN_401_DELETE_CONCURRENCY
    )
  };
};

export const writeStoredScan401Concurrency = (
  patch: Partial<Scan401ConcurrencyConfig>
): Scan401ConcurrencyConfig => {
  const current = readStoredScan401Concurrency();
  const next: Scan401ConcurrencyConfig = {
    scanConcurrency: normalizeScan401Concurrency(
      patch.scanConcurrency,
      current.scanConcurrency
    ),
    deleteConcurrency: normalizeScan401Concurrency(
      patch.deleteConcurrency,
      current.deleteConcurrency
    )
  };

  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    window.localStorage.setItem(
      SCAN_401_SCAN_CONCURRENCY_STORAGE_KEY,
      String(next.scanConcurrency)
    );
    window.localStorage.setItem(
      SCAN_401_DELETE_CONCURRENCY_STORAGE_KEY,
      String(next.deleteConcurrency)
    );
  }

  return next;
};
