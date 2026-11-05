/**
 * 「收到的文件」那一栏(2026-09-25,卡 J)。在对话记录那一页的「文件」里:
 * 一行一个(新的在前),点名字就用手机上的应用打开,右边一颗「分享」交给微信 / 邮件 / 别的 App。
 * 真相是「文档 / 事务官」那个文件夹 —— 列表现读,不另记账。
 */
import { receivedTimeText, type ReceivedFile } from './receivedFiles';
import { sizeText } from './fileFetch';
import './files.css';

export interface ReceivedFilesProps {
  files: readonly ReceivedFile[];
  note?: string | null;
  onOpen: (file: ReceivedFile) => void;
  onShare: (file: ReceivedFile) => void;
  now?: number;
}

export function ReceivedFiles({ files, note, onOpen, onShare, now }: ReceivedFilesProps) {
  return (
    <section className="ba-received" role="list" aria-label="收到的文件">
      <p className="ba-scene__recordhead">收到的文件 · 点一下打开 · 存在手机「文档 / 事务官」里</p>
      {files.length === 0 && <p className="ba-scene__recordnote">{note ?? '还没有收到过文件。在首页说一句「把某某发我」就行。'}</p>}
      {files.map((file) => (
        <div className="ba-received__row" role="listitem" key={file.path}>
          <button type="button" className="ba-received__open" onClick={() => onOpen(file)} aria-label={`打开「${file.name}」`}>
            <span className="ba-fileask__name">{file.name}</span>
            <span className="ba-fileask__meta">{[sizeText(file.bytes), receivedTimeText(file.mtime, now)].filter((part) => part !== '').join(' · ')}</span>
          </button>
          <button type="button" className="ba-scene__link ba-received__share" onClick={() => onShare(file)} aria-label={`分享「${file.name}」`}>分享</button>
        </div>
      ))}
    </section>
  );
}

/** 正在收的那一行(进度)。两种状态(通话中 / 不在通话)都摆,它不抢话:一行字 + 一条细线。 */
export function FileProgressLine({ text, received, total }: { text: string; received: number; total?: number }) {
  const pct = total === undefined || total <= 0 ? undefined : Math.min(100, Math.floor((received / total) * 100));
  return (
    <div className="ba-fileprogress" role="status" aria-live="polite">
      <p className="ba-fileprogress__text">{text}</p>
      {pct !== undefined && (
        <div className="ba-fileprogress__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      )}
    </div>
  );
}
