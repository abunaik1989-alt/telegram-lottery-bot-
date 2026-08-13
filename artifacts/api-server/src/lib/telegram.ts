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
type TelegramContact = { phone_number: string };
type TelegramMessage = {
  chat: { id: number | string };
  text?: string;
  photo?: TelegramPhoto[];
  contact?: TelegramContact;
  from?: { username?: string };
};
type TelegramUpdate = { update_id?: number; message?: TelegramMessage };

// --- ADMIN AUTHORIZATION ---
const ADMIN_CHAT_IDS: string[] = [
  "806241233",
  process.env.ADMIN_CHAT_ID,
  process.env.ADMIN_ID,
]
  .filter(Boolean)
  .map((id) => String(id).trim());

function isAdmin(chatId: string | number): boolean {
  return ADMIN_CHAT_IDS.includes(String(chatId).trim());
}

// In-Memory Caches
const pendingSelections = new Map<string, number>();
const userLanguages = new Map<string, "am" | "om" | "en">();
const userPhones = new Map<string, string>();
let started = false;

// --- TELEGRAM API HELPER ---
async function telegramRequest<T>(method: string, body: Record<string, unknown> = {}): Promise<T | null> {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !data.ok) throw new Error(data.description ?? `Telegram API ${method} failed`);
  return data.result ?? null;
}

async function sendMessage(chatId: string, text: string, replyMarkup: Record<string, unknown> | null = null) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: replyMarkup ?? { remove_keyboard: true },
  });
}

// --- DATABASE & CACHE HELPERS ---
async function getUserPhone(chatId: string): Promise<string | null> {
  if (userPhones.has(chatId)) return userPhones.get(chatId)!;

  const [user] = await db
    .select({ phone: lotteryEntriesTable.phone })
    .from(lotteryEntriesTable)
    .where(eq(lotteryEntriesTable.telegramChatId, chatId))
    .limit(1);

  if (user?.phone) {
    userPhones.set(chatId, user.phone);
    return user.phone;
  }
  return null;
}

async function getAllRegisteredChatIds(): Promise<string[]> {
  const entries = await db.select({ chatId: lotteryEntriesTable.telegramChatId }).from(lotteryEntriesTable);
  return Array.from(new Set([...entries.map((e) => e.chatId), ...userPhones.keys()]));
}

function availableRanges(numbers: number[]): string[] {
  const ranges: string[] = [];
  let start: number | undefined, prev: number | undefined;

  for (const num of numbers) {
    if (start === undefined) start = num;
    else if (prev !== undefined && num !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = num;
    }
    prev = num;
  }
  if (start !== undefined && prev !== undefined) {
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  }
  return ranges;
}

// --- MULTI-LANGUAGE HELPER ---
function getTranslation(chatId: string, key: "phone_prompt" | "phone_button" | "welcome" | "help") {
  const lang = userLanguages.get(chatId) ?? "am";
  const translations = {
    phone_prompt: {
      am: "⚠️ **አገልግሎቱን ለመጠቀም መጀመሪያ ስልክ ቁጥርዎን ማጋራት አለብዎት!**\n\nእባክዎ ከታች ያለውን **'📱 ስልክ ቁጥር አጋራ'** የሚለውን ቁልፍ ይጫኑ።",
      om: "⚠️ **Tajaajila fayyadamuuf jalqaba lakkoofsa bilbilaa qooduu qabdu!**\n\nMaaloo button **'📱 Lakkoofsa Bilbilaa Qooda'** jedhu tuqaa.",
      en: "⚠️ **Phone sharing is mandatory to participate!**\n\nPlease tap the **'📱 Share Phone Number'** button below.",
    },
    phone_button: {
      am: "📱 ስልክ ቁጥር አጋራ",
      om: "📱 Lakkoofsa Bilbilaa Qooda",
      en: "📱 Share Phone Number",
    },
    help: {
      am: "**የሎተሪ መመሪያዎች:**\n\n• /numbers - ክፍት ቁጥሮችን ለመመልከት\n• /pick 42 - ቁጥር ለመምረጥ\n• /status - የያዟቸውን ቁጥሮች ለማወቅ\n• /lang - ቋንቋ ለመቀየር",
      om: "**Qajeelfama Lotorii:**\n\n• /numbers - Lakkoofsa jiru ilaaluuf\n• /pick 42 - Lakkoofsa filachuuf\n• /status - Lakkoofsota qabsiiftan hunda ilaaluuf\n• /lang - Afaan jijjiiruuf",
      en: "**Lottery Instructions:**\n\n• /numbers - View available numbers\n• /pick 42 - Choose a number\n• /status - List your reserved numbers\n• /lang - Change language",
    },
  };
  return translations[key]?.[lang] ?? translations[key]?.["am"];
}

async function requestPhoneShare(chatId: string) {
  const keyboard = {
    keyboard: [[{ text: getTranslation(chatId, "phone_button"), request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  await sendMessage(chatId, getTranslation(chatId, "phone_prompt"), keyboard);
}

// --- ADMIN COMMAND HANDLER ---
async function handleAdminCommands(chatId: string, cmd: string, text: string): Promise<boolean> {
  if (!isAdmin(chatId)) return false;

  if (cmd === "/admin") {
    const s = await getSummary();
    await sendMessage(
      chatId,
      `🛠 **ADMIN CONTROL PANEL**\n─────────────\n` +
        `• Total: \`${s.totalNumbers}\` | Available: \`${s.availableNumbers}\`\n` +
        `• Paid: \`${s.paidNumbers}\` | Pending: \`${s.proofPending}\`\n` +
        `• Revenue: \`${s.totalCollected} ${s.currency}\`\n\n` +
        `⚡ **Commands:**\n• /pending\n• /approve <num>\n• /reject <num>\n• /drawlotto\n• /broadcast <msg>\n• /resetlotto\n• /user <chat_id>`,
    );
    return true;
  }

  if (cmd === "/pending") {
    const list = await db.select().from(lotteryEntriesTable).where(eq(lotteryEntriesTable.status, "proof_submitted"));
    if (!list.length) {
      await sendMessage(chatId, "✅ **No pending payment proofs.**");
      return true;
    }
    let msg = `⏳ **PENDING PAYMENTS (${list.length}):**\n\n`;
    for (const e of list) {
      msg += `🔹 **#${e.number}** | ${e.customerName} (${e.phone ?? "N/A"})\nChat ID: \`${e.telegramChatId}\`\n👉 \`/approve ${e.number}\` | \`/reject ${e.number}\`\n\n`;
    }
    await sendMessage(chatId, msg);
    return true;
  }

  if (cmd.startsWith("/approve")) {
    const num = Number(text.split(" ")[1]);
    const [entry] = await db.select().from(lotteryEntriesTable).where(and(eq(lotteryEntriesTable.number, num), eq(lotteryEntriesTable.status, "proof_submitted")));
    if (!entry) return await sendMessage(chatId, `❌ No pending proof for #${num}.`), true;

    await approveEntry(entry.id);
    await sendMessage(chatId, `✅ **Number #${num} approved!**`);
    await sendMessage(entry.telegramChatId, `🎉 **Your payment for #${num} has been approved!** Good luck!`);
    return true;
  }

  if (cmd.startsWith("/reject")) {
    const num = Number(text.split(" ")[1]);
    const [entry] = await db.select().from(lotteryEntriesTable).where(and(eq(lotteryEntriesTable.number, num), inArray(lotteryEntriesTable.status, ["reserved", "proof_submitted"])));
    if (!entry) return await sendMessage(chatId, `❌ No active reservation/proof for #${num}.`), true;

    await rejectEntry(entry.id);
    await sendMessage(chatId, `🚫 **Number #${num} rejected & released.**`);
    await sendMessage(entry.telegramChatId, `❌ **Payment for #${num} was rejected.** Reservation released.`);
    return true;
  }

  if (cmd === "/drawlotto") {
    try {
      const winner = await executeDrawWinner();
      await announceWinnerToAll(winner);
      await sendMessage(chatId, `✅ **Draw Complete!** Winner: #${winner.winnerNumber} (${winner.customerName})`);
    } catch (e: any) {
      await sendMessage(chatId, `❌ Draw failed: ${e.message}`);
    }
    return true;
  }

  if (cmd.startsWith("/broadcast")) {
    const broadcastMsg = text.replace(/^\/broadcast\s*/i, "").trim();
    if (!broadcastMsg) return await sendMessage(chatId, "❌ Usage: `/broadcast <message>`"), true;

    const ids = await getAllRegisteredChatIds();
    let sent = 0;
    for (const id of ids) {
      try {
        await sendMessage(id, `📢 **ANNOUNCEMENT:**\n\n${broadcastMsg}`);
        sent++;
      } catch (e) {}
    }
    await sendMessage(chatId, `✅ **Broadcast delivered to ${sent} users.**`);
    return true;
  }

  if (cmd === "/resetlotto") {
    await db.delete(lotteryEntriesTable);
    await sendMessage(chatId, "🔄 **Lottery round reset!**");
    return true;
  }

  return false;
}

// --- MAIN MESSAGE DISPATCHER ---
async function handleMessage(message: TelegramMessage) {
  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";
  const cmd = text.split(" ")[0].toLowerCase();

  // 1. Check if Admin command
  if (cmd.startsWith("/") && (await handleAdminCommands(chatId, cmd, text))) {
    return;
  }

  // 2. Handle Contact/Phone Submission
  if (message.contact) {
    const phone = message.contact.phone_number;
    userPhones.set(chatId, phone);
    await updateCustomerPhone(chatId, phone);
    await sendMessage(chatId, `✅ **Phone registered (${phone})!**\n\nSend /numbers to select a number.`);
    return;
  }

  // 3. Language Selector
  if (text.includes("አማርኛ")) userLanguages.set(chatId, "am");
  else if (text.includes("Afaan Oromoo")) userLanguages.set(chatId, "om");
  else if (text.includes("English")) userLanguages.set(chatId, "en");

  // 4. Welcome / Language Command
  if (cmd === "/start" || cmd === "/lang") {
    const keyboard = {
      keyboard: [[{ text: "🇪🇹 አማርኛ" }, { text: "🇪🇹 Afaan Oromoo" }], [{ text: "🇬🇧 English" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
    await sendMessage(chatId, `🎁 **Welcome to the Official Lottery Bot!**\n\n👇 Select your language:`, keyboard);
    return;
  }

  // 5. Mandatory Phone Gate (Blocked for non-admins if phone is missing)
  const phone = await getUserPhone(chatId);
  if (!phone && !isAdmin(chatId)) {
    await requestPhoneShare(chatId);
    return;
  }

  // 6. Handle Payment Screenshot Proof Upload
  if (message.photo?.length) {
    const entry = await findCustomerEntry(chatId);
    if (!entry) return await sendMessage(chatId, "❌ No active reservation found. Send /numbers first.");

    const photoId = message.photo[message.photo.length - 1].file_id;
    await submitProof(entry.id, { paymentMethod: "telebirr", paymentReference: `Photo ID: ${photoId}`, paymentProof: photoId });

    for (const adminId of ADMIN_CHAT_IDS) {
      try {
        await telegramRequest("sendPhoto", {
          chat_id: adminId,
          photo: photoId,
          caption: `📸 **NEW PAYMENT SCREENSHOT**\n\n• **#${entry.number}** | ${entry.customerName}\n• Chat ID: \`${chatId}\`\n\n👉 \`/approve ${entry.number}\` | \`/reject ${entry.number}\``,
          parse_mode: "Markdown",
        });
      } catch (e) {}
    }

    await sendMessage(chatId, `📸 **Payment proof for #${entry.number} received!** Pending admin approval.`);
    return;
  }

  if (!text) return;

  // 7. General Commands
  if (cmd === "/help") return await sendMessage(chatId, getTranslation(chatId, "help"));

  if (cmd === "/numbers") {
    const available = await listNumbers("available");
    const summary = await getSummary();
    const ranges = availableRanges(available.map((i) => i.number));
    await sendMessage(chatId, `🔢 **Available:** ${summary.availableNumbers}/${summary.totalNumbers}\n\n${ranges.join(", ") || "None"}\n\nPick: **/pick NUMBER**`);
    return;
  }

  // 8. Number Selection & Reservation
  const pickMatch = text.match(/^(?:\/pick\s+)?(\d{1,3})$/i);
  if (pickMatch) {
    const num = Number(pickMatch[1]);
    const available = await listNumbers("available");
    if (!available.some((i) => i.number === num)) return await sendMessage(chatId, `❌ Number #${num} is not available.`);

    pendingSelections.set(chatId, num);
    await sendMessage(chatId, `Number #${num} is open! Reply with your **Full Name** to reserve.`);
    return;
  }

  const pendingNum = pendingSelections.get(chatId);
  if (pendingNum) {
    const res = await reserveNumber({ number: pendingNum, customerName: text, telegramUsername: message.from?.username ?? null, telegramChatId: chatId });
    pendingSelections.delete(chatId);
    if (phone) await updateCustomerPhone(chatId, phone);

    await sendMessage(
      chatId,
      `✅ **Reserved #${res.number} for ${res.customerName}**\n\n` +
        `⚠️ Pay within **15 minutes** or reservation expires!\n\n` +
        `📱 **Telebirr:** \`0910778728\` (Remedan Abdulbari)\n` +
        `🏦 **CBE Bank:** \`1000724939779\`\n\n` +
        `Send screenshot photo here after payment.`,
    );
    return;
  }

  await sendMessage(chatId, "Unrecognized command. Send /help.");
}

export async function announceWinnerToAll(winner: { winnerNumber: number; customerName: string }) {
  const ids = await getAllRegisteredChatIds();
  for (const id of ids) {
    try {
      await sendMessage(id, `🎉 **LOTTERY DRAW COMPLETED!**\n\n🏆 **Winner:** #${winner.winnerNumber} (${winner.customerName})\n\n🔄 A new round has started! Send /numbers to pick.`);
    } catch (e) {}
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.message) {
    try {
      await handleMessage(update.message);
    } catch (err) {
      logger.error({ err }, "Telegram update failed");
    }
  }
}

async function poll() {
  let offset = 0;
  try {
    await telegramRequest("deleteWebhook", { drop_pending_updates: false });
  } catch (e) {
    logger.error({ err: e }, "Webhook deletion failed");
  }

  setInterval(() => {
    cleanupExpiredReservations().catch((e) => logger.error({ err: e }, "Cleanup error"));
  }, 60 * 1000);

  while (true) {
    try {
      const updates = (await telegramRequest<TelegramUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] })) ?? [];
      for (const update of updates) {
        if (typeof update.update_id === "number") offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function startTelegramBot() {
  if (started || !process.env.TELEGRAM_BOT_TOKEN) return;
  started = true;
  void poll();
}
