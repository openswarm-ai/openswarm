import React from 'react';
import { WeatherWidget as AnimatedWeatherWidget } from '@toolui/components/weather-widget/weather-widget-container';
import type { WeatherConditionCode, ForecastDay } from '@toolui/components/weather-widget/schema-runtime';
import { useThemeMode } from '@/shared/styles/ThemeContext';
import type { WeatherProps } from './showUiPayload';

function toConditionCode(condition: string | undefined): WeatherConditionCode {
  // "Partly Cloudy with Slight Chance of Showers" is a partly-cloudy scene, not a rain scene: drop the chance-of qualifiers so the leading descriptor wins.
  const cond = (condition || '').toLowerCase().replace(/(slight |small )?chance( of)? (showers?|rain|snow|thunderstorms?)/g, '');
  if (/thunder|storm/.test(cond)) return 'thunderstorm';
  if (/heavy rain|downpour/.test(cond)) return 'heavy-rain';
  if (/drizzle/.test(cond)) return 'drizzle';
  if (/rain|shower/.test(cond)) return 'rain';
  if (/sleet/.test(cond)) return 'sleet';
  if (/hail/.test(cond)) return 'hail';
  if (/snow/.test(cond)) return 'snow';
  if (/fog|mist|haze/.test(cond)) return 'fog';
  if (/overcast/.test(cond)) return 'overcast';
  if (/partly|part sun|some cloud/.test(cond)) return 'partly-cloudy';
  if (/cloud/.test(cond)) return 'cloudy';
  if (/wind/.test(cond)) return 'windy';
  return 'clear';
}

/** Agent-facing 'weather' shape adapted onto the vendored animated (WebGL) weather widget. */
function WeatherWidget({ props }: { props: WeatherProps }): React.ReactElement {
  const { mode } = useThemeMode();
  const forecast: ForecastDay[] = (props.forecast || []).slice(0, 7).map((d) => ({
    label: d.day,
    conditionCode: toConditionCode(d.condition),
    tempMin: Math.round(d.low ?? (d.high ?? props.temp) - 8),
    tempMax: Math.round(d.high ?? (d.low ?? props.temp) + 8),
  }));

  return (
    // 4:3 card; the vendored strip reveals at 245px height and its day icons at 280px, so width must be >= 374 for the full frame look.
    <div className={`tool-ui-scope${mode === 'dark' ? ' dark' : ''}`} style={{ width: 384, maxWidth: '100%' }}>
      <AnimatedWeatherWidget
        version="3.1"
        id={`weather-${props.location}`}
        location={{ name: props.location }}
        units={{ temperature: props.unit === 'C' ? 'celsius' : 'fahrenheit' }}
        current={{
          conditionCode: toConditionCode(props.condition),
          temperature: Math.round(props.temp),
          tempMin: Math.round(props.low ?? props.temp - 4),
          tempMax: Math.round(props.high ?? props.temp + 4),
        }}
        forecast={forecast}
        time={{ localTimeOfDay: new Date().getHours() + new Date().getMinutes() / 60 }}
        effects={{ enabled: true, quality: 'auto' }}
      />
    </div>
  );
}

export default WeatherWidget;
