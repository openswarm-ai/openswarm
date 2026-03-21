const port = (window as any).__OPENSWARM_PORT__ || 8324;
const host = window.location.hostname || 'localhost';

export const API_BASE = `http://${host}:${port}/api`;
export const WS_BASE = `ws://${host}:${port}`;
export const OPENSWARM_DEFAULT_PROXY_URL = 'https://api.openswarm.ai';
