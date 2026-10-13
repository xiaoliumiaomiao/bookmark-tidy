# Bookmark Tidy 第一版实施计划

> **For agentic workers:** Use task-scoped workers with independent file ownership and review checkpoints. Steps use checkbox syntax for tracking.

**Goal:** 交付可在 Edge 和 Chrome 加载的中文书签整理插件，完整网址不变，默认本地，能够预览、锁定、备份、应用和撤销。

**Architecture:** MV3 service worker 是唯一书签写入入口；纯函数产生建议，本地事务引擎复核范围并记录每一步。页面只编辑建议；可选 AI 仅发送用户预览确认的标题和域名，响应不能修改网址。

**Tech Stack:** 浏览器原生 JavaScript modules、HTML/CSS、Node 内置测试；运行时无第三方依赖；开发验证复用已有 Playwright。

## Global Constraints

- 第一版同时支持桌面 Edge 和 Chrome，浏览器书签各自独立，不跨浏览器自动同步。
- 网址逐字保留，书签不删除；只更新 title、move 原节点并创建分类文件夹。
- 默认完全本地，云端 AI 必须用户主动请求并预览发送数据；API key 只存在请求内存，不进入设置、备份、日志或 Git。
- 全量整理只影响选定文件夹中未锁定的书签；增量只影响选定书签栏的直接书签子节点，已有文件夹内书签不变。
- 锁定网址保护同网址条目；锁定文件夹路径保护整个子树；管理员管理的节点不可修改。
- 整理预览可逐项调整标题、归类、取消；人工选择可保存为网址对应的本地规则。
- 粗细为 few / balanced / many；日常增量优先复用分类，不重建已有目录。
- 应用前保存备份；持久化 pending journal；冲突时停止；重启后允许恢复撤销；撤销不能覆盖之后的用户修改。
- 仅首次安装需要 bookmarks 和 storage；网络域名权限可选；无遥测、远程字体、远程脚本。
- 在真实浏览器的独立临时 profile 中验证，不触碰用户日常 profile。
- 本地 Git 分阶段提交；GitHub push protection 单独核验，未关联仓库不能声称已开启。

## Interfaces

`settings.js`: DEFAULT_SETTINGS, validateSettings(value), exportSettings(settings), importSettings(value).
Settings: `{version:1, granularity:'balanced', lockedBookmarkUrls:[], lockedFolderPaths:[], rules:[], overrides:[]}`。
rules: `{type:'domain'|'keyword', pattern:string, category:string}`；overrides: `{url:string,title?:string,category?:string}`。

`tree.js`: flattenTree(tree) returns nodes with `{id,title,url?,parentId,index,path:string[],unmodifiable?,folderType?,syncing?}`; `findScopeRoots(tree)` returns editable permanent folders; `fingerprint(tree)` returns deterministic string ignoring timestamp/sync metadata; `folderPath(node)` returns path string joined by `/` (path matching uses arrays in settings).

`planner.js`: buildPlan(tree, `{scopeId,mode:'full'|'incremental',granularity,settings}`) returns `{version:1,id,createdAt,scopeId,mode,granularity,sourceFingerprint,folders,items,stats}`.
folder: `{key,title,parentId,existingId?:string}`.
item: `{id,url,oldTitle,newTitle,oldParentId,oldIndex,targetFolderKey:string|null,selected:boolean,confidence:'high'|'review',reason:string}`.
stats: `{scanned,locked,rename,move,review,total}`. Unknown uses null target and remains in place, title cleanup allowed. Planned folders only created when referenced by selected items. existing folder descendants may be destination; incremental only direct unlocked folders as destination.

`engine.js`: `createEngine({bookmarks,storage,withLock})` returns `{apply(plan,edits,settings),undo(),recover(),getState()}`; only immutable plan from background store accepted. Each method runs under withLock. Chrome Promise APIs supplied. Storage adapter `{get(key),set(values),remove(key)}`. Engine writes `{journal,history}`; backup original tree persisted before first mutation. Detect stale plan using fingerprint; verify URL/id and modified nodes during writes. Rollback preserves later unrelated user additions and stops on conflicts.

`background.js` message response: `{ok:true,data}` or `{ok:false,error:string}`; commands inspect, preview, apply, undo, recover, backup, saveSettings, exportRules, aiSuggestions.
inspect data: `{tree,settings,state:{journal,history},plan}`. preview input options above. apply input `{planId,edits:[{id,selected,newTitle,targetFolderKey}],remember:boolean}`. Other commands read-only except explicit ones. Preview never writes bookmarks.

## Task 1: 本地规则与安全建议

Files: extension/core/{tree,naming,settings,planner}.js; tests/{planner,naming,settings}.test.js.
- [x] Write tests covering URL preservation, direct-child incremental scope, nested lock, immutable tree, coarse/fine categories, unknowns and human overrides; run `node --test tests/planner.test.js tests/naming.test.js tests/settings.test.js`, observe missing functionality.
- [x] Implement exact interfaces above; run same tests, all pass.
- [x] Review coverage and commit exact files.

## Task 2: 事务引擎与 AI 边界

Files: extension/core/{engine,ai}.js; extension/background.js; tests/{engine,ai}.test.js.
- [x] Use an in-memory bookmark tree adapter to test apply, URL equality, stale plan, interrupted persistence, undo order, conflict preservation; observe failing tests before engine implementation.
- [x] Implement journal before each side effect, after each side effect record progress; rollback only nodes the journal proves are owned by this operation. Never remove existing bookmark/folder.
- [x] AI request only HTTPS or loopback HTTP endpoint, titles/domain preview, no complete URLs/key persistence, strict suggestion validation; test malformed response and injection-shaped data.
- [x] Run Node tests and inspect runtime permission manifest.

## Task 3: 中文整理界面

Files: extension/{manifest.json,app.html,app.js,styles.css,icons/*}; tests/ui.test.js.
- [x] Write static contracts / browser acceptance harness for visible preview, scope/mode controls, editable items, lock/settings, backup/undo and AI data confirmation.
- [x] Build full-page workspace: folder sidebar, quiet white/light-slate surface, deep blue action, Chinese system sans; category preview and editable before/after rows are the main visual focus. No external assets.
- [x] Integrate authoritative background API; enforce busy state; invalidate plan on scope/settings changes; distinguish pending recovery and completed operation.
- [x] Capture desktop and narrow screenshots; inspect keyboard focus, overflow, empty/error states.

## Task 4: 交付、Git 与密钥保护

Files: README.md, LICENSE, SECURITY.md, scripts/{check,package,browser-test,scan-secrets}.mjs, .github/workflows/ci.yml.
- [x] Add local source/commit secret scan and GitHub CI. Repository push protection remains pending: no GitHub remote or visibility has been specified. Enable and independently verify after that user decision.
- [x] Build packaged directory/zip with source manifest and hashes, excluding tests/profiles/bookmark backups/secrets.
- [x] Actual Chrome/Edge isolated API: full apply/undo; incremental leaves nested entries untouched; URLs identical, duplicate URLs retained, locks respected; local mode no external requests.
- [x] Independent code review, fix significant findings and rerun affected tests.
- [x] Save factual verification report, commit reviewed source, deliver loadable folder and install instructions. No release/GitHub public publication without specified visibility.

## Progress

- 2026-10-13: empty workspace verified; Node and both installed browsers found; initial plan prepared.
