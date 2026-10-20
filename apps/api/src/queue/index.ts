import type { DeliveryQueueMessage } from '@buzzkit/api/api/messages/index';
import { log } from '@buzzkit/api/libs/logger';
import { handleDeliveryBatch } from './deliveries';
import { type EventsQueueMessage, handleEventsBatch, handleEventsDeadLetterBatch } from './events';
import { handleWebhookBatch, type WebhookQueueMessage } from './webhooks';

export type QueueMessage = DeliveryQueueMessage | EventsQueueMessage | WebhookQueueMessage;

function handleDeadLetterBatch(batch: MessageBatch<QueueMessage>): void {
  for (const item of batch.messages) {
    log.error('[Queue] Dead-lettered message dropped, the reconcile sweep re-enqueues live work', {
      queue: batch.queue,
      body: item.body,
      attempts: item.attempts,
    });
    item.ack();
  }
}

const QUEUE_ROLES = [
  'buzzkit-events',
  'buzzkit-events-dlq',
  'buzzkit-webhooks',
  'buzzkit-webhooks-dlq',
  'buzzkit-deliveries',
  'buzzkit-deliveries-dlq',
] as const;

export type QueueRole = (typeof QUEUE_ROLES)[number];

export function resolveQueueRole(queue: string): QueueRole | null {
  return QUEUE_ROLES.find((role) => queue === role || queue.endsWith(`-${role}`)) ?? null;
}

export async function handleQueueBatch(batch: MessageBatch<QueueMessage>): Promise<void> {
  const role = resolveQueueRole(batch.queue);

  if (role === 'buzzkit-events') {
    await handleEventsBatch(batch as MessageBatch<EventsQueueMessage>);
    return;
  }

  if (role === 'buzzkit-events-dlq') {
    await handleEventsDeadLetterBatch(batch as MessageBatch<EventsQueueMessage>);
    return;
  }

  if (role === 'buzzkit-webhooks') {
    await handleWebhookBatch(batch as MessageBatch<WebhookQueueMessage>);
    return;
  }

  if (role === 'buzzkit-deliveries') {
    await handleDeliveryBatch(batch as MessageBatch<DeliveryQueueMessage>);
    return;
  }

  if (role === 'buzzkit-deliveries-dlq' || role === 'buzzkit-webhooks-dlq') {
    handleDeadLetterBatch(batch);
    return;
  }

  throw new Error(`No consumer for queue '${batch.queue}'`);
}
