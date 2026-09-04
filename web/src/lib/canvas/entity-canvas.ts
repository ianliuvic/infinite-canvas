import { nanoid } from "nanoid";

import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { Asset, AssetEntity, EntityAssetMember } from "@/stores/use-asset-store";
import { CanvasNodeType } from "@/types/canvas";

const CARD_WIDTH = 360;
const CARD_HEIGHT = 460;
const MEDIA_WIDTH = 260;
const MEDIA_HEIGHT = 220;
const GAP = 28;
const PADDING = 36;
const HEADER = 48;

export type EntityCanvasPlacement = {
    ops: CanvasAgentOp[];
    groupId: string;
    profileNodeId: string;
    referenceNodeIds: string[];
};

/** Build a readable entity board: profile card on the left, reference media on the right, all wrapped in a movable group. */
export function buildEntityCanvasPlacement(entity: AssetEntity, assets: Asset[], snapshot: CanvasAgentSnapshot, options: { assetIds?: string[]; maxReferences?: number } = {}): EntityCanvasPlacement {
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const requested = new Set(options.assetIds || []);
    const members = primaryFirst(entity.members)
        .filter((member) => !requested.size || requested.has(member.assetId))
        .flatMap((member) => {
            const asset = assetById.get(member.assetId);
            return asset && (asset.kind === "image" || asset.kind === "video") ? [{ member, asset }] : [];
        })
        .slice(0, Math.max(1, Math.min(12, options.maxReferences || 6)));
    const scale = Math.max(0.05, snapshot.viewport.k || 1);
    const viewport = snapshot.viewportSize || { width: 1200, height: 720 };
    const worldWidth = viewport.width / scale;
    const columns = worldWidth >= 1180 ? 2 : 1;
    const rows = Math.max(1, Math.ceil(members.length / columns));
    const groupWidth = PADDING * 2 + CARD_WIDTH + (members.length ? GAP + columns * MEDIA_WIDTH + (columns - 1) * GAP : 0);
    const groupHeight = HEADER + PADDING * 2 + Math.max(CARD_HEIGHT, rows * MEDIA_HEIGHT + (rows - 1) * GAP);
    const center = { x: (-snapshot.viewport.x + viewport.width / 2) / scale, y: (-snapshot.viewport.y + viewport.height / 2) / scale };
    const origin = { x: center.x - groupWidth / 2, y: center.y - groupHeight / 2 };
    const groupId = `entity-group-${nanoid()}`;
    const profileNodeId = `entity-profile-${nanoid()}`;
    const referenceNodeIds: string[] = [];
    const ops: CanvasAgentOp[] = [
        {
            type: "add_node",
            id: groupId,
            nodeType: CanvasNodeType.Group,
            title: `${entity.name} · ${entityKindLabel(entity.kind)}`,
            position: origin,
            width: groupWidth,
            height: groupHeight,
            metadata: { entityId: entity.id, entityKind: entity.kind, entityRole: "group", status: "success" },
        },
        {
            type: "add_node",
            id: profileNodeId,
            nodeType: CanvasNodeType.Text,
            title: `${entity.name} · 实体资料`,
            position: { x: origin.x + PADDING, y: origin.y + HEADER + PADDING },
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            metadata: { content: entityProfileText(entity), fontSize: 14, status: "success", groupId, entityId: entity.id, entityKind: entity.kind, entityRole: "profile" },
        },
    ];

    members.forEach(({ member, asset }, index) => {
        const id = `entity-reference-${nanoid()}`;
        referenceNodeIds.push(id);
        const column = index % columns;
        const row = Math.floor(index / columns);
        const position = { x: origin.x + PADDING + CARD_WIDTH + GAP + column * (MEDIA_WIDTH + GAP), y: origin.y + HEADER + PADDING + row * (MEDIA_HEIGHT + GAP) };
        const naturalWidth = asset.data.width || MEDIA_WIDTH;
        const naturalHeight = asset.data.height || MEDIA_HEIGHT;
        const size = fitNodeSize(naturalWidth, naturalHeight, MEDIA_WIDTH, MEDIA_HEIGHT);
        const metadata = asset.kind === "image"
            ? imageMetadata({ url: asset.data.dataUrl, storageKey: asset.data.storageKey, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType })
            : videoMetadata({ url: asset.data.url, storageKey: asset.data.storageKey || "", width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType });
        ops.push({
            type: "add_node",
            id,
            nodeType: asset.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video,
            title: `${asset.title} · ${entityRoleLabel(member)}`,
            position,
            width: size.width,
            height: size.height,
            metadata: { ...metadata, groupId, entityId: entity.id, entityKind: entity.kind, entityRole: member.role, assetId: asset.id },
        });
        ops.push({ type: "connect_nodes", fromNodeId: profileNodeId, toNodeId: id });
    });
    ops.push({ type: "select_nodes", ids: [groupId] });
    return { ops, groupId, profileNodeId, referenceNodeIds };
}

export function entitySearchText(entity: AssetEntity) {
    return [entity.name, ...entity.aliases, entity.summary, entity.description, ...entity.tags, entity.prompt, entity.negativePrompt, entity.usageRules].join(" ").toLowerCase();
}

export function entityProfileText(entity: AssetEntity) {
    return [
        `# ${entity.name}`,
        `类型：${entityKindLabel(entity.kind)}${entity.aliases.length ? `\n别名：${entity.aliases.join("、")}` : ""}`,
        entity.summary ? `## 简介\n${entity.summary}` : "",
        entity.description ? `## 详细档案\n${entity.description}` : "",
        entity.prompt ? `## 固定生成描述\n${entity.prompt}` : "",
        entity.negativePrompt ? `## 避免内容\n${entity.negativePrompt}` : "",
        entity.usageRules ? `## 使用规则\n${entity.usageRules}` : "",
        entity.tags.length ? `标签：${entity.tags.join(" · ")}` : "",
    ].filter(Boolean).join("\n\n");
}

export function entityKindLabel(kind: AssetEntity["kind"]) {
    return ({ person: "人物", product: "产品", scene: "场景", style: "风格", brand: "品牌", other: "其他" } as const)[kind];
}

export function entityRoleLabel(member: EntityAssetMember) {
    return ({ primary: "主参考", identity: "身份", fullBody: "全身", detail: "细节", expression: "表情", outfit: "服装", background: "背景", product: "产品", style: "风格", reference: "参考" } as const)[member.role];
}

function primaryFirst(members: EntityAssetMember[]) {
    return [...members].sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
}
