import { Router, type IRouter } from "express";
import {
  CreateLotteryReservationBody,
  GetLotterySummaryResponse,
  ListLotteryNumbersQueryParams,
  ListLotteryNumbersResponse,
  SubmitPaymentProofBody,
  SubmitPaymentProofParams,
  SubmitPaymentProofResponse,
} from "@workspace/api-zod";
import {
  getSummary,
  listNumbers,
  reserveNumber,
  submitProof,
} from "../lib/lottery";

const router: IRouter = Router();

router.get("/lottery/summary", async (_req, res): Promise<void> => {
  res.json(GetLotterySummaryResponse.parse(await getSummary()));
});

router.get("/lottery/numbers", async (req, res): Promise<void> => {
  const parsed = ListLotteryNumbersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ListLotteryNumbersResponse.parse(await listNumbers(parsed.data.status)));
});

router.post("/lottery/reservations", async (req, res): Promise<void> => {
  const parsed = CreateLotteryReservationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.status(201).json(
      SubmitPaymentProofResponse.parse(await reserveNumber(parsed.data)),
    );
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Number unavailable" });
  }
});

router.post(
  "/lottery/reservations/:id/payment-proof",
  async (req, res): Promise<void> => {
    const params = SubmitPaymentProofParams.safeParse(req.params);
    const body = SubmitPaymentProofBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Invalid payment proof." });
      return;
    }
    try {
      res.json(SubmitPaymentProofResponse.parse(await submitProof(params.data.id, body.data)));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : "Reservation not found" });
    }
  },
);

export default router;