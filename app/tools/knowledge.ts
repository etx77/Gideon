import { tool } from "@openai/agents";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const KNOWLEDGE_DIR = "/knowledge";

function safePath(inputPath: string): string {
  const resolved = path.resolve(KNOWLEDGE_DIR, inputPath);

  if (
    resolved !== KNOWLEDGE_DIR &&
    !resolved.startsWith(KNOWLEDGE_DIR + path.sep)
  ) {
    throw new Error("Percorso non consentito");
  }

  return resolved;
}

export const saveKnowledgeTool = tool({
  name: "save_knowledge",

  description: `
Salva conoscenza tecnica persistente nella knowledge base di Gideon.

Usa questo tool quando l'utente chiede esplicitamente di:
- salvare una conoscenza studiata
- memorizzare documentazione tecnica
- conservare informazioni per utilizzi futuri
- creare o aggiornare una voce della knowledge base

La knowledge base è persistente e separata dai file operativi in /data.
Salva contenuti strutturati e utili per consultazioni future.
Non usare questo tool per la memoria personale dell'utente.
`,

  parameters: z.object({
    topic: z.string().describe("Argomento della conoscenza"),
    content: z.string().describe("Contenuto tecnico da salvare"),
    source: z.string().optional().describe("URL o fonte della conoscenza"),
  }),

  async execute({ topic, content, source }) {
    const filename =
      topic
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9àèéìòù]+/gi, "-")
        .replace(/^-+|-+$/g, "") + ".md";

    const filePath = safePath(filename);

    const document = `# ${topic}

${source ? `Source: ${source}\n\n` : ""}${content}
`;

    await fs.writeFile(filePath, document, "utf8");

    return JSON.stringify({
      success: true,
      topic,
      path: filePath,
    });
  },
});

export const readKnowledgeTool = tool({
  name: "read_knowledge",

  description: `
Legge una conoscenza precedentemente salvata nella knowledge base persistente.

Usa questo tool quando una risposta richiede informazioni che Gideon
ha precedentemente studiato e salvato nella knowledge base.
`,

  parameters: z.object({
    path: z.string().describe("Percorso relativo del documento nella knowledge base"),
  }),

  async execute({ path: inputPath }) {
    const filePath = safePath(inputPath);
    const content = await fs.readFile(filePath, "utf8");

    return JSON.stringify({
      path: inputPath,
      content,
    });
  },
});

export const searchKnowledgeTool = tool({
  name: "search_knowledge",

  description: `
Cerca nella knowledge base persistente di Gideon.

Usa questo tool quando devi verificare se Gideon possiede già
conoscenza salvata su un argomento.
`,

  parameters: z.object({
    query: z.string().describe("Testo da cercare nella knowledge base"),
  }),

  async execute({ query }) {
    const entries = await fs.readdir(KNOWLEDGE_DIR, {
      recursive: true,
      withFileTypes: true,
    });

    const results: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const relativePath = entry.parentPath
        ? path.relative(KNOWLEDGE_DIR, path.join(entry.parentPath, entry.name))
        : entry.name;

      const filePath = safePath(relativePath);
      const content = await fs.readFile(filePath, "utf8");

      if (content.toLowerCase().includes(query.toLowerCase())) {
        results.push(relativePath);
      }
    }

    return JSON.stringify({
      query,
      results,
    });
  },
});
