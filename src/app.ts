import "./express-augment";
import express, { Request, Response } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { pool } from "./db/pool";
import { swaggerSpec } from "./docs/swagger";
import { errorHandler } from "./middleware/errors";
import { appConfigRouter } from "./routes/appConfig.routes";
import { assetsRouter } from "./routes/assets.routes";
import { authRouter } from "./routes/auth.routes";
import { depotsRouter } from "./routes/depots.routes";
import { equipmentRouter } from "./routes/equipment.routes";
import { equipmentModelsRouter } from "./routes/equipmentModels.routes";
import { jobCardsRouter } from "./routes/jobCards.routes";
import { inspectionItemsRouter } from "./routes/inspectionItems.routes";
import { mediaRouter } from "./routes/media.routes";
import { signaturesRouter } from "./routes/signatures.routes";
import { meRouter } from "./routes/me.routes";
import { usersRouter } from "./routes/users.routes";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("Health check failed:", err);
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(authRouter);
app.use(meRouter);
app.use(usersRouter);
// Signed-URL downloads carry their credential in the path, not a header, so
// this router is mounted ahead of every router that applies requireAuth —
// requireAuth throws rather than calling next(), so a router guarding itself
// wholesale would reject this request before it ever got here.
app.use(assetsRouter);

// Both of these scope their own requireAuth to a path prefix, so the order
// between them carries no security meaning — but assetsRouter must stay ahead
// of both, for the reason its comment above gives.
app.use(depotsRouter);
app.use(jobCardsRouter);
app.use(mediaRouter);
app.use(signaturesRouter);
app.use(inspectionItemsRouter);
app.use(appConfigRouter);
app.use(equipmentModelsRouter);
app.use(equipmentRouter);

app.use(errorHandler);
