import React from 'react';
import WeatherWidget from './WeatherWidget';
import PlanWidget from './PlanWidget';
import StatsWidget from './StatsWidget';
import LinksWidget from './LinksWidget';
import type { ShowUiPayload } from './showUiPayload';

/** One switch for every surface that renders a ShowUI payload (chat bubble, pill artifact). */
function ShowUiWidgetView({ payload }: { payload: ShowUiPayload }): React.ReactElement | null {
  if (payload.component === 'weather') return <WeatherWidget props={payload.props} />;
  if (payload.component === 'plan') return <PlanWidget props={payload.props} />;
  if (payload.component === 'stats') return <StatsWidget props={payload.props} />;
  if (payload.component === 'links') return <LinksWidget props={payload.props} />;
  return null;
}

export default ShowUiWidgetView;
