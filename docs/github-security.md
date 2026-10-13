# GitHub 密钥拦截状态

2026-10-13：经用户明确授权，已创建公开仓库 [xiaoliumiaomiao/bookmark-tidy](https://github.com/xiaoliumiaomiao/bookmark-tidy)，并在首次推送源码前开启 GitHub 仓库级保护。独立 GET API 核验得到：

| 设置 | 实际状态 |
| --- | --- |
| visibility | public |
| secret_scanning | enabled |
| secret_scanning_push_protection | enabled |
| 当前账户仓库管理权限 | admin: true |

本地 `origin` 指向该仓库。本地 hook 和 CI 是补充防护，不代替上述服务端设置。该记录不包含凭据值。

GitHub CLI 已安装，账户认证的只读 API 验证成功。本项目说明不保存凭证值。

## 可用条件

- Public 仓库可免费使用密钥扫描和 Push Protection。
- Organization-owned Private / Internal 仓库需 GitHub Team 或 Enterprise Cloud，并启用 GitHub Secret Protection。普通个人私有仓库不能只凭 GitHub Pro 或 `repo` scope 获得该功能；企业托管用户等特殊条件应按官方文档核验。
- 修改仓库安全状态需目标仓库管理员权限，或所属组织的 owner / security manager。认证成功不证明具有某个具体仓库的管理权限或产品授权。
- 用户账号级 Push Protection 默认开启并保护向 Public 仓库的推送，但用户可关闭；它与仓库级保护不同，不能据此宣称本项目已经保护。

依据：[当前支持范围](https://docs.github.com/en/code-security/reference/secret-security/secret-scanning-scope)、[Public 免费支持](https://github.blog/changelog/2023-05-09-secret-scannings-push-protection-is-available-on-public-repositories-for-free/)、[保护类型](https://docs.github.com/en/code-security/concepts/secret-security/push-protection)。

## 复核与维护

用户已指定仓库及公开可见性。以下命令可以重新核验；更换远端或可见性时，应重新检查仓库权限和产品授权条件。

命令不需要在文件里保存密钥：

```powershell
gh api --method GET repos/xiaoliumiaomiao/bookmark-tidy --jq '{visibility: .visibility, permissions: .permissions, security_and_analysis: .security_and_analysis}'
```

满足条件后开启密钥扫描及推送拦截：

```powershell
'{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}' |
  gh api --method PATCH repos/xiaoliumiaomiao/bookmark-tidy --input - --jq '.security_and_analysis'
```

必须再次独立读取确认两个 `status` 都是 `enabled`：

```powershell
gh api --method GET repos/xiaoliumiaomiao/bookmark-tidy --jq '.security_and_analysis | {secret_scanning, secret_scanning_push_protection}'
```

若字段不可见、返回失败或授权条件不足，应如实记录未启用，不把请求发出视为成功。[官方 REST API 参数与权限](https://docs.github.com/en/rest/repos/repos#update-a-repository)、[仓库启用说明](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection)。

Push Protection 只检测部分支持的密钥模式，存在扫描规模和格式等限制，也可能允许绕过。它不能保证所有秘密都被阻止。[检测范围与限制](https://docs.github.com/en/code-security/reference/secret-security/secret-scanning-scope)。
