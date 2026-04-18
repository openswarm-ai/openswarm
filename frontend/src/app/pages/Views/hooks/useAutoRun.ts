import React, { useState, useMemo } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { EXECUTE_APP, App, AppExecuteResult } from '@/shared/backend-bridge/apps/app_builder';
import { getDefault } from '../InputSchemaForm';
import type { ConsoleEntry } from '../ConsolePanel';

export function useAutoRun(
  app: App | null,
  createdIdRef: React.MutableRefObject<string | null>,
  files: Record<string, string>,
  name: string,
  setActiveTab: (tab: number) => void,
) {
  const dispatch = useAppDispatch();

  const schemaText = files['schema.json'] ?? '{"type":"object","properties":{},"required":[]}';
  const parsedSchema = useMemo(() => {
    try { return JSON.parse(schemaText); } catch { return { type: 'object', properties: {} }; }
  }, [schemaText]);

  const testInputDefault = useMemo(() => getDefault(parsedSchema), [parsedSchema]);
  const [testInput, setTestInput] = useState<Record<string, any>>(testInputDefault);

  const [executeResult, setExecuteResult] = useState<AppExecuteResult | null>(null);
  const [consoleEntry, setConsoleEntry] = useState<ConsoleEntry | null>(null);
  const [hasNewConsoleOutput, setHasNewConsoleOutput] = useState(false);

  const handleRunPreview = async () => {
    const eid = app?.id ?? createdIdRef.current;
    if (!eid) { setExecuteResult(null); return; }
    setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: null, stderr: null, backendResult: null, error: null, source: 'execute', running: true });
    setHasNewConsoleOutput(true);
    try {
      const res = await dispatch(EXECUTE_APP({ app_id: eid, input_data: testInput })).unwrap();
      setExecuteResult(res);
      setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: res.stdout ?? null, stderr: res.stderr ?? null, backendResult: res.backend_result as Record<string, any> | null, error: res.error, source: 'execute' });
    } catch (e: any) {
      setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: null, stderr: null, backendResult: null, error: e?.message || 'Execution failed', source: 'execute' });
    }
  };

  return {
    schemaText, parsedSchema, testInput, setTestInput,
    executeResult, consoleEntry,
    hasNewConsoleOutput, setHasNewConsoleOutput,
    handleRunPreview,
  };
}
