# 部署到云端

GameNest 的房间存在内存里，没有数据库，所以：

- **只能跑一个实例**，不要开多副本。
- **服务重启或休眠，所有房间清空**。更新最好挑没人玩的时候。
- 需要一直连着的 WebSocket：Vercel、Netlify 这类按请求运行的平台跑不了。

下面两种方式都免费：

| | Oracle Cloud 永久免费 VM | Render 免费版 |
|---|---|---|
| 一直在线 | ✅ | ❌ 15 分钟没流量就休眠，唤醒约 1 分钟 |
| 区域 | 新加坡 | 新加坡（不支持时改成美国，延迟约 200ms） |
| 上手 | 约 1 小时，要用 SSH | 约 10 分钟，网页上点几下 |
| 更新 | 在 VM 上运行 `update.sh` | 推送到 GitHub 自动部署 |

两边不能同时用同一个域名。比如 `play.sitehustle.my` 指向 Oracle，Render 就用它给的 `xxx.onrender.com` 地址，或者另开一个子域名。

---

## Render 免费版

东南亚（新加坡）区域用 [`deploy/render-sea.yaml`](render-sea.yaml)。根目录的 [`render.yaml`](../render.yaml) 是原来的配置，没有指定区域，保持不变。

1. 登录 [Render](https://dashboard.render.com)，用 GitHub 账号授权。
2. **New → Blueprint**，选 `GameNest` 仓库，**Blueprint Path 填 `deploy/render-sea.yaml`**（留空就会用根目录的 `render.yaml`），点 **Apply**。
   - 如果提示免费版不支持 `singapore`，在 `deploy/render-sea.yaml` 里把 `region` 改成 `oregon` 再推送（延迟会变成约 200ms）。
3. 部署完成后，打开 Render 给的 `https://gamenest-sea-xxxx.onrender.com` 测试。
4. （可选）自定义域名：服务的 **Settings → Custom Domains** 添加域名，然后按页面提示在你的 DNS 加一条 CNAME。HTTPS 证书自动签发。

之后每次推送到 `master` 都会自动重新部署（部署会清空房间）。

---

## Oracle Cloud 永久免费 VM

### 1. 开一台 VM
1. 注册 [Oracle Cloud](https://www.oracle.com/cloud/free/)，**主区域（Home Region）选 Singapore**。注册后不能再改。需要信用卡验证，不会扣钱。
2. **Compute → Instances → Create instance**：
   - Image：**Canonical Ubuntu 24.04**（22.04 也可以）
   - Shape：**Ampere (VM.Standard.A1.Flex)**，1 OCPU / 6 GB 内存就足够
     - 提示 *Out of capacity* 就过一阵再试，或者先用 `VM.Standard.E2.1.Micro`（x86，也是免费的）
   - 下载或粘贴 SSH 公钥
3. 记下实例的 **Public IP**。

### 2. 开放 80 / 443 端口（控制台）
**Networking → Virtual Cloud Networks →** 你的 VCN **→ Security Lists → Default Security List → Add Ingress Rules**，加两条：

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

VM 自己的防火墙由脚本处理。3000 端口不要对外开。

### 3. 域名
在你的 DNS 加一条 **A 记录**：`play.sitehustle.my` → VM 的 Public IP。
用 Cloudflare 的话先设成 **DNS only（灰色云）**，等证书签好再决定要不要开代理。

### 4. 运行安装脚本
```bash
ssh ubuntu@<Public IP>
curl -fsSL https://raw.githubusercontent.com/yiyang2001/GameNest/master/deploy/oracle/setup.sh -o setup.sh
bash setup.sh play.sitehustle.my
```
脚本会做这些事（可以重复运行）：
- 安装 Node.js 22 和 Caddy；
- 把代码放到 `/opt/gamenest`，以 `gamenest` 用户运行；
- 把 GameNest 注册成 systemd 服务，开机自启、崩溃自动重启；
- 用 Caddy 提供 HTTPS，证书自动签发、自动续期；
- 在 VM 防火墙上打开 80 / 443 端口。

**VM 上已经有别的服务也可以装：**
- 脚本开始前先检查端口。3000 被占用，或者 80/443 被 Caddy 以外的程序（比如 Nginx）占用，就直接停下，什么都不改。3000 被占用时可以换一个端口：`GAMENEST_PORT=3100 bash setup.sh play.sitehustle.my`。
- 已有的 Caddy 配置会保留：GameNest 写在单独的 `/etc/caddy/gamenest.caddy`，主配置里只加一行 `import`。原来的 Caddyfile 会备份成 `Caddyfile.bak.<时间>`；新配置检查不通过就自动恢复原样。

完成后打开 `https://play.sitehustle.my`。DNS 生效后的第一次访问，Caddy 会签证书，可能要等几秒。

### 日常操作
```bash
bash /opt/gamenest/deploy/oracle/update.sh   # 拉最新代码并重启（会清空房间）
sudo journalctl -u gamenest -f               # 看日志
sudo systemctl restart gamenest              # 重启
```

### 防止免费 VM 被回收
Oracle 规定：免费账号的 VM 如果连续 7 天 CPU、网络、内存使用率都低于 20%，可能会被回收。游戏服务器大部分时间都很闲，很容易符合这个条件。
常见做法是把账号升级成 **Pay As You Go**：只要用量不超出免费额度，费用还是 0。升级前请看官方说明确认最新规则：
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)。
