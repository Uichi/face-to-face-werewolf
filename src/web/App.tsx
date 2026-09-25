import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import QRCode from 'qrcode';
import { DEFAULT_COMPOSITIONS, validateComposition } from '../domain/rules.ts';
import type { Composition, Role } from '../domain/rules.ts';
import { captchaSiteKey, configured, ensureSession, hasSession, lobby, watchRoom } from './api.ts';
import type { Room } from './types.ts';
import { roleNames } from './types.ts';
import Turnstile from './Turnstile.tsx';

const LAST_ROOM = 'werewolf.last-room';
const REQUEST = 'werewolf.create-request';
const names = ['あなた', 'あおい', 'はる', 'みなと', 'ひなた'];
const demoRoom = (): Room => ({ id: 'preview', code: 'A7C92F4B10', hostId: 'p0', viewerId: 'p0', status: 'waiting', revision: 1,
  discussionMinutes: 3, composition: { ...DEFAULT_COMPOSITIONS[5]! }, customComposition: false,
  members: names.map((nickname, i) => ({ id: `p${i}`, nickname, connected: true })) });
function readSaved(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string | null) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* The auth layer reports storage failures. */ } }
function inviteCode() { return new URLSearchParams(location.search).get('room')?.replace(/[\s-]/g, '').toUpperCase() ?? ''; }
function Moon({ small = false }: { small?: boolean }) {
  return <svg width={small ? 24 : 48} height={small ? 24 : 48} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M35 31A17 17 0 0 1 17 8a18 18 0 1 0 18 23Z" fill="currentColor"/><path d="m34 7 1.6 4.4L40 13l-4.4 1.6L34 19l-1.6-4.4L28 13l4.4-1.6Z" fill="currentColor"/></svg>;
}
function Forest() {
  return <svg className="forest" viewBox="0 0 600 320" fill="none" aria-hidden="true">
    <circle cx="437" cy="68" r="39" fill="#e4c790"/><circle cx="455" cy="52" r="37" fill="#203b33"/>
    <path d="M0 245Q130 158 290 237T600 203V320H0Z" fill="#365347"/><path d="M0 288Q170 211 333 284T600 234V320H0Z" fill="#294438"/>
    {[60, 126, 502, 552].map((x, i) => <g key={x} fill={i % 2 ? '#142b24' : '#1b332a'}><path d={`M${x} ${88 + i * 13} l-38 118 h23 l-36 54 h41 v60 h19 v-60 h36 l-36-54 h24Z`}/></g>)}
    <path d="m286 275 12-46-9-31 23 14 28-11 15-30 9 37-12 29-10 38 16 28h-18l-16-29-13 9-4 20h-20l8-27Z" fill="#e5dfcd"/><path d="m286 269-29-15-17 9 24 26 28-2" fill="#e5dfcd"/><circle cx="345" cy="217" r="2.4" fill="#203b33"/>
    <g fill="#dfc995"><circle cx="207" cy="53" r="2"/><circle cx="322" cy="84" r="2"/><circle cx="145" cy="35" r="1.5"/><circle cx="517" cy="43" r="1.5"/><path d="m269 111 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/></g>
  </svg>;
}

export default function App() {
  const [screen, setScreen] = useState<'home' | 'create' | 'join'>(inviteCode() ? 'join' : 'home');
  const [room, setRoom] = useState<Room | null>(null);
  const [preview, setPreview] = useState(false);
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(inviteCode());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sessionExists, setSessionExists] = useState(false);
  const [token, setToken] = useState('');
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const [savedRoom, setSavedRoom] = useState(readSaved(LAST_ROOM));
  const operation = useRef(false);
  const needsCaptcha = configured && Boolean(captchaSiteKey) && !sessionExists;

  useEffect(() => { void hasSession().then(setSessionExists).catch(() => {}); }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('preview')) { setPreview(true); setRoom(demoRoom()); }
  }, []);

  const resume = useCallback(async (id: string) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try {
      if (!await hasSession()) throw new Error('このブラウザの参加情報が見つかりません。招待コードから参加してください。');
      const restored = await lobby('heartbeat', { roomId: id });
      setPreview(false); setRoom(restored);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); operation.current = false; }
  }, []);
  useEffect(() => {
    if (configured && savedRoom && !inviteCode() && !new URLSearchParams(location.search).has('preview')) void resume(savedRoom);
    // The mount restore must not run again after a user chooses another screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  useEffect(() => {
    if (!room || preview) return;
    const id = room.id; let disposed = false; let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const next = await lobby('heartbeat', { roomId: id });
        if (!disposed) {
          setRoom(current => current?.id === id && next.revision >= current.revision ? next : current);
          setSyncing(false);
        }
      } catch { if (!disposed) setSyncing(true); }
      finally { loading = false; }
    };
    const stop = watchRoom(id, () => { void refresh(); });
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    const visible = () => { void refresh(); };
    window.addEventListener('online', visible); document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => { disposed = true; stop(); clearInterval(timer); window.removeEventListener('online', visible); document.removeEventListener('visibilitychange', visible); };
  }, [room?.id, preview]);

  async function enterRoom(event: FormEvent) {
    event.preventDefault(); if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try {
      await ensureSession(token || undefined); setSessionExists(true);
      let requestId = readSaved(REQUEST);
      if (screen === 'create' && !requestId) { requestId = crypto.randomUUID(); save(REQUEST, requestId); }
      const next = await lobby(screen === 'create' ? 'create' : 'join', { nickname: nickname.normalize('NFKC').trim(), code, requestId });
      save(LAST_ROOM, next.id); setSavedRoom(next.id); save(REQUEST, null);
      setRoom(next); setPreview(false); setNotice('');
      history.replaceState(null, '', location.pathname);
    } catch (e) { setError((e as Error).message); setToken(''); setCaptchaVersion(v => v + 1); }
    finally { setBusy(false); operation.current = false; }
  }
  function home() { setRoom(null); setScreen('home'); setError(''); setNotice(''); setPreview(false); history.replaceState(null, '', location.pathname); }
  async function updateSettings(composition: Composition | null, discussionMinutes: number) {
    if (!room || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (preview) setRoom({ ...room, composition: composition ?? { ...DEFAULT_COMPOSITIONS[room.members.length]! }, customComposition: composition !== null, discussionMinutes, revision: room.revision + 1 });
      else {
        const updated = await lobby('settings', { roomId: room.id, revision: room.revision, composition, discussionMinutes });
        setRoom(current => current?.id === updated.id && current.revision <= updated.revision ? updated : current);
      }
      setNotice(preview ? 'プレビューの設定を変更しました。' : '設定を保存しました。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); operation.current = false; }
  }

  return <div className="app">
    <header className="site-header"><button className="brand" onClick={home} aria-label="夜のよりあい トップへ"><Moon small/><span>夜のよりあい</span></button><span className="header-note">集まって、話して、見抜こう。</span><span className="edition">対面人狼</span></header>
    <main>
      {preview && <div className="preview-banner">画面プレビュー <span>参加者は見本です。実際の部屋は作成されません。</span><button onClick={home}>終了</button></div>}
      {error && <div className="message error" role="alert">{error}</div>}
      {notice && <div className="message" role="status">{notice}</div>}
      {room ? <Lobby room={room} preview={preview} busy={busy} syncing={syncing} onSave={updateSettings} onNotice={setNotice} /> : <>
        {screen === 'home' ? <div className="home-grid">
          <section className="hero"><div className="eyebrow">A LITTLE MYSTERY, TOGETHER.</div><h1>いつもの顔に、<br/>ひとつの秘密。</h1><p>この中に、人狼がいる。<br/>同じ場所に集まった仲間と、<br/>スマホひとつで始まる推理の夜。</p><div className="hero-tags"><span>5〜10人</span><span>司会者いらず</span><span>登録不要</span></div><Forest/></section>
          <section className="home-actions"><div className="section-number">01 — 集まる</div><h2>さあ、席につこう。</h2><p className="muted">会話は目の前で。進行はおまかせ。</p>
            <button className="action-card" onClick={() => { setScreen('create'); setError(''); }}><span className="action-icon">＋</span><span><strong>部屋をつくる</strong><small>主催者になって、みんなを招待</small></span><span className="arrow">↗</span></button>
            <button className="action-card secondary-card" onClick={() => { setScreen('join'); setError(''); }}><span className="action-icon">⌗</span><span><strong>部屋に参加する</strong><small>招待された部屋のコードを入力</small></span><span className="arrow">→</span></button>
            {savedRoom && configured && <button className="resume" disabled={busy} onClick={() => void resume(savedRoom)}>前の部屋に戻る →</button>}
            {!configured && <div className="preview-note"><span className="dot"/>現在は画面確認版です。<button className="text-button" onClick={() => { setPreview(true); setRoom(demoRoom()); setError(''); }}>待機室をプレビュー →</button></div>}
            <div className="how"><div><b>1</b><span>仲間を招待</span></div><i/><div><b>2</b><span>役職を確認</span></div><i/><div><b>3</b><span>会話で推理</span></div></div>
          </section>
        </div> : <section className="entry-card">
          <button className="text-button back" onClick={home}>← トップへ</button><div className="section-number">{screen === 'create' ? 'HOST A ROOM' : 'JOIN YOUR FRIENDS'}</div>
          <h1>{screen === 'create' ? '今夜の部屋をつくる。' : 'みんなの待つ部屋へ。'}</h1><p className="muted">{screen === 'create' ? 'あなたもプレイヤーとして参加できます。' : '招待コードと、呼ばれたい名前を入力してください。'}</p>
          <form onSubmit={enterRoom}>
            {screen === 'join' && <label>部屋コード<input value={code} onChange={e => setCode(e.target.value.replace(/[\s-]/g, '').toUpperCase())} placeholder="A7C92F4B10" required minLength={10} maxLength={10} pattern="[A-Fa-f0-9]{10}" autoCapitalize="characters" autoCorrect="off" spellCheck={false}/></label>}
            <label>ニックネーム<input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="例：ゆう" required maxLength={20} autoComplete="nickname"/><small>1〜20文字。同じ部屋では名前を重複できません。</small></label>
            {needsCaptcha && <Turnstile key={captchaVersion} siteKey={captchaSiteKey} onToken={setToken} onError={setError}/>}
            {!configured && <div className="inline-note">ただいま接続の準備中です。待機室のプレビューをお試しいただけます。</div>}
            <button className="primary" disabled={busy || !configured || (needsCaptcha && !token)}>{busy ? '接続しています…' : screen === 'create' ? '部屋をつくる →' : '参加する →'}</button>
          </form>
          {!configured && <button className="text-button" onClick={() => { const demo = demoRoom(); if (nickname.trim()) demo.members[0]!.nickname = nickname.trim(); setRoom(demo); setPreview(true); setError(''); }}>待機室をプレビュー →</button>}
          <p className="small-note">メールアドレスの登録は不要です。<br/>再参加するときは、同じ端末・ブラウザを使ってください。</p>
        </section>}
        <section className="promise"><Moon small/><p>ひみつはスマホに。会話は、この場で。</p><span>インストールも、専任の司会者もいりません。</span></section>
      </>}
    </main>
    <footer><span>夜のよりあい</span><span>友だちと囲む、小さな推理の時間。</span><small>開発中 · {room ? '待機室' : 'はじめの一歩'}</small></footer>
  </div>;
}

function Lobby({ room, preview, busy, syncing, onSave, onNotice }: {
  room: Room; preview: boolean; busy: boolean; syncing: boolean;
  onSave: (composition: Composition | null, minutes: number) => Promise<void>; onNotice: (message: string) => void;
}) {
  const [qr, setQr] = useState('');
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(room.discussionMinutes);
  const [custom, setCustom] = useState(room.customComposition);
  const [draft, setDraft] = useState<Composition>(room.composition ?? { ...DEFAULT_COMPOSITIONS[5]! });
  const isHost = room.viewerId === room.hostId;
  const count = room.members.length;
  const url = new URL(location.pathname, location.origin); url.searchParams.set(preview ? 'preview' : 'room', preview ? '1' : room.code);
  const invite = url.toString();
  const host = room.members.find(m => m.id === room.hostId);
  let settingError = '';
  try { if (custom) validateComposition(count, draft); } catch (e) { settingError = (e as Error).message; }
  let currentError = '';
  try { if (room.composition) validateComposition(count, room.composition); } catch (e) { currentError = (e as Error).message; }
  useEffect(() => { let active = true; void QRCode.toDataURL(invite, { margin: 2, width: 180, color: { dark: '#182d26', light: '#ffffff' } }).then(image => { if (active) setQr(image); }); return () => { active = false; }; }, [invite]);
  useEffect(() => { setEditing(false); setMinutes(room.discussionMinutes); setCustom(room.customComposition); setDraft(room.composition ?? { ...DEFAULT_COMPOSITIONS[5]! }); }, [room.revision, room.hostId]);
  async function copy() {
    try { await navigator.clipboard.writeText(invite); onNotice(preview ? 'プレビュー用のリンクをコピーしました。' : '招待リンクをコピーしました。'); }
    catch { onNotice('リンクを長押ししてコピーしてください。'); }
  }
  return <div className="lobby">
    <div className="lobby-title"><div><div className="section-number">THE GATHERING</div><h1>今夜の待ち合わせ。</h1><p className="muted">みんなが集まるまで、ひと息。</p></div><span className={`status-pill ${syncing ? 'offline' : ''}`}><span className="dot"/>{preview ? 'プレビュー' : syncing ? '再接続を待っています' : '参加を受付中'}</span></div>
    <div className="lobby-grid"><div className="lobby-main">
      <section className="panel"><div className="panel-heading"><h2>集まった仲間</h2><span><b>{count}</b> / 10人</span></div><div className="members">
        {room.members.map((member, i) => <div className="member" key={member.id}><div className={`avatar tone-${i % 4}`}>{member.nickname.slice(0, 1)}</div><div><strong>{member.nickname}</strong><small>{member.id === room.hostId ? '主催者' : `プレイヤー ${i + 1}`}{member.id === room.viewerId ? ' · あなた' : ''}</small></div><span className={`connection ${member.connected ? '' : 'away'}`}>{member.connected ? '●' : '○'}<span className="sr-only">{member.connected ? '接続中' : '接続を待っています'}</span></span></div>)}
        {count < 5 && <div className="empty-seat"><span>＋</span>あと{5 - count}人で、始められる人数になります。</div>}
      </div></section>
      <section className="panel settings"><div className="panel-heading"><h2>今夜のルール</h2>{isHost && <button className="text-button" onClick={() => setEditing(!editing)}>{editing ? '閉じる' : '設定を変更'}</button>}</div>
        <div className="setting-line"><span>昼の議論</span><strong>{room.discussionMinutes}<small> 分</small></strong></div>
        <div className="role-grid">{(Object.keys(roleNames) as Role[]).map((role, index) => <div key={role} className={role === 'wolf' ? 'wolf-role' : ''}><span className="role-symbol">{['◇', '◈', '✧', '☽', '♜'][index]}</span><span>{roleNames[role]}</span><b>{room.composition?.[role] ?? '—'}</b></div>)}</div>
        {!room.composition && <p className="small-note">5人集まると、おすすめの配役が表示されます。</p>}
        {room.customComposition && <p className="inline-note">カスタム配役です。おすすめと異なる配役のバランスは保証されません。</p>}
        {currentError && <p role="alert" className="field-error">参加人数が変わりました。配役を設定し直してください。</p>}
        {editing && isHost && <form className="settings-form" onSubmit={e => { e.preventDefault(); void onSave(custom ? draft : null, minutes); }}>
          <label>議論時間<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option value={i + 1} key={i}>{i + 1}分</option>)}</select></label>
          <label className="check-label"><input type="checkbox" checked={custom} onChange={e => setCustom(e.target.checked)}/>配役を自分で決める</label>
          {custom && <div className="role-inputs">{(Object.keys(roleNames) as Role[]).map(role => <label key={role}>{roleNames[role]}<input aria-label={`${roleNames[role]}の人数`} type="number" min={0} max={role === 'villager' || role === 'wolf' ? 10 : 1} step={1} value={draft[role]} onChange={e => setDraft({ ...draft, [role]: e.target.valueAsNumber })}/></label>)}</div>}
          {settingError && <p className="field-error" role="alert">{settingError}</p>}
          <button className="primary" disabled={busy || Boolean(settingError)}>設定を保存</button>
        </form>}
        <div className="rule-footnote">初夜の襲撃なし <span>·</span> 役職は本人だけに表示</div>
      </section>
    </div><aside className="invite-panel"><div className="section-number">INVITE YOUR FRIENDS</div><h2>この輪に、招待しよう。</h2><p>近くの仲間にQRコードを見せるか、<br/>部屋コードを伝えてください。</p>
      <div className="qr-wrap">{qr && <img src={qr} alt={preview ? 'プレビュー用QRコード（実際の招待ではありません）' : '部屋の招待QRコード'} width={180} height={180}/>}</div>
      <span className="code-label">{preview ? '部屋コードの見本' : '部屋コード'}</span><div className="room-code">{room.code.slice(0, 5)}<span> </span>{room.code.slice(5)}</div>
      <button className="copy-button" onClick={() => void copy()}>{preview ? 'プレビューリンクをコピー' : '招待リンクをコピー'} <span>↗</span></button><input className="invite-url" aria-label={preview ? 'プレビューリンク' : '招待リンク'} value={invite} readOnly onFocus={e => e.currentTarget.select()}/>
      <div className="start-area"><p>{isHost ? 'あなたが今夜の主催者です。' : `主催者は ${host?.nickname ?? '確認中'} さんです。`}</p><button className="primary" disabled>ゲーム開始は準備中</button><small>この版では、招待・参加・設定の変更まで確認できます。</small></div>
    </aside></div>
    <div className="lobby-bottom"><span>◌</span><p>画面を閉じても、同じブラウザから席に戻れます。<br/><small>接続が切れても、すぐに脱落することはありません。</small></p></div>
  </div>;
}
