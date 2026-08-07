import { store } from '@/shared/state/store';
import { openMarketplaceCard } from '@/shared/state/dashboardLayoutSlice';
import type { DirectoryTab } from './MarketplaceBody';

export function openMarketplace(tab: DirectoryTab = 'skills'): void {
  store.dispatch(openMarketplaceCard({ tab }));
}
