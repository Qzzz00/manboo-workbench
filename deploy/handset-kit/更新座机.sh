#!/usr/bin/env bash
# 更新座机(树莓派话筒)。在 Mac 上跑,不在派上跑:
#   bash 更新座机.sh <派的IP>
# 登录派要么用维护者给你的密钥文件(放在 ~/.ssh/remarkable_paper_pro),要么输派的登录密码。
# 密钥 / 密码都不在这个包里 —— 找维护者要。整个过程只会让你输一次密码。
set -euo pipefail
HOST="${1:?用法:bash 更新座机.sh <派的IP>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PI_USER="${PI_USER:-ben}"
export SSH_KEY="${SSH_KEY:-$HOME/.ssh/remarkable_paper_pro}"
[ -f "$SSH_KEY" ] && echo "用密钥登录:$SSH_KEY" || echo "没有密钥文件,会让你输一次派的登录密码(用户 $PI_USER)"
# 一次登录、多次复用:给 ssh / scp 套一层壳,共用一条连接,免得 deploy.sh 里每一步都问密码。
SHIM="$(mktemp -d)"; CTL="$SHIM/ctl"
cat > "$SHIM/ssh" <<SH
#!/usr/bin/env bash
exec /usr/bin/ssh -o ControlMaster=auto -o ControlPath="$CTL-%r@%h:%p" -o ControlPersist=600 -o StrictHostKeyChecking=accept-new "\$@"
SH
cat > "$SHIM/scp" <<SH
#!/usr/bin/env bash
exec /usr/bin/scp -o ControlMaster=auto -o ControlPath="$CTL-%r@%h:%p" -o ControlPersist=600 -o StrictHostKeyChecking=accept-new "\$@"
SH
chmod +x "$SHIM/ssh" "$SHIM/scp"
export PATH="$SHIM:$PATH"
trap 'ssh -O exit -o ControlPath="$CTL-%r@%h:%p" "$PI_USER@$HOST" >/dev/null 2>&1 || true; rm -rf "$SHIM"' EXIT
bash "$HERE/phone-bridge/deploy.sh" "$HOST"
echo
echo "✓ 座机更新完。拿起话筒按一下,工作台那头应能看到它进房;看不到就把上面「自检」那几行发给维护者。"
