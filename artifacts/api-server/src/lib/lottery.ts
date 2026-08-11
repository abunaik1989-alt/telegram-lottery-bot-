import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  lotteryActivityTable,
  lotteryEntriesTable,
  lotterySettingsTable,
} from "@workspace/db";

export const TOTAL_NUMBERS = 300;
export const PRICE_PER_NUMBER = 200;
export const CURRENCY = "ETB";

export async function ensureLotterySettings() {
  const [existing] = await db
    .select()
    .from(lotterySettingsTable)
    .where(eq(lotterySettingsTable.id, 1));
  if (existing) return existing;
  const [created] = await db
    .insert(lotterySettingsTable)
    .values({
      id: 1,
      totalNumbers: TOTAL_NUMBERS,
      pricePerNumber: PRICE_PER_NUMBER,
      currency: CURRENCY,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [retried] = await db
    .select()
    .from(lotterySettingsTable)
    .where(eq(lotterySettingsTable.id, 1));
  if (!retried) throw new Error("Lottery settings could not be initialized");
  return retried;
}

export function numberStatus(
  entry: { status: string } | undefined,
): "available" | "reserved" | "paid" {
  if (!entry) return "available";
  if (entry.status === "paid") return "paid";
  return "reserved";
}

export async function addActivity(
  type: string,
  message: string,
  entryNumber: number | null,
) {
  await db.insert(lotteryActivityTable).values({ type, message, entryNumber });
}

export async function entryForApi(entry: typeof lotteryEntriesTable.$inferSelect) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export async function getSummary() {
  const settings = await ensureLotterySettings();
  const entries = await db.select().from(lotteryEntriesTable);
  const active = entries.filter((entry) => entry.status !== "rejected");
  const paidNumbers = active.filter((entry) => entry.status === "paid").length;
  const reservedNumbers = active.filter(
    (entry) => entry.status === "reserved",
  ).length;
  const proofPending = active.filter(
    (entry) => entry.status === "proof_submitted",
  ).length;
  return {
    totalNumbers: settings.totalNumbers,
    availableNumbers: settings.totalNumbers - active.length,
    reservedNumbers,
    paidNumbers,
    proofPending,
    totalCollected: paidNumbers * Number(settings.pricePerNumber),
    pricePerNumber: Number(settings.pricePerNumber),
    currency: settings.currency,
    winnerNumber: settings.winnerNumber,
    drawCompleted: settings.drawCompleted,
  };
}

export async function listNumbers(status = "all") {
  const settings = await ensureLotterySettings();
  const entries = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      inArray(lotteryEntriesTable.status, ["reserved", "proof_submitted", "paid"]),
    );
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  return Array.from({ length: settings.totalNumbers }, (_, index) => {
    const number = index + 1;
    const entry = byNumber.get(number);
    const currentStatus = numberStatus(entry);
    return {
      number,
      status: currentStatus,
      customerName: entry?.customerName ?? null,
      reservedAt: entry?.createdAt?.toISOString() ?? null,
    };
  }).filter((entry) => status === "all" || entry.status === status);
}

export async function reserveNumber(input: {
  number: number;
  customerName: string;
  telegramUsername?: string | null;
  telegramChatId: string;
  phone?: string | null;
}) {
  const settings = await ensureLotterySettings();
  if (input.number < 1 || input.number > settings.totalNumbers) {
    throw new Error("That number is outside this lottery.");
  }
  const created = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(lotteryEntriesTable)
      .where(eq(lotteryEntriesTable.number, input.number));
    if (existing && existing.status !== "rejected") {
      throw new Error("That number is no longer available.");
    }
    if (existing) {
      const [updated] = await tx
        .update(lotteryEntriesTable)
        .set({
          ...input,
          status: "reserved",
          paymentMethod: null,
          paymentReference: null,
          paymentProof: null,
          updatedAt: new Date(),
        })
        .where(eq(lotteryEntriesTable.id, existing.id))
        .returning();
      return updated;
    }
    const [inserted] = await tx
      .insert(lotteryEntriesTable)
      .values({ ...input, status: "reserved" })
      .returning();
    return inserted;
  });
  if (!created) throw new Error("The number could not be reserved.");
  await addActivity(
    "reservation",
    `${created.customerName} reserved number ${created.number}.`,
    created.number,
  );
  return entryForApi(created);
}

export async function submitProof(
  id: number,
  input: {
    paymentMethod: "bank" | "telebirr";
    paymentReference: string;
    paymentProof: string;
  },
) {
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({ ...input, status: "proof_submitted", updatedAt: new Date() })
    .where(
      and(
        eq(lotteryEntriesTable.id, id),
        eq(lotteryEntriesTable.status, "reserved"),
      ),
    )
    .returning();
  if (!updated) throw new Error("Reservation not found or already processed.");
  await addActivity(
    "proof_submitted",
    `Payment proof submitted for number ${updated.number}.`,
    updated.number,
  );
  return entryForApi(updated);
}

export async function approveEntry(id: number) {
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({ status: "paid", updatedAt: new Date() })
    .where(
      and(
        eq(lotteryEntriesTable.id, id),
        eq(lotteryEntriesTable.status, "proof_submitted"),
      ),
    )
    .returning();
  if (!updated) throw new Error("Only submitted payment proofs can be approved.");
  await addActivity(
    "approved",
    `Payment approved for number ${updated.number}.`,
    updated.number,
  );
  return entryForApi(updated);
}

export async function rejectEntry(id: number) {
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(lotteryEntriesTable.id, id),
        inArray(lotteryEntriesTable.status, ["reserved", "proof_submitted"]),
      ),
    )
    .returning();
  if (!updated) throw new Error("This entry cannot be rejected.");
  await addActivity(
    "rejected",
    `Payment rejected and number ${updated.number} released.`,
    updated.number,
  );
  return entryForApi(updated);
}

export async function drawWinner() {
  const settings = await ensureLotterySettings();

  const paid = await db
    .select()
    .from(lotteryEntriesTable)
    .where(eq(lotteryEntriesTable.status, "paid"));
  if (paid.length === 0) throw new Error("At least one paid entry is required.");

  // 1. Select the winner from paid numbers
  const winner = paid[Math.floor(Math.random() * paid.length)];
  const drawnAt = new Date().toISOString();

  // 2. Log winner activity
  await addActivity(
    "draw",
    `Number ${winner.number} won the lottery (${winner.customerName}). Board auto-reset for next round.`,
    winner.number,
  );

  // 3. AUTO-RESET: Clear all entries so all 300 numbers become available again
  await db.delete(lotteryEntriesTable);

  // 4. Reset draw status in settings so a new draw can take place later
  await db
    .update(lotterySettingsTable)
    .set({
      winnerNumber: winner.number,
      drawCompleted: false,
      drawnAt: new Date(),
    })
    .where(eq(lotterySettingsTable.id, 1));

  return {
    winnerNumber: winner.number,
    customerName: winner.customerName,
    telegramUsername: winner.telegramUsername,
    drawnAt,
  };
}

export async function recentActivity() {
  const rows = await db
    .select()
    .from(lotteryActivityTable)
    .orderBy(desc(lotteryActivityTable.createdAt))
    .limit(20);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    entryNumber: row.entryNumber,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function allEntries(status = "all") {
  const rows = await db
    .select()
    .from(lotteryEntriesTable)
    .orderBy(desc(lotteryEntriesTable.updatedAt));
  return rows
    .filter((row) => status === "all" || row.status === status)
    .map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
}

export async function findCustomerEntry(chatId: string) {
  const [entry] = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      and(
        eq(lotteryEntriesTable.telegramChatId, chatId),
        inArray(lotteryEntriesTable.status, [
          "reserved",
          "proof_submitted",
          "paid",
        ]),
      ),
    )
    .orderBy(desc(lotteryEntriesTable.updatedAt))
    .limit(1);
  return entry;
}
