import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import leadsRoutes from "./routes/leads.js";
import conversationsRoutes from "./routes/conversations.js";
import billingRoutes from "./routes/billing.js";

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5500", // match wherever your HTML is served from
    credentials: true, // required so the httpOnly session cookie is sent/accepted
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/leads", leadsRoutes);
app.use("/conversations", conversationsRoutes);
app.use("/billing", billingRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GymBot QC API listening on :${PORT}`));
