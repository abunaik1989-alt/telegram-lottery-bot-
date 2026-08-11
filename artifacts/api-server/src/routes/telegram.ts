import { Router, type IRouter } from "express";
import { HandleTelegramWebhookBody } from "@workspace/api-zod";
import { handleTelegramUpdate } from "../lib/telegram";

const router: IRouter = Router();

router.post("/telegram/webhook", async (req, res): Promise<void> => {
  const parsed = HandleTelegramWebhookBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Telegram update." });
    return;
  }
  await handleTelegramUpdate(parsed.data);
  res.json({ ok: true });
});

export default router;