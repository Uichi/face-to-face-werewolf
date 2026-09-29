import type { Role } from '../domain/rules.ts';
import { roleNames } from './types.ts';

export default function RoleImage({ role, compact = false }: { role: Role; compact?: boolean }) {
  if (role === 'baker') return <div className={`role-art role-art-placeholder${compact ? ' role-art-compact' : ''}`} role="img" aria-label="パン屋の役職カード"><span>🥖</span><strong>パン屋</strong></div>;
  return <img className={`role-art${compact ? ' role-art-compact' : ''}`} src={`/images/roles/${role}.png`} alt={`${roleNames[role]}の役職カード`} width={1024} height={1536} loading={compact ? 'lazy' : 'eager'} decoding="async" />;
}
