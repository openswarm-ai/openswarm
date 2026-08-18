import React from 'react';
import Box from '@mui/material/Box';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { RenderItem } from '../tool-bubbles/ToolGroupBubble';
import type { MessageScrollApi } from './useMessageScroll';
import { ScrollToBottomButton } from './ScrollToBottomButton';

// Full size view reads like a chat page, not a card: the transcript + composer center in one
// column at a comfortable measure (assistant-ui parks at 44rem, LibreChat 48rem; 760 splits them).
export const FULLSCREEN_READING_MAX_W = 760;

// The transcript's scroll surface (AGENTCHAT_SPLIT_PLAN step 6: MessageListBody + spacers move with the
// scroll mechanism). Owns the scroll container, the top/bottom spacers that stand in for unmounted
// items, the data-window-item-id wrapper each mounted item is measured through, the lastVisibleItemRef
// used by the initial bottom pin, and the scroll-to-bottom button. Domain content stays with the
// caller: `renderItem` renders a transcript item's inner content, `renderItemTrailer` renders an
// optional sibling AFTER the measured wrapper (the docked-browser slot), `header`/`footer` are slots
// for the non-windowed content above/below the item window (overflow card / streaming bubble cluster).
export function MessageListBody({
  scroll,
  c,
  fullscreenChat,
  isWelcomeDraft,
  header,
  footer,
  renderItem,
  renderItemTrailer,
}: {
  scroll: MessageScrollApi;
  c: ReturnType<typeof useClaudeTokens>;
  fullscreenChat?: boolean;
  isWelcomeDraft?: boolean;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  renderItem: (item: RenderItem, ctx: { isLastVisibleItem: boolean }) => React.ReactNode;
  renderItemTrailer?: (item: RenderItem) => React.ReactNode;
}) {
  return (
    <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <Box
        ref={scroll.scrollContainerRef}
        onScroll={scroll.onScroll}
        // Right-clicking transcript CONTENT gets the OS text menu (copy, spellcheck), never the card menu with Delete chat in it.
        data-chat-transcript
        sx={{
          height: '100%',
          overflow: 'auto',
          scrollbarGutter: 'stable',
          // Top-aligned natural flow: messages start at the top and grow down (standard chat). The earlier flex-column + mt:auto bottom-anchor clustered short chats at the bottom under a big void, reading broken.
          px: 2,
          py: 1,
          // Fullscreen: the scroller breaks OUT of the reading column so its scrollbar rides the window edge; matching padding keeps the content at the 760px measure.
          ...(fullscreenChat && {
            mr: `min(0px, calc((${FULLSCREEN_READING_MAX_W}px - 100vw) / 2))`,
            pr: `max(16px, calc((100vw - ${FULLSCREEN_READING_MAX_W}px) / 2))`,
          }),
          // Smoothness bundle (perf-only, no behavior change): 1. overflow-anchor: auto, Chromium's native scroll anchoring keeps the viewport pinned to the user's visible content as siblings above/below resize. Eliminates the "transcript snaps back" feel during streaming and parallel tool fan-outs. Runs on the compositor thread, free. 2. contain: layout, tells the browser layout shifts inside this scroll container don't affect siblings outside it. Prevents reflow from cascading up to the dashboard layout when bubbles grow. 3. overscroll-behavior: contain, keeps over-scroll gestures from leaking up to the dashboard pan/zoom when the user hits the chat top/bottom.
          overflowAnchor: 'auto',
          contain: 'layout',
          overscrollBehavior: 'contain',
          // Hidden until the user is in the chat: the thumb is transparent at rest and fades in on hover, so a resizing thumb never draws the eye.
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: 'transparent',
            borderRadius: 3,
            minHeight: 48,
            transition: 'background 0.2s',
          },
          '&:hover::-webkit-scrollbar-thumb': { background: c.border.medium },
          '&:hover::-webkit-scrollbar-thumb:hover': { background: c.border.strong },
          scrollbarWidth: 'thin',
          scrollbarColor: 'transparent transparent',
          '&:hover': { scrollbarColor: `${c.border.medium} transparent` },
        }}
      >
        {/* The welcome greeting is the FIRST thing and it's the agent talking, no user message above it, so give it real air under the header instead of sitting flush at the top. */}
        {/* Non-welcome chats still need headroom: at pt 0 the first user bubble's top edge clipped under the header. */}
        {/* Fullscreen carries the window title bar OVER the transcript, so the first message (and any attachment chips above it) needs to start below that chrome, not under it. */}
        <Box sx={{ pt: fullscreenChat ? 7 : isWelcomeDraft ? 4 : 2 }}>
          {header}
          {/* Stand-in for items unmounted ABOVE the window. Its measured
              height keeps the scrollbar geometry and scroll position stable
              while overflow-anchor pins the visible content. */}
          {scroll.topSpacerHeight > 0 && (
            <Box aria-hidden data-window-spacer="top" sx={{ height: scroll.topSpacerHeight, flexShrink: 0, overflowAnchor: 'none' }} />
          )}
          {scroll.renderedVisibleItems.map((item, itemIdx) => {
            const isLastVisibleItem = itemIdx === scroll.renderedVisibleItems.length - 1;
            const rendered = (
              <Box key={item.id} data-window-item-id={item.id} ref={isLastVisibleItem ? scroll.lastVisibleItemRef : undefined}>
                {renderItem(item, { isLastVisibleItem })}
              </Box>
            );
            const trailer = renderItemTrailer?.(item);
            if (!trailer) return rendered;
            // The trailer rides OUTSIDE the measured wrapper (it is not transcript content), as a keyed sibling.
            return (
              <React.Fragment key={`${item.id}-with-trailer`}>
                {rendered}
                {trailer}
              </React.Fragment>
            );
          })}
          {/* Stand-in for items unmounted BELOW the window (newer items not yet
              scrolled into view). Zero while following the live tail. */}
          {scroll.bottomSpacerHeight > 0 && (
            <Box aria-hidden data-window-spacer="bottom" sx={{ height: scroll.bottomSpacerHeight, flexShrink: 0, overflowAnchor: 'none' }} />
          )}
          {footer}
        </Box>
      </Box>
      <ScrollToBottomButton visible={scroll.showScrollButton} onScrollToBottom={scroll.scrollToBottom} c={c} />
    </Box>
  );
}
