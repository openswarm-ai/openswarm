import React from 'react';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';

export const ICON_MAP: Record<string, React.ReactNode> = {
  smart_toy: <SmartToyOutlinedIcon sx={{ fontSize: 14 }} />,
  question_answer: <QuestionAnswerOutlinedIcon sx={{ fontSize: 14 }} />,
  map: <MapOutlinedIcon sx={{ fontSize: 14 }} />,
  category: <CategoryOutlinedIcon sx={{ fontSize: 14 }} />,
  tune: <TuneOutlinedIcon sx={{ fontSize: 14 }} />,
};

export const FALLBACK_MODE_BASE = { label: 'Agent', icon: ICON_MAP.smart_toy };
