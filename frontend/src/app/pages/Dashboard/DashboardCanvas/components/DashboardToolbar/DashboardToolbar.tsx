import React, { useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import OpenSwarmComposer from '@/app/pages/AgentChat/OpenSwarmComposer/OpenSwarmComposer';
import { useStandaloneComposerRuntime } from '@/app/pages/AgentChat/runtime/useStandaloneComposerRuntime';
import type { ComposerExtras, DispatchableMessage } from '@/app/pages/AgentChat/runtime/useOpenSwarmRuntime';
import { useDashboardToolbar, TOOLBAR_OWNER_ID, ToolbarProps } from './useDashboardToolbar';
import HistoryPanel from './components/HistoryPanel';
import ViewPickerPanel from './components/ViewPickerPanel';
import ToolbarButtons from './components/ToolbarButtons/ToolbarButtons';

// TODO: pull this out into a separate file or idk do smthn else but not this
const ToolbarComposer: React.FC<{
  mode: string; onModeChange: (mode: string) => void;
  model: string; onModelChange: (model: string) => void;
  onSend: (
    message: string,
    images?: Array<{ data: string; media_type: string }>,
    contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>,
    forcedTools?: string[],
    attachedSkills?: Array<{ id: string; name: string; content: string }>,
    selectedBrowserIds?: string[],
  ) => void;
}> = ({ mode, onModeChange, model, onModelChange, onSend }) => {
  const composerExtrasRef = useRef<ComposerExtras>({});
  const dispatch = useCallback(
    (msg: DispatchableMessage) => {
      onSend(msg.prompt, msg.images, msg.contextPaths, msg.forcedTools, msg.attachedSkills, msg.selectedBrowserIds);
    },
    [onSend],
  );
  const runtime = useStandaloneComposerRuntime(composerExtrasRef, dispatch);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <OpenSwarmComposer
        composerExtrasRef={composerExtrasRef}
        mode={mode}
        onModeChange={onModeChange}
        model={model}
        onModelChange={onModelChange}
        embedded
        autoFocus
        sessionId={TOOLBAR_OWNER_ID}
      />
    </AssistantRuntimeProvider>
  );
};

const DashboardToolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(
  ({ inputOpen, onNewAgent, onCancel, onSend, onAddView, onHistoryResume, onAddBrowser, dashboardId }, ref) => {
    const {
      c, containerRef, searchInputRef, historyInputRef, historyListRef,
      mode, setMode, model, setModel,
      viewPickerOpen, viewSearch, setViewSearch,
      historyOpen, historyQuery, setHistoryQuery,
      historySearch, outputList, filteredOutputs,
      shortcutLabel, isExpanded,
      handleSend, handleSelectView,
      handleOpenViewPicker, handleOpenHistory,
      handleHistorySelect, handleHistoryScroll,
    } = useDashboardToolbar({
      inputOpen, onCancel, onSend, onAddView, onHistoryResume, onAddBrowser, dashboardId,
    });

    React.useImperativeHandle(ref, () => containerRef.current!, []);

    return (
      <motion.div
        ref={containerRef}
        layout
        transition={{ layout: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] } }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: c.bg.surface,
          border: `1px solid ${c.border.subtle}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: c.shadow.lg,
          padding: isExpanded ? '4px' : '6px',
          userSelect: 'none' as const,
          overflow: inputOpen ? 'visible' : 'hidden',
          width: viewPickerOpen ? 480 : isExpanded ? 360 : undefined,
        }}
      >
        {inputOpen ? (
          <div style={{ width: '100%', minHeight: 44, paddingBottom: 0, marginBottom: -4 }}>
            <ToolbarComposer
              mode={mode}
              onModeChange={setMode}
              model={model}
              onModelChange={setModel}
              onSend={handleSend}
            />
          </div>
        ) : historyOpen ? (
          <HistoryPanel
            historyInputRef={historyInputRef}
            historyListRef={historyListRef}
            historyQuery={historyQuery}
            onQueryChange={setHistoryQuery}
            historySearch={historySearch}
            onScroll={handleHistoryScroll}
            onSelect={handleHistorySelect}
            c={c}
          />
        ) : viewPickerOpen ? (
          <ViewPickerPanel
            searchInputRef={searchInputRef}
            viewSearch={viewSearch}
            onSearchChange={setViewSearch}
            filteredOutputs={filteredOutputs}
            outputList={outputList}
            onSelect={handleSelectView}
            c={c}
          />
        ) : (
          <ToolbarButtons
            onNewAgent={onNewAgent}
            onOpenViewPicker={handleOpenViewPicker}
            onAddBrowser={onAddBrowser}
            onOpenHistory={handleOpenHistory}
            shortcutLabel={shortcutLabel}
            c={c}
          />
        )}
      </motion.div>
    );
  },
);

DashboardToolbar.displayName = 'DashboardToolbar';

export default DashboardToolbar;
