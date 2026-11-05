/**
 * 舞台底部那个输入框 = 统一输入框(PhoneComposer)的「手机首页」裁剪。
 *
 * 口径的来历:
 *   - 2026-09-17 Ben:「不通话时:底部只有两样——左侧一个『通话』键,右侧一个输入框。输入框点了打字,按住就录音」。
 *   - 2026-09-24 上午(统一输入框):+、@、模式与模型合一的胶囊、发送、按住说话常驻。
 *   - 2026-09-24 下午(卡 feat/phone-composer-call-slot)维护者:
 *     「现在左侧的通话按钮和输入框有点不太一致,主要是上面空了一大截,给电话挪个位置吧,参考 codex 的做法,
 *       在输入框里没有内容的时候,发送按钮就是通话按钮……检测到输入文字就变回可发送的那个按钮」;
 *     「现在输入框内的文字还是点击输入,按住说话,但实际上按住说不了话,所以提示语要换,另外增加一个小按钮供按住说话」;
 *     「……直接就是按录音按钮就好了,样式大小和发送一样啊,在发送左边,处理好间距」。
 *   所以现在:输入框只管打字(灰字「说点什么…」),右下角那颗没内容时是通话键,它左边一颗麦克风键按住说话。
 *   通话入口(能不能打、点了进通话)由舞台页传进来。
 */
import type { ComposerCurrentView } from '../api/protocol';
import type { AsrResult } from '../api/voice';
import { BEAM } from '../fx/fxModel';
import type { ComposerApi } from '../composer/composerApi';
import type { ComposerDraft } from '../composer/composerModel';
import { PhoneComposer, type PhoneCallSlot } from '../composer/PhoneComposer';

/** 输入框里那句灰字(2026-09-24 界面规矩:全局一句「说点什么…」,不再写「点击输入,按住说话」)。 */
export const FIELD_PLACEHOLDER = '说点什么…';

export interface StageComposerProps {
  /** 语音不可用(设置里关了 / 本机没配 / 出了局域网被挡过):麦克风键灰着、按下去说为什么,但**打字还得能用**。 */
  disabled?: boolean;
  disabledNote?: string;
  transcribe(wav: Blob): Promise<AsrResult>;
  /** 打出来的和说出来的都走这一条:一句话 = 一条事项。(没传 onSubmitDraft 时用它,只有正文。) */
  onText(text: string): void;
  /**
   * 统一输入框(2026-09-24):正文 + 谁来办 + 附件 + 引用一起交。传了就走它(回 true = 接住了)。
   */
  onSubmitDraft?(draft: ComposerDraft): Promise<boolean>;
  onError(text: string): void;
  /** 实时音量给球用(说话时球是「聆听」态)。 */
  onLevel?(level: number): void;
  /** 打字框有没有焦点(球的「聆听」态也认打字)。 */
  onTypingChange?(typing: boolean): void;
  /**
   * 刚说的那句在路上(动效配角,2026-09-23):输入框底边走一道光。
   * 由舞台按「一屏最多一种强效果」判好传进来;录音中这里自己再压一次(全屏录音浮层在,别抢)。
   */
  glow?: boolean;
  /** 统一输入框的菜单数据与上传(2026-09-24)。缺席 = 老样子,只有正文。 */
  api?: ComposerApi;
  /** 胶囊上此刻写什么(/state.composer)。 */
  current?: ComposerCurrentView | undefined;
  /** 通话入口(2026-09-24 收进右下角那颗):没内容时那颗就是它。缺席 = 那颗永远是发送键。 */
  call?: PhoneCallSlot;
}

export function StageComposer(props: StageComposerProps) {
  const { disabled = false, disabledNote, transcribe, onText, onSubmitDraft, onError, onLevel, onTypingChange, glow = false, api, current, call } = props;
  return (
    <PhoneComposer
      trim="phone-home"
      placeholder={FIELD_PLACEHOLDER}
      ariaLabel="打字说给事务官"
      onSubmit={async (draft) => {
        if (onSubmitDraft !== undefined) return await onSubmitDraft(draft);
        if (draft.text.trim() !== '') onText(draft.text);
        return true;
      }}
      voice={{
        disabled,
        ...(disabledNote === undefined ? {} : { disabledNote }),
        transcribe,
        onError,
        ...(onLevel === undefined ? {} : { onLevel }),
      }}
      {...(onTypingChange === undefined ? {} : { onTypingChange })}
      glow={glow}
      fxSpec={BEAM.composer}
      {...(api === undefined ? {} : { api })}
      {...(call === undefined ? {} : { call })}
      current={current}
    />
  );
}
