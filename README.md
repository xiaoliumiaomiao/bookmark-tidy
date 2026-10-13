# 书签归位 · Bookmark Tidy

用于桌面 Edge / Chrome 的开源书签整理插件。先生成预览，再逐项确认名称和分类；完整网址逐字保留。默认使用本地规则，无运行时第三方依赖、遥测或远程脚本。

第一版提供全量整理、增量整理、网址与文件夹锁定、自定义规则、人工选择记忆、备份、撤销和可选 AI 建议。不同浏览器各自整理自己的书签，不自动跨浏览器同步。

## 安装

建议先在小范围书签上验收。加载插件会授予浏览器级的 `bookmarks` 读写权限及 `storage` 本地存储权限；实际操作范围由程序根据你的选择、锁定和预览控制。加载和卸载插件本身不执行整理。

1. 下载源码，找到 `extension` 文件夹。使用打包版时，先解压 ZIP，找到其中包含 `manifest.json` 的 `bookmark-tidy-0.1.0` 文件夹。
2. Edge 打开 `edge://extensions`；Chrome 打开 `chrome://extensions`。
3. 开启「开发人员模式」，点击「加载解压缩的扩展」，选择上一步的文件夹。
4. 点击工具栏中的「书签归位」图标，打开整理工作区。

插件源码修改后，需要在扩展管理页点击「重新加载」。卸载会移除插件设置及撤销记录；已经应用到浏览器的名称和目录不会自动还原。

## 第一次整理

1. 点击「导出完整备份」保存 JSON 精确快照，并点击「导出可导入备份」保存 HTML。已有整理历史时两者使用最近整理前的快照；要保存当前状态，可使用浏览器原生书签导出。
2. 在左侧选择范围，锁定不希望改动的网址或目录，并点击「保存锁定与规则」。
3. 选择「整理整体」和分类粗细，点击「生成整理预览」。预览只读取书签。
4. 检查每项建议；可以修改名称、选择目标目录或取消勾选。未知分类可保留当前位置。
5. 点击「应用选中项」。需要回退时，点击「撤销上次整理」。

全量整理包括所选范围的子文件夹，但不删除书签、重复网址或原有文件夹，因此整理后可能留下旧空文件夹。增量整理仅处理所选书签栏下直接放置的书签；已有文件夹内部保持原样，并优先复用可用分类目录。

锁定一个网址会保护所有具有完全相同网址的副本。锁定文件夹会保护其子树；锁定路径采用文件夹名称数组，跨浏览器语言不同或同名路径可能造成匹配局限，迁移规则后请重新核对锁定。管理员管理的节点会跳过。

浏览器同步或人工编辑会使旧预览失效，应重新生成。应用过程会记录恢复日志；如果中断，页面会要求先撤回未完成操作。撤销只回退可确认属于本次整理的修改；遇到之后的冲突修改会停止。自动化验证不代替你的真实书签验收。

## 两种备份

- **JSON 精确快照**：保存节点 ID、原始网址、标题、层级等信息。存在整理记录时，导出的是最近一次操作前的原始快照，可能不是当前书签；没有历史快照时才读取当前树。此文件用于留存和核对，第一版没有任意 JSON 快照的全量恢复入口。
- **可导入 HTML**：点击「导出可导入备份」生成浏览器支持的书签 HTML。可在浏览器书签管理器使用「导入书签」导入。导入会追加内容，可能产生重复；它不能完整恢复原节点 ID、全部元数据或精确撤销后续修改。备份来源与 JSON 相同。

两种备份都可能包含私密网址、标题、查询参数和目录。请保存在本地受控位置，不要上传到公开仓库。插件会在应用前持久化备份和恢复日志，但这不能替代独立下载备份。

「导出锁定与规则」只导出允许的设置字段，不含 AI 密钥；仍可能含锁定网址及人工规则网址，分享前应检查。导入规则后先核对，再点击保存。

## 可选 AI 建议

默认不联网。需要时先生成预览，再展开「可选 AI 建议」，填写完整的 Chat Completions 请求 URL（例如 `https://api.example.com/v1/chat/completions`）、模型名称和 API Key。服务需兼容 Chat Completions 响应；HTTPS 可用于远程服务，本机 `localhost` / `127.0.0.1` 允许 HTTP。

界面会展示将发送的书签 ID、原始标题和 hostname（主机名）。完整网址、路径、查询参数和书签树不放入请求；标题本身仍可能包含私人信息，应检查后勾选确认。每次最多 300 条，浏览器按请求的服务主机询问可选网络权限。你填写的服务商会按其条款处理数据，并可能计费。

API Key 仅用于本次请求，不写入插件设置、备份、规则或日志，请求后清空输入框。AI 建议仍需在预览中检查并点击应用，不会自动写书签。

## 开发与验证

需要 Node.js 22+、Git；插件运行不需要 Node.js。

```powershell
npm test
npm run check
npm run scan:secrets
npm run package
```

`package` 只交付插件运行文件：可加载目录 `dist/bookmark-tidy-0.1.0/`、ZIP 和 `.sha256` 校验文件。重复打包会保留之前的生成物，不会递归删除目录。Windows 使用已有 PowerShell `Compress-Archive`；其他平台使用 `zip` CLI。

真实浏览器测试可复用已有 Playwright：设置 `PLAYWRIGHT_MODULE_PATH` 为其模块路径后执行 `npm run test:browser`。开发环境也可安装测试依赖：

```powershell
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:browser
```

测试仅在 `.test-profiles` 下的独立 profile 创建模拟书签，不打开日常浏览器 profile。Windows 优先测试已安装的 Chrome / Edge；其他环境使用 Playwright Chromium，也可设置 `BROWSER_EXECUTABLE`。测试会用 `Extensions.loadUnpacked` 与 `--enable-unsafe-extension-debugging` 加载扩展，该选项只用于隔离测试环境。截图和报告写到忽略的 `artifacts` 目录。

要在当前仓库启用随项目提供的本地 hook，运行以下可回退配置；它不会改变全局 Git 配置：

```powershell
git config --local core.hooksPath .githooks
```

撤回该配置使用 `git config --local --unset core.hooksPath`。`pre-commit` 扫描暂存内容，`pre-push` 扫描本地可达历史。扫描仅输出文件、行号和类型，不输出命中值；检测范围有限且本地 hook 可被绕过。[安全边界](SECURITY.md)和 [GitHub 仓库保护状态](docs/github-security.md)另有说明。

## 当前验证边界

隔离测试报告见 `artifacts/browser-report.json`；测试使用合成书签。自动测试覆盖网址保留、重复保留、锁定、增量范围、冲突、应用及撤销。真实书签的分类、命名偏好和多设备同步行为仍由作者验收。GitHub CI 文件已提供，远端未配置时没有云端 CI 运行或仓库级 Push Protection 的成功证据。

MIT License，Copyright © 2026 xiaoliumiaomiao。
