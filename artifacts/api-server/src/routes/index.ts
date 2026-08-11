import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lotteryRouter from "./lottery";
import adminRouter from "./admin";
import telegramRouter from "./telegram";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lotteryRouter);
router.use(adminRouter);
router.use(telegramRouter);

export default router;
