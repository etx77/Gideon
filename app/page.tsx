"use client";

import { useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("modello non disponibile");

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/model")
      .then((response) => response.json())
      .then((data) => {
        if (data.model) {
          setModel(data.model);
        }
      })
      .catch((error) => {
        console.error("Errore recupero modello:", error);
      });
  }, []);

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      role: "user",
      content: input
    };

    const updatedMessages = [...messages, userMessage];

    setMessages(updatedMessages);
    setInput("");
    setLoading(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: updatedMessages
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error("Errore API");
      }

      const reader = response.body?.getReader();

      if (!reader) {
        throw new Error("Streaming non disponibile");
      }

      const decoder = new TextDecoder();

      let assistantText = "";

      setMessages([
        ...updatedMessages,
        {
          role: "assistant",
          content: ""
        }
      ]);

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        assistantText += decoder.decode(value, {
          stream: true
        });

        setMessages([
          ...updatedMessages,
          {
            role: "assistant",
            content: assistantText
          }
        ]);
      }

      // Completa eventuali byte rimasti nel decoder
      assistantText += decoder.decode();

      if (assistantText) {
        setMessages([
          ...updatedMessages,
          {
            role: "assistant",
            content: assistantText
          }
        ]);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        console.log("Richiesta interrotta dall'utente.");
        return;
      }

      console.error(error);

      setMessages([
        ...updatedMessages,
        {
          role: "assistant",
          content: "❌ Errore durante la comunicazione con il modello."
        }
      ]);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  }

  function stopMessage() {
    abortControllerRef.current?.abort();
  }

  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#212121",
        color: "#fff",
        fontFamily: '"Courier New", monospace'
      }}
    >
      <header
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid #444",
          fontSize: "18px",
          fontWeight: "bold",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }}
      >
        <span>🤖 Gideon AI Assistant</span>

        <span
          style={{
            fontSize: "13px",
            fontWeight: "normal",
            color: "#aaa"
          }}
        >
          {model}
        </span>
      </header>

      <section
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "30px",
          maxWidth: "1000px",
          width: "100%",
          margin: "0 auto"
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              textAlign: "center",
              marginTop: "20vh",
              color: "#aaa"
            }}
          >
            <h1 style={{ color: "#fff" }}>
              Gideon AI Assistant
            </h1>

            <p>
              Analisi, coding e troubleshooting con LLM NVIDIA API.
            </p>

            <p
              style={{
                marginTop: "12px",
                fontSize: "13px",
                color: "#777"
              }}
            >
              Modello: {model}
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            style={{
              marginBottom: "28px",
              whiteSpace: "pre-wrap",
              lineHeight: 1.6
            }}
          >
            <strong>
              {message.role === "user" ? "Lightbringer" : "🤖 Gideon"}
            </strong>

            <div
              style={{
                marginTop: "8px",
                color:
                  message.role === "assistant"
                    ? "#00ff66"
                    : "#ffff66"
              }}
            >
              {message.content}
            </div>
          </div>
        ))}
      </section>

      <div
        style={{
          padding: "20px",
          borderTop: "1px solid #444"
        }}
      >
        <div
          style={{
            maxWidth: "900px",
            margin: "0 auto",
            display: "flex",
            gap: "10px"
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();

                if (loading) {
                  stopMessage();
                } else {
                  sendMessage();
                }
              }
            }}
            placeholder="Scrivi un messaggio..."
            disabled={loading}
            style={{
              flex: 1,
              minHeight: "70px",
              resize: "none",
              padding: "14px",
              borderRadius: "10px",
              border: "1px solid #555",
              background: "#2f2f2f",
              color: "#fff",
              fontSize: "16px"
            }}
          />

          <button
            onClick={loading ? stopMessage : sendMessage}
            style={{
              padding: "0 22px",
              borderRadius: "10px",
              border: "none",
              cursor: "pointer",
              fontSize: "16px"
            }}
          >
            {loading ? "⏹ Stop" : "Invia"}
          </button>
        </div>
      </div>
    </main>
  );
}

