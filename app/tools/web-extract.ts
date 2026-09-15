import { tool } from "@openai/agents";
import { z } from "zod";

export const webExtractTool = tool({
  name: "web_extract",

  description: `
Estrae e restituisce il contenuto leggibile di una pagina web pubblica.

Usa questo tool quando:
- devi leggere una pagina trovata tramite web_search
- devi analizzare un articolo o una documentazione online
- devi recuperare il contenuto strutturato di una pagina web
- devi verificare dettagli presenti in una fonte online

Restituisce titolo, descrizione e contenuto in Markdown.
`,

  parameters: z.object({
    url: z.string().url().describe("URL della pagina web da estrarre"),
  }),

  async execute({ url }) {
    const endpoint = new URL(
      `${process.env.OPENSERP_URL}/extract`
    );

    endpoint.searchParams.set("url", url);

    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(
        `Estrazione pagina fallita: HTTP ${response.status}`
      );
    }

    const data = await response.json();

    return JSON.stringify({
      url: data.url ?? url,
      title: data.title ?? "",
      description: data.description ?? "",
      markdown: data.markdown ?? "",
    });
  },
});
