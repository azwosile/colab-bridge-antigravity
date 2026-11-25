---
name: colab-operator
description: Operate Google Colab GPU/TPU VMs through the local colab-bridge MCP server (`colab_session`, `colab_exec`, `colab_run`, `colab_files`, `colab_install`, `colab_job`). Use when provisioning Colab runtimes, executing remote Python or bash workloads, syncing files, or offloading long-running Blender Cycles GPU renders or ML jobs to Colab.
---

# Colab Bridge Operator (`colab-bridge` MCP)

Use the `colab-bridge` MCP tools directly instead of running `colab` in shell commands — the MCP server runs locally outside the command sandbox with network access and already pins `google-colab-cli`, `colab_shim.py`, and `.colabhome` credentials.

## Tool Map

| Tool | Purpose |
|---|---|
| `colab_session` | `doctor`, `whoami`, `usage`, `sessions`, `new`, `status`, `stop`, `restart_kernel`, `url`, `log` |
| `colab_exec` | Run inline `code`, a local `file` (`.py`/`.ipynb`), or a `shell_cmd` on an active session (persistent kernel) |
| `colab_run` | One-shot ephemeral VM: provision → run local Python script → auto-stop (zero zombie billing) |
| `colab_files` | `upload`, `download`, `ls`, `rm` between local disk and `/content/...` on the Colab VM |
| `colab_install` | Install Python packages (`packages[]` or local `requirement` file) on a session |
| `colab_job` | Async background `submit` (`kind="exec"` or `"run"`), `status` (with `log_tail`), `list`, `cancel` for long jobs |

## Core Rules & Mental Model

1. **Preflight first**: Call `colab_session(action="doctor")` before provisioning if unsure whether credentials or existing sessions are healthy.
2. **Always name sessions explicitly**: Pass `session` (e.g. `"gpu-render"`, `"t4-eval"`) to `colab_session(action="new", session="...", gpu="T4")`.
3. **Never leave VMs orphaned**:
   - For self-contained single scripts, prefer `colab_run` (auto-stops on exit or error).
   - For multi-step sessions (`new` → `upload` → `exec` → `download`), **always call `colab_session(action="stop", session="...")`** as soon as artifacts are downloaded.
4. **Persistent kernel state**: Across separate `colab_exec` calls in the same session, imports, variables, and `/content` files persist until `restart_kernel` or `stop`.
5. **Shell commands without PTY hangs**: Pass bash commands via `colab_exec(session="...", shell_cmd="nvidia-smi && df -h /content")` — the bridge wraps them in streaming Python `subprocess.Popen` so stdout/stderr appear cleanly without interactive TTY issues.
6. **Long workloads (>2 min)**: Use `colab_job(action="submit", ...)` and check progress with `colab_job(action="status", job_id="...", tail_lines=60)` instead of holding a blocking `colab_exec` call.

## Offloading Blender Cycles GPU Renders to Colab

When offloading heavy Cycles renders (high-res + OIDN denoising or animation sequences) from a local Blender 5.3 project:

1. **Keep geometry/BVH/physics/compositing local** (T4 has only 2 vCPUs). Only offload pure Cycles GPU rendering.
2. **Pack a temporary render-only `.blend` copy locally** (`bpy.ops.file.pack_all()` into a temp directory) so cross-folder Windows relative textures (`//..\..\...`) become self-contained without mutating the source `.blend`.
3. **Provision & bootstrap once per session**:
   - `colab_session(action="new", session="blender-gpu", gpu="T4")` (or `L4`/`A100` on Pro).
   - Download & extract the exact matching Linux tarball via `colab_job(action="submit", kind="exec", session="blender-gpu", shell_cmd="wget -q https://download.blender.org/release/Blender5.3/blender-5.3.0-linux-x64.tar.xz && tar -xf blender-5.3.0-linux-x64.tar.xz")`.
4. **Upload bundle & render asynchronously**:
   - `colab_files(action="upload", session="blender-gpu", local_path="...", remote_path="/content/scene_packed.blend")`
   - `colab_files(action="upload", session="blender-gpu", local_path="...", remote_path="/content/render_colab.py")`
   - `colab_job(action="submit", kind="exec", session="blender-gpu", shell_cmd="/content/blender-5.3.0-linux-x64/blender -b /content/scene_packed.blend --factory-startup --python /content/render_colab.py")`
5. **Pull rendered frames & release VM**:
   - Pack multiple frames into a `.tar` or `.zip` on Colab, download with `colab_files(action="download", ...)`, verify locally, then `colab_session(action="stop", session="blender-gpu")`.

## Auth Recovery

If a tool returns `"auth_required": true`, the OAuth2 refresh token in `COLAB_BRIDGE_HOME` has expired or been revoked. Never try to prompt interactively inside the MCP server; show the user the returned `auth_url` or ask them to re-run OAuth login once in a local terminal with `HOME` set to `COLAB_BRIDGE_HOME`, then retry `colab_session(action="doctor")`.
