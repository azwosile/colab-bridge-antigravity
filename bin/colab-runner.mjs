/**
 * colab-bridge runner — subprocess wrapper, output sanitizer, auth-expiry detector,
 * and async job manager for google-colab-cli on Windows/POSIX.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')

export const VALID_GPUS = Object.freeze(['T4', 'L4', 'G4', 'A100', 'H100'])
export const VALID_TPUS = Object.freeze(['v5e1', 'v6e1'])
export const VALID_AUTH_MODES = Object.freeze(['oauth2', 'adc'])

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const OAUTH_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2[^\s"'<>]+/i

function isUnexpandedTemplate(val) {
  return typeof val === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(val.trim())
}

function loadLocalConfig(pluginRoot = PLUGIN_ROOT) {
  const cfgPath = path.join(pluginRoot, 'local.config.json')
  if (!fs.existsSync(cfgPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    logErr(`Failed to parse local.config.json: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

function pickConfigValue(...candidates) {
  for (const val of candidates) {
    if (val !== undefined && val !== null && String(val).trim() !== '' && !isUnexpandedTemplate(String(val))) {
      return String(val)
    }
  }
  return null
}

function looksLikePath(exe) {
  return typeof exe === 'string' && (exe.includes('/') || exe.includes('\\') || path.isAbsolute(exe))
}

export function logErr(msg) {
  process.stderr.write(`[colab-bridge] ${msg}\n`)
}

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_ESCAPE_RE, '')
}

export function normalizeAuthMode(auth, fallback = 'oauth2') {
  const value = String(auth || fallback || 'oauth2').trim().toLowerCase()
  if (!VALID_AUTH_MODES.includes(value)) {
    throw new Error(`Invalid auth mode '${auth}'. Expected one of: ${VALID_AUTH_MODES.join(', ')}.`)
  }
  return value
}

export function validateSessionName(session, { required = true } = {}) {
  if (session === undefined || session === null || String(session).trim() === '') {
    if (required) {
      throw new Error('Missing required parameter: session (always pass an explicit session name, e.g. "gpu-render").')
    }
    return null
  }
  const s = String(session).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)) {
    throw new Error(
      `Invalid session name '${s}'. Use 1-64 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.`
    )
  }
  return s
}

export function validateAccelerator({ gpu, tpu } = {}) {
  const normGpu = gpu ? String(gpu).trim().toUpperCase() : null
  const normTpu = tpu ? String(tpu).trim().toLowerCase() : null
  if (normGpu && normTpu) {
    throw new Error('Specify at most one of gpu or tpu, not both.')
  }
  if (normGpu && !VALID_GPUS.includes(normGpu)) {
    throw new Error(`Unsupported gpu '${gpu}'. Supported values: ${VALID_GPUS.join(', ')}.`)
  }
  if (normTpu && !VALID_TPUS.includes(normTpu)) {
    throw new Error(`Unsupported tpu '${tpu}'. Supported values: ${VALID_TPUS.join(', ')}.`)
  }
  return { gpu: normGpu, tpu: normTpu }
}

export function buildShellWrapperPython(shellCmd, cwd = '/content') {
  const cmdJson = JSON.stringify(String(shellCmd))
  const cwdJson = JSON.stringify(String(cwd || '/content'))
  return [
    'import subprocess, sys',
    `__cmd = ${cmdJson}`,
    `__cwd = ${cwdJson}`,
    '__proc = subprocess.Popen(__cmd, shell=True, cwd=__cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)',
    'if __proc.stdout is not None:',
    '    for __line in __proc.stdout:',
    '        sys.stdout.write(__line)',
    '        sys.stdout.flush()',
    '__rc = __proc.wait()',
    'if __rc != 0:',
    '    sys.stderr.write(f"[colab-bridge shell exit code: {__rc}]\\n")',
    '    sys.stderr.flush()',
    '    raise SystemExit(__rc)',
    '',
  ].join('\n')
}

export function detectAuthProblem(stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`
  const urlMatch = combined.match(OAUTH_URL_RE)
  const hasPrompt = /Enter the authorization code|To authorize colab-cli|RefreshError|invalid_grant/i.test(
    combined
  )
  if (!urlMatch && !hasPrompt) return null
  return {
    auth_required: true,
    auth_url: urlMatch ? urlMatch[0] : null,
    hint:
      'Colab OAuth2 credentials are missing or expired and require interactive browser consent. ' +
      'Re-authenticate once in a normal terminal using colab-cli (with HOME pinned to COLAB_BRIDGE_HOME), then retry.',
  }
}

export function buildEnvFlags(envObj) {
  if (!envObj) return []
  if (typeof envObj !== 'object' || Array.isArray(envObj)) {
    throw new Error('Parameter env must be a JSON object mapping KEY -> VALUE.')
  }
  const args = []
  for (const [k, v] of Object.entries(envObj)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`Invalid environment variable name in env: '${k}'.`)
    }
    args.push('--env', `${k}=${String(v ?? '')}`)
  }
  return args
}

export function truncateOutput(text, maxChars, logDir, prefix) {
  const clean = stripAnsi(text)
  const limit = Math.max(1024, Math.min(200000, Number(maxChars) || 24000))
  if (clean.length <= limit) {
    return { text: clean, truncated: false, totalChars: clean.length, logFile: null }
  }
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.log`)
  fs.writeFileSync(logFile, clean, 'utf8')
  const headLen = Math.floor(limit * 0.4)
  const tailLen = limit - headLen
  const omitted = clean.length - limit
  const snippet =
    `${clean.slice(0, headLen)}\n\n` +
    `... [${omitted} chars omitted; full output saved to ${logFile}] ...\n\n` +
    `${clean.slice(clean.length - tailLen)}`
  return { text: snippet, truncated: true, totalChars: clean.length, logFile }
}

function killChildTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.unref()
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // Ignore best-effort cleanup.
    }
  }
}

export class ColabRunner {
  constructor(options = {}) {
    const localCfg = options.ignoreLocalConfig ? {} : loadLocalConfig(options.pluginRoot || PLUGIN_ROOT)
    const defaultPy = process.platform === 'win32' ? 'python' : 'python3'

    this.pythonExe = pickConfigValue(
      options.pythonExe,
      process.env.COLAB_BRIDGE_PYTHON,
      localCfg.pythonExe,
      defaultPy
    )
    this.sitePackages = pickConfigValue(
      options.sitePackages,
      process.env.COLAB_BRIDGE_SITE_PACKAGES,
      localCfg.sitePackages
    )
    this.colabHome = pickConfigValue(
      options.colabHome,
      process.env.COLAB_BRIDGE_HOME,
      localCfg.colabHome,
      os.homedir()
    )
    this.shimDir = pickConfigValue(
      options.shimDir,
      process.env.COLAB_BRIDGE_SHIM_DIR,
      localCfg.shimDir,
      __dirname
    )
    this.defaultAuth = normalizeAuthMode(
      pickConfigValue(options.defaultAuth, process.env.COLAB_BRIDGE_AUTH, localCfg.defaultAuth, 'oauth2')
    )
    this.dataDir = pickConfigValue(
      options.dataDir,
      process.env.COLAB_BRIDGE_DATA_DIR,
      localCfg.dataDir,
      path.join(os.tmpdir(), 'colab-bridge-data')
    )
    this.configFile = pickConfigValue(
      options.configFile,
      process.env.COLAB_BRIDGE_CONFIG,
      localCfg.configFile
    )
    this.tmpDir = path.join(this.dataDir, 'tmp')
    this.logsDir = path.join(this.dataDir, 'logs')
    this.jobsDir = path.join(this.dataDir, 'jobs')

    this.activeChildren = new Set()
    this.jobs = new Map()
    this.maxRetainedJobs = 50
  }

  _assertPythonAvailable() {
    if (looksLikePath(this.pythonExe) && !fs.existsSync(this.pythonExe)) {
      throw new Error(
        `COLAB_BRIDGE_PYTHON not found at '${this.pythonExe}'. Set COLAB_BRIDGE_PYTHON in mcp_config.json or local.config.json.`
      )
    }
  }

  buildSubprocessEnv() {
    const existingPyPath = process.env.PYTHONPATH
    const pathParts = [this.shimDir]
    if (this.sitePackages && fs.existsSync(this.sitePackages)) {
      pathParts.push(this.sitePackages)
    }
    if (existingPyPath) pathParts.push(existingPyPath)
    const pyPath = pathParts.join(path.delimiter)
    return {
      ...process.env,
      USERPROFILE: this.colabHome,
      HOME: this.colabHome,
      PYTHONPATH: pyPath,
      ...(this.sitePackages ? { COLAB_BRIDGE_SITE_PACKAGES: this.sitePackages } : {}),
      NO_COLOR: '1',
      CLICOLOR: '0',
      FORCE_COLOR: '0',
      COLUMNS: '200',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    }
  }

  buildCliArgs(subcommandArgs, { auth, config } = {}) {
    const args = ['-m', 'colab_shim']
    const authMode = normalizeAuthMode(auth, this.defaultAuth)
    args.push(`--auth=${authMode}`)
    const cfg = config || this.configFile
    if (cfg) {
      args.push('--config', String(cfg))
    }
    args.push(...subcommandArgs)
    return args
  }

  async runPythonProbe(code, timeoutMs = 15000) {
    return this._spawnRaw(this.pythonExe, ['-c', code], { timeoutMs })
  }

  async runCli(subcommandArgs, options = {}) {
    this._assertPythonAvailable()
    const cliArgs = this.buildCliArgs(subcommandArgs, {
      auth: options.auth,
      config: options.config,
    })
    const timeoutMs = Math.max(5000, Math.min(3900000, Number(options.timeoutMs) || 120000))
    const startedAt = Date.now()
    const raw = await this._spawnRaw(this.pythonExe, cliArgs, {
      timeoutMs,
      cwd: options.cwd,
    })
    const elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(2))
    const stdoutTrim = truncateOutput(raw.stdout, options.maxOutputChars, this.logsDir, 'stdout')
    const stderrTrim = truncateOutput(raw.stderr, options.maxOutputChars, this.logsDir, 'stderr')
    const authIssue = raw.exitCode !== 0 ? detectAuthProblem(raw.stdout, raw.stderr) : null

    return {
      ok: raw.exitCode === 0 && !raw.timedOut,
      exit_code: raw.exitCode,
      timed_out: raw.timedOut,
      elapsed_sec: elapsedSec,
      command: [path.basename(this.pythonExe), ...cliArgs],
      stdout: stdoutTrim.text,
      stderr: stderrTrim.text,
      truncated: stdoutTrim.truncated || stderrTrim.truncated,
      ...(stdoutTrim.logFile ? { stdout_log_file: stdoutTrim.logFile } : {}),
      ...(stderrTrim.logFile ? { stderr_log_file: stderrTrim.logFile } : {}),
      ...(authIssue ? authIssue : {}),
    }
  }

  writeTempScript(content, prefix = 'exec') {
    fs.mkdirSync(this.tmpDir, { recursive: true })
    const filePath = path.join(
      this.tmpDir,
      `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.py`
    )
    fs.writeFileSync(filePath, content, 'utf8')
    return filePath
  }

  removeFileQuiet(filePath) {
    if (!filePath) return
    try {
      fs.unlinkSync(filePath)
    } catch {
      // Ignore cleanup errors.
    }
  }

  submitJob({ kind, label, subcommandArgs, auth, config, timeoutMs, cleanupFiles = [] }) {
    this._assertPythonAvailable()
    fs.mkdirSync(this.jobsDir, { recursive: true })
    const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
    const logFile = path.join(this.jobsDir, `${jobId}.log`)
    const cliArgs = this.buildCliArgs(subcommandArgs, { auth, config })
    const effectiveTimeoutMs = Math.max(10000, Math.min(7200000, Number(timeoutMs) || 1800000))

    const logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })
    const job = {
      job_id: jobId,
      kind,
      label: label || kind,
      state: 'running',
      started_at: new Date().toISOString(),
      started_ms: Date.now(),
      finished_at: null,
      exit_code: null,
      timed_out: false,
      log_file: logFile,
      command: [path.basename(this.pythonExe), ...cliArgs],
      cleanup_files: cleanupFiles,
      child: null,
      timer: null,
    }

    const child = spawn(this.pythonExe, cliArgs, {
      env: this.buildSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    job.child = child
    this.activeChildren.add(child)

    const writeChunk = (chunk) => {
      const cleaned = stripAnsi(chunk.toString('utf8'))
      if (cleaned) logStream.write(cleaned)
    }
    child.stdout.on('data', writeChunk)
    child.stderr.on('data', writeChunk)

    job.timer = setTimeout(() => {
      if (job.state === 'running') {
        job.timed_out = true
        job.state = 'failed'
        logStream.write(`\n[colab-bridge] Job timed out after ${Math.round(effectiveTimeoutMs / 1000)}s.\n`)
        killChildTree(child)
      }
    }, effectiveTimeoutMs)

    const finalize = (code, errMsg) => {
      if (job.timer) {
        clearTimeout(job.timer)
        job.timer = null
      }
      this.activeChildren.delete(child)
      if (errMsg) {
        logStream.write(`\n[colab-bridge] Spawn error: ${errMsg}\n`)
      }
      job.exit_code = code
      job.finished_at = new Date().toISOString()
      if (job.state === 'running') {
        job.state = code === 0 ? 'completed' : 'failed'
      }
      job.child = null
      logStream.end()
      for (const f of job.cleanup_files) {
        this.removeFileQuiet(f)
      }
    }

    child.once('error', (err) => finalize(-1, err.message))
    child.once('close', (code) => finalize(code ?? -1, null))

    this.jobs.set(jobId, job)
    this._pruneOldJobs()

    return this._formatJobSummary(job, { tailLines: 0 })
  }

  getJobStatus(jobId, { tailLines = 80 } = {}) {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Unknown job_id '${jobId}'. Call colab_job(action="list") to inspect tracked jobs.`)
    }
    return this._formatJobSummary(job, { tailLines })
  }

  listJobs() {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.started_ms - a.started_ms)
      .map((job) => this._formatJobSummary(job, { tailLines: 0 }))
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Unknown job_id '${jobId}'.`)
    }
    if (job.state !== 'running') {
      return {
        ...this._formatJobSummary(job, { tailLines: 20 }),
        note: `Job was already in terminal state '${job.state}'.`,
      }
    }
    job.state = 'cancelled'
    if (job.timer) {
      clearTimeout(job.timer)
      job.timer = null
    }
    if (job.child) {
      killChildTree(job.child)
    }
    return {
      ...this._formatJobSummary(job, { tailLines: 20 }),
      note:
        'Local runner process terminated. If this job used a persistent session (colab_exec), the remote Colab VM ' +
        'may still be alive — call colab_session(action="status") or action="stop" if you want to free the VM.',
    }
  }

  _formatJobSummary(job, { tailLines = 0 } = {}) {
    const endMs = job.finished_at ? Date.parse(job.finished_at) : Date.now()
    const summary = {
      job_id: job.job_id,
      kind: job.kind,
      label: job.label,
      state: job.state,
      started_at: job.started_at,
      finished_at: job.finished_at,
      elapsed_sec: Number(((endMs - job.started_ms) / 1000).toFixed(2)),
      exit_code: job.exit_code,
      timed_out: job.timed_out,
      log_file: job.log_file,
    }
    if (tailLines > 0 && fs.existsSync(job.log_file)) {
      const content = fs.readFileSync(job.log_file, 'utf8')
      const lines = content.split(/\r?\n/)
      const slice = lines.slice(-Math.max(1, Math.min(400, tailLines))).join('\n')
      summary.log_total_lines = lines.length
      summary.log_tail = slice.length > 24000 ? slice.slice(-24000) : slice
      if (job.state === 'failed') {
        const authIssue = detectAuthProblem(content, '')
        if (authIssue) Object.assign(summary, authIssue)
      }
    }
    return summary
  }

  _pruneOldJobs() {
    if (this.jobs.size <= this.maxRetainedJobs) return
    const finished = Array.from(this.jobs.values())
      .filter((j) => j.state !== 'running')
      .sort((a, b) => a.started_ms - b.started_ms)
    while (this.jobs.size > this.maxRetainedJobs && finished.length > 0) {
      const victim = finished.shift()
      this.jobs.delete(victim.job_id)
    }
  }

  async doctor({ checkNetwork = true, auth } = {}) {
    const tokenPath = path.join(this.colabHome, '.config', 'colab-cli', 'token.json')
    const sessionsPath = path.join(this.colabHome, '.config', 'colab-cli', 'sessions.json')
    const shimPath = path.join(this.shimDir, 'colab_shim.py')

    let pythonOk = !looksLikePath(this.pythonExe) || fs.existsSync(this.pythonExe)
    let pythonResolved = null
    let cliVersion = null
    if (pythonOk) {
      const probe = await this.runPythonProbe(
        'import json, sys, importlib.metadata as m\n' +
          'ver = None\n' +
          'try:\n' +
          '    ver = m.version("google-colab-cli")\n' +
          'except Exception:\n' +
          '    pass\n' +
          'print(json.dumps({"exe": sys.executable, "version": ver}))',
        10000
      )
      if (probe.exitCode === 0) {
        try {
          const parsed = JSON.parse(probe.stdout.trim())
          pythonResolved = parsed.exe || null
          cliVersion = parsed.version || null
        } catch {
          pythonOk = false
        }
      } else {
        pythonOk = false
      }
    }

    const checks = {
      python_exe: this.pythonExe,
      python_resolved: pythonResolved,
      python_exists: pythonOk,
      site_packages: this.sitePackages,
      site_packages_exists: this.sitePackages ? fs.existsSync(this.sitePackages) : true,
      colab_home: this.colabHome,
      colab_home_exists: fs.existsSync(this.colabHome),
      shim_path: shimPath,
      shim_exists: fs.existsSync(shimPath),
      token_file_exists: fs.existsSync(tokenPath),
      sessions_file_exists: fs.existsSync(sessionsPath),
      default_auth: this.defaultAuth,
      data_dir: this.dataDir,
      google_colab_cli_version: cliVersion,
    }

    let whoami = null
    let sessions = null
    if (checkNetwork && checks.python_exists && checks.shim_exists && cliVersion) {
      whoami = await this.runCli(['whoami'], { auth, timeoutMs: 30000, maxOutputChars: 8000 })
      if (whoami.ok) {
        sessions = await this.runCli(['sessions'], { auth, timeoutMs: 30000, maxOutputChars: 8000 })
      }
    }

    const localReady = Boolean(checks.python_exists && checks.shim_exists && cliVersion)
    const networkReady = checkNetwork ? Boolean(whoami?.ok && sessions?.ok) : null
    return {
      ok: checkNetwork ? localReady && networkReady : localReady,
      local_ready: localReady,
      network_ready: networkReady,
      checks,
      ...(whoami ? { whoami } : {}),
      ...(sessions ? { sessions } : {}),
    }
  }

  _spawnRaw(exe, args, { timeoutMs = 120000, cwd } = {}) {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      const child = spawn(exe, args, {
        cwd: cwd || undefined,
        env: this.buildSubprocessEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.activeChildren.add(child)

      const timer = setTimeout(() => {
        timedOut = true
        killChildTree(child)
      }, timeoutMs)

      const finish = (exitCode, spawnError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.activeChildren.delete(child)
        if (spawnError) {
          stderr += (stderr ? '\n' : '') + spawnError
        }
        resolve({ exitCode, stdout, stderr, timedOut })
      }

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      child.once('error', (err) => finish(-1, err.message))
      child.once('close', (code) => finish(code ?? -1, null))
    })
  }

  async shutdown() {
    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearTimeout(job.timer)
        job.timer = null
      }
    }
    for (const child of Array.from(this.activeChildren)) {
      killChildTree(child)
    }
    this.activeChildren.clear()
  }
}
