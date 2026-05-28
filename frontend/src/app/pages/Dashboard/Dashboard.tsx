import React from 'react';
import SelectionOverlay from '@/app/components/editor/SelectionOverlay';
import { ElementSelectionProvider } from '@/app/components/editor/ElementSelectionContext';
import { useDomElementSelector } from '@/app/components/editor/useDomElementSelector';
import { useDashboardController } from './hooks/state/useDashboardController';
import DashboardCanvas from './canvas/DashboardCanvas';

const DashboardSelectionOverlay: React.FC = () => {
  const { overlay, dragRect, dragPreview } = useDomElementSelector();
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
