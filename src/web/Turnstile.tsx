import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void; theme: 'light'; size: 'flexible' }) => string;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: TurnstileApi } }
let scriptReady: Promise<void> | null = null;
function load() {
  if (window.turnstile) return Promise.resolve();
  if (!scriptReady) scriptReady = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true; script.onload = () => resolve();
    script.onerror = () => { script.remove(); scriptReady = null; reject(new Error('確認画面を読み込めませんでした。')); };
    document.head.appendChild(script);
  });
  return scriptReady;
}
export default function Turnstile({ siteKey, onToken, onError }: { siteKey: string; onToken: (token: string) => void; onError: (error: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false; let id: string | undefined;
    void load().then(() => {
      if (disposed || !container.current || !window.turnstile) return;
      id = window.turnstile.render(container.current, { sitekey: siteKey, theme: 'light', size: 'flexible', callback: onToken,
        'expired-callback': () => onToken(''), 'error-callback': () => { onToken(''); onError('確認をやり直してください。'); } });
    }).catch(() => onError('確認画面を読み込めませんでした。ページを再読み込みしてください。'));
    return () => { disposed = true; if (id) window.turnstile?.remove(id); };
  }, [siteKey, onToken, onError]);
  return <div className="captcha" ref={container} />;
}
