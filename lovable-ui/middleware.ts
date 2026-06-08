import { NextRequest, NextResponse } from "next/server";

const APP_DOMAIN =
  process.env.NEXT_PUBLIC_APP_DOMAIN || "koli-sooty.vercel.app";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  const { pathname } = request.nextUrl;

  if (
    host.endsWith(`.${APP_DOMAIN}`) &&
    host !== APP_DOMAIN &&
    host !== `www.${APP_DOMAIN}`
  ) {
    const slug = host.replace(`.${APP_DOMAIN}`, "");
    if (slug && !slug.includes(".")) {
      const suffix = pathname === "/" ? "" : pathname;
      return NextResponse.rewrite(
        new URL(`/p/${slug}${suffix}`, request.url)
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
