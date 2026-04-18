import React from 'react';
import ChatInput from '@/app/pages/AgentChat/ChatInput/ChatInput';
import type { Props } from './toolbarShared';
import { MotionBox, TOOLBAR_OWNER_ID } from './toolbarShared';
import { useDashboardToolbar } from './useDashboardToolbar';
import HistoryPanel from './HistoryPanel';
import ViewPickerPanel from './ViewPickerPanel';
import ToolbarButtons from './ToolbarButtons';

const DashboardToolbar = React.forwardRef<HTMLDivElement, Props>(
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
      <MotionBox
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
            <ChatInput
              onSend={handleSend}
              mode={mode}
              onModeChange={setMode}
              model={model}
              onModelChange={setModel}
              embedded
              autoFocus
              sessionId={TOOLBAR_OWNER_ID}
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
      </MotionBox>
    );
  },
);

DashboardToolbar.displayName = 'DashboardToolbar';

export default DashboardToolbar;
