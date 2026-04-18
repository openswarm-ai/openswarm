export interface RichPromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
}

export const LINE_HEIGHT = 1.5;
export const FONT_SIZE = 0.85;
