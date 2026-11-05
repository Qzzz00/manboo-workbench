# user-layer —— 用户层,不属于本体

这个目录里的东西**不是工作台本体**。本体(`workbench-plugin/` 等)只认一个加载口
(`workbench-plugin/src/server/userLayer.ts` + `src/client/userLayer.tsx`),从用户机器上的用户层目录
`~/.dsh/workbench/用户层/` 把这里的东西装进来。设计见 `docs/设计-分层第一刀-2026-10-21.md`。

```
user-layer/
  起步/小组件/<格>/     新机器第一次启动时放进用户层目录的那一份(现在是运营同学那六格)
    widget.json         清单:替哪一格、导出名、只在哪个模板下替
    index.js            代码:CommonJS,require 只认 react / react/jsx-runtime / @workbench/host
  （用户原件存档不随开源仓分发；这里只保留首次装机要用的起步层）
```

## 怎么到一台机器上

`pnpm build`(在 `workbench-plugin/` 里)最后一步把 `起步/` 拷进 `lib/starter-layer/`,随安装包与热更新包走;
工作台起服务时,**只在第一次建 `~/.dsh/workbench/用户层/` 那一下**整份拷进去。之后那个目录归她,升级一个字不动。

## 怎么改一格

- 在她自己的机器上:直接改 `~/.dsh/workbench/用户层/小组件/<格>/index.js`,工作台下一拍就换上(内容指纹变了就重装)。
  改坏了只有那一格受影响:先用上一版画好过的,没有上一版就退回本体自带的(本体没有自带的就写一句原因),设置 →「这台电脑」→「用户层」里看得到原因。
- 改这里(起步层)只影响**以后第一次装机**的机器,已经装过的机器不会被覆盖。

## 契约(第 1 版,只增不改)

- 每台机器的用户层目录里都有一份本体写的 `契约.md`(每次起服务重写)—— 派去改用户层的 coding agent 先读它。
- 改坏了那一格自动用 `.上一版/` 里画好过的那一版,改的文件不动;改好了自动换回。

- 能替哪几格、每一格给什么 props、`@workbench/host` 里有什么:设计稿第五节。
- 页内小组件和本体同权限:只放自己(或自己让人)写的东西。事务官派活做的小网页走「网页小组件」那条沙箱路,不在这里。

## 守门

`workbench-plugin` 的用例从这里读这六格、走真的加载口装出来(`tests/helpers/starterLayer.ts`、`tests/setup/starterLayer.ts`),
那几十份渲染整个工作台的用例就是「搬家前后一个像素不变」的守门;`client-air-accent`、`client-ops-no-purple-20261013` 两份照旧扫这里的颜色。
