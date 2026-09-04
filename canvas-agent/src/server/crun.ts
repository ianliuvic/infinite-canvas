import { readFile } from "node:fs/promises";

type CrunCapability = "image" | "video" | "audio";
type CrunCatalogModel = {
    model?: string;
    modality?: string;
    model_type?: string;
    operations?: string[];
    supports_reference?: boolean;
    supports_native_audio?: boolean;
};

type CrunGenerateInput = {
    model?: string;
    capability?: CrunCapability;
    prompt?: string;
    images?: string[];
    videos?: string[];
    audios?: string[];
    params?: Record<string, unknown>;
};

const CRUN_API_BASE = String(process.env.CRUN_API_BASE_URL || "https://api.crun.ai").replace(/\/+$/, "");
const CATALOG_PATH = String(process.env.CRUN_MODEL_CATALOG || "/opt/codex-worker/bundled-skills/crun-agent-skills/catalog/models.json");

const MODEL_SCRIPTS: Record<CrunCapability, string> = {
    image: `const result = await http.post("/generate", { model, capability: "image", prompt, images, params });
return result.media_urls || result.mediaUrls || [];`,
    video: `const toDataUrl = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return \`data:\${file.type || "application/octet-stream"};base64,\${btoa(binary)}\`;
};
const result = await http.post("/generate", { model, capability: "video", prompt, images, videos: await Promise.all(videos.map(toDataUrl)), audios: await Promise.all(audios.map(toDataUrl)), params });
return result.media_urls?.[0] || result.mediaUrls?.[0] || result.url;`,
    audio: `const result = await http.post("/generate", { model, capability: "audio", prompt, params });
return result.media_urls?.[0] || result.mediaUrls?.[0] || result.url;`,
};

export async function listCrunCanvasModels() {
    const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as { models?: CrunCatalogModel[] };
    return (catalog.models || []).flatMap((item) => {
        const name = String(item.model || "").trim();
        const capability = normalizeCapability(item.modality || item.model_type);
        if (!name || !capability) return [];
        return [{
            name,
            capability,
            script: MODEL_SCRIPTS[capability],
            operations: Array.isArray(item.operations) ? item.operations : [],
            supportsReference: Boolean(item.supports_reference),
            supportsNativeAudio: Boolean(item.supports_native_audio),
        }];
    });
}

export async function generateWithCrun(body: CrunGenerateInput) {
    const model = String(body.model || "").trim();
    const capability = normalizeCapability(body.capability);
    const prompt = String(body.prompt || "").trim();
    if (!model || !capability) throw new CrunHttpError(400, "Crun model and capability are required");
    if (!prompt) throw new CrunHttpError(400, "Prompt is required");

    const schemaResponse = await crunRequest("GET", `/api/v1/client/job/Models/${modelPath(model)}`);
    const schema = findInputSchema(schemaResponse);
    const references = [
        ...(body.images || []).map((value) => ({ value, kind: "image" })),
        ...(body.videos || []).map((value) => ({ value, kind: "video" })),
        ...(body.audios || []).map((value) => ({ value, kind: "audio" })),
    ];
    const uploaded = await Promise.all(references.map(async ({ value, kind }) => ({ kind, url: await ensureRemoteMedia(value) })));
    const input = buildModelInput(schema, { capability, prompt, params: body.params || {}, media: uploaded });

    const estimate = await crunRequest("POST", "/api/v1/client/job/EstimateTask", { model, input });
    if (estimate && typeof estimate === "object" && (estimate as Record<string, unknown>).affordable === false) {
        throw new CrunHttpError(402, "Crun credits are insufficient for this generation");
    }
    // CreateTask is deliberately called exactly once: retrying could create a duplicate charged task.
    const created = await crunRequest("POST", "/api/v1/client/job/CreateTask", { model, input }, false) as Record<string, unknown>;
    const taskId = String(created.task_id || "");
    if (!taskId) throw new CrunHttpError(502, "Crun did not return a task ID");
    const completed = await waitForTask(taskId);
    const result = completed.result && typeof completed.result === "object" ? completed.result as Record<string, unknown> : {};
    const mediaUrls = Array.isArray(result.media_urls) ? result.media_urls.filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
    if (!mediaUrls.length) throw new CrunHttpError(502, String(result.message || completed.message || "Crun completed without a media URL"));
    return { ok: true, task_id: taskId, status: "success", media_urls: mediaUrls, media_info: result.media_info || {} };
}

export async function describeCrunCanvasModel(model: string) {
    const name = model.trim();
    if (!name) throw new CrunHttpError(400, "Crun model is required");
    const response = await crunRequest("GET", `/api/v1/client/job/Models/${modelPath(name)}`);
    const schema = findInputSchema(response);
    if (!schema) throw new CrunHttpError(502, "Crun did not return an input schema for this model");
    return { ok: true, model: name, schema };
}

export class CrunHttpError extends Error {
    constructor(readonly status: number, message: string, readonly details?: unknown) {
        super(message);
        this.name = "CrunHttpError";
    }
}

function normalizeCapability(value: unknown): CrunCapability | null {
    const capability = String(value || "").toLowerCase();
    return capability === "image" || capability === "video" || capability === "audio" ? capability : null;
}

async function crunRequest(method: "GET" | "POST", path: string, body?: unknown, retry = true): Promise<unknown> {
    const apiKey = String(process.env.CRUN_API_KEY || "").trim();
    if (!apiKey) throw new CrunHttpError(503, "CRUN_API_KEY is not configured on the Canvas Agent server");
    const attempts = retry ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        let response: globalThis.Response;
        try {
            response = await fetch(`${CRUN_API_BASE}${path}`, {
                method,
                headers: { Accept: "application/json", "Content-Type": "application/json", "X-API-KEY": apiKey, "User-Agent": "infinite-canvas-crun/1" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(45_000),
            });
        } catch (error) {
            if (attempt + 1 < attempts) {
                await delay(500 * 2 ** attempt);
                continue;
            }
            throw new CrunHttpError(502, error instanceof Error ? error.message : "Crun network request failed");
        }
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.ok && Number(payload.code) === 200) return payload.data;
        if (attempt + 1 < attempts && [408, 429, 500, 502, 503, 504].includes(response.status)) {
            await delay(500 * 2 ** attempt);
            continue;
        }
        throw new CrunHttpError(response.status || 502, String(payload.message || `Crun request failed (${response.status})`), payload.data);
    }
    throw new CrunHttpError(502, "Crun request failed");
}

async function waitForTask(taskId: string) {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
        const task = await crunRequest("GET", `/api/v1/client/job/TaskInfo?task_id=${encodeURIComponent(taskId)}`) as Record<string, unknown>;
        const status = String(task.status || "").toLowerCase();
        if (status === "success") return task;
        if (status === "failed") {
            const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
            throw new CrunHttpError(502, String(result.message || task.message || "Crun generation failed"));
        }
        if (Date.now() >= deadline) throw new CrunHttpError(504, `Crun task ${taskId} is still running; retry status later`);
        await delay(2500);
    }
}

async function ensureRemoteMedia(value: string) {
    if (/^https?:\/\//i.test(value)) return value;
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (!match) throw new CrunHttpError(400, "Reference media must be an HTTP URL or base64 data URL");
    const contentType = match[1];
    const extension = mediaExtension(contentType);
    const upload = await crunRequest("GET", `/api/v1/client/files/upload-url?content_type=${encodeURIComponent(contentType)}&ext=${encodeURIComponent(extension)}`) as Record<string, unknown>;
    const presignedUrl = String(upload.presigned_url || "");
    const fileUrl = String(upload.file_url || "");
    if (!presignedUrl || !fileUrl) throw new CrunHttpError(502, "Crun did not return a media upload URL");
    const response = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: Buffer.from(match[2], "base64"), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new CrunHttpError(502, `Reference media upload failed (${response.status})`);
    return fileUrl;
}

function findInputSchema(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    for (const key of ["input_schema", "inputSchema", "schema", "parameters"]) {
        const candidate = record[key];
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).properties) return candidate as Record<string, unknown>;
    }
    if (record.properties && typeof record.properties === "object") return record;
    for (const child of Object.values(record)) {
        const found = findInputSchema(child);
        if (found) return found;
    }
    return null;
}

function buildModelInput(schema: Record<string, unknown> | null, source: { capability: CrunCapability; prompt: string; params: Record<string, unknown>; media: Array<{ kind: string; url: string }> }) {
    const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
    const accepts = (name: string) => !Object.keys(properties).length || Boolean(properties[name]);
    const input: Record<string, unknown> = {};
    setFirst(input, accepts, ["prompt", "text", "description"], source.prompt);

    const urls = (kind: string) => source.media.filter((item) => item.kind === kind).map((item) => item.url);
    setMedia(input, properties, accepts, ["images", "img_urls", "image_urls", "reference_images", "reference_image_urls"], ["image", "img_url", "image_url", "input_image", "reference_image"], urls("image"));
    setMedia(input, properties, accepts, ["videos", "video_list", "video_urls", "reference_videos"], ["video", "video_url", "input_video", "reference_video"], urls("video"));
    setMedia(input, properties, accepts, ["audios", "audio_urls", "reference_audios"], ["audio", "audio_url", "input_audio", "reference_audio"], urls("audio"));

    const size = String(source.params.size || "");
    const dimensions = parseDimensions(size);
    const explicitRatio = String(source.params.ratio || "");
    const ratio = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(explicitRatio)
        ? explicitRatio
        : /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(size)
          ? size
          : dimensions
            ? simplifyRatio(dimensions.width, dimensions.height)
            : "";
    const quality = String(source.params.quality || "").toLowerCase();
    const resolution = source.capability === "video"
        ? String(source.params.resolution || "")
        : dimensions
          ? dimensionsToResolution(dimensions.width, dimensions.height)
          : /^\d+k$/i.test(quality)
            ? quality.toUpperCase()
            : ({ low: "1K", medium: "2K", high: "4K" } as Record<string, string>)[quality] || String(source.params.resolution || "");
    setFirst(input, accepts, ["aspect_ratio", "aspectRatio", "ratio", "image_aspect_ratio"], enumCompatibleValue(properties, ["aspect_ratio", "aspectRatio", "ratio", "image_aspect_ratio"], ratio));
    setFirst(input, accepts, ["resolution", "image_size", "imageSize", "output_resolution"], enumCompatibleValue(properties, ["resolution", "image_size", "imageSize", "output_resolution"], resolution));
    if (dimensions && source.capability !== "video") {
        setFirst(input, accepts, ["width"], dimensions.width);
        setFirst(input, accepts, ["height"], dimensions.height);
        setFirst(input, accepts, ["size"], `${dimensions.width}x${dimensions.height}`);
    }
    setFirst(input, accepts, ["quality"], enumCompatibleValue(properties, ["quality"], quality === "auto" ? "" : quality));
    setFirst(input, accepts, ["duration", "seconds"], schemaCompatibleValue(properties, ["duration", "seconds"], source.params.seconds));
    setFirst(input, accepts, ["audio", "generate_audio", "with_audio"], source.params.generateAudio);
    setFirst(input, accepts, ["watermark", "add_watermark", "enable_watermark"], source.params.watermark);
    setFirst(input, accepts, ["mode"], enumCompatibleValue(properties, ["mode"], String(source.params.providerMode || "")));

    for (const [key, definition] of Object.entries(properties)) {
        if (input[key] !== undefined || definition.default === undefined) continue;
        input[key] = definition.default;
    }
    return input;
}

function setFirst(target: Record<string, unknown>, accepts: (name: string) => boolean, names: string[], value: unknown) {
    if (value === undefined || value === null || value === "") return;
    const name = names.find(accepts);
    if (name) target[name] = value;
}

function setMedia(target: Record<string, unknown>, properties: Record<string, Record<string, unknown>>, accepts: (name: string) => boolean, arrayNames: string[], scalarNames: string[], values: string[]) {
    if (!values.length) return;
    // Some Crun schemas omit `type: array` on plural media fields; the field name is
    // still authoritative and the API expects a list.
    const arrayName = arrayNames.find((name) => accepts(name));
    if (arrayName) target[arrayName] = values;
    else {
        const scalarName = scalarNames.find(accepts);
        if (scalarName) target[scalarName] = values[0];
    }
}

function parseDimensions(value: string) {
    const match = /^(\d+)x(\d+)$/i.exec(value);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : null;
}

function simplifyRatio(width: number, height: number) {
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function dimensionsToResolution(width: number, height: number) {
    const edge = Math.max(width, height);
    if (edge > 2048) return "4K";
    if (edge > 1024) return "2K";
    return "1K";
}

function greatestCommonDivisor(left: number, right: number): number {
    let a = Math.abs(Math.round(left));
    let b = Math.abs(Math.round(right));
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

function enumCompatibleValue(properties: Record<string, Record<string, unknown>>, names: string[], value: string) {
    if (!value) return undefined;
    const definition = names.map((name) => properties[name]).find(Boolean);
    const values = Array.isArray(definition?.enum) ? definition.enum.filter((item): item is string => typeof item === "string") : [];
    if (!values.length) return value;
    const exact = values.find((item) => item.toLowerCase() === value.toLowerCase());
    if (exact) return exact;
    if (/^\d+:\d+$/.test(value)) {
        const [width, height] = value.split(":").map(Number);
        const target = width / height;
        return values.filter((item) => /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(item)).reduce<string | undefined>((best, item) => {
            if (!best) return item;
            const score = (candidate: string) => {
                const [w, h] = candidate.split(":").map(Number);
                return Math.abs(w / h - target);
            };
            return score(item) < score(best) ? item : best;
        }, undefined);
    }
    return undefined;
}

function schemaCompatibleValue(properties: Record<string, Record<string, unknown>>, names: string[], value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    const definition = names.map((name) => properties[name]).find(Boolean);
    const enumValues = Array.isArray(definition?.enum) ? definition.enum.filter((item) => typeof item === "string" || typeof item === "number") as Array<string | number> : [];
    const numericValue = Number(value);
    if (enumValues.length) {
        const exact = enumValues.find((item) => String(item).toLowerCase() === String(value).toLowerCase());
        if (exact !== undefined) return exact;
        const numeric = enumValues.filter((item): item is number => typeof item === "number" || !Number.isNaN(Number(item))).map(Number);
        if (numeric.length && Number.isFinite(numericValue)) return numeric.reduce((best, item) => Math.abs(item - numericValue) < Math.abs(best - numericValue) ? item : best);
        return undefined;
    }
    if (Number.isFinite(numericValue)) {
        const minimum = Number(definition?.minimum ?? definition?.min);
        const maximum = Number(definition?.maximum ?? definition?.max);
        const clamped = Math.max(Number.isFinite(minimum) ? minimum : numericValue, Math.min(Number.isFinite(maximum) ? maximum : numericValue, numericValue));
        return Number.isInteger(numericValue) ? Math.round(clamped) : clamped;
    }
    return value;
}

function modelPath(model: string) {
    return model.split("/").map(encodeURIComponent).join("/");
}

function mediaExtension(contentType: string) {
    if (contentType === "image/jpeg") return ".jpg";
    if (contentType === "image/png") return ".png";
    if (contentType === "image/webp") return ".webp";
    if (contentType === "video/mp4") return ".mp4";
    if (contentType === "audio/mpeg") return ".mp3";
    if (contentType === "audio/wav") return ".wav";
    return ".bin";
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
