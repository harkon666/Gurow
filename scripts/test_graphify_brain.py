#!/usr/bin/env python3
import importlib.util
import json
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("graphify_brain", Path(__file__).with_name("graphify_brain.py"))
brain = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(brain)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class GraphifyBrainTests(unittest.TestCase):
    def test_inventory_allows_only_approved_untracked_and_excludes_issue_duplicates(self):
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / "README.md").write_text("tracked", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "README.md"], check=True)
            for relative in ("docs/research/new.md", "docs/research/new.json", "docs/research/old.issue.md", "random.md"):
                path = repo / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(relative, encoding="utf-8")
            records, excluded = brain.inventory(repo)
            included = {r["repository_path"] for r in records}
            reasons = {r["repository_path"]: r["reason"] for r in excluded}
            self.assertEqual(included, {"README.md", "docs/research/new.md", "docs/research/new.json"})
            self.assertIn("duplicate issue contract", reasons["docs/research/old.issue.md"])
            self.assertIn("not explicitly allowlisted", reasons["random.md"])

    def test_semantic_fragment_with_stale_source_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); staging = root / "staging/g"; source = "sources/repository/docs/a.md"
            path = staging / source; path.parent.mkdir(parents=True); path.write_text("current", encoding="utf-8")
            digest = brain.sha256_file(path)
            snapshot = {"fingerprint": "snap"}
            request_file = {"source_file": source, "sha256": digest, "extraction_required": True}
            request = {"snapshot_fingerprint": "snap", "fingerprint": "request", "files": [request_file]}
            write_json(staging / "metadata/snapshot.json", snapshot)
            write_json(staging / "metadata/semantic-request.json", request)
            write_json(staging / "metadata/semantic-seed.json", {"nodes": [], "edges": [], "hyperedges": []})
            fragment = root / "fragment.json"
            write_json(fragment, {"source_hashes": {str(path): "0" * 64}, "nodes": [{"id": "a", "source_file": str(path), "source_location": "L1"}], "edges": [], "hyperedges": []})
            with self.assertRaisesRegex(brain.PipelineError, "hash is stale"):
                brain.validate_semantics(staging, [fragment], root)

    def test_generation_verification_rejects_corrupt_artifact(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            artifact = root / "graphify-out/graph.json"
            write_json(artifact, {"directed": True, "nodes": [], "links": []})
            write_json(root / "metadata/build-validation.json", {"directed": True})
            record = {"path": "graphify-out/graph.json", "sha256": brain.sha256_file(artifact), "bytes": artifact.stat().st_size}
            write_json(root / "metadata/artifact-manifest.json", {"fingerprint": "x", "files": [record]})
            artifact.write_text("corrupt", encoding="utf-8")
            with self.assertRaisesRegex(brain.PipelineError, "artifact missing or corrupt"):
                brain.verify_generation(root, require_queries=False)

    def test_publication_pointer_failure_restores_legacy_directories(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw); staging = root / "staging/g"
            for name in ("sources", "metadata", "graphify-out"):
                (root / name).mkdir(parents=True); (root / name / "old").write_text(name, encoding="utf-8")
                (staging / name).mkdir(parents=True)
            real_replace = brain.os.replace
            def fail_pointer(source, destination):
                if Path(destination) == root / "current":
                    raise OSError("injected pointer failure")
                return real_replace(source, destination)
            with mock.patch.object(brain.os, "replace", side_effect=fail_pointer):
                with self.assertRaisesRegex(OSError, "injected"):
                    brain.publish(root, staging)
            self.assertFalse((root / "current").exists())
            for name in ("sources", "metadata", "graphify-out"):
                self.assertFalse((root / name).is_symlink())
                self.assertEqual((root / name / "old").read_text(encoding="utf-8"), name)


if __name__ == "__main__":
    unittest.main()
