---
name: synthesize-topic
description: Synthesizes a broad knowledge topic across notes using 3-tier RAG context assembly, multi-hop graph neighborhoods, and dynamic Mermaid topology diagrams.
---

# /synthesize-topic — Topic Synthesis Skill

This skill retrieves multi-hop knowledge subgraphs surrounding a focal note or concept and synthesizes an authoritative summary respecting strict token budgets.

```mermaid
sequenceDiagram
    autonumber
    actor User as "Operator"
    participant Agent as "AI Coding Agent"
    participant MCP as "Second Brain MCP"
    participant RAG as "Context Assembler"

    User->>Agent: "/synthesize-topic ZET-0001 (tier: standard)"
    Agent->>MCP: callTool("sb_assemble_context", { uid: "ZET-0001", tier: "standard", includeMermaidGraph: true })
    MCP->>RAG: assembleContext("ZET-0001", depth: 2)
    RAG-->>MCP: Assembled dossier with embedded Mermaid topology
    MCP-->>Agent: Rendered dossier
    Agent->>Agent: Deep synthesis (epistemic confidence, contradictions, gaps)
    Agent-->>User: Structured topic synthesis report
```

---

## Instructions

1. **Identify Focal UID:**
   Locate the focal note UID via `sb_search_knowledge(query)` if the user provided a topic phrase instead of an exact UID.
2. **Select Context Tier:**
   * `frugal`: For quick targeted answers ($\le 4\text{k}$ tokens).
   * `standard`: For standard thematic analysis ($\le 16\text{k}$ tokens).
   * `panoramic`: For deep comprehensive reviews or MOC creation ($\le 64\text{k}$ tokens).
3. **Assemble Context:**
   Invoke `sb_assemble_context(uid, tier, includeMermaidGraph: true)`.
4. **Deliver Synthesis:**
   Present the synthesis highlighting:
   * Core thesis and epistemic certainty
   * Supporting evidence and conceptual lineage
   * Counterarguments and unresolved contradictions
   * Recommended new research directions or atomic notes to capture

