/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // config/*.json (account mapping, audited figures, party rules) is read from disk at run time: make sure hosting ships it.
  outputFileTracingIncludes: { '/**/*': ['./config/**/*'] },
};
export default nextConfig;
