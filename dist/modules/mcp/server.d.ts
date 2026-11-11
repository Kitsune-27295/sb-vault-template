import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { VaultDatabase } from "../../core/db/database.js";
export declare function createSecondBrainMcpServer(vaultPath: string): {
    server: Server;
    db: VaultDatabase;
};
export declare function startMcpStdioServer(vaultPath: string): Promise<void>;
//# sourceMappingURL=server.d.ts.map