import { useSyncExternalStore } from "react";
import { exportPendingState, flushDurableState, getSaveStatus, subscribeSaveStatus } from "@/lib/localforage-storage";

export function SaveStatus() {
    const status = useSyncExternalStore(subscribeSaveStatus, getSaveStatus);
    const failed = /失败|未同步|冲突/.test(status);
    return (
        <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-3 px-4 py-1 text-xs text-muted-foreground">
            <span className={failed ? "text-destructive" : ""} title={status}>
                {status}
            </span>
            {failed && (
                <>
                    <button
                        className="shrink-0 hover:underline"
                        onClick={() => {
                            void flushDurableState().catch(() => undefined);
                        }}
                    >
                        重试保存
                    </button>
                    <button
                        className="shrink-0 hover:underline"
                        onClick={() => {
                            void exportPendingState();
                        }}
                    >
                        导出待同步备份
                    </button>
                </>
            )}
        </div>
    );
}
