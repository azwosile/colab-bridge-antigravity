import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ColabRunner,
  buildEnvFlags,
  buildShellWrapperPython,
  detectAuthProblem,
  normalizeAuthMode,
  stripAnsi,
  truncateOutput,
  validateAccelerator,
  validateSessionName,
} from '../bin/colab-runner.mjs'
import { SERVER_INFO, TOOL_DEFINITIONS, createMcpServer } from '../bin/mcp-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')
const SERVER_ENTRY = path.join(PLUGIN_ROOT, 'bin', 'mcp-server.mjs')

function parseToolPayload(res) {
  assert.ok(res && Array.isArray(res.content) && res.content[0]?.type === 'text')
  return JSON.parse(res.content[0].text)
}

describe('colab-runner helpers', () => {
  it('validates session names and accelerators strictly', () => {
    assert.equal(validateSessionName('gpu-render_01'), 'gpu-render_01')
    assert.equal(validateSessionName(undefined, { required: false }), null)
    assert.throws(() => validateSessionName('', { required: true }), /Missing required parameter: session/)
    assert.throws(() => validateSessionName('bad name with space'), /Invalid session name/)

    assert.deepEqual(validateAccelerator({ gpu: 't4' }), { gpu: 'T4', tpu: null })
    assert.deepEqual(validateAccelerator({ tpu: 'V5E1' }), { gpu: null, tpu: 'v5e1' })
    assert.throws(() => validateAccelerator({ gpu: 'T4', tpu: 'v5e1' }), /at most one/)
    assert.throws(() => validateAccelerator({ gpu: 'RTX4090' }), /Unsupported gpu/)
    assert.throws(() => validateAccelerator({ tpu: 'v99' }), /Unsupported tpu/)

    assert.equal(normalizeAuthMode('ADC'), 'adc')
    assert.throws(() => normalizeAuthMode('magic'), /Invalid auth mode/)
  })

  it('builds env flags, shell wrapper, ANSI stripper, truncation, and auth detector', () => {
    assert.deepEqual(buildEnvFlags({ FOO: '1', BAR_2: 'hello' }), ['--env', 'FOO=1', '--env', 'BAR_2=hello'])
    assert.throws(() => buildEnvFlags({ 'BAD-KEY': '1' }), /Invalid environment variable/)

    const wrapper = buildShellWrapperPython('nvidia-smi && echo "ok"', '/content/work')
    assert.match(wrapper, /subprocess\.Popen/)
    assert.match(wrapper, /nvidia-smi/)
    assert.match(wrapper, /\/content\/work/)

    assert.equal(stripAnsi('\x1b[32mOK\x1b[0m\n'), 'OK\n')

    const tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-trunc-'))
    try {
      const longText = 'A'.repeat(2500) + 'B'.repeat(2500)
      const res = truncateOutput(longText, 1200, tmpLogs, 'test')
      assert.equal(res.truncated, true)
      assert.equal(res.totalChars, 5000)
      assert.ok(res.logFile && fs.existsSync(res.logFile))
      assert.equal(fs.readFileSync(res.logFile, 'utf8'), longText)
    } finally {
      fs.rmSync(tmpLogs, { recursive: true, force: true })
    }

    const authDetected = detectAuthProblem(
      '',
      'To authorize colab-cli, visit:\n  https://accounts.google.com/o/oauth2/auth?client_id=123\nEOFError'
    )
    assert.equal(authDetected?.auth_required, true)
    assert.match(authDetected?.auth_url || '', /^https:\/\/accounts\.google\.com\/o\/oauth2/)
    assert.equal(detectAuthProblem('normal stdout', ''), null)
  })
})

describe('MCP tool routing with mock runner', () => {
  it('routes colab_session, colab_exec, colab_run, colab_files, colab_install accurately', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-mock-'))
    const calls = []
    const realRunner = new ColabRunner({ dataDir: tmpDir })
    const mockRunner = {
      writeTempScript: (c, p) => realRunner.writeTempScript(c, p),
      removeFileQuiet: (f) => realRunner.removeFileQuiet(f),
      runCli: async (subArgs, opts) => {
        calls.push({ subArgs, opts })
        if (subArgs[0] === 'download') {
          fs.writeFileSync(subArgs[4], 'downloaded-bytes', 'utf8')
        }
        return { ok: true, exit_code: 0, stdout: 'ok', stderr: '', elapsed_sec: 0.1 }
      },
      doctor: async (opts) => ({ ok: true, local_ready: true, network_ready: opts.checkNetwork }),
      shutdown: async () => {},
    }

    const server = createMcpServer({ runner: mockRunner })
    try {
      // 1. colab_session new
      let r = await server.callTool('colab_session', { action: 'new', session: 'b53', gpu: 'T4', high_mem: true })
      assert.equal(r.isError, false)
      assert.deepEqual(calls.at(-1).subArgs, ['new', '-s', 'b53', '--gpu', 'T4', '--high-mem'])

      // 2. colab_exec inline code -> creates temp script, runs -f, then deletes temp script
      r = await server.callTool('colab_exec', { session: 'b53', code: 'print(123)', timeout: 60, env: { X: '9' } })
      assert.equal(r.isError, false)
      const execCall = calls.at(-1).subArgs
      assert.equal(execCall[0], 'exec')
      assert.ok(execCall.includes('--env'))
      assert.ok(execCall.includes('X=9'))
      const tmpScriptPath = execCall[execCall.indexOf('-f') + 1]
      assert.equal(fs.existsSync(tmpScriptPath), false, 'Temp script must be removed after exec')

      // 3. colab_exec validation: reject 0 or 2 modes
      r = await server.callTool('colab_exec', { session: 'b53', code: '1', shell_cmd: 'echo 1' })
      assert.equal(r.isError, true)
      assert.match(parseToolPayload(r).error, /exactly one/)

      // 4. colab_files upload & download
      const upFile = path.join(tmpDir, 'scene.blend')
      fs.writeFileSync(upFile, 'blend-data', 'utf8')
      r = await server.callTool('colab_files', {
        action: 'upload',
        session: 'b53',
        local_path: upFile,
        remote_path: '/content/scene.blend',
      })
      assert.equal(r.isError, false)
      assert.equal(parseToolPayload(r).bytes, 10)
      assert.deepEqual(calls.at(-1).subArgs, ['upload', '-s', 'b53', upFile, '/content/scene.blend'])

      const dlFile = path.join(tmpDir, 'nested', 'out', 'frame.png')
      r = await server.callTool('colab_files', {
        action: 'download',
        session: 'b53',
        remote_path: '/content/frame.png',
        local_path: dlFile,
      })
      assert.equal(r.isError, false)
      assert.equal(parseToolPayload(r).bytes, 16)
      assert.equal(fs.existsSync(dlFile), true)

      // 5. colab_run
      const pyScript = path.join(tmpDir, 'job.py')
      fs.writeFileSync(pyScript, 'print("hi")\n', 'utf8')
      r = await server.callTool('colab_run', {
        script: pyScript,
        script_args: ['--frames', '10'],
        gpu: 'L4',
      })
      assert.equal(r.isError, false)
      assert.deepEqual(calls.at(-1).subArgs, ['run', '--timeout', '600', '--gpu', 'L4', pyScript, '--frames', '10'])

      // 6. colab_install
      r = await server.callTool('colab_install', { session: 'b53', packages: ['pillow', 'tqdm'] })
      assert.equal(r.isError, false)
      assert.deepEqual(calls.at(-1).subArgs, ['install', '-s', 'b53', 'pillow', 'tqdm'])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('executes async colab_job lifecycle cleanly with a stub shim', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-job-'))
    const shimDir = path.join(tmpDir, 'shim')
    fs.mkdirSync(shimDir, { recursive: true })
    fs.writeFileSync(
      path.join(shimDir, 'colab_shim.py'),
      'import sys, time\nprint("stub-args:", " ".join(sys.argv[1:]), flush=True)\ntime.sleep(0.15)\nprint("stub-done", flush=True)\n',
      'utf8'
    )
    const runner = new ColabRunner({
      colabHome: tmpDir,
      shimDir,
      dataDir: path.join(tmpDir, 'data'),
    })
    const server = createMcpServer({ runner })
    try {
      const subRes = await server.callTool('colab_job', {
        action: 'submit',
        kind: 'exec',
        session: 'async1',
        code: 'print("hello")',
        label: 'unit-async',
      })
      const submitted = parseToolPayload(subRes)
      assert.equal(submitted.ok, true)
      assert.equal(submitted.state, 'running')
      assert.ok(submitted.job_id)

      let status = null
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100))
        const stRes = await server.callTool('colab_job', { action: 'status', job_id: submitted.job_id })
        status = parseToolPayload(stRes)
        if (status.state !== 'running') break
      }
      assert.equal(status.state, 'completed')
      assert.equal(status.exit_code, 0)
      assert.match(status.log_tail, /stub-done/)

      const listRes = parseToolPayload(await server.callTool('colab_job', { action: 'list' }))
      assert.equal(listRes.jobs.length, 1)
      assert.equal(listRes.jobs[0].job_id, submitted.job_id)
    } finally {
      await server.shutdown()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Stdio JSON-RPC 2.0 end-to-end integration', () => {
  it('handles initialize, ping, tools/list, local doctor (real colab-cli 0.7.5), and clean EOF exit', async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...process.env,
        COLAB_BRIDGE_DATA_DIR: path.join(os.tmpdir(), 'colab-bridge-test-e2e'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const responses = []
    let stdoutBuf = ''
    let stderrBuf = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      stderrBuf += d
    })

    const waiters = new Map()
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk
      let idx = stdoutBuf.indexOf('\n')
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (line) {
          const msg = JSON.parse(line)
          responses.push(msg)
          if (waiters.has(msg.id)) {
            const resolve = waiters.get(msg.id)
            waiters.delete(msg.id)
            resolve(msg)
          }
        }
        idx = stdoutBuf.indexOf('\n')
      }
    })

    function rpc(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for rpc id=${id} (${method})`)), 15000)
        waiters.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      })
    }

    const init = await rpc(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'unit-test', version: '1.0' },
    })
    assert.equal(init.result.protocolVersion, '2025-03-26')
    assert.deepEqual(init.result.serverInfo, SERVER_INFO)

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const ping = await rpc(2, 'ping')
    assert.deepEqual(ping.result, {})

    const tools = await rpc(3, 'tools/list')
    assert.equal(tools.result.tools.length, TOOL_DEFINITIONS.length)
    assert.deepEqual(
      tools.result.tools.map((t) => t.name),
      ['colab_session', 'colab_exec', 'colab_run', 'colab_files', 'colab_install', 'colab_job']
    )

    const doctorResp = await rpc(4, 'tools/call', {
      name: 'colab_session',
      arguments: { action: 'doctor', check_network: false },
    })
    const doc = parseToolPayload(doctorResp.result)
    assert.equal(doc.checks.shim_exists, true)
    assert.equal(doc.checks.python_exists, true)
    if (doc.checks.google_colab_cli_version) {
      assert.equal(doctorResp.result.isError, false)
      assert.equal(doc.ok, true)
      assert.equal(doc.local_ready, true)
    }

    const exitCode = await new Promise((resolve) => {
      child.once('close', resolve)
      child.stdin.end()
    })
    assert.equal(exitCode, 0, `Expected clean exit 0; stderr=${stderrBuf}`)
  })
})
