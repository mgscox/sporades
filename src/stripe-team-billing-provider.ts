import { normalizeTeamBillingPortalPolicy } from "./team-billing-portal-policy.js";
import { teamBillingPeriodAt } from "./team-billing-subscription-semantics.js";
import { validBillingCurrency } from "./team-billing-prices.js";
import Stripe from "stripe";
import { teamBillingTransitionRefusal } from "./team-billing-subscription-semantics.js";
import { validTeamBillingHostedInvoiceUrl } from "./team-billing-payment-action.js";

type LooseRecord = Record<string, any>;

/** Internal purpose-specific provider seam for the headless Team Checkout Job. */
export function createStripeTeamBillingProvider(options: LooseRecord) {
  const config = options.config;
  const secretKey = options.env?.[config?.secretKeyEnv];
  if (!config?.enabled || typeof secretKey !== "string") throw providerFailure(false);
  const provider = loopbackProvider(options.apiBaseUrl);
  const stripe = new Stripe(secretKey, {
    apiVersion: config.apiVersion,
    timeout: config.requestTimeoutMs,
    maxNetworkRetries: 0,
    telemetry: false,
    ...(provider ?? {}),
  });
  return Object.freeze({
    async create(input: LooseRecord) {
      validateInput(input);
      throwIfAborted(options.signal);
      let session: LooseRecord;
      try {
        session = await stripe.checkout.sessions.create({
          mode: "subscription",
          ...(input.currency ? { currency: input.currency } : {}),
          line_items: [{ price: input.priceId, quantity: input.quantity }],
          success_url: new URL(input.successPath, config.publicOrigin).toString(),
          cancel_url: new URL(input.cancelPath, config.publicOrigin).toString(),
          client_reference_id: input.businessReference,
          expires_at: input.providerExpiresAt,
          metadata: { sporades_team_billing_operation: input.operationId },
          subscription_data: { metadata: { sporades_team_billing_operation: input.operationId },
            ...(input.trialDays === undefined ? {} : { trial_period_days: input.trialDays }) },
          ...(input.customerId ? { customer: input.customerId } : {}),
        }, { idempotencyKey: input.idempotencyKey });
      } catch (error: any) {
        if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
        const status = Number(error?.statusCode);
        throw providerFailure(!Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status));
      }
      throwIfAborted(options.signal);
      if (session.mode !== "subscription" || session.livemode !== config.livemode
        || session.client_reference_id !== input.businessReference || session.expires_at !== input.providerExpiresAt
        || !validSessionId(session.id) || !validUrl(session.url, session.id)
        || (input.currency && session.currency !== input.currency)
        || (input.customerId && session.customer !== input.customerId)) throw providerFailure(false);
      return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
    },
    async createCurrencySetup(input: LooseRecord) {
      validateCurrencyHandover(input, true);
      throwIfAborted(options.signal);
      try {
        await preflightCurrencyHandover(stripe, input, config.livemode);
        const session = await stripe.checkout.sessions.create({
          mode: "setup", customer: input.customerId,
          success_url: new URL(input.successPath, config.publicOrigin).toString(),
          cancel_url: new URL(input.cancelPath, config.publicOrigin).toString(),
          client_reference_id: input.operationId, expires_at: input.providerExpiresAt,
          metadata: { sporades_team_billing_operation: input.operationId },
        }, { idempotencyKey: `${input.idempotencyKey}:setup` });
        throwIfAborted(options.signal);
        if (session.mode !== "setup" || session.customer !== input.customerId || session.livemode !== config.livemode
          || session.client_reference_id !== input.operationId || session.expires_at !== input.providerExpiresAt
          || !validSessionId(session.id) || !validUrl(session.url, session.id)) throw providerFailure(false);
        return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
      } catch (error: any) { throwCurrencyProviderFailure(error); }
    },
    async replaceCurrencySubscription(input: LooseRecord) {
      validateCurrencyHandover(input, false);
      throwIfAborted(options.signal);
      try {
        let untouched = true;
        try {
          const source = await preflightCurrencyHandover(stripe, input, config.livemode);
          const session: LooseRecord = await stripe.checkout.sessions.retrieve(input.setupSessionId, { expand: ["setup_intent"] });
          const setup = session.setup_intent;
          if (session.mode !== "setup" || session.status !== "complete" || session.customer !== input.customerId
            || session.livemode !== config.livemode || session.client_reference_id !== input.operationId
            || session.metadata?.sporades_team_billing_operation !== input.operationId
            || setup?.object !== "setup_intent" || setup.status !== "succeeded" || setup.customer !== input.customerId
            || setup.livemode !== config.livemode || !/^pm_[A-Za-z0-9_]{1,240}$/.test(String(setup.payment_method))) throw providerFailure(false);
          throwIfAborted(options.signal);
          untouched = false;
          if (source.status !== "canceled") {
            const canceled = await stripe.subscriptions.cancel(input.sourceSubscriptionId,
              { prorate: false, invoice_now: false }, { idempotencyKey: `${input.idempotencyKey}:cancel` });
            if (canceled.id !== input.sourceSubscriptionId || canceled.customer !== input.customerId
              || canceled.livemode !== config.livemode || canceled.status !== "canceled") throw providerFailure(false);
          }
          throwIfAborted(options.signal);
          const created = await stripe.subscriptions.create({
            customer: input.customerId, currency: input.currency,
            items: [{ price: input.priceId, quantity: input.quantity }],
            default_payment_method: setup.payment_method,
            billing_cycle_anchor: input.anchor, proration_behavior: "none",
            metadata: { sporades_team_billing_operation: input.operationId },
          }, { idempotencyKey: `${input.idempotencyKey}:subscription` });
          throwIfAborted(options.signal);
          if (!validSubscriptionId(created.id) || created.customer !== input.customerId || created.livemode !== config.livemode
            || created.currency !== input.currency || created.billing_cycle_anchor !== input.anchor
            || created.items.data.length !== 1 || created.items.has_more
            || created.items.data[0].price.id !== input.priceId || created.items.data[0].quantity !== input.quantity) throw providerFailure(false);
          return Object.freeze({ ok: true, subscriptionId: created.id });
        } catch (error: any) { if (untouched && error?.retryable === false) error.handoverUntouched = true; throw error; }
      } catch (error: any) { throwCurrencyProviderFailure(error); }
    },
    async reconcileCurrencyHandover(input: LooseRecord) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "customerId,operationId,sourceSubscriptionId"
        || !validCustomerId(input.customerId) || !validUuid(input.operationId) || !validSubscriptionId(input.sourceSubscriptionId)) throw providerFailure(false);
      throwIfAborted(options.signal);
      try {
        let cursor: string | undefined;
        const replacements: LooseRecord[] = [];
        let sourceUncancelled = false;
        for (let page = 0; page < 4; page += 1) {
          const list: LooseRecord = await stripe.subscriptions.list({ customer: input.customerId, status: "all", limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
          if (list.object !== "list" || !Array.isArray(list.data) || typeof list.has_more !== "boolean") throw providerFailure(false);
          for (const subscription of list.data) {
            attestErasureSubscription(subscription, subscription.id, input.customerId, config.livemode);
            if (subscription.id !== input.sourceSubscriptionId) replacements.push(subscription);
            else sourceUncancelled = !["canceled", "incomplete_expired"].includes(subscription.status);
          }
          throwIfAborted(options.signal);
          if (!list.has_more) {
            const current = replacements.filter(sub => !["canceled", "incomplete_expired"].includes(sub.status));
            if (current.length > 1) throw providerFailure(false);
            return Object.freeze(current.length ? { closed: false, ...(current[0].metadata?.sporades_team_billing_operation === input.operationId ? { subscriptionId: current[0].id } : {}) } : { closed: true, sourceUncancelled });
          }
          cursor = list.data.at(-1)?.id;
          if (!validSubscriptionId(cursor)) throw providerFailure(false);
        }
        throw providerFailure(false);
      } catch (error: any) { throwCurrencyProviderFailure(error); }
    },
    async retrievePortalConfiguration(input: LooseRecord) {
      validatePortalConfigurationInput(input);
      throwIfAborted(options.signal);
      let portalConfiguration: LooseRecord;
      try {
        portalConfiguration = await stripe.billingPortal.configurations.retrieve(input.configurationId, {
          expand: ["features.subscription_update.products"],
        });
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      attestPortalConfiguration(portalConfiguration, input, config.livemode);
      return Object.freeze({ ok: true });
    },
    async createPortal(input: LooseRecord) {
      validatePortalInput(input);
      throwIfAborted(options.signal);
      const returnUrl = new URL(input.returnPath, config.publicOrigin).toString();
      let session: LooseRecord;
      try {
        session = await stripe.billingPortal.sessions.create({
          customer: input.customerId,
          configuration: input.configurationId,
          return_url: returnUrl,
        }, { idempotencyKey: input.idempotencyKey });
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      if (session.object !== "billing_portal.session" || session.customer !== input.customerId
        || session.configuration !== input.configurationId || session.livemode !== config.livemode
        || session.return_url !== returnUrl || !validPortalSessionId(session.id) || !validPortalUrl(session.url)) {
        throw providerFailure(false);
      }
      return Object.freeze({ ok: true, sessionId: session.id, url: session.url });
    },
    async updateManagedSubscription(input: LooseRecord) {
      validateManagedSubscriptionInput(input, config.livemode);
      throwIfAborted(options.signal);
      let current: LooseRecord;
      try {
        current = await stripe.subscriptions.retrieve(input.subscriptionId);
      } catch (error: any) {
        throwProviderOperationFailure(error);
      }
      throwIfAborted(options.signal);
      attestManagedSubscription(current, input, new Set([input.sourcePriceId, input.targetPriceId]), false);
      if (input.operationKind === "plan-transition") {
        const owned = input.scheduleId ?? input.releaseScheduleId ?? null;
        // A period-end write without an owned id may be recovering the schedule
        // its own stable create key already produced; its identity is verified
        // against that replayed create response below.
        const recovering = input.timing === "period-end" && owned === null;
        const refusal = teamBillingTransitionRefusal(current.status,
          input.resume !== true && (current.cancel_at_period_end === true || current.cancel_at != null),
          current.schedule != null && current.schedule !== owned && !recovering);
        if (refusal) {
          throw Object.assign(new Error("Team Billing plan transition is unavailable in the current subscription state."), { code: refusal, retryable: false });
        }
      }
      if (input.timing === "period-end") {
        throwIfAborted(options.signal);
        if (input.releaseScheduleId !== undefined) {
          // An already-detached schedule is a replay-safe acknowledgement.
          if (current.schedule == null) return Object.freeze({ ok: true, outcome: "acknowledged" });
          if (current.schedule !== input.releaseScheduleId) throw providerFailure(false);
          let released: LooseRecord;
          try {
            released = await stripe.subscriptionSchedules.release(input.releaseScheduleId, {},
              { idempotencyKey: `${input.idempotencyKey}:release` });
          } catch (error: any) { throwProviderOperationFailure(error); }
          throwIfAborted(options.signal);
          // Stripe clears `subscription` on release and records the detached
          // subscription in `released_subscription`.
          if (released?.object !== "subscription_schedule" || released.id !== input.releaseScheduleId
            || released.status !== "released" || released.livemode !== config.livemode
            || released.customer !== input.customerId
            || released.released_subscription !== input.subscriptionId
            || (released.subscription != null && released.subscription !== input.subscriptionId)) throw providerFailure(false);
          return Object.freeze({ ok: true, outcome: "acknowledged" });
        }
        const item = current.items.data[0];
        // The schedule must pin its current phase to the provider's attested
        // period, never to an implicitly derived boundary.
        const periodStart = item.current_period_start;
        const periodEnd = item.current_period_end;
        if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(periodEnd)
          || periodStart < 1 || periodEnd <= periodStart || periodEnd > 253_402_300_799) throw providerFailure(false);
        // A phase built from the source tuple would revert a Subscription that
        // already carries the target, so refuse rather than write backwards.
        if (item.price.id !== input.sourcePriceId) throw providerFailure(false);
        const currentQuantity = input.sourceQuantity ?? item.quantity;
        const phases = [
          { items: [{ price: input.sourcePriceId, quantity: currentQuantity }], start_date: periodStart, end_date: periodEnd },
          { items: [{ price: input.targetPriceId, quantity: input.targetQuantity }], start_date: periodEnd, proration_behavior: "none" as const },
        ];
        let scheduleId: string;
        if (input.scheduleId !== undefined) {
          if (current.schedule !== input.scheduleId) throw providerFailure(false);
          let updated: LooseRecord;
          try {
            updated = await stripe.subscriptionSchedules.update(input.scheduleId, { phases, end_behavior: "release" },
              { idempotencyKey: `${input.idempotencyKey}:schedule-phases` });
          } catch (error: any) { throwProviderOperationFailure(error); }
          throwIfAborted(options.signal);
          attestSchedulePhases(updated, input, "active", currentQuantity, periodStart, periodEnd);
          scheduleId = input.scheduleId;
        } else {
          let created: LooseRecord;
          try {
            created = await stripe.subscriptionSchedules.create({ from_subscription: input.subscriptionId },
              { idempotencyKey: `${input.idempotencyKey}:schedule` });
          } catch (error: any) { throwProviderOperationFailure(error); }
          throwIfAborted(options.signal);
          // The stable create key replays the schedule an earlier attempt already
          // made, even when the phase-update response was lost.
          attestCreatedSchedule(created, input, item);
          if (current.schedule != null && current.schedule !== created.id) throw providerFailure(false);
          scheduleId = created.id;
          let updated: LooseRecord;
          try {
            updated = await stripe.subscriptionSchedules.update(scheduleId, { phases, end_behavior: "release" },
              { idempotencyKey: `${input.idempotencyKey}:schedule-phases` });
          } catch (error: any) { throwProviderOperationFailure(error); }
          throwIfAborted(options.signal);
          attestSchedulePhases(updated, input, "active", currentQuantity, periodStart, periodEnd);
        }
        return Object.freeze({ ok: true, outcome: "acknowledged", scheduleId });
      }
      if ((input.endTrial === true || input.preserveTrial === true) && current.status !== "trialing") {
        const item = current.items.data[0];
        if (current.status !== "active" || current.pending_update != null
          || current.cancel_at_period_end === true || current.cancel_at != null
          || item.price.id !== input.targetPriceId || item.quantity !== input.targetQuantity) {
          throw Object.assign(new Error("Team Billing trial state changed before the switch."), {
            code: "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS", retryable: false,
          });
        }
        // A changed trial may only acknowledge an already-applied exact target.
        attestManagedSubscription(current, input, new Set([input.targetPriceId]), true);
        return Object.freeze({ ok: true, outcome: "acknowledged" });
      }

      // An applied reset needs no second POST, even after provider keys expire.
      const item = current.items.data[0];
      const recurring = item.price.recurring;
      const period = teamBillingPeriodAt(current.billing_cycle_anchor, recurring.interval, recurring.interval_count, item.current_period_start);
      const appliedReset = input.resetBillingCycle === true && current.pending_update == null
        && ["active", "trialing", "incomplete", "past_due", "unpaid"].includes(current.status)
        && item.price.id === input.targetPriceId && item.quantity === input.targetQuantity
        && Number.isSafeInteger(current.billing_cycle_anchor) && current.billing_cycle_anchor >= input.prorationDate
        && Number.isSafeInteger(item.current_period_start) && item.current_period_start >= current.billing_cycle_anchor
        && period?.start === item.current_period_start && period?.end === item.current_period_end;
      if (appliedReset && input.resume === true && (current.cancel_at_period_end === true || current.cancel_at != null)) {
        throw Object.assign(new Error("Team Billing cancellation changed after the switch."), {
          code: "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS", retryable: false,
        });
      }
      let updated: LooseRecord = current;
      if (!appliedReset) {
        try {
          updated = await stripe.subscriptions.update(input.subscriptionId, {
            items: [{
              id: input.subscriptionItemId,
              price: input.targetPriceId,
              quantity: input.targetQuantity,
            }],
            proration_behavior: input.resetBillingCycle ? "always_invoice" : "create_prorations",
            ...(input.resetBillingCycle ? { billing_cycle_anchor: billingCycleAnchorNow(config.apiVersion) } : {}),
            proration_date: input.prorationDate,
            payment_behavior: "pending_if_incomplete",
            expand: ["latest_invoice"],
            ...(input.resume === true ? { cancel_at_period_end: false } : {}),
            ...(input.endTrial === true ? { trial_end: "now" as const } : {}),
          }, { idempotencyKey: input.idempotencyKey });
        } catch (error: any) {
          throwProviderOperationFailure(error);
        }
      }
      throwIfAborted(options.signal);
      let paymentAction: { url: string; expiresAt: string } | undefined;
      if (updated.pending_update != null) {
        // pending_if_incomplete leaves the applied items unchanged. Attest the
        // requested tuple in pending_update rather than treating it as applied.
        attestManagedSubscription(updated, input, new Set([input.sourcePriceId, input.targetPriceId]), false);
        const pending = updated.pending_update;
        if (!Number.isSafeInteger(pending.expires_at) || pending.expires_at < 1
          || pending.expires_at > 253_402_300_799
          || !Array.isArray(pending.subscription_items) || pending.subscription_items.length !== 1) {
          throw providerFailure(false);
        }
        attestManagedItem(pending.subscription_items[0], input, new Set([input.targetPriceId]), true);
        // The pending update is paid on Stripe's hosted invoice page; a URL
        // from any other host is an arbitrary URL and is never surfaced.
        const invoice = updated.latest_invoice;
        if (invoice?.object !== "invoice" || !validTeamBillingHostedInvoiceUrl(invoice.hosted_invoice_url)) {
          throw providerFailure(false);
        }
        paymentAction = Object.freeze({
          url: invoice.hosted_invoice_url,
          expiresAt: new Date(pending.expires_at * 1000).toISOString(),
        });
      } else {
        attestManagedSubscription(updated, input, new Set([input.targetPriceId]), true);
      }
      const paymentActionRequired = updated.pending_update != null
        || ["incomplete", "past_due", "unpaid"].includes(updated.status);
      return Object.freeze({
        ok: true,
        outcome: paymentActionRequired ? "payment-action-required" : "acknowledged",
        ...(paymentAction ? { paymentAction } : {}),
      });
    },
    async quiesceTeamBilling(input: LooseRecord) {
      validateErasureInput(input, config.livemode);
      throwIfAborted(options.signal);
      const checkouts: LooseRecord[] = [];
      const subscriptionIds = new Set<string>(input.subscriptionIds);
      const checkoutSessionIds = new Set<string>(input.checkoutSessionIds);
      let customerId = input.customerId ?? null;
      for (const recovery of input.checkoutRecoveries ?? []) {
        let recovered: LooseRecord;
        try {
          recovered = await stripe.checkout.sessions.create(recovery.mode === "setup" ? {
            mode: "setup", customer: recovery.customerId,
            success_url: new URL(recovery.successPath, config.publicOrigin).toString(),
            cancel_url: new URL(recovery.cancelPath, config.publicOrigin).toString(),
            client_reference_id: recovery.operationId, expires_at: recovery.providerExpiresAt,
            metadata: { sporades_team_billing_operation: recovery.operationId },
          } : {
            mode: "subscription",
            ...(recovery.currency ? { currency: recovery.currency } : {}),
            line_items: [{ price: recovery.priceId, quantity: recovery.quantity }],
            success_url: new URL(recovery.successPath, config.publicOrigin).toString(),
            cancel_url: new URL(recovery.cancelPath, config.publicOrigin).toString(),
            client_reference_id: recovery.businessReference,
            expires_at: recovery.providerExpiresAt,
            metadata: { sporades_team_billing_operation: recovery.operationId },
            subscription_data: { metadata: { sporades_team_billing_operation: recovery.operationId },
              ...(recovery.trialDays === undefined ? {} : { trial_period_days: recovery.trialDays }) },
            ...(recovery.customerId ? { customer: recovery.customerId } : {}),
          }, { idempotencyKey: recovery.idempotencyKey });
        } catch (error: any) { throwProviderOperationFailure(error); }
        if (!validSessionId(recovered?.id) || recovered.client_reference_id !== recovery.operationId
          || recovered.livemode !== config.livemode || recovered.mode !== recovery.mode) throw providerFailure(false);
        checkoutSessionIds.add(recovered.id);
      }
      for (const sessionId of [...checkoutSessionIds].sort()) {
        let session: LooseRecord | null;
        try { session = await stripe.checkout.sessions.retrieve(sessionId); }
        catch (error: any) {
          if (Number(error?.statusCode) === 404) { checkouts.push({ id: sessionId, state: "safely-closed" }); continue; }
          throwProviderOperationFailure(error);
        }
        attestErasureCheckout(session, sessionId, config.livemode);
        if (session.status === "open") {
          try { session = await stripe.checkout.sessions.expire(sessionId); }
          catch (error: any) {
            if (Number(error?.statusCode) !== 404 && !isCheckoutNonExpireableRace(error)) {
              throwProviderOperationFailure(error);
            }
            try { session = await stripe.checkout.sessions.retrieve(sessionId); }
            catch (retrieval: any) {
              if (Number(retrieval?.statusCode) === 404) { checkouts.push({ id: sessionId, state: "safely-closed" }); continue; }
              throwProviderOperationFailure(retrieval);
            }
          }
          attestErasureCheckout(session, sessionId, config.livemode);
        }
        if (session.status === "complete") {
          if (session.customer && !validCustomerId(session.customer)) throw providerFailure(false);
          if (session.subscription && !validSubscriptionId(session.subscription)) throw providerFailure(false);
          if (customerId && session.customer && customerId !== session.customer) throw providerFailure(false);
          customerId ??= session.customer ?? null;
          if (session.subscription) subscriptionIds.add(session.subscription);
          checkouts.push({ id: sessionId, state: "complete" });
        } else if (session.status === "expired") checkouts.push({ id: sessionId, state: "expired" });
        else throw providerFailure(false);
      }
      const subscriptions = new Map<string, LooseRecord>();
      const scheduleIds = new Set<string>();
      const schedules: LooseRecord[] = [];
      const collectSchedule = (subscription: LooseRecord) => {
        if (subscription.schedule == null) return;
        if (!validScheduleId(subscription.schedule)) throw providerFailure(false);
        scheduleIds.add(subscription.schedule);
      };
      for (let pass = 0; pass < 4; pass += 1) {
        if (customerId) {
          let startingAfter: string | undefined;
          do {
            let page: LooseRecord;
            try { page = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) }); }
            catch (error: any) { throwProviderOperationFailure(error); }
            if (page?.object !== "list" || !Array.isArray(page.data) || typeof page.has_more !== "boolean") throw providerFailure(false);
            for (const subscription of page.data) {
              attestErasureSubscription(subscription, subscription.id, customerId, config.livemode);
              subscriptionIds.add(subscription.id);
              subscriptions.set(subscription.id, subscription);
              collectSchedule(subscription);
            }
            startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
            if (page.has_more && !validSubscriptionId(startingAfter)) throw providerFailure(false);
          } while (startingAfter);
        }
        let changed = false;
        // No live schedule may survive the fence: release every attached
        // schedule before cancelling the subscription it guards.
        for (const scheduleId of [...scheduleIds].sort()) {
          if (schedules.some((entry) => entry.id === scheduleId)) continue;
          let schedule: LooseRecord;
          try {
            schedule = await stripe.subscriptionSchedules.release(scheduleId, {},
              { idempotencyKey: erasureCancellationKey(input.idempotencyKey, scheduleId) });
          } catch (error: any) {
            if (Number(error?.statusCode) === 404) { schedules.push({ id: scheduleId, state: "safely-closed" }); continue; }
            throwProviderOperationFailure(error);
          }
          if (schedule?.object !== "subscription_schedule" || schedule.id !== scheduleId
            || !["released", "canceled"].includes(schedule.status) || schedule.livemode !== config.livemode
            || (customerId && schedule.customer !== customerId)) throw providerFailure(false);
          schedules.push({ id: scheduleId, state: schedule.status === "canceled" ? "canceled" : "released" });
        }
        schedules.sort((left, right) => left.id.localeCompare(right.id));
        for (const subscriptionId of [...subscriptionIds].sort()) {
          let subscription = subscriptions.get(subscriptionId);
          if (!subscription) {
            try { subscription = await stripe.subscriptions.retrieve(subscriptionId); }
            catch (error: any) {
              if (Number(error?.statusCode) === 404) { subscriptions.set(subscriptionId, { id: subscriptionId, safelyClosed: true }); continue; }
              throwProviderOperationFailure(error);
            }
            const inferredCustomer = subscription.customer;
            if (!customerId && validCustomerId(inferredCustomer)) customerId = inferredCustomer;
            if (!customerId) throw providerFailure(false);
            attestErasureSubscription(subscription, subscriptionId, customerId, config.livemode);
            subscriptions.set(subscriptionId, subscription);
            collectSchedule(subscription);
          }
          if (!subscription.safelyClosed && subscription.status !== "canceled") {
            try { subscription = await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey: erasureCancellationKey(input.idempotencyKey, subscriptionId) }); }
            catch (error: any) {
              if (Number(error?.statusCode) === 404) { subscriptions.set(subscriptionId, { id: subscriptionId, safelyClosed: true }); continue; }
              throwProviderOperationFailure(error);
            }
            attestErasureSubscription(subscription, subscriptionId, customerId!, config.livemode);
            if (subscription.status !== "canceled") throw providerFailure(false);
            subscriptions.set(subscriptionId, subscription);
            changed = true;
          }
        }
        if (!changed) break;
        if (pass === 3) throw providerFailure(true);
      }
      throwIfAborted(options.signal);
      return Object.freeze({
        ok: true,
        outcome: "quiesced",
        providerObservedAt: new Date().toISOString(),
        checkouts: Object.freeze(checkouts.sort((left, right) => left.id.localeCompare(right.id)).map(Object.freeze)),
        subscriptions: Object.freeze([...subscriptions.values()].sort((left, right) => left.id.localeCompare(right.id))
          .map((subscription) => Object.freeze({ id: subscription.id, state: subscription.safelyClosed ? "safely-closed" : "cancelled" }))),
        schedules: Object.freeze(schedules.map((schedule) => Object.freeze(schedule))),
      });
    },
  });
}

function validateErasureInput(input: LooseRecord, livemode: boolean) {
  const keys = Object.keys(input ?? {}).sort();
  const expected = ["checkoutSessionIds", "idempotencyKey", "mode", "subscriptionIds",
    ...(input?.customerId === undefined ? [] : ["customerId"]), ...(input?.checkoutRecoveries === undefined ? [] : ["checkoutRecoveries"])].sort();
  if (!input || typeof input !== "object" || Array.isArray(input) || keys.join("\0") !== expected.join("\0")
    || !["sandbox", "live"].includes(input.mode) || (input.mode === "live") !== livemode
    || input.customerId !== undefined && !validCustomerId(input.customerId)
    || !Array.isArray(input.checkoutSessionIds) || !input.checkoutSessionIds.every(validSessionId)
    || !Array.isArray(input.subscriptionIds) || !input.subscriptionIds.every(validSubscriptionId)
    || new Set(input.checkoutSessionIds).size !== input.checkoutSessionIds.length
    || new Set(input.subscriptionIds).size !== input.subscriptionIds.length
    || input.checkoutRecoveries !== undefined && (!Array.isArray(input.checkoutRecoveries)
      || !input.checkoutRecoveries.every((recovery: any) => { try { validateInput(recovery.mode === "setup" ? { ...recovery, mode: "subscription" } : recovery); return true; } catch { return false; } }))
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255) throw providerFailure(false);
}

function attestErasureCheckout(session: LooseRecord, sessionId: string, livemode: boolean) {
  if (session?.object !== "checkout.session" || session.id !== sessionId || !["subscription", "setup"].includes(session.mode)
    || session.livemode !== livemode || !["open", "complete", "expired"].includes(session.status)) throw providerFailure(false);
}

function attestErasureSubscription(subscription: LooseRecord, subscriptionId: string, customerId: string, livemode: boolean) {
  if (subscription?.object !== "subscription" || subscription.id !== subscriptionId
    || subscription.customer !== customerId || subscription.livemode !== livemode || typeof subscription.status !== "string") throw providerFailure(false);
}

function erasureCancellationKey(erasureKey: string, subscriptionId: string) {
  const crypto = process.getBuiltinModule("node:crypto");
  return `sporades-team-billing-cancel-${crypto.createHash("sha256").update(`${erasureKey}\0${subscriptionId}`).digest("hex")}`;
}

function validateManagedSubscriptionInput(input: LooseRecord, livemode: boolean) {
  const required = ["customerId", "idempotencyKey", "mode", "operationKind", "prorationDate", "sourcePriceId", "subscriptionId", "subscriptionItemId", "targetPriceId", "targetQuantity"];
  const keys = Object.keys(input ?? {}).filter((key) => !["targetProductId", "resume", "currency", "resetBillingCycle", "endTrial", "preserveTrial",
    "timing", "scheduleId", "sourceQuantity", "releaseScheduleId"].includes(key)).sort();
  if (!input || typeof input !== "object" || Array.isArray(input)
    || keys.join("\0") !== required.join("\0")
    || !["sandbox", "live"].includes(input.mode) || (input.mode === "live") !== livemode
    || (input.timing !== undefined && (!["now", "period-end"].includes(input.timing)
      || (input.timing === "now" && input.operationKind !== "plan-transition")))
    || (input.timing === "period-end" && (input.resetBillingCycle === true || input.endTrial === true || input.preserveTrial === true || input.resume === true))
    || (input.scheduleId !== undefined && (input.timing !== "period-end" || !validScheduleId(input.scheduleId)))
    || (input.operationKind === "seat-convergence" && input.timing === "period-end" && input.scheduleId === undefined)
    || (input.releaseScheduleId !== undefined && (input.timing !== "period-end" || !validScheduleId(input.releaseScheduleId)))
    || (input.scheduleId !== undefined && input.releaseScheduleId !== undefined)
    || (input.sourceQuantity !== undefined && (!Number.isInteger(input.sourceQuantity) || input.sourceQuantity < 1 || input.sourceQuantity > 999_999))
    || (input.resetBillingCycle !== undefined && typeof input.resetBillingCycle !== "boolean")
    || (input.resetBillingCycle === true && input.operationKind !== "plan-transition")
    || !["plan-transition", "seat-convergence"].includes(input.operationKind)
    || (input.preserveTrial !== undefined && (typeof input.preserveTrial !== "boolean" || input.operationKind !== "plan-transition"))
    || (input.preserveTrial === true && (input.endTrial === true || input.resetBillingCycle === true))
    || (input.resume !== undefined && typeof input.resume !== "boolean")
    || (input.currency !== undefined && !validBillingCurrency(input.currency))
    || (input.endTrial !== undefined && (typeof input.endTrial !== "boolean" || input.operationKind !== "plan-transition"))
    || !validCustomerId(input.customerId) || !validSubscriptionId(input.subscriptionId)
    || !validSubscriptionItemId(input.subscriptionItemId)
    || !validPriceId(input.sourcePriceId) || !validPriceId(input.targetPriceId)
    || (input.targetProductId !== undefined && !validProductId(input.targetProductId))
    || !Number.isInteger(input.targetQuantity) || input.targetQuantity < 1 || input.targetQuantity > 999_999
    || !Number.isSafeInteger(input.prorationDate) || input.prorationDate < 1
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
    || /[\r\n\0]/.test(input.idempotencyKey)) throw providerFailure(false);
}

function attestManagedSubscription(
  subscription: LooseRecord,
  input: LooseRecord,
  acceptedPriceIds: Set<string>,
  requireTarget: boolean,
) {
  const items = subscription?.items;
  if (subscription?.object !== "subscription" || subscription.id !== input.subscriptionId
    || (input.currency && subscription.currency !== input.currency)
    || subscription.customer !== input.customerId || subscription.livemode !== (input.mode === "live")
    || items?.object !== "list" || items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1) {
    throw providerFailure(false);
  }
  attestManagedItem(items.data[0], input, acceptedPriceIds, requireTarget);
}

/**
 * The schedule created from a Subscription copies the provider's current phase,
 * so attest that copy against the retrieved tuple and not against counts staged
 * after the provider read.
 */
function attestCreatedSchedule(schedule: LooseRecord, input: LooseRecord, item: LooseRecord) {
  const phase = schedule?.phases?.[0];
  if (schedule?.object !== "subscription_schedule" || !validScheduleId(schedule.id)
    || schedule.customer !== input.customerId || schedule.subscription !== input.subscriptionId
    || schedule.livemode !== (input.mode === "live") || schedule.status !== "active"
    || schedule.end_behavior !== "release" || !Array.isArray(schedule.phases) || schedule.phases.length !== 1
    || phase?.start_date !== item.current_period_start || phase?.end_date !== item.current_period_end) {
    throw providerFailure(false);
  }
  attestPhaseItem(phase, item.price.id, item.quantity);
}

/** Phase items carry either an expanded Price object or a bare Price ID across API versions. */
function attestSchedulePhases(schedule: LooseRecord, input: LooseRecord, status: string,
  currentQuantity: number, periodStart: number, periodEnd: number) {
  const phases = schedule?.phases;
  if (schedule?.object !== "subscription_schedule" || !validScheduleId(schedule.id)
    || schedule.customer !== input.customerId || schedule.subscription !== input.subscriptionId
    || schedule.livemode !== (input.mode === "live") || schedule.status !== status
    || schedule.end_behavior !== "release" || !Array.isArray(phases) || phases.length !== 2) throw providerFailure(false);
  const [currentPhase, targetPhase] = phases;
  // The current phase ends where the target phase begins: the attested period end.
  if (currentPhase?.start_date !== periodStart || currentPhase?.end_date !== periodEnd
    || targetPhase?.start_date !== periodEnd || targetPhase?.proration_behavior !== "none") throw providerFailure(false);
  attestPhaseItem(currentPhase, input.sourcePriceId, currentQuantity);
  attestPhaseItem(targetPhase, input.targetPriceId, input.targetQuantity);
}

function attestPhaseItem(phase: LooseRecord, expectedPriceId: string, expectedQuantity: number) {
  const items = phase?.items;
  if (!Array.isArray(items) || items.length !== 1) throw providerFailure(false);
  const priceId = typeof items[0]?.price === "string" ? items[0].price : items[0]?.price?.id;
  if (!validPriceId(priceId) || priceId !== expectedPriceId || items[0]?.quantity !== expectedQuantity) {
    throw providerFailure(false);
  }
}

function attestManagedItem(item: LooseRecord, input: LooseRecord, acceptedPriceIds: Set<string>, requireTarget: boolean) {
  const price = item?.price;
  // A multi-currency Price keeps its default currency in price.currency and
  // carries the subscription currency's override in price.currency_options.
  if (item?.object !== "subscription_item" || item.id !== input.subscriptionItemId
    || item.subscription !== input.subscriptionId || !acceptedPriceIds.has(price?.id)
    || (input.currency && price?.currency !== input.currency
      && !Object.hasOwn(price?.currency_options ?? {}, input.currency))
    || price?.object !== "price" || price.livemode !== (input.mode === "live")
    || !validProductId(price?.product) || price?.recurring?.usage_type !== "licensed"
    || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999_999
    || (requireTarget && price.id !== input.targetPriceId)
    || (requireTarget && item.quantity !== input.targetQuantity)
    || (requireTarget && input.targetProductId !== undefined && price.product !== input.targetProductId)) {
    throw providerFailure(false);
  }
}

function validCustomerId(value: any) {
  return typeof value === "string" && /^cus_[A-Za-z0-9_]{1,120}$/.test(value);
}

function validSubscriptionId(value: any) {
  return typeof value === "string" && /^sub_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validSubscriptionItemId(value: any) {
  return typeof value === "string" && /^si_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validScheduleId(value: any) {
  return typeof value === "string" && /^sub_sched_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validPriceId(value: any) {
  return typeof value === "string" && /^price_[A-Za-z0-9_]{1,249}$/.test(value);
}

function validProductId(value: any) {
  return typeof value === "string" && /^prod_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validatePortalConfigurationInput(input: LooseRecord) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).filter(key => !["expectedPolicy", "endTrial"].includes(key)).sort().join("\0") !== ["configurationId", "expectedProducts", "mode"].join("\0")
    || (input.endTrial !== undefined && typeof input.endTrial !== "boolean")
    || !validPortalConfigurationId(input.configurationId) || !["sandbox", "live"].includes(input.mode)
    || !Array.isArray(input.expectedProducts) || input.expectedProducts.length < 1) throw providerFailure(false);

  let previousProductId = "";
  const seenPrices = new Set<string>();
  for (const product of input.expectedProducts) {
    if (!product || typeof product !== "object" || Array.isArray(product)
      || Object.keys(product).sort().join("\0") !== "priceIds\0productId"
      || typeof product.productId !== "string" || !/^prod_[A-Za-z0-9_]{1,240}$/.test(product.productId)
      || product.productId <= previousProductId || !Array.isArray(product.priceIds) || product.priceIds.length < 1) throw providerFailure(false);
    previousProductId = product.productId;
    let previousPriceId = "";
    for (const priceId of product.priceIds) {
      if (typeof priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(priceId)
        || priceId <= previousPriceId || seenPrices.has(priceId)) throw providerFailure(false);
      previousPriceId = priceId;
      seenPrices.add(priceId);
    }
  }
}

function validatePortalInput(input: LooseRecord) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join("\0") !== ["configurationId", "customerId", "idempotencyKey", "returnPath"].join("\0")
    || !validPortalConfigurationId(input.configurationId)
    || typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId)
    || !validReturnPath(input.returnPath)
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
    || /[\r\n\0]/.test(input.idempotencyKey)) throw providerFailure(false);
}

function attestPortalConfiguration(portalConfiguration: LooseRecord, input: LooseRecord, livemode: boolean) {
  const subscriptionUpdate = portalConfiguration?.features?.subscription_update;
  let policy;
  try { policy = normalizeTeamBillingPortalPolicy(input.expectedPolicy); } catch { throw providerFailure(false); }
  const conditions = subscriptionUpdate?.schedule_at_period_end?.conditions;
  if (portalConfiguration?.object !== "billing_portal.configuration"
    || portalConfiguration.id !== input.configurationId || portalConfiguration.active !== true
    || portalConfiguration.livemode !== livemode || (input.mode === "live") !== livemode
    || portalConfiguration.features?.payment_method_update?.enabled !== true
    || portalConfiguration.features?.invoice_history?.enabled !== true
    || portalConfiguration.features?.subscription_cancel?.enabled !== true
    || portalConfiguration.features?.subscription_cancel?.mode !== "at_period_end"
    || subscriptionUpdate?.trial_update_behavior !== (input.endTrial === true ? "end_trial" : "continue_trial")
    || subscriptionUpdate?.enabled !== true
    || subscriptionUpdate.proration_behavior !== policy.prorationBehavior
    || (subscriptionUpdate.billing_cycle_anchor === null ? "unchanged" : subscriptionUpdate.billing_cycle_anchor) !== policy.billingCycleAnchor
    || !Array.isArray(conditions)
    || conditions.some((condition: any) => !condition || Object.keys(condition).join(",") !== "type")
    || !sameExactStringList(conditions.map((condition: any) => condition.type).sort(), [...policy.scheduleAtPeriodEnd])
    || !sameExactStringList(subscriptionUpdate.default_allowed_updates, ["price"])
    || !sameExactPortalProducts(subscriptionUpdate.products, input.expectedProducts)) throw providerFailure(false);
}

function sameExactPortalProducts(actual: any, expected: any[]) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized: Array<{ productId: string; priceIds: string[] }> = [];
  const seenProducts = new Set<string>();
  const seenPrices = new Set<string>();
  for (const product of actual) {
    if (!product || typeof product !== "object" || Array.isArray(product)
      || typeof product.product !== "string" || seenProducts.has(product.product)
      || product.adjustable_quantity?.enabled !== false || !Array.isArray(product.prices) || product.prices.length < 1) return false;
    seenProducts.add(product.product);
    const priceIds: string[] = [];
    for (const priceId of product.prices) {
      if (typeof priceId !== "string" || seenPrices.has(priceId) || priceIds.includes(priceId)) return false;
      priceIds.push(priceId);
      seenPrices.add(priceId);
    }
    priceIds.sort();
    normalized.push({ productId: product.product, priceIds });
  }
  normalized.sort((left, right) => left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0);
  return JSON.stringify(normalized) === JSON.stringify(expected);
}

function sameExactStringList(actual: any, expected: string[]) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validPortalConfigurationId(value: any) {
  return typeof value === "string" && /^bpc_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validPortalSessionId(value: any) {
  return typeof value === "string" && /^bps_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validPortalUrl(value: any) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com"
      || url.username || url.password || url.port) return false;
    if (/^\/p\/session\/[A-Za-z0-9_-]{8,1024}$/.test(url.pathname)) {
      return !url.search && (!url.hash || /^#[A-Za-z0-9_-]{1,1024}$/.test(url.hash));
    }
    const query = [...url.searchParams];
    return url.pathname === "/p/session" && !url.hash && query.length === 1
      && query[0][0] === "secret" && /^[A-Za-z0-9_-]{32,1024}$/.test(query[0][1]);
  } catch { return false; }
}

function isCheckoutNonExpireableRace(error: any) {
  const message = error?.raw?.message ?? error?.message;
  return Number(error?.statusCode) === 400
    && error?.type === "StripeInvalidRequestError"
    && error?.raw?.type === "invalid_request_error"
    && /^Only Checkout Sessions with a status in \["open"\] can be expired\. This Checkout Session has a status of `(complete|expired)`\.$/.test(message);
}

function throwProviderOperationFailure(error: any): never {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
  const status = Number(error?.statusCode);
  throw providerFailure(!Number.isInteger(status) || status >= 500 || [408, 409, 429].includes(status));
}

function validateInput(input: LooseRecord) {
  const required = ["businessReference", "cancelPath", "idempotencyKey", "mode", "operationId", "priceId", "productKey", "providerExpiresAt", "quantity", "successPath", "teamId"];
  const keys = Object.keys(input ?? {}).filter((key) => !["customerId", "currency", "trialDays"].includes(key)).sort();
  if (!input || typeof input !== "object" || Array.isArray(input) || keys.join("\0") !== required.sort().join("\0")
    || (input.currency !== undefined && !validBillingCurrency(input.currency))
    || input.mode !== "subscription" || !validUuid(input.operationId) || input.businessReference !== input.operationId
    || !validUuid(input.teamId) || typeof input.productKey !== "string"
    || typeof input.priceId !== "string" || !/^price_[A-Za-z0-9_]{1,249}$/.test(input.priceId)
    || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 999_999
    || (input.trialDays !== undefined && (!Number.isSafeInteger(input.trialDays) || input.trialDays < 1 || input.trialDays > 90))
    || !Number.isInteger(input.providerExpiresAt)
    || !validReturnPath(input.successPath) || !validReturnPath(input.cancelPath)
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255
    || /[\r\n\0]/.test(input.idempotencyKey)
    || (input.customerId !== undefined && (typeof input.customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,120}$/.test(input.customerId)))) throw providerFailure(false);
}

function validReturnPath(value: any) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")
    || value.includes("\\") || value.includes("?") || value.includes("#") || /\s/.test(value)) return false;
  try { return new URL(value, "https://sporades.invalid").pathname === value; } catch { return false; }
}

function validUuid(value: any) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validSessionId(value: any) {
  return typeof value === "string" && /^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(value);
}

function validUrl(value: any, sessionId: string) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com"
      && (url.pathname === `/c/pay/${sessionId}` || url.pathname === `/pay/${sessionId}`)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function loopbackProvider(value: any) {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw providerFailure(false); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw providerFailure(false);
  // Node's URL retains IPv6 brackets and elides scheme-default ports; Stripe
  // needs a bare hostname and otherwise substitutes its own default port (443).
  return {
    protocol: url.protocol.slice(0, -1) as "http" | "https",
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443,
  };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error: any = new Error("Team Checkout provider operation was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function providerFailure(retryable: boolean) {
  const error: any = new Error("Team Checkout provider operation failed.");
  error.code = retryable ? "TEAM_BILLING_PROVIDER_UNAVAILABLE" : "TEAM_BILLING_PROVIDER_REJECTED";
  error.retryable = retryable;
  return error;
}

// Stripe changed this parameter's wire shape in endive; the app may still pin dahlia.
function billingCycleAnchorNow(apiVersion: string): any {
  return apiVersion.slice(0, 10) >= "2026-09-30" ? { type: "now" } : "now";
}

function validateCurrencyHandover(input: LooseRecord, setup: boolean) {
  const keys = ["operationId", "customerId", "sourceSubscriptionId", "sourcePriceId", "sourceItemId", "sourceCurrency", "sourceQuantity", "anchor", "currency", "priceId", "quantity", "idempotencyKey",
    ...(setup ? ["successPath", "cancelPath", "providerExpiresAt"] : ["setupSessionId"])].sort();
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== keys.join()
    || !validUuid(input.operationId) || !validCustomerId(input.customerId) || !validSubscriptionId(input.sourceSubscriptionId)
    || !validPriceId(input.sourcePriceId) || !validSubscriptionItemId(input.sourceItemId) || !validPriceId(input.priceId)
    || !validBillingCurrency(input.sourceCurrency) || !validBillingCurrency(input.currency) || input.currency === input.sourceCurrency
    || ![input.quantity, input.sourceQuantity].every(q => Number.isSafeInteger(q) && q >= 1 && q <= 999_999)
    || !Number.isSafeInteger(input.anchor) || input.anchor < 1 || input.anchor > 253_402_300_799
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200 || /[\r\n\0]/.test(input.idempotencyKey)
    || (setup ? !validReturnPath(input.successPath) || !validReturnPath(input.cancelPath) || !Number.isSafeInteger(input.providerExpiresAt)
      : !validSessionId(input.setupSessionId))) throw providerFailure(false);
}

async function preflightCurrencyHandover(stripe: Stripe, input: LooseRecord, livemode: boolean) {
  const customer: LooseRecord = await stripe.customers.retrieve(input.customerId, { expand: ["invoice_credit_balance"] });
  if (customer.object !== "customer" || customer.deleted || customer.id !== input.customerId || customer.livemode !== livemode
    || !Number.isSafeInteger(customer.balance) || !customer.invoice_credit_balance || typeof customer.invoice_credit_balance !== "object"
    || Array.isArray(customer.invoice_credit_balance) || Object.values(customer.invoice_credit_balance).some(amount => !Number.isSafeInteger(amount))) throw providerFailure(false);
  if (customer.balance !== 0 || (customer.invoice_credit_balance[input.sourceCurrency] ?? 0) !== 0) {
    throw Object.assign(new Error("The old-currency customer balance must be resolved before handover."), { code: "TEAM_BILLING_CUSTOMER_BALANCE_NONZERO", retryable: false });
  }
  const source: LooseRecord = await stripe.subscriptions.retrieve(input.sourceSubscriptionId);
  attestManagedSubscription(source, { subscriptionId: input.sourceSubscriptionId, subscriptionItemId: input.sourceItemId,
    customerId: input.customerId, currency: input.sourceCurrency, mode: livemode ? "live" : "sandbox" }, new Set([input.sourcePriceId]), false);
  if (!["active", "canceled"].includes(source.status) || source.cancel_at_period_end || source.cancel_at != null
    || source.schedule != null || source.pending_update != null || source.items.data[0].quantity !== input.sourceQuantity
    || source.items.data[0].current_period_end !== input.anchor) throw providerFailure(false);
  const target: LooseRecord = await stripe.prices.retrieve(input.priceId, { expand: ["currency_options"] });
  if (target.object !== "price" || target.id !== input.priceId || target.livemode !== livemode || target.active !== true
    || target.recurring?.usage_type !== "licensed" || (target.currency !== input.currency && !target.currency_options?.[input.currency])) throw providerFailure(false);
  // Stripe only accepts a future anchor within the target's first full period.
  const start = new Date(); const end = new Date(start); const recurring = target.recurring;
  if (!Number.isSafeInteger(recurring.interval_count) || recurring.interval_count < 1) throw providerFailure(false);
  if (["day", "week"].includes(recurring.interval)) end.setUTCDate(end.getUTCDate() + recurring.interval_count * (recurring.interval === "week" ? 7 : 1));
  else if (["month", "year"].includes(recurring.interval)) {
    const day = end.getUTCDate(); end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + recurring.interval_count * (recurring.interval === "year" ? 12 : 1));
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate(); end.setUTCDate(Math.min(day, lastDay));
  } else throw providerFailure(false);
  if (input.anchor <= Math.floor(start.getTime() / 1000) || input.anchor > Math.floor(end.getTime() / 1000)) throw providerFailure(false);
  return source;
}

function throwCurrencyProviderFailure(error: any): never {
  if (["TEAM_BILLING_CUSTOMER_BALANCE_NONZERO", "TEAM_BILLING_PROVIDER_REJECTED", "TEAM_BILLING_PROVIDER_UNAVAILABLE"].includes(error?.code)) throw error;
  throwProviderOperationFailure(error);
}
