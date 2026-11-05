#!/usr/bin/env python3
"""ArkEPass serial console helper: run commands, pull/push files with md5 verify."""
import os, sys, time, select, base64, hashlib

PORT = "/dev/cu.usbmodem1301"
fd = None

def _open():
    global fd
    if fd is None:
        fd = os.open(PORT, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)

def _write(s):
    data = s.encode() if isinstance(s, str) else s
    n = 0
    while n < len(data):
        try:
            n += os.write(fd, data[n:])
        except BlockingIOError:
            time.sleep(0.005)

def read_until(sentinel, timeout):
    """Read until sentinel (str) seen or timeout. Return decoded buffer.
    Scans only the tail each read to stay O(n)."""
    end = time.time() + timeout
    chunks = []
    tail = ""
    sent = sentinel
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                d = b""
            if d:
                s = d.decode("utf-8", "replace")
                chunks.append(s)
                tail = (tail + s)[-(len(sent) + 4096):]
                if sent in tail:
                    return "".join(chunks)
    return "".join(chunks)

def login():
    _open()
    _write("\r")
    time.sleep(0.3)
    buf = read_until("# ", 1.5)
    if "login:" in buf[-300:]:
        _write("root\r"); time.sleep(0.4)
        b = read_until("assword", 1.2)
        if "assword" in b:
            _write("toor\r"); read_until("# ", 2.0)
    # disable device-side echo so our command lines are not echoed back
    # (markers then appear exactly once, in command output only)
    _write("stty -echo\r")
    read_until("# ", 1.5)

def cmd(c, timeout=5.0):
    mark = "__DONE_%d__" % (int(time.time()*1000) % 100000)
    _write(c + "; echo " + mark + "\r")
    out = read_until(mark, timeout)
    # strip the echoed command line and marker
    return out

def capture(c, timeout=8.0):
    """Run c, return only the text between START/END markers."""
    s = "__S%d__" % (int(time.time()*1000) % 100000)
    e = s.replace("__S", "__E")
    _write("echo %s; %s; echo %s\r" % (s, c, e))
    out = read_until(e + "\r", timeout + 2)
    if e not in out:
        out = read_until(e, 2)
    try:
        seg = out.split(s, 1)[1].split(e, 1)[0]
    except IndexError:
        return out
    # drop first line (echoed command remnant / newline)
    return seg

def md5_local(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def pull(remote, local, timeout=240):
    _open()
    # get remote md5
    rm = capture("md5sum '%s' 2>/dev/null | cut -d' ' -f1" % remote, 6).strip().split()
    rmd5 = rm[-1] if rm else ""
    s = "__PS%d__" % (int(time.time()*1000) % 100000)
    e = s.replace("__PS", "__PE")
    _write("echo %s; base64 '%s'; echo %s\r" % (s, remote, e))
    out = read_until(e, timeout)
    if e not in out:
        print("pull: END marker not seen (timeout)"); return False
    seg = out.split(s, 1)[1].split(e, 1)[0]
    b64 = "".join(seg.split())  # remove all whitespace/newlines
    try:
        raw = base64.b64decode(b64)
    except Exception as ex:
        print("pull: b64 decode failed:", ex); return False
    with open(local, "wb") as f:
        f.write(raw)
    lmd5 = md5_local(local)
    print("pulled %d bytes -> %s  md5 local=%s remote=%s  %s" %
          (len(raw), local, lmd5, rmd5, "OK" if lmd5 == rmd5 else "MISMATCH!"))
    return lmd5 == rmd5

def push(local, remote, chunk=512):
    _open()
    with open(local, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode()
    lmd5 = md5_local(local)
    tmp = remote + ".b64"
    cmd(": > '%s'" % tmp, 4)  # truncate
    total = len(b64)
    i = 0; idx = 0
    while i < total:
        part = b64[i:i+chunk]
        i += chunk; idx += 1
        k = "__K%d__" % idx
        _write("printf '%%s' '%s' >> '%s'; echo %s\r" % (part, tmp, k))
        got = read_until(k, 15)
        if k not in got:
            print("push: chunk %d not acked (timeout)" % idx); return False
        if idx % 40 == 0:
            print("  pushed %d/%d bytes b64 (%.0f%%)" % (i, total, 100.0*i/total))
    # decode on device + verify
    cmd("base64 -d '%s' > '%s' && sync" % (tmp, remote), 10)
    rm = capture("md5sum '%s' 2>/dev/null | cut -d' ' -f1" % remote, 8).strip().split()
    rmd5 = rm[-1] if rm else ""
    cmd("rm -f '%s'" % tmp, 4)
    print("pushed %d bytes -> %s  md5 local=%s remote=%s  %s" %
          (len(raw), remote, lmd5, rmd5, "OK" if lmd5 == rmd5 else "MISMATCH!"))
    return lmd5 == rmd5

if __name__ == "__main__":
    login()
    op = sys.argv[1] if len(sys.argv) > 1 else "cmd"
    if op == "pull":
        pull(sys.argv[2], sys.argv[3])
    elif op == "push":
        push(sys.argv[2], sys.argv[3])
    elif op == "cmd":
        print(capture(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 8))
