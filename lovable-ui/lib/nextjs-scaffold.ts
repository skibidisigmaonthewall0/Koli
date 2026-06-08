interface ScaffoldFile {
  path: string;
  content: string;
}

export function getNextJsScaffold(): ScaffoldFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: "generated-site",
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
          },
          dependencies: {
            next: "14.2.3",
            react: "^18",
            "react-dom": "^18",
          },
          devDependencies: {
            "@types/node": "^20",
            "@types/react": "^18",
            "@types/react-dom": "^18",
            autoprefixer: "^10",
            postcss: "^8",
            tailwindcss: "^3.4.1",
            typescript: "^5",
          },
        },
        null,
        2
      ),
    },
    {
      path: "next.config.mjs",
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`,
    },
    {
      path: "tsconfig.json",
      content: `{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`,
    },
    {
      path: "postcss.config.mjs",
      content: `const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
export default config;
`,
    },
    {
      path: "tailwind.config.ts",
      content: `import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
export default config;
`,
    },
    {
      path: "app/globals.css",
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-gray-950 text-white min-h-screen;
}
`,
    },
    {
      path: "app/layout.tsx",
      content: `import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Generated App",
  description: "Built with Lovable clone",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
  ];
}
