import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { apiCallApi, authFilesApi, getApiCallErrorMessage } from '@/services/api';
import { apiClient } from '@/services/api/client';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { formatFileSize } from '@/utils/format';
import { MAX_AUTH_FILE_SIZE } from '@/utils/constants';
import { downloadBlob } from '@/utils/download';
import {
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  resolveCodexChatgptAccountId
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/usage';
import { getTypeLabel, isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';

type DeleteAllOptions = {
  filter: string;
  onResetFilterToAll: () => void;
};

type ScanDelete401Options = {
  filter: string;
};

type ScanDelete401Phase = 'idle' | 'scanning' | 'scan_done' | 'deleting' | 'done';

export type ScanDelete401CodeGroup = {
  code: string;
  label: string;
  count: number;
  sampleMessage: string;
  isHttpStatus: boolean;
};

export type ScanDelete401Status = {
  running: boolean;
  phase: ScanDelete401Phase;
  filter: string;
  total: number;
  scanned: number;
  unauthorized: number;
  errors: number;
  skipped: number;
  deletingTotal: number;
  deleted: number;
  deleteFailed: number;
  statusCodeGroups: ScanDelete401CodeGroup[];
};

export type UseAuthFilesDataResult = {
  files: AuthFileItem[];
  selectedFiles: Set<string>;
  selectionCount: number;
  loading: boolean;
  error: string;
  uploading: boolean;
  deleting: string | null;
  deletingAll: boolean;
  statusUpdating: Record<string, boolean>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  loadFiles: () => Promise<void>;
  handleUploadClick: () => void;
  handleFileChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDelete: (name: string) => void;
  handleDeleteAll: (options: DeleteAllOptions) => void;
  handleDownload: (name: string) => Promise<void>;
  handleStatusToggle: (item: AuthFileItem, enabled: boolean) => Promise<void>;
  toggleSelect: (name: string) => void;
  selectAllVisible: (visibleFiles: AuthFileItem[]) => void;
  deselectAll: () => void;
  batchSetStatus: (names: string[], enabled: boolean) => Promise<void>;
  batchDelete: (names: string[]) => void;
  scanDelete401Status: ScanDelete401Status;
  handleScanDelete401: (options: ScanDelete401Options) => void;
  handleSetStatusByProbeCodes: (codes: string[], enabled: boolean) => void;
  handleDeleteByProbeCodes: (codes: string[]) => void;
};

export type UseAuthFilesDataOptions = {
  refreshKeyStats: () => Promise<void>;
};

const SCAN_401_CONCURRENCY = 8;
const DELETE_401_CONCURRENCY = 8;
const NO_STATUS_CODE = 'NO_STATUS';

const EMPTY_SCAN_DELETE_401_STATUS: ScanDelete401Status = {
  running: false,
  phase: 'idle',
  filter: 'all',
  total: 0,
  scanned: 0,
  unauthorized: 0,
  errors: 0,
  skipped: 0,
  deletingTotal: 0,
  deleted: 0,
  deleteFailed: 0,
  statusCodeGroups: []
};

const normalizeFileType = (file: AuthFileItem): string =>
  String(file.type ?? file.provider ?? '').trim().toLowerCase();

const trimErrorMessage = (message: string): string => {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
};

const isHttpStatusCode = (code: string): boolean => /^\d{3}$/.test(code);

const buildProbeCodeLabel = (code: string, t: (key: string) => string): string => {
  if (isHttpStatusCode(code)) return `HTTP ${code}`;
  if (code === NO_STATUS_CODE) return t('auth_files.scan_401_code_no_status');
  return code;
};

const summarizeCodeGroups = (
  filesByCode: Map<string, Set<string>>,
  sampleByCode: Map<string, string>,
  t: (key: string) => string
): ScanDelete401CodeGroup[] =>
  Array.from(filesByCode.entries())
    .map(([code, names]) => ({
      code,
      label: buildProbeCodeLabel(code, t),
      count: names.size,
      sampleMessage: sampleByCode.get(code) || '',
      isHttpStatus: isHttpStatusCode(code)
    }))
    .filter((group) => group.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const aNum = Number(a.code);
      const bNum = Number(b.code);
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
      return a.code.localeCompare(b.code);
    });

const extractErrorStatusCode = (err: unknown): number | null => {
  if (!err || typeof err !== 'object') return null;
  const raw = (err as { status?: unknown }).status;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 100 || parsed > 599) return null;
  return parsed;
};

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(items.length, concurrency));
  let index = 0;
  const threads = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(threads);
}

const collectNamesByCodes = (filesByCode: Map<string, Set<string>>, codes: string[]): string[] => {
  const names = new Set<string>();
  codes.forEach((code) => {
    const set = filesByCode.get(code);
    if (!set) return;
    set.forEach((name) => names.add(name));
  });
  return Array.from(names);
};

const removeNamesFromCodeMap = (filesByCode: Map<string, Set<string>>, deletedNames: Set<string>) => {
  filesByCode.forEach((names, code) => {
    deletedNames.forEach((name) => {
      names.delete(name);
    });
    if (names.size === 0) {
      filesByCode.delete(code);
    }
  });
};

type ProbeCodeTargets = {
  targetNames: string[];
  selectedLabels: string;
};

export function useAuthFilesData(options: UseAuthFilesDataOptions): UseAuthFilesDataResult {
  const { refreshKeyStats } = options;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState<Record<string, boolean>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [scanDelete401Status, setScanDelete401Status] = useState<ScanDelete401Status>(
    EMPTY_SCAN_DELETE_401_STATUS
  );
  const scanFilesByCodeRef = useRef<Map<string, Set<string>>>(new Map());
  const scanSampleByCodeRef = useRef<Map<string, string>>(new Map());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectionCount = selectedFiles.size;

  const toggleSelect = useCallback((name: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const selectAllVisible = useCallback((visibleFiles: AuthFileItem[]) => {
    const nextSelected = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    setSelectedFiles(new Set(nextSelected));
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  useEffect(() => {
    if (selectedFiles.size === 0) return;
    const existingNames = new Set(files.map((file) => file.name));
    setSelectedFiles((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((name) => {
        if (existingNames.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [files, selectedFiles.size]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      setFiles(data?.files || []);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;

      const filesToUpload = Array.from(fileList);
      const validFiles: File[] = [];
      const invalidFiles: string[] = [];
      const oversizedFiles: string[] = [];

      filesToUpload.forEach((file) => {
        if (!file.name.endsWith('.json')) {
          invalidFiles.push(file.name);
          return;
        }
        if (file.size > MAX_AUTH_FILE_SIZE) {
          oversizedFiles.push(file.name);
          return;
        }
        validFiles.push(file);
      });

      if (invalidFiles.length > 0) {
        showNotification(t('auth_files.upload_error_json'), 'error');
      }
      if (oversizedFiles.length > 0) {
        showNotification(
          t('auth_files.upload_error_size', { maxSize: formatFileSize(MAX_AUTH_FILE_SIZE) }),
          'error'
        );
      }

      if (validFiles.length === 0) {
        event.target.value = '';
        return;
      }

      setUploading(true);
      let successCount = 0;
      const failed: { name: string; message: string }[] = [];

      for (const file of validFiles) {
        try {
          await authFilesApi.upload(file);
          successCount++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          failed.push({ name: file.name, message: errorMessage });
        }
      }

      if (successCount > 0) {
        const suffix = validFiles.length > 1 ? ` (${successCount}/${validFiles.length})` : '';
        showNotification(
          `${t('auth_files.upload_success')}${suffix}`,
          failed.length ? 'warning' : 'success'
        );
        await loadFiles();
        await refreshKeyStats();
      }

      if (failed.length > 0) {
        const details = failed.map((item) => `${item.name}: ${item.message}`).join('; ');
        showNotification(`${t('notification.upload_failed')}: ${details}`, 'error');
      }

      setUploading(false);
      event.target.value = '';
    },
    [loadFiles, refreshKeyStats, showNotification, t]
  );

  const handleDelete = useCallback(
    (name: string) => {
      showConfirmation({
        title: t('auth_files.delete_title', { defaultValue: 'Delete File' }),
        message: `${t('auth_files.delete_confirm')} "${name}" ?`,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeleting(name);
          try {
            await authFilesApi.deleteFile(name);
            showNotification(t('auth_files.delete_success'), 'success');
            setFiles((prev) => prev.filter((item) => item.name !== name));
            setSelectedFiles((prev) => {
              if (!prev.has(name)) return prev;
              const next = new Set(prev);
              next.delete(name);
              return next;
            });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeleting(null);
          }
        }
      });
    },
    [showConfirmation, showNotification, t]
  );

  const handleDeleteAll = useCallback(
    (deleteAllOptions: DeleteAllOptions) => {
      const { filter, onResetFilterToAll } = deleteAllOptions;
      const isFiltered = filter !== 'all';
      const typeLabel = isFiltered ? getTypeLabel(t, filter) : t('auth_files.filter_all');
      const confirmMessage = isFiltered
        ? t('auth_files.delete_filtered_confirm', { type: typeLabel })
        : t('auth_files.delete_all_confirm');

      showConfirmation({
        title: t('auth_files.delete_all_title', { defaultValue: 'Delete All Files' }),
        message: confirmMessage,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeletingAll(true);
          try {
            if (!isFiltered) {
              await authFilesApi.deleteAll();
              showNotification(t('auth_files.delete_all_success'), 'success');
              setFiles((prev) => prev.filter((file) => isRuntimeOnlyAuthFile(file)));
              deselectAll();
            } else {
              const filesToDelete = files.filter(
                (f) => f.type === filter && !isRuntimeOnlyAuthFile(f)
              );

              if (filesToDelete.length === 0) {
                showNotification(t('auth_files.delete_filtered_none', { type: typeLabel }), 'info');
                setDeletingAll(false);
                return;
              }

              let success = 0;
              let failed = 0;
              const deletedNames: string[] = [];

              for (const file of filesToDelete) {
                try {
                  await authFilesApi.deleteFile(file.name);
                  success++;
                  deletedNames.push(file.name);
                } catch {
                  failed++;
                }
              }

              setFiles((prev) => prev.filter((f) => !deletedNames.includes(f.name)));
              setSelectedFiles((prev) => {
                if (prev.size === 0) return prev;
                const deletedSet = new Set(deletedNames);
                let changed = false;
                const next = new Set<string>();
                prev.forEach((name) => {
                  if (deletedSet.has(name)) {
                    changed = true;
                  } else {
                    next.add(name);
                  }
                });
                return changed ? next : prev;
              });

              if (failed === 0) {
                showNotification(
                  t('auth_files.delete_filtered_success', { count: success, type: typeLabel }),
                  'success'
                );
              } else {
                showNotification(
                  t('auth_files.delete_filtered_partial', { success, failed, type: typeLabel }),
                  'warning'
                );
              }
              onResetFilterToAll();
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeletingAll(false);
          }
        }
      });
    },
    [deselectAll, files, showConfirmation, showNotification, t]
  );

  const handleDownload = useCallback(
    async (name: string) => {
      try {
        const response = await apiClient.getRaw(
          `/auth-files/download?name=${encodeURIComponent(name)}`,
          { responseType: 'blob' }
        );
        const blob = new Blob([response.data]);
        downloadBlob({ filename: name, blob });
        showNotification(t('auth_files.download_success'), 'success');
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
      }
    },
    [showNotification, t]
  );

  const handleStatusToggle = useCallback(
    async (item: AuthFileItem, enabled: boolean) => {
      const name = item.name;
      const nextDisabled = !enabled;
      const previousDisabled = item.disabled === true;

      setStatusUpdating((prev) => ({ ...prev, [name]: true }));
      setFiles((prev) => prev.map((f) => (f.name === name ? { ...f, disabled: nextDisabled } : f)));

      try {
        const res = await authFilesApi.setStatus(name, nextDisabled);
        setFiles((prev) =>
          prev.map((f) => (f.name === name ? { ...f, disabled: res.disabled } : f))
        );
        showNotification(
          enabled
            ? t('auth_files.status_enabled_success', { name })
            : t('auth_files.status_disabled_success', { name }),
          'success'
        );
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        setFiles((prev) =>
          prev.map((f) => (f.name === name ? { ...f, disabled: previousDisabled } : f))
        );
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
      } finally {
        setStatusUpdating((prev) => {
          if (!prev[name]) return prev;
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
    },
    [showNotification, t]
  );

  const batchSetStatus = useCallback(
    async (names: string[], enabled: boolean) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      const targetNames = new Set(uniqueNames);
      const nextDisabled = !enabled;

      setFiles((prev) =>
        prev.map((file) =>
          targetNames.has(file.name) ? { ...file, disabled: nextDisabled } : file
        )
      );

      const results = await Promise.allSettled(
        uniqueNames.map((name) => authFilesApi.setStatus(name, nextDisabled))
      );

      let successCount = 0;
      let failCount = 0;
      const failedNames = new Set<string>();
      const confirmedDisabled = new Map<string, boolean>();

      results.forEach((result, index) => {
        const name = uniqueNames[index];
        if (result.status === 'fulfilled') {
          successCount++;
          confirmedDisabled.set(name, result.value.disabled);
        } else {
          failCount++;
          failedNames.add(name);
        }
      });

      setFiles((prev) =>
        prev.map((file) => {
          if (failedNames.has(file.name)) {
            return { ...file, disabled: !nextDisabled };
          }
          if (confirmedDisabled.has(file.name)) {
            return { ...file, disabled: confirmedDisabled.get(file.name) };
          }
          return file;
        })
      );

      if (failCount === 0) {
        showNotification(t('auth_files.batch_status_success', { count: successCount }), 'success');
      } else {
        showNotification(
          t('auth_files.batch_status_partial', { success: successCount, failed: failCount }),
          'warning'
        );
      }

      deselectAll();
    },
    [deselectAll, showNotification, t]
  );

  const batchDelete = useCallback(
    (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      showConfirmation({
        title: t('auth_files.batch_delete_title'),
        message: t('auth_files.batch_delete_confirm', { count: uniqueNames.length }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          const results = await Promise.allSettled(
            uniqueNames.map((name) => authFilesApi.deleteFile(name))
          );

          const deleted: string[] = [];
          let failCount = 0;
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              deleted.push(uniqueNames[index]);
            } else {
              failCount++;
            }
          });

          if (deleted.length > 0) {
            const deletedSet = new Set(deleted);
            setFiles((prev) => prev.filter((file) => !deletedSet.has(file.name)));
          }

          setSelectedFiles((prev) => {
            if (prev.size === 0) return prev;
            const deletedSet = new Set(deleted);
            let changed = false;
            const next = new Set<string>();
            prev.forEach((name) => {
              if (deletedSet.has(name)) {
                changed = true;
              } else {
                next.add(name);
              }
            });
            return changed ? next : prev;
          });

          if (failCount === 0) {
            showNotification(`${t('auth_files.delete_all_success')} (${deleted.length})`, 'success');
          } else {
            showNotification(
              t('auth_files.delete_filtered_partial', {
                success: deleted.length,
                failed: failCount,
                type: t('auth_files.filter_all')
              }),
              'warning'
            );
          }
        }
      });
    },
    [showConfirmation, showNotification, t]
  );

  const resolveProbeCodeTargets = useCallback(
    (codes: string[]): ProbeCodeTargets | null => {
      const normalizedCodes = Array.from(
        new Set(codes.map((code) => String(code || '').trim()).filter(Boolean))
      );
      if (normalizedCodes.length === 0) {
        showNotification(t('auth_files.scan_401_no_code_selected'), 'info');
        return null;
      }

      const selectedCodeSet = new Set(normalizedCodes);
      const selectedGroups = scanDelete401Status.statusCodeGroups.filter((group) =>
        selectedCodeSet.has(group.code)
      );
      if (selectedGroups.length === 0) {
        showNotification(t('auth_files.scan_401_no_code_selected'), 'info');
        return null;
      }

      const selectedCodes = selectedGroups.map((group) => group.code);
      const selectedLabels = selectedGroups.map((group) => group.label).join(', ');
      const targetNames = collectNamesByCodes(scanFilesByCodeRef.current, selectedCodes);
      if (targetNames.length === 0) {
        showNotification(t('auth_files.scan_401_no_code_targets'), 'info');
        return null;
      }

      return { targetNames, selectedLabels };
    },
    [scanDelete401Status.statusCodeGroups, showNotification, t]
  );

  const handleSetStatusByProbeCodes = useCallback(
    (codes: string[], enabled: boolean) => {
      if (scanDelete401Status.running) {
        showNotification(t('auth_files.scan_401_running'), 'info');
        return;
      }

      const resolved = resolveProbeCodeTargets(codes);
      if (!resolved) return;
      const { targetNames, selectedLabels } = resolved;
      const titleKey = enabled
        ? 'auth_files.scan_401_enable_selected_codes'
        : 'auth_files.scan_401_disable_selected_codes';
      const messageKey = enabled
        ? 'auth_files.scan_401_enable_codes_confirm'
        : 'auth_files.scan_401_disable_codes_confirm';

      showConfirmation({
        title: t(titleKey),
        message: t(messageKey, {
          count: targetNames.length,
          codes: selectedLabels
        }),
        variant: enabled ? 'secondary' : 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          await batchSetStatus(targetNames, enabled);
        }
      });
    },
    [batchSetStatus, resolveProbeCodeTargets, scanDelete401Status.running, showConfirmation, showNotification, t]
  );

  const handleDeleteByProbeCodes = useCallback(
    (codes: string[]) => {
      if (scanDelete401Status.running) {
        showNotification(t('auth_files.scan_401_running'), 'info');
        return;
      }

      const resolved = resolveProbeCodeTargets(codes);
      if (!resolved) return;
      const { targetNames, selectedLabels } = resolved;

      showConfirmation({
        title: t('auth_files.scan_401_delete_title'),
        message: t('auth_files.scan_401_delete_codes_confirm', {
          count: targetNames.length,
          codes: selectedLabels
        }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          let deletedCount = 0;
          let deleteFailedCount = 0;
          const deletedNames: string[] = [];

          setScanDelete401Status((prev) => ({
            ...prev,
            running: true,
            phase: 'deleting',
            deletingTotal: targetNames.length,
            deleted: 0,
            deleteFailed: 0
          }));

          await runWithConcurrency(targetNames, DELETE_401_CONCURRENCY, async (name) => {
            try {
              await authFilesApi.deleteFile(name);
              deletedCount += 1;
              deletedNames.push(name);
            } catch {
              deleteFailedCount += 1;
            } finally {
              setScanDelete401Status((prev) => ({
                ...prev,
                deleted: deletedCount,
                deleteFailed: deleteFailedCount
              }));
            }
          });

          if (deletedNames.length > 0) {
            const deletedSet = new Set(deletedNames);
            setFiles((prev) => prev.filter((file) => !deletedSet.has(file.name)));
            setSelectedFiles((prev) => {
              if (prev.size === 0) return prev;
              let changed = false;
              const next = new Set<string>();
              prev.forEach((name) => {
                if (deletedSet.has(name)) {
                  changed = true;
                } else {
                  next.add(name);
                }
              });
              return changed ? next : prev;
            });

            removeNamesFromCodeMap(scanFilesByCodeRef.current, deletedSet);
            scanSampleByCodeRef.current.forEach((_, code) => {
              if (!scanFilesByCodeRef.current.has(code)) {
                scanSampleByCodeRef.current.delete(code);
              }
            });
          }

          await refreshKeyStats().catch(() => {});

          const statusCodeGroups = summarizeCodeGroups(
            scanFilesByCodeRef.current,
            scanSampleByCodeRef.current,
            t
          );
          const unauthorized = scanFilesByCodeRef.current.get('401')?.size ?? 0;
          const errors = statusCodeGroups.reduce(
            (sum, group) => sum + (group.code === '401' ? 0 : group.count),
            0
          );

          setScanDelete401Status((prev) => ({
            ...prev,
            running: false,
            phase: 'done',
            unauthorized,
            errors,
            deleted: deletedCount,
            deleteFailed: deleteFailedCount,
            statusCodeGroups
          }));

          showNotification(
            t('auth_files.scan_401_delete_result', {
              success: deletedCount,
              failed: deleteFailedCount
            }),
            deleteFailedCount > 0 ? 'warning' : 'success'
          );
        }
      });
    },
    [refreshKeyStats, resolveProbeCodeTargets, scanDelete401Status.running, showConfirmation, showNotification, t]
  );

  const handleScanDelete401 = useCallback(
    (optionsForScan: ScanDelete401Options) => {
      if (scanDelete401Status.running) {
        showNotification(t('auth_files.scan_401_running'), 'info');
        return;
      }

      const filter = String(optionsForScan.filter || 'all').trim().toLowerCase();
      const scopeTypeLabel = filter === 'all' ? t('auth_files.filter_all') : getTypeLabel(t, filter);
      const scopedFiles = files.filter((file) => {
        if (isRuntimeOnlyAuthFile(file)) return false;
        if (filter === 'all') return true;
        return normalizeFileType(file) === filter;
      });
      const codexFiles = scopedFiles.filter((file) => normalizeFileType(file) === 'codex');
      const skipped = Math.max(0, scopedFiles.length - codexFiles.length);

      if (codexFiles.length === 0) {
        scanFilesByCodeRef.current = new Map();
        scanSampleByCodeRef.current = new Map();
        setScanDelete401Status({
          ...EMPTY_SCAN_DELETE_401_STATUS,
          phase: 'done',
          filter,
          skipped
        });
        showNotification(
          t('auth_files.scan_401_no_target', {
            scope: scopeTypeLabel
          }),
          'info'
        );
        return;
      }

      scanFilesByCodeRef.current = new Map();
      scanSampleByCodeRef.current = new Map();
      setScanDelete401Status({
        ...EMPTY_SCAN_DELETE_401_STATUS,
        running: true,
        phase: 'scanning',
        filter,
        total: codexFiles.length,
        skipped
      });

      void (async () => {
        let scanned = 0;
        let unauthorized = 0;
        let errors = 0;

        await runWithConcurrency(codexFiles, SCAN_401_CONCURRENCY, async (file) => {
          let code: string | null = null;
          let sampleMessage = '';

          try {
            const rawAuthIndex = file['auth_index'] ?? file.authIndex;
            const authIndex = normalizeAuthIndex(rawAuthIndex);
            if (!authIndex) {
              throw new Error(t('codex_quota.missing_auth_index'));
            }

            const chatgptAccountId = resolveCodexChatgptAccountId(file);
            if (!chatgptAccountId) {
              throw new Error(t('codex_quota.missing_account_id'));
            }

            const result = await apiCallApi.request({
              authIndex,
              method: 'GET',
              url: CODEX_USAGE_URL,
              header: {
                ...CODEX_REQUEST_HEADERS,
                'Chatgpt-Account-Id': chatgptAccountId
              }
            });

            if (result.statusCode < 200 || result.statusCode >= 300) {
              code = isHttpStatusCode(String(result.statusCode))
                ? String(result.statusCode)
                : NO_STATUS_CODE;
              sampleMessage = trimErrorMessage(getApiCallErrorMessage(result));
            }
          } catch (err: unknown) {
            const statusCode = extractErrorStatusCode(err);
            code = statusCode ? String(statusCode) : NO_STATUS_CODE;
            sampleMessage = trimErrorMessage(
              err instanceof Error ? err.message : t('common.unknown_error')
            );
          } finally {
            if (code) {
              let codeSet = scanFilesByCodeRef.current.get(code);
              if (!codeSet) {
                codeSet = new Set();
                scanFilesByCodeRef.current.set(code, codeSet);
              }
              codeSet.add(file.name);

              if (!scanSampleByCodeRef.current.has(code) && sampleMessage) {
                scanSampleByCodeRef.current.set(code, sampleMessage);
              }

              if (code === '401') {
                unauthorized += 1;
              } else {
                errors += 1;
              }
            }

            scanned += 1;
            setScanDelete401Status((prev) => ({
              ...prev,
              scanned,
              unauthorized,
              errors,
              statusCodeGroups: summarizeCodeGroups(
                scanFilesByCodeRef.current,
                scanSampleByCodeRef.current,
                t
              )
            }));
          }
        });

        setScanDelete401Status((prev) => ({
          ...prev,
          running: false,
          phase: 'scan_done',
          scanned: codexFiles.length,
          unauthorized,
          errors,
          statusCodeGroups: summarizeCodeGroups(
            scanFilesByCodeRef.current,
            scanSampleByCodeRef.current,
            t
          )
        }));

        showNotification(
          t('auth_files.scan_401_scan_done', {
            total: codexFiles.length,
            unauthorized,
            errors
          }),
          unauthorized > 0 || errors > 0 ? 'warning' : 'success'
        );
      })().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        setScanDelete401Status((prev) => ({
          ...prev,
          running: false,
          phase: 'done'
        }));
        showNotification(`${t('notification.operation_failed')}: ${message}`, 'error');
      });
    },
    [files, scanDelete401Status.running, showNotification, t]
  );

  return {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    deselectAll,
    batchSetStatus,
    batchDelete,
    scanDelete401Status,
    handleScanDelete401,
    handleSetStatusByProbeCodes,
    handleDeleteByProbeCodes
  };
}
