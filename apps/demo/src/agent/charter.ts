import {
  createCharter,
  createStandardExecutor,
} from "markov-machines";
import { memoryPack } from "./packs/memory";
import { themePack } from "./packs/theme";
import { rootNode } from "./nodes/root";
import { fooNode } from "./nodes/foo";
import { demoMemoryNode } from "./nodes/demo-memory";
import { demoPingNode } from "./nodes/demo-ping";
import { demoFavoritesNode } from "./nodes/demo-favorites";

export const demoCharter = createCharter({
  name: "demo-assistant",
  executor: createStandardExecutor({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-sonnet-4-5",
    maxTokens: 4096,
  }),
  packs: [memoryPack, themePack],
  nodes: {
    rootNode,
    fooNode,
    demoMemoryNode,
    demoPingNode,
    demoFavoritesNode,
  },
});

export { rootNode, fooNode, demoMemoryNode, demoPingNode, demoFavoritesNode };
