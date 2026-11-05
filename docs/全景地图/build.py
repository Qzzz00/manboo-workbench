# -*- coding: utf-8 -*-
"""把 docs/全景地图.md 生成一张单页网页。

跑法(仓库根):
  python3 -I docs/全景地图/build.py
产物:
  docs/全景地图/index.html        —— 完整网页,双击能开
  <第二个参数>                                     —— 可选:只含 <title>/<style>/正文 的片段(发私有页面用)

只用标准库。Markdown 只认本文用到的那一小撮写法:#/##/### 标题、- 与 1. 列表(两格缩进嵌套)、
| 表格 |、---、**粗**、`码`、[链接](url)、〔码〕〔测〕〔真机 …〕三档标记。
"""
import html, io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import figs  # 同目录:图的数据与生成器
FIGURES = figs.render_all(os.path.join(HERE, 'figures'))
MD = os.path.join(os.path.dirname(HERE), '全景地图.md')
OUT = os.path.join(HERE, 'index.html')
FRAG = sys.argv[1] if len(sys.argv) > 1 else None

# ---------- 行内 ----------
TAG_RE = re.compile(r'〔(码|测|真机[^〕]*|\d{2}-\d{2}[^〕]*|现状|方向|待拍板|已拍板|设计稿)〕')
KIND_CLASS = {'现状': 'now', '方向': 'dir', '待拍板': 'open', '已拍板': 'now', '设计稿': 'dir'}
CODE_RE = re.compile(r'`([^`]+)`')
BOLD_RE = re.compile(r'\*\*(.+?)\*\*')
LINK_RE = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')

def inline(text):
    # 粗体先换成占位符,免得 **`码`** 这种跨过码段的粗体被切断
    text = BOLD_RE.sub('\x01\\1\x02', text)
    out = []
    pos = 0
    for m in CODE_RE.finditer(text):
        out.append(_inline_nocode(text[pos:m.start()]))
        out.append('<code>' + html.escape(m.group(1)) + '</code>')
        pos = m.end()
    out.append(_inline_nocode(text[pos:]))
    return ''.join(out).replace('\x01', '<strong>').replace('\x02', '</strong>')

def _inline_nocode(t):
    t = html.escape(t, quote=False)
    def tag(m):
        body = m.group(1)
        if body in KIND_CLASS:
            return '<span class="tag tag-%s">%s</span>' % (KIND_CLASS[body], body)
        if body[:1].isdigit():
            body = '真机 ' + body
        if body.startswith('真机'):
            cls = 'real'
        elif body == '测':
            cls = 'test'
        else:
            cls = 'code'
        return '<span class="tag tag-%s">%s</span>' % (cls, body)
    t = TAG_RE.sub(tag, t)
    t = BOLD_RE.sub(r'<strong>\1</strong>', t)
    def _href(u):
        if u.startswith('全景地图/'): return u[len('全景地图/'):]  # md 在 docs/ 里指向本目录;网页就在本目录
        if u.endswith('.md') and not re.match(r'^(?:[a-z]+:|/|#|\.\./)', u): return '../' + u
        return u
    t = LINK_RE.sub(lambda m: '<a href="%s">%s</a>' % (_href(m.group(2)), m.group(1)), t)
    return t

# ---------- 块 ----------
def split_cells(line):
    cells, cur, inside = [], [], False
    s = line.strip()
    if s.startswith('|'): s = s[1:]
    if s.endswith('|'): s = s[:-1]
    for ch in s:
        if ch == '`': inside = not inside
        if ch == '|' and not inside:
            cells.append(''.join(cur).strip()); cur = []
        else:
            cur.append(ch)
    cells.append(''.join(cur).strip())
    return cells

LIST_RE = re.compile(r'^(\s*)(?:(-)|(\d+)\.)\s+(.*)$')
# 内嵌框:[嵌:相对路径|标题|高度px] —— 把 Archify 生成的单页图嵌进对应章节,旁边留「单独打开」
EMBED_RE = re.compile(r'^\[嵌:([^|\]]+)\|([^|\]]+)(?:\|(\d+))?\]$')

def pinned_revision(path):
    """图钉在哪个提交:读同名规格 JSON 的 meta.repository.revision,取前 8 位(重钉只改规格,这里跟着变)。"""
    spec = os.path.join(HERE, os.path.splitext(path)[0] + '.json')
    with io.open(spec, encoding='utf-8') as f:
        return json.load(f)['meta']['repository']['revision'][:8]

def render_embed(ln):
    m = EMBED_RE.match(ln.strip())
    path, cap, height = m.group(1).strip(), m.group(2).strip(), int(m.group(3) or 960)
    eid = 'embed-' + re.sub(r'[^A-Za-z0-9_-]+', '-', os.path.splitext(os.path.basename(path))[0])
    href = html.escape(path, quote=True)
    return ('<figure class="embed" id="%s">'
            '<div class="embedbar"><span class="tag tag-now">现状</span><span class="embedtitle">%s</span>'
            '<a class="embedopen" href="%s" target="_blank" rel="noopener">单独打开</a></div>'
            '<iframe src="%s" title="%s" loading="lazy" height="%d"></iframe>'
            '<figcaption>每个方块都能点开看它引用的源码行,链接钉在 main@%s;框里看不全就点「单独打开」。</figcaption>'
            '</figure>') % (eid, inline(cap), href, href, html.escape(cap, quote=True), height, pinned_revision(path))

def render_list(lines):
    """lines: 列表块的原始行(含缩进)。返回 html。"""
    items = []  # (level, ordered, text)
    for ln in lines:
        m = LIST_RE.match(ln)
        if m:
            indent = len(m.group(1).replace('\t', '  '))
            level = indent // 2
            items.append([level, m.group(3) is not None, m.group(4)])
        else:
            # 续行:并进上一条
            if items:
                items[-1][2] += '<br>' + ln.strip()
    out = []
    stack = []  # [(level, ordered)]
    def close_to(level):
        while stack and stack[-1][0] >= level:
            lv, od = stack.pop()
            out.append('</li></%s>' % ('ol' if od else 'ul'))
    for level, ordered, text in items:
        text_html = inline(text) if '<br>' not in text else '<br>'.join(inline(p) for p in text.split('<br>'))
        if stack and stack[-1][0] == level and stack[-1][1] == ordered:
            out.append('</li><li>' + text_html)
        elif stack and stack[-1][0] < level:
            out.append('<%s><li>%s' % ('ol' if ordered else 'ul', text_html))
            stack.append((level, ordered))
        else:
            close_to(level)
            if stack and stack[-1][0] == level and stack[-1][1] == ordered:
                out.append('</li><li>' + text_html)
            else:
                if stack and stack[-1][0] == level:
                    lv, od = stack.pop(); out.append('</li></%s>' % ('ol' if od else 'ul'))
                out.append('<%s><li>%s' % ('ol' if ordered else 'ul', text_html))
                stack.append((level, ordered))
    close_to(-1)
    return ''.join(out)

def render_table(lines):
    rows = [split_cells(l) for l in lines if not re.match(r'^\s*\|?\s*-{2,}', l)]
    if not rows: return ''
    head, body = rows[0], rows[1:]
    h = ['<div class="tablewrap"><table><thead><tr>']
    h += ['<th>%s</th>' % inline(c) for c in head]
    h.append('</tr></thead><tbody>')
    for r in body:
        h.append('<tr>' + ''.join('<td>%s</td>' % inline(c) for c in r) + '</tr>')
    h.append('</tbody></table></div>')
    return ''.join(h)

def slug(n):
    return 's%d' % n

def render_blocks(lines):
    """把一段 md 行渲染成 html(不含标题切分)。"""
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if ln.strip() == '':
            i += 1; continue
        if ln.strip() == '---':
            out.append('<hr>'); i += 1; continue
        if EMBED_RE.match(ln.strip()):
            out.append(render_embed(ln)); i += 1; continue
        if ln.startswith('#### '):
            t = ln[5:].strip()
            kind = 'dir' if '〔方向〕' in t else ('open' if '〔待拍板〕' in t else 'now')
            out.append('<h4 class="%s">%s</h4>' % (kind, inline(t))); i += 1; continue
        if ln.lstrip().startswith('|'):
            j = i
            while j < len(lines) and lines[j].lstrip().startswith('|'): j += 1
            out.append(render_table(lines[i:j])); i = j; continue
        if LIST_RE.match(ln):
            j = i
            while j < len(lines) and (LIST_RE.match(lines[j]) or (lines[j].startswith('  ') and lines[j].strip() != '')):
                j += 1
            out.append(render_list(lines[i:j])); i = j; continue
        # 段落:连续非空、非块起始行
        j = i
        if ln.startswith('#'):
            # 不认识的标题层级,当普通段落
            out.append('<p>%s</p>' % inline(ln.lstrip('# '))); i += 1; continue
        while j < len(lines) and lines[j].strip() != '' and not lines[j].lstrip().startswith('|') and not LIST_RE.match(lines[j]) and lines[j].strip() != '---' and not lines[j].startswith('#'):
            j += 1
        para = ' '.join(l.strip() for l in lines[i:j])
        out.append('<p>%s</p>' % inline(para)); i = j
    return '\n'.join(out)

# ---------- 结构 ----------
src = io.open(MD, encoding='utf-8').read().splitlines()
title = src[0].lstrip('# ').strip()
lead = []
sections = []  # dict(title, id, body_lines, subs=[(title,id,lines)])
cur = None
n = 0
i = 1
while i < len(src):
    ln = src[i]
    if ln.startswith('## '):
        n += 1
        cur = {'title': ln[3:].strip(), 'id': slug(n), 'pre': [], 'subs': []}
        sections.append(cur)
    elif ln.startswith('### '):
        n += 1
        cur['subs'].append({'title': ln[4:].strip(), 'id': slug(n), 'lines': []})
    else:
        if cur is None:
            lead.append(ln)
        elif cur['subs']:
            cur['subs'][-1]['lines'].append(ln)
        else:
            cur['pre'].append(ln)
    i += 1

DIAGRAM = '''<figure class="diagram"><svg viewBox="0 0 680 360" role="img" aria-label="事务官座机全景:三个入口、这台 Mac、云端">
<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<g class="zone"><rect x="40" y="40" width="165" height="250" rx="12"/><text x="52" y="58">三个入口</text></g>
<g class="zone"><rect x="230" y="40" width="245" height="250" rx="12"/><text x="242" y="58">这台 Mac</text></g>
<g class="zone"><rect x="505" y="40" width="135" height="250" rx="12"/><text x="517" y="58">云端</text></g>
<g class="box entry"><rect x="55" y="80" width="135" height="44" rx="8"/><text x="122.5" y="102">电脑工作台网页</text></g>
<g class="box entry"><rect x="55" y="150" width="135" height="44" rx="8"/><text x="122.5" y="172">手机 App</text></g>
<g class="box entry"><rect x="55" y="220" width="135" height="44" rx="8"/><text x="122.5" y="242">实体听筒</text></g>
<g class="box brain"><rect x="245" y="72" width="215" height="56" rx="8"/><text x="352.5" y="90">工作台插件(大脑)</text><text class="sub" x="352.5" y="108">跑在 DSH 进程里 · 8791</text></g>
<g class="box"><rect x="245" y="150" width="90" height="56" rx="8"/><text x="290" y="168">壳</text><text class="sub" x="290" y="186">点别家窗口</text></g>
<g class="box"><rect x="360" y="150" width="100" height="56" rx="8"/><text x="410" y="168">各家 AI</text><text class="sub" x="410" y="186">桌面窗口</text></g>
<g class="box"><rect x="245" y="220" width="90" height="56" rx="8"/><text x="290" y="238">语音后端</text><text class="sub" x="290" y="256">8792</text></g>
<g class="box"><rect x="360" y="220" width="100" height="56" rx="8"/><text x="410" y="238">通话工人</text><text class="sub" x="410" y="256">进房间说话</text></g>
<g class="box"><rect x="520" y="100" width="105" height="56" rx="8"/><text x="572.5" y="118">中转</text><text class="sub" x="572.5" y="136">账号与凭据</text></g>
<g class="box"><rect x="520" y="200" width="105" height="56" rx="8"/><text x="572.5" y="218">LiveKit</text><text class="sub" x="572.5" y="236">通话房间</text></g>
<g class="arrows"><line x1="190" y1="102" x2="243" y2="98" marker-end="url(#arr)"/><path d="M190 172 L218 172 L218 112 L243 112" marker-end="url(#arr)"/><path class="dash" d="M190 186 L218 186 L218 310 L572 310 L572 258" marker-end="url(#arr)"/><line class="dash" x1="190" y1="242" x2="218" y2="242"/><line x1="290" y1="128" x2="290" y2="148" marker-end="url(#arr)"/><line x1="335" y1="178" x2="358" y2="178" marker-end="url(#arr)"/><line x1="460" y1="104" x2="518" y2="120" marker-end="url(#arr)"/><line x1="460" y1="248" x2="518" y2="232" marker-start="url(#arr)" marker-end="url(#arr)"/></g>
<text class="legend" x="40" y="335">亮框 = 大脑,所有判断都在这里 · 细框 = 三个入口 · 虚线 = 出门时手机和听筒走的路(10-21 拍板:主路改回局域网)</text>
</svg><figcaption>三列:她的入口、这台 Mac、云端。在家时手机到电脑的请求走局域网,声音今天仍经云上的房间。</figcaption></figure>'''

def section_html(sec, collapsible=False):
    h = ['<section id="%s">' % sec['id'], '<h2>%s</h2>' % inline(sec['title'])]
    pre = render_blocks(sec['pre'])
    h.append(pre)
    status_kind = sec['title'].startswith(('分二', '分三', '分四·详解'))
    for sub in sec['subs']:
        body = render_blocks(sub['lines'])
        if status_kind and '〔' not in sub['title']:
            body = '<div class="kind"><span class="tag tag-now">现状</span><span>代码今天是什么、验到哪;〔方向〕块另起</span></div>' + body
        if collapsible:
            h.append('<details class="fam" id="%s"><summary><h3>%s</h3></summary><div class="fam-body">%s</div></details>' % (sub['id'], inline(sub['title']), body))
        else:
            h.append('<h3 id="%s">%s</h3>%s' % (sub['id'], inline(sub['title']), body))
    h.append('</section>')
    return '\n'.join(h)

def put_figures(h):
    """把 <p>[图:F3]</p> 换成图。"""
    def rep(m):
        fid = m.group(1)
        if fid not in FIGURES: return '<p class="note">(缺图 %s)</p>' % fid
        svg, cap = FIGURES[fid]
        return '<figure class="diagram" id="fig-%s"><div class="figwrap">%s</div><figcaption>%s</figcaption></figure>' % (fid, svg, inline(cap))
    return re.sub(r'<p>\[图:(F\d+)\]</p>', rep, h)

body_parts = []
toc = []
for sec in sections:
    collapsible = sec['title'].startswith('分四·详解')
    body_parts.append(put_figures(section_html(sec, collapsible)))
    clean = lambda t: html.escape(re.sub(r'〔[^〕]*〕', '', re.sub(r'[\(（].*$', '', t)).strip())
    toc.append('<li><a href="#%s">%s</a>' % (sec['id'], clean(sec['title'])))
    if sec['subs']:
        toc.append('<ul>' + ''.join('<li><a href="#%s">%s</a></li>' % (s['id'], clean(s['title'])) for s in sec['subs']) + '</ul>')
    toc.append('</li>')

lead_html = render_blocks([l for l in lead if not l.startswith('**三档标记**')])

STYLE = '''
<style>
/* 版式:左侧固定目录 + 右侧单栏长文;黑底白字灰线,沿用项目视觉 */
:root{
  --bg:#0b0d10; --bg-2:#14171c; --bg-3:#1b1f26;
  --fg:#e8e6df; --fg-2:#a9aba5; --fg-3:#6f7370;
  --line:#2a2f37; --line-2:#3a404a;
  --accent:#d9c89a; --accent-2:#8fb3c7;
  --ok:#7cb08a; --warn:#d9a660;
  --font:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Source Han Sans SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:"SF Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace;
  color-scheme:dark;
}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:15px;line-height:1.75;
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:0}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);z-index:10;background:var(--bg)}
a{color:var(--accent-2);text-decoration:none}a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.86em;background:var(--bg-3);border:1px solid var(--line);border-radius:4px;padding:0 .3em;color:var(--fg)}
strong{color:#fff;font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.wrap{display:grid;grid-template-columns:250px minmax(0,1fr);gap:40px;max-width:1240px;margin:0 auto}
header.top{grid-column:1/-1;padding:40px 0 8px;border-bottom:1px solid var(--line)}
header.top h1{font-size:28px;font-weight:600;margin:0 0 8px;letter-spacing:.01em;text-wrap:balance}
header.top .meta{color:var(--fg-2);font-size:14px}
header.top .lead p{max-width:72ch;color:var(--fg-2)}
nav.toc{position:sticky;top:calc(env(safe-area-inset-top,0px) + 16px);align-self:start;max-height:calc(100vh - 32px);overflow:auto;padding:16px 0 32px;font-size:13px;border-right:1px solid var(--line)}
nav.toc ul{list-style:none;margin:0;padding:0}
nav.toc > ul > li{margin:0 0 10px}
nav.toc > ul > li > a{color:var(--fg);font-weight:600}
nav.toc ul ul{margin:4px 0 0 10px;border-left:1px solid var(--line);padding-left:10px}
nav.toc ul ul li{margin:2px 0}
nav.toc ul ul a{color:var(--fg-2)}
nav.toc a{display:block;padding:2px 8px 2px 0}
nav.toc a:hover{color:var(--accent);text-decoration:none}
main{min-width:0;padding:8px 0 80px;max-width:860px}
section{padding:28px 0 8px;border-bottom:1px solid var(--line)}
section:last-child{border-bottom:0}
h2{font-size:22px;font-weight:600;margin:0 0 14px;color:#fff;text-wrap:balance}
h3{font-size:17px;font-weight:600;margin:26px 0 10px;color:var(--accent);text-wrap:balance}
p{margin:0 0 12px;max-width:78ch}
ul,ol{margin:0 0 12px;padding-left:1.4em}
li{margin:4px 0}
li>ul,li>ol{margin:4px 0 4px}
.tablewrap{overflow-x:auto;margin:0 0 16px;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}
th{background:var(--bg-2);color:var(--fg-2);font-weight:600;white-space:nowrap}
tr:last-child td{border-bottom:0}
td:first-child{color:#fff;white-space:nowrap}
.tag{display:inline-block;font-size:12px;line-height:1.5;padding:0 .5em;border-radius:999px;border:1px solid var(--line-2);color:var(--fg-2);margin:0 1px;white-space:nowrap;vertical-align:1px}
.tag-test{border-color:#3f5563;color:var(--accent-2)}
.tag-real{border-color:#6a5a2e;color:var(--accent);background:#1f1b12}
.tag-real::before{content:"●";font-size:9px;margin-right:4px;vertical-align:1px}
.tag-now{border-color:#3f5563;background:#111a20;color:var(--accent-2)}
.tag-dir{border-color:var(--accent);background:#1f1b12;color:var(--accent)}
.tag-open{border-color:#6a5a2e;color:var(--warn);border-style:dashed}
.kind{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--fg-3);margin:-4px 0 10px}
h4{font-size:15px;font-weight:600;margin:26px 0 8px;padding-left:10px;border-left:3px solid var(--line-2);color:var(--fg)}
h4.dir{border-left-color:var(--accent);color:var(--accent)}
h4.open{border-left-color:var(--warn);color:var(--warn)}
h4.now{border-left-color:var(--accent-2)}
details.fam{border:1px solid var(--line);border-radius:8px;margin:12px 0;background:var(--bg-2)}
details.fam summary{cursor:pointer;list-style:none;padding:12px 16px;display:flex;align-items:center;gap:10px}
details.fam summary::-webkit-details-marker{display:none}
details.fam summary::before{content:"▸";color:var(--fg-3);font-size:12px;transition:transform .15s}
details.fam[open] summary::before{transform:rotate(90deg)}
details.fam summary h3{margin:0;font-size:16px}
details.fam .fam-body{padding:0 16px 12px 36px;border-top:1px solid var(--line)}
details.fam .fam-body>:first-child{margin-top:12px}
.legendbar{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;font-size:13px;color:var(--fg-2);padding:10px 0 0}
.tools{display:flex;gap:8px;margin:0 0 8px}
.tools button{background:var(--bg-3);border:1px solid var(--line-2);color:var(--fg);border-radius:6px;padding:4px 10px;font:inherit;font-size:13px;cursor:pointer}
.tools button:focus-visible{outline:2px solid var(--accent)}
figure.diagram{margin:18px 0 22px;max-width:100%}
figure.diagram .figwrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg-2);padding:8px}
figure.diagram svg{width:100%;height:auto;max-width:920px;min-width:560px;display:block}
.diagram .box.todo rect{stroke-dasharray:5 4}
.diagram .box.lane rect{fill:var(--bg-3)}
.diagram line.life{stroke:var(--line-2);stroke-dasharray:3 4;stroke-width:1}
.diagram .num circle{fill:var(--bg-3);stroke:var(--line-2);stroke-width:.8}
.diagram .num text{fill:var(--fg-2);font-size:11px;font-family:var(--font)}
.diagram .mark circle{fill:#1f1b12;stroke:var(--accent);stroke-width:1}
.diagram .mark text{fill:var(--accent);font-size:11px;font-family:var(--font)}
.diagram text.lbl{fill:var(--fg);font-family:var(--font)}
.diagram rect.lblbg{fill:var(--bg-2)}
.diagram text.note{fill:var(--accent);font-family:var(--font)}
.diagram text.sub{fill:var(--fg-2);font-family:var(--font)}
.diagram .arrows .dot{stroke-dasharray:1.5 3}
.diagram .arrows .thick{stroke-width:2.6;stroke:var(--fg)}
.diagram .arrows .ble{stroke-dasharray:6 3 1.5 3}
.diagram marker path.mk{stroke:var(--fg-2)}
figure.diagram figcaption{color:var(--fg-2);font-size:13px;margin-top:6px}
figure.embed{margin:18px 0 26px;max-width:100%}
figure.embed .embedbar{display:flex;align-items:center;gap:10px;margin:0 0 8px;font-size:13px;color:var(--fg-2)}
figure.embed .embedtitle{color:var(--fg);font-weight:600}
figure.embed .embedopen{margin-left:auto;white-space:nowrap;border:1px solid var(--line-2);border-radius:6px;padding:2px 10px}
figure.embed .embedopen:hover{text-decoration:none;border-color:var(--accent-2)}
figure.embed iframe{width:100%;display:block;border:1px solid var(--line);border-radius:8px;background:#fff;color-scheme:light}
figure.embed figcaption{color:var(--fg-2);font-size:13px;margin-top:6px}
.diagram .zone rect{fill:none;stroke:var(--line-2);stroke-width:.6}
.diagram .zone text{fill:var(--fg-3);font-size:12px;font-family:var(--font)}
.diagram .box rect{fill:var(--bg-3);stroke:var(--line-2);stroke-width:.8}
.diagram .box text{fill:var(--fg);font-size:14px;font-weight:600;text-anchor:middle;dominant-baseline:central;font-family:var(--font)}
.diagram .box text.sub{fill:var(--fg-2);font-size:12px;font-weight:400}
.diagram .box.entry rect{stroke:var(--fg-3)}
.diagram .box.brain rect{fill:#1f1b12;stroke:var(--accent);stroke-width:1.2}
.diagram .box.brain text{fill:#fff}
.diagram .box.brain text.sub{fill:var(--accent)}
.diagram .arrows line,.diagram .arrows path{fill:none;stroke:var(--fg-2);stroke-width:1.2}
.diagram .arrows .dash{stroke-dasharray:4 3}
.diagram text.legend{fill:var(--fg-2);font-size:12px;font-family:var(--font)}
@media (max-width:900px){
  .wrap{display:block}
  nav.toc{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line);padding:12px 0}
  nav.toc ul ul{display:none}
  nav.toc > ul{display:flex;flex-wrap:wrap;gap:4px 14px}
  header.top{padding-top:24px}
  main{padding-top:0}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}details.fam summary::before{transition:none}}
</style>'''

SCRIPT = '''<script>
(function(){
  var b=document.getElementById('expand-all');if(!b)return;
  b.addEventListener('click',function(){var ds=document.querySelectorAll('details.fam');var open=Array.prototype.some.call(ds,function(d){return !d.open});
    ds.forEach(function(d){d.open=open});b.textContent=open?'全部收起':'全部展开'});
  if(location.hash){var el=document.querySelector(location.hash);if(el){var d=el.closest('details');if(d)d.open=true;}}
})();
</script>'''

LEGEND = '''<div class="legendbar"><span class="tag tag-code">码</span> 代码里有 <span class="tag tag-test">测</span> 有单元测试 <span class="tag tag-real">真机 日期</span> 交接里记了真机验过 · 没有「真机」的就是没在真机上验过或找不到记录</div>
<div class="legendbar"><span class="tag tag-now">现状</span> 代码今天是什么 <span class="tag tag-dir">方向</span> 已拍板要改成什么、设计稿 · 没有标〔方向〕的都是现状;图的说明也标</div>'''

frag = ['<title>事务官座机全景地图</title>',
        '<meta name="claude:viewport-fit-sides" content="cover">',
        STYLE,
        '<div class="wrap">',
        '<header class="top"><h1>%s</h1><div class="meta">2026-10-30 更新 · 代码 main@ebf98ea26（0.4.192，本机 = 公网热修 / 稳定142）· 10-29 可靠执行第一批见分二乙 · 正文其余为 10-25 盘点 · 历史源码图仍钉148</div><div class="lead">%s</div>%s</header>' % (html.escape(re.sub(r'[\(（].*$', '', title.replace('梳理 · ', '')).strip()), lead_html, LEGEND),
        '<nav class="toc" aria-label="目录"><ul>%s</ul></nav>' % ''.join(toc),
        '<main><div class="tools"><button id="expand-all" type="button">全部展开</button></div>',
        '\n'.join(body_parts),
        '</main></div>',
        SCRIPT]
fragment = '\n'.join(frag)

full = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + fragment.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '') + '\n</head>\n<body></body>\n</html>\n'
# 把片段里 <title>/<style> 留在 head,正文移到 body
m = re.search(r'(<div class="wrap">.*)$', full, flags=re.S)
head_part = full[:m.start()]
body_part = m.group(1).replace('\n</head>\n<body></body>\n</html>\n', '')
full = head_part + '</head>\n<body>\n' + body_part + '\n</body>\n</html>\n'

io.open(OUT, 'w', encoding='utf-8').write(full)
print('写好', OUT, len(full), '字节')
if FRAG:
    io.open(FRAG, 'w', encoding='utf-8').write(fragment)
    print('片段', FRAG, len(fragment), '字节')
