import { useSyncExternalStore } from "react";
import { discardConflictingState, exportPendingState, flushDurableState, getSaveStatus, subscribeSaveStatus } from "@/lib/localforage-storage";

export function SaveStatus() {
    const status = useSyncExternalStore(subscribeSaveStatus, getSaveStatus);
    const failed = /失败|未同步|冲突/.test(status);
    const conflicted = /冲突/.test(status);
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
                    {conflicted && (
                        <button
                            className="shrink-0 text-destructive hover:underline"
                            onClick={() => {
                                if (!window.confirm("确定放弃本机待同步的冲突修改，并重新载入云端版本吗？如需保留，请先导出待同步备份。")) return;
                                void discardConflictingState()
                                    .then((discarded) => {
                                        if (discarded) window.location.reload();
                                    })
                                    .catch((error) => window.alert(error instanceof Error ? error.message : "清除冲突失败"));
                            }}
                        >
                            放弃本机冲突
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
