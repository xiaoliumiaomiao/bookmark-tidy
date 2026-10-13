# 第一版技术验证记录

日期：2026-10-13。版本：0.1.0。验证使用合成书签和独立浏览器配置，未操作用户日常书签或同步账户。

## 最新结果

| 检查 | 实际结果 |
| --- | --- |
| Node 自动测试（含真实页面的 API mock 交互测试） | 103 通过，0 失败，0 跳过 |
| 本机 Chrome 154.0.8037.98 | 独立 profile，6 组真实扩展 API / UI 检查通过 |
| 本机 Edge 155.0.4283.45 | 独立 profile，6 组真实扩展 API / UI 检查通过 |
| 运行页面默认外联 / 页面异常 | 两浏览器均为 0 / 0 |
| 源码语法、MV3、权限、本地资源 | 23 个 JavaScript 文件检查通过 |
| Git 暂存区 / 可达历史密钥扫描 | 通过；检测模式有限 |
| 独立事务与隐私代码审查 | 最终 spec compliance 通过；quality 批准；确认的问题均有回归验证 |
| 安装产物 | 16 个运行文件，可加载目录、ZIP、SHA-256 |
| 首次 GitHub Actions（Ubuntu、Node 22、Playwright 1.62.1） | [运行 38355229165](https://github.com/xiaoliumiaomiao/bookmark-tidy/actions/runs/38355229165) 全部通过 |

命令：`node --test --test-reporter=spec tests/*.test.js`、`node scripts/browser-test.mjs`、`node scripts/check.mjs`、`node scripts/package.mjs`、`node scripts/scan-secrets.mjs --staged`、`node scripts/scan-secrets.mjs --history`。

## 实际浏览器检查

- 生成预览不修改书签，锁定网址和专题子树排除在修改候选外。
- 从真实工作区取消一项并应用：完整 URL 逐字保留，书签数量和重复网址保留，取消项与锁定项不变，原文件夹保留。
- 从真实工作区撤销：名称、父文件夹和已知书签原始顺序与应用前快照一致。
- 增量整理仅处理书签栏直接书签，已有文件夹内条目完整状态不变。
- 预览后书签修改导致旧计划被拒绝，规则导出没有凭据字段。
- 运行页面未发起外部 HTTP/HTTPS 请求，没有页面 JavaScript 异常。

详细机器记录和截图在本地忽略目录 `artifacts/browser-report.json`、`artifacts/chrome-preview.png`、`artifacts/edge-preview.png`。这些是合成书签，不是用户的真实收藏。

## 审查修复

已先复现失败、再实现修复的边界：中断后手动排序；撤销响应丢失后排序；日志持久化期间目的地移出范围或用户改名；清理新建空目录时用户保留该目录；增量只改名称；AI 请求不泄漏私人目录名；成功响应原文或 JSON 转义回显本次密钥被拒绝；后台持久化状态不含该密钥。

本地命名与分类效果回归包括品牌前缀简化、具体页面主题保留、全量细分类真正拆分、增量稳定沿用已有分类。

## 验收边界

尚未使用用户真实书签验证分类是否符合个人偏好，未验证浏览器账户的多设备同步效果。AI 传输和返回校验使用模拟服务验证，未向真实云端供应商发送书签或提供真实密钥。第一版保留原有空文件夹，没有任意 JSON 快照的全量恢复入口；HTML 导入会追加书签。

本地 Git hooks 通过仓库级 `core.hooksPath=.githooks` 激活。2026-10-13 经用户授权创建公开 GitHub 仓库，首次推送前已启用并通过独立 API 核验 Secret Scanning 与 Push Protection 均为 enabled。说明见 [github-security.md](github-security.md)。
