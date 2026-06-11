import React from 'react';
import SelectionOverlay from '@/app/components/editor/SelectionOverlay';
import { ElementSelectionProvider } from '@/app/components/editor/ElementSelectionContext';
import { useDomElementSelector } from '@/app/components/editor/useDomElementSelector';
import { useDashboardActive } from '@/shared/hooks/useDashboardActive';
import { useDashboardController } from './hooks/state/useDashboardController';
import DashboardCanvas from './canvas/DashboardCanvas';

const DashboardSelectionOverlay: React.FC = () => {
  const active = useDashboardActive();
  const { overlay, dragRect, dragPreview } = useDomElementSelector();
  // Selection state stays in context so it restores on return; we just stop
  // portaling highlights over whatever route is currently on top.
  if (!active) return null;
  return <SelectionOverlay overlay={overlay} dragRect={dragRect} dragPreview={dragPreview} />;
};

interface DashboardProps {
  dashboardId: string;
  isActive?: boolean;
}

const DashboardInner: React.FC<DashboardProps> = ({ dashboardId, isActive = true }) => {
  const controller = useDashboardController(dashboardId, isActive);
  return (
    <>
      <DashboardSelectionOverlay />
      <DashboardCanvas {...controller} />
    </>
  );
};

const Dashboard: React.FC<DashboardProps> = ({ dashboardId, isActive = true }) => (
  <ElementSelectionProvider>
    <DashboardInner dashboardId={dashboardId} isActive={isActive} />
  </ElementSelectionProvider>
);

export default Dashboard;
