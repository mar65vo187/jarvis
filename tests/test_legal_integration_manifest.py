"""Regression checks for the staged legal integration registry."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "legal-integrations" / "repositories.json"

EXPECTED = {
    "bundesrecht",
    "primamcp",
    "de-eli-mcp",
    "claude-fuer-deutsches-recht",
    "ai-skills-german-law",
    "legal-audit-de",
    "claude-for-legal",
    "legalrabbit-docx-mcp",
}


class LegalIntegrationManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(REGISTRY.read_text(encoding="utf-8"))
        cls.repositories = cls.manifest["repositories"]

    def test_exactly_eight_unique_requested_projects(self):
        ids = [item["id"] for item in self.repositories]
        self.assertEqual(set(ids), EXPECTED)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), 8)

    def test_every_entry_has_https_github_url_and_license_status(self):
        for item in self.repositories:
            with self.subTest(repository=item.get("id")):
                self.assertTrue(item["url"].startswith("https://github.com/"))
                self.assertTrue(item.get("license_status"))

    def test_integrations_are_disabled_until_reviewed(self):
        self.assertTrue(all(item["enabled"] is False for item in self.repositories))

    def test_privacy_and_citation_safety_gates_exist(self):
        gates = set(self.manifest["safety_gates"])
        self.assertIn("Never commit secrets or real client documents", gates)
        self.assertIn(
            "No remote transfer of confidential/personal contract data without explicit approval",
            gates,
        )
        self.assertIn(
            "Require source URL and citation for each legal proposition",
            gates,
        )


if __name__ == "__main__":
    unittest.main()
