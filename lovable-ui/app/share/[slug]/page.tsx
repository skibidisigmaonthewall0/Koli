import { redirect } from "next/navigation";
import { getIframePreviewUrl, findSandbox } from "@/lib/daytona-sandbox";

export default async function SharePage({
  searchParams,
}: {
  searchParams: { sandbox?: string };
}) {
  const sandboxId = searchParams.sandbox;
  if (!sandboxId) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>Invalid share link.</p>
      </main>
    );
  }

  try {
    const sandbox = await findSandbox(sandboxId);
    const url = await getIframePreviewUrl(sandbox, 3000);
    redirect(url);
  } catch {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>This project is no longer available.</p>
      </main>
    );
  }
}
