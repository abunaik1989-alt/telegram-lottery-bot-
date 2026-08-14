import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

/**
 * ============================================================
 * LOTTERY ROUNDS
 * ============================================================
 */
export const lotteryRoundsTable = pgTable(
  "lottery_rounds",
  {
    id: serial("id").primaryKey(),

    roundNumber: integer("round_number").notNull().unique(),

    totalNumbers: integer("total_numbers").notNull().default(300),

    pricePerNumber: numeric("price_per_number", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(200),

    currency: text("currency").notNull().default("ETB"),

    /**
     * active     = users can reserve
     * drawing    = draw currently being processed
     * completed  = winner selected
     * cancelled  = manually reset/cancelled
     */
    status: text("status").notNull().default("active"),

    winnerEntryId: integer("winner_entry_id"),

    winnerNumber: integer("winner_number"),

    drawnAt: timestamp("drawn_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    closedAt: timestamp("closed_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    // Only ONE active round is allowed.
    uniqueIndex("lottery_one_active_round")
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * ============================================================
 * LOTTERY ENTRIES
 * ============================================================
 */
export const lotteryEntriesTable = pgTable(
  "lottery_entries",
  {
    id: serial("id").primaryKey(),

    /**
     * Number is unique PER ROUND, not globally.
     */
    roundId: integer("round_id")
      .notNull()
      .default(1)
      .references(() => lotteryRoundsTable.id),

    number: integer("number").notNull(),

    customerName: text("customer_name").notNull(),

    telegramUsername: text("telegram_username"),

    telegramChatId: text("telegram_chat_id").notNull(),

    phone: text("phone"),

    /**
     * am = Amharic
     * om = Afaan Oromoo
     * en = English
     */
    language: text("language").notNull().default("am"),

    status: text("status").notNull().default("reserved"),

    paymentMethod: text("payment_method"),

    paymentReference: text("payment_reference"),

    paymentProof: text("payment_proof"),

    /**
     * Exact reservation lifetime.
     */
    reservedAt: timestamp("reserved_at", {
      withTimezone: true,
    }),

    expiresAt: timestamp("expires_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * Number 25 can exist in Round 1 and Round 2,
     * but only once inside the same round.
     */
    uniqueIndex("lottery_round_number_unique").on(
      table.roundId,
      table.number,
    ),

    index("lottery_entries_round_idx").on(table.roundId),

    index("lottery_entries_chat_idx").on(table.telegramChatId),

    index("lottery_entries_status_idx").on(table.status),
  ],
);

/**
 * ============================================================
 * ACTIVITY LOG
 * ============================================================
 */
export const lotteryActivityTable = pgTable(
  "lottery_activity",
  {
    id: serial("id").primaryKey(),

    roundId: integer("round_id").references(() => lotteryRoundsTable.id),

    type: text("type").notNull(),

    message: text("message").notNull(),

    entryNumber: integer("entry_number"),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("lottery_activity_round_idx").on(table.roundId),
    index("lottery_activity_created_idx").on(table.createdAt),
  ],
);

/**
 * ============================================================
 * LEGACY / GLOBAL SETTINGS
 * ============================================================
 *
 * Kept for compatibility with your existing application.
 * Round-specific information should now live in lotteryRoundsTable.
 */
export const lotterySettingsTable = pgTable("lottery_settings", {
  id: serial("id").primaryKey(),

  totalNumbers: integer("total_numbers").notNull().default(300),

  pricePerNumber: numeric("price_per_number", {
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(200),

  currency: text("currency").notNull().default("ETB"),

  winnerNumber: integer("winner_number"),

  drawCompleted: boolean("draw_completed").notNull().default(false),

  drawnAt: timestamp("drawn_at", {
    withTimezone: true,
  }),
});

/**
 * ============================================================
 * ZOD SCHEMAS
 * ============================================================
 */
export const insertLotteryEntrySchema = createInsertSchema(
  lotteryEntriesTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertLotteryActivitySchema = createInsertSchema(
  lotteryActivityTable,
).omit({
  id: true,
  createdAt: true,
});

export const insertLotterySettingsSchema = createInsertSchema(
  lotterySettingsTable,
).omit({
  id: true,
});

export const insertLotteryRoundSchema = createInsertSchema(
  lotteryRoundsTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertLotteryEntry = z.infer<typeof insertLotteryEntrySchema>;
export type LotteryEntry = typeof lotteryEntriesTable.$inferSelect;
export type LotteryActivity = typeof lotteryActivityTable.$inferSelect;
export type LotterySettings = typeof lotterySettingsTable.$inferSelect;
export type LotteryRound = typeof lotteryRoundsTable.$inferSelect;