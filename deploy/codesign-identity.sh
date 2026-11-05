#!/usr/bin/env bash
#
# 一张**不随构建变**的代码签名身份,给「工作台.app」与「安装工作台.app」用。
#
# 为什么要有这个东西
# ──────────────────
# macOS 的 TCC(就是「系统设置 → 隐私与安全性 → 辅助功能」那张表)记的**不是路径,
# 是签名**——准确说是签名里那条 designated requirement(DR)。ad-hoc 签名
# (`codesign --sign -`)每构建一次就换一份,系统于是每次都把壳当成一个**新 App**,
# 上一次给的辅助功能授权就作废了,用户得手动去删了再加。
#
# 办法:在这台机器的登录钥匙串里放**一张长期的自签代码签名证书**,以后每次构建都用它签。
# 同一张证书 ⇒ 同一条 DR ⇒ 系统认得这还是那个 App ⇒ **更新不掉授权**。
#
# 这只解决「本机与内测」。对外发布要 Apple Developer ID + 公证,
# 见 docs/交接-0918-壳稳定签名.md 第五节。
#
# 怎么用
# ──────
#   bash deploy/codesign-identity.sh              # 确保证书在(已经有就一个字不动)
#   bash deploy/codesign-identity.sh --check      # 只看一眼,不改任何东西(0=有,1=没有)
#   bash deploy/codesign-identity.sh --print      # 有就打印指纹,没有就退出码 1
#   bash deploy/codesign-identity.sh --resolve    # 给构建脚本用:打印这次该用哪个身份
#
# 认的环境变量
#   WORKBENCH_CODESIGN_IDENTITY   身份名。缺省「工作台本机签名」。
#                                 以后有了 Developer ID,就把它设成那个名字,
#                                 构建脚本一个字不用改。
#   WORKBENCH_CODESIGN_KEYCHAIN   证书放哪个钥匙串。缺省登录钥匙串。
#                                 (临时钥匙串里验证这个脚本时用它。)
#   WORKBENCH_KEYCHAIN_PASSWORD   钥匙串密码,只给 set-key-partition-list 那一步用。
#                                 不给就交互问;都没有就跳过那一步(见下面「那一步是干嘛的」)。
#
# **这个脚本要在真机上由本人跑一次**,不是构建的一环:它会往登录钥匙串里写东西,
# 而且可能弹一次系统的钥匙串询问框——那种事只能本人点。

set -euo pipefail

IDENTITY_NAME="${WORKBENCH_CODESIGN_IDENTITY:-工作台本机签名}"
KEYCHAIN="${WORKBENCH_CODESIGN_KEYCHAIN:-}"
VALID_DAYS="${WORKBENCH_CODESIGN_DAYS:-3650}"   # 10 年。自签证书没有 825 天那条上限
                                                # (那条只管 TLS);到期后签不了新的,
                                                # 重跑这个脚本换一张就行(换张证书 = 换条 DR,
                                                # 那一次要重新授权一次,十年一次能接受)。

MODE="ensure"
case "${1:-}" in
  --check) MODE="check" ;;
  --print) MODE="print" ;;
  --resolve) MODE="resolve" ;;
  --help|-h) sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "不认识的参数:$1(能用的是 --check / --print / --resolve / --help)" >&2; exit 1 ;;
esac

# ── 钥匙串参数:给了就只在那一个里找,没给就走系统的搜索路径 ──
# (不用数组:macOS 自带的是 bash 3.2,`"${a[@]}"` 碰上空数组 + set -u 会直接报错。)

# 在钥匙串里找这个名字的身份,找到就打印它的 SHA-1 指纹。
#
# **不能靠 `security find-identity` 里的那个名字去匹配。** 它一行长这样:
#   1) C684796C5A950A89D0FA3B68BB4888F6EBF400D3 "<unknown>" (CSSMERR_TP_NOT_TRUSTED)
# 名字位置是 `<unknown>` —— 证书的 CN 是 UTF8String(里头有中文)时 `security` 就是
# 这么打的,不是证书坏了(`find-certificate -Z` 能看到 labl 是正确的 UTF-8 字节)。真踩过。
# 所以走两步:`find-certificate -c 名字` 拿指纹 → 再到 `find-identity` 的指纹清单里对一下,
# 确认这张证书**配着私钥**(有证书没私钥签不了)。指纹是纯十六进制,不受编码影响。
#
# 顺带:那个 `CSSMERR_TP_NOT_TRUSTED` **不是毛病** —— 自签证书本来就不在任何信任链里。
# codesign 照签不误(真跑过,见交接第三节),它只影响 Gatekeeper,
# 而 Gatekeeper 那一关本来就得靠公证,不是靠信任设置能糊弄过去的。
sec() {
  if [ -n "$KEYCHAIN" ]; then security "$@" "$KEYCHAIN" 2>/dev/null
  else security "$@" 2>/dev/null; fi
}

find_identity_hash() {
  local identity_hashes cert_hash
  identity_hashes="$(sec find-identity | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{40}$/) print $i }')"
  [ -n "$identity_hashes" ] || return 0
  sec find-certificate -a -c "$IDENTITY_NAME" -Z \
    | awk '/^SHA-1 hash: /{ print $3 }' \
    | while read -r cert_hash; do
        case "
$identity_hashes
" in
          *"
$cert_hash
"*) printf '%s\n' "$cert_hash"; break ;;
        esac
      done
}

warn_adhoc() {
  cat >&2 <<'BANNER'

  ────────────────────────────────────────────────────────────────
   ⚠️  这次是 ad-hoc 签名(临时签名)

   装上去之后 macOS 会把它当成**一个全新的 App**:
   辅助功能授权会失效,要去「系统设置 → 隐私与安全性 → 辅助功能」
   把「工作台」关一次再开。以后每重建一次,都得再点一次。

   一次性了结:先跑一遍

       bash deploy/codesign-identity.sh

   它在你的登录钥匙串里建一张「工作台本机签名」证书,之后每次构建
   都用同一张 —— 签名不变,授权跨更新保留。
  ────────────────────────────────────────────────────────────────

BANNER
}

# ── --resolve:构建脚本问「这次该用哪个身份」,答案打到 stdout,只有一行 ──
if [ "$MODE" = "resolve" ]; then
  hash="$(find_identity_hash || true)"
  if [ -n "$hash" ]; then
    # 打指纹而不是名字:`codesign --sign` 两样都收,而指纹是纯十六进制,
    # 不会被中文名的编码问题绊倒(见 find_identity_hash 上面那段)。
    printf '%s\n' "$hash"
    exit 0
  fi
  if [ -n "${WORKBENCH_CODESIGN_IDENTITY:-}" ]; then
    # 名字是人明着指定的(比如 Developer ID),找不到就是配错了,**不许**偷偷退回 ad-hoc:
    # 那会悄悄把授权搞没,而人以为自己正用着正式证书。
    echo "× 钥匙串里找不到签名身份「${IDENTITY_NAME}」(WORKBENCH_CODESIGN_IDENTITY 指定的)。" >&2
    echo "  看一眼有哪些:security find-identity -v -p codesigning" >&2
    exit 1
  fi
  warn_adhoc
  printf -- '-\n'
  exit 0
fi

if [ "$MODE" = "check" ] || [ "$MODE" = "print" ]; then
  hash="$(find_identity_hash || true)"
  if [ -z "$hash" ]; then
    if [ "$MODE" = "print" ]; then
      echo "找不到签名身份「${IDENTITY_NAME}」。跑一次 bash deploy/codesign-identity.sh 建它。" >&2
    fi
    exit 1
  fi
  if [ "$MODE" = "print" ]; then printf '%s\n' "$hash"; fi
  exit 0
fi

# ───────────────────────── ensure:幂等地把证书弄进去 ─────────────────────────

existing="$(find_identity_hash || true)"
if [ -n "$existing" ]; then
  echo "✓ 已经有了:「${IDENTITY_NAME}」 $existing"
  echo "  什么都没动。要换一张(比如旧的快到期了),先在「钥匙串访问」里把它删掉再跑这条。"
  exit 0
fi

command -v /usr/bin/openssl >/dev/null || { echo "× 没有 /usr/bin/openssl?" >&2; exit 1; }

TARGET_KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
[ -f "$TARGET_KEYCHAIN" ] || { echo "× 钥匙串不存在:$TARGET_KEYCHAIN" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/workbench-codesign.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

echo "▸ 生成自签代码签名证书「${IDENTITY_NAME}」(有效期 ${VALID_DAYS} 天)"

# string_mask=utf8only + -utf8:名字里有中文,不这么写 LibreSSL 会按 latin-1 再编一遍,
# 钥匙串里看到的就是一串乱码,而 DR 里嵌的也是那串乱码。真踩过。
cat > "$WORK/openssl.cnf" <<CNF
[ req ]
distinguished_name = dn
prompt = no
string_mask = utf8only
[ dn ]
CN = $IDENTITY_NAME
[ codesign ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF

# 一定要 /usr/bin/openssl(系统自带的 LibreSSL),不是 PATH 里可能排在前面的 Homebrew
# OpenSSL 3:后者导出的 .p12 默认用 AES-256-CBC + PBKDF2,`security import` 读不动。
/usr/bin/openssl req -x509 -utf8 -newkey rsa:2048 -nodes -sha256 \
  -days "$VALID_DAYS" -set_serial "0x$(/usr/bin/openssl rand -hex 8)" \
  -config "$WORK/openssl.cnf" -extensions codesign \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1 \
  || { echo "× openssl 没生成出证书。" >&2; exit 1; }

P12_PASS="$(/usr/bin/openssl rand -hex 16)"   # 只活在这个临时目录里,导入完就没了
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$IDENTITY_NAME" -out "$WORK/id.p12" -passout "pass:$P12_PASS"

echo "▸ 导入钥匙串:$TARGET_KEYCHAIN"
# -T /usr/bin/codesign:把 codesign 加进这把私钥的 ACL,省掉每次签名都弹框。
# -A 不用:那是「所有程序都能用这把私钥」,对一把签名私钥来说给太宽了。
security import "$WORK/id.p12" -k "$TARGET_KEYCHAIN" -P "$P12_PASS" -f pkcs12 \
  -T /usr/bin/codesign -T /usr/bin/security \
  || { echo "× 导入失败。" >&2; exit 1; }

# ── set-key-partition-list:那一步是干嘛的 ──
# Sierra 之后,私钥除了上面那份 ACL,还有一张「分区表」(partition list)。新导入的私钥
# 分区表是空的,于是即便 ACL 里有 codesign,**第一次签名还是会弹一次系统框**问你要
# 钥匙串密码。这一条把 codesign 写进分区表,弹框就没了。
# 它自己要钥匙串密码(登录钥匙串 = 你的开机密码)——所以这一步**只能你本人**做。
echo "▸ 让 codesign 能直接用这把私钥(security set-key-partition-list)"
KC_PASS="${WORKBENCH_KEYCHAIN_PASSWORD:-}"
if [ -z "$KC_PASS" ] && [ -t 0 ]; then
  echo "  下面要你输一次这个钥匙串的密码(登录钥匙串的话就是你的开机密码)。"
  echo "  它只传给 security 这一条命令,不写进任何文件。直接回车可以跳过。"
  printf '  钥匙串密码:'
  read -rs KC_PASS
  printf '\n'
fi

partition_ok=0
if [ -n "$KC_PASS" ]; then
  if security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
       -k "$KC_PASS" "$TARGET_KEYCHAIN" >/dev/null 2>&1; then
    partition_ok=1
  fi
fi
unset KC_PASS

hash="$(find_identity_hash || true)"
[ -n "$hash" ] || { echo "× 导入之后还是找不到这个身份,不对劲。" >&2; exit 1; }

echo
echo "✓ 好了:「${IDENTITY_NAME}」 $hash"
if [ "$partition_ok" = "1" ]; then
  echo "  codesign 已经能直接用它,构建时不会弹框。"
else
  cat <<'TIP'
  没做成 set-key-partition-list(密码没给或者不对)。不影响能不能签,只影响弹不弹框:
  **第一次构建时系统会弹一个框**问「codesign 想使用您钥匙串里的密钥」——
  输密码然后点「始终允许」(不是「允许」),以后就不再问了。
TIP
fi
cat <<'NEXT'

  接下来照常构建就行:

      cd workbench-app && ./build.sh          # 壳
      bash deploy/build-installer.sh          # 安装包

  两个脚本都会自己找到这张证书。装上去之后授权点一次,以后更新不再掉。
NEXT
