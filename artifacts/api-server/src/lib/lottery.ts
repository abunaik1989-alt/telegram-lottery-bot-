import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  db,
  lotteryActivityTable,
  lotteryEntriesTable,
  lotterySettingsTable,
} from "@workspace/db";

export const TOTAL_NUMBERS = 300;
export const PRICE_PER_NUMBER = 200;
export const CURRENCY = "ETB";
export const RESERVATION_EXPIRY_MINUTES = 15;

/**
 * Initialize lottery settings if they don't exist.
 */
export async function ensureLotterySettings() {
  const [existing] = await db
    .select()
    .from(lotterySettingsTable)
    .where(eq(lotterySettingsTable.id, 1));

  if (existing) {
    return existing;
  }

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

  if (created) {
    return created;
  }

  const [retried] = await db
    .select()
    .from(lotterySettingsTable)
    .where(eq(lotterySettingsTable.id, 1));

  if (!retried) {
    throw new Error("Lottery settings could not be initialized");
  }

  return retried;
}

/**
 * Automatically reject reservations that have:
 * - status = reserved
 * - existed for more than 15 minutes
 * - no payment proof submitted
 */
export async function cleanupExpiredReservations() {
  const cutoffTime = new Date(
    Date.now() - RESERVATION_EXPIRY_MINUTES * 60 * 1000,
  );

  const expiredEntries = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      and(
        eq(lotteryEntriesTable.status, "reserved"),
        lt(lotteryEntriesTable.updatedAt, cutoffTime),
      ),
    );

  for (const entry of expiredEntries) {
    await db
      .update(lotteryEntriesTable)
      .set({
        status: "rejected",
        updatedAt: new Date(),
      })
      .where(eq(lotteryEntriesTable.id, entry.id));

    await addActivity(
      "rejected",
      `⏰ Reservation for number ${entry.number} automatically expired after ${RESERVATION_EXPIRY_MINUTES} minutes.`,
      entry.number,
    );
  }

  return expiredEntries.length;
}

/**
 * Convert database status to public number status.
 */
export function numberStatus(
  entry: { status: string } | undefined,
): "available" | "reserved" | "paid" {
  if (!entry) {
    return "available";
  }

  if (entry.status === "paid") {
    return "paid";
  }

  return "reserved";
}

/**
 * Add an activity log.
 */
export async function addActivity(
  type: string,
  message: string,
  entryNumber: number | null,
) {
  await db.insert(lotteryActivityTable).values({
    type,
    message,
    entryNumber,
  });
}

/**
 * Convert database date fields to JSON-safe strings.
 */
export async function entryForApi(
  entry: typeof lotteryEntriesTable.$inferSelect,
) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/**
 * Get lottery summary.
 */
export async function getSummary() {
  await cleanupExpiredReservations();

  const settings = await ensureLotterySettings();

  const entries = await db
    .select()
    .from(lotteryEntriesTable);

  const active = entries.filter(
    (entry) => entry.status !== "rejected",
  );

  const paidNumbers = active.filter(
    (entry) => entry.status === "paid",
  ).length;

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
    totalCollected:
      paidNumbers * Number(settings.pricePerNumber),
    pricePerNumber: Number(settings.pricePerNumber),
    currency: settings.currency,
    winnerNumber: settings.winnerNumber,
    drawCompleted: settings.drawCompleted,
    drawnAt: settings.drawnAt,
  };
}

/**
 * List lottery numbers.
 *
 * status:
 * all
 * available
 * reserved
 * paid
 */
export async function listNumbers(
  status = "all",
) {
  await cleanupExpiredReservations();

  const settings = await ensureLotterySettings();

  const entries = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      inArray(lotteryEntriesTable.status, [
        "reserved",
        "proof_submitted",
        "paid",
      ]),
    );

  const byNumber = new Map(
    entries.map((entry) => [entry.number, entry]),
  );

  return Array.from(
    { length: settings.totalNumbers },
    (_, index) => {
      const number = index + 1;

      const entry = byNumber.get(number);

      const currentStatus = numberStatus(entry);

      return {
        number,
        status: currentStatus,
        customerName: entry?.customerName ?? null,
        reservedAt:
          entry?.createdAt?.toISOString() ?? null,
      };
    },
  ).filter(
    (entry) =>
      status === "all" ||
      entry.status === status,
  );
}

/**
 * Reserve a lottery number.
 */
export async function reserveNumber(input: {
  number: number;
  customerName: string;
  telegramUsername?: string | null;
  telegramChatId: string;
  phone?: string | null;
}) {
  await cleanupExpiredReservations();

  const settings = await ensureLotterySettings();

  if (
    input.number < 1 ||
    input.number > settings.totalNumbers
  ) {
    throw new Error(
      "That number is outside this lottery.",
    );
  }

  const customerName = input.customerName.trim();

  if (!customerName) {
    throw new Error(
      "Customer name is required.",
    );
  }

  const created = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(lotteryEntriesTable)
      .where(
        eq(
          lotteryEntriesTable.number,
          input.number,
        ),
      );

    /**
     * Number is already being used.
     */
    if (
      existing &&
      existing.status !== "rejected"
    ) {
      throw new Error(
        "That number is no longer available.",
      );
    }

    /**
     * Reuse rejected number.
     */
    if (existing) {
      const [updated] = await tx
        .update(lotteryEntriesTable)
        .set({
          customerName,
          telegramUsername:
            input.telegramUsername ?? null,
          telegramChatId:
            input.telegramChatId,
          phone: input.phone ?? null,
          status: "reserved",
          paymentMethod: null,
          paymentReference: null,
          paymentProof: null,
          updatedAt: new Date(),
        })
        .where(
          eq(
            lotteryEntriesTable.id,
            existing.id,
          ),
        )
        .returning();

      return updated;
    }

    /**
     * Create a completely new entry.
     */
    const [inserted] = await tx
      .insert(lotteryEntriesTable)
      .values({
        number: input.number,
        customerName,
        telegramUsername:
          input.telegramUsername ?? null,
        telegramChatId:
          input.telegramChatId,
        phone: input.phone ?? null,
        status: "reserved",
      })
      .returning();

    return inserted;
  });

  if (!created) {
    throw new Error(
      "The number could not be reserved.",
    );
  }

  await addActivity(
    "reservation",
    `${created.customerName} reserved number ${created.number}.`,
    created.number,
  );

  return entryForApi(created);
}

/**
 * Submit payment proof.
 */
export async function submitProof(
  id: number,
  input: {
    paymentMethod:
      | "bank"
      | "telebirr";
    paymentReference: string;
    paymentProof: string;
  },
) {
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({
      paymentMethod: input.paymentMethod,
      paymentReference:
        input.paymentReference,
      paymentProof: input.paymentProof,
      status: "proof_submitted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(lotteryEntriesTable.id, id),
        eq(
          lotteryEntriesTable.status,
          "reserved",
        ),
      ),
    )
    .returning();

  if (!updated) {
    throw new Error(
      "Reservation expired or already processed.",
    );
  }

  await addActivity(
    "proof_submitted",
    `Payment proof submitted for number ${updated.number}.`,
    updated.number,
  );

  return entryForApi(updated);
}

/**
 * Approve payment proof.
 */
export async function approveEntry(id: number) {
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({
      status: "paid",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(lotteryEntriesTable.id, id),
        eq(
          lotteryEntriesTable.status,
          "proof_submitted",
        ),
      ),
    )
    .returning();

  if (!updated) {
    throw new Error(
      "Only submitted payment proofs can be approved.",
    );
  }

  await addActivity(
    "approved",
    `Payment approved for number ${updated.number}.`,
    updated.number,
  );

  return entryForApi(updated);
}

/**
 * Reject reservation/payment proof
 * and release the number.
 */
export async function rejectEntry(id: number) {
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({
      status: "rejected",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(lotteryEntriesTable.id, id),
        inArray(
          lotteryEntriesTable.status,
          [
            "reserved",
            "proof_submitted",
          ],
        ),
      ),
    )
    .returning();

  if (!updated) {
    throw new Error(
      "This entry cannot be rejected.",
    );
  }

  await addActivity(
    "rejected",
    `Payment rejected and number ${updated.number} released.`,
    updated.number,
  );

  return entryForApi(updated);
}

/**
 * Draw a random winner from paid entries.
 *
 * IMPORTANT:
 * participantChatIds are captured BEFORE
 * entries are deleted so they can still receive
 * the winner announcement.
 */
export async function drawWinner() {
  await cleanupExpiredReservations();

  const settings =
    await ensureLotterySettings();

  const paid = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      eq(
        lotteryEntriesTable.status,
        "paid",
      ),
    );

  if (paid.length === 0) {
    throw new Error(
      "At least one paid entry is required to draw a winner!",
    );
  }

  const winner =
    paid[
      Math.floor(
        Math.random() * paid.length,
      )
    ];

  const drawnAt = new Date();

  /**
   * Get every participant BEFORE clearing
   * the current round.
   */
  const allParticipants = await db
    .select({
      chatId:
        lotteryEntriesTable.telegramChatId,
    })
    .from(lotteryEntriesTable);

  const participantChatIds =
    Array.from(
      new Set(
        allParticipants
          .map((p) => p.chatId)
          .filter(
            (
              id,
            ): id is string =>
              Boolean(id),
          ),
      ),
    );

  await addActivity(
    "draw",
    `🎉 Winner drawn: Number #${winner.number} (${winner.customerName}). All entries cleared for next round.`,
    winner.number,
  );

  /**
   * Clear current round.
   */
  await db.delete(
    lotteryEntriesTable,
  );

  /**
   * Save winner information.
   */
  await db
    .update(lotterySettingsTable)
    .set({
      winnerNumber: winner.number,
      drawCompleted: true,
      drawnAt,
    })
    .where(
      eq(
        lotterySettingsTable.id,
        settings.id,
      ),
    );

  return {
    winnerNumber: winner.number,
    customerName:
      winner.customerName,
    telegramUsername:
      winner.telegramUsername,
    drawnAt:
      drawnAt.toISOString(),
    participantChatIds,
  };
}

/**
 * Return recent activity.
 */
export async function recentActivity() {
  const rows = await db
    .select()
    .from(lotteryActivityTable)
    .orderBy(
      desc(
        lotteryActivityTable.createdAt,
      ),
    )
    .limit(20);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    entryNumber:
      row.entryNumber,
    createdAt:
      row.createdAt.toISOString(),
  }));
}

/**
 * Return all lottery entries.
 */
export async function allEntries(
  status = "all",
  query = "",
) {
  await cleanupExpiredReservations();

  const rows = await db
    .select()
    .from(lotteryEntriesTable)
    .orderBy(
      desc(
        lotteryEntriesTable.updatedAt,
      ),
    );

  const searchTerm =
    query.trim().toLowerCase();

  return rows
    .filter(
      (row) =>
        status === "all" ||
        row.status === status,
    )
    .filter((row) => {
      if (!searchTerm) {
        return true;
      }

      const nameMatch =
        row.customerName
          ?.toLowerCase()
          .includes(searchTerm);

      const phoneMatch =
        row.phone
          ?.toLowerCase()
          .includes(searchTerm);

      const numberMatch =
        String(row.number).includes(
          searchTerm,
        );

      const chatIdMatch =
        row.telegramChatId
          ?.toLowerCase()
          .includes(searchTerm);

      return Boolean(
        nameMatch ||
          phoneMatch ||
          numberMatch ||
          chatIdMatch,
      );
    })
    .map((row) => ({
      ...row,
      createdAt:
        row.createdAt.toISOString(),
      updatedAt:
        row.updatedAt.toISOString(),
    }));
}

/**
 * Find the most recent active entry
 * belonging to a Telegram user.
 */
export async function findCustomerEntry(
  chatId: string,
) {
  await cleanupExpiredReservations();

  const [entry] = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      and(
        eq(
          lotteryEntriesTable.telegramChatId,
          chatId,
        ),
        inArray(
          lotteryEntriesTable.status,
          [
            "reserved",
            "proof_submitted",
            "paid",
          ],
        ),
      ),
    )
    .orderBy(
      desc(
        lotteryEntriesTable.updatedAt,
      ),
    )
    .limit(1);

  return entry;
}

/**
 * Update phone number on the user's
 * current active lottery entry.
 */
export async function updateCustomerPhone(
  chatId: string,
  phone: string,
) {
  const entry =
    await findCustomerEntry(chatId);

  if (!entry) {
    return null;
  }

  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({
      phone,
      updatedAt: new Date(),
    })
    .where(
      eq(
        lotteryEntriesTable.id,
        entry.id,
      ),
    )
    .returning();

  return updated ?? null;
}