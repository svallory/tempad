interface ProjectKeyLike {
  org: string;
  project: string;
}

interface NamedSessionLike extends ProjectKeyLike {
  projectName: string | null;
}

/**
 * `<name>` when every session in the group shares the same non-null
 * `projectName`, else the `org/project` key -- a mixed or nameless group
 * falls back rather than picking one session's name arbitrarily.
 */
export function projectLabel(key: ProjectKeyLike, sessions: NamedSessionLike[]): string {
  const keySessions = sessions.filter(
    (session) => session.org === key.org && session.project === key.project,
  );
  const names = new Set(keySessions.map((session) => session.projectName));
  if (names.size === 1) {
    const [name] = names;
    if (name) return name;
  }
  return `${key.org}/${key.project}`;
}
