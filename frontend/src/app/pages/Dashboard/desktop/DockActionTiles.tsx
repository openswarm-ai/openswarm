import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import { Globe, CalendarClock, Settings, LayoutGrid, Store } from 'lucide-react';
import { useAppDispatch } from '@/shared/hooks';
import { openSettingsCard, openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import { openMarketplace } from '@/app/pages/Directory/openMarketplace';
import UpdateReadyDot from '@/app/components/UpdateReadyDot';

// The dock reserves room for these before it knows what they are, so the count lives with the list.
export const DOCK_ACTION_COUNT = 5;

interface DockActionTilesProps {
  tile: number;
  onAddBrowser: () => void;
  onApplications: () => void;
  onHoverAway: () => void;
}

/** The dock's fixed group: browser, workflows, then settings + applications under their own divider. Action buttons are flat hairline glyphs resting on the rail material (running dock tiles above keep their colored tiles), so actions and running things read as different species. */
function DockActionTiles({ tile, onAddBrowser, onApplications, onHoverAway }: DockActionTilesProps): React.ReactElement {
  const dispatch = useAppDispatch();
  const actions: { label: string; Icon: typeof Globe; act: () => void; divider?: boolean; updateDot?: boolean }[] = [
    { label: 'Browsers', Icon: Globe, act: onAddBrowser },
    { label: 'Workflows', Icon: CalendarClock, act: () => dispatch(openWorkflowsApp()) },
    { label: 'Marketplace', Icon: Store, act: () => openMarketplace() },
    { label: 'Settings', Icon: Settings, act: () => dispatch(openSettingsCard()), divider: true, updateDot: true },
    { label: 'Applications', Icon: LayoutGrid, act: onApplications },
  ];

  return (
    <>
      {actions.map((a) => (
        <React.Fragment key={a.label}>
          {a.divider && <Box sx={{ width: tile - 16, height: '1px', background: 'rgba(255,255,255,0.10)', alignSelf: 'center', flexShrink: 0 }} />}
          <Tooltip title={a.label} placement="right">
            <Box
              className="osw-dock-tile"
              onClick={a.act}
              onMouseEnter={onHoverAway}
              sx={{
                position: 'relative',
                width: tile,
                height: tile,
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
                color: 'rgba(235, 235, 240, 0.72)',
                transition: 'background-color 0.15s ease, color 0.15s ease',
                '&:hover': { backgroundColor: 'rgba(255,255,255,0.10)', color: '#ffffff' },
                '&:active': { backgroundColor: 'rgba(255,255,255,0.16)' },
              }}
            >
              <a.Icon size={19} strokeWidth={1.5} />
              {a.updateDot && <UpdateReadyDot sx={{ position: 'absolute', top: 6, right: 6 }} />}
            </Box>
          </Tooltip>
        </React.Fragment>
      ))}
    </>
  );
}

export default DockActionTiles;
