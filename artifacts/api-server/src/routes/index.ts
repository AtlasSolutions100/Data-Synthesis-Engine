import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import accountsRouter from "./accounts";
import customersRouter from "./customers";
import vendorsRouter from "./vendors";
import employeesRouter from "./employees";
import jobsRouter from "./jobs";
import transactionsRouter from "./transactions";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(accountsRouter);
router.use(customersRouter);
router.use(vendorsRouter);
router.use(employeesRouter);
router.use(jobsRouter);
router.use(transactionsRouter);
router.use(reportsRouter);

export default router;
