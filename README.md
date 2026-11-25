# colab-bridge-antigravity

English | [简体中文](README.zh-CN.md)

Lightweight, zero-dependency Node.js Stdio MCP plugin for **Antigravity** that wraps [`google-colab-cli`](https://github.com/googlecolab/google-colab-cli) into 6 structured MCP tools — built to work smoothly on native **Windows**, macOS, and Linux without WSL.

## Highlights

- **Zero shell sandbox friction**: Runs as a local Antigravity Stdio MCP server with direct host network access (no per-command approval popups or WSL path translation).
- **Windows-ready**:
  - Bundles `bin/colab_shim.py` to shim `filelock>=4`'s `ReadWriteLock` onto `FileLock` (avoiding `WinError 5` lock errors in restricted environments).
  - Supports pointing `pythonExe` at a signed CPython binary + isolated `sitePackages` directory (avoiding Windows `_ctypes` DLL load blocks on unsigned `uv` venv trampoline stubs).
- **Zero interactive hangs**: Child `stdin` is always closed; expired OAuth2 tokens immediately return structured `auth_required` diagnostics with the consent URL instead of hanging.
- **Async background jobs**: `colab_job` runs multi-minute GPU workloads (e.g. Blender Cycles batch renders, model downloads, training runs) asynchronously with live log tailing.
- **Bundled `colab-operator` Skill & `rules/AGENTS.md`**: Teaches agents best practices and enforces MCP-first routing, zombie-VM billing protection, and Blender Cycles headless rendering SOPs.

## MCP Tools

| Tool | Actions / Capabilities |
|---|---|
| `colab_session` | `doctor`, `whoami`, `usage`, `sessions`, `new`, `status`, `stop`, `restart_kernel`, `url`, `log` |
| `colab_exec` | Run inline Python `code`, a local `.py`/`.ipynb` `file`, or a streaming bash `shell_cmd` on a persistent session |
| `colab_run` | Ephemeral one-shot script execution (`new` → run → auto `stop`) |
| `colab_files` | `upload`, `download` (auto-creates local parent directories), `ls`, `rm` |
| `colab_install` | Install Python packages (`packages[]` or local `requirement` file) onto a session VM |
| `colab_job` | Async `submit` (`kind="exec"` or `"run"`), `status` (with `log_tail`), `list`, `cancel` |

## Plugin Structure

```text
colab-bridge-antigravity/
├── plugin.json                  # Antigravity plugin manifest (name, displayName, version, logo, suggestedPrompts)
├── agy-market.json              # AGY Market companion metadata (categories, tags, preservePaths for local.config.json)
├── mcp_config.json              # Local Stdio MCP server definition (${PLUGIN_ROOT}/bin/mcp-server.mjs)
├── rules/AGENTS.md              # Global routing, billing-safety, and headless execution rules
├── skills/colab-operator/       # Bundled colab-operator skill (SKILL.md)
├── bin/                         # MCP server, Colab CLI runner, and Windows filelock shim
├── scripts/                     # Plugin sync script (register-plugin.ps1) and live doctor script
├── assets/logo.svg              # Plugin icon referenced by plugin.json
├── local.config.example.json    # Template for gitignored machine-local overrides (local.config.json)
└── tests/mcp-server.test.mjs    # Node built-in test suite
```

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

**Via AGY Market (recommended):**
Install `colab-bridge` from AGY Market or add this repository URL directly. `plugin.json` supplies the Antigravity manifest, and `agy-market.json` declares `"preservePaths": ["local.config.json"]` so marketplace upgrades keep your existing `local.config.json` intact.

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-plugin.ps1 -Mode GlobalCopy -Force
```

*(Note: Antigravity's plugin scanner skips Windows directory junctions under `~/.gemini/config/plugins/`, so `GlobalCopy` is the default, updates files in-place safely, and preserves any existing `local.config.json` in the target directory.)*

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
