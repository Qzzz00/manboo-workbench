import { friendlyWhen } from '../api/protocol';
import { deliveryTitle, type RawDelivery } from './collabCore';
import type { ActorContext } from './collabModel';

/** 投递只说明送到/受理；对应这条消息的真实回执单独呈现。 */
export function DeliveryList(props: {
  messageId: string;
  deliveries: readonly RawDelivery[];
  actors?: ActorContext;
  now: string;
  onOpenTask?(id: string): void;
}) {
  const { messageId, deliveries, actors, now, onOpenTask } = props;
  return <div className="ba-collab__actquote">
    {deliveries.map((delivery) => <div key={delivery.to}>
      <span>{deliveryTitle(delivery, actors)}</span> · {friendlyWhen(delivery.at, now)}
      {delivery.taskId !== undefined && (onOpenTask === undefined
        ? <span> · 处理事项:{delivery.taskId}</span>
        : <button type="button" className="ba-collab__linkbtn" onClick={() => onOpenTask(delivery.taskId!)}>查看处理事项</button>)}
      {delivery.receipt !== undefined && (delivery.receipt.messageId === messageId
        ? <div>
            <span>对应回执:{delivery.receipt.text}</span>
            <span> · {friendlyWhen(delivery.receipt.at, now)}</span>
            {delivery.receipt.evidence.length > 0 && <div>证据:{delivery.receipt.evidence.join('、')}</div>}
          </div>
        : <div>回执关联未知,尚不能确认这条消息的处理结果</div>)}
    </div>)}
  </div>;
}
