import React, { useEffect, useState } from 'react';
import ShareModal from './ShareModal';
import type { ShareTarget } from './shareTypes';

export const SHARE_REQUEST_EVENT = 'openswarm:share-entity';

export function requestShare(target: ShareTarget): void {
  window.dispatchEvent(new CustomEvent(SHARE_REQUEST_EVENT, { detail: target }));
}

/** One global mount that turns share requests from stateless menu rows (card context menu, dock
 * tiles) into the ShareModal; the row can't own modal state because the menu unmounts on click. */
const ShareRequestHost: React.FC = () => {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  useEffect(() => {
    const onShare = (e: Event): void => {
      const detail = (e as CustomEvent).detail as ShareTarget | undefined;
      if (detail && detail.kind && detail.id) setTarget(detail);
    };
    window.addEventListener(SHARE_REQUEST_EVENT, onShare);
    return () => window.removeEventListener(SHARE_REQUEST_EVENT, onShare);
  }, []);
  if (!target) return null;
  return <ShareModal target={target} open onClose={() => setTarget(null)} />;
};

export default ShareRequestHost;
