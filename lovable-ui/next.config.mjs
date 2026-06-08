import { config } from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.join(__dirname, "../.env");

if (fs.existsSync(rootEnvPath)) {
  config({ path: rootEnvPath });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "@daytonaio/sdk",
      "@daytonaio/api-client",
      "untildify",
    ],
  },
};

export default nextConfig;
