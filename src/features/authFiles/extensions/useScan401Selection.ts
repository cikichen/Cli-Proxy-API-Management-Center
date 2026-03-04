import { useCallback, useMemo, useState } from 'react';
import type { AuthFileItem } from '@/types';
import type { ScanDelete401Status } from '@/features/authFiles/hooks/useAuthFilesData';

type UseScan401SelectionOptions = {
  scanDelete401Status: ScanDelete401Status;
  filtered: AuthFileItem[];
  collectProbeCodeTargetNames: (codes: string[]) => string[];
};

export type UseScan401SelectionResult = {
  statusCodeGroups: ScanDelete401Status['statusCodeGroups'];
  selectedProbeCodes: Set<string>;
  selectedProbeCodeValues: string[];
  selectedProbeCodeCount: number;
  scan401ListFilterActive: boolean;
  probeFilteredCount: number;
  listFiltered: AuthFileItem[];
  toggleProbeCode: (code: string) => void;
  selectAllProbeCodes: () => void;
  clearProbeCodes: () => void;
};

export function useScan401Selection(
  options: UseScan401SelectionOptions
): UseScan401SelectionResult {
  const { scanDelete401Status, filtered, collectProbeCodeTargetNames } = options;
  const statusCodeGroups = scanDelete401Status.statusCodeGroups;
  const [selectedProbeCodesRaw, setSelectedProbeCodesRaw] = useState<Set<string>>(new Set());
  const [manualScopeKey, setManualScopeKey] = useState<string | null>(null);

  const statusCodeGroupSignature = useMemo(
    () => statusCodeGroups.map((group) => `${group.code}:${group.count}`).join('|'),
    [statusCodeGroups]
  );
  const selectionScopeKey = `${scanDelete401Status.phase}|${statusCodeGroupSignature}`;
  const availableCodes = useMemo(
    () => new Set(statusCodeGroups.map((group) => group.code)),
    [statusCodeGroups]
  );

  const selectedProbeCodes = useMemo(() => {
    if (availableCodes.size === 0) return new Set<string>();

    const next = new Set<string>();
    selectedProbeCodesRaw.forEach((code) => {
      if (availableCodes.has(code)) {
        next.add(code);
      }
    });

    if (
      next.size === 0 &&
      scanDelete401Status.phase !== 'scanning' &&
      availableCodes.has('401') &&
      manualScopeKey !== selectionScopeKey
    ) {
      next.add('401');
    }
    return next;
  }, [
    availableCodes,
    manualScopeKey,
    scanDelete401Status.phase,
    selectedProbeCodesRaw,
    selectionScopeKey,
  ]);

  const toggleProbeCode = useCallback(
    (code: string) => {
      setSelectedProbeCodesRaw((prevRaw) => {
        const next = new Set<string>();
        prevRaw.forEach((value) => {
          if (availableCodes.has(value)) {
            next.add(value);
          }
        });

        if (
          next.size === 0 &&
          scanDelete401Status.phase !== 'scanning' &&
          availableCodes.has('401') &&
          manualScopeKey !== selectionScopeKey
        ) {
          next.add('401');
        }

        setManualScopeKey(selectionScopeKey);

        if (next.has(code)) {
          next.delete(code);
        } else {
          next.add(code);
        }
        return next;
      });
    },
    [availableCodes, manualScopeKey, scanDelete401Status.phase, selectionScopeKey]
  );

  const selectAllProbeCodes = useCallback(() => {
    setManualScopeKey(selectionScopeKey);
    setSelectedProbeCodesRaw(new Set(statusCodeGroups.map((group) => group.code)));
  }, [selectionScopeKey, statusCodeGroups]);

  const clearProbeCodes = useCallback(() => {
    setManualScopeKey(selectionScopeKey);
    setSelectedProbeCodesRaw(new Set());
  }, [selectionScopeKey]);

  const selectedProbeCodeValues = useMemo(
    () => Array.from(selectedProbeCodes),
    [selectedProbeCodes]
  );
  const selectedProbeCodeCount = selectedProbeCodeValues.length;
  const scan401ListFilterActive =
    scanDelete401Status.phase !== 'idle' && selectedProbeCodeCount > 0;
  const probeFilteredNameSet = useMemo(() => {
    if (!scan401ListFilterActive) return null;
    if (!statusCodeGroupSignature) return new Set<string>();
    const matchedNames = collectProbeCodeTargetNames(selectedProbeCodeValues);
    return new Set(matchedNames);
  }, [
    collectProbeCodeTargetNames,
    scan401ListFilterActive,
    selectedProbeCodeValues,
    statusCodeGroupSignature,
  ]);
  const probeFilteredCount = probeFilteredNameSet?.size ?? 0;
  const listFiltered = useMemo(() => {
    if (!probeFilteredNameSet) return filtered;
    return filtered.filter((item) => probeFilteredNameSet.has(item.name));
  }, [filtered, probeFilteredNameSet]);

  return {
    statusCodeGroups,
    selectedProbeCodes,
    selectedProbeCodeValues,
    selectedProbeCodeCount,
    scan401ListFilterActive,
    probeFilteredCount,
    listFiltered,
    toggleProbeCode,
    selectAllProbeCodes,
    clearProbeCodes,
  };
}
