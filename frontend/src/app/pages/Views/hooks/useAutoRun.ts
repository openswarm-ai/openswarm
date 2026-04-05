import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  Output, OutputExecuteResult,
  executeOutput, autoRunOutput, autoRunAgentOutput,
  cleanupAutoRunAgent, AutoRunConfig,
} from '@/shared/state/outputsSlice';
import { ChatInputHandle } from '../../AgentChat/ChatInput';
import { getDefault } from '../InputSchemaForm';
import type { ConsoleEntry } from '../ConsolePanel';

const TAB_PREVIEW = 0;

export function useAutoRun(
  output: Output | null,
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
  useEffect(() => { setTestInput(getDefault(parsedSchema)); }, [schemaText]);

  const [executeResult, setExecuteResult] = useState<OutputExecuteResult | null>(null);
  const [consoleEntry, setConsoleEntry] = useState<ConsoleEntry | null>(null);
  const [hasNewConsoleOutput, setHasNewConsoleOutput] = useState(false);

  const savedAutoRun = output?.auto_run_config;
  const [autoRunEnabled, setAutoRunEnabled] = useState(savedAutoRun?.enabled ?? false);
  const [autoRunMode, setAutoRunMode] = useState(savedAutoRun?.mode ?? 'agent');
  const [autoRunModel, setAutoRunModel] = useState(savedAutoRun?.model ?? 'sonnet');
  const [autoRunning, setAutoRunning] = useState(false);
  const autoRunInputRef = useRef<ChatInputHandle>(null);
  const autoRunInitialized = useRef(false);

  const [autoRunSessionId, setAutoRunSessionId] = useState<string | null>(null);
  const autoRunLogEndRef = useRef<HTMLDivElement>(null);

  const autoRunSession = useAppSelector((state) =>
    autoRunSessionId ? state.agents.sessions[autoRunSessionId] : null
  );
  const autoRunMessages = autoRunSession?.messages ?? [];
  const autoRunSessionStatus = autoRunSession?.status ?? null;

  useEffect(() => {
    if (autoRunInitialized.current || !savedAutoRun) return;
    if (!autoRunEnabled) return;
    autoRunInitialized.current = true;
    const timer = setTimeout(() => {
      autoRunInputRef.current?.setContent(
        savedAutoRun.prompt || '',
        savedAutoRun.context_paths?.map((cp) => ({ path: cp.path, type: (cp.type as 'file' | 'directory') || 'file' })),
        savedAutoRun.forced_tools,
      );
    }, 100);
    return () => clearTimeout(timer);
  }, [savedAutoRun, autoRunEnabled]);

  const getAutoRunConfig = (): AutoRunConfig => {
    const config = autoRunInputRef.current?.getConfig();
    return {
      enabled: autoRunEnabled,
      prompt: config?.prompt ?? '',
      context_paths: config?.contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })) ?? [],
      forced_tools: (config?.forcedTools ?? []).map(({ label, tools, iconKey }) => ({ label, tools, iconKey })),
      mode: autoRunMode,
      model: autoRunModel,
    };
  };

  const handleRunPreview = async () => {
    const eid = output?.id ?? createdIdRef.current;
    if (!eid) { setExecuteResult(null); return; }
    setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: null, stderr: null, backendResult: null, error: null, source: 'execute', running: true });
    setHasNewConsoleOutput(true);
    try {
      const res = await dispatch(executeOutput({ output_id: eid, input_data: testInput })).unwrap();
      setExecuteResult(res);
      setConsoleEntry({ timestamp: Date.now(), inputData: res.input_data, stdout: res.stdout ?? null, stderr: res.stderr ?? null, backendResult: res.backend_result, error: res.error, source: 'execute' });
    } catch (e: any) {
      setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: null, stderr: null, backendResult: null, error: e?.message || 'Execution failed', source: 'execute' });
    }
  };

  const handleAutoRun = async () => {
    const config = autoRunInputRef.current?.getConfig();
    if (!config?.prompt?.trim()) return;
    setAutoRunning(true);
    let schema: Record<string, any>;
    try { schema = JSON.parse(schemaText); } catch { schema = { type: 'object', properties: {} }; }
    const forcedToolNames = config.forcedTools.flatMap((ft) => ft.tools);
    const eid = output?.id ?? createdIdRef.current;
    if (forcedToolNames.length > 0 && eid) {
      try {
        const res = await dispatch(autoRunAgentOutput({
          prompt: config.prompt, input_schema: schema, output_id: eid, model: autoRunModel,
          forced_tools: forcedToolNames,
          context_paths: config.contextPaths.map((cp) => ({ path: cp.path, type: cp.type })),
        })).unwrap();
        setAutoRunSessionId(res.session_id);
      } catch { setAutoRunning(false); }
    } else {
      try {
        const backendCode = files['backend.py'] ?? null;
        const res = await dispatch(autoRunOutput({
          prompt: config.prompt, input_schema: schema,
          backend_code: backendCode || undefined,
          context_paths: config.contextPaths.map((cp) => ({ path: cp.path, type: cp.type })),
          forced_tools: forcedToolNames.length > 0 ? forcedToolNames : undefined,
          model: autoRunModel,
        })).unwrap();
        if (res.input_data) {
          setTestInput(res.input_data);
          setExecuteResult({
            output_id: output?.id ?? createdIdRef.current ?? '', output_name: name,
            frontend_code: files['index.html'] ?? '', input_data: res.input_data,
            backend_result: res.backend_result, stdout: res.stdout ?? null,
            stderr: res.stderr ?? null, error: res.error,
          });
          setConsoleEntry({ timestamp: Date.now(), inputData: res.input_data, stdout: res.stdout ?? null, stderr: res.stderr ?? null, backendResult: res.backend_result, error: res.error, source: 'auto-run' });
          setHasNewConsoleOutput(true);
          setActiveTab(TAB_PREVIEW);
        }
      } catch {}
      setAutoRunning(false);
    }
  };

  useEffect(() => {
    if (!autoRunSessionId || !autoRunSessionStatus) return;
    if (autoRunSessionStatus !== 'completed' && autoRunSessionStatus !== 'error' && autoRunSessionStatus !== 'stopped') return;
    let extracted = false;
    for (const msg of autoRunMessages) {
      if (msg.role !== 'tool_call' || typeof msg.content !== 'object') continue;
      const tc = msg.content as { tool?: string; input?: Record<string, any> };
      if (tc.tool !== 'RenderOutput' || !tc.input?.input_data) continue;
      setTestInput(tc.input.input_data);
      setExecuteResult({
        output_id: output?.id ?? createdIdRef.current ?? '', output_name: name,
        frontend_code: files['index.html'] ?? '', input_data: tc.input.input_data,
        backend_result: null, stdout: null, stderr: null, error: null,
      });
      setConsoleEntry({ timestamp: Date.now(), inputData: tc.input.input_data, stdout: null, stderr: null, backendResult: null, error: null, source: 'agent' });
      setHasNewConsoleOutput(true);
      setActiveTab(TAB_PREVIEW);
      extracted = true;
      break;
    }
    if (!extracted && autoRunSessionStatus === 'error') {
      const lastSys = [...autoRunMessages].reverse().find((m) => m.role === 'system');
      if (lastSys) {
        const errMsg = typeof lastSys.content === 'string' ? lastSys.content : JSON.stringify(lastSys.content);
        setExecuteResult({
          output_id: output?.id ?? createdIdRef.current ?? '', output_name: name,
          frontend_code: files['index.html'] ?? '', input_data: {},
          backend_result: null, stdout: null, stderr: null, error: errMsg,
        });
        setConsoleEntry({ timestamp: Date.now(), inputData: {}, stdout: null, stderr: null, backendResult: null, error: errMsg, source: 'agent' });
        setHasNewConsoleOutput(true);
      }
    }
    setAutoRunning(false);
    cleanupAutoRunAgent(autoRunSessionId).catch(() => {});
    setTimeout(() => setAutoRunSessionId(null), 300);
  }, [autoRunSessionId, autoRunSessionStatus]);

  useEffect(() => {
    autoRunLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [autoRunMessages.length]);

  useEffect(() => {
    return () => {
      if (autoRunSessionId) cleanupAutoRunAgent(autoRunSessionId).catch(() => {});
    };
  }, [autoRunSessionId]);

  return {
    schemaText, parsedSchema, testInput, setTestInput,
    executeResult, consoleEntry,
    hasNewConsoleOutput, setHasNewConsoleOutput,
    autoRunEnabled, setAutoRunEnabled,
    autoRunMode, setAutoRunMode,
    autoRunModel, setAutoRunModel,
    autoRunning, autoRunInputRef,
    autoRunSessionId, autoRunMessages, autoRunSessionStatus,
    autoRunLogEndRef, getAutoRunConfig,
    handleRunPreview, handleAutoRun,
  };
}
