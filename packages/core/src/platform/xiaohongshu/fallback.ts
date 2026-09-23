/**
 * 小红书无 Cookie 兜底解析。
 *
 * ## 为什么需要它
 *
 * v7 的 `noteDetail` / `noteComments` 端点必须先签名，而签名要 cookie 里的 `a1`；
 * 没有 `a1` 时 amagi 直接返回 `INTERNAL_ERROR（sign 阶段）：a1Value cannot be empty`。
 * 就算自己造一个 `a1`，游客身份请求 `/api/sns/web/v1/feed` 也会被平台按 HTTP 461 / 406
 * 拒掉 —— 实测游客身份拿不到这两个接口，只有带真实登录态 cookie 才行。
 *
 * 参考实现 `TZJackZ2B9S/XHSAnalyse` 绕开了接口：笔记页的 `__INITIAL_STATE__`
 * 里已经带了笔记正文、互动数据、图片/视频流，直接抓 HTML 解析即可，完全不需要 cookie。
 * 本模块就是把那条路径搬过来，并把字段整形成 amagi 的形状，让上层
 * `XiaohongshuHandler` 与模板一行都不用改。
 *
 * ## 能力边界
 *
 * - **能拿到**：标题、正文、作者、互动数据、IP 归属、发布时间、图片列表
 *   （含 Live 图视频流）、视频笔记的全部画质档位。
 * - **拿不到**：评论区。笔记页 SSR 的 `comments.list` 实测恒为空数组，
 *   评论必须走接口，而接口要登录态。无 Cookie 时上层会跳过评论区而不是报错。
 * - 表情列表走 `redmoji/detail`，这个接口游客身份可用，无需签名。
 *
 * @module platform/xiaohongshu/fallback
 */

import type { XiaohongshuEmojiListResponse, XiaohongshuNoteDetailResponse } from '@ikenxuan/amagi'
import axios from 'node-karin/axios'

import { logger } from '@/module/utils/logger'

/** 笔记页要求桌面端 UA，移动端只会下发 720p 一档流 */
const UA_NOTE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
/** 短链跳转用移动端 UA，与分享场景一致 */
const UA_MOBILE =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Safari/537.36 HeyTapBrowser/51.8.8'
const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'

/** 笔记 ID 的三条常见路径 */
const NOTE_ID_PATTERNS = [/\/explore\/([a-f0-9]{24})/i, /\/discovery\/item\/([a-f0-9]{24})/i, /\/note\/([a-f0-9]{24})/i]
/** 短链域名 */
const SHORT_LINK_RE = /^https?:\/\/xhslink\.(?:com|cn)(?:\/|$)/i

/** 简单退避 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 无 Cookie 模式下的字段名转换：HTML 是 camelCase，amagi 返回 snake_case */
const STREAM_KEY_MAP: Record<string, string> = {
  masterUrl: 'master_url',
  backupUrls: 'backup_urls',
  backupUrl: 'backup_url',
  videoCodec: 'video_codec',
  audioCodec: 'audio_codec',
  videoBitrate: 'video_bitrate',
  audioBitrate: 'audio_bitrate',
  avgBitrate: 'avg_bitrate',
  qualityType: 'quality_type',
  streamDesc: 'stream_desc',
  hdrType: 'hdr_type'
}

/** 判断链接是不是小红书短链 */
export const isShortLink = (url: string): boolean => SHORT_LINK_RE.test(url)

/**
 * Cookie 是否具备签名能力。
 *
 * v7 的签名从 `a1` 派生，缺了它接口一定抛 `a1Value cannot be empty`；
 * 只拷到 `web_session` 而没有 `a1` 的半截 Cookie（开发者工具里很常见）
 * 照样走不通。提前判掉能省一次注定失败的请求，也避免评论区白跑一趟。
 * @param cookie - 配置里的小红书 Cookie
 */
export const hasSigningCookie = (cookie: string): boolean => cookie.split(';').some((part) => part.split('=', 1)[0]?.trim() === 'a1')

/** 从长链接里取笔记 ID */
export const extractNoteId = (url: string): string => {
  for (const pattern of NOTE_ID_PATTERNS) {
    const matched = pattern.exec(url)
    if (matched?.[1]) return matched[1]
  }
  return ''
}

/** 把 `http://` 升到 `https://`，并去掉转义残留 */
const normalizeUrl = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const raw = value.trim().replace(/\\\//g, '/').replace(/&amp;/g, '&')
  if (!raw) return ''
  if (raw.startsWith('http://')) return `https://${raw.slice(7)}`
  return raw.startsWith('https://') ? raw : ''
}

/**
 * 展开短链，并还原 `redirectPath`。
 *
 * 小红书现在会把短链重定向到登录页，真实地址塞在 `redirectPath` 查询参数里，
 * 所以要把它解出来，否则只能看到一个不含笔记 ID 的登录地址。
 */
export const resolveShareLink = async (url: string): Promise<string> => {
  if (!isShortLink(url)) return url

  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA_MOBILE },
      maxRedirects: 0,
      validateStatus: () => true
    })
    const location = resp?.headers?.location
    if (typeof location !== 'string' || !location) return url

    const joined = String(new URL(location, url))
    const decoded = (() => {
      try {
        return decodeURIComponent(joined)
      } catch {
        return joined
      }
    })()

    // `/login?redirectPath=...` 与 `/404/sec_xxx?redirectPath=...` 都走这里
    const matched = /[?&]redirectPath=([^&#]+)/.exec(decoded)
    if (matched?.[1]) {
      try {
        return decodeURIComponent(matched[1])
      } catch {
        return matched[1]
      }
    }
    return decoded
  } catch (error) {
    logger.debug(`[小红书] 短链展开失败，按原链接处理: ${String(error)}`)
    return url
  }
}

/**
 * 把任意笔记地址改写成 `/explore/<note_id>`，**保留原查询串**。
 *
 * `xsec_token` 只在 `discovery/item` 这类路径上有效，直接抓它会被跳到 404 风控页；
 * 换成 `explore` 路径、query 原样带上，才能稳定拿到 SSR 数据。
 */
export const buildExploreUrl = (baseUrl: string, noteId: string): string => {
  try {
    const parsed = new URL(baseUrl)
    const marker = /\/(?:explore|note|discovery\/item)\//i.exec(parsed.pathname)
    const root = marker ? parsed.pathname.slice(0, marker.index) : parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${root}/explore/${noteId}${parsed.search}`
  } catch {
    return `https://www.xiaohongshu.com/explore/${noteId}`
  }
}

/**
 * 从 HTML 里抽出 `__INITIAL_STATE__`。
 *
 * 页面里是 `window.__INITIAL_STATE__={...}` 这种赋值，且带 `undefined` /
 * `new Map([])` 这类非 JSON 字面量，要先做替换再 `JSON.parse`。
 */
export const extractInitialState = (html: string): Record<string, unknown> | null => {
  const marker = html.indexOf('__INITIAL_STATE__')
  if (marker < 0) return null
  const end = html.indexOf('</script>', marker)
  if (end < 0) return null

  const snippet = html.slice(marker, end)
  const assignment = snippet.indexOf('={')
  if (assignment < 0) return null

  const payload = snippet
    .slice(assignment + 1)
    .replace(/:undefined/g, ':null')
    .replace(/: undefined/g, ': null')
    .replace(/new Map\(\[\]\)/g, '{}')
    .replace(/new Set\(\[\]\)/g, '{}')

  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 取对象字段，兼容两种命名 */
const pick = (value: unknown, ...keys: string[]): unknown => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const found = record[key]
    if (found !== undefined && found !== null) return found
  }
  return undefined
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 流条目 key 转 snake_case。
 *
 * 上层 `xiaohongshuProcessVideos` / `xiaohongshuGetLivePhotoVideo` 读的是
 * `master_url` / `size` / `stream_desc` 这套名字，和 amagi 的返回保持一致。
 */
const normalizeStreamEntry = (entry: unknown): Record<string, unknown> => {
  const record = asRecord(entry)
  if (!record) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    out[STREAM_KEY_MAP[key] ?? key] = key === 'masterUrl' || key === 'backupUrl' ? normalizeUrl(value) : value
  }
  if (Array.isArray(out.backup_urls)) {
    out.backup_urls = out.backup_urls.map(normalizeUrl).filter(Boolean)
  }
  if (typeof out.master_url !== 'string' || !out.master_url) {
    const fallback = normalizeUrl(pick(record, 'masterUrl', 'master_url', 'url', 'play_url'))
    if (fallback) out.master_url = fallback
  }
  return out
}

/** 整个 stream（编码 → 码流数组）转 snake_case */
const normalizeStream = (stream: unknown): Record<string, unknown[]> => {
  const record = asRecord(stream)
  if (!record) return {}
  const out: Record<string, unknown[]> = {}
  for (const [codec, list] of Object.entries(record)) {
    const entries = asArray(list)
      .map(normalizeStreamEntry)
      .filter((item) => Object.keys(item).length > 0)
    if (entries.length > 0) out[codec] = entries
  }
  return out
}

/** `mediaV2` 在页面里偶尔是 JSON 字符串 */
const parseMaybeJson = (value: unknown): Record<string, unknown> | null => {
  const direct = asRecord(value)
  if (direct) return direct
  if (typeof value === 'string' && value.trim()) {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return null
}

/** 组装 video 字段：mediaV2 优先于 media，两者都提供全部画质档位 */
const normalizeVideo = (video: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(video)
  if (!record) return undefined

  const mediaV2 = parseMaybeJson(pick(record, 'mediaV2', 'media_v2'))
  const media = parseMaybeJson(pick(record, 'media'))

  const streamV2 = normalizeStream(pick(mediaV2, 'stream'))
  const streamV1 = normalizeStream(pick(media, 'stream'))
  // mediaV2 是更高清的那份清单，两边的编码互补，合并而不是覆盖
  const merged: Record<string, unknown[]> = { ...streamV1 }
  for (const [codec, list] of Object.entries(streamV2)) {
    merged[codec] = [...(merged[codec] ?? []), ...list]
  }

  const image = pick(record, 'image')
  const imageUrl = normalizeUrl(typeof image === 'string' ? image : pick(image, 'urlDefault', 'url_default', 'firstFrame'))

  return {
    media: { stream: merged },
    mediaV2: { stream: streamV2 },
    stream: merged,
    consumer: pick(record, 'consumer'),
    url_default: imageUrl || normalizeUrl(pick(record, 'urlDefault', 'url_default')),
    duration: asNumber(pick(record, 'duration', 'capa', 'videoDuration'))
  }
}

/** 组装 image_list，含 Live 图的视频流 */
const normalizeImageList = (list: unknown): Record<string, unknown>[] =>
  asArray(list).map((item) => {
    const record = asRecord(item) ?? {}
    const stream = normalizeStream(pick(record, 'stream'))
    return {
      file_id: asText(pick(record, 'fileId', 'file_id')),
      trace_id: asText(pick(record, 'traceId', 'trace_id')),
      width: asNumber(pick(record, 'width')),
      height: asNumber(pick(record, 'height')),
      url: normalizeUrl(pick(record, 'url')),
      url_default: normalizeUrl(pick(record, 'urlDefault', 'url_default')),
      url_pre: normalizeUrl(pick(record, 'urlPre', 'url_pre')),
      live_photo: Boolean(pick(record, 'livePhoto', 'live_photo')),
      stream,
      info_list: asArray(pick(record, 'infoList', 'info_list')).map((info) => {
        const infoRecord = asRecord(info) ?? {}
        return {
          image_scene: asText(pick(infoRecord, 'imageScene', 'image_scene')),
          url: normalizeUrl(pick(infoRecord, 'url'))
        }
      })
    }
  })

/** 互动数据 camelCase → snake_case */
const normalizeInteract = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value) ?? {}
  return {
    collected: Boolean(pick(record, 'collected')),
    collected_count: asText(pick(record, 'collectedCount', 'collected_count')),
    comment_count: asText(pick(record, 'commentCount', 'comment_count')),
    followed: Boolean(pick(record, 'followed')),
    liked: Boolean(pick(record, 'liked')),
    liked_count: asText(pick(record, 'likedCount', 'liked_count')),
    nice_count: asText(pick(record, 'niceCount', 'nice_count')),
    relation: asText(pick(record, 'relation')),
    share_count: asText(pick(record, 'shareCount', 'share_count'))
  }
}

/** 作者信息 camelCase → snake_case，并把头像地址补齐协议 */
const normalizeUser = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value) ?? {}
  return {
    user_id: asText(pick(record, 'userId', 'user_id')),
    nickname: asText(pick(record, 'nickname')),
    avatar: normalizeUrl(pick(record, 'avatar')),
    xsec_token: asText(pick(record, 'xsecToken', 'xsec_token'))
  }
}

/**
 * 把页面 state 里的笔记对象整形成 amagi `noteDetail` 的 `note_card`。
 *
 * 字段名从 camelCase 转 snake_case，图片/视频流里的 key 一并转换，
 * 这样上层读 `note_card.image_list[0].url_default` 之类的代码无需改动。
 */
export const normalizeNoteCard = (note: unknown): Record<string, unknown> => {
  const record = asRecord(note) ?? {}
  const card: Record<string, unknown> = {
    note_id: asText(pick(record, 'noteId', 'note_id')),
    title: asText(pick(record, 'title', 'displayTitle')),
    desc: asText(pick(record, 'desc')),
    type: asText(pick(record, 'type')),
    time: asNumber(pick(record, 'time', 'lastUpdateTime', 'last_update_time')),
    last_update_time: asNumber(pick(record, 'lastUpdateTime', 'last_update_time')),
    ip_location: asText(pick(record, 'ipLocation', 'ip_location')),
    user: normalizeUser(pick(record, 'user')),
    interact_info: normalizeInteract(pick(record, 'interactInfo', 'interact_info')),
    image_list: normalizeImageList(pick(record, 'imageList', 'image_list')),
    tag_list: asArray(pick(record, 'tagList', 'tag_list')).map((tag) => {
      const tagRecord = asRecord(tag) ?? {}
      return {
        id: asText(pick(tagRecord, 'id')),
        name: asText(pick(tagRecord, 'name')),
        type: asText(pick(tagRecord, 'type'))
      }
    }),
    at_user_list: asArray(pick(record, 'atUserList', 'at_user_list')).map((user) => {
      const userRecord = asRecord(user) ?? {}
      return {
        nickname: asText(pick(userRecord, 'nickname')),
        user_id: asText(pick(userRecord, 'userId', 'user_id')),
        xsec_token: asText(pick(userRecord, 'xsecToken', 'xsec_token'))
      }
    }),
    share_info: {
      un_share: Boolean(pick(pick(record, 'shareInfo', 'share_info'), 'unShare', 'un_share'))
    }
  }

  const video = normalizeVideo(pick(record, 'video'))
  if (video) card.video = video
  return card
}

/** 从 state 里定位笔记对象：优先 `noteData`，回退 `note.noteDetailMap` */
export const extractNoteFromState = (state: Record<string, unknown>): Record<string, unknown> | null => {
  const direct = asRecord(pick(pick(pick(state, 'noteData'), 'data'), 'noteData'))
  if (direct && asText(pick(direct, 'noteId', 'note_id'))) return direct

  const noteMap = asRecord(pick(pick(state, 'note'), 'noteDetailMap'))
  if (noteMap) {
    const first = Object.values(noteMap)[0]
    const firstRecord = asRecord(first)
    if (firstRecord) {
      const inner = asRecord(pick(firstRecord, 'note'))
      return inner ?? firstRecord
    }
  }
  return null
}

/**
 * 无 Cookie 抓取笔记详情。
 *
 * 小红书对无身份请求会间歇性投风控页（`/404/sec_*`），同一个地址隔几秒重试
 * 往往就能过 —— 参考实现同样靠重试兜住这种情况，所以这里带一次短退避重试。
 *
 * @param noteId - 笔记 ID
 * @param xsecToken - 分享链接里的 `xsec_token`，可空（空时用 `pc_feed` 来源的裸地址）
 * @returns 与 amagi `fetchNoteDetail` 同形的成功信封；失败抛错，由调用方兜底
 */
export const fetchNoteDetailFallback = async (noteId: string, xsecToken = ''): Promise<XiaohongshuNoteDetailResponse> => {
  const query = new URLSearchParams()
  if (xsecToken) {
    query.set('xsec_token', xsecToken)
    query.set('xsec_source', 'pc_feed')
  }
  const target = `https://www.xiaohongshu.com/explore/${noteId}${query.size > 0 ? `?${query.toString()}` : ''}`

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1200 * attempt)

    // node-karin 的 axios 没导出响应类型，这里按实际用到的字段收一个最小结构
    let resp: { data?: unknown; request?: { res?: { responseUrl?: string } } } | null = null
    try {
      resp = (await axios.get(target, {
        headers: {
          'User-Agent': UA_NOTE,
          Accept: ACCEPT_HTML,
          'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        validateStatus: () => true
      })) as { data?: unknown; request?: { res?: { responseUrl?: string } } }
    } catch (error) {
      lastError = new Error(`小红书笔记页请求失败: ${String(error)}`)
      continue
    }

    const html = typeof resp?.data === 'string' ? resp.data : ''
    if (!html) {
      lastError = new Error('小红书笔记页返回了空内容')
      continue
    }

    const finalUrl = String(resp?.request?.res?.responseUrl ?? target)
    const blocked = /\/404\/sec|\/website-login\/captcha/.test(finalUrl) || html.includes('请通过验证')
    if (blocked) {
      lastError = new Error('被小红书风控拦截，请稍后重试或配置小红书 Cookie')
      logger.debug(`[小红书] 第 ${attempt + 1} 次请求被风控，准备重试: ${noteId}`)
      continue
    }

    const state = extractInitialState(html)
    const note = state ? extractNoteFromState(state) : null
    if (!note) {
      lastError = new Error('小红书笔记页里没有找到笔记数据，可能是笔记已删除或需要 Cookie')
      continue
    }

    const noteCard = normalizeNoteCard(note)
    logger.debug(`[小红书] 无 Cookie 兜底解析成功: ${noteId}，图片 ${(noteCard.image_list as unknown[]).length} 张`)
    return {
      code: 0,
      success: true,
      msg: '成功',
      data: {
        current_time: Date.now(),
        cursor_score: '',
        items: [{ id: noteId, ignore: false, model_type: 'note', note_card: noteCard }]
      }
    } as unknown as XiaohongshuNoteDetailResponse
  }

  throw lastError ?? new Error('小红书笔记解析失败')
}

/**
 * 无 Cookie 抓取表情列表。
 *
 * `redmoji/detail` 游客身份可用，实测无需 cookie 与签名 —— 和笔记接口不同，
 * 这条不依赖登录态，因此无 Cookie 模式下表情依然能正常渲染。
 */
export const fetchEmojiListFallback = async (): Promise<XiaohongshuEmojiListResponse> => {
  const resp = await axios.get('https://edith.xiaohongshu.com/api/im/redmoji/detail', {
    headers: {
      'User-Agent': UA_NOTE,
      Origin: 'https://www.xiaohongshu.com',
      Referer: 'https://www.xiaohongshu.com/'
    },
    validateStatus: () => true
  })

  const body = asRecord(resp?.data)
  if (!body) throw new Error('小红书表情接口返回异常')

  // 接口偶尔把真正的数据再套一层，两种形状都兼容
  const tabs = asArray(pick(pick(body, 'data'), 'emoji') ? pick(pick(pick(body, 'data'), 'emoji'), 'tabs') : undefined)
  if (tabs.length === 0) throw new Error('小红书表情接口没有返回表情')

  return {
    code: 0,
    success: true,
    msg: '成功',
    data: { emoji: { tabs } }
  } as unknown as XiaohongshuEmojiListResponse
}
