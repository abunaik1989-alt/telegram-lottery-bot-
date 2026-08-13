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
import { db, lotteryEntriesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

type TelegramPhoto = { file_id: string };

type TelegramContact = {
  phone_number: string;
  first_name?: string;
  user_id?: number;
};

type TelegramMessage = {
  chat: { id: number | string };
  text?: string;
  photo?: TelegramPhoto[];
  contact?: TelegramContact;
  from?: { username?: string; first_name?: string };
};

type TelegramUpdate = { update_id?: number; message?: TelegramMessage };

// --- ADMIN AUTHORIZATION ---
const ADMIN_CHAT_IDS: string[] = [
  "806241233", // Your Telegram Chat ID
  process.env.ADMIN_CHAT_ID,
  process.env.ADMIN_ID,
].filter(Boolean).map((id) => String(id).trim());

function isAdmin(chatId: string | number): boolean {
  return ADMIN_CHAT_IDS.includes(String(chatId).trim());
}

const pendingSelections = new Map<string, number>();
const userLanguages = new Map<string, "am" | "om" | "en">();
// Cache user phone numbers in memory so users only share ONCE per server run/session
const userPhones = new Map<string, string>();
let started = false;

function apiUrl(method: string) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramRequest<T>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<T | null> {
  const response = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram API ${method} failed`);
  }
  return payload.result ?? null;
}

// Check if user has registered their phone number previously in DB or Memory
async function getUserPhone(chatId: string): Promise<string | null> {
  if (userPhones.has(chatId)) {
    return userPhones.get(chatId)!;
  }

  const [user] = await db
    .select({ phone: lotteryEntriesTable.phone })
    .from(lotteryEntriesTable)
    .where(and(eq(lotteryEntriesTable.telegramChatId, chatId)))
    .limit(1);

  if (user?.phone) {
    userPhones.set(chatId, user.phone);
    return user.phone;
  }

  return null;
}

// Get ALL unique chat IDs across history
async function getAllRegisteredChatIds(): Promise<string[]> {
  const entries = await db
    .select({ chatId: lotteryEntriesTable.telegramChatId })
    .from(lotteryEntriesTable);

  const dbChatIds = entries.map((e) => e.chatId);
  const memoryChatIds = Array.from(userPhones.keys());

  return Array.from(new Set([...dbChatIds, ...memoryChatIds]));
}

// --- HIDDEN ADMIN MENU SETUP ---
async function setupAdminCommandScopes() {
  for (const adminId of ADMIN_CHAT_IDS) {
    try {
      await telegramRequest("setMyCommands", {
        commands: [
          { command: "admin", description: "Open admin control panel" },
          { command: "pending", description: "View pending payment proofs" },
          { command: "approve", description: "Approve payment (e.g. /approve 28)" },
          { command: "reject", description: "Reject payment (e.g. /reject 28)" },
          { command: "drawlotto", description: "Perform random draw" },
          { command: "newround", description: "Announce new lottery round" },
          { command: "broadcast", description: "Broadcast message to all registered users" },
          { command: "resetlotto", description: "Reset active lottery round" },
          { command: "user", description: "Look up user info" },
        ],
        scope: { type: "chat", chat_id: adminId },
      });
      logger.info(`Admin commands scoped for chat ID: ${adminId}`);
    } catch (e) {
      logger.error(`Failed to scope commands for admin ${adminId}`);
    }
  }
}

async function sendMessage(
  chatId: string,
  text: string,
  replyMarkup: Record<string, unknown> | null = null,
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  } else {
    body.reply_markup = { remove_keyboard: true };
  }

  await telegramRequest("sendMessage", body);
}

function availableRanges(numbers: number[]) {
  const ranges: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const number of numbers) {
    if (start === undefined) {
      start = number;
    } else if (previous !== undefined && number !== previous + 1) {
      ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
      start = number;
    }
    previous = number;
  }
  if (start !== undefined && previous !== undefined) {
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  }
  return ranges;
}

export async function announceWinnerToAll(winner: {
  winnerNumber: number;
  customerName: string;
  participantChatIds: string[];
}) {
  const allChatIds = await getAllRegisteredChatIds();

  for (const chatId of allChatIds) {
    const lang = userLanguages.get(chatId) ?? "am";
    const announcementMsg =
      lang === "am"
        ? `🎉 **የሎተሪው ዕጣ ወጥቷል!** 🎉\n\n` +
          `🏆 **አሸናፊ ቁጥር:** #${winner.winnerNumber}\n` +
          `👤 **የአሸናፊው ስም:** ${winner.customerName}\n\n` +
          `🔄 **አዲስ ዙር ተጀምሯል!** ሁሉም የቆዩ ቁጥሮች ፀድተዋል። አሁኑኑ /numbers በማለት አዲስ ቁጥር ይምረጡ!`
        : lang === "om"
          ? `🎉 **Lottoriin carraa ba'eera!** 🎉\n\n` +
            `🏆 **Lakkoofsa Mo'ataa:** #${winner.winnerNumber}\n` +
            `👤 **Maqaa Mo'ataa:** ${winner.customerName}\n\n` +
            `🔄 **Marsaa haaraanti eagaleera!** Lakkoofsi duraa hundi haqameera. Amma /numbers fayyadamuun lakkoofsa haaraa filadhaa!`
          : `🎉 **LOTTERY DRAW COMPLETED!** 🎉\n\n` +
            `🏆 **Winning Number:** #${winner.winnerNumber}\n` +
            `👤 **Winner Name:** ${winner.customerName}\n\n` +
            `🔄 **A new round has started!** All previous numbers are cleared. Send /numbers to pick a new number!`;

    try {
      await sendMessage(chatId, announcementMsg);
    } catch (e) {
      logger.error(`Failed to notify chat ${chatId}`);
    }
  }
}

async function handleMessage(message: TelegramMessage) {
  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";
  const lang = userLanguages.get(chatId) ?? "am";

  const cmd = text.split(" ")[0].toLowerCase();

  // ==========================================
  // 👑 ADMIN COMMANDS SECTION
  // ==========================================

  // --- ADMIN DASHBOARD MENU ---
  if (cmd === "/admin" || cmd === "admin") {
    if (!isAdmin(chatId)) {
      await sendMessage(
        chatId,
        `⛔ **Access Denied:** You are not an admin.\nYour Chat ID: \`${chatId}\``,
      );
      return;
    }

    const summary = await getSummary();
    const adminMsg =
      `🛠 **ADMIN CONTROL PANEL**\n` +
      `─────────────\n` +
      `📊 **Summary:**\n` +
      `• Total Numbers: \`${summary.totalNumbers}\`\n` +
      `• Available: \`${summary.availableNumbers}\`\n` +
      `• Paid Entries: \`${summary.paidNumbers}\`\n` +
      `• Pending Approval: \`${summary.proofPending}\`\n` +
      `• Active Reserved: \`${summary.reservedNumbers}\`\n` +
      `• Total Revenue: \`${summary.totalCollected} ${summary.currency}\`\n\n` +
      `⚡ **Admin Commands:**\n` +
      `• /pending - View pending payment screenshots\n` +
      `• /approve <number> - Approve payment (e.g. \`/approve 28\`)\n` +
      `• /reject <number> - Reject payment & release number (e.g. \`/reject 28\`)\n` +
      `• /drawlotto - Draw winner and notify everyone\n` +
      `• /newround <msg> - Announce a new round notice to ALL users\n` +
      `• /broadcast <msg> - Broadcast text to all registered users\n` +
      `• /resetlotto - Clear entries for a fresh round\n` +
      `• /user <chat_id> - View user numbers & info`;

    await sendMessage(chatId, adminMsg);
    return;
  }

  // --- ADMIN: VIEW PENDING PAYMENTS ---
  if (cmd === "/pending") {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    const pendingEntries = await db
      .select()
      .from(lotteryEntriesTable)
      .where(eq(lotteryEntriesTable.status, "proof_submitted"));

    if (pendingEntries.length === 0) {
      await sendMessage(chatId, "✅ **No pending payment proofs to review.**");
      return;
    }

    let pendingListMsg = `⏳ **PENDING PAYMENTS (${pendingEntries.length}):**\n\n`;
    for (const entry of pendingEntries) {
      pendingListMsg +=
        `🔹 **Number #${entry.number}**\n` +
        `• Name: ${entry.customerName}\n` +
        `• Phone: ${entry.phone ?? "N/A"}\n` +
        `• Chat ID: \`${entry.telegramChatId}\`\n` +
        `• Proof Info: ${entry.paymentReference}\n` +
        `👉 Action: Send \`/approve ${entry.number}\` or \`/reject ${entry.number}\`\n\n`;
    }

    await sendMessage(chatId, pendingListMsg);
    return;
  }

  // --- ADMIN: APPROVE ENTRY ---
  if (cmd.startsWith("/approve")) {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    const parts = text.split(" ");
    const numberToApprove = Number(parts[1]);

    if (isNaN(numberToApprove)) {
      await sendMessage(chatId, "⚠️ Usage: `/approve <number>` (e.g. `/approve 4`)");
      return;
    }

    const [entry] = await db
      .select()
      .from(lotteryEntriesTable)
      .where(
        and(
          eq(lotteryEntriesTable.number, numberToApprove),
          eq(lotteryEntriesTable.status, "proof_submitted"),
        ),
      );

    if (!entry) {
      await sendMessage(
        chatId,
        `❌ No pending proof found for number #${numberToApprove}.`,
      );
      return;
    }

    await approveEntry(entry.id);
    await sendMessage(
      chatId,
      `✅ **Number #${numberToApprove} approved successfully!**`,
    );

    const userLang = userLanguages.get(entry.telegramChatId) ?? "am";
    const customerMsg =
      userLang === "am"
        ? `🎉 **ክፍያዎ ጸድቋል!** ቁጥር #${entry.number} ሙሉ በሙሉ የእርስዎ ሆኗል። መልካም እድል!`
        : userLang === "om"
          ? `🎉 **Kaffaltiin keessan mirkanaa'eera!** Lakkoofsi #${entry.number} kan keessan ta'eera. Carraa gaarii!`
          : `🎉 **Payment Approved!** Number #${entry.number} is officially yours. Good luck!`;

    try {
      await sendMessage(entry.telegramChatId, customerMsg);
    } catch (e) {
      logger.error(`Failed to notify customer chat ${entry.telegramChatId}`);
    }
    return;
  }

  // --- ADMIN: REJECT ENTRY ---
  if (cmd.startsWith("/reject")) {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    const parts = text.split(" ");
    const numberToReject = Number(parts[1]);

    if (isNaN(numberToReject)) {
      await sendMessage(chatId, "⚠️ Usage: `/reject <number>` (e.g. `/reject 4`)");
      return;
    }

    const [entry] = await db
      .select()
      .from(lotteryEntriesTable)
      .where(
        and(
          eq(lotteryEntriesTable.number, numberToReject),
          inArray(lotteryEntriesTable.status, [
            "reserved",
            "proof_submitted",
          ]),
        ),
      );

    if (!entry) {
      await sendMessage(
        chatId,
        `❌ Active reservation/proof not found for number #${numberToReject}.`,
      );
      return;
    }

    await rejectEntry(entry.id);
    await sendMessage(
      chatId,
      `🚫 **Number #${numberToReject} rejected and released.**`,
    );

    const userLang = userLanguages.get(entry.telegramChatId) ?? "am";
    const customerMsg =
      userLang === "am"
        ? `❌ **የክፍያ ደረሰኝዎ ውድቅ ተደርጓል!** ቁጥር #${entry.number} ክፍት ተደርጓል። እባክዎ እንደገና ይሞክሩ።`
        : userLang === "om"
          ? `❌ **Kaffaltiin keessan kufaa ta'eera!** Lakkoofsi #${entry.number} banaa ta'eera. Maaloo ammas yaalaa.`
          : `❌ **Payment rejected.** Reservation for number #${entry.number} has been released. Please try again.`;

    try {
      await sendMessage(entry.telegramChatId, customerMsg);
    } catch (e) {
      logger.error(`Failed to notify customer chat ${entry.telegramChatId}`);
    }
    return;
  }

  // --- ADMIN: MANUAL DRAW TRIGGER ---
  if (cmd === "/drawlotto") {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    try {
      const winner = await executeDrawWinner();
      await announceWinnerToAll(winner);
      await sendMessage(
        chatId,
        `✅ **Draw executed successfully!** Winner Number #${winner.winnerNumber} (${winner.customerName}) announced to all users.`,
      );
    } catch (err: any) {
      await sendMessage(chatId, `❌ Error performing draw: ${err.message}`);
    }
    return;
  }

  // --- ADMIN: ANNOUNCE NEW LOTTERY ROUND NOTICE ---
  if (cmd.startsWith("/newround") || cmd.startsWith("/roundnotice")) {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    const roundMsg = text.replace(/^\/(newround|roundnotice)\s*/i, "").trim();
    const noticeContent = roundMsg || "🚀 **አዲስ የሎተሪ ዙር ተጀምሯል!**\nአሁኑኑ /numbers በማለት ዕድልዎን ይሞክሩ።";

    const allChatIds = await getAllRegisteredChatIds();
    let count = 0;

    for (const targetChatId of allChatIds) {
      try {
        await sendMessage(
          targetChatId,
          `🔔 **የአዲስ ዙር ማስታወቂያ / NEW ROUND NOTICE**\n\n${noticeContent}\n\n👉 /numbers - ቁጥሮችን ይመልከቱ`,
        );
        count++;
      } catch (e) {
        // Ignored
      }
    }

    await sendMessage(chatId, `📢 **New round notice delivered to ${count} users!**`);
    return;
  }

  // --- ADMIN: BROADCAST MESSAGE ---
  if (cmd.startsWith("/broadcast")) {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    const broadcastMsg = text.replace(/^\/broadcast\s*/i, "").trim();
    if (!broadcastMsg) {
      await sendMessage(
        chatId,
        "❌ Please include a message. Example: `/broadcast Hello everyone!`",
      );
      return;
    }

    const allChatIds = await getAllRegisteredChatIds();
    let sentCount = 0;

    for (const targetChatId of allChatIds) {
      try {
        await sendMessage(
          targetChatId,
          `📢 **ANNOUNCEMENT / ማስታወቂያ:**\n\n${broadcastMsg}`,
        );
        sentCount++;
      } catch (e) {
        // Ignored
      }
    }

    await sendMessage(chatId, `✅ **Broadcast sent to ${sentCount} users!**`);
    return;
  }

  // --- ADMIN: RESET LOTTERY ROUND ---
  if (cmd === "/resetlotto") {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    await db.delete(lotteryEntriesTable);
    await sendMessage(
      chatId,
      "🔄 **Lottery round reset!** All entries cleared for current round.",
    );
    return;
  }

  // --- ADMIN: LOOKUP USER INFO ---
  if (cmd.startsWith("/user")) {
    if (!isAdmin(chatId)) {
      await sendMessage(chatId, "⛔ **Access Denied:** You are not an admin.");
      return;
    }

    const parts = text.split(" ");
    const targetChatId = parts[1];

    if (!targetChatId) {
      await sendMessage(chatId, "⚠️ Usage: `/user <chat_id>` (e.g. `/user 806241233`)");
      return;
    }

    const userEntries = await db
      .select()
      .from(lotteryEntriesTable)
      .where(eq(lotteryEntriesTable.telegramChatId, targetChatId));

    if (userEntries.length === 0) {
      await sendMessage(
        chatId,
        `❌ No records found for Chat ID \`${targetChatId}\`.`,
      );
      return;
    }

    let userDetails = `👤 **USER DETAILS (` + targetChatId + `):**\n\n`;
    for (const entry of userEntries) {
      userDetails +=
        `• **Number #${entry.number}** | Status: \`${entry.status}\`\n` +
        `  Name: ${entry.customerName}\n` +
        `  Phone: ${entry.phone ?? "N/A"}\n\n`;
    }

    await sendMessage(chatId, userDetails);
    return;
  }

  // ==========================================
  // 👤 MANDATORY PHONE CHECK FOR REGULAR USERS
  // ==========================================

  const savedPhone = await getUserPhone(chatId);

  // Phone submission handler
  if (message.contact) {
    const phoneNumber = message.contact.phone_number;
    userPhones.set(chatId, phoneNumber);
    await updateCustomerPhone(chatId, phoneNumber);

    const confirmationMsg =
      lang === "am"
        ? `✅ **ስልክ ቁጥርዎ በውጤታማነት ተመዝግቧል (${phoneNumber})!**\n\nአሁን የሎተሪ አገልግሎቱን መጠቀም ይችላሉ። ቁጥር ለመምረጥ **/numbers** ይላኩ።`
        : lang === "om"
          ? `✅ **Lakkoofsi bilbila keessan galmeeffameera (${phoneNumber})!**\n\nAmma tajaajila fayyadamuu dandeessu. Lakkoofsa filachuuf **/numbers** ergaa.`
          : `✅ **Phone number registered successfully (${phoneNumber})!**\n\nYou can now use all lottery features. Send **/numbers** to pick a number.`;

    await sendMessage(chatId, confirmationMsg);
    return;
  }

  // Language selectors
  if (text === "🇪🇹 አማርኛ") {
    userLanguages.set(chatId, "am");
    if (!savedPhone && !isAdmin(chatId)) {
      await requestPhoneShare(
        chatId,
        "📍 **የግዴታ ደረጃ:** ለመቀጠል እባክዎ ከታች ያለውን **'📱 ስልክ ቁጥር አጋራ'** የሚለውን ቁልፍ ይጫኑ።",
        "📱 ስልክ ቁጥር አጋራ",
      );
      return;
    }
  } else if (text === "🇪🇹 Afaan Oromoo") {
    userLanguages.set(chatId, "om");
    if (!savedPhone && !isAdmin(chatId)) {
      await requestPhoneShare(
        chatId,
        "📍 **Sadarkaa Dirqamaa:** Itti fufuuf maaloo button **'📱 Lakkoofsa Bilbilaa Qooda'** jedhu tuqaa.",
        "📱 Lakkoofsa Bilbilaa Qooda",
      );
      return;
    }
  } else if (text === "🇬🇧 English") {
    userLanguages.set(chatId, "en");
    if (!savedPhone && !isAdmin(chatId)) {
      await requestPhoneShare(
        chatId,
        "📍 **Mandatory Step:** Please tap the **'📱 Share Phone Number'** button below to complete registration.",
        "📱 Share Phone Number",
      );
      return;
    }
  }

  // Welcome command
  if (cmd === "/start" || cmd === "/lang") {
    const langKeyboard = {
      keyboard: [
        [{ text: "🇪🇹 አማርኛ" }, { text: "🇪🇹 Afaan Oromoo" }],
        [{ text: "🇬🇧 English" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    };

    const welcomeMsg =
      `🎁 **እንኳን ወደ ህጋዊ የሎተሪ ቦት በደህና መጡ!**\n` +
      `**Welcome to the Official Lottery Bot!**\n` +
      `─────────────\n` +
      `✨ የፈለጉትን እድለኛ ቁጥር በመምረጥ አሸናፊ ይሁኑ!\n` +
      `✨ Select your lucky numbers and win big prizes!\n\n` +
      `👇 **እባክዎ መጀመሪያ ቋንቋ ይምረጡ / Please select your language:**`;

    await sendMessage(chatId, welcomeMsg, langKeyboard);
    return;
  }

  // 🛑 BYPASS PHONE LOCK FOR ADMINS: Only block regular users if no phone saved
  if (!savedPhone && !isAdmin(chatId)) {
    await requestPhoneShare(
      chatId,
      lang === "am"
        ? "⚠️ **አገልግሎቱን ለመጠቀም መጀመሪያ ስልክ ቁጥርዎን ማጋራት አለብዎት!**\n\nእባክዎ ከታች ያለውን **'📱 ስልክ ቁጥር አጋራ'** የሚለውን ቁልፍ ይጫኑ።"
        : lang === "om"
          ? "⚠️ **Tajaajila fayyadamuuf jalqaba lakkoofsa bilbilaa qooduu qabdu!**\n\nMaaloo button **'📱 Lakkoofsa Bilbilaa Qooda'** jedhu tuqaa."
          : "⚠️ **Phone sharing is mandatory to participate!**\n\nPlease tap the **'📱 Share Phone Number'** button below.",
      lang === "am"
        ? "📱 ስልክ ቁጥር አጋራ"
        : lang === "om"
          ? "📱 Lakkoofsa Bilbilaa Qooda"
          : "📱 Share Phone Number",
    );
    return;
  }

  // --- PHOTO SCREENSHOT PROOF HANDLER ---
  if (message.photo && message.photo.length > 0) {
    const entry = await findCustomerEntry(chatId);
    if (!entry) {
      const msg =
        lang === "am"
          ? "❌ ንቁ ቦታ ማስያዝ አልተገኘም ወይም የ 15 ደቂቃ ጊዘዎ አልፏል። እባክዎ መጀመሪያ /numbers ወይም /pick ቁጥር ይላኩ።"
          : lang === "om"
            ? "❌ Qabsiisni active ta'e hin argamne ykn yeroon daqiiqaa 15 darbeera. Maaloo jalqaba /numbers ykn /pick LAKKOOFSA ergaa."
            : "❌ No active reservation found or it expired after 15 minutes. Use /numbers or /pick NUMBER first.";
      await sendMessage(chatId, msg);
      return;
    }

    if (entry.status === "paid") {
      const msg =
        lang === "am"
          ? `ቁጥር #${entry.number} ክፍያው ተረጋግጧል።`
          : lang === "om"
            ? `Lakkoofsi #${entry.number} kaffaltiin mirkanaa'eera.`
            : `Number #${entry.number} is already paid.`;
      await sendMessage(chatId, msg);
      return;
    }

    const photoId = message.photo[message.photo.length - 1].file_id;

    await submitProof(entry.id, {
      paymentMethod: "telebirr",
      paymentReference: `Screenshot FileID: ${photoId}`,
      paymentProof: `Photo proof uploaded by ${chatId}`,
    });

    // Send proof to admins
    for (const adminId of ADMIN_CHAT_IDS) {
      try {
        await telegramRequest("sendPhoto", {
          chat_id: adminId,
          photo: photoId,
          caption:
            `📸 **NEW PAYMENT SCREENSHOT SUBMITTED**\n\n` +
            `• **Number:** #${entry.number}\n` +
            `• **Customer:** ${entry.customerName}\n` +
            `• **Phone:** ${entry.phone ?? "N/A"}\n` +
            `• **Chat ID:** \`${chatId}\`\n\n` +
            `👉 **Quick Action:**\n` +
            `Approve: \`/approve ${entry.number}\`\n` +
            `Reject: \`/reject ${entry.number}\``,
          parse_mode: "Markdown",
        });
      } catch (err) {
        logger.error(`Failed to forward proof photo to admin ${adminId}`);
      }
    }

    const successMsg =
      lang === "am"
        ? `📸 **የክፍያ ደረሰኝ ስክሪንሾት ለቁጥር #${entry.number} ተቀብለናል!** አድሚኑ አረጋግጦ ያፀድቅልዎታል።`
        : lang === "om"
          ? `📸 **Nagaheen kaffaltii lakkoofsa #${entry.number} f fudhatameera!** Admin sa'aatii gabaabaa keessatti ni mirkaneessa.`
          : `📸 **Payment screenshot received for number #${entry.number}!** An admin will verify it shortly.`;

    await sendMessage(chatId, successMsg);
    return;
  }

  if (!text) return;

  // Help command
  if (cmd === "/help") {
    const helpMsg =
      lang === "am"
        ? "**የሎተሪ መመሪያዎች:**\n\n• /numbers - ክፍት ቁጥሮችን ለመመልከት\n• /pick 42 - ቁጥር ለመምረጥ\n• /status - የያዟቸውን ሁሉንም ቁጥሮች ለማወቅ\n• /lang - ቋንቋ ለመቀየር"
        : lang === "om"
          ? "**Qajeelfama Lotorii:**\n\n• /numbers - Lakkoofsa jiru ilaaluuf\n• /pick 42 - Lakkoofsa filachuuf\n• /status - Lakkoofsota qabsiiftan hunda ilaaluuf\n• /lang - Afaan jijjiiruuf"
          : "**Lottery Instructions:**\n\n• /numbers - View available numbers\n• /pick 42 - Choose a number\n• /status - List all your reserved numbers\n• /lang - Change language";
    await sendMessage(chatId, helpMsg);
    return;
  }

  // /numbers command
  if (cmd === "/numbers") {
    const available = await listNumbers("available");
    const summary = await getSummary();
    const ranges = availableRanges(available.map((item) => item.number));

    const msg =
      lang === "am"
        ? `🔢 **ዝግጁ የሆኑ ቁጥሮች:** ${summary.availableNumbers} ከ ${summary.totalNumbers}\n\n${ranges.length ? ranges.join(", ") : "ምንም ክፍት ቁጥር የለም"}\n\nቁጥር ለመምረጥ: **/pick ቁጥር** ይላኩ።`
        : lang === "om"
          ? `🔢 **Lakkoofsa jiran:** ${summary.availableNumbers} ከ ${summary.totalNumbers}\n\n${ranges.length ? ranges.join(", ") : "Lakkoofsi banaa hin jiru"}\n\nLakkoofsa filachuuf: **/pick LAKKOOFSA** ergaa.`
          : `🔢 **Available numbers:** ${summary.availableNumbers} of ${summary.totalNumbers}\n\n${ranges.length ? ranges.join(", ") : "No numbers available"}\n\nTo pick: **/pick NUMBER**`;

    await sendMessage(chatId, msg);
    return;
  }

  // /status command
  if (cmd === "/status" || cmd === "/mynumbers") {
    const userEntries = await db
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
      );

    if (userEntries.length === 0) {
      const msg =
        lang === "am"
          ? "ምንም የያዙት ቁጥር የለም። መጀመሪያ /numbers ን ይጠቀሙ።"
          : lang === "om"
            ? "Lakkoofsa qabsiistan hin jiru. Jalqaba /numbers fayyadamaa."
            : "No active numbers found. Use /numbers to select numbers.";
      await sendMessage(chatId, msg);
      return;
    }

    const numberList = userEntries
      .map(
        (e) =>
          `• **Number #${e.number}** (${e.customerName || "No Name"}) - Status: \`${e.status}\``,
      )
      .join("\n");

    const statusMsg =
      lang === "am"
        ? `📋 **የያዟቸው ቁጥሮች ዝርዝር (${userEntries.length}):**\n\n${numberList}`
        : lang === "om"
          ? `📋 **Tarree lakkoofsa qabsiistanii (${userEntries.length}):**\n\n${numberList}`
          : `📋 **Your Reserved Numbers (${userEntries.length}):**\n\n${numberList}`;

    await sendMessage(chatId, statusMsg);
    return;
  }

  // Pick command
  const pickMatch = text.match(/^(?:\/pick\s+)?(\d{1,3})$/i);
  if (pickMatch) {
    const number = Number(pickMatch[1]);
    const available = await listNumbers("available");
    if (!available.some((item) => item.number === number)) {
      const msg =
        lang === "am"
          ? `❌ ቁጥር #${number} ክፍት አይደለም።`
          : lang === "om"
            ? `❌ Lakkoofsi #${number} banaa miti.`
            : `❌ Number #${number} is not available.`;
      await sendMessage(chatId, msg);
      return;
    }
    pendingSelections.set(chatId, number);

    const askNameMsg =
      lang === "am"
        ? `ቁጥር #${number} ክፍት ነው። ለማስያዝ **ሙሉ ስምዎን** ይላኩ።`
        : lang === "om"
          ? `Lakkoofsi #${number} banaadha. Qabsiisuuf **Maqaa Guutuu** keessan ergaa.`
          : `Number #${number} is available. Reply with your **Full Name** to reserve.`;

    await sendMessage(chatId, askNameMsg);
    return;
  }

  // Name submission & reservation
  const pendingNumber = pendingSelections.get(chatId);
  if (pendingNumber) {
    const reserved = await reserveNumber({
      number: pendingNumber,
      customerName: text,
      telegramUsername: message.from?.username ?? null,
      telegramChatId: chatId,
    });
    pendingSelections.delete(chatId);

    if (savedPhone) {
      await updateCustomerPhone(chatId, savedPhone);
    }

    const paymentText =
      lang === "am"
        ? `✅ **ቁጥር #${reserved.number} በ ${reserved.customerName} ስም ተይዟል።**\n\n` +
          `⚠️ **ማሳሰቢያ:** ቁጥሩን በያዙ በ **15 ደቂቃ** ውስጥ ክፍያ ፈፅመው ደረሰኝ ካልላኩ ቦታ ማስያዙ በራስ-ሰር ይሰረዛል!\n\n` +
          `💰 **እባክዎ 200 ETB በ Telebirr ወይም Bank ይክፈሉ:**\n\n` +
          `📱 **Telebirr:**\n• ቁጥር: \`0910778728\`\n• ስም: Remedan Abdulbari Esmael\n\n` +
          `🏦 **CBE Bank:**\n• ሂሳብ ቁጥር: \`1000724939779\`\n• ስም: Remedan Abdulbari Esmael\n\n` +
          `ከከፈሉ በኋላ **የክፍያ ደረሰኝ ስክሪንሾት (Photo)** ቀጥታ ወደዚህ ቻት ይላኩ።`
        : lang === "om"
          ? `✅ **Lakkoofsi #${reserved.number} maqaa ${reserved.customerName} n qabameera.**\n\n` +
            `⚠️ **Akeekkachiisa:** Daqiiqaa **15** keessatti kaffaltii raawwattanii nagahee yoo hin ergin, qabsiisni keessan ofumaan haqama!\n\n` +
            `💰 **Maaloo 200 ETB Telebirr ykn Baankiin kaffalaa:**\n\n` +
            `📱 **Telebirr:**\n• Lakkoofsa: \`0910778728\`\n• Maqaa: Remedan Abdulbari Esmael\n\n` +
            `🏦 **CBE Baankii:**\n• Lakk. Herregaa: \`1000724939779\`\n• Maqaa: Remedan Abdulbari Esmael\n\n` +
            `Kaffaltii erga raawwattanii booda **Nagahee (Screenshot photo)** kallattiin chat kanaaf ergaa.`
          : `✅ **Reserved number #${reserved.number} for ${reserved.customerName}.**\n\n` +
            `⚠️ **Notice:** You must deposit and submit proof within **15 minutes**, or your reservation will be automatically cancelled.\n\n` +
            `💰 **Please pay 200 ETB via Telebirr or Bank:**\n\n` +
            `📱 **Telebirr:**\n• Number: \`0910778728\`\n• Name: Remedan Abdulbari Esmael\n\n` +
            `🏦 **CBE Bank:**\n• Account: \`1000724939779\`\n• Name: Remedan Abdulbari Esmael\n\n` +
            `After paying, send payment **screenshot photo** directly to this chat.`;

    await sendMessage(chatId, paymentText);
    return;
  }

  await sendMessage(
    chatId,
    lang === "am"
      ? "ትእዛዙ አልተለየም። /help ን ይጠቀሙ።"
      : lang === "om"
        ? "Ajiajni hin beekamne. /help fayyadamaa."
        : "Unrecognized command. Use /help.",
  );
}

async function requestPhoneShare(
  chatId: string,
  text: string,
  buttonLabel: string,
) {
  const keyboard = {
    keyboard: [[{ text: buttonLabel, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  await sendMessage(chatId, text, keyboard);
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.message) {
    try {
      await handleMessage(update.message);
    } catch (error) {
      logger.error({ err: error }, "Telegram update failed");
    }
  }
}

async function poll() {
  let offset = 0;
  try {
    await telegramRequest("deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    logger.error({ err: error }, "Telegram bot connection error");
    return;
  }

  setInterval(() => {
    cleanupExpiredReservations().catch((e) =>
      logger.error({ err: e }, "Failed to auto-cleanup expired reservations"),
    );
  }, 60 * 1000);

  while (true) {
    try {
      const updates =
        (await telegramRequest<TelegramUpdate[]>("getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message"],
        })) ?? [];
      for (const update of updates) {
        if (typeof update.update_id === "number")
          offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram polling failed");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

export function startTelegramBot() {
  if (started || !process.env.TELEGRAM_BOT_TOKEN) return;
  started = true;
  void setupAdminCommandScopes();
  void poll();
}
