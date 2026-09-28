#!/usr/bin/env python3
"""Reproducibly snapshot Gurow and publish a coherent Graphify brain generation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

SCHEMA_VERSION = 1
PROMPT_FILE = Path("/home/harkon666/.codex/skills/graphify/references/extraction-spec.md")
OWN_FILES = {
    "scripts/graphify_brain.py",
    "scripts/test_graphify_brain.py",
    "docs/agents/graphify.md",
}
UNTRACKED_ROOTS = (
    "docs/architecture/",
    "docs/benchmarks/p1/",
    "docs/research/",
    "docs/tickets/t06-l3/",
)
FRONTEND_BENCHMARK = "frontend/scripts/benchmark/"
NORMATIVE_JSON = {
    "docs/benchmarks/p1/protocol.json",
    "docs/benchmarks/p1/reference-environment.json",
    "docs/tickets/t06-l3/manifest.json",
}
CODE_SUFFIXES = {".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".css", ".wgsl", ".toml", ".json"}
DOC_SUFFIXES = {".md"}
EXCLUDED_PARTS = {
    ".agent", ".agents", ".codex", ".git", ".github", ".vscode", "node_modules",
    "target", ".output", "dist", "build", "coverage", "vendor", "__pycache__",
}
EXCLUDED_NAMES = {"AGENTS.md", "GEMINI.md", "GRILL_WITH_DOCS_PROMPT.md", "Cargo.lock"}
SECRET_RE = re.compile(r"(^|[._-])(secret|credential|credentials|token|private[-_]?key)([._-]|$)", re.I)


class PipelineError(RuntimeError):
    pass


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(data, encoding="utf-8")
    os.replace(temporary, path)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PipelineError(f"cannot read JSON {path}: {exc}") from exc


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)
    return result.stdout.rstrip("\n")


def is_ignored(repo: Path, relative: str) -> bool:
    result = subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", "--", relative])
    return result.returncode == 0


def allowed_untracked(relative: str) -> bool:
    suffix = PurePosixPath(relative).suffix.lower()
    if relative in OWN_FILES:
        return suffix in CODE_SUFFIXES | DOC_SUFFIXES
    if relative.startswith(UNTRACKED_ROOTS):
        return suffix in DOC_SUFFIXES | {".json"}
    if relative.startswith(FRONTEND_BENCHMARK):
        return suffix in CODE_SUFFIXES
    return False


def exclusion_reason(repo: Path, relative: str, tracked: bool) -> str | None:
    path = PurePosixPath(relative)
    source = repo / relative
    if source.is_symlink():
        return "symbolic link"
    if not source.is_file():
        return "missing or non-file"
    if any(part in EXCLUDED_PARTS for part in path.parts):
        return "generated, dependency, or agent directory"
    if path.name in EXCLUDED_NAMES or path.name.startswith("."):
        return "agent instruction, lock, or hidden file"
    if path.name.endswith(".issue.md"):
        return "duplicate issue contract snapshot; canonical ticket packet retained"
    if SECRET_RE.search(path.name) or path.suffix.lower() in {".pem", ".key", ".p12", ".env"}:
        return "potential secret"
    if ".gen." in path.name or path.suffix.lower() in {".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".wasm"}:
        return "generated, dependency lock, or binary"
    if is_ignored(repo, relative):
        return "git-ignored"
    if path.suffix.lower() not in CODE_SUFFIXES | DOC_SUFFIXES:
        return "unsupported corpus type"
    if not tracked and not allowed_untracked(relative):
        return "untracked path is not explicitly allowlisted"
    return None


def inventory(repo: Path) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    tracked = {p for p in git(repo, "ls-files", "-z").split("\0") if p}
    untracked = {p for p in git(repo, "ls-files", "--others", "--exclude-standard", "-z").split("\0") if p}
    records: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []
    for relative in sorted(tracked | untracked):
        reason = exclusion_reason(repo, relative, relative in tracked)
        if reason:
            excluded.append({"repository_path": relative, "reason": reason})
            continue
        data = (repo / relative).read_bytes()
        records.append({
            "repository_path": relative,
            "source_file": "sources/repository/" + relative,
            "sha256": sha256_bytes(data),
            "bytes": len(data),
            "tracked": relative in tracked,
            "kind": "semantic" if PurePosixPath(relative).suffix.lower() in DOC_SUFFIXES or relative in NORMATIVE_JSON else "structural",
        })
    return records, excluded


def generation_id(records: list[dict[str, Any]]) -> str:
    try:
        from importlib.metadata import version
        graphify_version = version("graphifyy")
    except Exception:
        graphify_version = "unknown"
    identity = {
        "schema": SCHEMA_VERSION,
        "graphify": graphify_version,
        "prompt_sha256": sha256_file(PROMPT_FILE),
        "files": [{"path": r["repository_path"], "sha256": r["sha256"]} for r in records],
    }
    return sha256_bytes(canonical_json(identity))[:16]


def normalize_source(source: str, brain: Path) -> str:
    marker = "/sources/repository/"
    if marker in source.replace("\\", "/"):
        return "sources/repository/" + source.replace("\\", "/").split(marker, 1)[1]
    path = Path(source)
    if path.is_absolute():
        try:
            return path.relative_to(brain).as_posix()
        except ValueError:
            return source
    return PurePosixPath(source).as_posix()


def prepare(repo: Path, brain: Path) -> dict[str, Any]:
    repo = repo.resolve(); brain = brain.resolve()
    records, excluded = inventory(repo)
    gid = generation_id(records)
    published = brain / "generations" / gid
    if published.is_dir():
        verify_generation(published, require_queries=True)
        result = {"generation": gid, "published": str(published), "status": "already-ready", "snapshot_files": len(records)}
        print(json.dumps(result, indent=2))
        return result
    staging = brain / "staging" / gid
    if staging.exists():
        existing = read_json(staging / "metadata/snapshot.json") if (staging / "metadata/snapshot.json").is_file() else {}
        if existing.get("generation") == gid:
            result = {"generation": gid, "staging": str(staging), "preserved": True, "semantic_request": str(staging / "metadata/semantic-request.json")}
            print(json.dumps(result, indent=2))
            return result
        raise PipelineError(f"refusing to replace existing staging directory: {staging}")
    sources = staging / "sources/repository"
    sources.mkdir(parents=True)
    for record in records:
        source = repo / record["repository_path"]
        # Detect edits between hashing and copying; never stamp bytes we did not hash.
        data = source.read_bytes()
        if sha256_bytes(data) != record["sha256"]:
            raise PipelineError(f"source changed during prepare: {record['repository_path']}")
        destination = sources / record["repository_path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    by_source = {r["source_file"]: r for r in records if r["kind"] == "semantic"}
    try:
        from graphify.cache import load_cached
    except ImportError as exc:
        raise PipelineError("prepare must run with the Graphify Python interpreter") from exc
    semantic_paths = [str(staging / source) for source in sorted(by_source)]
    cached_nodes: list[dict[str, Any]] = []; cached_edges: list[dict[str, Any]] = []
    cached_hypers: list[dict[str, Any]] = []; uncached: list[str] = []
    for semantic_path in semantic_paths:
        hit = load_cached(Path(semantic_path), root=staging, kind="semantic", cache_root=brain,
                          prompt_file=str(PROMPT_FILE), allow_legacy=False)
        if hit is None:
            uncached.append(semantic_path)
        else:
            cached_nodes.extend(hit.get("nodes", [])); cached_edges.extend(hit.get("edges", []))
            cached_hypers.extend(hit.get("hyperedges", []))
    seed = normalize_extraction_sources(
        {"nodes": cached_nodes, "edges": cached_edges, "hyperedges": cached_hypers}, staging, brain
    )
    uncached_sources = {normalize_source(path, brain) for path in uncached}
    seeded = {normalize_source(str(n.get("source_file", "")), brain) for n in seed["nodes"]}
    requests = []
    for source, record in sorted(by_source.items()):
        requests.append({
            "source_file": source,
            "absolute_source_file": str(staging / source),
            "repository_path": record["repository_path"],
            "sha256": record["sha256"],
            "cache_status": "miss" if source in uncached_sources else "reused",
            "extraction_required": source in uncached_sources or source not in seeded,
        })
    snapshot = {
        "schema_version": SCHEMA_VERSION,
        "generation": gid,
        "repository": str(repo),
        "brain": str(brain),
        "commit": git(repo, "rev-parse", "HEAD"),
        "branch": git(repo, "branch", "--show-current"),
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "files": records,
        "excluded": excluded,
    }
    snapshot["fingerprint"] = sha256_bytes(canonical_json(snapshot["files"]))
    write_json(staging / "metadata/snapshot.json", snapshot)
    write_json(staging / "metadata/semantic-seed.json", seed)
    request = {"schema_version": SCHEMA_VERSION, "generation": gid, "snapshot_fingerprint": snapshot["fingerprint"], "files": requests}
    request["fingerprint"] = sha256_bytes(canonical_json(request["files"]))
    write_json(staging / "metadata/semantic-request.json", request)
    (brain / "graphify-out").mkdir(parents=True, exist_ok=True)
    (brain / "graphify-out/.needs_update").write_text(f"generation {gid} prepared; build and verification pending\n", encoding="utf-8")
    result = {"generation": gid, "staging": str(staging), "snapshot_files": len(records), "semantic_files": len(requests), "semantic_required": sum(r["extraction_required"] for r in requests), "semantic_request": str(staging / "metadata/semantic-request.json")}
    print(json.dumps(result, indent=2))
    return result


def selected_staging(brain: Path, generation: str | None) -> Path:
    staging_root = brain.resolve() / "staging"
    if generation:
        result = staging_root / generation
    else:
        choices = sorted((p for p in staging_root.glob("*") if p.is_dir()), key=lambda p: p.stat().st_mtime)
        if not choices:
            raise PipelineError("no prepared generation")
        result = choices[-1]
    if not (result / "metadata/snapshot.json").is_file():
        raise PipelineError(f"invalid staged generation: {result}")
    return result


def normalize_extraction_sources(value: dict[str, Any], staging: Path, brain: Path) -> dict[str, Any]:
    for kind in ("nodes", "edges", "hyperedges"):
        if not isinstance(value.get(kind, []), list):
            raise PipelineError(f"semantic fragments field {kind} must be a list")
        for item in value.get(kind, []):
            if not isinstance(item, dict):
                raise PipelineError(f"semantic {kind} entry must be an object")
            source = str(item.get("source_file", ""))
            if not source:
                continue
            path = Path(source)
            if path.is_absolute():
                for root in (staging, brain):
                    try:
                        source = path.relative_to(root).as_posix()
                        break
                    except ValueError:
                        pass
            item["source_file"] = PurePosixPath(source).as_posix()
    return value


def merge_unique(values: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in values:
        result.setdefault(json.dumps(item, ensure_ascii=False, sort_keys=True), item)
    return list(result.values())


def validate_semantics(staging: Path, fragments: list[Path], brain: Path) -> dict[str, Any]:
    request = read_json(staging / "metadata/semantic-request.json")
    snapshot = read_json(staging / "metadata/snapshot.json")
    if request["snapshot_fingerprint"] != snapshot["fingerprint"]:
        raise PipelineError("semantic request does not match snapshot fingerprint")
    seed = normalize_extraction_sources(read_json(staging / "metadata/semantic-seed.json"), staging, brain)
    supplied = {"nodes": [], "edges": [], "hyperedges": []}
    supplied_hashes: dict[str, str] = {}
    for path in fragments:
        value = read_json(path.resolve())
        hashes = value.get("source_hashes")
        if not isinstance(hashes, dict):
            raise PipelineError(f"semantic fragment lacks source_hashes: {path}")
        for source, digest in hashes.items():
            normalized = normalize_source(str(source), brain)
            prior = supplied_hashes.setdefault(normalized, str(digest))
            if prior != str(digest):
                raise PipelineError(f"conflicting semantic source hash: {normalized}")
        value = normalize_extraction_sources(value, staging, brain)
        for kind in supplied:
            supplied[kind].extend(value.get(kind, []))
    allowed = {r["source_file"]: r for r in request["files"]}
    combined = {kind: merge_unique(seed.get(kind, []) + supplied[kind]) for kind in supplied}
    for kind, items in combined.items():
        for item in items:
            source = item.get("source_file")
            if source and source not in allowed:
                raise PipelineError(f"semantic {kind} has source outside current request: {source}")
            if kind in {"nodes", "edges"} and not item.get("source_location"):
                raise PipelineError(f"semantic {kind} lacks source_location in {source}")
            if kind == "edges":
                confidence = item.get("confidence")
                score = item.get("confidence_score")
                if confidence not in {"EXTRACTED", "INFERRED", "AMBIGUOUS"} or not isinstance(score, (int, float)):
                    raise PipelineError(f"semantic edge has invalid confidence in {source}")
                if confidence == "EXTRACTED" and score != 1.0:
                    raise PipelineError(f"EXTRACTED semantic edge must have score 1.0 in {source}")
                if confidence != "EXTRACTED" and not 0 < score < 1:
                    raise PipelineError(f"non-EXTRACTED semantic edge score must be between 0 and 1 in {source}")
    covered = {n.get("source_file") for n in combined["nodes"] if n.get("source_file")}
    missing = [r["source_file"] for r in request["files"] if r["source_file"] not in covered]
    if missing:
        raise PipelineError("semantic coverage missing: " + ", ".join(missing))
    # Supplied fresh fragments must describe the exact requested content hashes.
    supplied_sources = {n.get("source_file") for n in supplied["nodes"] if n.get("source_file")}
    fresh_missing = [r["source_file"] for r in request["files"] if r["extraction_required"] and r["source_file"] not in supplied_sources]
    if fresh_missing:
        raise PipelineError("fresh semantic extraction missing: " + ", ".join(fresh_missing))
    for record in request["files"]:
        actual = sha256_file(staging / record["source_file"])
        if actual != record["sha256"]:
            raise PipelineError(f"semantic source changed after request: {record['source_file']}")
        if record["source_file"] in supplied_sources and supplied_hashes.get(record["source_file"]) != record["sha256"]:
            raise PipelineError(f"semantic fragment hash is stale or absent: {record['source_file']}")
    combined["request_fingerprint"] = request["fingerprint"]
    combined["snapshot_fingerprint"] = snapshot["fingerprint"]
    return combined


def source_anchor_id(source: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", str(PurePosixPath(source).with_suffix("" )).lower()) + "_source"


def readable_labels(graph: Any, communities: dict[int, list[str]]) -> dict[int, str]:
    labels: dict[int, str] = {}
    for cid, members in communities.items():
        ranked = sorted(members, key=lambda n: (-graph.degree(n), str(graph.nodes[n].get("label", n)).casefold()))
        words: list[str] = []
        for node in ranked:
            label = str(graph.nodes[node].get("label", node)).strip()
            if label and not label.endswith((".md", ".json", ".ts", ".tsx", ".rs", ".py")) and label not in words:
                words.append(label)
            if len(words) == 3:
                break
        if not words:
            words = [str(graph.nodes[ranked[0]].get("label", ranked[0]))] if ranked else ["Isolated sources"]
        labels[cid] = " · ".join(words)
    return labels


SMOKE_QUERIES = (
    ("EditorState apply_command", "editor/crates/engine-core/src/state.rs"),
    ("Camera zoom_at", "editor/crates/engine-core/src/geometry.rs"),
    ("WasmEditor attach_renderer", "editor/crates/editor-wasm/src/lib.rs"),
    ("validateCheckpointIntegrity", "frontend/src/components/editor/checkpoint.ts"),
    ("gurow-p1-v1", "docs/benchmarks/p1/contract.md"),
    ("T06-L3-03", "docs/tickets/t06-l3/capture-primary-interactions.md"),
)


def run_smoke_queries(staging: Path) -> list[dict[str, Any]]:
    executable = shutil.which("graphify")
    if not executable:
        candidate = Path(sys.executable).parent / "graphify"
        executable = str(candidate) if candidate.is_file() else ""
    if not executable:
        raise PipelineError("graphify executable not found for smoke queries")
    results = []
    for query_text, expected in SMOKE_QUERIES:
        proc = subprocess.run([executable, "query", query_text, "--budget", "4000"], cwd=staging, capture_output=True, text=True)
        output = proc.stdout + proc.stderr
        matching_records = [block for block in re.split(r"\n\s*\n", output) if expected in block]
        location_present = any(re.search(r"(?:L|line)\s*\d+", block, re.I) for block in matching_records)
        passed = proc.returncode == 0 and bool(matching_records) and location_present
        results.append({"query": query_text, "expected_source": expected, "returncode": proc.returncode, "source_present": expected in output, "location_present": location_present, "passed": passed, "output": output})
    write_json(staging / "metadata/query-smoke.json", {"queries": results})
    failures = [r["query"] for r in results if not r["passed"]]
    if failures:
        raise PipelineError("query smoke regression: " + ", ".join(failures))
    return results


def artifact_manifest(root: Path) -> dict[str, Any]:
    excluded = {"metadata/artifact-manifest.json"}
    files = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink()):
        relative = path.relative_to(root).as_posix()
        if relative not in excluded:
            files.append({"path": relative, "sha256": sha256_file(path), "bytes": path.stat().st_size})
    value = {"schema_version": SCHEMA_VERSION, "generation": root.name, "files": files}
    value["fingerprint"] = sha256_bytes(canonical_json(files))
    return value


def build(repo: Path, brain: Path, generation: str | None, fragments: list[Path]) -> dict[str, Any]:
    brain = brain.resolve(); staging = selected_staging(brain, generation)
    snapshot = read_json(staging / "metadata/snapshot.json")
    live_records, _ = inventory(repo.resolve())
    live_fingerprint = sha256_bytes(canonical_json(live_records))
    if live_fingerprint != snapshot["fingerprint"]:
        raise PipelineError("repository corpus drifted since prepare; prepare a new generation")
    # Recheck the immutable snapshot itself before any extraction.
    for record in snapshot["files"]:
        if sha256_file(staging / record["source_file"]) != record["sha256"]:
            raise PipelineError(f"staged source hash mismatch: {record['source_file']}")
    semantic = validate_semantics(staging, fragments, brain)
    from graphify.analyze import god_nodes, suggest_questions, surprising_connections
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.diagnostics import diagnose_extraction
    from graphify.export import to_html, to_json
    from graphify.extract import extract
    from graphify.report import generate
    from graphify.cache import save_semantic_cache

    semantic_files = [r["source_file"] for r in snapshot["files"] if r["kind"] == "semantic"]
    save_semantic_cache(semantic["nodes"], semantic["edges"], semantic["hyperedges"], root=staging,
                        cache_root=staging, allowed_source_files=semantic_files, prompt_file=str(PROMPT_FILE))

    code_paths = [staging / r["source_file"] for r in snapshot["files"] if r["kind"] == "structural"]
    ast = extract(code_paths, cache_root=staging, root=staging) if code_paths else {"nodes": [], "edges": []}
    ast = normalize_extraction_sources(ast, staging, brain)
    nodes = list(ast.get("nodes", [])) + semantic["nodes"]
    edges = list(ast.get("edges", [])) + semantic["edges"]
    anchors = {}
    for record in snapshot["files"]:
        source = record["source_file"]
        anchor = source_anchor_id(source); anchors[source] = anchor
        nodes.append({"id": anchor, "label": PurePosixPath(source).name, "source_file": source, "source_location": "L1", "file_type": "document" if record["kind"] == "semantic" else "code", "sha256": record["sha256"], "_origin": "provenance"})
    for node in list(nodes):
        source = node.get("source_file")
        if source in anchors and node.get("id") != anchors[source]:
            edges.append({"source": anchors[source], "target": node["id"], "relation": "contains", "source_file": source, "source_location": node.get("source_location", "L1"), "confidence": "EXTRACTED", "confidence_score": 1.0, "_origin": "provenance"})
    # Ground doc-to-code navigation only when an exact identifier has one AST definition
    # and occurs on the semantic node's cited source line.
    ast_by_label: dict[str, list[dict[str, Any]]] = {}
    for node in ast.get("nodes", []):
        label = str(node.get("label", "")).strip().lstrip(".")
        if label.endswith("()"):
            label = label[:-2]
        if re.fullmatch(r"[A-Za-z_$][\w$]*", label):
            ast_by_label.setdefault(label, []).append(node)
    for node in semantic["nodes"]:
        label = str(node.get("label", "")).strip()
        candidates = ast_by_label.get(label, [])
        location = str(node.get("source_location", ""))
        match = re.fullmatch(r"L(\d+)(?:-L?(\d+))?", location)
        source = node.get("source_file")
        if len(candidates) != 1 or not match or source not in anchors:
            continue
        lines = (staging / source).read_text(encoding="utf-8", errors="replace").splitlines()
        start = int(match.group(1)); end = int(match.group(2) or start)
        cited = "\n".join(lines[max(0, start - 1):min(len(lines), end)])
        if re.search(rf"(?<![\w$]){re.escape(label)}(?![\w$])", cited):
            edges.append({"source": node["id"], "target": candidates[0]["id"], "relation": "references", "source_file": source, "source_location": location, "confidence": "INFERRED", "confidence_score": 0.85, "context": "exact identifier in cited documentation line uniquely matches an AST symbol", "_origin": "grounded-navigation"})
    glossary = {str(n.get("label", "")).casefold(): n for n in semantic["nodes"] if str(n.get("source_file", "")).endswith("CONTEXT.md")}
    for node in semantic["nodes"]:
        target = glossary.get(str(node.get("label", "")).casefold())
        if target and target["id"] != node["id"]:
            edges.append({"source": node["id"], "target": target["id"], "relation": "semantically_similar_to", "source_file": node["source_file"], "source_location": node["source_location"], "confidence": "INFERRED", "confidence_score": 0.85, "context": "exact canonical glossary label", "_origin": "grounded-navigation"})
    # Preserve exact, local Markdown references as grounded relations.
    for record in snapshot["files"]:
        source = record["source_file"]
        if not source.endswith(".md"):
            continue
        for line_number, text_line in enumerate((staging / source).read_text(encoding="utf-8").splitlines(), 1):
            for link in re.findall(r"\[[^\]]*\]\(([^\s)#]+)(?:#[^\s)]*)?\)", text_line):
                target = ((staging / source).parent / link).resolve()
                try:
                    relative = target.relative_to(staging).as_posix()
                except ValueError:
                    continue
                if relative in anchors:
                    edges.append({"source": anchors[source], "target": anchors[relative], "relation": "references", "source_file": source, "source_location": f"L{line_number}", "confidence": "EXTRACTED", "confidence_score": 1.0, "_origin": "provenance"})
    extraction = {"nodes": merge_unique(nodes), "edges": edges, "hyperedges": semantic["hyperedges"], "input_tokens": 0, "output_tokens": 0}
    out = staging / "graphify-out"; out.mkdir(exist_ok=True)
    write_json(out / ".graphify_ast.json", ast)
    write_json(out / ".graphify_semantic.json", semantic)
    write_json(out / ".graphify_extract.json", extraction)
    write_json(out / "all-relations.json", extraction)
    health = diagnose_extraction(extraction, directed=True, root=staging)
    write_json(staging / "metadata/graph-health.json", health)
    graph = build_from_json(extraction, root=staging, directed=True)
    if not graph.is_directed() or not graph.number_of_nodes():
        raise PipelineError("Graphify did not produce a non-empty directed graph")
    communities = cluster(graph)
    graph.graph["generation"] = snapshot["generation"]
    graph.graph["snapshot_fingerprint"] = snapshot["fingerprint"]
    labels = readable_labels(graph, communities)
    if not to_json(graph, communities, str(out / "graph.json"), force=True, built_at_commit=snapshot["commit"], community_labels=labels):
        raise PipelineError("graph.json export failed")
    if not to_html(graph, communities, str(out / "graph.html"), community_labels=labels):
        raise PipelineError("graph.html export failed")
    cohesion = score_all(graph, communities)
    gods = god_nodes(graph, exclude_hubs_percentile=95)
    surprises = surprising_connections(graph, communities)
    questions = suggest_questions(graph, communities, labels)
    total_words = sum(len((staging / r["source_file"]).read_text(encoding="utf-8", errors="replace").split()) for r in snapshot["files"])
    detection = {"total_files": len(snapshot["files"]), "total_words": total_words, "files": {"code": [r["source_file"] for r in snapshot["files"] if r["kind"] == "structural"], "document": [r["source_file"] for r in snapshot["files"] if r["kind"] == "semantic"]}}
    report = generate(graph, communities, cohesion, labels, gods, surprises, detection, {"input": 0, "output": 0}, str(staging), suggested_questions=questions, built_at_commit=snapshot["commit"])
    report = report.replace("Token cost: 0 input · 0 output", "Token cost: unknown (host-agent telemetry unavailable)")
    report = re.sub(r"(?m)^.*graphify update \.?.*$", "Refresh this managed brain with `scripts/graphify_brain.py prepare`, verified semantic extraction, `build`, then `status` from the Gurow repository.", report)
    report = report.replace(str(staging), str(brain / "current"))
    report = report.replace(
        "Run `git rev-parse HEAD` and compare to check if the graph is stale.",
        "Run the managed pipeline `status` command to compare source and artifact hashes; a matching commit alone does not establish freshness.",
    )
    report += (
        f"\n## Extraction health\n\nGeneration: `{snapshot['generation']}`. "
        f"Raw extraction has {health.get('dangling_endpoint_edges', 0)} relations with unresolved endpoints "
        f"and {health.get('directed_same_endpoint_collapsed_edges', 0)} parallel relations collapsed in the directed query view. "
        "All raw relations remain in all-relations.json; inspect metadata/graph-health.json for details. "
        "These warnings limit graph completeness and do not establish application bugs.\n"
    )
    (out / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    (out / ".graphify_python").write_text(sys.executable + "\n", encoding="utf-8")
    (out / ".graphify_root").write_text(str(brain / "current") + "\n", encoding="utf-8")
    write_json(out / ".graphify_analysis.json", {"communities": communities, "cohesion": cohesion, "labels": labels, "gods": gods, "surprises": surprises, "questions": questions})
    semantic_sources = {n.get("source_file") for n in semantic["nodes"] if n.get("source_file")}
    ast_sources = {n.get("source_file") for n in ast.get("nodes", []) if n.get("source_file")}
    semantic_records = [r for r in snapshot["files"] if r["kind"] == "semantic"]
    structural_records = [r for r in snapshot["files"] if r["kind"] == "structural"]
    write_json(staging / "metadata/build-validation.json", {
        "generation": snapshot["generation"], "snapshot_fingerprint": snapshot["fingerprint"],
        "semantic_request_fingerprint": semantic["request_fingerprint"], "nodes": graph.number_of_nodes(),
        "directed_edges": graph.number_of_edges(), "raw_relations": len(edges), "communities": len(communities),
        "directed": graph.is_directed(), "snapshot_files": len(snapshot["files"]),
        "semantic_files": len(semantic_records),
        "semantic_files_covered": sum(r["source_file"] in semantic_sources for r in semantic_records),
        "structural_files": len(structural_records),
        "symbol_extraction_empty": [r["source_file"] for r in structural_records if r["source_file"] not in ast_sources],
        "health": health,
    })
    run_smoke_queries(staging)
    manifest = artifact_manifest(staging)
    write_json(staging / "metadata/artifact-manifest.json", manifest)
    verify_generation(staging, require_queries=True)
    final_records, _ = inventory(repo.resolve())
    if sha256_bytes(canonical_json(final_records)) != snapshot["fingerprint"]:
        raise PipelineError("repository corpus drifted during build; refusing publication")
    published = publish(brain, staging)
    result = {"generation": snapshot["generation"], "published": str(published), "nodes": graph.number_of_nodes(), "edges": graph.number_of_edges(), "raw_relations": len(edges)}
    print(json.dumps(result, indent=2))
    return result


def verify_generation(root: Path, require_queries: bool = True) -> dict[str, Any]:
    manifest = read_json(root / "metadata/artifact-manifest.json")
    for record in manifest["files"]:
        path = root / record["path"]
        if not path.is_file() or sha256_file(path) != record["sha256"]:
            raise PipelineError(f"artifact missing or corrupt: {record['path']}")
    graph = read_json(root / "graphify-out/graph.json")
    validation = read_json(root / "metadata/build-validation.json")
    if not graph.get("directed", True) and validation.get("directed") is not True:
        raise PipelineError("published graph is not directed")
    if require_queries:
        smoke = read_json(root / "metadata/query-smoke.json")
        if len(smoke.get("queries", [])) != len(SMOKE_QUERIES) or not all(q.get("passed") for q in smoke["queries"]):
            raise PipelineError("query smoke evidence incomplete")
    return {"generation": root.name, "files": len(manifest["files"]), "fingerprint": manifest["fingerprint"]}


def publish(brain: Path, staging: Path) -> Path:
    generations = brain / "generations"; generations.mkdir(exist_ok=True)
    destination = generations / staging.name
    if destination.exists():
        raise PipelineError(f"generation already published: {destination}")
    os.replace(staging, destination)
    current = brain / "current"
    prior_current = os.readlink(current) if current.is_symlink() else None
    # Preserve the pre-pipeline layout before installing stable compatibility links.
    backup = brain / "backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    originals: dict[str, tuple[str, str | Path] | None] = {}
    try:
        for name in ("sources", "metadata", "graphify-out"):
            legacy = brain / name
            if legacy.is_symlink():
                originals[name] = ("symlink", os.readlink(legacy)); legacy.unlink()
            elif legacy.exists():
                backup.mkdir(parents=True, exist_ok=True)
                saved = backup / name; os.replace(legacy, saved); originals[name] = ("moved", saved)
            else:
                originals[name] = None
            link = brain / ("." + name + ".tmp")
            link.unlink(missing_ok=True)
            link.symlink_to(Path("current") / name, target_is_directory=True)
            os.replace(link, legacy)
        temporary = brain / ".current.tmp"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(Path("generations") / destination.name, target_is_directory=True)
        os.replace(temporary, current)
        verify_generation(current.resolve(), require_queries=True)
        for name in ("sources", "metadata", "graphify-out"):
            if (brain / name).resolve() != (current / name).resolve():
                raise PipelineError(f"compatibility link does not reference current/{name}")
    except Exception:
        if prior_current is not None:
            rollback = brain / ".current.rollback"
            rollback.unlink(missing_ok=True)
            rollback.symlink_to(prior_current, target_is_directory=True)
            os.replace(rollback, current)
        elif current.is_symlink():
            current.unlink()
        for name, original in originals.items():
            legacy = brain / name
            if legacy.is_symlink():
                legacy.unlink()
            if original is None:
                continue
            kind, value = original
            if kind == "symlink":
                legacy.symlink_to(value, target_is_directory=True)
            else:
                os.replace(Path(value), legacy)
        raise
    (brain / "graphify-out/.needs_update").unlink(missing_ok=True)
    return destination


def status(repo: Path, brain: Path, generation: str | None) -> dict[str, Any]:
    brain = brain.resolve()
    root = (brain / "generations" / generation) if generation else (brain / "current")
    if not root.exists():
        raise PipelineError(f"generation not found: {root}")
    result = verify_generation(root.resolve(), require_queries=True)
    snapshot = read_json(root.resolve() / "metadata/snapshot.json")
    live_records, _ = inventory(repo.resolve())
    live_fingerprint = sha256_bytes(canonical_json(live_records))
    drift = live_fingerprint != snapshot["fingerprint"]
    needs = (brain / "graphify-out/.needs_update").exists()
    for name in ("sources", "metadata", "graphify-out"):
        if not (brain / name).is_symlink() or (brain / name).resolve() != (brain / "current" / name).resolve():
            raise PipelineError(f"compatibility path is not linked to current/{name}")
    result.update({"status": "needs-update" if needs or drift else "ready", "needs_update": needs, "repository_drift": drift, "current": str(root.resolve())})
    print(json.dumps(result, indent=2))
    if needs or drift:
        raise PipelineError("brain generation is stale")
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subs = result.add_subparsers(dest="command", required=True)
    for name in ("prepare", "status", "build"):
        sub = subs.add_parser(name)
        sub.add_argument("--repo", type=Path, required=True)
        sub.add_argument("--brain", type=Path, required=True)
        sub.add_argument("--generation")
        if name == "build":
            sub.add_argument("--semantic-fragments", type=Path, action="append", default=[])
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "prepare":
            prepare(args.repo, args.brain)
        elif args.command == "build":
            build(args.repo, args.brain, args.generation, args.semantic_fragments)
        elif args.command == "status":
            status(args.repo, args.brain, args.generation)
        else:
            raise PipelineError(f"{args.command} is not implemented yet")
    except PipelineError as exc:
        print(f"graphify-brain: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
