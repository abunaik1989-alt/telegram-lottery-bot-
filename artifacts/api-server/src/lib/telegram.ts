import { logger } from "./logger";

import {
  findCustomerEntry,
  getSummary,
  listNumbers,
  reserveNumber,
  submitProof,
  updateCustomerPhone,
  drawWinner as executeDrawWinner,
  cleanupExpiredReservations,
  approveEntry,
  rejectEntry,
} from "./lottery";

import {
  db,
  lotteryEntriesTable,
} from "@workspace/db";

import {
  and,
  eq,
  inArray,
} from "drizzle-orm";

/* =========================================================
   TELEGRAM TYPES
   ========================================================= */

type TelegramPhoto = {
  file_id: string;
};

type TelegramContact = {
  phone_number: string;
  first_name?: string;
  last_name?: string;
  user_id?: number;
};

type TelegramUser = {
  id?: number;
  username?: string;
  first_name?: string;
};

type TelegramChat = {
  id: number | string;
  type?: string;
};

type TelegramMessage = {
  message_id?: number;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhoto[];
  contact?: TelegramContact;
  from?: TelegramUser;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

/* =========================================================
   LANGUAGE
   ========================================================= */

type Language = "am" | "om" | "en";

/**
 * IMPORTANT:
 *
 * Your current lottery database schema does NOT contain
 * a "language" column.
 *
 * Therefore language is kept in memory for now.
 *
 * If you want language to survive a server restart,
 * add a language column or a separate users table later.
 */
const userLanguages = new Map<string, Language>();

const DEFAULT_LANGUAGE: Language = "am";

/* =========================================================
   ADMIN AUTHORIZATION
   ========================================================= */

const ADMIN_CHAT_IDS: string[] = [
  "806241233",
  process.env.ADMIN_CHAT_ID,
  process.env.ADMIN_ID,
]
  .filter(
    (id): id is string =>
      Boolean(id),
  )
  .map((id) =>
    String(id).trim(),
  )
  .filter(Boolean);

function isAdmin(
  chatId: string | number,
): boolean {
  return ADMIN_CHAT_IDS.includes(
    String(chatId).trim(),
  );
}

/* =========================================================
   USER STATE
   ========================================================= */

/**
 * Stores the number a user selected while waiting
 * for them to provide their full name.
 *
 * Example:
 *
 * User: /pick 28
 * Bot: Send your full name
 *
 * Map:
 * chatId -> 28
 */
const pendingSelections =
  new Map<string, number>();

/**
 * Cache registered phone numbers.
 *
 * This is only a cache.
 * The database remains the source of truth.
 */
const userPhones =
  new Map<string, string>();

let started = false;

/* =========================================================
   TELEGRAM API
   ========================================================= */

function apiUrl(
  method: string,
): string {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured.",
    );
  }

  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Generic Telegram API request.
 */
async function telegramRequest<T>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<T | null> {
  const response = await fetch(
    apiUrl(method),
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",
      },

      body: JSON.stringify(body),
    },
  );

  let payload: {
    ok?: boolean;
    result?: T;
    description?: string;
  };

  try {
    payload =
      (await response.json()) as typeof payload;
  } catch {
    throw new Error(
      `Telegram API ${method} returned invalid JSON.`,
    );
  }

  if (
    !response.ok ||
    !payload.ok
  ) {
    throw new Error(
      payload.description ??
        `Telegram API ${method} failed.`,
    );
  }

  return payload.result ?? null;
}

/* =========================================================
   HTML HELPERS
   ========================================================= */

/**
 * Telegram HTML parse mode requires special characters
 * to be escaped when inserting user-provided content.
 */
function escapeHtml(
  value: unknown,
): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Telegram HTML formatting helper.
 */
function bold(
  value: unknown,
): string {
  return `<b>${escapeHtml(value)}</b>`;
}

/**
 * Telegram code formatting helper.
 */
function code(
  value: unknown,
): string {
  return `<code>${escapeHtml(value)}</code>`;
}

/* =========================================================
   LANGUAGE HELPERS
   ========================================================= */

function normalizeLanguage(
  value: string | undefined,
): Language {
  if (value === "om") {
    return "om";
  }

  if (value === "en") {
    return "en";
  }

  return "am";
}

function setUserLanguage(
  chatId: string,
  language: Language,
): void {
  userLanguages.set(
    chatId,
    language,
  );
}

function getUserLanguage(
  chatId: string,
): Language {
  return normalizeLanguage(
    userLanguages.get(chatId),
  );
}

/* =========================================================
   PHONE HELPERS
   ========================================================= */

/**
 * Check if user has previously registered a phone number.
 *
 * Database remains the source of truth.
 */
async function getUserPhone(
  chatId: string,
): Promise<string | null> {
  const normalizedChatId =
    String(chatId).trim();

  if (!normalizedChatId) {
    return null;
  }

  const cached =
    userPhones.get(normalizedChatId);

  if (cached) {
    return cached;
  }

  const [user] =
    await db
      .select({
        phone:
          lotteryEntriesTable.phone,
      })
      .from(
        lotteryEntriesTable,
      )
      .where(
        eq(
          lotteryEntriesTable.telegramChatId,
          normalizedChatId,
        ),
      )
      .limit(1);

  if (user?.phone) {
    userPhones.set(
      normalizedChatId,
      user.phone,
    );

    return user.phone;
  }

  return null;
}

/* =========================================================
   REGISTERED CHAT IDS
   ========================================================= */

async function getAllRegisteredChatIds(): Promise<string[]> {
  const entries =
    await db
      .select({
        chatId:
          lotteryEntriesTable.telegramChatId,
      })
      .from(
        lotteryEntriesTable,
      );

  const dbChatIds =
    entries
      .map(
        (entry) =>
          entry.chatId,
      )
      .filter(Boolean)
      .map(String);

  const memoryChatIds =
    Array.from(
      userPhones.keys(),
    );

  return Array.from(
    new Set([
      ...dbChatIds,
      ...memoryChatIds,
    ]),
  );
}

/* =========================================================
   COMMAND HELPERS
   ========================================================= */

/**
 * Extract command from Telegram message.
 *
 * Supports:
 *
 * /start
 * /numbers
 * /approve 28
 * /approve@MyBot 28
 */
function getCommand(
  text: string,
): string {
  const firstPart =
    text.trim().split(/\s+/)[0] ??
    "";

  return firstPart
    .toLowerCase()
    .replace(/^\/+/, "")
    .split("@")[0];
}

/**
 * Get command arguments.
 */
function getCommandArguments(
  text: string,
): string[] {
  return text
    .trim()
    .split(/\s+/)
    .slice(1);
}

/**
 * Get text after a command.
 */
function getCommandText(
  text: string,
): string {
  return text
    .trim()
    .replace(
      /^\/[a-zA-Z0-9_]+(?:@[a-zA-Z0-9_]+)?\s*/i,
      "",
    )
    .trim();
}

/* =========================================================
   ADMIN COMMAND SCOPES
   ========================================================= */

async function setupAdminCommandScopes() {
  if (ADMIN_CHAT_IDS.length === 0) {
    logger.warn(
      "No admin chat IDs configured.",
    );
    return;
  }

  for (
    const adminId of ADMIN_CHAT_IDS
  ) {
    try {
      await telegramRequest(
        "setMyCommands",
        {
          commands: [
            {
              command: "admin",
              description:
                "Open admin control panel",
            },
            {
              command: "pending",
              description:
                "View pending payment proofs",
            },
            {
              command: "approve",
              description:
                "Approve payment e.g. /approve 28",
            },
            {
              command: "reject",
              description:
                "Reject payment e.g. /reject 28",
            },
            {
              command: "drawlotto",
              description:
                "Perform random draw",
            },
            {
              command: "newround",
              description:
                "Announce new lottery round",
            },
            {
              command: "broadcast",
              description:
                "Broadcast message to users",
            },
            {
              command: "resetlotto",
              description:
                "Reset active lottery round",
            },
            {
              command: "user",
              description:
                "Look up user information",
            },
          ],

          scope: {
            type: "chat",
            chat_id: adminId,
          },
        },
      );

      logger.info(
        `Admin commands scoped for chat ID: ${adminId}`,
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          adminId,
        },
        "Failed to configure admin commands.",
      );
    }
  }
}

/* =========================================================
   MESSAGE SENDING
   ========================================================= */

async function sendMessage(
  chatId: string,
  text: string,
  replyMarkup:
    | Record<string, unknown>
    | null = null,
): Promise<void> {
  const body: Record<
    string,
    unknown
  > = {
    chat_id: chatId,

    text,

    /**
     * HTML is safer than Markdown here because
     * customer names, usernames and admin messages
     * can contain _, *, [, ], etc.
     */
    parse_mode: "HTML",
  };

  if (replyMarkup) {
    body.reply_markup =
      replyMarkup;
  } else {
    body.reply_markup = {
      remove_keyboard: true,
    };
  }

  await telegramRequest(
    "sendMessage",
    body,
  );
}

/**
 * Send phone-sharing keyboard.
 */
async function requestPhoneShare(
  chatId: string,
  text: string,
  buttonLabel: string,
): Promise<void> {
  const keyboard = {
    keyboard: [
      [
        {
          text: buttonLabel,
          request_contact: true,
        },
      ],
    ],

    resize_keyboard: true,

    one_time_keyboard: true,
  };

  await sendMessage(
    chatId,
    text,
    keyboard,
  );
}

/* =========================================================
   NUMBER RANGE DISPLAY
   ========================================================= */

function availableRanges(
  numbers: number[],
): string[] {
  if (numbers.length === 0) {
    return [];
  }

  const sortedNumbers =
    [...numbers].sort(
      (a, b) => a - b,
    );

  const ranges: string[] = [];

  let start =
    sortedNumbers[0];

  let previous =
    sortedNumbers[0];

  for (
    let index = 1;
    index < sortedNumbers.length;
    index++
  ) {
    const number =
      sortedNumbers[index];

    if (
      number !==
      previous + 1
    ) {
      ranges.push(
        start === previous
          ? String(start)
          : `${start}-${previous}`,
      );

      start = number;
    }

    previous = number;
  }

  ranges.push(
    start === previous
      ? String(start)
      : `${start}-${previous}`,
  );

  return ranges;
}

/* =========================================================
   WINNER ANNOUNCEMENT
   ========================================================= */

export async function announceWinnerToAll(
  winner: {
    winnerNumber: number;
    customerName: string;
    participantChatIds: string[];
  },
): Promise<void> {
  /**
   * Use participantChatIds from draw when possible.
   *
   * If empty, fall back to database history.
   */
  let allChatIds =
    winner.participantChatIds
      ?.filter(Boolean)
      .map(String) ?? [];

  if (allChatIds.length === 0) {
    allChatIds =
      await getAllRegisteredChatIds();
  }

  allChatIds =
    Array.from(
      new Set(allChatIds),
    );

  for (
    const chatId of allChatIds
  ) {
    const lang =
      getUserLanguage(chatId);

    const winnerNumber =
      code(
        `#${winner.winnerNumber}`,
      );

    const winnerName =
      bold(
        winner.customerName,
      );

    let announcementMsg: string;

    if (lang === "am") {
      announcementMsg =
        `🎉 ${bold("የሎተሪው ዕጣ ወጥቷል!")} 🎉\n\n` +
        `🏆 ${bold("አሸናፊ ቁጥር:")} ${winnerNumber}\n` +
        `👤 ${bold("የአሸናፊው ስም:")} ${winnerName}\n\n` +
        `🔄 ${bold("አዲስ ዙር ተጀምሯል!")}\n` +
        `የቀድሞው ዙር ቁጥሮች ተጠናቀዋል።\n\n` +
        `አሁኑኑ /numbers በመላክ አዲስ ቁጥር ይምረጡ።`;
    } else if (lang === "om") {
      announcementMsg =
        `🎉 ${bold("Lottoriin carraan ba'eera!")} 🎉\n\n` +
        `🏆 ${bold("Lakkoofsa Mo'ataa:")} ${winnerNumber}\n` +
        `👤 ${bold("Maqaa Mo'ataa:")} ${winnerName}\n\n` +
        `🔄 ${bold("Marsaan haaraan jalqabameera!")}\n` +
        `Lakkoofsotni marsaa darbee xumuramaniiru.\n\n` +
        `Amma /numbers erguun lakkoofsa haaraa filadhaa.`;
    } else {
      announcementMsg =
        `🎉 ${bold("LOTTERY DRAW COMPLETED!")} 🎉\n\n` +
        `🏆 ${bold("Winning Number:")} ${winnerNumber}\n` +
        `👤 ${bold("Winner Name:")} ${winnerName}\n\n` +
        `🔄 ${bold("A new round has started!")}\n` +
        `The previous round has been completed.\n\n` +
        `Send /numbers to pick a new number.`;
    }

    try {
      await sendMessage(
        chatId,
        announcementMsg,
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          chatId,
        },
        "Failed to notify user about winner.",
      );
    }
  }
}

/* =========================================================
   LANGUAGE KEYBOARD
   ========================================================= */

function languageKeyboard() {
  return {
    keyboard: [
      [
        {
          text: "🇪🇹 አማርኛ",
        },
        {
          text: "🇪🇹 Afaan Oromoo",
        },
      ],
      [
        {
          text: "🇬🇧 English",
        },
      ],
    ],

    resize_keyboard: true,

    one_time_keyboard: true,
  };
}

/* =========================================================
   LANGUAGE SELECTION
   ========================================================= */

async function handleLanguageSelection(
  chatId: string,
  text: string,
): Promise<boolean> {
  let language: Language | null =
    null;

  if (
    text.includes("አማርኛ")
  ) {
    language = "am";
  } else if (
    text.includes("Afaan Oromoo") ||
    text.includes("Oromoo")
  ) {
    language = "om";
  } else if (
    text.includes("English")
  ) {
    language = "en";
  }

  if (!language) {
    return false;
  }

  setUserLanguage(
    chatId,
    language,
  );

  const savedPhone =
    await getUserPhone(chatId);

  if (
    !savedPhone &&
    !isAdmin(chatId)
  ) {
    if (language === "am") {
      await requestPhoneShare(
        chatId,
        `📍 ${bold("የግዴታ ደረጃ:")}\n\n` +
          `ለመቀጠል እባክዎ ከታች ያለውን ${bold(
            "📱 ስልክ ቁጥር አጋራ",
          )} ቁልፍ ይጫኑ።`,
        "📱 ስልክ ቁጥር አጋራ",
      );
    } else if (
      language === "om"
    ) {
      await requestPhoneShare(
        chatId,
        `📍 ${bold("Sadarkaa Dirqamaa:")}\n\n` +
          `Itti fufuuf maaloo ${bold(
            "📱 Lakkoofsa Bilbilaa Qooda",
          )} jedhu tuqaa.`,
        "📱 Lakkoofsa Bilbilaa Qooda",
      );
    } else {
      await requestPhoneShare(
        chatId,
        `📍 ${bold("Mandatory Step:")}\n\n` +
          `Please tap ${bold(
            "📱 Share Phone Number",
          )} below to complete registration.`,
        "📱 Share Phone Number",
      );
    }
  } else {
    if (language === "am") {
      await sendMessage(
        chatId,
        `✅ ${bold(
          "ቋንቋው ወደ አማርኛ ተቀይሯል።",
        )}\n\n` +
          `ቁጥር ለመምረጥ ${bold(
            "/numbers",
          )} ይላኩ።`,
      );
    } else if (
      language === "om"
    ) {
      await sendMessage(
        chatId,
        `✅ ${bold(
          "Afaan gara Afaan Oromootti jijjiirameera.",
        )}\n\n` +
          `Lakkoofsa filachuuf ${bold(
            "/numbers",
          )} ergaa.`,
      );
    } else {
      await sendMessage(
        chatId,
        `✅ ${bold(
          "Language set to English.",
        )}\n\n` +
          `Send ${bold(
            "/numbers",
          )} to pick a number.`,
      );
    }
  }

  return true;
}

/* =========================================================
   START / LANGUAGE
   ========================================================= */

async function handleStartCommand(
  chatId: string,
): Promise<void> {
  await sendMessage(
    chatId,
    `🎁 ${bold(
      "እንኳን ወደ ህጋዊ የሎተሪ ቦት በደህና መጡ!",
    )}\n` +
      `${bold(
        "Welcome to the Official Lottery Bot!",
      )}\n` +
      `─────────────\n` +
      `✨ የፈለጉትን እድለኛ ቁጥር በመምረጥ አሸናፊ ይሁኑ!\n` +
      `✨ Select your lucky number and win!\n\n` +
      `👇 ${bold(
        "እባክዎ መጀመሪያ ቋንቋ ይምረጡ",
      )}\n` +
      `${bold(
        "Please select your language:",
      )}`,
    languageKeyboard(),
  );
}

/* =========================================================
   ADMIN: /ADMIN
   ========================================================= */

async function handleAdminCommand(
  chatId: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}\n\n` +
        `You are not an admin.\n` +
        `Your Chat ID: ${code(chatId)}`,
    );

    return;
  }

  const summary =
    await getSummary();

  const adminMsg =
    `🛠 ${bold(
      "ADMIN CONTROL PANEL",
    )}\n` +
    `─────────────\n\n` +
    `📊 ${bold("Summary")}\n` +
    `• Total Numbers: ${code(
      summary.totalNumbers,
    )}\n` +
    `• Available: ${code(
      summary.availableNumbers,
    )}\n` +
    `• Paid Entries: ${code(
      summary.paidNumbers,
    )}\n` +
    `• Pending Approval: ${code(
      summary.proofPending,
    )}\n` +
    `• Active Reserved: ${code(
      summary.reservedNumbers,
    )}\n` +
    `• Total Revenue: ${code(
      `${summary.totalCollected} ${summary.currency}`,
    )}\n\n` +
    `⚡ ${bold("Admin Commands")}\n` +
    `• /pending - View pending payments\n` +
    `• /approve <number> - Approve payment\n` +
    `• /reject <number> - Reject payment\n` +
    `• /drawlotto - Draw winner\n` +
    `• /newround <message> - New round notice\n` +
    `• /broadcast <message> - Broadcast\n` +
    `• /resetlotto - Reset lottery\n` +
    `• /user <chat_id> - User information`;

  await sendMessage(
    chatId,
    adminMsg,
  );
}

/* =========================================================
   ADMIN: /PENDING
   ========================================================= */

async function handlePendingCommand(
  chatId: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}\n\nYou are not an admin.`,
    );

    return;
  }

  const pendingEntries =
    await db
      .select()
      .from(
        lotteryEntriesTable,
      )
      .where(
        eq(
          lotteryEntriesTable.status,
          "proof_submitted",
        ),
      );

  if (
    pendingEntries.length === 0
  ) {
    await sendMessage(
      chatId,
      `✅ ${bold(
        "No pending payment proofs to review.",
      )}`,
    );

    return;
  }

  let message =
    `⏳ ${bold(
      `PENDING PAYMENTS (${pendingEntries.length})`,
    )}\n\n`;

  for (
    const entry of pendingEntries
  ) {
    message +=
      `🔹 ${bold(
        `Number #${entry.number}`,
      )}\n` +
      `• Name: ${escapeHtml(
        entry.customerName,
      )}\n` +
      `• Phone: ${escapeHtml(
        entry.phone ?? "N/A",
      )}\n` +
      `• Chat ID: ${code(
        entry.telegramChatId,
      )}\n` +
      `• Proof: ${escapeHtml(
        entry.paymentReference ??
          "N/A",
      )}\n` +
      `👉 /approve ${entry.number}\n` +
      `👉 /reject ${entry.number}\n\n`;
  }

  await sendMessage(
    chatId,
    message,
  );
}

/* =========================================================
   ADMIN: /APPROVE
   ========================================================= */

async function handleApproveCommand(
  chatId: string,
  text: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  const args =
    getCommandArguments(text);

  const number =
    Number(args[0]);

  if (
    !Number.isInteger(number)
  ) {
    await sendMessage(
      chatId,
      `⚠️ Usage: ${code(
        "/approve <number>",
      )}\n\nExample: ${code(
        "/approve 28",
      )}`,
    );

    return;
  }

  const [entry] =
    await db
      .select()
      .from(
        lotteryEntriesTable,
      )
      .where(
        and(
          eq(
            lotteryEntriesTable.number,
            number,
          ),
          eq(
            lotteryEntriesTable.status,
            "proof_submitted",
          ),
        ),
      )
      .limit(1);

  if (!entry) {
    await sendMessage(
      chatId,
      `❌ No pending payment proof found for ${bold(
        `number #${number}`,
      )}.`,
    );

    return;
  }

  try {
    await approveEntry(
      entry.id,
    );

    await sendMessage(
      chatId,
      `✅ ${bold(
        `Number #${number} approved successfully!`,
      )}`,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        entryId: entry.id,
      },
      "Failed to approve lottery entry.",
    );

    await sendMessage(
      chatId,
      `❌ Failed to approve ${bold(
        `number #${number}`,
      )}.`,
    );

    return;
  }

  const userLang =
    getUserLanguage(
      entry.telegramChatId,
    );

  let customerMsg: string;

  if (userLang === "am") {
    customerMsg =
      `🎉 ${bold(
        "ክፍያዎ ጸድቋል!",
      )}\n\n` +
      `ቁጥር ${bold(
        `#${entry.number}`,
      )} ሙሉ በሙሉ የእርስዎ ሆኗል።\n\n` +
      `መልካም እድል! 🍀`;
  } else if (
    userLang === "om"
  ) {
    customerMsg =
      `🎉 ${bold(
        "Kaffaltiin keessan mirkanaa'eera!",
      )}\n\n` +
      `Lakkoofsi ${bold(
        `#${entry.number}`,
      )} kan keessan ta'eera.\n\n` +
      `Carraa gaarii! 🍀`;
  } else {
    customerMsg =
      `🎉 ${bold(
        "Payment Approved!",
      )}\n\n` +
      `Number ${bold(
        `#${entry.number}`,
      )} is officially yours.\n\n` +
      `Good luck! 🍀`;
  }

  try {
    await sendMessage(
      entry.telegramChatId,
      customerMsg,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        chatId:
          entry.telegramChatId,
      },
      "Failed to notify customer after approval.",
    );
  }
}

/* =========================================================
   ADMIN: /REJECT
   ========================================================= */

async function handleRejectCommand(
  chatId: string,
  text: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  const args =
    getCommandArguments(text);

  const number =
    Number(args[0]);

  if (
    !Number.isInteger(number)
  ) {
    await sendMessage(
      chatId,
      `⚠️ Usage: ${code(
        "/reject <number>",
      )}\n\nExample: ${code(
        "/reject 28",
      )}`,
    );

    return;
  }

  const [entry] =
    await db
      .select()
      .from(
        lotteryEntriesTable,
      )
      .where(
        and(
          eq(
            lotteryEntriesTable.number,
            number,
          ),
          inArray(
            lotteryEntriesTable.status,
            [
              "reserved",
              "proof_submitted",
            ],
          ),
        ),
      )
      .limit(1);

  if (!entry) {
    await sendMessage(
      chatId,
      `❌ No active reservation or payment proof found for ${bold(
        `number #${number}`,
      )}.`,
    );

    return;
  }

  try {
    await rejectEntry(
      entry.id,
    );

    await sendMessage(
      chatId,
      `🚫 ${bold(
        `Number #${number} rejected and released.`,
      )}`,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        entryId: entry.id,
      },
      "Failed to reject lottery entry.",
    );

    await sendMessage(
      chatId,
      `❌ Failed to reject ${bold(
        `number #${number}`,
      )}.`,
    );

    return;
  }

  const userLang =
    getUserLanguage(
      entry.telegramChatId,
    );

  let customerMsg: string;

  if (userLang === "am") {
    customerMsg =
      `❌ ${bold(
        "የክፍያ ደረሰኝዎ ውድቅ ተደርጓል!",
      )}\n\n` +
      `ቁጥር ${bold(
        `#${entry.number}`,
      )} ክፍት ተደርጓል።\n\n` +
      `እባክዎ እንደገና ይሞክሩ።`;
  } else if (
    userLang === "om"
  ) {
    customerMsg =
      `❌ ${bold(
        "Kaffaltiin keessan kufaa ta'eera!",
      )}\n\n` +
      `Lakkoofsi ${bold(
        `#${entry.number}`,
      )} banaa ta'eera.\n\n` +
      `Maaloo ammas yaalaa.`;
  } else {
    customerMsg =
      `❌ ${bold(
        "Payment rejected.",
      )}\n\n` +
      `Reservation for number ${bold(
        `#${entry.number}`,
      )} has been released.\n\n` +
      `Please try again.`;
  }

  try {
    await sendMessage(
      entry.telegramChatId,
      customerMsg,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        chatId:
          entry.telegramChatId,
      },
      "Failed to notify customer after rejection.",
    );
  }
}

/* =========================================================
   ADMIN: /DRAWLOTTO
   ========================================================= */

async function handleDrawCommand(
  chatId: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  try {
    const winner =
      await executeDrawWinner();

    await announceWinnerToAll(
      winner,
    );

    await sendMessage(
      chatId,
      `✅ ${bold(
        "Draw executed successfully!",
      )}\n\n` +
        `🏆 Winning Number: ${code(
          `#${winner.winnerNumber}`,
        )}\n` +
        `👤 Winner: ${bold(
          winner.customerName,
        )}\n\n` +
        `📢 Winner announcement sent to participants.`,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown error.";

    logger.error(
      {
        err: error,
      },
      "Lottery draw failed.",
    );

    await sendMessage(
      chatId,
      `❌ ${bold(
        "Error performing draw",
      )}\n\n${escapeHtml(
        errorMessage,
      )}`,
    );
  }
}

/* =========================================================
   ADMIN: /NEWROUND
   ========================================================= */

async function handleNewRoundCommand(
  chatId: string,
  text: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  const roundMsg =
    getCommandText(text);

  const noticeContent =
    roundMsg ||
    `🚀 ${bold(
      "አዲስ የሎተሪ ዙር ተጀምሯል!",
    )}\n\n` +
      `አሁኑኑ /numbers በማለት ዕድልዎን ይሞክሩ።`;

  const allChatIds =
    await getAllRegisteredChatIds();

  let count = 0;

  for (
    const targetChatId of allChatIds
  ) {
    try {
      const lang =
        getUserLanguage(
          targetChatId,
        );

      let message: string;

      if (lang === "am") {
        message =
          `🔔 ${bold(
            "የአዲስ ዙር ማስታወቂያ",
          )}\n\n` +
          `${noticeContent}\n\n` +
          `👉 /numbers - ቁጥሮችን ይመልከቱ`;
      } else if (
        lang === "om"
      ) {
        message =
          `🔔 ${bold(
            "Beeksisa Marsaa Haaraa",
          )}\n\n` +
          `${noticeContent}\n\n` +
          `👉 /numbers - Lakkoofsota ilaalaa`;
      } else {
        message =
          `🔔 ${bold(
            "NEW ROUND NOTICE",
          )}\n\n` +
          `${noticeContent}\n\n` +
          `👉 /numbers - View available numbers`;
      }

      await sendMessage(
        targetChatId,
        message,
      );

      count++;
    } catch (error) {
      logger.warn(
        {
          err: error,
          chatId:
            targetChatId,
        },
        "Failed to send new-round notice.",
      );
    }
  }

  await sendMessage(
    chatId,
    `📢 ${bold(
      `New round notice delivered to ${count} users.`,
    )}`,
  );
}

/* =========================================================
   ADMIN: /BROADCAST
   ========================================================= */

async function handleBroadcastCommand(
  chatId: string,
  text: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  const broadcastMsg =
    getCommandText(text);

  if (!broadcastMsg) {
    await sendMessage(
      chatId,
      `❌ Please include a message.\n\nExample:\n${code(
        "/broadcast Hello everyone!",
      )}`,
    );

    return;
  }

  const allChatIds =
    await getAllRegisteredChatIds();

  let sentCount = 0;

  for (
    const targetChatId of allChatIds
  ) {
    try {
      const lang =
        getUserLanguage(
          targetChatId,
        );

      let prefix: string;

      if (lang === "am") {
        prefix =
          `📢 ${bold(
            "ማስታወቂያ",
          )}`;
      } else if (
        lang === "om"
      ) {
        prefix =
          `📢 ${bold(
            "BEKSISA",
          )}`;
      } else {
        prefix =
          `📢 ${bold(
            "ANNOUNCEMENT",
          )}`;
      }

      await sendMessage(
        targetChatId,
        `${prefix}\n\n${escapeHtml(
          broadcastMsg,
        )}`,
      );

      sentCount++;
    } catch (error) {
      logger.warn(
        {
          err: error,
          chatId:
            targetChatId,
        },
        "Failed to send broadcast.",
      );
    }
  }

  await sendMessage(
    chatId,
    `✅ ${bold(
      `Broadcast sent to ${sentCount} users.`,
    )}`,
  );
}

/* =========================================================
   ADMIN: /RESETLOTTO
   ========================================================= */

async function handleResetLotteryCommand(
  chatId: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  /**
   * NOTE:
   *
   * This deliberately preserves your original
   * reset behavior.
   *
   * It clears all current entries.
   *
   * Use this only when you intentionally want
   * to wipe the current round.
   */
  await db.delete(
    lotteryEntriesTable,
  );

  pendingSelections.clear();

  await sendMessage(
    chatId,
    `🔄 ${bold(
      "Lottery round reset!",
    )}\n\n` +
      `All current entries have been cleared.`,
  );
}

/* =========================================================
   ADMIN: /USER
   ========================================================= */

async function handleUserCommand(
  chatId: string,
  text: string,
): Promise<void> {
  if (!isAdmin(chatId)) {
    await sendMessage(
      chatId,
      `⛔ ${bold(
        "Access Denied",
      )}`,
    );

    return;
  }

  const args =
    getCommandArguments(text);

  const targetChatId =
    args[0]?.trim();

  if (!targetChatId) {
    await sendMessage(
      chatId,
      `⚠️ Usage:\n${code(
        "/user <chat_id>",
      )}\n\nExample:\n${code(
        "/user 806241233",
      )}`,
    );

    return;
  }

  const userEntries =
    await db
      .select()
      .from(
        lotteryEntriesTable,
      )
      .where(
        eq(
          lotteryEntriesTable.telegramChatId,
          targetChatId,
        ),
      );

  if (
    userEntries.length === 0
  ) {
    await sendMessage(
      chatId,
      `❌ No records found for Chat ID ${code(
        targetChatId,
      )}.`,
    );

    return;
  }

  let userDetails =
    `👤 ${bold(
      `USER DETAILS (${targetChatId})`,
    )}\n\n`;

  for (
    const entry of userEntries
  ) {
    userDetails +=
      `• ${bold(
        `Number #${entry.number}`,
      )}\n` +
      `  Status: ${code(
        entry.status,
      )}\n` +
      `  Name: ${escapeHtml(
        entry.customerName,
      )}\n` +
      `  Phone: ${escapeHtml(
        entry.phone ?? "N/A",
      )}\n` +
      `  Username: ${escapeHtml(
        entry.telegramUsername ??
          "N/A",
      )}\n\n`;
  }

  await sendMessage(
    chatId,
    userDetails,
  );
}

/* =========================================================
   HELP
   ========================================================= */

async function handleHelpCommand(
  chatId: string,
  lang: Language,
): Promise<void> {
  if (lang === "am") {
    await sendMessage(
      chatId,
      `📖 ${bold(
        "የሎተሪ መመሪያዎች",
      )}\n\n` +
        `• /numbers - ክፍት ቁጥሮችን ለማየት\n` +
        `• /pick 42 - ቁጥር ለመምረጥ\n` +
        `• /status - የያዙትን ቁጥሮች ለማየት\n` +
        `• /lang - ቋንቋ ለመቀየር`,
    );
  } else if (
    lang === "om"
  ) {
    await sendMessage(
      chatId,
      `📖 ${bold(
        "Qajeelfama Lotorii",
      )}\n\n` +
        `• /numbers - Lakkoofsa jiran ilaaluuf\n` +
        `• /pick 42 - Lakkoofsa filachuuf\n` +
        `• /status - Lakkoofsota qabdan ilaaluuf\n` +
        `• /lang - Afaan jijjiiruuf`,
    );
  } else {
    await sendMessage(
      chatId,
      `📖 ${bold(
        "Lottery Instructions",
      )}\n\n` +
        `• /numbers - View available numbers\n` +
        `• /pick 42 - Choose a number\n` +
        `• /status - View your numbers\n` +
        `• /lang - Change language`,
    );
  }
}

/* =========================================================
   AVAILABLE NUMBERS
   ========================================================= */

async function handleNumbersCommand(
  chatId: string,
  lang: Language,
): Promise<void> {
  const available =
    await listNumbers(
      "available",
    );

  const summary =
    await getSummary();

  const ranges =
    availableRanges(
      available.map(
        (item) =>
          item.number,
      ),
    );

  const rangeText =
    ranges.length > 0
      ? ranges.join(", ")
      : null;

  if (lang === "am") {
    await sendMessage(
      chatId,
      `🔢 ${bold(
        "ዝግጁ የሆኑ ቁጥሮች",
      )}: ${summary.availableNumbers} / ${summary.totalNumbers}\n\n` +
        `${rangeText ?? "ምንም ክፍት ቁጥር የለም"}\n\n` +
        `ቁጥር ለመምረጥ ${bold(
          "/pick ቁጥር",
        )} ይላኩ።`,
    );
  } else if (
    lang === "om"
  ) {
    await sendMessage(
      chatId,
      `🔢 ${bold(
        "Lakkoofsa jiran",
      )}: ${summary.availableNumbers} / ${summary.totalNumbers}\n\n` +
        `${rangeText ?? "Lakkoofsi banaa hin jiru"}\n\n` +
        `Lakkoofsa filachuuf ${bold(
          "/pick LAKKOOFSA",
        )} ergaa.`,
    );
  } else {
    await sendMessage(
      chatId,
      `🔢 ${bold(
        "Available numbers",
      )}: ${summary.availableNumbers} / ${summary.totalNumbers}\n\n` +
        `${rangeText ?? "No numbers available"}\n\n` +
        `To pick a number, send ${bold(
          "/pick NUMBER",
        )}.`,
    );
  }
}

/* =========================================================
   USER STATUS
   ========================================================= */

async function handleStatusCommand(
  chatId: string,
  lang: Language,
): Promise<void> {
  const userEntries =
    await db
      .select()
      .from(
        lotteryEntriesTable,
      )
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
      );

  if (
    userEntries.length === 0
  ) {
    if (lang === "am") {
      await sendMessage(
        chatId,
        `ℹ️ ${bold(
          "ምንም የያዙት ቁጥር የለም።",
        )}\n\n` +
          `/numbers በመጠቀም ቁጥር ይምረጡ።`,
      );
    } else if (
      lang === "om"
    ) {
      await sendMessage(
        chatId,
        `ℹ️ ${bold(
          "Lakkoofsa qabsiistan hin jiru.",
        )}\n\n` +
          `/numbers fayyadamuun lakkoofsa filadhaa.`,
      );
    } else {
      await sendMessage(
        chatId,
        `ℹ️ ${bold(
          "No active numbers found.",
        )}\n\n` +
          `Use /numbers to select a number.`,
      );
    }

    return;
  }

  const numberList =
    userEntries
      .map(
        (entry) =>
          `• ${bold(
            `#${entry.number}`,
          )} ` +
          `(${escapeHtml(
            entry.customerName,
          )}) - ${code(
            entry.status,
          )}`,
      )
      .join("\n");

  if (lang === "am") {
    await sendMessage(
      chatId,
      `📋 ${bold(
        `የያዟቸው ቁጥሮች (${userEntries.length})`,
      )}\n\n` +
        numberList,
    );
  } else if (
    lang === "om"
  ) {
    await sendMessage(
      chatId,
      `📋 ${bold(
        `Lakkoofsota qabsiistanii (${userEntries.length})`,
      )}\n\n` +
        numberList,
    );
  } else {
    await sendMessage(
      chatId,
      `📋 ${bold(
        `Your Numbers (${userEntries.length})`,
      )}\n\n` +
        numberList,
    );
  }
}

/* =========================================================
   PICK NUMBER
   ========================================================= */

async function handlePickCommand(
  chatId: string,
  text: string,
  lang: Language,
): Promise<boolean> {
  /**
   * Supports:
   *
   * /pick 42
   * 42
   */
  const command =
    getCommand(text);

  let numberText: string | undefined;

  if (command === "pick") {
    numberText =
      getCommandArguments(
        text,
      )[0];
  } else if (
    /^\d{1,3}$/.test(
      text.trim(),
    )
  ) {
    numberText =
      text.trim();
  }

  if (!numberText) {
    return false;
  }

  const number =
    Number(numberText);

  if (
    !Number.isInteger(number)
  ) {
    return false;
  }

  try {
    const available =
      await listNumbers(
        "available",
      );

    const isAvailable =
      available.some(
        (item) =>
          item.number ===
          number,
      );

    if (!isAvailable) {
      if (lang === "am") {
        await sendMessage(
          chatId,
          `❌ ቁጥር ${bold(
            `#${number}`,
          )} ክፍት አይደለም።`,
        );
      } else if (
        lang === "om"
      ) {
        await sendMessage(
          chatId,
          `❌ Lakkoofsi ${bold(
            `#${number}`,
          )} banaa miti.`,
        );
      } else {
        await sendMessage(
          chatId,
          `❌ Number ${bold(
            `#${number}`,
          )} is not available.`,
        );
      }

      return true;
    }

    pendingSelections.set(
      chatId,
      number,
    );

    if (lang === "am") {
      await sendMessage(
        chatId,
        `✅ Lakkoofsi ${bold(
          `#${number}`,
        )} banaadha.\n\n` +
          `Qabsiisuuf ${bold(
            "maqaa guutuu keessan",
          )} ergaa.`,
      );
    } else if (
      lang === "om"
    ) {
      await sendMessage(
        chatId,
        `✅ Lakkoofsi ${bold(
          `#${number}`,
        )} banaadha.\n\n` +
          `Qabsiisuuf ${bold(
            "Maqaa Guutuu",
          )} keessan ergaa.`,
      );
    } else {
      await sendMessage(
        chatId,
        `✅ Number ${bold(
          `#${number}`,
        )} is available.\n\n` +
          `Reply with your ${bold(
            "Full Name",
          )} to reserve it.`,
      );
    }

    return true;
  } catch (error) {
    logger.error(
      {
        err: error,
        chatId,
        number,
      },
      "Failed to process number selection.",
    );

    await sendMessage(
      chatId,
      `❌ ${bold(
        "Unable to process your number selection.",
      )}\n\nPlease try again.`,
    );

    return true;
  }
}

/* =========================================================
   RESERVATION AFTER FULL NAME
   ========================================================= */

async function handlePendingName(
  message: TelegramMessage,
  chatId: string,
  lang: Language,
): Promise<boolean> {
  const pendingNumber =
    pendingSelections.get(
      chatId,
    );

  if (
    pendingNumber ===
    undefined
  ) {
    return false;
  }

  const text =
    message.text?.trim() ??
    "";

  if (!text) {
    return false;
  }

  /**
   * Prevent commands from accidentally becoming
   * customer names.
   */
  if (
    text.startsWith("/")
  ) {
    return false;
  }

  try {
    const savedPhone =
      await getUserPhone(
        chatId,
      );

    const reserved =
      await reserveNumber({
        number:
          pendingNumber,

        customerName:
          text,

        telegramUsername:
          message.from
            ?.username ??
          null,

        telegramChatId:
          chatId,

        phone:
          savedPhone,
      });

    pendingSelections.delete(
      chatId,
    );

    const customerName =
      escapeHtml(
        reserved.customerName,
      );

    if (lang === "am") {
      await sendMessage(
        chatId,
        `✅ ${bold(
          `ቁጥር #${reserved.number} በ ${reserved.customerName} ስም ተይዟል።`,
        )}\n\n` +
          `⚠️ ${bold(
            "ማሳሰቢያ",
          )}\n` +
          `በ ${bold(
            "15 ደቂቃ",
          )} ውስጥ ክፍያ ፈፅመው ደረሰኝ ካልላኩ ቦታ ማስያዙ በራስ-ሰር ይሰረዛል።\n\n` +
          `💰 ${bold(
            "200 ETB በ Telebirr ወይም Bank ይክፈሉ።",
          )}\n\n` +
          `📱 ${bold(
            "Telebirr",
          )}\n` +
          `• ቁጥር: ${code(
            "0910778728",
          )}\n` +
          `• ስም: ${escapeHtml(
            "Remedan Abdulbari Esmael",
          )}\n\n` +
          `🏦 ${bold(
            "CBE Bank",
          )}\n` +
          `• ሂሳብ ቁጥር: ${code(
            "1000724939779",
          )}\n` +
          `• ስም: ${escapeHtml(
            "Remedan Abdulbari Esmael",
          )}\n\n` +
          `ከከፈሉ በኋላ ${bold(
            "የክፍያ ደረሰኝ ስክሪንሾት",
          )} ቀጥታ ወደዚህ ቻት ይላኩ።`,
      );
    } else if (
      lang === "om"
    ) {
      await sendMessage(
        chatId,
        `✅ ${bold(
          `Lakkoofsi #${reserved.number} maqaa ${reserved.customerName}tiin qabameera.`,
        )}\n\n` +
          `⚠️ ${bold(
            "Akeekkachiisa",
          )}\n` +
          `Daqiiqaa ${bold(
            "15",
          )} keessatti kaffaltii raawwattanii nagahee yoo hin ergine, qabsiisni ofumaan haqama.\n\n` +
          `💰 ${bold(
            "200 ETB Telebirr ykn Baankiin kaffalaa.",
          )}\n\n` +
          `📱 ${bold(
            "Telebirr",
          )}\n` +
          `• Lakkoofsa: ${code(
            "0910778728",
          )}\n` +
          `• Maqaa: ${escapeHtml(
            "Remedan Abdulbari Esmael",
          )}\n\n` +
          `🏦 ${bold(
            "CBE Bank",
          )}\n` +
          `• Herrega: ${code(
            "1000724939779",
          )}\n` +
          `• Maqaa: ${escapeHtml(
            "Remedan Abdulbari Esmael",
          )}\n\n` +
          `Kaffaltii erga raawwattanii booda ${bold(
            "screenshot nagahee kaffaltii",
          )} kallattiin chat kanaaf ergaa.`,
      );
    } else {
      await sendMessage(
        chatId,
        `✅ ${bold(
          `Number #${reserved.number} reserved for ${customerName}.`,
        )}\n\n` +
          `⚠️ ${bold(
            "Important",
          )}\n` +
          `You must complete payment and submit proof within ${bold(
            "15 minutes",
          )}, otherwise the reservation will automatically expire.\n\n` +
          `💰 ${bold(
            "Pay 200 ETB via Telebirr or Bank.",
          )}\n\n` +
          `📱 ${bold(
            "Telebirr",
          )}\n` +
          `• Number: ${code(
            "0910778728",
          )}\n` +
          `• Name: ${escapeHtml(
            "Remedan Abdulbari Esmael",
          )}\n\n` +
          `🏦 ${bold(
            "CBE Bank",
          )}\n` +
          `• Account: ${code(
            "1000724939779",
          )}\n` +
          `• Name: ${escapeHtml(
            "Remedan Abdulbari Esmael",
          )}\n\n` +
          `After paying, send the ${bold(
            "payment screenshot",
          )} directly to this chat.`,
      );
    }

    return true;
  } catch (error) {
    /**
     * Very important:
     *
     * If another user successfully took the number
     * between /pick and the name submission, reserveNumber()
     * will reject it.
     *
     * We must clear the pending selection and tell the
     * customer what happened.
     */
    pendingSelections.delete(
      chatId,
    );

    logger.warn(
      {
        err: error,
        chatId,
        pendingNumber,
      },
      "Number reservation failed.",
    );

    const errorMessage =
      error instanceof Error
        ? error.message
        : "";

    if (
      errorMessage.includes(
        "no longer available",
      )
    ) {
      if (lang === "am") {
        await sendMessage(
          chatId,
          `❌ ይቅርታ። ቁጥር ${bold(
            `#${pendingNumber}`,
          )} ከእንግዲህ ክፍት አይደለም።\n\n` +
            `/numbers በመላክ ሌላ ቁጥር ይምረጡ።`,
        );
      } else if (
        lang === "om"
      ) {
        await sendMessage(
          chatId,
          `❌ Dhiifama. Lakkoofsi ${bold(
            `#${pendingNumber}`,
          )} amma banaa miti.\n\n` +
            `/numbers erguun lakkoofsa biraa filadhaa.`,
        );
      } else {
        await sendMessage(
          chatId,
          `❌ Sorry. Number ${bold(
            `#${pendingNumber}`,
          )} is no longer available.\n\n` +
            `Send /numbers to choose another number.`,
        );
      }
    } else {
      await sendMessage(
        chatId,
        `❌ ${bold(
          "We could not complete the reservation.",
        )}\n\nPlease try /numbers again.`,
      );
    }

    return true;
  }
}

/* =========================================================
   PHONE REGISTRATION
   ========================================================= */

async function handleContact(
  message: TelegramMessage,
  chatId: string,
  lang: Language,
): Promise<void> {
  const contact =
    message.contact;

  if (!contact) {
    return;
  }

  /**
   * Security check:
   *
   * Telegram contact sharing normally includes user_id.
   * If it exists and doesn't match the sender, reject it.
   *
   * This prevents an admin/user from accidentally registering
   * someone else's contact as their own.
   */
  if (
    contact.user_id !==
      undefined &&
    message.from?.id !==
      undefined &&
    contact.user_id !==
      message.from.id
  ) {
    await sendMessage(
      chatId,
      `⚠️ ${bold(
        "Please share your own phone number.",
      )}`,
    );

    return;
  }

  const phoneNumber =
    contact.phone_number.trim();

  if (!phoneNumber) {
    await sendMessage(
      chatId,
      `❌ ${bold(
        "Invalid phone number.",
      )}`,
    );

    return;
  }

  userPhones.set(
    chatId,
    phoneNumber,
  );

  try {
    await updateCustomerPhone(
      chatId,
      phoneNumber,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        chatId,
      },
      "Failed to update customer phone.",
    );
  }

  if (lang === "am") {
    await sendMessage(
      chatId,
      `✅ ${bold(
        `ስልክ ቁጥርዎ በትክክል ተመዝግቧል።`,
      )}\n\n` +
        `📱 ${code(
          phoneNumber,
        )}\n\n` +
        `አሁን የሎተሪ አገልግሎቱን መጠቀም ይችላሉ።\n` +
        `${bold(
          "/numbers",
        )} በመላክ ቁጥር ይምረጡ።`,
    );
  } else if (
    lang === "om"
  ) {
    await sendMessage(
      chatId,
      `✅ ${bold(
        "Lakkoofsi bilbilaa keessan galmaa'eera.",
      )}\n\n` +
        `📱 ${code(
          phoneNumber,
        )}\n\n` +
        `Amma tajaajila lotorii fayyadamuu dandeessu.\n` +
        `${bold(
          "/numbers",
        )} erguun lakkoofsa filadhaa.`,
    );
  } else {
    await sendMessage(
      chatId,
      `✅ ${bold(
        "Phone number registered successfully.",
      )}\n\n` +
        `📱 ${code(
          phoneNumber,
        )}\n\n` +
        `You can now use the lottery service.\n` +
        `Send ${bold(
          "/numbers",
        )} to pick a number.`,
    );
  }
}

/* =========================================================
   PHONE REGISTRATION GUARD
   ========================================================= */

async function requirePhone(
  chatId: string,
  lang: Language,
): Promise<boolean> {
  /**
   * Admins don't need phone registration.
   */
  if (isAdmin(chatId)) {
    return true;
  }

  const savedPhone =
    await getUserPhone(chatId);

  if (savedPhone) {
    return true;
  }

  if (lang === "am") {
    await requestPhoneShare(
      chatId,
      `⚠️ ${bold(
        "ስልክ ቁጥር ማጋራት ግዴታ ነው።",
      )}\n\n` +
        `ለመሳተፍ ${bold(
          "📱 ስልክ ቁጥር አጋራ",
        )} የሚለውን ቁልፍ ይጫኑ።`,
      "📱 ስልክ ቁጥር አጋራ",
    );
  } else if (
    lang === "om"
  ) {
    await requestPhoneShare(
      chatId,
      `⚠️ ${bold(
        "Lakkoofsa bilbilaa qooduun dirqama.",
      )}\n\n` +
        `Hirmaachuuf ${bold(
          "📱 Lakkoofsa Bilbilaa Qooda",
        )} jedhu tuqaa.`,
      "📱 Lakkoofsa Bilbilaa Qooda",
    );
  } else {
    await requestPhoneShare(
      chatId,
      `⚠️ ${bold(
        "Phone sharing is mandatory.",
      )}\n\n` +
        `Please tap ${bold(
          "📱 Share Phone Number",
        )} below to participate.`,
      "📱 Share Phone Number",
    );
  }

  return false;
}

/* =========================================================
   PAYMENT SCREENSHOT
   ========================================================= */

async function handlePaymentPhoto(
  message: TelegramMessage,
  chatId: string,
  lang: Language,
): Promise<void> {
  if (
    !message.photo ||
    message.photo.length === 0
  ) {
    return;
  }

  const entry =
    await findCustomerEntry(
      chatId,
    );

  if (!entry) {
    if (lang === "am") {
      await sendMessage(
        chatId,
        `❌ ${bold(
          "ንቁ ቦታ ማስያዝ አልተገኘም።",
        )}\n\n` +
          `መጀመሪያ /numbers ወይም /pick ቁጥር ይላኩ።`,
      );
    } else if (
      lang === "om"
    ) {
      await sendMessage(
        chatId,
        `❌ ${bold(
          "Qabsiisa active ta'e hin argamne.",
        )}\n\n` +
          `Jalqaba /numbers ykn /pick LAKKOOFSA ergaa.`,
      );
    } else {
      await sendMessage(
        chatId,
        `❌ ${bold(
          "No active reservation found.",
        )}\n\n` +
          `Use /numbers or /pick NUMBER first.`,
      );
    }

    return;
  }

  if (
    entry.status ===
    "paid"
  ) {
    await sendMessage(
      chatId,
      lang === "am"
        ? `ℹ️ ${bold(
            `ቁጥር #${entry.number} ክፍያው ቀድሞ ተረጋግጧል።`,
          )}`
        : lang === "om"
          ? `ℹ️ ${bold(
              `Lakkoofsi #${entry.number} kaffaltiin isaa duraan mirkanaa'eera.`,
            )}`
          : `ℹ️ ${bold(
              `Number #${entry.number} is already paid.`,
            )}`,
    );

    return;
  }

  if (
    entry.status ===
    "proof_submitted"
  ) {
    await sendMessage(
      chatId,
      lang === "am"
        ? `⏳ ${bold(
            `የክፍያ ደረሰኝዎ ለቁጥር #${entry.number} ቀድሞ ተልኳል።`,
          )}\n\nእባክዎ አድሚኑ እስኪያረጋግጥ ይጠብቁ።`
        : lang === "om"
          ? `⏳ ${bold(
              `Nagaheen kaffaltii lakkoofsa #${entry.number} duraan ergameera.`,
            )}\n\nAdmin hanga mirkaneessutti maaloo eeggadhaa.`
          : `⏳ ${bold(
              `Payment proof for number #${entry.number} has already been submitted.`,
            )}\n\nPlease wait for admin verification.`,
    );

    return;
  }

  /**
   * Use the largest Telegram photo because it has
   * the best available resolution.
   */
  const photo =
    message.photo[
      message.photo.length - 1
    ];

  if (!photo?.file_id) {
    await sendMessage(
      chatId,
      `❌ ${bold(
        "Payment image could not be processed.",
      )}`,
    );

    return;
  }

  try {
    await submitProof(
      entry.id,
      {
        paymentMethod:
          "telebirr",

        paymentReference:
          `Screenshot FileID: ${photo.file_id}`,

        paymentProof:
          `Photo proof uploaded by ${chatId}`,
      },
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        entryId: entry.id,
      },
      "Failed to submit payment proof.",
    );

    const errorMessage =
      error instanceof Error
        ? error.message
        : "";

    if (
      errorMessage.includes(
        "expired",
      )
    ) {
      await sendMessage(
        chatId,
        `❌ ${bold(
          "This reservation has expired.",
        )}\n\nPlease select another number using /numbers.`,
      );
    } else {
      await sendMessage(
        chatId,
        `❌ ${bold(
          "Payment proof could not be submitted.",
        )}\n\nPlease try again.`,
      );
    }

    return;
  }

  /**
   * Notify all admins.
   */
  for (
    const adminId of ADMIN_CHAT_IDS
  ) {
    try {
      await telegramRequest(
        "sendPhoto",
        {
          chat_id: adminId,

          photo:
            photo.file_id,

          caption:
            `📸 NEW PAYMENT SCREENSHOT SUBMITTED\n\n` +
            `Number: #${entry.number}\n` +
            `Customer: ${entry.customerName}\n` +
            `Phone: ${entry.phone ?? "N/A"}\n` +
            `Chat ID: ${chatId}\n\n` +
            `Approve: /approve ${entry.number}\n` +
            `Reject: /reject ${entry.number}`,

          parse_mode: "HTML",
        },
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          adminId,
        },
        "Failed to forward payment proof to admin.",
      );
    }
  }

  if (lang === "am") {
    await sendMessage(
      chatId,
      `📸 ${bold(
        `የክፍያ ደረሰኝ ለቁጥር #${entry.number} ተቀብለናል!`,
      )}\n\n` +
        `አድሚኑ ክፍያውን ካረጋገጠ በኋላ ማረጋገጫ ይላክልዎታል።`,
    );
  } else if (
    lang === "om"
  ) {
    await sendMessage(
      chatId,
      `📸 ${bold(
        `Nagaheen kaffaltii lakkoofsa #${entry.number} fudhatameera!`,
      )}\n\n` +
        `Admin kaffaltii erga mirkaneesse booda isin beeksisa.`,
    );
  } else {
    await sendMessage(
      chatId,
      `📸 ${bold(
        `Payment screenshot received for number #${entry.number}!`,
      )}\n\n` +
        `An admin will verify your payment shortly.`,
    );
  }
}

/* =========================================================
   MAIN MESSAGE HANDLER
   ========================================================= */

async function handleMessage(
  message: TelegramMessage,
): Promise<void> {
  const chatId =
    String(message.chat.id);

  const text =
    message.text?.trim() ??
    "";

  let lang =
    getUserLanguage(chatId);

  const command =
    getCommand(text);

  /* =======================================================
     ADMIN COMMANDS
     ======================================================= */

  switch (command) {
    case "admin":
      await handleAdminCommand(
        chatId,
      );
      return;

    case "pending":
      await handlePendingCommand(
        chatId,
      );
      return;

    case "approve":
      await handleApproveCommand(
        chatId,
        text,
      );
      return;

    case "reject":
      await handleRejectCommand(
        chatId,
        text,
      );
      return;

    case "drawlotto":
      await handleDrawCommand(
        chatId,
      );
      return;

    case "newround":
    case "roundnotice":
      await handleNewRoundCommand(
        chatId,
        text,
      );
      return;

    case "broadcast":
      await handleBroadcastCommand(
        chatId,
        text,
      );
      return;

    case "resetlotto":
      await handleResetLotteryCommand(
        chatId,
      );
      return;

    case "user":
      await handleUserCommand(
        chatId,
        text,
      );
      return;
  }

  /* =======================================================
     LANGUAGE SELECTION
     ======================================================= */

  if (
    await handleLanguageSelection(
      chatId,
      text,
    )
  ) {
    return;
  }

  /* =======================================================
     PHONE CONTACT
     ======================================================= */

  if (message.contact) {
    await handleContact(
      message,
      chatId,
      lang,
    );

    return;
  }

  /* =======================================================
     START / LANGUAGE COMMAND
     ======================================================= */

  if (
    command === "start" ||
    command === "lang"
  ) {
    await handleStartCommand(
      chatId,
    );

    return;
  }

  /* =======================================================
     PHONE REGISTRATION GUARD
     ======================================================= */

  if (
    !(await requirePhone(
      chatId,
      lang,
    ))
  ) {
    return;
  }

  /* =======================================================
     PAYMENT PHOTO
     ======================================================= */

  if (
    message.photo &&
    message.photo.length > 0
  ) {
    await handlePaymentPhoto(
      message,
      chatId,
      lang,
    );

    return;
  }

  /* =======================================================
     IGNORE EMPTY NON-TEXT MESSAGE
     ======================================================= */

  if (!text) {
    return;
  }

  /* =======================================================
     CUSTOMER COMMANDS
     ======================================================= */

  if (command === "help") {
    await handleHelpCommand(
      chatId,
      lang,
    );

    return;
  }

  if (
    command === "numbers"
  ) {
    await handleNumbersCommand(
      chatId,
      lang,
    );

    return;
  }

  if (
    command === "status" ||
    command === "mynumbers"
  ) {
    await handleStatusCommand(
      chatId,
      lang,
    );

    return;
  }

  /* =======================================================
     NUMBER SELECTION
     ======================================================= */

  const handledPick =
    await handlePickCommand(
      chatId,
      text,
      lang,
    );

  if (handledPick) {
    return;
  }

  /* =======================================================
     PENDING FULL NAME
     ======================================================= */

  const handledPendingName =
    await handlePendingName(
      message,
      chatId,
      lang,
    );

  if (handledPendingName) {
    return;
  }

  /* =======================================================
     FALLBACK
     ======================================================= */

  if (lang === "am") {
    await sendMessage(
      chatId,
      `❓ ${bold(
        "ትእዛዙ አልተለየም።",
      )}\n\n` +
        `/help ይጠቀሙ።`,
    );
  } else if (
    lang === "om"
  ) {
    await sendMessage(
      chatId,
      `❓ ${bold(
        "Ajajni hin beekamne.",
      )}\n\n` +
        `/help fayyadamaa.`,
    );
  } else {
    await sendMessage(
      chatId,
      `❓ ${bold(
        "Command not recognized.",
      )}\n\n` +
        `Use /help.`,
    );
  }
}

/* =========================================================
   TELEGRAM UPDATE ENTRY POINT
   ========================================================= */

export async function handleTelegramUpdate(
  update: TelegramUpdate,
): Promise<void> {
  if (!update.message) {
    return;
  }

  try {
    await handleMessage(
      update.message,
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        updateId:
          update.update_id,
      },
      "Telegram update failed.",
    );

    /**
     * Try to notify the user rather than silently
     * failing.
     */
    try {
      const chatId =
        String(
          update.message.chat.id,
        );

      await sendMessage(
        chatId,
        `⚠️ ${bold(
          "Something went wrong.",
        )}\n\nPlease try again.`,
      );
    } catch {
      // Nothing else we can safely do here.
    }
  }
}

/* =========================================================
   POLLING
   ========================================================= */

async function poll(): Promise<void> {
  let offset = 0;

  try {
    await telegramRequest(
      "deleteWebhook",
      {
        drop_pending_updates:
          false,
      },
    );
  } catch (error) {
    logger.error(
      {
        err: error,
      },
      "Telegram bot connection error.",
    );

    return;
  }

  /**
   * Cleanup expired reservations every minute.
   */
  setInterval(() => {
    cleanupExpiredReservations()
      .catch((error) => {
        logger.error(
          {
            err: error,
          },
          "Failed to clean up expired reservations.",
        );
      });
  }, 60 * 1000);

  while (true) {
    try {
      const updates =
        (await telegramRequest<
          TelegramUpdate[]
        >(
          "getUpdates",
          {
            offset,

            timeout: 25,

            allowed_updates: [
              "message",
            ],
          },
        )) ?? [];

      for (
        const update of updates
      ) {
        if (
          typeof update.update_id ===
          "number"
        ) {
          offset =
            update.update_id + 1;
        }

        await handleTelegramUpdate(
          update,
        );
      }
    } catch (error) {
      logger.error(
        {
          err: error,
        },
        "Telegram polling failed.",
      );

      /**
       * Avoid hammering Telegram if there is
       * a temporary network/API problem.
       */
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            5000,
          ),
      );
    }
  }
}

/* =========================================================
   START BOT
   ========================================================= */

export function startTelegramBot(): void {
  if (started) {
    return;
  }

  if (
    !process.env.TELEGRAM_BOT_TOKEN
  ) {
    logger.warn(
      "TELEGRAM_BOT_TOKEN is not configured. Telegram bot will not start.",
    );

    return;
  }

  started = true;

  void setupAdminCommandScopes();

  void poll();
}

/* =========================================================
   START
   ========================================================= */

startTelegramBot();