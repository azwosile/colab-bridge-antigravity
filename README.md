# colab-bridge-antigravity

Lightweight, zero-dependency Node.js Stdio MCP plugin for **Antigravity** that wraps [`google-colab-cli`](https://github.com/googlecolab/google-colab-cli) into 6 structured MCP tools — built to work smoothly on native **Windows**, macOS, and Linux without WSL.

## Highlights

- **Zero shell sandbox friction**: Runs as a local Antigravity Stdio MCP server with direct host network access (no per-command approval popups or WSL path translation).
- **Windows-ready**:
  - Bundles `bin/colab_shim.py` to shim `filelock>=4`'s `ReadWriteLock` onto `FileLock` (avoiding `WinError 5` lock errors in restricted environments).
  - Supports pointing `pythonExe` at a signed CPython binary + isolated `sitePackages` directory (avoiding Windows `_ctypes` DLL load blocks on unsigned `uv` venv trampoline stubs).
- **Zero interactive hangs**: Child `stdin` is always closed; expired OAuth2 tokens immediately return structured `auth_required` diagnostics with the consent URL instead of hanging.
- **Async background jobs**: `colab_job` runs multi-minute GPU workloads (e.g. Blender Cycles batch renders, model downloads, training runs) asynchronously with live log tailing.
- **Bundled `colab-operator` Skill**: Teaches agents best practices including explicit session naming, zombie-VM billing protection, and Blender Cycles headless rendering SOPs.

## MCP Tools

| Tool | Actions / Capabilities |
|---|---|
| `colab_session` | `doctor`, `whoami`, `usage`, `sessions`, `new`, `status`, `stop`, `restart_kernel`, `url`, `log` |
| `colab_exec` | Run inline Python `code`, a local `.py`/`.ipynb` `file`, or a streaming bash `shell_cmd` on a persistent session |
| `colab_run` | Ephemeral one-shot script execution (`new` → run → auto `stop`) |
| `colab_files` | `upload`, `download` (auto-creates local parent directories), `ls`, `rm` |
| `colab_install` | Install Python packages (`packages[]` or local `requirement` file) onto a session VM |
| `colab_job` | Async `submit` (`kind="exec"` or `"run"`), `status` (with `log_tail`), `list`, `cancel` |

## Prerequisites

1. **Node.js `>= 20`** (tested on Node 24; zero `npm` packages required).
2. **Python `>= 3.12`** with `google-colab-cli` installed:
   ```bash
   pip install google-colab-cli
   # or with uv into a dedicated venv:
   uv venv .colab-venv --python python
   uv pip install --python .colab-venv google-colab-cli
   ```
3. **Authenticate once** in a normal terminal:
   ```bash
   colab --auth=oauth2 whoami
   # or with ADC:
   # gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
   ```

## Installation (Antigravity)

### 1. Optional machine-local configuration (`local.config.json`)

If `google-colab-cli` is installed in an isolated venv or uses a custom `HOME` directory for credentials, copy `local.config.example.json` to `local.config.json` (gitignored):

```json
{
  "pythonExe": "C:\\Path\\To\\python.exe",
  "sitePackages": "C:\\Path\\To\\venv\\Lib\\site-packages",
  "colabHome": "C:\\Path\\To\\colab-home",
  "defaultAuth": "oauth2"
}
```

Configuration precedence (highest → lowest):
1. Environment variables in `mcp_config.json` (`COLAB_BRIDGE_PYTHON`, `COLAB_BRIDGE_SITE_PACKAGES`, `COLAB_BRIDGE_HOME`, `COLAB_BRIDGE_SHIM_DIR`, `COLAB_BRIDGE_AUTH`, `COLAB_BRIDGE_DATA_DIR`, `COLAB_BRIDGE_CONFIG`)
2. `local.config.json` in the plugin root
3. Cross-platform defaults (`python` / `python3`, `os.homedir()`, `oauth2`)

### 2. Install into Antigravity global plugins

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-plugin.ps1 -Mode GlobalCopy -Force
```

*(Note: Antigravity's plugin scanner skips Windows directory junctions under `~/.gemini/config/plugins/`, so `GlobalCopy` is the default and overwrites files in-place safely.)*

**macOS / Linux:**
```bash
cp -R . ~/.gemini/config/plugins/colab-bridge
```

### 3. Verify health & tests

```bash
npm test
npm run doctor
```

## License

[MIT](LICENSE)
