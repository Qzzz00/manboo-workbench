#!/usr/bin/env python3
"""run-web-tests.sh 用的临时静态服务(2026-09-25,卡 fix/shell-web-capabilities)。

只绑 127.0.0.1、端口让系统挑(写进 argv[2] 那个文件),跑完由脚本按 PID 杀掉。
除了原样发 argv[1] 目录里的文件,只多两条:/attach/*(二进制附件)与 /attach-text/*(json,但标了
Content-Disposition: attachment),测「服务端回附件 → 壳转成下载、旧页不被换掉、不被盖板盖死」。
"""
import http.server
import sys

ROOT, PORT_FILE = sys.argv[1], sys.argv[2]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *args):  # 安静
        pass

    def do_GET(self):
        if self.path.startswith('/attach/'):
            body = b'\x00\x01report-bytes'
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', "attachment; filename=\"report.bin\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.bin")
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/attach-text/'):
            # 网页显示得了的类型,但服务端明说是附件:该下载,不该把整页换成这段字。
            body = '{"说明":"附件里的 json"}'.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Disposition', 'attachment; filename="notes.json"')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def guess_type(self, path):
        if str(path).endswith('.js'):
            return 'text/javascript'
        return super().guess_type(path)


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):  # WebView 提前断开连接之类,不刷屏
        pass


server = QuietServer(('127.0.0.1', 0), Handler)
with open(PORT_FILE, 'w') as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
