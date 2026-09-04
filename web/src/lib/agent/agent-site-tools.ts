import type { NavigateFunction } from "react-router-dom";

import i18n from "@/i18n";
import { fetchPrompts } from "@/services/api/prompts";
import { uploadImage } from "@/services/image-storage";
import { imageAspectOptions, imageQualityOptions, imageScaleOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions, videoSecondsRange, videoSizeOptions } from "@/components/video-settings-panel";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { buildEntityCanvasPlacement, entitySearchText } from "@/lib/canvas/entity-canvas";
import { clampVideoSeconds } from "@/lib/media-size";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type EntityAssetMember, type EntityAssetRole, type EntityKind } from "@/stores/use-asset-store";
import { modelOptionLabel, modelOptionName, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

// Execute site-level Agent tools in the browser, including canvas lists, workbench generation, prompt search, and asset operations.
// Their data lives locally in the browser through localforage and Zustand, so this module accesses the relevant stores directly.

export const SITE_TOOL_NAMES = [
    "canvas_list_projects",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "entities_search",
    "entities_get",
    "entities_add",
    "entities_update",
    "entities_place_on_canvas",
] as const;

export type SiteToolName = (typeof SITE_TOOL_NAMES)[number];

export function isSiteTool(name: string): name is SiteToolName {
    return (SITE_TOOL_NAMES as readonly string[]).includes(name);
}

function siteText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.siteTools.${key}`, options);
}

export const SITE_TOOL_LABELS: Record<SiteToolName, string> = {
    get canvas_list_projects() { return siteText("canvasList"); },
    get generation_get_status() { return siteText("generationStatus"); },
    get workbench_image_get_config() { return siteText("imageConfig"); },
    get workbench_image_generate() { return siteText("imageGenerate"); },
    get workbench_video_get_config() { return siteText("videoConfig"); },
    get workbench_video_generate() { return siteText("videoGenerate"); },
    get prompts_search() { return siteText("promptSearch"); },
    get assets_list() { return siteText("assetList"); },
    get assets_add() { return siteText("assetAdd"); },
    get entities_search() { return siteText("entitySearch"); },
    get entities_get() { return siteText("entityGet"); },
    get entities_add() { return siteText("entityAdd"); },
    get entities_update() { return i18n.language.startsWith("zh") ? "更新实体资产" : "Update entity asset"; },
    get entities_place_on_canvas() { return siteText("entityPlace"); },
};

type SiteToolInput = Record<string, unknown>;
type SiteToolContext = {
    canvasSnapshot?: CanvasAgentSnapshot | null;
    applyOps?: (ops: CanvasAgentOp[]) => CanvasAgentSnapshot;
    readAttachment?: (attachmentId: string) => Promise<Blob>;
};
type GenerationStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
type GenerationStatusItem = { id: string; source: "canvas" | "image" | "video"; status: GenerationStatus; kind?: string; title?: string; prompt?: string; projectId?: string; createdAt?: string; updatedAt?: string; successCount?: number; failCount?: number; error?: string };

export async function runSiteTool(name: SiteToolName, input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}): Promise<unknown> {
    switch (name) {
        case "canvas_list_projects":
            return listCanvasProjects(input);
        case "generation_get_status":
            return getGenerationStatus(input, context.canvasSnapshot);
        case "workbench_image_get_config":
            return getImageConfig();
        case "workbench_image_generate":
            return runImageWorkbench(input, navigate);
        case "workbench_video_get_config":
            return getVideoConfig();
        case "workbench_video_generate":
            return runVideoWorkbench(input, navigate);
        case "prompts_search":
            return searchPrompts(input);
        case "assets_list":
            return listAssets(input);
        case "assets_add":
            return addAsset(input);
        case "entities_search":
            return searchEntities(input);
        case "entities_get":
            return getEntity(input);
        case "entities_add":
            return addEntity(input, context);
        case "entities_update":
            return updateEntity(input, context);
        case "entities_place_on_canvas":
            return placeEntity(input, context);
        default:
            throw new Error(siteText("unknownTool", { name }));
    }
}

function getGenerationStatus(input: SiteToolInput, canvasSnapshot?: CanvasAgentSnapshot | null) {
    const scope = input.scope === "canvas" || input.scope === "image" || input.scope === "video" ? input.scope : "all";
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.filter((id): id is string => typeof id === "string") : []);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit)) || 20));
    const tasks: GenerationStatusItem[] = [];
    const includeCanvas = (scope === "all" || scope === "canvas") && (!taskId || nodeIds.size > 0);
    const includeWorkbench = !nodeIds.size || Boolean(taskId);

    if (includeCanvas && canvasSnapshot) {
        canvasSnapshot.nodes.forEach((node) => {
            const status = normalizeCanvasGenerationStatus(node.metadata?.status);
            if (!status || (nodeIds.size && !nodeIds.has(node.id))) return;
            const metadata = node.metadata || {};
            if (!nodeIds.size && node.type !== "config" && status !== "running" && status !== "failed" && !metadata.generationMode && !metadata.generationType && !metadata.model) return;
            tasks.push({ id: node.id, source: "canvas", status, kind: metadata.generationMode || node.type, title: node.title, prompt: compactPrompt(metadata.prompt || metadata.composerContent), projectId: canvasSnapshot.projectId, error: metadata.errorDetails });
        });
    }

    if (includeWorkbench) {
        useWorkbenchAgentStore.getState().tasks.forEach((task) => {
            if ((scope === "image" || scope === "video") && task.kind !== scope) return;
            if (scope === "canvas" || (taskId && task.id !== taskId)) return;
            tasks.push({ ...task, source: task.kind, prompt: compactPrompt(task.prompt) });
        });
    }

    tasks.sort((a, b) => generationStatusOrder(a.status) - generationStatusOrder(b.status) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const summary: Record<GenerationStatus, number> = { idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0 };
    tasks.forEach((task) => (summary[task.status] += 1));
    return { total: tasks.length, summary, tasks: tasks.slice(0, limit) };
}

function generationStatusOrder(status: GenerationStatus) {
    return status === "running" ? 0 : status === "queued" ? 1 : 2;
}

function normalizeCanvasGenerationStatus(status: unknown): GenerationStatus | null {
    if (status === "idle") return "idle";
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    return null;
}

function compactPrompt(prompt: unknown) {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    return value ? `${value.slice(0, 200)}${value.length > 200 ? "..." : ""}` : undefined;
}

function listCanvasProjects(input: SiteToolInput) {
    const { projects, hydrated } = useCanvasStore.getState();
    if (!hydrated) throw new Error(siteText("canvasLoading"));
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = keyword ? projects.filter((project) => project.title.toLowerCase().includes(keyword)) : projects;
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((project) => ({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
    }));
    return { total: filtered.length, page, pageSize, items, hint: siteText("canvasHint") };
}

function getImageConfig() {
    const { config } = useConfigStore.getState();
    const model = config.imageModel || config.model;
    return {
        current: { model, modelName: modelOptionName(model), quality: config.quality || "auto", size: config.size || "1:1", count: config.count || "1" },
        models: selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        qualityOptions: imageQualityOptions,
        scaleOptions: imageScaleOptions,
        sizeOptions: imageAspectOptions,
        countRange: { min: 1, max: 15 },
    };
}

function runImageWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("imageModel", value);
        applied.model = value;
    }
    if (typeof input.quality === "string" && input.quality.trim()) {
        configStore.updateConfig("quality", input.quality);
        applied.quality = input.quality;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.count != null) {
        const count = String(Math.max(1, Math.min(15, Math.floor(Number(input.count)) || 1)));
        configStore.updateConfig("count", count);
        applied.count = count;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/image");
    const taskId = useWorkbenchAgentStore.getState().dispatchImage({ prompt, run });
    return { ok: true, navigated: "/image", prompt, run, taskId, applied, note: siteText(run ? "imageGenerationStarted" : "imageConfigApplied") };
}

function getVideoConfig() {
    const { config } = useConfigStore.getState();
    const model = config.videoModel || config.model;
    return {
        current: {
            model,
            modelName: modelOptionName(model),
            size: config.size || "1280x720",
            seconds: config.videoSeconds || "6",
            resolution: config.vquality || "720",
            generateAudio: config.videoGenerateAudio !== "false",
            watermark: config.videoWatermark === "true",
            mode: config.videoMode === "reference" ? "reference" : "frames",
        },
        models: selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        sizeOptions: videoSizeOptions,
        secondsRange: videoSecondsRange,
        resolutionOptions: videoResolutionOptions,
        modeOptions: [
            { value: "frames", label: i18n.t("settingsPanels.video.modes.frames") },
            { value: "reference", label: i18n.t("settingsPanels.video.modes.reference") },
        ],
    };
}

function runVideoWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("videoModel", value);
        applied.model = value;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.seconds != null && String(input.seconds).trim()) {
        const seconds = clampVideoSeconds(String(input.seconds));
        configStore.updateConfig("videoSeconds", seconds);
        applied.seconds = seconds;
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
        configStore.updateConfig("vquality", input.resolution);
        applied.resolution = input.resolution;
    }
    if (typeof input.generateAudio === "boolean") {
        configStore.updateConfig("videoGenerateAudio", String(input.generateAudio));
        applied.generateAudio = input.generateAudio;
    }
    if (typeof input.watermark === "boolean") {
        configStore.updateConfig("videoWatermark", String(input.watermark));
        applied.watermark = input.watermark;
    }
    if (input.mode === "frames" || input.mode === "reference") {
        configStore.updateConfig("videoMode", input.mode);
        applied.mode = input.mode;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/video");
    const taskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt, run });
    return { ok: true, navigated: "/video", prompt, run, taskId, applied, note: siteText(run ? "videoGenerationStarted" : "videoConfigApplied") };
}

async function searchPrompts(input: SiteToolInput) {
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize)) || 20));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const result = await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || i18n.t("common.all")), tag: tags, page, pageSize });
    return {
        total: result.total,
        page,
        pageSize,
        categories: result.categories,
        tags: result.tags.slice(0, 60),
        items: result.items.map((prompt) => ({ id: prompt.id, title: prompt.title, prompt: prompt.prompt, category: prompt.category, tags: prompt.tags, coverUrl: prompt.coverUrl, githubUrl: prompt.githubUrl })),
    };
}

function listAssets(input: SiteToolInput) {
    const { assets, hydrated } = useAssetStore.getState();
    if (!hydrated) throw new Error(siteText("assetsLoading"));
    const kind = input.kind === "text" || input.kind === "image" || input.kind === "video" ? input.kind : "all";
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = assets.filter((asset) => {
        if (kind !== "all" && asset.kind !== kind) return false;
        if (!keyword) return true;
        return [asset.title, asset.note, asset.source, ...asset.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags,
        source: asset.source,
        note: asset.note,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        coverUrl: asset.coverUrl || undefined,
        content: asset.kind === "text" ? asset.data.content : undefined,
    }));
    return { total: filtered.length, page, pageSize, items };
}

function searchEntities(input: SiteToolInput) {
    const { entities, hydrated } = useAssetStore.getState();
    if (!hydrated) throw new Error(siteText("assetsLoading"));
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const kind = typeof input.kind === "string" ? input.kind : "all";
    const tags = new Set(Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : []);
    const filtered = entities.filter((entity) => (kind === "all" || entity.kind === kind) && (!tags.size || [...tags].every((tag) => entity.tags.includes(tag))) && (!keyword || entitySearchText(entity).includes(keyword)));
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    return { total: filtered.length, page, pageSize, items: filtered.slice(start, end).map(compactEntity) };
}

function getEntity(input: SiteToolInput) {
    const entity = findEntity(input);
    if (!entity) throw new Error(siteText("entityNotFound"));
    const assetById = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]));
    return {
        ...entity,
        members: entity.members.flatMap((member) => {
            const asset = assetById.get(member.assetId);
            return asset ? [{ ...member, title: asset.title, kind: asset.kind, tags: asset.tags, width: asset.kind === "text" ? undefined : asset.data.width, height: asset.kind === "text" ? undefined : asset.data.height }] : [];
        }),
    };
}

async function addEntity(input: SiteToolInput, context: SiteToolContext) {
    const name = String(input.name || "").trim();
    if (!name) throw new Error(siteText("entityNameRequired"));
    const store = useAssetStore.getState();
    const { members, importedAttachmentCount } = await collectEntityMembers(input, context, name, []);
    const id = store.addEntity({
        kind: entityKind(input.kind),
        name,
        aliases: stringArray(input.aliases),
        tags: stringArray(input.tags),
        summary: String(input.summary || ""),
        description: String(input.description || ""),
        prompt: String(input.prompt || ""),
        negativePrompt: String(input.negativePrompt || ""),
        usageRules: String(input.usageRules || ""),
        members,
    });
    return { ok: true, id, name, memberCount: members.length, importedAttachmentCount };
}

async function updateEntity(input: SiteToolInput, context: SiteToolContext) {
    const entity = findEntity(input);
    if (!entity) throw new Error(siteText("entityNotFound"));
    const baseMembers = input.replaceMembers === true ? [] : entity.members;
    const { members, importedAttachmentCount } = await collectEntityMembers(input, context, entity.name, baseMembers);
    const patch: Partial<Omit<typeof entity, "id" | "createdAt">> = { members };
    if (input.kind !== undefined) patch.kind = entityKind(input.kind);
    if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim();
    if (input.aliases !== undefined) patch.aliases = stringArray(input.aliases);
    if (input.tags !== undefined) patch.tags = stringArray(input.tags);
    if (typeof input.summary === "string") patch.summary = input.summary;
    if (typeof input.description === "string") patch.description = input.description;
    if (typeof input.prompt === "string") patch.prompt = input.prompt;
    if (typeof input.negativePrompt === "string") patch.negativePrompt = input.negativePrompt;
    if (typeof input.usageRules === "string") patch.usageRules = input.usageRules;
    useAssetStore.getState().updateEntity(entity.id, patch);
    return { ok: true, id: entity.id, name: patch.name || entity.name, memberCount: members.length, importedAttachmentCount, updated: true };
}

async function collectEntityMembers(input: SiteToolInput, context: SiteToolContext, entityName: string, initialMembers: EntityAssetMember[]) {
    const store = useAssetStore.getState();
    const validAssetIds = new Set(store.assets.map((asset) => asset.id));
    const members = [...initialMembers];
    if (Array.isArray(input.members)) {
        input.members.forEach((value) => {
            const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
            const assetId = String(item.assetId || "");
            if (!validAssetIds.has(assetId)) return;
            const member = { assetId, role: entityRole(item.role), ...(typeof item.note === "string" ? { note: item.note } : {}) };
            const existingIndex = members.findIndex((current) => current.assetId === assetId);
            if (existingIndex >= 0) members[existingIndex] = member;
            else members.push(member);
        });
    }
    const attachmentItems = Array.isArray(input.attachments) ? input.attachments : [];
    const seenAttachmentIds = new Set<string>();
    for (const [index, value] of attachmentItems.entries()) {
        const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const attachmentId = String(item.attachmentId || "").trim();
        if (!attachmentId || seenAttachmentIds.has(attachmentId)) continue;
        if (!context.readAttachment) throw new Error(siteText("attachmentImportUnavailable"));
        seenAttachmentIds.add(attachmentId);
        let image;
        try {
            image = await uploadImage(await context.readAttachment(attachmentId));
        } catch {
            throw new Error(siteText("attachmentImportFailed", { attachmentId }));
        }
        const role: EntityAssetRole = item.role ? entityRole(item.role) : members.length ? "reference" : "primary";
        const title = String(item.title || "").trim() || `${entityName} · ${role === "primary" ? siteText("primaryReference") : siteText("referenceImage")} ${index + 1}`;
        const assetId = store.addAsset({ kind: "image", title, coverUrl: image.url, tags: stringArray(input.tags), source: siteText("entityAttachmentSource"), note: typeof item.note === "string" ? item.note : undefined, data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
        members.push({ assetId, role, ...(typeof item.note === "string" ? { note: item.note } : {}) });
    }
    return { members, importedAttachmentCount: seenAttachmentIds.size };
}

function placeEntity(input: SiteToolInput, context: SiteToolContext) {
    const entity = findEntity(input);
    if (!entity) throw new Error(siteText("entityNotFound"));
    if (!context.canvasSnapshot || !context.applyOps) throw new Error(siteText("openCanvasFirst"));
    const placement = buildEntityCanvasPlacement(entity, useAssetStore.getState().assets, context.canvasSnapshot, { assetIds: stringArray(input.assetIds), maxReferences: Number(input.maxReferences) || undefined });
    context.applyOps(placement.ops);
    return { ok: true, entity: compactEntity(entity), groupId: placement.groupId, profileNodeId: placement.profileNodeId, referenceNodeIds: placement.referenceNodeIds, hint: siteText("entityPlaceHint") };
}

function findEntity(input: SiteToolInput) {
    const { entities } = useAssetStore.getState();
    const id = String(input.entityId || "");
    if (id) return entities.find((entity) => entity.id === id);
    const name = String(input.name || input.keyword || "").trim().toLowerCase();
    return entities.find((entity) => entity.name.toLowerCase() === name || entity.aliases.some((alias) => alias.toLowerCase() === name)) || entities.find((entity) => entitySearchText(entity).includes(name));
}

function compactEntity(entity: ReturnType<typeof useAssetStore.getState>["entities"][number]) {
    return { id: entity.id, kind: entity.kind, name: entity.name, aliases: entity.aliases, summary: entity.summary, tags: entity.tags, prompt: entity.prompt, negativePrompt: entity.negativePrompt, usageRules: entity.usageRules, memberCount: entity.members.length, updatedAt: entity.updatedAt };
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function entityKind(value: unknown): EntityKind {
    return value === "product" || value === "scene" || value === "style" || value === "brand" || value === "other" ? value : "person";
}

function entityRole(value: unknown): EntityAssetRole {
    return value === "primary" || value === "identity" || value === "fullBody" || value === "detail" || value === "expression" || value === "outfit" || value === "background" || value === "product" || value === "style" ? value : "reference";
}

async function addAsset(input: SiteToolInput) {
    const kind = input.kind;
    const title = String(input.title || "").trim();
    if (!title) throw new Error(siteText("assetTitleRequired"));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const source = typeof input.source === "string" ? input.source : "Agent";
    const note = typeof input.note === "string" ? input.note : undefined;
    const store = useAssetStore.getState();
    if (kind === "text") {
        const content = String(input.content || "").trim();
        if (!content) throw new Error(siteText("textContentRequired"));
        const id = store.addAsset({ kind: "text", title, coverUrl: "", tags, source, note, data: { content } });
        return { ok: true, id, kind: "text" };
    }
    if (kind === "image") {
        const imageUrl = String(input.imageUrl || "").trim();
        if (!imageUrl) throw new Error(siteText("imageUrlRequired"));
        let stored;
        try {
            stored = await uploadImage(imageUrl);
        } catch {
            throw new Error(siteText("imageReadFailed"));
        }
        const id = store.addAsset({ kind: "image", title, coverUrl: stored.url, tags, source, note, data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
        return { ok: true, id, kind: "image" };
    }
    throw new Error(siteText("assetKindUnsupported"));
}

function paginate(input: SiteToolInput, total: number, defaultSize: number) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || defaultSize));
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(maxPage, Math.max(1, Math.floor(Number(input.page)) || 1));
    const start = (page - 1) * pageSize;
    return { page, pageSize, start, end: start + pageSize };
}
