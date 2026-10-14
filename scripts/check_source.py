import ast
import io
import re
import tokenize
from pathlib import Path


def check_files(root: Path) -> list[str]:
    violations = []
    for directory in ("src", "tests", "scripts"):
        for path in sorted((root / directory).rglob("*.py")):
            source = path.read_text()
            if any(
                token.type == tokenize.COMMENT
                for token in tokenize.generate_tokens(io.StringIO(source).readline)
            ):
                violations.append(f"{path}: comment")
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if isinstance(
                    node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
                ):
                    if ast.get_docstring(node) is not None:
                        violations.append(f"{path}: docstring")
            if re.search(r"\b\d{8,}:[A-Za-z0-9_-]{30,}\b", source):
                violations.append(f"{path}: possible bot token")
    for pattern in (
        "*.toml",
        "*.yaml",
        ".github/**/*.yml",
        "Dockerfile",
        ".env.example",
        "*.txt",
        "*.lock",
        ".gitignore",
        ".dockerignore",
        "deploy/*.service",
    ):
        for path in root.glob(pattern):
            if any(line.lstrip().startswith("#") for line in path.read_text().splitlines()):
                violations.append(f"{path}: comment")
    return violations


if __name__ == "__main__":
    violations = check_files(Path(__file__).resolve().parents[1])
    if violations:
        raise SystemExit("\n".join(violations))
    print("Source policy checks passed")
