"use client";

import { Suspense, useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";

interface GeneratedFile {
  path: string;
  content: string;
}

interface Message {
  type:
    | "claude_message"
    | "tool_use"
    | "progress"
    | "error"
    | "complete"
    | "user_message"
    | "sandbox_ready"
    | "heartbeat";
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
  message?: string;
  previewUrl?: string;
  sandboxId?: string;
  files?: GeneratedFile[];
}

type SidePanel = "chat" | "files";

const IDLE_WARN_MS = 2 * 60 * 1000;
const IDLE_DELETE_MS = 1 * 60 * 1000;

function GeneratePageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialPrompt = searchParams.get("prompt") || "";

  const [messages, setMessages] = useState<Message[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<GeneratedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<SidePanel>("chat");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUpInput, setFollowUpInput] = useState("");
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [showIdleWarning, setShowIdleWarning] = useState(false);
  const [idleCountdown, setIdleCountdown] = useState(60);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasStartedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());

  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setShowIdleWarning(false);
    setIdleCountdown(60);
    if (sandboxId) {
      fetch("/api/sandbox/keepalive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      }).catch(() => {});
    }
  }, [sandboxId]);

  const deleteSandbox = useCallback(async () => {
    if (!sandboxId) return;
    try {
      await fetch("/api/sandbox/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      });
    } catch {
      // ignore
    }
    setSandboxId(null);
    setPreviewUrl(null);
    setShowIdleWarning(false);
    setError("Sandbox deleted due to inactivity. Generate again to continue.");
  }, [sandboxId]);

  useEffect(() => {
    if (!sandboxId || isGenerating) return;

    const tick = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= IDLE_WARN_MS + IDLE_DELETE_MS) {
        deleteSandbox();
      } else if (idle >= IDLE_WARN_MS) {
        const remaining = Math.ceil(
          (IDLE_WARN_MS + IDLE_DELETE_MS - idle) / 1000
        );
        setShowIdleWarning(true);
        setIdleCountdown(Math.max(1, remaining));
      }
    }, 1000);

    return () => clearInterval(tick);
  }, [sandboxId, isGenerating, deleteSandbox]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const processStream = async (response: Response) => {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) throw new Error("No response body");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);

        if (data === "[DONE]") {
          setIsGenerating(false);
          break;
        }

        try {
          const message = JSON.parse(data) as Message;

          if (message.type === "heartbeat") continue;

          if (message.type === "error") {
            throw new Error(message.message);
          }

          if (message.type === "sandbox_ready" && message.sandboxId) {
            setSandboxId(message.sandboxId);
          }

          if (message.type === "complete") {
            if (message.sandboxId) setSandboxId(message.sandboxId);
            if (message.previewUrl) {
              setPreviewUrl(message.previewUrl);
            }
            if (message.files?.length) {
              setProjectFiles(message.files);
              setSelectedFile(message.files[0]?.path || null);
            }
            setIsGenerating(false);
            bumpActivity();
          } else {
            setMessages((prev) => [...prev, message]);
          }
        } catch (e) {
          if (e instanceof Error && e.message !== data) throw e;
        }
      }
    }
  };

  const runGeneration = async (body: Record<string, string>) => {
    setIsGenerating(true);
    setError(null);
    bumpActivity();

    const response = await fetch("/api/generate-daytona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      try {
        const errorData = JSON.parse(text);
        throw new Error(errorData.error || "Failed to generate website");
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message !== text) {
          throw parseError;
        }
        throw new Error(
          text.includes("<!DOCTYPE")
            ? `Server error (${response.status}). Check Vercel env vars.`
            : text || `Failed (${response.status})`
        );
      }
    }

    await processStream(response);
  };

  const generateWebsite = async () => {
    try {
      await runGeneration({ prompt: initialPrompt });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsGenerating(false);
    }
  };

  const sendFollowUp = async (e: FormEvent) => {
    e.preventDefault();
    const text = followUpInput.trim();
    if (!text || isGenerating || !sandboxId) return;

    setFollowUpInput("");
    setMessages((prev) => [...prev, { type: "user_message", content: text }]);
    bumpActivity();

    try {
      await runGeneration({
        followUp: text,
        sandboxId,
        originalPrompt: initialPrompt,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsGenerating(false);
    }
  };

  const handlePublish = async () => {
    if (!sandboxId || isPublishing) return;
    setIsPublishing(true);
    bumpActivity();

    const slug = initialPrompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30);

    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId, projectName: slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish failed");
      setPublishUrl(data.url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setIsPublishing(false);
    }
  };

  const handleKeepAlive = () => {
    bumpActivity();
  };

  useEffect(() => {
    if (!initialPrompt) {
      router.push("/");
      return;
    }
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    generateWebsite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, router]);

  const formatToolInput = (input?: Record<string, unknown>) => {
    if (!input) return "";
    if (input.file_path) return `File: ${input.file_path}`;
    return JSON.stringify(input).slice(0, 80);
  };

  const canSendFollowUp = Boolean(sandboxId) && !isGenerating;
  const activeFile = projectFiles.find((f) => f.path === selectedFile);

  return (
    <main className="h-screen bg-black flex flex-col overflow-hidden relative">
      <Navbar />
      <div className="h-16" />

      {showIdleWarning && (
        <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
          <div className="bg-gray-900 border border-yellow-600 rounded-xl p-6 max-w-md text-center">
            <p className="text-yellow-400 font-semibold text-lg mb-2">
              Sandbox will be deleted soon
            </p>
            <p className="text-gray-300 mb-4">
              You haven&apos;t chatted for 2 minutes. Click below to keep your
              project alive, or it will be deleted in{" "}
              <span className="text-white font-mono">{idleCountdown}s</span>.
            </p>
            <button
              onClick={handleKeepAlive}
              className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-medium"
            >
              Keep my project — don&apos;t delete
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="w-[32%] flex flex-col border-r border-gray-800">
          <div className="p-4 border-b border-gray-800">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-white font-semibold">Lovable</h2>
              <div className="flex gap-1">
                <button
                  onClick={() => setSidePanel("chat")}
                  className={`px-2 py-1 text-xs rounded ${sidePanel === "chat" ? "bg-gray-700 text-white" : "text-gray-500"}`}
                >
                  Chat
                </button>
                <button
                  onClick={() => setSidePanel("files")}
                  className={`px-2 py-1 text-xs rounded ${sidePanel === "files" ? "bg-gray-700 text-white" : "text-gray-500"}`}
                >
                  Files ({projectFiles.length})
                </button>
              </div>
            </div>
            <p className="text-gray-400 text-sm mt-1 break-words">{initialPrompt}</p>
            {sandboxId && !isGenerating && (
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handlePublish}
                  disabled={isPublishing}
                  className="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg"
                >
                  {isPublishing ? "Publishing..." : "Publish"}
                </button>
                {publishUrl && (
                  <a
                    href={publishUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-green-400 rounded-lg truncate max-w-[200px]"
                  >
                    {publishUrl.replace("https://", "")}
                  </a>
                )}
              </div>
            )}
          </div>

          {sidePanel === "chat" ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((message, index) => (
                <div key={index}>
                  {message.type === "user_message" && (
                    <div className="flex justify-end">
                      <div className="bg-blue-900/40 rounded-lg p-4 max-w-[90%]">
                        <p className="text-gray-200 whitespace-pre-wrap break-words">
                          {message.content}
                        </p>
                      </div>
                    </div>
                  )}
                  {message.type === "claude_message" && (
                    <div className="bg-gray-900 rounded-lg p-4">
                      <p className="text-gray-300 whitespace-pre-wrap break-words text-sm">
                        {message.content}
                      </p>
                    </div>
                  )}
                  {message.type === "tool_use" && (
                    <div className="text-gray-500 text-xs font-mono">
                      🔧 {message.name}: {formatToolInput(message.input)}
                    </div>
                  )}
                  {message.type === "progress" && (
                    <div className="text-gray-500 text-sm font-mono break-all">
                      {message.message}
                    </div>
                  )}
                </div>
              ))}
              {isGenerating && (
                <div className="flex items-center gap-2 text-gray-400">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400" />
                  <span>Working...</span>
                </div>
              )}
              {error && (
                <div className="bg-red-900/20 border border-red-700 rounded-lg p-4">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                {projectFiles.length === 0 ? (
                  <p className="text-gray-500 text-sm p-4">
                    Files appear after generation completes.
                  </p>
                ) : (
                  projectFiles.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => setSelectedFile(file.path)}
                      className={`w-full text-left px-4 py-2 text-sm font-mono border-b border-gray-800/50 hover:bg-gray-900 ${
                        selectedFile === file.path
                          ? "bg-gray-900 text-purple-400"
                          : "text-gray-400"
                      }`}
                    >
                      {file.path}
                    </button>
                  ))
                )}
              </div>
              {activeFile && (
                <pre className="h-1/2 overflow-auto p-3 text-xs text-gray-400 bg-gray-950 border-t border-gray-800 font-mono">
                  {activeFile.content}
                </pre>
              )}
            </div>
          )}

          <form onSubmit={sendFollowUp} className="p-4 border-t border-gray-800">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={followUpInput}
                onChange={(e) => {
                  setFollowUpInput(e.target.value);
                  bumpActivity();
                }}
                placeholder={
                  canSendFollowUp
                    ? "Fix bugs, add features..."
                    : "Wait for generation..."
                }
                className="flex-1 px-4 py-2 bg-gray-900 text-white rounded-lg border border-gray-800 focus:outline-none focus:border-gray-700 disabled:opacity-50 text-sm"
                disabled={!canSendFollowUp}
              />
              <button
                type="submit"
                disabled={!canSendFollowUp || !followUpInput.trim()}
                className="p-2 text-gray-400 hover:text-white disabled:opacity-30"
              >
                ↑
              </button>
            </div>
          </form>
        </div>

        <div className="w-[68%] bg-gray-950 flex items-center justify-center">
          {!previewUrl && isGenerating && (
            <div className="text-center">
              <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center mb-4 mx-auto">
                <div className="w-12 h-12 bg-gray-700 rounded-xl animate-pulse" />
              </div>
              <p className="text-gray-400">Generating code & starting preview...</p>
              {sandboxId && (
                <p className="text-gray-600 text-xs mt-2 font-mono">{sandboxId}</p>
              )}
            </div>
          )}

          {previewUrl && (
            <iframe
              key={previewUrl}
              src={previewUrl}
              className="w-full h-full border-0"
              title="Website Preview"
              allow="clipboard-read; clipboard-write"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}

          {!previewUrl && !isGenerating && (
            <div className="text-center">
              <p className="text-gray-400">Preview will appear here</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function GeneratePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-black flex items-center justify-center">
          <p className="text-gray-400">Loading...</p>
        </main>
      }
    >
      <GeneratePageContent />
    </Suspense>
  );
}
