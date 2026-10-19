/** The supported Stripe protocol subset, intended only for local app acceptance tests. */
export type StripeFakeObject = Record<string, any>;
export type StripeFakeCatalogue = {
  products: Array<{ id: string; prices: Array<{ id: string; recurring: "month" | "year" }> }>;
  portalConfigurations: Array<{ id: string; products: Array<{ product: string; prices: string[] }> }>;
};
export type StripeFakeOperation =
  | "checkout.sessions.create" | "checkout.sessions.retrieve" | "checkout.sessions.expire"
  | "billingPortal.configurations.retrieve" | "billingPortal.sessions.create"
  | "subscriptions.retrieve" | "subscriptions.update" | "subscriptions.list" | "subscriptions.cancel"
  | "customers.retrieve";
export type StripeFakeFault = {
  operation: StripeFakeOperation;
  status: number | "timeout" | "paymentActionRequired" | "completeDuringExpire";
  count?: number;
  when?: "before" | "after";
};
export type StripeFakeDeliveryFault = {
  badSignature?: boolean;
  staleTimestamp?: boolean;
  /** A different correctly signed payload with the original Event ID. */
  mutatePayloadSameId?: StripeFakeObject;
};
export type StripeFakeEvent = {
  id: string; object: "event"; type: string; created: number; livemode: false;
  api_version: string; data: { object: StripeFakeObject };
};
export type StripeFakeDelivery = { eventId: string; status: number | null; error?: string };
export type StripeFakeRequest = {
  method: string; path: string; operation: StripeFakeOperation | "unsupported";
  parameters: StripeFakeObject; idempotencyKey: string | null; replay: boolean;
};
export type StripeTeamBillingFakeOptions = {
  webhookSecret: string;
  /** Literal 127.0.0.1 or [::1] with an explicit port; redirects are refused. */
  webhookTarget: string;
  catalogue: StripeFakeCatalogue;
  port?: number;
  controlPort?: number;
  delivery?: "auto" | "manual";
  /** Provider timeout faults hold the connection for longer than this duration. */
  requestTimeoutMs?: number;
  /** Maximum list page size, useful for testing discovery pagination. */
  pageSize?: number;
};
export type StripeTeamBillingFake = {
  origin: string;
  controlOrigin: string;
  close(): Promise<void>;
  checkout: {
    complete(id: string, options?: { customerId?: string }): Promise<StripeFakeObject>;
    expire(id: string): Promise<StripeFakeObject>;
  };
  portal: {
    switchPrice(id: string, priceId: string): Promise<StripeFakeObject>;
    cancelAtPeriodEnd(id: string): Promise<StripeFakeObject>;
    resume(id: string): Promise<StripeFakeObject>;
  };
  subscriptions: {
    setStatus(id: string, status: "active" | "past_due" | "unpaid" | "canceled"): Promise<StripeFakeObject>;
    setQuantity(id: string, quantity: number): Promise<StripeFakeObject>;
    /** Applies an unexpired pending update after simulated successful payment. */
    completePayment(id: string): Promise<StripeFakeObject>;
    failPayment(id: string): Promise<StripeFakeObject>;
    renew(id: string): Promise<StripeFakeObject>;
    get(id: string): StripeFakeObject;
  };
  customers: { subscriptions(id: string): StripeFakeObject[] };
  clock: { advance(seconds: number): Promise<void> };
  events: {
    pending(): StripeFakeEvent[];
    deliver(id?: string, fault?: StripeFakeDeliveryFault): Promise<StripeFakeDelivery[]>;
    deliverInOrder(ids: string[]): Promise<StripeFakeDelivery[]>;
    redeliver(id: string, fault?: StripeFakeDeliveryFault): Promise<StripeFakeDelivery>;
    emit(type: string, object: StripeFakeObject, options?: { created?: number }): Promise<StripeFakeEvent>;
    deliveries(): StripeFakeDelivery[];
  };
  faults: { inject(fault: StripeFakeFault): void; clear(): void };
  requests(): StripeFakeRequest[];
  state(): StripeFakeObject;
  reset(): void;
};
/** Starts two isolated loopback servers. Never forwards Stripe requests to Stripe. */
export function createStripeTeamBillingFake(options: StripeTeamBillingFakeOptions): Promise<StripeTeamBillingFake>;
