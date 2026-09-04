import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";

const VERSION_INTERVAL = "10 minutes";

/** PostgreSQL-backed app state plus R2-backed binary objects. */
export class PersistentStorage {
    private readonly databaseUrl = String(process.env.CANVAS_DATABASE_URL || process.env.DATABASE_URL || "").trim();
    private readonly bucket = String(process.env.CANVAS_R2_BUCKET || "").trim();
    private readonly accountId = String(process.env.CANVAS_R2_ACCOUNT_ID || process.env.META_MEDIA_R2_ACCOUNT_ID || "").trim();
    private readonly accessKeyId = String(process.env.CANVAS_R2_ACCESS_KEY_ID || process.env.META_MEDIA_R2_ACCESS_KEY_ID || "").trim();
    private readonly secretAccessKey = String(process.env.CANVAS_R2_SECRET_ACCESS_KEY || process.env.META_MEDIA_R2_SECRET_ACCESS_KEY || "").trim();
    private readonly pool = this.databaseUrl ? new Pool({ connectionString: this.databaseUrl, max: 4 }) : null;
    private readonly s3 = this.r2Configured
        ? new S3Client({
              region: "auto",
              endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
              credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
          })
        : null;
    private ready: Promise<void> | null = null;

    get stateConfigured() {
        return Boolean(this.pool);
    }

    get r2Configured() {
        return Boolean(this.bucket && this.accountId && this.accessKeyId && this.secretAccessKey);
    }

    status() {
        return { state: this.stateConfigured, objects: this.r2Configured, bucket: this.r2Configured ? this.bucket : undefined };
    }

    async getState(key: string) {
        await this.ensureState();
        const result = await this.pool!.query<{ value: string; revision: string; updated_at: Date }>("SELECT value, revision, updated_at FROM canvas_app_state WHERE storage_key = $1", [key]);
        const row = result.rows[0];
        return row ? { value: row.value, revision: Number(row.revision), updatedAt: row.updated_at.toISOString() } : null;
    }

    async putState(key: string, value: string) {
        await this.ensureState();
        const client = await this.pool!.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `INSERT INTO canvas_app_state_versions (storage_key, value, revision)
                 SELECT storage_key, value, revision FROM canvas_app_state current
                 WHERE storage_key = $1
                   AND NOT EXISTS (
                       SELECT 1 FROM canvas_app_state_versions history
                       WHERE history.storage_key = current.storage_key
                         AND history.created_at > NOW() - INTERVAL '${VERSION_INTERVAL}'
                   )`,
                [key],
            );
            const result = await client.query<{ revision: string; updated_at: Date }>(
                `INSERT INTO canvas_app_state (storage_key, value)
                 VALUES ($1, $2)
                 ON CONFLICT (storage_key) DO UPDATE
                 SET value = EXCLUDED.value, revision = canvas_app_state.revision + 1, updated_at = NOW()
                 RETURNING revision, updated_at`,
                [key, value],
            );
            await client.query("COMMIT");
            const row = result.rows[0];
            return { revision: Number(row.revision), updatedAt: row.updated_at.toISOString() };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async deleteState(key: string) {
        await this.ensureState();
        await this.pool!.query("DELETE FROM canvas_app_state WHERE storage_key = $1", [key]);
    }

    async putObject(key: string, data: Buffer, contentType: string) {
        this.ensureObjects();
        await this.s3!.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey(key), Body: data, ContentType: contentType || "application/octet-stream" }));
    }

    async getObject(key: string) {
        this.ensureObjects();
        try {
            const result = await this.s3!.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey(key) }));
            if (!result.Body) return null;
            return { data: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType || "application/octet-stream" };
        } catch (error) {
            const name = error instanceof Error ? error.name : "";
            if (name === "NoSuchKey" || name === "NotFound") return null;
            throw error;
        }
    }

    async deleteObject(key: string) {
        this.ensureObjects();
        await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey(key) }));
    }

    private async ensureState() {
        if (!this.pool) throw new StorageNotConfiguredError("PostgreSQL storage is not configured");
        this.ready ||= this.initializeState();
        await this.ready;
    }

    private async initializeState() {
        await this.pool!.query(`
            CREATE TABLE IF NOT EXISTS canvas_app_state (
                storage_key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                revision BIGINT NOT NULL DEFAULT 1,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS canvas_app_state_versions (
                id BIGSERIAL PRIMARY KEY,
                storage_key TEXT NOT NULL,
                value TEXT NOT NULL,
                revision BIGINT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS canvas_app_state_versions_lookup
                ON canvas_app_state_versions (storage_key, created_at DESC);
        `);
    }

    private ensureObjects() {
        if (!this.s3) throw new StorageNotConfiguredError("R2 object storage is not configured");
    }
}

export class StorageNotConfiguredError extends Error {
    readonly statusCode = 503;
}

function objectKey(key: string) {
    return `canvas-assets/${Buffer.from(key).toString("base64url")}`;
}
