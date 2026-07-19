import React from 'react';

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  helpText?: string;
}

export interface Integration {
  id: string;
  name: string;
  description: string;
  mcp_config: Record<string, any>;
  color: string;
  website: string;
  icon: React.ReactNode;
  credentialFields?: CredentialField[];
  connectLabel?: string;
  connectInstructions?: string;
  authType?: 'none' | 'oauth2' | 'env_vars' | 'device_code' | 'browser_login';
  loginUrl?: string;
}

export const INTEGRATIONS: Integration[] = [
  {
    id: 'x',
    name: 'X',
    description: 'Read your timeline, search, post, reply, quote, like, retweet, bookmark, follow, and DM, all from your own logged-in X (Twitter) session. No API key.',
    mcp_config: { type: 'stdio', command: 'python', args: ['-m', 'backend.apps.x_mcp_shim'] },
    color: '#000000',
    website: 'https://x.com',
    authType: 'browser_login',
    connectLabel: 'Sign in to X',
    loginUrl: 'https://x.com/i/flow/login',
    connectInstructions: 'Uses your own X account: open x.com in an OpenSwarm browser card and sign in once. Nothing is stored, the integration borrows your live session per request and paces itself to stay within human limits.',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path fill="#000000" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    ),
  },
  {
    id: 'spotify',
    name: "Spotify",
    description: 'Control playback, search tracks, and manage playlists. (Opens an external Chrome window to bypass DRM)',
    mcp_config: { type: 'stdio', command: 'python', args: ['-m', 'backend.apps.spotify_mcp_shim'] },
    color: '#1DB954',
    website: 'https://open.spotify.com',
    authType: 'browser_login',
    connectLabel: 'Instructions',
    loginUrl: '#',
    connectInstructions: 'IMPORTANT: Spotify DRM blocks internal browsers. When you run a command for the first time, an external Google Chrome window will automatically open. Please sign into Spotify in that external window. Do NOT log in via the internal OpenSwarm browser, as playback will fail.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 496 512">
        <path fill="#1ed760" d="M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8Z"/>
        <path d="M406.6 231.1c-5.2 0-8.4-1.3-12.9-3.9-71.2-42.5-198.5-52.7-280.9-29.7-3.6 1-8.1 2.6-12.9 2.6-13.2 0-23.3-10.3-23.3-23.6 0-13.6 8.4-21.3 17.4-23.9 35.2-10.3 74.6-15.2 117.5-15.2 73 0 149.5 15.2 205.4 47.8 7.8 4.5 12.9 10.7 12.9 22.6 0 13.6-11 23.3-23.2 23.3zm-31 76.2c-5.2 0-8.7-2.3-12.3-4.2-62.5-37-155.7-51.9-238.6-29.4-4.8 1.3-7.4 2.6-11.9 2.6-10.7 0-19.4-8.7-19.4-19.4s5.2-17.8 15.5-20.7c27.8-7.8 56.2-13.6 97.8-13.6 64.9 0 127.6 16.1 177 45.5 8.1 4.8 11.3 11 11.3 19.7-.1 10.8-8.5 19.5-19.4 19.5zm-26.9 65.6c-4.2 0-6.8-1.3-10.7-3.6-62.4-37.6-135-39.2-206.7-24.5-3.9 1-9 2.6-11.9 2.6-9.7 0-15.8-7.7-15.8-15.8 0-10.3 6.1-15.2 13.6-16.8 81.9-18.1 165.6-16.5 237 26.2 6.1 3.9 9.7 7.4 9.7 16.5s-7.1 15.4-15.2 15.4z"/>
      </svg>
    ),
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    description: 'Browse the For You feed, search, read videos and comments, like, comment, follow, and favorite, all from your own logged-in TikTok session. No API key.',
    mcp_config: { type: 'stdio', command: 'python', args: ['-m', 'backend.apps.tiktok_mcp_shim'] },
    color: '#FE2C55',
    website: 'https://www.tiktok.com',
    authType: 'browser_login',
    connectLabel: 'Sign in to TikTok',
    loginUrl: 'https://www.tiktok.com/login',
    connectInstructions: 'Uses your own TikTok account: open tiktok.com in an OpenSwarm browser card and sign in once. Nothing is stored. Note: TikTok signs every request, so signed writes and uploads route to the OpenSwarm browser agent (also free, using your real session).',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path fill="#FE2C55" d="M16.6 5.82a4.28 4.28 0 0 1-1.05-2.82h-3.2v12.86a2.6 2.6 0 1 1-1.86-2.49V9.9a5.77 5.77 0 1 0 5.06 5.72V9.01a7.45 7.45 0 0 0 4.35 1.4V7.2a4.28 4.28 0 0 1-3.3-1.38z"/>
      </svg>
    ),
  },
  {
    id: 'reddit',
    name: 'Reddit',
    description: 'Browse, search, post, comment, vote, save, subscribe, and DM, all from your own logged-in Reddit session. No API key.',
    mcp_config: { type: 'stdio', command: 'python', args: ['-m', 'backend.apps.reddit_mcp_shim'] },
    color: '#FF4500',
    website: 'https://www.reddit.com',
    authType: 'browser_login',
    connectLabel: 'Sign in to Reddit',
    loginUrl: 'https://www.reddit.com/login',
    connectInstructions: 'Uses your own Reddit account: open reddit.com in an OpenSwarm browser card and sign in once. Nothing is stored, the integration borrows your live session per request and paces itself to stay within human limits.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <circle cx="12" cy="12" r="12" fill="#FF4500"/>
        <path d="M19.5 12c0-.6-.5-1.1-1.1-1.1-.3 0-.6.1-.8.3-1-.7-2.3-1.1-3.7-1.1l.6-3 2.1.5c0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.6-.5-1.1-1.1-1.1-.4 0-.8.3-1 .6l-2.3-.5c-.1 0-.2 0-.2.1l-.7 3.3c-1.4 0-2.7.4-3.7 1.1-.2-.2-.5-.3-.8-.3-.6 0-1.1.5-1.1 1.1 0 .4.2.8.6 1-.1.3-.1.6-.1.9 0 2.3 2.6 4.1 5.8 4.1s5.8-1.8 5.8-4.1c0-.3 0-.6-.1-.9.4-.2.6-.6.6-1zm-9.8 1.1c0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1-.6 0-1.1-.5-1.1-1.1zm6.2 2.9c-.8.8-2 .9-2.9.9s-2.1-.1-2.9-.9c-.1-.1-.1-.3 0-.4.1-.1.3-.1.4 0 .6.6 1.6.8 2.5.8s1.9-.2 2.5-.8c.1-.1.3-.1.4 0 .1.1.1.3 0 .4zm-.2-1.8c-.6 0-1.1-.5-1.1-1.1 0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1z" fill="#fff"/>
      </svg>
    ),
  },
  {
    id: 'youtube',
    name: 'YouTube',
    description: 'Get video transcripts, details, comments, search videos, and channel stats. Transcripts work with no API key.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@kirbah/mcp-youtube'] },
    color: '#FF0000',
    website: 'https://www.npmjs.com/package/@kirbah/mcp-youtube',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z" fill="#FF0000"/>
        <path d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" fill="#fff"/>
      </svg>
    ),
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, pull requests, Actions, code search, and gists. Connects with your GitHub account.',
    mcp_config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/x/all' },
    color: '#181717',
    website: 'https://github.com/github/github-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.02 11.02 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" fill="#181717"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Including Google Docs, Sheets, Slides, Calendar, and Gmail. (Gemini CLI extension)',
    mcp_config: { type: 'stdio', command: 'uvx', args: ['--from', 'google-workspace-mcp', 'google-workspace-worker'] },
    color: '#4285F4',
    website: 'https://developers.google.com/gemini-api/docs/mcp',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    description: 'Outlook email, Calendar, OneDrive, Excel, OneNote, Tasks, Contacts, Teams, and SharePoint.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@softeria/ms-365-mcp-server'] },
    color: '#0078D4',
    website: 'https://www.npmjs.com/package/@softeria/ms-365-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M11.4 24H0V12.6L11.4 24zM24 24H12.6V12.6L24 24zM11.4 11.4H0V0l11.4 11.4zM24 11.4H12.6V0L24 11.4z" fill="#0078D4"/>
      </svg>
    ),
    authType: 'device_code',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Create, read, and update pages, databases, and blocks in Notion workspaces.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
    color: '#000000',
    website: 'https://www.npmjs.com/package/@notionhq/notion-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M4.46 2.95c.53.43.73.4 1.73.33l9.4-.57c.2 0 .03-.2-.03-.23l-1.57-1.13c-.3-.23-.7-.5-1.47-.43L3.3 1.78c-.5.07-.6.33-.4.53l1.56 1.13v.51zM5.03 6.15v9.93c0 .53.27.73.87.7l10.33-.6c.6-.03.67-.4.67-.83V5.52c0-.43-.17-.63-.53-.6l-10.8.63c-.4.03-.54.2-.54.6zM14.93 6.63c.07.3 0 .6-.3.63l-.5.1v7.33c-.43.23-.83.37-1.17.37-.53 0-.67-.17-1.07-.67l-3.27-5.13v4.97l1.03.23s0 .6-.83.6l-2.3.13c-.07-.13 0-.47.23-.53l.6-.17V8.33l-.83-.07c-.07-.3.1-.73.57-.77l2.47-.17 3.4 5.2V8.6l-.87-.1c-.07-.37.2-.63.53-.67l2.3-.2zM2.57 1.28L11.93.28c1.17-.1 1.47-.03 2.2.5l3.03 2.13c.5.37.67.47.67.87v15.27c0 .63-.23 1-.87 1.07l-10.7.63c-.5.03-.73-.07-.97-.37L2.73 17.3c-.27-.33-.4-.6-.4-1.03V2.15c0-.53.23-.83.83-.87h-.59z" fill="#000"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and write records, manage bases, tables, and fields in Airtable.',
    mcp_config: { type: 'http', url: 'https://mcp.airtable.com/mcp' },
    color: '#18BFFF',
    website: 'https://airtable.com/developers/web/api/introduction',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M11.52 1.28L2.1 5.13c-.28.12-.28.52 0 .64l9.5 3.9c.25.1.53.1.78 0l9.5-3.9c.28-.12.28-.52 0-.64l-9.5-3.85c-.25-.1-.53-.1-.78 0z" fill="#FCB400"/>
        <path d="M12.76 11.24v9.47c0 .3.32.5.58.38l9.3-4.32c.16-.07.26-.23.26-.4V6.9c0-.3-.32-.5-.58-.38l-9.3 4.32c-.16.07-.26.23-.26.4z" fill="#18BFFF"/>
        <path d="M11.24 11.24v9.47c0 .3-.32.5-.58.38L1.1 16.77c-.16-.07-.26-.23-.26-.4V6.9c0-.3.32-.5.58-.38l9.56 4.32c.16.07.26.23.26.4z" fill="#F82B60"/>
        <path d="M11.24 11.12L1.66 6.78l-.56.26 9.56 4.32c.16.07.34.07.5.02l.08-.26z" fill="#751AFF" opacity=".25"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'CRM contacts, deals, companies, tickets, and more. Free CRM tier included.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@hubspot/mcp-server'] },
    color: '#FF7A59',
    website: 'https://developers.hubspot.com/docs/guides/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M17.58 10.1V7.64a2.08 2.08 0 0 0 1.2-1.88 2.1 2.1 0 0 0-2.1-2.1 2.1 2.1 0 0 0-2.1 2.1c0 .82.48 1.53 1.17 1.88V10.1a5.37 5.37 0 0 0-2.55 1.2L7.31 6.93a2.52 2.52 0 0 0 .1-.68A2.44 2.44 0 0 0 4.97 3.8a2.44 2.44 0 0 0-2.44 2.45 2.44 2.44 0 0 0 2.44 2.44c.47 0 .9-.14 1.28-.37l5.73 4.32a5.36 5.36 0 0 0-.06 6.1l-1.73 1.73a2.06 2.06 0 0 0-.6-.1 2.07 2.07 0 0 0-2.07 2.08A2.07 2.07 0 0 0 9.6 24.5a2.07 2.07 0 0 0 2.07-2.07c0-.42-.13-.8-.34-1.13l1.68-1.68a5.38 5.38 0 1 0 4.57-9.52zm-.9 7.62a2.53 2.53 0 0 1-2.52-2.53 2.53 2.53 0 0 1 2.53-2.53 2.53 2.53 0 0 1 2.52 2.53 2.53 2.53 0 0 1-2.52 2.53z" fill="#FF7A59"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Search messages, send messages, read channels, DMs, and threads in Slack workspaces.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'], env: { SLACK_MCP_ADD_MESSAGE_TOOL: 'true' } },
    color: '#4A154B',
    website: 'https://github.com/korotovsky/slack-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M5.04 15.16a2.53 2.53 0 0 1-2.52 2.53A2.53 2.53 0 0 1 0 15.16a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.53 2.52v6.32A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.32z" fill="#E01E5A"/>
        <path d="M8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.53 2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 2.53 2.52 2.53 2.53 0 0 1-2.53 2.53H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31z" fill="#36C5F0"/>
        <path d="M18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.53h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-2.52 2.53 2.53 2.53 0 0 1-2.53-2.53V2.52A2.53 2.53 0 0 1 15.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31z" fill="#2EB67D"/>
        <path d="M15.17 18.96a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 15.17 24a2.53 2.53 0 0 1-2.53-2.52v-2.52h2.53zm0-1.27a2.53 2.53 0 0 1-2.53-2.52 2.53 2.53 0 0 1 2.53-2.53h6.31A2.53 2.53 0 0 1 24 15.17a2.53 2.53 0 0 1-2.52 2.52h-6.31z" fill="#ECB22E"/>
      </svg>
    ),
    connectLabel: 'Connect Slack',
    connectInstructions: 'On macOS with Chrome, tokens are auto-extracted. Otherwise: open app.slack.com in Chrome → F12 → Console → type `JSON.stringify({token: boot_data.api_token, cookie: document.cookie.match(/d=([^;]+)/)?.[1]})` → copy the result.',
    credentialFields: [
      { key: 'SLACK_MCP_XOXC_TOKEN', label: 'Slack Token (xoxc-...)', placeholder: 'Auto-detected via Sign in, or paste xoxc- token' },
      { key: 'SLACK_MCP_XOXD_TOKEN', label: 'Slack Cookie (xoxd-...)', placeholder: 'Auto-detected via Sign in, or paste xoxd- cookie' },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Read messages, send messages, manage channels, and interact with Discord servers via the OpenSwarm bot.',
    mcp_config: { type: 'stdio', command: 'python', args: ['-m', 'backend.apps.discord_mcp_shim'] },
    color: '#5865F2',
    website: 'https://github.com/barryyip0625/mcp-discord',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09a.09.09 0 0 0-.07-.03c-1.5.26-2.93.71-4.27 1.33a.07.07 0 0 0-.03.03c-2.72 4.07-3.47 8.03-3.1 11.95a.1.1 0 0 0 .04.07c1.83 1.34 3.6 2.16 5.34 2.7a.09.09 0 0 0 .1-.03c.41-.56.78-1.15 1.09-1.77a.09.09 0 0 0-.05-.13c-.58-.22-1.13-.49-1.66-.79a.09.09 0 0 1-.01-.16c.11-.08.22-.17.33-.25a.09.09 0 0 1 .09-.01c3.49 1.59 7.27 1.59 10.72 0a.09.09 0 0 1 .09.01c.11.09.22.17.33.26a.09.09 0 0 1-.01.16c-.53.31-1.08.57-1.66.79a.09.09 0 0 0-.05.13c.32.62.69 1.21 1.09 1.77a.09.09 0 0 0 .1.04c1.74-.54 3.51-1.36 5.34-2.7a.1.1 0 0 0 .04-.07c.44-4.53-.74-8.46-3.13-11.95a.07.07 0 0 0-.04-.04zM8.52 14.91c-1.04 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.04 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z" fill="#5865F2"/>
      </svg>
    ),
    authType: 'oauth2',
  },
];
