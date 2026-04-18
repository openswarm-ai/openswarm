import { API_BASE } from '@/shared/routes/base';

const SUBSCRIPTIONS_API: string = `${API_BASE}/subscriptions`;

export const SUBSCRIPTIONS_STATUS_API: string = `${SUBSCRIPTIONS_API}/status`;
export const SUBSCRIPTIONS_CONNECT_API: string = `${SUBSCRIPTIONS_API}/connect`;
export const SUBSCRIPTIONS_POLL_API: string = `${SUBSCRIPTIONS_API}/poll`;
export const SUBSCRIPTIONS_DISCONNECT_API: string = `${SUBSCRIPTIONS_API}/disconnect`;
export const SUBSCRIPTIONS_PENDING_API: (state: string) => string = (state: string) => `${SUBSCRIPTIONS_API}/pending/${state}`;
export const SUBSCRIPTIONS_CALLBACK_API: string = `${SUBSCRIPTIONS_API}/callback`;
