/**
 * ★ **往一条没开着的桌面会话捎话:留言等它醒**(2026-10-23,
 * 卡「捎话到没开着的会话留言等它醒」;设计见 `docs/交接-1023-捎话留言等它醒.md`)。
 *
 * 现场(10-23 07:36,统筹核过账):维护者在手机上给统筹会话(`claude/785a5e10…`)捎话。
 * `~/.dsh/workbench/jobs.jsonl` 里这条会话 07:36:34–40 共 5 次尝试:3 次过了闸,协议手
 * (`engine/adapters/claude.ts`)回 `not_sent`「那条 Claude 会话没开着,打开它再说一次」。
 * 为什么「没开着」:`~/.claude/sessions/21383.json` 与进程 21383 都是 **07:37:52** 才起的 ——
 * 桌面端让这条会话闲了一夜后进程没了,07:36 那三下送到的是一条没在跑的会话。
 *
 * 所以这一份只放**两句人话、全仓一处**(与 `screenLock.ts` 同款位置):
 * ① 留言时跟她说的一句 —— 手机回包、电话里那句、账上那一行,**同一个常量**;
 * ② 到 TTL 作废时记的那一句(排队的那本在 `engine/lockQueue.ts`,作废是队自己丢的,
 *    `index.ts` 的 `onDrop` 在 `reason:'closed'` 时把这一句记上账)。
 *
 * **排队的那一本 = 锁屏队**(`engine/lockQueue.ts`,落盘、原顺序、同句只排一条、TTL 12 小时),
 * 这张卡只给它加第二个入口(契约 `JobResult.sessionClosed`)与第二个触发(巡登记表,
 * `sessionAwakeWatch.ts` —— 那条会话的 socket 一在,就只重送那条会话的留言)。
 */

/** 留言时跟她说的那一句(排上了才许说「我留着」)。 */
export const SESSION_CLOSED_QUEUED_SAY = '那条会话没开着,这句我留着,它一开就送进去'

/** 到 TTL 作废时记的那一句(那句留言等了 12 小时它都没开,没送)。 */
export const SESSION_CLOSED_EXPIRED_SAY = '那句留言放了 12 小时它都没开,没送,你再说一遍'
