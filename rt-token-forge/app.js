import {
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  buildCpaZipBytes,
  buildFailedText,
  buildSub2ApiBatch,
  downloadBytes,
  downloadText,
  parseRtInput,
  refreshToken,
  timestampedName,
} from './rt-generator.js'

const DEFAULT_CONCURRENCY = 5
const DEFAULT_PLAN_TYPE = 'team'
const $ = (id) => document.getElementById(id)

const state = {
  parsed: parseRtInput(''),
  successes: [],
  failures: [],
  running: false,
  cpaBytes: null,
  subJson: '',
}

const el = {
  input: $('rtInput'),
  lineSummary: $('lineSummary'),
  totalCount: $('totalCount'),
  validCount: $('validCount'),
  successCount: $('successCount'),
  failedCount: $('failedCount'),
  duplicateCount: $('duplicateCount'),
  invalidCount: $('invalidCount'),
  issueCount: $('issueCount'),
  issueBox: $('issueBox'),
  logBox: $('logBox'),
  progressText: $('progressText'),
  progressBar: $('progressBar'),
  runBtn: $('runBtn'),
  runState: $('runState'),
  downloadCpaBtn: $('downloadCpaBtn'),
  downloadSubBtn: $('downloadSubBtn'),
  downloadFailedBtn: $('downloadFailedBtn'),
  pasteBtn: $('pasteBtn'),
  copyValidBtn: $('copyValidBtn'),
  clearBtn: $('clearBtn'),
  clearLogBtn: $('clearLogBtn'),
}

function renderParse() {
  state.parsed = parseRtInput(el.input.value)
  el.lineSummary.textContent = `${state.parsed.totalLines} 行 / ${state.parsed.validTokens.length} 有效`
  el.totalCount.textContent = String(state.parsed.totalLines)
  el.validCount.textContent = String(state.parsed.validTokens.length)
  el.duplicateCount.textContent = String(state.parsed.duplicateRows.length)
  el.invalidCount.textContent = String(state.parsed.invalidRows.length)
  renderIssues()
  renderButtons()
  renderRunState()
}

function renderRun() {
  el.successCount.textContent = String(state.successes.length)
  el.failedCount.textContent = String(state.failures.length)
  renderButtons()
  renderRunState()
}

function renderButtons() {
  const hasTokens = state.parsed.validTokens.length > 0
  el.runBtn.disabled = state.running || !hasTokens
  el.runBtn.textContent = state.running ? '刷新中...' : '刷新 RT 并生成'
  el.downloadCpaBtn.disabled = !state.cpaBytes
  el.downloadSubBtn.disabled = !state.subJson
  el.downloadFailedBtn.disabled = state.failures.length === 0 &&
    state.parsed.invalidRows.length === 0 &&
    state.parsed.duplicateRows.length === 0
}

function renderRunState() {
  if (state.running) {
    el.runState.textContent = '刷新中'
    return
  }

  if (state.cpaBytes || state.subJson) {
    el.runState.textContent = `已生成 ${state.successes.length}`
    return
  }

  if (state.parsed.validTokens.length) {
    el.runState.textContent = '可刷新'
    return
  }

  el.runState.textContent = state.parsed.totalLines ? '待修正' : '待输入'
}

function renderIssues() {
  const parseRows = [
    ...state.parsed.invalidRows.map((row) => ({ type: 'invalid', ...row })),
    ...state.parsed.duplicateRows.map((row) => ({ type: 'duplicate', ...row })),
  ]
  el.issueCount.textContent = String(parseRows.length + state.failures.length)

  const parseText = parseRows
    .map((row) => `${row.type}\tline=${row.lineNumber}\t${row.reason}\t${row.value}`)
    .join('\n')
  const failureText = state.failures
    .map((row) => `failed\tline=${row.lineNumber || '?'}\t${row.error}\t${previewToken(row.rt)}`)
    .join('\n')

  el.issueBox.textContent = [parseText, failureText].filter(Boolean).join('\n') || '暂无异常'
}

function previewToken(token) {
  const value = String(token || '')
  if (value.length <= 28) return value
  return `${value.slice(0, 18)}...${value.slice(-6)}`
}

function formatRefreshError(error) {
  const message = error?.message || String(error)
  const lower = message.toLowerCase()
  const isNetworkError = lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed')

  if (!isNetworkError) return message
  return `${message}（浏览器当前无法连接 auth.openai.com，请检查网络或代理）`
}

function log(message) {
  const now = new Date().toLocaleTimeString()
  if (el.logBox.textContent === '等待开始') el.logBox.textContent = ''
  el.logBox.textContent += `[${now}] ${message}\n`
  el.logBox.scrollTop = el.logBox.scrollHeight
}

function setProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0
  el.progressText.textContent = total ? `${done}/${total} (${pct}%)` : '待开始'
  el.progressBar.style.width = `${pct}%`
}

async function runPool(items, concurrency, worker) {
  let next = 0
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const current = next
      next += 1
      await worker(items[current], current)
      done += 1
      setProgress(done, items.length)
      renderRun()
      renderIssues()
    }
  })
  await Promise.all(workers)
}

async function runGenerate() {
  renderParse()
  const tokens = state.parsed.validTokens
  if (!tokens.length || state.running) return

  state.running = true
  state.successes = []
  state.failures = []
  state.cpaBytes = null
  state.subJson = ''
  el.logBox.textContent = ''
  setProgress(0, tokens.length)
  renderRun()
  renderIssues()

  log(`开始刷新 ${tokens.length} 个 RT，并发=${DEFAULT_CONCURRENCY}`)

  await runPool(tokens, DEFAULT_CONCURRENCY, async (rt, index) => {
    const lineNumber = findLineNumber(rt)
    try {
      const result = await refreshToken(rt, {
        clientId: DEFAULT_CLIENT_ID,
        redirectUri: DEFAULT_REDIRECT_URI,
      })
      state.successes.push(result)
      log(`成功 #${index + 1} line=${lineNumber || '?'} AT=${previewToken(result.access_token)}`)
    } catch (error) {
      const message = formatRefreshError(error)
      state.failures.push({ rt, lineNumber, error: message })
      log(`失败 #${index + 1} line=${lineNumber || '?'} ${message}`)
    }
  })

  if (state.successes.length) {
    state.cpaBytes = buildCpaZipBytes(state.successes)
    state.subJson = JSON.stringify(buildSub2ApiBatch(state.successes, {
      clientId: DEFAULT_CLIENT_ID,
      planType: DEFAULT_PLAN_TYPE,
    }), null, 2)
    log(`文件已生成：CPA ZIP + Sub2API JSON；成功账号 ${state.successes.length} 个`)
  } else {
    log('没有成功刷新任何 RT，未生成 CPA/Sub2API 文件')
  }

  state.running = false
  renderRun()
  renderIssues()
}

function findLineNumber(rt) {
  const lines = el.input.value.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === rt) return i + 1
  }
  return 0
}

function resetOutputs() {
  state.successes = []
  state.failures = []
  state.cpaBytes = null
  state.subJson = ''
  setProgress(0, 0)
  renderRun()
  renderIssues()
}

el.input.addEventListener('input', () => {
  resetOutputs()
  renderParse()
})

el.runBtn.addEventListener('click', runGenerate)

el.downloadCpaBtn.addEventListener('click', () => {
  if (!state.cpaBytes) return
  downloadBytes(timestampedName('cpa_auth_files', 'zip'), state.cpaBytes, 'application/zip')
})

el.downloadSubBtn.addEventListener('click', () => {
  if (!state.subJson) return
  downloadText(timestampedName('sub2api_accounts', 'json'), state.subJson, 'application/json;charset=utf-8')
})

el.downloadFailedBtn.addEventListener('click', () => {
  const parseFailures = [
    ...state.parsed.invalidRows.map((row) => ({
      lineNumber: row.lineNumber,
      value: row.value,
      reason: row.reason,
    })),
    ...state.parsed.duplicateRows.map((row) => ({
      lineNumber: row.lineNumber,
      value: row.value,
      reason: row.reason,
    })),
  ]
  const runtimeFailures = state.failures.map((row) => ({
    lineNumber: row.lineNumber,
    rt: row.rt,
    reason: row.error,
  }))
  downloadText(
    timestampedName('rt_failed', 'txt'),
    buildFailedText([...parseFailures, ...runtimeFailures]),
    'text/plain;charset=utf-8',
  )
})

el.clearBtn.addEventListener('click', () => {
  el.input.value = ''
  resetOutputs()
  el.logBox.textContent = '等待开始'
  renderParse()
})

el.clearLogBtn.addEventListener('click', () => {
  el.logBox.textContent = '等待开始'
})

el.copyValidBtn.addEventListener('click', async () => {
  renderParse()
  try {
    await navigator.clipboard.writeText(state.parsed.validTokens.join('\n'))
    log(`已复制 ${state.parsed.validTokens.length} 个有效 RT`)
  } catch (error) {
    log(`复制失败：${error?.message || error}`)
  }
})

el.pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText()
    el.input.value = text
    resetOutputs()
    renderParse()
  } catch (error) {
    log(`粘贴失败：${error?.message || error}`)
  }
})

renderParse()
renderRun()
