-- 0073: the Drive connection made in the app (Report freeze > Reconnect Drive). Add-only: one new table, nothing else changes.
-- One row at most (id is always 1). refreshTokenCiphertext is the Google refresh token encrypted with AES-256-GCM
-- (AiKeyCipher, key AI_SETTINGS_ENCRYPTION_KEY, bound to "drive_connection.refreshToken"), so a copied value does not
-- decrypt anywhere else. The plain token is never stored, logged or sent to the browser.
-- The freeze delivery and Check Drive use this token first and fall back to GOOGLE_DRIVE_REFRESH_TOKEN.
-- Merging to main applies this file to Production on deploy (the build runs prisma migrate deploy).
-- A single CREATE TABLE needs no SET LOCAL, so no explicit transaction (tests/MigrationTxnGuard.test.ts).
CREATE TABLE "drive_connection" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedBy" TEXT NOT NULL,
    CONSTRAINT "drive_connection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "drive_connection_single_row" CHECK ("id" = 1),
    CONSTRAINT "drive_connection_ciphertext_shape" CHECK ("refreshTokenCiphertext" LIKE 'v1:%' AND length("refreshTokenCiphertext") <= 4096),
    CONSTRAINT "drive_connection_connected_by" CHECK (length("connectedBy") BETWEEN 3 AND 320)
);
