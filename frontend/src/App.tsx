import { useCallback, useEffect, useRef, useState } from 'react'
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
type ImageLicense = { requestId: string; assetId: string; ownerUsername: string; ownerDisplayName: string; ownerAccountId: string; approvedAt: string }
type Post = { id: string; username: string; author: string; accountId: string; caption: string; image: string; images?: string[]; createdAt: string; likes: number; liked: boolean; comments: Comment[]; reported: boolean; provenance?: { status: 'new' | 'licensed'; licensedCount?: number; newCount: number }; licenses?: ImageLicense[] }
type Asset = Post & { keyBase64: string }
type CopyrightEvent = { id: string; type: 'asset_registered' | 'upload_blocked' | 'license_requested' | 'license_approved' | 'license_denied' | 'licensed_post_published'; createdAt: string; perspective: 'owner' | 'requester'; ownerDisplayName: string; ownerAccountId: string; actorDisplayName: string; actorAccountId: string; caption?: string; image?: string; matchMethod?: string; watermarkStatus?: string; extractedId?: string; extractionConfidence?: number }
type Notification = { id: string; type: string; title: string; message: string; ownerName: string; ownerAccountId: string; postCaption: string; createdAt: string; read: boolean; requestId?: string; requestStatus?: 'pending' | 'approved' | 'denied' | 'published'; requesterName?: string; requesterAccountId?: string; draftCaption?: string; draftImages?: string[]; licensedImageIndex?: number }
type LicenseRequestSummary = { id: string; assetId: string; status: 'pending' | 'approved' | 'denied' | 'published'; ownerUsername: string; ownerDisplayName: string; ownerAccountId: string; requesterUsername: string; requesterDisplayName: string; requesterAccountId: string; draftCaption: string; draftImages: string[]; imageIndex: number; createdAt: string; respondedAt?: string; postId?: string }
type LicenseCenter = { incoming: LicenseRequestSummary[]; outgoing: LicenseRequestSummary[] }
type AccountSummary = { username: string; displayName: string; accountId: string; postCount: number }
type Profile = { username: string; displayName: string; accountId: string; posts: Post[] }
type ProvenanceDetails = { imageIndex: number; assetId: string; ownerUsername: string; ownerDisplayName: string; ownerAccountId: string; registeredAt: string; matchMethod: string; pHashDistance?: number; siftMatches?: number; siftInliers?: number; watermarkStatus?: 'verified'; extractedId?: string; extractionConfidence?: number; extractionCandidatesChecked?: number; geometricCandidateCount?: number }
type ReportReason = 'copyright' | 'impersonation' | 'inappropriate' | 'spam' | 'other'

const REPORT_REASONS: { value: ReportReason; label: string; description: string }[] = [
  { value: 'copyright', label: 'Vi phạm bản quyền', description: 'Sử dụng hình ảnh hoặc tác phẩm khi chưa được phép.' },
  { value: 'impersonation', label: 'Giả mạo', description: 'Mạo danh cá nhân, tổ chức hoặc chủ sở hữu nội dung.' },
  { value: 'inappropriate', label: 'Nội dung không phù hợp', description: 'Nội dung gây hại, phản cảm hoặc vi phạm tiêu chuẩn cộng đồng.' },
  { value: 'spam', label: 'Spam', description: 'Nội dung lặp lại, quảng cáo rác hoặc gây phiền nhiễu.' },
  { value: 'other', label: 'Lý do khác', description: 'Một vấn đề khác cần quản trị viên xem xét.' },
]

class ApiError extends Error {
  code?: string
  details?: ProvenanceDetails
  constructor(message: string, code?: string, details?: ProvenanceDetails) { super(message); this.name = 'ApiError'; this.code = code; this.details = details }
}

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
function copyrightEventText(item: CopyrightEvent) {
  if (item.type === 'asset_registered') return { tone: 'protected', title: 'Ảnh đã được đăng ký bảo vệ', description: `Watermark Account ID ${item.ownerAccountId} đã được nhúng và key riêng đã được lưu.` }
  if (item.type === 'upload_blocked') return { tone: 'blocked', title: item.perspective === 'owner' ? 'Đã chặn một lượt đăng lại ảnh' : 'Ảnh tải lên đã bị chặn', description: item.perspective === 'owner' ? `${item.actorDisplayName} (ID ${item.actorAccountId}) đã tải lên ảnh thuộc kho của bạn.` : `Ảnh được xác định thuộc ${item.ownerDisplayName} (ID ${item.ownerAccountId}) nên chưa được đăng.` }
  if (item.type === 'license_requested') return { tone: 'pending', title: item.perspective === 'owner' ? 'Có yêu cầu sử dụng ảnh mới' : 'Đã gửi yêu cầu sử dụng ảnh', description: item.perspective === 'owner' ? `${item.actorDisplayName} đã gửi bản nháp để bạn xem xét.` : `Bản nháp đã được gửi đến ${item.ownerDisplayName} để duyệt.` }
  if (item.type === 'license_approved') return { tone: 'approved', title: 'Yêu cầu sử dụng ảnh đã được chấp thuận', description: `${item.ownerDisplayName} đã cho phép đăng đúng nội dung bản nháp.` }
  if (item.type === 'license_denied') return { tone: 'denied', title: 'Yêu cầu sử dụng ảnh đã bị từ chối', description: `${item.ownerDisplayName} chưa đồng ý cho sử dụng ảnh trong bản nháp.` }
  return { tone: 'published', title: 'Bài viết được cấp quyền đã được đăng', description: `${item.actorDisplayName} đã đăng bản nháp được duyệt và giữ nguyên watermark của ${item.ownerDisplayName}.` }
}

async function request<T>(path: string, options: RequestInit = {}, token = ''): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } })
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error || 'Yêu cầu không thành công.', data.code, data.details)
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
  const [copyrightLog, setCopyrightLog] = useState<CopyrightEvent[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [licenseCenter, setLicenseCenter] = useState<LicenseCenter>({ incoming: [], outgoing: [] })
  const [licenseTab, setLicenseTab] = useState<'incoming' | 'outgoing'>('incoming')
  const [activePage, setActivePage] = useState<'feed' | 'gallery' | 'copyright' | 'profile'>('feed')
  const [composerOpen, setComposerOpen] = useState(false)
  const [caption, setCaption] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
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
  const [provenanceConflict, setProvenanceConflict] = useState<ProvenanceDetails | null>(null)
  const [licenseBusy, setLicenseBusy] = useState(false)
  const [reportTarget, setReportTarget] = useState<{post: Post; image: string} | null>(null)
  const [reportReason, setReportReason] = useState<ReportReason>('copyright')
  const [reportDetail, setReportDetail] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null)

  const signOut = useCallback(async () => {
    if (session) request('/logout', { method: 'POST', body: '{}' }, session.token).catch(() => undefined)
    localStorage.removeItem(AUTH_STORAGE); setSession(null); setPosts([]); setAssets([]); setCopyrightLog([]); setNotifications([]); setLicenseCenter({ incoming: [], outgoing: [] })
  }, [session])
  const loadData = useCallback(async (active: Session) => {
    try {
      const [feed, own, audit, alerts, licenses] = await Promise.all([request<Post[]>('/feed', {}, active.token), request<Asset[]>('/assets', {}, active.token), request<CopyrightEvent[]>('/copyright-log', {}, active.token), request<Notification[]>('/notifications', {}, active.token), request<LicenseCenter>('/licenses', {}, active.token)])
      setPosts(feed); setAssets(own); setCopyrightLog(audit); setNotifications(alerts); setLicenseCenter(licenses)
    } catch (reason) { if (reason instanceof Error && reason.message.includes('Phiên đăng nhập')) signOut(); else setNotice(reason instanceof Error ? reason.message : 'Không tải được dữ liệu.') }
  }, [signOut])
  useEffect(() => {
    if (!session) return
    const timer = window.setTimeout(() => loadData(session), 0)
    return () => window.clearTimeout(timer)
  }, [session, loadData])
  useEffect(() => {
    if (!session || searchQuery.trim().length < 2) return
    const timer = window.setTimeout(() => request<AccountSummary[]>(`/accounts/search?q=${encodeURIComponent(searchQuery.trim())}`, {}, session.token).then(setSearchResults).catch(() => setSearchResults([])), 220)
    return () => window.clearTimeout(timer)
  }, [searchQuery, session])

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
  function closeComposer() { if (busy) return; setComposerOpen(false); setCaption(''); setPendingImages([]); setProvenanceConflict(null) }
  async function publish(event: FormEvent) {
    event.preventDefault(); if (!session || !pendingImages.length) { setNotice('Hãy chọn ít nhất một ảnh trước khi đăng.'); return }
    setBusy(true); setProvenanceConflict(null); setNotice(`Đang kiểm tra nguồn gốc ${pendingImages.length} ảnh…`)
    try {
      const post = await request<Post>('/posts', { method: 'POST', body: JSON.stringify({ images: pendingImages, caption }) }, session.token)
      setPosts((current) => [post, ...current]); setCaption(''); setPendingImages([]); setComposerOpen(false)
      setNotice(post.provenance?.licensedCount ? `Đã đăng ảnh theo quyền sử dụng được cấp. Watermark của chủ sở hữu được giữ nguyên và bài viết đã ghi rõ nguồn.` : `Đã đăng ${post.images?.length || 1} ảnh và lưu key bản quyền thành công.`)
      const own = await request<Asset[]>('/assets', {}, session.token); setAssets(own)
    }
    catch (reason) {
      if (reason instanceof ApiError && reason.code === 'PROVENANCE_CONFLICT' && reason.details) {
        setProvenanceConflict(reason.details); setNotice('')
        request<CopyrightEvent[]>('/copyright-log', {}, session.token).then(setCopyrightLog).catch(() => undefined)
      } else setNotice(reason instanceof Error ? reason.message : 'Không thể đăng ảnh.')
    }
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
  function openReport(post: Post, image: string) { setReportTarget({ post, image }); setReportReason('copyright'); setReportDetail(''); setViewerMenu(false) }
  function closeReport() { if (reportBusy) return; setReportTarget(null); setReportDetail('') }
  async function submitReport(event: FormEvent) {
    event.preventDefault(); if (!session || !reportTarget) return
    const images = reportTarget.post.images || [reportTarget.post.image]
    const imageIndex = Math.max(0, images.indexOf(reportTarget.image))
    setReportBusy(true)
    try {
      const result = await request<{ok:boolean; alreadyExists:boolean}>('/report', { method: 'POST', body: JSON.stringify({ postId: reportTarget.post.id, imageIndex, reason: reportReason, detail: reportDetail }) }, session.token)
      closeReport(); setReportTarget(null)
      setNotice(result.alreadyExists ? 'Báo cáo này đang chờ quản trị viên xem xét.' : 'Đã gửi báo cáo đến quản trị viên. Bài viết sẽ được giữ nguyên trong khi chờ xem xét.')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể gửi báo cáo.') }
    finally { setReportBusy(false) }
  }
  async function toggleNotifications() {
    const next = !notificationsOpen; setNotificationsOpen(next)
    if (next && session && notifications.some((item) => !item.read)) {
      setNotifications((current) => current.map((item) => ({ ...item, read: true })))
      request('/notifications/read', { method: 'POST', body: '{}' }, session.token).catch(() => undefined)
    }
  }
  async function refreshLicenseCenter(active = session) {
    if (!active) return
    setLicenseCenter(await request<LicenseCenter>('/licenses', {}, active.token))
  }
  async function refreshCopyrightLog(active = session) {
    if (!active) return
    setCopyrightLog(await request<CopyrightEvent[]>('/copyright-log', {}, active.token))
  }
  async function askForLicense() {
    if (!session || !provenanceConflict) return
    setLicenseBusy(true)
    try {
      const result = await request<{status:string; alreadyExists?:boolean}>('/licenses/request', { method: 'POST', body: JSON.stringify({ assetId: provenanceConflict.assetId, caption, images: pendingImages, imageIndex: provenanceConflict.imageIndex }) }, session.token)
      const message = result.status === 'approved' ? 'Bản nháp này đã được chủ sở hữu duyệt. Hãy mở thông báo để đăng bài.' : result.alreadyExists ? 'Bản nháp này đang chờ chủ sở hữu phản hồi.' : 'Đã gửi toàn bộ bản nháp đến chủ sở hữu để xem trước.'
      setProvenanceConflict(null); setComposerOpen(false); setCaption(''); setPendingImages([]); setNotice(message)
      await Promise.all([refreshLicenseCenter(session), refreshCopyrightLog(session)])
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể gửi yêu cầu sử dụng ảnh.') }
    finally { setLicenseBusy(false) }
  }
  async function respondToLicense(item: Notification | LicenseRequestSummary, decision: 'approved' | 'denied') {
    const requestId = 'requestId' in item ? item.requestId : item.id
    if (!session || !requestId) return
    try {
      await request('/licenses/respond', { method: 'POST', body: JSON.stringify({ requestId, decision }) }, session.token)
      setNotifications((current) => current.map((notification) => notification.requestId === requestId ? { ...notification, requestStatus: decision, read: true } : notification))
       await Promise.all([refreshLicenseCenter(session), refreshCopyrightLog(session)])
      setNotice(decision === 'approved' ? 'Đã cấp quyền. Người yêu cầu có thể đăng lại ảnh với watermark gốc.' : 'Đã từ chối yêu cầu sử dụng ảnh.')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể phản hồi yêu cầu.') }
  }
  async function publishApprovedDraft(item: Notification | LicenseRequestSummary) {
    const requestId = 'requestId' in item ? item.requestId : item.id
    if (!session || !requestId) return
    try {
      const post = await request<Post>('/licenses/publish', { method: 'POST', body: JSON.stringify({ requestId }) }, session.token)
      setPosts((current) => [post, ...current])
      const [own, alerts, licenses, audit] = await Promise.all([request<Asset[]>('/assets', {}, session.token), request<Notification[]>('/notifications', {}, session.token), request<LicenseCenter>('/licenses', {}, session.token), request<CopyrightEvent[]>('/copyright-log', {}, session.token)])
      setAssets(own); setNotifications(alerts); setLicenseCenter(licenses); setCopyrightLog(audit); setNotificationsOpen(false)
      setNotice('Đã đăng đúng bản nháp được chủ sở hữu chấp thuận. Watermark gốc được giữ nguyên.')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Không thể đăng bản nháp đã duyệt.') }
  }
  function renderNotification(item: Notification) {
    return <article className={!item.read ? 'unread' : ''} key={item.id}><span className="notification-symbol"><Icon name="shield"/></span><div><b>{item.title}</b><p>{item.message}</p>{item.type === 'license_request' && item.draftImages && item.draftImages.length > 0 && <div className="notification-draft"><div className="notification-draft-author"><span className="avatar">{initials(item.requesterName || 'U')}</span><span><b>{item.requesterName}</b><small>Account ID {item.requesterAccountId}</small></span></div>{item.draftCaption ? <p className="notification-draft-caption">{item.draftCaption}</p> : <p className="notification-draft-caption empty">Bài viết không có nội dung chữ.</p>}<div className={`notification-draft-images count-${Math.min(item.draftImages.length, 4)}`}>{item.draftImages.slice(0, 4).map((image, index) => <figure key={index}><img src={image} alt={`Ảnh trong bản nháp ${index + 1}`}/>{index === item.licensedImageIndex && <span>Ảnh của bạn</span>}{index === 3 && item.draftImages!.length > 4 && <i>+{item.draftImages!.length - 4}</i>}</figure>)}</div><em>Nội dung và ảnh sẽ bị khóa sau khi bạn cho phép.</em></div>}<small>{timeLabel(item.createdAt)}</small>{item.type === 'license_request' && item.requestStatus === 'pending' && <div className="license-request-actions"><button onClick={() => respondToLicense(item, 'denied')}>Từ chối</button><button className="approve" onClick={() => respondToLicense(item, 'approved')}>Cho phép đăng</button></div>}{item.type === 'license_response' && item.requestStatus === 'approved' && item.draftImages && item.draftImages.length > 0 && <div className="license-request-actions"><button className="approve publish-approved" onClick={() => publishApprovedDraft(item)}>Đăng bài đã duyệt</button></div>}{item.requestStatus && item.requestStatus !== 'pending' && !(item.type === 'license_response' && item.requestStatus === 'approved') && <span className={`license-request-status ${item.requestStatus}`}>{item.requestStatus === 'approved' ? 'Đã cho phép' : item.requestStatus === 'published' ? 'Đã đăng bài' : 'Đã từ chối'}</span>}</div></article>
  }
  function renderLicenseRequest(item: LicenseRequestSummary, direction: 'incoming' | 'outgoing') {
    const statusLabel = item.status === 'pending' ? 'Đang chờ duyệt' : item.status === 'approved' ? 'Đã cho phép' : item.status === 'published' ? 'Đã đăng bài' : 'Đã từ chối'
    const personName = direction === 'incoming' ? item.requesterDisplayName : item.ownerDisplayName
    const personId = direction === 'incoming' ? item.requesterAccountId : item.ownerAccountId
    return <article className="license-center-card" key={item.id}><header><span className="avatar">{initials(personName)}</span><div><b>{personName}</b><small>Account ID {personId} · {timeLabel(item.createdAt)}</small></div><span className={`license-center-status ${item.status}`}>{statusLabel}</span></header>{item.draftCaption ? <p>{item.draftCaption}</p> : <p className="empty-caption">Bài viết không có nội dung chữ.</p>}<div className={`license-center-images count-${Math.min(item.draftImages.length, 4)}`}>{item.draftImages.slice(0, 4).map((image, index) => <figure key={index}><img src={image} alt={`Ảnh bản nháp ${index + 1}`}/>{index === item.imageIndex && <span>Ảnh bản quyền</span>}{index === 3 && item.draftImages.length > 4 && <i>+{item.draftImages.length - 4}</i>}</figure>)}</div>{direction === 'incoming' && item.status === 'pending' && <footer><button onClick={() => respondToLicense(item, 'denied')}>Từ chối</button><button className="approve" onClick={() => respondToLicense(item, 'approved')}>Cho phép đăng</button></footer>}{direction === 'outgoing' && item.status === 'approved' && <footer><button className="approve publish" onClick={() => publishApprovedDraft(item)}>Đăng bài đã duyệt</button></footer>}</article>
  }
  if (!session) return <AuthScreen onAuthenticated={(value) => { localStorage.setItem(AUTH_STORAGE, JSON.stringify(value)); setSession(value) }}/>
  return <div className="app-shell">
    <header className="topbar">
      <div className="top-left"><div className="brand"><span className="brand-mark">w</span><span>Watermark Social</span></div><div className="search"><Icon name="search"/><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Tìm kiếm tài khoản"/>{searchQuery.trim().length >= 2 && <section className="search-dropdown">{searchResults.length === 0 ? <p>Không tìm thấy tài khoản phù hợp.</p> : searchResults.map((account) => <button onClick={() => openProfile(account.username)} key={account.username}><span className={`avatar ${account.username === session.username ? 'mine' : ''}`}>{initials(account.displayName)}</span><span><b>{account.displayName}</b><small>Account ID {account.accountId} · {account.postCount} bài viết</small></span></button>)}</section>}</div></div>
      <nav><button className={activePage === 'feed' ? 'nav-active' : ''} onClick={() => setActivePage('feed')} title="Bảng tin"><Icon name="home"/></button><button className={activePage === 'gallery' ? 'nav-active' : ''} onClick={() => setActivePage('gallery')} title="Kho bản quyền"><Icon name="image"/></button></nav>
      <div className="top-actions"><div className="notification-wrap"><button className="notification-button" onClick={toggleNotifications} title="Thông báo"><Icon name="bell"/>{notifications.some((item) => !item.read) && <span>{Math.min(9, notifications.filter((item) => !item.read).length)}{notifications.filter((item) => !item.read).length > 9 ? '+' : ''}</span>}</button>{notificationsOpen && <section className="notification-dropdown"><header><h3>Thông báo</h3><span>{notifications.length} thông báo</span></header>{notifications.length === 0 ? <div className="notification-empty"><Icon name="bell"/><p>Bạn chưa có thông báo mới.</p></div> : <div className="notification-list">{notifications.map(renderNotification)}</div>}</section>}</div><button className="profile-compact" onClick={() => openProfile(session.username)}><div className="user-compact"><span>{session.displayName}</span><small>ID {session.accountId}</small></div><span className="avatar mine">{initials(session.displayName)}</span></button><button className="logout-button" onClick={signOut} title="Đăng xuất"><Icon name="logout"/></button></div>
    </header>
    <main className="layout">
      <aside className="leftbar"><button className="profile-row" onClick={() => openProfile(session.username)}><span className="avatar large mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small>{session.username}</small></div></button><button className={`side-link ${activePage === 'feed' ? 'active' : ''}`} onClick={() => setActivePage('feed')}><Icon name="home"/>Bảng tin</button><button className={`side-link ${activePage === 'gallery' ? 'active' : ''}`} onClick={() => setActivePage('gallery')}><Icon name="image"/>Kho bản quyền <span className="badge">{assets.length}</span></button><button className={`side-link ${activePage === 'copyright' ? 'active' : ''}`} onClick={() => { setActivePage('copyright'); refreshCopyrightLog() }}><Icon name="shield"/>Nhật ký bản quyền</button></aside>
      {activePage === 'feed' ? <section className="feed">
        <section className="composer compact-composer"><span className="avatar mine">{initials(session.displayName)}</span><button className="composer-prompt" onClick={() => openComposer()}>{session.displayName.trim().split(/\s+/).slice(-1)[0]} ơi, bạn đang nghĩ gì thế?</button><button className="composer-photo" type="button" onClick={() => openComposer(true)} title="Chọn ảnh từ máy"><Icon name="image"/><span>Ảnh</span></button></section>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {posts.length === 0 && <div className="empty-feed"><Icon name="image"/><h3>Chưa có bài viết</h3><p>Hãy là người đầu tiên chia sẻ một bức ảnh.</p></div>}
        {posts.map((post) => <article className="post" key={post.id}>
          <div className="post-head"><span className={`avatar ${post.username === session.username ? 'mine' : ''}`}>{initials(post.author)}</span><div><b>{post.author}</b><small>{timeLabel(post.createdAt)} · ID {post.accountId}</small></div>{post.username === session.username && <div className="post-menu-wrap"><button className="more" onClick={() => setPostMenuId((current) => current === post.id ? '' : post.id)}>•••</button>{postMenuId === post.id && <div className="post-menu"><button onClick={() => { setEditingPost(post); setEditCaption(post.caption); setPostMenuId('') }}>Chỉnh sửa bài viết</button><button className="delete-option" onClick={() => removePost(post)}>Xóa bài viết</button></div>}</div>}</div>
          {post.licenses && post.licenses.length > 0 && <div className="licensed-post-label"><Icon name="shield"/><span>Đăng lại với sự cho phép của <b>{post.licenses[0].ownerDisplayName}</b> · Account ID {post.licenses[0].ownerAccountId}</span></div>}
          {post.caption && post.caption !== 'Ảnh không có tiêu đề' && <p className="caption">{post.caption}</p>}
          <div className={`post-media media-count-${Math.min(post.images?.length || 1, 4)}`}>{(post.images || [post.image]).map((image, index) => <button className="post-image-trigger" onClick={() => setPhotoViewer({ post, image })} key={index}><img className="post-image" src={image} alt={post.caption || `Ảnh ${index + 1}`}/></button>)}</div>
          <div className="post-stats"><span>{post.likes} lượt thích</span><button onClick={() => setOpenComments((current) => current.includes(post.id) ? current : [...current, post.id])}>{(post.comments || []).length > 0 ? `${post.comments.length} bình luận` : ''}</button>{post.reported && <span className="reported">Đang khiếu nại bản quyền</span>}</div>
          <div className="post-actions"><button className={post.liked ? 'liked' : ''} onClick={() => like(post.id)}><Icon name="heart"/>Thích</button><button onClick={() => setOpenComments((current) => current.includes(post.id) ? current.filter((id) => id !== post.id) : [...current, post.id])}><Icon name="comment"/>Bình luận</button><button><Icon name="share"/>Chia sẻ</button></div>
          {(post.comments || []).length > 0 && <div className="post-comments">{(openComments.includes(post.id) ? post.comments : post.comments.slice(-2)).map((item) => <div className="comment-row" key={item.id}><span className={`avatar comment-avatar ${item.username === session.username ? 'mine' : ''}`}>{initials(item.author)}</span><div><b>{item.author}</b><p>{item.text}</p><small>{timeLabel(item.createdAt)}</small></div></div>)}</div>}
          {openComments.includes(post.id) && <form className="comment-composer" onSubmit={(event) => comment(event, post.id)}><span className="avatar comment-avatar mine">{initials(session.displayName)}</span><input value={commentDrafts[post.id] || ''} onChange={(event) => setCommentDrafts((current) => ({ ...current, [post.id]: event.target.value }))} placeholder="Viết bình luận…" maxLength={1000} autoFocus/><button disabled={!commentDrafts[post.id]?.trim()}>Gửi</button></form>}
        </article>)}
      </section> : activePage === 'gallery' ? <section className="gallery-page">
        <div className="gallery-heading"><div><span className="gallery-icon"><Icon name="shield"/></span><div><h1>Kho bản quyền</h1><p>Quản lý ảnh đã được nhúng watermark và tải key xác minh.</p></div></div><span>{assets.length} ảnh</span></div>
        {assets.length === 0 ? <div className="gallery-empty"><Icon name="image"/><h3>Kho bản quyền đang trống</h3><p>Ảnh bạn đăng sẽ xuất hiện tại đây cùng key `.npz` riêng.</p></div> : <div className="gallery-grid image-only-gallery">{assets.map((asset) => <article className="gallery-card" key={asset.id}><img src={asset.image} alt="Ảnh bản quyền"/><div className="gallery-overlay"><button onClick={() => downloadKey(asset)}><Icon name="download"/> Tải key `.npz`</button></div></article>)}</div>}
      </section> : activePage === 'copyright' ? <section className="history-page copyright-log-page">
        <div className="gallery-heading"><div><span className="gallery-icon"><Icon name="shield"/></span><div><h1>Nhật ký bản quyền</h1><p>Các sự kiện được hệ thống tự động ghi nhận trong quá trình bảo vệ ảnh.</p></div></div><span>{copyrightLog.length} sự kiện</span></div>
        {copyrightLog.length === 0 ? <div className="gallery-empty"><Icon name="shield"/><h3>Chưa có sự kiện bản quyền</h3><p>Khi bạn đăng ảnh hoặc hệ thống phát hiện ảnh trùng, kết quả sẽ tự động xuất hiện tại đây.</p></div> : <div className="copyright-log-list">{copyrightLog.map((item) => { const meta = copyrightEventText(item); return <article className={`copyright-log-item ${meta.tone}`} key={item.id}>{item.image ? <img src={item.image} alt="Ảnh bản quyền"/> : <span className="copyright-log-placeholder"><Icon name="shield"/></span>}<div className="copyright-log-content"><div className="copyright-log-title"><b>{meta.title}</b><span>{timeLabel(item.createdAt)}</span></div><p>{meta.description}</p>{item.caption && <blockquote>{item.caption}</blockquote>}<dl><div><dt>Chủ sở hữu</dt><dd>{item.ownerDisplayName || 'Không xác định'} · ID {item.ownerAccountId || '—'}</dd></div>{item.actorDisplayName && <div><dt>Tài khoản thao tác</dt><dd>{item.actorDisplayName} · ID {item.actorAccountId || '—'}</dd></div>}<div><dt>Watermark</dt><dd>{item.extractedId ? `Đã đọc ID ${item.extractedId}` : item.type === 'upload_blocked' ? 'Không khôi phục được ID' : 'Đã được hệ thống bảo vệ'}</dd></div></dl></div></article> })}</div>}
      </section> : <section className="profile-page">{profile ? <>
        <div className="profile-cover"><div className={`avatar profile-avatar ${profile.username === session.username ? 'mine' : ''}`}>{initials(profile.displayName)}</div></div>
        <div className="profile-info"><div><h1>{profile.displayName}</h1><p>{profile.username}</p><span>Account ID {profile.accountId}</span></div><strong>{profile.posts.length}<small>bài viết</small></strong></div>
        {profile.username === session.username && <section className="license-center"><div className="license-center-heading"><div><h2>Quản lý yêu cầu sử dụng ảnh</h2><p>Theo dõi các bản nháp cần duyệt và những yêu cầu bạn đã gửi.</p></div><span>{licenseCenter.incoming.filter((item) => item.status === 'pending').length} chờ duyệt</span></div><div className="license-center-tabs"><button className={licenseTab === 'incoming' ? 'active' : ''} onClick={() => setLicenseTab('incoming')}>Các bài viết cần duyệt <span>{licenseCenter.incoming.length}</span></button><button className={licenseTab === 'outgoing' ? 'active' : ''} onClick={() => setLicenseTab('outgoing')}>Đã gửi yêu cầu duyệt <span>{licenseCenter.outgoing.length}</span></button></div><div className="license-center-list">{licenseCenter[licenseTab].length === 0 ? <div className="license-center-empty"><Icon name="shield"/><b>{licenseTab === 'incoming' ? 'Không có bài viết cần duyệt' : 'Bạn chưa gửi yêu cầu nào'}</b><p>{licenseTab === 'incoming' ? 'Các yêu cầu sử dụng ảnh của bạn sẽ xuất hiện tại đây.' : 'Yêu cầu xin phép đăng lại ảnh sẽ được tổng hợp tại đây.'}</p></div> : licenseCenter[licenseTab].map((item) => renderLicenseRequest(item, licenseTab))}</div></section>}
        <div className="profile-section-title"><h2>Ảnh đã đăng</h2><span>{profile.posts.reduce((total, post) => total + (post.images?.length || 1), 0)} ảnh</span></div>
        {profile.posts.length === 0 ? <div className="gallery-empty profile-empty"><Icon name="image"/><h3>Chưa có bài viết</h3></div> : <div className="profile-photo-grid">{profile.posts.flatMap((post) => (post.images || [post.image]).map((image, index) => <button onClick={() => setPhotoViewer({ post, image })} key={`${post.id}-${index}`}><img src={image} alt={post.caption || 'Ảnh bài viết'}/></button>))}</div>}
      </> : <div className="gallery-empty"><p>Đang tải trang cá nhân…</p></div>}</section>}
      <aside className="rightbar"><section className="account-card"><div className="card-title"><b>Account ID</b></div><div className="account-id-value">{session.accountId}</div></section></aside>
    </main>
    <input ref={imageInput} className="hidden" type="file" accept="image/*" multiple onChange={chooseImages}/>
    {composerOpen && <div className="modal-backdrop composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer() }}><form className="create-post-modal" onSubmit={publish}><header><h2>Tạo bài viết</h2><button type="button" className="close" onClick={closeComposer} aria-label="Đóng">×</button></header><div className="create-post-author"><span className="avatar mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small><Icon name="shield"/> Watermark ID {session.accountId}</small></div></div><textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder={`Bạn đang nghĩ gì, ${session.displayName}?`} autoFocus/>{pendingImages.length > 0 ? <div className={`upload-preview preview-count-${Math.min(pendingImages.length, 4)}`}>{pendingImages.map((image, index) => <figure key={index}><img src={image} alt={`Ảnh đã chọn ${index + 1}`}/><button type="button" onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>{index === 3 && pendingImages.length > 4 && <span>+{pendingImages.length - 4}</span>}</figure>)}</div> : <button type="button" className="photo-drop" onClick={() => imageInput.current?.click()}><span><Icon name="image"/></span><b>Thêm ảnh</b><small>Chọn tối đa 10 ảnh từ máy</small></button>}<div className="add-to-post"><b>Thêm vào bài viết</b><button type="button" onClick={() => imageInput.current?.click()} title="Thêm ảnh"><Icon name="image"/></button><span>Mỗi ảnh được nhúng watermark và có key riêng</span></div><button className="create-post-submit" disabled={busy || pendingImages.length === 0}>{busy ? `Đang bảo vệ ${pendingImages.length} ảnh…` : `Đăng${pendingImages.length ? ` ${pendingImages.length} ảnh` : ''}`}</button></form></div>}
    {provenanceConflict && <div className="modal-backdrop provenance-backdrop"><section className="provenance-modal">
      <header><span className="provenance-alert"><Icon name="shield"/></span><div><small>HỆ THỐNG BẢO VỆ BẢN QUYỀN</small><h2>Ảnh đã có chủ sở hữu</h2></div><button className="close" onClick={() => setProvenanceConflict(null)}>×</button></header>
      <div className="provenance-preview">{pendingImages[provenanceConflict.imageIndex] && <img src={pendingImages[provenanceConflict.imageIndex]} alt="Ảnh trùng khớp"/>}<span>Ảnh thứ {provenanceConflict.imageIndex + 1}</span></div>
      <p className="provenance-explanation">Hệ thống đã lấy ứng viên từ các ảnh watermark trong Kho bản quyền, xác minh hình học bằng SIFT + RANSAC rồi thử trích xuất watermark bằng key tương ứng. Ảnh chưa bị nhúng thêm watermark.</p>
      <dl className="provenance-owner"><div><dt>Chủ sở hữu đã đăng ký</dt><dd>{provenanceConflict.ownerDisplayName}</dd></div><div><dt>Account ID</dt><dd>{provenanceConflict.ownerAccountId}</dd></div><div><dt>Thời điểm đăng ký</dt><dd>{timeLabel(provenanceConflict.registeredAt)}</dd></div><div><dt>Xác minh watermark</dt><dd className="watermark-evidence verified">Đã trích xuất hợp lệ</dd></div><div><dt>ID trích xuất</dt><dd>{provenanceConflict.extractedId}</dd></div></dl>
      <div className="provenance-actions three-actions"><button type="button" disabled={licenseBusy} onClick={askForLicense}>{licenseBusy ? 'Đang gửi…' : 'Gửi yêu cầu sử dụng'}</button><button type="button" className="secondary" onClick={() => { const index = provenanceConflict.imageIndex; setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index)); setProvenanceConflict(null) }}>Bỏ ảnh này</button><button type="button" className="owner-link" onClick={() => { const owner = provenanceConflict.ownerUsername; setProvenanceConflict(null); closeComposer(); openProfile(owner) }}>Xem trang chủ sở hữu</button></div>
    </section></div>}
    {editingPost && <div className="modal-backdrop edit-backdrop"><form className="edit-post-modal" onSubmit={savePostEdit}><header><h2>Chỉnh sửa bài viết</h2><button type="button" className="close" onClick={() => setEditingPost(null)}>×</button></header><div className="create-post-author"><span className="avatar mine">{initials(session.displayName)}</span><div><b>{session.displayName}</b><small>Chỉ chỉnh sửa nội dung chữ</small></div></div><textarea value={editCaption} onChange={(event) => setEditCaption(event.target.value)} placeholder="Viết nội dung cho bài viết…" maxLength={5000} autoFocus/><div className="edit-preview"><img src={editingPost.image} alt="Ảnh bài viết"/><span>Ảnh và watermark được giữ nguyên</span></div><button className="create-post-submit">Lưu thay đổi</button></form></div>}
    {photoViewer && <div className="photo-viewer">
      <button className="viewer-close" onClick={() => { setPhotoViewer(null); setViewerMenu(false) }} aria-label="Đóng">×</button>
      <div className="photo-stage"><img src={photoViewer.image} alt={photoViewer.post.caption || 'Ảnh bài viết'}/><div className="viewer-menu-wrap"><button className="viewer-menu-button" onClick={() => setViewerMenu((current) => !current)} aria-label="Tùy chọn">•••</button>{viewerMenu && <div className="viewer-menu"><button onClick={() => { downloadImage(photoViewer.image, photoViewer.post.id); setViewerMenu(false) }}><Icon name="download"/><span><b>Lưu ảnh</b><small>Tải ảnh watermark về máy</small></span></button>{photoViewer.post.username !== session.username && <button className="copyright-option" onClick={() => openReport(photoViewer.post, photoViewer.image)}><Icon name="flag"/><span><b>Báo cáo bài viết</b><small>Gửi nội dung này đến quản trị viên</small></span></button>}</div>}</div></div>
      <aside className="viewer-panel"><div className="post-head"><span className={`avatar ${photoViewer.post.username === session.username ? 'mine' : ''}`}>{initials(photoViewer.post.author)}</span><div><b>{photoViewer.post.author}</b><small>{timeLabel(photoViewer.post.createdAt)} · ID {photoViewer.post.accountId}</small></div></div>{photoViewer.post.licenses && photoViewer.post.licenses.length > 0 && <div className="licensed-post-label viewer-license"><Icon name="shield"/><span>Được <b>{photoViewer.post.licenses[0].ownerDisplayName}</b> cho phép sử dụng · Account ID {photoViewer.post.licenses[0].ownerAccountId}</span></div>}{photoViewer.post.caption && photoViewer.post.caption !== 'Ảnh không có tiêu đề' && <p className="viewer-caption">{photoViewer.post.caption}</p>}<div className="viewer-stats"><span>{photoViewer.post.likes} lượt thích</span><span>{(photoViewer.post.comments || []).length} bình luận</span></div><div className="viewer-actions"><button className={photoViewer.post.liked ? 'liked' : ''} onClick={() => like(photoViewer.post.id)}><Icon name="heart"/>Thích</button><button><Icon name="comment"/>Bình luận</button></div><div className="viewer-comments">{(photoViewer.post.comments || []).length === 0 ? <p className="no-comments">Chưa có bình luận nào.</p> : photoViewer.post.comments.map((item) => <div className="comment-row" key={item.id}><span className={`avatar comment-avatar ${item.username === session.username ? 'mine' : ''}`}>{initials(item.author)}</span><div><b>{item.author}</b><p>{item.text}</p><small>{timeLabel(item.createdAt)}</small></div></div>)}</div><form className="comment-composer viewer-comment" onSubmit={(event) => comment(event, photoViewer.post.id)}><span className="avatar comment-avatar mine">{initials(session.displayName)}</span><input value={commentDrafts[photoViewer.post.id] || ''} onChange={(event) => setCommentDrafts((current) => ({ ...current, [photoViewer.post.id]: event.target.value }))} placeholder="Viết bình luận…" maxLength={1000}/><button disabled={!commentDrafts[photoViewer.post.id]?.trim()}>Gửi</button></form></aside>
    </div>}
    {reportTarget && <div className="modal-backdrop moderation-report-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeReport() }}><form className="moderation-report-modal" onSubmit={submitReport}><header><span className="report-modal-icon"><Icon name="flag"/></span><div><small>BÁO CÁO NỘI DUNG</small><h2>Báo cáo bài viết</h2></div><button type="button" className="close" onClick={closeReport}>×</button></header><div className="report-post-preview"><img src={reportTarget.image} alt="Ảnh được báo cáo"/><div><small>Bài viết của</small><b>{reportTarget.post.author}</b><span>Account ID {reportTarget.post.accountId}</span></div></div><fieldset><legend>Vì sao bạn báo cáo bài viết này?</legend>{REPORT_REASONS.map((reason) => <label className={reportReason === reason.value ? 'selected' : ''} key={reason.value}><input type="radio" name="report-reason" value={reason.value} checked={reportReason === reason.value} onChange={() => setReportReason(reason.value)}/><span><b>{reason.label}</b><small>{reason.description}</small></span><i>{reportReason === reason.value ? '✓' : ''}</i></label>)}</fieldset><label className="report-detail-label">Thông tin bổ sung <span>Không bắt buộc</span><textarea value={reportDetail} onChange={(event) => setReportDetail(event.target.value)} maxLength={1000} placeholder="Mô tả ngắn để quản trị viên hiểu rõ vấn đề…"/></label><p className="report-review-note"><Icon name="shield"/><span>Báo cáo sẽ được chuyển đến quản trị viên để xem xét. Bài viết không bị tự động xóa.</span></p><footer><button type="button" className="secondary" onClick={closeReport}>Hủy</button><button type="submit" className="submit-report" disabled={reportBusy}>{reportBusy ? 'Đang gửi…' : 'Gửi báo cáo'}</button></footer></form></div>}
  </div>
}
export default App
