# 交付工具核验记录

日期：2026-10-13；本地 Node.js v24.15.0；Windows PowerShell。此记录只陈述已实际运行的工具验证，作者真实书签验收与 GitHub 服务端保护另行确认。

- 密钥扫描采用先写测试的顺序：实现前 6 项失败，实现后 6 项通过；新增文件名泄露回归测试先失败再修复，最终 7 项通过。覆盖已跟踪工作文件、暂存版本与工作文件差异、已删除历史凭据、示例/低熵值、二进制跳过和参数错误。测试凭据用字符串拼接构造；命中报告不包含值，文件名含已知凭据格式时也会脱敏。
- `node scripts/check.mjs` 已实际通过：JS 语法、JSON、MV3、仅 bookmarks/storage 必需权限、可选网络权限、本地脚本与 PNG 图标。
- `node scripts/package.mjs` 已实际生成 16 个运行文件的可加载目录、ZIP 和 SHA-256 校验文件；仅复制 extension 运行文件，没有复制测试 profile、备份或开发依赖。重复打包保留旧生成物，无递归删除。
- ZIP 内部 16 个文件逐项计算 SHA-256，与可加载目录对比，0 项不一致。包含尚未跟踪源文件的显式清单扫描共 43 个文件，0 命中；常规 CLI 默认仍只扫描已跟踪文件。
- 已提供 pre-commit 暂存扫描和 pre-push 可达历史扫描 hook；是否激活依赖本仓库 `core.hooksPath` 配置，不能仅凭 hook 文件存在宣称生效。
- 已提供 Ubuntu GitHub CI：安装 Playwright 测试依赖和 Chromium，执行源码/历史扫描、检查、Node 测试、隔离浏览器测试与打包。尚无 remote，因此没有云端运行结果。
- 已读取落盘的 `artifacts/browser-report.json`：独立 profile 上 Chrome 154.0.8037.98 与 Edge 155.0.4283.45 各 6 组实际 API/UI 验证通过，外联请求和页面错误数组为空。报告使用合成书签，不能代替作者真实书签及多设备同步验收。

本地扫描仅覆盖有限模式；GitHub 仓库 Push Protection 尚未开启，详见 [GitHub 状态说明](github-security.md)。
