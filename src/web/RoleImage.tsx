import type { Role } from '../domain/rules.ts';
import { roleNames } from './types.ts';

export default function RoleImage({ role, compact = false }: { role: Role; compact?: boolean }) {
  return <img className={`role-art${compact ? ' role-art-compact' : ''}`} src={`/images/roles/${role}.png`} alt={`${roleNames[role]}の役職カード`} width={1024} height={1536} onLoad={event => { event.currentTarget.hidden=false; }} onError={event => { const image=event.currentTarget; image.hidden=true; }} loading={compact ? 'lazy' : 'eager'} decoding="async" />;
}
