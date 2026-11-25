# Colab Bridge — Google Colab MCP 路由与算力安全规范

本规则在 `colab-bridge` 插件启用期间全局生效，用于约束 Agent 通过本地 `colab-bridge` Stdio MCP 操作 Google Colab GPU/TPU 算力时的工具路由、防僵尸计费、防阻塞与任务分工边界。

## 1. 优先通路与零终端绕行铁律

1. **所有 Colab 操作一律走 `colab-bridge` MCP**：统一调用 `colab_session`、`colab_exec`、`colab_run`、`colab_files`、`colab_install`、`colab_job`；**禁止**在终端里直接调用 `colab`、`colabx` 或 `wsl colab`（避免 Windows 沙箱断网、重复审批弹窗、路径转义与 `filelock` 锁冲突）。
2. **多步流程按需加载 Skill**：涉及复杂环境装配、大文件同步或 Blender 远端 Cycles 渲染时，先读取配套 `colab-operator` Skill 获取完整 SOP。

## 2. 会话生命周期与防计费红线

1. **先验活再开卡**：不确定认证或远端残留会话状态时，先调 `colab_session(action="doctor")` 或 `action="sessions"`；避免盲开重复 VM。
2. **一次性任务优先 `colab_run`**：独立自包含脚本优先使用 `colab_run`（自动开卡 → 执行 → 退出/报错自动释放 VM，杜绝忘记关机）。
3. **持久会话必须显式命名并及时关机**：调用 `colab_session(action="new")` 必须传入语义化 `session` 名称（如 `gpu-render`）；产物通过 `colab_files(action="download")` 拉回并本地校验后，**必须立即执行 `colab_session(action="stop", session="...")`**。
4. **严禁瞎填加速器型号**：仅使用白名单参数 `gpu ∈ {T4, L4, G4, A100, H100}` 或 `tpu ∈ {v5e1, v6e1}`（二者互斥）；若账号无高配卡配额返回 400，诚实降级或回退 `T4` / CPU，不得循环重试。

## 3. 无头执行、异步长任务与鉴权降级

1. **严禁交互式 TTY 阻塞**：禁止在远端尝试需要人工 TTY 输入的命令（`repl`、`console`、`auth`、`drivemount`）；远端 bash 命令统一经 `colab_exec(session="...", shell_cmd="...")` 执行（流式回传 stdout/stderr，无 PTY 乱码）。
2. **超过 2 分钟的任务一律异步**：下载大包（如 Blender Linux 便携包）、多帧 Cycles 渲染或长训任务，必须用 `colab_job(action="submit")` 提交，并通过 `colab_job(action="status", job_id="...", tail_lines=...)` 查看进度与日志尾部，避免阻塞单轮 MCP 调用。
3. **鉴权失效立即止损汇报**：一旦工具返回 `auth_required: true`，立即停止重试，将 `auth_url` 或本地终端重新登录指引明确告知用户，待用户完成授权后再复检 `doctor`。

## 4. 本机与 Colab 算力分工边界（含 Blender 场景）

1. **CPU 重活留在本地，GPU 渲染/推理再上云**：Colab 免费 T4 仅有 2 vCPU / 12 GB RAM；几何建模、BVH 穿模审计、布料/刚体物理烘焙、PIL 拼板与 HTML 审计一律在本地执行，仅将纯 GPU Cycles 高画质/长序列渲染或显存受限的推理任务卸载至 Colab。
2. **严禁破坏源工程相对路径契约**：上传 Blender 场景前，必须在临时目录生成 `bpy.ops.file.pack_all()` 打包副本再 `upload`，绝不修改原始 `.blend` 的 `//` 相对贴图路径；远端须下载与本地严格一致版本的官方 Linux 便携包（如 Blender `5.3.0`），并仅跑 Cycles（勿在无头容器强跑 EEVEE）。

## 5. 插件维护与隐私卫生（改动本仓库时生效）

- 本机专属路径与隔离环境覆写仅允许写入被 `.gitignore` 忽略的 `local.config.json`；**严禁**向受 Git 跟踪的文件写入个人盘符路径、用户名、邮箱或 OAuth 令牌。
- 修改插件源码后，执行 `node --test` 通过测试，再运行 `scripts/register-plugin.ps1 -Mode GlobalCopy -Force` 同步至全局插件目录（避免使用 Windows 目录联接，Antigravity 插件扫描会跳过 Junction）。
