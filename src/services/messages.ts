import type { EventType } from './events.js';

/**
 * Push notification text. Inbox items stay structured (type + names) and are
 * rendered — and localised — by the app; only the OS-level push needs text
 * from the server. English only for now.
 */
export function pushText(
  type: EventType | 'tourDeletionSoon',
  p: { actor: string; tour: string; date?: string },
): { title: string; body: string } {
  const t = p.tour || 'Your tour';
  switch (type) {
    case 'joinRequest':
      return { title: t, body: `${p.actor} asked to join` };
    case 'joinApproved':
      return { title: t, body: 'Your request to join was approved' };
    case 'joinRejected':
      return { title: t, body: 'Your request to join was declined' };
    case 'settlementSubmitted':
      return { title: t, body: `${p.actor} recorded a payment for you to confirm` };
    case 'settlementConfirmed':
      return { title: t, body: `${p.actor} confirmed your payment` };
    case 'settlementDisputed':
      return { title: t, body: `${p.actor} disputed a payment` };
    case 'tourClosed':
      return { title: t, body: `${p.actor} closed the tour` };
    case 'tourReopened':
      return { title: t, body: `${p.actor} reopened the tour` };
    case 'roleChanged':
      return { title: t, body: `${p.actor} changed your role` };
    case 'expenseAdded':
      return { title: t, body: `${p.actor} added an expense` };
    case 'expenseEdited':
      return { title: t, body: `${p.actor} edited an expense` };
    case 'expenseDeleted':
      return { title: t, body: `${p.actor} deleted an expense` };
    case 'planAdded':
      return { title: t, body: `${p.actor} added to the plan` };
    case 'planEdited':
      return { title: t, body: `${p.actor} updated the plan` };
    case 'tourDeletionSoon':
      return {
        title: t,
        body: `This tour will be deleted on ${p.date ?? 'soon'}. Settle up and save anything you need.`,
      };
  }
}
