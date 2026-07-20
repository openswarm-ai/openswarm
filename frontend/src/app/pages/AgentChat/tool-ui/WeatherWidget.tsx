import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import WbSunnyOutlinedIcon from '@mui/icons-material/WbSunnyOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import GrainIcon from '@mui/icons-material/Grain';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import ThunderstormOutlinedIcon from '@mui/icons-material/ThunderstormOutlined';
import type { WeatherProps } from './showUiPayload';

function conditionIcon(condition: string | undefined, size: number): React.ReactElement {
  const cond = (condition || '').toLowerCase();
  const sx = { fontSize: size, color: 'rgba(255,255,255,0.92)' };
  if (/thunder|storm/.test(cond)) return <ThunderstormOutlinedIcon sx={sx} />;
  if (/rain|drizzle|shower/.test(cond)) return <GrainIcon sx={sx} />;
  if (/snow|sleet|ice/.test(cond)) return <AcUnitIcon sx={sx} />;
  if (/cloud|overcast|fog|mist/.test(cond)) return <CloudOutlinedIcon sx={sx} />;
  return <WbSunnyOutlinedIcon sx={sx} />;
}

/** iOS-style weather card: dusk-sky art, big thin temperature, five-day strip. */
function WeatherWidget({ props }: { props: WeatherProps }): React.ReactElement {
  const unit = props.unit || 'F';
  return (
    <Box
      sx={{
        width: 300,
        borderRadius: '16px',
        overflow: 'hidden',
        position: 'relative',
        p: 2,
        color: '#fff',
        background:
          'radial-gradient(120% 90% at 78% 62%, rgba(255,196,110,0.9) 0%, rgba(214,142,90,0.75) 30%, rgba(120,85,80,0.4) 55%, rgba(0,0,0,0) 75%), linear-gradient(180deg, #4d4048 0%, #6b5a58 45%, #8a6a55 100%)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
      }}
    >
      <Typography sx={{ fontSize: '1.05rem', fontWeight: 600, textShadow: '0 1px 8px rgba(0,0,0,0.35)' }}>
        {props.location}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', mt: 0.5 }}>
        <Typography sx={{ fontSize: '4rem', fontWeight: 200, lineHeight: 1, letterSpacing: '-2px', textShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
          {Math.round(props.temp)}
        </Typography>
        <Typography sx={{ fontSize: '1.6rem', fontWeight: 300, mt: 0.5, opacity: 0.85 }}>°{unit}</Typography>
      </Box>
      {(props.high != null || props.low != null) && (
        <Box sx={{ display: 'flex', gap: 1.5, mt: 1 }}>
          {props.high != null && (
            <Typography sx={{ fontSize: '0.9rem', fontWeight: 600 }}>
              <Box component="span" sx={{ opacity: 0.6, fontWeight: 400 }}>H </Box>{Math.round(props.high)}°
            </Typography>
          )}
          {props.low != null && (
            <Typography sx={{ fontSize: '0.9rem', fontWeight: 600 }}>
              <Box component="span" sx={{ opacity: 0.6, fontWeight: 400 }}>L </Box>{Math.round(props.low)}°
            </Typography>
          )}
        </Box>
      )}
      {props.forecast && props.forecast.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            mt: 2.5,
            borderRadius: '12px',
            background: 'rgba(255,255,255,0.14)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            px: 1,
            py: 1.25,
          }}
        >
          {props.forecast.slice(0, 5).map((d, i) => (
            <Box key={`${d.day}-${i}`} sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
              <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.85 }}>
                {d.day}
              </Typography>
              {conditionIcon(d.condition, 16)}
              <Typography sx={{ fontSize: '0.82rem', fontWeight: 700 }}>{Math.round(d.high)}°</Typography>
              {d.low != null && (
                <Typography sx={{ fontSize: '0.72rem', opacity: 0.6 }}>{Math.round(d.low)}°</Typography>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

export default WeatherWidget;
