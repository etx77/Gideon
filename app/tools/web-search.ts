import { tool } from "@openai/agents";
import { z } from "zod";

export const webSearchTool = tool({
  name: "web_search",

  description: `
Cerca informazioni aggiornate su Internet.

Usa questo tool quando l'utente:
- chiede di cercare qualcosa online
- chiede informazioni aggiornate
- vuole documentazione recente
- vuole verificare un'informazione
- vuole trovare manuali, guide, articoli o documentazione tecnica

Restituisci i risultati della ricerca con titolo, URL e descrizione.
`,

  parameters: z.object({
    query: z.string().describe("La ricerca da effettuare su Internet"),
  }),

  async execute({ query }) {
    const params = new URLSearchParams({
      text: query,
      engines: "google,bing,duckduckgo",
      limit: "8",
    });

const response = await fetch(
  `${process.env.OPENSERP_URL}/mega/search?` +
    params.toString(),
  {
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30000),
  }
);

    if (!response.ok) {
      throw new Error(
        "Ricerca web fallita: HTTP " + response.status
      );
    }

    const data = await response.json();

    const results = (data.results ?? [])
      .filter(
        (result: any) =>
          result.type === "organic" &&
          result.title &&
          result.url
      )
      .slice(0, 8)
      .map((result: any) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet ?? "",
      }));

    return JSON.stringify({
      query,
      results,
    });
  },
});
