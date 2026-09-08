// GENERATED FILE. Do not edit by hand.
// The canonical open-source bill of materials for the downpipes product, the
// source for the "open-source licences" view. Regenerate with: node tools/gen-sbom.mjs
// Generated.

export interface SbomDependency {
  name: string;
  version: string;
  licence: string;
  url: string;
  purpose: string;
}

export interface SbomComponent {
  key: string;
  name: string;
  lang: string;
  blurb: string;
  note?: string;
  runtime: SbomDependency[];
}

export interface Sbom {
  generatedAt: string;
  downloadUrl: string;
  summary: {
    components: number;
    runtimePackages: number;
    toolingPackages: number;
    totalPackages: number;
    licences: Record<string, number>;
  };
  components: SbomComponent[];
  tooling: SbomDependency[];
}

export const SBOM: Sbom = {
  "generatedAt": "2026-06-29",
  "downloadUrl": "https://downpipes.io/sbom.cdx.json",
  "summary": {
    "components": 6,
    "runtimePackages": 7,
    "toolingPackages": 29,
    "totalPackages": 1198,
    "licences": {
      "MIT": 991,
      "Apache-2.0": 53,
      "ISC": 50,
      "MPL-2.0": 25,
      "BSD-2-Clause": 17,
      "BSD-3-Clause": 16,
      "MIT OR Apache-2.0": 14,
      "LGPL-3.0-or-later": 10,
      "BlueOak-1.0.0": 9,
      "Apache-2.0 AND LGPL-3.0-or-later": 3,
      "CC0-1.0": 3,
      "0BSD": 2,
      "Apache-2.0 AND LGPL-3.0-or-later AND MIT": 1,
      "Python-2.0": 1,
      "CC-BY-4.0": 1,
      "(BSD-2-Clause OR MIT OR Apache-2.0)": 1,
      "(MIT OR CC0-1.0)": 1
    }
  },
  "components": [
    {
      "key": "reader",
      "name": "Offline reader",
      "lang": "Go",
      "blurb": "The standalone, MIT-licensed verifier and restorer. It reads an archive and recovers your data with your own keys, with no vendor in the loop. Distributed to you as a single binary, so its dependencies travel with it.",
      "runtime": [
        {
          "name": "Go standard library",
          "version": "1.26",
          "licence": "BSD-3-Clause",
          "url": "https://go.dev",
          "purpose": "The Go programming language and its standard library, which the offline reader is built on."
        },
        {
          "name": "golang.org/x/crypto",
          "version": "v0.52.0",
          "licence": "BSD-3-Clause",
          "url": "https://pkg.go.dev/golang.org/x/crypto",
          "purpose": "Supplementary cryptography for Go, maintained by the Go team."
        },
        {
          "name": "filippo.io/mldsa",
          "version": "v0.0.0-20260215214346-43d0283efc3e",
          "licence": "BSD-3-Clause",
          "url": "https://pkg.go.dev/filippo.io/mldsa",
          "purpose": "ML-DSA (FIPS 204) digital signatures for Go. By Filippo Valsorda."
        }
      ]
    },
    {
      "key": "console",
      "name": "Console",
      "lang": "TypeScript",
      "blurb": "The in-account web console you administer downpipes from. It runs entirely in your browser and signs and encrypts on the client, so the only third-party code it ships is the cryptography below.",
      "runtime": [
        {
          "name": "@noble/curves",
          "version": "2.2.0",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-curves",
          "purpose": "Audited, dependency-free elliptic-curve cryptography (ECDSA, EdDSA, ECDH, BLS). By Paul Miller."
        },
        {
          "name": "@noble/hashes",
          "version": "2.2.0",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-hashes",
          "purpose": "Audited, dependency-free hash functions: SHA2, SHA3, BLAKE, HMAC, HKDF, PBKDF2 and Argon2. By Paul Miller."
        },
        {
          "name": "@noble/post-quantum",
          "version": "0.6.1",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-post-quantum",
          "purpose": "Post-quantum cryptography: ML-KEM (FIPS 203), ML-DSA (FIPS 204) and SLH-DSA (FIPS 205). By Paul Miller."
        }
      ]
    },
    {
      "key": "engine",
      "name": "Engine",
      "lang": "TypeScript",
      "blurb": "The backup and restore engine that runs as a Cloudflare Worker in your own account. It seals, encrypts and verifies every archive.",
      "runtime": [
        {
          "name": "@noble/curves",
          "version": "2.2.0",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-curves",
          "purpose": "Audited, dependency-free elliptic-curve cryptography (ECDSA, EdDSA, ECDH, BLS). By Paul Miller."
        },
        {
          "name": "@noble/post-quantum",
          "version": "0.6.1",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-post-quantum",
          "purpose": "Post-quantum cryptography: ML-KEM (FIPS 203), ML-DSA (FIPS 204) and SLH-DSA (FIPS 205). By Paul Miller."
        }
      ]
    },
    {
      "key": "control-plane",
      "name": "Control plane",
      "lang": "TypeScript",
      "blurb": "The small licensing service we operate to issue and verify commercial licences. It never receives your backup data or your keys.",
      "runtime": [
        {
          "name": "@noble/curves",
          "version": "2.2.0",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-curves",
          "purpose": "Audited, dependency-free elliptic-curve cryptography (ECDSA, EdDSA, ECDH, BLS). By Paul Miller."
        },
        {
          "name": "@noble/post-quantum",
          "version": "0.6.1",
          "licence": "MIT",
          "url": "https://github.com/paulmillr/noble-post-quantum",
          "purpose": "Post-quantum cryptography: ML-KEM (FIPS 203), ML-DSA (FIPS 204) and SLH-DSA (FIPS 205). By Paul Miller."
        }
      ]
    },
    {
      "key": "website",
      "name": "Website",
      "lang": "Astro",
      "blurb": "This site.",
      "note": "Ships as static HTML and CSS. No JavaScript framework or runtime dependency is sent to your browser; the projects below build it.",
      "runtime": []
    },
    {
      "key": "docs",
      "name": "Documentation",
      "lang": "Astro",
      "blurb": "The documentation site, docs.downpipes.io. Its interactive pieces ship a small, React-compatible runtime.",
      "runtime": [
        {
          "name": "preact",
          "version": "10.29.1",
          "licence": "MIT",
          "url": "https://preactjs.com",
          "purpose": "A fast, 3kB React-compatible UI library, used for the interactive pieces of the documentation site."
        }
      ]
    }
  ],
  "tooling": [
    {
      "name": "@astrojs/check",
      "version": "0.9.9",
      "licence": "MIT",
      "url": "https://docs.astro.build",
      "purpose": "The type and diagnostics checker for Astro projects."
    },
    {
      "name": "@astrojs/mdx",
      "version": "5.0.3",
      "licence": "MIT",
      "url": "https://docs.astro.build",
      "purpose": "MDX (Markdown with components) support for Astro."
    },
    {
      "name": "@astrojs/preact",
      "version": "5.1.1",
      "licence": "MIT",
      "url": "https://docs.astro.build",
      "purpose": "The Preact renderer integration for Astro."
    },
    {
      "name": "@astrojs/rss",
      "version": "4.0.18",
      "licence": "MIT",
      "url": "https://docs.astro.build",
      "purpose": "RSS feed generation for Astro."
    },
    {
      "name": "@astrojs/sitemap",
      "version": "3.7.3",
      "licence": "MIT",
      "url": "https://docs.astro.build",
      "purpose": "Automatic sitemap generation for Astro."
    },
    {
      "name": "@biomejs/biome",
      "version": "2.5.0",
      "licence": "MIT OR Apache-2.0",
      "url": "https://biomejs.dev",
      "purpose": "The formatter and linter that keep the source consistent."
    },
    {
      "name": "@cloudflare/vitest-pool-workers",
      "version": "0.16.18",
      "licence": "MIT",
      "url": "https://github.com/cloudflare/workers-sdk",
      "purpose": "Runs the test suite inside the real Workers runtime."
    },
    {
      "name": "@cloudflare/workers-types",
      "version": "4.20260619.1",
      "licence": "MIT OR Apache-2.0",
      "url": "https://github.com/cloudflare/workerd",
      "purpose": "TypeScript types for the Cloudflare Workers runtime."
    },
    {
      "name": "@stryker-mutator/core",
      "version": "9.6.1",
      "licence": "Apache-2.0",
      "url": "https://stryker-mutator.io",
      "purpose": "Mutation testing, to check the tests actually catch regressions."
    },
    {
      "name": "@stryker-mutator/vitest-runner",
      "version": "9.6.1",
      "licence": "Apache-2.0",
      "url": "https://stryker-mutator.io",
      "purpose": "The Vitest runner for Stryker mutation testing."
    },
    {
      "name": "@tailwindcss/typography",
      "version": "0.5.19",
      "licence": "MIT",
      "url": "https://github.com/tailwindlabs/tailwindcss-typography",
      "purpose": "Typographic defaults for long-form documentation content."
    },
    {
      "name": "@tailwindcss/vite",
      "version": "4.2.2",
      "licence": "MIT",
      "url": "https://tailwindcss.com",
      "purpose": "The Tailwind CSS plugin for the Vite build pipeline."
    },
    {
      "name": "@types/node",
      "version": "25.9.2",
      "licence": "MIT",
      "url": "https://github.com/DefinitelyTyped/DefinitelyTyped",
      "purpose": "TypeScript types for the Node.js APIs the tooling uses."
    },
    {
      "name": "@vitest/coverage-istanbul",
      "version": "4.1.9",
      "licence": "MIT",
      "url": "https://vitest.dev/guide/coverage",
      "purpose": "Istanbul code-coverage instrumentation for Vitest."
    },
    {
      "name": "@vitest/coverage-v8",
      "version": "4.1.9",
      "licence": "MIT",
      "url": "https://vitest.dev/guide/coverage",
      "purpose": "V8 code-coverage instrumentation for Vitest."
    },
    {
      "name": "ajv",
      "version": "8.18.0",
      "licence": "MIT",
      "url": "https://ajv.js.org",
      "purpose": "JSON Schema validator used to check archive and configuration shapes."
    },
    {
      "name": "astro",
      "version": "6.4.8",
      "licence": "MIT",
      "url": "https://astro.build",
      "purpose": "The web framework the website and documentation are built with."
    },
    {
      "name": "c8",
      "version": "10.1.3",
      "licence": "ISC",
      "url": "https://github.com/bcoe/c8",
      "purpose": "Native V8 code-coverage reporting for the validator suite."
    },
    {
      "name": "cheerio",
      "version": "1.2.0",
      "licence": "MIT",
      "url": "https://cheerio.js.org",
      "purpose": "Server-side HTML parsing used in the documentation tests."
    },
    {
      "name": "esbuild",
      "version": "0.28.1",
      "licence": "MIT",
      "url": "https://esbuild.github.io",
      "purpose": "The bundler that builds the in-browser console."
    },
    {
      "name": "fast-check",
      "version": "4.8.0",
      "licence": "MIT",
      "url": "https://fast-check.dev",
      "purpose": "Property-based testing."
    },
    {
      "name": "knip",
      "version": "6.17.1",
      "licence": "ISC",
      "url": "https://knip.dev",
      "purpose": "Finds unused files, dependencies and exports."
    },
    {
      "name": "madge",
      "version": "8.0.0",
      "licence": "MIT",
      "url": "https://github.com/pahen/madge",
      "purpose": "Detects circular dependencies in the module graph."
    },
    {
      "name": "pagefind",
      "version": "1.5.2",
      "licence": "MIT",
      "url": "https://pagefind.app",
      "purpose": "The static, privacy-respecting search index for the documentation site."
    },
    {
      "name": "puppeteer",
      "version": "25.1.0",
      "licence": "Apache-2.0",
      "url": "https://pptr.dev",
      "purpose": "Headless Chromium used for documentation build checks."
    },
    {
      "name": "tailwindcss",
      "version": "4.2.2",
      "licence": "MIT",
      "url": "https://tailwindcss.com",
      "purpose": "The utility-first CSS framework used across the interfaces."
    },
    {
      "name": "typescript",
      "version": "6.0.3",
      "licence": "Apache-2.0",
      "url": "https://www.typescriptlang.org",
      "purpose": "The typed superset of JavaScript the product is written in."
    },
    {
      "name": "vitest",
      "version": "4.1.9",
      "licence": "MIT",
      "url": "https://vitest.dev",
      "purpose": "The unit and integration test runner."
    },
    {
      "name": "wrangler",
      "version": "4.103.0",
      "licence": "MIT OR Apache-2.0",
      "url": "https://developers.cloudflare.com/workers/wrangler/",
      "purpose": "Cloudflare's command-line tool for building and deploying Workers."
    }
  ]
};
