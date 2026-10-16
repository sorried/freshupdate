import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const violations = [];
for (const file of new Set(files)) {
  if (!file || file === "LICENSE" || file.endsWith(".md")) continue;
  if (file.endsWith(".py")) {
    violations.push(`${file}: legacy Python source`);
    continue;
  }
  const source = readFileSync(file, "utf8");
  if (/\.(ts|mjs)$/.test(file)) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const inspect = (node) => {
      if (
        ts.getLeadingCommentRanges(source, node.pos)?.length ||
        ts.getTrailingCommentRanges(source, node.end)?.length
      ) {
        violations.push(`${file}: comment`);
      }
      for (const child of node.getChildren(tree)) inspect(child);
    };
    inspect(tree);
  } else if (
    !file.endsWith(".json") &&
    source.split("\n").some((line) => line.trimStart().startsWith("#"))
  ) {
    violations.push(`${file}: comment`);
  }
  if (
    /\b\d{8,}:[A-Za-z0-9_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/.test(
      source,
    )
  ) {
    violations.push(`${file}: possible secret`);
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Source policy and secret checks passed");
}
