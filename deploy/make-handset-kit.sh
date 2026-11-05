#!/usr/bin/env bash
# 打一份「座机更新包」给不在维护者手边的那台树莓派话筒(2026-10-03,维护者:「座机的更新你得单独给我准备一份,
# 它现在不在我手上,我发给运营同学处理」)。产出 dist/座机更新包-<版本>.zip:phone-bridge 要推到派上的那几个文件
# + 一键脚本 更新座机.sh(套一层 ssh 壳,只问一次密码)+ 人话说明。**包里绝不带密钥 / 密码**,登录凭据由维护者当面给。
#   bash deploy/make-handset-kit.sh 0.4.90
set -euo pipefail
VERSION="${1:?要哪个版本?bash deploy/make-handset-kit.sh 0.4.90}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"; NAME="座机更新包-$VERSION"; STAGE="$(mktemp -d)/$NAME"
mkdir -p "$STAGE/phone-bridge" "$OUT"
cd "$ROOT/phone-bridge"
cp popphone.py phone_state.py signals.py pairing.py audio.py room_link.py requirements.txt \
   provision.py provisiond.py netcfg.py wb-provision.service phone-bridge.service deploy.sh README.md "$STAGE/phone-bridge/"
cp -R assets "$STAGE/phone-bridge/"
cp "$ROOT/deploy/handset-kit/更新座机.sh" "$ROOT/deploy/handset-kit/怎么更新座机.md" "$STAGE/"
sed -i '' "s/座机更新包-[0-9.]*/座机更新包-$VERSION/g; s/话筒)更新 · [0-9.]*/话筒)更新 · $VERSION/" "$STAGE/怎么更新座机.md"
chmod +x "$STAGE/更新座机.sh"
# 扫一遍不许有凭据(私钥块、看着像密码的赋值);扫到就不出包。
if grep -rIl -E "BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|^(PASSWORD|PASSWD|SECRET|TOKEN)=" "$STAGE" >/dev/null 2>&1; then
  echo "× 包里扫到像凭据的东西,不出包:"; grep -rIl -E "BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|^(PASSWORD|PASSWD|SECRET|TOKEN)=" "$STAGE"; exit 1
fi
rm -f "$OUT/$NAME.zip"
(cd "$(dirname "$STAGE")" && zip -qr "$OUT/$NAME.zip" "$NAME" -x '*/__pycache__/*' '*.pyc')
echo "✓ $OUT/$NAME.zip($(du -h "$OUT/$NAME.zip" | cut -f1))—— 发给拿着座机的人;登录派的密钥 / 密码另外给,不在包里。"
