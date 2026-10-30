import RoleImage from './RoleImage.tsx';

export default function HunterEffect({ mode = 'ready' }: { mode?: 'ready' | 'shot' }) {
  return <div className={`hunter-effect hunter-effect-${mode}`} aria-hidden="true">
    {mode === 'ready' && <RoleImage role="hunter" compact/>}
    <svg className="hunter-reticle" viewBox="0 0 120 120" fill="none"><circle cx="60" cy="60" r="36"/><circle className="hunter-inner-ring" cx="60" cy="60" r="22"/><path d="M60 8v30M60 82v30M8 60h30M82 60h30"/><circle cx="60" cy="60" r="3" className="hunter-center"/></svg>
    {mode === 'shot' && <span className="hunter-shot-ring"/>}
  </div>;
}
