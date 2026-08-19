"use client";

/**
 * Ordence — Assistant Tabs
 * Version: v0.77.0-alpha
 *
 * A simple tab switcher between the Chat and Goal Planner modes.
 * Both are client components; this wrapper just toggles between them.
 */

import { useState } from "react";
import { Bot, Sparkles } from "lucide-react";
import { ChatClient } from "./chat-client";
import { GoalPlannerClient } from "./goal-planner-client";

type Tab = "chat" | "planner";

export function AssistantTabs() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <div className="flex h-full flex-col">
      {/* ---- tab bar ---- */}
      <div className="flex items-center gap-1 border-b border-border px-6 pt-4">
        <TabButton
          active={tab === "chat"}
          onClick={() => setTab("chat")}
          icon={<Bot className="h-4 w-4" />}
          label="Chat"
        />
        <TabButton
          active={tab === "planner"}
          onClick={() => setTab("planner")}
          icon={<Sparkles className="h-4 w-4" />}
          label="Goal Planner"
        />
      </div>

      {/* ---- content ---- */}
      <div className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatClient />}
        {tab === "planner" && <GoalPlannerClient />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
