import { Router } from "express";
import { logger } from "../lib/logger.js";
import {
  isAwsConfigured,
  getS3BucketName,
  getS3AccessPoint,
  s3Upload,
  s3Download,
  s3Delete,
  s3Exists,
  s3List,
  s3PresignedGetUrl,
  s3PresignedPutUrl,
  sesSendMail,
} from "../lib/awsClient.js";

const router = Router();

// ─── Status ───────────────────────────────────────────────────────────────────

router.get("/aws/status", (_req, res) => {
  const ap = getS3AccessPoint();
  res.json({
    configured:  isAwsConfigured(),
    region:      process.env.AWS_REGION ?? "us-east-1",
    bucket:      process.env.AWS_S3_BUCKET || null,
    accessPoint: ap || null,
    s3Target:    getS3BucketName() || null,
  });
});

// ─── S3: list objects ─────────────────────────────────────────────────────────

router.get("/aws/s3/list", async (req, res) => {
  const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
  const result = await s3List(prefix);
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }
  res.json({ keys: result.keys });
});

// ─── S3: check existence ──────────────────────────────────────────────────────

router.get("/aws/s3/exists", async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!key) { res.status(400).json({ error: "key required" }); return; }
  const exists = await s3Exists(key);
  res.json({ exists });
});

// ─── S3: upload (server-side, body forwarded) ─────────────────────────────────
// For large files prefer the presigned PUT URL approach instead.

router.post("/aws/s3/upload", async (req, res) => {
  const key         = typeof req.query.key === "string"         ? req.query.key         : "";
  const contentType = typeof req.query.contentType === "string" ? req.query.contentType : "application/octet-stream";
  const isPublic    = req.query.public === "true";

  if (!key) { res.status(400).json({ error: "key query param required" }); return; }

  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    const body   = Buffer.concat(chunks);
    const result = await s3Upload({ key, body, contentType, public: isPublic });
    if (!result.ok) { res.status(500).json({ error: result.error }); return; }
    res.json({ ok: true, key: result.key, url: result.url ?? null });
  });
  req.on("error", (err) => {
    logger.warn({ err }, "aws/s3/upload: request error");
    res.status(500).json({ error: "Request stream error" });
  });
});

// ─── S3: download (proxy through server) ─────────────────────────────────────

router.get("/aws/s3/download", async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!key) { res.status(400).json({ error: "key required" }); return; }

  const result = await s3Download(key);
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }

  res.setHeader("Content-Type", result.contentType ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
  res.send(result.data);
});

// ─── S3: delete ───────────────────────────────────────────────────────────────

router.delete("/aws/s3/delete", async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!key) { res.status(400).json({ error: "key required" }); return; }

  const result = await s3Delete(key);
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// ─── S3: presigned GET URL (temporary access to private object) ───────────────

router.get("/aws/s3/presign/get", async (req, res) => {
  const key     = typeof req.query.key === "string"     ? req.query.key     : "";
  const expires = typeof req.query.expires === "string" ? parseInt(req.query.expires) : 3600;
  if (!key) { res.status(400).json({ error: "key required" }); return; }

  const result = await s3PresignedGetUrl(key, expires);
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }
  res.json({ url: result.url });
});

// ─── S3: presigned PUT URL (direct browser → S3 upload, bypasses API server) ──

router.post("/aws/s3/presign/put", async (req, res) => {
  const { key, contentType, expires } = req.body as {
    key: string;
    contentType?: string;
    expires?: number;
  };
  if (!key) { res.status(400).json({ error: "key required" }); return; }

  const result = await s3PresignedPutUrl(
    key,
    contentType ?? "application/octet-stream",
    expires ?? 900,
  );
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }
  res.json({ url: result.url, key });
});

// ─── SES: send email ──────────────────────────────────────────────────────────

router.post("/aws/ses/send", async (req, res) => {
  const { from, to, subject, text, html } = req.body as {
    from: string;
    to: string | string[];
    subject: string;
    text: string;
    html?: string;
  };

  if (!from || !to || !subject || !text) {
    res.status(400).json({ error: "from, to, subject, text are required" });
    return;
  }

  const result = await sesSendMail({ from, to, subject, text, html });
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }
  res.json({ ok: true, messageId: result.messageId });
});

// ─── SES: test (send to self) ─────────────────────────────────────────────────

router.post("/aws/ses/test", async (req, res) => {
  const from = (req.body as any)?.from ?? "support@orahdex.org";
  const result = await sesSendMail({
    from,
    to:      from,
    subject: "OrahDEX — AWS SES connection test",
    text:    "This is an automated SES connection test from OrahDEX admin panel.",
  });
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }
  res.json({ ok: true, messageId: result.messageId });
});

export default router;
