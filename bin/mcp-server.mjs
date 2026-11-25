#!/usr/bin/env node
/**
 * colab-bridge-antigravity — Pure Node 24 Stdio MCP Server (MCP 2025-03-26 / 2024-11-05).
 *
 * Exposes 6 cohesive tools wrapping google-colab-cli over newline-delimited JSON-RPC 2.0:
 *   1. colab_session  — doctor / whoami / usage / sessions / new / status / stop / restart_kernel / url / log
 *   2. colab_exec     — execute inline Python, local .py/.ipynb file, or bash shell_cmd on a persistent session
 *   3. colab_run      — one-shot ephemeral VM run (new -> run script -> auto stop)
 *   4. colab_files    — upload / download / ls / rm files on a session
 *   5. colab_install  — install Python packages on a session VM
 *   6. colab_job      — submit / status / list / cancel long-running async Colab jobs (e.g. Blender batch renders)
 *
 * CRITICAL STDIO INVARIANT:
 *   stdout is strictly reserved for newline-delimited JSON-RPC 2.0 messages.
 *   All diagnostics go to stderr.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ColabRunner,
  VALID_AUTH_MODES,
  VALID_GPUS,
  VALID_TPUS,
  buildEnvFlags,
  buildShellWrapperPython,
  logErr,
  normalizeAuthMode,
  validateAccelerator,
  validateSessionName,
} from './colab-runner.mjs'

export const SERVER_INFO = Object.freeze({
  name: 'colab-bridge-antigravity',
  version: '0.1.0',
})

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-03-26', '2024-11-05'])

export const TOOL_DEFINITIONS = [
  {
    name: 'colab_session',
    description:
      'Manage Google Colab VM sessions and account diagnostics. Supports doctor (local + auth health check), whoami, usage, sessions, new (provision CPU/GPU/TPU VM), status, stop (release VM to stop billing), restart_kernel, url, and log. Always pass an explicit session name for new/stop and remember to stop sessions when done.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'doctor',
            'whoami',
            'usage',
            'sessions',
            'new',
            'status',
            'stop',
            'restart_kernel',
            'url',
            'log',
          ],
          description: 'Session or diagnostic action to perform.',
        },
        session: {
          type: 'string',
          description: 'Explicit session name (required for new, stop, restart_kernel, url; optional for status, log).',
        },
        gpu: {
          type: 'string',
          enum: [...VALID_GPUS],
          description: 'GPU accelerator for action="new" (T4, L4, G4, A100, H100). Mutually exclusive with tpu.',
        },
        tpu: {
          type: 'string',
          enum: [...VALID_TPUS],
          description: 'TPU accelerator for action="new" (v5e1, v6e1). Mutually exclusive with gpu.',
        },
        high_mem: {
          type: 'boolean',
          description: 'Request a high-memory VM shape for action="new".',
        },
        check_network: {
          type: 'boolean',
          description: 'For action="doctor", also run live whoami + sessions checks against Google Colab (default true).',
        },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'For action="log", max number of recent events to return.',
        },
        log_type: {
          type: 'string',
          description: 'For action="log", filter events by type (e.g. execution, file_operation).',
        },
        output_path: {
          type: 'string',
          description: 'For action="log", export session history to a local file (.ipynb, .md, .txt, .jsonl).',
        },
        auth: {
          type: 'string',
          enum: [...VALID_AUTH_MODES],
          description: 'Override CLI auth mode (default configured by COLAB_BRIDGE_AUTH, typically oauth2).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_exec',
    description:
      'Execute Python code, a local .py/.ipynb file, or a bash shell_cmd on an active Colab session. Kernel state persists across calls in the same session. Provide exactly one of code, file, or shell_cmd. For long renders/downloads (>2 min), prefer colab_job(action="submit") so tool calls do not block.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['session'],
      properties: {
        session: {
          type: 'string',
          description: 'Active Colab session name.',
        },
        code: {
          type: 'string',
          description: 'Inline Python code to run in the session kernel.',
        },
        file: {
          type: 'string',
          description: 'Local path to a .py or .ipynb file to execute on the session.',
        },
        shell_cmd: {
          type: 'string',
          description:
            'Bash command to run on the Colab VM (wrapped cleanly in Python subprocess streaming stdout/stderr with zero PTY artifacts).',
        },
        cwd: {
          type: 'string',
          description: 'Remote working directory for shell_cmd (default "/content").',
        },
        timeout: {
          type: 'number',
          minimum: 5,
          maximum: 3600,
          description: 'Execution timeout in seconds (default 300).',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional environment variables injected for this execution.',
        },
        output_image: {
          type: 'string',
          description: 'Optional local file path to save intercepted matplotlib/PIL image output.',
        },
        max_output_chars: {
          type: 'integer',
          minimum: 1024,
          maximum: 200000,
          description: 'Cap returned stdout/stderr characters (default 24000; full output saved to disk if exceeded).',
        },
        auth: {
          type: 'string',
          enum: [...VALID_AUTH_MODES],
          description: 'Optional auth mode override.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_run',
    description:
      'Run a local Python script on a fresh ephemeral Colab VM and automatically release the VM on exit (new + exec + stop in one call). Ideal for self-contained one-shot GPU jobs without risking forgotten running VMs.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['script'],
      properties: {
        script: {
          type: 'string',
          description: 'Absolute or relative local path to the Python script to run.',
        },
        script_args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional CLI arguments passed to the script as sys.argv[1:].',
        },
        session: {
          type: 'string',
          description: 'Optional explicit session name.',
        },
        gpu: {
          type: 'string',
          enum: [...VALID_GPUS],
          description: 'GPU accelerator (T4, L4, G4, A100, H100). Mutually exclusive with tpu.',
        },
        tpu: {
          type: 'string',
          enum: [...VALID_TPUS],
          description: 'TPU accelerator (v5e1, v6e1). Mutually exclusive with gpu.',
        },
        high_mem: {
          type: 'boolean',
          description: 'Request a high-memory VM shape.',
        },
        keep: {
          type: 'boolean',
          description: 'Keep the VM alive after the script finishes (default false; auto-stops VM).',
        },
        timeout: {
          type: 'number',
          minimum: 5,
          maximum: 3600,
          description: 'Execution timeout in seconds (default 600).',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional environment variables injected into the remote execution.',
        },
        max_output_chars: {
          type: 'integer',
          minimum: 1024,
          maximum: 200000,
          description: 'Cap returned stdout/stderr characters (default 24000).',
        },
        auth: {
          type: 'string',
          enum: [...VALID_AUTH_MODES],
          description: 'Optional auth mode override.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_files',
    description:
      'Transfer or inspect files on an active Colab session: upload local file -> remote VM, download remote VM -> local file (auto-creating local parent directories), ls remote directory, or rm remote file.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['action', 'session'],
      properties: {
        action: {
          type: 'string',
          enum: ['upload', 'download', 'ls', 'rm'],
          description: 'File operation to perform.',
        },
        session: {
          type: 'string',
          description: 'Active Colab session name.',
        },
        local_path: {
          type: 'string',
          description: 'Local file path (required for upload and download).',
        },
        remote_path: {
          type: 'string',
          description: 'Remote path on the Colab VM (e.g. "/content/scene.blend"). Required for upload/download/rm; defaults to "content" for ls.',
        },
        timeout: {
          type: 'number',
          minimum: 10,
          maximum: 1800,
          description: 'Transfer timeout in seconds (default 300).',
        },
        auth: {
          type: 'string',
          enum: [...VALID_AUTH_MODES],
          description: 'Optional auth mode override.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_install',
    description:
      'Install Python packages onto a running Colab VM using colab-cli install (uv pip / pip). Provide packages and/or a local requirement file path.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['session'],
      properties: {
        session: {
          type: 'string',
          description: 'Active Colab session name.',
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of package specifiers to install (e.g. ["pillow", "numpy>=2.0"]).',
        },
        requirement: {
          type: 'string',
          description: 'Optional local requirements.txt file path.',
        },
        timeout: {
          type: 'number',
          minimum: 15,
          maximum: 1800,
          description: 'Install timeout in seconds (default 600).',
        },
        auth: {
          type: 'string',
          enum: [...VALID_AUTH_MODES],
          description: 'Optional auth mode override.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_job',
    description:
      'Manage asynchronous long-running Colab tasks (such as Blender Cycles batch renders, large downloads, or training loops) without blocking MCP turns. Supports submit (kind="exec" or "run"), status (with log_tail), list, and cancel.',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'status', 'list', 'cancel'],
          description: 'Async job action.',
        },
        job_id: {
          type: 'string',
          description: 'Job identifier returned by submit (required for status and cancel).',
        },
        tail_lines: {
          type: 'integer',
          minimum: 1,
          maximum: 400,
          description: 'For action="status", number of trailing log lines to include (default 80).',
        },
        kind: {
          type: 'string',
          enum: ['exec', 'run'],
          description: 'For action="submit": "exec" runs on an existing session; "run" provisions an ephemeral VM and stops it when done.',
        },
        label: {
          type: 'string',
          description: 'Optional human-readable label for action="submit".',
        },
        session: {
          type: 'string',
          description: 'Session name (required for kind="exec", optional for kind="run").',
        },
        code: {
          type: 'string',
          description: 'For kind="exec": inline Python code.',
        },
        file: {
          type: 'string',
          description: 'For kind="exec": local .py/.ipynb file path.',
        },
        shell_cmd: {
          type: 'string',
          description: 'For kind="exec": bash command to execute on the Colab VM.',
        },
        cwd: {
          type: 'string',
          description: 'Remote working directory for shell_cmd (default "/content").',
        },
        script: {
          type: 'string',
          description: 'For kind="run": local Python script path.',
        },
        script_args: {
          type: 'array',
          items: { type: 'string' },
          description: 'For kind="run": script arguments.',
        },
        gpu: {
          type: 'string',
          enum: [...VALID_GPUS],
          description: 'For kind="run": GPU accelerator.',
        },
        tpu: {
          type: 'string',
          enum: [...VALID_TPUS],
          description: 'For kind="run": TPU accelerator.',
        },
        high_mem: {
          type: 'boolean',
          description: 'For kind="run": high-memory VM flag.',
        },
        keep: {
          type: 'boolean',
          description: 'For kind="run": keep VM after script finishes (default false).',
        },
        timeout: {
          type: 'number',
          minimum: 10,
          maximum: 7200,
          description: 'Timeout in seconds (default 1800).',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional environment variables.',
        },
        auth: {
          type: 'string',
          enum: [...VALID_AUTH_MODES],
          description: 'Optional auth mode override.',
        },
      },
      additionalProperties: false,
    },
  },
]

function asToolSuccess(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: payload && payload.ok === false,
  }
}

function asToolError(message, details = null) {
  const payload = { ok: false, error: message, ...(details ? { details } : {}) }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  }
}

function prepareExecArgs(runner, args, defaultTimeoutSec) {
  const session = validateSessionName(args.session, { required: true })
  const providedModes = [
    args.code !== undefined && args.code !== null ? 'code' : null,
    args.file !== undefined && args.file !== null ? 'file' : null,
    args.shell_cmd !== undefined && args.shell_cmd !== null ? 'shell_cmd' : null,
  ].filter(Boolean)

  if (providedModes.length !== 1) {
    throw new Error('Provide exactly one of code, file, or shell_cmd.')
  }

  const timeoutSec = Math.max(5, Math.min(7200, Number(args.timeout) || defaultTimeoutSec))
  const cliSub = ['exec', '-s', session, '--timeout', String(timeoutSec)]
  cliSub.push(...buildEnvFlags(args.env))

  if (args.output_image) {
    const outImg = path.resolve(String(args.output_image))
    fs.mkdirSync(path.dirname(outImg), { recursive: true })
    cliSub.push('--output-image', outImg)
  }

  const cleanupFiles = []
  if (args.file) {
    const localFile = path.resolve(String(args.file))
    if (!fs.existsSync(localFile)) {
      throw new Error(`Local file does not exist: ${localFile}`)
    }
    cliSub.push('-f', localFile)
  } else if (args.code !== undefined && args.code !== null) {
    const tmpFile = runner.writeTempScript(String(args.code), 'code')
    cleanupFiles.push(tmpFile)
    cliSub.push('-f', tmpFile)
  } else {
    const wrapper = buildShellWrapperPython(args.shell_cmd, args.cwd || '/content')
    const tmpFile = runner.writeTempScript(wrapper, 'shell')
    cleanupFiles.push(tmpFile)
    cliSub.push('-f', tmpFile)
  }

  return { cliSub, timeoutSec, cleanupFiles, session }
}

function prepareRunArgs(args, defaultTimeoutSec) {
  if (!args.script) {
    throw new Error('Missing required parameter: script.')
  }
  const scriptPath = path.resolve(String(args.script))
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Local script does not exist: ${scriptPath}`)
  }
  const { gpu, tpu } = validateAccelerator({ gpu: args.gpu, tpu: args.tpu })
  const session = validateSessionName(args.session, { required: false })
  const timeoutSec = Math.max(5, Math.min(7200, Number(args.timeout) || defaultTimeoutSec))

  const cliSub = ['run', '--timeout', String(timeoutSec)]
  if (session) cliSub.push('-s', session)
  if (gpu) cliSub.push('--gpu', gpu)
  if (tpu) cliSub.push('--tpu', tpu)
  if (args.high_mem) cliSub.push('--high-mem')
  if (args.keep) cliSub.push('--keep')
  cliSub.push(...buildEnvFlags(args.env))
  cliSub.push(scriptPath)
  if (Array.isArray(args.script_args) && args.script_args.length > 0) {
    cliSub.push(...args.script_args.map(String))
  }
  return { cliSub, timeoutSec, scriptPath }
}

export function createMcpServer(options = {}) {
  const runner = options.runner || new ColabRunner(options)

  async function callTool(name, rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
    try {
      const auth = args.auth ? normalizeAuthMode(args.auth) : undefined

      if (name === 'colab_session') {
        const action = String(args.action || '').trim()
        if (action === 'doctor') {
          const checkNetwork = args.check_network !== false
          const res = await runner.doctor({ checkNetwork, auth })
          return asToolSuccess(res)
        }
        if (action === 'whoami' || action === 'usage' || action === 'sessions') {
          const res = await runner.runCli([action], { auth, timeoutMs: 45000 })
          return asToolSuccess(res)
        }
        if (action === 'new') {
          const session = validateSessionName(args.session, { required: true })
          const { gpu, tpu } = validateAccelerator({ gpu: args.gpu, tpu: args.tpu })
          const cliSub = ['new', '-s', session]
          if (gpu) cliSub.push('--gpu', gpu)
          if (tpu) cliSub.push('--tpu', tpu)
          if (args.high_mem) cliSub.push('--high-mem')
          const res = await runner.runCli(cliSub, { auth, timeoutMs: 180000 })
          return asToolSuccess({ ...res, session, gpu, tpu })
        }
        if (action === 'status') {
          const session = validateSessionName(args.session, { required: false })
          const cliSub = session ? ['status', '-s', session] : ['status']
          const res = await runner.runCli(cliSub, { auth, timeoutMs: 45000 })
          return asToolSuccess(res)
        }
        if (action === 'stop') {
          const session = validateSessionName(args.session, { required: true })
          const res = await runner.runCli(['stop', '-s', session], { auth, timeoutMs: 60000 })
          return asToolSuccess({ ...res, session })
        }
        if (action === 'restart_kernel') {
          const session = validateSessionName(args.session, { required: true })
          const res = await runner.runCli(['restart-kernel', '-s', session], { auth, timeoutMs: 90000 })
          return asToolSuccess({ ...res, session })
        }
        if (action === 'url') {
          const session = validateSessionName(args.session, { required: true })
          const res = await runner.runCli(['url', '-s', session], { auth, timeoutMs: 30000 })
          return asToolSuccess({ ...res, session })
        }
        if (action === 'log') {
          const session = validateSessionName(args.session, { required: false })
          const cliSub = ['log']
          if (session) cliSub.push('-s', session)
          if (args.lines !== undefined && args.lines !== null) cliSub.push('-n', String(args.lines))
          if (args.log_type) cliSub.push('-t', String(args.log_type))
          if (args.output_path) {
            const out = path.resolve(String(args.output_path))
            fs.mkdirSync(path.dirname(out), { recursive: true })
            cliSub.push('-o', out)
          }
          const res = await runner.runCli(cliSub, { auth, timeoutMs: 30000 })
          return asToolSuccess(res)
        }
        return asToolError(`Unsupported colab_session action: '${action}'.`)
      }

      if (name === 'colab_exec') {
        const { cliSub, timeoutSec, cleanupFiles, session } = prepareExecArgs(runner, args, 300)
        try {
          const res = await runner.runCli(cliSub, {
            auth,
            timeoutMs: (timeoutSec + 30) * 1000,
            maxOutputChars: args.max_output_chars,
          })
          return asToolSuccess({ ...res, session })
        } finally {
          for (const f of cleanupFiles) runner.removeFileQuiet(f)
        }
      }

      if (name === 'colab_run') {
        const { cliSub, timeoutSec, scriptPath } = prepareRunArgs(args, 600)
        const res = await runner.runCli(cliSub, {
          auth,
          timeoutMs: (timeoutSec + 120) * 1000,
          maxOutputChars: args.max_output_chars,
        })
        return asToolSuccess({ ...res, script: scriptPath })
      }

      if (name === 'colab_files') {
        const action = String(args.action || '').trim()
        const session = validateSessionName(args.session, { required: true })
        const timeoutMs = (Math.max(10, Math.min(1800, Number(args.timeout) || 300)) + 15) * 1000

        if (action === 'upload') {
          if (!args.local_path || !args.remote_path) {
            throw new Error('upload requires both local_path and remote_path.')
          }
          const localPath = path.resolve(String(args.local_path))
          if (!fs.existsSync(localPath)) {
            throw new Error(`Local upload file not found: ${localPath}`)
          }
          const stat = fs.statSync(localPath)
          if (!stat.isFile()) {
            throw new Error(`Local upload path is not a regular file: ${localPath}`)
          }
          const res = await runner.runCli(['upload', '-s', session, localPath, String(args.remote_path)], {
            auth,
            timeoutMs,
          })
          return asToolSuccess({
            ...res,
            session,
            local_path: localPath,
            remote_path: String(args.remote_path),
            bytes: stat.size,
          })
        }

        if (action === 'download') {
          if (!args.local_path || !args.remote_path) {
            throw new Error('download requires both remote_path and local_path.')
          }
          const localPath = path.resolve(String(args.local_path))
          fs.mkdirSync(path.dirname(localPath), { recursive: true })
          const res = await runner.runCli(['download', '-s', session, String(args.remote_path), localPath], {
            auth,
            timeoutMs,
          })
          const bytes = fs.existsSync(localPath) ? fs.statSync(localPath).size : null
          return asToolSuccess({
            ...res,
            session,
            remote_path: String(args.remote_path),
            local_path: localPath,
            bytes,
          })
        }

        if (action === 'ls') {
          const remotePath = args.remote_path ? String(args.remote_path) : 'content'
          const res = await runner.runCli(['ls', '-s', session, remotePath], { auth, timeoutMs })
          return asToolSuccess({ ...res, session, remote_path: remotePath })
        }

        if (action === 'rm') {
          if (!args.remote_path) {
            throw new Error('rm requires remote_path.')
          }
          const res = await runner.runCli(['rm', '-s', session, String(args.remote_path)], { auth, timeoutMs })
          return asToolSuccess({ ...res, session, remote_path: String(args.remote_path) })
        }

        return asToolError(`Unsupported colab_files action: '${action}'.`)
      }

      if (name === 'colab_install') {
        const session = validateSessionName(args.session, { required: true })
        const pkgs = Array.isArray(args.packages) ? args.packages.map(String).filter(Boolean) : []
        const reqPath = args.requirement ? path.resolve(String(args.requirement)) : null
        if (pkgs.length === 0 && !reqPath) {
          throw new Error('Provide at least one package in packages[] or a local requirement file path.')
        }
        if (reqPath && !fs.existsSync(reqPath)) {
          throw new Error(`Requirement file not found: ${reqPath}`)
        }
        const cliSub = ['install', '-s', session]
        if (reqPath) cliSub.push('-r', reqPath)
        cliSub.push(...pkgs)
        const timeoutMs = (Math.max(15, Math.min(1800, Number(args.timeout) || 600)) + 30) * 1000
        const res = await runner.runCli(cliSub, { auth, timeoutMs })
        return asToolSuccess({ ...res, session, packages: pkgs, requirement: reqPath })
      }

      if (name === 'colab_job') {
        const action = String(args.action || '').trim()
        if (action === 'list') {
          return asToolSuccess({ ok: true, jobs: runner.listJobs() })
        }
        if (action === 'status') {
          if (!args.job_id) throw new Error('status requires job_id.')
          const status = runner.getJobStatus(String(args.job_id), {
            tailLines: Number(args.tail_lines) || 80,
          })
          return asToolSuccess({ ok: true, ...status })
        }
        if (action === 'cancel') {
          if (!args.job_id) throw new Error('cancel requires job_id.')
          const cancelled = runner.cancelJob(String(args.job_id))
          return asToolSuccess({ ok: true, ...cancelled })
        }
        if (action === 'submit') {
          const kind = String(args.kind || 'exec').trim()
          if (kind === 'exec') {
            const { cliSub, timeoutSec, cleanupFiles, session } = prepareExecArgs(runner, args, 1800)
            const job = runner.submitJob({
              kind: 'exec',
              label: args.label || `exec:${session}`,
              subcommandArgs: cliSub,
              auth,
              timeoutMs: (timeoutSec + 60) * 1000,
              cleanupFiles,
            })
            return asToolSuccess({ ok: true, ...job })
          }
          if (kind === 'run') {
            const { cliSub, timeoutSec, scriptPath } = prepareRunArgs(args, 1800)
            const job = runner.submitJob({
              kind: 'run',
              label: args.label || `run:${path.basename(scriptPath)}`,
              subcommandArgs: cliSub,
              auth,
              timeoutMs: (timeoutSec + 120) * 1000,
            })
            return asToolSuccess({ ok: true, ...job })
          }
          throw new Error(`Unsupported colab_job submit kind '${kind}'. Expected 'exec' or 'run'.`)
        }
        return asToolError(`Unsupported colab_job action: '${action}'.`)
      }

      return asToolError(`Unknown tool: '${name}'.`)
    } catch (err) {
      return asToolError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleJsonRpc(msg) {
    if (!msg || typeof msg !== 'object') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      }
    }

    const { id, method, params } = msg
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id')

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null
    }

    if (method === 'initialize') {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0]
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      }
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOL_DEFINITIONS },
      }
    }

    if (method === 'tools/call') {
      const toolName = params?.name
      const toolArgs = params?.arguments || {}
      if (!toolName || typeof toolName !== 'string') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing tools/call params.name' },
        }
      }
      const result = await callTool(toolName, toolArgs)
      return { jsonrpc: '2.0', id, result }
    }

    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    }

    if (method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    }

    if (!hasId) return null

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }
  }

  return {
    runner,
    callTool,
    handleJsonRpc,
    shutdown: () => runner.shutdown(),
  }
}

export function startStdioServer(options = {}) {
  console.log = (...args) => logErr(args.map(String).join(' '))

  const server = createMcpServer(options)
  let buffer = ''
  let shuttingDown = false
  let inFlight = 0
  let stdinEnded = false

  function writeMessage(msg) {
    if (!msg) return
    try {
      process.stdout.write(`${JSON.stringify(msg)}\n`)
    } catch (err) {
      logErr(`stdout write error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function shutdownAndExit(code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    process.exitCode = code
    try {
      process.stdin.pause()
    } catch {
      // Ignore.
    }
    try {
      await server.shutdown()
    } catch (err) {
      logErr(`shutdown error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    process.exit(code)
  }

  function maybeExitOnDrain() {
    if (stdinEnded && inFlight === 0) {
      void shutdownAndExit(0)
    }
  }

  function processLine(rawLine) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line) return
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
      return
    }

    inFlight += 1
    server
      .handleJsonRpc(parsed)
      .then((response) => {
        if (response !== null) writeMessage(response)
      })
      .catch((err) => {
        if (Object.prototype.hasOwnProperty.call(parsed || {}, 'id')) {
          writeMessage({
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32603,
              message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
            },
          })
        }
      })
      .finally(() => {
        inFlight -= 1
        maybeExitOnDrain()
      })
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      processLine(line)
      idx = buffer.indexOf('\n')
    }
  })

  process.stdin.on('end', () => {
    if (buffer.trim()) {
      processLine(buffer)
      buffer = ''
    }
    stdinEnded = true
    maybeExitOnDrain()
  })

  process.stdin.on('error', () => {
    stdinEnded = true
    maybeExitOnDrain()
  })

  process.once('SIGINT', () => {
    void shutdownAndExit(0)
  })
  process.once('SIGTERM', () => {
    void shutdownAndExit(0)
  })

  return server
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectEntry) {
  startStdioServer()
}
