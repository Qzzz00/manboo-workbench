/**
 * 某家那条会话的卡片下面那个输入框 —— **直接把话说进那条会话里**(2026-09-27,卡 PS)。
 *
 * 维护者 22:0x 原话:「手机上加一个很实用的功能,现在运行中的卡不是有能看到最近的几轮吗,要及时之外,
 * 还得能直接在下面输入信息,**对标最外侧的输入框**,能直接把信息发到这个会话窗口里。」
 *
 * 三条口径:
 *   - **对标最外侧那个输入框** = 同一个组件(`PhoneComposer`),取它「只有文字与发送」那一档裁剪
 *     (`trim: 'call'`,通话页用的也是这一档):真 textarea(多行、系统的粘贴与选词)、回车发送、
 *     发送中那颗键显示「···」、灰着不让重发。这里不摆「+ / @ / 模式模型 / 麦克风」——
 *     那几样是「交办一件事」的口径,这条路只做一件事:把他的一句话送进**一条已经开着的对话**。
 *   - **发出去 = 捎话**(`POST /sessions/relay`,2026-09-26 卡 BR 那条路),带的是**这一条**会话的
 *     `agent` + `session_id`(不猜、不按名字认:他点开的就是这一条)。他的原话一个字不改。
 *   - **送不进去的会话不摆输入框**:一行人话说清为什么(那句话与真捎话回的一模一样,来自
 *     `GET /sessions/digest` 里那一格 `relay`)。摆一个按下去只会挨一句「你自己去电脑上说」的框,
 *     比不摆糟(D13:不给摆设)。
 *
 * 发出后卡上立刻一行回执:送进去了照工作台那句话说,没送进去说清哪一步没成 —— 并且**他打的字留在框里**
 * (送不成时不清空:那句话还没送出去,清了就是替他丢话)。送进去了就立刻再读一次最近几轮(`onSent`),
 * 他自己那句与对方的回话都在同一张卡上看得见。
 *
 * 2026-10-03(卡 claude/phone-saybox-pinned)两处变化,都是维护者当天上午从手机捎来的:
 *   - **这一整段吸底**:它现在摆在会话详情那张卡的第三格(`.ba-sheet__dock`,见 items/InboxPage.tsx),
 *     对话在它上面滚 —— 原来它排在整张卡最底下,「用起来得自己下滑,很难受」。
 *     所以这里的行序改成「几行回执在上、框在最下面」:框紧贴屏幕下沿,单手打字拇指就在那儿。
 *   - **送到了给一行「已送到 · 10:38」**(`data-say="sent"`,文案与时刻口径见 composer/sentHint.ts):
 *     只有 `/sessions/relay` 回 `ok:true` 才有;没送进去照旧只摆工作台那句原因。
 */
import { useState } from 'react';
import { newClientKey } from '../channel/clientKey';
import { useSession } from '../session';
import { PhoneComposer } from '../composer/PhoneComposer';
import { sentOkLine } from '../composer/sentHint';
import { FIELD_PLACEHOLDER } from '../stage/StageComposer';
import type { SessionRelayReadyView } from '../api/protocol';

/** 输入框的标签(读屏念的就是这一句)。 */
export const SAY_LABEL = '在这条会话里说一句';

/** 这台电脑上的工作台还没有「能不能捎话」这一格(旧版):不摆输入框,说实话。 */
export const SAY_OLD_WORKBENCH = '这台电脑上的工作台还是旧版,不会替你把话送进会话里 —— 到电脑上那一家里自己说';

/** 连这条会话的记录都读不到:更没法替他送话。 */
export const SAY_NO_RECORD = '这条会话的记录都读不到,也就没法替你把话送进去 —— 到电脑上那一家里自己说';

/** 记录读得到(完整对话就在上面),但这条对话没在电脑上开着(2026-10-01,手机读对话):话送不进去。 */
export const SAY_NOT_OPEN = '这条对话没在电脑上开着,没法替你把话送进去 —— 到电脑上那一家里打开它再说';

/**
 * 「打断并发送」那颗次级键(2026-09-28,卡 WR)。它正在跑、而且这一路按得到那家的停止键时才摆。
 *
 * **按下去不立刻做**:先问一句「要先停下它吗」(问完他再点一次才真做)——
 * 打断一条正在干活的会话是撤不回来的,和派活那道「要我按发送吗」同一条纪律。
 */
export const SAY_INTERRUPT = '打断并发送';
/** 已经按过一次:再按一次是「不打断了」。 */
export const SAY_INTERRUPT_ARMED = '不打断了';
export const SAY_INTERRUPT_ASK = '好 —— 要先停下它,再把你这句话送进去。写好按发送就这么做;点「不打断了」可以撤。';

/**
 * **「回了打电话给我」那个勾选**(2026-10-04,卡 `claude/relay-call-optin`)。
 *
 * 维护者当天经工作台捎来的原话:
 *
 * > 「现在每次我在手机里给你发信息,你回信息他就给我打电话……不是每次都要的,
 * > 能不能给个勾选,勾了才需要盯和打电话」
 *
 * **缺省不勾**:不勾的那一句,工作台**不盯、不读、不通知** —— 对方回了只在那条会话 / 那张卡上
 * (上面这一段对话里)看得见(同日追问「不勾的时候要不要干脆别读那扇窗」,她回「可以不读」,
 * 卡 `claude/relay-nocall-noread`);勾了才是从前那一套(盯着,它回了就打一通电话)。
 * 这一格每句话各算一次 —— 不是一个设置,所以发完就回到不勾(下一句她多半不要那通电话)。
 */
export const SAY_CALL_BACK = '回了打电话给我';

/** 没送到(2026-10-12):再按发送,补发的是同一句,不会送两遍。 */
export const SAY_UNSENT = '没送到 · 再按发送会补发这一句,不会送两遍';

export function SessionSayBox({ agent, name, sessionId, ready, now, onSent }: {
  agent: string;
  /** 这一家叫什么(回执里用)。 */
  name: string;
  sessionId: string;
  /**
   * 能不能送进去。**缺席 = 还在读这条会话**(那会儿整段不画:最近几轮那一段已经在说「正在读…」)。
   */
  ready?: SessionRelayReadyView;
  /**
   * `/state.now` —— 「已送到 · 10:38」那个时刻照**电脑的钟**写(口径见 src/clock.ts;
   * 还没连上时是空字符串,那就只写「已送到」)。
   */
  now?: string;
  /** 送进去了:立刻再读一次最近几轮。 */
  onSent?(): void;
}) {
  const session = useSession();
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  /** 送到了那一行(「已送到 · 10:38」):算出来就冻住 —— 这一页 4 秒一拍,`now` 每拍都新。 */
  const [sent, setSent] = useState<string | undefined>(undefined);
  /** 他点过一次「打断并发送」了(第二次点才真打断)。 */
  const [armed, setArmed] = useState(false);
  /**
   * 这一句要不要回电(2026-10-04,卡 `claude/relay-call-optin`)。**缺省不勾**,送出去之后回到不勾 ——
   * 它是「这一句」的决定,不是一个设置(她嫌烦的正是每一来一回都响一次)。
   */
  const [callBack, setCallBack] = useState(false);
  /**
   * 上一句没送到时那个请求号(2026-10-12,卡「手机交代只执行一次」)。她再按发送同一句,带回同一个号 ——
   * 那一下可能其实到了电脑、只是回话没回来,电脑按号只送一次进那条会话。送到了、或者电脑明说送不进去,就清掉。
   */
  const [retry, setRetry] = useState<{ text: string; key: string } | undefined>(undefined);
  if (ready === undefined) return null;
  /** 摆不摆那颗次级键:它在跑、而且工作台说打断这一下做得到。 */
  const canInterrupt = ready.can && ready.running === true && ready.interrupt?.can === true;
  const interruptWhy = ready.can && ready.running === true && ready.interrupt?.can === false
    ? ready.interrupt.why
    : undefined;

  /**
   * 送一句(`interrupt` = 先按那家的停止键再送;`callOnReply` = 她勾了「回了打电话给我」)。
   * 回执照工作台那句话说,不替它编 —— 勾没勾那句承诺也是工作台说的(它那头才知道回电登记上没有)。
   */
  async function say(text: string, interrupt: boolean, callOnReply: boolean): Promise<boolean> {
    setReceipt(undefined);
    setSent(undefined);
    const key = retry !== undefined && retry.text === text ? retry.key : newClientKey();
    try {
      const got = await session.client.json<{ ok?: boolean; note?: string; why?: string; error?: string; delivered?: string }>(
        '/sessions/relay',
        // 不勾就**一格都不送**(工作台那头缺席 = 不登记、不盯、不读;老版本工作台也是这个意思)。
        { method: 'POST', body: { agent, session_id: sessionId, text, ...(interrupt ? { interrupt: true } : {}), ...(callOnReply ? { call_on_reply: true } : {}), client_key: key } },
      );
      if (!got.ok) {
        // 连不上 / 电脑 5xx:这一句没送到(或送到了没回话),留着号,再按发送补的是同一句。电脑答了不行的不留。
        const unsent = got.kind === 'network' || got.status >= 500;
        setRetry(unsent ? { text, key } : undefined);
        setReceipt({ ok: false, text: unsent ? `${SAY_UNSENT}(${got.error})` : got.error });
        return false;
      }
      setRetry(undefined);
      const data = got.data;
      if (data?.ok === true) {
        setReceipt({ ok: true, text: data.note ?? `捎到了 —— 你那句话已经送进${name}那条会话里了。` });
        // 送到了那一下她要的那句小提示(2026-10-03):工作台那句话照旧摆着,这一行只说「到了,几点」。
        // ★ 留着等它醒 / 等解锁那一下(`delivered:'kept'`,2026-10-23 卡「捎话留言等它醒」):一个字都没送进去,
        //   不写「已送到」—— 工作台那句「这句我留着,它一开就送进去」就是全部实话。
        if (data.delivered !== 'kept') setSent(sentOkLine(now));
        onSent?.();
        return true;
      }
      setReceipt({ ok: false, text: data?.note ?? (data?.why === undefined ? '没送进去,工作台没说是哪一步没成' : `捎不进去:${data.why}`) });
      return false;
    }
    catch (error) {
      setRetry({ text, key });
      setReceipt({ ok: false, text: `${SAY_UNSENT}(${error instanceof Error ? error.message : '连不上工作台'})` });
      return false;
    }
  }
  return (
    <section className="ba-sheet__say2" aria-label="说给这条会话">
      {/*
        几行话在上、框在最下面(2026-10-03,卡 claude/phone-saybox-pinned):这一整段吸在卡的底边,
        框得紧贴屏幕下沿才顺手 —— 回执挤在框下面就把框顶起来了。
      */}
      {/* 送到了:「已送到 · 10:38」。只有真送到才有(sentHint.ts),没送到下面那行原因自己会说。 */}
      {sent !== undefined && <p className="ba-sheet__sent" role="status" data-say="sent">{sent}</p>}
      {/* 它在跑、可这一路打断不了:如实说一句(不摆那颗按不动的键)。 */}
      {interruptWhy !== undefined && <p className="ba-sheet__hint" data-say="no-interrupt">{interruptWhy}</p>}
      {receipt !== undefined && (
        <p className="ba-sheet__hint" role="status" data-say="receipt" data-ok={receipt.ok}>{receipt.text}</p>
      )}
      {/*
        「回了打电话给我」(2026-10-04,卡 `claude/relay-call-optin`):**摆在框上面、缺省不勾**。
        送得进去才摆 —— 送不进去的会话连框都没有,一个勾选摆在那儿就是摆设(D13)。
      */}
      {ready.can && (
        <label className="ba-switch ba-say__callback">
          <input
            type="checkbox"
            checked={callBack}
            onChange={(e) => { setCallBack(e.target.checked); }}
          />
          <span>{SAY_CALL_BACK}</span>
        </label>
      )}
      {ready.can
        ? (
          <PhoneComposer
            trim="call"
            placeholder={FIELD_PLACEHOLDER}
            ariaLabel={SAY_LABEL}
            onSubmit={async (draft) => {
              const text = draft.text.trim();
              if (text === '') return false;
              /**
               * 送出去这一下**默认是「补一句」**(2026-09-28,卡 WR):它在跑时这句话排进去,
               * 它跑完自己会看到。只有他先点过那颗「打断并发送」(`armed`)才先停下它 ——
               * 打断一条正在干活的会话撤不回来,不该由「按一下发送」这一下发生。
               */
              const ok = await say(text, armed, callBack);
              setArmed(false);
              // 这一格只管这一句:送出去就回到不勾(2026-10-04)。没送成留着她的勾,免得她再勾一遍。
              if (ok) setCallBack(false);
              return ok;
            }}
            extra={canInterrupt
              ? (
                <button
                  type="button"
                  className="ba-btn ba-btn--ghost ba-say__interrupt"
                  data-armed={armed}
                  aria-pressed={armed}
                  onClick={() => {
                    if (armed) { setArmed(false); setReceipt(undefined); return; }
                    setArmed(true);
                    setReceipt({ ok: false, text: SAY_INTERRUPT_ASK });
                  }}
                >
                  {armed ? SAY_INTERRUPT_ARMED : SAY_INTERRUPT}
                </button>
              )
              : undefined}
          />
        )
        : <p className="ba-sheet__hint" data-say="off">{ready.why ?? SAY_OLD_WORKBENCH}</p>}
    </section>
  );
}
