export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "project";
}

export function getAppDomain(): string {
  return process.env.NEXT_PUBLIC_APP_DOMAIN || "koli-sooty.vercel.app";
}

export function getPublishedUrls(slug: string) {
  const domain = getAppDomain();
  return {
    subdomain: `https://${slug}.${domain}`,
    path: `https://${domain}/p/${slug}`,
  };
}
