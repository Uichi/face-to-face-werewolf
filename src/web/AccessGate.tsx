import { useState } from 'react';
import type { FormEvent } from 'react';
import { captchaSiteKey, unlockSite } from './api.ts';
import Turnstile from './Turnstile.tsx';

export default function AccessGate({ needsCaptcha, onUnlocked }: { needsCaptcha: boolean; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [captchaVersion, setCaptchaVersion] = useState(0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await unlockSite(password, token || undefined);
      if (!result.ok) {
        setError(result.message || 'パスワードを確認してください。');
        setPassword(''); setToken(''); setCaptchaVersion(value => value + 1);
        return;
      }
      onUnlocked();
    } catch (cause) {
      setError((cause as Error).message);
      setToken(''); setCaptchaVersion(value => value + 1);
    } finally { setBusy(false); }
  }

  return <main className="access-gate">
    <section className="access-card" aria-labelledby="access-title">
      <div className="access-mark" aria-hidden="true">☾</div>
      <div className="section-number">PRIVATE GATHERING</div>
      <h1 id="access-title">合言葉を入力してください</h1>
      <p>この集まりを知っている人だけが入れます。</p>
      {error && <div className="message error" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <label>合言葉
          <div className="password-field"><input type={visible ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} required autoFocus autoComplete="current-password" enterKeyHint="go"/><button type="button" onClick={() => setVisible(value => !value)} aria-label={visible ? '合言葉を隠す' : '合言葉を表示する'}>{visible ? '隠す' : '表示'}</button></div>
        </label>
        {needsCaptcha && captchaSiteKey && <Turnstile key={captchaVersion} siteKey={captchaSiteKey} onToken={setToken} onError={setError}/>} 
        <button className="primary" disabled={busy || !password || (needsCaptcha && !token)}>{busy ? '確認しています…' : '中へ入る'}</button>
      </form>
      <small>一度確認すると、この端末では30日間入力を省略できます。</small>
    </section>
  </main>;
}
