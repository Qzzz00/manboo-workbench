# phone-bridge —— POP 话筒守护进程(跑在树莓派 pizero 上)

**这台派就是实体话筒。** 2026-09-21 起它是 **LiveKit 房间里的一台设备**
(`kind: handset`),不再只是个按键上报器:工人往房里广播 `ring`,**派不响铃、只等人提机**
(2026-09-22 晚 Ben 定:铃由手机 App 出,话筒自己是用来对话的);
拿起听筒 → 发 `call/answer` 并推麦克风音轨;放回去 → 发 `call/hangup` 并撤掉。
通话的嘴和耳朵都在这只听筒上。

分工(Ben 2026-09-21 定):**手机**(外壳里、无线充)管屏和 App;**派**管实体话筒。
「继续用树莓派更多是因为优雅 —— 手机能识别话筒,但无线充的场景下插在手机上很不优雅。」

- 信号协议:`docs/设计-座机信号协议-2026-09-21.md`
- 硬件事实(声卡 VID、GPIO 针脚、Wi-Fi、ssh):`docs/硬件-POP话筒与树莓派桥.md`
- 交接:`docs/交接-0921-树莓派话筒进房.md`
- 老那条链(只有铃)的设计:`docs/设计-来电链-v0.md`

## 文件

| 文件 | 是什么 |
|---|---|
| `phone_state.py` | 纯函数状态机(待机/**可提机接听**/通话),**两条来路一个状态机** |
| `signals.py` | 房间里那几条 JSON 的解析与拼装(跨仓库的那份手抄) |
| `pairing.py` | 配对(`/pair/claim`)与领进房凭证(局域网 / 中转两条路);**进房前先问一次工作台「现在该进哪个房」**(`GET /channel/status`,2026-10-03) |
| `audio.py` | 录放两根管子(`arecord`/`aplay`)、提机/挂机两声确认音(**没有铃**) |
| `room_link.py` | 进房、收 `wb.rpc`、推/撤音轨、订工人的音轨 |
| `popphone.py` | 守护进程:把几根线汇到一个队列,按状态机的动作表执行 |
| `dev/` | **Mac 上的假环境**(没有派、没有 POP、没有工人也能跑一遍),见 `dev/README.md` |
| `provision.py` | **配网**(2026-09-22)的纯逻辑:状态机、nmcli 输出解析、BLE 分帧、日志脱敏 |
| `provisiond.py` | 配网守护进程(**root**,`wb-provision.service`):bluez 的 GATT + 广播、跑 nmcli、写 device.json;兼当换网那条的「root 代办」(Unix socket) |
| `netcfg.py` | **换网**(2026-09-22 晚)的纯逻辑:房间里那条 `netcfg` 消息的编解码、切网看守(回不来就切回老网)、IPC 帧 |
| `wb-provision.service` | systemd **系统级** unit(与用户级的 phone-bridge.service 并存,理由见文件头) |
| `deploy.sh` | 从 Mac 推代码 + 装依赖 + 重启服务 + 自检(**走 ssh**) |
| `sdcard-stage.sh` | **ssh 走不通时那条路**(2026-09-22 夜):把代码铺到 SD 卡启动分区,并打印要追加进 `user-data` 的那段 `runcmd`。只写不删、幂等、不碰 `meta-data`/`cmdline.txt` |
| `sdcard/user-data.example` | cloud-init `user-data` 的**样例**(按文档重建,不是卡上那一份的副本;里面没有任何真密码/钥匙)。看门狗黑匣子的脚本正文也在这儿 |
| `requirements.txt` | 派上要装的三样(livekit / websockets / gpiozero) |
| `phone-bridge.service` | systemd 用户级 unit(开机自启 + 崩溃拉起) |

单测(**不需要派、不需要 livekit**):

```bash
cd phone-bridge && python3 -m unittest discover -p "*_test.py"
```

## 配网(2026-09-22)

座机的网由**手机 App** 配,不再碰 SD 卡、不敲命令。两条路:

- 座机**没网**(开箱第一次):**蓝牙**。`provisiond.py` 广播「工作台座机-XXXX」,
  手机 App 设置 → 座机 → 添加座机。
- 座机**已经在线**(换网):走**房间**那条现成的链路,`room_link.py` 收手机点名发来的
  `netcfg` 请求,交给 root 那半边跑 nmcli。手机 App 设置 → 座机 → 给座机换网络。

装法、真机验证步骤、没做的:`docs/交接-0922-座机配网走App.md`。

## 两条来路

1. **房间**(主路,带音频):LiveKit,`wb.rpc` 上的 `ring` / `ring_end`。要先配对。
2. **8791 的 WS**(兜底,**只有来电没有声音**):来电链 v0 那条,2026-08 起就在跑。
   房间没配起来、或者凭证领不到时派**照样会响** —— 那时拿起听筒只会上报一条
   `/phone/event`,听筒里不会有人说话。留着它是因为「响不响」比「有没有声音」更要紧。

## 配对(一次性,之后开机直用)

派是账号里的一台设备,走的就是手机那一套:

1. 电脑端 设置 → 手机与设备 → 生成配对码(6 位,5 分钟有效、一次性);
2. 派上跑一次:

```bash
ssh -i ~/.ssh/remarkable_paper_pro ben@<派IP> \
  'cd ~/phone-bridge && venv/bin/python popphone.py --pair 123456'
```

令牌写进 `~/phone-bridge/device.json`(**0600**,只有这一份,丢了就重配)。
之后每次开机自动拿它领进房凭证:**局域网优先**(`POST {8791}/channel/token`),
不通时走中转(`POST {中转}/v1/channel-token`;中转地址取 unit 的 `WORKBENCH_RELAY`、`device.json` 的 `relay`(手机配网写)或 `relay_base`(`--relay-login` 写),三处都空就只走 8791 —— 2026-10-21 起 unit 里缺省就是空)。
手上那张没到期(默认 7 天)就一个包都不发 —— 那是 Mac 关着时派唯一的指望。

`deploy.sh` 也能顺带配对:`./deploy.sh <派IP> --pair 123456`。

### 公网那条路的门票:`--relay-login`(2026-09-22)

出了局域网(或 Mac 关着)时,进房凭证向中转 `WORKBENCH_RELAY`(线上是 `https://api.aibooo.cn`)领,
要的是**账号里这台设备的中转令牌**。在派上跑一次,输账号密码(不回显、不落盘):

```bash
ssh -t -i ~/.ssh/remarkable_paper_pro ben@<派IP> \
  'cd ~/phone-bridge && WORKBENCH_RELAY=https://api.aibooo.cn venv/bin/python popphone.py --relay-login'
```

它登录 → `POST /register-device`(device_id 用配对时那份,类型 `handset`)→ 注销会话,令牌写进
`device.json` 的 `relay_token`。类型这一项 2026-09-23 之前报的是 `other`,中转据此签不出
凭证里的 `wb_kind`,工人把这只话筒当普通手机(手机的座机页说「座机不在线」)。
**已经领过令牌的派:把这条命令原样再跑一次**就把类型改过来了(同一个 device_id 重领
只是换钥匙,不算新设备)。**前提**:中转服务器配了 `RELAY_CHANNEL_LIVEKIT_*`,否则它签不出凭证
(客户端会看到「服务器上还没配 LiveKit」);而且 Mac 那头也得用服务器下发的凭据,两边才在同一间房。

## 部署(从 Mac)

```bash
./phone-bridge/deploy.sh 172.20.10.4
```

推代码 → `venv` 装 `requirements.txt` → 自检(livekit / websockets / gpiozero /
arecord / aplay / POP 在不在)→ 装服务并重启 → 打最后 20 行日志和内存占用。

⚠️ **派要连一个有互联网的 2.4G 网**。这一版比以前多一样:`pip install livekit`
要去 PyPI 拉一个 10.6MB 的 wheel(aarch64 有预编译,不会去编 Rust)。
iPhone 热点通外网,照旧连热点就行;挪到只有局域网的 Wi-Fi 上这一步会卡住,
而卡住的样子看起来像"ssh 没反应"。**Zero 2W 上这一步要几分钟,别当成死机。**

## 运行(systemd 用户级服务,开机自启)

**别再用 `nohup` 手工起。** 2026-08-21 就是手工起的,派 21:04 一重启进程就永久没了,
按 POP 按键从此没反应,直到 8/24 才查出来——链路第一段根本没人在监听。

- **用户级而不是系统级**:派上 `sudo` 要密码。`loginctl enable-linger` 用户可自助开启
  (无需 root),开了之后用户 systemd 在开机时就起来,不用登录。
- 崩溃自动拉起(`Restart=always`,实测 `kill -9` 后 6 秒内回来)。
- 日志在 `~/phone-bridge/popphone.log`(unit 里用 `append:`)。

```bash
systemctl --user status phone-bridge     # 看状态
systemctl --user restart phone-bridge    # 改完代码重推后重启
journalctl --user -u phone-bridge -n 50  # 看 systemd 侧的日志
```

## 配置(都在 unit 的 `Environment=` 里,不动代码)

| 变量 | 默认 | 干什么 |
|---|---|---|
| `WORKBENCH_WS` | `ws://MacBook-Air-1864.local:8791` | 工作台地址。**用 mDNS 主机名不用 IP** |
| `AUDIO_DEV` | `plughw:CARD=Phone` | 声卡。按名字选,热插拔之后序号会变 |
| `WORKBENCH_RELAY` | 空 | 中转地址。空着就不走那条路(不猜一个域名) |
| `DEVICE_NAME` | `座机话筒` | 配对时报的名字,设置里那一行显示它 |
| `PB_RECORD_CMD` / `PB_PLAY_CMD` / `PB_WAV_CMD` | 空 | **只为假环境**:把 arecord/aplay 换成别的命令 |
| `PB_PLAY_BUFFER_MS` / `PB_PLAY_PERIOD_MS` | `120` / `20` | 听筒的 ALSA 缓冲(2026-09-23)。**设成 0 = 不加参数,回到老行为**。听着爆音、断续就先设 0,再按 200/300 往上找 |
| `PB_RECORD_BUFFER_MS` / `PB_RECORD_PERIOD_MS` | `120` / `20` | 麦克风那一侧同理 |
| `PB_FILLER_WAV` | 空(**不本地垫**,2026-09-23 晚起) | 缓冲语改由电脑上的工人用当前音色说、走同一条音轨。要恢复派上本地垫:明设 `/var/lib/phone-bridge/filler.wav`(同时关掉工人那边的 `WORKBENCH_CHANNEL_WORKER_FILLER`,否则两句叠)。文件不在也不垫 |
| `PB_GREETING_WAV` | **空(不放)** | 提机那一句(2026-09-23)。**2026-09-23 下午起缺省关掉**:这一份是死文件、跟不了音色,而工人那句跟着当前音色走 —— 两边一起放,他在一通电话的头一秒里听见两个嗓子(维护者 14:20 真机)。要重新开:自己放一份 48k/单声道/16 位的 wav 进去,并**明着**设成那个路径 |

**缓冲语那段 wav 怎么来**:它得是 **48000Hz、单声道、16 位**的 WAV(格式不对 phone-bridge
如实记一行、不垫,**绝不自己重采样** —— 变调的她没人会想到是这里干的)。内容是一句
「我想想」,跟着事务官当前音色走,由统筹在 Mac 上从 8792 合一段拷进派。
这一段**故意不在安装包里**:音色换了它就该跟着换,打进包里只会变成两个嗓子。

**提机那一句(`greeting.wav`)——「缺省不放」了**(2026-09-23 下午):
维护者 14:20 真机原话「音色和最开始听到的『吩咐』二字不一致」。
派上这一份是用当时那个音色合出来的**死文件**,换了音色跟不上;工人那句是预合成 +
当前音色,而且缓存命中时**整条跳过 TTS**,已经够快。两边一起放的结果就是
一通电话的头一秒里两个人在说话。所以:`sdcard-stage.sh` 不再铺它、不再装它,
并且会**删掉派上装过的那一份**(要让那一行跑到,得换 instance-id 重铺卡)。
代码一行没删,`PB_GREETING_WAV` 明着指一份 wav 就还能开。

仓库里那一份还在(`phone-bridge/assets/greeting.wav`),留给要手动开这个兜底的人。
内容是「老板,有什么吩咐?」,格式要求同上;换了音色要跟着重合一份 —— 合法与缓冲语同一条:
`curl -s -X POST http://127.0.0.1:8792/api/tts -H 'content-type: application/json' -d '{"text":"老板,有什么吩咐?","scene":"chat"}' -o g.mp3`,
再 `ffmpeg -i g.mp3 -ar 48000 -ac 1 -c:a pcm_s16le greeting.wav`(掐掉头尾静音)。
**称呼在这一句里固定是「老板」**:轮换(「老板 / 姚总」按天换)在工人那边,
派上这句是死的 wav 跟不了表;工人那句一到就把它掐掉,他听见的称呼以工人那句为准。

**这两手的代价**:ALSA 缓冲调小了 Zero 2W 一忙就 underrun(听筒里断续的爆音);
缓冲语垫早了会和她抢话(所以有 0.7 秒的门,和手机那一侧同一个数)。

**默认地址用 mDNS 主机名不用 IP**:热点是 DHCP,Mac 的地址会变,写死 IP 之后断了
只会一直刷「断线,重连」,从日志看不出是地址错了。派侧 2026-08-24 实测能解析
`MacBook-Air-1864.local`(反方向 Mac 解析 `pizero.local` 不通,是另一回事)。
派 IP 是热点 DHCP 分的,会变;找法见硬件文档「连接方式」。
