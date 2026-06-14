// Shared types for the .swarm share/import UI. The *Response shapes mirror the
// backend pydantic models in backend/apps/swarm/models.py; keep them in sync.

export type ShareKind = 'skill' | 'app' | 'workflow' | 'dashboard';

export interface ShareTarget {
  kind: ShareKind;
  id: string;
  name: string;
}

export interface IncludeItem {
  type: string;
  name: string;
  detail?: string;
}

export interface RequirementView {
  kind: string;
  key: string;
  label: string;
  detail?: string;
}

export interface BundleSummary {
  root: IncludeItem;
  includes: IncludeItem[];
  requirements: RequirementView[];
  counts: Record<string, number>;
}

export interface ExportPreflight {
  ok: boolean;
  summary: BundleSummary;
  filename: string;
  link_supported: boolean;
}

export interface ReviewSummary {
  verdict: 'clean' | 'warn' | 'block';
  findings: string[];
  scanned_files: string[];
}

export interface ImportPreflight {
  ok: boolean;
  summary: BundleSummary;
  staging_token: string;
  conflicts: IncludeItem[];
  review?: ReviewSummary | null;
  warnings: string[];
}

export interface ImportCommitResult {
  ok: boolean;
  root_type: ShareKind;
  root_id: string;
  created: Record<string, string[]>;
  unresolved_requirements: RequirementView[];
}
