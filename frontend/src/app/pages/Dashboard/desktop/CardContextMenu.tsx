import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import CardMenuPanel, { MENU_WIDTH } from './CardMenuPanel';
import { CARD_MENU_EVENT, isMenuAction, type CardMenuAction, type CardMenuRequest, type CardMenuRow } from './openCardContextMenu';

// INVARIANT: the canvas pans/zooms via a CSS transform, and a transformed ancestor becomes the
// containing block for position:fixed, so this menu portals to document.body and never mounts inside
// the canvas subtree. A DOM menu also cannot cover an Electron <webview>: guest pages get Electron's
// own native menu, and a page that preventDefaults its contextmenu gets neither. That is expected.
const EDGE = 8;
const TOP_LAYER = 2147483647;

interface Placement {
  x: number;
  y: number;
  origin: string;
  nudgeX: number;
  nudgeY: number;
}

function place(x: number, y: number, w: number, h: number): Placement {
  const flipX = x + w > window.innerWidth - EDGE && x - w >= EDGE;
  const flipY = y + h > window.innerHeight - EDGE && y - h >= EDGE;
  const rawX = flipX ? x - w : x;
  const rawY = flipY ? y - h : y + 2;
  return {
    x: Math.max(EDGE, Math.min(rawX, window.innerWidth - w - EDGE)),
    y: Math.max(EDGE, Math.min(rawY, window.innerHeight - h - EDGE)),
    origin: `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`,
    nudgeX: flipX ? 4 : -4,
    nudgeY: flipY ? 4 : -4,
  };
}

function step(items: CardMenuRow[], from: number | null, dir: 1 | -1): number | null {
  const n = items.length;
  if (n === 0) return null;
  for (let hop = 1; hop <= n; hop += 1) {
    const i = ((from ?? (dir === 1 ? -1 : 0)) + dir * hop + n * 2) % n;
    const row = items[i];
    if (isMenuAction(row) && !row.disabled) return i;
  }
  return null;
}

function CardContextMenu(): React.ReactElement | null {
  const [menu, setMenu] = useState<CardMenuRequest | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [rootPlacement, setRootPlacement] = useState<Placement | null>(null);
  const [shown, setShown] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [subActiveIndex, setSubActiveIndex] = useState<number | null>(null);
  const [subPlacement, setSubPlacement] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  const close = useCallback((): void => {
    setMenu(null);
    setRootPlacement(null);
    setSubPlacement(null);
    setShown(false);
    setOpenIndex(null);
    setActiveIndex(null);
    setSubActiveIndex(null);
    const back = returnFocusTo.current;
    returnFocusTo.current = null;
    if (back && back.isConnected) back.focus?.();
  }, []);

  useEffect(() => {
    const onOpen = (e: Event): void => {
      const req = (e as CustomEvent).detail as CardMenuRequest;
      returnFocusTo.current = document.activeElement as HTMLElement | null;
      setMenu(req);
      setRootPlacement(null);
      setSubPlacement(null);
      setShown(false);
      setOpenIndex(null);
      setActiveIndex(null);
      setSubActiveIndex(null);
      setRenaming(false);
      setRenameValue(req.rename?.value ?? '');
    };
    window.addEventListener(CARD_MENU_EVENT, onOpen);
    return () => window.removeEventListener(CARD_MENU_EVENT, onOpen);
  }, []);

  // Body stamp so hover-dismiss surfaces (the Spaces strip) can hold still while a menu is up.
  useEffect(() => {
    document.body.classList.toggle('osw-card-menu-open', !!menu);
    return () => document.body.classList.remove('osw-card-menu-open');
  }, [menu]);

  // Measured, never guessed: rows render ~30px, so a hardcoded row height over-corrects long menus.
  useLayoutEffect(() => {
    if (!menu || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    setRootPlacement(place(menu.x, menu.y, r.width || MENU_WIDTH, r.height));
  }, [menu]);

  // One frame at the pre-entry style, otherwise there is no start value for the transition to run from.
  useEffect(() => {
    if (!rootPlacement || shown) return undefined;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [rootPlacement, shown]);

  const openRow = menu && openIndex !== null ? menu.items[openIndex] : undefined;
  const submenu = openRow && isMenuAction(openRow) ? (openRow as CardMenuAction).submenu : undefined;

  useLayoutEffect(() => {
    if (!submenu || !subRef.current || !rootRef.current || openIndex === null) return;
    const r = subRef.current.getBoundingClientRect();
    const panel = rootRef.current.getBoundingClientRect();
    const rowEl = rootRef.current.querySelector(`[data-menu-row="${openIndex}"]`);
    const anchorY = (rowEl?.getBoundingClientRect().top ?? panel.top) - 6;
    const toRight = panel.right - 4;
    const fits = toRight + r.width <= window.innerWidth - EDGE;
    const x = fits ? toRight : panel.left - r.width + 4;
    setSubPlacement({
      x: Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE)),
      y: Math.max(EDGE, Math.min(anchorY, window.innerHeight - r.height - EDGE)),
      origin: `${fits ? 'left' : 'right'} top`,
      nudgeX: fits ? -4 : 4,
      nudgeY: 0,
    });
  }, [submenu, openIndex]);

  const runRow = useCallback((row: CardMenuRow | undefined): void => {
    if (!row || !isMenuAction(row) || row.disabled || row.submenu) return;
    close();
    row.onClick?.();
  }, [close]);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e: Event): void => {
      const t = e.target as Node | null;
      if (t && (rootRef.current?.contains(t) || subRef.current?.contains(t))) return;
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      const items = menu.items;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (openIndex !== null) { setOpenIndex(null); setSubActiveIndex(null); return; }
        close();
        return;
      }
      if (submenu && openIndex !== null) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setSubActiveIndex(step(submenu, subActiveIndex, e.key === 'ArrowDown' ? 1 : -1));
          return;
        }
        if (e.key === 'ArrowLeft') { e.preventDefault(); setOpenIndex(null); setSubActiveIndex(null); return; }
        if (e.key === 'Enter' && subActiveIndex !== null) { e.preventDefault(); runRow(submenu[subActiveIndex]); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(step(items, activeIndex, e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      const active = activeIndex !== null ? items[activeIndex] : undefined;
      if (e.key === 'ArrowRight' && active && isMenuAction(active) && active.submenu) {
        e.preventDefault();
        setOpenIndex(activeIndex);
        setSubActiveIndex(step(active.submenu, null, 1));
        return;
      }
      if (e.key === 'Enter' && active) {
        e.preventDefault();
        if (isMenuAction(active) && active.submenu) { setOpenIndex(activeIndex); setSubActiveIndex(step(active.submenu, null, 1)); return; }
        runRow(active);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onDown, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onDown);
      window.removeEventListener('resize', close);
    };
  }, [menu, activeIndex, openIndex, subActiveIndex, submenu, close, runRow]);

  if (!menu) return null;

  const commitRename = (): void => {
    const trimmed = renameValue.trim();
    if (trimmed && menu.rename && trimmed !== menu.rename.value) menu.rename.onCommit(trimmed);
    close();
  };

  const entry = (p: Placement | null, visible: boolean): Record<string, unknown> => ({
    position: 'fixed' as const,
    left: p?.x ?? -9999,
    top: p?.y ?? -9999,
    pointerEvents: 'auto' as const,
    opacity: visible ? 1 : 0,
    transform: visible ? 'none' : `translate(${p?.nudgeX ?? 0}px, ${p?.nudgeY ?? 4}px) scale(0.97)`,
    transformOrigin: p?.origin ?? 'left top',
    transition: 'opacity 140ms cubic-bezier(0.25,0.46,0.45,0.94), transform 170ms cubic-bezier(0.25,0.46,0.45,0.94)',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none', transform: 'none' },
  });

  return createPortal(
    <Box role="menu" onContextMenu={(e: React.MouseEvent) => e.preventDefault()} sx={{ position: 'fixed', inset: 0, zIndex: TOP_LAYER, pointerEvents: 'none' }}>
      <Box data-card-context-menu sx={entry(rootPlacement, shown)}>
        <CardMenuPanel
          ref={rootRef}
          items={menu.items}
          activeIndex={activeIndex}
          openIndex={openIndex}
          onActivate={(i) => {
            const row = menu.items[i];
            if (isMenuAction(row) && row.submenu) { setOpenIndex(i); setActiveIndex(i); setSubActiveIndex(null); return; }
            runRow(row);
          }}
          onHover={(i) => {
            setActiveIndex(i);
            const row = menu.items[i];
            if (isMenuAction(row) && row.submenu) { setOpenIndex(i); setSubActiveIndex(null); } else setOpenIndex(null);
          }}
        >
          {menu.rename && (renaming ? (
            <Box
              component="input"
              autoFocus
              value={renameValue}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') close();
              }}
              onBlur={commitRename}
              sx={{
                width: '100%', boxSizing: 'border-box', mb: '2px', px: '9px', py: '6px',
                border: '1px solid rgba(255,255,255,0.35)', borderRadius: '8px',
                background: 'rgba(0,0,0,0.35)', outline: 'none',
                color: 'rgba(255,255,255,0.95)', fontFamily: 'inherit', fontSize: '0.8125rem',
              }}
            />
          ) : (
            <Box
              component="button"
              type="button"
              onMouseEnter={() => { setActiveIndex(null); setOpenIndex(null); }}
              onClick={() => setRenaming(true)}
              sx={{
                display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box',
                px: '9px', py: '5px', minHeight: 30, border: 'none', background: 'transparent',
                borderRadius: '8px', color: 'rgba(255,255,255,0.9)', fontFamily: 'inherit',
                fontSize: '0.8125rem', cursor: 'pointer', textAlign: 'left',
                '&:hover': { background: 'rgba(255,255,255,0.10)' },
              }}
            >
              Rename
            </Box>
          ))}
        </CardMenuPanel>
      </Box>
      {submenu && (
        <Box sx={entry(subPlacement, shown && !!subPlacement)}>
          <CardMenuPanel ref={subRef} items={submenu} activeIndex={subActiveIndex} openIndex={null} onActivate={(i) => runRow(submenu[i])} onHover={setSubActiveIndex} />
        </Box>
      )}
    </Box>,
    document.body,
  );
}

export default CardContextMenu;
