import React from 'react';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';

export interface AttachedImage {
  data: string;
  media_type: string;
  preview: string;
  // Set when preview uses createObjectURL; handleSend reads via FileReader to avoid retaining base64 in memory.
  _file?: File;
}

export interface ForcedToolGroup {
  label: string;
  tools: string[];
  icon?: React.ReactNode;
  iconKey?: string;
}

export interface ChatInputHandle {
  getConfig: () => { prompt: string; contextPaths: ContextPath[]; forcedTools: ForcedToolGroup[] };
  setContent: (prompt: string, contextPaths?: ContextPath[], forcedTools?: ForcedToolGroup[]) => void;
}
