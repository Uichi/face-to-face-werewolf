import { useState } from 'react';
import type { BreadType } from '../domain/game.ts';
import { breadNames } from './action-choice.ts';

/** Only a publicly delivered bread or the viewer's own selection belongs here. */
export default function BreadImage({ type, compact = false }: { type?: BreadType; compact?: boolean }) {
  const [failedType, setFailedType] = useState<BreadType>();
  if (!type || failedType === type) return null;
  return <img key={type} className={`bread-image${compact ? ' compact' : ''}`} src={`/images/breads/${type}.png`} alt={type === 'surprise' ? 'おまかせのパンの盛り合わせ' : `焼きたての${breadNames[type]}`} width="240" height="240" loading="lazy" onError={() => setFailedType(type)} />;
}
