/**
 * 没有形象时的占位:一颗声纹球(与电脑端同一个意象,《HER》那种)。
 * 四态用形态区分:待命=呼吸,聆听=外圈随音量起伏,在办=缓慢脉动,需要你=琥珀色;
 * 说话准备(引导里事务官在想)=外圈亮起、核心略收。
 */
export type OrbMode = 'idle' | 'listening' | 'working' | 'attention' | 'preparing';

interface Props {
  mode: OrbMode;
  /** 0~1,聆听 / 说话时的实时电平。 */
  level?: number;
  note?: string;
}

export function Orb({ mode, level = 0, note }: Props) {
  const ring = 1 + Math.min(1, level) * 0.35;
  return (
    <div className="ba-orb" data-mode={mode}>
      <div className="ba-orb__ring" style={{ transform: `scale(${ring.toFixed(3)})` }} aria-hidden />
      <div className="ba-orb__core" aria-hidden />
      {note !== undefined && <p className="ba-orb__note">{note}</p>}
    </div>
  );
}
