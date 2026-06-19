export interface McpToolInfo {
  isMcp: boolean;
  serverSlug: string;
  action: string;
  service: string;
  displayName: string;
}

export function parseMcpToolName(rawName: string): McpToolInfo {
  const m = rawName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (!m) return { isMcp: false, serverSlug: '', action: '', service: '', displayName: rawName };
  const serverSlug = m[1];
  const action = m[2];
  const spaced = action.replace(/_/g, ' ').toLowerCase();
  const display = spaced.charAt(0).toUpperCase() + spaced.slice(1);

  const lower = action.toLowerCase();
  let service = '';
  if (lower.includes('gmail') || lower.includes('email') || lower.includes('mail')) service = 'gmail';
  else if (lower.includes('calendar') || lower.includes('event') || lower.includes('freebusy')) service = 'calendar';
  else if (lower.includes('drive') || lower.includes('file')) service = 'drive';
  else if (lower.includes('sheet') || lower.includes('spreadsheet')) service = 'sheets';
  else if (lower.includes('doc') || lower.includes('paragraph')) service = 'docs';
  else if (lower.includes('contact')) service = 'contacts';

  return { isMcp: true, serverSlug, action, service, displayName: display };
}

function formatTime(hour: unknown, minute: unknown): string {
  const h = typeof hour === 'number' ? hour : Number(hour);
  const m = typeof minute === 'number' ? minute : Number(minute || 0);
  if (!Number.isFinite(h)) return '';
  const h12 = ((h + 11) % 12) + 1;
  const suffix = h < 12 ? 'am' : 'pm';
  return Number.isFinite(m) && m > 0 ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

function weekdayLabel(day: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] || '';
}

function compactWorkflowSchedule(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const enabled = input.schedule_enabled ?? input.enabled;
  if (enabled === false) return 'Turn schedule off';

  const unit = input.repeat_unit || input.unit;
  const every = Math.max(1, Number(input.repeat_every || 1));
  const time = formatTime(input.hour, input.minute);
  const days = Array.isArray(input.on_days) ? input.on_days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6) : [];

  if (unit === 'minute') return `Run every ${Math.max(15, Number(input.repeat_every || 15))} minutes`;
  if (unit === 'hour') {
    const minute = Number(input.minute || 0);
    const suffix = minute > 0 ? ` at :${String(minute).padStart(2, '0')}` : '';
    return every === 1 ? `Run every hour${suffix}` : `Run every ${every} hours${suffix}`;
  }
  if (unit === 'day') return `Run ${every === 1 ? 'daily' : `every ${every} days`}${time ? ` at ${time}` : ''}`;
  if (unit === 'month') return `Run ${every === 1 ? 'monthly' : `every ${every} months`}${time ? ` at ${time}` : ''}`;
  if (unit === 'week') {
    const dayText = days.length === 1
      ? weekdayLabel(days[0])
      : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))
        ? 'weekdays'
        : days.length > 1
          ? days.map(weekdayLabel).filter(Boolean).join(', ')
          : '';
    if (!dayText) return time ? `Choose weekly days at ${time}` : 'Choose weekly days';
    return `Run ${every === 1 ? `every ${dayText}` : `every ${every} weeks on ${dayText}`}${time ? ` at ${time}` : ''}`;
  }
  if (input.title) return `Update "${input.title}"`;
  return '';
}

function firstText(input: any, keys: string[]): string {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stepNumber(input: any): string {
  const raw = input?.step_idx ?? input?.step_index ?? input?.index;
  const idx = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(idx) && idx >= 0 ? String(idx + 1) : '';
}

function compactWorkflowAction(input: any, action: string): string {
  const lower = action.toLowerCase();
  const step = stepNumber(input);
  const text = firstText(input, ['new_text', 'text', 'prompt', 'description']);
  const label = firstText(input, ['new_label', 'label', 'title', 'name']);
  const preview = text || label;
  const shortPreview = preview.length > 80 ? preview.slice(0, 77) + '...' : preview;

  if (lower === 'addworkflowstep') return shortPreview ? `Add step: ${shortPreview}` : 'Add a workflow step';
  if (lower === 'editworkflowstep') return step ? `Edit step ${step}` : 'Edit workflow step';
  if (lower === 'deleteworkflowstep') return step ? `Delete step ${step}` : 'Delete workflow step';
  if (lower === 'runworkflow') return 'Run this workflow now';
  if (lower === 'testworkflow') return 'Test this workflow';
  if (lower === 'readtesttranscript') return 'Read latest test results';
  if (lower === 'deletescheduledworkflow') return 'Delete this workflow';
  if (lower === 'pauseallworkflows') return 'Pause all scheduled workflows';
  if (lower === 'resumeallworkflows') return 'Resume scheduled workflows';
  if (lower === 'listworkflows') return 'Show workflows';
  return '';
}

export function getWorkflowToolLabel(action: string): string | null {
  const lower = action.toLowerCase();
  if (lower === 'scheduleworkflow') return 'Schedule workflow';
  if (lower === 'updatescheduledworkflow') return 'Update schedule';
  if (lower === 'deletescheduledworkflow') return 'Delete workflow';
  if (lower === 'pauseallworkflows') return 'Pause workflows';
  if (lower === 'resumeallworkflows') return 'Resume workflows';
  if (lower === 'runworkflow') return 'Run workflow';
  if (lower === 'editworkflowstep') return 'Edit workflow step';
  if (lower === 'addworkflowstep') return 'Add workflow step';
  if (lower === 'deleteworkflowstep') return 'Delete workflow step';
  if (lower === 'testworkflow') return 'Test workflow';
  if (lower === 'readtesttranscript') return 'Read test results';
  if (lower === 'listworkflows') return 'List workflows';
  if (lower === 'suggestconverttoworkflow') return 'Suggest workflow';
  return null;
}

export function getWorkflowToolInputDisplay(input: any, action?: string, serverSlug?: string): string {
  if (!input || typeof input !== 'object') return '';
  const isWorkflowTool = serverSlug === 'openswarm-schedule' || (action && getWorkflowToolLabel(action));
  if (!isWorkflowTool || !action) return '';

  const lower = action.toLowerCase();
  const lines: string[] = [];
  const schedule = compactWorkflowSchedule(input);
  const step = stepNumber(input);
  const text = firstText(input, ['new_text', 'text', 'prompt', 'description']);
  const label = firstText(input, ['new_label', 'label', 'title', 'name']);

  if (lower === 'scheduleworkflow' || lower === 'updatescheduledworkflow') {
    if (schedule) lines.push(`Schedule: ${schedule}`);
    if (label) lines.push(`Name: ${label}`);
    return lines.join('\n') || getWorkflowToolLabel(action) || 'Workflow action';
  }

  if (lower === 'addworkflowstep') {
    if (text) lines.push(`Step: ${text}`);
    if (label && label !== text) lines.push(`Label: ${label}`);
    return lines.join('\n') || compactWorkflowAction(input, action);
  }

  if (lower === 'editworkflowstep') {
    if (step) lines.push(`Step: ${step}`);
    if (text) lines.push(`Prompt: ${text}`);
    if (label && label !== text) lines.push(`Label: ${label}`);
    return lines.join('\n') || compactWorkflowAction(input, action);
  }

  return compactWorkflowAction(input, action) || getWorkflowToolLabel(action) || 'Workflow action';
}

export function getMcpInputSummary(input: any, action?: string, serverSlug?: string): string {
  if (!input || typeof input !== 'object') return '';
  if (serverSlug === 'openswarm-schedule' || (action && getWorkflowToolLabel(action))) {
    const workflowSummary = compactWorkflowSchedule(input);
    if (workflowSummary) return workflowSummary;
    if (action) {
      const actionSummary = compactWorkflowAction(input, action);
      if (actionSummary) return actionSummary;
    }
    return '';
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const v = input[keys[0]];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  return keys.slice(0, 3).map((k) => {
    const v = input[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${s.length > 30 ? s.slice(0, 30) + '…' : s}`;
  }).join('  ');
}

export function getMcpShortAction(mcpInfo: McpToolInfo): string {
  const { action, service } = mcpInfo;
  let short = action;
  if (service && action.toLowerCase().startsWith(service.toLowerCase() + '_')) {
    short = action.slice(service.length + 1);
  }
  const lower = short.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function getGmailHeader(msg: any, name: string): string {
  if (msg.payload?.headers && Array.isArray(msg.payload.headers)) {
    const h = msg.payload.headers.find(
      (hdr: any) => (hdr.name || '').toLowerCase() === name.toLowerCase()
    );
    if (h) return h.value || '';
  }
  if (msg.headers && typeof msg.headers === 'object' && !Array.isArray(msg.headers)) {
    return msg.headers[name] || msg.headers[name.toLowerCase()] || '';
  }
  return '';
}
