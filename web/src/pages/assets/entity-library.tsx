import { App, Button, Card, Drawer, Empty, Form, Image, Input, Modal, Select, Tag, Typography } from "antd";
import { Boxes, PencilLine, Plus, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { entityKindLabel, entityRoleLabel, entitySearchText } from "@/lib/canvas/entity-canvas";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore, type AssetEntity, type EntityAssetMember, type EntityAssetRole, type EntityKind } from "@/stores/use-asset-store";

type EntityFormValues = {
    kind: EntityKind;
    name: string;
    aliases: string[];
    tags: string[];
    summary: string;
    description: string;
    prompt: string;
    negativePrompt: string;
    usageRules: string;
};

const kinds: EntityKind[] = ["person", "product", "scene", "style", "brand", "other"];
const roles: EntityAssetRole[] = ["primary", "identity", "fullBody", "detail", "expression", "outfit", "background", "product", "style", "reference"];

export function EntityLibrary({ keyword }: { keyword: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [form] = Form.useForm<EntityFormValues>();
    const assets = useAssetStore((state) => state.assets);
    const entities = useAssetStore((state) => state.entities);
    const addAsset = useAssetStore((state) => state.addAsset);
    const addEntity = useAssetStore((state) => state.addEntity);
    const updateEntity = useAssetStore((state) => state.updateEntity);
    const removeEntity = useAssetStore((state) => state.removeEntity);
    const [kind, setKind] = useState<EntityKind | "all">("all");
    const [editing, setEditing] = useState<AssetEntity | null>(null);
    const [preview, setPreview] = useState<AssetEntity | null>(null);
    const [deleting, setDeleting] = useState<AssetEntity | null>(null);
    const [open, setOpen] = useState(false);
    const [members, setMembers] = useState<EntityAssetMember[]>([]);
    const [uploading, setUploading] = useState(false);
    const uploadRef = useRef<HTMLInputElement>(null);
    const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return entities.filter((entity) => (kind === "all" || entity.kind === kind) && (!query || entitySearchText(entity).includes(query)));
    }, [entities, kind, keyword]);

    const openCreate = () => {
        setEditing(null);
        setMembers([]);
        form.setFieldsValue({ kind: "person", name: "", aliases: [], tags: [], summary: "", description: "", prompt: "", negativePrompt: "", usageRules: "" });
        setOpen(true);
    };
    const openEdit = (entity: AssetEntity) => {
        setEditing(entity);
        setMembers(entity.members);
        form.setFieldsValue({ kind: entity.kind, name: entity.name, aliases: entity.aliases, tags: entity.tags, summary: entity.summary, description: entity.description, prompt: entity.prompt, negativePrompt: entity.negativePrompt, usageRules: entity.usageRules });
        setOpen(true);
    };
    const save = async () => {
        const values = await form.validateFields();
        const payload = { ...values, name: values.name.trim(), aliases: values.aliases || [], tags: values.tags || [], summary: values.summary?.trim() || "", description: values.description?.trim() || "", prompt: values.prompt?.trim() || "", negativePrompt: values.negativePrompt?.trim() || "", usageRules: values.usageRules?.trim() || "", members };
        editing ? updateEntity(editing.id, payload) : addEntity(payload);
        message.success(t(editing ? "entities.updated" : "entities.saved"));
        setOpen(false);
    };
    const updateMemberIds = (ids: string[]) => setMembers(ids.map((assetId) => members.find((member) => member.assetId === assetId) || { assetId, role: "reference" }));
    const updateMember = (assetId: string, patch: Partial<EntityAssetMember>) => setMembers((current) => current.map((member) => (member.assetId === assetId ? { ...member, ...patch } : member)));
    const uploadReferences = async (files: FileList | null) => {
        const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        setUploading(true);
        try {
            const added: EntityAssetMember[] = [];
            for (const file of images) {
                const image = await uploadImage(file);
                const assetId = addAsset({ kind: "image", title: file.name, coverUrl: image.url, tags: [], source: t("entities.source"), data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                added.push({ assetId, role: members.length || added.length ? "reference" : "primary" });
            }
            setMembers((current) => [...current, ...added]);
            message.success(t("entities.uploaded", { count: added.length }));
        } catch (error) {
            console.error(error);
            message.error(t("entities.uploadFailed"));
        } finally {
            setUploading(false);
            if (uploadRef.current) uploadRef.current.value = "";
        }
    };

    return (
        <section className="mx-auto max-w-7xl">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-2">
                    <Tag.CheckableTag checked={kind === "all"} className={kind === "all" ? "is-active prompt-filter-tag" : "prompt-filter-tag"} onChange={() => setKind("all")}>{t("common.all")}</Tag.CheckableTag>
                    {kinds.map((item) => <Tag.CheckableTag key={item} checked={kind === item} className={kind === item ? "is-active prompt-filter-tag" : "prompt-filter-tag"} onChange={() => setKind(item)}>{t(`entities.kinds.${item}`)}</Tag.CheckableTag>)}
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>{t("entities.add")}</Button>
            </div>
            {filtered.length ? (
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {filtered.map((entity) => {
                        const cover = entity.members.map((member) => assetById.get(member.assetId)).find((asset) => asset?.kind === "image");
                        const coverUrl = cover?.kind === "image" ? cover.coverUrl || cover.data.dataUrl : "";
                        return (
                            <Card key={entity.id} hoverable className="overflow-hidden" styles={{ body: { padding: 0 } }}>
                                <button type="button" className="block w-full text-left" onClick={() => setPreview(entity)}>
                                    {coverUrl ? <img src={coverUrl} alt={entity.name} className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] items-center justify-center bg-gradient-to-br from-amber-50 to-stone-100 dark:from-amber-950/30 dark:to-stone-900"><Boxes className="size-10 text-amber-600/70" /></div>}
                                    <div className="p-4">
                                        <div className="flex items-start justify-between gap-2"><h2 className="line-clamp-1 font-semibold">{entity.name}</h2><Tag className="m-0 shrink-0">{entityKindLabel(entity.kind)}</Tag></div>
                                        <p className="mt-2 line-clamp-3 min-h-[3.75rem] text-xs leading-5 text-stone-500 dark:text-stone-400">{entity.summary || entity.description || t("entities.noSummary")}</p>
                                        <div className="mt-3 flex items-center justify-between text-xs text-stone-500"><span>{t("entities.memberCount", { count: entity.members.length })}</span><span>{entity.tags.slice(0, 2).join(" · ")}</span></div>
                                    </div>
                                </button>
                                <div className="flex gap-2 px-4 pb-4"><Button size="small" onClick={() => setPreview(entity)}>{t("common.view")}</Button><Button size="small" icon={<PencilLine className="size-3.5" />} onClick={() => openEdit(entity)}>{t("common.edit")}</Button><Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(entity)}>{t("common.delete")}</Button></div>
                            </Card>
                        );
                    })}
                </div>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("entities.empty")} className="py-20" />}

            <Modal title={editing ? t("entities.edit") : t("entities.add")} open={open} width={1040} onCancel={() => setOpen(false)} onOk={() => void save()} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false} className="pt-2">
                    <div className="grid gap-x-5 md:grid-cols-2">
                        <Form.Item name="name" label={t("entities.fields.name")} rules={[{ required: true, message: t("entities.fields.nameRequired") }]}><Input size="large" /></Form.Item>
                        <Form.Item name="kind" label={t("entities.fields.kind")}><Select options={kinds.map((value) => ({ value, label: t(`entities.kinds.${value}`) }))} /></Form.Item>
                        <Form.Item name="aliases" label={t("entities.fields.aliases")}><Select mode="tags" tokenSeparators={[",", "，"]} /></Form.Item>
                        <Form.Item name="tags" label={t("entities.fields.tags")}><Select mode="tags" tokenSeparators={[",", "，"]} /></Form.Item>
                    </div>
                    <Form.Item name="summary" label={t("entities.fields.summary")}><Input /></Form.Item>
                    <Form.Item name="description" label={t("entities.fields.description")}><Input.TextArea rows={3} /></Form.Item>
                    <div className="grid gap-x-5 md:grid-cols-2"><Form.Item name="prompt" label={t("entities.fields.prompt")}><Input.TextArea rows={4} /></Form.Item><Form.Item name="negativePrompt" label={t("entities.fields.negativePrompt")}><Input.TextArea rows={4} /></Form.Item></div>
                    <Form.Item name="usageRules" label={t("entities.fields.usageRules")}><Input.TextArea rows={3} /></Form.Item>
                    <div className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><Typography.Text strong>{t("entities.fields.members")}</Typography.Text><Typography.Text type="secondary" className="ml-2 text-xs">{t("entities.fields.membersHint")}</Typography.Text></div><Button loading={uploading} icon={<Upload className="size-4" />} onClick={() => uploadRef.current?.click()}>{t("entities.uploadReferences")}</Button></div>
                        <Select mode="multiple" className="w-full" value={members.map((member) => member.assetId)} onChange={updateMemberIds} placeholder={t("entities.fields.membersPlaceholder")} options={assets.map((asset) => ({ value: asset.id, label: `${asset.title} · ${t(`assets.kinds.${asset.kind}`)}` }))} />
                        <div className="mt-3 space-y-2">{members.map((member) => { const asset = assetById.get(member.assetId); return asset ? <div key={member.assetId} className="grid items-center gap-2 rounded-lg bg-stone-50 p-2 dark:bg-stone-900 md:grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)_32px]"><span className="truncate text-sm font-medium">{asset.title}</span><Select size="small" value={member.role} onChange={(role) => updateMember(member.assetId, { role })} options={roles.map((value) => ({ value, label: t(`entities.roles.${value}`) }))} /><Input size="small" value={member.note} placeholder={t("entities.memberNote")} onChange={(event) => updateMember(member.assetId, { note: event.target.value })} /><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} aria-label={t("common.delete")} onClick={() => setMembers((current) => current.filter((item) => item.assetId !== member.assetId))} /></div> : null; })}</div>
                    </div>
                </Form>
                <input ref={uploadRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void uploadReferences(event.target.files)} />
            </Modal>

            <Drawer title={preview?.name} open={Boolean(preview)} size="large" onClose={() => setPreview(null)}>
                {preview ? <div className="space-y-5"><div className="flex flex-wrap gap-2"><Tag color="gold">{entityKindLabel(preview.kind)}</Tag>{preview.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>{preview.summary ? <Typography.Paragraph className="text-base">{preview.summary}</Typography.Paragraph> : null}{[["description", preview.description], ["prompt", preview.prompt], ["negativePrompt", preview.negativePrompt], ["usageRules", preview.usageRules]].map(([label, value]) => value ? <div key={label}><Typography.Text type="secondary" className="text-xs">{t(`entities.fields.${label}`)}</Typography.Text><Typography.Paragraph className="mt-1 whitespace-pre-wrap">{value}</Typography.Paragraph></div> : null)}<div><Typography.Text strong>{t("entities.fields.members")}</Typography.Text><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{preview.members.map((member) => { const asset=assetById.get(member.assetId); if(!asset) return null; const cover=asset.kind === "image" ? asset.coverUrl || asset.data.dataUrl : asset.kind === "video" ? asset.coverUrl : ""; return <div key={member.assetId} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">{cover ? <Image preview={false} src={cover} alt={asset.title} className="aspect-square w-full object-cover" /> : <div className="grid aspect-square place-items-center bg-stone-100 text-xs dark:bg-stone-900">{t(`assets.kinds.${asset.kind}`)}</div>}<div className="p-2"><div className="truncate text-xs font-medium">{asset.title}</div><div className="mt-1 text-[11px] text-stone-500">{entityRoleLabel(member)}</div></div></div>; })}</div></div></div> : null}
            </Drawer>
            <Modal title={t("entities.deleteTitle")} open={Boolean(deleting)} onCancel={() => setDeleting(null)} onOk={() => { if (deleting) removeEntity(deleting.id); setDeleting(null); }} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>{t("entities.deleteConfirm", { name: deleting?.name })}</Modal>
        </section>
    );
}
