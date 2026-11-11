# NOTES

一个给朋友的公开小看板。文字卡片为浅黄色，链接卡片为浅蓝色；点击卡片打开阅读弹窗，主链接入口直接访问资源。作者通过管理模式新增、编辑、删除和拖动交换卡片位置。两类卡片都支持加粗、斜体、下划线和正文超链接，没有搜索框或手动改色功能。

## 本地预览

需要 Node.js 22 或更新版本，无需安装依赖或构建。

```powershell
node scripts/serve.mjs
```

打开终端中显示的 `http://127.0.0.1:4173/`。端口被占用时，可运行 `node scripts/serve.mjs 4174`。请通过本地服务器打开，不要直接双击 HTML 文件。

点击页面底部“管理看板”，可先选择“先在本地编辑”。点击“＋”填写卡片；已有卡片先进入阅读弹窗，再点击“编辑卡片”。勾选“作为链接卡片”后填写主链接，卡片颜色随类型自动改变。

修改自动保存在当前浏览器的本地草稿中，尚未发布的内容不会提交到仓库。浏览器、设备或站点地址改变后，草稿不会自动转移；清除网站数据也会清除本地草稿。写好后，使用“发布更改”统一提交本次内容、顺序和新增删除操作。

## GitHub Pages 托管

创建一个专用的**公开**仓库，例如 `friend-board`。网页和发布内容都可以公开；不要将个人令牌、`.env` 或不打算公开的内容提交到仓库。现有示例卡片可以在管理模式中替换或删除。

将以下文件和目录上传到新仓库的 `main` 分支根目录，保留目录结构：

```text
index.html
styles.css
config.json
favicon.svg
.nojekyll
scripts/app.js
scripts/model.js
scripts/github.js
scripts/credentials.js
data/board.json
vendor/quill.js
vendor/quill.snow.css
vendor/LICENSE
```

在 GitHub 仓库的 **Settings → Pages → Build and deployment** 中，将 Source 设为 **Deploy from a branch**，选择 `main` 和 `/(root)` 后保存。无需额外构建流程。初次发布地址通常为 `https://用户名.github.io/仓库名/`。更新可能需要等待最多约十分钟。

在 `config.json` 填写公开的仓库信息，示例如下；这里不保存任何令牌：

```json
{
  "owner": "你的 GitHub 用户名",
  "repo": "friend-board",
  "branch": "main",
  "path": "data/board.json",
  "siteUrl": "https://你的用户名.github.io/friend-board/"
}
```

## 作者发布

为这个仓库创建一个细粒度个人访问令牌（Fine-grained personal access token），仅选中该仓库，授予 **Contents: Read and write** 权限，并设置有效期。无需授予所有仓库权限或 Workflows 写入权限。网页不需要知道你的 GitHub 密码。

在“管理看板”中输入 `用户名/仓库名` 和令牌，勾选“在此浏览器记住令牌”后连接。验证通过后，令牌会加密保存在当前浏览器。以后可通过页面右下角的“管理模式”进入或退出管理。若只需要当次连接，可以取消勾选。要删除已记住的令牌，在“发布设置”中点击“清除已记住的令牌”。

使用同一浏览器配置文件的人可以尝试进入管理模式，因此请在自己的浏览器中使用记忆功能。令牌过期、被撤销或浏览器清除网站数据后，需要重新连接。GitHub 校验每次发布的仓库写入权限。

“发布更改”会检查自上次读取以来云端文件是否变化，再提交完整看板。发生冲突时本地草稿会保留，可下载备份后读取云端最新版，手动整理需要保留的改动。换设备前先发布，换设备后先读取云端内容，可减少冲突。

提交完成并不代表网页已更新。“等待上线”阶段会读取实际站点的 `data/board.json`，只有线上 `revision` 与本次发布一致才显示“已上线”。部署超时不会撤销已成功提交的内容，也不会丢弃本地草稿。访客刷新网页后看到新版；访客阅读无需 GitHub 登录或令牌。

## 开发检查与第三方资源

```powershell
node --test tests/*.test.mjs
```

富文本编辑器固定为 Quill 2.0.3，资源已保存在 `vendor/` 中，正常启动不需要访问 CDN。BSD-3-Clause 许可证见 `vendor/LICENSE`，来源与 SHA256 分别见 `vendor/SOURCE.md` 和 `vendor/SHA256SUMS`。需要恢复供应文件时运行 `node scripts/fetch-vendor.mjs`；已有校验清单时会验证下载内容，校验失败不会替换文件。
