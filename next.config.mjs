/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // wagmi's connectors barrel (pulled in for `injected()`) also ships a Base
    // Account connector that does `await import('@base-org/account')` — an
    // OPTIONAL wallet SDK we don't install or use. The import is guarded by a
    // try/catch and is never reached in our flow (we only use injected wallets),
    // but Next 14's webpack still tries to resolve it at build time and fails
    // ("Can't resolve '@base-org/account'"). Alias it to an empty module so the
    // build succeeds; the code path stays dead at runtime.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@base-org/account": false,
    };
    return config;
  },
};

export default nextConfig;
