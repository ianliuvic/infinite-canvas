import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    model?: string;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode" | "videoProviderMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, model, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const crunSettings = useCrunVideoSettings(config, model);
    const seconds = normalizeDuration(config.videoSeconds || "6", crunSettings);
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const resolution = normalizeResolutionOption(config.vquality);
    const selectedRatio = inferVideoRatio(config.size || "auto");
    const dimensions = readVideoDimensions(config.size || "auto", parseVideoResolution(resolution), selectedRatio);
    const availableResolutions = crunSettings?.resolutions.length ? crunSettings.resolutions : resolutionOptions.map((item) => item.value);
    const availableRatios = crunSettings?.ratios.length ? crunSettings.ratios.map(toRatioOption).filter((item): item is { value: string; width: number; height: number } => Boolean(item)) : [...videoRatioOptions];
    const showResolution = !crunSettings || crunSettings.fields.has("resolution");
    const showDimensions = !crunSettings || crunSettings.fields.has("size") || (crunSettings.fields.has("width") && crunSettings.fields.has("height"));
    const showRatio = !crunSettings || crunSettings.fields.has("ratio");
    const showAudio = !crunSettings || crunSettings.fields.has("audio");
    const showWatermark = !crunSettings || crunSettings.fields.has("watermark");
    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", computeVideoSize(nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto") onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {showResolution ? <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {availableResolutions.map((value) => (
                            <OptionPill key={value} selected={resolution.toLowerCase() === value.toLowerCase()} theme={theme} onClick={() => selectResolution(value)}>
                                {resolutionLabel(value)}
                            </OptionPill>
                        ))}
                        {!crunSettings ? <ResolutionInput value={parseVideoResolution(resolution)} theme={theme} onChange={selectResolution} /> : null}
                    </div>
                </SettingGroup> : null}
                {showDimensions ? <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup> : null}
                {showRatio ? <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {availableRatios.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => applySize(resolution, item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup> : null}
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    {crunSettings?.durations.length ? <div className="grid grid-cols-4 gap-2.5">
                        {crunSettings.durations.map((value) => <OptionPill key={value} selected={seconds === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>{value}s</OptionPill>)}
                    </div> : <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-0 flex-1" min={crunSettings?.durationMin ?? VIDEO_SECONDS_MIN} max={crunSettings?.durationMax ?? VIDEO_SECONDS_MAX} step={1} value={seconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                        <SecondsInput value={seconds} min={crunSettings?.durationMin ?? VIDEO_SECONDS_MIN} max={crunSettings?.durationMax ?? VIDEO_SECONDS_MAX} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                    </div>}
                </SettingGroup>
                {!crunSettings ? <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2.5">
                        {videoModeOptions.map((item) => (
                            <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                {t(`settingsPanels.video.modes.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup> : null}
                {crunSettings?.providerModes.length ? <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {crunSettings.providerModes.map((value) => <OptionPill key={value} selected={(config.videoProviderMode || crunSettings.providerModeDefault) === value} theme={theme} onClick={() => onConfigChange("videoProviderMode", value)}>{value}</OptionPill>)}
                    </div>
                </SettingGroup> : null}
                {showAudio ? <BooleanSetting title={t("settingsPanels.video.generateAudio")} value={config.videoGenerateAudio !== "false"} theme={theme} onChange={(value) => onConfigChange("videoGenerateAudio", String(value))} /> : null}
                {showWatermark ? <BooleanSetting title={t("settingsPanels.video.watermark")} value={config.videoWatermark === "true"} theme={theme} onChange={(value) => onConfigChange("videoWatermark", String(value))} /> : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return resolutionLabel(normalizeResolutionOption(value));
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" ? "reference" : "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function SecondsInput({ value, min, max, theme, onCommit }: { value: number; min: number; max: number; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Math.max(min, Math.min(max, Math.floor(Number(input.value) || value)));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={min}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

type CrunVideoField = "resolution" | "ratio" | "duration" | "audio" | "watermark" | "size" | "width" | "height";
type CrunVideoSettings = { fields: Set<CrunVideoField>; resolutions: string[]; ratios: string[]; durations: number[]; durationMin?: number; durationMax?: number; providerModes: string[]; providerModeDefault: string };

function useCrunVideoSettings(config: AiConfig, explicitModel?: string) {
    const selectedModel = explicitModel || config.model || config.videoModel;
    const channel = resolveModelChannel(config, selectedModel);
    const isCrun = channel.id === "crun";
    const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
    useEffect(() => {
        setSchema(null);
        if (!isCrun) return;
        const controller = new AbortController();
        const url = `${channel.baseUrl.replace(/\/+$/, "")}/v1/schema?model=${encodeURIComponent(modelOptionName(selectedModel))}`;
        void fetch(url, { credentials: "include", signal: controller.signal }).then(async (response) => {
            const data = await response.json() as { schema?: Record<string, unknown>; error?: string };
            if (!response.ok || !data.schema) throw new Error(data.error || "Failed to read Crun model schema");
            setSchema(data.schema);
        }).catch((error) => {
            if (error instanceof DOMException && error.name === "AbortError") return;
            setSchema(null);
        });
        return () => controller.abort();
    }, [channel.baseUrl, isCrun, selectedModel]);
    return useMemo(() => isCrun && schema ? parseCrunVideoSettings(schema) : null, [isCrun, schema]);
}

function parseCrunVideoSettings(schema: Record<string, unknown>): CrunVideoSettings {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
    const fields = new Set<CrunVideoField>();
    const resolution = findSchemaProperty(properties, ["resolution", "output_resolution"]);
    const ratio = findSchemaProperty(properties, ["aspect_ratio", "aspectRatio", "ratio"]);
    const duration = findSchemaProperty(properties, ["duration", "seconds"]);
    if (resolution) fields.add("resolution");
    if (ratio) fields.add("ratio");
    if (duration) fields.add("duration");
    if (findSchemaProperty(properties, ["audio", "generate_audio", "with_audio"])) fields.add("audio");
    if (findSchemaProperty(properties, ["watermark", "add_watermark", "enable_watermark"])) fields.add("watermark");
    for (const field of ["size", "width", "height"] as const) if (properties[field]) fields.add(field);
    const durationValues = schemaEnum(duration).map(Number).filter(Number.isFinite);
    const providerMode = properties.mode;
    return {
        fields,
        resolutions: schemaEnum(resolution).map(String),
        ratios: schemaEnum(ratio).map(String),
        durations: durationValues,
        durationMin: finiteNumber(duration?.minimum ?? duration?.min),
        durationMax: finiteNumber(duration?.maximum ?? duration?.max),
        providerModes: schemaEnum(providerMode).map(String),
        providerModeDefault: typeof providerMode?.default === "string" ? providerMode.default : "",
    };
}

function findSchemaProperty(properties: Record<string, Record<string, unknown>>, names: string[]) {
    return names.map((name) => properties[name]).find(Boolean);
}

function schemaEnum(definition: Record<string, unknown> | undefined): Array<string | number> {
    if (!definition) return [];
    if (Array.isArray(definition.enum)) return definition.enum.filter((value): value is string | number => typeof value === "string" || typeof value === "number");
    for (const key of ["oneOf", "anyOf"]) {
        const choices = definition[key];
        if (!Array.isArray(choices)) continue;
        const values = choices.flatMap((choice) => choice && typeof choice === "object" ? schemaEnum(choice as Record<string, unknown>) : []);
        if (values.length) return values;
    }
    return [];
}

function normalizeDuration(value: string, settings: CrunVideoSettings | null) {
    const numeric = Math.floor(Number(value) || 6);
    if (settings?.durations.length) return settings.durations.reduce((best, item) => Math.abs(item - numeric) < Math.abs(best - numeric) ? item : best);
    const min = settings?.durationMin ?? VIDEO_SECONDS_MIN;
    const max = settings?.durationMax ?? VIDEO_SECONDS_MAX;
    return Math.max(min, Math.min(max, numeric));
}

function normalizeResolutionOption(value: string) {
    const raw = String(value || "720").trim();
    return /^\d+k$/i.test(raw) ? raw : parseVideoResolution(raw);
}

function resolutionLabel(value: string) {
    return /^\d+k$/i.test(value) ? value.toUpperCase() : /p$/i.test(value) ? value : `${value}p`;
}

function toRatioOption(value: string) {
    if (value === "auto") return { value, width: 0, height: 0 };
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
    if (!match) return null;
    return { value, width: Number(match[1]), height: Number(match[2]) };
}

function finiteNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function BooleanSetting({ title, value, theme, onChange }: { title: string; value: boolean; theme: CanvasTheme; onChange: (value: boolean) => void }) {
    return <div className="flex items-center justify-between gap-3"><span className="text-xs font-medium" style={{ color: theme.node.muted }}>{title}</span><span onMouseDown={(event) => event.stopPropagation()}><Switch size="small" checked={value} onChange={onChange} /></span></div>;
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
