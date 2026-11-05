---
name: 截图验收
description: 要开一个看不见的浏览器把页面截图看(验收界面、复现样式问题、给他看改完的样子)时先读这一条 —— 照这里的写法开,所有要写的都落在临时文件夹里,不用提权、不用问他。
---

# 截图验收:开看不见的浏览器,不用提权

你的会话平时只能改**工作文件夹**和**临时文件夹**(`/tmp`、系统临时目录)。浏览器默认要往 `~/Library` 底下写自己的用户目录和
崩溃记录,直接开会被挡;挡了再提到最高权限,就得停下来问他 —— 维护者 09-25:「它有很多要我给权限的」。
照下面这样开,浏览器要写的全落在一个临时文件夹里,**这一步用不着提权**。

## 怎么开

1. 先找 Playwright 自带的无头浏览器(不碰他自己的 Chrome,截完自己退):

   ```
   ls ~/Library/Caches/ms-playwright/*/chrome-headless-shell-mac-*/chrome-headless-shell
   ```

   没有就用 Google Chrome:`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new`。

2. 一律带上这几个参数(少一个都会被挡、崩掉或者卡住):

   ```
   D=$(mktemp -d /tmp/wb-shot.XXXXXX)
   <浏览器> --no-sandbox --disable-gpu --use-mock-keychain --disable-crash-reporter \
     --crash-dumps-dir="$D/crash" --user-data-dir="$D/profile" \
     --window-size=1300,1100 --virtual-time-budget=8000 --hide-scrollbars \
     --screenshot="$D/shot.png" "<网址>"
   ```

   - `--no-sandbox`:你的会话本身就在沙箱里,浏览器自己的那层沙箱套不进去 —— 不加,画页面的那几个进程一起动就崩;
   - `--user-data-dir` / `--crash-dumps-dir` 都放进 `$D`;`--use-mock-keychain` 不去碰他的钥匙串;
   - 要页面上的字就把 `--screenshot=…` 换成 `--dump-dom > "$D/dom.html"`。

3. Google Chrome 截完不一定自己退出:给整条命令加个时限 `perl -e 'alarm 40; exec @ARGV' <浏览器> …`。
   `shot.png` 已经写出来了就算成,退出码不用管。

4. 截图在 `$D/shot.png`。要给他看,拷进这件事的工作文件夹再说一句在哪;临时文件夹不用删。

## 还是被挡了

说明这一次真的要写临时文件夹以外的地方。这时再按提权那条路走,**理由写清楚要做什么、写在哪儿**(他那边看到的是一句人话:
「要开一个看不见的浏览器,把页面截下来看」+ 你写的理由 + 这一下放开到多大)。他可以点「这件事里开看不见的浏览器截图都允许」——
那以后同一件事里同类的就不再问他。
