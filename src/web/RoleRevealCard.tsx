import { useEffect, useState } from 'react';
import type { Role } from '../domain/rules.ts';
import { roleNames } from './types.ts';

export default function RoleRevealCard({role, animate, highlight = false, onComplete}: {role: Role; animate: boolean; highlight?: boolean; onComplete: () => void}) {
  const [backReady, setBackReady] = useState(false);
  const [frontReady, setFrontReady] = useState(false);
  const [backFailed, setBackFailed] = useState(false);
  const [frontFailed, setFrontFailed] = useState(false);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!animate) return;
    // A stalled image must not prevent the player from learning their role.
    const loadingFallback = window.setTimeout(() => setStarted(true), 1500);
    return () => window.clearTimeout(loadingFallback);
  }, [animate]);
  useEffect(() => { if (animate && backReady && frontReady) setStarted(true); }, [animate, backReady, frontReady]);
  useEffect(() => {
    if (!animate || !started) return;
    const fallback = window.setTimeout(onComplete, 800);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => { if (reduced.matches) onComplete(); };
    changed(); reduced.addEventListener('change', changed);
    return () => { window.clearTimeout(fallback); reduced.removeEventListener('change', changed); };
  }, [animate, started, onComplete]);
  return <div className={`role-reveal-card ${animate ? started ? 'is-turning' : 'is-preparing' : 'is-open'} ${highlight&&!animate&&(frontReady||frontFailed)?'has-private-glow':''}`} aria-label={animate ? '役職カードをめくっています' : `${roleNames[role]}の役職カード`} aria-busy={animate}>
    <div className="role-reveal-inner" onAnimationEnd={event => { if (event.target===event.currentTarget && event.animationName==='role-card-turn') onComplete(); }}>
      <div className="role-reveal-back" aria-hidden="true">
        {!backFailed && <img src="/images/roles/card-back.png" alt="" width={1024} height={1536} onLoad={()=>setBackReady(true)} onError={()=>{setBackReady(true);setBackFailed(true);}}/>}
        {backFailed && <span className="card-back-fallback">☾<span>夜のよりあい</span></span>}
      </div>
      <div className="role-reveal-front" aria-hidden={animate}>
        {!frontFailed && <img src={`/images/roles/${role}.png`} alt={animate?'':`${roleNames[role]}の役職カード`} width={1024} height={1536} onLoad={()=>setFrontReady(true)} onError={()=>{setFrontReady(true);setFrontFailed(true);}}/>}
        {frontFailed && <span className="card-front-fallback">{roleNames[role]}</span>}
      </div>
    </div>
  </div>;
}
