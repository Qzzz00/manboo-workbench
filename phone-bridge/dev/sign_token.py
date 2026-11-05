"""假环境里自己签一张 LiveKit 进房凭证。

**只在 dev/ 里用**:真机上凭证一律由 8791(或中转)签,派手上从来没有 secret
(pairing.py 的两条路)。这里之所以能签,是因为 `livekit-server --dev` 的
key/secret 是公开的固定值(devkey / secret),它本来就只在本机跑。

签法与 `workbench-plugin/src/server/channel.ts` 的 `signAccessToken` 逐字相同:
HS256,`iss`=key、`sub`=身份、`video`=授权、`attributes`=签进去的属性。
"""
import base64
import hashlib
import hmac
import json
import time


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def sign(api_key: str, api_secret: str, identity: str, room: str,
         attributes: dict = None, ttl: int = 3600, name: str = "") -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = {
        "iss": api_key, "sub": identity, "nbf": now, "exp": now + ttl,
        "video": {"room": room, "roomJoin": True, "canPublish": True,
                  "canSubscribe": True, "canPublishData": True},
    }
    if name:
        payload["name"] = name
    if attributes:
        payload["attributes"] = attributes
    body = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(api_secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
    return f"{header}.{body}.{b64url(sig)}"


def ticket(identity: str, room: str = "workbench", url: str = "ws://127.0.0.1:7880",
           attributes: dict = None, name: str = "") -> dict:
    """一张 pairing.ticket_of 认得的凭证。"""
    return {"url": url, "room": room, "identity": identity,
            "token": sign("devkey", "secret", identity, room, attributes, name=name),
            "expires_at": int(time.time()) + 3600}
