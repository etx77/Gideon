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

export const runtime = "nodejs";

const provider = new OpenAIProvider({
  apiKey: process.env.NVIDIA_API_KEY!,
  baseURL: "https://integrate.api.nvidia.com/v1",
  useResponses: false,
});


import { fileInfoTool } from "../../tools/file-info";


export async function POST(request: Request) {
  try {
    /*
     * Carica il prompt di sistema dal file esterno.
     *
     * Il modello NON viene definito qui:
     * viene letto esclusivamente da NVIDIA_MODEL nel file .env.
     */
    const instructions = await fs.readFile(
      path.join(process.cwd(), "prompts", "system.md"),
      "utf8"
    );

    const body = await request.json();
    const messages = body.messages ?? [];

    const agent = new Agent({
      name: "NVIDIA Coding Assistant",

      instructions,

      model: await provider.getModel(
        process.env.NVIDIA_MODEL!
      ),

      tools: [
        webSearchTool,
        fetchUrlTool,

        listFilesTool,
        fileInfoTool,
        readFileTool,
        searchFilesTool,

        listArchiveTool,
        extractArchiveTool,
        
         sshTool,
      ],
    });

    /*
     * Converte i messaggi ricevuti dalla UI
     * nel formato utilizzato dall'Agents SDK.
     */
    const input = messages.map((message: any) => ({
      role: message.role,
      content: message.content,
    }));

    /*
     * Esecuzione agentica con streaming.
     *
     * maxTurns alto perché alcune analisi diagnostiche
     * richiedono molti passaggi tra search_files/read_file,
     * soprattutto con archivi e log grandi.
     */
    const result = await run(agent, input, {
      stream: true,
      maxTurns: 60,
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of result.toTextStream()) {
            controller.enqueue(encoder.encode(chunk));
          }

          controller.close();
        } catch (error) {
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
