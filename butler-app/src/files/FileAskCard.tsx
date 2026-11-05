/**
 * 「把工作台仓库的 README 发到我手机上」打完之后那张卡(2026-09-25,卡 J)。
 *
 * **他点「发到这台手机」那一下就是复述确认** —— 电话里是「她先念一遍、他说对」,打字这条换成了手指:
 * 卡上写着找到的是哪一个(文件名、在哪台电脑的哪个项目里、多大),**不念也不写路径**。
 * 找到好几个就一行一个,点哪个取哪个;一个都没找到就把「在哪找的、找的什么」原样摆出来,
 * 给一颗「交给事务官找」(按内容找、按描述找那些,DSH 里的她做得到,这一层做不到)。
 *
 * 形状沿用「发文件选设备」那一层(底部一块、一行一个、52px 行高,单手点),不另起一种弹层。
 */
import { sizeText, type FileAsk, type FileAskHit } from './fileFetch';
import './files.css';

const KIND_TEXT: Readonly<Record<FileAskHit['kind'], string>> = {
  text: '文本',
  pdf: 'PDF',
  image: '图片',
  video: '视频',
  audio: '音频',
  other: '文件',
};

export interface FileAskCardProps {
  ask: FileAsk;
  /** 正在取的那一张单号(按钮上写「正在要…」,别让他连点两次)。 */
  busy?: string | null;
  onPick: (hit: FileAskHit) => void;
  onDismiss: () => void;
  /** 「交给事务官找」:原话照旧建一件事项(不再岔到这里)。 */
  onHandOver?: () => void;
}

export function FileAskCard({ ask, busy, onPick, onDismiss, onHandOver }: FileAskCardProps) {
  const found = ask.hits.length;
  const head = found === 0
    ? `在${ask.device}上没找到`
    : found === 1
      ? `在${ask.device}上找到了`
      : `在${ask.device}上找到 ${ask.total > found ? `${ask.total} 个,最像的 ${found} 个` : `${found} 个`}`;
  return (
    <>
      <div className="ba-scene__scrim" onClick={onDismiss} aria-hidden="true" />
      <div className="ba-scene__picker ba-fileask" role="dialog" aria-label="发到这台手机">
        <p className="ba-scene__pickerhead">{head}</p>
        {ask.hits.map((hit) => (
          <button
            type="button"
            key={hit.offer}
            className="ba-scene__pickerone ba-fileask__hit"
            disabled={busy !== undefined && busy !== null}
            onClick={() => onPick(hit)}
            aria-label={`把「${hit.name}」发到这台手机`}
          >
            <span className="ba-fileask__main">
              <span className="ba-fileask__name">{hit.name}</span>
              {/* 大小在前:窄屏上截掉的是「在哪」的尾巴,不是大小(卡 J 在 375 宽上看到的)。 */}
              <span className="ba-fileask__meta">{[sizeText(hit.bytes), hit.where === '' ? KIND_TEXT[hit.kind] : hit.where].join(' · ')}</span>
            </span>
            <span className="ba-fileask__go">{busy === hit.offer ? '正在要…' : '发到这台手机'}</span>
          </button>
        ))}
        {ask.screen !== undefined && <p className="ba-scene__recordnote ba-fileask__note">{ask.screen}</p>}
        {ask.note !== undefined && ask.note !== ask.screen && <p className="ba-scene__recordnote ba-fileask__note">{ask.note}</p>}
        <div className="ba-fileask__foot">
          <button type="button" className="ba-scene__link" onClick={onDismiss}>{found === 0 ? '知道了' : '算了'}</button>
          {onHandOver !== undefined && (
            <button type="button" className="ba-scene__link" onClick={onHandOver}>交给事务官找</button>
          )}
        </div>
      </div>
    </>
  );
}
