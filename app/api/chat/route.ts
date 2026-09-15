import { Agent, OpenAIProvider, run } from "@openai/agents";
import fs from "fs/promises";
import path from "path";

import { webSearchTool } from "../../tools/web-search";
import { fetchUrlTool } from "../../tools/fetch-url";

import {
listFilesTool,
readFileTool,
searchFilesTool,
} from "../../tools/filesystem";

import {
listArchiveTool,
extractArchiveTool,
} from "../../tools/archive";

import { sshTool } from "../../tools/ssh";
import { fileInfoTool } from "../../tools/file-info";
import { webExtractTool } from "../../tools/web-extract";

import {
  saveKnowledgeTool,
  readKnowledgeTool,
  searchKnowledgeTool,
} from "../../tools/knowledge";

export const runtime = "nodejs";

const provider = new OpenAIProvider({
apiKey: process.env.NVIDIA_API_KEY!,
baseURL: "https://integrate.api.nvidia.com/v1",
useResponses: false,
});

export async function POST(request: Request) {
try {
const instructions = await fs.readFile(
path.join(process.cwd(), "prompts", "system.md"),
"utf8"
);

const body = await request.json();
const messages = body.messages ?? [];

const agent = new Agent({
  name: "Gideon",
  instructions,
  model: await provider.getModel(process.env.NVIDIA_MODEL!),
  tools: [
    webSearchTool,
    fetchUrlTool,
    webExtractTool,
    listFilesTool,
    fileInfoTool,
    readFileTool,
    searchFilesTool,
    listArchiveTool,
    extractArchiveTool,
    sshTool,
    saveKnowledgeTool,
    readKnowledgeTool,
    searchKnowledgeTool,
  ],
});

const input = messages.map((message: any) => ({
  role: message.role,
  content: message.content,
}));

const result = await run(agent, input, {
  stream: true,
  maxTurns: 60,
  signal: request.signal,
});

const encoder = new TextEncoder();

const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    try {
      for await (const chunk of result.toTextStream()) {
        if (request.signal.aborted) {
          console.log("🛑 Gideon stream aborted");
          return;
        }

        controller.enqueue(encoder.encode(chunk));
      }

      if (!request.signal.aborted) {
        controller.close();
      }
    } catch (error) {
      if (request.signal.aborted) {
        console.log("🛑 Gideon stream aborted");
        return;
      }

      console.error("Errore durante lo streaming:", error);
      controller.error(error);
    }
  },
});

return new Response(stream, {
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  },
});

} catch (error) {
if (request.signal.aborted) {
console.log("🛑 Gideon run aborted");

  return new Response(null, {
    status: 499,
  });
}

console.error("Errore API chat:", error);

return new Response(
  JSON.stringify({
    error: "Errore durante la chiamata al modello",
  }),
  {
    status: 500,
    headers: {
      "Content-Type": "application/json",
    },
  }
);

}
}
