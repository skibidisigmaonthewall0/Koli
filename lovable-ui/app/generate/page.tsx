"use client";

import {
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
  FormEvent,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import { slugify } from "@/lib/slug";

interface ProjectFile {
  path: string;
  content: string;
}

interface Message {
  type:
    | "claude_message"
    | "tool_use"
    | "tool_result"
    | "progress"
    | "error"
    | "complete"
    | "user_message"
    | "files";
  content?: string;
  name?: string;
  input?: any;
  message?: string;
  previewUrl?: string;
  sandboxId?: string;
  files?: ProjectFile[];
}

const IDLE_WARNING_MS = 2 * 60 * 1000;
const IDLE_DELETE_MS = 60 * 1000;

function GeneratePageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialPrompt = searchParams.get("prompt") || "";

  const [messages, setMessages] = useState<Message[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followUpInput, setFollowUpInput] = useState("");
  const [showIdleWarning, setShowIdleWarning] = useState(false);
  const [idleCountdown, setIdleCountdown] = useState(60);
  const [sandboxDeleted, setSandboxDeleted] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasStartedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const idleWarningShownAtRef = useRef<number | null>(null);
  const deletingRef = useRef(false);

  const touchActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (showIdleWarning) {
      setShowIdleWarning(false);
      idleWarningShownAtRef.current = null;
      setIdleCountdown(60);
    }
  }, [showIdleWarning]);

  const mergeFiles = useCallback((incoming: ProjectFile[]) => {
    setProjectFiles((prev) => {
      const map = new Map(prev.map((f) => [f.path, f]));
      for (const file of incoming) {
        map.set(file.path, file);
      }
      const merged = Array.from(map.values()).sort((a, b) =>
        a.path.localeCompare(b.path)
      );
      return merged;
    });
    if (incoming.length > 0 && !selectedFile) {
      setSelectedFile(incoming[0].path);
    }
  }, [selectedFile]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const processStream = async (response: Response) => {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error("No response body");
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      touchActivity();
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);

          if (data === "[DONE]") {
            setIsGenerating(false);
            touchActivity();
            break;
          }

          try {
            const message = JSON.parse(data) as Message;

            if (message.type === "error") {
              throw new Error(message.message);
            } else if (message.type === "files" && message.files) {
              mergeFiles(message.files);
            } else if (message.type === "complete") {
              if (message.sandboxId) {
                setSandboxId(message.sandboxId);
                setSandboxDeleted(false);
              }
              if (message.previewUrl) {
                const bust = message.previewUrl.includes("?")
                  ? `&t=${Date.now()}`
                  : `?t=${Date.now()}`;
                setPreviewUrl(message.previewUrl + bust);
              }
              if (message.files) {
                mergeFiles(message.files);
              }
              setIsGenerating(false);
              touchActivity();
            } else {
              setMessages((prev) => [...prev, message]);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== data) {
              throw e;
            }
          }
        }
      }
    }
  };

  const runGeneration = async (body: Record<string, string>) => {
    setIsGenerating(true);
    setError(null);
    touchActivity();

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
      console.error("Error generating website:", err);
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsGenerating(false);
    }
  };

  const sendFollowUp = async (e: FormEvent) => {
    e.preventDefault();
    const text = followUpInput.trim();
    if (!text || isGenerating || !sandboxId) return;

    setFollowUpInput("");
    touchActivity();
    setMessages((prev) => [
      ...prev,
      { type: "user_message", content: text },
    ]);

    try {
      await runGeneration({
        followUp: text,
        sandboxId,
        originalPrompt: initialPrompt,
      });
    } catch (err: unknown) {
      console.error("Error applying follow-up:", err);
      setError(err instanceof Error ? err.message : "An error occurred");
      setIsGenerating(false);
    }
  };

  const deleteSandbox = useCallback(async () => {
    if (!sandboxId || deletingRef.current) return;
    deletingRef.current = true;

    try {
      await fetch("/api/sandbox", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      });
    } catch {
      // Best effort
    }

    setSandboxId(null);
    setPreviewUrl(null);
    setSandboxDeleted(true);
    setShowIdleWarning(false);
    deletingRef.current = false;
  }, [sandboxId]);

  const keepSandboxAlive = () => {
    touchActivity();
  };

  const publishSite = async () => {
    if (!sandboxId || isPublishing) return;

    setIsPublishing(true);
    setError(null);
    touchActivity();

    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          projectName: initialPrompt,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Publish failed");
      }

      setPublishedUrl(data.url || data.pathUrl);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setIsPublishing(false);
    }
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

  useEffect(() => {
    if (!sandboxId || isGenerating || sandboxDeleted) return;

    const interval = setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current;

      if (!showIdleWarning && idleFor >= IDLE_WARNING_MS) {
        setShowIdleWarning(true);
        idleWarningShownAtRef.current = Date.now();
        setIdleCountdown(60);
        return;
      }

      if (showIdleWarning && idleWarningShownAtRef.current) {
        const sinceWarning = Date.now() - idleWarningShownAtRef.current;
        const remaining = Math.max(
          0,
          Math.ceil((IDLE_DELETE_MS - sinceWarning) / 1000)
        );
        setIdleCountdown(remaining);

        if (sinceWarning >= IDLE_DELETE_MS) {
          deleteSandbox();
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [
    sandboxId,
    isGenerating,
    showIdleWarning,
    sandboxDeleted,
    deleteSandbox,
  ]);

  useEffect(() => {
    if (projectFiles.length > 0 && !selectedFile) {
      setSelectedFile(projectFiles[0].path);
    }
  }, [projectFiles, selectedFile]);

  const formatToolInput = (input: any) => {
    if (!input) return "";
    if (input.file_path) return `File: ${input.file_path}`;
    if (input.command) return `Command: ${input.command}`;
    return JSON.stringify(input).substring(0, 100);
  };

  const canSendFollowUp = Boolean(sandboxId) && !isGenerating && !sandboxDeleted;
  const selectedContent =
    projectFiles.find((f) => f.path === selectedFile)?.content || "";

  const projectSlug = slugify(initialPrompt);

  return (
    <main className="h-screen bg-black flex flex-col overflow-hidden relative">
      <Navbar />
      <div className="h-16" />

      {showIdleWarning && sandboxId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-amber-600/50 rounded-xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-amber-400 font-semibold text-lg mb-2">
              Sandbox will be deleted soon
            </h3>
            <p className="text-gray-300 text-sm mb-4">
              You haven&apos;t chatted for 2 minutes. Click below to keep your
              sandbox alive and continue editing. Otherwise it deletes itself in{" "}
              <span className="text-white font-mono">{idleCountdown}s</span>.
            </p>
            <button
              onClick={keepSandboxAlive}
              className="w-full py-3 bg-amber-600 hover:bg-amber-500 text-black font-semibold rounded-lg transition-colors"
            >
              Don&apos;t delete — keep chatting
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Chat */}
        <div className="w-[26%] min-w-[220px] flex flex-col border-r border-gray-800">
          <div className="p-4 border-b border-gray-800">
            <h2 className="text-white font-semibold">Lovable</h2>
            <p className="text-gray-400 text-sm mt-1 break-words">
              {initialPrompt}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 overflow-x-hidden">
            {messages.map((message, index) => (
              <div key={index}>
                {message.type === "user_message" && (
                  <div className="flex justify-end">
                    <div className="bg-blue-900/40 rounded-lg p-4 max-w-[90%]">
                      <p className="text-gray-200 whitespace-pre-wrap break-words text-sm">
                        {message.content}
                      </p>
                    </div>
                  </div>
                )}

                {message.type === "claude_message" && (
                  <div className="bg-gray-900 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 bg-purple-600 rounded-full flex items-center justify-center">
                        <span className="text-white text-xs">L</span>
                      </div>
                      <span className="text-white font-medium text-sm">
                        Lovable
                      </span>
                    </div>
                    <p className="text-gray-300 whitespace-pre-wrap break-words text-sm">
                      {message.content}
                    </p>
                  </div>
                )}

                {message.type === "tool_use" && (
                  <div className="bg-gray-900/50 rounded-lg p-3 border border-gray-800">
                    <div className="flex items-start gap-2 text-xs">
                      <span className="text-blue-400">🔧 {message.name}</span>
                      <span className="text-gray-500 break-all">
                        {formatToolInput(message.input)}
                      </span>
                    </div>
                  </div>
                )}

                {message.type === "progress" && (
                  <div className="text-gray-500 text-xs font-mono break-all">
                    {message.message}
                  </div>
                )}
              </div>
            ))}

            {isGenerating && (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400" />
                <span>Working...</span>
              </div>
            )}

            {sandboxDeleted && (
              <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm text-gray-400">
                Sandbox deleted due to inactivity. Refresh to start a new build.
              </div>
            )}

            {error && (
              <div className="bg-red-900/20 border border-red-700 rounded-lg p-3">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={sendFollowUp}
            className="p-4 border-t border-gray-800"
            onFocus={touchActivity}
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={followUpInput}
                onChange={(e) => {
                  setFollowUpInput(e.target.value);
                  touchActivity();
                }}
                placeholder={
                  canSendFollowUp
                    ? "Fix bugs, add features..."
                    : isGenerating
                      ? "Generating..."
                      : "Chat unavailable"
                }
                className="flex-1 px-3 py-2 text-sm bg-gray-900 text-white rounded-lg border border-gray-800 focus:outline-none focus:border-gray-700 disabled:opacity-50"
                disabled={!canSendFollowUp}
              />
              <button
                type="submit"
                disabled={!canSendFollowUp || !followUpInput.trim()}
                className="p-2 text-gray-400 hover:text-white disabled:opacity-30"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </button>
            </div>
          </form>
        </div>

        {/* Files */}
        <div className="w-[24%] min-w-[200px] flex flex-col border-r border-gray-800">
          <div className="p-3 border-b border-gray-800 flex items-center justify-between">
            <h3 className="text-white text-sm font-semibold">Files</h3>
            <span className="text-gray-500 text-xs">
              {projectFiles.length} files
            </span>
          </div>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="overflow-y-auto max-h-[40%] border-b border-gray-800">
              {projectFiles.length === 0 ? (
                <p className="text-gray-600 text-xs p-3">
                  Files appear here after generation
                </p>
              ) : (
                projectFiles.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => {
                      setSelectedFile(file.path);
                      touchActivity();
                    }}
                    className={`w-full text-left px-3 py-2 text-xs font-mono truncate hover:bg-gray-900 ${
                      selectedFile === file.path
                        ? "bg-gray-900 text-white"
                        : "text-gray-400"
                    }`}
                  >
                    {file.path}
                  </button>
                ))
              )}
            </div>

            <div className="flex-1 overflow-auto p-3">
              {selectedFile ? (
                <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-all">
                  {selectedContent}
                </pre>
              ) : (
                <p className="text-gray-600 text-xs">Select a file</p>
              )}
            </div>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 flex flex-col bg-gray-950">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
            <span className="text-gray-400 text-sm">Preview</span>
            <div className="flex items-center gap-2">
              {publishedUrl && (
                <a
                  href={publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-green-400 hover:underline truncate max-w-[200px]"
                >
                  {publishedUrl}
                </a>
              )}
              <button
                onClick={publishSite}
                disabled={!sandboxId || isPublishing || isGenerating}
                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-lg hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isPublishing ? "Publishing..." : "Publish"}
              </button>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-center">
            {!previewUrl && isGenerating && (
              <div className="text-center">
                <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center mb-4 mx-auto">
                  <div className="w-12 h-12 bg-gray-700 rounded-xl animate-pulse" />
                </div>
                <p className="text-gray-400 text-sm">Spinning up preview...</p>
                <p className="text-gray-600 text-xs mt-2">
                  Usually 1–3 minutes with fast model
                </p>
              </div>
            )}

            {previewUrl && (
              <iframe
                key={previewUrl}
                src={previewUrl}
                className="w-full h-full"
                title="Website Preview"
              />
            )}

            {!previewUrl && !isGenerating && (
              <div className="text-center">
                <p className="text-gray-400 text-sm">Preview will appear here</p>
                {sandboxId && (
                  <p className="text-gray-600 text-xs mt-1">
                    Publish as{" "}
                    <span className="text-gray-400">
                      {projectSlug}.koli-sooty.vercel.app
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>
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
