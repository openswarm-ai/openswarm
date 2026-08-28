import React, { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import SendIcon from '@mui/icons-material/Send';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import { ApprovalRequest } from '@/shared/state/agentsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

function getOptionKey(opt: any): string {
  return opt.id || opt.value || opt.label || opt.text || String(opt);
}

function getOptionLabel(opt: any): string {
  return opt.label || opt.value || opt.text || String(opt);
}

type Answers = Record<number, string | string[]>;

export interface QuestionFormProps {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>, trustPattern?: boolean, alwaysAllow?: boolean) => void;
  onDeny: (requestId: string, message?: string) => void;
  compact?: boolean;
}

const OTHER_KEY = '__other__';

const QuestionForm: React.FC<QuestionFormProps> = ({ request, onApprove, onDeny, compact }) => {
  const c = useClaudeTokens();
  const questions: any[] = request.tool_input.questions || [];
  const [answers, setAnswers] = useState<Answers>(() => {
    const init: Answers = {};
    questions.forEach((q: any, i: number) => {
      init[i] = q.multiSelect ? [] : '';
    });
    return init;
  });
  const [otherActive, setOtherActive] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  const toggleOption = useCallback((qIdx: number, key: string, multi: boolean) => {
    setAnswers((prev) => {
      const copy = { ...prev };
      if (multi) {
        const arr = Array.isArray(copy[qIdx]) ? [...(copy[qIdx] as string[])] : [];
        const idx = arr.indexOf(key);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(key);
        copy[qIdx] = arr;
      } else {
        copy[qIdx] = copy[qIdx] === key ? '' : key;
      }
      return copy;
    });
    if (key !== OTHER_KEY) {
      if (!multi) {
        setOtherActive((prev) => ({ ...prev, [qIdx]: false }));
        setOtherText((prev) => ({ ...prev, [qIdx]: '' }));
      }
    }
  }, []);

  const toggleOther = useCallback((qIdx: number, multi: boolean) => {
    setOtherActive((prev) => {
      const wasActive = !!prev[qIdx];
      if (wasActive) {
        setOtherText((p) => ({ ...p, [qIdx]: '' }));
      }
      if (!multi && !wasActive) {
        setAnswers((p) => ({ ...p, [qIdx]: '' }));
      }
      return { ...prev, [qIdx]: !wasActive };
    });
  }, []);

  const setTextAnswer = useCallback((qIdx: number, text: string) => {
    setAnswers((prev) => ({ ...prev, [qIdx]: text }));
  }, []);

  const handleSubmit = () => {
    const answersDict: Record<string, string> = {};
    questions.forEach((q: any, i: number) => {
      const questionText = q.question || q.prompt || q.text || '';
      const hasOptions = Array.isArray(q.options) && q.options.length > 0;
      let answer = answers[i];
      if (hasOptions && otherActive[i] && otherText[i]) {
        if (q.multiSelect) {
          const arr = Array.isArray(answer) ? [...answer] : [];
          arr.push(otherText[i]);
          answer = arr;
        } else {
          answer = otherText[i];
        }
      }
      if (Array.isArray(answer)) {
        answersDict[questionText] = answer.join(', ');
      } else {
        answersDict[questionText] = answer || '';
      }
    });
    onApprove(request.id, { ...request.tool_input, questions, answers: answersDict });
  };

  const isSelected = (qIdx: number, key: string): boolean => {
    const val = answers[qIdx];
    if (Array.isArray(val)) return val.includes(key);
    return val === key;
  };

  return (
    <Box
      sx={{
        // Tint carries the container; the accent icon + title are the identity cue. Elevated, not
        // secondary: this is an input surface, and on the dark palette secondary sits BELOW the
        // surface it lands on, which reads as a well rather than something you type into.
        bgcolor: c.bg.elevated,
        borderRadius: compact ? 2 : 2.5,
        p: compact ? 1.5 : 2,
        mx: compact ? 0 : 2,
        mb: compact ? 0 : 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
        <Box sx={{ color: c.accent.primary, display: 'flex', alignItems: 'center' }}>
          <QuestionAnswerIcon sx={{ fontSize: '1rem' }} />
        </Box>
        <Typography sx={{ color: c.accent.primary, fontWeight: 700, fontSize: '0.875rem' }}>
          Agent has a question
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 2 }}>
        {questions.map((q: any, i: number) => {
          const hasOptions = Array.isArray(q.options) && q.options.length > 0;
          const multi = !!q.multiSelect;
          const isOtherActive = !!otherActive[i];
          return (
            <Box key={i}>
              {q.header && (
                <Typography sx={{ color: c.text.muted, fontSize: '0.6875rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', mb: 0.25 }}>
                  {q.header}
                </Typography>
              )}
              <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', fontWeight: 500, mb: 0.75 }}>
                {q.question || q.prompt || q.text || '(question)'}
              </Typography>
              {hasOptions ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                    {q.options.map((opt: any) => {
                      const key = getOptionKey(opt);
                      const selected = isSelected(i, key);
                      return (
                        <Chip
                          key={key}
                          label={getOptionLabel(opt)}
                          size="small"
                          onClick={() => toggleOption(i, key, multi)}
                          sx={{
                            fontSize: '0.75rem',
                            fontWeight: selected ? 600 : 400,
                            cursor: 'pointer',
                            color: selected ? c.accent.primary : c.text.secondary,
                            bgcolor: selected ? `${c.accent.primary}18` : 'transparent',
                            borderColor: selected ? c.accent.primary : c.border.medium,
                            borderWidth: 1,
                            borderStyle: 'solid',
                            transition: 'all 0.15s ease',
                            '&:hover': {
                              bgcolor: selected ? `${c.accent.primary}24` : `${c.text.secondary}0a`,
                              borderColor: selected ? c.accent.primary : c.text.secondary,
                            },
                          }}
                        />
                      );
                    })}
                    <Chip
                      label="Other…"
                      size="small"
                      onClick={() => toggleOther(i, multi)}
                      sx={{
                        fontSize: '0.75rem',
                        fontWeight: isOtherActive ? 600 : 400,
                        fontStyle: 'italic',
                        cursor: 'pointer',
                        color: isOtherActive ? c.accent.primary : c.text.muted,
                        bgcolor: isOtherActive ? `${c.accent.primary}18` : 'transparent',
                        borderColor: isOtherActive ? c.accent.primary : c.border.subtle,
                        borderWidth: 1,
                        borderStyle: 'dashed',
                        transition: 'all 0.15s ease',
                        '&:hover': {
                          bgcolor: isOtherActive ? `${c.accent.primary}24` : `${c.text.secondary}0a`,
                          borderColor: isOtherActive ? c.accent.primary : c.border.medium,
                        },
                      }}
                    />
                  </Box>
                  {isOtherActive && (
                    <TextField
                      placeholder="Type your own answer..."
                      value={otherText[i] || ''}
                      onChange={(e) => setOtherText((prev) => ({ ...prev, [i]: e.target.value }))}
                      fullWidth
                      size="small"
                      autoFocus
                      sx={{
                        mt: 0.25,
                        '& .MuiOutlinedInput-root': {
                          color: c.text.primary,
                          fontSize: '0.8125rem',
                          '& fieldset': { borderColor: c.border.medium },
                          '&:hover fieldset': { borderColor: c.border.strong },
                          '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                        },
                      }}
                    />
                  )}
                </Box>
              ) : (
                <TextField
                  placeholder="Type your answer..."
                  value={answers[i] || ''}
                  onChange={(e) => setTextAnswer(i, e.target.value)}
                  fullWidth
                  size="small"
                  multiline
                  maxRows={4}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      color: c.text.primary,
                      fontSize: '0.8125rem',
                      '& fieldset': { borderColor: c.border.medium },
                      '&:hover fieldset': { borderColor: c.border.strong },
                      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                    },
                  }}
                />
              )}
            </Box>
          );
        })}
      </Box>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          variant="contained"
          startIcon={<SendIcon />}
          onClick={handleSubmit}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.hover || c.accent.primary, filter: 'brightness(0.9)' },
            fontWeight: 600,
            fontSize: '0.8125rem',
          }}
        >
          Submit
        </Button>
        <Button
          variant="outlined"
          onClick={() => onDeny(request.id)}
          sx={{
            borderColor: c.border.strong,
            color: c.text.secondary,
            '&:hover': { borderColor: c.text.secondary, bgcolor: `${c.text.secondary}08` },
            fontWeight: 600,
            fontSize: '0.8125rem',
          }}
        >
          Dismiss
        </Button>
      </Box>
    </Box>
  );
};

export default QuestionForm;
