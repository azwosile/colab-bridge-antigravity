#!/usr/bin/env node
/**
 * Standalone live diagnostics for colab-bridge-antigravity.
 * Spawns bin/mcp-server.mjs over real Stdio JSON-RPC 2.0 and executes
 * colab_session(action="doctor", check_network=true) plus optional usage check.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(__dirname, '..', 'bin', 'mcp-server.mjs')
const checkNetwork = !process.argv.includes('--offline')

const child = spawn(process.execPath, [serverEntry], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
let stderr = ''
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => {
  stderr += d
})
child.stdout.on('data', (chunk) => {
  buf += chunk
  let idx = buf.indexOf('\n')
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line) {
      const msg = JSON.parse(line)
      if (pending.has(msg.id)) {
        const resolve = pending.get(msg.id)
        pending.delete(msg.id)
        resolve(msg)
      }
    }
    idx = buf.indexOf('\n')
  }
})

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout on ${method}`)), 60000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
  })
}

try {
  await rpc(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'colab-bridge-doctor', version: '0.1.0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const toolsResp = await rpc(2, 'tools/list')
  const docResp = await rpc(3, 'tools/call', {
    name: 'colab_session',
    arguments: { action: 'doctor', check_network: checkNetwork },
  })
  const payload = JSON.parse(docResp.result.content[0].text)
  console.log(
    JSON.stringify(
      {
        tools: toolsResp.result.tools.map((t) => t.name),
        doctor: payload,
      },
      null,
      2
    )
  )
  child.stdin.end()
  const code = await new Promise((resolve) => child.once('close', resolve))
  if (code !== 0 || !payload.ok) {
    if (stderr) console.error(stderr)
    process.exit(1)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  if (stderr) console.error(stderr)
  child.kill()
  process.exit(1)
}
