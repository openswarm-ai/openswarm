import React from 'react';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';

export interface CommandPickerItem {
  id: string;
  type: 'skill' | 'mode' | 'context';
  category: string;
  name: string;
  description: string;
  command: string;
  icon: React.ReactNode;
  toolNames?: string[];
  iconKey?: string;
}

export interface CommandPickerProps {
  trigger: '/' | '@';
  filter: string;
  onSelect: (item: CommandPickerItem) => void;
  onClose: () => void;
  visible: boolean;
}

export const MODE_ICON_MAP: Record<string, React.ComponentType<{ sx?: object }>> = {
  smart_toy: SmartToyOutlinedIcon,
  question_answer: QuestionAnswerOutlinedIcon,
  map: MapOutlinedIcon,
  category: CategoryOutlinedIcon,
  tune: TuneOutlinedIcon,
};

export function highlightMatch(text: string, query: string, color: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color, fontWeight: 600 }}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}
