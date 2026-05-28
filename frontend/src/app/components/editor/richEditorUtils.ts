export const SKILL_PILL_ATTR = 'data-skill-id';
export const SKILL_COLOR = '#7B61BD';

export interface AttachedSkill {
  id: string;
  name: string;
  content: string;
}

export function createSkillPillElement(
  skill: AttachedSkill,
  onRemove: (id: string) => void,
  monoFont: string,
  errorColor: string,
): HTMLSpanElement {
  const pill = document.createElement('span');
  pill.setAttribute(SKILL_PILL_ATTR, skill.id);
  pill.contentEditable = 'false';
  Object.assign(pill.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    padding: '1px 4px 1px 6px',
    margin: '0 1px',
    borderRadius: '999px',
    background: `${SKILL_COLOR}18`,
    color: SKILL_COLOR,
    fontSize: '0.72rem',
    fontFamily: monoFont,
    lineHeight: '1.8',
    verticalAlign: 'baseline',
    userSelect: 'none',
    whiteSpace: 'nowrap' as const,
    cursor: 'default',
  });

  const label = document.createElement('span');
  label.textContent = skill.name;
  Object.assign(label.style, { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' });

  const closeBtn = document.createElement('span');
  closeBtn.textContent = '\u00d7';
  Object.assign(closeBtn.style, {
    cursor: 'pointer',
    fontSize: '13px',
    lineHeight: '1',
    opacity: '0.6',
    marginLeft: '1px',
    fontWeight: '700',
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  });
  closeBtn.addEventListener('mouseover', () => { closeBtn.style.opacity = '1'; closeBtn.style.color = errorColor; });
  closeBtn.addEventListener('mouseout', () => { closeBtn.style.opacity = '0.6'; closeBtn.style.color = 'inherit'; });
  closeBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onRemove(skill.id); });

  pill.appendChild(label);
  pill.appendChild(closeBtn);
  return pill;
}

const SKILL_MARKER_RE = /\{\{skill:(.+?)\}\}/g;

export function deserializeToEditor(
  editor: HTMLElement,
  text: string,
  skillsByName: Record<string, AttachedSkill>,
  onRemove: (id: string) => void,
  monoFont: string,
  errorColor: string,
): Record<string, AttachedSkill> {
  editor.innerHTML = '';
  const restored: Record<string, AttachedSkill> = {};
  let lastIndex = 0;

  for (const match of text.matchAll(SKILL_MARKER_RE)) {
    const before = text.slice(lastIndex, match.index);
    if (before) editor.appendChild(document.createTextNode(before));

    const skillName = match[1];
    const skill = skillsByName[skillName];
    if (skill) {
      const pill = createSkillPillElement(skill, onRemove, monoFont, errorColor);
      editor.appendChild(pill);
      const spacer = document.createTextNode('\u200B');
      editor.appendChild(spacer);
      restored[skill.id] = skill;
    } else {
      editor.appendChild(document.createTextNode(match[0]));
    }
    lastIndex = match.index! + match[0].length;
  }

  const tail = text.slice(lastIndex);
  if (tail) editor.appendChild(document.createTextNode(tail));

  return restored;
}

export function serializeEditorContent(editor: HTMLElement, skills: Record<string, AttachedSkill>): string {
  const parts: string[] = [];
  let hasOutput = false;

  const walk = (parent: Node) => {
    parent.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent || '').replace(/\u200B/g, '');
        if (t) hasOutput = true;
        parts.push(t);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const sid = el.getAttribute(SKILL_PILL_ATTR);
        if (sid && skills[sid]) {
          hasOutput = true;
          parts.push(`{{skill:${skills[sid].name}}}`);
          return;
        }
        if (el.tagName === 'BR') { parts.push('\n'); return; }
        if (el.tagName === 'DIV' || el.tagName === 'P') {
          if (hasOutput) parts.push('\n');
          walk(el);
          return;
        }
        walk(el);
      }
    });
  };

  walk(editor);
  return parts.join('');
}

export interface TriggerState {
  visible: boolean;
  trigger: '/' | '@';
  filter: string;
  triggerNode: Text | null;
  triggerOffset: number;
}

export const EMPTY_TRIGGER: TriggerState = {
  visible: false,
  trigger: '/',
  filter: '',
  triggerNode: null,
  triggerOffset: 0,
};

export function detectEditorTrigger(): TriggerState | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const textNode = node as Text;
  const text = textNode.textContent || '';
  const before = text.slice(0, offset);

  let triggerIdx = -1;
  let triggerChar: '/' | '@' | null = null;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === ' ' || ch === '\n') break;
    if (ch === '@') {
      if (i === 0 || before[i - 1] === ' ' || before[i - 1] === '\n') {
        triggerIdx = i;
        triggerChar = '@';
      }
      break;
    }
    if (ch === '/') {
      if (i === 0 || before[i - 1] === ' ' || before[i - 1] === '\n') {
        triggerIdx = i;
        triggerChar = '/';
        break;
      }
      continue;
    }
  }

  if (triggerChar && triggerIdx >= 0) {
    return {
      visible: true,
      trigger: triggerChar,
      filter: before.slice(triggerIdx + 1),
      triggerNode: textNode,
      triggerOffset: triggerIdx,
    };
  }
  return null;
}
