export const POLL_INTERVAL_MS = 2000;

export const MIN_W = 320;
export const MAX_W = 700;
export const MIN_H = 300;
export const MAX_H = 900;

export interface SkillPreviewData {
  name: string;
  description: string;
  command: string;
  content: string;
}

export interface SkillBuilderChatProps {
  onSkillPreview: (data: SkillPreviewData | null) => void;
  onSkillSaved: (message: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}
