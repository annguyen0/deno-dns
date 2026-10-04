// GitHub Pages site builder: renders the Markdown docs to standalone HTML
// pages (formatted output), while keeping the raw .md sources alongside.
//
// Usage: deno task build-site
//   (or: deno run --allow-read --allow-write src/site/render.ts)
//
// Output (_site/):
//   index.html           landing page (links to the rendered pages)
//   README.html, CHANGELOG.html
//   docs/*.html
//   raw .md copies of every source
//   .nojekyll            skip Jekyll processing on GitHub Pages

import { marked } from "marked";

const outDir = "_site";
const docsDir = "docs";

const style = `
  body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
  h1{border-bottom:1px solid #e2e2e2;padding-bottom:.4rem}
  a{color:#0969da;text-decoration:none} a:hover{text-decoration:underline}
  code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.9em;background:#f6f8fa;padding:.1em .3em;border-radius:4px}
  pre{background:#f6f8fa;padding:1em;border-radius:6px;overflow-x:auto}
  pre code{background:none;padding:0}
  table{border-collapse:collapse}
  th,td{border:1px solid #d0d7de;padding:.35em .7em}
  th{background:#f6f8fa}
`.trim();

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — deno-dns</title>
  <style>
${style}
  </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

// First "# " heading becomes the page title; fall back to the file name.
function docTitle(source: string, fallback: string): string {
  const m = source.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

// Rewrite relative *.md links (README.md, docs/X.md, sibling .md) to the
// rendered *.html pages. Absolute URLs (https://...) are left untouched.
function rewriteMdLinks(html: string): string {
  return html.replace(
    /href="((?!:\/\/)[^"#]*?)\.md(#[^"]*)?"/g,
    (_m, path: string, frag: string | undefined) =>
      `href="${path}.html${frag ?? ""}"`,
  );
}

function renderDoc(
  relPath: string, // e.g. "docs/ARCHITECTURE.md"
): { file: string; title: string } {
  const source = Deno.readTextFileSync(relPath);
  const html = rewriteMdLinks(marked.parse(source, { async: false }) as string);
  const outFile = `${outDir}/${relPath.replace(/\.md$/, ".html")}`;
  Deno.writeTextFileSync(
    outFile,
    page(docTitle(source, relPath.split("/").pop() ?? relPath), html),
  );
  Deno.copyFileSync(relPath, `${outDir}/${relPath}`); // keep raw source
  return {
    file: relPath.replace(/\.md$/, ".html"),
    title: docTitle(source, relPath.split("/").pop() ?? relPath),
  };
}

// Fresh output dir.
try {
  Deno.removeSync(outDir, { recursive: true });
} catch (e) {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
}
Deno.mkdirSync(`${outDir}/${docsDir}`, { recursive: true });

// Short labels for the landing page (fall back to the doc's own H1).
const labels: Record<string, string> = {
  "README.md": "Project overview",
  "CHANGELOG.md": "Changelog",
  "docs/ARCHITECTURE.md": "Architecture",
  "docs/SOFTWARE_DESIGN.md": "Software design",
  "docs/CONTRIBUTING.md": "Contributing",
  "docs/CODE_OF_CONDUCT.md": "Code of conduct",
};

const pages: { file: string; title: string }[] = [];

pages.push(renderDoc("README.md"));
for (const entry of Deno.readDirSync(docsDir)) {
  if (!entry.name.endsWith(".md")) continue;
  pages.push(renderDoc(`${docsDir}/${entry.name}`));
}
pages.push(renderDoc("CHANGELOG.md"));

const indexBody = [
  "<h1>deno-dns — documentation</h1>",
  "<p>DoH server (RFC 8484) on Deno + Deno KV. Doc-as-code: the docs are",
  "published as rendered HTML under <code>/docs/</code>; the raw Markdown",
  "sources stay available next to each page.</p>",
  "<ul>",
  ...pages.map((p) =>
    `  <li><a href="${p.file}">${
      labels[p.file.replace(/\.html$/, ".md")] ?? p.title
    }</a></li>`
  ),
  "</ul>",
].join("\n");

Deno.writeTextFileSync(
  `${outDir}/index.html`,
  page("deno-dns — documentation", indexBody),
);
Deno.writeTextFileSync(`${outDir}/.nojekyll`, "");

console.log(
  `site: ${pages.length + 1} pages rendered → ${outDir}/ (${
    pages.map((p) => p.file).join(", ")
  }, index.html)`,
);
