import { useState, useCallback, useEffect, useMemo } from 'react';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { API_BASE, getAuthToken } from '@/shared/config';
import { ForcedToolGroup } from '../types';
import { basename } from '../helpers';

export type SendBlock = null | {
  estimate: number;
  window: number;
  history: number;
  system: number;
  framework: number;
  files: number;
  prompt: number;
  largestFile?: { path: string; tokens: number };
};

export function useContextFiles(
  currentModelCtx: number,
  model: string,
  contextEstimate: { used: number; limit: number } | undefined,
  sessionFrameworkOverhead: number,
) {
  const [isUploading, setIsUploading] = useState(false);
  const [contextPaths, setContextPaths] = useState<ContextPath[]>([]);
  const [forcedTools, setForcedTools] = useState<ForcedToolGroup[]>([]);
  const [copiedPathIdx, setCopiedPathIdx] = useState<number | null>(null);
  const [oversizeQueue, setOversizeQueue] = useState<Array<{ path: string; name: string; tokens: number }>>([]);
  const [summarizingPath, setSummarizingPath] = useState<string | null>(null);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);
  const [sendBlock, setSendBlock] = useState<SendBlock>(null);

  const uploadAndAttachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      const resp = await fetch(`${API_BASE}/settings/upload-files`, {
        method: 'POST',
        body: formData,
      });
      if (!resp.ok) throw new Error('Upload failed');
      const data = await resp.json();
      const halfCap = Math.floor(currentModelCtx * 0.5);
      const oversize: Array<{ path: string; name: string; tokens: number }> = [];
      const newPaths: ContextPath[] = (data.files || []).map((f: { path: string; name?: string; tokens?: number; kind?: 'text' | 'pdf' | 'image' | 'binary'; media_type?: string }) => {
        const t = typeof f.tokens === 'number' ? f.tokens : 0;
        if (t > halfCap) oversize.push({ path: f.path, name: f.name || basename(f.path) || 'file', tokens: t });
        return { path: f.path, type: 'file' as const, tokens: t, kind: f.kind, media_type: f.media_type };
      });
      setContextPaths((prev) => [...prev, ...newPaths]);
      if (oversize.length > 0) setOversizeQueue((q) => [...q, ...oversize]);
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setIsUploading(false);
    }
  }, [currentModelCtx]);

  useEffect(() => {
    const halfCap = Math.floor(currentModelCtx * 0.5);
    const stillOversize: Array<{ path: string; name: string; tokens: number }> = [];
    for (const cp of contextPaths) {
      const t = cp.tokens || 0;
      if (t > halfCap) {
        const name = basename(cp.path) || cp.path;
        stillOversize.push({ path: cp.path, name, tokens: t });
      }
    }
    setOversizeQueue((q) => {
      const next = stillOversize.filter((o) => !q.find((qq) => qq.path === o.path));
      return [...q.filter((qq) => stillOversize.find((o) => o.path === qq.path)), ...next];
    });
  }, [currentModelCtx, contextPaths]);

  const detachOversize = useCallback((path: string) => {
    setContextPaths((prev) => prev.filter((cp) => cp.path !== path));
    setOversizeQueue((q) => q.filter((o) => o.path !== path));
  }, []);

  const summarizeOversize = useCallback(async (path: string) => {
    if (summarizingPath) return;  // another summarize is in flight; ignore
    setSummarizingPath(path);
    try {
      const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      const target = Math.min(8_000, Math.max(1_000, Math.floor(currentModelCtx * 0.05)));
      const resp = await fetch(`${API_BASE}/settings/summarize-file`, {
        method: 'POST', headers,
        body: JSON.stringify({ path, target_tokens: target, primary_model: model }),
      });
      if (!resp.ok) {
        let detail = `summarize failed (${resp.status})`;
        try { const j = await resp.json(); if (j?.detail) detail = String(j.detail); } catch {}
        throw new Error(detail);
      }
      const data = await resp.json();
      const newPath: string = data.path;
      const newTokens: number = data.tokens || 0;
      setContextPaths((prev) => prev.map((cp) => cp.path === path ? { ...cp, path: newPath, tokens: newTokens, kind: 'text', media_type: 'text/plain' } : cp));
      setOversizeQueue((q) => q.filter((o) => o.path !== path));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'summarize failed';
      setSummarizeError(`${msg}. Detach the file or connect an aux provider in Settings.`);
    } finally {
      setSummarizingPath(null);
    }
  }, [currentModelCtx, model, summarizingPath]);

  const pendingPayloadEstimate = useMemo(() => {
    const history = Math.max(0, contextEstimate?.used ?? 0);
    const filesSum = contextPaths.reduce((acc, cp) => acc + (cp.tokens || 0), 0);
    return history + (sessionFrameworkOverhead || 0) + filesSum;
  }, [contextEstimate, contextPaths, sessionFrameworkOverhead]);

  const pendingKinds = useMemo(() => {
    const set = new Set<string>();
    for (const cp of contextPaths) {
      if (cp.kind) set.add(cp.kind);
    }
    return set;
  }, [contextPaths]);

  return {
    isUploading,
    contextPaths, setContextPaths,
    forcedTools, setForcedTools,
    copiedPathIdx, setCopiedPathIdx,
    oversizeQueue,
    summarizingPath,
    summarizeError, setSummarizeError,
    sendBlock, setSendBlock,
    uploadAndAttachFiles,
    detachOversize,
    summarizeOversize,
    pendingPayloadEstimate,
    pendingKinds,
  };
}
