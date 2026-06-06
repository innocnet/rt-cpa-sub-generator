(() => {
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const RT_TOKEN_PATTERN = /^rt\.\d+\.\S+$/

const MODEL_MAPPING = {
  'codex-auto-review': 'codex-auto-review',
  'gpt-4o-audio-preview': 'gpt-4o-audio-preview',
  'gpt-4o-realtime-preview': 'gpt-4o-realtime-preview',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5.2-chat-latest': 'gpt-5.2-chat-latest',
  'gpt-5.2-pro': 'gpt-5.2-pro',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'gpt-5.3-codex-spark': 'gpt-5.3-codex-spark',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'gpt-5.5': 'gpt-5.5',
  'gpt-image-1': 'gpt-image-1',
  'gpt-image-1.5': 'gpt-image-1.5',
  'gpt-image-2': 'gpt-image-2',
}

function parseRtInput(input) {
  const validTokens = []
  const invalidRows = []
  const duplicateRows = []
  const seen = new Set()
  let totalLines = 0

  String(input || '').split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim()
    if (!value) return

    totalLines += 1
    const lineNumber = index + 1
    if (!RT_TOKEN_PATTERN.test(value)) {
      invalidRows.push({ lineNumber, value, reason: '不是 rt.版本.token 格式' })
      return
    }

    if (seen.has(value)) {
      duplicateRows.push({ lineNumber, value, reason: '重复 RT，已忽略' })
      return
    }

    seen.add(value)
    validTokens.push(value)
  })

  return { totalLines, validTokens, invalidRows, duplicateRows }
}

async function refreshToken(rt, options = {}) {
  const clientId = String(options.clientId || DEFAULT_CLIENT_ID).trim()
  const redirectUri = String(options.redirectUri || DEFAULT_REDIRECT_URI).trim()
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前浏览器不支持 fetch')

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: rt,
    redirect_uri: redirectUri,
  })

  const resp = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const text = await resp.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  if (!resp.ok) {
    const message = data?.error?.message || data?.message || resp.statusText || `HTTP ${resp.status}`
    const code = data?.error?.code || data?.error || ''
    throw new Error(code ? `${message} (${code})` : message)
  }

  const accessToken = String(data.access_token || '').trim()
  if (!accessToken) throw new Error('刷新成功但响应缺少 access_token')

  return {
    input_refresh_token: rt,
    access_token: accessToken,
    refresh_token: String(data.refresh_token || rt).trim(),
    id_token: String(data.id_token || '').trim(),
    expires_in: Number(data.expires_in || 0),
    token_type: String(data.token_type || '').trim(),
    raw: data,
  }
}

function buildCpaAuthFile(tokenResult) {
  return {
    type: 'codex',
    access_token: tokenResult.access_token || '',
    refresh_token: tokenResult.refresh_token || tokenResult.input_refresh_token || '',
  }
}

function buildSub2ApiBatch(tokenResults, options = {}) {
  const exportedAt = options.exportedAt || new Date().toISOString()
  const dateLabel = options.dateLabel || formatDateLabel(new Date(exportedAt))
  const clientId = String(options.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID
  const planType = String(options.planType || 'team').trim() || 'team'
  const nowSeconds = Math.floor(Date.now() / 1000)

  return {
    exported_at: exportedAt,
    proxies: [],
    accounts: tokenResults.map((result, index) => {
      const accessPayload = decodeJwtPayload(result.access_token)
      const idPayload = decodeJwtPayload(result.id_token)
      const accessAuth = extractAuth(accessPayload)
      const idAuth = extractAuth(idPayload)
      const email = String(result.email || accessPayload.email || idPayload.email || '').trim()
      const expiresAt = Number(accessPayload.exp || 0) > 0
        ? Number(accessPayload.exp)
        : nowSeconds + Number(result.expires_in || 863999)

      return {
        name: `${dateLabel} #${index + 1}`,
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: result.access_token || '',
          chatgpt_account_id: String(accessAuth.chatgpt_account_id || idAuth.chatgpt_account_id || '').trim(),
          chatgpt_user_id: String(accessAuth.chatgpt_user_id || idAuth.chatgpt_user_id || '').trim(),
          client_id: clientId,
          email,
          expires_at: expiresAt,
          id_token: result.id_token || '',
          model_mapping: { ...MODEL_MAPPING },
          organization_id: extractOrganizationId(idPayload),
          plan_type: String(accessAuth.chatgpt_plan_type || idAuth.chatgpt_plan_type || planType).trim() || planType,
          refresh_token: result.refresh_token || result.input_refresh_token || '',
        },
        extra: {
          email,
          openai_oauth_responses_websockets_v2_enabled: false,
          openai_oauth_responses_websockets_v2_mode: 'off',
          privacy_mode: 'training_off',
        },
        concurrency: 10,
        priority: 1,
        rate_multiplier: 1,
        auto_pause_on_expired: true,
      }
    }),
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length < 2) return {}

    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const data = JSON.parse(new TextDecoder().decode(bytes))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function extractAuth(payload) {
  const auth = payload?.['https://api.openai.com/auth']
  return auth && typeof auth === 'object' ? auth : {}
}

function extractOrganizationId(idPayload) {
  const auth = extractAuth(idPayload)
  const direct = String(auth.organization_id || '').trim()
  if (direct) return direct

  const organizations = Array.isArray(auth.organizations) ? auth.organizations : []
  for (const item of organizations) {
    const id = String(item?.id || '').trim()
    if (id) return id
  }

  return ''
}

function buildCpaZipBytes(tokenResults) {
  const files = tokenResults.map((result, index) => ({
    filename: `${String(index + 1).padStart(6, '0')}.json`,
    content: JSON.stringify(buildCpaAuthFile(result), null, 2),
  }))
  return createZipBytes(files)
}

function buildFailedText(failures) {
  return failures.map((item) => {
    const line = item.lineNumber ? `line=${item.lineNumber}` : 'line=?'
    const reason = item.reason || item.error || ''
    const token = item.rt || item.value || ''
    return `${line}\t${reason}\t${token}`
  }).join('\n') + (failures.length ? '\n' : '')
}

function formatDateLabel(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function timestampedName(prefix, ext) {
  const now = new Date()
  const stamp = [
    formatDateLabel(now),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `${prefix}_${stamp}.${ext}`
}

function downloadText(filename, content, mime = 'application/json;charset=utf-8') {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

function downloadBytes(filename, bytes, mime = 'application/octet-stream') {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  downloadBlob(filename, new Blob([buffer], { type: mime }))
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function createZipBytes(files) {
  const localParts = []
  const prepared = []
  let offset = 0

  for (const file of files) {
    const filenameBytes = new TextEncoder().encode(file.filename)
    const dataBytes = new TextEncoder().encode(file.content)
    const crc = crc32(dataBytes)
    const localHeader = new Uint8Array(30 + filenameBytes.length)
    const view = new DataView(localHeader.buffer)

    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, dataBytes.length, true)
    view.setUint32(22, dataBytes.length, true)
    view.setUint16(26, filenameBytes.length, true)
    view.setUint16(28, 0, true)
    localHeader.set(filenameBytes, 30)

    localParts.push(localHeader, dataBytes)
    prepared.push({ filenameBytes, dataBytes, crc32: crc, offset })
    offset += localHeader.length + dataBytes.length
  }

  const centralOffset = offset
  const centralParts = []
  let centralSize = 0

  for (const file of prepared) {
    const central = new Uint8Array(46 + file.filenameBytes.length)
    const view = new DataView(central.buffer)

    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint16(14, 0, true)
    view.setUint32(16, file.crc32, true)
    view.setUint32(20, file.dataBytes.length, true)
    view.setUint32(24, file.dataBytes.length, true)
    view.setUint16(28, file.filenameBytes.length, true)
    view.setUint16(30, 0, true)
    view.setUint16(32, 0, true)
    view.setUint16(34, 0, true)
    view.setUint16(36, 0, true)
    view.setUint32(38, 0, true)
    view.setUint32(42, file.offset, true)
    central.set(file.filenameBytes, 46)

    centralParts.push(central)
    centralSize += central.length
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, prepared.length, true)
  endView.setUint16(10, prepared.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, centralOffset, true)
  endView.setUint16(20, 0, true)

  return concatBytes([...localParts, ...centralParts, end])
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

let crcTable = null

function crc32(bytes) {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function getCrcTable() {
  if (crcTable) return crcTable

  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }

  crcTable = table
  return table
}

window.RtTokenForge = {
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  TOKEN_URL,
  RT_TOKEN_PATTERN,
  MODEL_MAPPING,
  buildCpaZipBytes,
  buildFailedText,
  buildSub2ApiBatch,
  downloadBytes,
  downloadText,
  parseRtInput,
  refreshToken,
  timestampedName,
}
})()
