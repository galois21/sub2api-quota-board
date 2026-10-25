# Sub2API Quota Board

**简体中文** | [English](README.en.md)

为 Sub2API 提供一个可挂载到自定义菜单的上游账号额度看板，让普通登录用户也能看到当前容量。

**A lightweight dashboard for Sub2API upstream account quotas, concurrency, and recent activity.**

独立 Node.js 服务，原生单页面，无运行依赖、无数据库连接、无前端构建。通过 Sub2API 的管理接口读取数据，不修改 Sub2API 源码或框架。项目为第三方工具，与 [Sub2API](https://github.com/Wei-Shaw/sub2api) 独立维护。

## 功能

<img width="2398" height="1566" alt="image" src="https://github.com/user-attachments/assets/be03d7cb-d979-4bc1-9c51-f3a392ef92a8" />

- GPT、反重力、Gemini 三个 Tab，默认 GPT；只查询当前分组，其他分组首次切换时读取。
- 展示窗口额度、已用／剩余、括号内的重置倒计时、账号状态、当前并发和最近 5 分钟使用人数。
- 汇总展示账号总数、可用、已限流、停用；电脑每行两个账号，手机单列，支持浅色／深色。
- 每 60 秒检查当前分组，页面隐藏时暂停；支持手动更新、缓存和请求合并。
- 停用账号保留灰色卡片，隐藏额度明细；对普通用户只展示账号别名，不公开邮箱、凭据或内部备注。
- 管理员 Key 只留在服务端，用户通过现有 Sub2API 登录身份访问。

已在 Sub2API `0.2.18` 验证；其他版本需确认管理接口和自定义菜单格式兼容。这里展示的是**上游账号额度**，不是用户余额或个人消费。

## 最简单的安装方法：交给 AI

把下面这段话复制给有服务器操作能力的 AI，填好目录和访问地址即可：

```text
请把 https://github.com/galois21/sub2api-quota-board 安装到我的服务器中，
并挂载到 Sub2API 的自定义菜单，让普通登录用户可以查看上游账号额度。

我的 Sub2API 目录是：<填写现有 Sub2API 目录>
我的 Sub2API 访问地址是：https://<填写域名>
服务器连接方式：<填写 SSH 地址、用户名及认证方式，不要把密码或私钥提交到 Git>

请先阅读项目 README，检查现有部署、Node.js 和反向代理，再部署独立看板。
保留已有菜单，不修改 Sub2API 的源码、框架或数据库。
管理员 Key 我会在服务器上自行填写，请告诉我配置文件的位置；
不要把 Key 写进聊天、Git、网页或菜单 URL。
完成后给我访问地址，并验证未登录不能读取额度、普通登录用户可以查看。
```

## 手动安装

以下示例适用于 Linux + systemd + Nginx，使用主站同域的 `/quota/` 路径。需要 Node.js 22 或以上、Git，以及能读取 Sub2API 上游账号和额度的管理员 API Key。管理员 Key 不是调用模型时使用的普通 API Key；配置菜单时还需要系统设置权限。

### 1. 下载源码

```sh
sudo git clone https://github.com/galois21/sub2api-quota-board.git /opt/sub2api-quota-board
cd /opt/sub2api-quota-board
node --version
npm test
```

没有 npm 依赖，无需运行 `npm install`。测试仅使用本地模拟接口，不需要真实 Key。

### 2. 配置服务端环境文件

```sh
sudo install -m 600 .env.example /etc/sub2api-quota-board.env
sudoedit /etc/sub2api-quota-board.env
```

填写：

```dotenv
SUB2API_BASE_URL=http://127.0.0.1:8080
SUB2API_ADMIN_KEY=
PUBLIC_ORIGIN=https://sub2api.example.com
BASE_PATH=/quota
PORT=18081
```

| 配置 | 说明 |
| --- | --- |
| `SUB2API_BASE_URL` | 本服务能够访问的 Sub2API 地址；修改为实际内部端口或地址 |
| `SUB2API_ADMIN_KEY` | 在服务器编辑器里填写管理员 Key，不填写则额度接口返回未配置 |
| `PUBLIC_ORIGIN` | 实际主站 HTTPS 地址，与用户登录 Sub2API 的域名一致，不带 `/quota/` |
| `BASE_PATH` | 默认 `/quota`；修改时同步调整 Nginx 路径和菜单 |
| `PORT` | 默认 `18081`，服务仅监听 `127.0.0.1` |

真实环境文件放在项目目录外，权限保持 `600`。不要把它复制到 `public/` 或提交到仓库。

### 3. 启动服务

```sh
command -v node
sudo install -m 644 deploy/sub2api-quota-board.service /etc/systemd/system/sub2api-quota-board.service
```

模板默认使用 `/usr/bin/node` 和 `/opt/sub2api-quota-board`。路径不同时，先编辑安装后的 service 文件。模板启用了 `ProtectHome=true`，因此 Node.js 应安装在系统目录，不使用位于个人 home 中的 NVM 路径。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sub2api-quota-board
curl -fsS http://127.0.0.1:18081/quota/healthz
```

正确填写 Key 后，健康接口应返回 `{"status":"ok","configured":true}`。这只表示 Key 已配置，实际权限需要通过额度页面验证。动态服务用户需要能读取源码和上级目录；环境文件由 systemd 读取，无需放宽其权限。

### 4. 添加同域反向代理

将 `deploy/nginx.conf` 的内容加入现有 Sub2API 网站的 HTTPS `server` 块；也可以保存为 snippet 后通过 `include` 引入。保留主站现有代理和证书配置。

```sh
sudo install -d -m 755 /etc/nginx/snippets
sudo install -m 644 /opt/sub2api-quota-board/deploy/nginx.conf /etc/nginx/snippets/sub2api-quota-board.conf
```

在现有 HTTPS `server` 块中引入：

```nginx
include /etc/nginx/snippets/sub2api-quota-board.conf;
```

修改后先检查配置，再重载 Nginx：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

宝塔等面板环境可使用面板对应的配置目录和 Nginx 校验／重载功能。Nginx 若运行在容器内，需要调整代理地址以连接宿主机服务；无需向公网开放 `18081`。

示例代理关闭了该路径的访问日志，因为自定义菜单入口可能携带用户登录 token；前置 CDN、网关和监控也应避免记录这类查询参数。详见 [SECURITY.md](SECURITY.md)。

### 5. 挂载自定义菜单

使用配置好的环境文件执行一次：

```sh
sudo /usr/bin/node --env-file=/etc/sub2api-quota-board.env /opt/sub2api-quota-board/scripts/configure-menu.mjs
```

脚本保留已有菜单，幂等合并一个面向用户的「上游额度」菜单，不修改其他系统设置。以后启动看板不会自动改写菜单。也可以在 Sub2API 后台手动添加用户可见的自定义菜单，地址填写：

```text
https://你的主站域名/quota/
```

菜单 URL 中不要填写管理员 Key。登录 Sub2API 后从该菜单打开即可；同域直接访问也会尝试复用已有登录。管理员可切换到个人导航查看用户菜单。

## 数据口径

- 当前并发是正在处理的请求数，不是独立人数；最近 5 分钟使用人数是当前分组的去重用户数，只返回人数，不返回用户或请求记录。
- GPT 显示 5 小时在上、7 天在下；Gemini 独立分组显示分钟在上、日在下。
- 反重力显示 Gemini 在上、Claude / GPT 在下，重复模型取使用率最高的代表值。Gemini 的 5 小时与 Claude / GPT 额度同时限流，才将正常启用的账号显示为已限流；异常和停用状态优先。
- 停用账号不查询上游额度，公开接口也不返回其额度明细；显示「额度不可用」。
- 缺失、失败或过期数据有相应提示，不推断为剩余 100%，也不累加不同账号的百分比或保证还能使用多久。
- 所有有效登录用户看到相同的公开账号范围，不按用户套餐筛选上游账号。安装前应确认这种共享范围符合站点需求。
- 服务只提供固定的只读额度接口；菜单配置脚本会单独调用设置接口。不会测试账号、清除限流、刷新 OAuth 凭据或修改额度。

## 更新与卸载

更新时保留 `/etc/sub2api-quota-board.env`：

```sh
cd /opt/sub2api-quota-board
sudo git pull --ff-only
npm test
sudo systemctl restart sub2api-quota-board
```

卸载时，先从 Sub2API 后台移除对应菜单，再停止本服务、移除自己的 Nginx snippet／include 和 systemd service。校验并重载 Nginx，保留原主站配置；环境文件可按需单独保留或删除。

## 安全与许可

安全边界、日志注意事项和漏洞报告方式见 [SECURITY.md](SECURITY.md)。测试数据均为虚构示例，示例配置不包含真实凭据。

[MIT License](LICENSE)。
