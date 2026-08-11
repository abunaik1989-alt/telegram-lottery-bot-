import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const lotteryEntriesTable = pgTable("lottery_entries", {
  id: serial("id").primaryKey(),
  number: integer("number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  telegramUsername: text("telegram_username"),
  telegramChatId: text("telegram_chat_id").notNull(),
  phone: text("phone"),
  status: text("status").notNull().default("reserved"),
  paymentMethod: text("payment_method"),
  paymentReference: text("payment_reference"),
  paymentProof: text("payment_proof"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const lotteryActivityTable = pgTable("lottery_activity", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  entryNumber: integer("entry_number"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
  drawnAt: timestamp("drawn_at", { withTimezone: true }),
});

export const insertLotteryEntrySchema = createInsertSchema(
  lotteryEntriesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLotteryActivitySchema = createInsertSchema(
  lotteryActivityTable,
).omit({ id: true, createdAt: true });
export const insertLotterySettingsSchema = createInsertSchema(
  lotterySettingsTable,
).omit({ id: true });

export type InsertLotteryEntry = z.infer<typeof insertLotteryEntrySchema>;
export type LotteryEntry = typeof lotteryEntriesTable.$inferSelect;
export type LotteryActivity = typeof lotteryActivityTable.$inferSelect;
export type LotterySettings = typeof lotterySettingsTable.$inferSelect;