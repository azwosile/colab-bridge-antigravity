# colab-bridge-antigravity

[English](README.md) | 简体中文

面向 **Antigravity** 的轻量、零第三方 npm 依赖 Node.js 本地 Stdio MCP 插件，将 [`google-colab-cli`](https://github.com/googlecolab/google-colab-cli) 封装为 6 个结构化 MCP 工具，原生支持 **Windows**、macOS 与 Linux，无需 WSL。

## 核心特性

- **避免终端沙箱摩擦**：作为本地 Antigravity Stdio MCP 服务器运行，直接访问宿主机网络，无需逐条审批弹窗或 WSL 路径转换。
- **原生适配 Windows**：
  - 内置 `bin/colab_shim.py`，将 `filelock>=4` 的 `ReadWriteLock` 适配为 `FileLock`，避免受限环境下的 `WinError 5` 锁文件错误。
  - 支持在 `local.config.json` 中将 `pythonExe` 指向官方签名的 CPython 可执行文件并配合独立 `sitePackages` 目录，规避未签名 `uv` 虚拟环境入口在 Windows 下加载 `_ctypes` DLL 失败的问题。
- **避免交互阻塞**：子进程 `stdin` 始终关闭；当 OAuth2 凭据失效时，立即返回包含授权链接的结构化 `auth_required` 诊断信息，而不是挂起等待输入。
- **异步后台任务**：`colab_job` 支持以异步方式运行耗时 GPU 任务（如 Blender Cycles 批量渲染、模型下载、训练脚本），并实时读取日志尾部。
- **内置 `colab-operator` Skill 与 `rules/AGENTS.md`**：向 Agent 提供操作指南，约束 MCP 优先路由、防僵尸 VM 计费以及 Blender Cycles 无头渲染流程。

## MCP 工具

| 工具 | 支持动作与能力 |
|---|---|
| `colab_session` | `doctor`、`whoami`、`usage`、`sessions`、`new`、`status`、`stop`、`restart_kernel`、`url`、`log` |
| `colab_exec` | 在持久会话上运行内联 Python `code`、本地 `.py`/`.ipynb` `file`，或流式回传输出的 bash `shell_cmd` |
| `colab_run` | 一次性临时任务执行（自动 `new` → 运行脚本 → 退出或报错自动 `stop`） |
| `colab_files` | `upload`、`download`（自动创建本地父目录）、`ls`、`rm` |
| `colab_install` | 向会话 VM 安装 Python 依赖（支持 `packages[]` 或本地 `requirement` 文件） |
| `colab_job` | 异步 `submit`（`kind="exec"` 或 `"run"`）、`status`（带 `log_tail`）、`list`、`cancel` |

## 插件目录结构

```text
colab-bridge-antigravity/
├── plugin.json                  # Antigravity 插件清单（name、displayName、version、logo、suggestedPrompts）
├── agy-market.json              # AGY Market 伴生元数据（categories、tags，及保留 local.config.json 的 preservePaths）
├── mcp_config.json              # 本地 Stdio MCP 服务定义（${PLUGIN_ROOT}/bin/mcp-server.mjs）
├── rules/AGENTS.md              # 全局路由、算力计费安全与无头执行规范
├── skills/colab-operator/       # 内置 colab-operator Skill（SKILL.md）
├── bin/                         # MCP 服务、Colab CLI 执行器与 Windows filelock 兼容垫片
├── scripts/                     # 插件安装同步脚本（register-plugin.ps1）与诊断脚本（doctor.mjs）
├── assets/logo.svg              # plugin.json 引用的插件图标
├── local.config.example.json    # 受 .gitignore 忽略的本机覆写配置模板（local.config.json）
└── tests/mcp-server.test.mjs    # Node 内置测试套件
```

## 前置依赖

1. **Node.js `>= 20`**（已在 Node 24 验证，无需安装任何 `npm` 依赖包）。
2. **Python `>= 3.12`** 并安装 `google-colab-cli`：
   ```bash
   pip install google-colab-cli
   # 或使用 uv 安装到独立虚拟环境：
   uv venv .colab-venv --python python
   uv pip install --python .colab-venv google-colab-cli
   ```
3. **在普通本地终端完成一次登录认证**：
   ```bash
   colab --auth=oauth2 whoami
   # 或使用 ADC：
   # gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
   ```

## 安装与配置（Antigravity）

### 1. 可选本机配置（`local.config.json`）

如果 `google-colab-cli` 安装在独立虚拟环境，或使用自定义 `HOME` 目录存放凭据，可将 `local.config.example.json` 复制为 `local.config.json`（已被 `.gitignore` 忽略），并将示例路径替换为你的本机实际路径：

```json
{
  "pythonExe": "C:\\Path\\To\\python.exe",
  "sitePackages": "C:\\Path\\To\\venv\\Lib\\site-packages",
  "colabHome": "C:\\Path\\To\\colab-home",
  "defaultAuth": "oauth2"
}
```

配置优先级（从高到低）：
1. `mcp_config.json` 中的环境变量（`COLAB_BRIDGE_PYTHON`、`COLAB_BRIDGE_SITE_PACKAGES`、`COLAB_BRIDGE_HOME`、`COLAB_BRIDGE_SHIM_DIR`、`COLAB_BRIDGE_AUTH`、`COLAB_BRIDGE_DATA_DIR`、`COLAB_BRIDGE_CONFIG`）
2. 插件根目录下的 `local.config.json`
3. 跨平台默认值（`python` / `python3`、`os.homedir()`、`oauth2`）

### 2. 安装到 Antigravity 全局插件目录

**通过 AGY Market 安装（推荐）：**
在 AGY Market 中安装 `colab-bridge` 或直接添加本仓库链接。插件根目录的 `plugin.json` 提供标准 Antigravity 清单，`agy-market.json` 声明了 `"preservePaths": ["local.config.json"]`，通过市场升级时会自动保留你已有的 `local.config.json`。

**Windows（PowerShell）：**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-plugin.ps1 -Mode GlobalCopy -Force
```

*（说明：Antigravity 插件扫描器会跳过 `~/.gemini/config/plugins/` 下的 Windows 目录联接，因此默认采用 `GlobalCopy` 原地同步文件，并会保留目标目录中已有的 `local.config.json`。）*

**macOS / Linux：**
```bash
cp -R . ~/.gemini/config/plugins/colab-bridge
```

### 3. 验证健康状态与测试

```bash
npm test
npm run doctor
```

## 许可证

[MIT](LICENSE)
