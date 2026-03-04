import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { ScanDelete401Status } from '@/features/authFiles/hooks/useAuthFilesData';
import {
  DEFAULT_SCAN_401_DELETE_CONCURRENCY,
  DEFAULT_SCAN_401_SCAN_CONCURRENCY,
  MAX_SCAN_401_CONCURRENCY,
  MIN_SCAN_401_CONCURRENCY,
  normalizeScan401Concurrency,
  readStoredScan401Concurrency,
  writeStoredScan401Concurrency
} from './scan401ConcurrencyConfig';
import styles from './Scan401Panel.module.scss';

const getInitialScanConcurrencyInput = (): string =>
  String(readStoredScan401Concurrency().scanConcurrency);

const getInitialDeleteConcurrencyInput = (): string =>
  String(readStoredScan401Concurrency().deleteConcurrency);

type Scan401PanelProps = {
  status: ScanDelete401Status;
  hasError: boolean;
  progressText: string;
  selectedProbeCodes: Set<string>;
  selectedProbeCodeValues: string[];
  selectedProbeCodeCount: number;
  scan401ListFilterActive: boolean;
  listFilteredCount: number;
  probeFilteredCount: number;
  baseFilteredCount: number;
  disableControls: boolean;
  onSelectAllProbeCodes: () => void;
  onClearProbeCodes: () => void;
  onToggleProbeCode: (code: string) => void;
  onSetStatusByProbeCodes: (codes: string[], enabled: boolean) => void;
  onDeleteByProbeCodes: (codes: string[]) => void;
};

export function Scan401Panel(props: Scan401PanelProps) {
  const { t } = useTranslation();
  const [scanConcurrencyInput, setScanConcurrencyInput] = useState(getInitialScanConcurrencyInput);
  const [deleteConcurrencyInput, setDeleteConcurrencyInput] = useState(
    getInitialDeleteConcurrencyInput
  );
  const {
    status,
    hasError,
    progressText,
    selectedProbeCodes,
    selectedProbeCodeValues,
    selectedProbeCodeCount,
    scan401ListFilterActive,
    listFilteredCount,
    probeFilteredCount,
    baseFilteredCount,
    disableControls,
    onSelectAllProbeCodes,
    onClearProbeCodes,
    onToggleProbeCode,
    onSetStatusByProbeCodes,
    onDeleteByProbeCodes,
  } = props;

  const commitScanConcurrency = (raw: string) => {
    const normalized = normalizeScan401Concurrency(raw, DEFAULT_SCAN_401_SCAN_CONCURRENCY);
    const next = writeStoredScan401Concurrency({ scanConcurrency: normalized });
    setScanConcurrencyInput(String(next.scanConcurrency));
  };

  const commitDeleteConcurrency = (raw: string) => {
    const normalized = normalizeScan401Concurrency(raw, DEFAULT_SCAN_401_DELETE_CONCURRENCY);
    const next = writeStoredScan401Concurrency({ deleteConcurrency: normalized });
    setDeleteConcurrencyInput(String(next.deleteConcurrency));
  };

  const statusCodeGroups = status.statusCodeGroups;
  const listCountText = scan401ListFilterActive
    ? t('auth_files.scan_401_filtered_files_stat', {
        visible: listFilteredCount,
        matched: probeFilteredCount,
        defaultValue: '命中 {{matched}} 个，下方显示 {{visible}} 个',
      })
    : t('auth_files.scan_401_list_total_stat', {
        count: baseFilteredCount,
        defaultValue: '当前列表 {{count}} 个',
      });

  return (
    <div className={`${styles.panel} ${hasError ? styles.panelError : ''}`}>
      <div className={styles.configRow}>
        <span className={styles.configTitle}>
          {t('auth_files.scan_401_concurrency_title', {
            defaultValue: '并发配置',
          })}
        </span>
        <div className={styles.configFields}>
          <label className={styles.configField}>
            <span>
              {t('auth_files.scan_401_scan_concurrency_label', {
                defaultValue: '扫描并发',
              })}
            </span>
            <input
              className={styles.configInput}
              type="number"
              min={MIN_SCAN_401_CONCURRENCY}
              max={MAX_SCAN_401_CONCURRENCY}
              step={1}
              value={scanConcurrencyInput}
              disabled={status.running}
              onChange={(event) => setScanConcurrencyInput(event.target.value)}
              onBlur={(event) => commitScanConcurrency(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <label className={styles.configField}>
            <span>
              {t('auth_files.scan_401_delete_concurrency_label', {
                defaultValue: '删除并发',
              })}
            </span>
            <input
              className={styles.configInput}
              type="number"
              min={MIN_SCAN_401_CONCURRENCY}
              max={MAX_SCAN_401_CONCURRENCY}
              step={1}
              value={deleteConcurrencyInput}
              disabled={status.running}
              onChange={(event) => setDeleteConcurrencyInput(event.target.value)}
              onBlur={(event) => commitDeleteConcurrency(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        </div>
        <span className={styles.configHint}>
          {t('auth_files.scan_401_concurrency_hint', {
            min: MIN_SCAN_401_CONCURRENCY,
            max: MAX_SCAN_401_CONCURRENCY,
            defaultValue: '范围 {{min}}-{{max}}，修改后自动保存',
          })}
        </span>
      </div>

      {progressText && (
        <div className={styles.header}>
          <p className={styles.progressText}>{progressText}</p>
          {statusCodeGroups.length > 0 && (
            <div className={styles.stats}>
              <span className={styles.stat}>
                {t('auth_files.scan_401_selected_codes_stat', {
                  count: selectedProbeCodeCount,
                  defaultValue: '已选 {{count}} 个错误码',
                })}
              </span>
              <span className={styles.stat}>{listCountText}</span>
            </div>
          )}
        </div>
      )}

      {statusCodeGroups.length > 0 && (
        <div className={styles.codeSection}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarGroup}>
              <Button
                variant="secondary"
                size="sm"
                onClick={onSelectAllProbeCodes}
                disabled={status.running || statusCodeGroups.length === 0}
              >
                {t('auth_files.scan_401_select_all_codes')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearProbeCodes}
                disabled={status.running || selectedProbeCodeCount === 0}
              >
                {t('auth_files.scan_401_clear_codes')}
              </Button>
            </div>

            <div className={styles.toolbarGroup}>
              <Button
                size="sm"
                onClick={() => onSetStatusByProbeCodes(selectedProbeCodeValues, true)}
                disabled={disableControls || status.running || selectedProbeCodeCount === 0}
              >
                {t('auth_files.scan_401_enable_selected_codes')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onSetStatusByProbeCodes(selectedProbeCodeValues, false)}
                disabled={disableControls || status.running || selectedProbeCodeCount === 0}
              >
                {t('auth_files.scan_401_disable_selected_codes')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onDeleteByProbeCodes(selectedProbeCodeValues)}
                disabled={disableControls || status.running || selectedProbeCodeCount === 0}
              >
                {t('auth_files.scan_401_delete_selected_codes')}
              </Button>
            </div>
          </div>

          <div className={styles.codeList}>
            {statusCodeGroups.map((group) => {
              const isChecked = selectedProbeCodes.has(group.code);
              return (
                <label
                  key={`${group.code}-${group.count}`}
                  className={`${styles.codeItem} ${isChecked ? styles.codeItemSelected : ''}`}
                  title={group.sampleMessage || group.label}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggleProbeCode(group.code)}
                    disabled={status.running}
                  />
                  <div className={styles.codeText}>
                    <div className={styles.codeMeta}>
                      <span className={styles.codeLabel}>{group.label}</span>
                      <span className={styles.codeCount}>
                        {t('auth_files.scan_401_code_count', { count: group.count })}
                      </span>
                    </div>
                    {group.sampleMessage && (
                      <span className={styles.codeSample}>{group.sampleMessage}</span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
