export const ONBOARDING_TOOL_INTEGRATIONS = [
  { name: 'Google Workspace', desc: 'Gmail, Calendar, Drive, Docs, Sheets', color: '#4285F4', oauthProvider: 'google',
    mcp_config: { type: 'stdio', command: 'uvx', args: ['--from', 'google-workspace-mcp', 'google-workspace-worker'] } },
  { name: 'GitHub', desc: 'Repos, issues, pull requests', color: '#24292E', oauthProvider: 'github',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
  { name: 'Slack', desc: 'Channels, messages, search', color: '#4A154B', oauthProvider: 'slack',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] } },
  { name: 'Notion', desc: 'Pages, databases, search', color: '#000000', oauthProvider: 'notion',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] } },
];

export type ToolIntegration = typeof ONBOARDING_TOOL_INTEGRATIONS[number];

export const SUBSCRIPTION_PROVIDERS = [
  { id: 'claude', name: 'Claude', desc: 'Sonnet, Opus, Haiku', color: '#E8927A', preview: false },
  { id: 'gemini-cli', name: 'Gemini', desc: 'Gemini 2.5 Pro & Flash', color: '#4285F4', preview: true },
  { id: 'codex', name: 'ChatGPT', desc: 'GPT-5.4, o3, o4-mini', color: '#74AA9C', preview: true },
  { id: 'github', name: 'GitHub Copilot', desc: 'Claude + GPT models', color: '#8B949E', preview: true },
];