import { existsSync } from "node:fs";
import { join } from "node:path";
// Numeric-zone Instance layout (ADR 0013): `10-sources/` and `90-system/` at the root.
export function isInstanceLayout(vaultPath) {
    return existsSync(join(vaultPath, "10-sources")) && existsSync(join(vaultPath, "90-system"));
}
// Where `sb clip` drops a captured page until it is curated. An Instance vault uses
// `50-ops/inbox/_drop`, the folder the rest of the engine counts as pending inbox drops.
export function resolveDropDir(vaultPath) {
    if (existsSync(join(vaultPath, "01_Inbox", "_drop")))
        return join(vaultPath, "01_Inbox", "_drop");
    if (isInstanceLayout(vaultPath))
        return join(vaultPath, "50-ops", "inbox", "_drop");
    if (existsSync(join(vaultPath, "01_Inbox")))
        return join(vaultPath, "01_Inbox", "_drop");
    return join(vaultPath, "sources", "inbox");
}
// Where `sb capture` seals a source file: the Instance raw-source zone, the template's
// literature notes folder, or the bare-vault fallback.
export function resolveCaptureDir(vaultPath) {
    if (isInstanceLayout(vaultPath))
        return join(vaultPath, "10-sources");
    const literature = join(vaultPath, "02_Zettelkasten", "01_Literature_Notes");
    return existsSync(literature) ? literature : join(vaultPath, "80-sources");
}
//# sourceMappingURL=vault-layout.js.map