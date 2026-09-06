import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { resolveImageUrl } from "@/services/image-storage";
import type { ImageAsset } from "@/stores/use-asset-store";

const transparentPixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export function PersistedAssetImage({ asset, fallback, placeholder, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { asset: ImageAsset; fallback?: string; placeholder?: ReactNode }) {
    const ref = useRef<HTMLImageElement>(null);
    const source = fallback || asset.coverUrl || asset.data.dataUrl;
    const [visible, setVisible] = useState(false);
    const [url, setUrl] = useState(asset.data.storageKey ? "" : source);

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === "undefined") return void setVisible(true);
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            setVisible(true);
            observer.disconnect();
        }, { rootMargin: "240px" });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        let active = true;
        setUrl(asset.data.storageKey ? "" : source);
        if (visible && asset.data.storageKey) void resolveImageUrl(asset.data.storageKey, source).then((value) => active && setUrl(value));
        return () => { active = false; };
    }, [asset.data.storageKey, source, visible]);

    return <span className="relative block h-full w-full">{!url && placeholder ? placeholder : null}<img ref={ref} {...props} className={`${props.className || ""} ${!url && placeholder ? "absolute inset-0" : ""}`} src={url || transparentPixel} loading="lazy" decoding="async" /></span>;
}
