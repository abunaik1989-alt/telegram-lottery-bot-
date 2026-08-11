import { logger } from "./logger";
import {
  findCustomerEntry,
  getSummary,
  listNumbers,
  reserveNumber,
  submitProof,
} from "./lottery";

type TelegramPhoto = { file_id: string };

type TelegramMessage = {
  chat: { id: number | string };
  text?: string;
  photo?: TelegramPhoto[];
  from?: { username?: string; first_name?: string };
};

type TelegramUpdate = { update_id?: number; message?: TelegramMessage };

const pendingSelections = new Map<string, number>();
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

async function sendMessage(chatId: string, text: string) {
  await telegramRequest("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
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

async function handleMessage(message: TelegramMessage) {
  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";

  // --- 1. HANDLE PHOTO SCREENSHOTS AS PROOF ---
  if (message.photo && message.photo.length > 0) {
    const entry = await findCustomerEntry(chatId);
    if (!entry) {
      await sendMessage(chatId, "I could not find an active reservation for you. Use /numbers or /pick NUMBER first.");
      return;
    }
    if (entry.status === "paid") {
      await sendMessage(chatId, `Number #${entry.number} is already confirmed as paid.`);
      return;
    }

    const photoId = message.photo[message.photo.length - 1].file_id;
    await submitProof(entry.id, {
      paymentMethod: "telebirr",
      paymentReference: `Screenshot FileID: ${photoId}`,
      paymentProof: `Photo proof uploaded by ${chatId}`,
    });

    await sendMessage(
      chatId,
      `📸 Payment screenshot received for number #${entry.number}! An admin will verify it shortly.`,
    );
    return;
  }

  if (!text) return;

  // --- 2. COMMANDS & HELP ---
  if (text === "/start" || text === "/help") {
    await sendMessage(
      chatId,
      "Welcome to Lotto Service.\n\nUse /numbers to view available numbers.\nUse /pick 42 to choose a number.\nUse /status to check your reservation.\nUse /proof bank REFERENCE or send a screenshot photo after payment.\n\nEach number costs 200 ETB. Payment is verified manually.",
    );
    return;
  }

  if (text === "/numbers") {
    const available = await listNumbers("available");
    const summary = await getSummary();
    const ranges = availableRanges(available.map((item) => item.number));
    await sendMessage(
      chatId,
      `Available numbers: ${summary.availableNumbers} of ${summary.totalNumbers}\n\n${ranges.length ? ranges.join(", ") : "No numbers are currently available."}\n\nChoose one with /pick NUMBER.`,
    );
    return;
  }

  if (text === "/status") {
    const entry = await findCustomerEntry(chatId);
    if (!entry) {
      await sendMessage(chatId, "You do not have an active reservation yet. Use /numbers to begin.");
      return;
    }
    const label =
      entry.status === "paid"
        ? "Paid and confirmed"
        : entry.status === "proof_submitted"
          ? "Payment proof received; waiting for admin confirmation"
          : "Reserved; payment proof is still needed";
    await sendMessage(chatId, `Number #${entry.number}: ${label}`);
    return;
  }

  // --- 3. HANDLE TEXT PROOF (/proof bank ... or /proof telebirr ...) ---
  const proofMatch = text.match(/^\/proof\s+(bank|telebirr)\s+(.+)$/i);
  if (proofMatch) {
    const entry = await findCustomerEntry(chatId);
    if (!entry) {
      await sendMessage(chatId, "I could not find an active reservation. Use /pick NUMBER first.");
      return;
    }
    if (entry.status === "paid") {
      await sendMessage(chatId, `Number #${entry.number} is already confirmed as paid.`);
      return;
    }
    await submitProof(entry.id, {
      paymentMethod: proofMatch[1].toLowerCase() as "bank" | "telebirr",
      paymentReference: proofMatch[2].trim(),
      paymentProof: `Telegram proof submitted by ${chatId}`,
    });
    await sendMessage(
      chatId,
      `Payment proof received for number #${entry.number}. An admin will verify it and confirm your number.`,
    );
    return;
  }

  // --- 4. HANDLE NUMBER PICKING (/pick NUMBER) ---
  const pickMatch = text.match(/^(?:\/pick\s+)?(\d{1,3})$/);
  if (pickMatch) {
    const number = Number(pickMatch[1]);
    const available = await listNumbers("available");
    if (!available.some((item) => item.number === number)) {
      await sendMessage(chatId, `Number #${number} is not available. Use /numbers to see the current board.`);
      return;
    }
    pendingSelections.set(chatId, number);
    await sendMessage(chatId, `Number #${number} is available. Reply with your full name to reserve it.`);
    return;
  }

  // --- 5. HANDLE NAME SUBMISSION & SEND PAYMENT DETAILS ---
  const pendingNumber = pendingSelections.get(chatId);
  if (pendingNumber) {
    const reserved = await reserveNumber({
      number: pendingNumber,
      customerName: text,
      telegramUsername: message.from?.username ?? null,
      telegramChatId: chatId,
    });
    pendingSelections.delete(chatId);

    const paymentText = 
      `Reserved number #${reserved.number} for ${reserved.customerName}.\n\n` +
      `Pay 200 ETB via Telebirr or Bank:\n\n` +
      `📱 *Telebirr:*\n` +
      `• Number: \`0910778728\`\n` +
      `• Name: Remedan Abdulbari Esmael\n\n` +
      `🏦 *CBE Bank:*\n` +
      `• Account: \`1000724939779\`\n` +
      `• Name: Remedan Abdulbari Esmael\n\n` +
      `After paying, send your screenshot photo directly to this chat OR send:\n` +
      `/proof bank YOUR_REFERENCE\n` +
      `or\n` +
      `/proof telebirr YOUR_REFERENCE\n\n` +
      `Your number becomes confirmed after admin verification.`;

    await sendMessage(chatId, paymentText);
    return;
  }

  await sendMessage(chatId, "I did not recognize that command. Use /help to see the lottery instructions.");
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.message) {
    try {
      await handleMessage(update.message);
    } catch (error) {
      logger.error({ err: error }, "Telegram update failed");
      const chatId = update.message.chat?.id;
      if (chatId) {
        await sendMessage(String(chatId), "Something went wrong. Please try again or use /help.").catch(
          (sendError) => logger.error({ err: sendError }, "Telegram error response failed"),
        );
      }
    }
  }
}

async function poll() {
  let offset = 0;
  try {
    await telegramRequest("deleteWebhook", { drop_pending_updates: false });
    const bot = await telegramRequest<{ username?: string }>("getMe");
    logger.info({ bot: bot?.username }, "Telegram lottery bot connected");
  } catch (error) {
    logger.error({ err: error }, "Telegram bot could not connect");
    return;
  }

  while (true) {
    try {
      const updates =
        (await telegramRequest<TelegramUpdate[]>("getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message"],
        })) ?? [];
      for (const update of updates) {
        if (typeof update.update_id === "number") offset = update.update_id + 1;
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
  void poll();
}
