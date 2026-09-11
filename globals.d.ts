// globals.d.ts — ambient module declarations for non-TS asset imports.
//
// Build infra (not frontend code): lets `tsc --noEmit` resolve style/asset
// side-effect imports the same way the Next/webpack bundler does. Without this,
// a bare `import "./globals.css"` has no type to resolve to under
// moduleResolution: "Bundler" (allowArbitraryExtensions unset) and raw tsc
// reports TS2307 — even though `next build` compiles it fine. Declaring the
// wildcards keeps our `npm run typecheck` green and matches the deploy build.
//
// next ships no `declare module "*.css"`, so these do not conflict; multiple
// ambient wildcard declarations merge harmlessly.

// Global stylesheet side-effect imports: `import "./globals.css"`.
declare module "*.css";
declare module "*.scss";
declare module "*.sass";

// CSS Modules: `import styles from "./x.module.css"` → a class-name map.
declare module "*.module.css" {
  const classes: { readonly [name: string]: string };
  export default classes;
}
declare module "*.module.scss" {
  const classes: { readonly [name: string]: string };
  export default classes;
}
declare module "*.module.sass" {
  const classes: { readonly [name: string]: string };
  export default classes;
}

// Static asset imports occasionally used from components (kept broad; next also
// provides image typings via next/image-types/global for next/image usage).
declare module "*.svg" {
  const src: string;
  export default src;
}
