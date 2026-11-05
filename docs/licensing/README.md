# 事务官座机许可草案

状态：按维护者要求参考 Multica 逐条适配，主体及联系字段留空，尚未生效。采用自定义“事务官座机 License”方向，替代此前讨论的 PolyForm Perimeter；不标为标准 Apache-2.0 或 OSI 开源许可。

## 文件

- [LICENSE.draft.txt](LICENSE.draft.txt)：完整英文许可草案。Part I 为附加条件，Part II 为完整 Apache-2.0 正文，两部分共同组成拟用协议。
- [NOTICE.draft.txt](NOTICE.draft.txt)：配套署名与许可文本来源说明草案。
- [CONTRIBUTING.draft.md](CONTRIBUTING.draft.md)：对应贡献授权及 PR 评审规则草案。
- [原始许可快照](reference/Multica-LICENSE.txt)、[来源与替换清单](reference/source.json)、[完整差异](reference/adaptation.diff)：供工程师和法律审阅逐项核对。

## 来源与适配范围

基准：[multica-ai/multica@7a81f73ca2cd29a92e3808503dc11fa8a2ffb0fe](https://github.com/multica-ai/multica/tree/7a81f73ca2cd29a92e3808503dc11fa8a2ffb0fe)，取得日期 2026-10-21。原许可和 NOTICE 标记 Copyright 2025-2026 Index Labs (Hong Kong) Limited；原文版权声明保留在快照及来源说明中。这里只适配许可与贡献条款，不引入 Multica 软件代码。

保留原条款编号、授权条件、贡献条款、优先关系和再分发义务。变动仅为草案状态标记、项目名称、待填的权利主体与链接、版权年份，以及对应本仓库的 UI／后台目录和产物例子。Part II 与来源 Apache-2.0 正文逐字保留，不重写标准条款。

## 按原版保留的规则

- 允许个人使用、修改和单一组织内的商业使用。
- 向第三方提供托管服务需取得商业许可，免费托管也包含在内。
- 将本软件作为组件嵌入对外商业分发的产品或服务需取得商业许可。
- 公开 fork 源码本身不是托管服务，但仍须遵守完整许可及声明保留要求。
- 更改或移除 UI 中的产品名、LOGO、版权及署名信息需另获品牌豁免；无 UI 的后端、工人进程或 CLI 使用有相应来源说明义务。
- 商业许可与品牌豁免分别取得，不能相互推定，也不能从项目方沉默或接受贡献中推定。
- 贡献拟适用整份协议，允许项目方商业使用贡献，并保留原版关于调整许可的条款。PR 是否合并由维护者评估。

这些是阅读说明，不能替代英文完整条款。原版围绕托管和商业嵌入作限制，未添加 PolyForm 的一般性非竞争条款，也未额外扩大为禁止任何独立开发的同类产品。

## 待填字段

| 标记 | 内容 |
| --- | --- |
| RIGHTS_HOLDER_LEGAL_NAME | 实际有权许可的个人或法人完整名称 |
| COMMERCIAL_CONTACT_URL | 商业许可和品牌豁免的公开申请入口 |
| PUBLIC_PROJECT_URL | 本项目的公开来源链接 |

按维护者要求暂不填写这些字段，不借用 Multica 的公司名称、销售入口或镜像地址。Apache 正文附录自带的 `[yyyy]`、`[name of copyright owner]` 等示例属于原文，不是本次新增待填字段。

## 定稿与发布边界

这组草案尚未放到仓库根目录作为正式 LICENSE／NOTICE，也未改变包元数据、安装包或公开状态。填写主体与入口后，需要核对实际代码权属、第三方许可范围、许可文本复用及贡献授权的法律适用性，再将定稿文本同步到源码和实际发布物。

DSH、Aiboo 来源内容、SDK、依赖、字体、形象及其他第三方素材应按各自实际权属和许可证处理。此草案不赋予我们重新许可他人内容的权利，也不替代这些组件原有的许可与署名。Multica 采用某份协议本身，不构成该协议在本项目或所有法域均有效的证明。
