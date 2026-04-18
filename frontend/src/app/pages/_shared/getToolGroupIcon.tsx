import React from 'react';
import SvgIcon from '@mui/material/SvgIcon';
import LanguageIcon from '@mui/icons-material/Language';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';

const XLogoIcon: React.FC<{ sx?: object }> = ({ sx }) => (
  <SvgIcon sx={sx} viewBox="0 0 24 24">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </SvgIcon>
);

const GoogleIcon: React.FC<{ sx?: object }> = ({ sx }) => (
  <SvgIcon sx={sx} viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </SvgIcon>
);

const RedditIcon: React.FC<{ sx?: object }> = ({ sx }) => (
  <SvgIcon sx={sx} viewBox="0 0 24 24">
    <path d="M14.238 15.348c.085.084.085.221 0 .306-.465.462-1.194.687-2.231.687l-.008-.002-.008.002c-1.036 0-1.766-.225-2.231-.688-.085-.084-.085-.221 0-.305.084-.084.222-.084.307 0 .379.377 1.008.561 1.924.561l.008.002.008-.002c.915 0 1.544-.184 1.924-.561.085-.084.223-.084.307 0zm-3.44-2.418c0-.507-.414-.919-.922-.919-.509 0-.922.412-.922.919 0 .506.414.918.922.918.508 0 .922-.412.922-.918zm4.04-.919c-.509 0-.922.412-.922.919 0 .506.414.918.922.918.508 0 .922-.412.922-.918 0-.507-.414-.919-.922-.919zM12 2C6.478 2 2 6.477 2 12c0 5.522 4.478 10 10 10s10-4.478 10-10c0-5.523-4.478-10-10-10zm5.8 11.333c.02.14.03.283.03.428 0 2.19-2.547 3.964-5.69 3.964-3.142 0-5.69-1.774-5.69-3.964 0-.145.01-.288.03-.428A1.588 1.588 0 0 1 5.6 12c0-.881.716-1.596 1.599-1.596.424 0 .808.17 1.09.443 1.07-.742 2.554-1.22 4.19-1.284l.782-3.674a.11.11 0 0 1 .13-.083l2.603.556a1.132 1.132 0 0 1 2.154.481 1.134 1.134 0 0 1-1.132 1.133 1.132 1.132 0 0 1-1.105-.896l-2.318-.495-.69 3.248c1.6.08 3.046.56 4.094 1.29.283-.278.67-.45 1.099-.45.882 0 1.599.715 1.599 1.596 0 .56-.29 1.05-.726 1.334z" />
  </SvgIcon>
);

const TOOL_GROUP_ICONS: Record<string, React.FC<{ sx?: object }>> = {
  Twitter: XLogoIcon,
  Google: GoogleIcon,
  Reddit: RedditIcon,
  Web: LanguageIcon,
  View: ViewQuiltOutlinedIcon,
};

export function getToolGroupIcon(groupName: string, size: number = 15): React.ReactNode {
  const Icon = TOOL_GROUP_ICONS[groupName];
  if (Icon) return <Icon sx={{ fontSize: size }} />;
  return <BuildOutlinedIcon sx={{ fontSize: size }} />;
}
