import type { SubscriptionWireStatus } from 'custom/web/billing/types';

export interface BackendResponse {
  data?: unknown;
  error?: {
    message: string;
    name: string;
    stack?: string;
    code?: string;
    /**
     * The 402 denial's `status` field (spec 0003 AC-2), carried verbatim
     * from the control plane response so #handleDBCall can throw a typed
     * SubscriptionInactiveError instead of a flat DatabaseError.
     */
    status?: SubscriptionWireStatus;
  };
}
