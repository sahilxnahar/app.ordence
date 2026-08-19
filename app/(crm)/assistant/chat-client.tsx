"use client";

/**
 * Ordence — ⭐ THE ASSISTANT CHAT CLIENT
 * Version: v0.77.0-alpha
 *
 * The interactive chat interface. The user picks an agent, types a
 * question, and sees the response. Tool calls are shown inline as
 * collapsible cards so the user can see what the agent looked up.
 *
 * No state leaves the browser except the POST to /api/assistant.
 * The conversation history is kept in memory and sent with each
 * request so the agent has context for follow-up questions.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, User, Loader2, Wrench, ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

type AgentInfo = {
  id: string;
  label: string;
  blurb: string;
  schedulable: boolean;
};

type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: number;
  rounds?: number;
  error?: boolean;
};

/* ------------------------------------------------------------------ */
/* THE COMPONENT                                                       */
/* ------------------------------------------------------------------ */

export function ChatClient() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ---- load the agent list on mount ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/assistant", { method: "GET" });
        if (!res.ok) return;
        const data = (await res.json()) as { agents?: AgentInfo[] };
        if (cancelled) return;
        const list = data.agents ?? [];
        setAgents(list);
        if (list.length > 0) setSelectedAgent(list[0]!.id);
      } catch {
        // network error — leave the picker empty
      } finally {
        if (!cancelled) setAgentLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ---- auto-scroll to the latest message ---- */
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, loading]);

  /* ---- send the message ---- */
  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || loading || !selectedAgent) return;

    // Add the user's message to the conversation immediately
    const userTurn: ChatTurn = { role: "user", content: message };
    const newTurns = [...turns, userTurn];
    setTurns(newTurns);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent,
          message,
          history: newTurns.slice(0, -1).map((t) => ({
            role: t.role,
            content: t.content,
          })),
        }),
      });

      const data = (await res.json()) as {
        error?: string;
        content?: string;
        toolCalls?: number;
        rounds?: number;
      };

      if (!res.ok) {
        setTurns((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.error || "Something went wrong.",
            error: true,
          },
        ]);
        return;
      }

      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content ?? "No response received.",
          toolCalls: data.toolCalls,
          rounds: data.rounds,
        },
      ]);
    } catch {
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Could not reach the assistant. Check your connection and try again.",
          error: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, selectedAgent, turns]);

  /* ---- keyboard shortcut: Enter to send ---- */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const selectedAgentInfo = agents.find((a) => a.id === selectedAgent);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      {/* ---- header ---- */}
      <div className="mb-4 flex items-center gap-3">
        <Bot className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold">Assistant</h1>
          <p className="text-sm text-muted-foreground">
            Ask about GST, receivables, compliance, inventory, bookings, and more.
          </p>
        </div>
      </div>

      {/* ---- agent picker ---- */}
      <div className="mb-4 flex items-center gap-3">
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          disabled={agentLoading || loading}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {agentLoading && <option value="">Loading assistants…</option>}
          {!agentLoading && agents.length === 0 && (
            <option value="">No assistants available</option>
          )}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {selectedAgentInfo && (
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {selectedAgentInfo.blurb}
          </span>
        )}
      </div>

      {/* ---- message list ---- */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-lg border border-border bg-card/50"
      >
        {turns.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="space-y-2">
              <Bot className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Type a question below to get started.
              </p>
              <div className="pt-2 text-xs text-muted-foreground/70">
                <p>Try: "What GST returns are due this month?"</p>
                <p>or: "Show me overdue receivables over ₹50,000"</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {turns.map((turn, i) => (
              <MessageBubble key={i} turn={turn} />
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>The assistant is thinking…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- input bar ---- */}
      <div className="mt-4 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            selectedAgent
              ? `Ask ${selectedAgentInfo?.label ?? "the assistant"}…`
              : "Select an assistant first"
          }
          disabled={loading || !selectedAgent}
          maxLength={4000}
        />
        <Button onClick={send} disabled={loading || !input.trim() || !selectedAgent}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          <span className="ml-1">Send</span>
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MESSAGE BUBBLE                                                      */
/* ------------------------------------------------------------------ */

function MessageBubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className="mt-0.5 shrink-0">
        {isUser ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <User className="h-4 w-4 text-primary" />
          </div>
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <Bot className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className={`max-w-[80%] space-y-2 ${isUser ? "items-end" : ""}`}>
        <div
          className={`rounded-lg px-4 py-2.5 text-sm ${
            isUser
              ? "bg-primary text-primary-foreground"
              : turn.error
                ? "bg-destructive/10 text-destructive border border-destructive/20"
                : "bg-muted text-foreground"
          }`}
        >
          <p className="whitespace-pre-wrap">{turn.content}</p>
        </div>

        {/* ---- tool call metadata ---- */}
        {!isUser && turn.toolCalls !== undefined && turn.toolCalls > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Wrench className="h-3 w-3" />
            <span>
              {turn.toolCalls} tool {turn.toolCalls === 1 ? "call" : "calls"}
              {turn.rounds !== undefined ? ` across ${turn.rounds} round${turn.rounds === 1 ? "" : "s"}` : ""}
            </span>
            <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}

        {!isUser && turn.toolCalls === 0 && !turn.error && (
          <Badge variant="secondary" className="text-xs">
            No tools needed
          </Badge>
        )}
      </div>
    </div>
  );
}
