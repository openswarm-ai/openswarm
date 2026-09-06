import React from 'react';
import type { ZodType } from 'zod';
import './toolui.css';

/** One vendored tool-ui component: a loader for the renderer + the upstream Serializable wire schema. */
export interface ToolUiEntry {
  load: () => Promise<React.ComponentType<any>>;
  loadSchema: () => Promise<ZodType<any>>;
}

/* Every entry lazy-loads both the component and its zod contract so the chat bundle only pays
   for components a transcript actually uses. Names mirror upstream tool-ui component slugs. */
// The social-post components take their data nested as {post}; the wire props ARE the post.
// onOpen is the component's own top-level prop, not part of the post payload; nesting it made every post unclickable (ENG-234).
function wrapAsPost<P extends { id?: unknown }>(Inner: React.ComponentType<{ post: P; onOpen?: () => void }>): React.ComponentType<P & { onOpen?: () => void }> {
  return function PostAdapter(props: P & { onOpen?: () => void }) {
    const { onOpen, ...post } = props;
    return <Inner post={post as unknown as P} onOpen={onOpen} />;
  };
}

export const TOOL_UI_REGISTRY: Record<string, ToolUiEntry> = {
  'audio': {
    load: () => import('./components/audio').then((m) => m.Audio),
    loadSchema: () => import('./components/audio/schema').then((m) => m.SerializableAudioSchema),
  },
  'chart': {
    load: () => import('./components/chart').then((m) => m.Chart),
    loadSchema: () => import('./components/chart/schema').then((m) => m.SerializableChartSchema),
  },
  'code-block': {
    load: () => import('./components/code-block').then((m) => m.CodeBlock),
    loadSchema: () => import('./components/code-block/schema').then((m) => m.SerializableCodeBlockSchema),
  },
  'code-diff': {
    load: () => import('./components/code-diff').then((m) => m.CodeDiff),
    loadSchema: () => import('./components/code-diff/schema').then((m) => m.SerializableCodeDiffSchema),
  },
  'geo-map': {
    load: () => import('./components/geo-map').then((m) => m.GeoMap),
    loadSchema: () => import('./components/geo-map/schema').then((m) => m.SerializableGeoMapSchema),
  },
  'approval-card': {
    load: () => import('./components/approval-card').then((m) => m.ApprovalCard),
    loadSchema: () => import('./components/approval-card/schema').then((m) => m.SerializableApprovalCardSchema),
  },
  'citation': {
    load: () => import('./components/citation').then((m) => m.Citation),
    loadSchema: () => import('./components/citation/schema').then((m) => m.SerializableCitationSchema),
  },
  'data-table': {
    // Force the real grid (.Table) instead of the responsive default: every chat surface we render
    // into (card ~380px, fullscreen column ~442px) sits just under the component's @md breakpoint,
    // so "auto" always fell back to the mobile accordion that buries every column but the first.
    load: () => import('./components/data-table').then((m) => m.DataTable.Table),
    loadSchema: () => import('./components/data-table/schema').then((m) => m.SerializableDataTableSchema),
  },
  'image': {
    load: () => import('./components/image').then((m) => m.Image),
    loadSchema: () => import('./components/image/schema').then((m) => m.SerializableImageSchema),
  },
  'image-gallery': {
    load: () => import('./components/image-gallery').then((m) => m.ImageGallery),
    loadSchema: () => import('./components/image-gallery/schema').then((m) => m.SerializableImageGallerySchema),
  },
  'instagram-post': {
    load: () => import('./components/instagram-post').then((m) => wrapAsPost(m.InstagramPost)),
    loadSchema: () => import('./components/instagram-post/schema').then((m) => m.SerializableInstagramPostSchema),
  },
  'item-carousel': {
    load: () => import('./components/item-carousel').then((m) => m.ItemCarousel),
    loadSchema: () => import('./components/item-carousel/schema').then((m) => m.SerializableItemCarouselSchema),
  },
  'link-preview': {
    load: () => import('./components/link-preview').then((m) => m.LinkPreview),
    loadSchema: () => import('./components/link-preview/schema').then((m) => m.SerializableLinkPreviewSchema),
  },
  'linkedin-post': {
    load: () => import('./components/linkedin-post').then((m) => wrapAsPost(m.LinkedInPost)),
    loadSchema: () => import('./components/linkedin-post/schema').then((m) => m.SerializableLinkedInPostSchema),
  },
  'message-draft': {
    load: () => import('./components/message-draft').then((m) => m.MessageDraft),
    loadSchema: () => import('./components/message-draft/schema').then((m) => m.SerializableEmailDraftSchema),
  },
  'option-list': {
    load: () => import('./components/option-list').then((m) => m.OptionList),
    loadSchema: () => import('./components/option-list/schema').then((m) => m.SerializableOptionListSchema),
  },
  'order-summary': {
    load: () => import('./components/order-summary').then((m) => m.OrderSummary),
    loadSchema: () => import('./components/order-summary/schema').then((m) => m.SerializableOrderSummarySchema),
  },
  'parameter-slider': {
    load: () => import('./components/parameter-slider').then((m) => m.ParameterSlider),
    loadSchema: () => import('./components/parameter-slider/schema').then((m) => m.SerializableParameterSliderSchema),
  },
  'plan': {
    load: () => import('./components/plan').then((m) => m.Plan),
    loadSchema: () => import('./components/plan/schema').then((m) => m.SerializablePlanSchema),
  },
  'preferences-panel': {
    load: () => import('./components/preferences-panel').then((m) => m.PreferencesPanel),
    loadSchema: () => import('./components/preferences-panel/schema').then((m) => m.SerializablePreferencesPanelSchema),
  },
  'progress-tracker': {
    load: () => import('./components/progress-tracker').then((m) => m.ProgressTracker),
    loadSchema: () => import('./components/progress-tracker/schema').then((m) => m.SerializableProgressTrackerSchema),
  },
  'question-flow': {
    load: () => import('./components/question-flow').then((m) => m.QuestionFlow),
    // The full union: progressive (step/title), upfront (steps[]), and receipt modes are all valid wire shapes.
    loadSchema: () => import('./components/question-flow/schema').then((m) => m.SerializableQuestionFlowSchema),
  },
  'stats-display': {
    load: () => import('./components/stats-display').then((m) => m.StatsDisplay),
    loadSchema: () => import('./components/stats-display/schema').then((m) => m.SerializableStatsDisplaySchema),
  },
  'terminal': {
    load: () => import('./components/terminal').then((m) => m.Terminal),
    loadSchema: () => import('./components/terminal/schema').then((m) => m.SerializableTerminalSchema),
  },
  'video': {
    load: () => import('./components/video').then((m) => m.Video),
    loadSchema: () => import('./components/video/schema').then((m) => m.SerializableVideoSchema),
  },
  'x-post': {
    load: () => import('./components/x-post').then((m) => wrapAsPost(m.XPost)),
    loadSchema: () => import('./components/x-post/schema').then((m) => m.SerializableXPostSchema),
  },
};

export function isToolUiComponent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_UI_REGISTRY, name);
}

let warmed = false;
/** Warm every widget chunk and schema once the page is idle, so the first ShowUI in a chat mounts as content rather than a skeleton; a failed warm is silent and the widget's own mount retries it. */
export function preloadToolUi(): void {
  if (warmed) return;
  warmed = true;
  const run = (): void => {
    for (const e of Object.values(TOOL_UI_REGISTRY)) {
      e.load().catch(() => {});
      e.loadSchema().catch(() => {});
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

