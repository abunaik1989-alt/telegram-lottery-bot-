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

type TelegramPhoto = {
  file_id: string;
};

type TelegramContact = {
  phone_number: string;
  first_name?: string;
  user_id?: number;
};

type TelegramMessage = {
  chat: {
    id: number | string;
  };
  text?: string;
  photo?: TelegramPhoto[];
  contact?: TelegramContact;
  from?: {
    username?: string;
    first_name?: string;
  };
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

type Language = "am" | "om" | "en";

/* =========================================================
   ADMIN AUTHORIZATION
========================================================= */

const ADMIN_CHAT_IDS: string[] = [
  "806241233",
  process.env.ADMIN_CHAT_ID,
  process.env.ADMIN_ID,
]
  .filter(Boolean)
  .map((id) => String(id).trim());

function isAdmin(
  chatId: string | number,
): boolean {
  return ADMIN_CHAT_IDS.includes(
    String(chatId).trim(),
  );
}

/* =========================================================
   USER MEMORY
========================================================= */

const pendingSelections =
  new Map<string, number>();

const userLanguages =
  new Map<string, Language>();

const userPhones =
  new Map<string, string>();

let started = false;

/* =========================================================
   TELEGRAM API
========================================================= */

function apiUrl(method: string) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured.",
    );
  }

  return `https://api.telegram.org/bot${token}/${method}`;
}

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

  const payload =
    (await response.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };

  if (
    !response.ok ||
    !payload.ok
  ) {
    throw new Error(
      payload.description ??
        `Telegram API ${method} failed`,
    );
  }

  return payload.result ?? null;
}

/* =========================================================
   USER PHONE
========================================================= */

async function getUserPhone(
  chatId: string,
): Promise<string | null> {
  /**
   * First check memory.
   */
  if (userPhones.has(chatId)) {
    return (
      userPhones.get(chatId) ?? null
    );
  }

  /**
   * Then check database.
   */
  const [user] = await db
    .select({
      phone:
        lotteryEntriesTable.phone,
    })
    .from(lotteryEntriesTable)
    .where(
      eq(
        lotteryEntriesTable.telegramChatId,
        chatId,
      ),
    )
    .limit(1);

  if (user?.phone) {
    userPhones.set(
      chatId,
      user.phone,
    );

    return user.phone;
  }

  return null;
}

/* =========================================================
   LANGUAGE
========================================================= */

async function getUserLanguage(
  chatId: string,
): Promise<Language> {
  if (userLanguages.has(chatId)) {
    return (
      userLanguages.get(chatId) ??
      "am"
    );
  }

  const [user] = await db
    .select({
      language:
        lotteryEntriesTable.language,
    })
    .from(lotteryEntriesTable)
    .where(
      eq(
        lotteryEntriesTable.telegramChatId,
        chatId,
      ),
    )
    .limit(1);

  const lang =
    user?.language === "om" ||
    user?.language === "en" ||
    user?.language === "am"
      ? user.language
      : "am";

  userLanguages.set(
    chatId,
    lang,
  );

  return lang;
}

/* =========================================================
   REGISTERED USERS
========================================================= */

async function getAllRegisteredChatIds(): Promise<
  string[]
> {
  const entries = await db
    .select({
      chatId:
        lotteryEntriesTable.telegramChatId,
    })
    .from(lotteryEntriesTable);

  const dbChatIds = entries
    .map((entry) => entry.chatId)
    .filter(Boolean);

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
   ADMIN COMMAND SCOPES
========================================================= */

async function setupAdminCommandScopes() {
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
                "Approve payment (e.g. /approve 28)",
            },
            {
              command: "reject",
              description:
                "Reject payment (e.g. /reject 28)",
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
                "Look up user info",
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
    } catch (e) {
      logger.error(
        `Failed to scope commands for admin ${adminId}`,
      );
    }
  }
}

/* =========================================================
   SEND MESSAGE
========================================================= */

async function sendMessage(
  chatId: string,
  text: string,
  replyMarkup:
    | Record<string, unknown>
    | null = null,
) {
  const body: Record<
    string,
    unknown
  > = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
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

/* =========================================================
   REQUEST PHONE
========================================================= */

async function requestPhoneShare(
  chatId: string,
  text: string,
  buttonLabel: string,
) {
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
   NUMBER RANGE FORMATTER
========================================================= */

function availableRanges(
  numbers: number[],
) {
  const ranges: string[] = [];

  let start:
    | number
    | undefined;

  let previous:
    | number
    | undefined;

  for (const number of numbers) {
    if (start === undefined) {
      start = number;
    } else if (
      previous !== undefined &&
      number !== previous + 1
    ) {
      ranges.push(
        start === previous
          ? `${start}`
          : `${start}-${previous}`,
      );

      start = number;
    }

    previous = number;
  }

  if (
    start !== undefined &&
    previous !== undefined
  ) {
    ranges.push(
      start === previous
        ? `${start}`
        : `${start}-${previous}`,
    );
  }

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
) {
  /**
   * IMPORTANT:
   * Use participantChatIds captured before
   * drawWinner deleted the entries.
   */
  const allChatIds =
    winner.participantChatIds;

  for (
    const chatId of allChatIds
  ) {
    const lang =
      await getUserLanguage(
        chatId,
      );

    const announcementMsg =
      lang === "am"
        ? `🎉 **የሎተሪው ዕጣ ወጥቷል!** 🎉\n\n` +
          `🏆 **አሸናፊ ቁጥር:** #${winner.winnerNumber}\n` +
          `👤 **የአሸናፊው ስም:** ${winner.customerName}\n\n` +
          `🔄 **አዲስ ዙር ተጀምሯል!**\n` +
          `ሁሉም የቆዩ ቁጥሮች ፀድተዋል።\n\n` +
          `አሁኑኑ /numbers በማለት አዲስ ቁጥር ይምረጡ!`
        : lang === "om"
          ? `🎉 **Lottoriin carraan ba'eera!** 🎉\n\n` +
            `🏆 **Lakkoofsa Mo'ataa:** #${winner.winnerNumber}\n` +
            `👤 **Maqaa Mo'ataa:** ${winner.customerName}\n\n` +
            `🔄 **Marsaan haaraan jalqabameera!**\n` +
            `Lakkoofsotni marsaa duraa hundi haqamaniiru.\n\n` +
            `Amma /numbers fayyadamuun lakkoofsa haaraa filadhaa!`
          : `🎉 **LOTTERY DRAW COMPLETED!** 🎉\n\n` +
            `🏆 **Winning Number:** #${winner.winnerNumber}\n` +
            `👤 **Winner Name:** ${winner.customerName}\n\n` +
            `🔄 **A new round has started!**\n` +
            `All previous numbers have been cleared.\n\n` +
            `Send /numbers to pick a new number!`;

    try {
      await sendMessage(
        chatId,
        announcementMsg,
      );
    } catch (e) {
      logger.error(
        `Failed to notify chat ${chatId}`,
      );
    }
  }
}

/* =========================================================
   MAIN MESSAGE HANDLER
========================================================= */

async function handleMessage(
  message: TelegramMessage,
) {
  const chatId =
    String(message.chat.id);

  const text =
    message.text?.trim() ?? "";

  let lang =
    await getUserLanguage(
      chatId,
    );

  const cmd =
    text
      .split(/\s+/)[0]
      .toLowerCase();

  /* =======================================================
     ADMIN: /admin
  ======================================================= */

  if (
    cmd === "/admin" ||
    cmd === "admin"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        `⛔ **Access Denied.**\n\nYour Chat ID: \`${chatId}\``,
      );
      return;
    }

    const summary =
      await getSummary();

    const adminMsg =
      `🛠 **ADMIN CONTROL PANEL**\n` +
      `─────────────\n\n` +
      `📊 **Summary:**\n` +
      `• Total Numbers: \`${summary.totalNumbers}\`\n` +
      `• Available: \`${summary.availableNumbers}\`\n` +
      `• Paid Entries: \`${summary.paidNumbers}\`\n` +
      `• Pending Approval: \`${summary.proofPending}\`\n` +
      `• Active Reserved: \`${summary.reservedNumbers}\`\n` +
      `• Total Revenue: \`${summary.totalCollected} ${summary.currency}\`\n\n` +
      `⚡ **Admin Commands:**\n` +
      `• /pending\n` +
      `• /approve <number>\n` +
      `• /reject <number>\n` +
      `• /drawlotto\n` +
      `• /newround <message>\n` +
      `• /broadcast <message>\n` +
      `• /resetlotto\n` +
      `• /user <chat_id>`;

    await sendMessage(
      chatId,
      adminMsg,
    );

    return;
  }

  /* =======================================================
     ADMIN: /pending
  ======================================================= */

  if (cmd === "/pending") {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
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
        "✅ **No pending payment proofs to review.**",
      );
      return;
    }

    let pendingListMsg =
      `⏳ **PENDING PAYMENTS (${pendingEntries.length})**\n\n`;

    for (
      const entry of pendingEntries
    ) {
      pendingListMsg +=
        `🔹 **Number #${entry.number}**\n` +
        `• Name: ${entry.customerName}\n` +
        `• Phone: ${entry.phone ?? "N/A"}\n` +
        `• Chat ID: \`${entry.telegramChatId}\`\n` +
        `• Proof: ${entry.paymentReference ?? "N/A"}\n` +
        `• Approve: \`/approve ${entry.number}\`\n` +
        `• Reject: \`/reject ${entry.number}\`\n\n`;
    }

    await sendMessage(
      chatId,
      pendingListMsg,
    );

    return;
  }

  /* =======================================================
     ADMIN: /approve
  ======================================================= */

  if (
    cmd === "/approve"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
      );
      return;
    }

    const parts =
      text.split(/\s+/);

    const numberToApprove =
      Number(parts[1]);

    if (
      !Number.isInteger(
        numberToApprove,
      )
    ) {
      await sendMessage(
        chatId,
        "⚠️ Usage: `/approve <number>`",
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
              numberToApprove,
            ),
            eq(
              lotteryEntriesTable.status,
              "proof_submitted",
            ),
          ),
        );

    if (!entry) {
      await sendMessage(
        chatId,
        `❌ No pending proof found for number #${numberToApprove}.`,
      );
      return;
    }

    await approveEntry(
      entry.id,
    );

    await sendMessage(
      chatId,
      `✅ **Number #${numberToApprove} approved successfully!**`,
    );

    const userLang =
      await getUserLanguage(
        entry.telegramChatId,
      );

    const customerMsg =
      userLang === "am"
        ? `🎉 **ክፍያዎ ጸድቋል!**\n\nቁጥር #${entry.number} ሙሉ በሙሉ የእርስዎ ሆኗል።\nመልካም እድል!`
        : userLang === "om"
          ? `🎉 **Kaffaltiin keessan mirkanaa'eera!**\n\nLakkoofsi #${entry.number} kan keessan ta'eera.\nCarraa gaarii!`
          : `🎉 **Payment Approved!**\n\nNumber #${entry.number} is officially yours.\nGood luck!`;

    try {
      await sendMessage(
        entry.telegramChatId,
        customerMsg,
      );
    } catch (e) {
      logger.error(
        `Failed to notify customer ${entry.telegramChatId}`,
      );
    }

    return;
  }

  /* =======================================================
     ADMIN: /reject
  ======================================================= */

  if (
    cmd === "/reject"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
      );
      return;
    }

    const parts =
      text.split(/\s+/);

    const numberToReject =
      Number(parts[1]);

    if (
      !Number.isInteger(
        numberToReject,
      )
    ) {
      await sendMessage(
        chatId,
        "⚠️ Usage: `/reject <number>`",
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
              numberToReject,
            ),
            inArray(
              lotteryEntriesTable.status,
              [
                "reserved",
                "proof_submitted",
              ],
            ),
          ),
        );

    if (!entry) {
      await sendMessage(
        chatId,
        `❌ Active reservation/proof not found for number #${numberToReject}.`,
      );
      return;
    }

    await rejectEntry(
      entry.id,
    );

    await sendMessage(
      chatId,
      `🚫 **Number #${numberToReject} rejected and released.**`,
    );

    const userLang =
      await getUserLanguage(
        entry.telegramChatId,
      );

    const customerMsg =
      userLang === "am"
        ? `❌ **የክፍያ ደረሰኝዎ ውድቅ ተደርጓል!**\n\nቁጥር #${entry.number} ክፍት ተደርጓል።\nእባክዎ እንደገና ይሞክሩ።`
        : userLang === "om"
          ? `❌ **Nagaheen kaffaltii keessanii kufaa ta'eera!**\n\nLakkoofsi #${entry.number} banaa ta'eera.\nMaaloo ammas yaalaa.`
          : `❌ **Payment rejected.**\n\nReservation for number #${entry.number} has been released.\nPlease try again.`;

    try {
      await sendMessage(
        entry.telegramChatId,
        customerMsg,
      );
    } catch (e) {
      logger.error(
        `Failed to notify customer ${entry.telegramChatId}`,
      );
    }

    return;
  }

  /* =======================================================
     ADMIN: /drawlotto
  ======================================================= */

  if (
    cmd === "/drawlotto"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
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
        `✅ **Draw completed successfully!**\n\n🏆 Winner: #${winner.winnerNumber}\n👤 ${winner.customerName}\n\n📢 Winner announcement sent to ${winner.participantChatIds.length} participants.`,
      );
    } catch (
      err: any
    ) {
      await sendMessage(
        chatId,
        `❌ **Error performing draw:** ${err?.message ?? "Unknown error"}`,
      );
    }

    return;
  }

  /* =======================================================
     ADMIN: /newround
  ======================================================= */

  if (
    cmd === "/newround" ||
    cmd === "/roundnotice"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
      );
      return;
    }

    const roundMsg =
      text
        .replace(
          /^\/(newround|roundnotice)\s*/i,
          "",
        )
        .trim();

    const noticeContent =
      roundMsg ||
      `🚀 **አዲስ የሎተሪ ዙር ተጀምሯል!**\nአሁኑኑ /numbers በማለት ዕድልዎን ይሞክሩ።`;

    const allChatIds =
      await getAllRegisteredChatIds();

    let count = 0;

    for (
      const targetChatId of allChatIds
    ) {
      try {
        await sendMessage(
          targetChatId,
          `🔔 **NEW ROUND NOTICE / የአዲስ ዙር ማስታወቂያ**\n\n${noticeContent}\n\n👉 /numbers`,
        );

        count++;
      } catch (e) {
        logger.error(
          `Failed to send new round notice to ${targetChatId}`,
        );
      }
    }

    await sendMessage(
      chatId,
      `📢 **New round notice delivered to ${count} users!**`,
    );

    return;
  }

  /* =======================================================
     ADMIN: /broadcast
  ======================================================= */

  if (
    cmd === "/broadcast"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
      );
      return;
    }

    const broadcastMsg =
      text
        .replace(
          /^\/broadcast\s*/i,
          "",
        )
        .trim();

    if (!broadcastMsg) {
      await sendMessage(
        chatId,
        "❌ Please include a message.\n\nExample:\n`/broadcast Hello everyone!`",
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
        await sendMessage(
          targetChatId,
          `📢 **ANNOUNCEMENT / ማስታወቂያ**\n\n${broadcastMsg}`,
        );

        sentCount++;
      } catch (e) {
        logger.error(
          `Broadcast failed for ${targetChatId}`,
        );
      }
    }

    await sendMessage(
      chatId,
      `✅ **Broadcast sent to ${sentCount} users!**`,
    );

    return;
  }

  /* =======================================================
     ADMIN: /resetlotto
  ======================================================= */

  if (
    cmd === "/resetlotto"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
      );
      return;
    }

    await db.delete(
      lotteryEntriesTable,
    );

    await sendMessage(
      chatId,
      "🔄 **Lottery round reset!**\n\nAll current entries have been cleared.",
    );

    return;
  }

  /* =======================================================
     ADMIN: /user
  ======================================================= */

  if (
    cmd === "/user"
  ) {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        "⛔ **Access Denied.**",
      );
      return;
    }

    const parts =
      text.split(/\s+/);

    const targetChatId =
      parts[1];

    if (!targetChatId) {
      await sendMessage(
        chatId,
        "⚠️ Usage: `/user <chat_id>`",
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
        `❌ No records found for Chat ID \`${targetChatId}\`.`,
      );
      return;
    }

    let userDetails =
      `👤 **USER DETAILS (${targetChatId})**\n\n`;

    for (
      const entry of userEntries
    ) {
      userDetails +=
        `• **Number #${entry.number}**\n` +
        `  Name: ${entry.customerName}\n` +
        `  Phone: ${entry.phone ?? "N/A"}\n` +
        `  Status: \`${entry.status}\`\n` +
        `  Payment: ${entry.paymentMethod ?? "N/A"}\n\n`;
    }

    await sendMessage(
      chatId,
      userDetails,
    );

    return;
  }

  /* =======================================================
     LANGUAGE: AMHARIC
  ======================================================= */

  if (
    text.includes("አማርኛ")
  ) {
    userLanguages.set(
      chatId,
      "am",
    );

    lang = "am";

    const savedPhone =
      await getUserPhone(chatId);

    if (
      !savedPhone &&
      !isAdmin(chatId)
    ) {
      await requestPhoneShare(
        chatId,
        "📍 **የግዴታ ደረጃ:**\n\nለመቀጠል እባክዎ ከታች ያለውን **📱 ስልክ ቁጥር አጋራ** ቁልፍ ይጫኑ።",
        "📱 ስልክ ቁጥር አጋራ",
      );
    } else {
      await sendMessage(
        chatId,
        "✅ **ቋንቋው ወደ አማርኛ ተቀይሯል።**\n\nቁጥር ለመምረጥ **/numbers** ይላኩ።",
      );
    }

    return;
  }

  /* =======================================================
     LANGUAGE: OROMOO
  ======================================================= */

  if (
    text.includes(
      "Afaan Oromoo",
    ) ||
    text.includes("Oromoo")
  ) {
    userLanguages.set(
      chatId,
      "om",
    );

    lang = "om";

    const savedPhone =
      await getUserPhone(chatId);

    if (
      !savedPhone &&
      !isAdmin(chatId)
    ) {
      await requestPhoneShare(
        chatId,
        "📍 **Sadarkaa Dirqamaa:**\n\nItti fufuuf maaloo button **📱 Lakkoofsa Bilbilaa Qooda** jedhu tuqaa.",
        "📱 Lakkoofsa Bilbilaa Qooda",
      );
    } else {
      await sendMessage(
        chatId,
        "✅ **Afaan gara Afaan Oromootti jijjiirameera.**\n\nLakkoofsa filachuuf **/numbers** ergaa.",
      );
    }

    return;
  }

  /* =======================================================
     LANGUAGE: ENGLISH
  ======================================================= */

  if (
    text.includes("English")
  ) {
    userLanguages.set(
      chatId,
      "en",
    );

    lang = "en";

    const savedPhone =
      await getUserPhone(chatId);

    if (
      !savedPhone &&
      !isAdmin(chatId)
    ) {
      await requestPhoneShare(
        chatId,
        "📍 **Mandatory Step:**\n\nPlease tap **📱 Share Phone Number** below to complete registration.",
        "📱 Share Phone Number",
      );
    } else {
      await sendMessage(
        chatId,
        "✅ **Language set to English.**\n\nSend **/numbers** to pick a number.",
      );
    }

    return;
  }

  /* =======================================================
     PHONE REGISTRATION
  ======================================================= */

  const savedPhone =
    await getUserPhone(chatId);

  if (message.contact) {
    const phoneNumber =
      message.contact.phone_number;

    /**
     * Store in memory immediately.
     */
    userPhones.set(
      chatId,
      phoneNumber,
    );

    /**
     * If user already has an active
     * lottery entry, update it too.
     */
    await updateCustomerPhone(
      chatId,
      phoneNumber,
    );

    const confirmationMsg =
      lang === "am"
        ? `✅ **ስልክ ቁጥርዎ በትክክል ተመዝግቧል!**\n\nአሁን የሎተሪ አገልግሎቱን መጠቀም ይችላሉ።\n\nቁጥር ለመምረጥ **/numbers** ይላኩ።`
        : lang === "om"
          ? `✅ **Lakkoofsi bilbila keessan galmeeffameera!**\n\nAmma tajaajila lotorii fayyadamuu dandeessu.\n\nLakkoofsa filachuuf **/numbers** ergaa.`
          : `✅ **Phone number registered successfully!**\n\nYou can now use the lottery service.\n\nSend **/numbers** to pick a number.`;

    await sendMessage(
      chatId,
      confirmationMsg,
    );

    return;
  }

  /* =======================================================
     START / LANGUAGE
  ======================================================= */

  if (
    cmd === "/start" ||
    cmd === "/lang"
  ) {
    const langKeyboard = {
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

    const welcomeMsg =
      `🎁 **እንኳን ወደ ሎተሪ ቦት በደህና መጡ!**\n\n` +
      `**Welcome to the Lottery Bot!**\n` +
      `─────────────\n\n` +
      `✨ የፈለጉትን እድለኛ ቁጥር በመምረጥ አሸናፊ ይሁኑ!\n` +
      `✨ Select your lucky number and win!\n\n` +
      `👇 **ቋንቋ ይምረጡ / Please select your language:**`;

    await sendMessage(
      chatId,
      welcomeMsg,
      langKeyboard,
    );

    return;
  }

  /* =======================================================
     PHONE REQUIRED
  ======================================================= */

  if (
    !savedPhone &&
    !isAdmin(chatId)
  ) {
    await requestPhoneShare(
      chatId,
      lang === "am"
        ? "⚠️ **አገልግሎቱን ለመጠቀም መጀመሪያ ስልክ ቁጥርዎን ማጋራት አለብዎት!**"
        : lang === "om"
          ? "⚠️ **Tajaajila fayyadamuuf jalqaba lakkoofsa bilbilaa qooduu qabdu!**"
          : "⚠️ **Phone sharing is required to participate!**",
      lang === "am"
        ? "📱 ስልክ ቁጥር አጋራ"
        : lang === "om"
          ? "📱 Lakkoofsa Bilbilaa Qooda"
          : "📱 Share Phone Number",
    );

    return;
  }

  /* =======================================================
     PAYMENT SCREENSHOT
  ======================================================= */

  if (
    message.photo &&
    message.photo.length > 0
  ) {
    const entry =
      await findCustomerEntry(
        chatId,
      );

    if (!entry) {
      const msg =
        lang === "am"
          ? "❌ ንቁ ቦታ ማስያዝ አልተገኘም ወይም የ15 ደቂቃ ጊዜዎ አልፏል።\n\nመጀመሪያ /numbers ወይም /pick ቁጥር ይጠቀሙ።"
          : lang === "om"
            ? "❌ Qabsiisni active ta'e hin argamne ykn yeroon daqiiqaa 15 darbeera.\n\nJalqaba /numbers ykn /pick LAKKOOFSA fayyadamaa."
            : "❌ No active reservation found or it expired after 15 minutes.\n\nUse /numbers or /pick NUMBER first.";

      await sendMessage(
        chatId,
        msg,
      );

      return;
    }

    if (
      entry.status === "paid"
    ) {
      const msg =
        lang === "am"
          ? `ቁጥር #${entry.number} ክፍያው ተረጋግጧል።`
          : lang === "om"
            ? `Lakkoofsi #${entry.number} kaffaltiin mirkanaa'eera.`
            : `Number #${entry.number} is already paid.`;

      await sendMessage(
        chatId,
        msg,
      );

      return;
    }

    const photoId =
      message.photo[
        message.photo.length - 1
      ].file_id;

    await submitProof(
      entry.id,
      {
        paymentMethod:
          "telebirr",
        paymentReference:
          `Screenshot FileID: ${photoId}`,
        paymentProof:
          `Photo proof uploaded by ${chatId}`,
      },
    );

    /**
     * Send proof to every admin.
     */
    for (
      const adminId of ADMIN_CHAT_IDS
    ) {
      try {
        await telegramRequest(
          "sendPhoto",
          {
            chat_id: adminId,
            photo: photoId,
            caption:
              `📸 **NEW PAYMENT SCREENSHOT**\n\n` +
              `• **Number:** #${entry.number}\n` +
              `• **Customer:** ${entry.customerName}\n` +
              `• **Phone:** ${entry.phone ?? "N/A"}\n` +
              `• **Chat ID:** \`${chatId}\`\n\n` +
              `👉 **Approve:** \`/approve ${entry.number}\`\n` +
              `👉 **Reject:** \`/reject ${entry.number}\``,
            parse_mode:
              "Markdown",
          },
        );
      } catch (err) {
        logger.error(
          `Failed to forward proof to admin ${adminId}`,
        );
      }
    }

    const successMsg =
      lang === "am"
        ? `📸 **የክፍያ ደረሰኝ ስክሪንሾት ለቁጥር #${entry.number} ተቀብለናል!**\n\nአድሚኑ አረጋግጦ ያፀድቅልዎታል።`
        : lang === "om"
          ? `📸 **Nagaheen kaffaltii lakkoofsa #${entry.number} fudhatameera!**\n\nAdmin ni mirkaneessa.`
          : `📸 **Payment screenshot received for number #${entry.number}!**\n\nAn admin will verify it shortly.`;

    await sendMessage(
      chatId,
      successMsg,
    );

    return;
  }

  if (!text) {
    return;
  }

  /* =======================================================
     HELP
  ======================================================= */

  if (cmd === "/help") {
    const helpMsg =
      lang === "am"
        ? `**የሎተሪ መመሪያዎች:**\n\n• /numbers - ክፍት ቁጥሮችን ለማየት\n• /pick 42 - ቁጥር ለመምረጥ\n• /status - የያዙትን ቁጥር ለማየት\n• /lang - ቋንቋ ለመቀየር`
        : lang === "om"
          ? `**Qajeelfama Lotorii:**\n\n• /numbers - Lakkoofsa jiran ilaaluuf\n• /pick 42 - Lakkoofsa filachuuf\n• /status - Lakkoofsota qabdan ilaaluuf\n• /lang - Afaan jijjiiruuf`
          : `**Lottery Instructions:**\n\n• /numbers - View available numbers\n• /pick 42 - Choose a number\n• /status - View your numbers\n• /lang - Change language`;

    await sendMessage(
      chatId,
      helpMsg,
    );

    return;
  }

  /* =======================================================
     NUMBERS
  ======================================================= */

  if (
    cmd === "/numbers"
  ) {
    const available =
      await listNumbers(
        "available",
      );

    const summary =
      await getSummary();

    const ranges =
      availableRanges(
        available.map(
          (item) => item.number,
        ),
      );

    const msg =
      lang === "am"
        ? `🔢 **ዝግጁ የሆኑ ቁጥሮች:** ${summary.availableNumbers} / ${summary.totalNumbers}\n\n` +
          `${ranges.length ? ranges.join(", ") : "ምንም ክፍት ቁጥር የለም"}\n\n` +
          `ቁጥር ለመምረጥ: **/pick ቁጥር**`
        : lang === "om"
          ? `🔢 **Lakkoofsa jiran:** ${summary.availableNumbers} / ${summary.totalNumbers}\n\n` +
            `${ranges.length ? ranges.join(", ") : "Lakkoofsi banaa hin jiru"}\n\n` +
            `Lakkoofsa filachuuf: **/pick LAKKOOFSA**`
          : `🔢 **Available numbers:** ${summary.availableNumbers} / ${summary.totalNumbers}\n\n` +
            `${ranges.length ? ranges.join(", ") : "No numbers available"}\n\n` +
            `To pick: **/pick NUMBER**`;

    await sendMessage(
      chatId,
      msg,
    );

    return;
  }

  /* =======================================================
     STATUS
  ======================================================= */

  if (
    cmd === "/status" ||
    cmd === "/mynumbers"
  ) {
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
      const msg =
        lang === "am"
          ? "ምንም የያዙት ቁጥር የለም። /numbers ይጠቀሙ።"
          : lang === "om"
            ? "Lakkoofsa qabsiistan hin jiru. /numbers fayyadamaa."
            : "No active numbers found. Use /numbers.";

      await sendMessage(
        chatId,
        msg,
      );

      return;
    }

    const numberList =
      userEntries
        .map(
          (e) =>
            `• **Number #${e.number}**\n` +
            `  ${e.customerName}\n` +
            `  Status: \`${e.status}\``,
        )
        .join("\n\n");

    const statusMsg =
      lang === "am"
        ? `📋 **የያዟቸው ቁጥሮች (${userEntries.length}):**\n\n${numberList}`
        : lang === "om"
          ? `📋 **Lakkoofsota qabsiistanii (${userEntries.length}):**\n\n${numberList}`
          : `📋 **Your Numbers (${userEntries.length}):**\n\n${numberList}`;

    await sendMessage(
      chatId,
      statusMsg,
    );

    return;
  }

  /* =======================================================
     PICK NUMBER
  ======================================================= */

  const pickMatch =
    text.match(
      /^(?:\/pick\s+)?(\d{1,3})$/i,
    );

  if (pickMatch) {
    const number =
      Number(pickMatch[1]);

    const available =
      await listNumbers(
        "available",
      );

    if (
      !available.some(
        (item) =>
          item.number === number,
      )
    ) {
      const msg =
        lang === "am"
          ? `❌ ቁጥር #${number} ክፍት አይደለም።`
          : lang === "om"
            ? `❌ Lakkoofsi #${number} banaa miti.`
            : `❌ Number #${number} is not available.`;

      await sendMessage(
        chatId,
        msg,
      );

      return;
    }

    pendingSelections.set(
      chatId,
      number,
    );

    const askNameMsg =
      lang === "am"
        ? `ቁጥር #${number} ክፍት ነው።\n\nለማስያዝ **ሙሉ ስምዎን** ይላኩ።`
        : lang === "om"
          ? `Lakkoofsi #${number} banaadha.\n\nQabsiisuuf **Maqaa Guutuu** keessan ergaa.`
          : `Number #${number} is available.\n\nReply with your **Full Name** to reserve it.`;

    await sendMessage(
      chatId,
      askNameMsg,
    );

    return;
  }

  /* =======================================================
     NAME AFTER /PICK
  ======================================================= */

  const pendingNumber =
    pendingSelections.get(
      chatId,
    );

  if (
    pendingNumber !== undefined
  ) {
    /**
     * Prevent accidentally using a command
     * as a customer name.
     */
    if (text.startsWith("/")) {
      await sendMessage(
        chatId,
        lang === "am"
          ? "⚠️ እባክዎ ሙሉ ስምዎን ይላኩ።"
          : lang === "om"
            ? "⚠️ Maaloo maqaa guutuu keessan ergaa."
            : "⚠️ Please send your full name.",
      );

      return;
    }

    try {
      const reserved =
        await reserveNumber({
          number: pendingNumber,
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

      const paymentText =
        lang === "am"
          ? `✅ **ቁጥር #${reserved.number} በ ${reserved.customerName} ስም ተይዟል።**\n\n` +
            `⚠️ **ማሳሰቢያ:** በ **15 ደቂቃ** ውስጥ ክፍያ ፈፅመው ደረሰኝ ካልላኩ ቦታ ማስያዙ በራስ-ሰር ይሰረዛል።\n\n` +
            `💰 **200 ETB ይክፈሉ:**\n\n` +
            `📱 **Telebirr:**\n` +
            `• ቁጥር: \`0910778728\`\n` +
            `• ስም: Remedan Abdulbari Esmael\n\n` +
            `🏦 **CBE Bank:**\n` +
            `• ሂሳብ: \`1000724939779\`\n` +
            `• ስም: Remedan Abdulbari Esmael\n\n` +
            `ከከፈሉ በኋላ **የክፍያ ደረሰኝ ስክሪንሾት** ወደዚህ ቻት ይላኩ።`
          : lang === "om"
            ? `✅ **Lakkoofsi #${reserved.number} maqaa ${reserved.customerName} n qabameera.**\n\n` +
              `⚠️ **Akeekkachiisa:** Daqiiqaa **15** keessatti kaffaltii raawwattanii nagahee yoo hin ergin, qabsiisni ofumaan haqama.\n\n` +
              `💰 **200 ETB kaffalaa:**\n\n` +
              `📱 **Telebirr:**\n` +
              `• Lakkoofsa: \`0910778728\`\n` +
              `• Maqaa: Remedan Abdulbari Esmael\n\n` +
              `🏦 **CBE Bank:**\n` +
              `• Herrega: \`1000724939779\`\n` +
              `• Maqaa: Remedan Abdulbari Esmael\n\n` +
              `Erga kaffaltanii booda **screenshot nagahee** chat kanaaf ergaa.`
            : `✅ **Reserved number #${reserved.number} for ${reserved.customerName}.**\n\n` +
              `⚠️ **Notice:** You have **15 minutes** to pay and submit proof. Otherwise the reservation will be automatically cancelled.\n\n` +
              `💰 **Pay 200 ETB:**\n\n` +
              `📱 **Telebirr:**\n` +
              `• Number: \`0910778728\`\n` +
              `• Name: Remedan Abdulbari Esmael\n\n` +
              `🏦 **CBE Bank:**\n` +
              `• Account: \`1000724939779\`\n` +
              `• Name: Remedan Abdulbari Esmael\n\n` +
              `After payment, send the **payment screenshot** directly to this chat.`;

      await sendMessage(
        chatId,
        paymentText,
      );
    } catch (
      error: any
    ) {
      pendingSelections.delete(
        chatId,
      );

      await sendMessage(
        chatId,
        `❌ ${error?.message ?? "The number could not be reserved."}`,
      );
    }

    return;
  }

  /* =======================================================
     FALLBACK
  ======================================================= */

  await sendMessage(
    chatId,
    lang === "am"
      ? "ትእዛዙ አልተለየም። /help ይጠቀሙ።"
      : lang === "om"
        ? "Ajajni hin beekamne. /help fayyadamaa."
        : "Unrecognized command. Use /help.",
  );
}

/* =========================================================
   TELEGRAM UPDATE
========================================================= */

export async function handleTelegramUpdate(
  update: TelegramUpdate,
) {
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
      },
      "Telegram update failed",
    );
  }
}

/* =========================================================
   LONG POLLING
========================================================= */

async function poll() {
  let offset = 0;

  try {
    await telegramRequest(
      "deleteWebhook",
      {
        drop_pending_updates: false,
      },
    );
  } catch (error) {
    logger.error(
      {
        err: error,
      },
      "Telegram bot connection error",
    );

    return;
  }

  /**
   * Clean expired reservations
   * every 60 seconds.
   */
  setInterval(() => {
    cleanupExpiredReservations().catch(
      (e) =>
        logger.error(
          {
            err: e,
          },
          "Failed to auto-cleanup expired reservations",
        ),
    );
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
    } catch (
      error
    ) {
      logger.error(
        {
          err: error,
        },
        "Telegram polling failed",
      );

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

export function startTelegramBot() {
  if (
    started ||
    !process.env
      .TELEGRAM_BOT_TOKEN
  ) {
    return;
  }

  started = true;

  void setupAdminCommandScopes();

  void poll();
}

/**
 * Start bot process.
 */
startTelegramBot();