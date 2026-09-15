import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'
import './Auth.css'
import './AuthMotion.css'

const API = 'http://127.0.0.1:8787/api'
const AUTH_STORAGE = 'watermark-social-session-v2'

type Session = { token: string; username: string; accountId: string; displayName: string }
type Post = { id: string; username: string; author: string; accountId: string; caption: string; image: string; createdAt: string; likes: number; liked: boolean; reported: boolean }
type Asset = Post & { keyBase64: string }
type Verification = { matched: boolean; extractedId?: string; confidence?: number; message: string }

const paths: Record<string, string[]> = {
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14Z', 'm16 16 4 4'],
  home: ['m3 10 9-7 9 7v10H4V10Z', 'M9 21v-7h6v7'],
  image: ['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z', 'm7 16 3-3 3 3 2-2 3 3', 'M8 8h.01'],
  heart: ['M20.8 4.6a5.6 5.6 0 0 0-7.9 0L12 5.5l-.9-.9a5.6 5.6 0 0 0-7.9 7.9L12 21l8.8-8.5a5.6 5.6 0 0 0 0-7.9Z'],
  flag: ['M5 21V4m0 1c3-2 5 2 8 0s5 2 7 0v10c-2 2-4-2-7 0s-5-2-8 0'],
  share: ['M5 12v7h14v-7', 'M12 3v12m0-12 4 4m-4-4-4 4'],
  check: ['m5 12 4 4L19 6'],
  logout: ['M10 5H5v14h5', 'm14 12-4-4m4 4-4 4m4-4H9'],
  shield: ['M12 3 4 6v5c0 4 2.7 6.8 8 8 5.3-1.2 8-4 8-8V6l-8-3Z', 'm9 12 2 2 4-4'],
}
function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths[name].map((value, index) => <path d={value} key={index}/>)}</svg>
}
function initials(name: string) { return name.split(/\s+/).slice(-2).map((part) => part[0]).join('').toUpperCase() || 'U' }
function timeLabel(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); if (minutes < 1) return 'Vừa xong'; if (minutes < 60) return `${minutes} phút`; if (minutes < 1440) return `${Math.floor(minutes / 60)} giờ`; return new Date(value).toLocaleDateString('vi-VN') }

async function request<T>(path: string, options: RequestInit = {}, token = ''): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Yêu cầu không thành công.')
  return data
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [registering, setRegistering] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const session = await request<Session>(registering ? '/register' : '/login', { method: 'POST', body: JSON.stringify({ username, displayName, password }) })
      localStorage.setItem(AUTH_STORAGE, JSON.stringify(session)); onAuthenticated(session)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thể kết nối máy chủ.') }
    finally { setBusy(false) }
  }
  return <main className="auth-page-simple">
    <section className="auth-card-simple">
      <div className="auth-logo"><span className="brand-mark">w</span><strong>Watermark Social</strong></div>
      <h1>{registering ? 'Tạo tài khoản' : 'Đăng nhập'}</h1>
      <p>{registering ? '' : 'Chào mừng bạn quay lại Watermark Social.'}</p>
      <div className="auth-tabs"><button className={!registering ? 'chosen' : ''} onClick={() => { setRegistering(false); setError('') }}>Đăng nhập</button><button className={registering ? 'chosen' : ''} onClick={() => { setRegistering(true); setError('') }}>Đăng ký</button></div>
      <form onSubmit={submit}>
        {registering && <label>Tên hiển thị<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Nhập tên hiển thị" required/></label>}
        <label>Email hoặc số điện thoại<input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="email@example.com hoặc 0912345678" autoComplete="username" required/></label>
        <label>Mật khẩu<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Tối thiểu 8 ký tự" autoComplete={registering ? 'new-password' : 'current-password'} required/></label>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? 'Đang xử lý…' : registering ? 'Tạo tài khoản' : 'Đăng nhập'}</button>
      </form>
    </section>
  </main>
}

function App() {
  const [session, setSession] = useState<Session | null>(() => { try { return JSON.parse(localStorage.getItem(AUTH_STORAGE) || 'null') } catch { return null } })
  const [posts, setPosts] = useState<Post[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [caption, setCaption] = useState('')
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifyPost, setVerifyPost] = useState<Post | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [verifyMode, setVerifyMode] = useState<'vault' | 'file'>('vault')
  const [verification, setVerification] = useState<Verification | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const keyInput = useRef<HTMLInputElement>(null)

  const signOut = useCallback(async () => {
    if (session) request('/logout', { method: 'POST', body: '{}' }, session.token).catch(() => undefined)
    localStorage.removeItem(AUTH_STORAGE); setSession(null); setPosts([]); setAssets([])
  }, [session])
  const loadData = useCallback(async (active: Session) => {
    try {
      const [feed, own] = await Promise.all([request<Post[]>('/feed', {}, active.token), request<Asset[]>('/assets', {}, active.token)])
      setPosts(feed); setAssets(own)
    } catch (reason) { if (reason instanceof Error && reason.message.includes('Phiên đăng nhập')) signOut(); else setNotice(reason instanceof Error ? reason.message : 'Không tải được dữ liệu.') }
  }, [signOut])
  useEffect(() => { if (session) loadData(session) }, [session, loadData])

  const chosenAsset = useMemo(() => assets.find((asset) => asset.id === selectedAssetId), [assets, selectedAssetId])
  function chooseImage(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setPendingImage(String(reader.result)); reader.readAsDataURL(file); event.target.value = '' }
  async function publish(event: FormEvent) {
    event.preventDefault(); if (!session || !pendingImage) { setNotice('Hãy chọn một ảnh trước khi đăng.'); return }
    setBusy(true); setNotice('Đang nhúng watermark vào ảnh…')
    try { const post = await request<Post>('/posts', { method: 'POST', body: JSON.stringify({ image: pendingImage, caption }) }, session.token); setPosts((current) => [post, ...current]); setCaption(''); setPendingImage(null); setNotice('Đã đăng ảnh và lưu key bản quyền thành công.'); const own = await request<Asset[]>('/assets', {}, session.token); setAssets(own) }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể đăng ảnh.') }
    finally { setBusy(false) }
  }
  async function like(postId: string) { if (!session) return; try { const result = await request<{likes:number; liked:boolean}>('/like', { method: 'POST', body: JSON.stringify({ postId }) }, session.token); setPosts((current) => current.map((post) => post.id === postId ? { ...post, ...result } : post)) } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể thích bài viết.') } }
  function downloadKey(asset: Asset) { const bytes = Uint8Array.from(atob(asset.keyBase64), (character) => character.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `watermark-${asset.id}.npz`; anchor.click(); URL.revokeObjectURL(url) }
  async function verify(keyBase64: string) {
    if (!session || !verifyPost) return; setBusy(true); setVerification(null)
    try { const result = await request<{matched:boolean; extractedId:string; confidence:number}>('/verify', { method: 'POST', body: JSON.stringify({ image: verifyPost.image, keyBase64 }) }, session.token); setVerification(result.matched ? { ...result, message: 'Watermark trích xuất khớp với Account ID của bạn.' } : { ...result, message: `Không khớp. ID trích xuất: ${result.extractedId || 'không đọc được'}.` }) }
    catch (reason) { setVerification({ matched: false, message: reason instanceof Error ? reason.message : 'Không thể xác minh.' }) }
    finally { setBusy(false) }
  }
  function readKey(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => verify(String(reader.result).split(',').pop() || ''); reader.readAsDataURL(file); event.target.value = '' }
  async function report() { if (!session || !verifyPost || !verification?.matched) return; await request('/report', { method: 'POST', body: JSON.stringify({ postId: verifyPost.id }) }, session.token); setPosts((current) => current.map((post) => post.id === verifyPost.id ? { ...post, reported: true } : post)); setNotice('Đã gửi báo cáo kèm bằng chứng watermark.'); setVerifyPost(null); setVerification(null) }

  if (!session) return <AuthScreen onAuthenticated={(value) => { localStorage.setItem(AUTH_STORAGE, JSON.stringify(value)); setSession(value) }}/>
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">w</span><span>Watermark Social</span></div><div className="search"><Icon name="search"/><input placeholder="Tìm kiếm trên Watermark Social"/></div><nav><button className="nav-active"><Icon name="home"/></button><button><Icon name="image"/></button></nav><div className="top-actions"><div className="user-compact"><span>{session.displayName}</span><small>ID {session.accountId}</small></div><span className="avatar mine">{initials(session.displayName)}</span><button className="logout-button" onClick={signOut} title="Đăng xuất"><Icon name="logout"/></button></div></header>
    <main className="layout">
      <aside className="leftbar"><div className="profile-row"><span className="avatar large mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small>{session.username}</small></div></div><button className="side-link active"><Icon name="home"/>Bảng tin</button><button className="side-link"><Icon name="image"/>Kho bản quyền <span className="badge">{assets.length}</span></button><button className="side-link"><Icon name="check"/>Lịch sử xác minh</button></aside>
      <section className="feed">
        <form className="composer" onSubmit={publish}><div className="composer-top"><span className="avatar mine">{initials(session.displayName)}</span><input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Bạn đang nghĩ gì?"/></div>{pendingImage && <div className="preview"><img src={pendingImage}/><button type="button" onClick={() => setPendingImage(null)}>×</button></div>}<div className="composer-actions"><button type="button" onClick={() => imageInput.current?.click()}><Icon name="image"/> Ảnh</button><span className="protection-note"><Icon name="shield"/> Tự nhúng ID {session.accountId}</span><button className="publish" disabled={busy}>{busy ? 'Đang xử lý…' : 'Đăng'}</button></div><input ref={imageInput} className="hidden" type="file" accept="image/*" onChange={chooseImage}/></form>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {posts.length === 0 && <div className="empty-feed"><Icon name="image"/><h3>Chưa có bài viết</h3><p>Hãy là người đầu tiên chia sẻ một bức ảnh.</p></div>}
        {posts.map((post) => <article className="post" key={post.id}><div className="post-head"><span className="avatar">{initials(post.author)}</span><div><b>{post.author}</b><small>{timeLabel(post.createdAt)} · ID {post.accountId}</small></div><button className="more">•••</button></div><p className="caption">{post.caption}</p><img className="post-image" src={post.image} alt={post.caption}/><div className="post-stats"><span>{post.likes} lượt thích</span>{post.reported && <span className="reported">Đang khiếu nại bản quyền</span>}</div><div className="post-actions"><button className={post.liked ? 'liked' : ''} onClick={() => like(post.id)}><Icon name="heart"/>Thích</button><button onClick={() => { setVerifyPost(post); setVerification(null); setSelectedAssetId(assets[0]?.id || '') }}><Icon name="flag"/>Nghi ngờ vi phạm</button><button><Icon name="share"/>Chia sẻ</button></div></article>)}
      </section>
      <aside className="rightbar"><section className="account-card"><div className="card-title"><b>Danh tính watermark</b><span className="secure">● Đang bảo vệ</span></div><label>Account ID được hệ thống cấp</label><div className="account-id-value">{session.accountId}</div><p>ID gồm 10 chữ số và không thể thay đổi.</p></section><section className="vault"><div className="card-title"><b>Kho bản quyền của tôi</b><span>{assets.length} ảnh</span></div>{assets.length === 0 ? <div className="empty-vault"><Icon name="shield"/><p>Chưa có ảnh được bảo vệ</p></div> : assets.slice(0, 4).map((asset) => <div className="vault-row" key={asset.id}><img src={asset.image}/><div><b>{asset.caption}</b><small>{timeLabel(asset.createdAt)}</small><button onClick={() => downloadKey(asset)}>↓ Tải key .npz</button></div></div>)}</section></aside>
    </main>
    {verifyPost && <div className="modal-backdrop"><section className="modal"><button className="close" onClick={() => setVerifyPost(null)}>×</button><span className="modal-icon"><Icon name="shield"/></span><h2>Xác minh quyền sở hữu</h2><p className="muted">Dùng key của bạn để kiểm tra ảnh trong bài viết này.</p><div className="suspect"><img src={verifyPost.image}/><div><b>{verifyPost.author}</b><small>ID bài đăng: {verifyPost.accountId}</small></div></div>{!verification && <><div className="tabs"><button className={verifyMode === 'vault' ? 'selected' : ''} onClick={() => setVerifyMode('vault')}>Chọn từ kho</button><button className={verifyMode === 'file' ? 'selected' : ''} onClick={() => setVerifyMode('file')}>Tải key .npz</button></div>{verifyMode === 'vault' ? <><select value={selectedAssetId} onChange={(event) => setSelectedAssetId(event.target.value)}><option value="">Chọn ảnh bản quyền</option>{assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.caption}</option>)}</select><button className="primary wide" disabled={!chosenAsset || busy} onClick={() => chosenAsset && verify(chosenAsset.keyBase64)}>{busy ? 'Đang trích xuất…' : 'Xác minh watermark'}</button></> : <div className="key-drop"><Icon name="shield"/><b>Chọn file key `.npz`</b><button onClick={() => keyInput.current?.click()}>Tải key lên</button><input ref={keyInput} className="hidden" type="file" accept=".npz" onChange={readKey}/></div>}</>}{verification && <div className={verification.matched ? 'result success' : 'result failure'}><span>{verification.matched ? '✓' : '!'}</span><div><b>{verification.matched ? 'Đã xác minh quyền sở hữu' : 'Không thể xác minh'}</b><p>{verification.message}</p>{verification.matched && <dl><div><dt>ID trích xuất</dt><dd>{verification.extractedId}</dd></div><div><dt>Độ tin cậy</dt><dd>{verification.confidence}%</dd></div></dl>}</div>{verification.matched && <button className="report-button" onClick={report}><Icon name="flag"/> Gửi báo cáo vi phạm</button>}</div>}</section></div>}
  </div>
}
export default App
