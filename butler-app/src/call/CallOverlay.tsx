/**
 * 通话中盖在舞台上的那一层(2026-09-17 整合版)。
 *
 * 原来它是整屏另起的一屏、自己画一颗球。Ben 拍板的口径里通话是**舞台的一种状态**:
 * 「通话中:底部一共三个键——麦克风(收音开关)、挂断、字幕」,球还是舞台正中那一颗。
 * 所以这一层不画球、不画背景,只占球下面的字幕位和最底下那一条:
 *   - 球下面:状态字(正在接通 / 通话中)、时长、麦克风关着的提示、点开才有的字幕;
 *   - 最底下:麦克风 / 挂断 / 字幕,就三个键。
 *
 * 状态一概不自己持有(在 useCall 里),这样舞台页才能拿同一份状态去画球。
 *
 * 2026-09-17 晚:字幕多了一行「说到一半的那句」(LiveKit 那条链路的工人会推 `final:false`)。
 * 它**淡一点、带省略号、不进纪要**——看得见「她听见了」比干等一句定稿安心,但纪要里不该留半句话。
 */
import { PhoneComposer } from '../composer/PhoneComposer';
import { useCallback, useState } from 'react';
import { StageIcon } from '../stage/icons';
import type { CallHandle } from './useCall';
import { MIC_OFF_TEXT, ONBOARDING_ON_DESKTOP_TEXT, TAKE_LEAD_LABEL } from './useCall';
import { MIC_SETTINGS_LABEL } from './micPermission';
import { FxVoiceFloor } from '../fx/Fx';
import { callVoice } from '../fx/fxModel';
import { useBackHandler } from '../nav/back';
import { SayDecisionCards } from '../chat/SayDecisionCards';

export interface CallOverlayProps {
  call: CallHandle;
}

/** 打字备胎里输入框的占位符。说清这条路通向哪儿:和说话是同一条。 */
export const CALL_TYPE_PLACEHOLDER = '打字回答…';

export function CallOverlay({ call }: CallOverlayProps) {
  /**
   * 字幕平时不显示,点了才显示(Ben:通话中和不通话时的「记录/字幕」是同一个概念)。
   * 这一屏的开合只是看不看,和通话本身无关,所以留在这儿。
   */
  const [showSubtitles, setShowSubtitles] = useState(false);
  // 系统返回(2026-09-24,卡 fix/phone-nav-back):字幕面板开着先收它;电话本身不动(StagePage 那一层接住、不挂断)。
  useBackHandler(showSubtitles, () => setShowSubtitles(false));
  const [sendError, setSendError] = useState<string | null>(null);
  const connected = call.phase === 'connected';
  const blocked = call.micBlocked;
  /** 「改回手机」没成就把原话摆出来 —— 按了没反应是最气人的一种失败。 */
  const takeLead = useCallback(async () => {
    if (call.takeLead === undefined) return;
    const result = await call.takeLead();
    setSendError(result.ok ? null : result.error);
  }, [call]);
  /**
   * 打字备胎(2026-09-18,引导改通话模式):字幕面板里能打字。
   * 嗓子哑了、周围吵、不方便出声时还有一条路;走的是**同一条** `record` / `say` 路径,
   * 不是另起一条对话。没有这条路(不是引导 / 火山那条链路)就不摆框——摆一个发不出去的框是骗人。
   */
  const canType = call.say !== undefined && connected;

  return (
    <>
      {/*
        底边那道声音光:只在你说话时升起(她说话由球表现,2026-09-24 维护者);接通前来回扫,接通时淡出。
        看的是「谁在出声」(talkMode),不是球的样子:找项目时球在办,你开口光照升。整通电话一直挂着,不因谁说话装卸。
      */}
      <FxVoiceFloor voice={callVoice({ phase: call.phase, talk: call.talkMode, micOff: call.micOff })} />
      <div className="ba-call__captions">
        <p className="ba-call__status" role="status">{call.statusText}</p>
        {connected && call.elapsedText !== '' && (
          <p className="ba-call__elapsed" aria-label="通话时长">{call.elapsedText}</p>
        )}
        {call.scanLine !== undefined && <p className="ba-call__scan" role="status">{call.scanLine}</p>}
        {/*
          接通了却一直没听见她开口(2026-09-27,卡 fix/voice-onboarding-latency)。
          **不静默**:等一会儿说「她在准备第一句」,久到 15 秒就说清可能卡在哪 + 下一步
          (文案与时长在 useCall.ts 的 CALL_NO_VOICE_* 那一段)。
        */}
        {call.noVoiceHint !== undefined && <p className="ba-call__hint" role="status">{call.noVoiceHint}</p>}
        {call.micOff && !blocked && <p className="ba-call__micoff" role="status">{MIC_OFF_TEXT}</p>}
        {/*
          没有录音权限(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
          **不静默**:通话照常(她说得出话、打字备胎照样能用),但这一行必须在,
          而且被永久拒时要给一条能走的路 —— 再 request 一次不会弹任何东西。
        */}
        {blocked && (
          <div className="ba-call__micblock" role="alert">
            <p className="ba-call__micoff">{blocked.text}</p>
            {blocked.needsSettings && (
              <button type="button" className="ba-btn ba-call__micfix" onClick={() => { void call.openSettings(); }}>
                {MIC_SETTINGS_LABEL}
              </button>
            )}
          </div>
        )}
        {/* 引导归电脑管:这一通不开口,说清并给一条拿回来的路(2026-09-18)。 */}
        {call.leader === 'desktop' && (
          <div className="ba-call__lead" role="status">
            <p className="ba-call__micoff">{ONBOARDING_ON_DESKTOP_TEXT}</p>
            {call.takeLead !== undefined && (
              <button type="button" className="ba-btn ba-call__leadfix" onClick={() => { void takeLead(); }}>
                {TAKE_LEAD_LABEL}
              </button>
            )}
          </div>
        )}
        {call.note !== undefined && <p className="ba-call__note">{call.note}</p>}

        {call.sayDecisionCards?.map((payload, index) => <SayDecisionCards
          key={payload.say_id ?? index}
          payload={payload}
          busy={call.sayDecisionBusy}
          onChoose={(choice, askId, suggestId, decidedId) => { if (call.chooseSayDecision !== undefined) void call.chooseSayDecision(payload, choice, askId, suggestId, decidedId); }}
        />)}
        {call.sayDecisionError !== undefined && <p className="ba-call__note" role="alert">{call.sayDecisionError}</p>}

        {showSubtitles && (
          // data-ba-kb-stick:弹键盘时这一格缩进「球底到键盘上沿」那一截,滚到最底(viewport/keyboardViewport.ts,2026-09-24)。
          <div className="ba-call__subtitles" aria-label="字幕" data-ba-kb-stick="bottom">
            {call.lines.length === 0 && call.interim === undefined
              ? <p className="ba-call__subtitle ba-call__subtitle--empty">还没有字幕</p>
              : call.lines.slice(-8).map((line, index) => (
                <p className={`ba-call__subtitle ba-call__subtitle--${line.who}`} key={`${index}-${line.text}`}>
                  {line.who === 'me' ? '我:' : '事务官:'}{line.text}
                </p>
              ))}
            {/* 说到一半的那句:淡一点,而且不进纪要。看得见「她听见了」比等一句定稿更安心。 */}
            {call.interim !== undefined && (
              <p className={`ba-call__subtitle ba-call__subtitle--${call.interim.who}`} data-interim="true">
                {call.interim.who === 'me' ? '我:' : '事务官:'}{call.interim.text}…
              </p>
            )}
            {canType && (
              <div className="ba-call__type">
                {/* 统一输入框的「通话」裁剪(2026-09-24):只有文字与发送。 */}
                <PhoneComposer
                  trim="call"
                  placeholder={CALL_TYPE_PLACEHOLDER}
                  ariaLabel="打字回答"
                  onSubmit={async (d) => {
                    const text = d.text.trim();
                    if (text === '' || call.say === undefined) return false;
                    const result = await call.say(text);
                    setSendError(result.ok ? null : result.error);
                    return result.ok;
                  }}
                />
              </div>
            )}
            {sendError !== null && <p className="ba-call__note" role="alert">{sendError}</p>}
          </div>
        )}
      </div>

      <div className="ba-scene__dock ba-call__dock">
        {/*
          接不通的时候摆一个麦克风开关没有意义(根本没有上行),那时候只留一颗「关闭」。
          **声音在别的机器上时同理**(2026-09-28,座机形态):这台手机没在收音,
          摆一颗按了什么都不会变的键比没有这颗键更糟 —— 他会以为是坏了。
        */}
        {!call.failed && call.elsewhere === undefined && (
          <button
            type="button"
            className="ba-scene__icon ba-call__key"
            data-off={call.micOff}
            aria-pressed={call.micOff}
            aria-label={call.micOff ? '打开麦克风' : '关掉麦克风'}
            onClick={call.toggleMic}
          ><StageIcon name={call.micOff ? 'microphone-off' : 'microphone'} /></button>
        )}
        <button
          type="button"
          className="ba-btn ba-btn--danger ba-call__hangup"
          aria-label={call.failed ? '关闭' : '挂断'}
          disabled={call.ending}
          onClick={call.hangup}
        >{call.failed ? '关闭' : <StageIcon name="phone-off" />}</button>
        {!call.failed && (
          <button
            type="button"
            className="ba-scene__icon ba-call__key"
            aria-pressed={showSubtitles}
            aria-label={showSubtitles ? '收起字幕' : '显示字幕'}
            onClick={() => setShowSubtitles(v => !v)}
          ><StageIcon name="message-2" /></button>
        )}
      </div>
    </>
  );
}
