import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Modal from '@mui/material/Modal';
import CloseIcon from '@mui/icons-material/Close';

export interface AttachedImage {
  data: string;
  media_type: string;
  preview: string;
}

interface Props {
  images: AttachedImage[];
  onRemoveImage: (idx: number) => void;
  lightboxSrc: string | null;
  onOpenLightbox: (src: string) => void;
  onCloseLightbox: () => void;
  c: {
    border: { subtle: string; medium: string };
    bg: { surface: string; secondary: string };
    text: { secondary: string; tertiary: string; primary: string };
    shadow: { md: string };
  };
}

const ImageAttachments: React.FC<Props> = ({
  images, onRemoveImage, lightboxSrc, onOpenLightbox, onCloseLightbox, c,
}) => (
  <>
    {images.length > 0 && (
      <Box sx={{
        display: 'flex', gap: 0.75, px: 1.5, pt: 1, pb: 0.5, overflowX: 'auto',
        '&::-webkit-scrollbar': { height: 4 },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
      }}>
        {images.map((img, idx) => (
          <Box key={idx} sx={{
            position: 'relative', width: 56, height: 56, flexShrink: 0, borderRadius: '8px',
            overflow: 'hidden', border: `1px solid ${c.border.subtle}`, cursor: 'pointer',
            transition: 'opacity 0.15s, transform 0.15s',
            '&:hover': { opacity: 0.85, transform: 'scale(1.04)' },
          }} onClick={() => onOpenLightbox(img.preview)}>
            <img src={img.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); onRemoveImage(idx); }} sx={{
              position: 'absolute', top: -2, right: -2, width: 18, height: 18,
              bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
              color: c.text.tertiary,
              '&:hover': { bgcolor: c.bg.secondary, color: c.text.primary },
            }}>
              <CloseIcon sx={{ fontSize: 10 }} />
            </IconButton>
          </Box>
        ))}
      </Box>
    )}

    <Modal
      open={!!lightboxSrc}
      onClose={onCloseLightbox}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <Box onClick={onCloseLightbox} sx={{ position: 'relative', outline: 'none', maxWidth: '90vw', maxHeight: '90vh' }}>
        <IconButton onClick={onCloseLightbox} sx={{
          position: 'absolute', top: -16, right: -16, bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`, color: c.text.secondary,
          width: 32, height: 32, zIndex: 1, '&:hover': { bgcolor: c.bg.secondary },
          boxShadow: c.shadow.md,
        }}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
        <img
          src={lightboxSrc || ''} alt=""
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)', display: 'block',
          }}
        />
      </Box>
    </Modal>
  </>
);

export default ImageAttachments;
