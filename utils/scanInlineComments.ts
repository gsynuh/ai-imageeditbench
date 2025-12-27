import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

type InlineCommentHit = {
  file: string;
  line: number;
  column: number;
  placement: "full-line" | "trailing";
  content: string;
};

function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function getRepoFiles(): string[] {
  const raw = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: process.cwd() },
  );
  const files: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== 0) continue;
    if (i > start) {
      files.push(raw.slice(start, i).toString("utf8"));
    }
    start = i + 1;
  }
  if (start < raw.length) {
    files.push(raw.slice(start).toString("utf8"));
  }
  return files.filter(Boolean);
}

function getScriptKind(file: string): ts.ScriptKind | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".ts") return ts.ScriptKind.TS;
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".js") return ts.ScriptKind.JS;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".cjs") return ts.ScriptKind.JS;
  if (ext === ".mjs") return ts.ScriptKind.JS;
  if (ext === ".cts") return ts.ScriptKind.TS;
  if (ext === ".mts") return ts.ScriptKind.TS;
  return null;
}

function normalizeDoubleSlashContent(raw: string): string {
  return raw.replace(/^\/\/\s?/, "").trimEnd();
}

function isEligibleForDoubleSlashScan(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".cjs" ||
    ext === ".mjs" ||
    ext === ".cts" ||
    ext === ".mts" ||
    ext === ".scss" ||
    ext === ".sass"
  );
}

function shouldSkipDoubleSlashAtIndex(line: string, index: number): boolean {
  // Avoid treating URLs like https://example.com as comments
  if (index > 0 && line[index - 1] === ":") return true;
  return false;
}

function scanLineBasedDoubleSlashComments(
  text: string,
  relPath: string,
): InlineCommentHit[] {
  const hits: InlineCommentHit[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmedStart = line.trimStart();

    // Full-line comment: trimmed starts with //
    if (trimmedStart.startsWith("//")) {
      hits.push({
        file: relPath,
        line: i + 1,
        column: line.length - trimmedStart.length + 1,
        placement: "full-line",
        content: normalizeDoubleSlashContent(trimmedStart),
      });
      continue;
    }

    // Trailing comment: code then //
    const index = line.indexOf("//");
    if (index === -1) continue;
    if (shouldSkipDoubleSlashAtIndex(line, index)) continue;
    if (line.slice(0, index).trim().length === 0) continue;

    hits.push({
      file: relPath,
      line: i + 1,
      column: index + 1,
      placement: "trailing",
      content: normalizeDoubleSlashContent(line.slice(index)),
    });
  }

  return hits;
}

function scanTypeScriptDoubleSlashComments(
  text: string,
  relPath: string,
  scriptKind: ts.ScriptKind,
): InlineCommentHit[] {
  const sourceFile = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );

  const hits: InlineCommentHit[] = [];
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;

    const pos = scanner.getTokenPos();
    const end = scanner.getTextPos();
    const rawComment = text.slice(pos, end);

    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const prefix = text.slice(lineStart, pos);
    const placement =
      prefix.trim().length > 0 ? ("trailing" as const) : ("full-line" as const);

    const lc = ts.getLineAndCharacterOfPosition(sourceFile, pos);
    hits.push({
      file: relPath,
      line: lc.line + 1,
      column: lc.character + 1,
      placement,
      content: normalizeDoubleSlashContent(rawComment),
    });
  }

  return hits;
}

function formatHit(hit: InlineCommentHit): string {
  return `${hit.file}:${hit.line}:${hit.column}\t${hit.placement}\t//\t${hit.content}`;
}

function main() {
  const repoRoot = process.cwd();
  const files = getRepoFiles();
  const hits: InlineCommentHit[] = [];

  for (const relPath of files) {
    if (relPath === "comments.txt") continue;
    if (!isEligibleForDoubleSlashScan(relPath)) continue;
    const absPath = path.join(repoRoot, relPath);
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const buffer = fs.readFileSync(absPath);
    if (isBinary(buffer)) continue;
    const text = buffer.toString("utf8");

    // Prefer the TS scanner for JS/TS-family sources to avoid matching `//` inside strings.
    const scriptKind = getScriptKind(relPath);
    if (scriptKind) {
      hits.push(
        ...scanTypeScriptDoubleSlashComments(text, relPath, scriptKind),
      );
      continue;
    }

    // Fallback for other text files (e.g. `.scss`) where `//` is still used as a comment form.
    hits.push(...scanLineBasedDoubleSlashComments(text, relPath));
  }

  hits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  const outPath = path.join(repoRoot, "comments.txt");
  const header = [
    `Double-slash (//) comments report`,
    `Generated: ${new Date().toISOString()}`,
    `Count: ${hits.length}`,
    ``,
  ];
  fs.writeFileSync(
    outPath,
    [...header, ...hits.map(formatHit), ""].join("\n"),
    "utf8",
  );

  process.stdout.write("results in comments.txt\n");
}

main();
