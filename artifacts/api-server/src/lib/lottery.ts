import {
  and,
  desc,
  eq,
  inArray,
  lt,
  sql,
} from "drizzle-orm";

import {
  db,
  lotteryActivityTable,
  lotteryEntriesTable,
  lotteryRoundsTable,
  lotterySettingsTable,
} from "@workspace/db";

/* =========================================================
   LOTTERY CONFIGURATION
   ========================================================= */

export const TOTAL_NUMBERS = 300;
export const PRICE_PER_NUMBER = 200;
export const CURRENCY = "ETB";
export const RESERVATION_EXPIRY_MINUTES = 15;

const ACTIVE_STATUSES = [
  "reserved",
  "proof_submitted",
  "paid",
] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

type LotteryNumberStatus =
  | "available"
  | "reserved"
  | "paid";

type LotteryListStatus =
  | "all"
  | "available"
  | "reserved"
  | "paid";

type PaymentMethod = "bank" | "telebirr";

/* =========================================================
   HELPER FUNCTIONS
   ========================================================= */

/**
 * Returns the cutoff timestamp for expired reservations.
 */
function getReservationCutoff(): Date {
  return new Date(
    Date.now() - RESERVATION_EXPIRY_MINUTES * 60 * 1000,
  );
}

/**
 * Safely normalize customer name.
 */
function normalizeCustomerName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Validate customer name.
 */
function validateCustomerName(name: string): void {
  const normalized = normalizeCustomerName(name);

  if (!normalized) {
    throw new Error("Customer name is required.");
  }

  if (normalized.length < 2) {
    throw new Error("Customer name is too short.");
  }

  if (normalized.length > 150) {
    throw new Error("Customer name is too long.");
  }
}

/**
 * Validate lottery number.
 */
function validateLotteryNumber(
  number: number,
  totalNumbers: number,
): void {
  if (!Number.isInteger(number)) {
    throw new Error("Lottery number must be a whole number.");
  }

  if (number < 1 || number > totalNumbers) {
    throw new Error(
      `Lottery number must be between 1 and ${totalNumbers}.`,
    );
  }
}

/**
 * Convert database entry to API-safe format.
 */
export function entryForApi(
  entry: typeof lotteryEntriesTable.$inferSelect,
) {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/* =========================================================
   LOTTERY SETTINGS
   ========================================================= */

/**
 * Make sure lottery settings row #1 exists.
 */
export async function ensureLotterySettings() {
  const [existing] = await db
    .select()
    .from(lotterySettingsTable)
    .where(eq(lotterySettingsTable.id, 1))
    .limit(1);

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
      drawCompleted: false,
    })
    .onConflictDoNothing({
      target: lotterySettingsTable.id,
    })
    .returning();

  if (created) {
    return created;
  }

  const [retried] = await db
    .select()
    .from(lotterySettingsTable)
    .where(eq(lotterySettingsTable.id, 1))
    .limit(1);

  if (!retried) {
    throw new Error(
      "Lottery settings could not be initialized.",
    );
  }

  return retried;
}

async function ensureActiveRound() {
  const [existing] = await db
    .select()
    .from(lotteryRoundsTable)
    .where(eq(lotteryRoundsTable.status, "active"))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(lotteryRoundsTable)
    .values({
      roundNumber: 1,
      totalNumbers: TOTAL_NUMBERS,
      pricePerNumber: PRICE_PER_NUMBER,
      currency: CURRENCY,
      status: "active",
    })
    .onConflictDoNothing({
      target: lotteryRoundsTable.roundNumber,
    })
    .returning();

  if (created) {
    return created;
  }

  const [retried] = await db
    .select()
    .from(lotteryRoundsTable)
    .where(eq(lotteryRoundsTable.status, "active"))
    .limit(1);

  if (!retried) {
    throw new Error("Lottery round could not be initialized.");
  }

  return retried;
}

/* =========================================================
   ACTIVITY LOG
   ========================================================= */

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

/* =========================================================
   RESERVATION CLEANUP
   ========================================================= */

/**
 * Automatically release reservations that have:
 *
 * - status = reserved
 * - been inactive for more than 15 minutes
 *
 * IMPORTANT:
 * We deliberately only expire "reserved".
 *
 * Once a user submits payment proof, the status becomes
 * "proof_submitted" and it must remain pending until an
 * administrator approves or rejects it.
 */
export async function cleanupExpiredReservations() {
  const cutoffTime = getReservationCutoff();

  const expiredEntries = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      and(
        eq(lotteryEntriesTable.status, "reserved"),
        lt(lotteryEntriesTable.updatedAt, cutoffTime),
      ),
    );

  if (expiredEntries.length === 0) {
    return 0;
  }

  let expiredCount = 0;

  for (const entry of expiredEntries) {
    /**
     * Conditional update is important.
     *
     * If another request submitted payment proof after
     * our SELECT, this update will NOT reject it because
     * the status is no longer "reserved".
     */
    const [updated] = await db
      .update(lotteryEntriesTable)
      .set({
        status: "rejected",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(lotteryEntriesTable.id, entry.id),
          eq(lotteryEntriesTable.status, "reserved"),
          lt(lotteryEntriesTable.updatedAt, cutoffTime),
        ),
      )
      .returning();

    if (!updated) {
      continue;
    }

    expiredCount++;

    await addActivity(
      "rejected",
      `⏰ Reservation for number ${updated.number} automatically expired after ${RESERVATION_EXPIRY_MINUTES} minutes.`,
      updated.number,
    );
  }

  return expiredCount;
}

/* =========================================================
   NUMBER STATUS
   ========================================================= */

export function numberStatus(
  entry:
    | { status: string }
    | undefined,
): LotteryNumberStatus {
  if (!entry) {
    return "available";
  }

  if (entry.status === "paid") {
    return "paid";
  }

  return "reserved";
}

/* =========================================================
   SUMMARY
   ========================================================= */

export async function getSummary() {
  await cleanupExpiredReservations();

  const settings = await ensureLotterySettings();

  const entries = await db
    .select()
    .from(lotteryEntriesTable);

  const activeEntries = entries.filter(
    (entry) =>
      entry.status === "reserved" ||
      entry.status === "proof_submitted" ||
      entry.status === "paid",
  );

  const paidNumbers = activeEntries.filter(
    (entry) => entry.status === "paid",
  ).length;

  const reservedNumbers = activeEntries.filter(
    (entry) => entry.status === "reserved",
  ).length;

  const proofPending = activeEntries.filter(
    (entry) => entry.status === "proof_submitted",
  ).length;

  const availableNumbers =
    Math.max(
      0,
      Number(settings.totalNumbers) -
        activeEntries.length,
    );

  const totalCollected =
    paidNumbers *
    Number(settings.pricePerNumber);

  return {
    totalNumbers: Number(settings.totalNumbers),

    availableNumbers,

    reservedNumbers,

    paidNumbers,

    proofPending,

    totalCollected,

    pricePerNumber:
      Number(settings.pricePerNumber),

    currency: settings.currency,

    winnerNumber:
      settings.winnerNumber,

    drawCompleted:
      settings.drawCompleted,
  };
}

/* =========================================================
   LIST LOTTERY NUMBERS
   ========================================================= */

export async function listNumbers(
  status: LotteryListStatus = "all",
) {
  await cleanupExpiredReservations();

  const settings = await ensureLotterySettings();

  const entries = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      inArray(
        lotteryEntriesTable.status,
        [...ACTIVE_STATUSES],
      ),
    );

  const byNumber = new Map(
    entries.map((entry) => [
      entry.number,
      entry,
    ]),
  );

  const numbers = Array.from(
    {
      length: Number(settings.totalNumbers),
    },
    (_, index) => {
      const number = index + 1;

      const entry = byNumber.get(number);

      const currentStatus =
        numberStatus(entry);

      return {
        number,

        status: currentStatus,

        customerName:
          entry?.customerName ?? null,

        reservedAt:
          entry?.createdAt?.toISOString() ??
          null,
      };
    },
  );

  if (status === "all") {
    return numbers;
  }

  return numbers.filter(
    (entry) => entry.status === status,
  );
}

/* =========================================================
   RESERVE NUMBER
   ========================================================= */

/**
 * Reserve a lottery number.
 *
 * IMPORTANT FIX:
 *
 * The old implementation did:
 *
 *   SELECT number
 *   if available
 *   INSERT
 *
 * Two users could execute that at the same time.
 *
 * This version uses PostgreSQL's atomic
 * ON CONFLICT DO UPDATE mechanism.
 *
 * Because "number" is UNIQUE in your schema,
 * PostgreSQL guarantees that only one reservation
 * can own a number at a time.
 */
export async function reserveNumber(input: {
  number: number;
  customerName: string;
  telegramUsername?: string | null;
  telegramChatId: string;
  phone?: string | null;
}) {
  await cleanupExpiredReservations();

  const settings =
    await ensureLotterySettings();
  const round = await ensureActiveRound();

  validateLotteryNumber(
    input.number,
    Number(settings.totalNumbers),
  );

  const customerName =
    normalizeCustomerName(input.customerName);

  validateCustomerName(customerName);

  const telegramChatId =
    String(input.telegramChatId).trim();

  if (!telegramChatId) {
    throw new Error(
      "Telegram chat ID is required.",
    );
  }

  const now = new Date();

  /**
   * Atomic reservation.
   *
   * If the number doesn't exist:
   *   INSERT it.
   *
   * If it exists and is rejected:
   *   Reuse that row.
   *
   * If it exists and is active:
   *   DO NOTHING.
   *
   * This closes the SELECT-then-INSERT race condition.
   */
  const [created] = await db
    .insert(lotteryEntriesTable)
    .values({
      roundId: round.id,
      number: input.number,
      customerName,
      telegramUsername:
        input.telegramUsername ?? null,
      telegramChatId,
      phone: input.phone ?? null,

      status: "reserved",

      paymentMethod: null,
      paymentReference: null,
      paymentProof: null,

      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        lotteryEntriesTable.roundId,
        lotteryEntriesTable.number,
      ],

      /**
       * The existing row can only be reused if
       * the previous reservation was rejected.
       */
      setWhere: eq(
        lotteryEntriesTable.status,
        "rejected",
      ),

      set: {
        roundId: round.id,
        customerName,

        telegramUsername:
          input.telegramUsername ?? null,

        telegramChatId,

        phone:
          input.phone ?? null,

        status: "reserved",

        paymentMethod: null,

        paymentReference: null,

        paymentProof: null,

        createdAt: now,

        updatedAt: now,
      },
    })
    .returning();

  /**
   * If no row was returned, the number was already
   * reserved, pending proof, or paid.
   */
  if (!created) {
    throw new Error(
      "That number is no longer available.",
    );
  }

  await addActivity(
    "reservation",
    `${created.customerName} reserved number ${created.number}.`,
    created.number,
  );

  return entryForApi(created);
}

/* =========================================================
   SUBMIT PAYMENT PROOF
   ========================================================= */

export async function submitProof(
  id: number,
  input: {
    paymentMethod: PaymentMethod;
    paymentReference: string;
    paymentProof: string;
  },
) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Invalid lottery entry ID.",
    );
  }

  const paymentReference =
    input.paymentReference.trim();

  const paymentProof =
    input.paymentProof.trim();

  if (!paymentReference) {
    throw new Error(
      "Payment reference is required.",
    );
  }

  if (!paymentProof) {
    throw new Error(
      "Payment proof is required.",
    );
  }

  /**
   * Only "reserved" entries can submit proof.
   *
   * This prevents:
   *
   * reserved -> proof_submitted
   * proof_submitted -> proof_submitted
   * paid -> proof_submitted
   * rejected -> proof_submitted
   */
  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({
      paymentMethod:
        input.paymentMethod,

      paymentReference,

      paymentProof,

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
      "Reservation expired or has already been processed.",
    );
  }

  await addActivity(
    "proof_submitted",
    `Payment proof submitted for number ${updated.number}.`,
    updated.number,
  );

  return entryForApi(updated);
}

/* =========================================================
   APPROVE PAYMENT
   ========================================================= */

export async function approveEntry(
  id: number,
) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Invalid lottery entry ID.",
    );
  }

  /**
   * Only proof_submitted can become paid.
   */
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

/* =========================================================
   REJECT ENTRY
   ========================================================= */

export async function rejectEntry(
  id: number,
) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Invalid lottery entry ID.",
    );
  }

  /**
   * Admin can reject:
   *
   * reserved
   * proof_submitted
   *
   * But cannot reject an already paid entry.
   */
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

/* =========================================================
   DRAW WINNER
   ========================================================= */

/**
 * Draw a winner from PAID entries only.
 *
 * IMPORTANT FIX:
 *
 * The old implementation allowed two simultaneous
 * /drawlotto requests to potentially select winners
 * from the same paid entries.
 *
 * This version locks the lottery settings row inside
 * a PostgreSQL transaction.
 *
 * Only one draw operation can therefore proceed at
 * a time.
 */
export async function drawWinner() {
  await ensureLotterySettings();

  const result =
    await db.transaction(async (tx) => {
      /**
       * Lock the single lottery settings row.
       *
       * Any other draw transaction must wait here
       * until this transaction finishes.
       */
      await tx.execute(
        sql`
          SELECT id
          FROM ${lotterySettingsTable}
          WHERE ${lotterySettingsTable.id} = 1
          FOR UPDATE
        `,
      );

      /**
       * Get paid entries while the settings row is locked.
       */
      const paid = await tx
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

      /**
       * Select random winner.
       */
      const winner =
        paid[
          Math.floor(
            Math.random() * paid.length,
          )
        ];

      if (!winner) {
        throw new Error(
          "Winner selection failed.",
        );
      }

      const drawnAt = new Date();

      /**
       * Get participants before deleting the entries.
       */
      const allParticipants =
        await tx
          .select({
            chatId:
              lotteryEntriesTable.telegramChatId,
          })
          .from(
            lotteryEntriesTable,
          );

      const participantChatIds =
        Array.from(
          new Set(
            allParticipants
              .map(
                (participant) =>
                  participant.chatId,
              )
              .filter(
                (
                  chatId,
                ): chatId is string =>
                  Boolean(chatId),
              ),
          ),
        );

      /**
       * Store activity BEFORE deleting entries.
       */
      await tx
        .insert(lotteryActivityTable)
        .values({
          type: "draw",

          message:
            `🎉 Winner drawn: Number #${winner.number} ` +
            `(${winner.customerName}). ` +
            `All entries cleared for next round.`,

          entryNumber: winner.number,
        });

      /**
       * Clear the current round.
       */
      await tx
        .delete(lotteryEntriesTable);

      /**
       * The current application immediately starts
       * the next round after the draw.
       *
       * Therefore drawCompleted remains false.
       */
      await tx
        .update(lotterySettingsTable)
        .set({
          winnerNumber: winner.number,

          drawCompleted: false,

          drawnAt,
        })
        .where(
          eq(
            lotterySettingsTable.id,
            1,
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
    });

  return result;
}

/* =========================================================
   RECENT ACTIVITY
   ========================================================= */

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

/* =========================================================
   ALL ENTRIES
   ========================================================= */

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

      const usernameMatch =
        row.telegramUsername
          ?.toLowerCase()
          .includes(searchTerm);

      return Boolean(
        nameMatch ||
          phoneMatch ||
          numberMatch ||
          chatIdMatch ||
          usernameMatch,
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

/* =========================================================
   FIND CUSTOMER ENTRY
   ========================================================= */

/**
 * Find the latest active entry belonging to a Telegram user.
 *
 * Used when the user sends:
 *
 * - payment screenshot
 * - phone number
 * - status request
 */
export async function findCustomerEntry(
  chatId: string,
) {
  await cleanupExpiredReservations();

  const normalizedChatId =
    String(chatId).trim();

  if (!normalizedChatId) {
    return undefined;
  }

  const [entry] = await db
    .select()
    .from(lotteryEntriesTable)
    .where(
      and(
        eq(
          lotteryEntriesTable.telegramChatId,
          normalizedChatId,
        ),

        inArray(
          lotteryEntriesTable.status,
          [...ACTIVE_STATUSES],
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

/* =========================================================
   UPDATE CUSTOMER PHONE
   ========================================================= */

export async function updateCustomerPhone(
  chatId: string,
  phone: string,
) {
  const normalizedChatId =
    String(chatId).trim();

  const normalizedPhone =
    String(phone).trim();

  if (!normalizedChatId) {
    throw new Error(
      "Telegram chat ID is required.",
    );
  }

  if (!normalizedPhone) {
    throw new Error(
      "Phone number is required.",
    );
  }

  /**
   * Find latest active entry.
   */
  const entry =
    await findCustomerEntry(
      normalizedChatId,
    );

  /**
   * If the user hasn't selected a number yet,
   * there may be no entry to update.
   *
   * This is not an error because the Telegram
   * registration flow can happen before /pick.
   */
  if (!entry) {
    return null;
  }

  const [updated] = await db
    .update(lotteryEntriesTable)
    .set({
      phone: normalizedPhone,
      updatedAt: new Date(),
    })
    .where(
      eq(
        lotteryEntriesTable.id,
        entry.id,
      ),
    )
    .returning();

  if (!updated) {
    return null;
  }

  return entryForApi(updated);
}