/**
 * Order lifecycle. Transitions are an explicit whitelist — anything not listed
 * throws. There is no "force" parameter and no way for the AI to skip a state.
 */
export const ORDER_STATUSES = [
  'DRAFT', 'CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION', 'CONFIRMED',
  'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED',
  'CANCELLED', 'REJECTED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'CUSTOMER_NO_SHOW',
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT:                  ['CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION', 'CANCELLED', 'EXPIRED'],
  CLARIFICATION_REQUIRED: ['DRAFT', 'READY_FOR_CONFIRMATION', 'CANCELLED', 'EXPIRED'],
  READY_FOR_CONFIRMATION: ['DRAFT', 'CLARIFICATION_REQUIRED', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED:              ['RECEIVED', 'CANCELLED'],
  RECEIVED:               ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED:               ['PREPARING', 'CANCELLED', 'REJECTED'],
  PREPARING:              ['READY', 'CANCELLED'],
  READY:                  ['PICKED_UP', 'CUSTOMER_NO_SHOW', 'CANCELLED'],
  PICKED_UP:              ['COMPLETED', 'REFUND_PENDING'],
  COMPLETED:              ['REFUND_PENDING'],
  CANCELLED:              ['REFUND_PENDING'],
  REJECTED:               ['REFUND_PENDING'],
  REFUND_PENDING:         ['REFUNDED'],
  REFUNDED:               [],
  EXPIRED:                [],
  CUSTOMER_NO_SHOW:       ['COMPLETED', 'REFUND_PENDING'],
};

/** Statuses where the order has left the conversation and belongs to the kitchen. */
export const LIVE_KITCHEN_STATUSES: OrderStatus[] = ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY'];
/** Statuses the customer can still cancel by themselves. */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = [
  'DRAFT', 'CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION', 'CONFIRMED', 'RECEIVED', 'ACCEPTED',
];
/** Statuses that count as revenue. */
export const REVENUE_STATUSES: OrderStatus[] = ['PICKED_UP', 'COMPLETED'];

export class IllegalTransitionError extends Error {
  constructor(public from: OrderStatus, public to: OrderStatus) {
    super(`Illegal order transition ${from} -> ${to}. Allowed: ${TRANSITIONS[from].join(', ') || '(none)'}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
