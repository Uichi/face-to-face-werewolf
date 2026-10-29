import { useState } from 'react';
import type { BreadType } from '../domain/game.ts';

/** Only a publicly delivered bread or the viewer's own selection belongs here. */
export default function BreadImage({ type, compact = false }: { type?: BreadType; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (type !== 'croissant' || failed) return null;
  return <img className={`bread-image${compact ? ' compact' : ''}`} src="/images/breads/croissant.png" alt="焼きたてのクロワッサン" width="240" height="240" loading="lazy" onError={() => setFailed(true)} />;
}
