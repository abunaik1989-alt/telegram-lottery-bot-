import { Router, type IRouter } from "express";
import {
  ApproveLotteryEntryParams,
  DrawLotteryWinnerResponse,
  GetLotterySummaryResponse,
  ListAdminLotteryEntriesQueryParams,
  ListAdminLotteryEntriesResponse,
  ListLotteryActivityResponse,
  RejectLotteryEntryParams,
  RejectLotteryEntryBody,
  RejectLotteryEntryResponse,
  ApproveLotteryEntryResponse,
} from "@workspace/api-zod";
import {
  allEntries,
  approveEntry,
  drawWinner,
  getSummary,
  recentActivity,
  rejectEntry,
} from "../lib/lottery";

const router: IRouter = Router();

function requireAdmin(req: Parameters<IRouter["get"]>[1] extends never ? never : any, res: any): boolean {
  const expected = process.env.LOTTO_ADMIN_KEY;
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (
    !expected ||
    (req.header("x-admin-key") !== expected && bearer !== expected)
  ) {
    res.status(401).json({ error: "Admin key required." });
    return false;
  }
  return true;
}

router.get("/admin/lottery/entries", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const parsed = ListAdminLotteryEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ListAdminLotteryEntriesResponse.parse(await allEntries(parsed.data.status)));
});

router.post("/admin/lottery/entries/:id/approve", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const parsed = ApproveLotteryEntryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(ApproveLotteryEntryResponse.parse(await approveEntry(parsed.data.id)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Approval failed" });
  }
});

router.post("/admin/lottery/entries/:id/reject", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const params = RejectLotteryEntryParams.safeParse(req.params);
  const body = RejectLotteryEntryBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid entry." });
    return;
  }
  try {
    res.json(RejectLotteryEntryResponse.parse(await rejectEntry(params.data.id)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Rejection failed" });
  }
});

router.post("/admin/lottery/draw", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(DrawLotteryWinnerResponse.parse(await drawWinner()));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Draw failed" });
  }
});

router.get("/admin/lottery/activity", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  res.json(ListLotteryActivityResponse.parse(await recentActivity()));
});

router.get("/admin/lottery/summary", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  res.json(GetLotterySummaryResponse.parse(await getSummary()));
});

export default router;