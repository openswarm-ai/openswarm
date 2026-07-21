/* Generates terse per-component prop hints for the ShowUI tool description straight from the
   vendored tool-ui zod contracts, so the server spec can never drift from what validates.
   Run: npx tsx --tsconfig tsconfig.json scripts/gen-toolui-hints.ts */
import { z } from 'zod';

const TARGETS: Record<string, [string, string]> = {
  'approval-card': ['../src/toolui/components/approval-card/schema', 'SerializableApprovalCardSchema'],
  'audio': ['../src/toolui/components/audio/schema', 'SerializableAudioSchema'],
  'chart': ['../src/toolui/components/chart/schema', 'SerializableChartSchema'],
  'citation': ['../src/toolui/components/citation/schema', 'SerializableCitationSchema'],
  'code-block': ['../src/toolui/components/code-block/schema', 'SerializableCodeBlockSchema'],
  'code-diff': ['../src/toolui/components/code-diff/schema', 'SerializableCodeDiffSchema'],
  'data-table': ['../src/toolui/components/data-table/schema', 'SerializableDataTableSchema'],
  'geo-map': ['../src/toolui/components/geo-map/schema', 'SerializableGeoMapSchema'],
  'image': ['../src/toolui/components/image/schema', 'SerializableImageSchema'],
  'image-gallery': ['../src/toolui/components/image-gallery/schema', 'SerializableImageGallerySchema'],
  'instagram-post': ['../src/toolui/components/instagram-post/schema', 'SerializableInstagramPostSchema'],
  'item-carousel': ['../src/toolui/components/item-carousel/schema', 'SerializableItemCarouselSchema'],
  'link-preview': ['../src/toolui/components/link-preview/schema', 'SerializableLinkPreviewSchema'],
  'linkedin-post': ['../src/toolui/components/linkedin-post/schema', 'SerializableLinkedInPostSchema'],
  'message-draft': ['../src/toolui/components/message-draft/schema', 'SerializableEmailDraftSchema'],
  'option-list': ['../src/toolui/components/option-list/schema', 'SerializableOptionListSchema'],
  'order-summary': ['../src/toolui/components/order-summary/schema', 'SerializableOrderSummarySchema'],
  'parameter-slider': ['../src/toolui/components/parameter-slider/schema', 'SerializableParameterSliderSchema'],
  'plan': ['../src/toolui/components/plan/schema', 'SerializablePlanSchema'],
  'preferences-panel': ['../src/toolui/components/preferences-panel/schema', 'SerializablePreferencesPanelSchema'],
  'progress-tracker': ['../src/toolui/components/progress-tracker/schema', 'SerializableProgressTrackerSchema'],
  'question-flow': ['../src/toolui/components/question-flow/schema', 'SerializableProgressiveModeSchema'],
  'stats-display': ['../src/toolui/components/stats-display/schema', 'SerializableStatsDisplaySchema'],
  'terminal': ['../src/toolui/components/terminal/schema', 'SerializableTerminalSchema'],
  'video': ['../src/toolui/components/video/schema', 'SerializableVideoSchema'],
  'x-post': ['../src/toolui/components/x-post/schema', 'SerializableXPostSchema'],
};

function describe(node: any, depth: number): string {
  if (!node || typeof node !== 'object') return 'any';
  if (Array.isArray(node.enum)) return node.enum.map((v: unknown) => `'${v}'`).join('|');
  if (Array.isArray(node.anyOf)) return node.anyOf.map((n: any) => describe(n, depth)).join('|');
  const t = node.type;
  if (t === 'array') return `[${describe(node.items, depth)}]`;
  if (t === 'object') {
    if (depth >= 2) return 'obj';
    const req = new Set(node.required || []);
    const props = node.properties || {};
    // Required props FIRST so tail truncation can only ever cost optional detail, never a required field.
    const keys = Object.keys(props).sort((a, b) => Number(req.has(b)) - Number(req.has(a)));
    const parts = keys.map((k) => `${k}${req.has(k) ? '' : '?'}: ${describe(props[k], depth + 1)}`);
    return `{${parts.join(', ')}}`;
  }
  if (t === 'string') return 'str';
  if (t === 'number' || t === 'integer') return 'num';
  if (t === 'boolean') return 'bool';
  return 'any';
}

async function main(): Promise<void> {
  const fs = await import('fs');
  const out: Record<string, { hint: string; schema: unknown }> = {};
  for (const [name, [path, exportName]] of Object.entries(TARGETS)) {
    const mod = await import(path);
    const schema = mod[exportName];
    const js = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' } as any) as any;
    let hint = describe(js, 0);
    if (hint.length > 420) hint = hint.slice(0, 417) + '...';
    out[name] = { hint: `props: ${hint.replace(/"/g, "'")}`, schema: js };
  }
  const dest = new URL('../../backend/apps/agents/toolui_schemas.json', import.meta.url).pathname;
  fs.writeFileSync(dest, JSON.stringify(out, null, 1));
  console.log(`wrote ${Object.keys(out).length} component schemas to ${dest}`);
}

void main();
