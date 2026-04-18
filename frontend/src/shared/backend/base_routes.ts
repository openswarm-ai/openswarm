const port: number = (window as any).__OPENSWARM_PORT__ || 8325;
const host: string = window.location.hostname || 'localhost';

export const API_BASE: string = `http://${host}:${port}/api`;
export const WS_BASE: string = `ws://${host}:${port}`;
