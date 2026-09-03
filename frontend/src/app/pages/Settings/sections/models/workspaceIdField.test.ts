import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Anthropic's identity-linked keys can span workspaces and then need a workspace id on every
// request. The field lives on the Anthropic card only, appears once a key is present, and the
// chat card for that refusal opens Settings under its own title instead of "Sign-in required".

const card = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/Settings/sections/models/ApiKeyCard.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(process.cwd(), 'src/app/pages/AgentChat/AgentChat.tsx'), 'utf8');
const slice = fs.readFileSync(path.join(process.cwd(), 'src/shared/state/settingsSlice.ts'), 'utf8');

test('the workspace id field is gated on the Anthropic card with a key present', () => {
  assert.match(card, /config\.field === 'anthropic_api_key' && value \? \(/);
  assert.match(card, /anthropic_workspace_id: e\.target\.value\.trim\(\) \|\| null/);
});

test('the settings shape carries the field with a null default', () => {
  assert.match(slice, /anthropic_workspace_id: string \| null;/);
  assert.match(slice, /anthropic_workspace_id: null,/);
});

test('the workspace refusal opens Settings under its own title', () => {
  assert.match(chat, /const isWorkspace = reason === 'anthropic_workspace_id';/);
  assert.match(chat, /opensSettings = isAuth \|\| isWorkspace/);
  assert.match(chat, /isWorkspace \? 'Workspace ID needed'/);
});
