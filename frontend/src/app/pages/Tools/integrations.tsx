import React from 'react';
import { AirtableIcon, DiscordIcon, GitHubIcon, GoogleWorkspaceIcon, HubSpotIcon, Microsoft365Icon, NotionIcon, RedditIcon, SlackIcon, SpotifyIcon, TikTokIcon, XIcon, YouTubeIcon } from './integrationIcons';

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
    icon: XIcon,
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
    connectInstructions: 'IMPORTANT: Spotify DRM blocks internal browsers. When you run a command for the first time, an external browser window will automatically open. Please sign into Spotify in that external window. Do NOT log in via the internal OpenSwarm browser, as playback will fail.',
    icon: SpotifyIcon,
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
    icon: TikTokIcon,
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
    icon: RedditIcon,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    description: 'Get video transcripts, details, comments, search videos, and channel stats. Transcripts work with no API key.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@kirbah/mcp-youtube'] },
    color: '#FF0000',
    website: 'https://www.npmjs.com/package/@kirbah/mcp-youtube',
    icon: YouTubeIcon,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, pull requests, Actions, code search, and gists. Connects with your GitHub account.',
    mcp_config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/x/all' },
    color: '#181717',
    website: 'https://github.com/github/github-mcp-server',
    icon: GitHubIcon,
    authType: 'oauth2',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Including Google Docs, Sheets, Slides, Calendar, and Gmail. (Gemini CLI extension)',
    mcp_config: { type: 'stdio', command: 'uvx', args: ['--from', 'google-workspace-mcp', 'google-workspace-worker'] },
    color: '#4285F4',
    website: 'https://developers.google.com/gemini-api/docs/mcp',
    icon: GoogleWorkspaceIcon,
    authType: 'oauth2',
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    description: 'Outlook email, Calendar, OneDrive, Excel, OneNote, Tasks, Contacts, Teams, and SharePoint.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@softeria/ms-365-mcp-server'] },
    color: '#0078D4',
    website: 'https://www.npmjs.com/package/@softeria/ms-365-mcp-server',
    icon: Microsoft365Icon,
    authType: 'device_code',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Create, read, and update pages, databases, and blocks in Notion workspaces.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
    color: '#000000',
    website: 'https://www.npmjs.com/package/@notionhq/notion-mcp-server',
    icon: NotionIcon,
    authType: 'oauth2',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and write records, manage bases, tables, and fields in Airtable.',
    mcp_config: { type: 'http', url: 'https://mcp.airtable.com/mcp' },
    color: '#18BFFF',
    website: 'https://airtable.com/developers/web/api/introduction',
    icon: AirtableIcon,
    authType: 'oauth2',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'CRM contacts, deals, companies, tickets, and more. Free CRM tier included.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@hubspot/mcp-server'] },
    color: '#FF7A59',
    website: 'https://developers.hubspot.com/docs/guides/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
    icon: HubSpotIcon,
    authType: 'oauth2',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Search messages, send messages, read channels, DMs, and threads in Slack workspaces.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'], env: { SLACK_MCP_ADD_MESSAGE_TOOL: 'true' } },
    color: '#4A154B',
    website: 'https://github.com/korotovsky/slack-mcp-server',
    icon: SlackIcon,
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
    icon: DiscordIcon,
    authType: 'oauth2',
  },
];
