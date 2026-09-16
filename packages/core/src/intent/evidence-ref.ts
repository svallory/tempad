export type EvidenceRef =
  | { kind: "pr"; repo: string; number: number }
  | { kind: "commit"; sha: string }
  | { kind: "monday"; itemId: string };

const PR_PATTERN = /^pr:([^/#]+\/[^/#]+)#(\d+)$/;
const COMMIT_PATTERN = /^commit:([0-9a-f]{7,40})$/;
const MONDAY_PATTERN = /^monday:(\d+)$/;

export const EVIDENCE_REF_SHAPES = "pr:<repo>#<number>, commit:<sha>, monday:<item id>";

export function parseEvidenceRef(ref: string): EvidenceRef {
  const pr = ref.match(PR_PATTERN);
  if (pr)
    return { kind: "pr", repo: pr[1] as string, number: Number.parseInt(pr[2] as string, 10) };

  const commit = ref.match(COMMIT_PATTERN);
  if (commit) return { kind: "commit", sha: commit[1] as string };

  const monday = ref.match(MONDAY_PATTERN);
  if (monday) return { kind: "monday", itemId: monday[1] as string };

  throw new Error(`invalid evidence ref: ${ref} (expected one of ${EVIDENCE_REF_SHAPES})`);
}

export function formatEvidenceRef(ref: EvidenceRef): string {
  switch (ref.kind) {
    case "pr":
      return `pr:${ref.repo}#${ref.number}`;
    case "commit":
      return `commit:${ref.sha}`;
    case "monday":
      return `monday:${ref.itemId}`;
  }
}
