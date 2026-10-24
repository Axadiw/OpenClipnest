import { sql } from 'drizzle-orm';
import { boolean, check, integer, index, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './users.js';

// ---------------------------------------------------------------------------
// Payment provider state for paid plans.
//
// payment_customers — links an account to its customer at the provider.
// subscriptions     — one row per subscription, as the provider last reported it.
// payment_events    — one row per received webhook event; makes handling idempotent.
// ---------------------------------------------------------------------------
export const paymentCustomers = pgTable('payment_customers', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  providerCustomerId: text('provider_customer_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerSubscriptionId: text('provider_subscription_id').notNull().unique(),
    status: text('status').notNull(),
    priceLookupKey: text('price_lookup_key'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    waiverAcceptedAt: timestamp('waiver_accepted_at', { withTimezone: true }),
    scheduledPriceLookupKey: text('scheduled_price_lookup_key'),
    scheduledChangeAt: timestamp('scheduled_change_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('subscriptions_user_id_idx').on(table.userId),
  }),
);

export const paymentEvents = pgTable('payment_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
});

export type PaymentCustomer = typeof paymentCustomers.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type PaymentEvent = typeof paymentEvents.$inferSelect;

// payment_reconcile_runs — one row per daily reconciliation run; a row without
// finished_at is a run that was killed before it ended.
export const paymentReconcileRuns = pgTable('payment_reconcile_runs', {
  id: serial('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  checked: integer('checked').notNull().default(0),
  drifted: integer('drifted').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  overridesExpired: integer('overrides_expired').notNull().default(0),
  downgradesCancelled: integer('downgrades_cancelled').notNull().default(0),
  // Granted plans (invite or admin, no override) whose date passed and that the run locked.
  grantsExpired: integer('grants_expired').notNull().default(0),
  truncated: boolean('truncated').notNull().default(false),
});

// purchase_statements — the statement a user made when buying a plan or moving
// to a higher one: which version, in which language, the exact text shown, the
// terms version and when. confirmation_* track the confirmation e-mail: the
// invoice it is reserved for, when the reservation was taken (a lease against
// two deliveries sending it twice) and when it was sent.
export const purchaseStatements = pgTable(
  'purchase_statements',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'purchase' | 'upgrade'>().notNull(),
    version: text('version').notNull(),
    language: text('language').$type<'pl' | 'en'>().notNull(),
    statementText: text('statement_text').notNull(),
    termsVersion: text('terms_version').notNull(),
    planName: text('plan_name').notNull(),
    priceLookupKey: text('price_lookup_key').notNull(),
    fromPriceLookupKey: text('from_price_lookup_key'),
    requestId: text('request_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    confirmationInvoiceId: text('confirmation_invoice_id'),
    confirmationClaimedAt: timestamp('confirmation_claimed_at', { withTimezone: true }),
    confirmationSentAt: timestamp('confirmation_sent_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('purchase_statements_user_idx').on(t.userId, t.acceptedAt),
    requestUq: uniqueIndex('purchase_statements_request_uq').on(t.userId, t.requestId).where(sql`${t.requestId} IS NOT NULL`),
    confirmationInvoiceUq: uniqueIndex('purchase_statements_confirmation_invoice_uq').on(t.confirmationInvoiceId).where(sql`${t.confirmationInvoiceId} IS NOT NULL`),
    kindCheck: check('purchase_statements_kind_check', sql`${t.kind} IN ('purchase', 'upgrade')`),
    languageCheck: check('purchase_statements_language_check', sql`${t.language} IN ('pl', 'en')`),
  }),
);
