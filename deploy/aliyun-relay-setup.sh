#!/usr/bin/env bash
# 在 Ben 的阿里云主机上装「我们提供的模型服务」= relay/ 这个中转。
#
# 用法(在 Mac 上,仓库根目录):
#   1) 先把代码同步上去(这一步在 Mac 上跑,不在服务器上):
#        rsync -a --delete --exclude node_modules --exclude '*.sqlite*' \
#          relay/ aiboo-server:/opt/relay/app/
#   2) 再跑这个脚本(**域名必须给**,2026-10-21 起脚本里不带缺省;我们那台的域名在 deploy/release-endpoints.env):
#        ssh aiboo-server 'RELAY_DOMAIN=api.aibooo.cn bash -s' < deploy/aliyun-relay-setup.sh
#   3) 脚本会停在「上游 Key 还没填」那一步。**Ben 自己**在服务器上填:
#        ssh aiboo-server
#        nano /opt/relay/.env      # 把 RELAY_UPSTREAM_KEY= 后面补上 DeepSeek 的 Key
#                                  # (要 GPT / 豆包的话,再填 RELAY_OPENAI_KEY / RELAY_DOUBAO_KEY)
#        systemctl restart relay
#      这一步不能由助手代做(凭据只有 Ben 能碰),脚本也不会打印这个值。
#   4) 领一个令牌试试(在服务器上,管理接口只认回环):
#        curl -s -X POST 127.0.0.1:8795/admin/tokens \
#          -H 'content-type: application/json' -d '{"account":"ben","device_id":"mac-1"}'
#
# 前提:
#   - DNS 里 api.aibooo.cn 的 A 记录指到这台机器(和 js / echo / lk 三个同一套做法);
#   - 服务器上有 node >= 24(`node:sqlite` 要);
#   - Caddy 在跑(80/443 由它占着,证书自动签)。
#
# 安全:中转只监听 127.0.0.1;外面那一层由 Caddy 进来,而且 Caddy **只放行**
# /v1/*、/register-device、/health、/updates/* 四条路 —— /admin/* 从公网压根到不了。
#
# /updates/*(2026-09-18 热更新)是**只读的静态目录** /var/lib/relay/updates:
# 一份 latest.json + 按版本号分目录的产物。发版在 Mac 上跑 deploy/publish-update.sh,
# 它用 rsync 把这一棵推上来 —— **中转进程自己从不往里写**。
# 那里面没有任何用户数据、没有任何密钥,所以它是公开的(刚装完还没领令牌的机器也要查得到更新);
# 防"装到别人给的包"的那道门在客户端:清单里每件产物钉着 sha256,且产物必须与清单同源。

set -euo pipefail

# 域名必须给(自建中转):ssh 主机 'RELAY_DOMAIN=relay.example.com bash -s' < deploy/aliyun-relay-setup.sh
# 给了之后,电脑端在 ~/.dsh/workbench/model.json 填 relay_url(见 docs/开源-对外连接清单-2026-10-21.md)。
# 不带缺省(2026-10-21,局域网 M7):开源仓库里不该有一个指向我们那台的默认值,漏给就停,不猜。
DOMAIN="${RELAY_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  echo "要给中转的域名:ssh 主机 'RELAY_DOMAIN=你的域名 bash -s' < deploy/aliyun-relay-setup.sh" >&2
  exit 2
fi
PORT=8795
APP_DIR=/opt/relay/app
DATA_DIR=/var/lib/relay
UPDATES_DIR=/var/lib/relay/updates
ENV_FILE=/opt/relay/.env

echo "== 1/6 检查 node =="
# 2026-09-17 实装时发现:那台机器系统 node 是 v20(还有别的站在用它,不能换)。
# 中转要 >= 24(node:sqlite)。所以自己装一份独立的到 /opt/node24,只给中转用,系统 node 一个字不动。
NODE_VERSION=24.19.0
NODE_DIR=/opt/node24
NODE_BIN="$NODE_DIR/bin/node"
if [ ! -x "$NODE_BIN" ] || [ "$("$NODE_BIN" -p 'process.versions.node')" != "$NODE_VERSION" ]; then
  echo "装独立的 node $NODE_VERSION 到 $NODE_DIR(约 50MB,国内镜像)"
  TMP=$(mktemp -d)
  TARBALL="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL --retry 3 -o "$TMP/$TARBALL" "https://npmmirror.com/mirrors/node/v$NODE_VERSION/$TARBALL" \
    || curl -fsSL --retry 3 -o "$TMP/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/$TARBALL" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "node $("$NODE_BIN" -v) 可以(在 $NODE_DIR,不动系统的 node)"

echo "== 2/6 检查代码同步过来了没有 =="
if [ ! -f "$APP_DIR/server/index.cjs" ]; then
  echo "$APP_DIR 里没有代码。先在 Mac 上跑这一行再来:" >&2
  echo "  rsync -a --delete --exclude node_modules --exclude '*.sqlite*' relay/ aiboo-server:$APP_DIR/" >&2
  exit 1
fi

echo "== 3/6 建用户与目录 =="
# 中转握着上游 Key,不该用 root 跑。
id -u relay >/dev/null 2>&1 || useradd --system --home-dir /opt/relay --shell /usr/sbin/nologin relay
mkdir -p "$DATA_DIR" "$UPDATES_DIR" /opt/relay
chown -R relay:relay "$DATA_DIR" /opt/relay
# 热更新的产物目录(2026-09-18)。**由 Mac 上的 publish-update.sh 经 rsync 写**,
# 中转进程只读它 —— 所以属主给推产物的那个账号(默认 root,即 ssh aiboo-server 的身份),
# 中转靠"其他人可读"读得到。这样中转进程哪天被人搞了也改不动要发给全体用户的安装包。
chmod 755 "$UPDATES_DIR"

echo "== 4/6 装依赖(只有 express)=="
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
chown -R relay:relay "$APP_DIR"

echo "== 5/6 .env 与 systemd =="
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENV'
# 上游 DeepSeek 的 API Key。**只有 Ben 填**,填完 `systemctl restart relay`。
# 这个值不进仓库、不进日志、不进任何接口的返回。
RELAY_UPSTREAM_KEY=

# 上游地址。一般不用改。
RELAY_UPSTREAM_URL=https://api.deepseek.com

# ——————————— 另外两家上游(2026-09-22,派活走接口那只手)———————————
# 中转按**模型名前缀**挑上游:gpt-* / o1..o4 → OpenAI,doubao-* / ep-* → 火山方舟,
# 其余 → 上面那家 DeepSeek。**哪一家没填 Key,那一家就一律 503**
# (「服务器没配 X」),绝不改发给别家。填完 `systemctl restart relay`,
# 用 `curl http://127.0.0.1:8795/health` 看 providers 那一格(只回布尔,不回值)。

# OpenAI(GPT 那一家;图片生成 POST /v1/images 也走它)。
RELAY_OPENAI_KEY=
# 地址一般不用改。走代理时**写到不含 /v1 为止**。
RELAY_OPENAI_BASE=https://api.openai.com

# 豆包 / 火山方舟。
RELAY_DOUBAO_KEY=
# ★ 方舟的路里**没有 /v1**,它的 base 自带 /api/v3 —— 这一行写到 /api/v3 为止。
RELAY_DOUBAO_BASE=https://ark.cn-beijing.volces.com/api/v3
# 模型名 → 接入点 id 的映射(方舟上很多模型是按接入点调的)。
# 逗号 / 分号 / 换行都当分隔符;映射不到就原样发过去,让方舟自己说没这个模型。
# 例:RELAY_DOUBAO_ENDPOINTS=doubao-pro-32k=ep-20260922-xxxxx,doubao-lite-4k=ep-20260922-yyyyy
RELAY_DOUBAO_ENDPOINTS=

# 每个令牌(= 每台设备)每天最多花多少**元**(2026-09-23 起额度按钱算,缺省 5)。
# 要放宽就改这里再 restart。旧的 RELAY_DAILY_TOKEN_LIMIT 已废弃、被忽略(写着的话启动日志会提醒)。
RELAY_DAILY_COST_LIMIT_CNY=5

# 价格表:「缓存命中,缓存未命中,输出」三个数,单位 元 / 百万 tokens。**不写就用代码里的缺省价**
# (DeepSeek 官方高峰价,2026-09-23 核对,出处见 relay/server/pricing.cjs 文件头)。
# DeepSeek 调价时改这几行再 restart;写坏了按缺省价算,/health 的 warnings 里会说。
# RELAY_PRICE_DEEPSEEK_FLASH_CNY=0.04,2,8
# RELAY_PRICE_DEEPSEEK_PRO_CNY=0.3,9,27
# OpenAI / 豆包的缺省是没核过的保守值,要记准就写上实价:
# RELAY_PRICE_OPENAI_CNY=20,20,120
# RELAY_PRICE_DOUBAO_CNY=4,4,40

# 同一个 IP 每小时最多领几个令牌(注册账号也数在这一档里)/ 一个账号最多几台设备。
RELAY_REGISTER_PER_HOUR=10
RELAY_MAX_DEVICES_PER_ACCOUNT=10

# ——————————————— 账号(2026-09-21)———————————————
# 账号从这一版起在服务器上:/v1/account/{register,login,logout,me,password,devices}。
# 密码只存 scrypt 加盐哈希,会话令牌只存 sha256。**这一组没有任何要填的密钥。**
#
# 老客户端那条「不带账号会话就领设备令牌」的路还开着吗。
#   开着(默认):部署这一版的那一刻,用户那台 Mac 上跑的还是旧插件,
#                关掉等于部署完他的模型服务与电话当场全挂。
#   关掉(=0): 房间边界彻底收口 —— 从此只有登录过的账号才领得到设备令牌。
# **全网(Ben 那台 Mac + 他手上的手机包)都升到带账号的版本之后,把这里改成 0 再 restart。**
# 这一刀由人拍板,见 docs/交接-0921-账号搬服务器.md 最后一节。
RELAY_ALLOW_LEGACY_REGISTER=1

RELAY_PORT=8795
RELAY_BIND=127.0.0.1
RELAY_HOME=/var/lib/relay

# 热更新的产物目录(2026-09-18)。发版由 Mac 上的 deploy/publish-update.sh 推上来;
# 中转只读,不写。改这里要连 Caddy 的放行一起想清楚。
RELAY_UPDATES_DIR=/var/lib/relay/updates

# ——————————————— 通道层的钥匙串(2026-09-21)———————————————
# 以前这几把是 Ben 手工拷进每台 Mac 的 ~/.dsh/workbench/channel.json 的。
# 现在只在这台服务器上:客户端登录后向 GET /v1/channel-credentials 取。
# **这几行的值同样只有 Ben 填**,助手不代填、脚本不打印。
#
# LiveKit:api key / secret **永远不下发**给客户端——客户端要进房就来 POST /v1/channel-token,
# 中转替它签一张只够进它自己那一间房的短命凭证。
RELAY_CHANNEL_LIVEKIT_URL=
RELAY_CHANNEL_LIVEKIT_API_KEY=
RELAY_CHANNEL_LIVEKIT_API_SECRET=
# 进房凭证的有效期(秒)。默认 7 天,与工作台那边同一个数。
RELAY_CHANNEL_TOKEN_TTL=604800
# 房间名前缀。房间名 = 前缀 + sha256(账号作用域) 前 16 位,由中转算,客户端说了不算。
# 2026-09-21 起「账号作用域」对登录过的账号是 `acct:<16 字节随机 id>`(猜不出来),
# 对还没迁移的老客户端仍是它自己报的那个名字 —— 两者永远算不出同一间房。
RELAY_CHANNEL_ROOM_PREFIX=wb-

# 火山识别(ASR)。**这两样会下发给客户端**——识别是客户端直连火山的流式 WebSocket,
# 绕一趟我们的服务器会把延迟和带宽都翻一倍。下发时带到期时间,客户端只存内存、不落盘。
RELAY_CHANNEL_VOLC_ASR_APP_ID=
RELAY_CHANNEL_VOLC_ASR_ACCESS_TOKEN=
# 一般不用填,缺省 volc.bigasr.sauc.duration。
RELAY_CHANNEL_VOLC_ASR_RESOURCE_ID=

# 火山合成(TTS)。同上。本机 8792 在设置页没填时用它(2026-09-23,docs/交接-0923-语音合成用下发钥匙.md)。
# **APP_ID / ACCESS_TOKEN 空着就复用上面识别那组**(火山同一个应用可同时开两样);
# RESOURCE_ID / CLUSTER 一般不填,空着由合成那端用自己的缺省(不会套识别的 resource)。
RELAY_CHANNEL_VOLC_TTS_APP_ID=
RELAY_CHANNEL_VOLC_TTS_ACCESS_TOKEN=
RELAY_CHANNEL_VOLC_TTS_RESOURCE_ID=
RELAY_CHANNEL_VOLC_TTS_CLUSTER=

# 下发出去的火山凭据在客户端内存里活多久(秒)。也就是"服务器上换了钥匙,多久全网跟上"。
RELAY_CHANNEL_CREDENTIAL_TTL=3600

# ——————————————— 搜索代理(2026-09-21,资讯与播客)———————————————
# 工作台每天早上按项目搜一轮资讯,搜索走这台服务器代发(POST /v1/search)。
# **这把 Key 同样只有 Ben 填**,助手不代填、脚本不打印;不配也起得来,
# 那条路会回 503「这台服务器还没配搜索服务」,工作台那边整块如实缺席、不编条目。
#
# 默认这家:博查(open.bochaai.com,国内直连、按次计费、有免费试用资源包)。
# 选型、价格与申请方式见 docs/交接-0921-资讯与播客.md 第一节。
RELAY_SEARCH_KEY=
# 换别家时这两行一起改(回包形状认博查 / 扁平数组 / SerpAPI 三种)。
RELAY_SEARCH_PROVIDER=bocha
RELAY_SEARCH_URL=https://api.bochaai.com/v1/web-search
# 每台设备每天最多搜几次。**搜索按次计费,这道闸挡的是跑飞的循环**;
# 它与 RELAY_DAILY_COST_LIMIT_CNY 是两本账(搜索花的是搜索服务的钱)。
RELAY_SEARCH_DAILY_LIMIT=60
RELAY_SEARCH_TIMEOUT_MS=12000

# ── 远程错误上报的管理员令牌(2026-09-22,诊断包与远程上报那张卡)────────────
#
# 用户那台机器出错时会 POST /v1/diag/report(拿它自己的设备令牌)。统筹要把这些报错
# 拉下来看,走的是 GET /v1/diag/reports —— **那条路只认这一把令牌**。
#
# 没填 = 那条路整个关着(503),不是"谁都能看"。写的那条(/v1/diag/report)不受影响,
# 报错照样进库、照样 30 天自动清 —— 只是没人读得到,直到 Ben 填上这一行。
#
# 值随便起一串长的随机串,**只有 Ben 填**(仓库里不出现真值)。生成一把:
#   openssl rand -base64 32
RELAY_ADMIN_TOKEN=

# ── 协作区企业微信机器人(2026-10-21,docs/交接-1021-协作区中转底座.md)──
# 企微后台「接收消息」那一页给的 Token 与 EncodingAESKey(43 位);回调地址填
#   https://api.aibooo.cn/v1/wecom/callback
# 没填 = 机器人回调整个关着(503),工作室 / 频道 / 收件箱不受影响。只有 Ben 填,仓库里不出现真值。
RELAY_WECOM_TOKEN=
RELAY_WECOM_ENCODING_AES_KEY=
ENV
  chown relay:relay "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE(上游 Key 与通道那几把都还是空的)"
else
  # 已经有 .env 的机器**一个字不改**(里头有 Ben 填的真值)。但 2026-09-21 起多了
  # 一组 RELAY_CHANNEL_*,老文件里没有 —— 这里只提醒,不代填、不追加。
  echo "$ENV_FILE 已存在,不动它"
  if ! grep -q '^RELAY_CHANNEL_LIVEKIT_API_KEY=' "$ENV_FILE"; then
    echo "  ⚠️ 这份 .env 里还没有 2026-09-21 新增的 RELAY_CHANNEL_*(通道层钥匙串)。"
    echo "     没有它们,客户端取通道凭据时会拿到「服务器上还没配」——通话连不起来。"
    echo "     变量清单见 docs/交接-0921-通道密钥下发与DSH走中转.md 第三节,由 Ben 自己 nano 进去。"
  fi
  if ! grep -q '^RELAY_SEARCH_KEY=' "$ENV_FILE"; then
    echo "  ⚠️ 这份 .env 里还没有 2026-09-21 新增的 RELAY_SEARCH_*(搜索代理)。"
    echo "     没有它,手机上的「资讯」会如实说「这台服务器还没配搜索服务」——不会编条目,但也没内容。"
    echo "     变量清单与选型/价格见 docs/交接-0921-资讯与播客.md 第一、五节,由 Ben 自己 nano 进去。"
  fi
  if ! grep -q '^RELAY_ADMIN_TOKEN=' "$ENV_FILE"; then
    echo "  ⚠️ 这份 .env 里还没有 2026-09-22 新增的 RELAY_ADMIN_TOKEN(远程错误上报的读取口)。"
    echo "     没有它,用户那头的报错照样进库、照样 30 天自动清,但 GET /v1/diag/reports 是 503——谁也读不到。"
    echo "     生成一把:openssl rand -base64 32;见 docs/交接-0922-诊断包与远程上报.md。"
  fi
  if ! grep -q '^RELAY_WECOM_TOKEN=' "$ENV_FILE"; then
    echo "  ⚠️ 这份 .env 里还没有 2026-10-21 新增的 RELAY_WECOM_*(协作区企业微信机器人)。"
    echo "     没有它,/v1/wecom/callback 是 503;工作室、频道、收件箱照常。见 docs/交接-1021-协作区中转底座.md。"
  fi
fi

cat > /etc/systemd/system/relay.service <<UNIT
[Unit]
Description=Workbench model relay (OpenAI-compatible, upstream DeepSeek)
After=network.target

[Service]
User=relay
Group=relay
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server/index.cjs
Restart=always
RestartSec=3
# 只该读自己那几个目录。
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now relay
systemctl restart relay
sleep 2
systemctl is-active relay && echo "relay 服务已启动"

echo "== 6/6 Caddy =="
cp -n /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-relay-$(date +%Y%m%d%H%M%S)" || true
if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  # 只放行四条路。/admin/* 不在里面 —— 管理接口只能在服务器上 curl 127.0.0.1。
  #
  # 2026-09-18:用量那条接口**不在这张白名单上另开一条**,而是挪进了 /v1(即 /v1/usage)。
  # Ben 真机上「用量 HTTP 404」正是这张清单里没有 /usage —— 白名单每多一条,就多一次
  # 「部署过的机器忘了改 Caddyfile」的机会。这一行以后能不动就不动。
  cat >> /etc/caddy/Caddyfile <<CADDY

$DOMAIN {
	@relay path /v1/* /register-device /health /updates/*
	handle @relay {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
		respond "not found" 404
	}
}
CADDY
else
  # 已经配过 api.aibooo.cn 的那台机器(2026-09-17 装的那一版只放行三条路):
  # 把 /updates/* 补进那一行。**只在这一行确实还没有它时才动**,幂等;改之前的备份在上面那句 cp。
  if ! grep -q 'path /v1/\* /register-device /health /updates/\*' /etc/caddy/Caddyfile; then
    sed -i 's|@relay path /v1/\* /register-device /health$|@relay path /v1/* /register-device /health /updates/*|' /etc/caddy/Caddyfile
    echo "已把 /updates/* 补进 $DOMAIN 的放行清单"
  fi
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
echo "Caddy 已加 $DOMAIN → 127.0.0.1:$PORT(只放行 /v1/*、/register-device、/health、/updates/*)"

echo
echo "本机自检:"
curl -fsS "127.0.0.1:$PORT/health" || true
echo
echo "完成。还差两步,都得 Ben 自己做:"
echo "  1. DNS:$DOMAIN 的 A 记录 → 这台机器的公网 IP(证书首次访问时自动签,约几十秒)"
echo "  2. 上游 Key:nano $ENV_FILE 填 RELAY_UPSTREAM_KEY=,然后 systemctl restart relay"
echo "  2b. 搜索 Key(2026-09-21):同一个文件里填 RELAY_SEARCH_KEY=(博查,见交接-0921-资讯与播客)"
echo "     (填好之后 curl 127.0.0.1:$PORT/health 里的 upstream_configured 会变成 true)"
echo "  2c. 报错读取口(2026-09-22):同一个文件里填 RELAY_ADMIN_TOKEN=(openssl rand -base64 32)"
echo "     之后统筹在这台机器上:curl -s '127.0.0.1:$PORT/v1/diag/reports?limit=20' -H \"Authorization: Bearer \$RELAY_ADMIN_TOKEN\""
