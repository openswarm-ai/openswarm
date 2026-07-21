import React, { lazy } from 'react';
import type { ZodType } from 'zod';
import './toolui.css';

/** One vendored tool-ui component: lazy renderer + the upstream Serializable wire schema. */
export interface ToolUiEntry {
  Component: React.LazyExoticComponent<React.ComponentType<any>>;
  loadSchema: () => Promise<ZodType<any>>;
}

/* Every entry lazy-loads both the component and its zod contract so the chat bundle only pays
   for components a transcript actually uses. Names mirror upstream tool-ui component slugs. */
// The social-post components take their data nested as {post}; the wire props ARE the post.
function wrapAsPost<P extends { id?: unknown }>(Inner: React.ComponentType<{ post: P }>): React.ComponentType<P> {
  return function PostAdapter(props: P) {
    return <Inner post={props} />;
  };
}

export const TOOL_UI_REGISTRY: Record<string, ToolUiEntry> = {
  'audio': {
    Component: lazy(() => import('./components/audio').then((m) => ({ default: m.Audio }))),
    loadSchema: () => import('./components/audio/schema').then((m) => m.SerializableAudioSchema),
  },
  'chart': {
    Component: lazy(() => import('./components/chart').then((m) => ({ default: m.Chart }))),
    loadSchema: () => import('./components/chart/schema').then((m) => m.SerializableChartSchema),
  },
  'code-block': {
    Component: lazy(() => import('./components/code-block').then((m) => ({ default: m.CodeBlock }))),
    loadSchema: () => import('./components/code-block/schema').then((m) => m.SerializableCodeBlockSchema),
  },
  'code-diff': {
    Component: lazy(() => import('./components/code-diff').then((m) => ({ default: m.CodeDiff }))),
    loadSchema: () => import('./components/code-diff/schema').then((m) => m.SerializableCodeDiffSchema),
  },
  'geo-map': {
    Component: lazy(() => import('./components/geo-map').then((m) => ({ default: m.GeoMap }))),
    loadSchema: () => import('./components/geo-map/schema').then((m) => m.SerializableGeoMapSchema),
  },
  'approval-card': {
    Component: lazy(() => import('./components/approval-card').then((m) => ({ default: m.ApprovalCard }))),
    loadSchema: () => import('./components/approval-card/schema').then((m) => m.SerializableApprovalCardSchema),
  },
  'citation': {
    Component: lazy(() => import('./components/citation').then((m) => ({ default: m.Citation }))),
    loadSchema: () => import('./components/citation/schema').then((m) => m.SerializableCitationSchema),
  },
  'data-table': {
    Component: lazy(() => import('./components/data-table').then((m) => ({ default: m.DataTable }))),
    loadSchema: () => import('./components/data-table/schema').then((m) => m.SerializableDataTableSchema),
  },
  'image': {
    Component: lazy(() => import('./components/image').then((m) => ({ default: m.Image }))),
    loadSchema: () => import('./components/image/schema').then((m) => m.SerializableImageSchema),
  },
  'image-gallery': {
    Component: lazy(() => import('./components/image-gallery').then((m) => ({ default: m.ImageGallery }))),
    loadSchema: () => import('./components/image-gallery/schema').then((m) => m.SerializableImageGallerySchema),
  },
  'instagram-post': {
    Component: lazy(() => import('./components/instagram-post').then((m) => ({ default: wrapAsPost(m.InstagramPost) }))),
    loadSchema: () => import('./components/instagram-post/schema').then((m) => m.SerializableInstagramPostSchema),
  },
  'item-carousel': {
    Component: lazy(() => import('./components/item-carousel').then((m) => ({ default: m.ItemCarousel }))),
    loadSchema: () => import('./components/item-carousel/schema').then((m) => m.SerializableItemCarouselSchema),
  },
  'link-preview': {
    Component: lazy(() => import('./components/link-preview').then((m) => ({ default: m.LinkPreview }))),
    loadSchema: () => import('./components/link-preview/schema').then((m) => m.SerializableLinkPreviewSchema),
  },
  'linkedin-post': {
    Component: lazy(() => import('./components/linkedin-post').then((m) => ({ default: wrapAsPost(m.LinkedInPost) }))),
    loadSchema: () => import('./components/linkedin-post/schema').then((m) => m.SerializableLinkedInPostSchema),
  },
  'message-draft': {
    Component: lazy(() => import('./components/message-draft').then((m) => ({ default: m.MessageDraft }))),
    loadSchema: () => import('./components/message-draft/schema').then((m) => m.SerializableEmailDraftSchema),
  },
  'option-list': {
    Component: lazy(() => import('./components/option-list').then((m) => ({ default: m.OptionList }))),
    loadSchema: () => import('./components/option-list/schema').then((m) => m.SerializableOptionListSchema),
  },
  'order-summary': {
    Component: lazy(() => import('./components/order-summary').then((m) => ({ default: m.OrderSummary }))),
    loadSchema: () => import('./components/order-summary/schema').then((m) => m.SerializableOrderSummarySchema),
  },
  'parameter-slider': {
    Component: lazy(() => import('./components/parameter-slider').then((m) => ({ default: m.ParameterSlider }))),
    loadSchema: () => import('./components/parameter-slider/schema').then((m) => m.SerializableParameterSliderSchema),
  },
  'plan': {
    Component: lazy(() => import('./components/plan').then((m) => ({ default: m.Plan }))),
    loadSchema: () => import('./components/plan/schema').then((m) => m.SerializablePlanSchema),
  },
  'preferences-panel': {
    Component: lazy(() => import('./components/preferences-panel').then((m) => ({ default: m.PreferencesPanel }))),
    loadSchema: () => import('./components/preferences-panel/schema').then((m) => m.SerializablePreferencesPanelSchema),
  },
  'progress-tracker': {
    Component: lazy(() => import('./components/progress-tracker').then((m) => ({ default: m.ProgressTracker }))),
    loadSchema: () => import('./components/progress-tracker/schema').then((m) => m.SerializableProgressTrackerSchema),
  },
  'question-flow': {
    Component: lazy(() => import('./components/question-flow').then((m) => ({ default: m.QuestionFlow }))),
    loadSchema: () => import('./components/question-flow/schema').then((m) => m.SerializableProgressiveModeSchema),
  },
  'stats-display': {
    Component: lazy(() => import('./components/stats-display').then((m) => ({ default: m.StatsDisplay }))),
    loadSchema: () => import('./components/stats-display/schema').then((m) => m.SerializableStatsDisplaySchema),
  },
  'terminal': {
    Component: lazy(() => import('./components/terminal').then((m) => ({ default: m.Terminal }))),
    loadSchema: () => import('./components/terminal/schema').then((m) => m.SerializableTerminalSchema),
  },
  'video': {
    Component: lazy(() => import('./components/video').then((m) => ({ default: m.Video }))),
    loadSchema: () => import('./components/video/schema').then((m) => m.SerializableVideoSchema),
  },
  'x-post': {
    Component: lazy(() => import('./components/x-post').then((m) => ({ default: wrapAsPost(m.XPost) }))),
    loadSchema: () => import('./components/x-post/schema').then((m) => m.SerializableXPostSchema),
  },
};

export function isToolUiComponent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_UI_REGISTRY, name);
}
