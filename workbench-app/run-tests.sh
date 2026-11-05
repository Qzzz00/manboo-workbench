#!/bin/zsh
# 壳的纯逻辑测试(WindowPlacement:落屏顺序、窗口记忆、收边;WindowMode:前台/桌面两档;
# SwitchBudget:一次切换的时限与预算切分;
# ShellRelaunch:这一趟是不是热更新换完壳之后自动拉起来的;
# WebPolicy:壳替网页做的那批事——导航去留、选文件框的开关、下载文件名;
# ActivationSense:被叫到前面是「真切过去」还是「临时叫一下」——截图遮罩、划词浮窗、快捷面板;
# ShellTitleBar:壳顶上那一条——标题栏透明化的 styleMask、网页表头发来的拖动/双击、双击照系统设置;
# NotifyPolicy:事务官有话问你 / 要你批时弹不弹系统通知——在前台不弹、通知没开不弹)。
# ShellReadiness:先探 8791 就绪再让页面加载——探针地址、算不算就绪、退避与上限(2026-09-26 卡 U6);
# DisplayAwakePolicy:工作台在前台就别让屏幕暗下去——四个事实各自怎么让它放掉(2026-09-27 卡 IN);
#   2026-10-03 多第五格「出门时电脑不睡」(缺省关):为真时不看前台、退出照旧放掉、pmset 那一行按理由换名字,
#   以及**开关关着时四种前台组合逐条与今天相等**那一组(卡「出门时电脑不睡」);
# SystemAwakePolicy:工作台开着时整台电脑不睡——开关默认开、退出就放掉、读不懂配置回默认(2026-09-28 卡 AW);
# ScreenLockPolicy:电脑锁着屏时窗口型的家送不进——怎么从 CGSession 那本字典认出锁屏、回包带哪一格、
#   「一扇标准窗口都没有」换成哪句人话(2026-10-03 卡「锁屏时窗口型的家送不进」);
# GrantMode:装的时候把授权一次做完——`--grant` 怎么认、grants.json 的编解码(2026-09-27 卡 IN);
# 真 WebKit 引擎里的那一半(选文件、拖文件、新窗口、弹框、下载)在 ./run-web-tests.sh。
#
# 壳没有 SwiftPM 工程(build.sh 是 swiftc 直编一堆 .swift),所以也没有 `swift test`;
# 测试就是一个可执行文件:编 Sources/WindowPlacement.swift + Tests/main.swift,跑,
# 全绿退出码 0。WindowPlacement 故意不 import AppKit,才编得动、也才测得了。
#
# 跑法:cd workbench-app && ./run-tests.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(mktemp -d)/window-placement-tests"
swiftc -O Sources/ScreenLockPolicy.swift Sources/WindowPlacement.swift Sources/WindowMode.swift Sources/DragSense.swift Sources/ShellRelaunch.swift Sources/SendTextPolicy.swift Sources/SwitchBudget.swift Sources/WebToken.swift Sources/LoadingCover.swift Sources/ShellReadiness.swift Sources/TitleBar.swift Sources/WebPolicy.swift Sources/ActivationSense.swift Sources/NotifyPolicy.swift Sources/AgentWindowPolicy.swift Sources/IconColor.swift Sources/AppIconPolicy.swift Sources/DisplayAwakePolicy.swift Sources/SystemAwakePolicy.swift Sources/GrantMode.swift Sources/AppOpenLog.swift Sources/ReadLanes.swift Tests/main.swift -o "$OUT"
"$OUT"
