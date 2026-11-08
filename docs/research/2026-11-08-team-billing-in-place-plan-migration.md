# Migrating a Team Billing subscription in place instead of cancel + new Checkout

Date: 2026-11-08 · Author: Hypatia (Research) · Status: evaluation only, no code changed

## Question

The manager's ask: "changing a subscription currently requires cancelling and starting a new one; it
should be possible to migrate between subscriptions. Evaluate how this might be accomplished."

In detail:

1. Which plan changes still force cancel + new Checkout today, in Sporades and in each derived app
   (daily-build-template, TallyTray, Voxuse)? For each, is the limit in Stripe, in Sporades or in the
   app UI?
2. What does Stripe allow in place, according to its current docs?
3. What should `teamBilling.requestPlanTransition` gain, and how does that fit desired-state
   convergence, quarantine, the erasure fence and the Stripe fake? For changes that are true
   replacements (currency), what handover avoids both double charging and an entitlement gap?
4. What are the risks?

## Summary

**Most of the "cancel and start again" limit is not in Stripe.** Stripe can change the Price,
quantity, interval and timing of a live subscription in place. The only exceptions are a currency
change and a subscription that is already cancelled.

**What blocks it today is Sporades, plus how the apps configure it.**

- `requestPlanTransition` refuses every switch whose source and target share a quantity policy
  (`TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED`) and leaves those switches to the Customer Portal.
- The daily-build template and Voxuse give each product its own Portal configuration that lists only
  that product's Price, so the Portal cannot switch between them either.
- Their users therefore have to cancel at period end, wait for the subscription to end, and then run
  a new Checkout.
- TallyTray only has a fixed product and a team-members product, so its Studio↔Agency switch already
  migrates in place.

**Recommendation: make `requestPlanTransition` the one in-place path for every catalogue target.**

- Targets include another product, another interval (#350) and a retired legacy product.
- The server side decides timing ("now" or "period end") and proration. The browser does not.
- Add a provider-free charge preview.
- Implement period-end changes with Stripe Subscription Schedules.
- Refuse the change, with a clear reason, while the subscription is cancelling, past-due, trialing or
  ambiguous.
- Stop `startCheckout` from opening a second Checkout while a Team already has a live subscription.

**Two Stripe changes since the current code was written matter here.**

- From API `2025-09-30.clover` on, new subscriptions default to *flexible* billing mode, and flexible
  mode **never resets the billing cycle anchor on an interval change** [2][3]. Sporades pins
  `2026-08-26.dahlia`, so PR #361's monthly↔annual switch probably would not bill the annual amount
  at the switch. The Stripe fake models the classic behaviour instead.
- `2026-09-30.endive` turns `billing_cycle_anchor` into an object [16].

**A currency change cannot be done in place [7].** The cleanest handover follows Stripe's own
procedure [8]:

1. Collect a payment method first.
2. Cancel the old subscription with no proration.
3. Create the new-currency subscription anchored at the old period end, with no proration.

Entitlement is held across the gap by a runtime-owned handover latch.

**Seven draft issues follow.** Issues 1–4 are the core work. Issues 6 and 7 wait on #353 and #352.

Confidence: high on the Sporades and app findings (read from code at `origin/main`). High on the
Stripe facts quoted from docs.stripe.com on 2026-11-08. **Medium** on three Stripe behaviours the
docs do not spell out; they are marked *unconfirmed* below and should be checked with Stripe test
clocks before implementation.

## Findings

### 1. What Sporades does today (v0.9.46 `main`, plus open PR #361)

| Surface | What it does | Where |
| --- | --- | --- |
| `startCheckout` | Creates a new subscription. It reuses the Team's Customer. It does **not** check whether the Team already has a live subscription. | `src/team-billing-runtime.ts:252-300`, `checkoutDesiredState` at :858 |
| `openPortal` | Attests the explicit `bpc_…` configuration. Requires `default_allowed_updates == ["price"]`, quantity editing off, cancellation `at_period_end`, and an exact Product→Price list whose products share one quantity policy. It does **not** attest `subscription_update.proration_behavior`, `billing_cycle_anchor` or `schedule_at_period_end`. | `src/stripe-team-billing-provider.ts:382-417` |
| `requestPlanTransition` | Allowed only when the source and target **differ** in quantity policy. Otherwise it fails with `TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED`. It updates the single item's Price and quantity with `create_prorations`, a stable `proration_date` and `pending_if_incomplete`, and always applies immediately. | `src/team-billing-management.ts:17-66`, `:558`; provider `:85-129` |
| Admission state | `currentSubscription` takes rows in `state IN ('active','past-due')`. "Cancelling" is stored as `active` with `cancelAtPeriodEnd=1`, so cancelling and past-due Teams **are admitted**. No live subscription, or more than one, raises `PROVIDER_STATE_AMBIGUOUS`. | `team-billing-management.ts:466-471` |
| Convergence | Accepts Stripe statuses `active`, `past_due` and `unpaid`. Anything else (`trialing`, `incomplete`, `paused`) is quarantined as `provider-state-ambiguous`. A `cancel_at` that differs from the item's `current_period_end` is also quarantined. | `src/team-billing-convergence.ts:245-260` |
| Payment action | If the update leaves a `pending_update`, the operation fails as `PAYMENT_ACTION_REQUIRED` "for app-owned recovery". No recovery URL is exposed. | provider `:110-128`, management `:190` |
| Stripe fake | `subscriptions.update` accepts exactly `items`, `proration_behavior`, `proration_date` and `payment_behavior`. It has no schedules, no `invoices.createPreview`, no `billing_cycle_anchor`, no trials and no currency. PR #361 adds "an interval change resets the period", which is the *classic* behaviour. | `src/testing/stripe.ts:284-300`; PR #361 docs |
| API version | `2026-08-26.dahlia` throughout the repo. TallyTray's archived notes use `2026-07-29.dahlia`. Its live config is sealed, so the live version is an assumption. | grep of `src`/`docs` |

In-flight work:

- **#350 / PR #361 (open):** several Prices per product (`month:1`, `year:1`). PR #361 already routes
  interval changes through the managed path and adds `interval` to `authorize`, billing truth and the
  fake.
- **#351 / PR #363 (open):** usage-counted quantity.
- **#352:** `currency_options`. Its own proposal says a cross-currency transition should be refused.
- **#353:** trial days, with `trialing` as an entitled state.

### 2. The derived apps (read at `origin/main`, 2026-11-08)

**daily-build-template**

- Catalogue: one fixed-1 product (`standard`, £15/month, tax-inclusive), plus `billing.free`, which is
  outside the catalogue. Activation is dormant and the IDs are placeholders.
- UI (`client/team-billing.tsx:179-202`):
  - "Start Checkout" when the state is `inactive` or `cancelled`.
  - "Manage workspace billing", which opens the Portal, in every other state.
  - "Request plan change" only when the server sets `canTransition` (state `active` *and* a different
    quantity policy, `server/team-billing.ts:187-188`).
- Each product's Portal configuration lists only its own Price (`docs/team-billing.md:257-260`).
- **Every derived app that adds a second fixed product inherits cancel → wait → Checkout.**

**TallyTray (live)**

- Catalogue: `studio` (fixed 1) and `agency` (team-members, minimum 5), monthly, one Price each.
  `freelancer` is the free plan.
- Studio↔Agency calls `requestPlanTransition` (`client/pages/settings.tsx:350-352`).
- Cancel and billing details go through the Portal.
- Plan change is hidden while cancelling, past-due, pending or attention-required.
- It went live on 2026-10-28. Production admission opened on 2026-10-29
  (`docs/operations/stripe-public-opening-2026-10-29.md`). The repo records one real £12 Studio
  smoke purchase, cancelled at period end (ends 2026-11-29). The number of other paying Teams is not
  in the repo.

**Voxuse**

- Uses the template's code. Every product is fixed 1.
- `standard` is the legacy £99 offer, now `offered:false` but with real live IDs. `solo`, `agency`
  and `studio` are coming soon.
- `canTransition` is never set, and each product has its own Portal configuration. Legacy
  subscribers therefore have no way to move to a new plan other than cancel + Checkout.
  `docs/plan-transition.md:42-56` says they "keep its contract".

### 3. What Stripe allows in place (docs.stripe.com, checked 2026-11-08)

**Price and quantity**

- `subscriptions.update` with `items[0].id` plus `price` replaces the Price on the same item.
- Quantity reverts to 1 unless it is passed again [1]. Sporades already passes it.

**Billing mode: the important 2025 change**

- On API `2025-09-30.clover` and later the default `billing_mode` for new subscriptions is
  `flexible` [2]. That covers subscriptions created through the API, Checkout, Payment Links and
  Pricing Tables.
- Existing classic subscriptions stay classic until migrated, and migration is one-way [2].
- Differences that affect plan changes [3]:
  - **Anchor.** Classic resets the anchor and invoices immediately on an interval change or a
    free→paid change. Flexible: "The changes listed in the Classic column don't reset the billing
    cycle anchor." To invoice now, pass `billing_cycle_anchor=now` or `proration_behavior=always_invoice`.
  - **Credit prorations.** Flexible computes them from the *original debited amount*, not the
    current Price.
  - **Portal cancellation.** In flexible mode the Portal sets `cancel_at`, not `cancel_at_period_end`,
    and "when an item's `current_period_end` changes, the cancellation date (`cancel_at`) isn't
    updated."
  - **Mixed intervals.** Flexible allows mixed intervals on one subscription.
- *Unconfirmed:* the docs do not show the exact item period and invoice for a lone monthly item
  switched to an annual Price in flexible mode with the anchor unchanged. Settle this with a test
  clock before Issue 2 lands.

**Endive API version**

- `2026-09-30.endive` makes `billing_cycle_anchor` on update and preview an object (`{type:'now'}` /
  `{type:'unchanged'}`) [16].
- Because the API version is Capsule-configured, the provider must encode the anchor according to
  `config.apiVersion`.

**Proration**

- `proration_behavior` is `create_prorations` (the default), `always_invoice` or `none` [1].
- "Negative prorations aren't automatically refunded and positive prorations aren't immediately
  billed" [4]. A downgrade credit lands on the customer balance in that currency [5].
- Use the same `proration_date` for the preview and the update so they match [4].
- Trap: when the latest invoice is unpaid, prorations can credit time that was never paid for [4].

**Preview**

- `GET /v1/invoices/upcoming` was removed in `2025-03-31.basil`.
- Use `POST /v1/invoices/create_preview` with `subscription`, `subscription_details.items`,
  `proration_date` and the same `proration_behavior` / `billing_cycle_anchor` [6].

**Strong customer authentication (SCA) and `pending_if_incomplete`** [9]

- If payment for the update fails, Stripe creates a `pending_update` instead of changing the items.
- It expires after 23 hours, or at the earliest period or trial end if that is sooner.
- It emits `customer.subscription.pending_update_applied` / `_expired`.
- Allowed parameters include `items` (price, quantity), `billing_cycle_anchor`, `proration_behavior`,
  `proration_date`, `trial_end` and `cancel_at_period_end`.
- A later update with non-empty `items`, `billing_cycle_anchor` or `trial_end` voids it.
- It requires `charge_automatically` and a supported payment method.

**Subscription Schedules: changes at period end** [10][11]

- Mechanism: `from_subscription`, then update with the current phase plus a new phase, then the
  `end_behavior: release` option.
- Limits:
  - At most 10 current or future phases.
  - "Stripe unsets omitted parameters."
  - While a schedule is attached, use the Schedule API, because direct subscription edits "might be
    overwritten … when the next phase is entered".
  - Do not pass `billing_mode` together with `from_subscription`.
- Portal interaction: "Customers can't update or cancel subscriptions that currently have an update
  scheduled with a subscription schedule" [12]. The Portal's own "manage downgrades" only schedules
  between Prices of the same product [13].

**Currency** [7][8][14]

- "You can't update the currencies of existing subscriptions by changing prices … you must cancel
  existing subscriptions before creating a new subscription with a new currency … you can't have two
  active subscriptions with different currencies." This applies even to multi-currency customers [7].
- Stripe's procedure [8]:
  1. Create Prices in the new currency.
  2. Void open old-currency items, invoices, quotes and discounts.
  3. Adjust or convert the old-currency balance.
  4. "Cancel any subscriptions … in the old currency with prorations disabled."
  5. "Create a subscription … in the new currency using the previous subscription's period end as the
     billing cycle anchor", with prorations disabled.
- Credit balances are kept per currency and only apply to invoices in that currency [7].

**Trials**

- `trial_end` on update moves the anchor to that time, and `trial_end=now` ends the trial [1].
- "You can update subscriptions in a trial normally" [15]. *Unconfirmed:* the docs do not say
  outright that a Price change during a trial keeps the trial. The update reference implies it,
  because only "a trial starts or ends" triggers a reset.
- Portal edits end a trial unless the configuration's `trial_update_behavior=continue_trial` [12].

**Customer Portal `subscription_update`** [12][13]

- Up to 10 products. Each can carry several Prices, but "you can't define multiple Prices with the
  same product and recurring.interval". One monthly plus one yearly Price per product is fine.
- Configurable settings: `proration_behavior` (the example object shows `none`),
  `billing_cycle_anchor` (`now` / `unchanged`, added in `2025-12-15.clover`) and
  `schedule_at_period_end.conditions`.
- Update is not offered for subscriptions with several products, usage-based billing, trial offers,
  `send_invoice`, or an attached schedule.

**Cancelled and other states**

- A `canceled` subscription is terminal and cannot be reactivated [17].
- Since 2018-02-28, a Price update no longer clears `cancel_at_period_end` [17]. That is inferred:
  only `cancel_at_period_end=false` resumes the subscription.
- *Unconfirmed:* whether a Price update on a `past_due` subscription is allowed. No explicit rule was
  found. Sporades should refuse it anyway because of the unpaid-invoice trap.

**Tax**

- Stripe Tax handles prorations, and credit notes reduce tax liability [18].
- In flexible mode, credits use the originally debited (tax-inclusive) amounts [3].

### 4. Change-type matrix

Limiting layer key: **S** = Stripe, **Sp** = Sporades runtime, **App** = app UI or configuration.
"Proposed" refers to the design in the next section.

| Change | Today (Sporades / template & Voxuse / TallyTray) | Limit | Proposed |
| --- | --- | --- | --- |
| Paid→paid, other product, **same** quantity policy (e.g. fixed→fixed) | Sp: the transition is refused and the Portal is expected to do it. Template and Voxuse: each Portal configuration has one Price, so the user must **cancel → wait → Checkout**. TallyTray: no such pair. | Sp + App | In place through `requestPlanTransition`, timing now or period end. Interim app-only fix: one shared reviewed Portal configuration per quantity policy (already supported). |
| Paid→paid, **different** quantity policy (fixed↔team-members, different floors) | In place, immediate, `create_prorations`. TallyTray uses it. | — | Same, plus timing, preview and proration policy. |
| Retired / legacy Price → new plan (Voxuse £99 `standard`) | Same as row 1: blocked unless the policies differ. | Sp + App | In place. The app keeps the legacy key as a non-offered catalogue entry, and `authorize` chooses period end to honour the contract. |
| Monthly↔annual, same product | `main`: impossible, because there is one Price per product (#350). PR #361: managed path, immediate, `create_prorations`, no anchor parameter. On a flexible subscription that probably bills nothing extra now; *unconfirmed*. | Sp (until #350), then flexible-mode semantics | Upgrade to a longer interval: `billing_cycle_anchor=now` plus `always_invoice`. Shorter interval: period end through a schedule. |
| Monthly↔annual across products | Same as the two rows above combined. | Sp | Same mechanism as the previous row. |
| Currency change | No multi-currency support (#352). | **S** (cannot be done in place) | Refused by transition. A separate **currency handover** operation (Issue 7). |
| Paid→free | Portal cancellation at period end in all three apps. That is correct, since free means no subscription. | — | Unchanged. Optionally a runtime cancel/resume command later. |
| Free→paid | Checkout. Correct, since it needs a payment method and consent. But Checkout admission does not refuse when a live subscription exists, so a direct SDK call creates a second subscription: double charge plus `attention-required`. | Sp (missing guard) | Checkout refuses `TEAM_BILLING_SUBSCRIPTION_EXISTS` while a non-terminal subscription exists. |
| From **cancelling** (`cancel_at_period_end` / `cancel_at`) | Sp admits it, Stripe keeps the cancellation, so the plan changes and then still ends. In flexible mode, a period change leaves `cancel_at ≠ current_period_end` and convergence quarantines. TallyTray and the template hide the action. | Sp + S semantics | Refuse by default (`TEAM_BILLING_SUBSCRIPTION_CANCELLING`). Optional `resume: true` clears cancellation in the same update. |
| From **past-due** | Sp admits it, and a credit for an unpaid period is possible. Apps hide the action. | Sp | Refuse (`TEAM_BILLING_PAYMENT_RECOVERY_REQUIRED`). The app routes the user to the Portal to pay. |
| From **trialing** | Convergence quarantines `trialing` (no trials until #353). | Sp | After #353: switch keeps `trial_end` by default, with an explicit `endTrial` option. |
| Cancelled → resubscribe | New Checkout, reusing the Customer. | **S** (`canceled` is terminal) | Unchanged. This is correct behaviour, not a defect. |
| Payment action on an upgrade (SCA) | Safe `failed`/`PAYMENT_ACTION_REQUIRED` with no recovery link. The pending update expires within 23 hours. | Sp | Expose a validated, expiring hosted-invoice URL capability, and observe `pending_update_applied` / `_expired`. |
| `attention-required: catalogue-mismatch` | All transitions and Portal attestation refuse. Fixing it is an operator task. | Sp (deliberate) | Keep the refusal. Recover by adding the observed Price back to the catalogue as a non-offered key, then transition. |
| `attention-required: provider-state-ambiguous` (e.g. two live subscriptions) | Refused. | Sp (deliberate) | Keep the refusal. The new Checkout guard prevents the commonest cause. |

## Recommended design

### Principles

- **Keep one in-place path.**
  - `requestPlanTransition` handles every catalogue-to-catalogue change on one live, healthy
    subscription.
  - Checkout handles only "no live subscription".
  - The Portal stays for payment methods, invoices and cancellation. It may keep same-policy
    switching for apps that want it.
- **The browser names only the target.**
  - Following the existing rule that "the browser cannot select a mode or Price", the browser sends
    `{ teamId, requestId, productKey, interval?, quoteId?, resume? }`.
  - Timing and proration are server decisions. The new `teamBilling.transitions` declaration sets the
    defaults, and `authorize` may override them per request, because it is already the downgrade-
    policy seam.

### API sketch

```ts
// server declaration (optional; omission keeps 0.9.x behaviour exactly)
teamBilling({
  ...,
  transitions: {
    immediate: { proration: "create_prorations" | "always_invoice" }, // default create_prorations
    allowSamePolicy: true,            // lift TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED
  },
  async authorize(ctx, input) {        // input gains from/to product+interval for plan-transition
    // e.g. downgrade -> period end, upgrade -> now
    return { allow: true, timing: isDowngrade(input) ? "period-end" : "now" };
  },
});

// browser
const quote = await teamBilling.previewPlanTransition({ teamId, requestId, productKey, interval });
// -> { state: "ready", quoteId, timing, currency, amountDueNow, nextInvoiceAmount,
//      nextInvoiceAt, creditCarriedForward, expiresAt }   (minor units, provider-free)
await teamBilling.requestPlanTransition({ teamId, requestId, productKey, interval, quoteId });
await teamBilling.cancelScheduledPlanTransition({ teamId, requestId });
```

### Provider mechanics

**`timing: "now"`**

- `subscriptions.update` with:
  - `items[0]` = exact item, target Price and target quantity;
  - `proration_behavior` from policy;
  - `proration_date` from the quote, or from the intent if there is no quote;
  - `payment_behavior: pending_if_incomplete`.
- When the target interval is **longer** than the source interval, also send
  `billing_cycle_anchor: now` (an object in endive) and `always_invoice`. Flexible mode would
  otherwise not charge for the new period.
- If the source subscription is classic, Sporades does not migrate it. It reads `billing_mode` and
  records it, because classic already resets the anchor on an interval change.

**`timing: "period-end"`**

- Steps:
  1. `subscriptionSchedules.create({ from_subscription })`.
  2. `subscriptionSchedules.update`: phase 1 is the current item exactly; phase 2 is the target Price
     and quantity, `proration_behavior: none`; `end_behavior: release`.
- Stripe applies phase 2 at the boundary even when the Capsule is down. That is the reason to use
  Schedules rather than a runtime timer that would have to win the race against the renewal invoice.

**Preview**

- `invoices.createPreview` with the same tuple and a `proration_date`.
- The quote binds the target, timing, proration and `proration_date` for at most about 10 minutes.
  Admission rejects stale or mismatched quotes.
- A preview call is provider I/O, so it runs as a short durable operation, like Portal, never inside
  a transaction.

### Fit with existing invariants

**Desired state (ADR 0048).** The tuple gains `targetPriceId` (already in PR #361), `timing`,
`prorationBehavior`, `anchorReset`, `quoteProrationDate` and `providerScheduleId` (private). Three
new statuses:

- `scheduled`: provider acknowledged, waiting for the phase.
- `awaiting-observation`: as today.
- Settled by exact verified `customer.subscription.updated` evidence showing the target, as today.

Latest-wins still applies:

- A new request releases or replaces the pending schedule phase in the same provider lane.
- `cancelScheduledPlanTransition` releases it.

**Seat and usage convergence (#351).**

- While a schedule is attached, quantity work must update *both* phases through
  `subscriptionSchedules.update` instead of `subscriptions.update`. Otherwise the next phase silently
  restores a stale quantity.
- This is the main extra complexity of period-end timing. It needs one lane-level router, "where do
  quantity writes go", shared by team-members and usage.

**Convergence and quarantine.**

- Record the subscription's `schedule` and `billing_mode` as private correlation.
- An unknown or foreign schedule (for example, one created in the Dashboard) does not change
  entitlement, which still follows the current items. It does make new transitions refuse
  `PROVIDER_STATE_AMBIGUOUS`.
- `pending_update` never changes entitlement; that is already true.
- Accept `cancel_at` equal to the max item `current_period_end` (Portal in flexible mode).
- When the runtime itself changed the period end, re-check the cancellation instead of quarantining.

**Erasure fence (ADR 0049).**

- `prepareErasure` already blocks new managed work.
- Quiescence must also release or cancel any runtime-created schedule before, or as part of,
  cancelling the subscription, and must discover foreign schedules through
  `subscription_schedules.list({customer})`.
- *Unconfirmed:* whether `subscriptions.cancel` succeeds while a schedule is attached. Test it and
  model the result in the fake.

**Stripe fake (`src/testing/stripe.ts`, ADR 0058).** It needs to model:

- per-subscription `billing_mode` (default flexible, plus a classic fixture);
- flexible anchor semantics (PR #361's fake currently resets the period, which is classic);
- `billing_cycle_anchor` in dahlia (string) and endive (object) forms;
- `always_invoice`;
- `invoices.createPreview`;
- a schedule subset (create `from_subscription`, update two phases, release, phase transition on
  `clock.advance`);
- `cancel_at`, `trialing` (with #353) and `currency` (with #352).

Fake acceptance stays separate from real-Stripe acceptance. Issues 2 and 4 need a sandbox test-clock
check as well.

### Currency: a true replacement (after #352)

A cross-currency switch is refused by `requestPlanTransition` (`TEAM_BILLING_CURRENCY_CHANGE_REQUIRES_HANDOVER`).
A separate durable `teamBilling.startCurrencyHandover({ teamId, requestId, productKey, interval, currency })`
runs these steps:

1. **Consent and payment method.** Stripe-hosted Checkout in `mode: "setup"` for the existing
   Customer. It locks no currency. The customer sees the new amount and currency in app copy that
   Sporades does not render.
2. **Handover latch.** After verified setup completion, inside the atomic fence, the runtime records
   a latch that keeps the current product entitled until the old `current_period_end`.
3. **Cancel the old subscription.** `subscriptions.cancel` with `prorate: false` and
   `invoice_now: false`. The customer has already paid to the period end, so there is no refund and
   no double charge.
4. **Create the new subscription.** API `subscriptions.create` in the new currency with the saved
   payment method, `billing_cycle_anchor = old current_period_end`, `proration_behavior: none` and
   idempotency from the intent. Nothing is charged until the anchor, so there is no double charge.
   Entitlement moves to the new subscription when verified evidence arrives. The latch prevents a
   gap during the seconds between steps 3 and 4.
5. **Failure handling.** If step 4 keeps failing, entitlement still runs only to the old period end,
   which the customer paid for. The operation ends `failed`, and the app offers an ordinary Checkout.

This deliberately cancels first, because one Customer cannot hold two active subscriptions in
different currencies [7]. An old-currency credit balance is stranded [7], so the app must choose
refund or forfeit before the handover starts. The runtime refuses while that balance is non-zero.

## Risks

**Double billing**

- Today the main source is a direct `startCheckout` while a subscription is live; Issue 1 fixes it.
- The "cancel at period end + new Checkout now" workaround also double-bills for the overlap.
  Removing the need for it is the point of this work.
- The currency handover is safe only with `prorate:false` cancellation and a future anchor.

**Entitlement gaps**

- A period-end change through a schedule has no gap.
- A runtime timer would leave a gap if the Capsule is down at the boundary. That is why Schedules
  are recommended.
- The currency handover relies on the latch.

**Webhook ordering**

- A schedule phase change and the renewal invoice both arrive at the boundary. The existing
  event-time ratchet and the "same time: cancellation > failure > cancelling > active" ranks still
  apply.
- A delayed pre-change `subscription.updated` cannot override a later one.
- Settlement must compare the exact target tuple, as it does today.

**Credits and refunds**

- Downgrades produce customer-balance credit, not refunds [4][5]. App copy must say so.
- Flexible-mode credits use the amounts originally charged [3].
- `pending_if_incomplete` invoices exclude existing pending items [3].

**Tax**

- Stripe Tax recalculates prorations [18].
- The prices in the derived apps are tax-inclusive, so the preview must show tax-inclusive totals.
  Sporades should pass amounts through without computing tax.

**Portal drift**

- `subscription_update.proration_behavior` is not attested today. A Portal configuration left at
  `none` makes Portal upgrades free until renewal. Issue 2 adds attestation.

**API version drift**

- The anchor encoding differs between dahlia and endive [16].
- Subscriptions created before a Capsule moved to clover or later are classic, so behaviour must be
  read per subscription.

**Live TallyTray**

- TallyTray has live paying Teams (count unknown) on monthly Studio/Agency.
- Its managed transitions already run live, so any change to the default `requestPlanTransition`
  parameters changes live billing.
- Everything here must be **opt-in through the `transitions` declaration**. With it omitted, 0.9.x
  behaviour stays byte-for-byte, and a fake test pins the existing provider tuple.
- TallyTray does not need any of this to keep working.
- Before TallyTray enables annual pricing, run a sandbox test-clock rehearsal of
  monthly→annual on a flexible subscription.

## Draft issues

Each is sized for one agent session, unless it is marked as one to split. All need public types,
`docs/reference/teams.md`, `CHANGES.md` and fake support, as the repo rules require.

1. **Team Billing: in-place transitions for every catalogue target, with state guards.**
   - Opt-in `transitions.allowSamePolicy` lifts `TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED`. This
     includes legacy, non-offered source keys.
   - Refuse with distinct safe codes while cancelling, past-due, trialing, or holding an unknown
     schedule.
   - `startCheckout` refuses `TEAM_BILLING_SUBSCRIPTION_EXISTS` while a non-terminal subscription
     exists. This one is a fix, so it is not opt-in.
   - `authorize` input gains `fromProductKey`/`fromInterval`.
   - *Depends on:* #350 / PR #361 merged, for `interval`.
2. **Team Billing: flexible-billing-mode-correct interval changes and Portal proration attestation.**
   - Read and store `billing_mode`.
   - Longer-interval upgrades send an anchor reset plus `always_invoice`.
   - Encode the anchor by API version (dahlia string, endive object).
   - Fake: per-subscription billing mode with flexible semantics, which corrects PR #361's
     classic-style reset.
   - Attest the Portal's `proration_behavior`, `billing_cycle_anchor` and `schedule_at_period_end`
     against the declaration.
   - Includes a sandbox test-clock evidence note.
   - *Depends on:* #350.
3. **Team Billing: provider-free plan-change preview quotes.**
   - `previewPlanTransition`: a durable short operation calling `invoices.createPreview`.
   - Returns a bounded quote (minor-unit amounts, currency, next invoice date, credit) and an opaque
     `quoteId` that binds `proration_date`.
   - `requestPlanTransition` accepts the `quoteId`.
   - Fake: a `createPreview` subset.
   - *Depends on:* 1 (and 2 for interval tuples).
4. **Team Billing: period-end plan changes through Subscription Schedules.**
   - `authorize` may return `timing: "period-end"`.
   - Desired state gains `scheduled`.
   - Add `cancelScheduledPlanTransition`.
   - Route seat and usage quantity writes to schedule phases while a schedule is attached.
   - Convergence records the schedule and treats foreign schedules as blocking.
   - Erasure releases or cancels schedules.
   - Fake: a schedule subset with phase transition on `clock.advance`.
   - *Depends on:* 1 and 2. *Interacts with:* #351 (usage quantities must use the same router). This
     is the largest issue; split it if the session runs long (4a: schedule plus convergence;
     4b: quantity router plus erasure).
5. **Team Billing: payment-action recovery and resume-and-switch.**
   - For `PAYMENT_ACTION_REQUIRED`, expose a validated, expiring `invoice.stripe.com` hosted-invoice
     URL capability.
   - Observe `customer.subscription.pending_update_applied` / `_expired` and settle the operation.
   - Optional `resume: true` on a transition from cancelling, which clears `cancel_at_period_end` /
     `cancel_at` in the same update.
   - *Depends on:* 1.
6. **Team Billing: transitions during trials.**
   - After `trialing` becomes entitled, a switch keeps `trial_end` by default.
   - Optional server-side `endTrial` policy.
   - Attest the Portal's `trial_update_behavior`.
   - Settle the *unconfirmed* trial-preservation behaviour with a test clock.
   - *Depends on:* #353 and 1.
7. **Team Billing: currency handover (cancel without proration plus anchored new subscription).**
   - The handover procedure described above, with a setup-mode Checkout, a handover latch and a
     stranded-balance refusal.
   - Fake: currency on subscriptions and the two-active-currencies refusal.
   - *Depends on:* #352 and 1.

**App follow-ups (each app's own repository, not Sporades issues)**

- Template and Voxuse can get in-place same-policy switching **today**, without Sporades changes:
  1. Use one shared reviewed Portal configuration per quantity policy, listing every offered Price
     of that policy.
  2. Set its `proration_behavior` to `create_prorations` or `always_invoice`.
  3. Make "Manage billing" the switch path.
- After Issue 1, switch them to `requestPlanTransition`.
- Voxuse's legacy `standard` subscribers need a business decision, period-end migration or
  grandfathering, before they are offered any of this.

## Open questions

- In flexible mode, a lone monthly item switched to an annual Price with the anchor unchanged: what
  period and invoice result? (Test clock, Issue 2.)
- Does a Price change during `trialing` keep the trial through the API? (Test clock, Issue 6.)
- Does `subscriptions.cancel` succeed while a schedule is attached, or must the schedule be released
  or cancelled first? (Issue 4.)
- Which API version does TallyTray's sealed live config pin, and are its live subscriptions classic
  or flexible? The operator should read `billing_mode` on one live subscription.
- How many live paying TallyTray Teams are there? This decides how much rehearsal Issue 2 needs
  before TallyTray adopts it.
- Should Sporades offer a runtime cancel/resume command so apps can skip the Portal for paid→free?
  Not needed for migration; left out of the draft issues.

## Sources

1. Stripe API: Update a subscription. https://docs.stripe.com/api/subscriptions/update; Change price. https://docs.stripe.com/billing/subscriptions/change-price
2. Stripe: Billing mode. https://docs.stripe.com/billing/subscriptions/billing-mode
3. Stripe: Compare classic and flexible billing mode. https://docs.stripe.com/billing/subscriptions/billing-mode/compare
4. Stripe: Prorations. https://docs.stripe.com/billing/subscriptions/prorations
5. Stripe: Customer credit balance. https://docs.stripe.com/billing/customer/balance
6. Stripe changelog: invoice preview API deprecations (2025-03-31.basil). https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations
7. Stripe: Multi-currency customers. https://docs.stripe.com/invoicing/multi-currency-customers
8. Stripe Support: Updating subscription currency. https://support.stripe.com/questions/updating-subscription-currency
9. Stripe: Pending updates. https://docs.stripe.com/billing/subscriptions/pending-updates
10. Stripe: Subscription schedules. https://docs.stripe.com/billing/subscriptions/subscription-schedules
11. Stripe: Subscription schedule use cases. https://docs.stripe.com/billing/subscriptions/subscription-schedules/use-cases
12. Stripe: Customer management (Customer Portal). https://docs.stripe.com/customer-management
13. Stripe: Configure the portal; Portal configuration object. https://docs.stripe.com/customer-management/configure-portal ; https://docs.stripe.com/api/customer_portal/configurations/object
14. Stripe Support: Why are customers locked to a currency. https://support.stripe.com/questions/why-are-customers-locked-to-a-specific-currency-and-can-not-be-moved-to-a-price-in-another-currency
15. Stripe: Free trials. https://docs.stripe.com/billing/subscriptions/trials/free-trials
16. Stripe changelog: polymorphic billing_cycle_anchor (2026-09-30.endive). https://docs.stripe.com/changelog/endive/2026-09-30/polymorphic-billing-cycle-anchor
17. Stripe: Cancel subscriptions; Subscriptions overview. https://docs.stripe.com/billing/subscriptions/cancel ; https://docs.stripe.com/billing/subscriptions/overview
18. Stripe Tax with subscriptions. https://docs.stripe.com/billing/taxes/collect-taxes

Internal: `src/team-billing-management.ts`, `src/team-billing-runtime.ts`, `src/team-billing-convergence.ts`,
`src/stripe-team-billing-provider.ts`, `src/testing/stripe.ts`, ADR 0048/0049/0058, `docs/reference/teams.md`,
issues #350–#353, PR #361 and PR #363. Derived apps at `origin/main`: daily-build-template (GitHub `main`),
TallyTray 9baca7e, Voxuse 21cfa18.
