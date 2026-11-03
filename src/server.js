import "dotenv/config";
// Must be imported before any routes are registered: it patches Express's
// router so an async handler that rejects (throws, or an awaited Prisma
// call that fails) is forwarded to the error-handling middleware below.
// Without this, Express 4 does NOT catch a rejected promise from a route
// handler — the request would simply hang with no response ever sent,
// masked only by the unhandledRejection console.error below.
import "express-async-errors";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import leadsRoutes from "./routes/leads.js";
import conversationsRoutes from "./routes/conversations.js";
import billingRoutes from "./routes/billing.js";
import subscriptionsRoutes from "./routes/subscriptions.js";
import gymSettingsRoutes from "./routes/gymSettings.js";
import gymPlatformConfigRoutes from "./routes/gymPlatformConfig.js";
import publicRoutes from "./routes/public.js";
import dashboardRoutes from "./routes/dashboard.js";
import { maintenanceGate } from "./middleware/maintenance.js";
import { csrfHeaderGate } from "./middleware/csrf.js";
 
// Fail fast rather than start in a half-configured, insecure state.
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set — refusing to start without it.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — refusing to start without it.");
}
 
const app = express();
 
// Pure JSON API, no browser-rendered HTML served from this process, so
// the CSP/script-src machinery Helmet ships for HTML pages doesn't apply
// here — disabled rather than left at defaults that do nothing useful.
// Every other Helmet header (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, HSTS, etc.) stays on.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
 
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
 
// Explicit, comma-separated allowlist — never a wildcard, since
// credentials:true means a reflected "*" would let any site ride a
// visitor's session cookie. FRONTEND_ORIGIN can hold one or more
// origins ("https://gymbot-qc.pages.dev,https://app.gymbotqc.com").
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5500")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
 
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = same-origin / server-to-server / curl — allow.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "x-gymbot-client"],
  })
);
 
// /health is exempt from maintenance mode so uptime checks (and the
// platform hosting this) can always tell the process itself is alive,
// even while GymBot QC is deliberately down for everyone else.
app.get("/health", (req, res) => res.json({ ok: true }));
 
app.use(maintenanceGate);
app.use(csrfHeaderGate);
 
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/leads", leadsRoutes);
app.use("/conversations", conversationsRoutes);
app.use("/billing", billingRoutes);
app.use("/subscriptions", subscriptionsRoutes);
app.use("/gym-settings", gymSettingsRoutes);
app.use("/gym-platform-config", gymPlatformConfigRoutes);
app.use("/public", publicRoutes);
app.use("/dashboard", dashboardRoutes);
 
app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});
 
// Central error handler. Thanks to the express-async-errors import at the
// top of this file, a rejected promise from any async route handler lands
// here too, not just synchronously-thrown errors. Never leaks a stack
// trace or raw error message to the client.
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  console.error("Unhandled route error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
});
 
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});
 
// Tests import `app` directly and bind their own ephemeral port.
if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`GymBot QC API listening on :${PORT}`));
}
 
export default app;