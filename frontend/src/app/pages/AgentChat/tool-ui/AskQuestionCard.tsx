import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import VendoredToolUi from '@/toolui/VendoredToolUi';
import QuestionForm, { type QuestionFormProps } from './QuestionForm';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const OTHER_ID = '__other__';

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<Record<string, unknown> | string>;
  multiSelect?: boolean;
}

function optionId(opt: Record<string, unknown> | string, i: number): string {
  if (typeof opt === 'string') return opt || `option-${i + 1}`;
  return String(opt.id ?? opt.value ?? opt.label ?? opt.text ?? `option-${i + 1}`);
}

function optionLabel(opt: Record<string, unknown> | string): string {
  if (typeof opt === 'string') return opt;
  return String(opt.label ?? opt.value ?? opt.text ?? '');
}

function optionDescription(opt: Record<string, unknown> | string): string | undefined {
  if (typeof opt === 'string') return undefined;
  const d = opt.description;
  return typeof d === 'string' && d ? d : undefined;
}

/** AskUserQuestion rendered through the vendored tool-ui question-flow (the modern stepped card),
 * with a host-side follow-up input when the user picks "Other". Questions the flow's contract
 * can't hold (free-text, no options) fall back to the classic form, so nothing loses function. */
const AskQuestionCard: React.FC<QuestionFormProps> = (props) => {
  const { request, onApprove, onDeny, compact } = props;
  const c = useClaudeTokens();
  const questions: AskQuestion[] = useMemo(
    () => (Array.isArray(request.tool_input.questions) ? request.tool_input.questions : []),
    [request.tool_input.questions],
  );
  const flowFits = questions.length > 0 && questions.every((q) => Array.isArray(q.options) && q.options.length > 0);
  const [flowAnswers, setFlowAnswers] = useState<Record<string, string[]> | null>(null);
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  // Live per-step selection, updated on every toggle so "Other..." can reveal its box immediately.
  const [liveAnswers, setLiveAnswers] = useState<Record<string, string[]>>({});

  const steps = useMemo(() => questions.map((q, i) => ({
    id: `q-${i}`,
    title: q.question || '(question)',
    description: q.header || undefined,
    options: [
      ...(q.options || []).map((opt, j) => ({
        id: optionId(opt, j),
        label: optionLabel(opt) || `Option ${j + 1}`,
        description: optionDescription(opt),
      })),
      { id: OTHER_ID, label: 'Other…', description: 'Answer in your own words' },
    ],
    selectionMode: (q.multiSelect ? 'multi' : 'single') as 'multi' | 'single',
  })), [questions]);

  if (!flowFits) return <QuestionForm {...props} />;

  const submit = (answers: Record<string, string[]>): void => {
    const answersDict: Record<string, string> = {};
    questions.forEach((q, i) => {
      const picked = answers[`q-${i}`] || [];
      const resolved = picked.map((id) => (id === OTHER_ID ? (otherText[`q-${i}`] || '').trim() : id)).filter(Boolean);
      answersDict[q.question || ''] = resolved.join(', ');
    });
    onApprove(request.id, { ...request.tool_input, questions, answers: answersDict });
  };

  // Steps where "Other..." is picked RIGHT NOW, whether or not the flow has been committed. It used
  // to read `flowAnswers` alone, which only exists after onComplete, so the box the user was asked
  // to type into did not appear until they pressed Enter on the whole flow (ENG-419).
  const otherSteps = flowAnswers ?? liveAnswers;
  const pendingOther = Object.entries(otherSteps)
    .filter(([, ids]) => ids.includes(OTHER_ID))
    .map(([stepId]) => stepId);

  return (
    <Box sx={{ mx: compact ? 0 : 2, mb: compact ? 0 : 1 }}>
      {!flowAnswers && (
        <VendoredToolUi
          name="question-flow"
          props={{ id: request.id, steps }}
          extraProps={{
            onSelectionChange: (stepId: string, ids: string[]) =>
              setLiveAnswers((prev) => ({ ...prev, [stepId]: ids })),
            onComplete: (answers: Record<string, string[]>) => {
              const needsOther = Object.values(answers).some((ids) => ids.includes(OTHER_ID));
              if (needsOther) setFlowAnswers(answers);
              else submit(answers);
            },
          }}
        />
      )}
      {pendingOther.length > 0 && (
        <Box sx={{ bgcolor: c.bg.secondary, borderRadius: 2.5, p: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          {pendingOther.map((stepId) => {
            const idx = Number(stepId.slice(2));
            return (
              <Box key={stepId}>
                <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', fontWeight: 500, mb: 0.75 }}>
                  {questions[idx]?.question}
                </Typography>
                <TextField
                  placeholder="Your answer..."
                  value={otherText[stepId] || ''}
                  onChange={(e) => setOtherText((prev) => ({ ...prev, [stepId]: e.target.value }))}
                  fullWidth
                  size="small"
                  autoFocus={flowAnswers !== null}
                  multiline
                  maxRows={4}
                />
              </Box>
            );
          })}
          {flowAnswers !== null && (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="contained" disableElevation size="small" onClick={() => submit(flowAnswers)}
              disabled={pendingOther.some((s) => !(otherText[s] || '').trim())}
              sx={{ fontWeight: 600, fontSize: '0.8125rem', textTransform: 'none' }}>
              Submit
            </Button>
            <Button variant="text" size="small" color="inherit" onClick={() => setFlowAnswers(null)}
              sx={{ fontSize: '0.8125rem', textTransform: 'none', color: c.text.secondary }}>
              Back
            </Button>
          </Box>
          )}
        </Box>
      )}
      {!flowAnswers && (
        <Button variant="text" size="small" color="inherit" onClick={() => onDeny(request.id)}
          sx={{ mt: 0.5, fontSize: '0.75rem', textTransform: 'none', color: c.text.muted }}>
          Dismiss
        </Button>
      )}
    </Box>
  );
};

export default AskQuestionCard;
