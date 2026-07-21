import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { API_BASE } from '@/shared/config';

interface ApplicationsWindowProps {
  onClose: () => void;
}

const CATEGORY_RULES: Array<{ label: string; re: RegExp }> = [
  { label: 'Developer Tools', re: /code|cursor|docker|terminal|xcode|git|iterm|studio|postman|figma|utm|dev/i },
  { label: 'Productivity & Finance', re: /notion|calendar|mail|numbers|pages|keynote|excel|word|slides|office|linear|wallet|slack|zoom|meet|drive|todo|remind/i },
  { label: 'Social', re: /message|discord|telegram|whatsapp|signal|wechat|facetime|x\b|instagram/i },
  { label: 'Entertainment', re: /spotify|music|tv|netflix|youtube|game|steam|chess|vlc|iina|podcast/i },
  { label: 'Utilities', re: /calculator|clock|settings|finder|preview|utility|cleaner|monitor|keychain|archive|font/i },
  { label: 'Travel', re: /maps|weather|flight|uber|airbnb/i },
  { label: 'Creativity', re: /photo|imovie|garageband|final cut|logic|premiere|illustrator|sketch|blender|procreate|paint|davinci/i },
  { label: 'Information', re: /news|books|stocks|dictionary|wiki|safari|chrome|edge|firefox|arc|browser/i },
];

function categorize(name: string): string {
  for (const rule of CATEGORY_RULES) if (rule.re.test(name)) return rule.label;
  return 'Other';
}

function LetterTile({ name }: { name: string }): React.ReactElement {
  const letter = name.match(/[a-z0-9]/i)?.[0]?.toUpperCase() || '?';
  return (
    <Box
      sx={{
        width: 52,
        height: 52,
        borderRadius: '12px',
        background: 'linear-gradient(135deg, rgba(255,255,255,0.22), rgba(255,255,255,0.08))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1.3rem',
        fontWeight: 700,
        color: 'rgba(255,255,255,0.85)',
      }}
    >
      {letter}
    </Box>
  );
}

/** Launchpad-style window over the canvas: the user's real /Applications, categorized. */
function ApplicationsWindow({ onClose }: ApplicationsWindowProps): React.ReactElement {
  const [apps, setApps] = useState<string[] | null>(null);
  const [error, setError] = useState(false);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [category, setCategory] = useState<string>('All');

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/onboarding/scan`, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const names: string[] = Array.isArray(d?.apps) ? d.apps : [];
        setApps(names);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  const getIcon = (window as unknown as { openswarm?: { getAppIcon?: (n: string) => Promise<string | null> } }).openswarm?.getAppIcon;
  useEffect(() => {
    if (!apps || !getIcon) return;
    let cancelled = false;
    (async () => {
      for (const name of apps.slice(0, 60)) {
        if (cancelled) return;
        try {
          const dataUrl = await getIcon(name);
          if (cancelled) return;
          if (dataUrl) setIcons((prev) => (prev[name] ? prev : { ...prev, [name]: dataUrl }));
        } catch {
          /* icon-less tile falls back to the letter */
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps]);

  const categories = useMemo(() => {
    if (!apps) return [];
    const present = new Set(apps.map(categorize));
    return ['All', ...CATEGORY_RULES.map((r) => r.label).filter((l) => present.has(l)), ...(present.has('Other') ? ['Other'] : [])];
  }, [apps]);

  const visible = useMemo(() => {
    if (!apps) return [];
    return category === 'All' ? apps : apps.filter((a) => categorize(a) === category);
  }, [apps, category]);

  const openApp = (window as unknown as { openswarm?: { openApplication?: (n: string) => Promise<boolean> } }).openswarm?.openApplication;

  return (
    <>
      <Box onClick={onClose} sx={{ position: 'absolute', inset: 0, zIndex: 19 }} />
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 20,
          width: 620,
          maxWidth: 'calc(100% - 80px)',
          maxHeight: 'calc(100% - 120px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '18px',
          background: 'rgba(22,12,34,0.82)',
          backdropFilter: 'blur(28px) saturate(160%)',
          WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          p: 2.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 1.5 }}>
          <Typography sx={{ fontSize: '1.15rem' }}>🐙</Typography>
          <Typography sx={{ fontSize: '1.05rem', fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>
            Applications
          </Typography>
        </Box>

        {categories.length > 1 && (
          <Box sx={{ display: 'flex', gap: 0.75, mb: 2, overflowX: 'auto', pb: 0.5, scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
            {categories.map((cat) => (
              <Box
                key={cat}
                onClick={() => setCategory(cat)}
                sx={{
                  px: 1.25,
                  py: 0.4,
                  borderRadius: 999,
                  flexShrink: 0,
                  cursor: 'pointer',
                  fontSize: '0.72rem',
                  fontWeight: 500,
                  color: category === cat ? '#fff' : 'rgba(255,255,255,0.6)',
                  background: category === cat ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)',
                  '&:hover': { background: 'rgba(255,255,255,0.16)' },
                }}
              >
                {cat}
              </Box>
            ))}
          </Box>
        )}

        <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 120 }}>
          {!apps && !error && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress size={22} sx={{ color: 'rgba(255,255,255,0.5)' }} />
            </Box>
          )}
          {error && (
            <Typography sx={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.85rem', textAlign: 'center', py: 5 }}>
              Could not read /Applications.
            </Typography>
          )}
          {apps && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(78px, 1fr))', gap: 1.5 }}>
              {visible.map((name) => (
                <Box
                  key={name}
                  onClick={() => { if (openApp) void openApp(name); }}
                  title={name}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 0.75,
                    py: 0.75,
                    borderRadius: '10px',
                    cursor: openApp ? 'pointer' : 'default',
                    '&:hover': openApp ? { background: 'rgba(255,255,255,0.08)' } : undefined,
                  }}
                >
                  {icons[name] ? (
                    <Box component="img" src={icons[name]} alt="" sx={{ width: 52, height: 52, borderRadius: '12px' }} />
                  ) : (
                    <LetterTile name={name} />
                  )}
                  <Typography sx={{ fontSize: '0.66rem', color: 'rgba(255,255,255,0.82)', textAlign: 'center', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    </>
  );
}

export default ApplicationsWindow;
