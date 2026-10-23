# Deutsche Rechtsprüfung für Jarvis

Status: **staged integration proposal**. This folder documents and validates the eight requested projects. It does not claim that third-party services are already installed, authenticated, or reachable.

## Safety model

- Keep existing Jarvis providers, private-data routing, credentials, and workflows unchanged.
- Legal research is opt-in. Do not send contracts, customer data, confidential details, or personal data to a remote legal service unless the user explicitly approves that destination and its privacy terms.
- Never invent a statute, paragraph, judgment, court, date, docket number, or citation.
- Every legal claim in a draft must carry a source citation, a source URL, and the applicable version/date when available.
- Distinguish official legal text, court decision, secondary commentary, and model inference.
- If a source is missing, stale, unavailable, or contradictory, mark the issue unresolved instead of guessing.
- Generated contracts are drafts for review by a qualified German lawyer; this workflow is not legal advice and cannot guarantee enforceability.

## Repository review

| Repository | Intended role | License / distribution notes | Integration decision |
|---|---|---|---|
| [Gesetze-fuer-KI/bundesrecht](https://github.com/Gesetze-fuer-KI/bundesrecht) | Searchable federal law corpus | No root `LICENSE` file was found in the checked path. Do not redistribute or vendor the corpus until the rights/licensing are confirmed. | Use as a source candidate; verify terms first. |
| [PLANIT-TECH/primamcp](https://github.com/PLANIT-TECH/primamcp) | Managed German/EU law MCP | Repository says MIT for code/docs/wrapper; hosted service source is not open source and may require an API key/paid tier. | Optional remote MCP; configure credentials locally only after privacy and pricing review. |
| [matematicsolutions/de-eli-mcp](https://github.com/matematicsolutions/de-eli-mcp) | Law + case-law MCP with ELI/ECLI citations | Apache-2.0. Uses upstream legal-data sources; inspect plugin privacy notes and network endpoints before use. | Preferred local MCP candidate, opt-in install and smoke-test. |
| [Klotzkette/claude-fuer-deutsches-recht](https://github.com/Klotzkette/claude-fuer-deutsches-recht) | German-law skills, contract and AGB workflows | README path and Apache-2.0 license checked. Repository is very large; avoid cloning/downloading everything. | Select individual skills only after reviewing each file and source. |
| [borghei/AI-Skills-German-Law](https://github.com/borghei/AI-Skills-German-Law) | Broad German/EU legal skill collection | Dual-licensed Apache-2.0 OR MIT per repository license. README reports a verification date; that does not itself prove every skill is current. | Select specific skills; check verification log and individual citations. |
| [FutureRootsDE/legal-audit-de](https://github.com/FutureRootsDE/legal-audit-de) | German/EU compliance audit for code and documents | MIT. May invoke browser tooling; do not enable browser/network checks without explicit scope. | Optional audit workflow; read plugin commands and permissions before installing. |
| [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | General legal-workflow methods | Apache-2.0. Many workflows are US-oriented; source-attribution and escalation methods are reusable, legal substance is not automatically applicable in Germany. | Use methodology only, not US clauses as German law. |
| [LegalRabbit-AI/legalrabbit-docx-mcp](https://github.com/LegalRabbit-AI/legalrabbit-docx-mcp) | Local DOCX reading/editing and comments | MIT. Document processing has file-write effects; test on copies and review code before enabling. | Optional local DOCX adapter; never overwrite originals without approval. |

## Recommended staged order

1. Review this manifest and the relevant upstream license/security/privacy documents.
2. Configure one legal-source connector at a time. Prefer a local MCP server for sensitive documents; use remote PRIMAMCP only for queries that contain no confidential or personal data unless explicitly authorized.
3. Install the legal-review skill in `.claude/skills/deutsche-vertragspruefung/`.
4. Select and review only the German contract/AGB skills needed from the two large skill collections.
5. Run offline manifest checks, then MCP smoke tests with public sample queries, then synthetic contract tests.
6. Review DOCX edits on a copy and inspect tracked changes before use.
7. Keep credentials in local environment variables or the client’s secret store. Never commit tokens or real client contracts.

## MCP setup

For the local `de-eli-mcp` server, follow the upstream installation guide:
https://github.com/matematicsolutions/de-eli-mcp

The upstream README documents `uvx de-eli-mcp` and Python module execution. Install only after reviewing the upstream plugin privacy notes and dependencies. The example file `mcp.de-eli.example.json` is a template, not an active configuration.

For PRIMAMCP, use its official setup flow and obtain credentials directly from its provider:
https://github.com/PLANIT-TECH/primamcp
Do not paste API keys into this repository.

## Acceptance checklist

- [ ] Each configured server starts successfully and reports tool discovery.
- [ ] Public test query returns a real legal source and a stable citation.
- [ ] A deliberately nonexistent citation is rejected or reported as not found.
- [ ] Offline mode continues working when legal connectors are unavailable.
- [ ] No contract/customer content is sent remotely without explicit approval.
- [ ] Generated DOCX is written to a new path; original remains unchanged.
- [ ] Test report records environment, versions, timestamp, and any skipped tests.

**Important:** A passing technical test verifies software behavior only. It does not prove that a contract is legally enforceable or that a particular clause is valid in a specific case.
