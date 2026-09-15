import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'
import './Auth.css'
import './AuthMotion.css'
import './LayoutFix.css'
import './ComposerGallery.css'

const API = 'http://127.0.0.1:8787/api'
const AUTH_STORAGE = 'watermark-social-session-v2'

type Session = { token: string; username: string; accountId: string; displayName: string }
type Comment = { id: string; username: string; author: string; text: string; createdAt: string }
type Post = { id: string; username: string; author: string; accountId: string; caption: string; image: string; images?: string[]; createdAt: string; likes: number; liked: boolean; comments: Comment[]; reported: boolean }
type Asset = Post & { keyBase64: string }
type Verification = { matched: boolean; extractedId?: string; expectedId?: string; extractedOwner?: string; confidence?: number; historyId?: string; message: string }
type VerificationHistory = { id: string; postId: string; imageIndex: number; method: 'vault' | 'file'; sourceName: string; matched: boolean; extractedId: string; expectedId: string; extractedOwner?: string; confidence: number; createdAt: string; image?: string; postAuthor?: string; caption?: string; action?: string }
type Notification = { id: string; type: string; title: string; message: string; ownerName: string; ownerAccountId: string; postCaption: string; createdAt: string; read: boolean }
type AccountSummary = { username: string; displayName: string; accountId: string; postCount: number }
type Profile = { username: string; displayName: string; accountId: string; posts: Post[] }

const paths: Record<string, string[]> = {
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14Z', 'm16 16 4 4'],
  home: ['m3 10 9-7 9 7v10H4V10Z', 'M9 21v-7h6v7'],
  image: ['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z', 'm7 16 3-3 3 3 2-2 3 3', 'M8 8h.01'],
  heart: ['M20.8 4.6a5.6 5.6 0 0 0-7.9 0L12 5.5l-.9-.9a5.6 5.6 0 0 0-7.9 7.9L12 21l8.8-8.5a5.6 5.6 0 0 0 0-7.9Z'],
  comment: ['M21 11.5a8.4 8.4 0 0 1-9 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.6-4.6A8.3 8.3 0 1 1 21 11.5Z'],
  flag: ['M5 21V4m0 1c3-2 5 2 8 0s5 2 7 0v10c-2 2-4-2-7 0s-5-2-8 0'],
  share: ['M5 12v7h14v-7', 'M12 3v12m0-12 4 4m-4-4-4 4'],
  check: ['m5 12 4 4L19 6'],
  logout: ['M10 5H5v14h5', 'm14 12-4-4m4 4-4 4m4-4H9'],
  shield: ['M12 3 4 6v5c0 4 2.7 6.8 8 8 5.3-1.2 8-4 8-8V6l-8-3Z', 'm9 12 2 2 4-4'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
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
  const [history, setHistory] = useState<VerificationHistory[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [activePage, setActivePage] = useState<'feed' | 'gallery' | 'history' | 'profile'>('feed')
  const [composerOpen, setComposerOpen] = useState(false)
  const [caption, setCaption] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifyPost, setVerifyPost] = useState<Post | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [verifyMode, setVerifyMode] = useState<'vault' | 'file'>('vault')
  const [verification, setVerification] = useState<Verification | null>(null)
  const [photoViewer, setPhotoViewer] = useState<{post: Post; image: string} | null>(null)
  const [openComments, setOpenComments] = useState<string[]>([])
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [viewerMenu, setViewerMenu] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [postMenuId, setPostMenuId] = useState('')
  const [editingPost, setEditingPost] = useState<Post | null>(null)
  const [editCaption, setEditCaption] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<AccountSummary[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const keyInput = useRef<HTMLInputElement>(null)

  const signOut = useCallback(async () => {
    if (session) request('/logout', { method: 'POST', body: '{}' }, session.token).catch(() => undefined)
    localStorage.removeItem(AUTH_STORAGE); setSession(null); setPosts([]); setAssets([]); setHistory([]); setNotifications([])
  }, [session])
  const loadData = useCallback(async (active: Session) => {
    try {
      const [feed, own, checks, alerts] = await Promise.all([request<Post[]>('/feed', {}, active.token), request<Asset[]>('/assets', {}, active.token), request<VerificationHistory[]>('/verifications', {}, active.token), request<Notification[]>('/notifications', {}, active.token)])
      setPosts(feed); setAssets(own); setHistory(checks); setNotifications(alerts)
    } catch (reason) { if (reason instanceof Error && reason.message.includes('Phiên đăng nhập')) signOut(); else setNotice(reason instanceof Error ? reason.message : 'Không tải được dữ liệu.') }
  }, [signOut])
  useEffect(() => { if (session) loadData(session) }, [session, loadData])
  useEffect(() => {
    if (!session || searchQuery.trim().length < 2) { setSearchResults([]); return }
    const timer = window.setTimeout(() => request<AccountSummary[]>(`/accounts/search?q=${encodeURIComponent(searchQuery.trim())}`, {}, session.token).then(setSearchResults).catch(() => setSearchResults([])), 220)
    return () => window.clearTimeout(timer)
  }, [searchQuery, session])

  const chosenAsset = useMemo(() => assets.find((asset) => asset.id === selectedAssetId), [assets, selectedAssetId])
  async function chooseImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith('image/'))
    event.target.value = ''
    if (!files.length) return
    const remaining = Math.max(0, 10 - pendingImages.length)
    const selected = files.slice(0, remaining)
    const images = await Promise.all(selected.map((file) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file)
    })))
    setPendingImages((current) => [...current, ...images].slice(0, 10))
    if (files.length > remaining) setNotice('Mỗi bài viết hỗ trợ tối đa 10 ảnh.')
  }
  function openComposer(selectPhotos = false) {
    setComposerOpen(true)
    if (selectPhotos) imageInput.current?.click()
  }
  function closeComposer() { if (busy) return; setComposerOpen(false); setCaption(''); setPendingImages([]) }
  async function publish(event: FormEvent) {
    event.preventDefault(); if (!session || !pendingImages.length) { setNotice('Hãy chọn ít nhất một ảnh trước khi đăng.'); return }
    setBusy(true); setNotice(`Đang nhúng watermark vào ${pendingImages.length} ảnh…`)
    try { const post = await request<Post>('/posts', { method: 'POST', body: JSON.stringify({ images: pendingImages, caption }) }, session.token); setPosts((current) => [post, ...current]); setCaption(''); setPendingImages([]); setComposerOpen(false); setNotice(`Đã đăng ${post.images?.length || 1} ảnh và lưu key bản quyền thành công.`); const own = await request<Asset[]>('/assets', {}, session.token); setAssets(own) }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể đăng ảnh.') }
    finally { setBusy(false) }
  }
  async function like(postId: string) { if (!session) return; try { const result = await request<{likes:number; liked:boolean}>('/like', { method: 'POST', body: JSON.stringify({ postId }) }, session.token); setPosts((current) => current.map((post) => post.id === postId ? { ...post, ...result } : post)); setPhotoViewer((current) => current?.post.id === postId ? { ...current, post: { ...current.post, ...result } } : current) } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể thích bài viết.') } }
  async function comment(event: FormEvent, postId: string) {
    event.preventDefault(); if (!session) return
    const text = commentDrafts[postId]?.trim(); if (!text) return
    try {
      const added = await request<Comment>('/comments', { method: 'POST', body: JSON.stringify({ postId, text }) }, session.token)
      setPosts((current) => current.map((post) => post.id === postId ? { ...post, comments: [...(post.comments || []), added] } : post))
      setPhotoViewer((current) => current?.post.id === postId ? { ...current, post: { ...current.post, comments: [...(current.post.comments || []), added] } } : current)
      setCommentDrafts((current) => ({ ...current, [postId]: '' }))
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể gửi bình luận.') }
  }
  async function openProfile(username: string) {
    if (!session) return
    try { const data = await request<Profile>(`/profile?username=${encodeURIComponent(username)}`, {}, session.token); setProfile(data); setActivePage('profile'); setSearchQuery(''); setSearchResults([]); setNotificationsOpen(false) }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể mở trang cá nhân.') }
  }
  async function savePostEdit(event: FormEvent) {
    event.preventDefault(); if (!session || !editingPost) return
    try {
      const result = await request<{id:string; caption:string}>('/posts/edit', { method: 'POST', body: JSON.stringify({ postId: editingPost.id, caption: editCaption }) }, session.token)
      setPosts((current) => current.map((post) => post.id === result.id ? { ...post, caption: result.caption } : post))
      setProfile((current) => current ? { ...current, posts: current.posts.map((post) => post.id === result.id ? { ...post, caption: result.caption } : post) } : current)
      setEditingPost(null); setPostMenuId(''); setNotice('Đã cập nhật bài viết.')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể chỉnh sửa bài viết.') }
  }
  async function removePost(post: Post) {
    if (!session || !window.confirm('Xóa bài viết này? Ảnh watermark và key bản quyền đi kèm cũng sẽ bị xóa.')) return
    try {
      await request('/posts/delete', { method: 'POST', body: JSON.stringify({ postId: post.id }) }, session.token)
      setPosts((current) => current.filter((item) => item.id !== post.id)); setProfile((current) => current ? { ...current, posts: current.posts.filter((item) => item.id !== post.id) } : current)
      setAssets(await request<Asset[]>('/assets', {}, session.token)); setPostMenuId(''); setPhotoViewer(null); setNotice('Đã xóa bài viết và dữ liệu bản quyền đi kèm.')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể xóa bài viết.') }
  }
  function downloadKey(asset: Asset) { const bytes = Uint8Array.from(atob(asset.keyBase64), (character) => character.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `watermark-${asset.id}.npz`; anchor.click(); URL.revokeObjectURL(url) }
  function downloadImage(image: string, postId: string) { const anchor = document.createElement('a'); anchor.href = image; anchor.download = `watermark-social-${postId}.jpg`; anchor.click() }
  async function toggleNotifications() {
    const next = !notificationsOpen; setNotificationsOpen(next)
    if (next && session && notifications.some((item) => !item.read)) {
      setNotifications((current) => current.map((item) => ({ ...item, read: true })))
      request('/notifications/read', { method: 'POST', body: '{}' }, session.token).catch(() => undefined)
    }
  }
  async function verify(keyBase64: string, sourceName = '') {
    if (!session || !verifyPost) return; setBusy(true); setVerification(null)
    const imageIndex = Math.max(0, (verifyPost.images || [verifyPost.image]).indexOf(verifyPost.image))
    try {
      const result = await request<{matched:boolean; extractedId:string; expectedId:string; extractedOwner:string; confidence:number; historyId:string}>('/verify', { method: 'POST', body: JSON.stringify({ image: verifyPost.image, keyBase64, postId: verifyPost.id, imageIndex, method: verifyMode, sourceName }) }, session.token)
      const resolved: Verification = result.matched ? { ...result, message: `Watermark xác nhận ảnh thuộc về ${result.extractedOwner || 'tài khoản của bạn'} (Account ID ${result.extractedId}).` } : { ...result, message: `Không đủ bằng chứng quyền sở hữu. ID trích xuất: ${result.extractedId || 'không đọc được'}.` }
      setVerification(resolved); setHistory(await request<VerificationHistory[]>('/verifications', {}, session.token))
      if (result.matched) {
        await request('/report', { method: 'POST', body: JSON.stringify({ postId: verifyPost.id, historyId: result.historyId }) }, session.token)
        setPosts((current) => current.filter((post) => post.id !== verifyPost.id))
        setVerification({ ...resolved, message: `Ảnh thuộc quyền sở hữu của ${result.extractedOwner || 'tài khoản của bạn'} — Account ID ${result.extractedId}. Bài viết vi phạm đã được tự động gỡ bỏ.` })
        setHistory(await request<VerificationHistory[]>('/verifications', {}, session.token))
      }
    }
    catch (reason) { setVerification({ matched: false, message: reason instanceof Error ? reason.message : 'Không thể xác minh.' }) }
    finally { setBusy(false) }
  }
  function readKey(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => verify(String(reader.result).split(',').pop() || '', file.name); reader.readAsDataURL(file); event.target.value = '' }

  if (!session) return <AuthScreen onAuthenticated={(value) => { localStorage.setItem(AUTH_STORAGE, JSON.stringify(value)); setSession(value) }}/>
  return <div className="app-shell">
    <header className="topbar"><div className="top-left"><div className="brand"><span className="brand-mark">w</span><span>Watermark Social</span></div><div className="search"><Icon name="search"/><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Tìm kiếm tài khoản"/>{searchQuery.trim().length >= 2 && <section className="search-dropdown">{searchResults.length === 0 ? <p>Không tìm thấy tài khoản phù hợp.</p> : searchResults.map((account) => <button onClick={() => openProfile(account.username)} key={account.username}><span className={`avatar ${account.username === session.username ? 'mine' : ''}`}>{initials(account.displayName)}</span><span><b>{account.displayName}</b><small>Account ID {account.accountId} · {account.postCount} bài viết</small></span></button>)}</section>}</div></div><nav><button className={activePage === 'feed' ? 'nav-active' : ''} onClick={() => setActivePage('feed')} title="Bảng tin"><Icon name="home"/></button><button className={activePage === 'gallery' ? 'nav-active' : ''} onClick={() => setActivePage('gallery')} title="Kho bản quyền"><Icon name="image"/></button></nav><div className="top-actions"><div className="notification-wrap"><button className="notification-button" onClick={toggleNotifications} title="Thông báo"><Icon name="bell"/>{notifications.some((item) => !item.read) && <span>{Math.min(9, notifications.filter((item) => !item.read).length)}{notifications.filter((item) => !item.read).length > 9 ? '+' : ''}</span>}</button>{notificationsOpen && <section className="notification-dropdown"><header><h3>Thông báo</h3><span>{notifications.length} thông báo</span></header>{notifications.length === 0 ? <div className="notification-empty"><Icon name="bell"/><p>Bạn chưa có thông báo mới.</p></div> : <div className="notification-list">{notifications.map((item) => <article className={!item.read ? 'unread' : ''} key={item.id}><span className="notification-symbol"><Icon name="shield"/></span><div><b>{item.title}</b><p>{item.message}</p><small>{timeLabel(item.createdAt)}</small></div></article>)}</div>}</section>}</div><button className="profile-compact" onClick={() => openProfile(session.username)}><div className="user-compact"><span>{session.displayName}</span><small>ID {session.accountId}</small></div><span className="avatar mine">{initials(session.displayName)}</span></button><button className="logout-button" onClick={signOut} title="Đăng xuất"><Icon name="logout"/></button></div></header>
    <main className="layout">
      <aside className="leftbar"><button className="profile-row" onClick={() => openProfile(session.username)}><span className="avatar large mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small>{session.username}</small></div></button><button className={`side-link ${activePage === 'feed' ? 'active' : ''}`} onClick={() => setActivePage('feed')}><Icon name="home"/>Bảng tin</button><button className={`side-link ${activePage === 'gallery' ? 'active' : ''}`} onClick={() => setActivePage('gallery')}><Icon name="image"/>Kho bản quyền <span className="badge">{assets.length}</span></button><button className={`side-link ${activePage === 'history' ? 'active' : ''}`} onClick={() => setActivePage('history')}><Icon name="check"/>Lịch sử xác minh</button></aside>
      {activePage === 'feed' ? <section className="feed">
        <section className="composer compact-composer"><span className="avatar mine">{initials(session.displayName)}</span><button className="composer-prompt" onClick={() => openComposer()}>{session.displayName.trim().split(/\s+/).slice(-1)[0]} ơi, bạn đang nghĩ gì thế?</button><button className="composer-photo" type="button" onClick={() => openComposer(true)} title="Chọn ảnh từ máy"><Icon name="image"/><span>Ảnh</span></button></section>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {posts.length === 0 && <div className="empty-feed"><Icon name="image"/><h3>Chưa có bài viết</h3><p>Hãy là người đầu tiên chia sẻ một bức ảnh.</p></div>}
        {posts.map((post) => <article className="post" key={post.id}><div className="post-head"><span className={`avatar ${post.username === session.username ? 'mine' : ''}`}>{initials(post.author)}</span><div><b>{post.author}</b><small>{timeLabel(post.createdAt)} · ID {post.accountId}</small></div>{post.username === session.username && <div className="post-menu-wrap"><button className="more" onClick={() => setPostMenuId((current) => current === post.id ? '' : post.id)}>•••</button>{postMenuId === post.id && <div className="post-menu"><button onClick={() => { setEditingPost(post); setEditCaption(post.caption); setPostMenuId('') }}>Chỉnh sửa bài viết</button><button className="delete-option" onClick={() => removePost(post)}>Xóa bài viết</button></div>}</div>}</div>{post.caption && post.caption !== 'Ảnh không có tiêu đề' && <p className="caption">{post.caption}</p>}<div className={`post-media media-count-${Math.min(post.images?.length || 1, 4)}`}>{(post.images || [post.image]).map((image, index) => <button className="post-image-trigger" onClick={() => setPhotoViewer({ post, image })} key={index}><img className="post-image" src={image} alt={post.caption || `Ảnh ${index + 1}`}/></button>)}</div><div className="post-stats"><span>{post.likes} lượt thích</span><button onClick={() => setOpenComments((current) => current.includes(post.id) ? current : [...current, post.id])}>{(post.comments || []).length > 0 ? `${post.comments.length} bình luận` : ''}</button>{post.reported && <span className="reported">Đang khiếu nại bản quyền</span>}</div><div className="post-actions"><button className={post.liked ? 'liked' : ''} onClick={() => like(post.id)}><Icon name="heart"/>Thích</button><button onClick={() => setOpenComments((current) => current.includes(post.id) ? current.filter((id) => id !== post.id) : [...current, post.id])}><Icon name="comment"/>Bình luận</button><button><Icon name="share"/>Chia sẻ</button></div>{(post.comments || []).length > 0 && <div className="post-comments">{(openComments.includes(post.id) ? post.comments : post.comments.slice(-2)).map((item) => <div className="comment-row" key={item.id}><span className={`avatar comment-avatar ${item.username === session.username ? 'mine' : ''}`}>{initials(item.author)}</span><div><b>{item.author}</b><p>{item.text}</p><small>{timeLabel(item.createdAt)}</small></div></div>)}</div>}{openComments.includes(post.id) && <form className="comment-composer" onSubmit={(event) => comment(event, post.id)}><span className="avatar comment-avatar mine">{initials(session.displayName)}</span><input value={commentDrafts[post.id] || ''} onChange={(event) => setCommentDrafts((current) => ({ ...current, [post.id]: event.target.value }))} placeholder="Viết bình luận…" maxLength={1000} autoFocus/><button disabled={!commentDrafts[post.id]?.trim()}>Gửi</button></form>}</article>)}
      </section> : activePage === 'gallery' ? <section className="gallery-page"><div className="gallery-heading"><div><span className="gallery-icon"><Icon name="shield"/></span><div><h1>Kho bản quyền</h1><p>Quản lý ảnh đã được nhúng watermark và tải key xác minh.</p></div></div><span>{assets.length} ảnh</span></div>{assets.length === 0 ? <div className="gallery-empty"><Icon name="image"/><h3>Kho bản quyền đang trống</h3><p>Ảnh bạn đăng sẽ xuất hiện tại đây cùng key `.npz` riêng.</p></div> : <div className="gallery-grid image-only-gallery">{assets.map((asset) => <article className="gallery-card" key={asset.id}><img src={asset.image} alt="Ảnh bản quyền"/><div className="gallery-overlay"><button onClick={() => downloadKey(asset)}><Icon name="download"/> Tải key `.npz`</button></div></article>)}</div>}</section> : activePage === 'history' ? <section className="history-page"><div className="gallery-heading"><div><span className="gallery-icon"><Icon name="check"/></span><div><h1>Lịch sử xác minh</h1><p>Các lần kiểm tra watermark bằng key của tài khoản này.</p></div></div><span>{history.length} lần</span></div>{history.length === 0 ? <div className="gallery-empty"><Icon name="check"/><h3>Chưa có lần xác minh nào</h3><p>Kết quả kiểm tra ảnh nghi ngờ sẽ được lưu và hiển thị tại đây.</p></div> : <div className="history-list">{history.map((item) => <article className="history-item" key={item.id}>{item.image ? <img src={item.image} alt={item.caption || 'Ảnh đã xác minh'}/> : <span className="history-placeholder"><Icon name="image"/></span>}<div className="history-detail"><div><b>{item.caption || 'Ảnh đã xác minh'}</b><span className={item.matched ? 'history-status matched' : 'history-status unmatched'}>{item.matched ? 'Khớp bản quyền' : 'Không khớp'}</span></div><small>{timeLabel(item.createdAt)} · {item.method === 'vault' ? 'Key từ kho bản quyền' : `File ${item.sourceName || '.npz'}`}</small><dl><div><dt>ID trích xuất</dt><dd>{item.extractedId || 'Không đọc được'}</dd></div><div><dt>Độ tin cậy</dt><dd>{item.confidence}%</dd></div></dl></div></article>)}</div>}</section> : <section className="profile-page">{profile ? <><div className="profile-cover"><div className={`avatar profile-avatar ${profile.username === session.username ? 'mine' : ''}`}>{initials(profile.displayName)}</div></div><div className="profile-info"><div><h1>{profile.displayName}</h1><p>{profile.username}</p><span>Account ID {profile.accountId}</span></div><strong>{profile.posts.length}<small>bài viết</small></strong></div><div className="profile-section-title"><h2>Ảnh đã đăng</h2><span>{profile.posts.reduce((total, post) => total + (post.images?.length || 1), 0)} ảnh</span></div>{profile.posts.length === 0 ? <div className="gallery-empty profile-empty"><Icon name="image"/><h3>Chưa có bài viết</h3></div> : <div className="profile-photo-grid">{profile.posts.flatMap((post) => (post.images || [post.image]).map((image, index) => <button onClick={() => setPhotoViewer({ post, image })} key={`${post.id}-${index}`}><img src={image} alt={post.caption || 'Ảnh bài viết'}/></button>))}</div>}</> : <div className="gallery-empty"><p>Đang tải trang cá nhân…</p></div>}</section>}
      <aside className="rightbar"><section className="account-card"><div className="card-title"><b>Account ID</b></div><div className="account-id-value">{session.accountId}</div></section></aside>
    </main>
    <input ref={imageInput} className="hidden" type="file" accept="image/*" multiple onChange={chooseImages}/>
    {composerOpen && <div className="modal-backdrop composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer() }}><form className="create-post-modal" onSubmit={publish}><header><h2>Tạo bài viết</h2><button type="button" className="close" onClick={closeComposer} aria-label="Đóng">×</button></header><div className="create-post-author"><span className="avatar mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small><Icon name="shield"/> Watermark ID {session.accountId}</small></div></div><textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder={`Bạn đang nghĩ gì, ${session.displayName}?`} autoFocus/>{pendingImages.length > 0 ? <div className={`upload-preview preview-count-${Math.min(pendingImages.length, 4)}`}>{pendingImages.map((image, index) => <figure key={index}><img src={image} alt={`Ảnh đã chọn ${index + 1}`}/><button type="button" onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>{index === 3 && pendingImages.length > 4 && <span>+{pendingImages.length - 4}</span>}</figure>)}</div> : <button type="button" className="photo-drop" onClick={() => imageInput.current?.click()}><span><Icon name="image"/></span><b>Thêm ảnh</b><small>Chọn tối đa 10 ảnh từ máy</small></button>}<div className="add-to-post"><b>Thêm vào bài viết</b><button type="button" onClick={() => imageInput.current?.click()} title="Thêm ảnh"><Icon name="image"/></button><span>Mỗi ảnh được nhúng watermark và có key riêng</span></div><button className="create-post-submit" disabled={busy || pendingImages.length === 0}>{busy ? `Đang bảo vệ ${pendingImages.length} ảnh…` : `Đăng${pendingImages.length ? ` ${pendingImages.length} ảnh` : ''}`}</button></form></div>}
    {editingPost && <div className="modal-backdrop edit-backdrop"><form className="edit-post-modal" onSubmit={savePostEdit}><header><h2>Chỉnh sửa bài viết</h2><button type="button" className="close" onClick={() => setEditingPost(null)}>×</button></header><div className="create-post-author"><span className="avatar mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small>Chỉ chỉnh sửa nội dung chữ</small></div></div><textarea value={editCaption} onChange={(event) => setEditCaption(event.target.value)} placeholder="Viết nội dung cho bài viết…" maxLength={5000} autoFocus/><div className="edit-preview"><img src={editingPost.image} alt="Ảnh bài viết"/><span>Ảnh và watermark được giữ nguyên</span></div><button className="create-post-submit">Lưu thay đổi</button></form></div>}
    {photoViewer && <div className="photo-viewer"><button className="viewer-close" onClick={() => { setPhotoViewer(null); setViewerMenu(false) }} aria-label="Đóng">×</button><div className="photo-stage"><img src={photoViewer.image} alt={photoViewer.post.caption || 'Ảnh bài viết'}/><div className="viewer-menu-wrap"><button className="viewer-menu-button" onClick={() => setViewerMenu((current) => !current)} aria-label="Tùy chọn">•••</button>{viewerMenu && <div className="viewer-menu"><button onClick={() => { downloadImage(photoViewer.image, photoViewer.post.id); setViewerMenu(false) }}><Icon name="download"/><span><b>Lưu ảnh</b><small>Tải ảnh watermark về máy</small></span></button>{photoViewer.post.username !== session.username && <button className="copyright-option" onClick={() => { setVerifyPost({ ...photoViewer.post, image: photoViewer.image }); setVerification(null); setSelectedAssetId(''); setViewerMenu(false) }}><Icon name="flag"/><span><b>Nghi ngờ vi phạm bản quyền</b><small>Kiểm tra ảnh bằng watermark của bạn</small></span></button>}</div>}</div></div><aside className="viewer-panel"><div className="post-head"><span className={`avatar ${photoViewer.post.username === session.username ? 'mine' : ''}`}>{initials(photoViewer.post.author)}</span><div><b>{photoViewer.post.author}</b><small>{timeLabel(photoViewer.post.createdAt)} · ID {photoViewer.post.accountId}</small></div></div>{photoViewer.post.caption && photoViewer.post.caption !== 'Ảnh không có tiêu đề' && <p className="viewer-caption">{photoViewer.post.caption}</p>}<div className="viewer-stats"><span>{photoViewer.post.likes} lượt thích</span><span>{(photoViewer.post.comments || []).length} bình luận</span></div><div className="viewer-actions"><button className={photoViewer.post.liked ? 'liked' : ''} onClick={() => like(photoViewer.post.id)}><Icon name="heart"/>Thích</button><button><Icon name="comment"/>Bình luận</button></div><div className="viewer-comments">{(photoViewer.post.comments || []).length === 0 ? <p className="no-comments">Chưa có bình luận nào.</p> : photoViewer.post.comments.map((item) => <div className="comment-row" key={item.id}><span className={`avatar comment-avatar ${item.username === session.username ? 'mine' : ''}`}>{initials(item.author)}</span><div><b>{item.author}</b><p>{item.text}</p><small>{timeLabel(item.createdAt)}</small></div></div>)}</div><form className="comment-composer viewer-comment" onSubmit={(event) => comment(event, photoViewer.post.id)}><span className="avatar comment-avatar mine">{initials(session.displayName)}</span><input value={commentDrafts[photoViewer.post.id] || ''} onChange={(event) => setCommentDrafts((current) => ({ ...current, [photoViewer.post.id]: event.target.value }))} placeholder="Viết bình luận…" maxLength={1000}/><button disabled={!commentDrafts[photoViewer.post.id]?.trim()}>Gửi</button></form></aside></div>}
    {verifyPost && <div className="modal-backdrop verification-backdrop"><section className="modal verification-modal"><button className="close" onClick={() => { if (verification?.matched) setPhotoViewer(null); setVerifyPost(null); setVerification(null) }}>×</button><div className="verification-heading"><span className="modal-icon"><Icon name="shield"/></span><div><h2>Xác minh quyền sở hữu</h2><p className="muted">Đối chiếu watermark của ảnh đang xem với bằng chứng của bạn.</p></div></div><div className="suspect suspect-large"><img src={verifyPost.image}/><div><small>Ảnh đang được kiểm tra</small><b>Bài viết của {verifyPost.author}</b><span>Account ID người đăng: {verifyPost.accountId}</span></div></div>{(verifyPost.images?.length || 0) > 1 && <div className="suspect-picker"><small>Chọn ảnh cần kiểm tra trong bài viết</small><div>{verifyPost.images!.map((image, index) => <button className={verifyPost.image === image ? 'selected' : ''} onClick={() => { setVerifyPost({ ...verifyPost, image }); setVerification(null) }} key={index}><img src={image} alt={`Ảnh nghi ngờ ${index + 1}`}/></button>)}</div></div>}{!verification && <><div className="tabs verification-tabs"><button className={verifyMode === 'vault' ? 'selected' : ''} onClick={() => setVerifyMode('vault')}>Chọn ảnh trong kho của tôi</button><button className={verifyMode === 'file' ? 'selected' : ''} onClick={() => setVerifyMode('file')}>Tải key `.npz` từ máy</button></div>{verifyMode === 'vault' ? <><div className="vault-picker">{assets.length === 0 ? <div className="vault-picker-empty"><Icon name="image"/><span>Kho bản quyền chưa có ảnh.</span></div> : assets.map((asset) => <button className={selectedAssetId === asset.id ? 'selected' : ''} onClick={() => setSelectedAssetId(asset.id)} key={asset.id}><img src={asset.image} alt={asset.caption || 'Ảnh bản quyền'}/><span><b>{asset.caption || 'Ảnh bản quyền'}</b><small>ID {asset.accountId}</small></span><i>{selectedAssetId === asset.id ? '✓' : ''}</i></button>)}</div><button className="primary wide verify-submit" disabled={!chosenAsset || busy} onClick={() => chosenAsset && verify(chosenAsset.keyBase64, chosenAsset.caption || 'Ảnh từ kho')}>{busy ? 'Đang trích xuất watermark…' : 'Xác minh và xử lý vi phạm'}</button></> : <div className="key-drop key-drop-large"><Icon name="shield"/><b>Chọn file key `.npz` của ảnh</b><small>Hệ thống sẽ trích xuất Account ID và tự động gỡ bài nếu xác nhận vi phạm.</small><button onClick={() => keyInput.current?.click()}>Chọn key từ máy</button><input ref={keyInput} className="hidden" type="file" accept=".npz" onChange={readKey}/></div>}</>}{verification && <div className={verification.matched ? 'verification-result-card matched' : 'verification-result-card unmatched'}><span className="result-mark">{verification.matched ? '✓' : '!'}</span><div><small>{verification.matched ? 'ĐÃ XÁC MINH VÀ XỬ LÝ' : 'KHÔNG ĐỦ BẰNG CHỨNG'}</small><h3>{verification.matched ? 'Bài viết vi phạm đã được gỡ bỏ' : 'Watermark không khớp'}</h3><p>{verification.message}</p><div className="identity-proof"><div><span>Chủ sở hữu watermark</span><b>{verification.extractedOwner || 'Không xác định'}</b></div><div><span>Account ID trích xuất</span><b>{verification.extractedId || 'Không đọc được'}</b></div><div><span>Độ tin cậy</span><b>{verification.confidence ?? 0}%</b></div></div></div></div>}</section></div>}
  </div>
}
export default App
