import React, { useMemo, useState, useCallback } from 'react';
import { OptionList } from './OptionList/OptionList';
import type { OptionListSelection } from './OptionList/schema';
import { QuestionFlow } from './QuestionFlow/QuestionFlow';
import type { ApprovalRequest } from '@/shared/state/agentsSlice';

function optionKey(opt: any): string {
  return opt.id || opt.value || opt.label || opt.text || String(opt);
}

function optionLabel(opt: any): string {
  return opt.label || opt.value || opt.text || String(opt);
}

// ---------------------------------------------------------------------------
// FreeTextQuestion (fallback for questions without options)
// ---------------------------------------------------------------------------

const FreeTextQuestion: React.FC<{
  id: string;
  question: string;
  header?: string;
  onSubmit: (answer: string) => void;
  onDismiss: () => void;
}> = ({ id, question, header, onSubmit, onDismiss }) => {
  const [text, setText] = useState('');

  return (
    <div
      className="flex w-full max-w-md flex-col gap-3 text-foreground"
      data-slot="free-text-question"
      data-tool-ui-id={id}
    >
      <div className="bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-xs">
        {header && (
          <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            {header}
          </span>
        )}
        <h2 className="text-base font-semibold leading-tight">{question}</h2>
        <textarea
          className="border-input bg-background text-foreground placeholder:text-muted-foreground w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
          rows={3}
          placeholder="Type your answer..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
          onClick={onDismiss}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          onClick={() => onSubmit(text)}
          disabled={!text.trim()}
        >
          Submit
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ToolQuestion
// ---------------------------------------------------------------------------

interface ToolQuestionProps {
  request: ApprovalRequest;
  onApprove: (requestId: string, updatedInput?: Record<string, any>) => void;
  onDeny: (requestId: string, message?: string) => void;
  compact?: boolean;
}

export const ToolQuestion: React.FC<ToolQuestionProps> = ({ request, onApprove, onDeny }) => {
  const rawQuestions: any[] = request.tool_input.questions || [];

  const questions = useMemo(() => {
    if (rawQuestions.length > 0) return rawQuestions;
    if (request.tool_input.question) {
      return [{
        question: request.tool_input.question,
        options: request.tool_input.options,
        multiSelect: request.tool_input.allow_multiple ?? request.tool_input.multiSelect,
        header: request.tool_input.header,
      }];
    }
    return [];
  }, [rawQuestions, request.tool_input]);

  const buildAnswersPayload = useCallback(
    (answersDict: Record<string, string>) => {
      return { ...request.tool_input, questions, answers: answersDict };
    },
    [request.tool_input, questions],
  );

  // Multi-step questions with options -> QuestionFlow upfront mode
  const stepsWithOptions = useMemo(() => {
    if (questions.length <= 1) return null;
    const steps = questions
      .map((q: any, i: number) => {
        const opts = Array.isArray(q.options) ? q.options : [];
        if (opts.length === 0) return null;
        return {
          id: `q-${i}`,
          title: q.question || q.prompt || q.text || `Question ${i + 1}`,
          description: q.header,
          options: opts.map((opt: any) => ({
            id: optionKey(opt),
            label: optionLabel(opt),
            description: opt.description,
          })),
          selectionMode: (q.multiSelect || q.allow_multiple ? 'multi' : 'single') as 'multi' | 'single',
        };
      })
      .filter(Boolean) as Array<{
        id: string;
        title: string;
        description?: string;
        options: Array<{ id: string; label: string; description?: string }>;
        selectionMode: 'multi' | 'single';
      }>;
    return steps.length > 1 ? steps : null;
  }, [questions]);

  const handleFlowComplete = useCallback(
    (answers: Record<string, string[]>) => {
      const answersDict: Record<string, string> = {};
      if (stepsWithOptions) {
        stepsWithOptions.forEach((step, i) => {
          const q = questions[i];
          const questionText = q?.question || q?.prompt || q?.text || '';
          const selection = answers[step.id] || [];
          answersDict[questionText] = selection.join(', ');
        });
      }
      onApprove(request.id, buildAnswersPayload(answersDict));
    },
    [stepsWithOptions, questions, request.id, onApprove, buildAnswersPayload],
  );

  if (stepsWithOptions) {
    return (
      <QuestionFlow
        id={request.id}
        steps={stepsWithOptions}
        onComplete={handleFlowComplete}
      />
    );
  }

  // Single question
  const q = questions[0] || request.tool_input;
  const questionText: string = q.question || q.prompt || q.text || '(question)';
  const options: any[] = Array.isArray(q.options) ? q.options : [];
  const isMulti: boolean = !!(q.multiSelect || q.allow_multiple);

  if (options.length > 0) {
    const mappedOptions = options.map((opt: any) => ({
      id: optionKey(opt),
      label: optionLabel(opt),
      description: opt.description,
    }));

    return (
      <div className="flex flex-col gap-2">
        <div className="text-foreground px-1">
          <h2 className="text-base font-semibold leading-tight">{questionText}</h2>
        </div>
        <OptionList
          id={request.id}
          options={mappedOptions}
          selectionMode={isMulti ? 'multi' : 'single'}
          actions={[
            { id: 'cancel', label: 'Skip' },
            { id: 'confirm', label: 'Submit' },
          ]}
          onAction={(actionId: string, selection: OptionListSelection) => {
            if (actionId === 'confirm') {
              const answer = Array.isArray(selection) ? selection : selection ? [selection] : [];
              onApprove(request.id, { answer });
            } else {
              onDeny(request.id);
            }
          }}
        />
      </div>
    );
  }

  // Free-text fallback
  return (
    <FreeTextQuestion
      id={request.id}
      question={questionText}
      header={q.header}
      onSubmit={(answer) => {
        const answersDict: Record<string, string> = { [questionText]: answer };
        onApprove(request.id, buildAnswersPayload(answersDict));
      }}
      onDismiss={() => onDeny(request.id)}
    />
  );
};
