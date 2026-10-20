import type { Messaging } from 'firebase-admin/messaging';

import type { Messenger, PushMessage } from './notifier.js';

const INVALID = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** FCM implementation of [Messenger] using multicast (500 tokens per call). */
export class FcmMessenger implements Messenger {
  constructor(private readonly messaging: Messaging) {}

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    const invalidTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const res = await this.messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: {
          priority: 'high',
          notification: { channelId: 'tour_updates', tag: message.data.tourId },
        },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      res.responses.forEach((r, idx) => {
        if (!r.success && r.error && INVALID.has(r.error.code)) invalidTokens.push(chunk[idx]!);
      });
    }
    return { invalidTokens };
  }
}
