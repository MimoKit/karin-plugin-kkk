import type { ForwardOptions } from 'node-karin'

/**
 * 合并转发的外显参数。
 *
 * ## 为什么 `news` 不能传
 *
 * NapCat 在 `parseForwardNodes` 里会对每个转发节点跑
 * `assertForwardNodeMetadataIsScalar`：节点 `data` 里除 `content` / `message`
 * 之外的**每个字段都必须是标量**（string / number / boolean），数组直接抛
 * `forward messages[0].news must be a scalar value`。
 *
 * 而 Karin 的 `forwardKarinConvertAdapter` 会把 `options.news` 原样写进
 * `messages[0].data.news` —— 于是只要传了 `news`，**整条转发必失败**
 * （实测 retcode 1400，且多图场景必现）。
 *
 * 好在 NapCat 并不依赖这个字段：节点 `data` 里那份被拒之后，它会从发送参数
 * 顶层的 `meta` 读外显，读不到再用 `buildNewsFromNodes(nodes)` 依据节点内容
 * 自动生成。因此**不传 `news`** 既规避了校验，外显也不受影响。
 *
 * `source` / `summary` / `prompt` 都是标量，能过校验且确实生效，保留。
 *
 * @param source - 小卡片标题
 * @param summary - 小卡片底部文本，如「查看 3 张图片」
 * @param prompt - 消息列表里的外显
 * @returns 可直接交给 `sendForwardMsg` 的外显参数
 */
export const buildForwardOptions = (source: string, summary: string, prompt: string): ForwardOptions =>
  ({ source, summary, prompt }) as ForwardOptions
